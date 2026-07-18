import { useState, useEffect, useCallback } from 'react';
import { api, fmt } from '../utils/api';
import { publishGlobalDataRefresh } from '../utils/globalDataRefresh';

// 💸 ÖDEME MERKEZİ v1 (2026-07-15, sahip: "ödeme girişlerini tek alana alıp
// dağıtılsın; tanım alanları ayrı kalsın") — Codex + tasarım ajanı çaprazlı.
// İLKE: hub deftere YAZMAZ — her seçim MEVCUT tek-yazıcı uca delege edilir
// (dedup/guard/kilitler aynen çalışır, çift kayıt imkânsız):
//   plan tam    → POST /odeme-plani/{oid}/ode
//   plan kısmi  → POST /odeme-plani/{oid}/kismi-ode
//   ertele      → POST /odeme-plani/{oid}/ertele
//   değişken f. → POST /fatura-ode | /fatura-vadeye-yaz
//   serbest     → POST /anlik-gider
// Besleme: GET /odeme-plani/bugun?gun=7&personel=0 (salt-okur tek uç).
const KATEGORILER = ['Fatura', 'Kira', 'Malzeme', 'Tamir/Bakım', 'Temizlik', 'Ulaşım', 'Diğer'];

async function faturaEkiYukle(dosya) {
  // 📎 Maliyet/Tedarikçi boru hattının aynısı — hata fırlatır, çağıran not düşer
  const fd = new FormData();
  const isPdf = /pdf/i.test(dosya.type || '') || /\.pdf$/i.test(dosya.name || '');
  fd.append(isPdf ? 'pdf' : 'foto', dosya);
  const headers = {};
  try {
    const mut = (localStorage.getItem('evvelMerkezMutasyonKey') || '').trim();
    if (mut) headers['X-Evvel-Merkez-Key'] = mut;
  } catch { /* ignore */ }
  const res = await fetch(isPdf ? '/api/fatura/yukle-pdf' : '/api/fatura/yukle',
    { method: 'POST', headers, body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.detail) || 'fatura yüklenemedi');
}

const TIP_IKON = {
  'Kredi Kartı': '💳', 'Borç Taksiti': '🏦', 'Sabit Gider': '🏠',
  'Vadeli Alım': '📦', 'Fatura (tutar bekleniyor)': '⚡',
};

export default function OdemeMerkezi() {
  const [liste, setListe] = useState(null);
  const [hata, setHata] = useState('');
  const [msg, setMsg] = useState(null);
  // v3: pencere seçici — 29.07 gibi ileri vadeliler de merkezden ödensin
  const [pencere, setPencere] = useState(7);
  // Sahip isteği (2026-07-15): tür başlıkları — zamana/türe göre grup değiştirici
  const [grupla, setGrupla] = useState('zaman'); // 'zaman' | 'tur'
  const toast = (m, t = 'green') => { setMsg({ m, t }); setTimeout(() => setMsg(null), 5000); };

  const yukle = useCallback(() => {
    api(`/odeme-plani/bugun?gun=${pencere}&personel=0`)
      .then(r => setListe(Array.isArray(r) ? r : []))
      .catch(e => { setHata(e?.message || 'Yüklenemedi'); setListe([]); });
  }, [pencere]);
  useEffect(() => { yukle(); }, [yukle]);

  // ── TEK ÖDEME MODALI ──
  const [sec, setSec] = useState(null);          // seçili satır
  const [mod, setMod] = useState('tam');         // tam | kismi | vadeye (fatura satırı)
  const [tutar, setTutar] = useState('');
  const [kalanVade, setKalanVade] = useState('');
  const [yontem, setYontem] = useState('nakit');
  const [kartId, setKartId] = useState('');
  const [kartlar, setKartlar] = useState([]);
  const [dosya, setDosya] = useState(null);
  const [mesgul, setMesgul] = useState(false);

  const ac = (r) => {
    setSec(r); setMod(r.tutar_girilmedi ? 'tam' : 'tam');
    setTutar(r.tutar_girilmedi ? (r.tahmini_tutar || '') : r.tutar);
    setKalanVade(''); setYontem('nakit'); setKartId(''); setDosya(null); setHata('');
    const t = r.tutar_girilmedi ? (r.tahmini_tutar || 0) : r.tutar;
    api(`/anlik-gider-kart-oneri?tutar=${t || 0}`)
      .then(rr => setKartlar(Array.isArray(rr) ? rr : (rr?.kartlar || [])))
      .catch(() => setKartlar([]));
  };
  const kapat = () => { setSec(null); setHata(''); };

  const dosyaNotu = async () => {
    if (!dosya) return '';
    try { await faturaEkiYukle(dosya); return ' · 📎 fatura arşive alındı'; }
    catch (e) { return ` · ⚠ fatura yüklenemedi: ${e.message}`; }
  };

  const odemeYap = async () => {
    if (!sec) return;
    const tutarN = Number(String(tutar).replace(',', '.'));
    if (yontem === 'kart' && !kartId) { setHata('Kart seçin'); return; }
    setMesgul(true); setHata('');
    try {
      if (sec.tutar_girilmedi) {
        // ⚡ Değişken fatura — tutar zorunlu
        if (!tutarN || tutarN <= 0) { setHata('Fatura tutarını girin'); setMesgul(false); return; }
        if (mod === 'vadeye') {
          await api('/fatura-vadeye-yaz', { method: 'POST', body: { sabit_gider_id: sec.sabit_gider_id, tutar: tutarN } });
          toast(`${sec.baslik.slice(0, 40)} — ${fmt(tutarN)} vadeye yazıldı (kasa etkilenmedi)`);
        } else {
          await api('/fatura-ode', {
            method: 'POST',
            body: { sabit_gider_id: sec.sabit_gider_id, tutar: tutarN, tarih: new Date().toISOString().slice(0, 10), odeme_yontemi: yontem, kart_id: yontem === 'kart' ? kartId : null },
          });
          toast(`Ödendi — ${yontem === 'kart' ? 'karta yazıldı' : 'kasadan düşüldü'}${await dosyaNotu()}`);
        }
      } else if (mod === 'kismi') {
        if (!tutarN || tutarN <= 0 || tutarN >= Number(sec.tutar)) { setHata('Kısmi tutar 0 ile borç arasında olmalı'); setMesgul(false); return; }
        if (!kalanVade) { setHata('Kalan borç için yeni vade tarihi seçin'); setMesgul(false); return; }
        await api(`/odeme-plani/${sec.id}/kismi-ode`, {
          method: 'POST',
          body: { odenen_tutar: tutarN, kalan_vade_tarihi: kalanVade, odeme_yontemi: yontem, kart_id: yontem === 'kart' ? kartId : null },
        });
        toast(`${fmt(tutarN)} ödendi · kalan ${fmt(Number(sec.tutar) - tutarN)} → ${kalanVade}${await dosyaNotu()}`);
      } else {
        await api(`/odeme-plani/${sec.id}/ode`, {
          method: 'POST',
          body: { odeme_yontemi: yontem, kart_id: yontem === 'kart' ? kartId : null },
        });
        toast(`${sec.baslik.slice(0, 40)} ödendi — ${yontem === 'kart' ? 'karta yazıldı' : 'kasadan düşüldü'}${await dosyaNotu()}`);
      }
      kapat(); yukle(); publishGlobalDataRefresh('odeme-merkezi');
    } catch (e) { setHata(e?.message || 'Ödenemedi'); }
    finally { setMesgul(false); }
  };

  const ertele = async () => {
    if (!sec || sec.tutar_girilmedi) return;
    const yeni = window.prompt('Yeni vade tarihi (YYYY-AA-GG):', sec.tarih || '');
    if (!yeni) return;
    setMesgul(true);
    try {
      await api(`/odeme-plani/${sec.id}/ertele?yeni_tarih=${encodeURIComponent(yeni)}`, { method: 'POST' });
      toast(`Ertelendi → ${yeni}`, 'yellow'); kapat(); yukle(); publishGlobalDataRefresh('odeme-merkezi');
    } catch (e) { setHata(e?.message || 'Ertelenemedi'); }
    finally { setMesgul(false); }
  };

  // ── SERBEST ÖDEME (listede olmayan şey) ──
  const [sAcik, setSAcik] = useState(false);
  // 📄 Faturadan Vadeye — okunan faturayı ödeme takvimine bağlama
  const [fvAcik, setFvAcik] = useState(false);
  const [fvTed, setFvTed] = useState('');
  const [fvFaturalar, setFvFaturalar] = useState([]);
  // 🤝 FAZ B — Yeni Taahhüt (elle vade girişinin yeni evi; borç yaratmaz,
  // nakit planıdır; faturası gelince oto-kuyruk motoru üstüne birleşir)
  const [tAcik, setTAcik] = useState(false);
  const [tf, setTf] = useState({ tedarikci: '', tutar: '', vade: '', aciklama: '' });
  const taahhutKaydet = async (ekstra = {}) => {
    const tut = parseFloat(String(tf.tutar).replace(',', '.'));
    if (!tf.tedarikci.trim() || !tut || !tf.vade) { alert('Tedarikçi, tutar ve vade tarihi zorunlu.'); return; }
    try {
      const r = await api('/vadeli-alimlar', { method: 'POST', body: {
        tedarikci: tf.tedarikci.trim(), tutar: tut, vade_tarihi: tf.vade,
        aciklama: `🤝 Taahhüt: ${tf.aciklama.trim() || 'ödeme sözü'}`, ...ekstra,
      } });
      if (r?.warning) {
        if (r.kod === 'TEDARIKCI_ACIK_BAKIYE') {
          if (window.confirm(`${tf.tedarikci} için zaten açık borç var.\nTAMAM = ayrı satır olarak kaydet · İptal = vazgeç`)) {
            return taahhutKaydet({ tedarikci_karari: 'ayri' });
          }
          return;
        }
        if (window.confirm(`${r.mesaj}\nYine de kaydedilsin mi?`)) return taahhutKaydet({ ...ekstra, force: true });
        return;
      }
      alert(`Taahhüt kaydedildi — ${tf.vade} günü bekleyenlerde görünecek.`);
      setTf({ tedarikci: '', tutar: '', vade: '', aciklama: '' });
      setTAcik(false);
      yukle();
    } catch (e) { alert(e?.message || 'kaydedilemedi'); }
  };
  const [sf, setSf] = useState({ kategori: 'Diğer', tutar: '', aciklama: '', sube: 'MERKEZ', odeme_yontemi: 'nakit', kart_id: '', tedarikci: '' });
  const [sDosya, setSDosya] = useState(null);
  const [subeler, setSubeler] = useState([]);
  const [tedarikciler, setTedarikciler] = useState([]);
  useEffect(() => {
    api('/subeler').then(r => setSubeler(Array.isArray(r) ? r : [])).catch(() => {});
    api('/tedarikciler').then(r => setTedarikciler(Array.isArray(r) ? r : (r?.tedarikciler || []))).catch(() => {});
  }, []);
  const serbestKaydet = async () => {
    const t = Number(String(sf.tutar).replace(',', '.'));
    if (!t || t <= 0) { toast('Geçerli tutar girin', 'red'); return; }
    if (sf.odeme_yontemi === 'kart' && !sf.kart_id) { toast('Kart seçin', 'red'); return; }
    setMesgul(true);
    try {
      const body = { ...sf, tutar: t, tarih: new Date().toISOString().slice(0, 10) };
      if (!sDosya) body.aciklama = `${(sf.aciklama || '').trim()} [faturasız alım]`.trim();
      if (sf.odeme_yontemi === 'nakit') delete body.kart_id;
      const res = await api('/anlik-gider', { method: 'POST', body });
      if (res && res.warning) { toast(res.mesaj || 'Mükerrer olabilir', 'red'); setMesgul(false); return; }
      let not = ' · faturasız alım olarak girildi';
      if (sDosya) { try { await faturaEkiYukle(sDosya); not = ' · 📎 fatura arşive alındı'; } catch (e) { not = ` · ⚠ ${e.message}`; } }
      toast((sf.odeme_yontemi === 'kart' ? 'Eklendi — karta yazıldı' : 'Eklendi — kasadan düşüldü')
        + (sf.tedarikci ? ' · 🏪 tedarikçiye ödeme olarak izlendi' : '') + not);
      setSf({ kategori: 'Diğer', tutar: '', aciklama: '', sube: sf.sube, odeme_yontemi: 'nakit', kart_id: '', tedarikci: '' });
      setSDosya(null); setSAcik(false); yukle(); publishGlobalDataRefresh('odeme-merkezi');
    } catch (e) { toast(e?.message || 'Kaydedilemedi', 'red'); }
    finally { setMesgul(false); }
  };
  useEffect(() => {
    if (sAcik && sf.odeme_yontemi === 'kart') {
      api(`/anlik-gider-kart-oneri?tutar=${Number(String(sf.tutar).replace(',', '.')) || 0}`)
        .then(rr => setKartlar(Array.isArray(rr) ? rr : (rr?.kartlar || []))).catch(() => {});
    }
  }, [sAcik, sf.odeme_yontemi, sf.tutar]);

  const gecikmis = (liste || []).filter(r => r.gecikmis);
  const bugunkuler = (liste || []).filter(r => !r.gecikmis && (r.gun_gecikme === 0 || r.tutar_girilmedi));
  const yaklasan = (liste || []).filter(r => !r.gecikmis && r.gun_gecikme < 0 && !r.tutar_girilmedi);
  const topla = (arr) => arr.reduce((s, r) => s + (Number(r.tutar) || 0), 0);
  const gecikmisT = topla(gecikmis), bugunT = topla(bugunkuler), yaklasanT = topla(yaklasan);
  const toplamBekleyen = gecikmisT + bugunT + yaklasanT;

  // Ramp/Melio deseni: göreli tarih ("3 gün gecikti" > "2026-07-12")
  const zamanEtiket = (r) => r.gecikmis ? `${r.gun_gecikme} gün gecikti`
    : (r.gun_gecikme < 0 ? (r.gun_gecikme === -1 ? 'yarın' : `${-r.gun_gecikme} gün sonra`)
      : (r.tutar_girilmedi ? 'tutar bekleniyor' : 'bugün'));

  const Satir = ({ r }) => {
    const renk = r.gecikmis ? 'var(--red)' : (r.gun_gecikme < 0 ? 'var(--text3)' : '#f59e0b');
    return (
      <div onClick={() => ac(r)}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                 padding: '12px 12px', margin: '6px 0', borderRadius: 10, cursor: 'pointer',
                 background: 'var(--bg2)', borderLeft: `4px solid ${renk}`,
                 transition: 'transform .08s, background .12s' }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg3, var(--bg2))'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg2)'; }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span style={{ fontSize: 20 }}>{TIP_IKON[r.tip] || '💸'}</span>
          <span style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 380 }}>{r.baslik}</div>
            <div style={{ fontSize: 11, color: 'var(--text3)' }}>
              <span style={{ color: renk, fontWeight: 700 }}>{zamanEtiket(r)}</span>
              {' · '}{r.tip}{r.tarih ? ` · ${r.tarih}` : ''}
            </div>
          </span>
        </span>
        <span style={{ whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: 15 }}>
              {r.tutar_girilmedi ? (r.tahmini_tutar ? `≈ ${fmt(r.tahmini_tutar)}` : '—') : fmt(r.tutar)}
            </div>
            {r.asgari != null && <div style={{ fontSize: 10, color: 'var(--text3)' }}>asgari {fmt(r.asgari)}</div>}
          </span>
          <button className="btn btn-primary btn-sm" onClick={e => { e.stopPropagation(); ac(r); }}
            style={{ minWidth: 86 }}>{r.tutar_girilmedi ? 'Tutarı Gir' : 'Öde ›'}</button>
        </span>
      </div>
    );
  };

  const Bolum = ({ ad, renk, satirlar, toplam }) => satirlar.length > 0 && (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 4px' }}>
        <span style={{ fontSize: 12, fontWeight: 800, color: renk, letterSpacing: 0.5 }}>{ad} ({satirlar.length})</span>
        <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: renk, fontWeight: 700 }}>{fmt(toplam)}</span>
      </div>
      {satirlar.map(r => <Satir key={r.id} r={r} />)}
    </div>
  );

  // 🗂 Türe göre gruplar — her bölümde gecikmişler üstte
  const TUR_GRUPLARI = [
    ['💳 KREDİ KARTLARI', ['Kredi Kartı']],
    ['🏦 KREDİLER / TAKSİTLER', ['Borç Taksiti']],
    ['📦 VADELİ BORÇLAR (TEDARİKÇİ)', ['Vadeli Alım']],
    ['⚡ DEĞİŞKEN FATURALAR', ['Fatura (tutar bekleniyor)']],
    ['🏠 SABİT GİDERLER', ['Sabit Gider']],
  ];
  const turSirala = (arr) => [...arr].sort((a, b) => (b.gecikmis ? 1 : 0) - (a.gecikmis ? 1 : 0) || (b.gun_gecikme || 0) - (a.gun_gecikme || 0));
  const turGruplari = TUR_GRUPLARI.map(([ad, tipler]) => {
    const satirlar = turSirala((liste || []).filter(r => tipler.includes(r.tip)));
    return { ad, satirlar, toplam: topla(satirlar), gecikmisVar: satirlar.some(r => r.gecikmis) };
  });
  const turDisi = turSirala((liste || []).filter(r => !TUR_GRUPLARI.some(([, t]) => t.includes(r.tip))));

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header">
        <h2>💸 Ödeme Merkezi</h2>
        <p>Tüm para çıkışı tek kapıdan — sistem doğru deftere kendisi dağıtır.</p>
      </div>
      {/* KPI şeridi (Ramp deseni: gecikmiş her zaman en gürültülü) */}
      {liste !== null && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          {[
            ['⚠ GECİKMİŞ', gecikmisT, gecikmis.length, 'var(--red)', true],
            ['🗓 Bugün', bugunT, bugunkuler.length, '#f59e0b', false],
            ['📅 Yaklaşan', yaklasanT, yaklasan.length, 'var(--text2, var(--text))', false],
            ['Σ Toplam', toplamBekleyen, (liste || []).length, 'var(--text)', false],
          ].map(([ad, val, adet, renk, buyuk]) => (
            <div key={ad} className="card" style={{ padding: '10px 16px', minWidth: 150, borderTop: `3px solid ${renk}` }}>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>{ad} {adet > 0 ? `· ${adet}` : ''}</div>
              <div style={{ fontWeight: 800, fontFamily: 'var(--font-mono)', fontSize: buyuk ? 22 : 16, color: renk }}>{fmt(val)}</div>
            </div>
          ))}
        </div>
      )}
      {hata && !sec && <div className="alert-box red mb-16">{hata}</div>}
      {liste === null && <div style={{ color: 'var(--text3)' }}>Yükleniyor…</div>}
      {liste !== null && (
        <>
          <div className="card" style={{ padding: 16, marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', gap: 6 }}>
              <div style={{ fontWeight: 800 }}>📋 Bekleyenler ({liste.length})</div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {[['zaman', '⏱ Zamana göre'], ['tur', '🗂 Türe göre']].map(([m, et]) => (
                  <button key={m} className="btn btn-secondary btn-sm"
                    style={{ fontWeight: grupla === m ? 800 : 400, border: grupla === m ? '2px solid var(--accent)' : undefined }}
                    onClick={() => setGrupla(m)}>{et}</button>
                ))}
                <span style={{ width: 8 }} />
                {[7, 30, 60].map(g => (
                  <button key={g} className="btn btn-secondary btn-sm"
                    style={{ fontWeight: pencere === g ? 800 : 400, border: pencere === g ? '2px solid var(--accent)' : undefined }}
                    onClick={() => setPencere(g)}>{g} gün</button>
                ))}
              </div>
            </div>
            {liste.length === 0 && (
              <div style={{ textAlign: 'center', padding: 30, color: 'var(--text3)' }}>
                <div style={{ fontSize: 40, marginBottom: 6 }}>🎉</div>
                Bekleyen ödeme yok — kasan rahat.
              </div>
            )}
            {grupla === 'zaman' ? (
              <>
                <Bolum ad="GECİKMİŞ" renk="var(--red)" satirlar={gecikmis} toplam={gecikmisT} />
                <Bolum ad="BUGÜN / TUTAR BEKLEYEN" renk="#f59e0b" satirlar={bugunkuler} toplam={bugunT} />
                <Bolum ad={`YAKLAŞAN (${pencere} GÜN)`} renk="var(--text3)" satirlar={yaklasan} toplam={yaklasanT} />
              </>
            ) : (
              <>
                {turGruplari.map(g => (
                  <Bolum key={g.ad} ad={g.ad} renk={g.gecikmisVar ? 'var(--red)' : 'var(--text2, var(--text))'}
                    satirlar={g.satirlar} toplam={g.toplam} />
                ))}
                <Bolum ad="DİĞER" renk="var(--text3)" satirlar={turDisi} toplam={topla(turDisi)} />
              </>
            )}
          </div>

          <div className="card" style={{ padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontWeight: 800 }}>➕ Listede yok — serbest ödeme</div>
              <button className="btn btn-secondary btn-sm" onClick={() => setSAcik(a => !a)}>{sAcik ? 'Kapat' : 'Aç'}</button>
            </div>
            {sAcik && (
              <div style={{ marginTop: 10, display: 'grid', gap: 8, maxWidth: 520 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <select value={sf.kategori} onChange={e => setSf({ ...sf, kategori: e.target.value })}>{KATEGORILER.map(k => <option key={k}>{k}</option>)}</select>
                  <select value={sf.sube} onChange={e => setSf({ ...sf, sube: e.target.value })}>
                    <option>MERKEZ</option>{subeler.map(s => <option key={s.id}>{s.ad}</option>)}
                  </select>
                </div>
                <input type="number" placeholder="Tutar ₺" value={sf.tutar} onChange={e => setSf({ ...sf, tutar: e.target.value })} />
                <input placeholder="Açıklama (ne için ödendi?)" value={sf.aciklama} onChange={e => setSf({ ...sf, aciklama: e.target.value })} />
                {/* V4: tedarikçiye ödemeyse SEÇ — cari/mutabakat KESİN eşleşir (conf 1.0) */}
                <input list="omTedarikciler" placeholder="🏪 Tedarikçi (opsiyonel — tedarikçiye ödemeyse seç)"
                  value={sf.tedarikci} onChange={e => setSf({ ...sf, tedarikci: e.target.value })} />
                <datalist id="omTedarikciler">
                  {tedarikciler.map(t => <option key={t.id || t.ad} value={t.ad} />)}
                </datalist>
                <div style={{ display: 'flex', gap: 8 }}>
                  {[['nakit', '💵 Nakit (kasadan)'], ['kart', '💳 Kart (borca)']].map(([k, et]) => (
                    <button key={k} className={sf.odeme_yontemi === k ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
                      onClick={() => setSf({ ...sf, odeme_yontemi: k })}>{et}</button>
                  ))}
                </div>
                {sf.odeme_yontemi === 'kart' && (
                  <select value={sf.kart_id} onChange={e => setSf({ ...sf, kart_id: e.target.value })}>
                    <option value="">Kart seçin…</option>
                    {kartlar.map(k => <option key={k.kart_id || k.id} value={k.kart_id || k.id}>
                      {(k.banka || '')} {k.kart_adi}{k.oneri ? ' ⭐' : ''}{k.kalan_limit != null ? ` — kalan ${fmt(k.kalan_limit)}` : ''}
                    </option>)}
                  </select>
                )}
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text3)' }}>📎 Fatura (opsiyonel)</div>
                  <input type="file" accept="application/pdf,image/*" onChange={e => setSDosya(e.target.files?.[0] || null)} />
                  <div style={{ fontSize: 11, color: sDosya ? 'var(--green)' : 'var(--yellow)' }}>
                    {sDosya ? `📎 ${sDosya.name} — arşive alınacak` : '⚠ Eklenmezse FATURASIZ ALIM olarak işaretlenir'}
                  </div>
                </div>
                <button className="btn btn-primary" disabled={mesgul} onClick={serbestKaydet}>{mesgul ? 'Kaydediliyor…' : 'Kaydet'}</button>
              </div>
            )}
          </div>

          {/* ── 🤝 FAZ B: YENİ TAAHHÜT — elle vade girişinin yeni evi ── */}
          <div className="card" style={{ padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontWeight: 800 }}>🤝 Yeni Taahhüt — tedarikçiye ödeme sözü ver</div>
              <button className="btn btn-secondary btn-sm" onClick={() => setTAcik(a => !a)}>{tAcik ? 'Kapat' : 'Aç'}</button>
            </div>
            {tAcik && (
              <div style={{ marginTop: 10, display: 'grid', gap: 8, maxWidth: 520 }}>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                  Bu bir ödeme SÖZÜdür — borç yaratmaz (borç faturadan doğar). Faturası
                  sonradan okunursa sistem otomatik bu söze bağlar, çift kayıt olmaz.
                </div>
                <input list="omTedarikciler" placeholder="🏪 Tedarikçi" value={tf.tedarikci}
                  onChange={e => setTf({ ...tf, tedarikci: e.target.value })} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="number" placeholder="Tutar ₺" style={{ flex: 1 }} value={tf.tutar}
                    onChange={e => setTf({ ...tf, tutar: e.target.value })} />
                  <input type="date" style={{ flex: 1 }} value={tf.vade}
                    onChange={e => setTf({ ...tf, vade: e.target.value })} />
                </div>
                <input placeholder="Açıklama (ör: temmuz süt borcu)" value={tf.aciklama}
                  onChange={e => setTf({ ...tf, aciklama: e.target.value })} />
                <button className="btn btn-primary" onClick={() => taahhutKaydet()}>Kaydet</button>
              </div>
            )}
          </div>

          {/* ── 📄 FATURADAN VADEYE (sahip 2026-07-18: 'bütün para çıkışlarını
               tek alandan yöneteyim') — okunan faturayı ödeme takvimine bağla ── */}
          <div className="card" style={{ padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontWeight: 800 }}>📄 Faturadan Vadeye — okunan faturayı ödeme takvimine koy</div>
              <button className="btn btn-secondary btn-sm" onClick={() => setFvAcik(a => !a)}>{fvAcik ? 'Kapat' : 'Aç'}</button>
            </div>
            {fvAcik && (
              <div style={{ marginTop: 10, display: 'grid', gap: 8, maxWidth: 560 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input list="omTedarikciler" placeholder="🏪 Tedarikçi seç…" style={{ flex: 1 }}
                    value={fvTed} onChange={e => setFvTed(e.target.value)} />
                  <button className="btn btn-secondary btn-sm" disabled={fvTed.trim().length < 3}
                    onClick={async () => {
                      try {
                        const r = await api(`/fatura/cari-ekstre?tedarikci=${encodeURIComponent(fvTed.trim())}`);
                        setFvFaturalar((r?.faturalar || []).filter(f => (f.tutar || 0) > 0).slice(-10).reverse());
                      } catch (e) { alert(e?.message || 'faturalar alınamadı'); setFvFaturalar([]); }
                    }}>Faturaları Getir</button>
                </div>
                {fvFaturalar.map(f => (
                  <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12, padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
                    <span>🧾 {f.tarih} · {f.fatura_no || 'no yok'} · <b style={{ fontFamily: 'var(--font-mono)' }}>{fmt(f.tutar)}</b>
                      {f.goruntule && <>{' '}<a href={f.goruntule} target="_blank" rel="noreferrer" style={{ color: 'var(--blue, #60a5fa)' }}>📎</a></>}
                    </span>
                    <button className="btn btn-sm btn-primary" onClick={async () => {
                      const vt = window.prompt(`${fvTed} · ${fmt(f.tutar)}\nVade tarihi (YYYY-AA-GG):`,
                        new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
                      if (!vt) return;
                      try {
                        await api('/vadeli-alimlar', { method: 'POST', body: {
                          tedarikci: fvTed.trim(), tutar: f.tutar, vade_tarihi: vt,
                          aciklama: `Fatura ${f.fatura_no || String(f.id).slice(0, 8)} — vadeye yazıldı (Ödeme Merkezi)`,
                        } });
                        alert(`${fmt(f.tutar)} vadeye yazıldı (${vt}) — bekleyenler listesine düşecek.`);
                        yukle();
                      } catch (e) { alert(e?.message || 'vadeye yazılamadı'); }
                    }}>📅 Vadeye yaz</button>
                  </div>
                ))}
                {fvFaturalar.length === 0 && fvTed && (
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>Tedarikçiyi yazıp "Faturaları Getir"e bas — son 10 okunmuş fatura listelenir.</div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── TEK ÖDEME MODALI — her tür için aynı pencere ── */}
      {sec && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && kapat()}>
          <div className="modal" style={{ maxWidth: 460 }}>
            <div className="modal-header"><h3>{TIP_IKON[sec.tip] || '💸'} {sec.baslik}</h3></div>
            <div style={{ padding: '4px 16px 12px', display: 'grid', gap: 10 }}>
              {hata && <div className="alert-box red">{hata}</div>}
              {sec.tutar_girilmedi ? (
                <>
                  <div style={{ fontSize: 12, color: 'var(--text3)' }}>Bu ayın fatura tutarını gir{sec.tahmini_tutar ? ` (geçen ay ≈ ${fmt(sec.tahmini_tutar)})` : ''}:</div>
                  <input type="number" autoFocus value={tutar} onChange={e => setTutar(e.target.value)} placeholder="Fatura tutarı ₺" />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className={mod !== 'vadeye' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} onClick={() => setMod('tam')}>Ödedim</button>
                    <button className={mod === 'vadeye' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} onClick={() => setMod('vadeye')}>Henüz ödemedim → vadeye yaz</button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button className={mod === 'tam' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} onClick={() => { setMod('tam'); setTutar(sec.tutar); }}>Tam · {fmt(sec.tutar)}</button>
                    <button className={mod === 'kismi' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} onClick={() => setMod('kismi')}>✂ Kısmi{sec.asgari != null ? ` (asg ${fmt(sec.asgari)})` : ''}</button>
                  </div>
                  {mod === 'kismi' && (
                    <>
                      <input type="number" value={tutar} onChange={e => setTutar(e.target.value)} placeholder="Ödenecek tutar ₺" />
                      <div style={{ fontSize: 12, color: 'var(--text3)' }}>Kalan borç için yeni vade:</div>
                      <input type="date" value={kalanVade} onChange={e => setKalanVade(e.target.value)} />
                    </>
                  )}
                </>
              )}
              {mod !== 'vadeye' && (
                <>
                  {/* Kaynak seçimi — büyük iki kart (banka uygulaması deseni) */}
                  <div style={{ display: 'flex', gap: 10 }}>
                    {[['nakit', '💵', 'Kasa', 'kasadan düşer'], ['kart', '💳', 'Kart', 'kart borcuna yazılır']].map(([k, ikon, ad, alt]) => (
                      <button key={k} onClick={() => setYontem(k)}
                        style={{ flex: 1, padding: '12px 8px', borderRadius: 10, cursor: 'pointer',
                                 border: `2px solid ${yontem === k ? 'var(--accent)' : 'var(--border)'}`,
                                 background: yontem === k ? 'var(--accent-dim, var(--bg2))' : 'var(--bg2)', textAlign: 'center' }}>
                        <div style={{ fontSize: 22 }}>{ikon}</div>
                        <div style={{ fontWeight: 800, fontSize: 14 }}>{ad}</div>
                        <div style={{ fontSize: 10, color: 'var(--text3)' }}>{alt}</div>
                      </button>
                    ))}
                  </div>
                  {yontem === 'kart' && (
                    <select value={kartId} onChange={e => setKartId(e.target.value)}>
                      <option value="">Kart seçin…</option>
                      {kartlar.map(k => <option key={k.kart_id || k.id} value={k.kart_id || k.id} disabled={k.uygun === false}>
                        {(k.banka || '')} {k.kart_adi}{k.oneri ? ' ⭐' : ''}{k.kalan_limit != null ? ` — kalan ${fmt(k.kalan_limit)}` : ''}{k.uygun === false ? ` (${k.uygun_degil_neden})` : ''}
                      </option>)}
                    </select>
                  )}
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--text3)' }}>📎 Fatura ekle (opsiyonel — arşive/cariye düşer)</div>
                    <input type="file" accept="application/pdf,image/*" onChange={e => setDosya(e.target.files?.[0] || null)} />
                  </div>
                </>
              )}
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
              <span>
                {!sec.tutar_girilmedi && <button className="btn btn-ghost btn-sm" onClick={ertele} disabled={mesgul}>⏭ Ertele</button>}
              </span>
              <span style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-secondary" onClick={kapat}>Vazgeç</button>
                <button className="btn btn-primary" onClick={odemeYap} disabled={mesgul}>
                  {mesgul ? 'İşleniyor…' : (mod === 'vadeye' ? 'Vadeye Yaz' : 'Onayla ve Öde')}
                </button>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
