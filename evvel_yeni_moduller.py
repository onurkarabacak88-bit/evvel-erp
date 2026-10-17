"""🧩 EVVEL YENİ · MODÜL LİSTESİ (2026-10-17) — sahip: "ileride özellik ekleyebilmek ya da kaldırabilmek; başka iş kollarına da".

Bütün Evvel Yeni modülleri BU listede. main.py tek satırla `modulleri_yukle(app)` çağırır.
  · Modül KAPATMAK  = satırda acik=False (ekrandaki menüden de kalkar — /api/evvel-yeni/moduller okur).
  · Modül EKLEMEK   = evvel_yeni_<kod>_api.py (router + gerekiyorsa çekirdeğe kayıt) + buraya bir satır
                      + src/pages/evvelyeni/moduller.jsx'e bir satır.
  · sektor: "genel" = her işletmede olur · "kahve" = kahveciliğe özgü (başka iş kolunda kapatılır).
  · yetki : yetkilendirmede kullanılacak anahtar (rol → modül; şimdilik yalnız etiket — giriş kapısı EN SONA, sahip kararı).
  · gerekir: çalışmak için açık olması gereken modüller; biri kapalıysa bu modül de yüklenmez (kırık yarım modül olmasın).
Her modül ayrı try içinde yüklenir: biri bozulursa diğerleri ve eski Evvel çalışmaya devam eder.
"""

import importlib
import logging
from typing import Dict, List

from fastapi import APIRouter

log = logging.getLogger(__name__)

MODULLER: List[dict] = [
    # kod          ad                 ikon  sektor    gerekir                 açıklama
    {"kod": "olay", "ad": "Şube olay defteri", "ikon": "📒", "sektor": "genel", "gerekir": [], "dosya": "evvel_yeni_olay",
     "kurulum": "olay_tablosu_kur", "menu": False, "aciklama": "panel kayıtlarının Evvel Yeni kopyası"},
    {"kod": "kasa", "ad": "Kasa", "ikon": "💰", "sektor": "genel", "gerekir": [], "aciklama": "para nerede — tek para defteri"},
    {"kod": "tanim", "ad": "Tanımlar", "ikon": "⚙️", "sektor": "genel", "gerekir": ["kasa"], "aciklama": "şube, personel, banka, kart, toptancı"},
    {"kod": "gelir", "ad": "Gelir", "ikon": "📥", "sektor": "genel", "gerekir": ["kasa"], "aciklama": "şube şube, gün gün ciro"},
    {"kod": "kira", "ad": "Kiralar", "ikon": "🏠", "sektor": "genel", "gerekir": ["kasa"], "menu": False,
     "aciklama": "kira tanımı + takvim (sayfaları Ödeme altında)"},
    {"kod": "maas", "ad": "Personel", "ikon": "👥", "sektor": "genel", "gerekir": ["kasa"], "aciklama": "hak ediş, takvim, yoklama"},
    {"kod": "gider", "ad": "Gider", "ikon": "💸", "sektor": "genel", "gerekir": ["kasa", "gelir"], "aciklama": "şubenin kendi işletme yükü"},
    {"kod": "odeme", "ad": "Ödeme", "ikon": "🧾", "sektor": "genel", "gerekir": ["kasa"], "aciklama": "ödeme / gider girişi, patron harcamaları"},
    {"kod": "kart", "ad": "Kartlar", "ikon": "💳", "sektor": "genel", "gerekir": ["kasa"], "aciklama": "kullanılabilir limit, son ödeme"},
    {"kod": "toptanci", "ad": "Toptancılar", "ikon": "🚚", "sektor": "genel", "gerekir": ["kasa"], "aciklama": "borç = açılış + alım − ödeme"},
    {"kod": "depo", "ad": "Depo", "ikon": "📦", "sektor": "genel", "gerekir": ["gider"], "aciklama": "ürün nerede — tek hareket defteri"},
    {"kod": "kazanc", "ad": "Şube kazancı", "ikon": "📈", "sektor": "genel", "gerekir": ["gelir", "gider"], "aciklama": "gelir − şubenin gideri"},
    {"kod": "bar", "ad": "Bar", "ikon": "🥤", "sektor": "kahve", "gerekir": ["kasa"], "aciklama": "bardak + bar ürün sayımı"},
    {"kod": "satis", "ad": "Satış kontrolü", "ikon": "🔍", "sektor": "kahve", "gerekir": ["kasa", "bar"],
     "aciklama": "bardak × bardak başına ciro ↔ gerçek ciro"},
]
for _m in MODULLER:
    _m.setdefault("acik", True)
    _m.setdefault("menu", True)
    _m.setdefault("yetki", _m["kod"])
    _m.setdefault("dosya", f"evvel_yeni_{_m['kod']}_api")

DURUM: Dict[str, str] = {}   # kod → yuklendi | kapali | eksik:<kod> | hata:<mesaj>


def modulleri_yukle(app) -> None:
    """Listeyi sırayla yükler. Sıra önemli: bir modül, gerektirdiği modüllerden SONRA gelir."""
    for m in MODULLER:
        kod = m["kod"]
        if not m["acik"]:
            DURUM[kod] = "kapali"
            continue
        eksik = [g for g in m["gerekir"] if DURUM.get(g) != "yuklendi"]
        if eksik:
            DURUM[kod] = "eksik:" + ",".join(eksik)
            log.warning("evvel_yeni %s yüklenmedi — gerektirdiği modül kapalı/bozuk: %s", kod, eksik)
            continue
        try:
            mod = importlib.import_module(m["dosya"])
            if m.get("kurulum"):
                getattr(mod, m["kurulum"])()
            app.include_router(mod.router)
            DURUM[kod] = "yuklendi"
        except Exception as e:  # noqa: BLE001 — izole: ana akış etkilenmez
            DURUM[kod] = "hata:" + str(e)[:200]
            log.warning("evvel_yeni %s modülü yüklenemedi (izole, ana akış etkilenmez): %s", kod, e)
    app.include_router(router)


router = APIRouter(prefix="/api/evvel-yeni/moduller", tags=["evvel-yeni-moduller"])


@router.get("")
def moduller():
    """Ekran menüsü bunu okur: yalnız yüklenen modüller gösterilir."""
    return {"moduller": [{k: m[k] for k in ("kod", "ad", "ikon", "sektor", "yetki", "gerekir", "menu", "aciklama")}
                         | {"durum": DURUM.get(m["kod"], "bilinmiyor")} for m in MODULLER]}
