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

import logging
import re
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import List, Optional

from fastapi import APIRouter, HTTPException
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


def _personel(cur, sube_id: str, pid: Optional[str]) -> dict:
    """Ad seçimi (sahip: yetki fazına kadar PIN yok). Her kayıt personel kimliği taşır."""
    from evvel_yeni_tanim_api import secim_listeleri
    if not pid:
        raise HTTPException(400, "Adını seç")
    p = next((x for x in secim_listeleri(cur)["personel"] if str(x["id"]) == str(pid) and x["aktif"]), None)
    if not p:
        raise HTTPException(400, "Personel bulunamadı")
    if str(p.get("sube_id") or "") != str(sube_id):   # Codex: başka şubenin personeli bu şubeye yazamasın
        raise HTTPException(400, "Bu şubenin personeli değilsin — adını listeden seç")
    return {"id": str(p["id"]), "ad": p["ad"]}


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


def _calistir(sube_id: str, istek_id: Optional[str], is_fn) -> dict:
    """Ortak iskelet: hazırlık → tek işlem → (deneme modunda geri al). is_fn(cur, ctx) yazar ve özet döner."""
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
            ctx = {"gun": _bugun(), "sube": _sube(cur, sube_id), "kuru": _bugun() < _baslangic(cur)}
            sonuc = is_fn(cur, ctx)
            sonuc = {"ok": True, "kuru": ctx["kuru"], **sonuc}
            if ctx["kuru"]:
                raise _Kuru(sonuc)
            return sonuc
    except _Kuru as k:
        return {**k.sonuc, "mesaj": "DENEME — kaydedilmedi (panel " + "henüz açılmadı)"}


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
    def _u(x):
        return {"id": x["id"], "ad": x["ad"], "birim": x["birim"], "koli_ici": x.get("koli_ici")}
    return {"sube": {"id": s["id"], "ad": s["ad"]}, "gun": gun.isoformat(), "kuru": gun < bas, "panel_baslangic": bas.isoformat(),
            "personel": per, "teslim_alanlar": [{"id": c, "ad": c.split(":")[1].capitalize()} for c in TESLIM_ALANLAR],
            "sayilan": [{"kategori": k["ad"], "urunler": [_u(x) for x in k["urunler"] if x.get("takip") == "sayim" and x.get("panel_sayim")]}
                        for k in kat],
            "acilan": [{"kategori": k["ad"], "urunler": [_u(x) for x in k["urunler"] if x.get("takip") == "acilinca"]} for k in kat],
            "bugun": bugunku,
            "acilis_var": any(o["tur"] == "acilis" and not o["iptal"] for o in bugunku),
            "kapanis_var": any(o["tur"] == "kapanis" and not o["iptal"] for o in bugunku)}


# ─────────────────────────── YAZMA ───────────────────────────
class SayimSatir(BaseModel):
    urun_id: str
    sayilan: Optional[Decimal] = None


class AcilisBody(BaseModel):
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


def _sayim_satirlari(cur, sayim: List[SayimSatir]) -> list:
    satir = [{"urun_id": x.urun_id, "sayilan": _tam(x.sayilan, "Sayım")} for x in sayim if x.sayilan is not None]
    if satir:
        _urunler(cur, [x["urun_id"] for x in satir], takip="sayim")
    return satir


@router.post("/{sube_id}/acilis")
def acilis(sube_id: str, b: AcilisBody):
    """Açılış: kasadaki nakit + sayılan ürünler. Kasa sabah sayımı (gün−1'e) Kasa'nın kendi takvimiyle sonra yazılır
    (geç gelen kayıtlar kilide takılmasın — mevcut kural); burada ham olay + Depo günlük sayımı."""
    def is_(cur, c):
        from evvel_yeni_depo_api import sayim_yaz
        p = _personel(cur, sube_id, b.personel_id)
        kasa = _tl(b.kasa_sayim, "Kasadaki para")
        satir = _sayim_satirlari(cur, b.sayim)
        kok = f"panel:acilis:{sube_id}:{c['gun'].isoformat()}"
        oid = _olay(cur, sube_id=sube_id, tur="acilis", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                       personel_id=p["id"], personel_ad=p["ad"], tutar=Decimal(kasa) / 100,
                       veri={"kasa_sayim": kasa, "sayim": satir, "istek_id": b.istek_id,
                             "pasta_toplam": None if b.pasta_toplam is None else _tam(b.pasta_toplam, "Pasta")})
        d = sayim_yaz(cur, konum=f"depo:{sube_id}", satirlar=satir, kim=f"{KIM} · {p['ad']}", tur="gunluk",
                      kaynak_ref=f"{kok}:sayim") if satir else None
        return {"olay": oid, "tekrar": oid is None, "sayilan": len(satir) if d else 0, "mesaj": "Açılış kaydedildi"}
    return _calistir(sube_id, b.istek_id, is_)


class TeslimSatir(BaseModel):
    alan: str          # ev:onur · ev:fethi · ev:fatma
    tutar: Decimal


class KapanisBody(BaseModel):
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


@router.post("/{sube_id}/kapanis")
def kapanis(sube_id: str, b: KapanisBody):
    """Kapanış: ciro (nakit / POS / online) → Kasa kapanış beyanı; teslimler → Kasa teslim; sayım → Depo günlük sayımı
    (düşüş = kullanılan, sahip kararı); hepsi tek işlemde. Aynı gün ikinci kapanış Kasa'da reddedilir (düzeltme merkezde)."""
    def is_(cur, c):
        from evvel_yeni_depo_api import sayim_yaz
        from evvel_yeni_kasa_api import HareketBody, kasa_yaz
        p = _personel(cur, sube_id, b.personel_id)
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
        kim = f"{KIM} · {p['ad']}"
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
        d = sayim_yaz(cur, konum=f"depo:{sube_id}", satirlar=satir, kim=kim, tur="gunluk",
                      kaynak_ref=f"{kok}:sayim") if satir else None
        return {"olay": oid, "tekrar": oid is None and bool(k.get("tekrar")), "sayilan": len(satir) if d else 0,
                "mesaj": "Kapanış kaydedildi"}
    return _calistir(sube_id, b.istek_id, is_)


class DevirBody(BaseModel):
    devreden_id: str
    devralan_id: str
    sayilan: Decimal
    istek_id: str


@router.post("/{sube_id}/devir")
def kasa_devri(sube_id: str, b: DevirBody):
    """Vardiya kasa devri — yalnız ham olay (para el değiştirmez, aynı dükkân kasası)."""
    def is_(cur, c):
        a, v = _personel(cur, sube_id, b.devreden_id), _personel(cur, sube_id, b.devralan_id)
        if a["id"] == v["id"]:
            raise HTTPException(400, "Devreden ve devralan aynı kişi olamaz")
        k = _tl(b.sayilan, "Sayılan")
        oid = _olay(cur, sube_id=sube_id, tur="vardiya", is_gunu=c["gun"], kok=f"panel:vardiya:{sube_id}:{b.istek_id}",
                       kaynak_tablo="panel", personel_id=a["id"], personel_ad=a["ad"], tutar=Decimal(k) / 100,
                       veri={"devreden": a, "devralan": v, "sayilan": k})
        return {"olay": oid, "tekrar": oid is None, "mesaj": "Kasa devri kaydedildi"}
    return _calistir(sube_id, b.istek_id, is_)


class AraTeslimBody(BaseModel):
    personel_id: str
    alan: str
    tutar: Decimal
    istek_id: str


@router.post("/{sube_id}/ara-teslim")
def ara_teslim(sube_id: str, b: AraTeslimBody):
    """Gün içi para teslimi (Onur / Fethi / Fatma) → Kasa teslim ('onay bekliyor')."""
    def is_(cur, c):
        from evvel_yeni_kasa_api import HareketBody, kasa_yaz
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
    return _calistir(sube_id, b.istek_id, is_)


class Kalem(BaseModel):
    urun_id: str
    adet: Decimal


class UrunAcBody(BaseModel):
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
    def is_(cur, c):
        from evvel_yeni_depo_api import hareket_yaz
        p = _personel(cur, sube_id, b.personel_id)
        k = _kalemler(cur, b.kalemler, takip="acilinca")
        kok = f"panel:ac:{sube_id}:{b.istek_id}"
        oid = _olay(cur, sube_id=sube_id, tur="urun_ac", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                       personel_id=p["id"], personel_ad=p["ad"], veri={"kalemler": k})
        for i, x in enumerate(k):
            hareket_yaz(cur, kaynak_ref=f"{kok}:{i}", tur="ac", urun_id=x["urun_id"], urun_ad=x["ad"], adet=x["adet"],
                        kaynak=f"depo:{sube_id}", hedef="dışarı:tuketim", kim=f"{KIM} · {p['ad']}", bag=kok, gun=c["gun"])
        return {"olay": oid, "tekrar": oid is None, "mesaj": f"{len(k)} ürün açıldı"}
    return _calistir(sube_id, b.istek_id, is_)


class FireBody(BaseModel):
    personel_id: str
    kalemler: List[Kalem]
    sebep: str
    istek_id: str


@router.post("/{sube_id}/fire")
def fire(sube_id: str, b: FireBody):
    """Fire: Depo 'fire' depo:şube → dışarı:fire (sebep zorunlu)."""
    def is_(cur, c):
        from evvel_yeni_depo_api import hareket_yaz
        p = _personel(cur, sube_id, b.personel_id)
        sebep = (b.sebep or "").strip()[:200]
        if len(sebep) < 2:
            raise HTTPException(400, "Fire sebebini yaz")
        k = _kalemler(cur, b.kalemler)
        kok = f"panel:fire:{sube_id}:{b.istek_id}"
        oid = _olay(cur, sube_id=sube_id, tur="fire", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                       personel_id=p["id"], personel_ad=p["ad"], veri={"kalemler": k, "sebep": sebep})
        for i, x in enumerate(k):
            hareket_yaz(cur, kaynak_ref=f"{kok}:{i}", tur="fire", urun_id=x["urun_id"], urun_ad=x["ad"], adet=x["adet"],
                        kaynak=f"depo:{sube_id}", hedef="dışarı:fire", kim=f"{KIM} · {p['ad']}", aciklama=sebep, bag=kok, gun=c["gun"])
        return {"olay": oid, "tekrar": oid is None, "mesaj": "Fire kaydedildi"}
    return _calistir(sube_id, b.istek_id, is_)


# ─────────────────────────── MERKEZ: Bekleyen işler (personele gitmez) ───────────────────────────
def _bekleyen(cur, baglam: dict) -> list:
    """Panel açıldıysa: dün kapanışı olmayan aktif şube."""
    if _bugun() <= _baslangic(cur):
        return []
    from evvel_yeni_olay import olaylar
    from evvel_yeni_tanim_api import subeler
    dun = _bugun() - timedelta(days=1)
    kapanan = {str(o["sube_id"]) for o in olaylar(cur, bas=dun, son=dun, turler={"kapanis"}) if not o.get("iptal")}
    out = []
    for s in subeler(cur):
        if str(s["id"]) not in kapanan:
            out.append({"tur": "panel_kapanis_yok", "genel": True, "grup": "kasa", "id": f"panel_kapanis:{s['id']}:{dun}",
                        "tarih": dun.isoformat(), "etiket": "🧾 Kapanış yok", "ad": f"{s['ad']} — {dun.strftime('%d.%m')} kapanışı yapılmadı",
                        "alt": "Şube panelinden kapanış gelmedi", "sayfa": None, "dugme": None})
    return out


bekleyen_is_kaydet("panel", _bekleyen)
