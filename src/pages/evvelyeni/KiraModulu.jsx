// ─────────────────────────────────────────────────────────────────────────────
// 🏠 EVVEL YENİ · KİRA TAKVİMİ — şube × 12 ay
//
// Sahip (2026-10-16): "Ay ay ödenen kiraların listesi yıllıkta ay ay tutulsun — takvim mantığı!" ·
// "Kira artış periyotları takvimde ayı farklı renk olsun."
// Rakamlar /api/evvel-yeni/kira/takvim'den; ekran yalnız dizer.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, num, fmt, tKisa } from './KasaModulu';
import { AY_UZUN, AyIzgara, DURUM, Lejant, Pencere, YilSecici } from './AyTakvim';   // ortak takvim (Dalga 5, T4-08 — kopya kalktı)

const MOR = '#7B4FB8';   // kira artış ayı

export function KiraTakvim() {
  const [yil, setYil] = useState(() => new Date().getFullYear());
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [sec, setSec] = useState(null);   // {s, a, i}
  const no = useRef(0);
  useEffect(() => {
    const n = ++no.current;
    setV(null);
    api(`/evvel-yeni/kira/takvim?yil=${yil}`).then((r) => { if (n === no.current) { setV(r); setHata(null); } })
      .catch((e) => { if (n === no.current) setHata(e?.message || 'okunamadı'); });
  }, [yil]);

  const satirlar = (v?.subeler || []).map((s) => ({
    id: s.sube_id, kaynak: s, baslik: s.ad,
    alt: `${s.kira_yok ? 'mülk bizim — kira yok' : s.kira != null ? `${fmt(s.kira)} ₺/ay` : 'kira tanımsız'}${s.odeme_gunu ? ` · ${s.odeme_gunu}'i` : ''}${s.artis_ayi ? ` · artış ${AY_UZUN[s.artis_ayi - 1]}` : ''}`,
    aylar: s.aylar.map((a) => ({
      ...a, ust: a.odenen > 0 ? fmt(a.odenen) : a.beklenen != null ? fmt(a.beklenen) : '—',
      alt: a.durum === 'kismi' ? `kalan ${fmt(a.kalan)}` : null,
      vurgu: (a.artis_ayi || a.artis) ? MOR : null, etiket: (a.artis_ayi || a.artis) ? `📈${a.artis ? ' artış' : ''}` : null,
    })),
    sag: fmt(s.yil_odenen), sagAlt: `/ ${fmt(s.yil_beklenen)}`,
  }));
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
        <div><div className="pi-eyebrow">Evvel Yeni · Ödeme</div><h1 style={{ fontSize: 30 }}>Kira takvimi</h1></div>
        <YilSecici yil={yil} setYil={setYil} />
      </div>
      <Lejant ek={[{ ad: '📈 kira artış ayı', renk: MOR }]} />
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {!v && !hata && <div style={{ color: R.not }}>Takvim hazırlanıyor…</div>}
      {v && <AyIzgara satirlar={satirlar} ilkBaslik="Şube" onHucre={(s, a, i) => setSec({ s: s.kaynak, a, i })} />}
      {sec && (
        <Pencere baslik={`🏠 ${sec.s.ad} · ${AY_UZUN[sec.i]} ${v.yil}`} onKapat={() => setSec(null)}>
          {(sec.a.artis_ayi || sec.a.artis) && <div style={{ color: MOR, fontWeight: 700 }}>📈 {sec.a.artis ? `Kira bu ay arttı: ${fmt(sec.a.onceki_tutar)} → ${fmt(sec.a.beklenen)} ₺` : 'Kira artış ayı — yeni tutarı Tanımlar → Şubeler\'den gir'}</div>}
          <div>Beklenen <b style={num}>{sec.a.beklenen != null ? fmt(sec.a.beklenen) : '—'}</b> ₺ · ödenen <b style={num}>{fmt(sec.a.odenen)}</b> ₺ · kalan <b style={num}>{fmt(sec.a.kalan)}</b> ₺</div>
          <div style={{ color: R.not, fontSize: 13 }}>Son ödeme günü {tKisa(sec.a.vade)} · durum: {(DURUM[sec.a.durum] || DURUM.gelecek).ad}</div>
          {sec.a.yeni_kayitlar.map((k) => <div key={k.id} style={{ fontSize: 13 }}>• {tKisa(k.tarih)} · {fmt(k.tutar)} ₺ · {k.aciklama}</div>)}
          {sec.a.eski_sistem > 0 && <div style={{ fontSize: 13 }}>• eski sistemde ödenmiş: {fmt(sec.a.eski_sistem)} ₺</div>}
          {sec.a.iki_yerde && <div style={{ fontSize: 12.5, color: R.amber }}>⚠ Hem eski sistemde hem Evvel Yeni'de ödeme var — biri mükerrer olabilir (toplanmadı; Kart/Kredi ile aynı kural).</div>}
          {sec.a.kalan > 0 && <div style={{ fontSize: 12.5, color: R.not }}>Ödemek için: Ödeme → Ödeme / gider gir → Kira → şube ve "ait olduğu ay" seç; tutar kendiliğinden gelir.</div>}
        </Pencere>
      )}
    </div>
  );
}
