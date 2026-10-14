"""🧵 PARA İZİ — sade çekirdeğin ilk tuğlası (2026-10-15).

Sahip: *"Evvel her şeyi takip etsin dedik ama hem çok karışık hem sürekli hata
yapıyor; sade kurup sonra işlevi artıralım. Eski sistemden AYRI bir modül
olarak kur, bu aydan itibaren."*

Bu modül ESKİ PARA TABLOLARINA HİÇ YAZMAZ (kasa_hareketleri, kasa_teslim,
ciro…). Kendi iki tablosu var; eski sistemden yalnız OKUYARAK, tek yönlü ve
kaynak kimliğiyle (kaynak_ref) aktarım yapar. Eski sistem çökse de bu modül,
bu modül çökse de eski sistem etkilenmez.

MODEL (sahip kararları, [[project_sade_cekirdek_yeniden_kurgu]]):
  · Para TEK HAVUZ. Şubenin "hakkı / emaneti / destek bakiyesi" YOKTUR.
  · Para yalnız CEPLERDE durur: şube kasaları · patron evleri (Onur, Fethi,
    Fatma) · geçiş hesabı (Fethi'nin hesabı — "giren çıkmalı").
  · İsimsiz "merkez kovası" YOKTUR — her lira adı olan bir cepte durur.
  · Eksik para SİLİNMEZ ve gider SAYILMAZ: "açık fark" olarak sebebi bulunana
    kadar bekler; kapatma kim/ne zaman/neden ile yazılır.
  · Kayıtlar DEĞİŞTİRİLMEZ/SİLİNMEZ; geri almak = "iptal" kaydı (ters kayıt).
  · Tutarlar veritabanında KURUŞ (BIGINT) — float yuvarlama hatası yok.
  · Bakiyeler saklanmaz, her istekte hareketlerden TÜRETİLİR → iki rakamın
    birbirinden kopması imkânsız ("ekran kendi aritmetiğini kurmaz").
"""

import json
import logging
import uuid
from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from database import db, savepoint

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/para-izi", tags=["para-izi"])

BASLANGIC = date(2026, 10, 1)          # sahip: "bu aydan itibaren kurgula"
ACIK = "__acik"                          # açık fark kovası (cep değil)
TEMIZ_ESIK = 50                          # kuruş — 0,50 ₺ altı "sıfır" sayılır

PATRON_CEPLERI = [
    ("ev:onur", "Onur'un evi", "Onur", "ev", 10),
    ("ev:fethi", "Fethi'nin evi", "Fethi", "ev", 11),
    ("ev:fatma", "Fatma'nın evi", "Fatma", "ev", 12),
    ("hesap:fethi", "Fethi'nin hesabı", "Fethi hesabı", "hesap", 40),
]
DIS_TURLERI = {
    "borc": ("Borç alındı", "Borç", True),
    "kredi": ("Kredi çekildi", "Kredi", True),
    "kira": ("Kira geliri", "Kira", False),
    "satis": ("Satış (demirbaş, eşya vb.)", "Satış dışı", False),
    "destek": ("Patron desteği (maaştan)", "Destek", False),
    "diger": ("Diğer giriş", "Diğer", False),
}
SEBEPLER = {
    "bulundu": "Yanlış sayılmış / bulundu",
    "subede": "Şubede kalmış",
    "harcandi": "Elden harcanmış, kaydı girilmemiş",
    "kayip": "Kayıp / kasa açığı",
    "kabul": "Fazla para kabul edildi",
}
HAREKET_TURLERI = {"acilis", "kapanis", "dis", "teslim", "tasima", "odeme", "sayim", "cozum", "iptal"}


# ─────────────────────────── TABLOLAR ───────────────────────────
_HAZIR = False


def _tablolar(cur) -> None:
    """Modülün KENDİ tabloları — lazy, idempotent. Sıcak tabloya ALTER YOK."""
    global _HAZIR
    if _HAZIR:
        return
    cur.execute("SET LOCAL lock_timeout = '3s'")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS para_izi_cep (
            id      TEXT PRIMARY KEY,
            ad      TEXT NOT NULL,
            kisa    TEXT NOT NULL,
            tur     TEXT NOT NULL CHECK (tur IN ('sube','ev','hesap')),
            sube_id TEXT,
            sira    INTEGER NOT NULL DEFAULT 0,
            aktif   BOOLEAN NOT NULL DEFAULT TRUE
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS para_izi_hareket (
            id            TEXT PRIMARY KEY,
            tur           TEXT NOT NULL,
            is_gunu       DATE NOT NULL,
            kayit_zamani  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            kaydeden      TEXT,
            cep           TEXT,
            kaynak        TEXT,
            hedef         TEXT,
            tutar         BIGINT NOT NULL DEFAULT 0,
            durum         TEXT,
            onay_zamani   TIMESTAMPTZ,
            onaylayan     TEXT,
            veri          JSONB NOT NULL DEFAULT '{}'::jsonb,
            kaynak_ref    TEXT UNIQUE
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_para_izi_hareket_gun ON para_izi_hareket (is_gunu, kayit_zamani)")
    # Cepler: patronlar + geçiş hesabı sabit; şube kasaları `subeler`den.
    for cid, ad, kisa, tur, sira in PATRON_CEPLERI:
        cur.execute(
            "INSERT INTO para_izi_cep (id, ad, kisa, tur, sira) VALUES (%s,%s,%s,%s,%s) "
            "ON CONFLICT (id) DO NOTHING", (cid, ad, kisa, tur, sira))
    try:
        with savepoint(cur, "sp_pi_sube"):
            cur.execute("SELECT id, ad FROM subeler WHERE aktif = TRUE ORDER BY ad")
            for i, r in enumerate(cur.fetchall() or []):
                r = dict(r)
                ad = (r.get("ad") or "").strip() or str(r["id"])
                cur.execute(
                    "INSERT INTO para_izi_cep (id, ad, kisa, tur, sube_id, sira) "
                    "VALUES (%s,%s,%s,'sube',%s,%s) ON CONFLICT (id) DO NOTHING",
                    ("sube:" + str(r["id"]), ad + " kasası", ad, str(r["id"]), 20 + i))
    except Exception as e:  # noqa: BLE001 — şube listesi okunamazsa patron cepleriyle devam
        log.warning("para-izi: subeler okunamadi: %s", str(e)[:200])
    _HAZIR = True


# ─────────────────────────── OKUMA ───────────────────────────
def _cepler(cur) -> List[dict]:
    cur.execute("SELECT id, ad, kisa, tur, sube_id, sira FROM para_izi_cep WHERE aktif ORDER BY sira, ad")
    return [dict(r) for r in cur.fetchall() or []]


def _hareketler(cur) -> List[dict]:
    """İptal edilmemiş bütün hareketler, iş günü + kayıt sırasıyla."""
    cur.execute("""
        SELECT id, tur, is_gunu, kayit_zamani, kaydeden, cep, kaynak, hedef, tutar,
               durum, onay_zamani, onaylayan, veri, kaynak_ref
          FROM para_izi_hareket ORDER BY is_gunu, kayit_zamani, id
    """)
    rows = []
    for r in cur.fetchall() or []:
        r = dict(r)
        v = r.get("veri")
        r["veri"] = v if isinstance(v, dict) else (json.loads(v) if v else {})
        r["is_gunu"] = r["is_gunu"].isoformat() if hasattr(r["is_gunu"], "isoformat") else str(r["is_gunu"])
        rows.append(r)
    iptaller = {r["veri"].get("hedef_id") for r in rows if r["tur"] == "iptal"}
    return [r for r in rows if r["tur"] != "iptal" and r["id"] not in iptaller]


# ─────────────────────────── MOTOR ───────────────────────────
def _etki(h: dict, C: dict) -> List[dict]:
    """Bir hareketin ceplere etkisi (kuruş). Tek doğru yer — ekran tekrar etmez."""
    t, v = h["tur"], h["veri"]
    ad = lambda cid: C.get(cid, {}).get("ad", cid)  # noqa: E731
    kisa = lambda cid: C.get(cid, {}).get("kisa", cid)  # noqa: E731
    if t == "acilis":
        return [{"cep": h["cep"], "d": h["tutar"], "etiket": "Açılış bakiyesi", "kaynak": "Açılış"}]
    if t == "kapanis":
        return [{"cep": h["cep"], "d": h["tutar"],
                 "etiket": "Kapanış nakdi" + ("" if h["durum"] == "onaylandi" else " (onay bekliyor)"), "kaynak": "Satış"}]
    if t == "dis":
        alt = v.get("alt", "diger")
        k = (v.get("kimden") or "Patron") + " desteği" if alt == "destek" else DIS_TURLERI.get(alt, DIS_TURLERI["diger"])[1]
        return [{"cep": h["cep"], "d": h["tutar"],
                 "etiket": DIS_TURLERI.get(alt, DIS_TURLERI["diger"])[0] + (" · " + v["kimden"] if v.get("kimden") else ""), "kaynak": k}]
    if t == "teslim":
        r = [{"cep": h["kaynak"], "d": -h["tutar"],
              "etiket": "Teslim → " + ad(h["hedef"]) + (" (onay bekliyor)" if h["durum"] != "onaylandi" else "")}]
        if h["durum"] == "onaylandi":
            al = int(v.get("alinan", h["tutar"]))
            r.append({"cep": h["hedef"], "d": al, "etiket": "Teslim ← " + ad(h["kaynak"]), "kaynak": kisa(h["kaynak"])})
            if abs(h["tutar"] - al) >= TEMIZ_ESIK:
                r.append({"cep": ACIK, "d": h["tutar"] - al, "etiket": "Teslim farkı"})
        return r
    if t == "tasima":
        return [{"cep": h["kaynak"], "d": -h["tutar"], "etiket": "→ " + ad(h["hedef"])},
                {"cep": h["hedef"], "d": h["tutar"], "etiket": "← " + ad(h["kaynak"]), "kaynak": kisa(h["kaynak"])}]
    if t == "odeme":
        return [{"cep": p["cep"], "d": -int(p["tutar"]), "etiket": "Ödeme · " + (v.get("aciklama") or "")}
                for p in v.get("parcalar", [])]
    if t == "sayim":
        f = int(v.get("beklenen", 0)) - int(v.get("sayilan", 0))
        if abs(f) < TEMIZ_ESIK:
            return []
        return [{"cep": h["cep"], "d": -f, "etiket": "Sayım farkı"}, {"cep": ACIK, "d": f, "etiket": "Sayım farkı"}]
    if t == "cozum":
        f, sb = int(v.get("f", 0)), v.get("sebep")
        r = [{"cep": ACIK, "d": -f, "etiket": "Fark çözüldü"}]
        if sb == "bulundu":
            r.append({"cep": v.get("cep"), "d": f, "etiket": "Fark çözüldü · " + SEBEPLER[sb]})
        elif sb == "subede":
            r.append({"cep": v.get("sube_cep"), "d": f, "etiket": "Fark çözüldü · " + SEBEPLER[sb]})
        return r
    return []


def _bakiye(hs: List[dict], C: dict) -> dict:
    b = {cid: 0 for cid in C}
    b[ACIK] = 0
    yolda = kayip = 0
    for h in hs:
        for e in _etki(h, C):
            b[e["cep"]] = b.get(e["cep"], 0) + e["d"]
        if h["tur"] == "teslim" and h["durum"] != "onaylandi":
            yolda += h["tutar"]
        if h["tur"] == "cozum" and h["veri"].get("sebep") in ("kayip", "harcandi"):
            kayip += int(h["veri"].get("f", 0))
    top = lambda tur: sum(b[c] for c, x in C.items() if x["tur"] == tur)  # noqa: E731
    ev, sube, gecis = top("ev"), top("sube"), top("hesap")
    toplam = ev + sube + gecis + yolda
    return {"b": b, "ev": ev, "sube": sube, "gecis": gecis, "yolda": yolda, "toplam": toplam,
            "acik": b[ACIK], "defter": toplam + b[ACIK], "kayip": kayip}


def _farklar(hs: List[dict], C: dict) -> List[dict]:
    coz = {h["veri"].get("fark_id"): h for h in hs if h["tur"] == "cozum"}
    out = []
    for h in hs:
        if h["tur"] == "teslim" and h["durum"] == "onaylandi":
            f = h["tutar"] - int(h["veri"].get("alinan", h["tutar"]))
            if abs(f) >= TEMIZ_ESIK:
                out.append({"id": h["id"], "tarih": h["is_gunu"], "tur": "teslim", "f": f, "cep": h["hedef"],
                            "sube_cep": h["kaynak"], "ad": f"{C.get(h['kaynak'],{}).get('ad','?')} → {C.get(h['hedef'],{}).get('ad','?')} teslimi"})
        if h["tur"] == "sayim":
            f = int(h["veri"].get("beklenen", 0)) - int(h["veri"].get("sayilan", 0))
            if abs(f) >= TEMIZ_ESIK:
                out.append({"id": h["id"], "tarih": h["is_gunu"], "tur": "sayim", "f": f, "cep": h["cep"],
                            "sube_cep": None, "ad": f"{C.get(h['cep'],{}).get('ad','?')} sayımı"})
    for x in out:
        c = coz.get(x["id"])
        x["coz"] = None if not c else {"sebep": c["veri"].get("sebep"), "sebep_ad": SEBEPLER.get(c["veri"].get("sebep"), ""),
                                        "sorumlu": c["veri"].get("sorumlu"), "not": c["veri"].get("not"), "tarih": c["is_gunu"]}
    return out


def _gun_fark(a: str, b: str) -> int:
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def _cep_iz(cid: str, hs: List[dict], C: dict) -> dict:
    bal, seg, tum, bosaldi = 0, [], [], None
    for h in hs:
        for e in _etki(h, C):
            if e["cep"] != cid:
                continue
            bal += e["d"]
            r = {"hareket_id": h["id"], "tur": h["tur"], "tarih": h["is_gunu"], "d": e["d"], "bakiye": bal,
                 "etiket": e["etiket"], "kaynak": e.get("kaynak")}
            tum.append(r)
            seg.append(r)
            if abs(bal) < TEMIZ_ESIK:
                bosaldi, seg = r, []
    return {"bal": bal, "seg": seg, "tum": tum, "bosaldi": bosaldi}


def _cep_durum(c: dict, hs: List[dict], D: dict, ref: str, fl: List[dict]) -> dict:
    cid = c["id"]
    iz = _cep_iz(cid, hs, _C_CACHE)
    bal = D["b"].get(cid, 0)
    bos = abs(bal) < TEMIZ_ESIK
    kir, sar = [], []
    for x in fl:
        if not x["coz"] and (x["cep"] == cid or x["sube_cep"] == cid):
            kir.append(f"{_tl(abs(x['f']))} {'eksik' if x['f'] > 0 else 'fazla'} · açık fark ({'teslim' if x['tur']=='teslim' else 'sayım'}, {x['tarih']})")
    for h in hs:
        if h["tur"] == "teslim" and h["durum"] != "onaylandi" and cid in (h["kaynak"], h["hedef"]):
            sar.append(f"{_tl(h['tutar'])} teslim \"aldı\" onayı bekliyor" if h["hedef"] == cid
                       else f"{_tl(h['tutar'])} teslim edildi, alan onaylamadı")
    son_teslim = None
    if c["tur"] == "sube":
        ts = [h["is_gunu"] for h in hs if h["tur"] == "teslim" and h["kaynak"] == cid]
        son_teslim = ts[-1] if ts else None
        onaysiz = [h for h in hs if h["tur"] == "kapanis" and h["cep"] == cid and h["durum"] != "onaylandi"]
        if onaysiz:
            sar.append(f"{len(onaysiz)} kapanış onaysız ({_tl(sum(h['tutar'] for h in onaysiz))})")
        if not bos:
            g = _gun_fark(son_teslim, ref) if son_teslim else None
            if g is None or g >= 7:
                kir.append("Bu dönemde hiç teslim yok" if g is None else f"{g} gündür teslim yok")
            elif g >= 4:
                sar.append(f"{g} gündür teslim yok")
    if c["tur"] == "hesap" and not bos:
        ilk = next((r for r in iz["seg"] if r["d"] > 0), None)
        g = _gun_fark(ilk["tarih"], ref) if ilk else 0
        (kir if g >= 3 else sar).append(f"{_tl(bal)} {g} gündür hesapta bekliyor")
    gelen = {}
    for r in iz["seg"]:
        if r["d"] > 0:
            gelen[r["kaynak"] or "?"] = gelen.get(r["kaynak"] or "?", 0) + r["d"]
    cikan = sum(-r["d"] for r in iz["seg"] if r["d"] < 0)
    seviye = "kirmizi" if kir else "sari" if sar else "gri" if bos else "yesil"
    return {"id": cid, "ad": c["ad"], "kisa": c["kisa"], "tur": c["tur"], "bakiye": _tl_sayi(bal),
            "seviye": seviye, "kirmizi": kir, "sari": sar,
            "gelen": [{"kaynak": k, "tutar": _tl_sayi(v), "cep": _kisa_to_cep(k)} for k, v in gelen.items()],
            "cikan": _tl_sayi(cikan), "son_teslim": son_teslim,
            "bosaldi": None if not iz["bosaldi"] or not bos else {"tarih": iz["bosaldi"]["tarih"], "etiket": iz["bosaldi"]["etiket"]}}


_C_CACHE: dict = {}


def _kisa_to_cep(k: str) -> Optional[str]:
    for cid, c in _C_CACHE.items():
        if c["kisa"] == k:
            return cid
    return None


def _tl_sayi(k: int) -> float:
    return round(k / 100.0, 2)


def _tl(k: int) -> str:
    s = f"{abs(k) / 100:,.0f}".replace(",", ".")
    return ("−" if k < 0 else "") + s + " ₺"


def _kurus(x) -> int:
    try:
        return int(round(float(x) * 100))
    except (TypeError, ValueError):
        raise HTTPException(400, "Tutar sayı olmalı")


def _hareket_dto(h: dict, C: dict, hs: List[dict]) -> dict:
    v = h["veri"]
    d = {"id": h["id"], "tur": h["tur"], "tarih": h["is_gunu"], "kaydeden": h.get("kaydeden"), "durum": h.get("durum"),
         "cep": h.get("cep"), "kaynak": h.get("kaynak"), "hedef": h.get("hedef"), "tutar": _tl_sayi(h["tutar"]),
         "eski_sistem": bool(h.get("kaynak_ref"))}
    if h["tur"] == "kapanis":
        d["kart"] = _tl_sayi(int(v.get("kart", 0)))
    elif h["tur"] == "teslim":
        d["alinan"] = _tl_sayi(int(v.get("alinan", h["tutar"])))
    elif h["tur"] == "dis":
        alt = v.get("alt", "diger")
        d.update(alt=alt, alt_ad=DIS_TURLERI.get(alt, DIS_TURLERI["diger"])[0], geri_odenecek=DIS_TURLERI.get(alt, DIS_TURLERI["diger"])[2],
                 kimden=v.get("kimden"), not_=v.get("not"))
    elif h["tur"] == "sayim":
        d.update(beklenen=_tl_sayi(int(v.get("beklenen", 0))), sayilan=_tl_sayi(int(v.get("sayilan", 0))))
    elif h["tur"] == "cozum":
        d.update(sebep=v.get("sebep"), sebep_ad=SEBEPLER.get(v.get("sebep"), ""), sorumlu=v.get("sorumlu"),
                 not_=v.get("not"), fark_ad=v.get("fark_ad"), f=_tl_sayi(int(v.get("f", 0))))
    elif h["tur"] == "odeme":
        i = hs.index(h)
        once, sonra = _bakiye(hs[:i], C), _bakiye(hs[:i + 1], C)
        d.update(aciklama=v.get("aciklama"), kimin=v.get("kimin") or "Ortak",
                 parcalar=[{"cep": p["cep"], "tutar": _tl_sayi(int(p["tutar"])),
                            "once": _tl_sayi(once["b"].get(p["cep"], 0)), "sonra": _tl_sayi(sonra["b"].get(p["cep"], 0))}
                           for p in v.get("parcalar", [])],
                 toplam_once=_tl_sayi(once["toplam"]), toplam_sonra=_tl_sayi(sonra["toplam"]))
    return d


def _ozet(D: dict) -> dict:
    return {k: _tl_sayi(D[k]) for k in ("toplam", "ev", "sube", "gecis", "yolda", "acik", "defter", "kayip")}


def _isler(hs: List[dict], C: dict, fl: List[dict]) -> List[dict]:
    """Bekleyen işler — GÜNE BAĞLI DEĞİL, en eski üstte (sahip: 'onayları gözden kaçırırız')."""
    out = []
    for h in hs:
        if h["tur"] == "kapanis" and h["durum"] != "onaylandi":
            out.append({"tur": "kapanis", "id": h["id"], "tarih": h["is_gunu"], "cep": h["cep"], "ad": C.get(h["cep"], {}).get("ad"),
                        "nakit": _tl_sayi(h["tutar"]), "kart": _tl_sayi(int(h["veri"].get("kart", 0)))})
        if h["tur"] == "teslim" and h["durum"] != "onaylandi":
            out.append({"tur": "teslim", "id": h["id"], "tarih": h["is_gunu"], "kaynak": h["kaynak"], "hedef": h["hedef"],
                        "ad": f"{C.get(h['kaynak'],{}).get('ad')} → {C.get(h['hedef'],{}).get('ad')}",
                        "hedef_kisa": C.get(h["hedef"], {}).get("kisa"), "tutar": _tl_sayi(h["tutar"])})
    for x in fl:
        if not x["coz"]:
            out.append({"tur": "fark", "id": x["id"], "tarih": x["tarih"], "ad": x["ad"], "f": _tl_sayi(x["f"])})
    out.sort(key=lambda x: x["tarih"])
    return out


def _yukle(cur):
    _tablolar(cur)
    cep_list = _cepler(cur)
    C = {c["id"]: c for c in cep_list}
    _C_CACHE.clear()
    _C_CACHE.update(C)
    return cep_list, C, _hareketler(cur)


# ─────────────────────────── UÇLAR: OKUMA ───────────────────────────
@router.get("/durum")
def durum(gun: Optional[str] = None, hepsi: bool = False):
    """Tek ekranın bütün verisi: seçilen gün AKŞAMI para nerede + o günün hareketleri
    + güne bağlı olmayan bekleyen işler. Hata yutmaz → ekran 'okunamadı' der."""
    with db() as (conn, cur):
        cep_list, C, tum = _yukle(cur)
    bugun = date.today().isoformat()
    g = (gun or bugun)[:10]
    try:
        date.fromisoformat(g)
    except ValueError:
        raise HTTPException(400, "gun YYYY-AA-GG olmalı")
    ref = bugun if hepsi else g
    hs = tum if hepsi else [h for h in tum if h["is_gunu"] <= g]
    D = _bakiye(hs, C)
    onceki = None if hepsi else _bakiye([h for h in tum if h["is_gunu"] < g], C)
    fl = _farklar(hs, C)
    gunun = tum if hepsi else [h for h in tum if h["is_gunu"] == g]
    kpi = {
        "satis_nakdi": _tl_sayi(sum(h["tutar"] for h in gunun if h["tur"] == "kapanis")),
        "kart": _tl_sayi(sum(int(h["veri"].get("kart", 0)) for h in gunun if h["tur"] == "kapanis")),
        "dis_giris": _tl_sayi(sum(h["tutar"] for h in gunun if h["tur"] == "dis")),
        "teslim": _tl_sayi(sum(h["tutar"] for h in gunun if h["tur"] == "teslim")),
        "odenen": _tl_sayi(sum(h["tutar"] for h in gunun if h["tur"] == "odeme")),
    }
    cep_durumlari = [_cep_durum(c, hs, D, ref, fl) for c in cep_list]
    return {
        "gun": g, "hepsi": hepsi, "baslangic": BASLANGIC.isoformat(), "bugun": bugun,
        "ozet": _ozet(D), "onceki_toplam": None if onceki is None else _tl_sayi(onceki["toplam"]),
        "cepler": cep_durumlari,
        "seviye_sayim": {"kirmizi": sum(1 for c in cep_durumlari if c["seviye"] == "kirmizi"),
                         "sari": sum(1 for c in cep_durumlari if c["seviye"] == "sari")},
        "kpi": kpi,
        "hareketler": [_hareket_dto(h, C, tum) for h in gunun],
        "isler": _isler(tum, C, _farklar(tum, C)),
        "acik_fark_sayisi": sum(1 for x in fl if not x["coz"]),
        "dis_turleri": [{"kod": k, "ad": v[0], "geri_odenecek": v[2]} for k, v in DIS_TURLERI.items()],
        "anlik_bakiye": {cid: _tl_sayi(v) for cid, v in _bakiye(tum, C)["b"].items() if cid != ACIK},
        "acilis_girilen": sorted({h["cep"] for h in tum if h["tur"] == "acilis"}),
        "hareket_sayisi": len(tum),
    }


@router.get("/cep/{cep_id:path}")
def cep_detay(cep_id: str, gun: Optional[str] = None, hepsi: bool = False):
    with db() as (conn, cur):
        cep_list, C, tum = _yukle(cur)
    if cep_id not in C:
        raise HTTPException(404, "Cep bulunamadı")
    g = (gun or date.today().isoformat())[:10]
    hs = tum if hepsi else [h for h in tum if h["is_gunu"] <= g]
    D = _bakiye(hs, C)
    fl = _farklar(hs, C)
    iz = _cep_iz(cep_id, hs, C)
    fark_ids = {x["id"] for x in fl}
    return {
        "cep": _cep_durum(C[cep_id], hs, D, date.today().isoformat() if hepsi else g, fl),
        "gelen_toplam": _tl_sayi(sum(r["d"] for r in iz["seg"] if r["d"] > 0)),
        "iz": [{**r, "d": _tl_sayi(r["d"]), "bakiye": _tl_sayi(r["bakiye"]), "fark": r["hareket_id"] in fark_ids}
               for r in reversed(iz["tum"])],
        "farklar": [{**x, "f": _tl_sayi(x["f"])} for x in fl if x["cep"] == cep_id or x["sube_cep"] == cep_id],
    }


@router.get("/acik-defter")
def acik_defter():
    """Açık farklar defteri — sahip: 'açıkları toplayarak gün gün toplam açık tutmalıyım'."""
    with db() as (conn, cur):
        cep_list, C, tum = _yukle(cur)
    fl = _farklar(tum, C)
    gunler = sorted({h["is_gunu"] for h in tum})
    satir, kum = [], 0
    for d in gunler:
        yeni = sum(x["f"] for x in fl if x["tarih"] == d)
        cz = [h for h in tum if h["tur"] == "cozum" and h["is_gunu"] == d]
        geri = sum(int(h["veri"].get("f", 0)) for h in cz if h["veri"].get("sebep") not in ("kayip", "harcandi"))
        kay = sum(int(h["veri"].get("f", 0)) for h in cz if h["veri"].get("sebep") in ("kayip", "harcandi"))
        kum += kay
        son = _bakiye([h for h in tum if h["is_gunu"] <= d], C)["acik"]
        if abs(yeni) + abs(geri) + abs(kay) + abs(son) < TEMIZ_ESIK:
            continue
        satir.append({"gun": d, "yeni": _tl_sayi(yeni), "geri_donen": _tl_sayi(geri), "kayba_yazilan": _tl_sayi(kay),
                      "gun_sonu_acik": _tl_sayi(son), "toplam_kayip": _tl_sayi(kum)})
    D = _bakiye(tum, C)
    return {"acik": _tl_sayi(D["acik"]), "kayip": _tl_sayi(D["kayip"]),
            "farklar": [{**x, "f": _tl_sayi(x["f"])} for x in fl], "gun_gun": satir}


@router.get("/fark/{fark_id}")
def fark_detay(fark_id: str):
    with db() as (conn, cur):
        cep_list, C, tum = _yukle(cur)
    x = next((z for z in _farklar(tum, C) if z["id"] == fark_id), None)
    if not x:
        raise HTTPException(404, "Fark bulunamadı")
    secenek = (["bulundu"] + (["subede"] if x["tur"] == "teslim" else []) + ["harcandi", "kayip"]) if x["f"] > 0 else ["bulundu", "kabul"]
    return {**x, "f": _tl_sayi(x["f"]), "cep_ad": C.get(x["cep"], {}).get("ad"),
            "sube_cep_ad": C.get(x["sube_cep"], {}).get("ad") if x["sube_cep"] else None,
            "sebep_secenekleri": [{"kod": s, "ad": ("Sayım hatası, defter doğru" if x["f"] < 0 and s == "bulundu" else SEBEPLER[s])} for s in secenek]}


# ─────────────────────────── UÇLAR: YAZMA ───────────────────────────
class Parca(BaseModel):
    cep: str
    tutar: float


class HareketBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    tur: str
    is_gunu: Optional[str] = None
    kaydeden: Optional[str] = None
    cep: Optional[str] = None
    kaynak: Optional[str] = None
    hedef: Optional[str] = None
    tutar: Optional[float] = None
    kart: Optional[float] = None
    alt: Optional[str] = None
    kimden: Optional[str] = None
    not_: Optional[str] = Field(None, alias="not")
    aciklama: Optional[str] = None
    kimin: Optional[str] = None
    parcalar: Optional[List[Parca]] = None
    sayilan: Optional[float] = None
    fark_id: Optional[str] = None
    sebep: Optional[str] = None
    sorumlu: Optional[str] = None


def _yaz(cur, tur, gun, kaydeden, cep=None, kaynak=None, hedef=None, tutar=0, durum=None, veri=None, kaynak_ref=None):
    hid = str(uuid.uuid4())
    cur.execute("""
        INSERT INTO para_izi_hareket (id, tur, is_gunu, kaydeden, cep, kaynak, hedef, tutar, durum, veri, kaynak_ref)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s)
        ON CONFLICT (kaynak_ref) DO NOTHING RETURNING id
    """, (hid, tur, gun, (kaydeden or "")[:60] or None, cep, kaynak, hedef, int(tutar), durum,
          json.dumps(veri or {}, ensure_ascii=False), kaynak_ref))
    r = cur.fetchone()
    return dict(r)["id"] if r else None


@router.post("/hareket")
def hareket_ekle(body: HareketBody):
    """Tek yazma kapısı. Tek transaction: ya tamamı yazılır ya hiçbiri (sessiz başarı yok)."""
    t = body.tur
    if t not in HAREKET_TURLERI - {"iptal"}:
        raise HTTPException(400, "Geçersiz tür")
    gun = (body.is_gunu or date.today().isoformat())[:10]
    try:
        gd = date.fromisoformat(gun)
    except ValueError:
        raise HTTPException(400, "Gün YYYY-AA-GG olmalı")
    if gd < BASLANGIC:
        raise HTTPException(400, f"Para İzi {BASLANGIC.strftime('%d.%m.%Y')} tarihinden başlar")
    if gd > date.today() + timedelta(days=1):
        raise HTTPException(400, "Gelecek tarihli kayıt girilemez")
    with db() as (conn, cur):
        cep_list, C, tum = _yukle(cur)
        B = _bakiye(tum, C)["b"]

        def cep_var(cid, turler=None):
            if not cid or cid not in C or (turler and C[cid]["tur"] not in turler):
                raise HTTPException(400, "Cep bulunamadı")

        def yeter(cid, k):
            if k > B.get(cid, 0) + TEMIZ_ESIK:
                raise HTTPException(400, f"{C[cid]['ad']} içinde {_tl(B.get(cid, 0))} var")

        tut = _kurus(body.tutar) if body.tutar is not None else 0
        if t == "acilis":
            cep_var(body.cep)
            if tut < 0:
                raise HTTPException(400, "Açılış bakiyesi eksi olamaz")
            if any(h["tur"] == "acilis" and h["cep"] == body.cep for h in tum):
                raise HTTPException(409, "Bu cebin açılış bakiyesi zaten girilmiş. Düzeltmek için önce eskisini iptal et.")
            hid = _yaz(cur, t, BASLANGIC.isoformat(), body.kaydeden, cep=body.cep, tutar=tut)
        elif t == "kapanis":
            cep_var(body.cep, {"sube"})
            kart = _kurus(body.kart or 0)
            if tut < 0 or kart < 0 or (tut == 0 and kart == 0):
                raise HTTPException(400, "Nakit ya da kart tutarı gir")
            if any(h["tur"] == "kapanis" and h["cep"] == body.cep and h["is_gunu"] == gun for h in tum):
                raise HTTPException(409, "Bu şubenin bu güne ait kapanışı zaten var")
            hid = _yaz(cur, t, gun, body.kaydeden, cep=body.cep, tutar=tut, durum="bekliyor", veri={"kart": kart})
        elif t == "dis":
            cep_var(body.cep)
            alt = body.alt if body.alt in DIS_TURLERI else None
            if not alt:
                raise HTTPException(400, "Giriş türü seç")
            if tut <= 0:
                raise HTTPException(400, "Tutar gir")
            if alt in ("destek", "borc", "kredi") and not (body.kimden or "").strip():
                raise HTTPException(400, "Kimden geldiğini yaz")
            hid = _yaz(cur, t, gun, body.kaydeden, cep=body.cep, tutar=tut,
                       veri={"alt": alt, "kimden": (body.kimden or "").strip()[:80], "not": (body.not_ or "").strip()[:200]})
        elif t == "teslim":
            cep_var(body.kaynak, {"sube"})
            cep_var(body.hedef, {"ev"})
            if tut <= 0:
                raise HTTPException(400, "Tutar gir")
            yeter(body.kaynak, tut)
            hid = _yaz(cur, t, gun, body.kaydeden, kaynak=body.kaynak, hedef=body.hedef, tutar=tut, durum="bekliyor")
        elif t == "tasima":
            cep_var(body.kaynak)
            cep_var(body.hedef, {"ev", "hesap"})
            if body.kaynak == body.hedef:
                raise HTTPException(400, "Nereden ve nereye aynı olamaz")
            if tut <= 0:
                raise HTTPException(400, "Tutar gir")
            yeter(body.kaynak, tut)
            hid = _yaz(cur, t, gun, body.kaydeden, kaynak=body.kaynak, hedef=body.hedef, tutar=tut)
        elif t == "odeme":
            ac = (body.aciklama or "").strip()
            if not ac:
                raise HTTPException(400, "Ne ödendiğini yaz")
            ps = [{"cep": p.cep, "tutar": _kurus(p.tutar)} for p in (body.parcalar or []) if p.tutar and p.tutar > 0]
            if not ps:
                raise HTTPException(400, "En az bir kaynak ekle")
            if len({p["cep"] for p in ps}) != len(ps):
                raise HTTPException(400, "Aynı cep iki kez seçilemez")
            for p in ps:
                cep_var(p["cep"])
                yeter(p["cep"], p["tutar"])
            top = sum(p["tutar"] for p in ps)
            if abs(top - tut) >= TEMIZ_ESIK:
                raise HTTPException(400, f"Kaynaklar ({_tl(top)}) ödemeye ({_tl(tut)}) eşit olmalı")
            hid = _yaz(cur, t, gun, body.kaydeden, tutar=top,
                       veri={"aciklama": ac[:120], "kimin": (body.kimin or "Ortak")[:40], "parcalar": ps})
        elif t == "sayim":
            cep_var(body.cep)
            if body.sayilan is None or body.sayilan < 0:
                raise HTTPException(400, "Sayılan tutarı gir")
            beklenen = _bakiye([h for h in tum if h["is_gunu"] <= gun], C)["b"].get(body.cep, 0)
            hid = _yaz(cur, t, gun, body.kaydeden, cep=body.cep, tutar=_kurus(body.sayilan),
                       veri={"beklenen": beklenen, "sayilan": _kurus(body.sayilan)})
        elif t == "cozum":
            x = next((z for z in _farklar(tum, C) if z["id"] == body.fark_id), None)
            if not x:
                raise HTTPException(404, "Fark bulunamadı")
            if x["coz"]:
                raise HTTPException(409, "Bu fark zaten kapanmış")
            izinli = (["bulundu"] + (["subede"] if x["tur"] == "teslim" else []) + ["harcandi", "kayip"]) if x["f"] > 0 else ["bulundu", "kabul"]
            if body.sebep not in izinli:
                raise HTTPException(400, "Bu fark için geçersiz sebep")
            if body.sebep in ("kayip", "harcandi") and not (body.not_ or "").strip():
                raise HTTPException(400, "Kayba ya da harcamaya yazarken açıklama zorunlu")
            if gun < x["tarih"]:
                raise HTTPException(400, "Fark, oluştuğu günden önce kapatılamaz")
            hid = _yaz(cur, t, gun, body.kaydeden, tutar=abs(x["f"]),
                       veri={"fark_id": x["id"], "fark_ad": x["ad"], "f": x["f"], "sebep": body.sebep, "cep": x["cep"],
                             "sube_cep": x["sube_cep"], "sorumlu": (body.sorumlu or "")[:40], "not": (body.not_ or "").strip()[:200]})
        else:
            raise HTTPException(400, "Geçersiz tür")
    return {"ok": True, "id": hid}


class OnayBody(BaseModel):
    alinan: Optional[float] = None
    onaylayan: Optional[str] = None


@router.post("/hareket/{hid}/onay")
def onayla(hid: str, body: OnayBody):
    """Kapanış onayı (merkez karşılaştırıp onaylar) ya da teslim 'aldı' onayı (sayılan tutarla)."""
    with db() as (conn, cur):
        _tablolar(cur)
        cur.execute("SELECT id, tur, tutar, durum, veri FROM para_izi_hareket WHERE id=%s FOR UPDATE", (hid,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Kayıt bulunamadı")
        r = dict(r)
        if r["durum"] == "onaylandi":
            raise HTTPException(409, "Zaten onaylanmış")
        veri = r["veri"] if isinstance(r["veri"], dict) else json.loads(r["veri"] or "{}")
        if r["tur"] == "teslim":
            al = r["tutar"] if body.alinan is None else _kurus(body.alinan)
            if al < 0 or al > r["tutar"]:
                raise HTTPException(400, "Sayılan tutar 0 ile teslim edilen arasında olmalı")
            veri["alinan"] = al
        elif r["tur"] != "kapanis":
            raise HTTPException(400, "Bu kayıt onay gerektirmez")
        cur.execute("""UPDATE para_izi_hareket SET durum='onaylandi', onay_zamani=NOW(), onaylayan=%s, veri=%s::jsonb
                        WHERE id=%s""", ((body.onaylayan or "")[:60] or None, json.dumps(veri, ensure_ascii=False), hid))
    return {"ok": True}


class IptalBody(BaseModel):
    sebep: str
    kaydeden: Optional[str] = None


@router.post("/hareket/{hid}/iptal")
def iptal(hid: str, body: IptalBody):
    """Kayıt SİLİNMEZ — 'iptal' kaydı yazılır (ters kayıt); iz kalır."""
    if not (body.sebep or "").strip():
        raise HTTPException(400, "İptal sebebi zorunlu")
    with db() as (conn, cur):
        cep_list, C, tum = _yukle(cur)
        h = next((x for x in tum if x["id"] == hid), None)
        if not h:
            raise HTTPException(404, "Kayıt bulunamadı ya da zaten iptal")
        if any(x["tur"] == "cozum" and x["veri"].get("fark_id") == hid for x in tum):
            raise HTTPException(409, "Bu kaydın farkı kapatılmış; önce fark kapanışını iptal et")
        _yaz(cur, "iptal", date.today().isoformat(), body.kaydeden, veri={"hedef_id": hid, "sebep": body.sebep.strip()[:200]})
    return {"ok": True}


# ─────────────────────────── ESKİ SİSTEMDEN TEK YÖNLÜ AKTARIM ───────────────────────────
def _patron_bul(ad: str) -> Optional[str]:
    """kasa_teslim.teslim_alan_ad serbest metin — Onur/Fethi/Fatma adını içeriyorsa eşle."""
    a = (ad or "").replace("İ", "i").replace("I", "ı").lower()
    for anahtar, cid in (("onur", "ev:onur"), ("fethi", "ev:fethi"), ("fatma", "ev:fatma")):
        if anahtar in a:
            return cid
    return None


@router.post("/aktar")
def eski_sistemden_aktar(kuru: bool = True):
    """1 Ekim'den bu yana şube kapanışlarını (ciro_taslak) ve kasa teslimlerini (kasa_teslim)
    Para İzi'ne aktarır. ESKİ TABLOLARA DOKUNMAZ (yalnız SELECT). kaynak_ref benzersiz →
    kaç kez çalışırsa çalışsın çift kayıt doğmaz. Varsayılan KURU: yazmadan ne olacağını söyler.

    · Kapanış: nakit → şube kasasına; pos+online yalnız bilgi ('kart', nakde girmez).
      Eski sistemde onaylı → onaylandı; bekliyor → onay bekliyor; reddedilen → alınmaz.
    · Teslim: alıcı adı Onur/Fethi/Fatma içeriyorsa o patronun evine, 'alındı' olarak
      (geçmiş teslim, sayım bilgisi yok). Eşleşmeyen alıcı → ALINMAZ, listede gösterilir.
    · Dış kaynak (DIS_KAYNAK): eski sistem paranın KİMDE olduğunu tutmadığı için otomatik
      alınmaz; listede gösterilir, elle "Dış giriş" olarak girilir.
    """
    with db() as (conn, cur):
        cep_list, C, tum = _yukle(cur)
        sube_cep = {c["sube_id"]: c["id"] for c in cep_list if c["tur"] == "sube"}
        var = {h.get("kaynak_ref") for h in tum if h.get("kaynak_ref")}
        rapor = {"kapanis": [], "teslim": [], "eslesmeyen_teslim": [], "dis_kaynak": [], "atlanan": 0}

        cur.execute("""SELECT id, sube_id, tarih, nakit, pos, online, durum FROM ciro_taslak
                        WHERE tarih >= %s AND durum IN ('bekliyor','onaylandi') ORDER BY tarih, olusturma""", (BASLANGIC,))
        for r in cur.fetchall() or []:
            r = dict(r)
            ref = "ciro_taslak:" + str(r["id"])
            cid = sube_cep.get(str(r["sube_id"]))
            if ref in var or not cid:
                rapor["atlanan"] += 1
                continue
            nakit = _kurus(r["nakit"] or 0)
            kart = _kurus((r["pos"] or 0)) + _kurus((r["online"] or 0))
            durum_ = "onaylandi" if r["durum"] == "onaylandi" else "bekliyor"
            rapor["kapanis"].append({"gun": str(r["tarih"]), "sube": C[cid]["kisa"], "nakit": _tl_sayi(nakit),
                                     "kart": _tl_sayi(kart), "durum": durum_})
            if not kuru:
                _yaz(cur, "kapanis", r["tarih"].isoformat(), "eski sistem", cep=cid, tutar=nakit, durum=durum_,
                     veri={"kart": kart}, kaynak_ref=ref)

        try:
            with savepoint(cur, "sp_pi_teslim"):
                cur.execute("""SELECT id, sube_id, tarih, tutar, teslim_alan_ad FROM kasa_teslim
                                WHERE tarih >= %s AND COALESCE(durum,'aktif')='aktif' ORDER BY tarih, olusturma""", (BASLANGIC,))
                teslimler = [dict(r) for r in cur.fetchall() or []]
        except Exception:  # noqa: BLE001 — durum kolonu olmayan kurulum
            cur.execute("""SELECT id, sube_id, tarih, tutar, teslim_alan_ad FROM kasa_teslim
                            WHERE tarih >= %s ORDER BY tarih, olusturma""", (BASLANGIC,))
            teslimler = [dict(r) for r in cur.fetchall() or []]
        for r in teslimler:
            ref = "kasa_teslim:" + str(r["id"])
            kaynak = sube_cep.get(str(r["sube_id"]))
            hedef = _patron_bul(r.get("teslim_alan_ad"))
            if ref in var:
                rapor["atlanan"] += 1
                continue
            satir = {"gun": str(r["tarih"]), "sube": C[kaynak]["kisa"] if kaynak else r["sube_id"],
                     "alan": r.get("teslim_alan_ad"), "tutar": _tl_sayi(_kurus(r["tutar"]))}
            if not kaynak or not hedef:
                rapor["eslesmeyen_teslim"].append(satir)
                continue
            rapor["teslim"].append({**satir, "patron": C[hedef]["kisa"]})
            if not kuru:
                t = _kurus(r["tutar"])
                _yaz(cur, "teslim", r["tarih"].isoformat(), "eski sistem", kaynak=kaynak, hedef=hedef, tutar=t,
                     durum="onaylandi", veri={"alinan": t, "eski_alan_ad": r.get("teslim_alan_ad")}, kaynak_ref=ref)

        try:
            with savepoint(cur, "sp_pi_dis"):
                cur.execute("""SELECT tarih, tutar, aciklama FROM kasa_hareketleri
                                WHERE islem_turu='DIS_KAYNAK' AND COALESCE(durum,'aktif')='aktif' AND tarih >= %s
                                ORDER BY tarih""", (BASLANGIC,))
                rapor["dis_kaynak"] = [{"gun": str(dict(r)["tarih"])[:10], "tutar": float(dict(r)["tutar"] or 0),
                                        "aciklama": dict(r).get("aciklama")} for r in cur.fetchall() or []]
        except Exception as e:  # noqa: BLE001
            rapor["dis_kaynak_hata"] = str(e)[:120]

    rapor["kuru"] = kuru
    rapor["ozet"] = {"kapanis": len(rapor["kapanis"]), "teslim": len(rapor["teslim"]),
                     "eslesmeyen_teslim": len(rapor["eslesmeyen_teslim"]), "dis_kaynak_elle": len(rapor["dis_kaynak"]),
                     "zaten_aktarilmis": rapor["atlanan"]}
    return rapor
