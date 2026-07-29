// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — PARA HAREKETLERİ modülü (kadife koyu)
// Blueprint: tasarim/cloud-v2/03_evvel-erp-v2_GUNCEL.dc.html → para.* bölümleri
//
// 5 görünüm: Ciro Girişi · Ürün Satışları · Kasa Teslim · Anlık Gider · Dış Kaynak
//
// İlkeler:
// - TÜM görünümler SALT-OKUR: ciro/gider/dış-kaynak GİRİŞİ mevcut guard'lı
//   formlarda kalır (köprüyle açılır) — yeni para yazma yolu YOK.
// - Blueprint'ten bilinçli sapmalar (tasarımın-devamı kuralı):
//   * Ürün Satışları'nda "Sabah/Öğle/Akşam" kolonları YOK — Evo raporu saatlik
//     kırılım vermiyor, sahte sayı yasak. Yerine şube kırılımı çekmecesi.
//   * Kasa Teslim'de "teslim bekleyen" KPI'sı YOK — sistemde 'bekleyen teslim'
//     kaydı tutulmuyor (teslim edilince kayıt doğar); olmayan veri uydurulmaz.
//     kasaTeslim rozeti de bu yüzden BAĞLANMADI.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Tablo } from './parcalar';

const sayi = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// Tarih tuzağı (bkz TasarimV2): "bugün" yerel parçalardan, aritmetik UTC'de
const bugunISO = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const gunEkle = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const AYLAR = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const tarihKisa = (iso) => {
  const s = String(iso || '').slice(0, 10);
  if (s.length < 10) return '—';
  return `${Number(s.slice(8, 10))} ${AYLAR[Number(s.slice(5, 7)) - 1] || ''}`;
};

const rozetHap = (renk) => ({
  padding: '3px 10px', borderRadius: 99, fontSize: 10.5, fontWeight: 700,
  background: `${renk}22`, color: renk, whiteSpace: 'nowrap',
});

function Yukleniyor() {
  return (
    <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not, fontSize: 13 }}>
      Yükleniyor…
    </div>
  );
}
function HataBandi({ mesaj, onTekrar }) {
  return (
    <div style={{
      ...kartYuzey, padding: '16px 20px', marginBottom: 16, display: 'flex',
      alignItems: 'center', gap: 14, border: `1px solid ${R.kirmizi}55`,
    }}>
      <span style={{ fontSize: 13, color: R.kirmizi, flex: 1 }}>
        Veri alınamadı — {mesaj || 'sunucuya ulaşılamadı'}. Bu "veri yok" değil, bağlantı sorunu.
      </span>
      <button onClick={onTekrar} style={{
        padding: '7px 14px', borderRadius: 9, border: `1px solid ${R.kirmizi}55`,
        background: `${R.kirmizi}18`, color: R.kirmizi, fontSize: 12, fontWeight: 700,
        fontFamily: 'inherit', cursor: 'pointer',
      }}>
        🔄 Tekrar dene
      </button>
    </div>
  );
}
function BosDurum({ metin }) {
  return (
    <div style={{ ...kartYuzey, padding: '34px 30px', textAlign: 'center' }}>
      <div style={{ fontSize: 13, color: R.not }}>{metin}</div>
    </div>
  );
}
function KopruButon({ ad, onTikla, birincil }) {
  return (
    <button onClick={onTikla} style={birincil ? {
      padding: '9px 17px', borderRadius: 10, border: 'none',
      background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
      fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
      boxShadow: '0 6px 18px rgba(217,154,78,.24)',
    } : {
      padding: '9px 16px', borderRadius: 10, border: `1px solid ${R.cizgi3}`,
      background: R.girinti, color: R.metin2, fontSize: 12, fontWeight: 600,
      fontFamily: 'inherit', cursor: 'pointer',
    }}>
      {ad}
    </button>
  );
}

// Kadife form alanı stili (yerli giriş — köprüsüz)
const alanStil = {
  width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
  border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
  fontSize: 13, fontFamily: 'inherit', outline: 'none',
};
const alanEtiket = {
  fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase',
  color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block',
};

export default function ParaModulu({ gorunum, onCekmece, onKopru, onToast }) {
  // ── CİRO GİRİŞİ ───────────────────────────────────────────────────────────
  const [cirolar, setCirolar] = useState(null);
  const [subeler, setSubeler] = useState([]);
  const [taslaklar, setTaslaklar] = useState([]);
  const [ciroHata, setCiroHata] = useState('');
  // v2-YERLİ ciro formu (2026-07-29 sahip kararı: köprüler kalkıyor) — aynı
  // guard'lı uca yazar (POST /ciro: mükerrer uyarı + force; DELETE: kasa iadesi)
  const [ciroForm, setCiroForm] = useState(null);      // null=kapalı | {tarih,sube_id,nakit,pos,online,aciklama}
  const [ciroDup, setCiroDup] = useState('');          // mükerrer uyarı metni
  const [ciroMesgul, setCiroMesgul] = useState(false);
  const [iptalSor, setIptalSor] = useState('');        // iki-adımlı iptal onayı (kayıt id)
  // ── ÜRÜN SATIŞLARI ────────────────────────────────────────────────────────
  const [satisGun, setSatisGun] = useState(() => bugunISO());
  const [satis, setSatis] = useState(null);
  const [satisHata, setSatisHata] = useState('');
  // ── KASA TESLİM ───────────────────────────────────────────────────────────
  const [teslimler, setTeslimler] = useState(null);
  const [teslimHata, setTeslimHata] = useState('');
  const [paraYolda, setParaYolda] = useState(null);  // duyu 2/6 (salt-okur)
  // ── ANLIK GİDER ───────────────────────────────────────────────────────────
  const [giderler, setGiderler] = useState(null);
  const [giderOzet, setGiderOzet] = useState(null);
  const [giderHata, setGiderHata] = useState('');
  // ── DIŞ KAYNAK ────────────────────────────────────────────────────────────
  const [dkAy, setDkAy] = useState(() => bugunISO().slice(0, 7));
  const [diskaynak, setDiskaynak] = useState(null);
  const [dkHata, setDkHata] = useState('');

  const ciroYukle = useCallback(() => {
    setCiroHata('');
    Promise.all([
      api('/ciro?limit=300'),
      api('/subeler'),
      api('/ciro-taslak?durum=bekliyor').catch(() => []),
    ]).then(([c, s, t]) => {
      setCirolar(Array.isArray(c) ? c : []);
      setSubeler(Array.isArray(s) ? s : []);
      setTaslaklar(Array.isArray(t) ? t : []);
    }).catch((e) => setCiroHata(e?.message || ''));
  }, []);

  const ciroKaydet = async (force = false) => {
    if (!ciroForm?.sube_id) { onToast?.('Şube seçmeden ciro kaydedilmez'); return; }
    setCiroMesgul(true);
    setCiroDup('');
    try {
      const res = await api('/ciro', { method: 'POST', body: { ...ciroForm, force } });
      if (res?.warning) { setCiroDup(res.mesaj || 'Benzer kayıt var.'); return; }
      onToast?.('✓ Ciro kaydedildi — merkez kasaya eklendi');
      setCiroForm(null);
      ciroYukle();
    } catch (e) {
      onToast?.(e?.message || 'Ciro kaydedilemedi');
    } finally {
      setCiroMesgul(false);
    }
  };

  const ciroIptal = async (id) => {
    setCiroMesgul(true);
    try {
      await api(`/ciro/${id}`, { method: 'DELETE' });
      onToast?.('Ciro iptal edildi — kasadan iade edildi');
      setIptalSor('');
      ciroYukle();
    } catch (e) {
      onToast?.(e?.message || 'İptal edilemedi');
    } finally {
      setCiroMesgul(false);
    }
  };

  const satisYukle = useCallback((gun) => {
    setSatisHata('');
    setSatis(null);
    api(`/evo/sube-grup-detay?bastar=${gun}&bittar=${gun}`)
      .then((d) => setSatis(d || {}))
      .catch((e) => setSatisHata(e?.message || ''));
  }, []);

  const teslimYukle = useCallback(() => {
    setTeslimHata('');
    const b = bugunISO();
    Promise.all([
      api(`/kasa-teslim?tarih_baslangic=${b.slice(0, 7)}-01&tarih_bitis=${b}`),
      subeler.length ? Promise.resolve(subeler) : api('/subeler').catch(() => []),
    ]).then(([k, s]) => {
      setTeslimler(Array.isArray(k) ? k : (k?.satirlar || []));
      if (!subeler.length && Array.isArray(s)) setSubeler(s);
    }).catch((e) => setTeslimHata(e?.message || ''));
    api('/ops/para-yolda?gun=14')
      .then((d) => setParaYolda(d || {}))
      .catch(() => setParaYolda({}));
  }, [subeler]);

  const giderYukle = useCallback(() => {
    setGiderHata('');
    const ay = bugunISO().slice(0, 7);
    api(`/anlik-gider?durum=aktif&include_summary=true&ay=${ay}`)
      .then((d) => {
        setGiderler(Array.isArray(d) ? d : (d?.satirlar || []));
        setGiderOzet(d?.ozet || null);
      })
      .catch((e) => setGiderHata(e?.message || ''));
  }, []);

  const dkYukle = useCallback((ay) => {
    setDkHata('');
    setDiskaynak(null);
    api(`/dis-kaynak?ay=${ay}`)
      .then((d) => setDiskaynak(Array.isArray(d) ? d : (d?.liste || [])))
      .catch((e) => setDkHata(e?.message || ''));
  }, []);

  useEffect(() => {
    if (gorunum === 'girisi') ciroYukle();
    if (gorunum === 'satis') satisYukle(satisGun);
    if (gorunum === 'kasa') teslimYukle();
    if (gorunum === 'gider') giderYukle();
    if (gorunum === 'diskaynak') dkYukle(dkAy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gorunum]);

  const subeAd = useMemo(() => {
    const m = {};
    (subeler || []).forEach((s) => { m[String(s.id)] = s.ad; });
    return m;
  }, [subeler]);

  // ════════════════════════ GÖRÜNÜM: CİRO GİRİŞİ ════════════════════════════
  if (gorunum === 'girisi') {
    if (ciroHata) return <HataBandi mesaj={ciroHata} onTekrar={ciroYukle} />;
    if (cirolar == null) return <Yukleniyor />;
    const bugun = bugunISO();
    const dun = gunEkle(bugun, -1);
    const gunKayit = (g) => cirolar.filter((c) => String(c.tarih || '').slice(0, 10) === g);
    const bugunku = gunKayit(bugun);
    const dunku = gunKayit(dun);
    const toplam = (rows) => rows.reduce((t, c) => t + (sayi(c.toplam) || sayi(c.nakit) + sayi(c.pos) + sayi(c.online)), 0);
    const girilenSubeler = new Set(bugunku.map((c) => String(c.sube_id)));
    const magazalar = (subeler || []).filter((s) => s.aktif !== false);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bugün girilen', deger: `${girilenSubeler.size} / ${magazalar.length} şube`, alt: girilenSubeler.size < magazalar.length ? 'eksik şube var' : 'tamamlandı', renk: girilenSubeler.size < magazalar.length ? R.amber : R.yesil },
          { etiket: 'Bugünkü toplam', deger: fmt(toplam(bugunku)), alt: 'onaylı ciro kayıtları' },
          { etiket: 'Dün', deger: fmt(toplam(dunku)), alt: `${dunku.length} şube kaydı` },
          { etiket: 'Onay bekleyen taslak', deger: String(taslaklar.length), alt: 'ciro onayında', renk: taslaklar.length > 0 ? R.amber : R.krem },
        ]} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          {magazalar.map((s) => {
            const kayit = bugunku.find((c) => String(c.sube_id) === String(s.id));
            return (
              <div key={s.id} style={{
                ...kartYuzey, padding: '13px 18px', display: 'flex', alignItems: 'center',
                gap: 14, flexWrap: 'wrap',
                border: kayit ? kartYuzey.border : `1px solid ${R.amber}44`,
              }}>
                <div style={{ flex: 1, minWidth: 150 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700 }}>{s.ad}</div>
                  <div style={{ fontSize: 11, color: R.not2, marginTop: 2 }}>
                    {kayit ? `bugün girildi · ${tarihKisa(kayit.tarih)}` : 'bugünün cirosu henüz girilmedi'}
                  </div>
                </div>
                {kayit ? (
                  <>
                    <span style={{ fontFamily: F.mono, fontSize: 14, fontWeight: 700 }}>
                      {fmt(sayi(kayit.toplam) || sayi(kayit.nakit) + sayi(kayit.pos) + sayi(kayit.online))}
                    </span>
                    <span style={rozetHap(R.yesil)}>✓ girildi</span>
                    {iptalSor === String(kayit.id) ? (
                      <span style={{ display: 'flex', gap: 6 }}>
                        <button disabled={ciroMesgul} onClick={() => ciroIptal(kayit.id)} style={{
                          padding: '6px 12px', borderRadius: 9, border: 'none', cursor: 'pointer',
                          background: `${R.kirmizi}22`, color: R.kirmizi, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
                        }}>
                          Eminim — kasadan iade et
                        </button>
                        <button onClick={() => setIptalSor('')} style={{
                          padding: '6px 10px', borderRadius: 9, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                          background: 'transparent', color: R.metin2, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
                        }}>
                          Vazgeç
                        </button>
                      </span>
                    ) : (
                      <button onClick={() => setIptalSor(String(kayit.id))} style={{
                        padding: '6px 11px', borderRadius: 9, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                        background: 'transparent', color: R.not, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
                      }}>
                        İptal
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <span style={rozetHap(R.amber)}>bekliyor</span>
                    <KopruButon birincil ad="Ciro gir" onTikla={() => {
                      setCiroDup('');
                      setCiroForm({ tarih: bugun, sube_id: String(s.id), nakit: '', pos: '', online: '', aciklama: '' });
                    }} />
                  </>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', marginBottom: 16 }}>
          <KopruButon birincil ad="+ Ciro Gir (serbest tarih/şube)" onTikla={() => {
            setCiroDup('');
            setCiroForm({ tarih: bugun, sube_id: '', nakit: '', pos: '', online: '', aciklama: '' });
          }} />
          {taslaklar.length > 0 && <KopruButon ad={`Ciro onayı (${taslaklar.length})`} onTikla={() => onKopru?.('__modul:onaylar:ciro')} />}
        </div>

        {/* ── YERLİ CİRO FORMU (kadife modal — köprü kaldırıldı, aynı uca yazar) ── */}
        {ciroForm && (() => {
          const sube = (subeler || []).find((x) => String(x.id) === String(ciroForm.sube_id));
          const posK = (sayi(ciroForm.pos) * (sayi(sube?.pos_oran))) / 100;
          const onlK = (sayi(ciroForm.online) * (sayi(sube?.online_oran))) / 100;
          const yanan = posK + onlK;
          const toplamG = sayi(ciroForm.nakit) + sayi(ciroForm.pos) + sayi(ciroForm.online);
          const alan = (k, v) => setCiroForm((f) => ({ ...f, [k]: v }));
          return (
            <div
              onClick={(e) => { if (e.target === e.currentTarget && !ciroMesgul) setCiroForm(null); }}
              style={{
                position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
                backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
              }}
            >
              <div style={{ ...kartYuzey, width: 520, maxWidth: '96vw', maxHeight: '92vh', overflowY: 'auto', padding: '24px 26px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 18 }}>
                  <div style={{ fontFamily: F.baslik, fontSize: 21, fontWeight: 600 }}>Ciro Gir</div>
                  <div style={{ fontSize: 11.5, color: R.not2 }}>kaydedilince merkez kasaya eklenir</div>
                  <button onClick={() => !ciroMesgul && setCiroForm(null)} style={{
                    marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                    fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                  }}>✕</button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                  <div>
                    <label style={alanEtiket}>Tarih</label>
                    <input type="date" value={ciroForm.tarih} onChange={(e) => alan('tarih', e.target.value)}
                      style={{ ...alanStil, colorScheme: 'dark' }} />
                  </div>
                  <div>
                    <label style={alanEtiket}>Şube *</label>
                    <select value={ciroForm.sube_id} onChange={(e) => alan('sube_id', e.target.value)} style={alanStil}>
                      <option value="">Seçin</option>
                      {(subeler || []).map((x) => <option key={x.id} value={x.id}>{x.ad}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={alanEtiket}>Nakit (₺)</label>
                    <input type="number" value={ciroForm.nakit} onChange={(e) => alan('nakit', e.target.value)}
                      style={{ ...alanStil, fontFamily: F.mono, textAlign: 'right' }} />
                  </div>
                  <div>
                    <label style={alanEtiket}>POS (₺)</label>
                    <input type="number" value={ciroForm.pos} onChange={(e) => alan('pos', e.target.value)}
                      style={{ ...alanStil, fontFamily: F.mono, textAlign: 'right' }} />
                  </div>
                  <div>
                    <label style={alanEtiket}>Online (₺)</label>
                    <input type="number" value={ciroForm.online} onChange={(e) => alan('online', e.target.value)}
                      style={{ ...alanStil, fontFamily: F.mono, textAlign: 'right' }} />
                  </div>
                  <div>
                    <label style={alanEtiket}>Açıklama</label>
                    <input value={ciroForm.aciklama} onChange={(e) => alan('aciklama', e.target.value)} style={alanStil} />
                  </div>
                </div>

                {/* Anlık toplam + yanan para (finansman maliyeti) */}
                <div style={{
                  marginTop: 16, padding: '12px 16px', borderRadius: 12, background: R.girinti,
                  border: `1px solid ${R.cizgi3}`, display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12.5,
                }}>
                  <span style={{ color: R.metin2 }}>
                    Toplam: <strong style={{ fontFamily: F.mono, color: R.krem }}>{fmt(toplamG)}</strong>
                  </span>
                  {yanan > 0 && (
                    <>
                      {posK > 0 && <span style={{ color: R.metin2 }}>POS kesinti (%{sayi(sube?.pos_oran)}): <strong style={{ fontFamily: F.mono, color: R.kirmizi }}>−{fmt(posK)}</strong></span>}
                      {onlK > 0 && <span style={{ color: R.metin2 }}>Online kesinti (%{sayi(sube?.online_oran)}): <strong style={{ fontFamily: F.mono, color: R.kirmizi }}>−{fmt(onlK)}</strong></span>}
                      <span style={{ color: R.kirmizi, fontWeight: 700 }}>🔥 Yanan: {fmt(yanan)}</span>
                    </>
                  )}
                </div>

                {ciroDup && (
                  <div style={{
                    marginTop: 14, padding: '13px 16px', borderRadius: 12,
                    background: `${R.kirmizi}14`, border: `1px solid ${R.kirmizi}55`,
                  }}>
                    <div style={{ fontSize: 12.5, color: R.kirmizi, fontWeight: 700 }}>⚠ Benzer kayıt var</div>
                    <div style={{ fontSize: 12, color: R.metin2, marginTop: 5, lineHeight: 1.55 }}>{ciroDup}</div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button disabled={ciroMesgul} onClick={() => ciroKaydet(true)} style={{
                        padding: '7px 13px', borderRadius: 9, border: 'none', cursor: 'pointer',
                        background: `${R.kirmizi}26`, color: R.kirmizi, fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                      }}>
                        Yine de kaydet
                      </button>
                      <button onClick={() => setCiroDup('')} style={{
                        padding: '7px 12px', borderRadius: 9, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                        background: 'transparent', color: R.metin2, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                      }}>
                        Vazgeç
                      </button>
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
                  <button disabled={ciroMesgul} onClick={() => setCiroForm(null)} style={{
                    padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                    background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                  }}>
                    İptal
                  </button>
                  <button disabled={ciroMesgul || !ciroForm.sube_id || ciroDup !== ''} onClick={() => ciroKaydet(false)} style={{
                    padding: '10px 20px', borderRadius: 10, border: 'none',
                    background: (!ciroForm.sube_id || ciroDup !== '') ? R.girinti : 'linear-gradient(150deg, #D99A4E, #B06E2C)',
                    color: (!ciroForm.sube_id || ciroDup !== '') ? R.not : '#1C1309',
                    fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                    cursor: (!ciroForm.sube_id || ciroDup !== '') ? 'default' : 'pointer',
                  }}>
                    {ciroMesgul ? 'Kaydediliyor…' : 'Kaydet'}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: ÜRÜN SATIŞLARI ═════════════════════════
  if (gorunum === 'satis') {
    if (satisHata) return <HataBandi mesaj={satisHata} onTekrar={() => satisYukle(satisGun)} />;
    if (satis == null) return <Yukleniyor />;
    const subeVeri = satis?.subeler || {};
    // Ürünleri şubeler arası topla
    const urunMap = {};
    let toplamAdet = 0; let toplamCiro = 0;
    Object.entries(subeVeri).forEach(([sad, sd]) => {
      (sd?.cok_satilan || []).forEach((u) => {
        const k = String(u.ad || '').trim();
        if (!k) return;
        if (!urunMap[k]) urunMap[k] = { ad: k, grup: u.grup || '—', adet: 0, ciro: 0, subeler: {} };
        urunMap[k].adet += sayi(u.adet);
        urunMap[k].ciro += sayi(u.ciro);
        urunMap[k].subeler[sad] = (urunMap[k].subeler[sad] || 0) + sayi(u.adet);
        toplamAdet += sayi(u.adet);
        toplamCiro += sayi(u.ciro);
      });
    });
    const urunler = Object.values(urunMap).sort((a, b) => b.adet - a.adet);
    const enCok = urunler[0];
    const gunSecici = (
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {[[bugunISO(), 'Bugün'], [gunEkle(bugunISO(), -1), 'Dün'], [gunEkle(bugunISO(), -2), tarihKisa(gunEkle(bugunISO(), -2))]].map(([g, ad]) => (
          <div
            key={g}
            onClick={() => { setSatisGun(g); satisYukle(g); }}
            style={{
              padding: '6px 14px', borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              background: satisGun === g ? `${R.bakir}22` : R.girinti,
              color: satisGun === g ? R.bakir : R.not,
              border: `1px solid ${satisGun === g ? `${R.bakir}55` : R.cizgi3}`,
            }}
          >
            {ad}
          </div>
        ))}
      </div>
    );
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Satılan ürün', deger: String(toplamAdet), alt: `${urunler.length} çeşit · ${Object.keys(subeVeri).length} şube` },
          { etiket: 'Ürün cirosu', deger: toplamCiro > 0 ? fmt(toplamCiro) : '—', alt: 'Evo satış raporu' },
          { etiket: 'En çok satan', deger: enCok ? enCok.ad : '—', alt: enCok ? `${enCok.adet} adet` : 'kayıt yok', renk: R.yesil },
          { etiket: 'Gün', deger: tarihKisa(satisGun), alt: 'Evo gece senkronuyla dolar' },
        ]} />
        {gunSecici}
        {urunler.length === 0 ? (
          <BosDurum metin="Bu gün için Evo satış raporu henüz düşmedi — rapor gece senkronuyla gelir. Dünü seçerek tamamlanmış günü görebilirsin." />
        ) : (
          <Tablo
            baslik={`Ürün satışları · ${tarihKisa(satisGun)}`}
            not="satıra tıkla → şube kırılımı"
            kolonlar={[
              { ad: 'Ürün' }, { ad: 'Grup' }, { ad: 'Adet', sag: 1 }, { ad: 'Ciro', sag: 1 }, { ad: 'Pay', sag: 1 },
            ]}
            satirlar={urunler.slice(0, 30).map((u, i) => ({
              id: `u-${i}`,
              _u: u,
              hucreler: [
                { v: u.ad, kalin: true },
                { v: u.grup, renk: R.not },
                { v: String(u.adet), mono: true, sag: true, kalin: i === 0 },
                { v: u.ciro > 0 ? fmt(u.ciro) : '—', mono: true, sag: true },
                { v: toplamAdet ? `%${Math.round((u.adet / toplamAdet) * 100)}` : '—', bar: toplamAdet ? Math.round((u.adet / toplamAdet) * 100) : 0, sag: true, renk: R.bakir },
              ],
            }))}
            onSatir={({ _u }) => onCekmece?.({
              tip: 'ÜRÜN SATIŞI',
              baslik: _u.ad,
              alt: `${_u.grup} · ${tarihKisa(satisGun)} · ${_u.adet} adet`,
              kpi: [
                { etiket: 'Adet', deger: String(_u.adet) },
                { etiket: 'Ciro', deger: _u.ciro > 0 ? fmt(_u.ciro) : '—' },
                { etiket: 'Şube', deger: String(Object.keys(_u.subeler).length) },
                { etiket: 'Pay', deger: toplamAdet ? `%${Math.round((_u.adet / toplamAdet) * 100)}` : '—', renk: R.bakir },
              ],
              listeBaslik: 'Şube kırılımı',
              satirlar: Object.entries(_u.subeler)
                .sort((a, b) => b[1] - a[1])
                .map(([sad, adet]) => ({ ad: sad, detay: '', tutar: `${adet} adet` })),
              not: 'Reçete maliyeti ve tüketim kıyası Kâr & Maliyet modülünde.',
              aksiyonAd: 'Satış analizini aç (Evo)',
              _hedef: 'evo-satis',
            })}
          />
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: KASA TESLİM ════════════════════════════
  if (gorunum === 'kasa') {
    if (teslimHata) return <HataBandi mesaj={teslimHata} onTekrar={teslimYukle} />;
    if (teslimler == null) return <Yukleniyor />;
    const bugun = bugunISO();
    const bugunku = teslimler.filter((t) => String(t.tarih || '').slice(0, 10) === bugun);
    const ara = teslimler.filter((t) => t.teslim_turu === 'ara');
    const gunSonu = teslimler.filter((t) => t.teslim_turu === 'gun_sonu');
    const toplam = (rows) => rows.reduce((s, t) => s + sayi(t.tutar), 0);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bugün teslim', deger: `${bugunku.length} kayıt`, alt: fmt(toplam(bugunku)), renk: bugunku.length > 0 ? R.yesil : R.krem },
          { etiket: 'Bu ay ara teslim', deger: String(ara.length), alt: fmt(toplam(ara)) },
          { etiket: 'Bu ay gün sonu', deger: String(gunSonu.length), alt: fmt(toplam(gunSonu)) },
          { etiket: 'Bu ay toplam', deger: fmt(toplam(teslimler)), alt: `${teslimler.length} teslim kaydı` },
        ]} />
        {/* PARA YOLDA DUYUSU 2/6 (2026-07-29): "teslim bekleyen" artık uydurma
            değil TÜRETİLMİŞ veri — kapanış cevap_ts ↔ gun_sonu teslim eşlemesi. */}
        {paraYolda && sayi(paraYolda.kapanis_adet) > 0 && (
          <div style={{
            ...kartYuzey, padding: '16px 18px', marginBottom: 14,
            border: sayi(paraYolda.gecikmis_adet) > 0 ? `1px solid ${R.kirmizi}55` : kartYuzey.border,
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              paddingBottom: 10, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 11, flexWrap: 'wrap', gap: 8,
            }}>
              <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>
                💸 Para yolda · son {sayi(paraYolda.kesit_gun)} gün
              </span>
              <span style={{ fontSize: 10.5, color: R.not2 }}>
                kapanış ↔ gün sonu teslimi eşlemesi · 18 saati aşan gecikmiş sayılır
              </span>
            </div>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12.5, marginBottom: sayi(paraYolda.bekleyen_adet) > 0 ? 11 : 0 }}>
              <span>Kapanış <b style={{ fontFamily: F.mono }}>{sayi(paraYolda.kapanis_adet)}</b></span>
              <span>teslimle eşleşen <b style={{ fontFamily: F.mono, color: R.yesil }}>{sayi(paraYolda.eslesen_adet)}</b></span>
              <span>bekleyen <b style={{ fontFamily: F.mono, color: sayi(paraYolda.bekleyen_adet) > 0 ? R.amber : R.yesil }}>{sayi(paraYolda.bekleyen_adet)}</b></span>
              <span>gecikmiş <b style={{ fontFamily: F.mono, color: sayi(paraYolda.gecikmis_adet) > 0 ? R.kirmizi : R.yesil }}>{sayi(paraYolda.gecikmis_adet)}</b></span>
              <span style={{ color: R.not2 }}>
                ort. kapanış→teslim {paraYolda.ort_teslim_saat != null ? `${paraYolda.ort_teslim_saat} sa` : '—'}
              </span>
            </div>
            {(paraYolda.bekleyenler || []).slice(0, 6).map((b, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5,
                padding: '8px 0', borderTop: i === 0 ? `1px solid ${R.cizgi2}` : 'none',
              }}>
                <span style={rozetHap(b.gecikmis ? R.kirmizi : R.amber)}>
                  {b.gecikmis ? 'gecikmiş' : 'yolda'}
                </span>
                <span style={{ fontWeight: 700, flex: 1 }}>{b.sube}</span>
                <span style={{ color: R.not2, fontSize: 11.5 }}>
                  {tarihKisa(b.tarih)} {b.kapanis_saat} kapanış · {b.gecen_saat != null ? `${Math.round(b.gecen_saat)} sa geçti` : ''}
                </span>
                {b.beklenen_tutar != null && (
                  <span style={{ fontFamily: F.mono, fontWeight: 700 }}>{fmt(sayi(b.beklenen_tutar))}</span>
                )}
              </div>
            ))}
          </div>
        )}
        {teslimler.length === 0 ? (
          <BosDurum metin="Bu ay kasa teslim kaydı yok." />
        ) : (
          <Tablo
            baslik="Kasa teslimleri · bu ay"
            not="teslim eden → alan; kayıt kasa iziyle doğar"
            kolonlar={[
              { ad: 'Tarih' }, { ad: 'Şube' }, { ad: 'Tür' }, { ad: 'Teslim eden → alan' }, { ad: 'Tutar', sag: 1 },
            ]}
            satirlar={[...teslimler]
              .sort((a, b) => String(b.tarih).localeCompare(String(a.tarih)))
              .slice(0, 40)
              .map((t, i) => ({
                id: t.id || `t-${i}`,
                hucreler: [
                  { v: tarihKisa(t.tarih), mono: true, renk: R.not },
                  { v: subeAd[String(t.sube_id)] || t.sube_adi || '—', kalin: true },
                  t.teslim_turu === 'gun_sonu'
                    ? { v: '🌙 gün sonu', rozet: R.mavi }
                    : { v: '🔄 ara', rozet: R.amber },
                  { v: `${t.teslim_eden_ad || '—'} → ${t.teslim_alan_ad || '—'}`, renk: R.metin2 },
                  { v: fmt(sayi(t.tutar)), mono: true, sag: true, kalin: true },
                ],
              }))}
          />
        )}
        <div style={{ display: 'flex', gap: 9, marginTop: 2, marginBottom: 16 }}>
          <KopruButon ad="Kasa Teslim ekranını aç" onTikla={() => onKopru?.('kasa-teslim')} />
        </div>
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: ANLIK GİDER ════════════════════════════
  if (gorunum === 'gider') {
    if (giderHata) return <HataBandi mesaj={giderHata} onTekrar={giderYukle} />;
    if (giderler == null) return <Yukleniyor />;
    const bugun = bugunISO();
    const bugunku = giderler.filter((g) => String(g.tarih || '').slice(0, 10) === bugun);
    const toplam = (rows) => rows.reduce((s, g) => s + sayi(g.tutar), 0);
    const enBuyuk = [...giderler].sort((a, b) => sayi(b.tutar) - sayi(a.tutar))[0];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bugünkü anlık gider', deger: fmt(toplam(bugunku)), alt: `${bugunku.length} kayıt`, renk: bugunku.length > 0 ? R.amber : R.krem },
          { etiket: 'Bu ay toplam', deger: fmt(sayi(giderOzet?.toplam) || toplam(giderler)), alt: 'plan dışı harcama' },
          { etiket: 'Kayıt sayısı', deger: String(giderler.length), alt: 'bu ay' },
          { etiket: 'En büyük kalem', deger: enBuyuk ? fmt(sayi(enBuyuk.tutar)) : '—', alt: enBuyuk ? String(enBuyuk.aciklama || '').slice(0, 26) : 'kayıt yok' },
        ]} />
        {giderler.length === 0 ? (
          <BosDurum metin="Bu ay anlık gider kaydı yok — plan dışı harcama girilmemiş." />
        ) : (
          <Tablo
            baslik="Anlık giderler · bu ay"
            not="kayıt anında kasadan düşer"
            kolonlar={[
              { ad: 'Tarih' }, { ad: 'Açıklama' }, { ad: 'Şube' }, { ad: 'Tutar', sag: 1 },
            ]}
            satirlar={[...giderler]
              .sort((a, b) => String(b.tarih).localeCompare(String(a.tarih)))
              .slice(0, 40)
              .map((g, i) => ({
                id: g.id || `g-${i}`,
                hucreler: [
                  { v: tarihKisa(g.tarih), mono: true, renk: R.not },
                  { v: g.aciklama || '—', kalin: true },
                  { v: g.sube_adi || subeAd[String(g.sube_id)] || g.sube || '—', renk: R.not },
                  { v: fmt(sayi(g.tutar)), mono: true, sag: true, renk: R.kirmizi },
                ],
              }))}
          />
        )}
        <div style={{ display: 'flex', gap: 9, marginTop: 2, marginBottom: 16 }}>
          <KopruButon birincil ad="Anlık gider gir" onTikla={() => onKopru?.('anlik-gider')} />
        </div>
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: DIŞ KAYNAK ═════════════════════════════
  if (gorunum === 'diskaynak') {
    if (dkHata) return <HataBandi mesaj={dkHata} onTekrar={() => dkYukle(dkAy)} />;
    if (diskaynak == null) return <Yukleniyor />;
    const buAy = bugunISO().slice(0, 7);
    const gecenAy = gunEkle(buAy + '-01', -1).slice(0, 7);
    const toplam = diskaynak.reduce((s, r) => s + sayi(r.tutar), 0);
    const enBuyuk = [...diskaynak].sort((a, b) => sayi(b.tutar) - sayi(a.tutar))[0];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Dönem dış geliri', deger: fmt(toplam), alt: `${diskaynak.length} kayıt · ciro dışı`, renk: R.yesil },
          { etiket: 'En büyük kayıt', deger: enBuyuk ? fmt(sayi(enBuyuk.tutar)) : '—', alt: enBuyuk ? String(enBuyuk.aciklama || '').slice(0, 26) : '—' },
          { etiket: 'Dönem', deger: dkAy, alt: 'aşağıdan değiştir' },
          { etiket: 'Not', deger: 'kasaya işlenir', alt: 'ciro istatistiklerine karışmaz' },
        ]} />
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          {[[buAy, 'Bu ay'], [gecenAy, 'Geçen ay']].map(([a, ad]) => (
            <div
              key={a}
              onClick={() => { setDkAy(a); dkYukle(a); }}
              style={{
                padding: '6px 14px', borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                background: dkAy === a ? `${R.bakir}22` : R.girinti,
                color: dkAy === a ? R.bakir : R.not,
                border: `1px solid ${dkAy === a ? `${R.bakir}55` : R.cizgi3}`,
              }}
            >
              {ad}
            </div>
          ))}
        </div>
        {diskaynak.length === 0 ? (
          <BosDurum metin="Bu dönemde dış kaynak geliri kaydı yok." />
        ) : (
          <Tablo
            baslik={`Dış kaynak gelirleri · ${dkAy}`}
            not="ciro dışı gelirler — kasaya işlenir"
            kolonlar={[
              { ad: 'Tarih' }, { ad: 'Açıklama' }, { ad: 'Durum' }, { ad: 'Tutar', sag: 1 },
            ]}
            satirlar={[...diskaynak]
              .sort((a, b) => String(b.tarih).localeCompare(String(a.tarih)))
              .slice(0, 40)
              .map((r, i) => ({
                id: r.id || `d-${i}`,
                hucreler: [
                  { v: tarihKisa(r.tarih), mono: true, renk: R.not },
                  { v: r.aciklama || '—', kalin: true },
                  { v: r.durum === 'aktif' ? 'işlendi' : (r.durum || '—'), rozet: r.durum === 'aktif' ? R.yesil : R.amber },
                  { v: fmt(sayi(r.tutar)), mono: true, sag: true, renk: R.yesil, kalin: true },
                ],
              }))}
          />
        )}
        <div style={{ display: 'flex', gap: 9, marginTop: 2, marginBottom: 16 }}>
          <KopruButon birincil ad="Dış kaynak geliri gir" onTikla={() => onKopru?.('dis-kaynak')} />
        </div>
      </>
    );
  }

  return <BosDurum metin="Bilinmeyen görünüm." />;
}
