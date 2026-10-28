"""🧩 EVVEL YENİ · MODÜL LİSTESİ (2026-10-17) — sahip: "ileride özellik ekleyebilmek ya da kaldırabilmek; başka iş kollarına da".

Bütün Evvel Yeni modülleri BU listede. main.py tek satırla `modulleri_yukle(app)` çağırır.
  · Modül KAPATMAK  = satırda acik=False (ekrandaki menüden de kalkar — /api/evvel-yeni/moduller okur).
  · Modül EKLEMEK   = evvel_yeni_<kod>_api.py (router + gerekiyorsa çekirdeğe kayıt) + buraya bir satır
                      + src/pages/evvelyeni/moduller.jsx'e bir satır.
  · sektor: "genel" = her işletmede olur · "kahve" = kahveciliğe özgü (başka iş kolunda kapatılır).
            "ozel"  = yalnız BU işletmenin düzenine özgü (kart/abonelik alışkanlığı gibi) — genel çekirdekle bağı yok.
  · yetki : yetkilendirmede kullanılacak anahtar (rol → modül; şimdilik yalnız etiket — giriş kapısı EN SONA, sahip kararı).
  · gerekir: çalışmak için açık olması gereken modüller; biri kapalıysa bu modül de yüklenmez (kırık yarım modül olmasın).
  · gorevler: modülün ARKA PLAN işleri [{"ad", "fn", "aralik_sn", "baslik"}] — çekirdeğin tek zamanlayıcısı koşturur, her koşu
              ey_gorev_kosu'ya yazılır (F3.1 B7/B11 · IS 5c, sim 26 Eki · Opus + Codex + Fable). Ekran OKUMASI artık yazmaz.
  · kesim  : 1 KASIM SON AKTARIM adımı {"fn", "sira", "baslik"} — modül eski dönemin çıktısını KENDİ arşiv anahtarına dondurur
              (KESIM_1KASIM_ENVANTERI ⚖️). Sistem durumu › "1 Kasım son aktarım": önce kuru dene, sonra çalıştır (adım adım).
Her modül ayrı try içinde yüklenir: biri bozulursa diğerleri ve eski Evvel çalışmaya devam eder.
"""

import importlib
import json
import logging
import threading
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional

from fastapi import APIRouter, Header

log = logging.getLogger(__name__)

MODULLER: List[dict] = [
    # kod          ad                 ikon  sektor    gerekir                 açıklama
    {"kod": "olay", "ad": "Şube olay defteri", "ikon": "📒", "sektor": "genel", "gerekir": [], "dosya": "evvel_yeni_olay",
     "kurulum": "olay_tablosu_kur", "menu": False, "aciklama": "panel kayıtlarının Evvel Yeni kopyası"},
    {"kod": "urun", "ad": "Ürün kataloğu", "ikon": "📚", "sektor": "genel", "gerekir": [], "menu": False,
     "aciklama": "tek ürün kimliği + değişiklik izi; Depo / Toptancılar / Bar / Gider / Satış buradan okur (sayfası Tanımlar altında)"},
    {"kod": "kasa", "ad": "Kasa", "ikon": "💰", "sektor": "genel", "gerekir": [], "aciklama": "para nerede — tek para defteri",
     "kesim": {"fn": "kesim_dondur", "sira": 10, "baslik": "Eski panelin Ekim kapanış / teslim / dükkân giderleri + sayımları Kasa'ya (31 Eki akşamı = 1 Kasım açılışının karşılığı) — şubeler açılmadan ve dönem geçişinden ÖNCE"},
     "gorevler": [{"ad": "kasa_otomatik", "fn": "otomatik_isler", "aralik_sn": 600,
                   "baslik": "Kasa otomatik işleri (eski köprü · otomatik kabul · POS · panel sayım aktarımı)"}]},
    {"kod": "tanim", "ad": "Tanımlar", "ikon": "⚙️", "sektor": "genel", "gerekir": ["kasa"], "aciklama": "şube, personel, banka, kart, toptancı",
     "kesim": {"fn": "kesim_dondur", "sira": 5, "baslik": "Eski şube / personel / ücret / kart / toptancı tanımlarının son kopyası (yalnız eksik ve boş alan)"}},
    {"kod": "gelir", "ad": "Gelir", "ikon": "📥", "sektor": "genel", "gerekir": ["kasa"], "aciklama": "şube şube, gün gün ciro"},
    {"kod": "kira", "ad": "Kiralar", "ikon": "🏠", "sektor": "genel", "gerekir": ["kasa"], "menu": False,
     "aciklama": "kira tanımı + takvim (sayfaları Ödeme altında)",
     "kesim": {"fn": "kesim_dondur", "sira": 54, "baslik": "Eski 'Öde' ekranında ödenmiş kiralar dondurulur (kira takvimi)"}},
    {"kod": "maas", "ad": "Personel", "ikon": "👥", "sektor": "genel", "gerekir": ["kasa"], "aciklama": "hak ediş, takvim, yoklama",
     "kesim": {"fn": "kesim_dondur", "sira": 30, "baslik": "Ekim bordrosu son kez hesaplanır + eski maaş kayıtları dondurulur"}},
    {"kod": "gider", "ad": "Gider", "ikon": "💸", "sektor": "genel", "gerekir": ["kasa", "gelir"], "aciklama": "şubenin kendi işletme yükü",
     "kesim": {"fn": "kesim_dondur", "sira": 42, "baslik": "Ekim şube gideri dondurulur"}},
    {"kod": "odeme", "ad": "Ödeme", "ikon": "🧾", "sektor": "genel", "gerekir": ["kasa"], "aciklama": "ödeme / gider girişi, patron harcamaları"},
    {"kod": "kredi", "ad": "Krediler", "ikon": "🏦", "sektor": "genel", "gerekir": ["kasa", "odeme"],
     "aciklama": "kredi tanımı + kredi takvimi (borç = taksit; ödeme Ödeme'den)",
     "kesim": {"fn": "kesim_dondur", "sira": 52, "baslik": "Eski 'Öde' ekranında ödenmiş kredi taksitleri dondurulur (kredi takvimi)"}},
    {"kod": "kart", "ad": "Kartlar", "ikon": "💳", "sektor": "genel", "gerekir": ["kasa", "odeme"], "aciklama": "kullanılabilir limit, son ödeme",
     "kesim": {"fn": "kesim_dondur", "sira": 50, "baslik": "Eski 'Öde' ekranında ödenmiş kart borçları dondurulur (kart takvimi)"}},
    {"kod": "toptanci", "ad": "Toptancılar", "ikon": "🚚", "sektor": "genel", "gerekir": ["kasa", "tanim", "urun"], "aciklama": "borç = açılış + alım − ödeme",
     "kesim": {"fn": "kesim_dondur", "sira": 6, "baslik": "Toptancı açılış bakiyesi — kontrol (yazmaz): eski cari bakiye ↔ girilen açılış (açılış = eski 31 Ekim borcu, Ekim teslimleri dahil); borç Tanımlar › Toptancılar'da elle"}},
    {"kod": "depo", "ad": "Depo", "ikon": "📦", "sektor": "genel", "gerekir": ["tanim", "urun"], "aciklama": "ürün nerede — tek hareket defteri · sevk et ⇄ depodan gelen",
     "gorevler": [{"ad": "depo_senkron", "fn": "otomatik_senkron_gorevi", "aralik_sn": 300,
                   "baslik": "Depo: eski panel kayıtlarını stok defterine aktar (1 Kasım'da kendiliğinden kapanır; sonu son aktarımda)"}],
     "kesim": {"fn": "kesim_dondur", "sira": 20, "baslik": "Eski panelin son depo kayıtları (giriş · sevk · ürün aç · fire) + eski sevklerin hedef şubesi"}},
    {"kod": "siparis", "ad": "Sipariş", "ikon": "🛒", "sektor": "genel", "gerekir": ["tanim", "urun", "depo"],
     "aciklama": "şube talebi → merkez yönlendirme (depo / toptancı) → sevk / teslim — Depo ve Toptancılar'ın üzerinde katman"},
    {"kod": "panel", "ad": "Şube paneli", "ikon": "🧾", "sektor": "genel", "gerekir": ["olay", "kasa", "tanim", "urun", "depo"],
     "menu": False, "aciklama": "şube personelinin ekranı (açılış, kapanış, ürün aç, fire…) — Evvel Yeni defterlerine yazar; 1 Kasım'a kadar deneme"},
    {"kod": "yoklama", "ad": "Yoklama · QR telefon", "ikon": "📱", "sektor": "genel", "gerekir": ["tanim", "olay"], "menu": False,
     "kurulum": "yoklama_hazirla", "aciklama": "telefon/tablet bağlama, dönen QR, giriş/çıkış + konum (sayfası Personel › Telefonlar)"},
    {"kod": "kazanc", "ad": "Şube kazancı", "ikon": "📈", "sektor": "genel", "gerekir": ["gelir", "gider"], "aciklama": "gelir − şubenin gideri"},
    {"kod": "avans", "ad": "Avans talepleri", "ikon": "🤝", "sektor": "genel", "gerekir": ["maas"], "menu": False,
     "aciklama": "personelin QR sayfasından avans talepleri → havale / elden / ret (sayfası Personel altında)",
     "kesim": {"fn": "kesim_dondur", "sira": 28, "baslik": "Eski açık avans talepleri + Kasım'a ait Ekim havaleleri taşınır (para hareketsiz) — şubeler açılmadan"}},
    {"kod": "vardiya", "ad": "Vardiya planı", "ikon": "🗓️", "sektor": "genel", "gerekir": ["tanim"], "menu": False,
     "kurulum": "vardiya_hazirla", "aciklama": "kalıp + kişi/gün planı, taslak → yayın; Günlük yoklama, Maaş, Panel/Telefon 'Bugün' buradan okur (sayfası Personel altında)",
     "kesim": {"fn": "kesim_dondur", "sira": 60, "baslik": "Eski ekrandaki 26 Eki–9 Kas vardiya planı alınır, düğme kapanır"}},
    {"kod": "fis", "ad": "Anlık gider fiş kontrol", "ikon": "🧾", "sektor": "genel", "gerekir": ["kasa"], "menu": False,
     "aciklama": "panelden girilen giderlerin fişi geldi mi; gelmeyen girişi yapan personelle (sayfası Gider altında)",
     "kesim": {"fn": "kesim_dondur", "sira": 46, "baslik": "Eski panel giderlerinin personel adı + fiş işareti ve kartla girilen giderler (fiş kontrolü)"}},
    {"kod": "mulk", "ad": "Kira hesabı", "ikon": "🏠", "sektor": "ozel", "gerekir": ["kasa"],
     "aciklama": "ev kiraları takvimi + işletmelerin Fatma'nın kira hesabına borcu (Kasım'dan)"},
    {"kod": "fatura", "ad": "Faturaları dağıt", "ikon": "🧾", "sektor": "ozel", "gerekir": ["odeme", "kart"], "menu": False,
     "aciklama": "kart ekstresindeki otomatik fatura ödemeleri → şube gideri (sayfası Ödeme altında)"},
    {"kod": "bar", "ad": "Bar", "ikon": "🥤", "sektor": "kahve", "gerekir": ["kasa"], "aciklama": "bardak + bar ürün sayımı",
     "kesim": {"fn": "kesim_dondur", "sira": 40, "baslik": "Eylül + Ekim bar özeti dondurulur"}},
    {"kod": "satis", "ad": "Satış kontrolü", "ikon": "🔍", "sektor": "kahve", "gerekir": ["kasa", "bar"],
     "aciklama": "bardak × bardak başına ciro ↔ gerçek ciro",
     "kesim": {"fn": "kesim_dondur", "sira": 44, "baslik": "Ekim kasa mutabakatı + fire + kasa devir defteri dondurulur"}},
]
for _m in MODULLER:
    _m.setdefault("acik", True)
    _m.setdefault("menu", True)
    _m.setdefault("yetki", _m["kod"])
    _m.setdefault("dosya", f"evvel_yeni_{_m['kod']}_api")

DURUM: Dict[str, str] = {}   # kod → yuklendi | kapali | eksik:<kod> | hata:<mesaj>
KESIM: Dict[str, dict] = {}   # kod → {fn, sira, baslik} — yalnız yüklenen modülün son aktarım adımı
GOREVLER: Dict[str, dict] = {}   # görev adı → {kod, fn, aralik_sn, baslik} — yalnız yüklenen modüllerinki
GOREV_HATA: Dict[str, str] = {}   # manifestte yazılı ama fonksiyonu bulunamayan görev


def acik(kod: str) -> bool:
    """PUBLIC — modül yüklendi mi (tak-çıkar yumuşak bağ). Dalga 4 (F#3): aynı karşılaştırma 12 yerde yazılıydı."""
    return DURUM.get(kod) == "yuklendi"


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
            for g in m.get("gorevler") or []:   # tak-çıkar: yalnız YÜKLENEN modülün görevi kaydolur
                fn = getattr(mod, g["fn"], None)
                if callable(fn):
                    GOREVLER[g["ad"]] = {"kod": kod, "fn": fn, "aralik_sn": int(g["aralik_sn"]), "baslik": g.get("baslik") or g["ad"]}
                else:
                    GOREV_HATA[g["ad"]] = f"{kod}: görev fonksiyonu yok ({g['fn']})"
                    log.warning("evvel_yeni %s görevi kaydedilmedi — fonksiyon yok: %s", kod, g["fn"])
            k = m.get("kesim")
            if k and callable(getattr(mod, k["fn"], None)):   # tak-çıkar: yalnız YÜKLENEN modülün kesim adımı
                KESIM[kod] = {"fn": getattr(mod, k["fn"]), "sira": int(k["sira"]), "baslik": k["baslik"]}
        except Exception as e:  # noqa: BLE001 — izole: ana akış etkilenmez
            DURUM[kod] = "hata:" + str(e)[:200]
            log.warning("evvel_yeni %s modülü yüklenemedi (izole, ana akış etkilenmez): %s", kod, e)
    app.include_router(router)


router = APIRouter(prefix="/api/evvel-yeni/moduller", tags=["evvel-yeni-moduller"])


@router.get("")
def moduller():
    """Ekran menüsü bunu okur: yalnız yüklenen modüller gösterilir."""
    return {"moduller": [{k: m[k] for k in ("kod", "ad", "ikon", "sektor", "yetki", "gerekir", "menu", "aciklama")}
                         | {"durum": DURUM.get(m["kod"], "bilinmiyor"),
                            "kesim": m["kod"] in KESIM} for m in MODULLER]}   # F6.3: son aktarım adımı yüklü mü (yayın doğrulaması da bundan)


# 🧪 PİLOT ŞUBE (sahip 27 Eki · Fable L4b A) — bir şube 1 Kasım'dan önce yeni panelde GERÇEK kayda geçer; kural çekirdekte
# (sube_baslangic / yeni_donem(sube_id) / eski_yazim_kapisi(sube_id)). Ayar: ey_ayar 'pilot_baslangic:<şube>'. Kaldırınca denemeye döner.
@router.get("/pilot")
def pilot_listesi(x_evvel_oturum: Optional[str] = Header(default=None)):
    from database import db
    from evvel_yeni_cekirdek import merkez_aktor, panel_baslangic, pilot_baslangiclari
    from evvel_yeni_tanim_api import subeler
    with db() as (conn, cur):
        merkez_aktor(cur, x_evvel_oturum)
        pl = pilot_baslangiclari(cur)
        return {"panel_baslangic": panel_baslangic(cur).isoformat(),
                "subeler": [{"id": s["id"], "ad": s["ad"], "pilot": pl[s["id"]].isoformat() if s["id"] in pl else None} for s in subeler(cur)]}


class _PilotBody(__import__("pydantic").BaseModel):
    sube_id: str
    gun: Optional[str] = None   # None → pilot kaldırılır (şube denemeye döner)


@router.post("/pilot")
def pilot_yaz(body: _PilotBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    from datetime import date as _date
    from database import db
    from fastapi import HTTPException
    from evvel_yeni_cekirdek import ayar_yaz, merkez_aktor, panel_baslangic, yeni_donem
    from evvel_yeni_tanim_api import subeler
    with db() as (conn, cur):
        kim = merkez_aktor(cur, x_evvel_oturum)
        if body.sube_id not in {s["id"] for s in subeler(cur)}:
            raise HTTPException(400, "Şube bulunamadı ya da pasif")
        if body.gun:
            try:
                g = _date.fromisoformat(body.gun[:10])
            except ValueError:
                raise HTTPException(400, "Gün YYYY-AA-GG olmalı")
            if g >= panel_baslangic(cur):
                raise HTTPException(400, f"Pilot günü genel başlangıçtan ({panel_baslangic(cur).isoformat()}) önce olmalı")
            if g < __import__("evvel_yeni_cekirdek").is_gunu():   # Fable B7: geçmiş gün → Kasa köprüsü o günden beri eski satırları atlardı
                raise HTTPException(400, "Pilot günü bugünden (iş günü) önce olamaz")
            ayar_yaz(cur, f"pilot_baslangic:{body.sube_id}", g.isoformat(), kim)
            return {"ok": True, "mesaj": f"Pilot başladı — {g.isoformat()} iş gününden itibaren bu şube yeni panelde GERÇEK kayıt tutar, eski panel kapanır"}
        if yeni_donem(cur):   # Fable 🟡3: 1 Kasım'dan (son aktarımdan) sonra kaldırılırsa pilot günleri ne arşivde ne yeni evrende olur
            raise HTTPException(409, "1 Kasım geçildi — pilot kaydı artık kaldırılamaz (pilot günleri yeni panelden okunuyor)")
        ayar_yaz(cur, f"pilot_baslangic:{body.sube_id}", "", kim)   # boş = pilot yok (çekirdeğin PUBLIC kapısı; tablo çekirdeğin)
        return {"ok": True, "mesaj": "Pilot kaldırıldı — şube denemeye döndü, eski panel yeniden açık"}


@router.get("/gecis/{sube_id}")
def gecis_sube(sube_id: str):
    """📢 Eski şube panelinin geçiş uyarısı (sahip 27 Eki · Fable): şubenin yeni panele geçiş günü (🧪 pilot dahil), geçti mi, yeni adres.
    Oturumsuz (eski panel jeton taşımaz); kişisel / para verisi yok. Okunamazsa sabit 1 Kasım (eski kapıyla aynı yedek)."""
    from datetime import date as _date
    from database import db
    from evvel_yeni_cekirdek import is_gunu, pilot_baslangiclari, sube_baslangic
    try:
        with db() as (conn, cur):
            gun = sube_baslangic(cur, sube_id)
            pilot = sube_id in pilot_baslangiclari(cur)
    except Exception:  # noqa: BLE001
        gun, pilot = _date(2026, 11, 1), False
    return {"gun": gun.isoformat(), "pilot": pilot, "gecti": is_gunu() >= gun, "adres": f"/panel/{sube_id}"}


@router.get("/gecis")
def gecis():
    """Eski QR adresi (/gorev-giris, /gorev-pin) yeni telefon evine (/q) yönlensin mi? TEK kural çekirdeğin anahtarı (30 sn önbellekli).
    Çekirdek yönlendiricisinde (her zaman yüklü — Fable: yoklama modülü sökülse de kesim kuralı okunur). Oturumsuz, kişisel veri yok."""
    from evvel_yeni_cekirdek import eski_panel_zinciri_acik_onbellekli
    return {"yeni": not eski_panel_zinciri_acik_onbellekli()}


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


# ─────────────────────────── ARKA PLAN GÖREVLERİ (tek zamanlayıcı) ────────────────────────────
# IS 5c / F3.1 B7+B11 (sim 26 Eki · Opus + Codex + Fable): Kasa ve Depo'nun otomatik işleri ekran okumasıyla (GET) tetikleniyordu —
# kimse açmazsa işlenmiyordu. Artık manifestteki görevler süreç içi TEK thread'de koşar (main.py startup başlatır, ilk koşu 75 sn sonra).
# Çift süreç koruması: görev başına işlem düzeyinde try-kilit; vade kilitten SONRA kalıcı kayıttan yeniden denetlenir (Codex).
# Görev KENDİ bağlantılarında çalışır; kilit + sonuç satırı ayrı işlemde → görev patlasa da hata satırı yazılır.
_GOREV_DUR = threading.Event()
_GOREV_SON: Dict[str, float] = {}   # süreç içi ön süzgeç (DB'ye her tikte gitmesin); asıl karar kalıcı kayıtta
_GOREV_ACILIS = {"t": time.time()}
_GOREV_TEMIZLIK = {"t": 0.0}
_GOREV_HAZIR = {"ok": False}
GOREV_ILK_GECIKME_SN = 75
GOREV_TIK_SN = 30
GOREV_SAKLAMA_GUN = 7


def _gorev_hazirla() -> None:
    """ey_gorev_kosu — çekirdeğin tablosu; ayrı kısa işlemde, süreçlerarası kilit altında (_ayar_hazirla kalıbı)."""
    if _GOREV_HAZIR["ok"]:
        return
    from database import db
    with db() as (_c, k):
        k.execute("SELECT pg_advisory_xact_lock(7012077)")
        k.execute("SET LOCAL lock_timeout = '3s'")
        k.execute("""CREATE TABLE IF NOT EXISTS ey_gorev_kosu (
            id BIGSERIAL PRIMARY KEY, ad TEXT NOT NULL, basla TIMESTAMPTZ NOT NULL, bitir TIMESTAMPTZ NOT NULL,
            tamam BOOLEAN NOT NULL, elle BOOLEAN NOT NULL DEFAULT FALSE, ozet JSONB, hata TEXT)""")
        k.execute("CREATE INDEX IF NOT EXISTS ey_gorev_kosu_ad ON ey_gorev_kosu (ad, bitir DESC)")
    _GOREV_HAZIR["ok"] = True


def gorev_calistir(ad: str, elle: bool = False) -> dict:
    """PUBLIC — görevi bir kez koşturur. Başka süreç/istek o an koşturuyorsa {zaten: True} (sessiz başarı DEĞİL).
    elle=False iken vade dolmamışsa koşmaz ({erken: True})."""
    g = GOREVLER.get(ad)
    if not g:
        return {"ok": False, "mesaj": GOREV_HATA.get(ad) or "böyle bir görev yok (modül kapalı olabilir)"}
    _gorev_hazirla()
    from database import db
    from psycopg2.extras import Json
    with db() as (conn, cur):
        cur.execute("SELECT pg_try_advisory_xact_lock(hashtext(%s)) AS k", ("ey_gorev:" + ad,))
        if not dict(cur.fetchone())["k"]:
            return {"ok": False, "zaten": True, "mesaj": "bu iş şu an zaten çalışıyor"}
        if not elle:
            cur.execute("SELECT 1 FROM ey_gorev_kosu WHERE ad = %s AND basla > NOW() - make_interval(secs => %s) LIMIT 1",
                        (ad, g["aralik_sn"]))
            if cur.fetchone():
                _GOREV_SON[ad] = time.time()
                return {"ok": False, "erken": True}
        basla = datetime.now(timezone.utc)
        ozet, hata = None, None
        try:
            ozet = g["fn"]() or {}
        except Exception as e:  # noqa: BLE001 — görevin hatası kayda düşer, zamanlayıcıyı durdurmaz
            hata = str(e)[:300]
            log.warning("evvel_yeni görev %s: %s", ad, hata)
        if hata is None and isinstance(ozet, dict):
            if ozet.get("hatalar"):   # Codex: kısmi hata başarı sayılmaz
                hata = ("kısmi: " + "; ".join(str(x) for x in ozet["hatalar"]))[:300]
            elif ozet.get("tamam") is False:
                hata = str(ozet.get("hata") or "tamamlanamadı")[:300]
        cur.execute("""INSERT INTO ey_gorev_kosu (ad, basla, bitir, tamam, elle, ozet, hata)
                       VALUES (%s, %s, clock_timestamp(), %s, %s, %s, %s)""",   # Codex: NOW() işlem başı — bitiş değil
                    (ad, basla, hata is None, elle, Json(ozet, dumps=lambda o: json.dumps(o, ensure_ascii=False, default=str)), hata))
        if time.time() - _GOREV_TEMIZLIK["t"] > 86400:   # saklama günde bir, SÜREYE dayalı (Codex: adet sınırı 24 saati garanti etmez)
            cur.execute("DELETE FROM ey_gorev_kosu WHERE bitir < NOW() - make_interval(days => %s)", (GOREV_SAKLAMA_GUN,))
            _GOREV_TEMIZLIK["t"] = time.time()
    _GOREV_SON[ad] = time.time()
    return {"ok": hata is None, "ozet": ozet, "hata": hata}


def _gorev_dongusu() -> None:
    if _GOREV_DUR.wait(GOREV_ILK_GECIKME_SN):
        return
    while not _GOREV_DUR.is_set():
        for ad, g in list(GOREVLER.items()):
            if time.time() - _GOREV_SON.get(ad, 0.0) < g["aralik_sn"]:
                continue
            try:
                gorev_calistir(ad)
            except Exception as e:  # noqa: BLE001 — döngü hiçbir hatayla ölmez
                _GOREV_SON[ad] = time.time()
                log.warning("evvel_yeni görev döngüsü %s: %s", ad, str(e)[:200])
        _GOREV_DUR.wait(GOREV_TIK_SN)


def gorevleri_baslat() -> None:
    """PUBLIC — main.py startup (init_db'den SONRA) bir kez çağırır."""
    if not GOREVLER or any(t.name == "ey-gorev" for t in threading.enumerate()):
        return
    _GOREV_ACILIS["t"] = time.time()
    threading.Thread(target=_gorev_dongusu, daemon=True, name="ey-gorev").start()
    log.info("evvel_yeni görev zamanlayıcısı başladı: %s", ", ".join(GOREVLER))


def gorevleri_durdur() -> None:
    """PUBLIC — main.py shutdown."""
    _GOREV_DUR.set()


def gorev_durumu(cur, ad: str) -> dict:
    """PUBLIC — bir görevin son koşusu + son başarılı koşusu + gecikti mi (ekranlar buradan OKUR, yazmaz)."""
    g = GOREVLER.get(ad)
    out = {"ad": ad, "kayitli": bool(g), "son": None, "son_basarili": None, "gecikti": False}
    if not g:
        return out
    _gorev_hazirla()
    cur.execute("SELECT bitir, tamam, elle, ozet, hata FROM ey_gorev_kosu WHERE ad = %s ORDER BY bitir DESC LIMIT 1", (ad,))
    r = cur.fetchone()
    son_bitir = dict(r)["bitir"] if r else None
    out["son"] = {**dict(r), "bitir": son_bitir.isoformat()} if r else None
    cur.execute("SELECT bitir, ozet FROM ey_gorev_kosu WHERE ad = %s AND tamam ORDER BY bitir DESC LIMIT 1", (ad,))
    r = cur.fetchone()
    out["son_basarili"] = {**dict(r), "bitir": dict(r)["bitir"].isoformat()} if r else None
    # Fable/Opus: yeniden başlatma sonrası sahte alarm olmasın — süreç en az bir koşu yapacak kadar çalıştıysa.
    # Gecikme SON KOŞUYA göre (Fable F3.1: kısmi hata veren ama düzenli koşan iş "gecikti" görünmesin — hatası ayrıca söylenir)
    if time.time() - _GOREV_ACILIS["t"] > GOREV_ILK_GECIKME_SN + g["aralik_sn"]:
        out["gecikti"] = son_bitir is None or (datetime.now(timezone.utc) - son_bitir).total_seconds() > 2 * g["aralik_sn"]
    return out


@router.get("/gorevler")
def gorevler():
    """⚙️ Sistem durumu — modüllerin arka plan işleri: son koşu, ne yaptı, son hata, son 24 saatte kaç kez."""
    from database import db
    out = []
    with db() as (conn, cur):
        for ad, g in GOREVLER.items():
            d = gorev_durumu(cur, ad)
            cur.execute("""SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE NOT tamam) AS hatali FROM ey_gorev_kosu
                           WHERE ad = %s AND bitir > NOW() - INTERVAL '24 hours'""", (ad,))
            say = dict(cur.fetchone())
            out.append({**d, "baslik": g["baslik"], "modul": g["kod"], "aralik_sn": g["aralik_sn"],
                        "kosu_24s": say["n"], "hatali_24s": say["hatali"]})
    return {"gorevler": out, "kayitsiz": [{"ad": a, "hata": h} for a, h in GOREV_HATA.items()],
            "zamanlayici": any(t.name == "ey-gorev" and t.is_alive() for t in threading.enumerate())}


@router.post("/gorevler/{ad}/calistir")
def gorev_simdi(ad: str):
    """Sistem durumu › Şimdi çalıştır — zamanlayıcıyla aynı kilit; o an çalışıyorsa 'zaten çalışıyor' döner."""
    return gorev_calistir(ad, elle=True)


# ─────────────────────────── ✂️ 1 KASIM SON AKTARIM ───────────────────────────
# Opus karar 3 (27 Eki): genel 'eski_gece_zinciri' anahtarı AÇILMAZ; adımlar buradan doğrudan, 1 Kas 02:00 SONRASI (iş günü ≥ panel
# başlangıcı), ÖNCE KURU. Her adım kendi savepoint'inde: kuruda sonuç sayılır ve geri alınır; gerçekte yazılır, ey_ayar'a iz düşer.
def _kesim_ay(cur) -> str:
    from evvel_yeni_cekirdek import ay_kaydir, panel_baslangic
    return ay_kaydir(panel_baslangic(cur).strftime("%Y-%m"), -1)


def _son(cur, kod: str):
    from evvel_yeni_cekirdek import ayar_oku, json_ac
    v = ayar_oku(cur, f"kesim_son:{kod}")
    return json_ac(v, None) if v else None   # yazılmamış adım "✓ yazıldı" görünüyordu (json_ac boşa {} döner)


@router.get("/kesim")
def kesim_durum(x_evvel_oturum: Optional[str] = Header(default=None)):
    """Sistem durumu › 1 Kasım son aktarım: adımlar (sıralı), son gerçek çalıştırma, açılabilir mi."""
    from database import db
    from evvel_yeni_cekirdek import merkez_aktor, yeni_donem, panel_baslangic
    with db() as (conn, cur):
        merkez_aktor(cur, x_evvel_oturum)   # Fable 🟡4: maaş toplamı taşır — merkez oturumu
        acik = yeni_donem(cur)
        out = [{"kod": k, "ad": next((m["ad"] for m in MODULLER if m["kod"] == k), k), "sira": v["sira"], "baslik": v["baslik"],
                "son": _son(cur, k)} for k, v in sorted(KESIM.items(), key=lambda x: x[1]["sira"])]
        return {"ay": _kesim_ay(cur), "gercek_acik": acik, "baslangic": panel_baslangic(cur).isoformat(), "adimlar": out}


class _KesimBody(__import__("pydantic").BaseModel):
    kod: str
    kuru: bool = True


@router.post("/kesim/calistir")
def kesim_calistir(body: _KesimBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Bir adımı çalıştır. Kuru: sonuç sayılır, hiçbir şey yazılmaz. Gerçek: yalnız yeni dönem başladıktan sonra (31 Eki gecesi
    02:00'den önce Ekim bitmemiştir — 409). Aynı anda iki çalıştırma yok (kilit)."""
    from database import db
    from fastapi import HTTPException
    from evvel_yeni_cekirdek import ayar_yaz, merkez_aktor, yeni_donem
    adim = KESIM.get(body.kod)
    if not adim:
        raise HTTPException(404, "Bu modülün son aktarım adımı yok ya da modül kapalı")
    with db() as (conn, cur):
        kim = merkez_aktor(cur, x_evvel_oturum)
        if not body.kuru and not yeni_donem(cur):
            raise HTTPException(409, "Son aktarım yeni dönem başladıktan sonra çalışır (1 Kasım 02:00) — şimdi yalnız kuru dene")
        cur.execute("SELECT pg_try_advisory_xact_lock(7012099) AS k")
        if not dict(cur.fetchone())["k"]:
            raise HTTPException(409, "Son aktarım şu an başka bir yerde çalışıyor")
        ay = _kesim_ay(cur)
        t0 = time.time()
        cur.execute("SAVEPOINT sp_kesim")
        try:
            sonuc = adim["fn"](cur, kim, ay)
        except Exception as e:  # noqa: BLE001
            cur.execute("ROLLBACK TO SAVEPOINT sp_kesim")
            log.warning("son aktarım %s: %s", body.kod, e, exc_info=True)
            raise HTTPException(500, f"{body.kod}: {str(e)[:200]}")
        sure = round(time.time() - t0, 1)
        if body.kuru:
            cur.execute("ROLLBACK TO SAVEPOINT sp_kesim")
        else:
            cur.execute("RELEASE SAVEPOINT sp_kesim")
            ayar_yaz(cur, f"kesim_son:{body.kod}", json.dumps({"zaman": datetime.now(timezone.utc).isoformat(), "yazan": kim, "ay": ay,
                                                               "sonuc": sonuc}, ensure_ascii=False, default=str), kim)
        return {"kod": body.kod, "kuru": body.kuru, "ay": ay, "sure_sn": sure, "sonuc": sonuc}
