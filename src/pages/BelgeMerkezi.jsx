import { useState, useEffect } from 'react';
import { api, fmt } from '../utils/api';

// 🧾 BELGE MERKEZİ (2026-07-10) — sahip: "faturaları toptancı toptancı, ay ay,
// gün gün görebildiğim; işletme harcamalarından faturası OLMAYANLARI direkt
// gördüğüm mekanizma". Kaynak: /api/fatura/belge-merkezi (salt-okur).
const DURUM_RENK = { ocr_bekliyor: '#f59e0b', incelendi: '#22c55e', onaylandi: '#22c55e' };

export default function BelgeMerkezi() {
  const bugunAy = new Date().toISOString().slice(0, 7);
  const [ay, setAy] = useState(bugunAy);
  const [d, setD] = useState(null);
  const [hata, setHata] = useState('');
  const [acikToptanci, setAcikToptanci] = useState(null);
  // BM-5: toptancı açılınca cari ekstre (beyan bakiye + vade + zincir)
  const [cari, setCari] = useState({});
  async function cariGetir(ad) {
    if (!ad || ad === '(tedarikçi belirsiz)' || cari[ad]) return;
    try {
      const r = await api(`/fatura/cari-ekstre?tedarikci=${encodeURIComponent(ad)}`);
      setCari(c => ({ ...c, [ad]: r }));
    } catch { setCari(c => ({ ...c, [ad]: { hata: true } })); }
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

  useEffect(() => {
    setD(null); setHata('');
    api(`/fatura/belge-merkezi?ay=${ay}`).then(setD)
      .catch(e => setHata(e?.message || 'Yüklenemedi'));
  }, [ay]);

  const k = d?.kapsama || {};
  const oran = k.oran_yuzde;

  return (
    <div style={{ padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>🧾 Belge Merkezi</h2>
        <input type="month" value={ay} onChange={e => setAy(e.target.value)}
          style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px' }} />
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>
          Fatura arşivi · faturasız harcamalar · gün gün kapsama
        </span>
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
          {/* KAPSAMA BARI */}
          <div className="card" style={{ padding: 16, marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <div style={{ fontWeight: 800 }}>Belge Kapsama — {d.ay}</div>
              <div style={{ fontSize: 13, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <span>💳 İşletme kart harcaması: <b>{fmt(k.isletme_kart_harcamasi || 0)}</b></span>
                <span style={{ color: 'var(--green)' }}>🧾 Faturalı: <b>{fmt(k.faturali_eslesen || 0)}</b></span>
                <span style={{ color: 'var(--red)' }}>⚠ Faturasız: <b>{fmt(k.faturasiz || 0)}</b></span>
              </div>
            </div>
            <div style={{ marginTop: 10, height: 14, borderRadius: 999, background: 'rgba(239,68,68,.25)', overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(100, oran || 0)}%`, height: '100%', background: 'var(--green)' }} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>
              Kapsama: {oran != null ? `%${oran}` : '—'} · faturasız kısım = belge isteme adayı (KDV indirimi + gider kanıtı)
            </div>
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

          {/* BM-2 — MUTABAKAT ZİNCİRİ (eksik halkalar varsa) */}
          {mz && mz.siparis_adet > 0 && (mz.sayac?.tam ?? 0) < mz.siparis_adet && (
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

          {/* BM-4 — FATURA İSTE (ödenmiş ama faturasız ≥eşik ödemeler) */}
          {fi && (
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
                      {g.wa_link
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
                          onClick={() => fiKapat(x.id)} title="Manuel kapat (açıklama zorunlu)">✔</button>
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* BM-6 — FİYAT BANDI (band dışı son alımlar; öneri-only) */}
          {fb && fb.band_disi_adet > 0 && (
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
            {/* TOPTANCILAR */}
            <div className="card" style={{ padding: 16 }}>
              <div style={{ fontWeight: 800, marginBottom: 8 }}>🏪 Toptancı Toptancı ({(d.toptancilar || []).length})</div>
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
                          💼 Cari: beyan bakiye{' '}
                          <b>{cari[t.toptanci].beyan_bakiye != null ? `≈ ${fmt(cari[t.toptanci].beyan_bakiye)}` : 'fatura üstünde yok'}</b>
                          {cari[t.toptanci].bekleyen_vade_toplam > 0 && (
                            <> · bekleyen vade <b style={{ color: 'var(--red)' }}>{fmt(cari[t.toptanci].bekleyen_vade_toplam)}</b>
                              {cari[t.toptanci].bekleyen_vadeler?.[0] && ` (en yakın ${cari[t.toptanci].bekleyen_vadeler[0].vade})`}</>
                          )}
                          {(cari[t.toptanci].faturalar || []).some(f => f.zincir_fark != null && f.zincir_fark !== 0) && (
                            <span style={{ color: 'var(--text3)' }}> · zincirde ödeme/hareket izi var</span>
                          )}
                          <div style={{ color: 'var(--text3)', marginTop: 2 }}>
                            beyan = tedarikçinin fatura üstü bakiyesi (≈, mutabakat hükmü değil)
                          </div>
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

            {/* FATURASIZ HARCAMALAR */}
            <div className="card" style={{ padding: 16 }}>
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
            </div>
          </div>

          {/* GÜN GÜN */}
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
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8 }}>{d.not}</div>
        </>
      )}
    </div>
  );
}
