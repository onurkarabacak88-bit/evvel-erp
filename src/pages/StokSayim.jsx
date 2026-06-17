import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';

// Sahip (işletme sahibi) Stok Sayım yönetimi:
//  - Görev Ata: şube + personel + kapsam (tam/set) → zorunlu sayım görevi
//  - Onay Bekleyen: sayılan vs sistem (kâğıt) fark tablosu → hakemlik + onay
//  - Aktif: devam eden görevler → uzaktan kilidi aç (güvenlik valfi)
// Öneri-Only: onay sube_depo_stok'u ezmez, envanter_duzeltme iz kaydı yazar.

const CARD = { background: '#fff', border: '1px solid #e6e6ea', borderRadius: 12, padding: 16, marginBottom: 14 };
const LBL = { fontSize: 12, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 };
const INP = { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #d6d6dc', fontSize: 14, boxSizing: 'border-box' };
const BTN = (bg) => ({ padding: '11px 16px', borderRadius: 9, border: 'none', background: bg, color: '#fff', fontWeight: 800, fontSize: 14, cursor: 'pointer' });

function Mesaj({ m }) {
  if (!m?.t) return null;
  const renk = m.tip === 'ok' ? '#157347' : '#b02a37';
  const bg = m.tip === 'ok' ? '#e8f5ee' : '#fdeaec';
  return <div style={{ background: bg, color: renk, padding: '10px 12px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>{m.t}</div>;
}

export default function StokSayim() {
  const [sekme, setSekme] = useState('ata');
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '8px 4px 40px' }}>
      <h2 style={{ fontSize: 20, fontWeight: 800, margin: '4px 0 14px' }}>📋 Stok Sayım</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {[['ata', '➕ Görev Ata'], ['onay', '✅ Onay Bekleyen'], ['aktif', '⏳ Aktif / Kilit']].map(([id, l]) => (
          <button key={id} onClick={() => setSekme(id)} style={{
            padding: '9px 14px', borderRadius: 9, border: '1px solid ' + (sekme === id ? '#C8956A' : '#d6d6dc'),
            background: sekme === id ? '#C8956A' : '#fff', color: sekme === id ? '#fff' : '#555',
            fontWeight: 700, fontSize: 13, cursor: 'pointer',
          }}>{l}</button>
        ))}
      </div>
      {sekme === 'ata' && <GorevAta />}
      {sekme === 'onay' && <OnayBekleyen />}
      {sekme === 'aktif' && <AktifGorevler />}
    </div>
  );
}

// ── 1) GÖREV ATA ──────────────────────────────────────────────────────────────
function GorevAta() {
  const [subeler, setSubeler] = useState([]);
  const [subeId, setSubeId] = useState('');
  const [personeller, setPersoneller] = useState([]);
  const [personelId, setPersonelId] = useState('');
  const [kapsam, setKapsam] = useState('tam');
  const [kalemler, setKalemler] = useState([]);
  const [secili, setSecili] = useState({}); // kalem_kodu -> bool
  const [not, setNot] = useState('');
  const [msg, setMsg] = useState({});
  const [bekle, setBekle] = useState(false);

  useEffect(() => { api('/subeler').then((r) => setSubeler(r || [])).catch(() => {}); }, []);
  useEffect(() => {
    if (!subeId) { setPersoneller([]); setKalemler([]); return; }
    api(`/gorev/sube-personel/${encodeURIComponent(subeId)}`).then((r) => setPersoneller(r || [])).catch(() => {});
    api(`/stok-sayim/sube-kalemler?sube_id=${encodeURIComponent(subeId)}`).then((r) => setKalemler(r?.kalemler || [])).catch(() => {});
    setPersonelId(''); setSecili({});
  }, [subeId]);

  const ata = async () => {
    setMsg({});
    if (!subeId || !personelId) { setMsg({ tip: 'err', t: 'Şube ve personel seçin' }); return; }
    const body = { sube_id: subeId, personel_id: personelId, kapsam_tip: kapsam, not_aciklama: not };
    if (kapsam === 'set') {
      const sec = kalemler.filter((k) => secili[k.kalem_kodu]).map((k) => ({ kalem_kodu: k.kalem_kodu, kalem_adi: k.kalem_adi }));
      if (!sec.length) { setMsg({ tip: 'err', t: 'En az bir ürün seçin (veya Tam Sayım seçin)' }); return; }
      body.kalemler = sec;
    }
    setBekle(true);
    try {
      const r = await api('/stok-sayim/gorev-ata', { method: 'POST', body });
      const modT = r.mod === 'kalibrasyon' ? 'İLK SAYIM (kalibrasyon)' : 'KONTROL';
      setMsg({ tip: 'ok', t: `✅ Görev atandı — ${r.personel_ad || ''} · ${r.kalem_sayisi} kalem · ${modT}. Personel mesai başlatınca ekranı kilitlenecek.` });
      setSecili({}); setNot('');
    } catch (e) {
      setMsg({ tip: 'err', t: e.message || 'Atama başarısız' });
    } finally { setBekle(false); }
  };

  return (
    <div style={CARD}>
      <Mesaj m={msg} />
      <div style={{ marginBottom: 12 }}>
        <label style={LBL}>Şube</label>
        <select style={INP} value={subeId} onChange={(e) => setSubeId(e.target.value)}>
          <option value="">— Şube seç —</option>
          {subeler.map((s) => <option key={s.id} value={s.id}>{s.ad}</option>)}
        </select>
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={LBL}>Personel (görev sadece bu kişide görünür)</label>
        <select style={INP} value={personelId} onChange={(e) => setPersonelId(e.target.value)} disabled={!subeId}>
          <option value="">— Personel seç —</option>
          {personeller.map((p) => <option key={p.id} value={p.id}>{p.ad_soyad}{p.bu_sube ? '' : ` (${p.sube_adi})`}{p.pin_tanimli ? '' : ' · PIN yok'}</option>)}
        </select>
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={LBL}>Kapsam</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {[['tam', 'Tam Sayım (tüm ürünler)'], ['set', 'Ürün Seti (seç)']].map(([id, l]) => (
            <button key={id} onClick={() => setKapsam(id)} style={{
              flex: 1, padding: '10px', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer',
              border: '1px solid ' + (kapsam === id ? '#C8956A' : '#d6d6dc'),
              background: kapsam === id ? '#fbf2ea' : '#fff', color: kapsam === id ? '#9c6638' : '#555',
            }}>{l}</button>
          ))}
        </div>
      </div>
      {kapsam === 'set' && (
        <div style={{ marginBottom: 12, maxHeight: 240, overflowY: 'auto', border: '1px solid #eee', borderRadius: 8, padding: 8 }}>
          {kalemler.length === 0 && <div style={{ fontSize: 13, color: '#888', padding: 8 }}>Bu şubede tanımlı stok kalemi yok.</div>}
          {kalemler.map((k) => (
            <label key={k.kalem_kodu} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', fontSize: 14, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!secili[k.kalem_kodu]} onChange={(e) => setSecili((m) => ({ ...m, [k.kalem_kodu]: e.target.checked }))} />
              {k.kalem_adi}
            </label>
          ))}
        </div>
      )}
      <div style={{ marginBottom: 14 }}>
        <label style={LBL}>Not (opsiyonel)</label>
        <input style={INP} value={not} onChange={(e) => setNot(e.target.value)} placeholder="örn. Akşam vardiyasında say" />
      </div>
      <button onClick={ata} disabled={bekle} style={{ ...BTN(bekle ? '#bbb' : '#C8956A'), width: '100%' }}>
        {bekle ? 'Atanıyor…' : '➕ Sayım Görevi Ata'}
      </button>
    </div>
  );
}

// ── 6-7) ONAY BEKLEYEN (fark tablosu + hakemlik) ──────────────────────────────
function OnayBekleyen() {
  const [liste, setListe] = useState([]);
  const [acik, setAcik] = useState(null); // detay
  const [kararlar, setKararlar] = useState({}); // kalem_kodu -> 'sayim'|'sistem'
  const [msg, setMsg] = useState({});
  const [bekle, setBekle] = useState(false);

  const yukle = useCallback(() => {
    api('/stok-sayim/bekleyen-onay').then((r) => setListe(r?.gorevler || [])).catch(() => {});
  }, []);
  useEffect(() => { yukle(); }, [yukle]);

  const detayAc = async (id) => {
    setMsg({});
    try {
      const d = await api(`/stok-sayim/gorev/${id}`);
      setAcik(d);
      // Varsayılan karar: fark olanlarda 'sayim' (sayım hakikat), farksızlarda farketmez
      const k = {};
      (d.satirlar || []).forEach((s) => { if (s.fark !== 0) k[s.kalem_kodu] = 'sayim'; });
      setKararlar(k);
    } catch (e) { setMsg({ tip: 'err', t: e.message }); }
  };

  const onayla = async () => {
    if (!acik) return;
    setBekle(true); setMsg({});
    try {
      const kararList = (acik.satirlar || []).filter((s) => s.fark !== 0)
        .map((s) => ({ kalem_kodu: s.kalem_kodu, karar: kararlar[s.kalem_kodu] || 'sayim' }));
      const r = await api(`/stok-sayim/gorev/${acik.id}/onayla`, { method: 'POST', body: { kararlar: kararList } });
      setMsg({ tip: 'ok', t: `✅ Onaylandı — ${r.duzeltme_sayisi} düzeltme kaydı yazıldı, stok güncellendi.` });
      setAcik(null); yukle();
    } catch (e) { setMsg({ tip: 'err', t: e.message }); } finally { setBekle(false); }
  };

  const hepsiFarksiz = () => {
    // Sadece farksız satırları otomatik kabul et; farklılar tek tek karar bekler
    const farkli = (acik.satirlar || []).filter((s) => s.fark !== 0);
    if (farkli.length === 0) { onayla(); return; }
    setMsg({ tip: 'err', t: `${farkli.length} farklı satır var — onları tek tek karar verin, sonra Onayla.` });
  };

  if (acik) {
    const kalib = acik.mod === 'kalibrasyon';
    return (
      <div style={CARD}>
        <Mesaj m={msg} />
        <button onClick={() => setAcik(null)} style={{ background: 'none', border: 'none', color: '#C8956A', fontWeight: 700, cursor: 'pointer', padding: 0, marginBottom: 10 }}>← Geri</button>
        <div style={{ fontSize: 16, fontWeight: 800 }}>{acik.sube_adi} · {acik.personel_ad}</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: kalib ? '#C8956A' : '#157347', margin: '4px 0 12px' }}>
          {kalib ? '🎯 İLK SAYIM — sayım gerçeği KURAR (hakem yok)' : '🔍 KONTROL — fark satırlarında sen karar ver'}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ color: '#888', textAlign: 'left' }}>
              <th style={{ padding: '6px 4px' }}>Ürün</th>
              <th style={{ padding: '6px 4px', textAlign: 'center' }}>Sayım</th>
              <th style={{ padding: '6px 4px', textAlign: 'center' }}>Sistem</th>
              <th style={{ padding: '6px 4px', textAlign: 'center' }}>Fark</th>
              {!kalib && <th style={{ padding: '6px 4px', textAlign: 'center' }}>Doğru olan</th>}
            </tr></thead>
            <tbody>
              {(acik.satirlar || []).map((s) => {
                const farkVar = s.fark !== 0;
                return (
                  <tr key={s.kalem_kodu} style={{ borderTop: '1px solid #eee', background: farkVar ? '#fffaf3' : '#fff' }}>
                    <td style={{ padding: '8px 4px' }}>{s.kalem_adi}</td>
                    <td style={{ padding: '8px 4px', textAlign: 'center', fontWeight: 700 }}>{s.sayilan_adet}</td>
                    <td style={{ padding: '8px 4px', textAlign: 'center', color: '#888' }}>{s.sistem_adet}</td>
                    <td style={{ padding: '8px 4px', textAlign: 'center', fontWeight: 800, color: farkVar ? (s.fark > 0 ? '#157347' : '#b02a37') : '#bbb' }}>
                      {s.fark > 0 ? '+' : ''}{s.fark}
                    </td>
                    {!kalib && (
                      <td style={{ padding: '8px 4px', textAlign: 'center' }}>
                        {farkVar ? (
                          <div style={{ display: 'inline-flex', gap: 4 }}>
                            {[['sayim', 'Sayım'], ['sistem', 'Sistem']].map(([v, l]) => (
                              <button key={v} onClick={() => setKararlar((m) => ({ ...m, [s.kalem_kodu]: v }))} style={{
                                padding: '4px 9px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                                border: '1px solid ' + ((kararlar[s.kalem_kodu] || 'sayim') === v ? '#C8956A' : '#d6d6dc'),
                                background: (kararlar[s.kalem_kodu] || 'sayim') === v ? '#C8956A' : '#fff',
                                color: (kararlar[s.kalem_kodu] || 'sayim') === v ? '#fff' : '#666',
                              }}>{l}</button>
                            ))}
                          </div>
                        ) : <span style={{ color: '#bbb', fontSize: 12 }}>—</span>}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          {!kalib && <button onClick={hepsiFarksiz} disabled={bekle} style={{ ...BTN('#6c757d'), flex: '0 0 auto' }}>Farksızları Onayla</button>}
          <button onClick={onayla} disabled={bekle} style={{ ...BTN(bekle ? '#bbb' : '#157347'), flex: 1 }}>
            {bekle ? 'Onaylanıyor…' : (kalib ? '✓ Gerçeği Kur (Onayla)' : '✓ Onayla')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={CARD}>
      <Mesaj m={msg} />
      {liste.length === 0 && <div style={{ fontSize: 14, color: '#888', padding: 8 }}>Onay bekleyen sayım yok.</div>}
      {liste.map((g) => (
        <div key={g.id} onClick={() => detayAc(g.id)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 10px', borderTop: '1px solid #eee', cursor: 'pointer' }}>
          <div>
            <div style={{ fontWeight: 700 }}>{g.sube_adi} · {g.personel_ad}</div>
            <div style={{ fontSize: 12, color: '#888' }}>{g.mod === 'kalibrasyon' ? '🎯 İlk sayım' : '🔍 Kontrol'} · {g.kalem_sayisi} kalem</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <span style={{ fontWeight: 800, color: g.fark_sayisi ? '#b02a37' : '#157347' }}>{g.fark_sayisi} fark</span>
            <div style={{ fontSize: 18 }}>›</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── 9) AKTİF GÖREVLER + UZAKTAN KİLİT AÇ ──────────────────────────────────────
function AktifGorevler() {
  const [liste, setListe] = useState([]);
  const [msg, setMsg] = useState({});

  const yukle = useCallback(() => {
    api('/stok-sayim/gorevler?limit=100').then((r) => setListe(r?.gorevler || [])).catch(() => {});
  }, []);
  useEffect(() => { yukle(); }, [yukle]);

  const kilitAc = async (g) => {
    if (!window.confirm(`${g.personel_ad || 'Personel'} (${g.sube_adi}) sayım görevini iptal et ve kilidi aç?`)) return;
    setMsg({});
    try {
      await api(`/stok-sayim/gorev/${g.id}/kilit-ac`, { method: 'POST', body: { neden: 'sahip uzaktan açtı' } });
      setMsg({ tip: 'ok', t: '✅ Kilit açıldı, görev iptal edildi.' });
      yukle();
    } catch (e) { setMsg({ tip: 'err', t: e.message }); }
  };

  const DURUM_ET = { atandi: ['Atandı', '#C8956A'], basladi: ['Sayım sürüyor', '#0d6efd'], tamamlandi: ['Onay bekliyor', '#157347'], onaylandi: ['Onaylandı', '#888'], kapandi: ['Kapandı', '#888'], iptal: ['İptal', '#b02a37'] };
  const aktif = liste.filter((g) => ['atandi', 'basladi', 'tamamlandi'].includes(g.durum));
  const gecmis = liste.filter((g) => ['onaylandi', 'kapandi', 'iptal'].includes(g.durum));

  return (
    <div style={CARD}>
      <Mesaj m={msg} />
      <div style={{ fontSize: 13, fontWeight: 800, color: '#555', marginBottom: 8 }}>Aktif görevler</div>
      {aktif.length === 0 && <div style={{ fontSize: 14, color: '#888', padding: 8 }}>Aktif sayım görevi yok.</div>}
      {aktif.map((g) => {
        const [et, renk] = DURUM_ET[g.durum] || [g.durum, '#888'];
        return (
          <div key={g.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 10px', borderTop: '1px solid #eee' }}>
            <div>
              <div style={{ fontWeight: 700 }}>{g.sube_adi} · {g.personel_ad}</div>
              <div style={{ fontSize: 12, color: renk, fontWeight: 700 }}>{et} · {g.kalem_sayisi} kalem · {g.mod === 'kalibrasyon' ? 'ilk sayım' : 'kontrol'}</div>
            </div>
            {['atandi', 'basladi'].includes(g.durum) && (
              <button onClick={() => kilitAc(g)} style={{ ...BTN('#b02a37'), padding: '7px 12px', fontSize: 12 }}>🔓 Kilidi Aç</button>
            )}
          </div>
        );
      })}
      {gecmis.length > 0 && <>
        <div style={{ fontSize: 13, fontWeight: 800, color: '#555', margin: '18px 0 8px' }}>Geçmiş</div>
        {gecmis.slice(0, 30).map((g) => {
          const [et, renk] = DURUM_ET[g.durum] || [g.durum, '#888'];
          return (
            <div key={g.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 10px', borderTop: '1px solid #f1f1f1', fontSize: 13 }}>
              <span>{g.sube_adi} · {g.personel_ad}</span>
              <span style={{ color: renk, fontWeight: 700 }}>{et}</span>
            </div>
          );
        })}
      </>}
    </div>
  );
}
