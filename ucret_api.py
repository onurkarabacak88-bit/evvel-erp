# -*- coding: utf-8 -*-
"""ÜCRET ZAMAN ÇİZGİSİ — asgari ücret ve kişi ücretlerinin YÖNETİM UCU.

🔴 NEDEN (MAAS_V2_PLAN.md · Adım 2, sahip 2026-09-06):
    "BURADA UÇTA ASLINDA PERSONELE MAAŞ TANIMLAMASI YAPIYORUZ AYLIK! SİSTEM NE
     YAZILDIYSA ONA GÖRE HESAPLAYABİLMELİ."
    "ASGARİ ÜCRET ... ŞU ANDA 28075 OLARAK GİRSEK BİLE BU DÜZELTİLEBİLİR OLMALI"

Bu yüzden İKİ AYRI YOL vardır ve ikisi de çalışmak zorundadır:
  · DÜZELTME (`duzelt=true`)  → yanlış YAZILMIŞ tutarı yerinde düzeltir.
    Geçmiş de değişir, çünkü o rakam hiç doğru olmamıştı. Eski değer izde kalır.
  · DEĞİŞİKLİK (`duzelt=false`) → yeni tarihten itibaren YENİ SATIR açar,
    öncekini bir gün önce kapatır. Geçmiş ay ESKİ tutarla hesaplanmaya
    devam eder ([[feedback-kayan-pencere-capa]]).

── DOKTRİNLER ───────────────────────────────────────────────────────────────
· KURU ÇALIŞTIRMA ZORUNLU — backfill varsayılan `kuru=true`; liste okunmadan
  hiçbir satır yazılmaz ([[feedback-kuru-calistirma-kapisi]]).
· UYDURMA YOK — backfill personel kartındaki tutarı BİREBİR taşır, yuvarlamaz,
  "muhtemelen asgaridir" diye eşitlemez. Mod seçimi SAHİBİNDİR.
· İZ BIRAKIR — her satır `gerekce` + `kaynak` taşır; düzeltme eski tutarı
  gerekçeye yazar, silmez.
· AYNA BOZULMAZ — `personel.maas` kolonlarına DOKUNULMAZ. Eski ekranlar
  çalışmaya devam eder; V2 motoru `bordro_ucret`ten okur.
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

import bordro_kural_coz
import bordro_ucret
from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/ucret", tags=["ucret"])

SISTEM_BASLANGIC = "2026-06-01"   # bordro verisinin başladığı ay


def _tarih(s: Optional[str], vars_: Optional[str] = None) -> date:
    t = (s or vars_ or "")[:10]
    if not t:
        raise HTTPException(400, "tarih zorunlu (YYYY-AA-GG)")
    try:
        return datetime.strptime(t, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(400, "tarih bicimi YYYY-AA-GG olmali: %s" % t)


# ── OKUMA ───────────────────────────────────────────────────────────────────
@router.get("/durum")
def durum(tarih: Optional[str] = Query(None)):
    """Zaman çizgisinin bugünkü hâli + kaç kişi hâlâ AYNA'dan okunuyor.

    `ayna_kalan` sıfıra inmeden Adım 5 (V1 kesimi) yapılamaz — motorun geçmişi
    doğru hesaplayabilmesi buna bağlı.
    """
    g = _tarih(tarih, str(date.today()))
    with db() as (_, cur):
        cur.execute(
            "SELECT id, tutar, gecerli_bas, gecerli_bit, gerekce, kaynak, olusturma "
            "  FROM ucret_tanim WHERE kapsam='GENEL' AND tur='ASGARI' "
            " ORDER BY gecerli_bas DESC")
        asgari_cizgi = [dict(r) for r in (cur.fetchall() or [])]

        cur.execute("SELECT COUNT(*) AS n FROM ucret_tanim WHERE kapsam='KISI'")
        kisi_satir = (cur.fetchone() or {}).get("n") or 0

        cur.execute("SELECT id, ad_soyad, maas, yemek_ucreti, yol_ucreti, "
                    "       saatlik_ucret, calisma_turu, aktif, baslangic_tarihi "
                    "  FROM personel ORDER BY aktif DESC, ad_soyad")
        P = cur.fetchall() or []

        ayna: List[Dict[str, Any]] = []
        cozum: List[Dict[str, Any]] = []
        for p in P:
            s = bordro_ucret.sozlesme_coz(cur, p["id"], g, dict(p))
            satir = {"personel_id": p["id"], "ad_soyad": p.get("ad_soyad"),
                     "aktif": bool(p.get("aktif")),
                     "calisma_turu": s["calisma_turu"],
                     "kalem": {k: {"tutar": v["tutar"], "mod": v["mod"],
                                   "kaynak": v["kaynak"], "uyari": v["uyari"]}
                               for k, v in s["kalem"].items()}}
            cozum.append(satir)
            if s["ayna_kullanildi"]:
                ayna.append({"personel_id": p["id"], "ad_soyad": p.get("ad_soyad"),
                             "aktif": bool(p.get("aktif"))})

        a = bordro_ucret.asgari_coz(cur, g)

    return {"tarih": str(g), "asgari": a, "asgari_cizgi": asgari_cizgi,
            "kisi_satir_sayisi": kisi_satir,
            "ayna_kalan": len(ayna), "ayna_kisiler": ayna,
            "personel": cozum,
            "hazir": (a["tutar"] is not None and not ayna)}


@router.get("/coz")
def coz(personel_id: str = Query(...), tarih: Optional[str] = Query(None)):
    """Tek kişi, tek tarih — "bu rakam nereden geldi" sorusunun cevabı."""
    g = _tarih(tarih, str(date.today()))
    with db() as (_, cur):
        cur.execute("SELECT id, ad_soyad, maas, yemek_ucreti, yol_ucreti, "
                    "       saatlik_ucret, calisma_turu, baslangic_tarihi "
                    "  FROM personel WHERE id=%s", (str(personel_id),))
        p = cur.fetchone()
        if not p:
            raise HTTPException(404, "personel bulunamadi")
        return bordro_ucret.sozlesme_coz(cur, personel_id, g, dict(p))


@router.get("/personel/{pid}/cizgi")
def cizgi(pid: str):
    """Bir kişinin ücret geçmişi — hangi tarihte ne kazanıyordu."""
    with db() as (_, cur):
        cur.execute(
            "SELECT id, tur, mod, tutar, fark, gecerli_bas, gecerli_bit, "
            "       gerekce, kaynak, olusturma "
            "  FROM ucret_tanim WHERE kapsam='KISI' AND personel_id=%s "
            " ORDER BY tur, gecerli_bas DESC", (str(pid),))
        return {"personel_id": pid, "satirlar": [dict(r) for r in (cur.fetchall() or [])]}


# ── YAZMA ───────────────────────────────────────────────────────────────────
class AsgariModel(BaseModel):
    tutar: float
    gecerli_bas: Optional[str] = None
    gerekce: Optional[str] = None
    duzelt: bool = False        # True → mevcut satırı YERİNDE düzelt (yazım hatası)


@router.post("/asgari")
def asgari_yaz(m: AsgariModel):
    """Asgari ücreti tanımla. TEK YERDEN — bağlı olan herkese aynı anda uygular.

    duzelt=False → yeni dönem açar (zam). Geçmiş ay eski tutarla kalır.
    duzelt=True  → o tarihte geçerli satırı yerinde düzeltir (yanlış yazılmıştı).
    """
    if m.tutar is None or float(m.tutar) <= 0:
        raise HTTPException(400, "tutar sifirdan buyuk olmali")
    g = _tarih(m.gecerli_bas, SISTEM_BASLANGIC)
    with db() as (conn, cur):
        if m.duzelt:
            cur.execute(
                "SELECT id, tutar FROM ucret_tanim "
                " WHERE kapsam='GENEL' AND tur='ASGARI' AND gecerli_bas <= %s "
                "   AND (gecerli_bit IS NULL OR gecerli_bit >= %s) "
                " ORDER BY gecerli_bas DESC LIMIT 1", (g, g))
            r = cur.fetchone()
            if not r:
                raise HTTPException(404, "duzeltilecek asgari satiri yok — once tanimlayin")
            eski = float(r["tutar"] or 0)
            cur.execute(
                "UPDATE ucret_tanim SET tutar=%s, gerekce=%s WHERE id=%s",
                (float(m.tutar),
                 "%s | DUZELTME %s: %.2f → %.2f" % (
                     m.gerekce or "", date.today(), eski, float(m.tutar)),
                 r["id"]))
            conn.commit()
            return {"ok": True, "islem": "duzeltildi", "id": r["id"],
                    "eski_tutar": eski, "yeni_tutar": float(m.tutar)}

        # Yeni dönem: önceki açık satırı bir gün önce kapat.
        cur.execute(
            "UPDATE ucret_tanim SET gecerli_bit=%s "
            " WHERE kapsam='GENEL' AND tur='ASGARI' AND gecerli_bas < %s "
            "   AND (gecerli_bit IS NULL OR gecerli_bit >= %s)",
            (g - timedelta(days=1), g, g))
        kapanan = cur.rowcount or 0
        cur.execute(
            "INSERT INTO ucret_tanim (kapsam, tur, mod, tutar, gecerli_bas, gerekce, kaynak) "
            "VALUES ('GENEL','ASGARI','SABIT',%s,%s,%s,'sahip') RETURNING id",
            (float(m.tutar), g, m.gerekce))
        yeni = cur.fetchone()["id"]
        conn.commit()
    return {"ok": True, "islem": "yeni_donem", "id": yeni,
            "gecerli_bas": str(g), "kapanan_onceki": kapanan}


class KisiUcretModel(BaseModel):
    tur: str                            # TABAN | YEMEK | YOL | SAATLIK
    mod: str = "SABIT"                  # SABIT | ASGARIYE_BAGLI
    tutar: Optional[float] = None       # SABIT icin
    fark: float = 0.0                   # ASGARIYE_BAGLI icin (asgari + fark)
    gecerli_bas: Optional[str] = None
    gerekce: Optional[str] = None
    duzelt: bool = False


@router.post("/personel/{pid}")
def kisi_yaz(pid: str, m: KisiUcretModel):
    """Kişinin bir ücret kalemini tanımla/değiştir/düzelt."""
    tur = (m.tur or "").upper()
    if tur not in bordro_ucret.TURLER:
        raise HTTPException(400, "tur %s olmali" % (bordro_ucret.TURLER,))
    mod = (m.mod or "SABIT").upper()
    if mod not in ("SABIT", "ASGARIYE_BAGLI"):
        raise HTTPException(400, "mod SABIT veya ASGARIYE_BAGLI olmali")
    if mod == "SABIT" and (m.tutar is None or float(m.tutar) < 0):
        raise HTTPException(400, "SABIT modda tutar zorunlu")
    g = _tarih(m.gecerli_bas, SISTEM_BASLANGIC)

    with db() as (conn, cur):
        cur.execute("SELECT id, ad_soyad FROM personel WHERE id=%s", (str(pid),))
        p = cur.fetchone()
        if not p:
            raise HTTPException(404, "personel bulunamadi")

        if mod == "ASGARIYE_BAGLI":
            a = bordro_ucret.asgari_coz(cur, g)
            if a["tutar"] is None:
                raise HTTPException(
                    400, "asgari ucret %s tarihi icin tanimli degil — once "
                         "POST /api/ucret/asgari" % g)

        if m.duzelt:
            cur.execute(
                "SELECT id, tutar, fark, mod FROM ucret_tanim "
                " WHERE kapsam='KISI' AND personel_id=%s AND tur=%s AND gecerli_bas <= %s "
                "   AND (gecerli_bit IS NULL OR gecerli_bit >= %s) "
                " ORDER BY gecerli_bas DESC LIMIT 1", (str(pid), tur, g, g))
            r = cur.fetchone()
            if not r:
                raise HTTPException(404, "duzeltilecek satir yok")
            cur.execute(
                "UPDATE ucret_tanim SET mod=%s, tutar=%s, fark=%s, gerekce=%s WHERE id=%s",
                (mod, (float(m.tutar) if mod == "SABIT" else None), float(m.fark or 0),
                 "%s | DUZELTME %s: mod %s→%s tutar %s→%s" % (
                     m.gerekce or "", date.today(), r["mod"], mod,
                     r["tutar"], m.tutar), r["id"]))
            conn.commit()
            return {"ok": True, "islem": "duzeltildi", "id": r["id"],
                    "ad_soyad": p.get("ad_soyad")}

        cur.execute(
            "UPDATE ucret_tanim SET gecerli_bit=%s "
            " WHERE kapsam='KISI' AND personel_id=%s AND tur=%s AND gecerli_bas < %s "
            "   AND (gecerli_bit IS NULL OR gecerli_bit >= %s)",
            (g - timedelta(days=1), str(pid), tur, g, g))
        kapanan = cur.rowcount or 0
        cur.execute(
            "INSERT INTO ucret_tanim (kapsam, personel_id, tur, mod, tutar, fark, "
            "                         gecerli_bas, gerekce, kaynak) "
            "VALUES ('KISI',%s,%s,%s,%s,%s,%s,%s,'sahip') RETURNING id",
            (str(pid), tur, mod, (float(m.tutar) if mod == "SABIT" else None),
             float(m.fark or 0), g, m.gerekce))
        yeni = cur.fetchone()["id"]
        conn.commit()
    return {"ok": True, "islem": "yeni_donem", "id": yeni,
            "ad_soyad": p.get("ad_soyad"), "gecerli_bas": str(g),
            "kapanan_onceki": kapanan}


# ── BACKFILL ────────────────────────────────────────────────────────────────
class BackfillModel(BaseModel):
    kuru: bool = True
    asgari: Optional[float] = None       # verilirse asgari satırı da açılır
    asgariye_bagla: bool = False         # tutarı asgariye EŞİT olanları bağla
    gerekce: Optional[str] = None


@router.post("/backfill")
def backfill(m: BackfillModel):
    """Personel kartındaki ücretleri zaman çizgisine TAŞI.

    ⚠️ Tutarlar BİREBİR taşınır — hiçbir rakam değişmez, yuvarlanmaz.
    `asgariye_bagla=False` iken sonuç bugünküyle bire bir aynıdır (hepsi SABIT).
    `asgariye_bagla=True` iken tutarı asgariye EŞİT olanlar ASGARIYE_BAGLI
    (fark=0) olur — bugünkü rakam yine aynı çıkar, ama asgari artınca birlikte
    artarlar. Sahip kararı budur.

    `gecerli_bas` = personelin işe başlangıç tarihi (yoksa sistem başlangıcı).
    Böylece geçmiş aylar da çözülebilir.
    """
    yazilan: List[Dict[str, Any]] = []
    atlanan: List[Dict[str, Any]] = []
    with db() as (conn, cur):
        cur.execute("SELECT id, ad_soyad, maas, yemek_ucreti, yol_ucreti, "
                    "       saatlik_ucret, calisma_turu, aktif, baslangic_tarihi "
                    "  FROM personel ORDER BY aktif DESC, ad_soyad")
        P = [dict(r) for r in (cur.fetchall() or [])]

        asgari_tutar = m.asgari
        if asgari_tutar is None:
            a = bordro_ucret.asgari_coz(cur, date.today())
            asgari_tutar = a["tutar"]

        if m.asgari is not None and not m.kuru:
            cur.execute("SELECT id FROM ucret_tanim WHERE kapsam='GENEL' AND tur='ASGARI'")
            if not cur.fetchone():
                cur.execute(
                    "INSERT INTO ucret_tanim (kapsam, tur, mod, tutar, gecerli_bas, "
                    "                         gerekce, kaynak) "
                    "VALUES ('GENEL','ASGARI','SABIT',%s,%s,%s,'sahip')",
                    (float(m.asgari), SISTEM_BASLANGIC,
                     m.gerekce or "backfill ile tanimlandi"))

        for p in P:
            bas = str(p.get("baslangic_tarihi") or SISTEM_BASLANGIC)[:10]
            part = (p.get("calisma_turu") or "surekli") != "surekli"
            for tur, kol in bordro_ucret.AYNA_KOLON.items():
                v = float(p.get(kol) or 0)
                if v <= 0:
                    continue
                if tur == "TABAN" and part:
                    continue      # part-time'da taban yok
                if tur == "SAATLIK" and not part:
                    continue
                mod, fark, tutar = "SABIT", 0.0, v
                if (tur == "TABAN" and m.asgariye_bagla and asgari_tutar
                        and abs(v - float(asgari_tutar)) < 0.01):
                    mod, fark, tutar = "ASGARIYE_BAGLI", 0.0, None

                cur.execute(
                    "SELECT id FROM ucret_tanim WHERE kapsam='KISI' AND personel_id=%s "
                    "   AND tur=%s AND gecerli_bas=%s", (p["id"], tur, bas))
                if cur.fetchone():
                    atlanan.append({"ad_soyad": p.get("ad_soyad"), "tur": tur,
                                    "neden": "zaten var"})
                    continue

                yazilan.append({"personel_id": p["id"], "ad_soyad": p.get("ad_soyad"),
                                "tur": tur, "mod": mod,
                                "tutar": (float(tutar) if tutar is not None else None),
                                "fark": fark, "gecerli_bas": bas,
                                "kart_tutari": v})
                if not m.kuru:
                    cur.execute(
                        "INSERT INTO ucret_tanim (kapsam, personel_id, tur, mod, tutar, "
                        "                         fark, gecerli_bas, gerekce, kaynak) "
                        "VALUES ('KISI',%s,%s,%s,%s,%s,%s,%s,'backfill')",
                        (p["id"], tur, mod,
                         (float(tutar) if tutar is not None else None), fark, bas,
                         m.gerekce or "personel kartindan tasindi (Adim 2)"))
        if m.kuru:
            conn.rollback()
        else:
            conn.commit()

    return {"kuru": m.kuru, "asgari_kullanilan": asgari_tutar,
            "yazilacak": len(yazilan), "atlanan": len(atlanan),
            "satirlar": yazilan, "atlanan_detay": atlanan,
            "not": ("KURU — hicbir sey yazilmadi. kuru=false ile uygulayin."
                    if m.kuru else "UYGULANDI")}


# ── KURAL (Adım 3) ──────────────────────────────────────────────────────────
@router.get("/kural")
def kural(tarih: Optional[str] = Query(None),
          personel_id: Optional[str] = Query(None),
          sube_id: Optional[str] = Query(None)):
    """O tarihte geçerli bordro parametreleri + nereden geldikleri.

    Tablo boşken kodda yazılı değerlerin BİREBİR aynısını döner — bu adım
    hiçbir rakamı değiştirmez, yalnız GÖRÜNÜR kılar.
    """
    g = _tarih(tarih, str(date.today()))
    with db() as (_, cur):
        p = bordro_kural_coz.kural_coz(cur, g, personel_id, sube_id)
        cur.execute("SELECT id, kapsam, sube_id, personel_id, gecerli_bas, "
                    "       gecerli_bit, parametre, gerekce, olusturma "
                    "  FROM bordro_kural ORDER BY gecerli_bas DESC")
        cizgi = [dict(r) for r in (cur.fetchall() or [])]
    return {"tarih": str(g), "parametre": p, "cizgi": cizgi,
            "celiski": bordro_kural_coz.celiski_var_mi(p)}


class KuralModel(BaseModel):
    parametre: Dict[str, Any]
    kapsam: str = "GENEL"
    sube_id: Optional[str] = None
    personel_id: Optional[str] = None
    gecerli_bas: Optional[str] = None
    gerekce: Optional[str] = None
    duzelt: bool = False


@router.post("/kural")
def kural_yaz(m: KuralModel):
    """Kural değişikliğini VERİ olarak yaz. Geçmiş ay eski kuralla kalır."""
    kapsam = (m.kapsam or "GENEL").upper()
    if kapsam not in ("GENEL", "SUBE", "KISI"):
        raise HTTPException(400, "kapsam GENEL|SUBE|KISI olmali")
    if kapsam == "SUBE" and not m.sube_id:
        raise HTTPException(400, "SUBE kapsaminda sube_id zorunlu")
    if kapsam == "KISI" and not m.personel_id:
        raise HTTPException(400, "KISI kapsaminda personel_id zorunlu")
    bilinmeyen = [k for k in (m.parametre or {}) if k not in bordro_kural_coz.VARSAYILAN]
    if bilinmeyen:
        raise HTTPException(400, "bilinmeyen parametre: %s — gecerliler: %s"
                            % (bilinmeyen, sorted(bordro_kural_coz.VARSAYILAN)))
    if not m.gerekce:
        # Gerekçesiz kural denetimde savunulamaz (İZ BIRAKIR doktrini).
        raise HTTPException(400, "gerekce zorunlu — hangi sozlesme maddesi/karar")
    g = _tarih(m.gecerli_bas, SISTEM_BASLANGIC)

    with db() as (conn, cur):
        if m.duzelt:
            cur.execute(
                "SELECT id, parametre FROM bordro_kural "
                " WHERE kapsam=%s AND COALESCE(sube_id,'')=%s "
                "   AND COALESCE(personel_id,'')=%s AND gecerli_bas <= %s "
                "   AND (gecerli_bit IS NULL OR gecerli_bit >= %s) "
                " ORDER BY gecerli_bas DESC LIMIT 1",
                (kapsam, str(m.sube_id or ""), str(m.personel_id or ""), g, g))
            r = cur.fetchone()
            if not r:
                raise HTTPException(404, "duzeltilecek kural satiri yok")
            cur.execute("UPDATE bordro_kural SET parametre = parametre || %s::jsonb, "
                        "       gerekce=%s WHERE id=%s",
                        (json.dumps(m.parametre),
                         "%s | DUZELTME %s (eski: %s)" % (m.gerekce, date.today(),
                                                          json.dumps(r["parametre"])),
                         r["id"]))
            conn.commit()
            return {"ok": True, "islem": "duzeltildi", "id": r["id"]}

        cur.execute(
            "UPDATE bordro_kural SET gecerli_bit=%s "
            " WHERE kapsam=%s AND COALESCE(sube_id,'')=%s "
            "   AND COALESCE(personel_id,'')=%s AND gecerli_bas < %s "
            "   AND (gecerli_bit IS NULL OR gecerli_bit >= %s)",
            (g - timedelta(days=1), kapsam, str(m.sube_id or ""),
             str(m.personel_id or ""), g, g))
        kapanan = cur.rowcount or 0
        cur.execute(
            "INSERT INTO bordro_kural (kapsam, sube_id, personel_id, gecerli_bas, "
            "                          parametre, gerekce) "
            "VALUES (%s,%s,%s,%s,%s::jsonb,%s) RETURNING id",
            (kapsam, m.sube_id, m.personel_id, g, json.dumps(m.parametre), m.gerekce))
        yeni = cur.fetchone()["id"]
        conn.commit()
    return {"ok": True, "islem": "yeni_donem", "id": yeni,
            "gecerli_bas": str(g), "kapanan_onceki": kapanan}
