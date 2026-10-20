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
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import List, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from database import db, savepoint
from evvel_yeni_cekirdek import ayar_oku, bekleyen_is_kaydet, deneme_mi, is_gunu as _bugun, kurus as _kurus   # şube İŞ GÜNÜ (gece 02:00'ye kadar önceki gün)

router = APIRouter(prefix="/api/evvel-yeni/panel", tags=["evvel-yeni-panel"])
log = logging.getLogger(__name__)
from evvel_yeni_kasa_api import TESLIM_HEDEFLERI as _TH   # TEK liste Kasa'da (C-T1-34; Fethi → geçiş hesabı)
TESLIM_ALANLAR = tuple(_TH.values())     # sahip kararı: teslim yalnız Onur / Fethi / Fatma
KIM = "şube paneli"


class _Kuru(Exception):
    """Deneme modunda işlemi geri almak için (sonuç taşır)."""

    def __init__(self, sonuc: dict):
        super().__init__("kuru")
        self.sonuc = sonuc


def _baslangic(cur) -> date:
    from evvel_yeni_cekirdek import panel_baslangic
    return panel_baslangic(cur)   # tek yerde ayrıştırılır (çekirdek; geçersiz ayarda kendisi 1 Kasım'a düşer)


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
    from evvel_yeni_cekirdek import yeni_donem
    return _yoklama() is not None and yeni_donem(cur)


def _personel(cur, sube_id: str, pid: Optional[str], kapi: bool = True, gun=None) -> dict:
    """Ad seçimi (sahip: yetki fazına kadar PIN yok). Her kayıt personel kimliği taşır."""
    from evvel_yeni_tanim_api import secim_listeleri
    if not pid:
        raise HTTPException(400, "Adını seç")
    p = next((x for x in secim_listeleri(cur)["personel"] if str(x["id"]) == str(pid) and x["aktif"]), None)
    if not p:
        raise HTTPException(400, "Personel bulunamadı")
    y = _yoklama()
    # sahip (2026-10-19): "bütün personeller bütün şubelere gider" — QR'la BU şubeye girmiş olan (deneme döneminde de) burada çalışır
    burada = y is not None and (
        y.acik_mi(cur, sube_id, str(p["id"])) if kapi
        else y.girdi_mi(cur, sube_id, str(p["id"]), gun or _bugun()))   # K11: QR'la bu şubeye girmiş (kapanış: o gün girmiş)
    if str(p.get("sube_id") or "") != str(sube_id) and not burada:   # Codex: QR'sız başka şubenin personeli bu şubeye yazamasın
        raise HTTPException(400, "Önce bu şubeye telefonundan QR ile giriş yap")
    if kapi and y is not None and _qr_gerekli(cur) and not y.acik_mi(cur, sube_id, str(p["id"])):   # K: panel ad listesi = bugün girenler
        raise HTTPException(400, "Önce telefonundan QR ile giriş yap")
    return {"id": str(p["id"]), "ad": p["ad"], "erken_acilis": bool(p.get("erken_acilis"))}


def _pin(cur, p: dict, pin: Optional[str]) -> None:
    """Sık işlem (ürün aç, fire, ara teslim…): QR ile girmiş kişi + kendi 4 haneli PIN'i (sahip R1b). Doğrulama Tanımlar'da."""
    from evvel_yeni_tanim_api import pin_dogrula
    pin_dogrula(cur, p["id"], pin)


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


def _urunler(cur, idler: List[str], takip: Optional[str] = None, pasif_olur: bool = False) -> dict:
    """takip verilirse ürün o takip türünde olmalı (Codex: sayım = 'sayim'). pasif_olur: Ürün Aç "Pasifleri göster" (eski panel)."""
    from evvel_yeni_urun_api import urun_bilgi
    b = urun_bilgi(cur, idler)
    for i in idler:
        if i not in b or (not b[i]["aktif"] and not pasif_olur):
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
        return ("Açılış onayı yalnızca 07:00 ve sonrasında yapılabilir (Türkiye saati). "
                "Bu personelin erken açılış izni yok — izin merkezden verilir.")
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
        # Basamak 3: uyarılı kapanış → merkez Bekleyen işler "⚠ Kapanış uyarılı — Gördüm" (Kasa'daki eski panel satırıyla AYNI biçim)
        cur.execute("ALTER TABLE ey_panel_deneme ADD COLUMN IF NOT EXISTS uyarilar JSONB")
        cur.execute("ALTER TABLE ey_panel_deneme ADD COLUMN IF NOT EXISTS goruldu TEXT")
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


def _deneme_kapat(did: Optional[str], sonuc: str, sebep: Optional[str] = None, uyarilar: Optional[list] = None) -> None:
    if not did:
        return
    try:
        with db() as (_c, cur):
            cur.execute("UPDATE ey_panel_deneme SET sonuc=%s, sebep=%s, uyarilar=%s::jsonb WHERE id=%s",
                        (sonuc, (sebep or "")[:300] or None, json.dumps(uyarilar, ensure_ascii=False) if uyarilar else None, did))
    except Exception as e:  # noqa: BLE001
        log.error("panel denemesi sonucu yazılamadı (%s): %s", did, str(e)[:200])


def _calistir(sube_id: str, istek_id: Optional[str], is_fn, tur: Optional[str] = None, govde: Optional[dict] = None,
              gun=None, merkez: Optional[str] = None, isle_deneme: Optional[str] = None) -> dict:
    """Ortak iskelet: deneme kaydı → hazırlık → tek işlem → (deneme modunda geri al) → deneme sonucu.
    gun/merkez: yalnız merkezin 'geç kapanış' işlemi (o iş gününe; saat kuralı ve gün kilidi uygulanmaz)."""
    gun0 = gun or _bugun()
    govde = {k: v for k, v in (govde or {}).items() if k != "pin"}   # PIN asla saklanmaz
    ig = govde.get("istemci_gunu")
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
    mu = sonuc.pop("merkez_uyarilari", None)   # sahip: kasa uyarısı panele / telefona GİTMEZ — yalnız merkez kaydına
    mu = sonuc.get("uyarilar") if mu is None else mu
    _deneme_kapat(did, "deneme" if sonuc.get("kuru") and not sonuc.get("kalici") else ("ok_uyarili" if mu else "ok"), uyarilar=mu)
    if merkez and isle_deneme and mu and not sonuc.get("kuru"):   # Codex P2-3: geç kapanış uyarısı Bekleyen işler'e
        _deneme_kapat(isle_deneme, "ok_uyarili", f"geç kapanış merkezde işlendi · {merkez}", uyarilar=mu)
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
        if _modul_acik("toptanci"):   # Fable: Toptancı tabloları da ana işlemin DIŞINDA (deneme geri alınca hazır bayrağı yalan kalmasın)
            from evvel_yeni_toptanci_api import toptanci_hazirla
            toptanci_hazirla(hc)
    try:
        with db() as (conn, cur):
            g = gun or _bugun()
            cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"ey_panel_gun:{sube_id}:{g.isoformat()}",))
            ctx = {"gun": g, "sube": _sube(cur, sube_id), "kuru": deneme_mi(cur, g), "merkez": merkez}
            sonuc = is_fn(cur, ctx)
            if isle_deneme and not ctx["kuru"]:   # Codex: geç kapanış ile 'işlendi' işareti AYNI işlemde (yarıda kalmaz)
                cur.execute("UPDATE ey_panel_deneme SET islendi=TRUE, isleyen=%s WHERE id=%s", (merkez, isle_deneme))
            sonuc = {"ok": True, "kuru": ctx["kuru"], "kalici": bool(ctx.get("kalici")), **sonuc}
            if ctx["kuru"] and not ctx.get("kalici"):   # sahip D2 (S5): stok yazmayan sipariş talebi/hazırlığı denemede de kalır
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
        kat_hepsi = katalog(cur, hepsi=True)   # Fable: tek sorgu — aktif liste bundan süzülür
        toptancilar = [{"id": str(t["id"]), "ad": t["ad"], "kategori": t.get("kategori")} for t in secim_listeleri(cur).get("toptancilar") or []]
        kat = [{**k, "urunler": [x for x in k["urunler"] if x.get("aktif", True)]} for k in kat_hepsi if k.get("aktif", True)]
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
            if yok["qr_gerekli"]:   # ad listesi = bu şubede QR'la girmiş olanlar (K11: başka şubenin personeli dahil)
                per = [{"id": g["personel_id"], "ad": g["ad"]} for g in yok["girenler"] if g["acik"]]
        depo_acik, depo_yolda, depo_mu = _modul_acik("depo"), [], False
        if depo_acik:   # Basamak 5 (Fable F3/F6): gelen paketler (ADET YOK — kör sayım) + Tema depo bayrağı; yumuşak bağ
            try:
                with savepoint(cur, "sp_panel_depo"):
                    from evvel_yeni_depo_api import yoldakiler, _depo_sube
                    depo_yolda = yoldakiler(cur, str(sube_id))
                    depo_mu = _depo_sube(cur) == str(sube_id)
            except Exception:  # noqa: BLE001
                log.warning("panel durum: depo okunamadı", exc_info=True)
    def _u(x):
        return {"id": x["id"], "ad": x["ad"], "birim": x["birim"], "koli_ici": x.get("koli_ici")}
    return {"sube": {"id": s["id"], "ad": s["ad"], "depo": depo_mu}, "depo_acik": depo_acik, "depo_yolda": depo_yolda, "gun": gun.isoformat(), "kuru": gun < bas, "panel_baslangic": bas.isoformat(),
            "personel": per, "teslim_alanlar": [{"id": c, "ad": a} for a, c in _TH.items()],
            "sayilan": [{"kategori": k["ad"], "urunler": [_u(x) for x in k["urunler"] if x.get("takip") == "sayim" and x.get("panel_sayim")]}
                        for k in kat],
            "acilan": [{"kategori": k["ad"], "urunler": [_u(x) for x in k["urunler"] if x.get("takip") == "acilinca"]} for k in kat],
            # Basamak 5 Ürün Aç: BÜTÜN katalog (aktif kategoriler; ürünlerde aktif bayrağı — "Pasifleri göster")
            "ac_katalog": [{"id": str(k.get("id")), "kategori": k["ad"], "emoji": k.get("emoji"),
                            "urunler": [{**_u(x), "takip": x.get("takip") or "sayim", "aktif": bool(x.get("aktif", True))} for x in k["urunler"]
                                        if x.get("takip") != "gununde"]}   # pasta (gununde) açılmaz — girişte tüketildi
                           for k in kat_hepsi if k.get("aktif", True)],
            "bugun": bugunku, "yoklama": yok,
            # gün çizgisi (eski ana sayfa ①): AÇILIŞ · KAPANIŞ — kim, saat (KONTROL noktası yok: sahip istisnası 10)
            "gun_cizgisi": {t: next(({"kim": o["kim"], "saat": o["zaman"]} for o in bugunku if o["tur"] == t and not o["iptal"]), None)
                            for t in ("acilis", "kapanis")},
            "acilis_var": any(o["tur"] == "acilis" and not o["iptal"] for o in bugunku),
            "kapanis_var": any(o["tur"] == "kapanis" and not o["iptal"] for o in bugunku),
            "kapanis_merkezde": _merkezde_mi(sube_id, gun),   # Fable B5: telefonsuz merkeze gönderildi (panel aynı geceyi yeniden doldurmasın)
            "fire_sebepleri": [{"kod": k, "ad": v} for k, v in FIRE_SEBEPLERI.items()],
            "toptancilar": toptancilar, "toptanci_acik": _modul_acik("toptanci"), "siparis_acik": _modul_acik("siparis"),   # Basamak 8: Tedarikçiden teslim al (yumuşak bağ)
            "saat": {"acilis": "%02d:%02d" % ACILIS_SAAT, "kapanis": "%02d:%02d" % KAPANIS_SAAT}}


def _merkezde_mi(sube_id: str, gun) -> Optional[str]:
    """Bugün telefonsuz 'Merkeze gönder' yapıldı ve henüz işlenmedi mi → gönderim saati (yoksa None)."""
    try:
        with db() as (_c, cur):
            cur.execute("SELECT to_regclass('ey_panel_deneme') IS NOT NULL AS v")
            if not dict(cur.fetchone())["v"]:
                return None
            cur.execute("""SELECT zaman FROM ey_panel_deneme WHERE sube_id=%s AND is_gunu=%s AND tur='kapanis' AND sonuc='ret'
                             AND sebep LIKE 'Telefonsuz%%' AND NOT islendi ORDER BY zaman DESC LIMIT 1""", (str(sube_id), gun))
            r = cur.fetchone()
            return _saat_tr(dict(r)["zaman"]) if r else None
    except Exception:  # noqa: BLE001
        return None


def _saat_tr(ts) -> Optional[str]:
    from zoneinfo import ZoneInfo
    try:
        return (ts.astimezone(ZoneInfo("Europe/Istanbul")) if getattr(ts, "tzinfo", None) else ts).strftime("%H:%M")
    except Exception:  # noqa: BLE001
        return None


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
    kw.setdefault("sema_surumu", 2)   # Fable (altyapı #9): yeni panel biçimi (kuruş int, sayim listesi, ey_urun) ≠ eski çift yazım (1)
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("ey_panel_kok:" + kw["kok"],))
    cur.execute("""SELECT (SELECT MAX(olay_zamani) FROM ey_sube_olay WHERE kok=%s AND tur<>'iptal') AS son,
                          (SELECT MAX(olay_zamani) FROM ey_sube_olay WHERE hedef_kok=%s AND tur='iptal') AS iptal""",
                (kw["kok"], kw["kok"]))
    r = dict(cur.fetchone() or {})
    iptalli = r.get("son") is not None and r.get("iptal") is not None and r["iptal"] >= r["son"]
    vardi = r.get("son") is not None and not iptalli   # Fable: iptal edilen gün yeniden açılabilsin
    if r.get("iptal") is not None:   # Codex: iptal varsa içerik son iptale bağlanır → yeniden açılış yeni sürüm, aynı isteğin tekrarı yine "tekrar"
        kw["veri"] = {**(kw.get("veri") or {}), "iptal_sonrasi": str(r["iptal"])}
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


def _sayim_satirlari(cur, sayim: List[SayimSatir]) -> list:
    satir = [{"urun_id": x.urun_id, "sayilan": _tam(x.sayilan, "Sayım")} for x in sayim if x.sayilan is not None]
    if satir:
        _urunler(cur, [x["urun_id"] for x in satir], takip="sayim")
    return satir


def _acilis_tam(cur, b: "AcilisBody") -> None:
    """Eski sihirbaz: her alan dolu (boş → 'X adedini girin'), 0 yazılabilir. Liste = katalogda panelde sayılan ürünler (S5)."""
    from evvel_yeni_urun_api import katalog
    gerek = {str(x["id"]): x["ad"] for k in katalog(cur) for x in k["urunler"] if x.get("takip") == "sayim" and x.get("panel_sayim")}
    gelen = {}
    for x in b.sayim:
        if x.urun_id in gelen:
            raise HTTPException(400, "Aynı ürün iki kez sayılmış — formu yenile")
        gelen[x.urun_id] = x.sayilan
    for uid, ad in gerek.items():
        if gelen.get(uid) is None:
            raise HTTPException(400, f"{ad} adedini girin")
    if b.pasta_toplam is None:
        raise HTTPException(400, "Pasta adedini girin")
    _tam(b.pasta_toplam, "Pasta")
    _tl(b.kasa_sayim, "Kasadaki para")
    _sayim_satirlari(cur, b.sayim)
    if not b.istemci_gunu:
        raise HTTPException(400, "Form günü yok — sayfayı yenile")


def _onay_sart(sube_id: str, ad: str, tur: str, govde: dict) -> None:
    """Canlıda (QR kapısı açık) açılış / kapanış panelden DOĞRUDAN yazılamaz — telefon onayı (R1) zorunlu. Deneme döneminde serbest."""
    with db() as (_c, cur):
        if _bugun() < _baslangic(cur):
            return   # deneme dönemi
        if _yoklama() is None:   # Codex: yoklama yüklenemedi diye onay şartı kalkmasın
            kod, msg = 503, f"{ad} şu an kaydedilemiyor — QR sistemi çalışmıyor, merkeze haber ver"
        else:
            kod, msg = 409, f"{ad} telefonla onaylanır — ekrandaki 'QR ile onayla' düğmesini kullan"
    # Fable: reddedilen gün kaydı kaybolmasın → deneme defterine 'ret' (merkez Bekleyen işler / geç kapanış görür); PIN asla
    gun = _bugun()
    try:
        if govde.get("istemci_gunu"):
            gun = date.fromisoformat(str(govde["istemci_gunu"])[:10])   # Codex: formun açıldığı iş günü
    except ValueError:
        pass
    did = _deneme_ac(sube_id, tur, gun, {k: v for k, v in govde.items() if k != "pin"})
    _deneme_kapat(did, "ret" if kod == 409 else "hata", msg)
    raise HTTPException(kod, msg)


@router.post("/{sube_id}/acilis")
def acilis_uc(sube_id: str, b: AcilisBody):
    _onay_sart(sube_id, "Açılış", "acilis", b.model_dump(mode="json"))
    return acilis(sube_id, b)


def acilis(sube_id: str, b: AcilisBody):
    """Açılış: kasadaki nakit + sayılan ürünler. Kasa sabah sayımı (gün−1'e) Kasa'nın kendi takvimiyle sonra yazılır
    (geç gelen kayıtlar kilide takılmasın — mevcut kural); burada ham olay + Depo günlük sayımı."""
    _TUR = "acilis"
    def is_(cur, c):
        from evvel_yeni_depo_api import sayim_yaz
        p = _personel(cur, sube_id, b.personel_id)
        _acilis_tam(cur, b)
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
        d = sayim_yaz(cur, konum=f"bar:{sube_id}", satirlar=satir, kim=f"{KIM} · {p['ad']}", tur="gunluk", gun=c["gun"],
                      kaynak_ref=f"{kok}:sayim:{oid}") if satir and oid else None   # Codex: sürüme bağlı (iptal sonrası yeni sayım); Fable: iş günü
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
    x_rapor: bool = False                    # eski 5. adım: "X raporu yazıcıdan çıktı alındı ve gönderildi"
    urun_ac_yok: bool = False                # S11-5: bugün Ürün Aç kaydı yok → personel "açılmadı" dedi
    merkeze: bool = False                    # sahip (19 Eki): telefonsuz kapanış → kayıt yazılmaz, merkeze iletilir (geç kapanış)
    pin: Optional[str] = None                # yalnız "Merkeze gönder" — doğrulanır, hiçbir yere yazılmaz


def _kapanis_tam(cur, b: "KapanisBody", merkez: bool = False) -> None:
    """Eski kapanış korumaları (sube_operasyon.py KAPANIS 1267-1333, sube_panel.html kapNext1 — Fable F2, fonksiyon kaybı yok):
    en az bir ciro · online = nakit+POS → RED (çift sayım) · çekmecedeki TÜM para (kör) ZORUNLU · bırakılan ZORUNLU ·
    tezgah sayımı her kalem (0 yazılabilir) + pasta ZORUNLU (açılışla aynı liste)."""
    from evvel_yeni_urun_api import katalog
    n, p_, o = _tl(b.nakit, "Nakit"), _tl(b.pos, "POS"), _tl(b.online, "Online")
    if n + p_ + o <= 0:
        raise HTTPException(400, "En az bir ciro tutarı girin")
    if o > 0 and n > 0 and p_ > 0 and abs(o - (n + p_)) < 50:
        raise HTTPException(400, "Online alanı nakit+POS toplamına eşit olamaz. Online satış yoksa 0 bırakın.")
    if merkez:   # Fable B3: merkez geç kapanışı — personelin o gün girdiği veri ESAS; katalog sonradan değiştiyse / eski kayıtsa tıkanmaz
        return
    if b.kor_sayim is None:
        raise HTTPException(400, "Çekmecedeki TÜM parayı sayıp girin (teslim etmeden önce, kör sayım)")
    _tl(b.kor_sayim, "Çekmecedeki para")
    if b.birakilan is None:
        raise HTTPException(400, "Kasada bırakılan (devir) tutarı zorunlu")
    _tl(b.birakilan, "Bırakılan")
    gerek = {str(x["id"]): x["ad"] for k in katalog(cur) for x in k["urunler"] if x.get("takip") == "sayim" and x.get("panel_sayim")}
    gelen = {}
    for x in b.sayim:
        if x.urun_id in gelen:
            raise HTTPException(400, "Aynı ürün iki kez sayılmış — formu yenile")
        gelen[x.urun_id] = x.sayilan
    for uid, ad in gerek.items():
        if gelen.get(uid) is None:
            raise HTTPException(400, f"{ad} adedini girin")
    if b.pasta_toplam is None:
        raise HTTPException(400, "Pasta adedini girin")
    _tam(b.pasta_toplam, "Pasta")


def _kapanis_uyarilari(cur, sube_id: str, gun, p: dict, b: "KapanisBody") -> tuple:
    """EKSİK VAR (sarı kart) + merkez "⚠ Kapanış uyarılı". Kapanışı ENGELLEMEZ. Kasa sağlaması YENİDEN YAZILMAZ — Satış'ın tek
    hesabı (kasa_mutabakat, yeni evren; bu işlemde yazılan kapanış dahil). Dönüş: (uyarılar, ek veri: sorumlu / içeride kalanlar,
    kasa_uyarilari). SAHİP (2026-10-19): KASA UYARISI PANELE VERİLMEZ (kör sayım — personel tuttu mu bilmez) → ek["kasa_uyarilari"]
    yalnız merkeze (olay + Bekleyen işler)."""
    from evvel_yeni_moduller import DURUM
    from evvel_yeni_olay import olaylar
    u, ek, ku = [], {}, []
    bugun = [o for o in olaylar(cur, sube_id=sube_id, bas=gun, son=gun) if not o.get("iptal") and (o.get("kaynak_tablo") or "") == "panel"]
    if not any(o["tur"] == "acilis" for o in bugun):
        u.append("Bugün açılış kaydı yok")
    if not any(o["tur"] == "urun_ac" for o in bugun):
        u.append("Bugün Ürün Aç kaydı yok" + (" — personel 'ürün açılmadı' dedi" if b.urun_ac_yok else ""))
    if not b.x_rapor:
        u.append("'X raporu gönderildi' işaretlenmedi")
    if DURUM.get("satis") == "yuklendi":
        try:
            from evvel_yeni_satis_api import kasa_mutabakat
            m = kasa_mutabakat(cur, gun.isoformat(), evren="yeni").get(str(sube_id)) or {}
            if m.get("kor_belirsiz"):
                ku.append("Kör sayım teslimden SONRA yapılmış görünüyor — sağlama yapılamadı")
            elif m.get("kor_fark") is not None and abs(m["kor_fark"]) >= 1:
                ku.append(f"Kör sayım tutmuyor: sayılan {m['kor_sayim']:,.2f} − teslim {m['teslim'] or 0:,.2f} = {m['kor_kalan']:,.2f}, "
                         f"bırakılan {m['devir']:,.2f} ₺ (fark {m['kor_fark']:+,.2f} ₺)")
            # Kasa farkı burada YAZILMAZ (sahip 2026-10-20: tek evi Kasa › Açık farklar — tekrar etmesin)
        except Exception:  # noqa: BLE001 — uyarı kapanışı ASLA durdurmaz
            log.warning("kapanış uyarısı: kasa sağlaması okunamadı", exc_info=True)
    y = _yoklama()
    if y is not None:
        try:
            cur.execute("""SELECT 1 FROM ey_devir WHERE sube_id=%s AND is_gunu=%s AND (durum='devreden_onayladi'
                             OR (durum IN ('baslatildi','dolduruluyor') AND COALESCE(ustlen_ts, panel_ts) > NOW() - INTERVAL '30 minutes'))
                           LIMIT 1""", (str(sube_id), gun))   # Codex P2-5: salt okuma (UPDATE'li devir_durum kilit almasın)
            if cur.fetchone():
                u.append("Kasa devri tamamlanmadı")
            s = y.kapanis_sorumlusu(cur, str(sube_id), gun)
            if s:
                ek["sorumlu"] = s
                if str(s["personel_id"]) != str(p["id"]):
                    u.append(f"Kapanışı sorumlu ({s['ad']}) değil {p['ad']} yaptı")
            kalan = [g["ad"] for g in y.bugun_girenler(cur, str(sube_id), gun) if g.get("acik") and str(g["personel_id"]) != str(p["id"])]
            ek["iceride_kalanlar"] = kalan
            if kalan:
                u.append("Kapanışta içeride kalan: " + ", ".join(kalan) + " (QR ile çıkış yapmazsa gece otomatik kapanır)")
        except Exception:  # noqa: BLE001
            log.warning("kapanış uyarısı: yoklama okunamadı", exc_info=True)
    ek["kasa_uyarilari"] = ku
    return u, ek


def _kapanis_yaz(sube_id: str, b: "KapanisBody", gun=None, merkez: Optional[str] = None, isle_deneme: Optional[str] = None) -> dict:
    """Kapanış: ciro (nakit / POS / online) → Kasa kapanış beyanı; teslimler → Kasa teslim; sayım → Depo günlük sayımı
    (düşüş = kullanılan, sahip kararı); hepsi tek işlemde. Aynı gün ikinci kapanış Kasa'da reddedilir (düzeltme merkezde)."""
    _TUR = "kapanis"
    def is_(cur, c):
        from evvel_yeni_depo_api import sayim_yaz
        from evvel_yeni_kasa_api import HareketBody, kasa_yaz
        p = _personel(cur, sube_id, b.personel_id, kapi=False, gun=c["gun"])   # QR kapısı aşağıda: tekrar gönderim ve merkez geç kapanış geçer
        _kapanis_tam(cur, b, merkez=bool(c.get("merkez")))
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
        dusen = []
        try:
            satir = _sayim_satirlari(cur, b.sayim)
        except HTTPException:
            if not c.get("merkez"):
                raise
            from evvel_yeni_urun_api import urun_bilgi   # merkez geç kapanış: personelin o gün saydığı ürün sonradan değiştiyse
            bil = urun_bilgi(cur, [x.urun_id for x in b.sayim])
            satir = [{"urun_id": x.urun_id, "sayilan": _tam(x.sayilan, "Sayım")} for x in b.sayim
                     if x.sayilan is not None and x.urun_id in bil and (bil[x.urun_id].get("takip") or "sayim") == "sayim"
                     and bil[x.urun_id].get("panel_sayim")]
            dusen = [(bil.get(x.urun_id) or {}).get("ad") or x.urun_id for x in b.sayim
                     if x.sayilan is not None and x.urun_id not in {s_["urun_id"] for s_ in satir}]
        kok = f"panel:kapanis:{sube_id}:{gun}"
        oid = _olay(cur, sube_id=sube_id, tur="kapanis", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                       personel_id=p["id"], personel_ad=p["ad"], tutar=Decimal(nakit) / 100,
                       veri={"nakit": nakit, "pos": pos, "online": onl, "teslimler": tes, "sayim": satir,
                             "kor_sayim": None if b.kor_sayim is None else _tl(b.kor_sayim, "Kör sayım"),
                             "birakilan": None if b.birakilan is None else _tl(b.birakilan, "Bırakılan"),
                             "degirmen": _degirmen(b.degirmen),
                             "pasta_toplam": None if b.pasta_toplam is None else _tam(b.pasta_toplam, "Pasta"),
                             "x_rapor": bool(b.x_rapor), "urun_ac_yok": bool(b.urun_ac_yok), "istek_id": b.istek_id})
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
        # Fable: sayım kaynak_ref olay SÜRÜMÜNE bağlı (iptal sonrası yeniden kapanışta sayım yeniden yazılır; tekrar gönderimde yazılmaz)
        # ve İŞ GÜNÜNE yazılır (00:00–02:00 kapanışı dünün hareketi)
        d = sayim_yaz(cur, konum=f"bar:{sube_id}", satirlar=satir, kim=kim, tur="gunluk", gun=c["gun"],
                      kaynak_ref=f"{kok}:sayim:{oid}") if satir and oid and not gecmis else None
        if satir and gecmis:
            log.warning("geç kapanış %s %s: ürün sayımı geçmiş güne uygulanmadı (olayda duruyor)", sube_id, gun)
            cur.execute("""UPDATE ey_sube_olay SET veri = veri || '{"sayim_uygulanmadi": true}'::jsonb WHERE id=%s""", (oid,)) if oid else None
        uyarilar, merkez_uyarilari = [], []
        y0 = _yoklama()
        if y0 is not None and not c["kuru"] and not c.get("merkez") and oid is not None:
            y0.personel_kilidi(cur, p["id"])   # Codex P2-5: devir telefonuyla aynı sıra (kişi → devir) — kilitlenme yok
        if oid is not None:   # yeni yazım: uyarılar + sorumlu + içeride kalanlar (değişken bilgi → tekrar korumasının DIŞINDA, sonradan eklenir)
            uyarilar, ek = _kapanis_uyarilari(cur, sube_id, c["gun"], p, b)
            if dusen:
                uyarilar.append("Geç kapanış: sayımdaki " + ", ".join(dusen) + " artık sayım listesinde değil — uygulanmadı")
            merkez_uyarilari = ek["kasa_uyarilari"] + uyarilar   # merkez HEPSİNİ görür; panel kasa uyarısını GÖRMEZ
            cur.execute("UPDATE ey_sube_olay SET veri = veri || %s::jsonb WHERE id=%s",
                        (json.dumps({"uyarilar": uyarilar, **ek}, ensure_ascii=False, default=str), oid))
        y = _yoklama()
        if y is not None and not c["kuru"] and not c.get("merkez") and oid is not None:
            y.personel_kilidi(cur, p["id"])   # Codex: telefon çıkış/giriş ile yarışmasın
            if _qr_gerekli(cur) and not y.acik_mi(cur, sube_id, p["id"]):
                raise HTTPException(400, "Önce telefonundan QR ile giriş yap")   # yeni kapanış; işlem geri alınır
            y.cikis_yaz(cur, p["id"], "kapanis", kim=kim, sube_id=str(sube_id))   # tasarım: kapanış = kapanışçının çıkışı
        return {"olay": oid, "tekrar": oid is None and bool(k.get("tekrar")), "sayilan": len(satir) if d else 0,
                "mesaj": "Kapanış kaydedildi" + (" — ürün sayımı geçmiş güne uygulanmadı (olayda duruyor)" if satir and gecmis else ""),
                "saat_engeli": engel, "uyarilar": uyarilar, "merkez_uyarilari": merkez_uyarilari, "kapanisci": p["ad"]}
    return _calistir(sube_id, b.istek_id, is_, tur=_TUR, govde=b.model_dump(mode="json"), gun=gun, merkez=merkez,
                     isle_deneme=isle_deneme)


@router.post("/{sube_id}/kapanis")
def kapanis_uc(sube_id: str, b: KapanisBody):
    if b.merkeze:
        return _kapanis_merkeze(sube_id, b)
    _onay_sart(sube_id, "Kapanış", "kapanis", b.model_dump(mode="json"))   # telefon onayı zorunlu (canlı); telefonsuz → merkeze=True
    return kapanis(sube_id, b)


def _kapanis_merkeze(sube_id: str, b: KapanisBody) -> dict:
    """Sahip (2026-10-19): MÜHÜRSÜZ GÖNDER YOK. Kapanışçının telefonu yoksa ve içeride telefonla onaylayacak başka kimse yoksa:
    QR'la girmiş kişi ad + PIN → form doğrulanır, KAYIT YAZILMAZ; girilen rakamlar deneme defterine 'ret' ("telefonsuz — merkeze
    gönderildi") → merkez Bekleyen işler'den tek tıkla GEÇ KAPANIŞ (var olan yol). Rakamlar kaybolmaz; PIN hiçbir yere yazılmaz."""
    with db() as (_c, cur):
        p = _personel(cur, sube_id, b.personel_id)   # QR'la girmiş (içeride)
        _pin(cur, p, b.pin)
        _kapanis_tam(cur, b)
        _onay_hazirla()
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"ey_panel_onay:{sube_id}:kapanis",))   # onay ile aynı sıra
        cur.execute("""SELECT 1 FROM ey_panel_onay WHERE sube_id=%s AND tur='kapanis' AND durum='isleniyor'
                       AND islenme > NOW() - INTERVAL '2 minutes' LIMIT 1""", (str(sube_id),))
        if cur.fetchone():
            raise HTTPException(409, "Kapanış şu an telefondan onaylanıyor — birkaç saniye bekle")
        try:
            fg = date.fromisoformat(str(b.istemci_gunu or "")[:10])
        except ValueError:
            fg = _bugun()
        if _gun_kapali(cur, sube_id, fg):   # Codex: formun GÜNÜ (dünkü eksik kapanış da gönderilebilsin)
            raise HTTPException(409, "Bu günün kapanışı zaten yapıldı")
        cur.execute("""UPDATE ey_panel_onay SET durum='iptal', mesaj='merkeze gönderildi' WHERE sube_id=%s AND tur='kapanis'
                       AND durum IN ('bekliyor','hata')""", (str(sube_id),))   # açık QR onayı kalmasın
        if not b.istemci_gunu:
            raise HTTPException(400, "Form günü yok — sayfayı yenile")
    gun = _bugun()
    try:
        gun = date.fromisoformat(str(b.istemci_gunu)[:10])
    except ValueError:
        pass
    govde = {k: v for k, v in b.model_dump(mode="json").items() if k not in ("pin", "merkeze")}
    did = _deneme_ac(sube_id, "kapanis", gun, govde)
    _deneme_kapat(did, "ret", f"Telefonsuz — {p['ad']} merkeze gönderdi (geç kapanış olarak işleyin)")
    with db() as (_c, cur):
        kuru = deneme_mi(cur, gun)
    return {"ok": True, "merkeze": True, "kuru": kuru,
            "mesaj": ("DENEME — gerçekte merkeze iletilirdi" if kuru else "Kapanış merkeze iletildi — merkez işleyince gün kapanır. Rakamlar kaydedildi.")}


def kapanis(sube_id: str, b: KapanisBody):
    return _kapanis_yaz(sube_id, b)


# Kasa devri (Basamak 4, sahip 2026-10-19): panel YALNIZ başlatır (yoklama /devir-baslat, kayıtlı PC imzası) ve gösterir;
# devreden formu kendi telefonunda doldurur. Eski panel formu (DevirBody) ve 'yoklama yoksa doğrudan vardiya olayı' dalı KALDIRILDI (tek yol).


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
    pin: Optional[str] = None          # 4 hane — doğrulanır, hiçbir yere yazılmaz
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
        _pin(cur, p, b.pin)
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
    pin: Optional[str] = None          # 4 hane — doğrulanır, hiçbir yere yazılmaz
    kalemler: List[Kalem]
    istek_id: str
    aciklama: Optional[str] = None     # eski panel "Not (isteğe bağlı)"


def _kalemler(cur, kalemler: List[Kalem], takip: Optional[str] = None, pasif_olur: bool = False) -> list:
    k = [{"urun_id": x.urun_id, "adet": _tam(x.adet, "Adet")} for x in kalemler]
    k = [x for x in k if x["adet"] > 0]
    if not k:
        raise HTTPException(400, "En az bir ürün seç")
    if len({x["urun_id"] for x in k}) != len(k):
        raise HTTPException(400, "Aynı ürün iki kez seçildi")
    b = _urunler(cur, [x["urun_id"] for x in k], takip=takip, pasif_olur=pasif_olur)
    for x in k:
        x["ad"] = b[x["urun_id"]]["ad"]
        x["takip"] = b[x["urun_id"]].get("takip") or "sayim"
        x["panel_sayim"] = bool(b[x["urun_id"]].get("panel_sayim"))
    return k


def _modul_acik(kod: str) -> bool:
    from evvel_yeni_moduller import DURUM
    return DURUM.get(kod) == "yuklendi"


# ─────────────── BASAMAK 5 S3 · DEPODAN GELEN — TESLİM AL (PANEL_YENIDEN_KURULUM.md §6 + "Basamak 5", sahip P3) ───────────────
# Kalem kalem KÖR sayım (panel beklenen adedi hiç görmez) → Depo PUBLIC kabul_yaz (0 gerçek; hasarlı/fazla askıda; merkez karar).
# Gün kapalıyken de AÇIK (D7: sevk kabulü kapanıştan sonra gelebilir). Paketin bekleyen BÜTÜN kalemleri tek seferde sayılır.
class DepoKabulSatir(BaseModel):
    bag: str
    sayilan: int
    hasarli: int = 0


class DepoKabulBody(BaseModel):
    istemci_gunu: Optional[str] = None
    personel_id: str
    pin: Optional[str] = None          # 4 hane — doğrulanır, hiçbir yere yazılmaz
    parti_id: str
    satirlar: List[DepoKabulSatir]
    istek_id: str


@router.post("/{sube_id}/depodan-kabul")
def depodan_kabul(sube_id: str, b: DepoKabulBody):
    _TUR = "depo_kabul"
    if not _modul_acik("depo"):
        raise HTTPException(503, "Depo modülü kapalı — paket şu an kabul edilemiyor, merkeze haber ver")

    def is_(cur, c):
        from evvel_yeni_depo_api import kabul_yaz, yoldakiler
        p = _personel(cur, sube_id, b.personel_id)
        _pin(cur, p, b.pin)
        bek = next((x for x in yoldakiler(cur, str(sube_id)) if x["parti_id"] == b.parti_id), None)
        kok = f"panel:depo_kabul:{sube_id}:{b.istek_id}"
        if bek is None:   # tekrar gönderim (aynı istek) ya da başka yerden kabul edildi / merkez geri aldı
            cur.execute("SELECT 1 FROM ey_sube_olay WHERE kok=%s LIMIT 1", (kok,))
            if cur.fetchone():
                return {"tekrar": True, "mesaj": "Bu paket zaten kabul edilmişti ✓"}
            raise HTTPException(409, "Bu paket artık bekleyenlerde yok — sayfayı yenile")
        gerek = {k["bag"]: k["ad"] for k in bek["kalemler"]}
        gelen = {x.bag: x for x in b.satirlar}
        if set(gelen) != set(gerek) or len(gelen) != len(b.satirlar):
            raise HTTPException(400, "Paketin bütün ürünleri sayılmalı — sayfayı yenile")
        for x in b.satirlar:
            if x.sayilan < 0 or x.hasarli < 0 or x.sayilan > 99999 or x.hasarli > 99999:
                raise HTTPException(400, "Sayılar 0 ya da daha büyük olmalı")
        kim = f"{KIM} · {p['ad']}"
        oid = _olay(cur, sube_id=sube_id, tur="depo_kabul", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                    personel_id=p["id"], personel_ad=p["ad"],
                    veri={"parti_id": b.parti_id, "nereden": bek["nereden"], "istek_id": b.istek_id,
                          "satirlar": [{"bag": x.bag, "ad": gerek[x.bag], "sayilan": x.sayilan, "hasarli": x.hasarli} for x in b.satirlar]})
        if oid is None:
            return {"tekrar": True, "mesaj": "Bu paket zaten kabul edilmişti ✓"}
        fark = False
        for x in sorted(b.satirlar, key=lambda z: int(z.bag.rsplit(":", 1)[1])):   # Fable S3 #1: kalem İNDEKS sırası (sevk_iptal ile aynı)
            r = kabul_yaz(cur, bag=x.bag, sayilan=x.sayilan, hasarli=x.hasarli, kim=kim, gun=c["gun"], beklenen_hedef=str(sube_id))
            fark = fark or bool(r.get("eksik") or r.get("fazla") or r.get("hasar"))
        # KÖR kalır: personele rakam söylenmez (beklenen sızmasın) — yalnız "merkeze iletildi"
        return {"olay": oid, "tekrar": False,
                "mesaj": f"{len(b.satirlar)} ürün kabul edildi ✓" + (" · Sayımda fark var — merkeze iletildi" if fark else "")}
    return _calistir(sube_id, b.istek_id, is_, tur=_TUR, govde=b.model_dump(mode="json"))


# ─────────────── BASAMAK 5 S5 · SİPARİŞ VER · TAKİP · GÖNDERİLECEK (sahip D1–D4, 2026-10-20) ───────────────
# Kayıt Sipariş modülünün PUBLIC kapılarından (evvel_yeni_siparis_api); panel yalnız kimlik + iskelet. Modül kapalıysa 503 (yumuşak bağ).
def _siparis():
    if not _modul_acik("siparis"):
        raise HTTPException(503, "Sipariş modülü kapalı — merkeze haber ver")
    import evvel_yeni_siparis_api as s
    return s


class SiparisKalem(BaseModel):
    urun_id: Optional[str] = None
    ad: Optional[str] = None       # katalog dışı öneri (D4)
    adet: int


class SiparisBody(BaseModel):
    istemci_gunu: Optional[str] = None
    personel_id: str
    pin: Optional[str] = None
    kalemler: List[SiparisKalem]
    notu: Optional[str] = None
    istek_id: str


@router.post("/{sube_id}/siparis")
def siparis_ver(sube_id: str, b: SiparisBody):
    """Sipariş ver (A2): gün AÇIK şart (A14). 1 Kasım öncesi talep GERÇEK yazılır, deneme işaretli (D2 — stok yok)."""
    S = _siparis()

    def is_(cur, c):
        _gun_acik_mi(cur, c, sube_id)
        p = _personel(cur, sube_id, b.personel_id)
        _pin(cur, p, b.pin)
        r = S.siparis_yaz(cur, sube_id=str(sube_id), kalemler=[x.model_dump() for x in b.kalemler], kim=f"{KIM} · {p['ad']}",
                          personel_id=p["id"], istek_id=b.istek_id, notu=b.notu, deneme=c["kuru"], gun=c["gun"])
        if not c["kuru"]:   # olay defteri yalnız gerçek dönemde (deneme siparişi okuyuculara karışmasın)
            _olay(cur, sube_id=sube_id, tur="siparis", is_gunu=c["gun"], kok=f"panel:siparis:{sube_id}:{b.istek_id}", kaynak_tablo="panel",
                  personel_id=p["id"], personel_ad=p["ad"], veri={"siparis_id": r["siparis_id"], "kalem": r["kalem"], "istek_id": b.istek_id})
        c["kalici"] = True
        return {"siparis_id": r["siparis_id"], "tekrar": r["tekrar"],
                "mesaj": ("Bu sipariş zaten gönderilmişti ✓" if r["tekrar"] else f"🛒 Sipariş gönderildi — {r['kalem']} kalem")
                + (" · 🧪 deneme (1 Kasım'a kadar sevk yapılmaz)" if c["kuru"] else "")}
    return _calistir(sube_id, b.istek_id, is_, tur="siparis", govde=b.model_dump(mode="json"))


@router.get("/{sube_id}/siparisler")
def panel_siparisler(sube_id: str):
    """Sipariş takip (A7, KÖR — sevk/kabul adedi yok) + Sipariş ver rozetleri (A2/A12, adetsiz) + Gönderilecek (yalnız merkez depo şubesi)
    + Tedarikçi 'beklenen' kartları (A10)."""
    S = _siparis()
    with db() as (conn, cur):
        S.siparis_hazirla(cur)
        _sube(cur, sube_id)
        from evvel_yeni_tanim_api import depo_sube_id
        depo_mu = depo_sube_id(cur) == str(sube_id)
        sip = S.subenin_siparisleri(cur, str(sube_id))
        return {"siparisler": sip, "rozet": S.bekleyen_urunler(cur, str(sube_id), sip),   # Fable #8: ikinci türetme yok
                "gonderilecek": S.gonderilecek(cur, str(sube_id)) if depo_mu else [], "depo": depo_mu,
                "toptanci_beklenen": S.toptanci_beklenen(cur, str(sube_id)) if _modul_acik("toptanci") else []}   # #16


class SiparisIptalBody(BaseModel):
    istemci_gunu: Optional[str] = None
    personel_id: str
    pin: Optional[str] = None
    istek_id: str


@router.post("/{sube_id}/siparis/{sid}/iptal")
def panel_siparis_iptal(sube_id: str, sid: str, b: SiparisIptalBody):
    """Şube yalnız HİÇ yönlendirilmemiş kendi siparişini geri çeker (ad + PIN)."""
    S = _siparis()

    def is_(cur, c):
        p = _personel(cur, sube_id, b.personel_id)
        _pin(cur, p, b.pin)
        S.siparis_hazirla(cur)
        S.siparis_iptal(cur, sid=sid, kim=f"{KIM} · {p['ad']}", sebep="şube geri çekti", sube_id=str(sube_id))
        c["kalici"] = True
        return {"mesaj": "Sipariş geri çekildi"}
    return _calistir(sube_id, b.istek_id, is_, tur="siparis_iptal", govde=b.model_dump(mode="json"))


class GonderSatir(BaseModel):
    yon_id: str
    siparis_id: str
    surum: Optional[int] = None
    hazir: Optional[int] = None
    gonderilen: Optional[int] = None


class GonderBody(BaseModel):
    istemci_gunu: Optional[str] = None
    personel_id: str
    pin: Optional[str] = None
    hedef: str
    satirlar: List[GonderSatir]
    yola_cik: bool = False          # False = yalnız "Hazırlığı kaydet" (stok yazmaz)
    istek_id: str


@router.post("/{sube_id}/gonderilecek")
def panel_gonderilecek(sube_id: str, b: GonderBody):
    """Gönderilecek (A9, yalnız merkez depo şubesi): 'Hazırlığı kaydet' (stok yok, denemede de kalır) ya da '🚚 Yola çıkar'
    (Depo sevk_yaz — 1 Kasım öncesi DENEME, geri alınır). Gün kapalıyken de açık (D7). Kısmi → kalan yönlendirilmemişe döner."""
    S = _siparis()

    def is_(cur, c):
        from evvel_yeni_tanim_api import depo_sube_id
        if depo_sube_id(cur) != str(sube_id):
            raise HTTPException(403, "Gönderilecek yalnız merkez depo şubesinde")
        p = _personel(cur, sube_id, b.personel_id)
        _pin(cur, p, b.pin)
        kim = f"{KIM} · {p['ad']}"
        if not b.yola_cik:
            n = S.hazirlik_yaz(cur, depo_sube=str(sube_id), satirlar=[x.model_dump() for x in b.satirlar])
            c["kalici"] = True
            return {"mesaj": f"Hazırlık kaydedildi ({n} kalem)"}
        if any(x.gonderilen is None for x in b.satirlar):
            raise HTTPException(400, "Her kalem için VAR / KISMİ / YOK seç")
        r = S.yola_cikar(cur, depo_sube=str(sube_id), hedef_sube=b.hedef, kim=kim, istek_id=b.istek_id[:58],
                         satirlar=[{"yon_id": x.yon_id, "siparis_id": x.siparis_id, "surum": x.surum, "gonderilen": x.gonderilen} for x in b.satirlar])
        _olay(cur, sube_id=sube_id, tur="sevk_cikis", is_gunu=c["gun"], kok=f"panel:sevk:{sube_id}:{b.istek_id}", kaynak_tablo="panel",
              personel_id=p["id"], personel_ad=p["ad"], veri={"hedef": b.hedef, "parti_id": r.get("parti_id"), "istek_id": b.istek_id})
        return {"parti_id": r.get("parti_id"), "mesaj": (f"🚚 {r['kalem']} ürün yola çıktı" if r.get("kalem") else "Gönderilen ürün yok")
                + (f" ({r['paket']} paket — aynı ürün iki siparişte)" if r.get("paket", 1) > 1 else "")
                + (f" · {r['yok']} kalem YOK — merkez yeniden karar verecek" if r.get("yok") else "")
                + (f" · {r['kismi']} kalem kısmi — kalanı merkeze döndü" if r.get("kismi") else "")}
    return _calistir(sube_id, b.istek_id, is_, tur="gonderilecek", govde=b.model_dump(mode="json"))


# ─────────────── BASAMAK 8 · TEDARİKÇİDEN TESLİM AL (sahip onayı 2026-10-19; PANEL_YENIDEN_KURULUM.md "BASAMAK 8") ───────────────
# TEK teslim kapısı (Tema = merkez depo da). Var olan Toptancı kurgusu ESAS: teslim_yaz (TEK KAYIT = TESLİM, borç teslimde) +
# Depo 'giris' (dışarı:toptanci → depo:şube) TEK işlemde. Toptancı kendiliğinden açılmaz; fiyat şube tutarından öğrenilmez (E5).
class TeslimAlBody(BaseModel):
    istemci_gunu: Optional[str] = None
    personel_id: str
    pin: Optional[str] = None          # 4 hane — doğrulanır, hiçbir yere yazılmaz
    toptanci_id: str
    kalemler: List[Kalem]
    fatura_geldi: Optional[bool] = None   # zorunlu soru (eski "🧾 FATURA GELDİ Mİ?")
    tutar: Optional[Decimal] = None       # EVET → faturadaki TOPLAM (zorunlu) · HAYIR → kâğıtta yazıyorsa
    fatura_no: Optional[str] = None
    aciklama: Optional[str] = None
    koli: Optional[dict] = None           # yalnız iz: {urun_id: {koli, koli_ici, tek}} (hesap ekranda)
    siparis_yon: Optional[List[str]] = None   # S5 (A10): seçilen "beklenen toptancı siparişi" kart satırları
    istek_id: str


@router.post("/{sube_id}/teslim-al")
def teslim_al(sube_id: str, b: TeslimAlBody):
    _TUR = "teslim_al"
    if not _modul_acik("toptanci"):
        raise HTTPException(503, "Toptancılar modülü kapalı — teslim şu an alınamıyor, merkeze haber ver")
    def is_(cur, c):
        import hashlib
        from evvel_yeni_depo_api import hareket_yaz
        from evvel_yeni_toptanci_api import teslim_yaz
        _gun_acik_mi(cur, c, sube_id)   # eski: gün kapalıyken teslim alınmaz (merkez girer)
        p = _personel(cur, sube_id, b.personel_id)
        _pin(cur, p, b.pin)
        cur.execute("SELECT id, ad FROM ey_toptanci WHERE id=%s AND aktif", (str(b.toptanci_id),))
        t = cur.fetchone()
        if not t:   # Fable: panel toptancı AÇMAZ (çift kimlik — eski hastalık)
            raise HTTPException(400, "Toptancı listede yok — merkeze haber ver")
        t = dict(t)
        k = _kalemler(cur, b.kalemler, pasif_olur=True)
        if b.fatura_geldi is None:
            raise HTTPException(400, "🧾 Fatura geldi mi? — EVET ya da HAYIR seç")
        tutar = _tl(b.tutar, "Tutar") if b.tutar not in (None, "") else None
        if tutar == 0:
            tutar = None
        if b.fatura_geldi and not tutar:
            raise HTTPException(400, "Fatura geldiyse faturadaki TOPLAM tutarı yaz")
        ozet = hashlib.sha1(json.dumps(sorted((x["urun_id"], x["adet"]) for x in k)).encode()).hexdigest()[:16] + ":" + str(t["id"])
        if not c["kuru"]:   # Fable: "kaydedildi mi?" deyip yeni istekle ikinci basış → 3 dk aynı içerik kilidi (eski SUBE-004)
            cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"ey_teslim_al:{sube_id}",))
            cur.execute("""SELECT 1 FROM ey_sube_olay WHERE sube_id=%s AND tur='teslim_al' AND veri->>'ozet'=%s
                             AND olay_zamani > NOW() - INTERVAL '3 minutes' AND veri->>'istek_id' <> %s LIMIT 1""",
                        (str(sube_id), ozet, b.istek_id))
            if cur.fetchone():
                raise HTTPException(409, "Bu teslim az önce kaydedildi — tekrar gönderme. Gerçekten ikinci teslimse 3 dk sonra dene.")
        kok = f"panel:teslim:{sube_id}:{b.istek_id}"
        kalem_veri = [{"urun_id": x["urun_id"], "ad": x["ad"], "adet": x["adet"]} for x in k]
        oid = _olay(cur, sube_id=sube_id, tur="teslim_al", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                    personel_id=p["id"], personel_ad=p["ad"], tutar=(Decimal(tutar) / 100 if tutar else None),
                    veri={"toptanci_id": t["id"], "toptanci_ad": t["ad"], "kalemler": kalem_veri, "fatura_geldi": bool(b.fatura_geldi),
                          "tutar": tutar, "fatura_no": (b.fatura_no or "").strip()[:40] or None, "aciklama": (b.aciklama or "").strip()[:300] or None,
                          "koli": b.koli or None, "ozet": ozet, "istek_id": b.istek_id})
        tid = None
        if oid is not None:
            tid = teslim_yaz(cur, kaynak_ref=kok, toptanci_id=t["id"], toptanci_ad=t["ad"], sube_id=str(sube_id), gun=c["gun"],
                             kalemler=[{"urun_id": x["urun_id"], "urun_ad": x["ad"], "adet": x["adet"]} for x in k],
                             fatura_geldi=bool(b.fatura_geldi), kesin_tutar=tutar, fatura_no=b.fatura_no, teslim_alan=p["ad"],
                             aciklama=b.aciklama, kesin_kaynak="şube")
            for i, x in enumerate(k):
                hareket_yaz(cur, kaynak_ref=f"{kok}:{i}", tur="giris", urun_id=x["urun_id"], urun_ad=x["ad"], adet=x["adet"],
                            kaynak="dışarı:toptanci", hedef=f"depo:{sube_id}", kim=f"{KIM} · {p['ad']}", bag=kok, gun=c["gun"],
                            aciklama=f"{t['ad']} teslimi")
            if b.siparis_yon and tid:
                if not _modul_acik("siparis"):
                    raise HTTPException(503, "Sipariş modülü kapalı — kart seçmeden teslim al ya da merkeze haber ver")
                from evvel_yeni_siparis_api import teslime_bagla
                teslime_bagla(cur, sube_id=str(sube_id), teslim_id=tid, toptanci_id=t["id"], yon_idler=b.siparis_yon)
        return {"olay": oid, "teslim_id": tid, "tekrar": oid is None, "toptanci": t["ad"],
                "mesaj": f"✅ {t['ad']} teslimi kaydedildi — {len(k)} kalem / {sum(x['adet'] for x in k)} adet"}
    return _calistir(sube_id, b.istek_id, is_, tur=_TUR, govde=b.model_dump(mode="json"))


@router.post("/{sube_id}/urun-ac")
def urun_ac(sube_id: str, b: UrunAcBody):
    """Ürün aç — BÜTÜN katalog (sahip: "bütün mekanizma", Basamak 5). Sahip (2026-10-19): açılış/kapanışta YALNIZ tezgah sayılır.
    Panelde sayılan (panel_sayim: bardak/süt/su…) → depo:şube → bar:şube (taşıma; tüketimi bar sayım farkı) · diğer HER ürün
    (açılınca biten ya da depoda dönem sayımlı: kahve, şurup, toz…) → depo:şube → dışarı:tuketim (= gider; eski panel kuralı,
    Fable 2026-10-19). Eksi stok ENGELLENMEZ (merkeze iş)."""
    _TUR = "urun_ac"
    def is_(cur, c):
        from evvel_yeni_depo_api import hareket_yaz
        _gun_acik_mi(cur, c, sube_id)
        p = _personel(cur, sube_id, b.personel_id)
        _pin(cur, p, b.pin)
        k = _kalemler(cur, b.kalemler, pasif_olur=True)
        if any(x["takip"] == "gununde" for x in k):   # sahip P1: pasta depoya girerken tüketildi — açılırsa çift gider
            raise HTTPException(400, "Pasta gibi gününde tüketilen ürün Ürün Aç'ta açılmaz — listeyi yenileyin")
        kok = f"panel:ac:{sube_id}:{b.istek_id}"
        oid = _olay(cur, sube_id=sube_id, tur="urun_ac", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                       personel_id=p["id"], personel_ad=p["ad"], veri={"kalemler": k, "aciklama": (b.aciklama or "").strip()[:200] or None})
        for i, x in enumerate(k):
            if oid is None:   # tekrar gönderim
                continue
            if x["panel_sayim"]:   # tezgahta sayılan (bardak, süt, su…) → bara TAŞINIR; tüketimi bar sayım farkı verir (çift gider yok)
                hedef = f"bar:{sube_id}"
            else:                  # diğer her şey (kahve, şurup, toz, kapak, temizlik…) açılınca GİDER — eski panel kuralı;
                hedef = "dışarı:tuketim"   # merkez depo sayımındaki fark ayrıca 'kayıp/fazla' görünür (gidere karışmaz)
            hareket_yaz(cur, kaynak_ref=f"{kok}:{i}", tur="ac", urun_id=x["urun_id"], urun_ad=x["ad"], adet=x["adet"],
                        kaynak=f"depo:{sube_id}", hedef=hedef, kim=f"{KIM} · {p['ad']}", bag=kok, gun=c["gun"])
        return {"olay": oid, "tekrar": oid is None, "mesaj": f"{len(k)} kalem · {sum(x['adet'] for x in k)} adet açıldı"}
    return _calistir(sube_id, b.istek_id, is_, tur=_TUR, govde=b.model_dump(mode="json"))


class IadeBilgi(BaseModel):
    fis_no: str
    iade_saat: str                    # "HH:MM"
    musteri_ad: Optional[str] = None  # personele GÖSTERİLMEZ (yalnız merkez)
    musteri_tel: Optional[str] = None


class FireBody(BaseModel):
    istemci_gunu: Optional[str] = None   # tabletin formu açtığı iş günü (gün değiştiyse kayıt merkeze iletilir)
    personel_id: str
    pin: Optional[str] = None          # 4 hane — doğrulanır, hiçbir yere yazılmaz
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
        _pin(cur, p, b.pin)
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
# ─────────────────────────── R1 · İŞLEM SONUNDA QR İLE ONAY (sahip 2026-10-18 — "Adını seç" ve PIN yok) ───────────────────────────
# Panel formu doldurur → onay isteği (para/stok YAZILMAZ) → ekranda QR (+ onay kimliği) → personel KENDİ telefonuyla okutur → ONAYLA →
# kişi telefondan (istemciden gelmez), QR + konum yoklama modülünün PUBLIC servisleriyle doğrulanır → panelin MEVCUT yazma ucu o kişi adına
# çalışır (tek yazar). SUBE_PANELI_TASARIM.md §R1.
ONAY_SURE_DK = 10
ONAY_TURLERI = {
    "acilis": (AcilisBody, lambda s, b: acilis(s, b), "Açılış"),
    "kapanis": (KapanisBody, lambda s, b: kapanis(s, b), "Kapanış"),
}   # sahip (2026-10-18): sık işlemler (ürün aç, fire, ara teslim, anlık gider, teslim al) QR DEĞİL — "giriş yapmış personelin adı + PIN" (R1b)
_ONAY_HAZIR = False


def _onay_hazirla() -> None:
    global _ONAY_HAZIR
    if _ONAY_HAZIR:
        return
    with db() as (_c, cur):
        cur.execute("SELECT pg_advisory_xact_lock(7012051)")
        cur.execute("SET LOCAL lock_timeout = '3s'")
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_panel_onay (
            id TEXT PRIMARY KEY, sube_id TEXT NOT NULL, tur TEXT NOT NULL, govde JSONB NOT NULL, ozet TEXT,
            durum TEXT NOT NULL DEFAULT 'bekliyor', personel_id TEXT, personel_ad TEXT, mesaj TEXT, sonuc JSONB,
            olusturma TIMESTAMPTZ NOT NULL DEFAULT NOW(), son TIMESTAMPTZ NOT NULL, islenme TIMESTAMPTZ)""")
    _ONAY_HAZIR = True


# ─────────────── PANEL TASLAĞI (eski /urun-ac/taslak — sahip: "fonksiyon kaybı istemiyorum") ───────────────
# Seçimler SUNUCUDA da durur: tarayıcı verisi silinse / panel başka PC'ye taşınsa yarım iş geri gelir. PIN ASLA yazılmaz.
TASLAK_TURLERI = {"urun_ac"}
_TASLAK_HAZIR = False


def _taslak_hazirla() -> None:
    global _TASLAK_HAZIR
    if _TASLAK_HAZIR:
        return
    with db() as (_c, cur):
        cur.execute("SELECT pg_advisory_xact_lock(7012052)")
        cur.execute("SET LOCAL lock_timeout = '3s'")
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_panel_taslak (
            sube_id TEXT NOT NULL, tur TEXT NOT NULL, is_gunu DATE NOT NULL, veri JSONB NOT NULL, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (sube_id, tur, is_gunu))""")
    _TASLAK_HAZIR = True


class TaslakBody(BaseModel):
    gun: str
    veri: dict


def _taslak_gun(gun: str):
    try:
        return date.fromisoformat(str(gun)[:10])
    except ValueError:
        raise HTTPException(400, "Gün geçersiz")


@router.get("/{sube_id}/taslak/{tur}")
def taslak_oku(sube_id: str, tur: str, gun: str):
    if tur not in TASLAK_TURLERI:
        raise HTTPException(404, "Taslak yok")
    _taslak_hazirla()
    with db() as (conn, cur):
        cur.execute("SELECT veri FROM ey_panel_taslak WHERE sube_id=%s AND tur=%s AND is_gunu=%s", (sube_id, tur, _taslak_gun(gun)))
        r = cur.fetchone()
    return {"veri": dict(r)["veri"] if r else None}


@router.post("/{sube_id}/taslak/{tur}")
def taslak_yaz(sube_id: str, tur: str, b: TaslakBody):
    if tur not in TASLAK_TURLERI:
        raise HTTPException(404, "Taslak yok")
    v = {k: x for k, x in (b.veri or {}).items() if k != "pin"}   # PIN asla
    ham = json.dumps(v, ensure_ascii=False, default=str)
    if len(ham) > 50000:
        raise HTTPException(400, "Taslak çok büyük")
    _taslak_hazirla()
    with db() as (conn, cur):
        _sube(cur, sube_id)
        cur.execute("""INSERT INTO ey_panel_taslak (sube_id, tur, is_gunu, veri) VALUES (%s,%s,%s,%s::jsonb)
                       ON CONFLICT (sube_id, tur, is_gunu) DO UPDATE SET veri=EXCLUDED.veri, zaman=NOW()""",
                    (sube_id, tur, _taslak_gun(b.gun), ham))
    return {"ok": True}


@router.delete("/{sube_id}/taslak/{tur}")
def taslak_sil(sube_id: str, tur: str, gun: str):
    if tur not in TASLAK_TURLERI:
        raise HTTPException(404, "Taslak yok")
    _taslak_hazirla()
    with db() as (conn, cur):
        cur.execute("DELETE FROM ey_panel_taslak WHERE sube_id=%s AND tur=%s AND is_gunu=%s", (sube_id, tur, _taslak_gun(gun)))
    return {"ok": True}


def _tl_yaz(x) -> str:
    try:
        return f"{Decimal(str(x)):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".") + " ₺"
    except Exception:  # noqa: BLE001
        return str(x)


def _onay_ozet(cur, tur: str, g: dict) -> str:
    """Telefonda gösterilecek tek satır özet (personel ne onayladığını görür)."""
    def adlar(kalemler):
        ids = [str(k.get("urun_id")) for k in kalemler or [] if k.get("urun_id")]
        try:
            u = _urunler(cur, ids) if ids else {}
        except HTTPException:
            u = {}
        return ", ".join(f"{(u.get(str(k.get('urun_id'))) or {}).get('ad', '?')} × {k.get('adet') if k.get('adet') is not None else k.get('sayilan')}" for k in kalemler or [])
    if tur == "acilis":   # Codex: telefonda her kalemin adı ve sayısı (kişi neyi onayladığını görsün)
        return (f"Kasa {_tl_yaz(g.get('kasa_sayim', 0))} · " + adlar(g.get("sayim"))
                + (f" · pasta {g['pasta_toplam']}" if g.get("pasta_toplam") not in (None, "") else ""))
    if tur == "kapanis":
        tes = " · teslim " + ", ".join(f"{str(t.get('alan', '')).split(':')[-1].capitalize()} {_tl_yaz(t.get('tutar', 0))}" for t in g.get("teslimler") or []) if g.get("teslimler") else ""
        return (f"Nakit {_tl_yaz(g.get('nakit', 0))} · POS {_tl_yaz(g.get('pos', 0))} · online {_tl_yaz(g.get('online', 0))}"
                f" · çekmece {_tl_yaz(g.get('kor_sayim') or 0)}{tes} · bırakılan {_tl_yaz(g.get('birakilan') or 0)} · " + adlar(g.get("sayim"))
                + (f" · pasta {g['pasta_toplam']}" if g.get("pasta_toplam") not in (None, "") else ""))
    if tur == "ara-teslim":
        return f"{str(g.get('alan', '')).split(':')[-1].capitalize()}'a {_tl_yaz(g.get('tutar', 0))} teslim"
    if tur in ("urun-ac", "fire"):
        return adlar(g.get("kalemler")) + (f" · sebep {FIRE_SEBEPLERI.get(g.get('sebep'), g.get('sebep'))}" if tur == "fire" else "")
    return ""


class OnayIsteBody(BaseModel):
    tur: str
    govde: dict


@router.post("/{sube_id}/onay-iste")
def onay_iste(sube_id: str, b: OnayIsteBody):
    """Panel: form hazır → onay isteği. Biçim burada denetlenir (telefon geçersiz form görmesin); kayıt telefon onaylayınca yazılır."""
    if _yoklama() is None:
        raise HTTPException(503, "QR sistemi çalışmıyor — merkeze haber ver")
    if b.tur not in ONAY_TURLERI:
        raise HTTPException(400, "Bu işlem QR ile onaylanmaz")
    Body, _f, ad = ONAY_TURLERI[b.tur]
    try:
        g = Body(**{**(b.govde or {}), "personel_id": "-"}).model_dump(mode="json", exclude={"personel_id", "pin"})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Form eksik: {str(e)[:160]}")
    _onay_hazirla()
    oid = "on-" + uuid.uuid4().hex[:16]
    with db() as (conn, cur):
        _sube(cur, sube_id)
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"ey_panel_onay:{sube_id}:{b.tur}",))   # Codex: tek sıra
        cur.execute("""SELECT 1 FROM ey_panel_onay WHERE sube_id=%s AND tur=%s AND durum='isleniyor'
                       AND islenme > NOW() - INTERVAL '2 minutes' LIMIT 1""", (str(sube_id), b.tur))
        if cur.fetchone():
            raise HTTPException(409, "Önceki onay şu an telefondan işleniyor — birkaç saniye bekle")
        if b.tur == "acilis":
            _acilis_tam(cur, Body(**{**g, "personel_id": "-"}))
        elif b.tur == "kapanis":   # eski korumalar QR çıkmadan (telefon geçersiz form görmesin)
            if g.get("merkeze"):
                raise HTTPException(400, "Merkeze gönderim QR ile yapılmaz")
            _kapanis_tam(cur, Body(**{**g, "personel_id": "-"}))
        ozet = _onay_ozet(cur, b.tur, g)
        cur.execute("""UPDATE ey_panel_onay SET durum='iptal', mesaj='yerine yeni onay istendi'
                       WHERE sube_id=%s AND tur=%s AND durum IN ('bekliyor','hata')""", (str(sube_id), b.tur))
        cur.execute("""INSERT INTO ey_panel_onay (id, sube_id, tur, govde, ozet, son)
                       VALUES (%s,%s,%s,%s::jsonb,%s, NOW() + (%s || ' minutes')::interval)""",
                    (oid, str(sube_id), b.tur, json.dumps(g, ensure_ascii=False, default=str), ozet, str(ONAY_SURE_DK)))
    return {"ok": True, "onay_id": oid, "ad": ad, "ozet": ozet, "sure_dk": ONAY_SURE_DK,
            "mesaj": "Telefonunla ekrandaki QR'ı okut ve onayla"}


def _onay_oku(cur, oid: str) -> dict:
    cur.execute("SELECT *, son < NOW() AS gecti FROM ey_panel_onay WHERE id=%s", (oid,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Onay bulunamadı")
    return dict(r)


@router.get("/onay/{oid}")
def onay_durum(oid: str):
    """Panel 2 sn'de bir sorar: bekliyor / onaylandi / hata / iptal / sure_doldu."""
    _onay_hazirla()
    with db() as (conn, cur):
        o = _onay_oku(cur, oid)
    durum = "sure_doldu" if o["durum"] in ("bekliyor", "hata") and o["gecti"] else o["durum"]
    sonuc = o.get("sonuc") if isinstance(o.get("sonuc"), dict) else {}
    return {"durum": durum, "mesaj": o["mesaj"], "kisi": o["personel_ad"], "ozet": o["ozet"], "tur": o["tur"],
            "kuru": bool((sonuc or {}).get("kuru")), "uyarilar": (sonuc or {}).get("uyarilar") or []}   # kapanış: EKSİK VAR kartı


@router.post("/onay/{oid}/iptal")
def onay_iptal(oid: str):
    _onay_hazirla()
    with db() as (conn, cur):
        cur.execute("UPDATE ey_panel_onay SET durum='iptal' WHERE id=%s AND durum IN ('bekliyor','hata') RETURNING id", (oid,))
        if not cur.fetchone():
            raise HTTPException(409, "Bu onay artık iptal edilemez")
    return {"ok": True, "mesaj": "Onay iptal edildi — form duruyor"}


@router.get("/onay/{oid}/ozet")
async def onay_ozet_telefon(oid: str, request: Request):
    """Telefon (imzalı): neyi onaylayacağını görür."""
    y = _yoklama()
    if y is None:
        raise HTTPException(400, "QR onayı kapalı")
    _onay_hazirla()

    def _is():
        with db() as (conn, cur):
            c = y.cihaz_coz(cur, request.headers, "GET", request.url.path, b"", tur="telefon")
            p = y.personel_oku(cur, c["personel_id"])
            o = _onay_oku(cur, oid)
            cur.execute("SELECT ad FROM ey_sube WHERE id=%s", (o["sube_id"],))
            sube_ad = dict(cur.fetchone() or {}).get("ad")
        return {"tur": o["tur"], "ad": ONAY_TURLERI.get(o["tur"], (None, None, o["tur"]))[2], "ozet": o["ozet"], "sube": o["sube_id"],
                "sube_ad": sube_ad, "kisi": p["ad"], "durum": "sure_doldu" if o["durum"] in ("bekliyor", "hata") and o["gecti"] else o["durum"],
                "mesaj": o["mesaj"]}
    return await run_in_threadpool(_is)


@router.post("/onay/{oid}/onayla")
async def onay_onayla(oid: str, request: Request):
    """Telefon (imzalı) ONAYLA: kişi telefondan, QR + konum doğrulanır → panelin mevcut yazma ucu o kişi adına çalışır."""
    y = _yoklama()
    if y is None:
        raise HTTPException(400, "QR onayı kapalı")
    _onay_hazirla()
    ham = await request.body()

    def _dogrula():
        with db() as (conn, cur):
            c = y.cihaz_coz(cur, request.headers, "POST", request.url.path, ham, tur="telefon")
            try:
                v = json.loads(ham) if ham else {}
            except ValueError:
                raise HTTPException(400, "İstek okunamadı")
            p = y.personel_oku(cur, c["personel_id"])
            cur.execute("SELECT sube_id, tur FROM ey_panel_onay WHERE id=%s", (oid,))
            _sk = cur.fetchone()
            if _sk:   # onay-iste ile aynı sıra kilidi (yeni QR istenirken eski onay işlenmeye başlayamaz)
                cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"ey_panel_onay:{_sk['sube_id']}:{_sk['tur']}",))
            cur.execute("SELECT *, son < NOW() AS gecti, islenme < NOW() - INTERVAL '2 minutes' AS takildi FROM ey_panel_onay WHERE id=%s FOR UPDATE", (oid,))
            o = cur.fetchone()
            if not o:
                raise HTTPException(404, "Onay bulunamadı")
            o = dict(o)
            if o["durum"] == "onaylandi":
                return {"tekrar": True, "mesaj": o["mesaj"], "kisi": o["personel_ad"]}
            if o["durum"] == "isleniyor" and not o["takildi"]:
                raise HTTPException(409, "Onay işleniyor — birazdan panele bak")
            if o["durum"] not in ("bekliyor", "hata", "isleniyor"):
                raise HTTPException(409, "Bu onay artık geçerli değil — panelden yeniden iste")
            if o["gecti"]:
                raise HTTPException(410, "Onayın süresi doldu — panelden yeniden iste")
            sube = str(v.get("sube") or "")
            if sube != o["sube_id"]:
                raise HTTPException(409, "Bu onay başka şubenin — o şubenin QR'ını okut")
            dilim = y.qr_dogrula(cur, sube, str(v.get("qr") or ""))
            if dilim is None:
                raise HTTPException(409, "QR süresi doldu — panelde QR yenilenince tekrar okut")
            y.konum_kontrol(cur, sube, p, v.get("lat"), v.get("lng"))
            y.qr_kullan(cur, sube, dilim, p["id"], "onay:" + oid)   # iz (aynı onayın yeniden denemesi engellenmez; tekrar onay satırıyla korunur)
            cur.execute("UPDATE ey_panel_onay SET durum='isleniyor', personel_id=%s, personel_ad=%s, islenme=NOW() WHERE id=%s",
                        (p["id"], p["ad"], oid))
            return {"o": o, "p": p}
    r = await run_in_threadpool(_dogrula)
    if r.get("tekrar"):
        return {"ok": True, "tekrar": True, "mesaj": r["mesaj"] or "Zaten onaylandı"}
    o, p = r["o"], r["p"]
    Body, fn, ad = ONAY_TURLERI[o["tur"]]
    govde = dict(o["govde"] if isinstance(o["govde"], dict) else json.loads(o["govde"]))
    govde["personel_id"] = p["id"]   # kimlik KAYNAKTA: telefonun sahibi
    try:
        sonuc = await run_in_threadpool(lambda: fn(o["sube_id"], Body(**govde)))
        durum, mesaj, kod = "onaylandi", f"{p['ad']} adına · {sonuc.get('mesaj') or 'kaydedildi'}", None
    except HTTPException as e:
        sonuc, durum, mesaj, kod = None, "hata", str(e.detail), e.status_code
    except Exception as e:  # noqa: BLE001
        log.error("panel onay işlenemedi %s: %s", oid, str(e)[:300])
        sonuc, durum, mesaj, kod = None, "hata", "Kaydedilemedi — tekrar dene", 503

    def _kapat():
        with db() as (conn, cur):
            cur.execute("UPDATE ey_panel_onay SET durum=%s, mesaj=%s, sonuc=%s::jsonb WHERE id=%s",
                        (durum, mesaj, json.dumps(sonuc or {}, ensure_ascii=False, default=str), oid))
    await run_in_threadpool(_kapat)
    if kod:
        raise HTTPException(kod, mesaj)
    return {"ok": True, "mesaj": mesaj, "kuru": bool((sonuc or {}).get("kuru"))}


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
    _deneme_hazirla()   # uyarilar / goruldu sütunları (ayrı kısa işlem)
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
        out.append({"tur": "kapanis_red", "merkeze": (r.get("sebep") or "").startswith("Telefonsuz"),
                    "grup": "kasa", "id": r["id"], "tarih": r["is_gunu"].isoformat(),
                    "ad": adlar.get(str(r["sube_id"]), r["sube_id"]), "sebep": r.get("sebep") or "sonuç alınamadı",
                    "saat": str(r["zaman"])[5:16].replace("-", ".").replace(" ", " "), "islem": "/evvel-yeni/panel/gec-kapanis"})
    cur.execute("""SELECT id, sube_id, is_gunu, uyarilar, zaman FROM ey_panel_deneme
                    WHERE tur='kapanis' AND sonuc='ok_uyarili' AND goruldu IS NULL AND zaman >= NOW() - INTERVAL '7 days'
                      AND is_gunu >= %s ORDER BY zaman DESC""", (_baslangic(cur),))
    for r in [dict(x) for x in cur.fetchall() or []]:
        out.append({"tur": "kapanis_uyarili", "grup": "kasa", "id": r["id"], "tarih": r["is_gunu"].isoformat(),
                    "ad": adlar.get(str(r["sube_id"]), r["sube_id"]), "uyarilar": r.get("uyarilar") or [],
                    "saat": str(r["zaman"])[5:16].replace("-", "."), "gordum": "/evvel-yeni/panel/kapanis-uyari-gordum"})
    return out


@router.post("/kapanis-uyari-gordum")
def kapanis_uyari_gordum(body: DenemeBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez: uyarılı kapanışı gördü (iz: kim)."""
    from evvel_yeni_cekirdek import aktor
    _deneme_hazirla()
    with db() as (conn, cur):
        kim = aktor(cur, x_evvel_oturum)
        if kim in ("oturumsuz", "bilinmiyor"):
            raise HTTPException(401, "Merkez oturumu gerekli")
        cur.execute("""UPDATE ey_panel_deneme SET goruldu=%s WHERE id=%s AND tur='kapanis' AND sonuc='ok_uyarili' AND goruldu IS NULL
                       RETURNING id""", (kim, body.deneme_id))
        if not cur.fetchone():
            raise HTTPException(404, "Görülecek uyarılı kapanış yok")
    return {"ok": True}


# ─────────────────────────── MERKEZ: Bekleyen işler (personele gitmez) ───────────────────────────
def _bekleyen(cur, baglam: dict) -> list:
    """Panel açıldıysa: dün kapanışı olmayan aktif şube."""
    out = []
    try:
        out.extend(_kapanis_isleri(cur))   # 🛟 reddedilen kapanış — panel açılmadan da (deneme dışı) görünür
    except Exception as e:  # noqa: BLE001
        log.warning("panel kapanış denemeleri okunamadı: %s", str(e)[:150])
    # C-T1-16: "dün kapanış yok" satırı artık yalnız Kasa'dan (eksik_kapanis — yeni panel kapanışı Kasa'ya yazar); burada ikinci
    # kopya üretilmez (aynı gün iki bekleyen iş çıkıyordu).
    return out


bekleyen_is_kaydet("panel", _bekleyen)
