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
    `asgariye_bagla=True` iken tutarı asgariye EŞİT olan AKTİF kişiler ASGARIYE_BAGLI
    (fark=0) olur — bugünkü rakam yine aynı çıkar, ama asgari artınca birlikte
    artarlar. Sahip kararı budur.

    ⛔ AYRILANLAR HER ZAMAN SABİT — sahip 2026-09-06: "TALHA VE YILMAZ ZATEN
    AYRILDILAR AMA MAAŞLARI BUYDU". Ayrılmış kişinin ücreti dondurulur.

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
                # 🔴 AYRILAN DONAR — sahip kararı 2026-09-06: "TALHA VE YILMAZ
                # ZATEN AYRILDILAR AMA MAAŞLARI BUYDU." İşten ayrılmış kişinin
                # ücreti asgariye BAĞLANMAZ; ileride asgari artınca onun kapanmış
                # dönemleri kaymasın diye tutar olduğu gibi dondurulur.
                if (tur == "TABAN" and m.asgariye_bagla and asgari_tutar
                        and p.get("aktif")
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
                " ORDER BY gecerli_bas DESC, olusturma DESC LIMIT 1",
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


# ── MOLA ONAYI (Adım 7) ─────────────────────────────────────────────────────
# Sahip 2026-09-06: "AMA MANTIKLISI SANKİ C GİBİ" — mola kaydı bulunmayan gün
# kendiliğinden hak DOĞURMAZ; askıya alınır ve sahip gün gün onaylar.
# Kanıtsız ödeme yapmak "UYDURMA YOK" doktrinine aykırı olurdu; onay ise AÇIK
# BİR KARARdır ve `bordro_kalem`'e KARAR ekseninde iz bırakır.
class MolaOnayGun(BaseModel):
    personel_id: str
    tarih: str                  # YYYY-AA-GG


class MolaOnayModel(BaseModel):
    gunler: List[MolaOnayGun]
    gerekce: str
    onaylayan: Optional[str] = None
    kuru: bool = True           # ⚠️ VARSAYILAN KURU
    geri_al: bool = False       # onayı kaldır


@router.get("/mola-askida")
def mola_askida(yil: int = Query(...), ay: int = Query(...)):
    """Sahibin onayını bekleyen günler — kişi kişi, gün gün, para karşılığıyla.

    "Askıda" = vardiya var, mola kaydı YOK. Bu bir ihlal değil, BOŞLUKtur;
    para ödenmedi ama kaybolmadı.
    """
    with db() as (_, cur):
        cur.execute("SELECT personel_id, kanit->>'tarih' AS tarih, "
                    "       kanit->>'gerekce' AS gerekce, kanit->>'onaylayan' AS onaylayan "
                    "  FROM bordro_kalem "
                    " WHERE tur='YEMEK_GUN_ONAY' AND durum='aktif' AND yil=%s AND ay=%s "
                    " ORDER BY personel_id", (yil, ay))
        onayli = [dict(r) for r in (cur.fetchall() or [])]
    try:
        from gorev_api import vardiya_takip as _vt
        vt = _vt(yil, ay)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, "vardiya takip okunamadi: %s" % e)

    bekleyen, toplam_tl = [], 0.0
    for r in (vt or {}).get("personeller") or []:
        gunler = r.get("mola_askida_gunler") or []
        if not gunler:
            continue
        u = r.get("ucret_detay") or {}
        pg = r.get("planli_gun") or 0
        aylik_yemek = (float(u.get("aylik_toplam_tahmini") or 0)
                       - float(u.get("taban_maas") or 0)
                       - float(u.get("yol_ucret_aylik") or 0))
        gecen = float(u.get("gecen_gun") or 0)
        # Bir günün para karşılığı = aylık yemek × dönem oranı ÷ planlı gün
        gun_tl = (aylik_yemek * (gecen / 30.0) / pg) if pg else 0.0
        toplam_tl += gun_tl * len(gunler)
        # 🔴 SEBEBİ SÖYLE, SADECE "ONAYLA" DEME (sahip 2026-09-07:
        # "HER GÜN ONAY MI YAPACAĞIM!"). Ölçüm gösterdi ki iki ayrı topluluk var:
        #   · kaydı düzgün tutan, bir gün kaçıran  → tek tık onay, güvenli
        #   · sistemi HİÇ kullanmamış               → onay değil, EĞİTİM sorunu
        # Canlı: emir efe 0/7, ersan kazan 0/6, gökçe 0/6, naz dal 0/5 — dördü de
        # 1 Eylül'de başladı ve mola butonuna HİÇ basmadı. MERT ALİ AKAR 3 ayda
        # 36 planlı gün, TEK kayıt yok (part-time, yemek hakkı zaten yok).
        m = r.get("mola_ozet") or {}
        _kayitli = (m.get("hak_dogdu", 0) + m.get("ihlal", 0) + m.get("belirsiz", 0))
        if _kayitli == 0:
            tani = "hic_kullanmamis"
            tani_metni = ("Bu kişi mola kaydını HİÇ tutmamış — onay değil, "
                          "kullanmayı göstermek gerekiyor.")
        elif _kayitli >= pg * 0.8:
            tani = "duzenli_tutuyor"
            tani_metni = "Kaydı düzenli tutuyor, bu günleri kaçırmış — onay güvenli."
        else:
            tani = "duzensiz"
            tani_metni = "Kaydı düzensiz tutuyor — önce nedenini sormak gerekebilir."
        bekleyen.append({
            "personel_id": str(r.get("personel_id")),
            "ad_soyad": r.get("ad_soyad"),
            "planli_gun": pg,
            "askida_gun": len(gunler),
            "gunler": gunler,
            "gun_tutari": round(gun_tl, 2),
            "toplam_tutar": round(gun_tl * len(gunler), 2),
            "mola_ozet": m,
            "kayitli_gun": _kayitli,
            "tani": tani,
            "tani_metni": tani_metni,
        })
    return {"yil": yil, "ay": ay,
            "kural": (vt or {}).get("personeller", [{}])[0].get("mola_kurali")
                     if (vt or {}).get("personeller") else None,
            "bekleyen_kisi": len(bekleyen),
            "bekleyen_gun": sum(b["askida_gun"] for b in bekleyen),
            "bekleyen_tutar": round(toplam_tl, 2),
            "bekleyenler": bekleyen,
            "onayli": onayli}


@router.post("/mola-onay")
def mola_onay(m: MolaOnayModel, yil: int = Query(...), ay: int = Query(...)):
    """Askıdaki günleri ONAYLA (veya onayı geri al). ⚠️ Varsayılan KURU."""
    if not m.gerekce:
        raise HTTPException(400, "gerekce zorunlu — bu bir PARA kararidir")
    if not m.gunler:
        raise HTTPException(400, "gun listesi bos")
    yazilan, atlanan = [], []
    with db() as (conn, cur):
        for g in m.gunler:
            try:
                _tarih(g.tarih)
            except HTTPException:
                atlanan.append({"personel_id": g.personel_id, "tarih": g.tarih,
                                "neden": "tarih bicimi"})
                continue
            if g.tarih[:7] != "%04d-%02d" % (yil, ay):
                atlanan.append({"personel_id": g.personel_id, "tarih": g.tarih,
                                "neden": "donem disi"})
                continue
            # 🔴 GELECEK GÜN ONAYLANAMAZ (2026-09-07). Kuyruk artık gelecek gün
            # uretmiyor (gorev_api mola_durum='gelecek'), ama onay bir PARA
            # kararidir: cagrinin govdesi elle de gonderilebilir. Yasanmamis
            # gunun molasi hakkinda verilecek karar YOKTUR.
            try:
                from tr_saat import dt_now_tr as _dnt_o
                _bugun_o = str(_dnt_o().date())
            except Exception:  # noqa: BLE001
                _bugun_o = str(date.today())
            if not m.geri_al and g.tarih > _bugun_o:
                atlanan.append({"personel_id": g.personel_id, "tarih": g.tarih,
                                "neden": "gun henuz yasanmadi"})
                continue
            cur.execute("SELECT id FROM bordro_kalem "
                        " WHERE tur='YEMEK_GUN_ONAY' AND durum='aktif' "
                        "   AND personel_id=%s AND yil=%s AND ay=%s "
                        "   AND kanit->>'tarih'=%s",
                        (g.personel_id, yil, ay, g.tarih))
            mevcut = cur.fetchone()
            if m.geri_al:
                if not mevcut:
                    atlanan.append({"personel_id": g.personel_id, "tarih": g.tarih,
                                    "neden": "zaten onayli degil"})
                    continue
                yazilan.append({"personel_id": g.personel_id, "tarih": g.tarih,
                                "islem": "geri_alindi"})
                if not m.kuru:
                    # append-only: SİLİNMEZ, 'eski' yapılır (İZ BIRAKIR).
                    cur.execute("UPDATE bordro_kalem SET durum='eski' WHERE id=%s",
                                (mevcut["id"],))
                continue
            if mevcut:
                atlanan.append({"personel_id": g.personel_id, "tarih": g.tarih,
                                "neden": "zaten onayli"})
                continue
            yazilan.append({"personel_id": g.personel_id, "tarih": g.tarih,
                            "islem": "onaylandi"})
            if not m.kuru:
                cur.execute(
                    "INSERT INTO bordro_kalem (personel_id, yil, ay, tur, eksen, "
                    "   miktar, birim, tutar, kaynak, kanit_sinifi, kanit) "
                    "VALUES (%s,%s,%s,'YEMEK_GUN_ONAY','KARAR',1,'gun',0,"
                    "        'sahip_onayi','beyan',%s::jsonb)",
                    (g.personel_id, yil, ay,
                     json.dumps({"tarih": g.tarih, "gerekce": m.gerekce,
                                 "onaylayan": m.onaylayan or "sahip",
                                 "onay_ts": str(date.today())}, ensure_ascii=False)))
        if m.kuru:
            conn.rollback()
        else:
            conn.commit()
    return {"kuru": m.kuru, "islem": ("geri_alma" if m.geri_al else "onay"),
            "etkilenen": len(yazilan), "atlanan": len(atlanan),
            "satirlar": yazilan, "atlanan_detay": atlanan,
            "not": ("KURU — hicbir sey yazilmadi. kuru=false ile uygulayin."
                    if m.kuru else "UYGULANDI")}


# ── GÖLGE HESAP (Adım 6) ────────────────────────────────────────────────────
# 🔴 Saf motor (`bordro_motor.hesapla`) V1 ile YARIŞIR, para AKMAZ.
# Kesim (net = Σ kalem) ancak burada 0,00 fark görülünce yapılır.
# Motor ölçümü ÜRETMEZ, ALIR: ölçüm kanıtı `vardiya_takip`ten gelir; motor
# yalnız ARİTMETİĞİ bağımsız olarak yeniden kurar. Aritmetikte bir kusur varsa
# gölge onu yakalar; ölçüm kusurunu yakalamaz (o Adım 4'ün işi).
def _kalem_donem_hesapla(cur, yil: int, ay: int,
                         personel_id: Optional[str] = None):
    """ORTAK ÇEKİRDEK — dönemin kalemlerini üretir. Yazmaz, döndürür.

    TEK ÇEKİRDEK: gölge hesabı da (`/kalem-golge`) deftere yazma da
    (`/kalem-yaz`) BURAYI çağırır. İki ayrı kopya olsaydı biri düzelip
    diğeri kalırdı — bu projede tam olarak böyle üç ayrı dönem-oranı
    formülü doğmuştu.
    """
    """V1 net'i ile saf motorun Σ kalem'ini karşılaştırır. SALT OKUR."""
    import bordro_motor as _bm
    try:
        from gorev_api import vardiya_takip as _vt
        vt = _vt(yil, ay, personel_id=personel_id) if personel_id else _vt(yil, ay)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, "vardiya takip okunamadi: %s" % e)

    satirlar, kirik, toplam_v1, toplam_v2 = [], 0, 0.0, 0.0
    for r in (vt or {}).get("personeller") or []:
        pid = str(r.get("personel_id"))
        u = r.get("ucret_detay") or {}
        gecen = float(u.get("gecen_gun") or 0)
        if gecen <= 0 and not (r.get("planli_gun") or 0):
            continue
        cur.execute("SELECT id, ad_soyad, maas, yemek_ucreti, yol_ucreti, "
                    "       saatlik_ucret, calisma_turu, baslangic_tarihi "
                    "  FROM personel WHERE id=%s", (pid,))
        p = cur.fetchone()
        if not p:
            continue
        _bas = p.get("baslangic_tarihi")
        _t = date(yil, ay, 1)
        if _bas and _bas > _t:
            _t = _bas
        sz = bordro_ucret.sozlesme_coz(cur, pid, _t, dict(p))
        kr = bordro_kural_coz.kural_coz(cur, _t, personel_id=pid,
                                        sube_id=p.get("sube_id"))
        m = r.get("mola_ozet") or {}
        # Yemek paydası: motor kuralı BİLİR ama günleri saymaz — ölçümden gelir.
        _planli = int(r.get("planli_gun") or 0)
        _yp = kr.get("yemek_paydasi") or "planli_gun"
        if _planli <= 0:
            _payda = 0.0          # vardiya hiç yok → motor VARSAYIM dalına düşsün
        elif _yp == "beklenen_gun":
            _payda = max(float(_planli),
                         round(gecen * float(kr.get("haftalik_calisma_gun") or 6) / 7.0))
        else:
            try:
                _payda = float(_yp)
            except (TypeError, ValueError):
                _payda = float(_planli)
        _ham = r.get("olcum_ham") or {}
        olcum = {
            "gecen_gun": float(_ham.get("gecen_gun") or gecen),
            "planli_gun": _planli,
            "yemek_hak_gun": int(r.get("yemek_ucret_gun") or 0),
            "yemek_paydasi_deger": _payda,
            "ihlal_gun": m.get("ihlal", 0),
            "kayit_yok_gun": m.get("kayit_yok", 0),
            "onayli_gun": m.get("onayli", 0),
            "fazla_mesai_saat": float(_ham.get("fazla_mesai_saat")
                                      if _ham.get("fazla_mesai_saat") is not None
                                      else (r.get("toplam_fazla_mesai_saat") or 0)),
            "calisilan_saat": float(_ham.get("planlanan_saat")
                                    if _ham.get("planlanan_saat") is not None
                                    else (r.get("toplam_planlanan_saat") or 0)),
            "saat_kaynagi": r.get("saat_kaynagi"),
            "ay_tamam": u.get("ay_tamam"),
        }
        # KARAR + MAHSUP katmanı `personel_aylik`'te durur — motor onu ALIR.
        cur.execute(
            "SELECT bayram_mesai_saat, eksik_gun, raporlu_gun, rapor_kesinti, "
            "       manuel_duzeltme, not_aciklama, hesaplanan_net, "
            "       COALESCE(avans_mahsup,0) AS avans_mahsup, "
            "       COALESCE(mahsup_devir,0) AS mahsup_devir, durum, "
            "       calisma_saati, saat_kaynagi "
            "  FROM personel_aylik WHERE personel_id=%s AND yil=%s AND ay=%s",
            (pid, yil, ay))
        _k = cur.fetchone() or {}
        karar = {"bayram_mesai_saat": _k.get("bayram_mesai_saat"),
                 "eksik_gun": _k.get("eksik_gun"),
                 "raporlu_gun": _k.get("raporlu_gun"),
                 "rapor_kesinti": _k.get("rapor_kesinti"),
                 "manuel_duzeltme": _k.get("manuel_duzeltme"),
                 "gerekce": _k.get("not_aciklama")}
        mahsup = {"avans_mahsup": _k.get("avans_mahsup"),
                  "mahsup_devir": _k.get("mahsup_devir")}

        # 🕐 ELLE GİRİLEN SAAT KAZANIR (part-time). Sahip 2026-09-06:
        # "part personeli sistem hesaplamıyor — saati belirtiyorum".
        # Vardiya planı olmayan part-time'da hakediş elle girilen saatten
        # doğar; gölge bunu okumazsa MERT/nisanur gibi kişilerde koca fark
        # üretir ve "V2 eksik hesaplıyor" sanılır. Kaynağı da taşı:
        # bu bir ÖLÇÜM değil BEYANdır, kalem öyle damgalanmalı.
        if (sz.get("calisma_turu") or "surekli") != "surekli"                     and str(_k.get("saat_kaynagi") or "") == "elle"                     and float(_k.get("calisma_saati") or 0) > 0:
            olcum["calisilan_saat"] = float(_k["calisma_saati"])
            olcum["saat_kaynagi"] = "elle"
            olcum["saat_kanit_sinifi"] = "beyan"

        sonuc = _bm.hesapla(sz, kr, olcum, karar, mahsup)

        # İKİ AYRI KARŞILAŞTIRMA — ikisi farklı soruyu ölçer:
        #   hakediş  ↔ vardiya_takip.net_hakediş   (SOZLESME+OLCUM, KARAR hariç)
        #   ödenecek ↔ personel_aylik.hesaplanan_net (KARAR+MAHSUP dahil)
        v1_hak = float(r.get("net_hakediş") or 0)
        v2_saf = sonuc["eksen_toplam"]["SOZLESME"] + sonuc["eksen_toplam"]["OLCUM"]
        fark_hak = round(v2_saf - v1_hak, 2)
        # ⚠️ ELLE SAATTE HAKEDİŞ KIYASI ANLAMSIZ: `vardiya_takip.net_hakediş`
        # saati VARDİYA PLANINDAN alır; elle girilen saat katmanı ondan SONRA
        # (maas_service.part_elle_saat_net) uygulanır. İkisini kıyaslamak
        # "V2 eksik hesaplıyor" yanılgısı üretir — MERT ALİ AKAR'da 12.183,27.
        # Bu kişilerde geçerli kıyas ÖDENECEK tarafıdır ve o tutuyor.
        kiyas_disi = (olcum.get("saat_kaynagi") == "elle")
        v1_ode = (float(_k.get("hesaplanan_net"))
                  if _k.get("hesaplanan_net") is not None else None)
        fark_ode = (round(sonuc["net_odenecek"] - v1_ode, 2)
                    if v1_ode is not None else None)
        toplam_v1 += v1_hak
        toplam_v2 += v2_saf
        _kirik_hak = (not kiyas_disi) and abs(fark_hak) > 0.005
        _kirik_ode = (fark_ode is not None) and abs(fark_ode) > 0.005
        if _kirik_hak or _kirik_ode:
            kirik += 1
        satirlar.append({
            "personel_id": pid, "ad_soyad": r.get("ad_soyad"),
            "durum": _k.get("durum"),
            "v1_net": round(v1_hak, 2), "v2_net": round(v2_saf, 2),
            "fark": fark_hak, "hakedis_kiyas_disi": kiyas_disi,
            "v1_odenecek": v1_ode, "v2_odenecek": sonuc["net_odenecek"],
            "fark_odenecek": fark_ode,
            "kalemler": sonuc["kalemler"], "notlar": sonuc["notlar"],
            "eksen_toplam": sonuc["eksen_toplam"]})

    return satirlar, kirik, toplam_v1, toplam_v2

@router.get("/kalem-golge")
def kalem_golge(yil: int = Query(...), ay: int = Query(...),
                personel_id: Optional[str] = Query(None)):
    """V1 net'i ile saf motorun kalem toplamını karşılaştırır. SALT OKUR."""
    with db() as (_, cur):
        satirlar, kirik, toplam_v1, toplam_v2 = _kalem_donem_hesapla(
            cur, yil, ay, personel_id)
    return {"yil": yil, "ay": ay, "kisi": len(satirlar), "kirik": kirik,
            "toplam_v1": round(toplam_v1, 2), "toplam_v2": round(toplam_v2, 2),
            "toplam_fark": round(toplam_v2 - toplam_v1, 2),
            "hazir": kirik == 0,
            "satirlar": satirlar}


# ── DEFTERE YAZ (Adım 6/3) ──────────────────────────────────────────────────
class KalemYazModel(BaseModel):
    kuru: bool = True
    gerekce: Optional[str] = None


@router.post("/kalem-yaz")
def kalem_yaz(m: KalemYazModel, yil: int = Query(...), ay: int = Query(...),
              personel_id: Optional[str] = Query(None)):
    """Motorun ürettiği kalemleri `bordro_kalem`'e YAZAR. ⚠️ PARA AKMAZ.

    🔴 APPEND-ONLY: eski kalemler SİLİNMEZ, `durum='eski'` yapılır ve yeni
    sürüm yazılır. "Bu rakam dün neydi" sorusunun cevabı kalmalı — bordroda
    silinen satır, savunulamayan bordrodur.

    `personel_aylik`'e yalnız İZLEME alanları yazılır (Adım 1'de bunun için
    açılmıştı): `kalem_toplam`, `guncel_fark`, `hesap_surumu`, `hesap_ts`,
    `kural_id`. **`hesaplanan_net`'e DOKUNULMAZ** — para hâlâ V1'den akar.
    Kesim ayrı bir adımdır ve kabul testi + gölge 0 fark şartına bağlıdır.
    """
    yazilan, atlanan = [], []
    with db() as (conn, cur):
        satirlar, kirik, _tv1, _tv2 = _kalem_donem_hesapla(cur, yil, ay, personel_id)
        for s in satirlar:
            pid = s["personel_id"]
            kalemler = s["kalemler"]
            if not kalemler:
                atlanan.append({"ad_soyad": s["ad_soyad"], "neden": "kalem yok"})
                continue
            # ⛔ KARAR KAYITLARI SÜRÜMLENMEZ (kuru çalıştırma bunu yakaladı):
            # `YEMEK_GUN_ONAY` satırları HESAPLANMIŞ kalem değil, sahibin
            # KARARIdır. Yeniden hesap onları eskitemez — eskitseydi bugün
            # onaylanan 12 mola günü tek komutla kaybolurdu.
            cur.execute(
                "SELECT COALESCE(MAX(surum),0) AS s FROM bordro_kalem "
                " WHERE personel_id=%s AND yil=%s AND ay=%s "
                "   AND tur <> 'YEMEK_GUN_ONAY'", (pid, yil, ay))
            surum = int((cur.fetchone() or {}).get("s") or 0) + 1
            yazilan.append({"personel_id": pid, "ad_soyad": s["ad_soyad"],
                            "surum": surum, "kalem": len(kalemler),
                            "kalem_toplam": s["v2_odenecek"],
                            "guncel_fark": s.get("fark_odenecek")})
            if m.kuru:
                continue
            # append-only: öncekiler 'eski', yenisi 'aktif'
            cur.execute("UPDATE bordro_kalem SET durum='eski' "
                        " WHERE personel_id=%s AND yil=%s AND ay=%s AND durum='aktif' "
                        "   AND tur <> 'YEMEK_GUN_ONAY'",   # ⛔ KARAR dokunulmaz
                        (pid, yil, ay))
            for k in kalemler:
                cur.execute(
                    "INSERT INTO bordro_kalem (personel_id, yil, ay, surum, tur, eksen, "
                    "   miktar, birim, birim_tutar, tutar, kaynak, kanit_sinifi, kanit, "
                    "   kural_id, ucret_tanim_id, durum) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,'aktif')",
                    (pid, yil, ay, surum, k["tur"], k["eksen"], k["miktar"], k["birim"],
                     k["birim_tutar"], k["tutar"], k["kaynak"], k["kanit_sinifi"],
                     json.dumps(k["kanit"], ensure_ascii=False, default=str),
                     k.get("kural_id"), k.get("ucret_tanim_id")))
            # personel_aylik: YALNIZ izleme alanları (hesaplanan_net'e DOKUNMA)
            cur.execute(
                "UPDATE personel_aylik SET hesap_surumu=%s, hesap_ts=NOW(), "
                "       kural_id=%s, kalem_toplam=%s, guncel_fark=%s "
                " WHERE personel_id=%s AND yil=%s AND ay=%s",
                (surum, (kalemler[0] or {}).get("kural_id"), s["v2_odenecek"],
                 s.get("fark_odenecek"), pid, yil, ay))
        if m.kuru:
            conn.rollback()
        else:
            conn.commit()

    return {"kuru": m.kuru, "yil": yil, "ay": ay,
            "kisi": len(yazilan), "atlanan": len(atlanan),
            "kalem_toplam": sum(x["kalem"] for x in yazilan),
            "golge_kirik": kirik,
            "satirlar": yazilan, "atlanan_detay": atlanan,
            "not": ("KURU — hicbir sey yazilmadi. kuru=false ile uygulayin."
                    if m.kuru else
                    "YAZILDI — bordro_kalem doldu. PARA HALA V1'DEN AKIYOR.")}


@router.get("/kalem")
def kalem_oku(yil: int = Query(...), ay: int = Query(...),
              personel_id: Optional[str] = Query(None)):
    """Deftere yazılmış kalemleri okur — "bu rakam nereden çıktı"nın cevabı."""
    kosul = ["yil=%s", "ay=%s", "durum='aktif'"]
    par: List[Any] = [yil, ay]
    if personel_id:
        kosul.append("personel_id=%s")
        par.append(str(personel_id))
    with db() as (_, cur):
        cur.execute(
            "SELECT k.*, p.ad_soyad FROM bordro_kalem k "
            "  LEFT JOIN personel p ON p.id = k.personel_id "
            " WHERE " + " AND ".join(kosul) +
            " ORDER BY p.ad_soyad, k.eksen, k.tur", tuple(par))
        R = [dict(r) for r in (cur.fetchall() or [])]
    kisi: Dict[str, Any] = {}
    for r in R:
        a = r.get("ad_soyad") or r["personel_id"]
        d = kisi.setdefault(a, {"kalemler": [], "toplam": 0.0, "surum": r.get("surum"),
                                "personel_id": str(r.get("personel_id") or "")})
        d["kalemler"].append(r)
        d["toplam"] = round(d["toplam"] + float(r.get("tutar") or 0), 2)

    # 🔴 DEFTER BAYATLAYABİLİR (Adım 11 · canlı bulgu 2026-09-07)
    # Kesimden sonra net HER SENKRONDA motordan yeniden hesaplanıyor, ama
    # `bordro_kalem` tablosuna YAZMA ayrı bir uçla (`/kalem-yaz`) yapılıyor.
    # Açık ayda gün ilerledikçe yazılı defter hesabın gerisinde kalıyor —
    # canlı: Eylül defteri 6 Eylül'de yazılmış, kişi başına 900-1.400 ₺ geride.
    # Personelin telefonunda üstte GÜNCEL net, altta ESKİ döküm görünüyordu ve
    # ikisi tutmuyordu; döküm "bu rakam nereden çıktı"yı yanlış cevaplıyordu.
    # ⚠️ SESSİZCE TAZELEMİYORUZ (defter append-only, her okuma yeni sürüm
    # yazsaydı tablo şişerdi). Duyu SÖYLER: `guncel=false` + fark.
    with db() as (_, cur2):
        try:
            sat, _k, _t1, _t2 = _kalem_donem_hesapla(cur2, yil, ay, personel_id)
        except Exception as e:  # noqa: BLE001
            logger.warning("kalem defteri tazelik olculemedi %s-%s: %s", yil, ay, e)
            sat = []
    simdi = {str(x["personel_id"]): x for x in sat}
    bayat = 0
    for a, d in kisi.items():
        x = simdi.get(d.get("personel_id") or "")
        if not x:
            d["guncel"] = None       # ölçülemedi ≠ güncel
            continue
        gnc = float(x.get("v2_odenecek") or 0)
        d["guncel_net"] = gnc
        d["fark"] = round(gnc - float(d["toplam"]), 2)
        d["guncel"] = abs(d["fark"]) < 0.5
        if not d["guncel"]:
            bayat += 1
    return {"yil": yil, "ay": ay, "kisi": len(kisi), "kalem": len(R),
            "bayat_kisi": bayat,
            "not": ("Defter GÜNCEL." if not bayat else
                    "%d kişinin defteri hesabın gerisinde — ay ilerledi, defter "
                    "o günden beri yazılmadı. Tazelemek icin POST /api/ucret/kalem-yaz"
                    % bayat),
            "defter": kisi}


# ── DÜZELTME DEFTERİ (Adım 8) ───────────────────────────────────────────────
# 🔴 NEDEN (canlı bulgu 2026-09-07, kendi hatam):
# Kapanmış dönemin farkı `anlik_giderler`'e serbest bir "elden ödeme" satırı
# olarak yazılmıştı. O satırın düzelttiği DÖNEME hiçbir bağı yoktu. Sonra
# Ağustos'u kapatırken KAYNAK kaydı da düzelttim — ve aynı para iki yerde
# birden kaldı: MERVE KARABACAK 3.180,00 + YAĞIZ ERKEK 1.400,00 = 4.580,00 ₺.
# Hiçbir şey uyarmadı, çünkü düzeltmeyi kaynağına bağlayan bir defter yoktu.
#
# Düzeltme defteri üç şeyi birden tutar:
#   1) HANGİ DÖNEMİ düzeltiyor (kaynak_yil/ay) — serbest gider satırında yok
#   2) YAZILDIĞI ANDA kaynak ne diyordu (`kanit.v1_anlik`) — çıpa
#   3) Bugün kaynak ne diyor — DUYU bunu her okumada yeniden ölçer
# Üçü bir arada olunca "kaynak sonradan düzeltildi, bu düzeltme artık mükerrer"
# durumu KENDİLİĞİNDEN görünür. Tek bir çıpa ([[feedback-kayan-pencere-capa]])
# olmadan bu tespit imkânsızdır.
class DuzeltmeModel(BaseModel):
    personel_id: str
    kaynak_yil: int
    kaynak_ay: int
    tutar: float
    neden: str
    hedef_yil: Optional[int] = None
    hedef_ay: Optional[int] = None
    gider_id: Optional[str] = None      # bağlı anlik_giderler satırı
    kuru: bool = True                   # ⚠️ VARSAYILAN KURU


def _duzeltme_tani(tutar: float, v1_anlik, v1_simdi, v2_simdi):
    """Bir düzeltme bugün hâlâ GEÇERLİ mi, MÜKERRER mi, EKSİK mi?

    Kanıt: düzeltme yazıldığında kaynak `v1_anlik` diyordu. Bugün `v1_simdi`
    diyor. Motorun gerçeği `v2_simdi`. Açık = v2 − v1.
      · açık ≈ düzeltme tutarı → kaynak değişmemiş, düzeltme YERİNDE
      · açık ≈ 0               → kaynak sonradan düzeltilmiş → MÜKERRER
      · açık > düzeltme        → düzeltme yetmiyor, hâlâ eksik var
    """
    if v1_simdi is None or v2_simdi is None:
        return ("olculemedi",
                "Bu dönem için karşılaştırma yapılamadı — kaynak kaydı okunamıyor.")
    acik = round(float(v2_simdi) - float(v1_simdi), 2)
    t = round(float(tutar or 0), 2)
    if abs(acik - t) < 1.0:
        return ("gecerli",
                "Kaynak kayıt hâlâ %s ₺ eksik — bu düzeltme yerinde duruyor." % ("%.2f" % t))
    if abs(acik) < 1.0:
        return ("mukerrer",
                "⚠ Kaynak kayıt sonradan düzeltilmiş (%s → %s). Aynı para iki yerde: "
                "bu düzeltme artık MÜKERRER."
                % (("%.2f" % float(v1_anlik)) if v1_anlik is not None else "?",
                   "%.2f" % float(v1_simdi)))
    if acik > t:
        return ("eksik",
                "Kaynakta hâlâ %s ₺ açık var — bu düzeltme (%s ₺) tamamını kapatmıyor."
                % ("%.2f" % acik, "%.2f" % t))
    return ("fazla",
            "Düzeltme (%s ₺) kaynaktaki açıktan (%s ₺) büyük." % ("%.2f" % t, "%.2f" % acik))


@router.get("/duzeltme")
def duzeltme_listesi(yil: Optional[int] = Query(None), ay: Optional[int] = Query(None)):
    """Düzeltme defteri + HER SATIRIN BUGÜNKÜ GEÇERLİLİĞİ.

    ⚠️ Bu uç sadece listelemez, ÖLÇER. Bir düzeltme yazıldıktan sonra kaynak
    kayıt değişmiş olabilir; o zaman düzeltme sessizce mükerrere döner. Liste
    her okumada bunu yeniden hesaplar — "yazdım ve unuttum" hâli olmasın.
    """
    with db() as (_, cur):
        sql = ("SELECT d.id, d.personel_id, d.kaynak_yil, d.kaynak_ay, d.hedef_yil, "
               "       d.hedef_ay, d.tutar, d.neden, d.kanit, d.durum, d.olusturma, "
               "       p.ad_soyad "
               "  FROM bordro_duzeltme d "
               "  LEFT JOIN personel p ON p.id = d.personel_id "
               " WHERE d.durum <> 'reddedildi' ")
        args: List[Any] = []
        if yil:
            sql += " AND d.kaynak_yil=%s"
            args.append(yil)
        if ay:
            sql += " AND d.kaynak_ay=%s"
            args.append(ay)
        sql += " ORDER BY d.kaynak_yil DESC, d.kaynak_ay DESC, p.ad_soyad"
        cur.execute(sql, tuple(args))
        satirlar = [dict(r) for r in (cur.fetchall() or [])]

        # Dönem başına TEK gölge koşusu — kişi başına çağırmak dakikalar sürerdi.
        donemler = sorted({(int(s["kaynak_yil"]), int(s["kaynak_ay"])) for s in satirlar})
        golge: Dict[Any, Dict[str, Any]] = {}
        for (y, a) in donemler:
            try:
                sat, _k, _t1, _t2 = _kalem_donem_hesapla(cur, y, a)
            except Exception as e:  # noqa: BLE001
                logger.warning("duzeltme golge okunamadi %s-%s: %s", y, a, e)
                continue
            for s in sat:
                golge[(y, a, str(s["personel_id"]))] = s

        out, ozet = [], {"gecerli": 0, "mukerrer": 0, "eksik": 0, "fazla": 0, "olculemedi": 0}
        mukerrer_tl = 0.0
        for s in satirlar:
            k = s.get("kanit") or {}
            if isinstance(k, str):
                try:
                    k = json.loads(k)
                except Exception:  # noqa: BLE001
                    k = {}
            g = golge.get((int(s["kaynak_yil"]), int(s["kaynak_ay"]), str(s["personel_id"])))
            tani, metin = _duzeltme_tani(
                float(s["tutar"] or 0), k.get("v1_anlik"),
                (g or {}).get("v1_odenecek"), (g or {}).get("v2_odenecek"))
            ozet[tani] = ozet.get(tani, 0) + 1
            if tani == "mukerrer":
                mukerrer_tl += float(s["tutar"] or 0)
            out.append({**{kk: s[kk] for kk in
                           ("id", "personel_id", "ad_soyad", "kaynak_yil", "kaynak_ay",
                            "hedef_yil", "hedef_ay", "neden", "durum", "olusturma")},
                        "tutar": float(s["tutar"] or 0),
                        "kanit": k,
                        "v1_anlik": k.get("v1_anlik"),
                        "v1_simdi": (g or {}).get("v1_odenecek"),
                        "v2_simdi": (g or {}).get("v2_odenecek"),
                        "tani": tani, "tani_metni": metin})
    return {"adet": len(out), "ozet": ozet,
            "mukerrer_tutar": round(mukerrer_tl, 2),
            "satirlar": out}


@router.post("/duzeltme")
def duzeltme_yaz(m: DuzeltmeModel):
    """Kapanmış döneme düzeltme yaz. ⚠️ VARSAYILAN KURU."""
    if not m.neden or not m.neden.strip():
        raise HTTPException(400, "neden zorunlu — duzeltme denetimde savunulmali")
    if abs(float(m.tutar or 0)) < 0.01:
        raise HTTPException(400, "tutar sifir olamaz")
    with db() as (conn, cur):
        cur.execute("SELECT id, ad_soyad FROM personel WHERE id=%s", (str(m.personel_id),))
        p = cur.fetchone()
        if not p:
            raise HTTPException(404, "personel bulunamadi")
        # Aynı kişi+dönem+tutar zaten varsa MÜKERRER yazma.
        cur.execute("SELECT id FROM bordro_duzeltme "
                    " WHERE personel_id=%s AND kaynak_yil=%s AND kaynak_ay=%s "
                    "   AND ROUND(tutar,2)=ROUND(%s,2) AND durum <> 'reddedildi'",
                    (str(m.personel_id), m.kaynak_yil, m.kaynak_ay, float(m.tutar)))
        if cur.fetchone():
            return {"ok": False, "neden": "ayni kisi/donem/tutar zaten kayitli"}

        # ÇIPA: yazıldığı anda kaynak ne diyordu. Sonradan değişirse duyu görür.
        try:
            sat, _k, _t1, _t2 = _kalem_donem_hesapla(cur, m.kaynak_yil, m.kaynak_ay,
                                                     str(m.personel_id))
        except Exception:  # noqa: BLE001
            sat = []
        g = sat[0] if sat else {}
        kanit = {"v1_anlik": g.get("v1_odenecek"), "v2_anlik": g.get("v2_odenecek"),
                 "gider_id": m.gider_id, "yazim_ts": str(date.today())}
        if m.kuru:
            return {"kuru": True, "yazilacak": {
                "ad_soyad": p.get("ad_soyad"), "donem": "%d-%02d" % (m.kaynak_yil, m.kaynak_ay),
                "tutar": float(m.tutar), "kanit": kanit},
                "not": "KURU — hicbir sey yazilmadi. kuru=false ile uygulayin."}
        cur.execute(
            "INSERT INTO bordro_duzeltme (personel_id, kaynak_yil, kaynak_ay, "
            "        hedef_yil, hedef_ay, tutar, neden, kanit, durum) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb,'uygulandi') RETURNING id",
            (str(m.personel_id), m.kaynak_yil, m.kaynak_ay, m.hedef_yil, m.hedef_ay,
             float(m.tutar), m.neden.strip(), json.dumps(kanit, ensure_ascii=False)))
        yeni = cur.fetchone()["id"]
        conn.commit()
    return {"ok": True, "id": yeni, "ad_soyad": p.get("ad_soyad")}


class DuzeltmeBackfillModel(BaseModel):
    kuru: bool = True


@router.post("/duzeltme/backfill")
def duzeltme_backfill(m: DuzeltmeBackfillModel):
    """Elden yazılmış hakediş farklarını düzeltme defterine TAŞI. ⚠️ KURU.

    Bu kayıtlar bugüne kadar `anlik_giderler`'de serbest satırdı: hangi dönemi
    düzelttikleri yalnız AÇIKLAMA METNİNDE yazıyordu, hiçbir alan bağlamıyordu.
    Deftere taşınınca kaynağına bağlanır ve duyu onları izlemeye başlar.
    """
    import re as _re
    with db() as (conn, cur):
        cur.execute(
            "SELECT id, tarih, tutar, aciklama FROM anlik_giderler "
            " WHERE aciklama LIKE %s ORDER BY tarih", ("%hakediş farkı (elden)%",))
        giderler = [dict(r) for r in (cur.fetchall() or [])]
        # 🪤 AYNI AD, İKİ KAYIT (canlı bulgu 2026-09-07): CELİLE IŞIK'ın biri
        # 1 Mayıs'ta başlayan kapanmış dönemi, diğeri 7 Eylül'de başlayan yeni
        # dönemi. Adı anahtar yapan sözlük ikincisini birincinin üzerine yazdı
        # ve HAZİRAN düzeltmesi EYLÜL kaydına bağlandı. Ad TEK BAŞINA kimlik
        # değildir — dönem de sorulmalı ([[feedback-personel-kisi-kimligi]]).
        cur.execute("SELECT id, ad_soyad, baslangic_tarihi FROM personel "
                    " ORDER BY baslangic_tarihi NULLS FIRST")
        _aday: Dict[str, List[Dict[str, Any]]] = {}
        for r in (cur.fetchall() or []):
            _aday.setdefault((r["ad_soyad"] or "").strip(), []).append(dict(r))

        def _kisi_sec(ad: str, yy: int, aa: int):
            """O DÖNEMDE çalışan kaydı seç. Belirsizse None — uydurma yok."""
            adaylar = _aday.get(ad) or []
            if not adaylar:
                return None, "personel bulunamadi: %s" % ad
            if len(adaylar) == 1:
                return adaylar[0]["id"], None
            son = date(yy + (1 if aa == 12 else 0), (1 if aa == 12 else aa + 1), 1) - timedelta(days=1)
            uygun = [a for a in adaylar
                     if not a.get("baslangic_tarihi") or a["baslangic_tarihi"] <= son]
            if not uygun:
                return None, ("%s adinda %d kayit var, hicbiri %d-%02d doneminde baslamamis"
                              % (ad, len(adaylar), yy, aa))
            uygun.sort(key=lambda a: (a.get("baslangic_tarihi") or date(1900, 1, 1)))
            return uygun[-1]["id"], None

        yazilacak, atlanan = [], []
        for g in giderler:
            ac = str(g.get("aciklama") or "")
            mm = _re.match(r"^(.+?)\s+(\d{4})-(\d{2})\s+hakediş farkı", ac)
            if not mm:
                atlanan.append({"gider_id": g["id"], "neden": "aciklama cozulemedi"})
                continue
            ad, yy, aa = mm.group(1).strip(), int(mm.group(2)), int(mm.group(3))
            pid, _hata = _kisi_sec(ad, yy, aa)
            if not pid:
                # ⛔ GEVŞEK AD EŞLEŞTİRME YOK ([[feedback-para-zinciri-dersleri]]):
                # yakın ad aramak yerine ATLA ve ADIYLA söyle. Yanlış kişiye
                # bağlanan bir para kaydı, hiç bağlanmamış olandan beterdir.
                atlanan.append({"gider_id": g["id"], "neden": _hata})
                continue
            cur.execute("SELECT id FROM bordro_duzeltme "
                        " WHERE personel_id=%s AND kaynak_yil=%s AND kaynak_ay=%s "
                        "   AND ROUND(tutar,2)=ROUND(%s,2) AND durum <> 'reddedildi'",
                        (pid, yy, aa, float(g["tutar"] or 0)))
            if cur.fetchone():
                atlanan.append({"gider_id": g["id"], "neden": "defterde zaten var"})
                continue
            # Açıklamadaki "Evvel X kaydetmiş" tutarı = yazıldığı andaki çıpa.
            m2 = _re.search(r"Evvel\s+([\d.]+,\d{2})\s+kaydetmiş", ac)
            v1_anlik = None
            if m2:
                try:
                    v1_anlik = float(m2.group(1).replace(".", "").replace(",", "."))
                except ValueError:
                    v1_anlik = None
            yazilacak.append({
                "personel_id": pid, "ad_soyad": ad, "yil": yy, "ay": aa,
                "tutar": float(g["tutar"] or 0), "gider_id": g["id"],
                "v1_anlik": v1_anlik, "aciklama": ac})

        if m.kuru:
            return {"kuru": True, "bulunan_gider": len(giderler),
                    "yazilacak": len(yazilacak), "atlanan": len(atlanan),
                    "toplam_tutar": round(sum(x["tutar"] for x in yazilacak), 2),
                    "satirlar": yazilacak, "atlanan_detay": atlanan,
                    "not": "KURU — hicbir sey yazilmadi. kuru=false ile uygulayin."}

        for x in yazilacak:
            kanit = {"v1_anlik": x["v1_anlik"], "gider_id": x["gider_id"],
                     "kaynak": "anlik_giderler", "aciklama": x["aciklama"],
                     "yazim_ts": str(date.today())}
            cur.execute(
                "INSERT INTO bordro_duzeltme (personel_id, kaynak_yil, kaynak_ay, "
                "        tutar, neden, kanit, durum) "
                "VALUES (%s,%s,%s,%s,%s,%s::jsonb,'uygulandi')",
                (x["personel_id"], x["yil"], x["ay"], x["tutar"],
                 "Evvel eksik kaydetmisti, fark elden odendi (sahip 2026-09-06)",
                 json.dumps(kanit, ensure_ascii=False)))
        conn.commit()
    return {"kuru": False, "yazilan": len(yazilacak), "atlanan": len(atlanan),
            "toplam_tutar": round(sum(x["tutar"] for x in yazilacak), 2)}


class DuzeltmeDurumModel(BaseModel):
    durum: str                  # 'uygulandi' | 'reddedildi'
    gerekce: str


@router.post("/duzeltme/{did}/durum")
def duzeltme_durum(did: str, m: DuzeltmeDurumModel):
    """Bir düzeltmeyi geçersiz kıl ya da geri getir. SİLMEZ — iz kalır.

    🔴 'reddedildi' bir SİLME değildir: satır defterde durur, listeden düşer ve
    ne zaman/neden geçersiz kılındığı `kanit.red`'de yazar. Para kaydını silmek,
    "bu para hiç konuşulmadı" demektir; oysa konuşuldu ve bir karar verildi.
    """
    d = (m.durum or "").strip()
    if d not in ("uygulandi", "reddedildi"):
        raise HTTPException(400, "durum 'uygulandi' veya 'reddedildi' olmali")
    if not (m.gerekce or "").strip():
        raise HTTPException(400, "gerekce zorunlu — bu bir PARA kararidir")
    with db() as (conn, cur):
        cur.execute("SELECT id, kanit, durum FROM bordro_duzeltme WHERE id=%s", (str(did),))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "duzeltme bulunamadi")
        k = r["kanit"] or {}
        if isinstance(k, str):
            try:
                k = json.loads(k)
            except Exception:  # noqa: BLE001
                k = {}
        k.setdefault("gecmis", []).append(
            {"eski_durum": r["durum"], "yeni_durum": d,
             "gerekce": m.gerekce.strip(), "ts": str(date.today())})
        cur.execute("UPDATE bordro_duzeltme SET durum=%s, kanit=%s::jsonb WHERE id=%s",
                    (d, json.dumps(k, ensure_ascii=False), str(did)))
        conn.commit()
    return {"ok": True, "id": did, "durum": d}


# ── PLAN ↔ BORDRO BAĞI (Adım 9) ─────────────────────────────────────────────
# 🔴 NEDEN (canlı ölçüm 2026-09-07):
# Maaş ödeme planı satırı bordroya TARİH ARİTMETİĞİYLE bağlıydı: plan
# `kaynak_tablo='personel'` + `referans_ay` ile yazılıyor, hangi BORDRO
# KAYDINDAN doğduğu hiçbir yerde durmuyordu. Sonucu canlıda görünür:
#   · Ağustos dönemi için 189.985,68 ₺ hâlâ "bekliyor" — bordrolar 'taslak',
#     ödeme gerçekte yapılmış olsa bile plan kendiliğinden kapanmıyor
#   · MEHMET EFE Ağustos bordrosu 'onaylandi' AMA planı hâlâ açık
#   · MERT ALİ AKAR Haziran planı 68 gündür gecikmiş görünüyor
# Nakit kokpiti bu satırları 30 günlük çıkışa sayıyor; yani "ne kadar para
# çıkacak" sorusunun cevabı, kapanmamış eski planlar yüzünden şişik.
#
# Bu adım PARAYA DOKUNMAZ: yalnız `odeme_plani.bordro_id` alanını doldurur
# (Adım 1'de boş açılmıştı) ve iki defteri YAN YANA okutur. Kapatma kararı
# sahibindir — bağ kurulmadan o karar bile verilemiyordu.
class PlanBaglaModel(BaseModel):
    kuru: bool = True


def _plan_bordro_esle(cur):
    """Maaş planı satırlarını bordro kaydıyla eşle. SALT OKUR, liste döner.

    Eşleşme çapası: (personel_id, ÇALIŞMA DÖNEMİ). Çalışma dönemi plandaki
    `referans_ay`dan `maas_service.referans_to_donem` ile çözülür — o alan
    ÖDEME ayını tutar, dönemi değil. Ad ya da tutar üzerinden EŞLEŞTİRİLMEZ;
    ikisi de zayıf kanıttır ([[feedback-teslimat-fatura-eslesme]]).
    """
    import maas_service as _maas_svc
    cur.execute(
        "SELECT op.id, op.kaynak_id AS personel_id, op.tarih, op.referans_ay, "
        "       op.odenecek_tutar, COALESCE(op.odenen_tutar,0) AS odenen_tutar, "
        "       op.durum, op.aciklama, op.bordro_id, "
        "       p.ad_soyad "
        "  FROM odeme_plani op "
        "  LEFT JOIN personel p ON p.id = op.kaynak_id "
        " WHERE op.kaynak_tablo = 'personel' "
        " ORDER BY op.tarih")
    planlar = [dict(r) for r in (cur.fetchall() or [])]

    cur.execute("SELECT id, personel_id, yil, ay, hesaplanan_net, durum "
                "  FROM personel_aylik")
    bordro = {(str(r["personel_id"]), int(r["yil"]), int(r["ay"])): dict(r)
              for r in (cur.fetchall() or [])}

    out = []
    for pl in planlar:
        ref = pl.get("referans_ay")
        # 🔴 referans_ay = ÖDEME AYI, ÇALIŞMA DÖNEMİ DEĞİL (maas_service:59-64).
        # İlk sürümde referans_ay'ı dönem sandım ve 87 satırın 32'si "bordro yok"
        # göründü — oysa hepsinin bordrosu vardı, yalnızca BİR AY KAYMIŞTI.
        # Dönüşümü BURADA yeniden türetmiyoruz: planı yazan modülün kendi ters
        # fonksiyonu çağrılır. İki yerde iki ayrı tarih aritmetiği, bu projede
        # zaten üç ayrı dönem-oranı formülü doğurmuştu (TEK ÇEKİRDEK).
        if not ref:
            out.append({**pl, "bordro": None, "tani": "referans_ay yok",
                        "tani_metni": "Plan hangi döneme ait belli değil — bağlanamaz."})
            continue
        _dy, _da = _maas_svc.referans_to_donem(ref)
        b = bordro.get((str(pl.get("personel_id")), _dy, _da))
        # 🔴 ÖNCE DURUM, SONRA BORDRO (kendi duyumun sahte alarmı, 2026-09-07):
        # ilk sürümde bordro bulunamayınca ERKEN ÇIKIYORDUM ve durum kontrolüne
        # hiç varmıyordum. Sonuç: `durum='iptal'` 17 eski plan "yetim, açık"
        # göründü ve 600.630,00 ₺'lik SAHTE bir borç rakamı üretti. Kapanmış bir
        # satırın bordrosunun olmaması sorun değildir — o satır zaten bitmiştir.
        if pl["durum"] not in ("bekliyor", "onay_bekliyor"):
            out.append({**pl, "bordro": b, "tani": "kapali",
                        "tani_metni": "Plan zaten kapanmış (%s)." % pl["durum"]})
            continue
        if not b:
            out.append({**pl, "bordro": None, "tani": "bordro_yok",
                        "tani_metni": "Bu dönem için bordro kaydı yok; plan yetim."})
            continue
        net = float(b.get("hesaplanan_net") or 0)
        tutar = float(pl.get("odenecek_tutar") or 0)
        fark = round(net - tutar, 2)
        if b["durum"] == "odendi":
            tani = "bordro_odendi_plan_acik"
            metin = ("⚠ Bordro ÖDENDİ işaretli ama plan hâlâ açık — nakit "
                     "kokpitinde çıkacak para gibi görünüyor.")
        elif b["durum"] == "onaylandi":
            tani = "bordro_onayli_plan_acik"
            metin = ("Bordro onaylanmış, plan açık. Ödeme yapıldıysa plan "
                     "kapatılmalı; yapılmadıysa borç gerçek.")
        elif abs(fark) > 0.5:
            tani = "tutar_farki"
            metin = ("Plan %s ₺ diyor, bordro %s ₺ — aradaki %s ₺ hangi rakamın "
                     "güncel olduğuna göre değişir." % ("%.2f" % tutar, "%.2f" % net,
                                                        "%.2f" % fark))
        else:
            tani, metin = "hizali", "Plan ve bordro aynı rakamı söylüyor."
        out.append({**pl, "bordro": b, "fark": fark, "tani": tani, "tani_metni": metin})
    return out


@router.get("/plan-durum")
def plan_durum():
    """Maaş ödeme planı ↔ bordro kaydı YAN YANA. SALT OKUR.

    "Bu maaş ödendi mi" sorusunun cevabı bugüne kadar iki ayrı deftere bakıp
    kafadan eşleştirmeyi gerektiriyordu. Burada tek tabloda duruyor.
    """
    with db() as (_, cur):
        satirlar = _plan_bordro_esle(cur)
    ozet: Dict[str, int] = {}
    acik_tl = 0.0
    for s in satirlar:
        ozet[s["tani"]] = ozet.get(s["tani"], 0) + 1
        # AÇIK = kapanmamış satır. 'kapali' hariç her şey açıktır; tek tek
        # saymak yeni bir tanı eklendiğinde onu sessizce dışarıda bırakırdı.
        if s["tani"] != "kapali":
            acik_tl += float(s.get("odenecek_tutar") or 0)
    return {"adet": len(satirlar), "ozet": ozet,
            "acik_plan_tutari": round(acik_tl, 2),
            "bagli": sum(1 for s in satirlar if s.get("bordro_id")),
            "satirlar": [{k: v for k, v in s.items() if k != "bordro"}
                         | {"bordro_durum": (s.get("bordro") or {}).get("durum"),
                            "bordro_net": (s.get("bordro") or {}).get("hesaplanan_net")}
                         for s in satirlar]}


@router.post("/plan-bagla")
def plan_bagla(m: PlanBaglaModel):
    """`odeme_plani.bordro_id` alanını doldur. ⚠️ VARSAYILAN KURU · PARA AKMAZ.

    Yalnızca KİMLİK yazar; tutar, durum, tarih hiçbiri değişmez. Bağ kurulunca
    "bu plan hangi bordrodan doğdu" sorusu tarih aritmetiğiyle değil, kimlikle
    cevaplanır.
    """
    with db() as (conn, cur):
        satirlar = _plan_bordro_esle(cur)
        yazilacak = [s for s in satirlar
                     if s.get("bordro") and not s.get("bordro_id")]
        if m.kuru:
            return {"kuru": True, "plan_satiri": len(satirlar),
                    "baglanacak": len(yazilacak),
                    "zaten_bagli": sum(1 for s in satirlar if s.get("bordro_id")),
                    "baglanamaz": sum(1 for s in satirlar if not s.get("bordro")),
                    "satirlar": [{"ad_soyad": s.get("ad_soyad"),
                                  "donem": str(s.get("referans_ay"))[:7],
                                  "plan_tutar": float(s.get("odenecek_tutar") or 0),
                                  "bordro_net": float((s["bordro"] or {}).get("hesaplanan_net") or 0),
                                  "bordro_durum": (s["bordro"] or {}).get("durum"),
                                  "tani": s["tani"]}
                                 for s in yazilacak],
                    "not": "KURU — hicbir sey yazilmadi. kuru=false ile uygulayin."}
        for s in yazilacak:
            cur.execute("UPDATE odeme_plani SET bordro_id=%s WHERE id=%s",
                        (s["bordro"]["id"], s["id"]))
        conn.commit()
    return {"kuru": False, "baglanan": len(yazilacak)}
