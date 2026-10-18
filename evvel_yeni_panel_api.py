"""🧾 EVVEL YENİ · ŞUBE PANELİ (sunucu) — tak-çıkar modül "panel" (SUBE_PANELI_TASARIM.md, Fable + Codex + sahip kararları).

Sahip: "Yeni Şube Paneli" — sıfırdan; eski panele / eski tablolara bağ YOK. Personel aynı akışı görür, altta her işlem
Evvel Yeni'nin MEVCUT defterlerine yazar (yeni tablo yok):
  · ham olay → ey_sube_olay (Olay modülü `olay_yaz`)       · para → Kasa `kasa_yaz` (kapanış / teslim)
  · stok     → Depo `hareket_yaz` / `sayim_yaz` (ey_urun)   · ürün kimliği = yeni katalog (ey_urun)
Tek işlem: bir düğmenin yazdığı her şey ya hep birlikte yazılır ya hiç (hata → "Kaydedilemedi, tekrar deneyin").
Tekrar gönderim (istek_id / kaynak_ref) ikinci kez yazılmaz.

DENEME MODU: `ey_ayar.panel_baslangic` (varsayılan 2026-11-01) gelmeden panel KAYDETMEZ — her şeyi doğrular, ne yazacağını
gösterir, işlemi geri alır ("kuru"). Böylece 1 Kasım öncesi canlı defterler kirlenmeden denenir.
Uyarılar personele GİTMEZ (sahip): eksi stok, fiyatı eksik ürün vb. yalnız merkez Bekleyen işler'e.
Faz 1: açılış · kapanış · kasa devri · ara teslim · ürün aç · fire. (Teslim al / depodan gelen / anlık gider: faz 2.)
"""

import json
import logging
import re
import uuid
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from database import db
from evvel_yeni_cekirdek import ayar_oku, bekleyen_is_kaydet, is_gunu as _bugun, kurus as _kurus   # şube İŞ GÜNÜ (gece 02:00'ye kadar önceki gün)

router = APIRouter(prefix="/api/evvel-yeni/panel", tags=["evvel-yeni-panel"])
log = logging.getLogger(__name__)
VARSAYILAN_BASLANGIC = "2026-11-01"
TESLIM_ALANLAR = ("ev:onur", "ev:fethi", "ev:fatma")     # sahip kararı: teslim yalnız Onur / Fethi / Fatma
KIM = "şube paneli"


class _Kuru(Exception):
    """Deneme modunda işlemi geri almak için (sonuç taşır)."""

    def __init__(self, sonuc: dict):
        super().__init__("kuru")
        self.sonuc = sonuc


def _baslangic(cur) -> date:
    try:
        return date.fromisoformat((ayar_oku(cur, "panel_baslangic", VARSAYILAN_BASLANGIC) or VARSAYILAN_BASLANGIC)[:10])
    except ValueError:
        return date.fromisoformat(VARSAYILAN_BASLANGIC)


def _sube(cur, sube_id: str) -> dict:
    from evvel_yeni_tanim_api import subeler
    s = next((x for x in subeler(cur) if str(x["id"]) == str(sube_id)), None)
    if not s:
        raise HTTPException(404, "Şube bulunamadı")
    return s


def _yoklama():
    """Yumuşak bağ: yoklama modülü yüklüyse PUBLIC servisleri; değilse None (panel yoklamasız çalışır)."""
    from evvel_yeni_moduller import DURUM
    if DURUM.get("yoklama") != "yuklendi":
        return None
    import evvel_yeni_yoklama_api as y
    return y


def _qr_gerekli(cur) -> bool:
    """QR kapısı: yoklama yüklü + deneme dönemi bitti (panel_baslangic). Denemede kapı uyarı olarak görünür, engel olmaz."""
    return _yoklama() is not None and _bugun() >= _baslangic(cur)


def _personel(cur, sube_id: str, pid: Optional[str], kapi: bool = True, gun=None) -> dict:
    """Ad seçimi (sahip: yetki fazına kadar PIN yok). Her kayıt personel kimliği taşır."""
    from evvel_yeni_tanim_api import secim_listeleri
    if not pid:
        raise HTTPException(400, "Adını seç")
    p = next((x for x in secim_listeleri(cur)["personel"] if str(x["id"]) == str(pid) and x["aktif"]), None)
    if not p:
        raise HTTPException(400, "Personel bulunamadı")
    y = _yoklama()
    burada = y is not None and _qr_gerekli(cur) and (
        y.acik_mi(cur, sube_id, str(p["id"])) if kapi
        else y.girdi_mi(cur, sube_id, str(p["id"]), gun or _bugun()))   # K11: QR'la bu şubeye girmiş (kapanış: o gün girmiş)
    if str(p.get("sube_id") or "") != str(sube_id) and not burada:   # Codex: başka şubenin personeli bu şubeye yazamasın
        raise HTTPException(400, "Bu şubenin personeli değilsin — adını listeden seç")
    if kapi and y is not None and _qr_gerekli(cur) and not y.acik_mi(cur, sube_id, str(p["id"])):   # K: panel ad listesi = bugün girenler
        raise HTTPException(400, "Önce telefonundan QR ile giriş yap")
    return {"id": str(p["id"]), "ad": p["ad"], "erken_acilis": bool(p.get("erken_acilis"))}


def _tam(v, ad: str) -> int:
    """Tam sayı adet (kesir / eksi yok)."""
    if isinstance(v, bool) or v in (None, ""):
        raise HTTPException(400, f"{ad}: sayı yaz")
    try:
        d = Decimal(str(v).replace(",", "."))
    except InvalidOperation:
        raise HTTPException(400, f"{ad}: sayı yaz")
    if d != d.to_integral_value() or d < 0:
        raise HTTPException(400, f"{ad}: tam sayı yaz")
    return int(d)


def _tl(v, ad: str) -> int:
    try:
        k = _kurus(v if v not in (None, "") else 0)
    except HTTPException:
        raise HTTPException(400, f"{ad}: tutarı yaz")
    if k < 0:
        raise HTTPException(400, f"{ad}: eksi olamaz")
    return k


def _urunler(cur, idler: List[str], takip: Optional[str] = None) -> dict:
    """takip verilirse ürün o takip türünde olmalı (Codex: sayım = 'sayim', ürün aç = 'acilinca')."""
    from evvel_yeni_urun_api import urun_bilgi
    b = urun_bilgi(cur, idler)
    for i in idler:
        if i not in b or not b[i]["aktif"]:
            raise HTTPException(400, "Ürün bulunamadı — listeyi yenileyin")
        if takip and (b[i].get("takip") or "sayim") != takip:
            raise HTTPException(400, f"{b[i]['ad']}: bu listede yok — listeyi yenileyin")
        if takip == "sayim" and not b[i].get("panel_sayim"):
            raise HTTPException(400, f"{b[i]['ad']}: sayım listesinde yok — listeyi yenileyin")
    return b


ACILIS_SAAT = (7, 0)       # sahip D10: 07:00'den önce açılış ENGELLENİR (kişiye özel erken açılış izni hariç)
KAPANIS_SAAT = (22, 30)    # sahip D10: 22:30'dan önce kapanış ENGELLENİR
FIRE_SEBEPLERI = {         # sahip D9 — eski panelin sebep kartları (fire_bildirim.FIRE_SEBEP ile aynı anlam)
    "iade": "Müşteri iadesi / bozuk ürün", "siparis_iptali": "Sipariş iptali", "skt_bozulma": "SKT / bozulma",
    "kirilma_dokulme": "Kırılma / dökülme", "yanlis_urun": "Yanlış ürün / değişim", "hazirlik_deneme": "Hazırlık / deneme / eğitim",
    "ikram": "İkram", "personel_kullanim": "Personel kullanımı", "sayim_hatasi": "Sayım hatası", "panel_hatasi": "Panel kullanım hatası",
    "diger": "Diğer",
}
# fire DIŞI çıkışlar ayrı konuma gider (maliyet raporunda ayrı satır — sahip D9)
FIRE_HEDEF = {"ikram": "dışarı:ikram", "personel_kullanim": "dışarı:personel", "sayim_hatasi": "dışarı:sayim", "panel_hatasi": "dışarı:sayim"}


def _simdi_tr():
    from tr_saat import dt_now_tr
    return dt_now_tr()


def _saat_kurali(tur: str, personel: dict) -> Optional[str]:
    """Açılış / kapanış saat kuralı (iş günü saatiyle). Engelse mesaj döner."""
    n = _simdi_tr()
    hm = (n.hour, n.minute)
    if tur == "acilis" and hm < ACILIS_SAAT and not personel.get("erken_acilis"):
        return "Açılış 07:00'den önce yapılamaz"
    if tur == "kapanis" and 2 <= n.hour and hm < KAPANIS_SAAT:
        return "Kapanış 22:30'dan önce yapılamaz"
    return None


def _gun_kapali(cur, sube_id: str, gun) -> bool:
    """Bugünün kapanışı yapıldıysa gün kapalıdır (D7): ürün aç / fire / ara teslim / kasa devri yazılmaz."""
    from evvel_yeni_olay import olaylar
    return any(not o.get("iptal") and (o.get("kaynak_tablo") or "") == "panel"
               for o in olaylar(cur, sube_id=sube_id, bas=gun, son=gun, turler={"kapanis"}))


def _gun_acik_mi(cur, c: dict, sube_id: str) -> None:
    if not c.get("merkez") and _gun_kapali(cur, sube_id, c["gun"]):
        raise HTTPException(409, "Gün kapandı — bu işlem yapılamaz")


# ─────────────── 🛟 KAPANIŞ KAYBOLMASIN (Zafer 16 Ekim dersi; sahip: "gönderdim sandı ama gelmedi — bunu atlama") ───────────────
# Her gönderim, asıl işlemden ÖNCE ayrı bağlantıyla ey_panel_deneme'ye yazılır (ham gövde); sonuç / ret SEBEBİ sonra ayrı
# bağlantıyla işlenir → asıl işlem geri alınsa da deneme kalır. Reddedilen / hata veren kapanış merkez Bekleyen işler'e
# "Geç kapanış olarak işle" diye düşer; merkez tek tıkla, personelin girdiği verilerle o iş gününe işler.
_DENEME_HAZIR = False


def _deneme_hazirla() -> None:
    global _DENEME_HAZIR
    if _DENEME_HAZIR:
        return
    with db() as (_c, cur):
        cur.execute("SELECT pg_advisory_xact_lock(7012045)")
        cur.execute("SET LOCAL lock_timeout = '3s'")
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_panel_deneme (
            id TEXT PRIMARY KEY, sube_id TEXT NOT NULL, tur TEXT NOT NULL, is_gunu DATE NOT NULL, istek_id TEXT, personel_id TEXT,
            govde JSONB NOT NULL DEFAULT '{}'::jsonb, sonuc TEXT NOT NULL DEFAULT 'bekliyor', sebep TEXT,
            zaman TIMESTAMPTZ NOT NULL DEFAULT NOW(), islendi BOOLEAN NOT NULL DEFAULT FALSE, isleyen TEXT)""")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_ey_panel_deneme ON ey_panel_deneme (tur, sonuc, zaman)")
    _DENEME_HAZIR = True


def _deneme_ac(sube_id: str, tur: str, gun, govde: dict) -> Optional[str]:
    try:
        _deneme_hazirla()
        did = str(uuid.uuid4())
        with db() as (_c, cur):
            cur.execute("""INSERT INTO ey_panel_deneme (id, sube_id, tur, is_gunu, istek_id, personel_id, govde)
                           VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb)""",
                        (did, str(sube_id), tur, gun, govde.get("istek_id"), govde.get("personel_id") or govde.get("devreden_id"),
                         json.dumps(govde, ensure_ascii=False, default=str)))
        return did
    except Exception as e:  # noqa: BLE001 — Codex: deneme yazılamazsa işlem YAPILMAZ (iz garantisi); tablet kuyruğu tekrar dener
        log.error("panel denemesi yazılamadı (%s %s): %s", sube_id, tur, str(e)[:200])
        raise HTTPException(503, "Kaydedilemedi — tekrar deneyin")


def _deneme_kapat(did: Optional[str], sonuc: str, sebep: Optional[str] = None) -> None:
    if not did:
        return
    try:
        with db() as (_c, cur):
            cur.execute("UPDATE ey_panel_deneme SET sonuc=%s, sebep=%s WHERE id=%s", (sonuc, (sebep or "")[:300] or None, did))
    except Exception as e:  # noqa: BLE001
        log.error("panel denemesi sonucu yazılamadı (%s): %s", did, str(e)[:200])


def _calistir(sube_id: str, istek_id: Optional[str], is_fn, tur: Optional[str] = None, govde: Optional[dict] = None,
              gun=None, merkez: Optional[str] = None, isle_deneme: Optional[str] = None) -> dict:
    """Ortak iskelet: deneme kaydı → hazırlık → tek işlem → (deneme modunda geri al) → deneme sonucu.
    gun/merkez: yalnız merkezin 'geç kapanış' işlemi (o iş gününe; saat kuralı ve gün kilidi uygulanmaz)."""
    gun0 = gun or _bugun()
    ig = (govde or {}).get("istemci_gunu")
    if not merkez and ig:   # Codex: tablette kalıp gün değiştikten sonra gelen kayıt yanlış güne yazılmasın → deneme o güne, ret
        try:
            from datetime import date as _d
            igd = _d.fromisoformat(str(ig)[:10])
        except ValueError:
            igd = gun0
        if igd != gun0:
            did = _deneme_ac(sube_id, tur, igd, govde or {}) if tur else None
            _deneme_kapat(did, "ret", f"gün değişti — tablette {igd.isoformat()} günü girilmişti")
            raise HTTPException(409, "Gün değişti — bu kayıt merkeze iletildi")
    did = _deneme_ac(sube_id, tur, gun0, govde or {}) if tur and not merkez else None   # Fable: merkez koşusu yeni deneme açmaz
    try:
        sonuc = _calistir_ic(sube_id, istek_id, is_fn, gun, merkez, isle_deneme)
    except HTTPException as e:
        _deneme_kapat(did, "ret" if e.status_code < 500 else "hata", str(e.detail))
        raise
    except Exception as e:  # noqa: BLE001
        _deneme_kapat(did, "hata", str(e)[:300])
        raise
    _deneme_kapat(did, "deneme" if sonuc.get("kuru") else "ok")
    return sonuc


def _calistir_ic(sube_id: str, istek_id: Optional[str], is_fn, gun=None, merkez: Optional[str] = None,
                 isle_deneme: Optional[str] = None) -> dict:
    """Hazırlık → tek işlem → (deneme modunda geri al). is_fn(cur, ctx) yazar ve özet döner."""
    if istek_id is not None and not re.fullmatch(r"[A-Za-z0-9-]{8,64}", istek_id):   # Codex: '#', '%', '_' ref çakışması üretmesin
        raise HTTPException(400, "İstek kimliği geçersiz")
    from evvel_yeni_depo_api import depo_hazirla
    from evvel_yeni_kasa_api import kasa_hazirla
    from evvel_yeni_olay import olay_tablosu_kur
    from evvel_yeni_urun_api import katalog as _katalog_hazir
    kasa_hazirla()
    olay_tablosu_kur()
    with db() as (_c, hc):   # Codex: tablo hazırlıkları ANA işlemin dışında (deneme geri alınca hazır bayrağı yalan kalmasın)
        _katalog_hazir(hc)
        depo_hazirla(hc)
    try:
        with db() as (conn, cur):
            g = gun or _bugun()
            cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"ey_panel_gun:{sube_id}:{g.isoformat()}",))
            ctx = {"gun": g, "sube": _sube(cur, sube_id), "kuru": g < _baslangic(cur), "merkez": merkez}
            sonuc = is_fn(cur, ctx)
            if isle_deneme and not ctx["kuru"]:   # Codex: geç kapanış ile 'işlendi' işareti AYNI işlemde (yarıda kalmaz)
                cur.execute("UPDATE ey_panel_deneme SET islendi=TRUE, isleyen=%s WHERE id=%s", (merkez, isle_deneme))
            sonuc = {"ok": True, "kuru": ctx["kuru"], **sonuc}
            if ctx["kuru"]:
                raise _Kuru(sonuc)
            return sonuc
    except _Kuru as k:
        return {**k.sonuc, "mesaj": "DENEME — kaydedilmedi (panel henüz açılmadı)" + (f" · gerçekte: {k.sonuc['saat_engeli']}" if k.sonuc.get("saat_engeli") else "")}


# ─────────────────────────── OKUMA ───────────────────────────
@router.get("/{sube_id}/durum")
def panel_durum(sube_id: str):
    """Panelin açılışta ihtiyacı olan her şey: şube, personel, sayılacak / açılacak ürünler, bugün yapılanlar."""
    from evvel_yeni_olay import olay_tablosu_kur, olaylar
    from evvel_yeni_tanim_api import secim_listeleri
    from evvel_yeni_urun_api import katalog
    olay_tablosu_kur()
    with db() as (conn, cur):
        s = _sube(cur, sube_id)
        gun = _bugun()
        per = [{"id": str(p["id"]), "ad": p["ad"]} for p in secim_listeleri(cur)["personel"]
               if p["aktif"] and str(p.get("sube_id") or "") == str(sube_id)]
        kat = katalog(cur)
        bugunku = [{"id": o["id"], "tur": o["tur"], "zaman": str(o["olay_zamani"])[11:16], "kim": o.get("personel_ad"),
                    "iptal": o.get("iptal", False)}
                   for o in olaylar(cur, sube_id=sube_id, bas=gun, son=gun) if (o.get("kaynak_tablo") or "") == "panel"]
        bas = _baslangic(cur)
        y = _yoklama()
        yok = {"var": y is not None, "qr_gerekli": False, "girenler": [], "son_okutanlar": [], "tablet_kayitli": False}
        if y is not None:
            yok["qr_gerekli"] = gun >= bas
            yok["girenler"] = y.bugun_girenler(cur, str(sube_id), gun)
            yok["son_okutanlar"] = y.son_okutanlar(cur, str(sube_id), 120)
            cur.execute("SELECT 1 FROM ey_cihaz WHERE sube_id=%s AND tur='tablet' AND durum='aktif' LIMIT 1", (str(sube_id),))
            yok["tablet_kayitli"] = bool(cur.fetchone())
            yok["devir"] = y.devir_durum(cur, str(sube_id), gun)
            yok["kapanis_sorumlusu"] = y.kapanis_sorumlusu(cur, str(sube_id), gun)
            giren = {g["personel_id"] for g in yok["girenler"] if g["acik"]}
            yok["devralan_adaylari"] = ([{"id": g["personel_id"], "ad": g["ad"], "girdi": True} for g in yok["girenler"] if g["acik"]]
                                        + [{"id": x["id"], "ad": x["ad"], "girdi": False} for x in per if x["id"] not in giren])
            if yok["qr_gerekli"]:   # ad listesi = bu şubede QR'la girmiş olanlar (K11: başka şubenin personeli dahil)
                per = [{"id": g["personel_id"], "ad": g["ad"]} for g in yok["girenler"] if g["acik"]]
    def _u(x):
        return {"id": x["id"], "ad": x["ad"], "birim": x["birim"], "koli_ici": x.get("koli_ici")}
    return {"sube": {"id": s["id"], "ad": s["ad"]}, "gun": gun.isoformat(), "kuru": gun < bas, "panel_baslangic": bas.isoformat(),
            "personel": per, "teslim_alanlar": [{"id": c, "ad": c.split(":")[1].capitalize()} for c in TESLIM_ALANLAR],
            "sayilan": [{"kategori": k["ad"], "urunler": [_u(x) for x in k["urunler"] if x.get("takip") == "sayim" and x.get("panel_sayim")]}
                        for k in kat],
            "acilan": [{"kategori": k["ad"], "urunler": [_u(x) for x in k["urunler"] if x.get("takip") == "acilinca"]} for k in kat],
            "bugun": bugunku, "yoklama": yok,
            "acilis_var": any(o["tur"] == "acilis" and not o["iptal"] for o in bugunku),
            "kapanis_var": any(o["tur"] == "kapanis" and not o["iptal"] for o in bugunku),
            "fire_sebepleri": [{"kod": k, "ad": v} for k, v in FIRE_SEBEPLERI.items()],
            "saat": {"acilis": "%02d:%02d" % ACILIS_SAAT, "kapanis": "%02d:%02d" % KAPANIS_SAAT}}


# ─────────────────────────── YAZMA ───────────────────────────
class SayimSatir(BaseModel):
    urun_id: str
    sayilan: Optional[Decimal] = None


class AcilisBody(BaseModel):
    istemci_gunu: Optional[str] = None   # tabletin formu açtığı iş günü (gün değiştiyse kayıt merkeze iletilir)
    personel_id: str
    kasa_sayim: Decimal                      # sabah kasadaki nakit (TL)
    sayim: List[SayimSatir] = []             # sayılan ürünler (boş bırakılan SAYILMAZ)
    pasta_toplam: Optional[Decimal] = None   # sahip: pasta yalnız TOPLAM adet (eski panel "Pasta adedi")
    istek_id: Optional[str] = None


def _olay(cur, **kw) -> Optional[str]:
    """Olay yaz — aynı kök ZATEN varsa: içerik aynıysa tekrar (None), farklıysa 409 (Codex: olay ile defterler ayrışmasın;
    düzeltme personelde değil merkezde). Kök kilidi altında (eşzamanlı iki gönderim aynı sürümü alamasın)."""
    from evvel_yeni_olay import olay_yaz
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("ey_panel_kok:" + kw["kok"],))
    cur.execute("SELECT 1 FROM ey_sube_olay WHERE kok=%s LIMIT 1", (kw["kok"],))
    vardi = bool(cur.fetchone())
    oid = olay_yaz(cur, **kw)
    if vardi and oid is not None:
        raise HTTPException(409, "Bu kayıt zaten yapıldı — değiştirmek için merkeze haber verin")
    return oid


def _degirmen(d: Optional[dict]) -> Optional[dict]:
    """Eski paneldeki 4 sayaç: Bugünkü çekim · Doz I · Doz II · Doz III (boş bırakılan yazılmaz)."""
    if not d:
        return None
    out = {}
    for k, ad in (("gunluk", "Bugünkü çekim"), ("doz1", "Doz I"), ("doz2", "Doz II"), ("doz3", "Doz III")):
        if d.get(k) not in (None, ""):
            out[k] = _tam(d[k], ad)
    return out or None


def _bardak_satirlari(cur, sayim: List[SayimSatir]) -> list:
    """Devir bardak sayımı — yalnız olaya yazılır (Depo'ya hareket YAZMAZ: ara ölçüm gider üretmez)."""
    satir = [{"urun_id": x.urun_id, "sayilan": _tam(x.sayilan, "Bardak")} for x in sayim if x.sayilan is not None]
    if satir:
        b = _urunler(cur, [x["urun_id"] for x in satir], takip="sayim")
        for x in satir:
            if "bardak" not in (b[x["urun_id"]]["ad"] or "").lower():
                raise HTTPException(400, "Devirde yalnız bardak sayılır")
    return satir


def _sayim_satirlari(cur, sayim: List[SayimSatir]) -> list:
    satir = [{"urun_id": x.urun_id, "sayilan": _tam(x.sayilan, "Sayım")} for x in sayim if x.sayilan is not None]
    if satir:
        _urunler(cur, [x["urun_id"] for x in satir], takip="sayim")
    return satir


@router.post("/{sube_id}/acilis")
def acilis(sube_id: str, b: AcilisBody):
    """Açılış: kasadaki nakit + sayılan ürünler. Kasa sabah sayımı (gün−1'e) Kasa'nın kendi takvimiyle sonra yazılır
    (geç gelen kayıtlar kilide takılmasın — mevcut kural); burada ham olay + Depo günlük sayımı."""
    _TUR = "acilis"
    def is_(cur, c):
        from evvel_yeni_depo_api import sayim_yaz
        p = _personel(cur, sube_id, b.personel_id)
        engel = _saat_kurali("acilis", p)
        if engel and not c["kuru"]:
            raise HTTPException(409, engel)
        kasa = _tl(b.kasa_sayim, "Kasadaki para")
        satir = _sayim_satirlari(cur, b.sayim)
        kok = f"panel:acilis:{sube_id}:{c['gun'].isoformat()}"
        oid = _olay(cur, sube_id=sube_id, tur="acilis", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                       personel_id=p["id"], personel_ad=p["ad"], tutar=Decimal(kasa) / 100,
                       veri={"kasa_sayim": kasa, "sayim": satir, "istek_id": b.istek_id,
                             "pasta_toplam": None if b.pasta_toplam is None else _tam(b.pasta_toplam, "Pasta")})
        d = sayim_yaz(cur, konum=f"depo:{sube_id}", satirlar=satir, kim=f"{KIM} · {p['ad']}", tur="gunluk",
                      kaynak_ref=f"{kok}:sayim") if satir else None
        return {"olay": oid, "tekrar": oid is None, "sayilan": len(satir) if d else 0, "mesaj": "Açılış kaydedildi", "saat_engeli": engel}
    return _calistir(sube_id, b.istek_id, is_, tur=_TUR, govde=b.model_dump(mode="json"))


class TeslimSatir(BaseModel):
    alan: str          # ev:onur · ev:fethi · ev:fatma
    tutar: Decimal


class KapanisBody(BaseModel):
    istemci_gunu: Optional[str] = None   # tabletin formu açtığı iş günü (gün değiştiyse kayıt merkeze iletilir)
    personel_id: str
    nakit: Decimal
    pos: Decimal = Decimal(0)
    online: Decimal = Decimal(0)
    kor_sayim: Optional[Decimal] = None      # kasada sayılan (sağlama — Kasa'ya SAYIM yazılmaz, mevcut karar)
    teslimler: List[TeslimSatir] = []
    birakilan: Optional[Decimal] = None      # kasada bırakılan
    degirmen: Optional[dict] = None          # değirmen sayaçları (sahip: kalır) — {gunluk, doz1, doz2, doz3} (eski panelle aynı 4 alan)
    sayim: List[SayimSatir] = []
    pasta_toplam: Optional[Decimal] = None   # sahip: pasta yalnız TOPLAM adet
    istek_id: Optional[str] = None


def _kapanis_yaz(sube_id: str, b: "KapanisBody", gun=None, merkez: Optional[str] = None, isle_deneme: Optional[str] = None) -> dict:
    """Kapanış: ciro (nakit / POS / online) → Kasa kapanış beyanı; teslimler → Kasa teslim; sayım → Depo günlük sayımı
    (düşüş = kullanılan, sahip kararı); hepsi tek işlemde. Aynı gün ikinci kapanış Kasa'da reddedilir (düzeltme merkezde)."""
    _TUR = "kapanis"
    def is_(cur, c):
        from evvel_yeni_depo_api import sayim_yaz
        from evvel_yeni_kasa_api import HareketBody, kasa_yaz
        p = _personel(cur, sube_id, b.personel_id, kapi=False, gun=c["gun"])   # QR kapısı aşağıda: tekrar gönderim ve merkez geç kapanış geçer
        engel = None if c.get("merkez") else _saat_kurali("kapanis", p)
        if engel and not c["kuru"]:
            raise HTTPException(409, engel)
        gun = c["gun"].isoformat()
        nakit, pos, onl = _tl(b.nakit, "Nakit"), _tl(b.pos, "POS"), _tl(b.online, "Online")
        tes = []
        for i, t in enumerate(b.teslimler):
            if t.alan not in TESLIM_ALANLAR:
                raise HTTPException(400, "Teslim alan: Onur / Fethi / Fatma")
            k = _tl(t.tutar, "Teslim")
            if k:
                tes.append({"alan": t.alan, "tutar": k})
        satir = _sayim_satirlari(cur, b.sayim)
        kok = f"panel:kapanis:{sube_id}:{gun}"
        oid = _olay(cur, sube_id=sube_id, tur="kapanis", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                       personel_id=p["id"], personel_ad=p["ad"], tutar=Decimal(nakit) / 100,
                       veri={"nakit": nakit, "pos": pos, "online": onl, "teslimler": tes, "sayim": satir,
                             "kor_sayim": None if b.kor_sayim is None else _tl(b.kor_sayim, "Kör sayım"),
                             "birakilan": None if b.birakilan is None else _tl(b.birakilan, "Bırakılan"),
                             "degirmen": _degirmen(b.degirmen),
                             "pasta_toplam": None if b.pasta_toplam is None else _tam(b.pasta_toplam, "Pasta"),
                             "istek_id": b.istek_id})
        kim = (f"merkez (geç kapanış) · {c['merkez']} · {p['ad']}" if c.get("merkez") else f"{KIM} · {p['ad']}")
        k = kasa_yaz(cur, HareketBody(tur="kapanis", is_gunu=gun, cep=f"sube:{sube_id}", tutar=Decimal(nakit) / 100,
                                      kart=Decimal(pos) / 100, online=Decimal(onl) / 100), kim,
                     kaynak_ref=f"kapanis:{sube_id}:{gun}")
        if k.get("tekrar") and oid is not None and not c["kuru"]:
            # içerik değişmiş ikinci kapanış: Kasa'daki beyan sessizce eski kalmasın → hepsi geri alınır, düzeltme merkezde
            raise HTTPException(409, "Bugünün kapanışı zaten yapıldı — değiştirmek için merkeze haber verin")
        for i, t in enumerate(tes):
            kasa_yaz(cur, HareketBody(tur="teslim", is_gunu=gun, kaynak=f"sube:{sube_id}", hedef=t["alan"],
                                      tutar=Decimal(t["tutar"]) / 100, teslim_eden=p["ad"]), kim,
                     kaynak_ref=f"{kok}:teslim:{i}")
        # Codex BLOKER: geç kapanışta sayım BUGÜNÜN bakiyesine uygulanmaz (geçmiş gün uzlaştırılamaz) — olayda kalır, merkez görür
        gecmis = bool(c.get("merkez")) and c["gun"] != _bugun()
        d = sayim_yaz(cur, konum=f"depo:{sube_id}", satirlar=satir, kim=kim, tur="gunluk",
                      kaynak_ref=f"{kok}:sayim") if satir and not gecmis else None
        if satir and gecmis:
            log.warning("geç kapanış %s %s: ürün sayımı geçmiş güne uygulanmadı (olayda duruyor)", sube_id, gun)
            cur.execute("""UPDATE ey_sube_olay SET veri = veri || '{"sayim_uygulanmadi": true}'::jsonb WHERE id=%s""", (oid,)) if oid else None
        y = _yoklama()
        if y is not None and not c["kuru"] and not c.get("merkez") and oid is not None:
            y.personel_kilidi(cur, p["id"])   # Codex: telefon çıkış/giriş ile yarışmasın
            if _qr_gerekli(cur) and not y.acik_mi(cur, sube_id, p["id"]):
                raise HTTPException(400, "Önce telefonundan QR ile giriş yap")   # yeni kapanış; işlem geri alınır
            y.cikis_yaz(cur, p["id"], "kapanis", kim=kim, sube_id=str(sube_id))   # tasarım: kapanış = kapanışçının çıkışı
        return {"olay": oid, "tekrar": oid is None and bool(k.get("tekrar")), "sayilan": len(satir) if d else 0,
                "mesaj": "Kapanış kaydedildi" + (" — ürün sayımı geçmiş güne uygulanmadı (olayda duruyor)" if satir and gecmis else ""),
                "saat_engeli": engel}
    return _calistir(sube_id, b.istek_id, is_, tur=_TUR, govde=b.model_dump(mode="json"), gun=gun, merkez=merkez,
                     isle_deneme=isle_deneme)


@router.post("/{sube_id}/kapanis")
def kapanis(sube_id: str, b: KapanisBody):
    return _kapanis_yaz(sube_id, b)


class DevirBody(BaseModel):
    istemci_gunu: Optional[str] = None   # tabletin formu açtığı iş günü (gün değiştiyse kayıt merkeze iletilir)
    devreden_id: str
    devralan_id: str
    sayilan: Decimal
    bardak: List[SayimSatir] = []    # sahip D2: devirde yalnız 3 bardak (küçük / büyük / plastik) — gider üretmez, merkez görür
    istek_id: str


@router.post("/{sube_id}/devir")
def kasa_devri(sube_id: str, b: DevirBody):
    """Vardiya kasa devri — yalnız ham olay (para el değiştirmez, aynı dükkân kasası)."""
    _TUR = "devir"
    def is_(cur, c):
        _gun_acik_mi(cur, c, sube_id)
        y = _yoklama()
        # devralan henüz girmemiş olabilir (kabulüyle girişi açılır) → kapı yalnız devredende
        a, v = _personel(cur, sube_id, b.devreden_id), _personel(cur, sube_id, b.devralan_id, kapi=y is None)
        if a["id"] == v["id"]:
            raise HTTPException(400, "Devreden ve devralan aynı kişi olamaz")
        k = _tl(b.sayilan, "Sayılan")
        if y is not None:   # D5: onaylar kişilerin KENDİ telefonunda; vardiya olayını devralanın onayı yazar (tek yazar)
            bardak = _bardak_satirlari(cur, b.bardak)
            if bardak:
                ad = _urunler(cur, [x["urun_id"] for x in bardak], takip="sayim")
                bardak = [{**x, "ad": ad[x["urun_id"]]["ad"]} for x in bardak]
            r = y.devir_ac(cur, str(sube_id), c["gun"], a, v, k, bardak, b.istek_id, giris_zorunlu=_qr_gerekli(cur))
            return {**r, "tekrar": bool(r.get("tekrar")),
                    "mesaj": f"Devir hazır — {a['ad']} telefonundan 'Devrediyorum', sonra {v['ad']} 'Kabul ediyorum' desin"}
        oid = _olay(cur, sube_id=sube_id, tur="vardiya", is_gunu=c["gun"], kok=f"panel:vardiya:{sube_id}:{b.istek_id}",
                       kaynak_tablo="panel", personel_id=a["id"], personel_ad=a["ad"], tutar=Decimal(k) / 100,
                       veri={"devreden": a, "devralan": v, "sayilan": k, "bardak": _bardak_satirlari(cur, b.bardak)})
        return {"olay": oid, "tekrar": oid is None, "mesaj": "Kasa devri kaydedildi"}
    return _calistir(sube_id, b.istek_id, is_, tur=_TUR, govde=b.model_dump(mode="json"))


class DevirIptalBody(BaseModel):
    istek_id: Optional[str] = None


@router.post("/{sube_id}/devir-iptal")
def kasa_devri_iptal(sube_id: str, b: DevirIptalBody):
    """Panel: devreden henüz onaylamadıysa açık devri iptal eder (onaylandıysa merkez kapatır)."""
    y = _yoklama()
    if y is None:
        raise HTTPException(400, "Devir onayı açık değil")
    with db() as (conn, cur):
        if not y.devir_iptal(cur, str(sube_id), _bugun()):
            raise HTTPException(409, "İptal edilecek bekleyen devir yok (devreden onayladıysa merkeze haber verin)")
    return {"ok": True, "mesaj": "Devir iptal edildi"}


class AraTeslimBody(BaseModel):
    istemci_gunu: Optional[str] = None   # tabletin formu açtığı iş günü (gün değiştiyse kayıt merkeze iletilir)
    personel_id: str
    alan: str
    tutar: Decimal
    istek_id: str


@router.post("/{sube_id}/ara-teslim")
def ara_teslim(sube_id: str, b: AraTeslimBody):
    """Gün içi para teslimi (Onur / Fethi / Fatma) → Kasa teslim ('onay bekliyor')."""
    _TUR = "ara_teslim"
    def is_(cur, c):
        from evvel_yeni_kasa_api import HareketBody, kasa_yaz
        _gun_acik_mi(cur, c, sube_id)
        p = _personel(cur, sube_id, b.personel_id)
        if b.alan not in TESLIM_ALANLAR:
            raise HTTPException(400, "Teslim alan: Onur / Fethi / Fatma")
        k = _tl(b.tutar, "Tutar")
        if not k:
            raise HTTPException(400, "Tutarı yaz")
        kok = f"panel:ara:{sube_id}:{b.istek_id}"
        oid = _olay(cur, sube_id=sube_id, tur="teslim", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                       personel_id=p["id"], personel_ad=p["ad"], tutar=Decimal(k) / 100, veri={"alan": b.alan, "tutar": k})
        r = kasa_yaz(cur, HareketBody(tur="teslim", is_gunu=c["gun"].isoformat(), kaynak=f"sube:{sube_id}", hedef=b.alan,
                                      tutar=Decimal(k) / 100, teslim_eden=p["ad"]), f"{KIM} · {p['ad']}", kaynak_ref=kok)
        return {"olay": oid, "tekrar": oid is None and bool(r.get("tekrar")), "mesaj": "Teslim kaydedildi"}
    return _calistir(sube_id, b.istek_id, is_, tur=_TUR, govde=b.model_dump(mode="json"))


class Kalem(BaseModel):
    urun_id: str
    adet: Decimal


class UrunAcBody(BaseModel):
    istemci_gunu: Optional[str] = None   # tabletin formu açtığı iş günü (gün değiştiyse kayıt merkeze iletilir)
    personel_id: str
    kalemler: List[Kalem]
    istek_id: str


def _kalemler(cur, kalemler: List[Kalem], takip: Optional[str] = None) -> list:
    k = [{"urun_id": x.urun_id, "adet": _tam(x.adet, "Adet")} for x in kalemler]
    k = [x for x in k if x["adet"] > 0]
    if not k:
        raise HTTPException(400, "En az bir ürün seç")
    if len({x["urun_id"] for x in k}) != len(k):
        raise HTTPException(400, "Aynı ürün iki kez seçildi")
    b = _urunler(cur, [x["urun_id"] for x in k], takip=takip)
    for x in k:
        x["ad"] = b[x["urun_id"]]["ad"]
    return k


@router.post("/{sube_id}/urun-ac")
def urun_ac(sube_id: str, b: UrunAcBody):
    """Ürün aç (yalnız 'açılınca gider' ürünler): Depo 'ac' depo:şube → dışarı:tuketim. Fiyat yazılmaz (Gider okurken hesaplar).
    Eksi stok ENGELLENMEZ — merkeze iş düşer (personele uyarı yok)."""
    _TUR = "urun_ac"
    def is_(cur, c):
        from evvel_yeni_depo_api import hareket_yaz
        _gun_acik_mi(cur, c, sube_id)
        p = _personel(cur, sube_id, b.personel_id)
        k = _kalemler(cur, b.kalemler, takip="acilinca")
        kok = f"panel:ac:{sube_id}:{b.istek_id}"
        oid = _olay(cur, sube_id=sube_id, tur="urun_ac", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                       personel_id=p["id"], personel_ad=p["ad"], veri={"kalemler": k})
        for i, x in enumerate(k):
            hareket_yaz(cur, kaynak_ref=f"{kok}:{i}", tur="ac", urun_id=x["urun_id"], urun_ad=x["ad"], adet=x["adet"],
                        kaynak=f"depo:{sube_id}", hedef="dışarı:tuketim", kim=f"{KIM} · {p['ad']}", bag=kok, gun=c["gun"])
        return {"olay": oid, "tekrar": oid is None, "mesaj": f"{len(k)} ürün açıldı"}
    return _calistir(sube_id, b.istek_id, is_, tur=_TUR, govde=b.model_dump(mode="json"))


class IadeBilgi(BaseModel):
    fis_no: str
    iade_saat: str                    # "HH:MM"
    musteri_ad: Optional[str] = None  # personele GÖSTERİLMEZ (yalnız merkez)
    musteri_tel: Optional[str] = None


class FireBody(BaseModel):
    istemci_gunu: Optional[str] = None   # tabletin formu açtığı iş günü (gün değiştiyse kayıt merkeze iletilir)
    personel_id: str
    kalemler: List[Kalem]
    sebep: str                         # FIRE_SEBEPLERI kodu
    aciklama: Optional[str] = None     # 'diger' için zorunlu
    iade: Optional[IadeBilgi] = None   # 'iade' için zorunlu
    istek_id: str


@router.post("/{sube_id}/fire")
def fire(sube_id: str, b: FireBody):
    """Fire: Depo 'fire' depo:şube → dışarı:fire (sebep zorunlu)."""
    _TUR = "fire"
    def is_(cur, c):
        from evvel_yeni_depo_api import hareket_yaz
        _gun_acik_mi(cur, c, sube_id)
        p = _personel(cur, sube_id, b.personel_id)
        if b.sebep not in FIRE_SEBEPLERI:
            raise HTTPException(400, "Fire sebebini seç")
        aciklama = (b.aciklama or "").strip()[:200]
        if b.sebep == "diger" and len(aciklama) < 2:
            raise HTTPException(400, "Sebebi yaz")
        iade = None
        if b.sebep == "iade":
            m_ = re.fullmatch(r"(\d{1,2}):(\d{2})", (b.iade.iade_saat or "").strip()) if b.iade else None
            if not b.iade or not (b.iade.fis_no or "").strip() or not m_ or int(m_.group(1)) > 23 or int(m_.group(2)) > 59:
                raise HTTPException(400, "İadede fiş numarası ve iade saati zorunlu")
            iade = {"fis_no": b.iade.fis_no.strip()[:40], "iade_saat": b.iade.iade_saat.strip(),
                    "musteri_ad": (b.iade.musteri_ad or "").strip()[:80] or None,
                    "musteri_tel": re.sub(r"[^\d+]", "", b.iade.musteri_tel or "")[:20] or None}
        sebep_ad = FIRE_SEBEPLERI[b.sebep]
        k = _kalemler(cur, b.kalemler)
        kok = f"panel:fire:{sube_id}:{b.istek_id}"
        oid = _olay(cur, sube_id=sube_id, tur="fire", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                    personel_id=p["id"], personel_ad=p["ad"],
                    veri={"kalemler": k, "sebep": b.sebep, "sebep_ad": sebep_ad, "aciklama": aciklama or None, "iade": iade})
        hedef = FIRE_HEDEF.get(b.sebep, "dışarı:fire")
        for i, x in enumerate(k):
            hareket_yaz(cur, kaynak_ref=f"{kok}:{i}", tur="fire", urun_id=x["urun_id"], urun_ad=x["ad"], adet=x["adet"],
                        kaynak=f"depo:{sube_id}", hedef=hedef, kim=f"{KIM} · {p['ad']}",
                        aciklama=sebep_ad + (f" — {aciklama}" if aciklama else "") + (f" · fiş {iade['fis_no']}" if iade else ""),
                        bag=kok, gun=c["gun"])
        return {"olay": oid, "tekrar": oid is None, "mesaj": "Fire kaydedildi"}
    return _calistir(sube_id, b.istek_id, is_, tur=_TUR, govde=b.model_dump(mode="json"))


# ─────────────────────────── MERKEZ: geç kapanış (reddedilen / hata veren kapanış) ───────────────────────────
class DenemeBody(BaseModel):
    deneme_id: str


@router.post("/gec-kapanis")
def gec_kapanis(body: DenemeBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez: reddedilen / hata veren panel kapanışını, personelin girdiği verilerle O İŞ GÜNÜNE işler
    (saat kuralı ve gün kilidi uygulanmaz; yeni istek kimliğiyle — eski deneme izli kalır)."""
    from evvel_yeni_cekirdek import aktor
    _deneme_hazirla()
    with db() as (conn, cur):
        kim = aktor(cur, x_evvel_oturum)
        if kim in ("oturumsuz", "bilinmiyor"):   # Codex: deneme kimliğini bilen herkes saat kuralını atlayamasın
            raise HTTPException(401, "Merkez oturumu gerekli")
        cur.execute("SELECT * FROM ey_panel_deneme WHERE id=%s FOR UPDATE", (body.deneme_id,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Deneme bulunamadı")
        r = dict(r)
        if r["tur"] != "kapanis" or r["sonuc"] not in ("ret", "hata", "bekliyor") or r["islendi"]:
            raise HTTPException(409, "Bu deneme işlenemez (kapanış değil, başarılı ya da zaten işlendi)")
    govde = r["govde"] if isinstance(r["govde"], dict) else json.loads(r["govde"] or "{}")
    govde["istek_id"] = "gec-" + body.deneme_id.replace("-", "")[:32]   # sabit: yarıda kalırsa tekrar = aynı kayıt (çift yazım yok)
    govde.pop("istemci_gunu", None)
    try:
        kb = KapanisBody(**govde)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Kayıtlı kapanış verisi okunamadı: {str(e)[:150]}")
    sonuc = _kapanis_yaz(r["sube_id"], kb, gun=r["is_gunu"], merkez=kim, isle_deneme=body.deneme_id)
    return {"ok": True, "mesaj": "Geç kapanış işlendi", "sonuc": sonuc}


def _kapanis_isleri(cur) -> list:
    """Son 7 gün: kapanış denemesi reddedilmiş / hata vermiş ve o gün için başarılı panel kapanışı YOK → merkez işi."""
    from evvel_yeni_olay import olaylar
    from evvel_yeni_tanim_api import subeler
    cur.execute("SELECT to_regclass('ey_panel_deneme') IS NOT NULL AS v")
    if not dict(cur.fetchone())["v"]:
        return []
    cur.execute("""SELECT DISTINCT ON (sube_id, is_gunu) id, sube_id, is_gunu, sonuc, sebep, zaman FROM ey_panel_deneme
                    WHERE tur='kapanis' AND zaman >= NOW() - INTERVAL '7 days' AND NOT islendi
                      AND (sonuc IN ('ret','hata') OR (sonuc = 'bekliyor' AND zaman < NOW() - INTERVAL '10 minutes'))
                      AND is_gunu >= %s
                    ORDER BY sube_id, is_gunu, zaman DESC""", (_baslangic(cur),))   # deneme dönemi merkeze iş üretmez
    satirlar = [dict(x) for x in cur.fetchall() or []]   # Codex BLOKER: subeler() imleci tüketmeden ÖNCE
    adlar = {str(s["id"]): s["ad"] for s in subeler(cur)}
    out = []
    for r in satirlar:
        kapali = any(not o.get("iptal") and (o.get("kaynak_tablo") or "") == "panel"
                     for o in olaylar(cur, sube_id=r["sube_id"], bas=r["is_gunu"], son=r["is_gunu"], turler={"kapanis"}))
        if kapali:
            continue
        out.append({"tur": "kapanis_red", "grup": "kasa", "id": r["id"], "tarih": r["is_gunu"].isoformat(),
                    "ad": adlar.get(str(r["sube_id"]), r["sube_id"]), "sebep": r.get("sebep") or "sonuç alınamadı",
                    "saat": str(r["zaman"])[5:16].replace("-", ".").replace(" ", " "), "islem": "/evvel-yeni/panel/gec-kapanis"})
    return out


# ─────────────────────────── MERKEZ: Bekleyen işler (personele gitmez) ───────────────────────────
def _bekleyen(cur, baglam: dict) -> list:
    """Panel açıldıysa: dün kapanışı olmayan aktif şube."""
    out = []
    try:
        out.extend(_kapanis_isleri(cur))   # 🛟 reddedilen kapanış — panel açılmadan da (deneme dışı) görünür
    except Exception as e:  # noqa: BLE001
        log.warning("panel kapanış denemeleri okunamadı: %s", str(e)[:150])
    if _bugun() <= _baslangic(cur):
        return out
    from evvel_yeni_olay import olaylar
    from evvel_yeni_tanim_api import subeler
    dun = _bugun() - timedelta(days=1)
    kapanan = {str(o["sube_id"]) for o in olaylar(cur, bas=dun, son=dun, turler={"kapanis"}) if not o.get("iptal")}
    for s in subeler(cur):
        if str(s["id"]) not in kapanan:
            out.append({"tur": "panel_kapanis_yok", "genel": True, "grup": "kasa", "id": f"panel_kapanis:{s['id']}:{dun}",
                        "tarih": dun.isoformat(), "etiket": "🧾 Kapanış yok", "ad": f"{s['ad']} — {dun.strftime('%d.%m')} kapanışı yapılmadı",
                        "alt": "Şube panelinden kapanış gelmedi", "sayfa": None, "dugme": None})
    return out


bekleyen_is_kaydet("panel", _bekleyen)
