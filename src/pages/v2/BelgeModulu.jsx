// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — BELGE MERKEZİ modülü (kadife koyu)
// Blueprint: tasarim/cloud-v2/03_evvel-erp-v2_GUNCEL.dc.html → belge.* bölümleri
//
// 7 görünüm: Belge Kapsama · Fatura Arşivi (FTS) · Fatura İstek · Mükerrer &
//            Parmak İzi · Cari Ekstre · Fiyat Bandı · KDV Kanıt Paketi
//
// Veri omurgası: /api/fatura/belge-merkezi (kapsama + arşiv + KDV kanıt tek uç),
// /api/fatura-istek/liste (BM-4), /api/fatura/cari-ekstre (BM-5),
// /api/fatura/fiyat-bandi (BM-6), /api/fatura/ara (BM-8 FTS).
// TÜM görünümler SALT-OKUR; fatura isteme/onay mevcut ekranlarda (köprü).
// KDV kanıtında motorun kendi ilkesi ekranda: KDV TUTARI HESAPLANMAZ — hüküm
// muhasebecinin (sahte sayı yasağıyla birebir uyumlu).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Liste, Tablo } from './parcalar';

const sayi = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const AYLAR = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const tarihKisa = (iso) => {
  const s = String(iso || '').slice(0, 10);
  if (s.length < 10) return '—';
  return `${Number(s.slice(8, 10))} ${AYLAR[Number(s.slice(5, 7)) - 1] || ''}`;
};
const buAyISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const kisalt = (s, n = 90) => {
  const t = String(s || '').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
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

export default function BelgeModulu({ gorunum, onCekmece, onKopru }) {
  const [merkez, setMerkez] = useState(null);
  const [merkezHata, setMerkezHata] = useState('');
  const [istek, setIstek] = useState(null);
  const [istekHata, setIstekHata] = useState('');
  const [bant, setBant] = useState(null);
  const [bantHata, setBantHata] = useState('');
  const [cariSecim, setCariSecim] = useState('');
  const [cari, setCari] = useState(null);
  const [cariHata, setCariHata] = useState('');
  const [arama, setArama] = useState('');
  const [aramaSonuc, setAramaSonuc] = useState(null);
  const [araniyor, setAraniyor] = useState(false);

  const merkezYukle = useCallback(() => {
    setMerkezHata('');
    api(`/fatura/belge-merkezi?ay=${buAyISO()}`)
      .then((d) => setMerkez(d || {}))
      .catch((e) => setMerkezHata(e?.message || ''));
  }, []);

  const istekYukle = useCallback(() => {
    setIstekHata('');
    api('/fatura-istek/liste')
      .then((d) => setIstek(d || {}))
      .catch((e) => setIstekHata(e?.message || ''));
  }, []);

  const bantYukle = useCallback(() => {
    setBantHata('');
    api('/fatura/fiyat-bandi')
      .then((d) => setBant(d || {}))
      .catch((e) => setBantHata(e?.message || ''));
  }, []);

  const cariYukle = useCallback((tedarikci) => {
    if (!tedarikci) return;
    setCariHata('');
    setCari(null);
    api(`/fatura/cari-ekstre?tedarikci=${encodeURIComponent(tedarikci)}`)
      .then((d) => setCari(d || {}))
      .catch((e) => setCariHata(e?.message || ''));
  }, []);

  useEffect(() => {
    if (['kapsama', 'arsiv', 'uyarilar', 'kdv', 'cari'].includes(gorunum) && !merkez) merkezYukle();
    if (gorunum === 'istek') istekYukle();
    if (gorunum === 'fiyat') bantYukle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gorunum]);

  const toptancilar = useMemo(() => (Array.isArray(merkez?.toptancilar) ? merkez.toptancilar : []), [merkez]);

  // Cari görünümüne ilk girişte en büyük toptancıyı seç
  useEffect(() => {
    if (gorunum === 'cari' && !cariSecim && toptancilar.length) {
      const ilk = toptancilar[0].toptanci;
      setCariSecim(ilk);
      cariYukle(ilk);
    }
  }, [gorunum, cariSecim, toptancilar, cariYukle]);

  // ════════════════════════ GÖRÜNÜM: BELGE KAPSAMA ══════════════════════════
  if (gorunum === 'kapsama') {
    if (merkezHata) return <HataBandi mesaj={merkezHata} onTekrar={merkezYukle} />;
    if (!merkez) return <Yukleniyor />;
    const k = merkez.kapsama || {};
    const oran = sayi(k.oran_yuzde);
    const faturali = sayi(k.faturali_eslesen) + sayi(k.kurumsal_otomatik);
    const faturasiz = sayi(k.faturasiz);
    const fh = Array.isArray(merkez.faturasiz_harcamalar) ? merkez.faturasiz_harcamalar : [];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Belge kapsama', deger: `%${Math.round(oran)}`, alt: 'işletme kart harcamasının faturalısı', renk: oran >= 70 ? R.yesil : oran >= 50 ? R.amber : R.kirmizi },
          { etiket: 'Faturalı', deger: fmt(faturali), alt: 'eşleşen + kurumsal otomatik', renk: R.yesil },
          { etiket: 'Faturasız', deger: fmt(faturasiz), alt: 'belge isteme adayı', renk: faturasiz > 0 ? R.kirmizi : R.yesil },
          { etiket: 'Kart harcaması', deger: fmt(sayi(k.isletme_kart_harcamasi)), alt: `${merkez.ay || buAyISO()} · işletme` },
        ]} />

        {/* Kapsama barı — blueprint'in yeşil/kırmızı oran şeridi */}
        <div style={{ ...kartYuzey, padding: '18px 20px', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
            <span style={{ fontFamily: F.baslik, fontSize: 15.5, fontWeight: 600 }}>
              Belge kapsama — {merkez.ay || buAyISO()} kart harcamaları
            </span>
            <span style={{ fontSize: 11.5, color: R.not2 }}>faturasız kısım = KDV indirimi + gider kanıtı kaybı riski</span>
          </div>
          <div style={{ display: 'flex', height: 16, borderRadius: 99, overflow: 'hidden', background: R.cizgi2 }}>
            <span style={{ width: `${Math.max(2, Math.min(98, oran))}%`, background: `linear-gradient(90deg, ${R.yesil}, #22C55E)` }} />
            <span style={{ flex: 1, background: `linear-gradient(90deg, ${R.kirmizi}, #EF4444)` }} />
          </div>
          <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginTop: 10, fontSize: 12.5 }}>
            <span style={{ color: R.yesil }}>Faturalı <b style={{ fontFamily: F.mono, whiteSpace: 'nowrap' }}>{fmt(faturali)}</b> · %{Math.round(oran)}</span>
            <span style={{ color: R.kirmizi }}>Faturasız <b style={{ fontFamily: F.mono, whiteSpace: 'nowrap' }}>{fmt(faturasiz)}</b></span>
            <span style={{ color: R.not2, marginLeft: 'auto' }}>hedef %85</span>
          </div>
        </div>

        {fh.length === 0 ? (
          <BosDurum metin="Faturasız işletme harcaması yok — kapsama tam." />
        ) : (
          <Liste
            satirlar={fh.slice(0, 12).map((h, i) => ({
              id: `fh-${i}`,
              baslik: kisalt(h.aciklama || 'Kart harcaması', 70),
              alt: `${tarihKisa(h.tarih)} · ${kisalt(h.kart, 34)}${h.tip ? ` · ${h.tip}` : ''}`,
              tutar: fmt(sayi(h.tutar)),
              tier: sayi(h.tutar) >= 10000 ? 'kritik' : 'uyari',
              aksiyon: 'Belge Merkezi',
            }))}
            onAc={() => onKopru?.('belge-merkezi')}
          />
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: FATURA ARŞİVİ (FTS) ════════════════════
  if (gorunum === 'arsiv') {
    if (merkezHata) return <HataBandi mesaj={merkezHata} onTekrar={merkezYukle} />;
    if (!merkez) return <Yukleniyor />;
    const arsiv = Array.isArray(merkez.fatura_arsivi) ? merkez.fatura_arsivi : [];
    const gosterilen = aramaSonuc != null ? aramaSonuc : arsiv;
    const ara = async () => {
      const q = arama.trim();
      if (!q) { setAramaSonuc(null); return; }
      setAraniyor(true);
      try {
        const d = await api(`/fatura/ara?q=${encodeURIComponent(q)}`);
        const rows = Array.isArray(d) ? d : (d?.sonuclar || d?.satirlar || []);
        setAramaSonuc(rows);
      } catch { setAramaSonuc([]); }
      setAraniyor(false);
    };
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bu ay belge', deger: String(arsiv.length), alt: merkez.ay || buAyISO() },
          { etiket: 'Toptancı', deger: String(toptancilar.length), alt: 'arşivde temsil edilen' },
          { etiket: 'Arşiv toplamı', deger: fmt(toptancilar.reduce((t, x) => t + sayi(x.toplam), 0)), alt: 'toptancı faturaları' },
          { etiket: 'Arama', deger: 'FTS', alt: 'belge metninde tam arama' },
        ]} />
        {/* FTS arama — blueprint'in arama kutusu, /fatura/ara gerçek ucu */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14,
          padding: '6px 6px 6px 16px', borderRadius: 14, background: R.girinti, border: `1px solid ${R.cizgi}`,
        }}>
          <input
            value={arama}
            onChange={(e) => setArama(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ara()}
            placeholder="Belge metninde ara — toptancı, kalem, tutar, belge no… (FTS)"
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              color: R.krem, fontSize: 13, fontFamily: 'inherit', padding: '9px 0',
            }}
          />
          {aramaSonuc != null && (
            <button onClick={() => { setArama(''); setAramaSonuc(null); }} style={{
              padding: '7px 12px', borderRadius: 9, border: `1px solid ${R.cizgi3}`,
              background: 'transparent', color: R.not, fontSize: 11.5, fontFamily: 'inherit', cursor: 'pointer',
            }}>
              temizle
            </button>
          )}
          <button onClick={ara} disabled={araniyor} style={{
            padding: '8px 15px', borderRadius: 9, border: 'none',
            background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
            fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', opacity: araniyor ? 0.6 : 1,
          }}>
            {araniyor ? '…' : 'Ara'}
          </button>
        </div>
        {gosterilen.length === 0 ? (
          <BosDurum metin={aramaSonuc != null ? 'Arama sonucu yok.' : 'Bu ay arşivlenmiş fatura yok.'} />
        ) : (
          <Tablo
            baslik={aramaSonuc != null ? `Arama sonucu · ${gosterilen.length} belge` : `Fatura arşivi · ${merkez.ay || buAyISO()}`}
            not="satıra tıkla → belge görüntüle"
            kolonlar={[
              { ad: 'Tarih' }, { ad: 'Toptancı' }, { ad: 'Durum' }, { ad: 'Tutar', sag: 1 },
            ]}
            satirlar={gosterilen.slice(0, 40).map((b, i) => ({
              id: b.id || `b-${i}`,
              _b: b,
              hucreler: [
                { v: tarihKisa(b.tarih), mono: true, renk: R.not },
                { v: kisalt(b.tedarikci_ad || b.toptanci || '—', 42), kalin: true },
                /tamam/i.test(String(b.durum || ''))
                  ? { v: 'işlendi', rozet: R.yesil }
                  : /hata/i.test(String(b.durum || ''))
                    ? { v: b.durum, rozet: R.kirmizi }
                    : { v: b.durum || '—', rozet: R.amber },
                { v: fmt(sayi(b.tutar)), mono: true, sag: true, kalin: true },
              ],
            }))}
            onSatir={({ _b }) => {
              if (_b.goruntule) window.open(_b.goruntule, '_blank');
              else onKopru?.('belge-merkezi');
            }}
          />
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: FATURA İSTEK ═══════════════════════════
  if (gorunum === 'istek') {
    if (istekHata) return <HataBandi mesaj={istekHata} onTekrar={istekYukle} />;
    if (!istek) return <Yukleniyor />;
    const gruplar = Array.isArray(istek.gruplar) ? istek.gruplar : [];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bekleyen istek', deger: String(sayi(istek.acik_adet)), alt: 'teslim alındı, belge yok', renk: sayi(istek.acik_adet) > 0 ? R.amber : R.yesil },
          { etiket: 'Toplam açık', deger: fmt(sayi(istek.acik_toplam)), alt: 'KDV kanıtı bekliyor', renk: sayi(istek.acik_toplam) > 0 ? R.kirmizi : R.krem },
          { etiket: 'KDV riski', deger: fmt(sayi(istek.kdv_riski)), alt: 'belgesiz kısımda tahmini' },
          { etiket: 'Oto-kapanış', deger: 'açık', alt: 'fatura gelince istek kapanır', renk: R.yesil },
        ]} />
        {gruplar.length === 0 ? (
          <BosDurum metin="Açık fatura isteği yok — teslim alınan her şeyin belgesi gelmiş." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
            {gruplar.slice(0, 10).map((g, i) => (
              <div key={i} style={{ ...kartYuzey, padding: '15px 18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 170 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700 }}>{g.tedarikci || '—'}</div>
                    <div style={{ fontSize: 11, color: R.not2, marginTop: 2 }}>
                      {sayi(g.adet)} istek · {g.tel ? 'telefon kayıtlı — wa.me tek dokunuş (cepten)' : 'telefon kayıtsız'}
                    </div>
                  </div>
                  <span style={{ fontFamily: F.mono, fontSize: 14, fontWeight: 700, color: R.kirmizi }}>
                    {fmt(sayi(g.toplam))}
                  </span>
                  {g.kurumsal && <span style={rozetHap(R.mavi)}>kurumsal</span>}
                </div>
                {(Array.isArray(g.istekler) ? g.istekler : []).slice(0, 3).map((x, j) => (
                  <div key={j} style={{
                    display: 'flex', gap: 10, fontSize: 12, color: R.metin2,
                    marginTop: 8, paddingTop: 8, borderTop: `1px solid ${R.cizgi2}`,
                  }}>
                    <span style={{ fontFamily: F.mono, color: R.not2 }}>{tarihKisa(x.tarih)}</span>
                    <span style={{ flex: 1 }}>{kisalt(x.aciklama || x.kaynak_tip, 64)}</span>
                    <span style={{ fontFamily: F.mono, fontWeight: 700 }}>{fmt(sayi(x.tutar))}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        <KopruButon birincil ad="Fatura istek yönetimi (Belge Merkezi)" onTikla={() => onKopru?.('belge-merkezi')} />
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: MÜKERRER & PARMAK İZİ ══════════════════
  if (gorunum === 'uyarilar') {
    if (merkezHata) return <HataBandi mesaj={merkezHata} onTekrar={merkezYukle} />;
    if (!merkez) return <Yukleniyor />;
    const kk = merkez.kdv_kanit || {};
    const supheli = kk.supheli || {};
    const inceleme = kk.inceleme || {};
    const islenemeyen = Array.isArray(merkez.islenemeyen_foto) ? merkez.islenemeyen_foto : [];
    const arsiv = Array.isArray(merkez.fatura_arsivi) ? merkez.fatura_arsivi : [];
    const hatali = arsiv.filter((b) => /hata/i.test(String(b.durum || '')));
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Şüpheli belge', deger: String(sayi(supheli.adet)), alt: 'GİB damgası / mükerrer şüphesi', renk: sayi(supheli.adet) > 0 ? R.kirmizi : R.yesil },
          { etiket: 'İnceleme kuyruğu', deger: String(sayi(inceleme.adet)), alt: `no/VKN eksik · ${fmt(sayi(inceleme.toplam))}`, renk: sayi(inceleme.adet) > 0 ? R.amber : R.yesil },
          { etiket: 'İşlenemeyen foto', deger: String(islenemeyen.length), alt: 'OCR okuyamadı', renk: islenemeyen.length > 0 ? R.amber : R.krem },
          { etiket: 'Mükerrer freni', deger: '4 katman', alt: 'aynı belge iki kanaldan giremez', renk: R.yesil },
        ]} />
        <div style={{
          ...kartYuzey, padding: '12px 18px', marginBottom: 14,
          fontSize: 12, color: R.not, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <span style={rozetHap(R.mavi)}>ℹ fren</span>
          Parmak izi (PDF hash) + belge no + tutar+gün + GİB damgası — dört katman girişte otomatik çalışır;
          bu ekran KALANLARI (inceleme + şüpheli) gösterir.
        </div>
        {hatali.length === 0 && islenemeyen.length === 0 && sayi(inceleme.adet) === 0 ? (
          <BosDurum metin="Uyarı kuyruğu temiz — mükerrer şüphesi veya işlenemeyen belge yok." />
        ) : (
          <>
            {hatali.length > 0 && (
              <Liste
                satirlar={hatali.slice(0, 8).map((b, i) => ({
                  id: b.id || `h-${i}`,
                  baslik: `${kisalt(b.tedarikci_ad, 44)} · işlenemedi`,
                  alt: `${tarihKisa(b.tarih)} · durum: ${b.durum}`,
                  tutar: fmt(sayi(b.tutar)),
                  tier: 'kritik',
                  aksiyon: 'İncele',
                }))}
                onAc={() => onKopru?.('belge-merkezi')}
              />
            )}
            {sayi(inceleme.adet) > 0 && (
              <div style={{ ...kartYuzey, padding: '15px 18px', marginBottom: 14, border: `1px solid ${R.amber}44` }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 5 }}>
                  İnceleme kuyruğu · {sayi(inceleme.adet)} belge · {fmt(sayi(inceleme.toplam))}
                </div>
                <div style={{ fontSize: 12, color: R.metin2, lineHeight: 1.55 }}>
                  Belge no veya VKN eksik — fatura onay ekranında tamamlanınca KDV kanıt paketine girer.
                </div>
              </div>
            )}
          </>
        )}
        <KopruButon ad="Belge Merkezi'ni aç" onTikla={() => onKopru?.('belge-merkezi')} />
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: CARİ EKSTRE ════════════════════════════
  if (gorunum === 'cari') {
    if (merkezHata) return <HataBandi mesaj={merkezHata} onTekrar={merkezYukle} />;
    if (!merkez) return <Yukleniyor />;
    const faturalar = Array.isArray(cari?.faturalar) ? cari.faturalar : [];
    return (
      <>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          {toptancilar.slice(0, 8).map((t) => {
            const aktif = cariSecim === t.toptanci;
            return (
              <div
                key={t.toptanci}
                onClick={() => { setCariSecim(t.toptanci); cariYukle(t.toptanci); }}
                style={{
                  padding: '6px 13px', borderRadius: 99, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                  background: aktif ? `${R.bakir}22` : R.girinti,
                  color: aktif ? R.bakir : R.not,
                  border: `1px solid ${aktif ? `${R.bakir}55` : R.cizgi3}`,
                }}
              >
                {kisalt(t.toptanci, 24)}
              </div>
            );
          })}
        </div>
        {cariHata ? <HataBandi mesaj={cariHata} onTekrar={() => cariYukle(cariSecim)} /> : !cari ? <Yukleniyor /> : (
          <>
            <KpiSeridi kpiler={[
              { etiket: 'Hesaplanan açık', deger: fmt(sayi(cari.hesaplanan_acik)), alt: 'fatura − ödeme izi + devir', renk: sayi(cari.hesaplanan_acik) > 0 ? R.kirmizi : R.yesil },
              { etiket: 'Tedarikçi beyanı', deger: cari.beyan_bakiye != null ? fmt(sayi(cari.beyan_bakiye)) : '—', alt: cari.beyan_bakiye != null ? 'iki göz kıyası' : 'beyan girilmemiş' },
              { etiket: 'Açılış devri', deger: fmt(sayi(cari.devir)), alt: kisalt(cari.devir_not, 30) || 'sistem öncesi beyan' },
              { etiket: '6 ay hacim', deger: fmt(sayi(cari.fatura_toplam_6ay)), alt: `${sayi(cari.fatura_adet)} fatura · ödeme izi ${fmt(sayi(cari.odeme_izi_toplam_6ay))}` },
            ]} />
            {faturalar.length === 0 ? (
              <BosDurum metin="Bu tedarikçi için arşivde fatura yok." />
            ) : (
              <Tablo
                baslik={`Cari ekstre — ${kisalt(cariSecim, 44)}`}
                not="satıra tıkla → belge görüntüle"
                kolonlar={[
                  { ad: 'Tarih' }, { ad: 'Belge no' }, { ad: 'Tutar', sag: 1 }, { ad: 'Bakiye (dahil)', sag: 1 },
                ]}
                satirlar={faturalar.slice(0, 30).map((f, i) => ({
                  id: f.id || `f-${i}`,
                  _f: f,
                  hucreler: [
                    { v: tarihKisa(f.tarih), mono: true, renk: R.not },
                    { v: f.fatura_no || '—', mono: true, renk: R.not },
                    { v: fmt(sayi(f.tutar)), mono: true, sag: true, kalin: true },
                    { v: f.bakiye_dahil != null ? fmt(sayi(f.bakiye_dahil)) : '—', mono: true, sag: true, renk: R.metin2 },
                  ],
                }))}
                onSatir={({ _f }) => {
                  if (_f.goruntule) window.open(_f.goruntule, '_blank');
                  else onKopru?.('belge-merkezi');
                }}
              />
            )}
          </>
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: FİYAT BANDI ════════════════════════════
  if (gorunum === 'fiyat') {
    if (bantHata) return <HataBandi mesaj={bantHata} onTekrar={bantYukle} />;
    if (!bant) return <Yukleniyor />;
    const disi = Array.isArray(bant.band_disi) ? bant.band_disi : [];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'İzlenen kalem', deger: String(sayi(bant.urun_adet)), alt: 'fatura fiyat geçmişi' },
          { etiket: 'Bant dışı', deger: String(sayi(bant.band_disi_adet)), alt: 'son alış aralık üstünde', renk: sayi(bant.band_disi_adet) > 0 ? R.kirmizi : R.yesil },
          { etiket: 'En sert sapma', deger: disi.length ? `${Math.round(Math.max(...disi.map((x) => (sayi(x.son_fiyat) / (sayi(x.medyan) || 1) - 1) * 100)))}%` : '—', alt: 'medyana göre', renk: R.kirmizi },
          { etiket: 'Kaynak', deger: 'onaylı fatura', alt: 'OCR değil — öneri-only' },
        ]} />
        {disi.length === 0 ? (
          <BosDurum metin="Bant dışı alış yok — son fiyatlar 90 günlük aralığın içinde." />
        ) : (
          <Tablo
            baslik="Fiyat bandı · son alış vs geçmiş aralık"
            not="zam yakalanınca burada belirir — 3 zam bu bantla yakalandı"
            kolonlar={[
              { ad: 'Kalem' }, { ad: 'Son tedarikçi' }, { ad: 'Bant', sag: 1 }, { ad: 'Son alış', sag: 1 }, { ad: 'Sapma', sag: 1 }, { ad: 'Durum' },
            ]}
            satirlar={disi.slice(0, 25).map((x, i) => {
              const sapma = sayi(x.medyan) > 0 ? Math.round((sayi(x.son_fiyat) / sayi(x.medyan) - 1) * 100) : null;
              return {
                id: x.kod || `x-${i}`,
                hucreler: [
                  { v: kisalt(x.ad, 40), kalin: true },
                  { v: kisalt(x.son_tedarikci || x.tedarikci || '—', 24), renk: R.not },
                  { v: Array.isArray(x.aralik) ? `${x.aralik[0]} – ${x.aralik[1]}` : '—', mono: true, sag: true, renk: R.not },
                  { v: String(sayi(x.son_fiyat)), mono: true, sag: true, kalin: true, renk: R.kirmizi },
                  { v: sapma != null ? `+%${sapma}` : '—', mono: true, sag: true, renk: R.kirmizi },
                  { v: 'bant dışı', rozet: R.kirmizi },
                ],
              };
            })}
          />
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: KDV KANIT PAKETİ ═══════════════════════
  if (gorunum === 'kdv') {
    if (merkezHata) return <HataBandi mesaj={merkezHata} onTekrar={merkezYukle} />;
    if (!merkez) return <Yukleniyor />;
    const kk = merkez.kdv_kanit || {};
    const uclu = [
      { ad: 'İndirime aday', v: kk.indirime_aday, renk: R.yesil, alt: 'fatura no + VKN/GİB damgası ✓ — pakete hazır' },
      { ad: 'İnceleme', v: kk.inceleme, renk: R.amber, alt: 'no/VKN eksik — tamamlanınca pakete girer' },
      { ad: 'Şüpheli', v: kk.supheli, renk: R.kirmizi, alt: 'mükerrer/GİB uyarılı — muhasebeye NOTLA gider' },
    ];
    return (
      <>
        <KpiSeridi kpiler={uclu.map((u) => ({
          etiket: u.ad, deger: `${sayi(u.v?.adet)} belge`, alt: fmt(sayi(u.v?.toplam)), renk: sayi(u.v?.adet) > 0 ? u.renk : R.krem,
        })).concat([{ etiket: 'Dönem', deger: kk.ay || merkez.ay || buAyISO(), alt: 'muhasebeye ay sonu' }])} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 12, marginBottom: 14 }}>
          {uclu.map((u) => (
            <div key={u.ad} style={{ ...kartYuzey, padding: '17px 19px', border: sayi(u.v?.adet) > 0 ? `1px solid ${u.renk}44` : kartYuzey.border }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>{u.ad}</span>
                <span style={rozetHap(sayi(u.v?.adet) > 0 ? u.renk : R.yesil)}>{sayi(u.v?.adet)}</span>
              </div>
              <div style={{ fontFamily: F.mono, fontSize: 19, fontWeight: 700, marginBottom: 7 }}>{fmt(sayi(u.v?.toplam))}</div>
              <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.5 }}>{u.alt}</div>
            </div>
          ))}
        </div>
        {/* Motorun kendi ilkesi — sahte sayı yasağının backend'deki kardeşi */}
        <div style={{
          ...kartYuzey, padding: '13px 18px', marginBottom: 14,
          fontSize: 12, color: R.not, lineHeight: 1.6,
        }}>
          <span style={rozetHap(R.mavi)}>ℹ ilke</span>{' '}
          KDV TUTARI HESAPLANMAZ — hüküm muhasebecinin. Bu ekran yalnız belge KANITININ
          sağlamlığını sınıflar; eksikler fatura onay ekranında no/VKN girilerek kapanır.
        </div>
        <KopruButon birincil ad="Belge Merkezi'nde KDV paketi" onTikla={() => onKopru?.('belge-merkezi')} />
      </>
    );
  }

  return <BosDurum metin="Bilinmeyen görünüm." />;
}
