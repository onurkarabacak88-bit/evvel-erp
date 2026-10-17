// 🧩 EVVEL YENİ · MODÜL LİSTESİ (ekran tarafı) — sahip: "ekle-çıkar; başka iş kollarına da".
// Sol menü ve sayfa yönlendirmesi YALNIZ bu listeden. Sunucu karşılığı: evvel_yeni_moduller.py (kod = mod).
//   Modül EKLEMEK  = buraya bir satır (+ sunucu listesine bir satır).
//   Modül KAPATMAK = sunucu listesinde acik=False → /api/evvel-yeni/moduller "yuklendi" demez → menüden kalkar.
// sektor: 'genel' her işletmede · 'kahve' kahveciliğe özgü · 'ozel' yalnız bu işletmenin düzeni. yetki: rol anahtarı (sonra).
// bolum: modülün sayfaları BAŞKA bir bölümün altında görünür (ör. Faturaları dağıt → Ödeme); modül kapanınca sayfa da kalkar.
import React from 'react';
import KasaModulu, { SAYFALAR } from './KasaModulu';
import GelirModulu, { GELIR_SAYFALAR } from './GelirModulu';
import GiderModulu, { GIDER_SAYFALAR } from './GiderModulu';
import OdemeModulu, { ODEME_SAYFALAR, PatronHarcama } from './OdemeModulu';
import KazancModulu, { KAZANC_SAYFALAR } from './KazancModulu';
import TanimModulu, { TANIM_SAYFALAR } from './TanimModulu';
import BarModulu, { BAR_SAYFALAR } from './BarModulu';
import MaasModulu, { MAAS_SAYFALAR, PersonelTakvim, GunlukYoklama } from './MaasModulu';
import SatisModulu, { SATIS_SAYFALAR } from './SatisModulu';
import KartModulu, { KART_SAYFALAR } from './KartModulu';
import { KiraTakvim } from './KiraModulu';
import ToptanciModulu, { TOPTANCI_SAYFALAR, UrunFiyatlari } from './ToptanciModulu';
import DepoModulu, { DEPO_SAYFALAR } from './DepoModulu';
import FaturaModulu, { FATURA_SAYFALAR } from './FaturaModulu';
import FisModulu, { FIS_SAYFALAR } from './FisModulu';

// g(sekme, c): c = { onToast, onSekme, onVeri } — kabuğun modüllere verdiği ortak bağlantılar
export const MODULLER = [
  { mod: 'kasa', ad: 'Kasa', ikon: '💰', sektor: 'genel', sayfalar: SAYFALAR,
    g: (s, c) => <KasaModulu gorunum={s} onSekme={c.onSekme} onToast={c.onToast} onVeri={c.onVeri} sekmesiz /> },
  { mod: 'gelir', ad: 'Gelir', ikon: '📥', sektor: 'genel', sayfalar: GELIR_SAYFALAR, g: () => <GelirModulu /> },
  { mod: 'gider', ad: 'Gider', ikon: '💸', sektor: 'genel', sayfalar: GIDER_SAYFALAR, g: (s, c) => <GiderModulu onToast={c.onToast} /> },
  { mod: 'fis', bolum: 'gider', ad: 'Anlık gider fiş kontrol', ikon: '🧾', sektor: 'genel', sayfalar: FIS_SAYFALAR, g: (s, c) => <FisModulu onToast={c.onToast} /> },
  { mod: 'odeme', ad: 'Ödeme', ikon: '🧾', sektor: 'genel', sayfalar: ODEME_SAYFALAR,
    g: (s, c) => (s === 'kira_takvimi' ? <KiraTakvim /> : s === 'patron_harcama' ? <PatronHarcama /> : <OdemeModulu onToast={c.onToast} />) },
  { mod: 'fatura', bolum: 'odeme', ad: 'Faturaları dağıt', ikon: '🧾', sektor: 'ozel', sayfalar: FATURA_SAYFALAR, g: (s, c) => <FaturaModulu onToast={c.onToast} /> },
  { mod: 'kart', ad: 'Kartlar', ikon: '💳', sektor: 'genel', sayfalar: KART_SAYFALAR, g: (s, c) => <KartModulu onToast={c.onToast} /> },
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
