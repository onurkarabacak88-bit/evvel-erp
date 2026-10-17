"""🧩 EVVEL YENİ · MODÜL LİSTESİ (2026-10-17) — sahip: "ileride özellik ekleyebilmek ya da kaldırabilmek; başka iş kollarına da".

Bütün Evvel Yeni modülleri BU listede. main.py tek satırla `modulleri_yukle(app)` çağırır.
  · Modül KAPATMAK  = satırda acik=False (ekrandaki menüden de kalkar — /api/evvel-yeni/moduller okur).
  · Modül EKLEMEK   = evvel_yeni_<kod>_api.py (router + gerekiyorsa çekirdeğe kayıt) + buraya bir satır
                      + src/pages/evvelyeni/moduller.jsx'e bir satır.
  · sektor: "genel" = her işletmede olur · "kahve" = kahveciliğe özgü (başka iş kolunda kapatılır).
            "ozel"  = yalnız BU işletmenin düzenine özgü (kart/abonelik alışkanlığı gibi) — genel çekirdekle bağı yok.
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
    {"kod": "urun", "ad": "Ürün kataloğu", "ikon": "📚", "sektor": "genel", "gerekir": [], "menu": False,
     "aciklama": "tek ürün kimliği + değişiklik izi; Depo / Toptancılar / Bar / Gider / Satış buradan okur (sayfası Tanımlar altında)"},
    {"kod": "kasa", "ad": "Kasa", "ikon": "💰", "sektor": "genel", "gerekir": [], "aciklama": "para nerede — tek para defteri"},
    {"kod": "tanim", "ad": "Tanımlar", "ikon": "⚙️", "sektor": "genel", "gerekir": ["kasa"], "aciklama": "şube, personel, banka, kart, toptancı"},
    {"kod": "gelir", "ad": "Gelir", "ikon": "📥", "sektor": "genel", "gerekir": ["kasa"], "aciklama": "şube şube, gün gün ciro"},
    {"kod": "kira", "ad": "Kiralar", "ikon": "🏠", "sektor": "genel", "gerekir": ["kasa"], "menu": False,
     "aciklama": "kira tanımı + takvim (sayfaları Ödeme altında)"},
    {"kod": "maas", "ad": "Personel", "ikon": "👥", "sektor": "genel", "gerekir": ["kasa"], "aciklama": "hak ediş, takvim, yoklama"},
    {"kod": "gider", "ad": "Gider", "ikon": "💸", "sektor": "genel", "gerekir": ["kasa", "gelir"], "aciklama": "şubenin kendi işletme yükü"},
    {"kod": "odeme", "ad": "Ödeme", "ikon": "🧾", "sektor": "genel", "gerekir": ["kasa"], "aciklama": "ödeme / gider girişi, patron harcamaları"},
    {"kod": "kredi", "ad": "Krediler", "ikon": "🏦", "sektor": "genel", "gerekir": ["kasa", "odeme"],
     "aciklama": "kredi tanımı + kredi takvimi (borç = taksit; ödeme Ödeme'den)"},
    {"kod": "kart", "ad": "Kartlar", "ikon": "💳", "sektor": "genel", "gerekir": ["kasa", "odeme"], "aciklama": "kullanılabilir limit, son ödeme"},
    {"kod": "toptanci", "ad": "Toptancılar", "ikon": "🚚", "sektor": "genel", "gerekir": ["kasa"], "aciklama": "borç = açılış + alım − ödeme"},
    {"kod": "depo", "ad": "Depo", "ikon": "📦", "sektor": "genel", "gerekir": ["gider"], "aciklama": "ürün nerede — tek hareket defteri"},
    {"kod": "kazanc", "ad": "Şube kazancı", "ikon": "📈", "sektor": "genel", "gerekir": ["gelir", "gider"], "aciklama": "gelir − şubenin gideri"},
    {"kod": "avans", "ad": "Avans talepleri", "ikon": "🤝", "sektor": "genel", "gerekir": ["maas"], "menu": False,
     "aciklama": "personelin QR sayfasından avans talepleri → havale / elden / ret (sayfası Personel altında)"},
    {"kod": "fis", "ad": "Anlık gider fiş kontrol", "ikon": "🧾", "sektor": "genel", "gerekir": ["kasa"], "menu": False,
     "aciklama": "panelden girilen giderlerin fişi geldi mi; gelmeyen girişi yapan personelle (sayfası Gider altında)"},
    {"kod": "mulk", "ad": "Kira hesabı", "ikon": "🏠", "sektor": "ozel", "gerekir": ["kasa"],
     "aciklama": "ev kiraları takvimi + işletmelerin Fatma'nın kira hesabına borcu (Kasım'dan)"},
    {"kod": "fatura", "ad": "Faturaları dağıt", "ikon": "🧾", "sektor": "ozel", "gerekir": ["odeme", "kart"], "menu": False,
     "aciklama": "kart ekstresindeki otomatik fatura ödemeleri → şube gideri (sayfası Ödeme altında)"},
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


# ─────────── ESKİ SİSTEM ENVANTERİ: "son 30 günde kullanıldı mı?" (yalnız OKUR) ───────────
# Sahip: eski Evvel özellikleri tek tek TAŞI / DÜZELT / ÇIKAR. Eski sistemde sayfa ziyaret kaydı yok →
# kullanım = tabloya son 30 günde yazılan kayıt sayısı + son kayıt tarihi. Ağır: 1 saat önbellek.
_TARIH_TERCIH = ("created_at", "olusturma", "olusturma_zamani", "kayit_zamani", "zaman", "olay_zaman", "ts", "tarih",
                 "updated_at", "guncelleme", "is_gunu", "gun")
_KULLANIM_ONBELLEK: dict = {}


@router.get("/eski-kullanim")
def eski_kullanim(tazele: bool = False):
    import time
    from database import db, savepoint
    if not tazele and _KULLANIM_ONBELLEK.get("t", 0) > time.time() - 3600:
        return _KULLANIM_ONBELLEK["v"]
    out = []
    with db() as (conn, cur):
        cur.execute("""SELECT c.table_name, c.column_name, c.data_type FROM information_schema.columns c
                       JOIN information_schema.tables t ON t.table_name=c.table_name AND t.table_schema=c.table_schema
                       WHERE c.table_schema='public' AND t.table_type='BASE TABLE'
                         AND c.data_type IN ('timestamp with time zone','timestamp without time zone','date')""")
        kolon: Dict[str, List[str]] = {}
        for r in cur.fetchall():
            r = dict(r)
            kolon.setdefault(r["table_name"], []).append(r["column_name"])
        cur.execute("""SELECT relname, n_live_tup, n_tup_ins, n_tup_upd, n_tup_del FROM pg_stat_user_tables WHERE schemaname='public'""")
        stat = {dict(r)["relname"]: dict(r) for r in cur.fetchall()}
        for tablo in sorted(stat):
            s = stat[tablo]
            kol = kolon.get(tablo, [])
            sec = next((k for k in _TARIH_TERCIH if k in kol), kol[0] if kol else None)
            satir = {"tablo": tablo, "satir": s["n_live_tup"], "ekleme": s["n_tup_ins"], "guncelleme": s["n_tup_upd"],
                     "tarih_kolonu": sec, "son30": None, "son_kayit": None}
            if sec:
                try:
                    with savepoint(cur, "sp_ey_envanter"):
                        cur.execute("SET LOCAL statement_timeout = '4s'")
                        cur.execute(f'SELECT count(*) FILTER (WHERE "{sec}" >= now() - interval \'30 days\' AND "{sec}" <= now() + interval \'1 day\') AS n, '
                                    f'max("{sec}") FILTER (WHERE "{sec}" <= now() + interval \'1 day\') AS son FROM "{tablo}"')
                        r = dict(cur.fetchone())
                        satir["son30"], satir["son_kayit"] = r["n"], (str(r["son"])[:16] if r["son"] else None)
                except Exception as e:  # noqa: BLE001
                    satir["hata"] = str(e)[:80]
            out.append(satir)
    v = {"tablolar": out, "not": "son30 = tarih kolonuna göre son 30 günde yazılan kayıt; tarih kolonu yoksa yalnız pg istatistiği"}
    _KULLANIM_ONBELLEK.update(t=time.time(), v=v)
    return v
