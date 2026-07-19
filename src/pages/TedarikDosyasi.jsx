import { useState, useEffect } from 'react';
import { api, fmt, fmtDate } from '../utils/api';

// ─────────────────────────────────────────────────────────────────────────
// Tedarik Dosyası — bir siparişin TÜM zinciri tek ekranda:
//   N1 talep · N2 toptancı siparişleri · kabul farkı (N3↔N4) · fatura + 📷 + fiyat
// Veri: GET /api/ops/tedarik-dosyasi (liste) + /tedarik-dosyasi/{id} (detay)
// ─────────────────────────────────────────────────────────────────────────

const DURUM_RENK = {
  bekliyor: 'var(--orange)', gonderildi: '#3b82f6', hazirlaniyor: '#3b82f6',
  teslim_edildi: 'var(--green)', kabul_uyusmazlik: 'var(--red)', iptal: '#94a3b8',
};

export default function TedarikDosyasi() {
  const [dosyalar, setDosyalar] = useState([]);
  const [loading, setLoading] = useState(false);
  const [seciliId, setSeciliId] = useState(null);
  const [detay, setDetay] = useState({});       // id -> detay objesi
  const [detayYuk, setDetayYuk] = useState(false);
  const [fotoUrl, setFotoUrl] = useState(null);
  const [hata, setHata] = useState('');
  const [gorunum, setGorunum] = useState('siparisler'); // 'siparisler' | 'teslimler'
  const [teslimler, setTeslimler] = useState([]);
  const [teslimYuk, setTeslimYuk] = useState(false);
  const [guvenilirlik, setGuvenilirlik] = useState([]);
  const [guvenYuk, setGuvenYuk] = useState(false);

  const listeYukle = () => {
    setLoading(true);
    api('/ops/tedarik-dosyasi')
      .then(r => setDosyalar((r && r.dosyalar) || []))
      .catch(e => setHata(e.message || 'Liste yüklenemedi'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { listeYukle(); }, []);

  const dosyaAc = async (id) => {
    setSeciliId(id);
    if (detay[id]) return;
    setDetayYuk(true);
    try {
      const d = await api('/ops/tedarik-dosyasi/' + encodeURIComponent(id));
      setDetay(prev => ({ ...prev, [id]: d }));
    } catch (e) { setHata(e.message || 'Dosya yüklenemedi'); }
    finally { setDetayYuk(false); }
  };

  const teslimYukle = () => {
    setTeslimYuk(true);
    api('/ops/teslim-alimlari')
      .then(r => setTeslimler((r && r.teslimler) || []))
      .catch(e => setHata(e.message || 'Teslimler yüklenemedi'))
      .finally(() => setTeslimYuk(false));
  };
  useEffect(() => { if (gorunum === 'teslimler') teslimYukle(); }, [gorunum]);

  const guvenYukle = () => {
    setGuvenYuk(true);
    api('/ops/tedarikci-guvenilirlik?gun=60')
      .then(r => setGuvenilirlik((r && r.tedarikciler) || []))
      .catch(e => setHata(e.message || 'Güvenilirlik yüklenemedi'))
      .finally(() => setGuvenYuk(false));
  };
  useEffect(() => { if (gorunum === 'guvenilirlik') guvenYukle(); }, [gorunum]);

  const d = seciliId ? detay[seciliId] : null;

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>🧾 Tedarik Dosyası</h2>
        <button className="btn btn-secondary btn-sm" onClick={listeYukle}>↻ Yenile</button>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text3)', marginTop: 0, marginBottom: 14 }}>
        Bir siparişe tıkla → tüm zincir tek yerde: ne ısmarlandı, ne geldi, faturası, fiyatı.
      </p>
      {hata && <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 10 }}>⚠️ {hata}</div>}

      {/* Görünüm sekmesi */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {[['siparisler', '📦 Siparişler'], ['teslimler', '📥 Teslim Alımları (saat saat)'], ['guvenilirlik', '🚚 Tedarikçi Güvenilirlik']].map(([k, l]) => (
          <button key={k} onClick={() => setGorunum(k)}
            style={{
              cursor: 'pointer', fontSize: 13, fontWeight: 700, padding: '7px 14px', borderRadius: 10,
              border: `1px solid ${gorunum === k ? '#3b82f6' : 'var(--border)'}`,
              background: gorunum === k ? 'rgba(59,130,246,0.10)' : 'var(--bg3)', color: 'var(--text)',
            }}>{l}</button>
        ))}
      </div>

      {gorunum === 'teslimler' && (
        <div className="card">
          <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>
            Şubelerin "Ürün Teslim Al" ile aldığı tüm teslimler — siparişsiz gelenler dahil, en yeniden eskiye.
          </div>
          {teslimYuk && <div style={{ fontSize: 12, color: 'var(--text3)' }}>Yükleniyor…</div>}
          {!teslimYuk && teslimler.length === 0 && <div className="empty"><p>Bu dönemde teslim alımı yok.</p></div>}
          {teslimler.map(t => (
            <div key={t.id} style={{ display: 'flex', gap: 10, padding: '8px 4px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text2)', minWidth: 96, whiteSpace: 'nowrap' }}>{t.olay_ts}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {t.sube_adi} <span style={{ color: 'var(--text3)', fontWeight: 500 }}>· 🚚 {t.tedarikci}</span>
                  {t.siparisli
                    ? <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 20, background: '#3b82f6', color: '#fff' }}>siparişli</span>
                    : <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 20, background: 'var(--orange)', color: '#fff' }}>siparişsiz</span>}
                  {t.teslim_durumu === 'eksik_var' && <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 20, background: 'var(--red)', color: '#fff' }}>eksik</span>}
                </div>
                {t.kalemler?.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                    {t.kalemler.map((k, i) => (
                      <span key={i} style={{ fontSize: 11, padding: '1px 7px', borderRadius: 6, background: 'var(--bg2)', border: '1px solid var(--border)' }}>{k.ad} <b>×{k.adet}</b></span>
                    ))}
                  </div>
                )}
                {t.personel_ad && <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>👤 {t.personel_ad}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {gorunum === 'guvenilirlik' && (
        <div className="card">
          <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>
            Son 60 gün kabul farkları tedarikçi başına. <b>Birden çok şubede</b> fark → "tedarikçi paterni" (şube masum). Tek şube → belirsiz (sayım/şube de olabilir).
          </div>
          {guvenYuk && <div style={{ fontSize: 12, color: 'var(--text3)' }}>Yükleniyor…</div>}
          {!guvenYuk && guvenilirlik.length === 0 && <div className="empty"><p>Bu dönemde kabul farkı yok — temiz. ✓</p></div>}
          {guvenilirlik.map(t => {
            const cokSube = t.sonuc === 'tedarikci_paterni';
            return (
              <div key={t.tedarikci} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 4px', borderBottom: '1px solid var(--border)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    🚚 {t.tedarikci}
                    {cokSube
                      ? <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: 'var(--red)', color: '#fff' }}>tedarikçi paterni ({t.sube_sayisi} şube)</span>
                      : <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: 'var(--orange)', color: '#fff' }}>tek şube — belirsiz</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>
                    {t.olay_sayisi} kabul farkı · {t.sube_sayisi} şube ({(t.subeler || []).join(', ')})
                    {t.eksik_toplam > 0 ? ` · toplam ${t.eksik_toplam} eksik` : ''}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {gorunum === 'siparisler' && (
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 360px) 1fr', gap: 16, alignItems: 'start' }}>
        {/* SOL: liste */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {loading && <div style={{ fontSize: 12, color: 'var(--text3)' }}>Yükleniyor…</div>}
          {!loading && dosyalar.length === 0 && (
            <div className="empty"><p>Toptancı siparişi bulunan kayıt yok.</p></div>
          )}
          {dosyalar.map(f => {
            const sec = seciliId === f.talep_id;
            const renk = DURUM_RENK[f.durum] || 'var(--text3)';
            return (
              <button key={f.talep_id} onClick={() => dosyaAc(f.talep_id)}
                style={{
                  textAlign: 'left', cursor: 'pointer', borderRadius: 10, padding: '10px 12px',
                  background: sec ? 'rgba(59,130,246,0.08)' : 'var(--bg3)',
                  border: `1px solid ${sec ? '#3b82f6' : 'var(--border)'}`,
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: renk, flexShrink: 0 }} />
                  <span style={{ fontWeight: 700, fontSize: 13 }}>{f.sube_adi || '—'}</span>
                  <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 'auto' }}>{f.tarih ? fmtDate(f.tarih) : ''}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>🚚 {f.tedarikciler || '—'}</div>
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 20, background: renk, color: '#fff' }}>{f.durum}</span>
                  {f.fatura_say > 0 && <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 20, background: '#a855f7', color: '#fff' }}>📄 {f.fatura_say}</span>}
                  {f.kabul_durum === 'kabul_uyusmazlik' && <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 20, background: 'var(--red)', color: '#fff' }}>⚠ fark</span>}
                </div>
              </button>
            );
          })}
        </div>

        {/* SAĞ: detay zinciri */}
        <div className="card" style={{ minHeight: 200 }}>
          {!seciliId && <div style={{ fontSize: 13, color: 'var(--text3)' }}>← Soldan bir sipariş seç.</div>}
          {seciliId && detayYuk && !d && <div style={{ fontSize: 13, color: 'var(--text3)' }}>Dosya yükleniyor…</div>}
          {d && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 800 }}>{d.sube_adi} · {d.tarih ? fmtDate(d.tarih) : ''}</div>
                <div style={{ fontSize: 12, color: 'var(--text3)' }}>Durum: {d.durum} {d.kabul_durum ? `· kabul: ${d.kabul_durum}` : ''}</div>
              </div>

              {/* N1: Şube talebi */}
              <Bolum baslik="1 · Şube ne istedi (talep)">
                {d.n1_talep?.length ? (
                  <KalemSatirlari kalemler={d.n1_talep} />
                ) : <Bos>Talep kalemi yok.</Bos>}
              </Bolum>

              {/* N2: Toptancı siparişleri */}
              <Bolum baslik="2 · Toptancıya ne sipariş edildi">
                {d.n2_siparisler?.length ? d.n2_siparisler.map(s => (
                  <div key={s.id} style={{ marginBottom: 8, padding: '8px 10px', background: 'var(--bg3)', borderRadius: 8, border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, display: 'flex', gap: 8, alignItems: 'center' }}>
                      🚚 {s.tedarikci_ad}
                      {s.wa_gonderildi && <span title="WhatsApp gönderildi" style={{ fontSize: 11 }}>📲</span>}
                      <span style={{ fontSize: 10, marginLeft: 'auto', padding: '1px 7px', borderRadius: 20, background: s.teslim_alindi ? 'var(--green)' : 'var(--orange)', color: '#fff', fontWeight: 700 }}>
                        {s.teslim_alindi ? 'teslim alındı' : 'bekleniyor'}
                      </span>
                    </div>
                    <KalemSatirlari kalemler={s.kalemler} />
                  </div>
                )) : <Bos>Henüz toptancıya yollanmadı.</Bos>}
              </Bolum>

              {/* Kabul farkı (N3↔N4) */}
              {d.kabul_farklar?.length > 0 && (
                <Bolum baslik="⚠ Kabul farkı (gelen ≠ beklenen)">
                  {d.kabul_farklar.map((k, i) => (
                    <div key={i} style={{ fontSize: 12, color: 'var(--red)', padding: '2px 0' }}>
                      {k.urun_ad}: beklenen {k.istenen}, sayılan {k.kabul} ({k.fark > 0 ? '+' : ''}{k.fark})
                      {k.aciklama ? ` — “${k.aciklama}”` : ''}
                    </div>
                  ))}
                </Bolum>
              )}

              {/* N3: Faturalar + foto + fiyat */}
              <Bolum baslik="3 · Fatura (fiyat + kanıt)">
                {d.faturalar?.length ? d.faturalar.map(f => (
                  <div key={f.id} style={{ marginBottom: 8, padding: '8px 10px', background: 'var(--bg3)', borderRadius: 8, border: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {f.foto_var && (
                        <button className="btn btn-ghost btn-sm" title="Şubenin gönderdiği fatura fotoğrafı"
                          onClick={() => setFotoUrl('/api/fatura/' + encodeURIComponent(f.id) + '/foto')}
                          style={{ fontSize: 18, padding: '2px 8px', lineHeight: 1 }}>📷</button>
                      )}
                      <span style={{ fontWeight: 700, fontSize: 13 }}>{f.tedarikci_ad}</span>
                      <span style={{ fontSize: 11, color: 'var(--text3)' }}>
                        {f.fatura_tarih ? fmtDate(f.fatura_tarih) : ''}{f.toplam_tutar != null ? ` · ${fmt(f.toplam_tutar)}` : ''}
                      </span>
                      <span style={{ fontSize: 10, marginLeft: 'auto', color: 'var(--text3)' }}>{f.durum}</span>
                    </div>
                    {f.kalemler?.length > 0 && (
                      <table style={{ width: '100%', fontSize: 11, marginTop: 6, borderCollapse: 'collapse' }}>
                        <tbody>
                          {f.kalemler.map((k, i) => (
                            <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                              <td style={{ padding: '3px 0' }}>{k.ocr_ad || '—'}</td>
                              <td style={{ textAlign: 'right', color: 'var(--text3)' }}>{k.adet ?? '-'}</td>
                              <td style={{ textAlign: 'right', fontWeight: 700 }}>{k.birim_fiyat != null ? `${fmt(k.birim_fiyat)}` : '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )) : <Bos>Bu siparişe bağlı fatura yok. (Şube "Fatura Çek" ile ekleyebilir.)</Bos>}
                <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>
                  Fiyatları onaylamak/güncellemek için: <b>Maliyet → 📱 Telefon Faturaları</b>.
                </div>
              </Bolum>
            </div>
          )}
        </div>
      </div>
      )}

      {/* Foto kanıt modalı */}
      {fotoUrl && (
        <div onClick={() => setFotoUrl(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.82)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <img src={fotoUrl} alt="Fatura fotoğrafı" onClick={e => e.stopPropagation()}
            style={{ maxWidth: '96%', maxHeight: '92%', borderRadius: 10, background: '#fff' }} />
        </div>
      )}
    </div>
  );
}

function Bolum({ baslik, children }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>{baslik}</div>
      {children}
    </div>
  );
}
function KalemSatirlari({ kalemler }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
      {(kalemler || []).map((k, i) => (
        <span key={i} style={{ fontSize: 12, padding: '2px 8px', borderRadius: 6, background: 'var(--bg2)', border: '1px solid var(--border)' }}>
          {k.urun_ad} <b>×{k.adet}</b>
        </span>
      ))}
    </div>
  );
}
function Bos({ children }) {
  return <div style={{ fontSize: 12, color: 'var(--text3)' }}>{children}</div>;
}
