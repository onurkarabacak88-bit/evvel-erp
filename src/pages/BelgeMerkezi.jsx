import { useState, useEffect, Fragment } from 'react';
import { api, fmt } from '../utils/api';

// 🧾 BELGE MERKEZİ (2026-07-10) — sahip: "faturaları toptancı toptancı, ay ay,
// gün gün görebildiğim; işletme harcamalarından faturası OLMAYANLARI direkt
// gördüğüm mekanizma". Kaynak: /api/fatura/belge-merkezi (salt-okur).
const DURUM_RENK = { ocr_bekliyor: '#f59e0b', incelendi: '#22c55e', onaylandi: '#22c55e' };

// 🏦 TEDARİKÇİ MERKEZİ dönüşümü (2026-07-14, sahip: "hepsini tek merkez halinde
// kurgulayalım"). Codex mimarisi: ana obje=Tedarikçi-360, iniş=Genel Bakış;
// GECİKMİŞ her zaman en gürültülü KPI; yaşlandırma VADE tarihine göre; faturasız
// harcama aging'e karışmaz; iki kovalama evreni ayrı alt-durum; ödeme akışı
// TAŞINMADI (deep-link). Salt-okur komuta merkezi.
const SEKMELER = [
  ['genel', '📊 Genel Bakış'],
  ['tedarikci', '🏪 Tedarikçiler'],
  ['belge', '📄 Belge Akışı'],
  ['acik', '📨 Belge Açığı'],
];

export default function BelgeMerkezi() {
  const bugunAy = new Date().toISOString().slice(0, 7);
  const [ay, setAy] = useState(bugunAy);
  const [d, setD] = useState(null);
  const [hata, setHata] = useState('');
  const [sekme, setSekme] = useState('genel');
  // Tedarikçi Merkezi agregatı (KPI + vade yaşlandırma + gecikmişler)
  const [mk, setMk] = useState(null);
  useEffect(() => {
    api('/fatura/tedarikci-merkez').then(setMk).catch(() => setMk(null));
  }, []);
  const [acikToptanci, setAcikToptanci] = useState(null);
  // BM-5: toptancı açılınca cari ekstre (beyan bakiye + vade + zincir)
  const [cari, setCari] = useState({});
  const [acikAy, setAcikAy] = useState(null); // "toptanci|ay" — ay detayı açık mı
  async function cariGetir(ad) {
    if (!ad || ad === '(tedarikçi belirsiz)' || cari[ad]) return;
    try {
      const r = await api(`/fatura/cari-ekstre?tedarikci=${encodeURIComponent(ad)}`);
      setCari(c => ({ ...c, [ad]: r }));
    } catch { setCari(c => ({ ...c, [ad]: { hata: true } })); }
  }
  // 📜 Sistem-öncesi AÇILIŞ DEVRİ (DYK vakası 2026-07-18): 1 Haziran öncesi
  // kalan bakiye sahip beyanıyla girilir — cari açık + yürüyen ekstre buna oturur
  const [devirDuzen, setDevirDuzen] = useState(null);
  const [devirTutar, setDevirTutar] = useState('');
  const [devirNot, setDevirNot] = useState('');
  async function devirKaydet(ad) {
    const t = parseFloat(String(devirTutar).replace(/\./g, '').replace(',', '.'));
    if (isNaN(t)) { alert('Tutar sayı olmalı (borç için +, bizim avansımız için −)'); return; }
    try {
      await api('/fatura/cari-devir', { method: 'POST', body: { tedarikci: ad, tutar: t, aciklama: devirNot.trim() || null } });
      setDevirDuzen(null); setDevirTutar(''); setDevirNot('');
      const r = await api(`/fatura/cari-ekstre?tedarikci=${encodeURIComponent(ad)}`);
      setCari(c => ({ ...c, [ad]: r }));
    } catch (e) { alert(e.message || 'devir kaydedilemedi'); }
  }
  // BM-8: tam metin arama
  const [q, setQ] = useState('');
  const [araSonuc, setAraSonuc] = useState(null);
  async function ara() {
    if (q.trim().length < 2) return;
    try { setAraSonuc(await api(`/fatura/ara?q=${encodeURIComponent(q.trim())}`)); }
    catch (e) { setAraSonuc({ hata: e?.message || 'arama hatası' }); }
  }
  // BM-4: Fatura İstek Motoru (ödenmiş ama faturasız ≥eşik ödemeler)
  const [fi, setFi] = useState(null);
  const [fiMesaj, setFiMesaj] = useState('');
  async function fiYenile() {
    try { setFi(await api('/fatura-istek/liste')); }
    catch { setFi(null); }
  }
  useEffect(() => { fiYenile(); }, []);
  // BM-6: fiyat bandı (band dışı son alımlar)
  const [fb, setFb] = useState(null);
  useEffect(() => {
    api('/fatura/fiyat-bandi').then(setFb).catch(() => setFb(null));
  }, []);
  // BM-2: mutabakat zinciri (sipariş→teslim→belge→fatura→ödeme izi)
  const [mz, setMz] = useState(null);
  useEffect(() => {
    api('/fatura/mutabakat-zinciri').then(setMz).catch(() => setMz(null));
  }, []);
  async function fiTara() {
    setFiMesaj('taranıyor…');
    try {
      const r = await api('/fatura-istek/tara', { method: 'POST' });
      setFiMesaj(`✓ ${r.yeni_aday ?? 0} yeni aday, ${r.oto_kapanan ?? 0} kendiliğinden kapandı`);
      fiYenile();
    } catch (e) { setFiMesaj(e?.message || 'tarama hatası'); }
  }
  async function fiIste(g) {
    if (!g.wa_link) return;
    window.open(g.wa_link, '_blank');
    try {
      for (const x of g.istekler) await api(`/fatura-istek/${x.id}/gonderildi`, { method: 'POST' });
    } catch { /* iz düşemedi — mesaj yine gitti */ }
    fiYenile();
  }
  async function fiNumara(g) {
    const tel = window.prompt(`${g.tedarikci} için telefon numarası (örn. 0532 123 45 67):`);
    if (!tel) return;
    try {
      await api(`/fatura-istek/${g.istekler[0].id}/telefon`, {
        method: 'POST', body: { telefon: tel },
      });
      fiYenile();
    } catch (e) { alert(e?.message || 'numara kaydedilemedi'); }
  }
  async function fiKapat(id) {
    const acik = window.prompt('Kapanış açıklaması (zorunlu — örn. "faturası kağıt geldi", "fatura kesilmeyecek"):');
    if (!acik) return;
    try {
      await api(`/fatura-istek/${id}/kapat`, { method: 'POST', body: { aciklama: acik } });
      fiYenile();
    } catch (e) { alert(e?.message || 'kapatılamadı'); }
  }
  // 🚫 belge beklenmez — kapat + kalıbı ÖĞREN (personele elden ödeme vb bir daha aday olmaz)
  async function fiBelgesiz(x) {
    if (!window.confirm(`"${(x.aciklama || '').slice(0, 40)}" için belge beklenmesin mi?\nBu kalıp öğrenilir — benzer ödemeler bir daha aday olmaz.`)) return;
    try {
      const r = await api(`/fatura-istek/${x.id}/kapat`, {
        method: 'POST',
        body: { aciklama: 'belge beklenmez (personel/elden ödeme — sahip işareti)', kalici_istisna: true },
      });
      if (r.ogrenilen_kalip) alert(`Öğrenildi: "${r.ogrenilen_kalip}" — benzer ödemeler artık aday olmaz.`);
      fiYenile();
    } catch (e) { alert(e?.message || 'işaretlenemedi'); }
  }

  useEffect(() => {
    setD(null); setHata('');
    api(`/fatura/belge-merkezi?ay=${ay}`).then(setD)
      .catch(e => setHata(e?.message || 'Yüklenemedi'));
  }, [ay]);

  const k = d?.kapsama || {};
  const oran = k.oran_yuzde;

  return (
    <div style={{ padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>🏦 Tedarikçi Merkezi</h2>
        <input type="month" value={ay} onChange={e => setAy(e.target.value)}
          style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px' }} />
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>
          cari · vadeler · fatura arşivi · belge açığı — tek merkez
        </span>
      </div>
      {/* KPI ŞERİDİ — gecikmiş her zaman en gürültülü (Codex kuralı) */}
      {mk && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          {[
            ['⏰ GECİKMİŞ VADE', mk.kpi?.gecikmis_vade_toplam, 'var(--red)', true],
            ['💼 Hesaplanan Açık', mk.kpi?.toplam_hesaplanan_acik, 'var(--text)', false],
            ['📅 Vadesi Gelmemiş', mk.kpi?.vadesi_gelmemis, 'var(--text2, var(--text))', false],
            ['🗓 Bu Hafta Vade', mk.kpi?.bu_hafta_vade_toplam, '#f59e0b', false],
            ['🧾 Faturasız Risk', mk.kpi?.faturasiz_risk, '#f59e0b', false],
          ].map(([ad, val, renk, buyuk]) => (
            <div key={ad} className="card" style={{ padding: '8px 14px', minWidth: 150 }}>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>{ad}</div>
              <div style={{ fontWeight: 800, fontSize: buyuk ? 20 : 15, color: renk }}>{fmt(val || 0)}</div>
            </div>
          ))}
          {(mk.kpi?.islenemeyen_foto || 0) > 0 && (
            <div className="card" style={{ padding: '8px 14px', minWidth: 120 }}>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>📷 Takılı Foto</div>
              <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--red)' }}>{mk.kpi.islenemeyen_foto}</div>
            </div>
          )}
        </div>
      )}
      {/* SEKMELER */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {SEKMELER.map(([k2, ad]) => (
          <button key={k2} className="btn btn-secondary"
            onClick={() => setSekme(k2)}
            style={{ fontWeight: sekme === k2 ? 800 : 400,
                     border: sekme === k2 ? '2px solid var(--accent)' : undefined }}>
            {ad}
          </button>
        ))}
      </div>
      {/* BM-8 — arama */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input value={q} onChange={e => setQ(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && ara()}
          placeholder="🔍 Fatura ara: tedarikçi, fatura no, belge içeriği, ürün adı…"
          style={{ flex: 1, background: 'var(--bg2)', color: 'var(--text)',
                   border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px' }} />
        <button className="btn btn-secondary" onClick={ara}>Ara</button>
        {araSonuc && <button className="btn btn-secondary" onClick={() => { setAraSonuc(null); setQ(''); }}>✕</button>}
      </div>
      {araSonuc && (
        <div className="card" style={{ padding: 14, marginBottom: 14 }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>🔍 Arama: "{araSonuc.q}" — {araSonuc.adet ?? 0} sonuç</div>
          {araSonuc.hata && <div style={{ color: 'var(--red)' }}>{araSonuc.hata}</div>}
          {(araSonuc.sonuclar || []).map(s => (
            <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
              <span>{s.tarih || '—'} · <b>{s.tedarikci_ad || '?'}</b> · {s.fatura_no || 'no yok'}
                {s.gib_dogrulama === 'dogrulandi' && ' · ✅GİB'}
                {s.gib_dogrulama === 'supheli' && ' · ⚠️GİB'}</span>
              <span style={{ whiteSpace: 'nowrap' }}>{fmt(s.tutar)} <a href={s.goruntule} target="_blank" rel="noreferrer" style={{ color: 'var(--blue, #60a5fa)' }}>📎</a>{' '}
                <a href="https://ebelge.gib.gov.tr/earsivsorgula.html" target="_blank" rel="noreferrer" title="GİB e-Arşiv sorgula (sonucu sistemde damgala)" style={{ color: 'var(--text3)' }}>🏛️</a></span>
            </div>
          ))}
        </div>
      )}
      {hata && <div className="card" style={{ padding: 14, color: 'var(--red)' }}>{hata}</div>}
      {!d && !hata && <div style={{ color: 'var(--text3)' }}>Yükleniyor…</div>}
      {d && (
        <>
          {/* ═══ 📊 GENEL BAKIŞ — triage inişi (Codex): gecikmişler + bu hafta ═══ */}
          {sekme === 'genel' && mk && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 14, marginBottom: 14 }}>
              <div className="card" style={{ padding: 16 }}>
                <div style={{ fontWeight: 800, marginBottom: 6, color: 'var(--red)' }}>
                  ⏰ Gecikmiş Vadeler ({(mk.gecikmis_vadeler || []).length})
                </div>
                {(mk.gecikmis_vadeler || []).length === 0 && <div style={{ color: 'var(--green)', fontSize: 13 }}>Gecikmiş vade yok 🎉</div>}
                {(mk.gecikmis_vadeler || []).map(v => (
                  <div key={v.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                    <span>{(v.tedarikci || v.aciklama || '?').slice(0, 28)} · vade {v.vade}</span>
                    <span style={{ whiteSpace: 'nowrap', color: 'var(--red)', fontWeight: 700 }}>
                      {fmt(v.tutar)} · {v.gecikme_gun}g gecikti
                    </span>
                  </div>
                ))}
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>
                  Yaşlandırma: 1-7g {fmt(mk.vade_yaslandirma?.g1_7 || 0)} · 8-30g {fmt(mk.vade_yaslandirma?.g8_30 || 0)} ·
                  31-60g {fmt(mk.vade_yaslandirma?.g31_60 || 0)} · 61+g {fmt(mk.vade_yaslandirma?.g61_plus || 0)} —
                  ödeme için Vadeli Alımlar ekranı kullanılır (buradan taşınmadı).
                </div>
              </div>
              <div className="card" style={{ padding: 16 }}>
                <div style={{ fontWeight: 800, marginBottom: 6, color: '#f59e0b' }}>
                  🗓 Bu Hafta Vadesi Gelenler ({(mk.bu_hafta_vadeler || []).length})
                </div>
                {(mk.bu_hafta_vadeler || []).length === 0 && <div style={{ color: 'var(--text3)', fontSize: 13 }}>Bu hafta vadesi gelen yok.</div>}
                {(mk.bu_hafta_vadeler || []).map(v => (
                  <div key={v.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                    <span>{(v.tedarikci || v.aciklama || '?').slice(0, 28)}</span>
                    <span style={{ whiteSpace: 'nowrap' }}>{fmt(v.tutar)} · {v.vade}</span>
                  </div>
                ))}
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>
                  Belge açığı: ödeme-temelli {(mk.belge_acigi?.odeme_temelli?.acik_adet ?? 0)} istek ·
                  teslimat-temelli {(mk.belge_acigi?.teslimat_temelli?.bekleyen ?? 0)} açık teslimat
                  {(mk.belge_acigi?.teslimat_temelli?.en_yasli_gun || 0) > 0 && ` (en yaşlısı ${mk.belge_acigi.teslimat_temelli.en_yasli_gun}g)`}
                  {' '}→ 📨 Belge Açığı sekmesi
                </div>
              </div>
            </div>
          )}

          {/* KAPSAMA BARI */}
          {sekme === 'belge' && (
          <div className="card" style={{ padding: 16, marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <div style={{ fontWeight: 800 }}>Belge Kapsama — {d.ay}</div>
              <div style={{ fontSize: 13, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <span>💳 İşletme kart harcaması: <b>{fmt(k.isletme_kart_harcamasi || 0)}</b></span>
                <span style={{ color: 'var(--green)' }}>🧾 Faturalı: <b>{fmt(k.faturali_eslesen || 0)}</b></span>
                {(k.kurumsal_otomatik || 0) > 0 && (
                  <span style={{ color: '#f59e0b' }} title="MEPAŞ/su/telekom vb otomatik ödemeler — faturası kurumda hazır, e-arşivden indirip yükleyin">
                    🏢 Kurumsal: <b>{fmt(k.kurumsal_otomatik)}</b>
                  </span>
                )}
                {(k.belge_beklenmez || 0) > 0 && (
                  <span style={{ color: 'var(--text3)' }} title="Personele elden ödeme / prim / öğrenilen istisnalar — belge beklenmez, risk sayılmaz">
                    🚫 Belge beklenmez: <b>{fmt(k.belge_beklenmez)}</b>
                  </span>
                )}
                <span style={{ color: 'var(--red)' }}>⚠ Faturasız: <b>{fmt(k.faturasiz || 0)}</b></span>
              </div>
            </div>
            <div style={{ marginTop: 10, height: 14, borderRadius: 999, background: 'rgba(239,68,68,.25)', overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(100, oran || 0)}%`, height: '100%', background: 'var(--green)' }} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>
              Kapsama: {oran != null ? `%${oran}` : '—'} · faturasız kısım = belge isteme adayı (KDV indirimi + gider kanıtı)
            </div>
            {/* 📷 İŞLENEMEYEN FOTOLAR (SÜTAŞ vakası): OCR'a takılanlar görünür olsun */}
            {d.islenemeyen_foto && d.islenemeyen_foto.adet > 0 && (
              <div style={{ fontSize: 12, marginTop: 8, padding: '6px 10px', borderRadius: 8,
                            background: 'rgba(239,68,68,.12)', display: 'flex',
                            justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span>
                  📷 <b>{d.islenemeyen_foto.adet} foto işlenemedi</b> (OCR hatası/bekliyor) —
                  içlerinde aranan faturalar olabilir
                  {d.islenemeyen_foto.son_hata && (
                    <span style={{ color: 'var(--text3)' }}> · son hata: {d.islenemeyen_foto.son_hata.slice(0, 60)}</span>
                  )}
                </span>
                <button className="btn btn-secondary" onClick={async () => {
                  try {
                    const r = await api('/fatura/ocr-yeniden-dene?limit=50', { method: 'POST' });
                    alert(`${r.kuyruga_alinan} foto OCR kuyruğuna alındı — 1-2 dk sonra sayfayı yenileyin.` +
                      (r.son_hatalar?.length ? `\nSon hata: ${r.son_hatalar[0]}` : ''));
                  } catch (e) { alert(e?.message || 'tetiklenemedi'); }
                }}>🔄 Yeniden Dene</button>
              </div>
            )}
            {/* BM-3 — KDV kanıt sınıflaması + BM-0b arşiv boyutu */}
            {(d.kdv_kanit || d.arsiv_depo) && (
              <div style={{ fontSize: 12, marginTop: 8, display: 'flex', gap: 16, flexWrap: 'wrap', color: 'var(--text3)' }}>
                {d.kdv_kanit && (
                  <span>
                    🧮 KDV kanıt: <b style={{ color: 'var(--green)' }}>{d.kdv_kanit.indirime_aday.adet} sağlam</b> ({fmt(d.kdv_kanit.indirime_aday.toplam)})
                    {d.kdv_kanit.inceleme.adet > 0 && <> · <b style={{ color: '#f59e0b' }}>{d.kdv_kanit.inceleme.adet} inceleme</b> ({fmt(d.kdv_kanit.inceleme.toplam)} — no/VKN eksik)</>}
                    {d.kdv_kanit.supheli.adet > 0 && <> · <b style={{ color: 'var(--red)' }}>{d.kdv_kanit.supheli.adet} şüpheli</b></>}
                    {' '}· hüküm muhasebecinin
                  </span>
                )}
                {d.arsiv_depo && (
                  <span>💾 Arşiv: {d.arsiv_depo.dosyali_adet} dosya / {d.arsiv_depo.toplam_mb} MB</span>
                )}
              </div>
            )}
          </div>
          )}

          {/* BM-2 — MUTABAKAT ZİNCİRİ (eksik halkalar varsa) */}
          {sekme === 'genel' && mz && mz.siparis_adet > 0 && (mz.sayac?.tam ?? 0) < mz.siparis_adet && (
            <div className="card" style={{ padding: 16, marginBottom: 14 }}>
              <div style={{ fontWeight: 800, marginBottom: 4 }}>
                🔗 Mutabakat Zinciri — son 60 gün: {mz.sayac.tam}/{mz.siparis_adet} sipariş TAM
              </div>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 6 }}>
                sipariş → teslim → belge → fatura → ödeme izi
                {mz.sayac.teslim_yok > 0 && <> · teslim yok: <b>{mz.sayac.teslim_yok}</b></>}
                {mz.sayac.belge_acik > 0 && <> · belge açık: <b>{mz.sayac.belge_acik}</b></>}
                {mz.sayac.fatura_yok > 0 && <> · fatura yok: <b>{mz.sayac.fatura_yok}</b></>}
                {mz.sayac.odeme_izi_yok > 0 && <> · ödeme izi yok: <b>{mz.sayac.odeme_izi_yok}</b></>}
              </div>
              {(mz.eksik_zincirler || []).slice(0, 6).map(z => (
                <div key={z.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
                  <span>{z.siparis_tarihi} · {(z.tedarikci_ad || '?').slice(0, 30)}</span>
                  <span style={{ color: 'var(--red)', whiteSpace: 'nowrap' }}>
                    {z.eksik === 'teslim_yok' ? 'teslim alınmadı' : z.eksik === 'belge_acik' ? 'belge bekleniyor'
                      : z.eksik === 'fatura_yok' ? 'fatura yok' : 'ödeme izi yok'}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* ═══ 📨 BELGE AÇIĞI: iki alt-durum (Codex — ayrı kuyruklar, tek sekme) ═══ */}
          {sekme === 'acik' && mk?.belge_acigi?.teslimat_temelli && (
            <div className="card" style={{ padding: 12, marginBottom: 14, fontSize: 13 }}>
              📦 <b>Teslimat-temelli belge açığı:</b> {mk.belge_acigi.teslimat_temelli.bekleyen} açık teslimat
              {(mk.belge_acigi.teslimat_temelli.en_yasli_gun || 0) > 0 && ` (en yaşlısı ${mk.belge_acigi.teslimat_temelli.en_yasli_gun} gün)`}
              {' '}— takibi EVVEL Cep → Açık Teslimat ekranında (teslim başına kovalanır; buradaki 📨 liste ise ödeme-temelli).
            </div>
          )}
          {/* BM-4 — FATURA İSTE (ödeme-temelli belge açığı) */}
          {sekme === 'acik' && fi && (
            <div className="card" style={{ padding: 16, marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div style={{ fontWeight: 800 }}>
                  📨 Fatura İste — {fi.acik_adet} açık / {fmt(fi.acik_toplam)}
                  {fi.acik_adet > 0 && (
                    <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>
                      {' '}· KDV riski ≈ {fmt(fi.kdv_riski)}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {fiMesaj && <span style={{ fontSize: 12, color: 'var(--text3)' }}>{fiMesaj}</span>}
                  <button className="btn btn-secondary" onClick={fiTara}>🔄 Adayları Tara</button>
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text3)', margin: '4px 0 8px' }}>
                ≥{fmt(fi.esik)} ödenmiş ama faturası arşivde eşleşmeyen ödemeler. Fatura gelince istek
                kendiliğinden kapanır. Teslimat faturaları ayrı takipte
                {fi.belge_talep_bekleyen > 0 ? ` (Açık Teslimat: ${fi.belge_talep_bekleyen} bekliyor)` : ''}.
              </div>
              {fi.acik_adet === 0 && <div style={{ color: 'var(--green)', fontSize: 13 }}>Açık istek yok 🎉</div>}
              {(fi.gruplar || []).map(g => (
                <div key={g.tedarikci} style={{ borderBottom: '1px solid var(--border)', padding: '8px 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontWeight: 700 }}>
                      {g.tedarikci} <span style={{ color: 'var(--text3)', fontWeight: 400 }}>({g.adet} ödeme · {fmt(g.toplam)})</span>
                    </span>
                    <span style={{ display: 'flex', gap: 6 }}>
                      {g.kurumsal
                        ? <a className="btn btn-secondary" href="https://ebelge.gib.gov.tr/earsivsorgula.html" target="_blank" rel="noreferrer"
                             title="Kurumsal otomatik ödeme (MEPAŞ vb) — faturası kurumda; e-arşivden indirip yükle">🏛️ e-Arşiv'den İndir</a>
                        : g.wa_link
                          ? <button className="btn btn-secondary" onClick={() => fiIste(g)}>📲 WhatsApp'tan İste</button>
                          : <button className="btn btn-secondary" onClick={() => fiNumara(g)}>📵 Numara Ekle</button>}
                    </span>
                  </div>
                  {(g.istekler || []).map(x => (
                    <div key={x.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, padding: '3px 0' }}>
                      <span>
                        {x.tarih} · {x.kaynak_tip === 'kart' ? `💳 ${x.kanal_detay || 'kart'}`
                          : x.kaynak_tip === 'anlik_gider' ? '🧾 anlık gider' : '📦 vadeli alım'}
                        {' · '}{(x.aciklama || '').slice(0, 40)}
                        {x.durum === 'istek_gonderildi' && <span style={{ color: 'var(--green)' }}> · ✉ istendi ({x.mesaj_sayisi})</span>}
                      </span>
                      <span style={{ whiteSpace: 'nowrap' }}>
                        {fmt(x.tutar)}{' '}
                        <button className="btn btn-secondary" style={{ padding: '0 6px', fontSize: 11 }}
                          onClick={() => fiKapat(x.id)} title="Manuel kapat (açıklama zorunlu)">✔</button>{' '}
                        <button className="btn btn-secondary" style={{ padding: '0 6px', fontSize: 11 }}
                          onClick={() => fiBelgesiz(x)} title="Belge beklenmez (personele elden ödeme vb) — kalıbı öğren, bir daha aday olmasın">🚫</button>
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* BM-6 — FİYAT BANDI (band dışı son alımlar; öneri-only) */}
          {sekme === 'genel' && fb && fb.band_disi_adet > 0 && (
            <div className="card" style={{ padding: 16, marginBottom: 14 }}>
              <div style={{ fontWeight: 800, marginBottom: 4 }}>
                📈 Fiyat Bandı — {fb.band_disi_adet} ürün band dışı
                <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>
                  {' '}({fb.urun_adet} ürünün 180 günlük bandı izleniyor)
                </span>
              </div>
              {(fb.band_disi || []).slice(0, 8).map(b => (
                <div key={`${b.kod}-${b.birim}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
                  <span>{(b.ad || b.kod).slice(0, 38)} <span style={{ color: 'var(--text3)' }}>({b.birim})</span> · medyan {b.medyan}</span>
                  <span style={{ whiteSpace: 'nowrap', color: (b.sapma_yuzde || 0) > 0 ? 'var(--red)' : 'var(--green)' }}>
                    son {b.son_fiyat} ({b.sapma_yuzde > 0 ? '+' : ''}{b.sapma_yuzde}%)
                  </span>
                </div>
              ))}
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                Aynı birim kıyası; fiyat kaydı değiştirilmez — maliyet kartı güncellemesi insan onayıyla.
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 14 }}>
            {/* ═══ 🏪 TEDARİKÇİLER (Tedarikçi-360: cari + ekstre + ay-ay + PDF) ═══ */}
            {sekme === 'tedarikci' && (
            <div className="card" style={{ padding: 16, gridColumn: '1 / -1' }}>
              <div style={{ fontWeight: 800, marginBottom: 8 }}>🏪 Tedarikçi-360 ({(d.toptancilar || []).length}) — tıkla: cari · yürüyen ekstre · ay-ay mutabakat · 📎 PDF</div>
              {(d.toptancilar || []).length === 0 && <div style={{ color: 'var(--text3)', fontSize: 13 }}>Bu ay arşivde fatura yok.</div>}
              {(d.toptancilar || []).map(t => (
                <div key={t.toptanci} style={{ borderBottom: '1px solid var(--border)', padding: '8px 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, cursor: 'pointer' }}
                       onClick={() => { setAcikToptanci(a => a === t.toptanci ? null : t.toptanci); cariGetir(t.toptanci); }}>
                    <span style={{ fontWeight: 700 }}>{t.toptanci} <span style={{ color: 'var(--text3)', fontWeight: 400 }}>({t.adet} fatura)</span></span>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{fmt(t.toplam)}</span>
                  </div>
                  {acikToptanci === t.toptanci && (
                    <div style={{ marginTop: 6 }}>
                      {/* BM-5 — cari şerit: beyan bakiye + bekleyen vade + zincir */}
                      {cari[t.toptanci] && !cari[t.toptanci].hata && (
                        <div style={{ fontSize: 12, padding: '6px 8px', marginBottom: 4,
                                      background: 'var(--bg2)', borderRadius: 8 }}>
                          💼 Cari — bizim hesap:{' '}
                          <b style={{ color: (cari[t.toptanci].hesaplanan_acik || 0) > 0 ? 'var(--red)' : 'var(--green)' }}>
                            ≈ {fmt(cari[t.toptanci].hesaplanan_acik)}
                          </b>
                          <span style={{ color: 'var(--text3)' }}>
                            {' '}({cari[t.toptanci].devir ? `📜 devir ${fmt(cari[t.toptanci].devir)} + ` : ''}fatura {fmt(cari[t.toptanci].fatura_toplam_6ay)} − ödeme izi {fmt(cari[t.toptanci].odeme_izi_toplam_6ay)})
                          </span>
                          {' '}· beyan{' '}
                          <b>{cari[t.toptanci].beyan_bakiye != null ? `≈ ${fmt(cari[t.toptanci].beyan_bakiye)}` : 'fatura üstünde yok'}</b>
                          {cari[t.toptanci].bekleyen_vade_toplam > 0 && (
                            <> · bekleyen vade <b style={{ color: 'var(--red)' }}>{fmt(cari[t.toptanci].bekleyen_vade_toplam)}</b>
                              {cari[t.toptanci].bekleyen_vadeler?.[0] && ` (en yakın ${cari[t.toptanci].bekleyen_vadeler[0].vade})`}</>
                          )}
                          {/* SÖZ vs FATURA farkı (ATALAY vakası): toplu vade sözü fatura açığından saparsa uyar */}
                          {cari[t.toptanci].bekleyen_vade_toplam > 0 &&
                            Math.abs(cari[t.toptanci].bekleyen_vade_toplam - Math.max(0, cari[t.toptanci].hesaplanan_acik || 0)) >
                              Math.max(500, (cari[t.toptanci].bekleyen_vade_toplam || 0) * 0.05) && (
                            <div style={{ color: '#f59e0b', marginTop: 2 }}>
                              ⚠ Ödeme sözü {fmt(cari[t.toptanci].bekleyen_vade_toplam)} ama faturalardan görünen açık {fmt(Math.max(0, cari[t.toptanci].hesaplanan_acik || 0))} —
                              fark {fmt(Math.abs(cari[t.toptanci].bekleyen_vade_toplam - Math.max(0, cari[t.toptanci].hesaplanan_acik || 0)))}:
                              ya faturaları henüz yüklenmedi/okunmadı, ya söz toplu/tahmini girildi.
                            </div>
                          )}
                          {(cari[t.toptanci].faturalar || []).some(f => f.zincir_fark != null && f.zincir_fark !== 0) && (
                            <span style={{ color: 'var(--text3)' }}> · zincirde ödeme/hareket izi var</span>
                          )}
                          <div style={{ color: 'var(--text3)', marginTop: 2 }}>
                            bizim hesap = açılış devri + 180 gün fatura − ödeme izi (ödeme izi yoksa açık büyür) · beyan = tedarikçinin fatura üstü bakiyesi · ikisi de ≈, hüküm değil
                          </div>
                          {/* 📜 AÇILIŞ DEVRİ — sistem (1 Haziran) öncesinden kalan bakiye beyanı */}
                          <div style={{ marginTop: 4, fontSize: 11 }}>
                            📜 Sistem öncesi devir:{' '}
                            <b>{cari[t.toptanci].devir ? fmt(cari[t.toptanci].devir) : 'yok'}</b>
                            {cari[t.toptanci].devir_not && <span style={{ color: 'var(--text3)' }}> · {cari[t.toptanci].devir_not}</span>}
                            {devirDuzen === t.toptanci ? (
                              <span style={{ marginLeft: 6, display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                                <input value={devirTutar} onChange={e => setDevirTutar(e.target.value)}
                                       placeholder="tutar (borç +, avansımız −)"
                                       style={{ width: 150, fontSize: 11, padding: '2px 6px' }} />
                                <input value={devirNot} onChange={e => setDevirNot(e.target.value)}
                                       placeholder="not (ör: Mayıs öncesi ödendi)"
                                       style={{ width: 160, fontSize: 11, padding: '2px 6px' }} />
                                <button className="btn btn-sm" onClick={() => devirKaydet(t.toptanci)}>Kaydet</button>
                                <button className="btn btn-sm" onClick={() => setDevirDuzen(null)}>Vazgeç</button>
                              </span>
                            ) : (
                              <button className="btn btn-sm" style={{ marginLeft: 6, fontSize: 11 }}
                                      onClick={() => {
                                        setDevirDuzen(t.toptanci);
                                        setDevirTutar(cari[t.toptanci].devir ? String(cari[t.toptanci].devir) : '');
                                        setDevirNot(cari[t.toptanci].devir_not || '');
                                      }}>✏ gir/düzenle</button>
                            )}
                            <div style={{ color: 'var(--text3)' }}>
                              1 Haziran ÖNCESİNDEN kalan bakiyeyi bir kez gir (tedarikçiye borcun kaldıysa +, fazla/peşin ödediysen −, borç kapandıysa 0/boş) — sonrasını sistem kendisi işler.
                            </div>
                          </div>
                          {/* 📜 YÜRÜYEN EKSTRE — fatura(+) ödeme(−) sırayla, bakiye yürür */}
                          {(cari[t.toptanci].hareketler || []).length > 0 && (
                            <details style={{ marginTop: 6 }}>
                              <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                                📜 Yürüyen Ekstre — güncel bakiye ≈ {fmt(cari[t.toptanci].yuruyen_bakiye)}
                              </summary>
                              <div style={{ maxHeight: 220, overflowY: 'auto', marginTop: 4 }}>
                                {cari[t.toptanci].hareketler.map((h, i) => (
                                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, padding: '2px 0', borderBottom: '1px solid var(--border)' }}>
                                    <span>
                                      {h.tarih} {h.tip === 'fatura' ? '🧾' : h.tip === 'devir' ? '📜' : '💸'} {(h.aciklama || '').slice(0, 40)}
                                      {h.goruntule && <>{' '}<a href={h.goruntule} target="_blank" rel="noreferrer" style={{ color: 'var(--blue, #60a5fa)' }}>📎</a></>}
                                    </span>
                                    <span style={{ whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }}>
                                      <span style={{ color: h.tip === 'odeme' ? 'var(--green)' : 'var(--red)' }}>
                                        {h.tip === 'odeme' ? '−' : h.tutar >= 0 ? '+' : ''}{fmt(h.tutar)}
                                      </span>
                                      {' '}<b style={{ color: h.bakiye < 0 ? 'var(--green)' : undefined }}
                                             title={h.bakiye < 0 ? 'Avans/alacak: ödemeler faturaları aşıyor' : undefined}>
                                        → {fmt(h.bakiye)}{h.bakiye < 0 ? ' 🟢avans' : ''}
                                      </b>
                                    </span>
                                  </div>
                                ))}
                              </div>
                              <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>
                                Ekstre 📜 açılış devriyle başlar (sistem öncesi bakiye — sahip beyanı). Borç yalnız FATURADAN doğar
                                (elle vadeli alım girişi çift saymaz — o vade takibi + ödeme izidir). Ödeme bakiyeden düşer; fatura tutarına
                                eşit olmak zorunda değil (avans/kısmi/toplu ödeme doğal desteklenir, eksi bakiye = avans). ≈ aday eşleşme.
                              </div>
                            </details>
                          )}
                          {/* AY AY MUTABAKAT — fatura ↔ ödeme; aya tıkla = detay + PDF */}
                          {(cari[t.toptanci].aylik || []).length > 0 && (
                            <div style={{ marginTop: 6 }}>
                              <table style={{ width: '100%', fontSize: 11 }}>
                                <thead><tr style={{ color: 'var(--text3)' }}>
                                  <th style={{ textAlign: 'left' }}>Ay</th>
                                  <th style={{ textAlign: 'right' }}>Fatura</th>
                                  <th style={{ textAlign: 'right' }}>Ödeme</th>
                                  <th style={{ textAlign: 'right' }}>Fark</th>
                                </tr></thead>
                                <tbody>
                                  {cari[t.toptanci].aylik.map(a => {
                                    const anahtar = `${t.toptanci}|${a.ay}`;
                                    return (
                                      <Fragment key={anahtar}>
                                        <tr key={anahtar} onClick={() => setAcikAy(x => x === anahtar ? null : anahtar)}
                                            style={{ cursor: 'pointer', opacity: a.sistem_oncesi ? 0.5 : 1 }}
                                            title={a.sistem_oncesi ? 'Sistem öncesi — arşiv, hesaba girmez' : 'Detay için tıkla'}>
                                          <td>{acikAy === anahtar ? '▾' : '▸'} {a.ay}{a.sistem_oncesi ? ' 🗄' : ''}</td>
                                          <td style={{ textAlign: 'right' }}>{a.fatura_adet > 0 ? `${fmt(a.fatura_toplam)} (${a.fatura_adet})` : '—'}</td>
                                          <td style={{ textAlign: 'right' }}>{a.odeme_adet > 0 ? `${fmt(a.odeme_toplam)} (${a.odeme_adet})` : '—'}</td>
                                          <td style={{ textAlign: 'right', color: a.fark > 0 ? 'var(--red)' : a.fark < 0 ? 'var(--green)' : 'var(--text3)' }}>{fmt(a.fark)}</td>
                                        </tr>
                                        {acikAy === anahtar && (
                                          <tr key={anahtar + '-d'}><td colSpan={4} style={{ padding: '4px 0 8px 14px' }}>
                                            {(cari[t.toptanci].faturalar || []).filter(f => String(f.tarih).slice(0, 7) === a.ay).map(f => (
                                              <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '2px 0' }}>
                                                <span>🧾 {f.tarih} · {f.fatura_no || 'no yok'}</span>
                                                <span style={{ whiteSpace: 'nowrap' }}>{fmt(f.tutar)}{' '}
                                                  <a href={f.goruntule} target="_blank" rel="noreferrer" style={{ color: 'var(--blue, #60a5fa)' }}>📎 PDF</a></span>
                                              </div>
                                            ))}
                                            {(cari[t.toptanci].odeme_adaylari || []).filter(o => String(o.tarih).slice(0, 7) === a.ay).map((o, i) => (
                                              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '2px 0', color: 'var(--text3)' }}>
                                                <span>💸 {o.tarih} · {o.kanal === 'kart' ? 'kart' : o.kanal === 'anlik_gider' ? 'nakit/anlık' : 'vadeli ödeme'} · {(o.aciklama || '').slice(0, 30)}</span>
                                                <span style={{ whiteSpace: 'nowrap' }}>−{fmt(o.tutar)}</span>
                                              </div>
                                            ))}
                                          </td></tr>
                                        )}
                                      </Fragment>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      )}
                      {(d.fatura_arsivi || []).filter(f => (f.tedarikci_ad || '(tedarikçi belirsiz)').trim() === t.toptanci || ((f.tedarikci_ad || '').trim() === '' && t.toptanci === '(tedarikçi belirsiz)')).map(f => (
                        <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0' }}>
                          <span>{f.tarih || '—'} · <span style={{ color: DURUM_RENK[f.durum] || 'var(--text3)' }}>{f.durum}</span></span>
                          <span>
                            {fmt(f.tutar)}{' '}
                            <a href={f.goruntule} target="_blank" rel="noreferrer" style={{ color: 'var(--blue, #60a5fa)' }}>📎 gör</a>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            )}

            {/* FATURASIZ HARCAMALAR (ödeme-temelli açığın ham listesi) */}
            {sekme === 'acik' && (
            <div className="card" style={{ padding: 16, gridColumn: '1 / -1' }}>
              <div style={{ fontWeight: 800, marginBottom: 8, color: 'var(--red)' }}>
                ⚠ Faturası Olmayan İşletme Harcamaları ({(d.faturasiz_harcamalar || []).length})
              </div>
              {(d.faturasiz_harcamalar || []).length === 0 && <div style={{ color: 'var(--green)', fontSize: 13 }}>Hepsi eşleşti 🎉</div>}
              <div style={{ maxHeight: 340, overflowY: 'auto' }}>
                {(d.faturasiz_harcamalar || []).map((h, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                    <span>{h.tarih} · {(h.kart || '').slice(0, 16)} · {h.aciklama}{h.tip === 'belirsiz' ? ' · ❓' : ''}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{fmt(h.tutar)}</span>
                  </div>
                ))}
              </div>
              {/* 🏢 KURUMSAL OTOMATİK (MEPAŞ vb) — faturasız DEĞİL: belgesi kurumda hazır */}
              {(d.kurumsal_harcamalar || []).length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontWeight: 700, fontSize: 12, color: '#f59e0b', marginBottom: 4 }}>
                    🏢 Kurumsal Otomatik Ödemeler ({d.kurumsal_harcamalar.length}) — faturası kurumda hazır
                    {' '}<a href="https://ebelge.gib.gov.tr/earsivsorgula.html" target="_blank" rel="noreferrer" style={{ color: 'var(--blue, #60a5fa)', fontWeight: 400 }}>🏛️ e-Arşiv'den indir</a>
                  </div>
                  <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                    {d.kurumsal_harcamalar.map((h, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, padding: '3px 0', borderBottom: '1px solid var(--border)', color: 'var(--text3)' }}>
                        <span>{h.tarih} · {(h.kart || '').slice(0, 16)} · {h.aciklama}</span>
                        <span style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{fmt(h.tutar)}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                    İndirdiğin PDF'i Belge Merkezi'ne yükleyince satır faturalıya geçer (KDV indirimi + gider kanıtı).
                  </div>
                </div>
              )}
            </div>
            )}
          </div>

          {/* GÜN GÜN */}
          {sekme === 'belge' && (
          <div className="card" style={{ padding: 16, marginTop: 14 }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>📅 Gün Gün</div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Gün</th><th style={{ textAlign: 'right' }}>Fatura (adet)</th><th style={{ textAlign: 'right' }}>Fatura toplamı</th><th style={{ textAlign: 'right' }}>Faturasız harcama</th></tr></thead>
                <tbody>
                  {(d.gun_gun || []).map(g => (
                    <tr key={g.gun}>
                      <td>{g.gun}</td>
                      <td style={{ textAlign: 'right' }}>{g.fatura_adet}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(g.fatura_toplam)}</td>
                      <td style={{ textAlign: 'right', color: g.faturasiz_harcama > 0 ? 'var(--red)' : 'var(--text3)' }}>{fmt(g.faturasiz_harcama)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8 }}>
            {sekme === 'belge' ? d.not : (mk?.not || '')}
          </div>
        </>
      )}
    </div>
  );
}
