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
        bekleyen.append({
            "personel_id": str(r.get("personel_id")),
            "ad_soyad": r.get("ad_soyad"),
            "planli_gun": pg,
            "askida_gun": len(gunler),
            "gunler": gunler,
            "gun_tutari": round(gun_tl, 2),
            "toplam_tutar": round(gun_tl * len(gunler), 2),
            "mola_ozet": r.get("mola_ozet"),
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
@router.get("/kalem-golge")
def kalem_golge(yil: int = Query(...), ay: int = Query(...),
                personel_id: Optional[str] = Query(None)):
    """V1 net'i ile saf motorun Σ kalem'ini karşılaştırır. SALT OKUR."""
    import bordro_motor as _bm
    try:
        from gorev_api import vardiya_takip as _vt
        vt = _vt(yil, ay, personel_id=personel_id) if personel_id else _vt(yil, ay)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, "vardiya takip okunamadi: %s" % e)

    satirlar, kirik, toplam_v1, toplam_v2 = [], 0, 0.0, 0.0
    with db() as (_, cur):
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
                "       COALESCE(mahsup_devir,0) AS mahsup_devir, durum "
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
            sonuc = _bm.hesapla(sz, kr, olcum, karar, mahsup)

            # İKİ AYRI KARŞILAŞTIRMA — ikisi farklı soruyu ölçer:
            #   hakediş  ↔ vardiya_takip.net_hakediş   (SOZLESME+OLCUM, KARAR hariç)
            #   ödenecek ↔ personel_aylik.hesaplanan_net (KARAR+MAHSUP dahil)
            v1_hak = float(r.get("net_hakediş") or 0)
            v2_saf = sonuc["eksen_toplam"]["SOZLESME"] + sonuc["eksen_toplam"]["OLCUM"]
            fark_hak = round(v2_saf - v1_hak, 2)
            v1_ode = (float(_k.get("hesaplanan_net"))
                      if _k.get("hesaplanan_net") is not None else None)
            fark_ode = (round(sonuc["net_odenecek"] - v1_ode, 2)
                        if v1_ode is not None else None)
            toplam_v1 += v1_hak
            toplam_v2 += v2_saf
            if abs(fark_hak) > 0.005 or (fark_ode is not None and abs(fark_ode) > 0.005):
                kirik += 1
            satirlar.append({
                "personel_id": pid, "ad_soyad": r.get("ad_soyad"),
                "durum": _k.get("durum"),
                "v1_net": round(v1_hak, 2), "v2_net": round(v2_saf, 2),
                "fark": fark_hak,
                "v1_odenecek": v1_ode, "v2_odenecek": sonuc["net_odenecek"],
                "fark_odenecek": fark_ode,
                "kalemler": sonuc["kalemler"], "notlar": sonuc["notlar"],
                "eksen_toplam": sonuc["eksen_toplam"]})

    return {"yil": yil, "ay": ay, "kisi": len(satirlar), "kirik": kirik,
            "toplam_v1": round(toplam_v1, 2), "toplam_v2": round(toplam_v2, 2),
            "toplam_fark": round(toplam_v2 - toplam_v1, 2),
            "hazir": kirik == 0,
            "satirlar": satirlar}
