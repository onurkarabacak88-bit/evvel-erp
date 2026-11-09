// 🏠 KİRA DAĞILIMI — fazla gelen kira nereye sayılsın? (sahip 10 Kas: "sorsun ama geçmiş borcuna mı sayılsın, yoksa bu ay için mi" ·
// Fable L4b: iki düğme, artan hep sonraki aya — "bu ayda fazla kalsın" yok). Para girişi formu ve Kira › Uyarılar AYNI parçayı kullanır.
// Sunucu doğrular: evvel_yeni_mulk_api._dagilim_dogrula (Σ = tutar · en çok 4 ay · ±12 ay · ev o ay kirada).
import React from 'react';
import { Dugme, R } from './KasaModulu';

const AY = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
export const ayAdKisa = (a) => (a ? `${AY[Number(a.slice(5, 7)) - 1]} ${a.slice(0, 4)}` : '');
const sonrakiAy = (a) => { const y = Number(a.slice(0, 4)); const m = Number(a.slice(5, 7)); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
const kurus = (t) => Math.round(Number(t || 0) * 100);
export const EN_COK_AY = 4;

// ay = seçilen ay · toplam = girilen tutar (₺) · acik = [{ay, kalan}] (seçilen ay dahil) · yon = 'gecmis' | 'gelecek'
// → [{ay, tutar}] (₺, kuruş hassasiyetinde). Önce (gecmis'te) eski açık aylar, sonra seçilen ay, artan sonraki aylara.
export function kiraDagit(ay, toplam, acik, yon) {
  const kal = Object.fromEntries((acik || []).map((a) => [a.ay, kurus(a.kalan)]));
  let artan = kurus(toplam);
  const out = [];
  const ver = (a, k) => { if (k > 0) { out.push({ ay: a, tutar: k / 100 }); artan -= k; } };
  if (yon === 'gecmis') (acik || []).filter((a) => a.ay < ay).sort((x, y) => (x.ay < y.ay ? -1 : 1)).forEach((a) => ver(a.ay, Math.min(artan, kal[a.ay])));
  ver(ay, Math.min(artan, kal[ay] || 0));
  let m = ay;
  for (let i = 0; artan > 0 && i < 12; i += 1) { m = sonrakiAy(m); ver(m, kal[m] != null ? Math.min(artan, kal[m]) : artan); }
  return out;
}

// Seçilen ayın kalanını aşan girişte gösterilir. secim: null | 'gecmis' | 'gelecek'.
export function FazlaSoru({ ay, toplam, acik, secim, onSecim }) {
  const kalanSec = (acik || []).find((a) => a.ay === ay)?.kalan || 0;
  const fazla = Math.round((toplam - kalanSec) * 100) / 100;
  const gecmisVar = (acik || []).some((a) => a.ay < ay && a.kalan > 0);
  const dag = secim ? kiraDagit(ay, toplam, acik, secim) : [];
  return (
    <div style={{ border: `1px solid ${R.amber}`, borderRadius: 10, padding: 10, display: 'grid', gap: 8, fontSize: 13.5 }}>
      <div>⚠️ {ayAdKisa(ay)} için <b>{kalanSec.toLocaleString('tr-TR')}</b> ₺ bekleniyordu, <b>{Number(toplam).toLocaleString('tr-TR')}</b> ₺ geldi. <b>Fazla {fazla.toLocaleString('tr-TR')} ₺ nereye sayılsın?</b></div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {gecmisVar && <Dugme kucuk ana={secim === 'gecmis'} onClick={() => onSecim('gecmis')}>Geçmiş borca say</Dugme>}
        <Dugme kucuk ana={secim === 'gelecek'} onClick={() => onSecim('gelecek')}>Gelecek aya say</Dugme>
      </div>
      {dag.length > 0 && (
        <div style={{ color: R.metin2 }}>
          {dag.map((d) => <span key={d.ay} style={{ marginRight: 12 }}>{ayAdKisa(d.ay)} <b>{d.tutar.toLocaleString('tr-TR')}</b> ₺</span>)}
          {dag.length > EN_COK_AY && <div style={{ color: R.kirmizi }}>En çok {EN_COK_AY} aya dağıtılır — tutarı kontrol et</div>}
        </div>
      )}
    </div>
  );
}
