import { useState, useEffect } from 'react';
import { api, fmt, fmtDate } from '../utils/api';

const BOSH = { kart_adi: '', banka: '', limit_tutar: '', kesim_gunu: 15, son_odeme_gunu: 25,
  faiz_orani: '', asgari_oran: 40, gecikme_faiz_orani: '', sahip: 'İşletme', ortak_limit_grup: '' };

export default function Kartlar() {
  const [kartlar, setKartlar] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(BOSH);
  const [duzenleId, setDuzenleId] = useState(null);
  const [msg, setMsg] = useState(null);
  // Kart-odaklı araç çubuğu: arama + sıralama (bu sayfada işe yarayan şey budur)
  const [arama, setArama] = useState('');
  const [sirala, setSirala] = useState('borc'); // borc | kullanim | sonodeme | ad

  const load = () => api('/kartlar').then((k) => setKartlar(k || []));
  useEffect(() => { load(); }, []);

  const toast = (m, t = 'green') => { setMsg({ m, t }); setTimeout(() => setMsg(null), 3000); };

  async function kaydet() {
    try {
      if (duzenleId) await api(`/kartlar/${duzenleId}`, { method: 'PUT', body: form });
      else await api('/kartlar', { method: 'POST', body: form });
      toast(duzenleId ? 'Kart güncellendi' : 'Kart eklendi');
      setShowModal(false); setForm(BOSH); setDuzenleId(null); load();
    } catch (e) { toast(e.message, 'red'); }
  }

  async function sil(id) {
    if (!confirm('Kartı pasife almak istiyor musunuz?')) return;
    try { await api(`/kartlar/${id}`, { method: 'DELETE' }); toast('Kart pasife alındı'); load(); }
    catch (e) { toast(e.message, 'red'); }
  }
  async function kaliciSil(k) {
    if (!confirm(`"${k.kart_adi}" kartı KALICI olarak silinecek (geri alınamaz).\n\nYalnızca işlemi olmayan (test/yanlış) kartlar silinebilir. Devam?`)) return;
    const pin = window.prompt('İşletme onayı — Merve Karabacak 4 haneli PIN:');
    if (!pin) return;
    try {
      const r = await api(`/kartlar/${k.id}/kalici-sil`, { method: 'POST', body: { onay_pin: pin } });
      toast(`"${r.kart_adi}" kalıcı silindi`); load();
    } catch (e) { toast(e.message || 'Silinemedi — işlemi olan kart için "Pasife Al" kullanın', 'red'); }
  }

  function duzenle(k) {
    setForm({ kart_adi: k.kart_adi, banka: k.banka, limit_tutar: k.limit_tutar,
      kesim_gunu: k.kesim_gunu, son_odeme_gunu: k.son_odeme_gunu,
      faiz_orani: k.faiz_orani,
      asgari_oran: k.asgari_oran ?? 40,
      gecikme_faiz_orani: k.gecikme_faiz_orani ?? 0,
      sahip: k.sahip ?? 'İşletme',
      ortak_limit_grup: k.ortak_limit_grup ?? '' });
    setDuzenleId(k.id); setShowModal(true);
  }

  const riskClass = (doluluk) => doluluk > 0.9 ? 'red' : doluluk > 0.7 ? 'yellow' : 'green';

  const TR_AYLAR = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
  const ayEtiketi = (s) => {
    if (!s) return '—';
    const m = String(s).match(/^(\d{4})-(\d{2})$/);
    if (!m) return s;
    return `${TR_AYLAR[parseInt(m[2], 10) - 1]} ${m[1]}`;
  };
  const trGun = (iso) => {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return `${d.getDate()} ${TR_AYLAR[d.getMonth()].slice(0, 3)}`;
    } catch { return iso; }
  };
  const oncekiDurumEtiket = (d) => {
    if (d === 'tam') return { txt: '✓ önceki tam ödendi', renk: 'var(--green)' };
    if (d === 'asgari_odendi') return { txt: '⚠ asgari ödendi (kalan devretti)', renk: 'var(--yellow)' };
    if (d === 'asgari_odenmedi') return { txt: '⛔ asgari ödenmedi (gecikme faizi)', renk: 'var(--red)' };
    return null;
  };

  const aktifKartlar = kartlar.filter((k) => k.aktif);

  // Üst özet — kart bazlı (bu sayfada anlamlı olan)
  const toplamBorc = aktifKartlar.reduce((s, k) => s + (parseFloat(k.guncel_borc) || 0), 0);
  const toplamLimit = aktifKartlar.reduce((s, k) => s + (parseFloat(k.limit_tutar) || 0), 0);
  const bosLimit = toplamLimit - toplamBorc;

  // Arama + sıralama → gösterilen kartlar
  const q = arama.trim().toLowerCase();
  const gosterilenKartlar = aktifKartlar
    .filter((k) => !q || `${k.kart_adi || ''} ${k.banka || ''} ${k.sahip || ''}`.toLowerCase().includes(q))
    .sort((a, b) => {
      if (sirala === 'ad') return String(a.kart_adi || '').localeCompare(String(b.kart_adi || ''), 'tr');
      if (sirala === 'kullanim') return (b.limit_doluluk || 0) - (a.limit_doluluk || 0);
      if (sirala === 'sonodeme') return (a.gun_kaldi ?? 99) - (b.gun_kaldi ?? 99);
      return (parseFloat(b.guncel_borc) || 0) - (parseFloat(a.guncel_borc) || 0); // borc (vars.)
    });

  async function bozukTemizle() {
    if (!window.confirm('TÜM kartların hareket kayıtları iptal edilecek (borçlar sıfırlanır).\n\nBu, açılış devri kurmadan önceki temizliktir. Kasaya dokunmaz. Devam?')) return;
    const pin = window.prompt('İşletme onayı — Merve Karabacak 4 haneli PIN:');
    if (!pin) return;
    try {
      const r = await api('/kartlar/__hepsi__/ledger-sifirla', { method: 'POST', body: { onay_pin: pin, hepsi: true } });
      setMsg({ t: 'green', m: `✓ ${r.kart_sayisi} kart temizlendi (${r.iptal_edilen_hareket} hareket iptal). Şimdi her karta ekstre yükleyip "devir olarak kabul et" diyebilirsin.` });
      load();
    } catch (e) { setMsg({ t: 'red', m: e.message || 'Temizlenemedi' }); }
  }

  async function tamSifirla(k) {
    const hedef = k ? `"${k.kart_adi}" kartının` : 'TÜM kartların';
    if (!window.confirm(`${hedef} hareket geçmişi, ekstre dönem kayıtları (faiz hesaplamaları dahil), ödeme planı ve ekstre-aktarımlı giderleri KALICI olarak silinecek.\n\nSadece kart tanımı (isim/banka/limit) kalır — sanki hiç ekstre yüklenmemiş gibi sıfırdan başlarsın. Geri alınamaz. Devam?`)) return;
    const pin = window.prompt('İşletme onayı — Merve Karabacak 4 haneli PIN:');
    if (!pin) return;
    try {
      const r = await api(`/kartlar/${k ? k.id : '__hepsi__'}/tam-sifirla`, { method: 'POST', body: { onay_pin: pin } });
      const adlar = r.kartlar.map(x => x.kart_adi).join(', ');
      setMsg({ t: 'green', m: `✓ Tam sıfırlandı: ${adlar}. Artık "Ekstre Yükle" ile sıfırdan yükleyebilirsin.` });
      load();
    } catch (e) { setMsg({ t: 'red', m: e.message || 'Sıfırlanamadı' }); }
  }

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header flex items-center justify-between">
        <div><h2>Kartlar</h2><p>{aktifKartlar.length} aktif kart</p></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={() => { setForm(BOSH); setDuzenleId(null); setShowModal(true); }}>+ Kart Ekle</button>
        </div>
      </div>

      {/* Kart araç çubuğu — arama + sıralama + kart-bazlı özet (bu sayfaya özgü işlevsel) */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        marginBottom: 16, padding: '10px 12px', background: 'var(--bg2)',
        border: '1px solid var(--border)', borderRadius: 10,
      }}>
        <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 180 }}>
          <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)', fontSize: 13, pointerEvents: 'none' }}>🔍</span>
          <input
            value={arama} onChange={(e) => setArama(e.target.value)}
            placeholder="Kart / banka / sahip ara…"
            style={{ width: '100%', padding: '9px 12px 9px 32px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text1)', fontSize: 13 }}
          />
          {arama && (
            <button onClick={() => setArama('')} title="Temizle"
              style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 14 }}>✕</button>
          )}
        </div>

        {/* Sıralama — segmentli butonlar (dropdown'dan hızlı) */}
        <div style={{ display: 'flex', gap: 3, background: 'var(--bg3)', borderRadius: 8, padding: 3 }}>
          {[
            { k: 'borc', l: '💸 Borç' },
            { k: 'kullanim', l: '📊 Kullanım' },
            { k: 'sonodeme', l: '⏰ Son Ödeme' },
            { k: 'ad', l: 'A–Z' },
          ].map((o) => (
            <button key={o.k} onClick={() => setSirala(o.k)}
              style={{
                padding: '6px 11px', fontSize: 12, fontWeight: sirala === o.k ? 700 : 500,
                border: 'none', borderRadius: 6, cursor: 'pointer',
                background: sirala === o.k ? 'var(--primary)' : 'transparent',
                color: sirala === o.k ? '#fff' : 'var(--text2)', transition: 'background .15s',
              }}>{o.l}</button>
          ))}
        </div>

        {/* Kart-bazlı özet */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginLeft: 'auto', fontSize: 12 }}>
          <span className="badge">{gosterilenKartlar.length}{q ? `/${aktifKartlar.length}` : ''} kart</span>
          <span className="badge badge-red" title="Toplam güncel borç">Borç: {fmt(toplamBorc)}</span>
          <span className="badge badge-green" title="Toplam boş limit">Boş: {fmt(bosLimit)}</span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 14 }}>
        {gosterilenKartlar.length === 0 && (
          <div className="card" style={{ gridColumn: '1/-1', padding: 24, textAlign: 'center', color: 'var(--text3)' }}>
            {q ? `"${arama}" ile eşleşen kart yok` : 'Aktif kart yok — “+ Kart Ekle” ile başla'}
          </div>
        )}
        {gosterilenKartlar.map(k => {
          const risk = riskClass(k.limit_doluluk || 0);
          const onceki = oncekiDurumEtiket(k.onceki_durum);
          return (
            <div key={k.id} className="card" style={{ borderTop: `3px solid var(--${risk})` }}>
              <div className="flex items-center justify-between mb-16">
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}
                    className={k.blink ? 'blink' : ''}>
                    💳 {k.kart_adi}
                    {k.blink && <span className="badge badge-red" style={{ marginLeft: 6 }}>SON GÜN</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>{k.banka}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className={`amount ${risk === 'red' ? 'amount-neg' : ''}`} style={{ fontSize: 18, fontWeight: 700 }}>
                    {fmt(k.guncel_borc)}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>güncel borç</div>
                </div>
              </div>

              {/* ── AKTİF DÖNEM BADGE — hangi ay hesaplanıyor? ── */}
              {k.aktif_donem && (
                <div style={{
                  background: 'linear-gradient(90deg, rgba(79,142,247,0.12), rgba(79,142,247,0.04))',
                  border: '1px solid rgba(79,142,247,0.35)',
                  borderRadius: 8,
                  padding: '8px 12px',
                  marginBottom: 12,
                  fontSize: 12,
                }}>
                  <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
                    <span style={{ fontWeight: 700, color: '#4f8ef7' }}>
                      📅 Aktif Dönem: {ayEtiketi(k.aktif_donem)}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--text3)' }}>
                      {k.gun_kaldi >= 0 ? `${k.gun_kaldi} gün kaldı` : `${Math.abs(k.gun_kaldi)} gün geçti`}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <span>🔪 Kesim: <strong style={{ color: 'var(--text)' }}>{trGun(k.aktif_kesim)}</strong></span>
                    <span>💰 Son ödeme: <strong style={{ color: 'var(--text)' }}>{trGun(k.aktif_son_odeme)}</strong></span>
                  </div>
                  {onceki && (
                    <div style={{ fontSize: 10, marginTop: 4, color: onceki.renk }}>
                      {onceki.txt}
                      {(k.devreden_anapara > 0 || k.devreden_faiz > 0) && (
                        <span style={{ color: 'var(--text3)', marginLeft: 4 }}>
                          (anapara {fmt(k.devreden_anapara)} + faiz {fmt(k.devreden_faiz)})
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div style={{ marginBottom: 12 }}>
                <div className="flex items-center justify-between" style={{ marginBottom: 4, fontSize: 12 }}>
                  <span style={{ color: 'var(--text3)' }}>Limit Kullanımı</span>
                  <span className={`risk-${risk}`}>{((k.limit_doluluk||0)*100).toFixed(0)}%</span>
                </div>
                <div className="progress-bar">
                  <div className={`progress-fill ${risk}`} style={{ width: `${Math.min(100,(k.limit_doluluk||0)*100)}%` }}/>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 }}>
                {[
                  ['Limit', fmt(k.limit_tutar)],
                  ['Kullanılabilir', fmt(k.kalan_limit)],
                  [`Asgari (${ayEtiketi(k.aktif_donem) || 'bu dönem'})`, fmt(k.asgari_odeme)],
                  ['Bu Ekstre', fmt(k.bu_ekstre)],
                  ['Faiz / Asgari Oranı', `%${k.faiz_orani} / %${k.asgari_oran ?? 40}`],
                  ['Ham Kesim/Son Öd.', `${k.kesim_gunu}/${k.son_odeme_gunu}. gün`],
                  ['Kart Sahibi', k.sahip || 'İşletme'],
                  ...(k.ortak_grup_uye ? [[`🔗 Ortak Limit (${k.ortak_grup_uye} kart)`, `${fmt(k.ortak_grup_borc)} / ${fmt(k.ortak_grup_limit)}`]] : []),
                ].map(([label, val]) => (
                  <div key={label} style={{ background: 'var(--bg3)', borderRadius: 6, padding: '7px 10px' }}>
                    <div style={{ color: 'var(--text3)', marginBottom: 2, fontSize: 11 }}>{label}</div>
                    <div className="mono">{val}</div>
                  </div>
                ))}
              </div>

              <div className="flex gap-8" style={{ marginTop: 12 }}>
                <button className="btn btn-secondary btn-sm" onClick={() => duzenle(k)}>✏️ Düzenle</button>
                <button className="btn btn-danger btn-sm" onClick={() => sil(k.id)}>Pasife Al</button>
                <button className="btn btn-danger btn-sm" title="Kalıcı sil (yalnızca işlemsiz kart)" onClick={() => kaliciSil(k)} style={{ background: 'transparent', color: 'var(--red)' }}>🗑 Sil</button>
                <button className="btn btn-sm" title="Bu kartın tüm geçmişini (hareket+ekstre+faiz) sil, sadece tanımı kalsın" onClick={() => tamSifirla(k)} style={{ background: 'transparent', color: 'var(--orange)', borderColor: 'var(--orange)' }}>♻️ Tam Sıfırla</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bakım / nadir işlemler — en altta, kazara tıklanmasın */}
      <div style={{ marginTop: 22, paddingTop: 14, borderTop: '1px dashed var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-sm" style={{ borderColor: 'var(--orange)', color: 'var(--orange)', background: 'transparent' }}
          title="Bozuk/karışık kart hareketlerini temizle (açılış devri öncesi)" onClick={bozukTemizle}>
          🧹 Bozuk Kayıtları Temizle
        </button>
        <button className="btn btn-sm" style={{ borderColor: 'var(--red)', color: 'var(--red)', background: 'transparent' }}
          title="TÜM kartların hareket+ekstre+faiz geçmişini sil, sadece kart tanımları kalsın" onClick={() => tamSifirla(null)}>
          ♻️ Tüm Kartları Tam Sıfırla
        </button>
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowModal(false)}>
          <div className="modal">
            <div className="modal-header">
              <h3>{duzenleId ? 'Kart Düzenle' : 'Yeni Kart Ekle'}</h3>
              <button className="modal-close" onClick={() => setShowModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-row cols-2">
                <div className="form-group" style={{ gridColumn: '1/-1' }}>
                  <label>Kart Adı *</label>
                  <input placeholder="GARANTI_BONUS_6020" value={form.kart_adi}
                    onChange={e => setForm({ ...form, kart_adi: e.target.value.toUpperCase() })}/>
                </div>
                <div className="form-group">
                  <label>Banka</label>
                  <input placeholder="Garanti, Yapıkredi..." value={form.banka}
                    onChange={e => setForm({ ...form, banka: e.target.value })}/>
                </div>
                <div className="form-group">
                  <label>Kart Sahibi</label>
                  <input placeholder="İşletme, Annem, Onur..." value={form.sahip}
                    onChange={e => setForm({ ...form, sahip: e.target.value })}/>
                </div>
                <div className="form-group">
                  <label>Ortak Limit Grubu</label>
                  <input placeholder="Aynı krediyi paylaşan kartlara aynı etiket" value={form.ortak_limit_grup}
                    onChange={e => setForm({ ...form, ortak_limit_grup: e.target.value })}/>
                </div>
                <div className="form-group">
                  <label>Limit (₺)</label>
                  <input type="number" value={form.limit_tutar} onChange={e => setForm({ ...form, limit_tutar: e.target.value })}/>
                </div>
                <div className="form-group">
                  <label>Kesim Günü</label>
                  <input type="number" min={1} max={31} value={form.kesim_gunu} onChange={e => setForm({ ...form, kesim_gunu: e.target.value })}/>
                </div>
                <div className="form-group">
                  <label>Son Ödeme Günü</label>
                  <input type="number" min={1} max={31} value={form.son_odeme_gunu} onChange={e => setForm({ ...form, son_odeme_gunu: e.target.value })}/>
                </div>
                <div className="form-group">
                  <label>Akdi Faiz Oranı (yıllık %)</label>
                  <input type="number" step="0.01" placeholder="54" value={form.faiz_orani}
                    onChange={e => setForm({ ...form, faiz_orani: e.target.value })}/>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                    Asgari ÖDENİRSE kalan borca uygulanır (yıllık → /12 aylık)
                  </div>
                </div>
                <div className="form-group">
                  <label>Asgari Ödeme Oranı (%)</label>
                  <input type="number" step="1" min={20} max={100} placeholder="40" value={form.asgari_oran}
                    onChange={e => setForm({ ...form, asgari_oran: e.target.value })}/>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                    TCMB minimum %40 — bankaya göre değişir (20–100)
                  </div>
                </div>
                <div className="form-group" style={{ gridColumn: '1/-1' }}>
                  <label>Gecikme Faiz Oranı (yıllık %) — opsiyonel</label>
                  <input type="number" step="0.01" placeholder="0 → Akdi × 1.3 fallback" value={form.gecikme_faiz_orani}
                    onChange={e => setForm({ ...form, gecikme_faiz_orani: e.target.value })}/>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                    Asgari ÖDENMEZSE kalan borca uygulanır. <b>0 girilirse</b> sistem akdi × 1.3 ile fallback yapar (TCMB ortalama gecikme farkı).
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>İptal</button>
              <button className="btn btn-primary" onClick={kaydet} disabled={!form.kart_adi}>Kaydet</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
