// ─────────────────────────────────────────────────────────────────────────────
// 🏠 KİRALIK MÜLKLER — Evvel'in İÇİNDE ama AYRI MANTIKTA çalışan sistem
//
// 🔴 NEDEN (sahip 2026-09-08/09):
//   · "kiralık mülklerimizin takip alanını kurmak istiyorum; sadece o sayfaya
//      girince kendi içinde sekmeleri ve çalışma metodu olan bir alan"
//   · "bu kasa izi, kahveci dükkânın kasa izinden ayrışmalı"
//   · "toplam kasa diye yeni bir isimde şu andaki kasa görünsün"
//   · "ev sembolleri ayrı ayrı olmalı" · "kira elden mi havale mi seçebilmeli"
//   · "kiracı değiştiğinde sistemden değişim yapabilmeliyim"
//   · "buraya gelen elektrik vs abonelikleri takip edebilmeliyim"
//   · "tıklayınca içerikler açılmalı"
//
// ⚠️ KAHVE İŞİYLE TEK KESİŞME NOKTASI:
//        TOPLAM KASA  =  TULİPİ kasası  +  MÜLK kasası
// Mülk hareketleri TULİPİ'nin cirosuna, giderine, P&L'ine GİRMEZ. Sahip
// açıkça böyle istedi: "sadece panel ve BAKIŞ'ta kasaları ayrıştırarak
// göstersin". Bu ekran o ayrımın kendi tarafıdır.
//
// ⚠️ DEPOZİTO GELİR DEĞİLDİR — iade edilecek emanettir; mülk kasasının
// içindedir ama "kira geliri" toplamına girmez.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { Tablo, HataBandi, BosDurum } from './parcalar';

// 🏠 Mülk sembolleri — sahip: "ev sembolleri ayrı ayrı olmalı".
// Amaç süs değil AYIRT ETME: listede mülkü adres okumadan gözle bulmak.
const SIMGELER = ['🏠', '🏡', '🏢', '🏬', '🏘️', '🏚️', '🏪', '🏭', '🛖', '🏛️', '🚪', '🅿️'];
const MULK_TURU = ['daire', 'dükkan', 'depo', 'ofis', 'arsa', 'diğer'];
const ABONELIK_TURU = [
  { id: 'elektrik', ad: 'Elektrik', simge: '⚡' },
  { id: 'su', ad: 'Su', simge: '💧' },
  { id: 'dogalgaz', ad: 'Doğalgaz', simge: '🔥' },
  { id: 'internet', ad: 'İnternet', simge: '🌐' },
  { id: 'aidat', ad: 'Aidat', simge: '🏢' },
  { id: 'diger', ad: 'Diğer', simge: '📄' },
];

const alanStil = {
  width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
  border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
  fontSize: 13, fontFamily: 'inherit', outline: 'none',
};
const etiketStil = {
  fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase',
  color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block',
};
const dugme = {
  padding: '9px 16px', borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit',
  fontSize: 12, fontWeight: 600, border: `1px solid ${R.cizgi3}`,
  background: 'transparent', color: R.metin2,
};
const dugmeAna = {
  padding: '9px 20px', borderRadius: 9, border: 'none', cursor: 'pointer',
  background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
  fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
};

const sayi = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const fmt = (v) => sayi(v).toLocaleString('tr-TR', {
  minimumFractionDigits: 0, maximumFractionDigits: 0,
}) + ' ₺';
const bugun = () => new Date().toISOString().slice(0, 10);

// ═══════════════════════════════════════════════════════════════════
// KASA ŞERİDİ — üç rakam, her ekranın üstünde
// ═══════════════════════════════════════════════════════════════════
function KasaSeridi({ kasa }) {
  if (!kasa) return null;
  const kutu = (etiket, deger, renk, alt) => (
    <div style={{
      flex: 1, minWidth: 168, padding: '14px 16px', borderRadius: 14,
      background: kartYuzey, border: `1px solid ${R.cizgi2}`,
    }}>
      <div style={{ ...etiketStil, marginBottom: 4 }}>{etiket}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: renk, fontFamily: F.baslik }}>
        {fmt(deger)}
      </div>
      {alt ? <div style={{ fontSize: 11, color: R.not2, marginTop: 3 }}>{alt}</div> : null}
    </div>
  );
  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        {kutu('Toplam kasa', kasa.toplam, R.krem, 'bugüne kadar gördüğünüz rakam')}
        {kutu('TULİPİ kasası', kasa.tulipi, '#D29A5B', 'kahve işi')}
        {kutu('Mülk kasası', kasa.mulk, '#7FB77E', 'kira · aidat · depozito')}
        {sayi(kasa.depozito_emanet) !== 0
          ? kutu('Elde tutulan depozito', kasa.depozito_emanet, '#FBBF24',
                 'emanet — gelir DEĞİL')
          : null}
      </div>
      <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.55 }}>
        Toplam kasa = TULİPİ + Mülk. Para yerinden oynamadı; yalnız hangi
        çekmeceye ait olduğu yazıldı.
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
export default function MulkModulu({ gorunum, onCekmece, onToast }) {
  const [kasa, setKasa] = useState(null);
  const [mulkler, setMulkler] = useState(null);
  const [kiracilar, setKiracilar] = useState(null);
  const [sozlesmeler, setSozlesmeler] = useState(null);
  const [tahsilat, setTahsilat] = useState(null);
  const [abonelikler, setAbonelikler] = useState(null);
  const [defter, setDefter] = useState(null);
  const [goc, setGoc] = useState(null);
  const [hata, setHata] = useState(null);
  const [mesgul, setMesgul] = useState(false);

  const [form, setForm] = useState(null);   // { tip, veri }

  const yukle = useCallback(async () => {
    setHata(null);
    try {
      const [k, m, kr, sz] = await Promise.all([
        api('/api/mulk/kasa'),
        api('/api/mulk'),
        api('/api/mulk/kiraci'),
        api('/api/mulk/sozlesme'),
      ]);
      setKasa(k); setMulkler(m); setKiracilar(kr); setSozlesmeler(sz);
    } catch (e) {
      setHata(String(e?.message || e));
    }
  }, []);

  useEffect(() => { yukle(); }, [yukle]);

  useEffect(() => {
    let iptal = false;
    (async () => {
      try {
        if (gorunum === 'tahsilat') {
          const d = await api('/api/mulk/tahsilat'); if (!iptal) setTahsilat(d);
        } else if (gorunum === 'abonelik') {
          const d = await api('/api/mulk/abonelik'); if (!iptal) setAbonelikler(d);
        } else if (gorunum === 'defter') {
          const d = await api('/api/mulk/defter'); if (!iptal) setDefter(d);
        } else if (gorunum === 'goc') {
          const d = await api('/api/mulk/goc-adaylari'); if (!iptal) setGoc(d);
        }
      } catch (e) { if (!iptal) setHata(String(e?.message || e)); }
    })();
    return () => { iptal = true; };
  }, [gorunum]);

  const cagir = async (yol, yontem, govde) => {
    setMesgul(true);
    try {
      const r = await api(yol, { method: yontem, body: JSON.stringify(govde) });
      onToast?.(r?.islem ? `✅ ${r.islem}` : '✅ kaydedildi');
      setForm(null);
      await yukle();
      if (gorunum === 'tahsilat') setTahsilat(await api('/api/mulk/tahsilat'));
      if (gorunum === 'abonelik') setAbonelikler(await api('/api/mulk/abonelik'));
      if (gorunum === 'defter') setDefter(await api('/api/mulk/defter'));
      return r;
    } catch (e) {
      onToast?.(`⚠ ${String(e?.message || e)}`);
      throw e;
    } finally { setMesgul(false); }
  };

  const kiraciAdi = useCallback((id) =>
    (kiracilar?.kiracilar || []).find((k) => k.id === id)?.ad || '—', [kiracilar]);

  // ── ÇEKMECE: mülk dosyası ────────────────────────────────────────
  // 🚪 Kapı ancak ARKASINDA İÇERİK VARSA açılır. Boş çekmece çıkmaz sokaktan
  // beterdir: kullanıcı tıklar, bir şey görmez, bir daha tıklamaz.
  const mulkDosyasiAc = async (m) => {
    let d = null;
    try { d = await api(`/api/mulk/${m.id}/dosya`); }
    catch (e) { onToast?.(`⚠ dosya açılamadı: ${String(e?.message || e)}`); return; }
    const s = d.sozlesmeler || [];
    const aktif = s.find((x) => x.durum === 'aktif');
    onCekmece?.({
      tip: 'MÜLK DOSYASI',
      baslik: `${m.simge || '🏠'}  ${m.ad}`,
      alt: [m.tur, m.adres].filter(Boolean).join(' · ') || 'adres girilmemiş',
      kpi: [
        { etiket: 'Durum', deger: aktif ? 'DOLU' : 'BOŞ',
          renk: aktif ? '#7FB77E' : '#FBBF24' },
        { etiket: 'Aylık kira', deger: aktif ? fmt(aktif.aylik_kira) : '—' },
        { etiket: 'Kiracı', deger: aktif ? aktif.kiraci_ad : '—' },
        { etiket: 'Toplam tahsil', deger: fmt(d.toplam_kira) },
      ],
      listeBaslik: 'Dosya içeriği',
      satirlar: [
        ...(s.length ? [{
          ad: '— KİRACI GEÇMİŞİ —',
          detay: `${s.length} sözleşme`, tutar: '',
        }] : []),
        ...s.map((x) => ({
          ad: `${x.kiraci_ad}${x.durum === 'aktif' ? '  ●' : ''}`,
          detay: `${x.baslangic} → ${x.bitis || 'sürüyor'} · ${x.durum}`
                 + (sayi(x.depozito) ? ` · depozito ${fmt(x.depozito)}` : '')
                 + (x.kiraci_tipi === 'isyeri' ? ` · işyeri (stopaj %${x.stopaj_orani})` : ''),
          tutar: fmt(x.aylik_kira),
        })),
        ...(d.abonelikler?.length ? [{
          ad: '— ABONELİKLER —', detay: `${d.abonelikler.length} kayıt`, tutar: '',
        }] : []),
        ...(d.abonelikler || []).map((a) => {
          const t = ABONELIK_TURU.find((x) => x.id === a.tur);
          const riskli = a.abone_kime === 'sahip' && a.odeyen === 'kiraci';
          return {
            ad: `${t?.simge || '📄'} ${t?.ad || a.tur}${riskli ? '  ⚠' : ''}`,
            detay: [`abone: ${a.abone_kime}`, `ödeyen: ${a.odeyen}`,
                    a.saglayici, a.abone_no].filter(Boolean).join(' · ')
                   + (riskli ? ' — kiracı ödemezse borç SİZE kalır' : ''),
            tutar: a.aylik_tahmin ? fmt(a.aylik_tahmin) : '',
          };
        }),
        ...(d.hareketler?.length ? [{
          ad: '— PARA HAREKETLERİ —', detay: `${d.hareketler.length} satır`, tutar: '',
        }] : []),
        ...(d.hareketler || []).slice(0, 40).map((h) => ({
          ad: h.tur.replace(/_/g, ' '),
          detay: [h.tarih, h.kiraci_ad, h.aciklama,
                  h.kasa_iz ? 'kasa izi ✓' : '⚠ kasa izi YOK'].filter(Boolean).join(' · '),
          tutar: fmt(h.tutar),
        })),
      ],
    });
  };

  if (hata) return <HataBandi mesaj={hata} kaynak="mülk" onTekrar={yukle} />;

  // ══════════════════════════════════════════════════════════════════
  // FORMLAR
  // ══════════════════════════════════════════════════════════════════
  const Form = () => {
    if (!form) return null;
    const { tip } = form;
    const [v, setV] = [form.veri, (y) => setForm({ ...form, veri: { ...form.veri, ...y } })];
    const kapat = () => setForm(null);

    const sarmal = (baslik, alt, icerik, kaydet) => (
      <div style={{
        marginBottom: 18, padding: 18, borderRadius: 14,
        background: kartYuzey, border: `1px solid ${R.cizgi3}`,
      }}>
        <div style={{ fontFamily: F.baslik, fontSize: 16, color: R.krem, marginBottom: 3 }}>
          {baslik}
        </div>
        {alt ? <div style={{ fontSize: 11.5, color: R.not2, marginBottom: 14 }}>{alt}</div> : null}
        {icerik}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button style={dugmeAna} disabled={mesgul} onClick={kaydet}>
            {mesgul ? 'Kaydediliyor…' : 'Kaydet'}
          </button>
          <button style={dugme} onClick={kapat}>Vazgeç</button>
        </div>
      </div>
    );

    const izgara = (cocuklar) => (
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 12,
      }}>{cocuklar}</div>
    );

    if (tip === 'mulk') {
      return sarmal(
        v.id ? 'Mülkü düzenle' : 'Yeni mülk',
        'Sembol seçin — listede adres okumadan gözle bulmak için.',
        <>
          <div style={{ marginBottom: 14 }}>
            <span style={etiketStil}>Sembol</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {SIMGELER.map((s) => (
                <button key={s} onClick={() => setV({ simge: s })} style={{
                  fontSize: 22, padding: '6px 9px', borderRadius: 10, cursor: 'pointer',
                  background: v.simge === s ? 'rgba(224,165,89,.18)' : 'transparent',
                  border: `1px solid ${v.simge === s ? '#D29A5B' : R.cizgi3}`,
                }}>{s}</button>
              ))}
            </div>
          </div>
          {izgara(<>
            <div><span style={etiketStil}>Ad *</span>
              <input style={alanStil} value={v.ad || ''}
                     placeholder="Huzur Sitesi B/4"
                     onChange={(e) => setV({ ad: e.target.value })} /></div>
            <div><span style={etiketStil}>Tür</span>
              <select style={alanStil} value={v.tur || ''}
                      onChange={(e) => setV({ tur: e.target.value })}>
                <option value="">—</option>
                {MULK_TURU.map((t) => <option key={t} value={t}>{t}</option>)}
              </select></div>
            <div><span style={etiketStil}>Hedef aylık kira</span>
              <input style={alanStil} type="number" value={v.aylik_kira ?? ''}
                     onChange={(e) => setV({ aylik_kira: e.target.value })} /></div>
            <div style={{ gridColumn: '1/-1' }}><span style={etiketStil}>Adres</span>
              <input style={alanStil} value={v.adres || ''}
                     onChange={(e) => setV({ adres: e.target.value })} /></div>
            <div style={{ gridColumn: '1/-1' }}><span style={etiketStil}>Not</span>
              <input style={alanStil} value={v.notlar || ''}
                     onChange={(e) => setV({ notlar: e.target.value })} /></div>
          </>)}
        </>,
        () => {
          if (!String(v.ad || '').trim()) { onToast?.('⚠ Ad zorunlu'); return; }
          const g = { ad: v.ad, adres: v.adres || null, tur: v.tur || null,
                      simge: v.simge || null,
                      aylik_kira: v.aylik_kira ? Number(v.aylik_kira) : null,
                      notlar: v.notlar || null };
          cagir(v.id ? `/api/mulk/${v.id}` : '/api/mulk', v.id ? 'PUT' : 'POST', g);
        });
    }

    if (tip === 'kiraci') {
      return sarmal(v.id ? 'Kiracıyı düzenle' : 'Yeni kiracı', null,
        izgara(<>
          <div><span style={etiketStil}>Ad Soyad *</span>
            <input style={alanStil} value={v.ad || ''}
                   onChange={(e) => setV({ ad: e.target.value })} /></div>
          <div><span style={etiketStil}>Telefon</span>
            <input style={alanStil} value={v.telefon || ''}
                   onChange={(e) => setV({ telefon: e.target.value })} /></div>
          <div style={{ gridColumn: '1/-1' }}><span style={etiketStil}>Not</span>
            <input style={alanStil} value={v.notlar || ''}
                   onChange={(e) => setV({ notlar: e.target.value })} /></div>
        </>),
        () => {
          if (!String(v.ad || '').trim()) { onToast?.('⚠ Ad zorunlu'); return; }
          cagir(v.id ? `/api/mulk/kiraci/${v.id}` : '/api/mulk/kiraci',
                v.id ? 'PUT' : 'POST',
                { ad: v.ad, telefon: v.telefon || null, notlar: v.notlar || null });
        });
    }

    if (tip === 'sozlesme') {
      return sarmal('Yeni sözleşme',
        'Kira artışında bu sözleşmeyi bitirip YENİSİNİ açın — geçmiş tahsilatlar eski tutara bağlı kalsın.',
        izgara(<>
          <div><span style={etiketStil}>Mülk *</span>
            <select style={alanStil} value={v.mulk_id || ''}
                    onChange={(e) => setV({ mulk_id: e.target.value })}>
              <option value="">seçin…</option>
              {(mulkler?.mulkler || []).map((m) =>
                <option key={m.id} value={m.id}>{(m.simge || '🏠') + ' ' + m.ad}</option>)}
            </select></div>
          <div><span style={etiketStil}>Kiracı *</span>
            <select style={alanStil} value={v.kiraci_id || ''}
                    onChange={(e) => setV({ kiraci_id: e.target.value })}>
              <option value="">seçin…</option>
              {(kiracilar?.kiracilar || []).map((k) =>
                <option key={k.id} value={k.id}>{k.ad}</option>)}
            </select></div>
          <div><span style={etiketStil}>Başlangıç *</span>
            <input style={alanStil} type="date" value={v.baslangic || bugun()}
                   onChange={(e) => setV({ baslangic: e.target.value })} /></div>
          <div><span style={etiketStil}>Aylık kira *</span>
            <input style={alanStil} type="number" value={v.aylik_kira ?? ''}
                   onChange={(e) => setV({ aylik_kira: e.target.value })} /></div>
          <div><span style={etiketStil}>Depozito</span>
            <input style={alanStil} type="number" value={v.depozito ?? ''}
                   onChange={(e) => setV({ depozito: e.target.value })} /></div>
          <div><span style={etiketStil}>Ödeme günü</span>
            <input style={alanStil} type="number" min="1" max="31" value={v.odeme_gunu ?? 1}
                   onChange={(e) => setV({ odeme_gunu: e.target.value })} /></div>
          <div><span style={etiketStil}>Kiracı tipi</span>
            <select style={alanStil} value={v.kiraci_tipi || 'sahis'}
                    onChange={(e) => setV({
                      kiraci_tipi: e.target.value,
                      stopaj_orani: e.target.value === 'isyeri' ? 20 : 0,
                    })}>
              <option value="sahis">Şahıs (konut)</option>
              <option value="isyeri">İşyeri (stopajlı)</option>
            </select></div>
          {v.kiraci_tipi === 'isyeri' ? (
            <div><span style={etiketStil}>Stopaj %</span>
              <input style={alanStil} type="number" value={v.stopaj_orani ?? 20}
                     onChange={(e) => setV({ stopaj_orani: e.target.value })} />
              <div style={{ fontSize: 10.5, color: R.not2, marginTop: 4 }}>
                İşyeri kiracı stopajı kaynağında keser; size NET ulaşır.
                Bu oran girilmezse her ay "eksik ödedi" uyarısı çıkar.
              </div></div>
          ) : null}
        </>),
        () => {
          if (!v.mulk_id || !v.kiraci_id || !v.aylik_kira) {
            onToast?.('⚠ Mülk, kiracı ve aylık kira zorunlu'); return;
          }
          cagir('/api/mulk/sozlesme', 'POST', {
            mulk_id: v.mulk_id, kiraci_id: v.kiraci_id,
            baslangic: v.baslangic || bugun(),
            aylik_kira: Number(v.aylik_kira),
            depozito: Number(v.depozito || 0),
            odeme_gunu: Number(v.odeme_gunu || 1),
            kiraci_tipi: v.kiraci_tipi || 'sahis',
            stopaj_orani: Number(v.stopaj_orani || 0),
          });
        });
    }

    if (tip === 'tahsilat') {
      return sarmal(`Kira tahsilatı — ${v.kiraci_ad || ''}`,
        `${v.mulk_ad || ''} · aylık ${fmt(v.aylik_kira)}`,
        <>
          {izgara(<>
            <div><span style={etiketStil}>Tarih</span>
              <input style={alanStil} type="date" value={v.tarih || bugun()}
                     onChange={(e) => setV({ tarih: e.target.value })} /></div>
            <div><span style={etiketStil}>Tutar *</span>
              <input style={alanStil} type="number" value={v.tutar ?? ''}
                     onChange={(e) => setV({ tutar: e.target.value })} /></div>
            <div><span style={etiketStil}>Hangi ayın kirası</span>
              <input style={alanStil} type="month" value={v.donem || ''}
                     onChange={(e) => setV({ donem: e.target.value })} />
              <div style={{ fontSize: 10.5, color: R.not2, marginTop: 4 }}>
                İsteğe bağlı. Boş bırakırsanız en eski açık aydan kapatılır.
              </div></div>
          </>)}
          <div style={{ marginTop: 14 }}>
            <span style={etiketStil}>Para nasıl geldi?</span>
            <div style={{ display: 'flex', gap: 8 }}>
              {[{ id: 'havale', ad: '🏦 Havale / EFT' },
                { id: 'elden', ad: '💵 Elden nakit' }].map((y) => (
                <button key={y.id} onClick={() => setV({ odeme_yontemi: y.id })} style={{
                  ...dugme, flex: 1,
                  background: v.odeme_yontemi === y.id ? 'rgba(224,165,89,.18)' : 'transparent',
                  borderColor: v.odeme_yontemi === y.id ? '#D29A5B' : R.cizgi3,
                  color: v.odeme_yontemi === y.id ? R.krem : R.metin2,
                }}>{y.ad}</button>
              ))}
            </div>
            <div style={{ fontSize: 10.5, color: R.not2, marginTop: 6 }}>
              Elden alınan nakit çekmecedeki parayı artırır, havale bankaya
              düşer. Ayrım olmadan banka mutabakatı doğru çalışmaz.
            </div>
          </div>
          <label style={{
            display: 'flex', gap: 9, alignItems: 'flex-start', marginTop: 14,
            cursor: 'pointer',
          }}>
            <input type="checkbox" checked={!!v.tulipiye_aktar} style={{ marginTop: 3 }}
                   onChange={(e) => setV({ tulipiye_aktar: e.target.checked })} />
            <span style={{ fontSize: 12, color: R.metin2, lineHeight: 1.5 }}>
              <b style={{ color: R.krem }}>Bu para dükkâna girdi</b> — TULİPİ
              kasasında kullanılacak.<br />
              İşaretlerseniz mülk defterinden çıkıp TULİPİ'ye aktarılır;
              <b> toplam kasa değişmez.</b> İşaretlemezseniz para mülk
              çekmecesinde birikir.
            </span>
          </label>
        </>,
        () => {
          if (!v.tutar) { onToast?.('⚠ Tutar zorunlu'); return; }
          cagir('/api/mulk/tahsilat', 'POST', {
            sozlesme_id: v.sozlesme_id, tarih: v.tarih || bugun(),
            tutar: Number(v.tutar), donem: v.donem || null,
            odeme_yontemi: v.odeme_yontemi || null,
            tulipiye_aktar: !!v.tulipiye_aktar,
          });
        });
    }

    if (tip === 'devir') {
      return sarmal(`Kiracı değişimi — ${v.mulk_ad || ''}`,
        `Çıkan: ${v.eski_kiraci_ad}. Eski sözleşme kapanır, yenisi açılır — geçmiş tahsilatlar eski kiracıda KALIR.`,
        izgara(<>
          <div><span style={etiketStil}>Yeni kiracı *</span>
            <select style={alanStil} value={v.yeni_kiraci_id || ''}
                    onChange={(e) => setV({ yeni_kiraci_id: e.target.value })}>
              <option value="">seçin…</option>
              {(kiracilar?.kiracilar || []).filter((k) => k.id !== v.eski_kiraci_id)
                .map((k) => <option key={k.id} value={k.id}>{k.ad}</option>)}
            </select></div>
          <div><span style={etiketStil}>Devir tarihi *</span>
            <input style={alanStil} type="date" value={v.tarih || bugun()}
                   onChange={(e) => setV({ tarih: e.target.value })} /></div>
          <div><span style={etiketStil}>Yeni aylık kira</span>
            <input style={alanStil} type="number" value={v.aylik_kira ?? ''}
                   placeholder={String(v.eski_kira || '')}
                   onChange={(e) => setV({ aylik_kira: e.target.value })} />
            <div style={{ fontSize: 10.5, color: R.not2, marginTop: 4 }}>
              Boş bırakırsanız eskisi devam eder.
            </div></div>
          <div><span style={etiketStil}>Yeni depozito</span>
            <input style={alanStil} type="number" value={v.depozito ?? ''}
                   onChange={(e) => setV({ depozito: e.target.value })} /></div>
          <div style={{ gridColumn: '1/-1' }}>
            <label style={{ display: 'flex', gap: 9, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={v.depozito_iade !== false}
                     onChange={(e) => setV({ depozito_iade: e.target.checked })} />
              <span style={{ fontSize: 12, color: R.metin2 }}>
                Çıkan kiracının depozitosu iade edildi
                {sayi(v.eski_depozito) ? ` (${fmt(v.eski_depozito)})` : ''}
                {' '}— mülk defterinden düşülür.
              </span>
            </label>
          </div>
        </>),
        async () => {
          if (!v.yeni_kiraci_id) { onToast?.('⚠ Yeni kiracı seçin'); return; }
          const r = await cagir(`/api/mulk/sozlesme/${v.sozlesme_id}/devir`, 'POST', {
            yeni_kiraci_id: v.yeni_kiraci_id, tarih: v.tarih || bugun(),
            aylik_kira: v.aylik_kira ? Number(v.aylik_kira) : null,
            depozito: Number(v.depozito || 0),
            depozito_iade: v.depozito_iade !== false,
          });
          if (r?.abonelik_uyarisi?.length) {
            onToast?.(`⚠ ${r.abonelik_uyarisi.length} abonelik devredilmedi — Abonelikler sekmesinden güncelleyin`);
          }
        });
    }

    if (tip === 'abonelik') {
      return sarmal(v.id ? 'Aboneliği düzenle' : 'Yeni abonelik',
        'İki ayrı soru: ABONE kimin üstüne kayıtlı, FATURAYI kim ödüyor. Karıştırılırsa tahliyeden sonra borç size kalır.',
        izgara(<>
          <div><span style={etiketStil}>Mülk *</span>
            <select style={alanStil} value={v.mulk_id || ''}
                    onChange={(e) => setV({ mulk_id: e.target.value })}>
              <option value="">seçin…</option>
              {(mulkler?.mulkler || []).map((m) =>
                <option key={m.id} value={m.id}>{(m.simge || '🏠') + ' ' + m.ad}</option>)}
            </select></div>
          <div><span style={etiketStil}>Tür *</span>
            <select style={alanStil} value={v.tur || ''}
                    onChange={(e) => setV({ tur: e.target.value })}>
              <option value="">seçin…</option>
              {ABONELIK_TURU.map((t) =>
                <option key={t.id} value={t.id}>{t.simge + ' ' + t.ad}</option>)}
            </select></div>
          <div><span style={etiketStil}>Sağlayıcı</span>
            <input style={alanStil} value={v.saglayici || ''} placeholder="Aydem · İZSU…"
                   onChange={(e) => setV({ saglayici: e.target.value })} /></div>
          <div><span style={etiketStil}>Abone / tesisat no</span>
            <input style={alanStil} value={v.abone_no || ''}
                   onChange={(e) => setV({ abone_no: e.target.value })} /></div>
          <div><span style={etiketStil}>Abone kimin üstüne</span>
            <select style={alanStil} value={v.abone_kime || 'sahip'}
                    onChange={(e) => setV({ abone_kime: e.target.value })}>
              <option value="sahip">Benim üstüme</option>
              <option value="kiraci">Kiracının üstüne</option>
            </select></div>
          <div><span style={etiketStil}>Faturayı kim öder</span>
            <select style={alanStil} value={v.odeyen || 'kiraci'}
                    onChange={(e) => setV({ odeyen: e.target.value })}>
              <option value="kiraci">Kiracı</option>
              <option value="sahip">Ben</option>
            </select></div>
          <div><span style={etiketStil}>Aylık tahmini</span>
            <input style={alanStil} type="number" value={v.aylik_tahmin ?? ''}
                   onChange={(e) => setV({ aylik_tahmin: e.target.value })} /></div>
        </>),
        () => {
          if (!v.mulk_id || !v.tur) { onToast?.('⚠ Mülk ve tür zorunlu'); return; }
          cagir(v.id ? `/api/mulk/abonelik/${v.id}` : '/api/mulk/abonelik',
                v.id ? 'PUT' : 'POST', {
                  mulk_id: v.mulk_id, tur: v.tur, saglayici: v.saglayici || null,
                  abone_no: v.abone_no || null,
                  abone_kime: v.abone_kime || 'sahip', odeyen: v.odeyen || 'kiraci',
                  aylik_tahmin: v.aylik_tahmin ? Number(v.aylik_tahmin) : null,
                });
        });
    }

    if (tip === 'gider') {
      return sarmal('Mülk gideri', 'Aidat · site faturası · emlak vergisi · tadilat. Kahve işinin giderine KARIŞMAZ.',
        izgara(<>
          <div><span style={etiketStil}>Tarih</span>
            <input style={alanStil} type="date" value={v.tarih || bugun()}
                   onChange={(e) => setV({ tarih: e.target.value })} /></div>
          <div><span style={etiketStil}>Tutar *</span>
            <input style={alanStil} type="number" value={v.tutar ?? ''}
                   onChange={(e) => setV({ tutar: e.target.value })} /></div>
          <div><span style={etiketStil}>Mülk</span>
            <select style={alanStil} value={v.mulk_id || ''}
                    onChange={(e) => setV({ mulk_id: e.target.value })}>
              <option value="">(genel)</option>
              {(mulkler?.mulkler || []).map((m) =>
                <option key={m.id} value={m.id}>{(m.simge || '🏠') + ' ' + m.ad}</option>)}
            </select></div>
          <div><span style={etiketStil}>Nasıl ödendi</span>
            <select style={alanStil} value={v.odeme_yontemi || ''}
                    onChange={(e) => setV({ odeme_yontemi: e.target.value })}>
              <option value="">—</option>
              <option value="havale">🏦 Havale</option>
              <option value="elden">💵 Elden</option>
            </select></div>
          <div style={{ gridColumn: '1/-1' }}><span style={etiketStil}>Açıklama *</span>
            <input style={alanStil} value={v.aciklama || ''}
                   placeholder="Huzur Sitesi aidat — Eylül"
                   onChange={(e) => setV({ aciklama: e.target.value })} /></div>
        </>),
        () => {
          if (!v.tutar || !String(v.aciklama || '').trim()) {
            onToast?.('⚠ Tutar ve açıklama zorunlu'); return;
          }
          cagir('/api/mulk/gider', 'POST', {
            tarih: v.tarih || bugun(), tutar: Number(v.tutar),
            aciklama: v.aciklama, mulk_id: v.mulk_id || null,
            odeme_yontemi: v.odeme_yontemi || null,
          });
        });
    }

    if (tip === 'aktarim') {
      return sarmal('Mülkten TULİPİ\'ye aktarım',
        'Mülk defterinden para çıkar, TULİPİ kasasına girer. TOPLAM KASA DEĞİŞMEZ.',
        izgara(<>
          <div><span style={etiketStil}>Tarih</span>
            <input style={alanStil} type="date" value={v.tarih || bugun()}
                   onChange={(e) => setV({ tarih: e.target.value })} /></div>
          <div><span style={etiketStil}>Tutar *</span>
            <input style={alanStil} type="number" value={v.tutar ?? ''}
                   onChange={(e) => setV({ tutar: e.target.value })} /></div>
          <div style={{ gridColumn: '1/-1' }}><span style={etiketStil}>Açıklama</span>
            <input style={alanStil} value={v.aciklama || ''}
                   onChange={(e) => setV({ aciklama: e.target.value })} /></div>
        </>),
        () => {
          if (!v.tutar) { onToast?.('⚠ Tutar zorunlu'); return; }
          cagir('/api/mulk/aktarim', 'POST', {
            tarih: v.tarih || bugun(), tutar: Number(v.tutar),
            aciklama: v.aciklama || null,
          });
        });
    }
    return null;
  };

  const ustCubuk = (dugmeler) => (
    <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', margin: '16px 0 14px' }}>
      {dugmeler.map((d) => (
        <button key={d.ad} style={d.ana ? dugmeAna : dugme} onClick={d.tikla}>{d.ad}</button>
      ))}
    </div>
  );

  // ══════════════════════════════════════════════════════════════════
  // GÖRÜNÜMLER
  // ══════════════════════════════════════════════════════════════════
  const govde = () => {
    // ── MÜLKLER ──────────────────────────────────────────────────
    if (!gorunum || gorunum === 'mulkler') {
      const liste = mulkler?.mulkler || [];
      return (
        <>
          {ustCubuk([
            { ad: '+ Yeni mülk', ana: true, tikla: () => setForm({ tip: 'mulk', veri: { simge: '🏠' } }) },
            { ad: '+ Sözleşme', tikla: () => setForm({ tip: 'sozlesme', veri: {} }) },
            { ad: '+ Mülk gideri', tikla: () => setForm({ tip: 'gider', veri: {} }) },
            { ad: '↗ TULİPİ\'ye aktar', tikla: () => setForm({ tip: 'aktarim', veri: {} }) },
          ])}
          <Form />
          {!liste.length ? (
            <BosDurum baslik="Henüz mülk yok"
                      aciklama="İlk mülkü ekleyin; sonra kiracı ve sözleşme tanımlayın."
                      ikon="🏠" />
          ) : (
            <Tablo
              baslik={`Mülkler · ${mulkler.dolu} dolu, ${mulkler.bos} boş`}
              not={`Aylık beklenen: ${fmt(mulkler.aylik_beklenen)} · satıra tıklayın`}
              kolonlar={[{ ad: '' }, { ad: 'Mülk' }, { ad: 'Tür' }, { ad: 'Kiracı' },
                { ad: 'Aylık kira', sag: true }, { ad: 'Durum' }]}
              satirlar={liste.map((m) => ({
                id: m.id, _m: m,
                hucreler: [
                  { v: m.simge || '🏠' },
                  { v: m.ad, kalin: true },
                  { v: m.tur || '—', renk: R.not2 },
                  { v: m.kiraci_ad || '—', renk: m.kiraci_ad ? R.krem : R.not3 },
                  { v: m.sozlesme_kira ? fmt(m.sozlesme_kira) : '—', sag: true, mono: true },
                  { v: m.sozlesme_id ? 'DOLU' : 'BOŞ',
                    rozet: m.sozlesme_id ? R.yesil : R.amber },
                ],
              }))}
              onSatir={(r) => mulkDosyasiAc(r._m)}
            />
          )}
        </>
      );
    }

    // ── TAHSİLAT & GECİKME ───────────────────────────────────────
    if (gorunum === 'tahsilat') {
      if (!tahsilat) return <BosDurum baslik="Yükleniyor…" ikon="⏳" />;
      const s = tahsilat.satirlar || [];
      return (
        <>
          <Form />
          {!s.length ? (
            <BosDurum baslik="Aktif sözleşme yok"
                      aciklama="Tahsilat takibi sözleşmeye dayanır. Önce mülk, kiracı ve sözleşme tanımlayın."
                      ikon="📋" />
          ) : (
            <Tablo
              baslik={`Tahsilat · ${tahsilat.borclu_adet} kiracı borçlu`}
              not={`toplam bakiye ${fmt(tahsilat.toplam_bakiye)} · tahsilat için satıra tıklayın`}
              kolonlar={[{ ad: 'Mülk' }, { ad: 'Kiracı' }, { ad: 'Aylık', sag: true },
                { ad: 'Beklenen', sag: true }, { ad: 'Alınan', sag: true },
                { ad: 'Bakiye', sag: true }, { ad: 'Durum' }]}
              satirlar={s.map((r) => ({
                id: r.sozlesme_id, _r: r,
                hucreler: [
                  { v: r.mulk_ad }, { v: r.kiraci_ad, kalin: true },
                  { v: fmt(r.aylik_kira), sag: true, mono: true, renk: R.not2 },
                  { v: fmt(r.beklenen), sag: true, mono: true },
                  { v: fmt(r.alinan), sag: true, mono: true },
                  { v: fmt(r.bakiye), sag: true, mono: true, kalin: true,
                    renk: r.bakiye > 0.5 ? R.kirmizi
                      : r.bakiye < -0.5 ? R.yesil : R.metin2 },
                  { v: r.durum === 'borclu' ? `${r.gecikme_ay} ay geride`
                      : r.durum === 'pesin' ? 'peşin' : 'güncel',
                    rozet: r.durum === 'borclu' ? R.kirmizi
                      : r.durum === 'pesin' ? R.yesil : R.not },
                ],
              }))}
              onSatir={(row) => {
                const r = row._r;
                setForm({ tip: 'tahsilat', veri: {
                  sozlesme_id: r.sozlesme_id, kiraci_ad: r.kiraci_ad,
                  mulk_ad: r.mulk_ad, aylik_kira: r.aylik_kira,
                  tutar: r.bakiye > 0 ? Math.min(r.bakiye, r.aylik_kira) : r.aylik_kira,
                  odeme_yontemi: 'havale', tulipiye_aktar: true,
                } });
              }}
            />
          )}
          {s.length ? ustCubuk([
            { ad: '🔁 Kiracı değişimi', tikla: () => {
              const aktif = (sozlesmeler?.sozlesmeler || []).filter((x) => x.durum === 'aktif');
              if (!aktif.length) { onToast?.('⚠ Aktif sözleşme yok'); return; }
              const a = aktif[0];
              setForm({ tip: 'devir', veri: {
                sozlesme_id: a.id, mulk_ad: a.mulk_ad,
                eski_kiraci_ad: a.kiraci_ad, eski_kiraci_id: a.kiraci_id,
                eski_kira: a.aylik_kira, eski_depozito: a.depozito,
              } });
            } },
          ]) : null}
        </>
      );
    }

    // ── KİRACILAR ────────────────────────────────────────────────
    if (gorunum === 'kiracilar') {
      const liste = kiracilar?.kiracilar || [];
      const aktifSoz = (sozlesmeler?.sozlesmeler || []).filter((x) => x.durum === 'aktif');
      return (
        <>
          {ustCubuk([
            { ad: '+ Yeni kiracı', ana: true, tikla: () => setForm({ tip: 'kiraci', veri: {} }) },
            { ad: '+ Sözleşme', tikla: () => setForm({ tip: 'sozlesme', veri: {} }) },
          ])}
          <Form />
          {!liste.length ? (
            <BosDurum baslik="Henüz kiracı yok"
                      aciklama="Kiracıyı bir kez tanımlayın; farklı yazımları sistem sonradan kendisi tanır."
                      ikon="👤" />
          ) : (
            <Tablo
              baslik={`Kiracılar · ${liste.length}`}
              not="satıra tıklayın — sözleşmesi varsa kiracı değişimi başlar"
              kolonlar={[{ ad: 'Ad Soyad' }, { ad: 'Telefon' }, { ad: 'Mülk' },
                { ad: 'Aylık', sag: true }, { ad: 'Bilinen yazımlar' }]}
              satirlar={liste.map((k) => {
                const soz = aktifSoz.find((x) => x.kiraci_id === k.id);
                return {
                  id: k.id, _k: k, _s: soz,
                  hucreler: [
                    { v: k.ad, kalin: true },
                    { v: k.telefon || '—', mono: true, renk: R.metin2 },
                    { v: soz?.mulk_ad || '—', renk: soz ? R.krem : R.not3 },
                    { v: soz ? fmt(soz.aylik_kira) : '—', sag: true, mono: true },
                    { v: k.takma_adlar || '—', renk: R.not2 },
                  ],
                };
              })}
              onSatir={(row) => {
                if (!row._s) { setForm({ tip: 'kiraci', veri: { ...row._k } }); return; }
                setForm({ tip: 'devir', veri: {
                  sozlesme_id: row._s.id, mulk_ad: row._s.mulk_ad,
                  eski_kiraci_ad: row._k.ad, eski_kiraci_id: row._k.id,
                  eski_kira: row._s.aylik_kira, eski_depozito: row._s.depozito,
                } });
              }}
            />
          )}
        </>
      );
    }

    // ── ABONELİKLER ──────────────────────────────────────────────
    if (gorunum === 'abonelik') {
      const liste = abonelikler?.abonelikler || [];
      return (
        <>
          {ustCubuk([
            { ad: '+ Yeni abonelik', ana: true, tikla: () => setForm({ tip: 'abonelik', veri: {} }) },
          ])}
          <Form />
          {!liste.length ? (
            <BosDurum baslik="Abonelik kaydı yok"
                      aciklama="Elektrik, su, doğalgaz, internet, aidat… Her mülk için abonenin kimin üstüne kayıtlı olduğunu ve faturayı kimin ödediğini ayrı ayrı yazın."
                      ikon="⚡" />
          ) : (
            <Tablo
              baslik={`Abonelikler · ${liste.length}`}
              not={abonelikler.riskli_adet
                ? `⚠ ${abonelikler.riskli_adet} abonelik SİZİN üstünüze kayıtlı ama faturayı kiracı ödüyor — kiracı ödemezse borç size kalır.`
                : abonelikler.not}
              kolonlar={[{ ad: '' }, { ad: 'Mülk' }, { ad: 'Tür' }, { ad: 'Sağlayıcı' },
                { ad: 'Abone' }, { ad: 'Ödeyen' }, { ad: 'Aylık', sag: true }]}
              satirlar={liste.map((a) => {
                const t = ABONELIK_TURU.find((x) => x.id === a.tur);
                const riskli = a.abone_kime === 'sahip' && a.odeyen === 'kiraci';
                return {
                  id: a.id, _a: a,
                  hucreler: [
                    { v: t?.simge || '📄' },
                    { v: `${a.mulk_simge || '🏠'} ${a.mulk_ad}` },
                    { v: t?.ad || a.tur, kalin: true },
                    { v: a.saglayici || '—', renk: R.not2 },
                    { v: a.abone_kime === 'sahip' ? (riskli ? 'siz ⚠' : 'siz') : 'kiracı',
                      renk: riskli ? R.amber : R.krem },
                    { v: a.odeyen === 'sahip' ? 'siz' : 'kiracı', renk: R.metin2 },
                    { v: a.aylik_tahmin ? fmt(a.aylik_tahmin) : '—', sag: true, mono: true },
                  ],
                };
              })}
              onSatir={(row) => setForm({ tip: 'abonelik', veri: { ...row._a } })}
            />
          )}
        </>
      );
    }

    // ── MÜLK DEFTERİ ─────────────────────────────────────────────
    if (gorunum === 'defter') {
      const s = defter?.satirlar || [];
      return (
        <>
          {ustCubuk([
            { ad: '+ Mülk gideri', tikla: () => setForm({ tip: 'gider', veri: {} }) },
            { ad: '↗ TULİPİ\'ye aktar', tikla: () => setForm({ tip: 'aktarim', veri: {} }) },
          ])}
          <Form />
          {!s.length ? (
            <BosDurum baslik="Defter boş"
                      aciklama="Kira tahsilatı, aidat, depozito ve aktarımlar buraya düşer. Her satırın kasa izi vardır."
                      ikon="📒" />
          ) : (
            <Tablo
              baslik={`Mülk defteri · ${s.length} hareket`}
              not={defter.not}
              kolonlar={[{ ad: 'Tarih' }, { ad: 'İşlem' }, { ad: 'Mülk' }, { ad: 'Kiracı' },
                { ad: 'Açıklama' }, { ad: 'Tutar', sag: true }, { ad: 'Kasa izi' }]}
              satirlar={s.map((h) => ({
                id: h.id,
                hucreler: [
                  { v: h.tarih, mono: true, renk: R.metin2 },
                  { v: h.tur.replace(/_/g, ' '), kalin: true },
                  { v: h.mulk_ad || '—', renk: R.not2 },
                  { v: h.kiraci_ad || '—', renk: R.not2 },
                  { v: h.aciklama || '—', renk: R.metin2 },
                  { v: fmt(h.tutar), sag: true, mono: true, kalin: true,
                    renk: sayi(h.tutar) < 0 ? R.kirmizi : R.yesil },
                  { v: h.kasa_iz ? '✓' : 'YOK',
                    rozet: h.kasa_iz ? R.yesil : R.kirmizi },
                ],
              }))}
            />
          )}
        </>
      );
    }

    // ── GÖÇ: eski kayıtları aktar ────────────────────────────────
    if (gorunum === 'goc') {
      if (!goc) return <BosDurum baslik="Okunuyor…" ikon="⏳" />;
      const km = goc.kiraci_kumeleri || [];
      const on = goc.birlestirme_onerileri || [];
      return (
        <>
          <div style={{
            padding: 16, borderRadius: 14, marginBottom: 16,
            background: 'rgba(251,191,36,.07)', border: '1px solid rgba(251,191,36,.28)',
          }}>
            <div style={{ fontFamily: F.baslik, fontSize: 15, color: '#FBBF24', marginBottom: 6 }}>
              🧪 Kuru çalıştırma — hiçbir şey yazılmadı
            </div>
            <div style={{ fontSize: 12.5, color: R.metin2, lineHeight: 1.6 }}>
              "Dış kaynak geliri" içindeki eski kayıtlar okundu ve türlerine
              ayrıldı. Hiçbir satır değişmedi. Aşağıdaki kiracı kümelerini
              onayladığınızda kira geçmişi mülk defterine <b>aynalanır</b>:
              mevcut kayıtlara dokunulmaz, karşılarına mülk satırı yazılır ve
              hemen TULİPİ'ye aktarılmış sayılır — <b>toplam kasa değişmez.</b>
            </div>
          </div>

          <Tablo
            baslik="Eski kayıtların gerçek içeriği"
            not="Toplam birebir tutuyor — hiçbir kayıt kaybolmuyor, hiçbiri iki kez sayılmıyor."
            kolonlar={[{ ad: 'Ne' }, { ad: 'Kayıt', sag: true },
              { ad: 'Tutar', sag: true }, { ad: 'Ne olacak' }]}
            satirlar={[
              ['🏠 Kira', goc.kira, 'mülk defterine aynalanır', R.yesil],
              ['🔐 Depozito', goc.depozito, 'emanet olarak ayrılır — gelir DEĞİL', R.amber],
              ['🧾 Mülk gideri', goc.mulk_gideri, 'mülk gideri olur', R.metin2],
              ['🏡 Varlık satışı', goc.varlik_satisi, 'gelir sayılmaz — varlık satışı', R.amber],
              ['💰 Gerçek dış kaynak', goc.gercek_dis_kaynak,
                'DOKUNULMAZ — emekli maaşı, kredi, SGK', R.not2],
            ].map(([ad, v, karar, renk], i) => ({
              id: `k${i}`,
              hucreler: [
                { v: ad, kalin: true },
                { v: String(v?.adet ?? 0), sag: true, mono: true },
                { v: fmt(v?.toplam), sag: true, mono: true, kalin: true, renk },
                { v: karar, renk: R.not2 },
              ],
            }))}
          />

          <div style={{ height: 18 }} />
          <Tablo
            baslik={`Kiracı adayları · ${km.length} küme`}
            not="Aynı kişinin farklı yazımları tek kümede toplanır. Küme sayısı gerçek kiracı sayısından fazlaysa aşağıdaki birleştirme önerilerine bakın."
            kolonlar={[{ ad: 'Önerilen ad' }, { ad: 'Kayıt', sag: true },
              { ad: 'Toplam', sag: true }, { ad: 'Aylar' }, { ad: 'Yazım' }]}
            satirlar={km.map((k, i) => ({
              id: `${k.anahtar}-${i}`,
              hucreler: [
                { v: k.onerilen_ad, kalin: true },
                { v: String(k.adet), sag: true, mono: true },
                { v: fmt(k.toplam), sag: true, mono: true },
                { v: (k.aylar || []).join(', '), renk: R.not2, mono: true },
                { v: k.yazim_adedi > 1 ? `${k.yazim_adedi} farklı` : '—',
                  renk: k.yazim_adedi > 1 ? R.amber : R.not3 },
              ],
            }))}
          />

          {on.length ? (
            <>
              <div style={{ height: 18 }} />
              <Tablo
                baslik={`Birleştirme önerileri · ${on.length}`}
                not="⚠ ÖNERİ — otomatik birleştirilmedi. İki isim benzer olabilir ama BAŞKA İNSAN olabilir; yanlış birleştirme iki kiracının borcunu tek kişide toplar."
                kolonlar={[{ ad: 'Bu' }, { ad: 'ile bu' }, { ad: 'Neden' },
                  { ad: 'Benzerlik', sag: true }, { ad: 'Toplam', sag: true }]}
                satirlar={on.map((o, i) => ({
                  id: `o${i}`,
                  hucreler: [
                    { v: o.a, kalin: true }, { v: o.b, kalin: true },
                    { v: o.gerekce, renk: R.not2 },
                    { v: `%${Math.round(o.benzerlik * 100)}`, sag: true, mono: true,
                      renk: o.benzerlik >= 0.9 ? R.amber : R.not2 },
                    { v: fmt(o.toplam), sag: true, mono: true },
                  ],
                }))}
              />
            </>
          ) : null}
        </>
      );
    }

    return <BosDurum baslik="Görünüm bulunamadı" ikon="❓" />;
  };

  return (
    <div>
      <KasaSeridi kasa={kasa} />
      {govde()}
    </div>
  );
}
