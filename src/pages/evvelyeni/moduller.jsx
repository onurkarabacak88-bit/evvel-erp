// 🧩 EVVEL YENİ · MODÜL LİSTESİ (ekran tarafı) — sahip: "ekle-çıkar; başka iş kollarına da".
// Sol menü ve sayfa yönlendirmesi YALNIZ bu listeden. Sunucu karşılığı: evvel_yeni_moduller.py (kod = mod).
//   Modül EKLEMEK  = buraya bir satır (+ sunucu listesine bir satır).
//   Modül KAPATMAK = sunucu listesinde acik=False → /api/evvel-yeni/moduller "yuklendi" demez → menüden kalkar.
// sektor: 'genel' her işletmede · 'kahve' kahveciliğe özgü · 'ozel' yalnız bu işletmenin düzeni. yetki: rol anahtarı (sonra).
// bolum: modülün sayfaları BAŞKA bir bölümün altında görünür (ör. Faturaları dağıt → Ödeme); modül kapanınca sayfa da kalkar.
import React from 'react';
import KasaModulu, { SAYFALAR, IS_GRUPLARI } from './KasaModulu';
import GelirModulu, { GELIR_SAYFALAR } from './GelirModulu';
import GiderModulu, { GIDER_SAYFALAR } from './GiderModulu';
import OdemeModulu, { ODEME_SAYFALAR, PatronHarcama } from './OdemeModulu';
import KazancModulu, { KAZANC_SAYFALAR } from './KazancModulu';
import TanimModulu, { TANIM_SAYFALAR } from './TanimModulu';
import BarModulu, { BAR_SAYFALAR } from './BarModulu';
import MaasModulu, { MAAS_SAYFALAR, PersonelTakvim, GunlukYoklama } from './MaasModulu';
import SatisModulu, { SATIS_SAYFALAR } from './SatisModulu';
import KartModulu, { KART_SAYFALAR, KartTakvim } from './KartModulu';
import KrediModulu, { KREDI_SAYFALAR } from './KrediModulu';
import { KiraTakvim } from './KiraModulu';
import ToptanciModulu, { TOPTANCI_SAYFALAR, UrunFiyatlari } from './ToptanciModulu';
import DepoModulu, { DEPO_SAYFALAR } from './DepoModulu';
import FaturaModulu, { FATURA_SAYFALAR } from './FaturaModulu';
import FisModulu, { FIS_SAYFALAR } from './FisModulu';
import AvansModulu, { AVANS_SAYFALAR } from './AvansModulu';
import MulkModulu, { MULK_SAYFALAR } from './MulkModulu';
import UrunModulu, { URUN_SAYFALAR } from './UrunModulu';
import YoklamaModulu, { YOKLAMA_SAYFALAR, YemekMolalari, Devirler } from './YoklamaModulu';

// g(sekme, c): c = { onToast, onSekme, onVeri } — kabuğun modüllere verdiği ortak bağlantılar
export const MODULLER = [
  { mod: 'kasa', ad: 'Kasa', ikon: '💰', sektor: 'genel', sayfalar: SAYFALAR,
    g: (s, c) => <KasaModulu gorunum={s} onSekme={c.onSekme} onToast={c.onToast} onVeri={c.onVeri} sekmesiz /> },
  // 📋 Bekleyen işler — kendi başlığı + konu alt sekmeleri (sahip 2026-10-17). Her zaman görünür (çekirdek görünüm).
  { mod: 'isler', her_zaman: true, ad: 'Bekleyen işler', ikon: '📋', sektor: 'genel', sayfalar: IS_GRUPLARI,
    g: (s, c) => <KasaModulu gorunum={s} onSekme={c.onSekme} onToast={c.onToast} onVeri={c.onVeri} sekmesiz /> },
  { mod: 'gelir', ad: 'Gelir', ikon: '📥', sektor: 'genel', sayfalar: GELIR_SAYFALAR, g: () => <GelirModulu /> },
  { mod: 'gider', ad: 'Gider', ikon: '💸', sektor: 'genel', sayfalar: GIDER_SAYFALAR, g: (s, c) => <GiderModulu onToast={c.onToast} /> },
  { mod: 'avans', bolum: 'maas', ad: 'Avans talepleri', ikon: '🤝', sektor: 'genel', sayfalar: AVANS_SAYFALAR, g: (s, c) => <AvansModulu onToast={c.onToast} /> },
  { mod: 'yoklama', bolum: 'maas', ad: 'Yoklama', ikon: '📱', sektor: 'genel', sayfalar: YOKLAMA_SAYFALAR,
    g: (s, c) => (s === 'personel_mola' ? <YemekMolalari onToast={c.onToast} /> : s === 'personel_devir' ? <Devirler onToast={c.onToast} /> : <YoklamaModulu onToast={c.onToast} />) },
  { mod: 'urun', bolum: 'tanim', ad: 'Ürünler', ikon: '📚', sektor: 'genel', sayfalar: URUN_SAYFALAR, g: (s, c) => <UrunModulu onToast={c.onToast} /> },
  { mod: 'fis', bolum: 'gider', ad: 'Anlık gider fiş kontrol', ikon: '🧾', sektor: 'genel', sayfalar: FIS_SAYFALAR, g: (s, c) => <FisModulu onToast={c.onToast} /> },
  { mod: 'odeme', ad: 'Ödeme', ikon: '🧾', sektor: 'genel', sayfalar: ODEME_SAYFALAR,
    g: (s, c) => (s === 'kira_takvimi' ? <KiraTakvim /> : s === 'patron_harcama' ? <PatronHarcama /> : <OdemeModulu key={s} gorunum={s} onToast={c.onToast} />) },
  { mod: 'fatura', bolum: 'odeme', ad: 'Faturaları dağıt', ikon: '🧾', sektor: 'ozel', sayfalar: FATURA_SAYFALAR, g: (s, c) => <FaturaModulu onToast={c.onToast} /> },
  { mod: 'kredi', ad: 'Krediler', ikon: '🏦', sektor: 'genel', sayfalar: KREDI_SAYFALAR, g: (s, c) => <KrediModulu onToast={c.onToast} onSekme={c.onSekme} /> },
  { mod: 'mulk', ad: 'Kira hesabı', ikon: '🏠', sektor: 'ozel', sayfalar: MULK_SAYFALAR, g: (s, c) => <MulkModulu gorunum={s} onToast={c.onToast} onSekme={c.onSekme} /> },
  { mod: 'kart', ad: 'Kartlar', ikon: '💳', sektor: 'genel', sayfalar: KART_SAYFALAR,
    g: (s, c) => (s === 'kart_takvimi' ? <KartTakvim onSekme={c.onSekme} /> : <KartModulu onToast={c.onToast} />) },
  { mod: 'toptanci', ad: 'Toptancılar', ikon: '🚚', sektor: 'genel', sayfalar: TOPTANCI_SAYFALAR,
    g: (s, c) => (s === 'urun_fiyatlari' ? <UrunFiyatlari onToast={c.onToast} /> : <ToptanciModulu onToast={c.onToast} />) },
  { mod: 'depo', ad: 'Depo', ikon: '📦', sektor: 'genel', sayfalar: DEPO_SAYFALAR, g: (s, c) => <DepoModulu gorunum={s} onToast={c.onToast} /> },
  { mod: 'kazanc', ad: 'Şube kazancı', ikon: '📈', sektor: 'genel', sayfalar: KAZANC_SAYFALAR, g: () => <KazancModulu /> },
  { mod: 'bar', ad: 'Bar', ikon: '🥤', sektor: 'kahve', sayfalar: BAR_SAYFALAR, g: () => <BarModulu /> },
  { mod: 'satis', ad: 'Satış kontrolü', ikon: '🔍', sektor: 'kahve', sayfalar: SATIS_SAYFALAR, g: (s) => <SatisModulu gorunum={s} /> },
  { mod: 'maas', ad: 'Personel', ikon: '👥', sektor: 'genel', sayfalar: MAAS_SAYFALAR,
    g: (s, c) => (s === 'personel_yoklama' ? <GunlukYoklama /> : s === 'personel_takvim' ? <PersonelTakvim onToast={c.onToast} />
      : <MaasModulu onToast={c.onToast} onSekme={c.onSekme} />) },
  { mod: 'tanim', ad: 'Tanımlar', ikon: '⚙️', sektor: 'genel', sayfalar: TANIM_SAYFALAR, g: (s, c) => <TanimModulu gorunum={s} onToast={c.onToast} /> },
];

export const TUM_SAYFALAR = MODULLER.flatMap((b) => b.sayfalar.map((x) => ({ ...x, mod: b.mod })));
