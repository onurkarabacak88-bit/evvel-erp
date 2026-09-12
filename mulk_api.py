# -*- coding: utf-8 -*-
"""🏠 KİRALIK MÜLKLER — sahibin gayrimenkulleri, TULİPİ'den AYRI defter.

🔴 NEDEN (sahip 2026-09-08):
  · "kiralık mülklerimizin takip alanını kurmak istiyorum"
  · "bu kasa izi, kahveci dükkânın kasa izinden ayrışmalı"
  · "toplam kasa diye yeni bir isimde şu andaki kasa görünsün"

        TOPLAM KASA  =  TULİPİ kasası  +  MÜLK kasası

Para fiziken TEK yerde durur; ayrım paranın YERİNDE değil ETİKETİNDEdir
(`kasa_hareketleri.defter`). `defter` filtresi koymayan mevcut 530 sorgu
TOPLAMI okumaya devam eder — bugünkü kasa rakamı değişmez.

── İKİ EKSEN (Fable mimari turu 2026-09-08) ───────────────────────────────
`defter`     → bu para KİMİN cebi
`islem_turu` → bu akışın DOĞASI ne (gelir / emanet / varlık / iç transfer)
Sahibin şikâyeti ("Temmuz'da 3,88 M gelir elde ettik" — o EV SATIŞIYDI)
ikinci eksendedir. Tek eksen düzeltmek yetmez; ikisi birden süzülür
(`finans_core.TULIPI_GELIR_SUZGEC`).

── ÇIPA: SÖZLEŞME, DÖNEM DEĞİL ────────────────────────────────────────────
Beklenen kira satırları veritabanına YAZILMAZ, okunurken türetilir. Yazsaydık
yaşanmamış aylar karar kuyruğuna düşerdi ([[feedback-gelecek-gun-karar-kuyrugu]]).
Bakiye = Σ beklenen(sözleşme başlangıcı..bugün) − Σ tahsilat. Kayan pencere
YOK, çıpa sözleşme başlangıcıdır ([[feedback-kayan-pencere-capa]]).
Kısmi ödeme, gecikmiş toplu ödeme ve peşin ödeme bu tek formülden kendiliğinden
çıkar; hangi ayı kapattığı okuma anında FIFO ile bulunur (BAĞLAMA ≠ KAPATMA).

⚠️ DEPOZİTO GELİR DEĞİLDİR — iade edilecek emanettir. `kasa_etkisi=TRUE`
(para fiziken eldedir; FALSE yapmak kasa izini yalanlar) ama "kira geliri"
toplamına GİRMEZ.
"""
from __future__ import annotations

import logging
import re
import unicodedata
import uuid
import datetime as _dt
from datetime import date
from typing import Any, Dict, List, Optional

import hashlib

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from database import db
from kasa_service import insert_kasa_hareketi

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/mulk", tags=["mulk"])


# ═══════════════════════════════════════════════════════════════════
# AD NORMALİZASYONU — "hamayoun / hamayoğun / hamoayoun faizi" tek kişi
# ═══════════════════════════════════════════════════════════════════
# ⚠️ TÜRKÇE-I TUZAĞI: Python'un .lower()'ı 'İ' harfini birleşik noktalı bir
# karaktere çevirir ve arama sessizce ıskalar. Canlı veride bu tuzağa bir kez
# düşüldü: "KİRA" içeren 46 kaydın yalnız 9'u bulunmuştu.
def tr_kucuk(s: str) -> str:
    return unicodedata.normalize("NFC", (s or "").replace("İ", "i").replace("I", "ı").lower())


def ad_anahtari(s: str) -> str:
    """Yazım farklarını eleyen arama anahtarı. Eşleşme İDDİA etmez, ADAY üretir."""
    t = tr_kucuk(s)
    for a, b in (("ğ", "g"), ("ş", "s"), ("ı", "i"), ("ö", "o"), ("ü", "u"), ("ç", "c")):
        t = t.replace(a, b)
    t = re.sub(r"[^a-z0-9 ]", " ", t)
    t = re.sub(r"(.)\1+", r"\1", t)        # tekrarlı harf: "baser" ~ "basser"
    return " ".join(sorted(t.split()))     # kelime sırası önemsiz


AYLAR = ("ocak", "subat", "şubat", "mart", "nisan", "mayis", "mayıs", "haziran",
         "temmuz", "agustos", "ağustos", "eylul", "eylül", "ekim", "kasim",
         "kasım", "aralik", "aralık")


def kiraci_adi_ayikla(ham: str) -> str:
    """Serbest metinden kiracı adını çıkarır.

    ⚠️ TEK YER OLMASI ŞART: bu temizlik ÖNCE göç adayları ucunda, SONRA göç
    yazımında ayrı ayrı yazılmıştı ve ikisi farklı davranıyordu — yazım ucu ay
    adlarını temizlemiyordu, bu yüzden "HASAN GÜÇLÜ MAYIS KİRA" tanımlı
    kiracıya EŞLEŞMİYORDU (kuru çalıştırmada yakalandı). Aynı gerçeği iki
    yerde ayrı yazmak bu sistemdeki hataların en sık kalıbı.
    """
    t = tr_kucuk(ham or "")
    t = re.sub(r"(kira bedeli|kira|geliri|depozito|depozit|gecikmi[şs]|"
               r"[0-9]+ ?ayl[ıi]k| ay[ıi] | ay[ıi]$)", " ", t)
    t = re.sub(r"\b(" + "|".join(AYLAR) + r")\b", " ", t)
    return re.sub(r"\s+", " ", t).strip(" -–—.()")


# Tür adlarının insan dili — iptal açıklamalarında ve uyarılarda kullanılır.
# Ekrandaki TUR_AD ile AYNI metinler; iki yerde farklı yazılırsa aynı hareket
# defterde başka, ekranda başka görünürdü.
TUR_ADI = {
    "KIRA_TAHSILAT": "Kira tahsilatı",
    "DEPOZITO_ALINDI": "Depozito alındı",
    "DEPOZITO_IADE": "Depozito iadesi",
    "MULK_GIDER": "Mülk gideri",
    "MULK_AKTARIM_CIKIS": "Mülkten TULİPİ'ye çıkış",
    "VARLIK_SATISI": "Varlık satışı",
}


def _ay_ekle(y: int, a: int, n: int):
    t = (y * 12 + (a - 1)) + n
    return t // 12, t % 12 + 1


# ═══════════════════════════════════════════════════════════════════
# KASA — üç rakam
# ═══════════════════════════════════════════════════════════════════
@router.get("/kasa")
def mulk_kasa():
    """TOPLAM KASA · TULİPİ kasası · MÜLK kasası.

    ⚠️ `toplam` sahibin bugüne kadar gördüğü rakamla AYNIdır — hiçbir şey
    yerinden oynamadı, yalnız iki çekmeceye ayrıldı.
    """
    from finans_core import kasa_bakiyesi
    with db() as (conn, cur):
        toplam = kasa_bakiyesi(cur)
        tulipi = kasa_bakiyesi(cur, defter="TULIPI")
        mulk = kasa_bakiyesi(cur, defter="MULK")
        # Mülk çekmecesinin içi: neyin ne kadar olduğu
        cur.execute("""
            SELECT islem_turu, COALESCE(SUM(tutar),0)::float AS tutar, COUNT(*) AS adet
            FROM kasa_hareketleri
            WHERE kasa_etkisi=TRUE AND COALESCE(durum,'aktif')='aktif'
              AND COALESCE(defter,'TULIPI')='MULK'
            GROUP BY islem_turu ORDER BY 2 DESC
        """)
        kirilim = [dict(r) for r in (cur.fetchall() or [])]
        # Elde tutulan emanet (depozito) — gelir DEĞİL, yükümlülük
        cur.execute("""
            SELECT COALESCE(SUM(CASE WHEN tur='DEPOZITO_ALINDI' THEN tutar
                                     WHEN tur='DEPOZITO_IADE'   THEN tutar
                                     ELSE 0 END),0)::float AS emanet
            FROM mulk_hareket WHERE COALESCE(durum,'aktif')='aktif'
        """)
        emanet = float((cur.fetchone() or {}).get("emanet") or 0)

        # ── KİRA TAKİBİ (sahip 2026-09-11) ───────────────────────────
        # ⚠️ Hepsi SUNUCUDA toplanır. Ekran kendi aritmetiğini kurarsa iki
        # yerde iki rakam doğar ve bir gün ayrışır.
        #
        # BEKLENEN = aktif sözleşmelerin aylık kirası. İşyeri kiracıda stopaj
        # kaynağında kesilir ve sahibe NET ulaşır; brütü beklemek her ay
        # "eksik ödedi" sahte alarmı doğururdu.
        cur.execute("""
            SELECT COALESCE(SUM(
                       aylik_kira * (1 - COALESCE(stopaj_orani,0)/100.0)
                   ),0)::float AS beklenen,
                   COUNT(*) AS sozlesme
            FROM kira_sozlesme WHERE durum='aktif'
        """)
        _b = dict(cur.fetchone() or {})
        # TAHSİLAT / AKTARIM / GİDER — bu ay ve tüm zamanlar
        cur.execute("""
            SELECT
              COALESCE(SUM(tutar) FILTER (
                WHERE tur='KIRA_TAHSILAT'
                  AND to_char(tarih,'YYYY-MM') = to_char(CURRENT_DATE,'YYYY-MM')
              ),0)::float AS kira_ay,
              COALESCE(SUM(tutar) FILTER (WHERE tur='KIRA_TAHSILAT'),0)::float AS kira_tum,
              COALESCE(SUM(-tutar) FILTER (
                WHERE tur='MULK_AKTARIM_CIKIS'
                  AND to_char(tarih,'YYYY-MM') = to_char(CURRENT_DATE,'YYYY-MM')
              ),0)::float AS aktarim_ay,
              COALESCE(SUM(-tutar) FILTER (WHERE tur='MULK_AKTARIM_CIKIS'),0)::float AS aktarim_tum,
              COALESCE(SUM(-tutar) FILTER (
                WHERE tur='MULK_GIDER'
                  AND to_char(tarih,'YYYY-MM') = to_char(CURRENT_DATE,'YYYY-MM')
              ),0)::float AS gider_ay,
              COALESCE(SUM(-tutar) FILTER (WHERE tur='MULK_GIDER'),0)::float AS gider_tum,
              COALESCE(SUM(tutar) FILTER (WHERE tur='DEPOZITO_ALINDI'),0)::float AS dep_alinan,
              COALESCE(SUM(-tutar) FILTER (WHERE tur='DEPOZITO_IADE'),0)::float AS dep_iade
            FROM mulk_hareket WHERE COALESCE(durum,'aktif')='aktif'
        """)
        _h = dict(cur.fetchone() or {})

    _beklenen = round(float(_b.get("beklenen") or 0), 2)
    _kira_ay = round(float(_h.get("kira_ay") or 0), 2)
    return {
        "toplam": round(toplam, 2),
        "tulipi": round(tulipi, 2),
        "mulk": round(mulk, 2),
        "depozito_emanet": round(emanet, 2),
        "kirilim": kirilim,
        # ── Mülk alanının kendi göstergeleri ──────────────────────────
        "beklenen_aylik": _beklenen,
        "aktif_sozlesme": int(_b.get("sozlesme") or 0),
        "kira_bu_ay": _kira_ay,
        "kira_toplam": round(float(_h.get("kira_tum") or 0), 2),
        # ⚠️ EKSİK = beklenen − bu ay toplanan. NEGATİF olabilir (gecikmiş
        # borcunu bu ay ödeyen kiracı) — kırpılmaz, olduğu gibi gösterilir;
        # kırpılsaydı "fazla tahsilat" görünmez olurdu.
        "kira_eksik_bu_ay": round(_beklenen - _kira_ay, 2),
        "aktarim_bu_ay": round(float(_h.get("aktarim_ay") or 0), 2),
        "aktarim_toplam": round(float(_h.get("aktarim_tum") or 0), 2),
        "gider_bu_ay": round(float(_h.get("gider_ay") or 0), 2),
        "gider_toplam": round(float(_h.get("gider_tum") or 0), 2),
        "depozito_alinan": round(float(_h.get("dep_alinan") or 0), 2),
        "depozito_iade": round(float(_h.get("dep_iade") or 0), 2),
        "not": ("TOPLAM KASA = TULİPİ + MÜLK. Toplam, sistemin bugüne kadar "
                "gösterdiği rakamın aynısıdır; para yerinden oynamadı, yalnız "
                "hangi çekmeceye ait olduğu yazıldı. Depozito emanettir — "
                "mülk kasasının içindedir ama GELİR değildir."),
        "beklenen_not": ("Beklenen kira AKTİF SÖZLEŞMELERDEN toplanır. İşyeri "
                         "kiracıda stopaj kaynağında kesildiği için NET tutar "
                         "beklenir — brüt beklemek her ay sahte 'eksik ödedi' "
                         "alarmı doğururdu."),
    }


# ═══════════════════════════════════════════════════════════════════
# MÜLKLER
# ═══════════════════════════════════════════════════════════════════
class MulkBody(BaseModel):
    ad: Optional[str] = None        # boşsa "bina · birim"den kurulur
    bina: Optional[str] = None      # "Muhacır Pazarı"
    birim: Optional[str] = None     # "1. kat"
    adres: Optional[str] = None
    tur: Optional[str] = None
    simge: Optional[str] = None          # 🏠 🏢 🏬 … her mülkün kendi sembolü
    aylik_kira: Optional[float] = None
    notlar: Optional[str] = None


def _mulk_adi(b) -> str:
    """Görünen ad. Sahip ad yazmadıysa "bina · birim"den kurulur.

    ⚠️ `ad` yine de SAKLANIR (türetilmez): bina/birim sonradan düzeltilirse
    eski defter satırlarındaki isim kaymasın. Ad bir KİMLİKtir, formül değil.
    """
    a = (b.ad or "").strip()
    if a:
        return a
    parca = [x for x in [(b.bina or "").strip(), (b.birim or "").strip()] if x]
    return " · ".join(parca) or "Adsız mülk"


@router.get("")
def mulk_listele(hepsi: bool = False):
    with db() as (conn, cur):
        cur.execute("""
            SELECT m.*,
                   s.id           AS sozlesme_id,
                   s.aylik_kira::float AS sozlesme_kira,
                   s.baslangic::text   AS sozlesme_baslangic,
                   s.bitis::text       AS sozlesme_bitis,
                   k.ad           AS kiraci_ad,
                   k.id           AS kiraci_id
            FROM mulk m
            LEFT JOIN kira_sozlesme s
                   ON s.mulk_id = m.id AND s.durum = 'aktif'
            LEFT JOIN kiraci k ON k.id = s.kiraci_id
            WHERE (%s OR m.aktif = TRUE)
            ORDER BY m.ad
        """, (hepsi,))
        satirlar = [dict(r) for r in (cur.fetchall() or [])]
    dolu = sum(1 for r in satirlar if r.get("sozlesme_id"))
    # 🏢 BİNA ÖZETİ — sahip "Muhacır Pazarı'ndan bu ay ne geliyor?" diye sorar.
    # Gruplama sunucuda yapılır ki ekran ile rapor aynı cevabı versin.
    binalar: Dict[str, Dict[str, Any]] = {}
    for r in satirlar:
        b = (r.get("bina") or "").strip() or "—"
        g = binalar.setdefault(b, {"bina": b, "birim": 0, "dolu": 0, "aylik": 0.0})
        g["birim"] += 1
        if r.get("sozlesme_id"):
            g["dolu"] += 1
            g["aylik"] += float(r.get("sozlesme_kira") or 0)
    return {
        "mulkler": satirlar,
        "adet": len(satirlar),
        "dolu": dolu,
        "bos": len(satirlar) - dolu,
        "aylik_beklenen": round(sum(float(r.get("sozlesme_kira") or 0) for r in satirlar), 2),
        "binalar": sorted(({**v, "aylik": round(v["aylik"], 2)} for v in binalar.values()),
                          key=lambda x: -x["aylik"]),
    }


@router.post("")
def mulk_ekle(b: MulkBody):
    mid = str(uuid.uuid4())
    with db() as (conn, cur):
        cur.execute("""INSERT INTO mulk (id, ad, bina, birim, adres, tur, simge, aylik_kira, notlar)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (mid, _mulk_adi(b), b.bina, b.birim, b.adres, b.tur, b.simge,
                     b.aylik_kira, b.notlar))
    return {"id": mid, "islem": "eklendi"}


@router.put("/{mid}")
def mulk_guncelle(mid: str, b: MulkBody):
    with db() as (conn, cur):
        cur.execute("""UPDATE mulk SET ad=%s, bina=%s, birim=%s, adres=%s, tur=%s,
                              simge=%s, aylik_kira=%s, notlar=%s
                       WHERE id=%s""",
                    (_mulk_adi(b), b.bina, b.birim, b.adres, b.tur, b.simge,
                     b.aylik_kira, b.notlar, mid))
        if cur.rowcount == 0:
            raise HTTPException(404, "Mülk bulunamadı")
    return {"islem": "guncellendi"}


@router.delete("/{mid}")
def mulk_kapat(mid: str):
    """Mülk SİLİNMEZ, kapatılır — defterdeki geçmişi kaybolmamalı."""
    with db() as (conn, cur):
        cur.execute("UPDATE mulk SET aktif=FALSE WHERE id=%s", (mid,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Mülk bulunamadı")
    return {"islem": "kapatildi"}


# ═══════════════════════════════════════════════════════════════════
# KİRACILAR
# ═══════════════════════════════════════════════════════════════════
class KiraciBody(BaseModel):
    ad: str
    telefon: Optional[str] = None
    notlar: Optional[str] = None


@router.get("/kiraci")
def kiraci_listele(hepsi: bool = False):
    with db() as (conn, cur):
        cur.execute("""
            SELECT k.*,
                   (SELECT COUNT(*) FROM kira_sozlesme s
                     WHERE s.kiraci_id=k.id AND s.durum='aktif') AS aktif_sozlesme,
                   (SELECT string_agg(t.takma_ad, ' · ') FROM kiraci_takma_ad t
                     WHERE t.kiraci_id=k.id) AS takma_adlar
            FROM kiraci k
            WHERE (%s OR k.aktif = TRUE)
            ORDER BY k.ad
        """, (hepsi,))
        return {"kiracilar": [dict(r) for r in (cur.fetchall() or [])]}


@router.post("/kiraci")
def kiraci_ekle(b: KiraciBody):
    kid = str(uuid.uuid4())
    with db() as (conn, cur):
        cur.execute("INSERT INTO kiraci (id, ad, telefon, notlar) VALUES (%s,%s,%s,%s)",
                    (kid, b.ad.strip(), b.telefon, b.notlar))
        # Kendi adı da bir takma addır — ekstre eşleşmesi ilk günden çalışsın.
        cur.execute("""INSERT INTO kiraci_takma_ad (takma_ad, kiraci_id, kaynak)
                       VALUES (%s,%s,'elle') ON CONFLICT (takma_ad) DO NOTHING""",
                    (ad_anahtari(b.ad), kid))
    return {"id": kid, "islem": "eklendi"}


@router.put("/kiraci/{kid}")
def kiraci_guncelle(kid: str, b: KiraciBody):
    with db() as (conn, cur):
        cur.execute("UPDATE kiraci SET ad=%s, telefon=%s, notlar=%s WHERE id=%s",
                    (b.ad.strip(), b.telefon, b.notlar, kid))
        if cur.rowcount == 0:
            raise HTTPException(404, "Kiracı bulunamadı")
    return {"islem": "guncellendi"}


@router.delete("/kiraci/{kid}")
def kiraci_kapat(kid: str):
    with db() as (conn, cur):
        cur.execute("UPDATE kiraci SET aktif=FALSE WHERE id=%s", (kid,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Kiracı bulunamadı")
    return {"islem": "kapatildi"}


# ═══════════════════════════════════════════════════════════════════
# SÖZLEŞMELER
# ═══════════════════════════════════════════════════════════════════
class SozlesmeBody(BaseModel):
    # ⚠️ `depozito` sözleşmede YAZAN tutardır. `depozito_alindi` ise parayı
    # FİİLEN alıp almadığınızı söyler — ikisi ayrı sorudur. Geçmişe dönük bir
    # sözleşme girilirken depozito kâğıtta vardır ama kasaya BUGÜN girmez.
    depozito_alindi: bool = False
    mulk_id: str
    kiraci_id: str
    baslangic: date
    bitis: Optional[date] = None
    aylik_kira: float
    depozito: float = 0
    odeme_gunu: int = 1
    kiraci_tipi: str = "sahis"      # sahis | isyeri
    stopaj_orani: float = 0         # işyeri: 20
    notlar: Optional[str] = None


@router.get("/sozlesme")
def sozlesme_listele(durum: str = None):
    kos, par = "", []
    if durum:
        kos = " AND s.durum = %s"
        par = [durum]
    with db() as (conn, cur):
        cur.execute(f"""
            SELECT s.*, s.aylik_kira::float AS aylik_kira,
                   s.depozito::float AS depozito, s.stopaj_orani::float AS stopaj_orani,
                   s.baslangic::text AS baslangic, s.bitis::text AS bitis,
                   m.ad AS mulk_ad, k.ad AS kiraci_ad
            FROM kira_sozlesme s
            JOIN mulk m ON m.id = s.mulk_id
            JOIN kiraci k ON k.id = s.kiraci_id
            WHERE TRUE{kos}
            ORDER BY s.durum, s.baslangic DESC
        """, par)
        return {"sozlesmeler": [dict(r) for r in (cur.fetchall() or [])]}


@router.post("/sozlesme")
def sozlesme_ekle(b: SozlesmeBody):
    """⚠️ KİRA ARTIŞI = YENİ SÖZLEŞME. Eskisini 'bitti' yap, yenisini aç.
    Ayrı bir 'kira dönemi' tablosu açılmadı: sözleşme yenilemesi zaten yeni
    sözleşmedir ve beklenen kira, ayın düştüğü sözleşmeden okunur."""
    if b.aylik_kira <= 0:
        raise HTTPException(400, "Aylık kira pozitif olmalı")
    sid = str(uuid.uuid4())
    with db() as (conn, cur):
        cur.execute("""INSERT INTO kira_sozlesme
            (id, mulk_id, kiraci_id, baslangic, bitis, aylik_kira, depozito,
             odeme_gunu, kiraci_tipi, stopaj_orani, notlar)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (sid, b.mulk_id, b.kiraci_id, b.baslangic, b.bitis, b.aylik_kira,
                     b.depozito, b.odeme_gunu, b.kiraci_tipi, b.stopaj_orani, b.notlar))
        # 🔴 2026-09-11: burada depozito hareketi HİÇ yazılmıyordu. Sözleşmede
        # "depozito 35.000" yazıyor, kasada hiçbir iz yok — "Depozito Emaneti"
        # çekmecesi bu çelişkiyi gösteriyordu ama kaynağı açık kalmıştı.
        # Artık AÇIK SORU: parayı aldıysanız işaretlersiniz, kasaya girer.
        dep = None
        if b.depozito_alindi and float(b.depozito or 0) > 0:
            dep = _mulk_yaz(cur, "DEPOZITO_ALINDI", b.baslangic, abs(float(b.depozito)),
                            "Sözleşme depozitosu", sozlesme_id=sid,
                            mulk_id=b.mulk_id, kiraci_id=b.kiraci_id)
    return {
        "id": sid, "islem": "eklendi", "depozito_hareketi": dep,
        "not": (None if (dep or not float(b.depozito or 0))
                else "Depozito sözleşmeye yazıldı ama KASAYA GİRMEDİ — parayı "
                     "aldıysanız 'depozito alındı' işaretiyle kaydedin."),
    }


@router.post("/sozlesme/{sid}/bitir")
def sozlesme_bitir(sid: str, bitis: str = Query(None)):
    with db() as (conn, cur):
        cur.execute("UPDATE kira_sozlesme SET durum='bitti', bitis=COALESCE(%s::date, CURRENT_DATE) "
                    "WHERE id=%s", (bitis, sid))
        if cur.rowcount == 0:
            raise HTTPException(404, "Sözleşme bulunamadı")
    return {"islem": "bitirildi"}


# ═══════════════════════════════════════════════════════════════════
# TAHSİLAT & GECİKME — "bu ay kim ödemedi?"
# ═══════════════════════════════════════════════════════════════════
def _tahsilat_hesapla(cur, bugun):
    """Aktif sözleşmelerin tahsilat tablosu — TEK HESAP.

    ⚠️ Hem `/tahsilat` hem `/uyarilar` BU fonksiyonu okur. İki yerde ayrı
    hesaplansaydı bir gün ayrışır ve ekran "borçlu" derken uyarı susardı
    (ya da tersi) — bu sistemdeki hataların en sık kalıbı.

    ⚠️ Beklenen satırlar SAKLANMAZ, burada türetilir. Yaşanmamış ay hiçbir
    zaman borç sayılmaz: sayaç sözleşme başlangıcından BUGÜNÜN AYINA kadar.
    """
    if True:
        cur.execute("""
            SELECT s.id, s.baslangic, s.bitis, s.aylik_kira::float AS aylik_kira,
                   s.odeme_gunu, s.durum, s.kiraci_tipi, s.stopaj_orani::float AS stopaj_orani,
                   m.ad AS mulk_ad, m.id AS mulk_id,
                   k.ad AS kiraci_ad, k.id AS kiraci_id, k.telefon
            FROM kira_sozlesme s
            JOIN mulk m ON m.id = s.mulk_id
            JOIN kiraci k ON k.id = s.kiraci_id
            WHERE s.durum = 'aktif'
            ORDER BY m.ad
        """)
        sozlesmeler = [dict(r) for r in (cur.fetchall() or [])]

        cur.execute("""
            SELECT sozlesme_id, COALESCE(SUM(tutar),0)::float AS tahsil
            FROM mulk_hareket
            WHERE tur='KIRA_TAHSILAT' AND COALESCE(durum,'aktif')='aktif'
              AND sozlesme_id IS NOT NULL
            GROUP BY sozlesme_id
        """)
        tahsil = {r["sozlesme_id"]: float(r["tahsil"]) for r in (cur.fetchall() or [])}
        # Ay ay dağılım için TEK TEK tahsilatlar (tarih sırası — FIFO çıpası)
        cur.execute("""
            SELECT id, sozlesme_id, tarih::text AS tarih, tutar::float AS tutar,
                   donem, aciklama
            FROM mulk_hareket
            WHERE tur='KIRA_TAHSILAT' AND COALESCE(durum,'aktif')='aktif'
              AND sozlesme_id IS NOT NULL
            ORDER BY tarih, olusturma
        """)
        _hareketler: Dict[str, List[Dict[str, Any]]] = {}
        for r in (cur.fetchall() or []):
            _hareketler.setdefault(r["sozlesme_id"], []).append(dict(r))

    satirlar = []
    for s in sozlesmeler:
        bas = s["baslangic"]
        son = s["bitis"] or bugun
        if son > bugun:
            son = bugun
        # Kaç ay yaşandı? (başlangıç ayı dahil, bugünün ayı dahil)
        ay_sayisi = max(0, (son.year * 12 + son.month) - (bas.year * 12 + bas.month) + 1)
        beklenen = round(ay_sayisi * float(s["aylik_kira"]), 2)
        # İşyeri kiracı stopajı kaynağında keser → sahibe NET ulaşır.
        if str(s.get("kiraci_tipi")) == "isyeri" and float(s.get("stopaj_orani") or 0) > 0:
            beklenen = round(beklenen * (1 - float(s["stopaj_orani"]) / 100.0), 2)
        alinan = round(tahsil.get(s["id"], 0.0), 2)
        bakiye = round(beklenen - alinan, 2)
        ay_kira = float(s["aylik_kira"])
        gecikme_ay = int(bakiye // ay_kira) if ay_kira > 0 and bakiye > 0 else 0

        # 📅 AY AY DAĞILIM — "3 ay geride" iddiasının KANITI.
        # 🔴 NEDEN: sahip 2026-09-09 "bence de görünmeli". Bir rakama bakıp
        # "bu nereden çıktı" diyememek bordroda DÖRT AY fark edilmeyen bir
        # eksik hesaba yol açmıştı ([[project-bordro-v2-kesim]]).
        #
        # FIFO: tahsilatlar tarih sırasıyla en ESKİ açık aya yazılır. Hangi ayı
        # kapattığı SAKLANMAZ, okuma anında bulunur (BAĞLAMA ≠ KAPATMA) — böylece
        # 3 aylık toplu ödeme, kısmi ödeme ve peşin ödeme aynı kuraldan çıkar.
        # `donem` alanı varsa yalnızca İPUCU olarak gösterilir, tahsisi değiştirmez.
        _bek_ay = beklenen / ay_sayisi if ay_sayisi else 0.0
        _kalan = list(_hareketler.get(s["id"], []))
        _kuyruk = [{"id": h["id"], "tarih": h["tarih"], "kalan": float(h["tutar"]),
                    "donem": h.get("donem")} for h in _kalan]
        aylar = []
        _yi, _ai = bas.year, bas.month
        for _n in range(ay_sayisi):
            _don = "%04d-%02d" % (_yi, _ai)
            _ihtiyac = round(_bek_ay, 2)
            _kapatan = []
            for h in _kuyruk:
                if _ihtiyac <= 0.005 or h["kalan"] <= 0.005:
                    continue
                _al = min(h["kalan"], _ihtiyac)
                h["kalan"] = round(h["kalan"] - _al, 2)
                _ihtiyac = round(_ihtiyac - _al, 2)
                _kapatan.append({"hareket_id": h["id"], "tarih": h["tarih"],
                                 "tutar": round(_al, 2), "donem_ipucu": h["donem"]})
            # ⏰ ÖDEME GÜNÜ GEÇTİ Mİ? Ayın 5'i ödeme günüyse ve bugün 3'ü ise
            # BU AY HENÜZ GECİKMİŞ DEĞİLDİR — "bekleniyor"dur. Bu ayrım
            # olmasaydı her ayın 1'inde tüm kiracılar borçlu görünürdü ve
            # uyarı hiçbir şey anlatmaz olurdu (alarm yorgunluğu).
            _vade = _dt.date(_yi, _ai, min(int(s["odeme_gunu"] or 1), 28))
            _gecti = _vade < bugun
            _acik_mi = _ihtiyac > 0.005
            aylar.append({
                "donem": _don, "beklenen": round(_bek_ay, 2),
                "kapanan": round(_bek_ay - _ihtiyac, 2), "acik": round(_ihtiyac, 2),
                "durum": ("kapandi" if not _acik_mi
                          else "kismi" if _kapatan else "acik"),
                # gecikti → vadesi geçti ve hâlâ açık
                # bekleniyor → vadesi gelmedi, açık olması NORMAL
                "vade": _vade.isoformat(),
                "vade_gecti": bool(_gecti),
                "uyari": ("gecikti" if (_acik_mi and _gecti)
                          else "bekleniyor" if _acik_mi else None),
                "kapatan": _kapatan,
            })
            _yi, _ai = _ay_ekle(_yi, _ai, 1)
        _fazla = round(sum(h["kalan"] for h in _kuyruk), 2)
        satirlar.append({
            "sozlesme_id": s["id"], "mulk_id": s["mulk_id"], "mulk_ad": s["mulk_ad"],
            "kiraci_id": s["kiraci_id"], "kiraci_ad": s["kiraci_ad"],
            "telefon": s.get("telefon"),
            "aylik_kira": ay_kira, "odeme_gunu": s["odeme_gunu"],
            "baslangic": str(bas), "ay_sayisi": ay_sayisi,
            "beklenen": beklenen, "alinan": alinan, "bakiye": bakiye,
            "gecikme_ay": gecikme_ay,
            "kiraci_tipi": s.get("kiraci_tipi"),
            "stopaj_orani": float(s.get("stopaj_orani") or 0),
            "durum": ("borclu" if bakiye > 0.5 else
                      "pesin" if bakiye < -0.5 else "guncel"),
            "aylar": aylar,
            # Aylara dağıtıldıktan sonra ARTAN para = peşin ödenmiş kısım.
            "pesin_tutar": _fazla,
            "acik_ay": sum(1 for a in aylar if a["durum"] != "kapandi"),
        })
    satirlar.sort(key=lambda r: -r["bakiye"])
    return satirlar


@router.get("/tahsilat")
def tahsilat_durum(donem: str = None):
    """Her aktif sözleşme için: bugüne kadar beklenen − tahsil edilen."""
    from tr_saat import bugun_tr
    bugun = bugun_tr()
    with db() as (conn, cur):
        satirlar = _tahsilat_hesapla(cur, bugun)
    return {
        "donem": donem or bugun.strftime("%Y-%m"),
        "satirlar": satirlar,
        "toplam_beklenen": round(sum(r["beklenen"] for r in satirlar), 2),
        "toplam_alinan": round(sum(r["alinan"] for r in satirlar), 2),
        "toplam_bakiye": round(sum(r["bakiye"] for r in satirlar), 2),
        "borclu_adet": sum(1 for r in satirlar if r["durum"] == "borclu"),
        "not": ("Beklenen kira hiçbir yere yazılmaz, sözleşme başlangıcından "
                "bu aya kadar HESAPLANIR. Kısmi ödeme, gecikmiş toplu ödeme ve "
                "peşin ödeme aynı formülden çıkar: eksi bakiye = peşin ödemiş. "
                "İşyeri kiracıda stopaj düşülmüş NET beklenir."),
    }


# ═══════════════════════════════════════════════════════════════════
# PARA YAZMA — tahsilat · gider · depozito · aktarım
# ═══════════════════════════════════════════════════════════════════
def _mulk_yaz(cur, tur: str, tarih, tutar: float, aciklama: str,
              sozlesme_id=None, mulk_id=None, kiraci_id=None, donem=None,
              odeme_yontemi=None, kaynak_kasa_id=None) -> Dict[str, str]:
    """Mülk hareketi + karşılığı kasa satırı. İkisi `kasa_hareket_id` ile bağlı.

    ⚠️ `defter` BURADA VERİLMEZ — `kasa_service.defter_turet` türden çıkarır.
    Elle verilseydi bir çağıran unutur ve kira satırı kahve çekmecesine düşerdi.
    """
    hid = str(uuid.uuid4())
    insert_kasa_hareketi(cur, tarih, tur, tutar, aciklama,
                         "mulk_hareket", hid, odeme_yontemi=odeme_yontemi)
    cur.execute("""SELECT id FROM kasa_hareketleri
                   WHERE kaynak_tablo='mulk_hareket' AND kaynak_id=%s
                   ORDER BY olusturma DESC LIMIT 1""", (hid,))
    _k = cur.fetchone()
    cur.execute("""INSERT INTO mulk_hareket
        (id, tarih, tur, sozlesme_id, mulk_id, kiraci_id, donem, tutar,
         aciklama, kasa_hareket_id, kaynak_kasa_id)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (hid, tarih, tur, sozlesme_id, mulk_id, kiraci_id, donem,
                 tutar, aciklama, (_k or {}).get("id"), kaynak_kasa_id))
    return {"id": hid, "kasa_hareket_id": (_k or {}).get("id")}


class TahsilatBody(BaseModel):
    sozlesme_id: str
    tarih: date
    tutar: float
    donem: Optional[str] = None          # 'YYYY-MM' — İPUCU, kural değil
    odeme_yontemi: Optional[str] = None  # 'havale' | 'elden'
    aciklama: Optional[str] = None
    tulipiye_aktar: bool = False         # para dükkâna girdiyse TRUE


@router.post("/tahsilat")
def tahsilat_yaz(b: TahsilatBody):
    if b.tutar <= 0:
        raise HTTPException(400, "Tutar pozitif olmalı")
    with db() as (conn, cur):
        cur.execute("""SELECT s.id, s.mulk_id, s.kiraci_id, m.ad AS mulk_ad, k.ad AS kiraci_ad
                       FROM kira_sozlesme s JOIN mulk m ON m.id=s.mulk_id
                       JOIN kiraci k ON k.id=s.kiraci_id WHERE s.id=%s""", (b.sozlesme_id,))
        s = cur.fetchone()
        if not s:
            raise HTTPException(404, "Sözleşme bulunamadı")
        ack = b.aciklama or f"{s['kiraci_ad']} — {s['mulk_ad']} kira"
        r = _mulk_yaz(cur, "KIRA_TAHSILAT", b.tarih, b.tutar, ack,
                      sozlesme_id=s["id"], mulk_id=s["mulk_id"], kiraci_id=s["kiraci_id"],
                      donem=b.donem, odeme_yontemi=b.odeme_yontemi)
        aktarim = None
        if b.tulipiye_aktar:
            aktarim = _aktarim_yaz(cur, b.tarih, b.tutar,
                                   f"Mülk → TULİPİ ({s['kiraci_ad']} kira)")
    return {"islem": "yazildi", **r, "aktarim": aktarim}


class GiderBody(BaseModel):
    tarih: date
    tutar: float                 # pozitif gir, eksi yazılır
    aciklama: str
    mulk_id: Optional[str] = None
    odeme_yontemi: Optional[str] = None


@router.post("/gider")
def gider_yaz(b: GiderBody):
    """Aidat · site faturası · emlak vergisi · tadilat.

    ⚠️ `sabit_giderler` tablosuna YAZILMAZ: o tablo `gider_kanonik` üzerinden
    TULİPİ'nin P&L'ine akar ve mülk gideri kahve maliyetine sızardı.
    """
    if b.tutar <= 0:
        raise HTTPException(400, "Tutar pozitif girilmeli (eksi olarak yazılır)")
    with db() as (conn, cur):
        r = _mulk_yaz(cur, "MULK_GIDER", b.tarih, -abs(b.tutar), b.aciklama,
                      mulk_id=b.mulk_id, odeme_yontemi=b.odeme_yontemi)
    return {"islem": "yazildi", **r}


class DepozitoBody(BaseModel):
    sozlesme_id: str
    tarih: date
    tutar: float
    iade: bool = False
    aciklama: Optional[str] = None


@router.post("/depozito")
def depozito_yaz(b: DepozitoBody):
    """⚠️ Depozito GELİR DEĞİLDİR — iade edilecek emanettir. Kasa etkisi VARDIR
    (para fiziken elde), ama kira geliri toplamına girmez."""
    if b.tutar <= 0:
        raise HTTPException(400, "Tutar pozitif olmalı")
    with db() as (conn, cur):
        cur.execute("""SELECT s.id, s.mulk_id, s.kiraci_id, k.ad AS kiraci_ad
                       FROM kira_sozlesme s JOIN kiraci k ON k.id=s.kiraci_id
                       WHERE s.id=%s""", (b.sozlesme_id,))
        s = cur.fetchone()
        if not s:
            raise HTTPException(404, "Sözleşme bulunamadı")
        tur = "DEPOZITO_IADE" if b.iade else "DEPOZITO_ALINDI"
        tutar = -abs(b.tutar) if b.iade else abs(b.tutar)
        ack = b.aciklama or f"{s['kiraci_ad']} depozito {'iadesi' if b.iade else ''}".strip()
        r = _mulk_yaz(cur, tur, b.tarih, tutar, ack,
                      sozlesme_id=s["id"], mulk_id=s["mulk_id"], kiraci_id=s["kiraci_id"])
    return {"islem": "yazildi", **r}


def _aktarim_yaz(cur, tarih, tutar: float, aciklama: str) -> Dict[str, Any]:
    """MÜLK → TULİPİ. ÇİFT KAYIT: MULK −X, TULIPI +X. TOPLAM KASA DEĞİŞMEZ.

    Emsali sistemde var: KASA_TESLIM_CIKIS/GIRIS ve SUBE_BORC_* aynı desen.
    """
    cikis = _mulk_yaz(cur, "MULK_AKTARIM_CIKIS", tarih, -abs(tutar), aciklama)
    # 🔴 2026-09-11 DÜZELTME: giriş satırı önceden RASTGELE bir "grup" kimliğine
    # bağlanıyordu ve o kimlik HİÇBİR YERDE SAKLANMIYORDU → çiftin varış ucu
    # sonradan bulunamıyordu. İptal edilmek istendiğinde yalnız çıkış ucu
    # kapanır, giriş ucu TULİPİ kasasında AKTİF kalırdı: toplam kasa
    # aktarım tutarı kadar ŞİŞERDİ.
    # Artık iki uç da AYNI kaynak_id'yi (çıkış hareketinin kimliği) taşır;
    # `islem_turu` ikisini ayırır, `iptal_kasa_hareketi` her birini kendi
    # türüyle bulur.
    insert_kasa_hareketi(cur, tarih, "MULK_AKTARIM_GIRIS", abs(tutar), aciklama,
                         "mulk_hareket", cikis["id"])
    return {"cikis": cikis["id"], "tutar": abs(tutar)}


class AktarimBody(BaseModel):
    tarih: date
    tutar: float
    aciklama: Optional[str] = None


@router.post("/aktarim")
def aktarim_yaz(b: AktarimBody):
    if b.tutar <= 0:
        raise HTTPException(400, "Tutar pozitif olmalı")
    with db() as (conn, cur):
        r = _aktarim_yaz(cur, b.tarih, b.tutar, b.aciklama or "Mülk → TULİPİ aktarım")
    return {"islem": "yazildi", **r}


# ═══════════════════════════════════════════════════════════════════
# DEFTER — tüm hareketler + kasa izi
# ═══════════════════════════════════════════════════════════════════
@router.get("/defter")
def mulk_defteri(ay: str = None, kiraci_id: str = None, sozlesme_id: str = None,
                 mulk_id: str = None, tur: str = None, limit: int = 300):
    """Mülk defteri. Filtreler EKLEMELİ — hiçbiri verilmezse davranış eskisi.

    ⚠️ `tur` virgülle çoklu alır ('DEPOZITO_ALINDI,DEPOZITO_IADE'). Çekmeceler
    aynı ucu farklı süzgeçlerle okur; süzmek aritmetik DEĞİLDİR — ekran kendi
    rakamını üretmez, sunucunun satırlarını daraltır.
    """
    kos, par = "", []
    if ay and re.match(r"^\d{4}-\d{2}$", ay):
        kos += " AND to_char(h.tarih,'YYYY-MM') = %s"
        par.append(ay)
    if kiraci_id:
        kos += " AND h.kiraci_id = %s"
        par.append(kiraci_id)
    if sozlesme_id:
        kos += " AND h.sozlesme_id = %s"
        par.append(sozlesme_id)
    if mulk_id:
        kos += " AND h.mulk_id = %s"
        par.append(mulk_id)
    if tur:
        _t = [x.strip() for x in str(tur).split(",") if x.strip()]
        if _t:
            kos += " AND h.tur = ANY(%s)"
            par.append(_t)
    with db() as (conn, cur):
        cur.execute(f"""
            SELECT h.*, h.tarih::text AS tarih, h.tutar::float AS tutar,
                   m.ad AS mulk_ad, m.simge AS mulk_simge, k.ad AS kiraci_ad,
                   kh.id AS kasa_iz, kh.islem_turu AS kasa_turu,
                   COALESCE(kh.defter,'TULIPI') AS kasa_defter,
                   kh.odeme_yontemi, kh.kasa_etkisi
            FROM mulk_hareket h
            LEFT JOIN mulk m ON m.id = h.mulk_id
            LEFT JOIN kiraci k ON k.id = h.kiraci_id
            LEFT JOIN kasa_hareketleri kh ON kh.id = h.kasa_hareket_id
            WHERE COALESCE(h.durum,'aktif')='aktif'{kos}
            ORDER BY h.tarih DESC, h.olusturma DESC
            LIMIT %s
        """, par + [max(1, min(1000, limit))])
        satirlar = [dict(r) for r in (cur.fetchall() or [])]
    _lim = max(1, min(1000, limit))
    return {
        "satirlar": satirlar,
        "adet": len(satirlar),
        "toplam": round(sum(float(r["tutar"]) for r in satirlar), 2),
        # ⚠️ SESSİZ ELEME YASAK: liste tavana dayandıysa söylenir.
        "kesildi": len(satirlar) >= _lim,
        "izsiz": sum(1 for r in satirlar if not r.get("kasa_iz")),
        "not": ("Her satırın kasa izi vardır (kasa_iz). İz yoksa o satır "
                "kasaya yansımamış demektir — sessiz geçilmez, görünür olur."),
    }


# Her mülk hareketi türünün kasa ters-kayıt türü. TEK YER.
# ⚠️ Aktarım ÇİFTTİR: çıkış iptal edilirken GİRİŞ ucu da kapanmalı, yoksa
# TULİPİ kasasında karşılıksız para kalır ve TOPLAM KASA ŞİŞER.
_IPTAL_TURU = {
    "KIRA_TAHSILAT": ["KIRA_TAHSILAT_IPTAL"],
    "MULK_GIDER": ["MULK_GIDER_IPTAL"],
    "DEPOZITO_ALINDI": ["DEPOZITO_ALINDI_IPTAL"],
    "DEPOZITO_IADE": ["DEPOZITO_IADE_IPTAL"],
    "VARLIK_SATISI": ["VARLIK_SATISI_IPTAL"],
    "MULK_AKTARIM_CIKIS": ["MULK_AKTARIM_CIKIS_IPTAL", "MULK_AKTARIM_GIRIS_IPTAL"],
}
# Ters kaydı hangi kasa türünden arayacağız (çift uçta ikisi ayrı satır).
_IPTAL_KAYNAK = {
    "MULK_AKTARIM_CIKIS_IPTAL": "MULK_AKTARIM_CIKIS",
    "MULK_AKTARIM_GIRIS_IPTAL": "MULK_AKTARIM_GIRIS",
}


@router.delete("/hareket/{hid}")
def hareket_iptal(hid: str):
    """Satır SİLİNMEZ, iptal edilir; kasa karşılığı da ters kayıtla kapanır.

    🔴 HATA YUTULMAZ (2026-09-11). Önceki sürüm kasa iptali patlarsa yalnız
    uyarı logluyor ve mülk hareketini YİNE DE 'iptal' işaretliyordu. Sonuç:
    defterde satır iptal görünür, kasada para DURUR — iki defter sessizce
    ayrışır ve kimse fark etmez. Artık kasa kapanmazsa İŞLEM DE OLMAZ.

    ⚠️ Göçten gelen aynalar (kaynak_kasa_id dolu): bunların TULİPİ ucu eski
    DIS_KAYNAK satırıdır ve ona DOKUNULMAZ. İptal yalnız mülk tarafını geri
    alır; toplam kasa yine değişmez çünkü mülk tarafı zaten net sıfırdır.
    """
    from kasa_service import iptal_kasa_hareketi
    with db() as (conn, cur):
        cur.execute("SELECT * FROM mulk_hareket WHERE id=%s", (hid,))
        h = cur.fetchone()
        if not h:
            raise HTTPException(404, "Hareket bulunamadı")
        if str(h.get("durum") or "aktif") != "aktif":
            return {"islem": "zaten_iptal"}
        tur = str(h["tur"])
        turler = _IPTAL_TURU.get(tur)
        if not turler:
            raise HTTPException(400, f"'{tur}' türü için iptal tanımlı değil")

        kapanan = []
        for it in turler:
            kaynak_turu = _IPTAL_KAYNAK.get(it, tur)
            try:
                iptal_kasa_hareketi(cur, hid, "mulk_hareket", kaynak_turu, it,
                                    f"{TUR_ADI.get(tur, tur)} iptali")
                kapanan.append(it)
            except Exception as e:
                # Çift uçlu aktarımın GİRİŞ ucu eski kayıtlarda bulunamayabilir
                # (2026-09-11 öncesi rastgele gruba bağlanmıştı). Bunu SESSİZ
                # geçmek yerine 409 ile söylüyoruz: yanlış iptal, kasayı şişirir.
                raise HTTPException(409,
                    f"Kasa ters kaydı yazılamadı ({kaynak_turu} → {it}): {e}. "
                    "Hareket İPTAL EDİLMEDİ — iki defter ayrışmasın diye işlem "
                    "geri alındı.")

        cur.execute("UPDATE mulk_hareket SET durum='iptal' WHERE id=%s", (hid,))
    return {"islem": "iptal", "kapanan_kasa_kaydi": kapanan}


# ═══════════════════════════════════════════════════════════════════
# GÖÇ ADAYLARI — mevcut DIS_KAYNAK kayıtlarından kira çıkarma (KURU)
# ═══════════════════════════════════════════════════════════════════
@router.get("/goc-adaylari")
def goc_adaylari():
    """🧪 KURU ÇALIŞTIRMA — hiçbir şey yazmaz, yalnız gösterir.

    Canlıdaki `DIS_KAYNAK` kayıtlarından kira olanları ayıklar ve yazım
    farklarına göre kiracı KÜMELERİ önerir. Sahip kümeleri onaylayınca göç
    yazılır; onaylamadan hiçbir para satırı doğmaz
    ([[feedback-kuru-calistirma-kapisi]]).
    """
    with db() as (conn, cur):
        cur.execute("""
            SELECT id, tarih::text AS tarih, tutar::float AS tutar, aciklama
            FROM kasa_hareketleri
            WHERE islem_turu='DIS_KAYNAK' AND COALESCE(durum,'aktif')='aktif'
            ORDER BY tarih DESC
        """)
        satirlar = [dict(r) for r in (cur.fetchall() or [])]

    kira, depozito, gider, varlik, disi = [], [], [], [], []
    for r in satirlar:
        a = tr_kucuk(r.get("aciklama"))
        if "ev sat" in a or "satış fiyat" in a or "satis fiyat" in a:
            varlik.append(r)
        elif "depozit" in a:
            depozito.append(r)
        elif "aidat" in a or "merdiven" in a or "site fatura" in a:
            gider.append(r)
        elif "kira" in a:
            kira.append(r)
        else:
            disi.append(r)

    # Kiracı kümeleri — ad anahtarına göre
    kume: Dict[str, Dict[str, Any]] = {}
    for r in kira:
        ad = kiraci_adi_ayikla((r.get("aciklama") or "").split(":", 1)[-1])
        anahtar = ad_anahtari(ad)
        if not anahtar:
            anahtar = "(adsız)"
        k = kume.setdefault(anahtar, {"onerilen_ad": ad.strip().title() or "(adsız)",
                                      "yazimlar": set(), "adet": 0, "toplam": 0.0,
                                      "aylar": set(), "kayit_id": [], "satirlar": []})
        k["yazimlar"].add(ad.strip())
        k["adet"] += 1
        k["toplam"] += float(r["tutar"])
        k["aylar"].add(r["tarih"][:7])
        k["kayit_id"].append(r["id"])
        # ⚠️ HAM KAYIT DA GÖRÜNSÜN: sahip 46 kaydı körlemesine birleştirmesin.
        # Para değiştiren toplu işlemin LİSTESİ okunur
        # ([[feedback-kuru-calistirma-kapisi]]).
        k["satirlar"].append({"id": r["id"], "tarih": r["tarih"],
                              "tutar": r["tutar"], "aciklama": r["aciklama"]})

    kumeler = sorted(
        ({"anahtar": a, "onerilen_ad": v["onerilen_ad"],
          "yazimlar": sorted(v["yazimlar"]), "yazim_adedi": len(v["yazimlar"]),
          "adet": v["adet"], "toplam": round(v["toplam"], 2),
          "aylar": sorted(v["aylar"]), "kayit_id": v["kayit_id"],
          "satirlar": sorted(v["satirlar"], key=lambda r: r["tarih"])}
         for a, v in kume.items()),
        key=lambda r: -r["toplam"])

    # 🔗 BİRLEŞTİRME ÖNERİLERİ — ÖNERİ-ONLY, hiçbir küme kendiliğinden birleşmez.
    # "hamayoun / hamayoğun / hamoayoun faizi" gibi yazım farkları harf
    # normalizasyonuyla yakalanmıyor (fazladan harf, yer değiştirme). Benzerlik
    # ölçüsü ADAY üretir; kararı sahip verir.
    # ⚠️ BİLEREK OTOMATİK DEĞİL: "Mehmet Turan" ile "Mustafa Haluk Turan"
    # %70 benzer ama BAŞKA İNSAN olabilir. Yanlış birleştirme iki kiracının
    # borcunu tek kişide toplar ve biri "ödemiş" görünür.
    import difflib as _dl
    oneriler = []
    for i in range(len(kumeler)):
        for j in range(i + 1, len(kumeler)):
            a1, a2 = kumeler[i]["anahtar"], kumeler[j]["anahtar"]
            if not a1 or not a2 or "adsız" in (a1 + a2):
                continue
            oran = _dl.SequenceMatcher(None, a1, a2).ratio()
            # Bir taraf diğerinin içinde geçiyorsa (ad kısaltması) güçlü aday
            _ic = a1 in a2 or a2 in a1
            if oran >= 0.80 or _ic:
                oneriler.append({
                    "a": kumeler[i]["onerilen_ad"], "b": kumeler[j]["onerilen_ad"],
                    "a_anahtar": a1, "b_anahtar": a2,
                    "benzerlik": round(oran, 3),
                    "gerekce": "biri diğerini içeriyor" if _ic else "yazım benzerliği",
                    "toplam": round(kumeler[i]["toplam"] + kumeler[j]["toplam"], 2),
                })
    oneriler.sort(key=lambda r: -r["benzerlik"])

    # Küme zaten bir kiracıya bağlandı mı? Sahip aynı işi iki kez yapmasın.
    with db() as (conn, cur):
        cur.execute("""SELECT t.takma_ad, t.kiraci_id, k.ad
                       FROM kiraci_takma_ad t JOIN kiraci k ON k.id = t.kiraci_id""")
        _bagli = {r["takma_ad"]: {"kiraci_id": r["kiraci_id"], "ad": r["ad"]}
                  for r in (cur.fetchall() or [])}
    for k in kumeler:
        _e = _bagli.get(k["anahtar"])
        k["eslesti"] = bool(_e)
        k["kiraci_id"] = _e["kiraci_id"] if _e else None
        k["kiraci_ad"] = _e["ad"] if _e else None
    # Eşleşmişleri birleştirme önerilerinden düş — iş bitmiş, gürültü kalmasın.
    oneriler = [o for o in oneriler
                if not (_bagli.get(o["a_anahtar"]) and _bagli.get(o["b_anahtar"]))]

    def _t(x):
        return round(sum(float(r["tutar"]) for r in x), 2)

    return {
        # ⚠️ KİRA ve GERÇEK DIŞ KAYNAK kovaları da satırlarını taşır: sınıflama
        # yalnız açıklamadaki anahtar kelimeye bakıyor ("kira" geçmeyen bir kira
        # kaydı yanlış kovaya düşer) ve bunu yakalamanın TEK yolu içini görmek.
        "kira": {"adet": len(kira), "toplam": _t(kira), "satirlar": kira},
        "depozito": {"adet": len(depozito), "toplam": _t(depozito),
                     "satirlar": depozito},
        "mulk_gideri": {"adet": len(gider), "toplam": _t(gider), "satirlar": gider},
        "varlik_satisi": {"adet": len(varlik), "toplam": _t(varlik), "satirlar": varlik},
        "gercek_dis_kaynak": {"adet": len(disi), "toplam": _t(disi),
                              "satirlar": disi},
        "kiraci_kumeleri": kumeler,
        "birlestirme_onerileri": oneriler,
        "eslesen_kume": sum(1 for k in kumeler if k.get("eslesti")),
        "not": ("KURU ÇALIŞTIRMA — hiçbir kayıt yazılmadı, hiçbir satır "
                "değişmedi. 'gercek_dis_kaynak' kovasına DOKUNULMAZ (emekli "
                "maaşı, kredi, SGK iadesi). Kümeler ONAY bekler: aynı kiracının "
                "farklı yazımları tek kişide toplanır, sonra bir daha sorulmaz."),
    }


# ═══════════════════════════════════════════════════════════════════
# KİRACI DEĞİŞİMİ (DEVİR)
# ═══════════════════════════════════════════════════════════════════
class DevirBody(BaseModel):
    yeni_kiraci_id: str
    tarih: date                             # eski çıkış = yeni giriş günü
    aylik_kira: Optional[float] = None      # boşsa eskisi devam eder
    depozito: float = 0
    odeme_gunu: Optional[int] = None
    kiraci_tipi: Optional[str] = None
    stopaj_orani: Optional[float] = None
    depozito_iade: bool = True              # eski kiracının depozitosu iade edildi mi
    notlar: Optional[str] = None


@router.post("/sozlesme/{sid}/devir")
def sozlesme_devir(sid: str, b: DevirBody):
    """🔁 Kiracı değişti: eski sözleşme KAPANIR, yenisi açılır.

    ⚠️ Sözleşme GÜNCELLENMEZ, yenisi yazılır. Aynı satırın kiracısını
    değiştirmek geçmişi yalanlardı: Mayıs'ta kimden kira aldığımız o satıra
    bağlıdır; kiracı adı üstüne yazılınca eski tahsilatlar YENİ kiracının
    ödemesi gibi görünürdü (aynı ders: [[reference-personel-kisi-kimligi]]).

    Aynı işlemde yapılanlar:
      · eski sözleşme durum='bitti', bitiş = devir tarihi
      · varsa eski depozito iadesi mülk defterine yazılır (emanet kapanır)
      · yeni sözleşme açılır, yeni depozito alındıysa yazılır
      · abonelikler OTOMATİK DEVREDİLMEZ — sahibe listelenip sorulur
    """
    with db() as (conn, cur):
        cur.execute("""SELECT s.*, s.aylik_kira::float AS aylik_kira,
                              s.depozito::float AS depozito, m.ad AS mulk_ad,
                              k.ad AS eski_kiraci_ad
                       FROM kira_sozlesme s
                       JOIN mulk m ON m.id=s.mulk_id
                       JOIN kiraci k ON k.id=s.kiraci_id
                       WHERE s.id=%s""", (sid,))
        eski = cur.fetchone()
        if not eski:
            raise HTTPException(404, "Sözleşme bulunamadı")
        if str(eski.get("durum")) != "aktif":
            raise HTTPException(400, "Bu sözleşme zaten kapalı")

        cur.execute("UPDATE kira_sozlesme SET durum='bitti', bitis=%s WHERE id=%s",
                    (b.tarih, sid))

        iade = None
        _dep = float(eski.get("depozito") or 0)
        if b.depozito_iade and _dep > 0:
            iade = _mulk_yaz(cur, "DEPOZITO_IADE", b.tarih, -abs(_dep),
                             "%s depozito iadesi (cikis)" % eski["eski_kiraci_ad"],
                             sozlesme_id=sid, mulk_id=eski["mulk_id"],
                             kiraci_id=eski["kiraci_id"])

        yid = str(uuid.uuid4())
        cur.execute("""INSERT INTO kira_sozlesme
            (id, mulk_id, kiraci_id, baslangic, aylik_kira, depozito, odeme_gunu,
             kiraci_tipi, stopaj_orani, notlar)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (yid, eski["mulk_id"], b.yeni_kiraci_id, b.tarih,
                     b.aylik_kira if b.aylik_kira else eski["aylik_kira"],
                     b.depozito,
                     b.odeme_gunu if b.odeme_gunu else eski["odeme_gunu"],
                     b.kiraci_tipi or eski.get("kiraci_tipi") or "sahis",
                     (b.stopaj_orani if b.stopaj_orani is not None
                      else float(eski.get("stopaj_orani") or 0)),
                     b.notlar))
        if b.depozito > 0:
            _mulk_yaz(cur, "DEPOZITO_ALINDI", b.tarih, abs(b.depozito),
                      "Yeni kiraci depozitosu", sozlesme_id=yid,
                      mulk_id=eski["mulk_id"], kiraci_id=b.yeni_kiraci_id)

        cur.execute("""SELECT id, tur, saglayici, abone_kime, odeyen
                       FROM mulk_abonelik
                       WHERE mulk_id=%s AND COALESCE(durum,'aktif')='aktif'""",
                    (eski["mulk_id"],))
        abonelikler = [dict(r) for r in (cur.fetchall() or [])]

    return {
        "islem": "devredildi",
        "eski_sozlesme": sid, "yeni_sozlesme": yid,
        "depozito_iade": iade,
        "abonelik_uyarisi": abonelikler,
        "not": ("Eski sözleşme kapandı, yenisi açıldı — geçmiş tahsilatlar eski "
                "kiracıda KALDI. Abonelikler otomatik devredilmedi: her birinin "
                "abonesi ve ödeyeni ayrıca işaretlenmeli, yoksa kiracının "
                "faturası mülk sahibine kalır."),
    }


# ═══════════════════════════════════════════════════════════════════
# ABONELİKLER — elektrik · su · doğalgaz · internet · aidat
# ═══════════════════════════════════════════════════════════════════
class AbonelikBody(BaseModel):
    mulk_id: str
    tur: str
    saglayici: Optional[str] = None
    abone_no: Optional[str] = None
    abone_kime: str = "sahip"        # sahip | kiraci
    odeyen: str = "kiraci"           # sahip | kiraci
    sozlesme_id: Optional[str] = None
    aylik_tahmin: Optional[float] = None
    notlar: Optional[str] = None


@router.get("/abonelik")
def abonelik_listele(mulk_id: str = None):
    kos, par = "", []
    if mulk_id:
        kos = " AND a.mulk_id = %s"
        par = [mulk_id]
    with db() as (conn, cur):
        cur.execute("""
            SELECT a.*, a.aylik_tahmin::float AS aylik_tahmin,
                   m.ad AS mulk_ad, m.simge AS mulk_simge
            FROM mulk_abonelik a
            JOIN mulk m ON m.id = a.mulk_id
            WHERE COALESCE(a.durum,'aktif')='aktif'""" + kos + """
            ORDER BY m.ad, a.tur
        """, par)
        satirlar = [dict(r) for r in (cur.fetchall() or [])]
    # ⚠️ RİSK: abonesi SAHİP olup faturasını KİRACI ödeyen abonelik, kiracı
    # ödemediğinde borcu sahibe bırakır. Sessiz geçilmez, sayılır.
    riskli = [r for r in satirlar
              if str(r.get("abone_kime")) == "sahip" and str(r.get("odeyen")) == "kiraci"]
    return {
        "abonelikler": satirlar,
        "riskli_adet": len(riskli),
        "not": ("Abonesi SAHİP, ödeyeni KİRACI olan abonelikler risklidir: "
                "kiracı ödemezse borç mülk sahibine kalır. Devirde aboneliğin "
                "de devredilmesi gerekir."),
    }


@router.post("/abonelik")
def abonelik_ekle(b: AbonelikBody):
    aid = str(uuid.uuid4())
    with db() as (conn, cur):
        cur.execute("""INSERT INTO mulk_abonelik
            (id, mulk_id, tur, saglayici, abone_no, abone_kime, odeyen,
             sozlesme_id, aylik_tahmin, notlar)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (aid, b.mulk_id, b.tur, b.saglayici, b.abone_no, b.abone_kime,
                     b.odeyen, b.sozlesme_id, b.aylik_tahmin, b.notlar))
    return {"id": aid, "islem": "eklendi"}


@router.put("/abonelik/{aid}")
def abonelik_guncelle(aid: str, b: AbonelikBody):
    with db() as (conn, cur):
        cur.execute("""UPDATE mulk_abonelik SET tur=%s, saglayici=%s, abone_no=%s,
                              abone_kime=%s, odeyen=%s, aylik_tahmin=%s, notlar=%s
                       WHERE id=%s""",
                    (b.tur, b.saglayici, b.abone_no, b.abone_kime, b.odeyen,
                     b.aylik_tahmin, b.notlar, aid))
        if cur.rowcount == 0:
            raise HTTPException(404, "Abonelik bulunamadı")
    return {"islem": "guncellendi"}


@router.delete("/abonelik/{aid}")
def abonelik_kapat(aid: str):
    with db() as (conn, cur):
        cur.execute("UPDATE mulk_abonelik SET durum='kapali' WHERE id=%s", (aid,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Abonelik bulunamadı")
    return {"islem": "kapatildi"}


# ═══════════════════════════════════════════════════════════════════
# MÜLK DOSYASI — tıklayınca açılan içerik (çekmece)
# ═══════════════════════════════════════════════════════════════════
@router.get("/{mid}/dosya")
def mulk_dosyasi(mid: str):
    """Tek mülkün her şeyi: sözleşme geçmişi · abonelikler · para hareketleri.

    Çekmece deseni: kapı ancak ARKASINDA İÇERİK VARSA açılır. Bu uç içeriği
    TEK okumada verir ki ekran dört ayrı istek atmasın.
    """
    with db() as (conn, cur):
        cur.execute("SELECT *, aylik_kira::float AS aylik_kira FROM mulk WHERE id=%s",
                    (mid,))
        m = cur.fetchone()
        if not m:
            raise HTTPException(404, "Mülk bulunamadı")
        cur.execute("""
            SELECT s.*, s.aylik_kira::float AS aylik_kira, s.depozito::float AS depozito,
                   s.stopaj_orani::float AS stopaj_orani,
                   s.baslangic::text AS baslangic, s.bitis::text AS bitis,
                   k.ad AS kiraci_ad, k.telefon
            FROM kira_sozlesme s JOIN kiraci k ON k.id=s.kiraci_id
            WHERE s.mulk_id=%s ORDER BY s.baslangic DESC
        """, (mid,))
        sozlesmeler = [dict(r) for r in (cur.fetchall() or [])]
        cur.execute("""SELECT *, aylik_tahmin::float AS aylik_tahmin
                       FROM mulk_abonelik
                       WHERE mulk_id=%s AND COALESCE(durum,'aktif')='aktif'
                       ORDER BY tur""", (mid,))
        abonelikler = [dict(r) for r in (cur.fetchall() or [])]
        cur.execute("""
            SELECT h.*, h.tarih::text AS tarih, h.tutar::float AS tutar,
                   k.ad AS kiraci_ad, h.kasa_hareket_id AS kasa_iz,
                   kh.odeme_yontemi, kh.islem_turu AS kasa_turu,
                   COALESCE(kh.defter,'TULIPI') AS kasa_defter
            FROM mulk_hareket h
            LEFT JOIN kiraci k ON k.id=h.kiraci_id
            LEFT JOIN kasa_hareketleri kh ON kh.id = h.kasa_hareket_id
            WHERE h.mulk_id=%s AND COALESCE(h.durum,'aktif')='aktif'
            ORDER BY h.tarih DESC LIMIT 200
        """, (mid,))
        hareketler = [dict(r) for r in (cur.fetchall() or [])]
        # 📄 Belge arşivi — YENİDEN ESKİYE. Sıralama `belge_tarihi`ne göredir
        # (belgenin kendi tarihi), yüklenme anına göre DEĞİL: 2024 sözleşmesi
        # bugün yüklendi diye arşivin başına geçmemeli.
        cur.execute("""
            SELECT b.id, b.mulk_id, b.sozlesme_id, b.tur, b.ad, b.aciklama,
                   b.belge_tarihi::text AS belge_tarihi, b.mime, b.boyut,
                   b.olusturma::text AS olusturma, k.ad AS kiraci_ad
            FROM mulk_belge b
            LEFT JOIN kira_sozlesme s ON s.id = b.sozlesme_id
            LEFT JOIN kiraci k ON k.id = s.kiraci_id
            WHERE b.mulk_id=%s AND COALESCE(b.durum,'aktif')='aktif'
            ORDER BY b.belge_tarihi DESC NULLS LAST, b.olusturma DESC
        """, (mid,))
        belgeler = [dict(r) for r in (cur.fetchall() or [])]
    return {
        "mulk": dict(m),
        "sozlesmeler": sozlesmeler,
        "abonelikler": abonelikler,
        "hareketler": hareketler,
        "belgeler": belgeler,
        "kiraci_gecmisi": len(sozlesmeler),
        "toplam_kira": round(sum(float(h["tutar"]) for h in hareketler
                                 if h["tur"] == "KIRA_TAHSILAT"), 2),
    }


# ═══════════════════════════════════════════════════════════════════
# KİRACI BİRLEŞTİRME — yazım farklarını TEK kişide toplama
# ═══════════════════════════════════════════════════════════════════
class BirlestirBody(BaseModel):
    ad: str                          # kanonik ad — sahip yazar
    anahtarlar: List[str] = []       # göç kümelerinin ad anahtarları
    yazimlar: List[str] = []         # ham yazımlar (anahtara çevrilir)
    telefon: Optional[str] = None
    kiraci_id: Optional[str] = None  # varsa mevcut kişiye ekle


@router.post("/kiraci/birlestir")
def kiraci_birlestir(b: BirlestirBody):
    """Aynı kişinin farklı yazımlarını TEK kiracıya bağlar.

    🔴 NEDEN: canlıda "hamayoun faizi / hamayoğun faizi / hamoayoun faizi"
    üç ayrı kişi gibi duruyor; "bu ay kim ödemedi?" sorusu bu yüzden cevapsız.
    Sahip adı BİR KEZ onaylar, takma adlar deftere yazılır ve bir daha
    sorulmaz — sonraki serbest metin ve BANKA EKSTRESİ eşleşmesi otomatik
    çözülür (emsali: tedarikçi "Kimlik Birleştirme").

    ⚠️ OTOMATİK BİRLEŞTİRME YOK. Bu uç yalnız SAHİBİN seçtiklerini bağlar.
    "Mehmet Turan" ile "Mustafa Haluk Turan" %70 benzer ama başka insan
    olabilir; yanlış birleştirme iki kiracının borcunu tek kişide toplar ve
    biri "ödemiş" görünür.
    """
    ad = (b.ad or "").strip()
    if not ad:
        raise HTTPException(400, "Kanonik ad zorunlu")
    anahtarlar = {ad_anahtari(x) for x in (b.anahtarlar or []) if str(x).strip()}
    anahtarlar |= {ad_anahtari(x) for x in (b.yazimlar or []) if str(x).strip()}
    anahtarlar.add(ad_anahtari(ad))
    anahtarlar = {a for a in anahtarlar if a}

    with db() as (conn, cur):
        kid = b.kiraci_id
        if kid:
            cur.execute("SELECT id FROM kiraci WHERE id=%s", (kid,))
            if not cur.fetchone():
                raise HTTPException(404, "Kiracı bulunamadı")
            cur.execute("UPDATE kiraci SET ad=%s WHERE id=%s", (ad, kid))
        else:
            # Aynı anahtara bağlı kiracı zaten varsa ONA ekle — mükerrer kişi
            # açmak, birleştirmenin tam tersini yapardı.
            cur.execute("""SELECT kiraci_id FROM kiraci_takma_ad
                           WHERE takma_ad = ANY(%s) LIMIT 1""",
                        (list(anahtarlar),))
            _v = cur.fetchone()
            if _v:
                kid = _v["kiraci_id"]
                cur.execute("UPDATE kiraci SET ad=%s, aktif=TRUE WHERE id=%s", (ad, kid))
            else:
                kid = str(uuid.uuid4())
                cur.execute("INSERT INTO kiraci (id, ad, telefon) VALUES (%s,%s,%s)",
                            (kid, ad, b.telefon))
        if b.telefon:
            cur.execute("UPDATE kiraci SET telefon=%s WHERE id=%s", (b.telefon, kid))

        eklenen = 0
        for a in sorted(anahtarlar):
            # ⚠️ Takma ad BAŞKA kiracıya bağlıysa ÜSTÜNE YAZILMAZ: sessizce
            # çalmak, iki kiracının geçmişini karıştırırdı. Çakışma bildirilir.
            cur.execute("""INSERT INTO kiraci_takma_ad (takma_ad, kiraci_id, kaynak)
                           VALUES (%s,%s,'birlestirme')
                           ON CONFLICT (takma_ad) DO NOTHING""", (a, kid))
            eklenen += cur.rowcount
        cur.execute("""SELECT takma_ad, kiraci_id FROM kiraci_takma_ad
                       WHERE takma_ad = ANY(%s)""", (list(anahtarlar),))
        mevcut = [dict(r) for r in (cur.fetchall() or [])]

    catisan = [r["takma_ad"] for r in mevcut if r["kiraci_id"] != kid]
    return {
        "islem": "birlestirildi", "kiraci_id": kid, "ad": ad,
        "takma_ad_eklendi": eklenen,
        "toplam_takma_ad": len([r for r in mevcut if r["kiraci_id"] == kid]),
        "catisan": catisan,
        "not": ("Bu yazımlar artık tek kişiye bağlı. Çatışan varsa o yazım "
                "BAŞKA bir kiracıda duruyor ve üstüne yazılmadı — önce oradan "
                "ayırın." if catisan else
                "Bu yazımlar artık tek kişiye bağlı; bir daha sorulmayacak."),
    }


@router.get("/kiraci/{kid}/takma-ad")
def kiraci_takma_adlari(kid: str):
    with db() as (conn, cur):
        cur.execute("""SELECT takma_ad, kaynak, olusturma::text AS olusturma
                       FROM kiraci_takma_ad WHERE kiraci_id=%s ORDER BY takma_ad""",
                    (kid,))
        return {"takma_adlar": [dict(r) for r in (cur.fetchall() or [])]}


@router.delete("/kiraci/takma-ad/{takma_ad}")
def takma_ad_kaldir(takma_ad: str):
    """Yanlış birleştirilmiş bir yazımı geri ayır. Birleştirme geri alınabilir
    olmalı — yoksa sahip 'yanlış olur mu' diye hiç birleştirmez."""
    with db() as (conn, cur):
        cur.execute("DELETE FROM kiraci_takma_ad WHERE takma_ad=%s", (takma_ad,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Takma ad bulunamadı")
    return {"islem": "ayrildi"}


# ═══════════════════════════════════════════════════════════════════
# GÖÇ YAZIMI — AYNALAMA (mevcut kayda DOKUNULMAZ)
# ═══════════════════════════════════════════════════════════════════
GOC_ETIKET = "MULK_GOC_2026_09"


@router.post("/goc-yaz")
def goc_yaz(kuru: bool = Query(True), varlik: bool = Query(False),
            etiket: str = Query(GOC_ETIKET)):
    """Eski `DIS_KAYNAK` kira/depozito kayıtlarını mülk defterine AYNALAR.

    🔴 SAHİP KARARI 2026-09-08: *"para dükkâna girdi"*. Bu yüzden kayıtlar
    TAŞINMAZ, AYNALANIR:

        mevcut DIS_KAYNAK satırı  ............ DOKUNULMAZ (TULİPİ, +X)
        yeni  MULK KIRA_TAHSILAT ............. +X
        yeni  MULK MULK_AKTARIM_CIKIS ........ −X   (dükkâna aktarıldı)

    Sonuç: MÜLK net 0 · TULİPİ değişmez · TOPLAM KASA DEĞİŞMEZ.
    Kazanılan: "kim, ne zaman, ne kadar ödedi" ayrıntısı.

    ⚠️ TAŞIMA (retag) BİLEREK SEÇİLMEDİ: 46 satırı `defter='MULK'` yapmak
    TULİPİ çekmecesinden 657 bin ₺ SESSİZCE düşürür ve fiziksel sayımla
    çelişirdi ([[feedback-beklenen-etki-capaya-donmasin]]).

    ⚠️ MÜKERRER KORUMASI: her satır `mulk_hareket.kaynak_kasa_id` ile eski
    kasa satırına çıpalanır; ikinci çalıştırma o satırları ATLAR.

    `kuru=true` (varsayılan) hiçbir şey yazmaz, ne olacağını döndürür.
    """
    from finans_core import kasa_bakiyesi

    with db() as (conn, cur):
        t0 = kasa_bakiyesi(cur)
        tu0 = kasa_bakiyesi(cur, defter="TULIPI")
        mu0 = kasa_bakiyesi(cur, defter="MULK")

        cur.execute("""
            SELECT id, tarih, tarih::text AS tarih_m, tutar::float AS tutar, aciklama
            FROM kasa_hareketleri
            WHERE islem_turu='DIS_KAYNAK' AND COALESCE(durum,'aktif')='aktif'
            ORDER BY tarih
        """)
        satirlar = [dict(r) for r in (cur.fetchall() or [])]

        cur.execute("""SELECT t.takma_ad, t.kiraci_id, k.ad
                       FROM kiraci_takma_ad t JOIN kiraci k ON k.id=t.kiraci_id""")
        bagli = {r["takma_ad"]: (r["kiraci_id"], r["ad"]) for r in (cur.fetchall() or [])}

        cur.execute("""SELECT kaynak_kasa_id FROM mulk_hareket
                       WHERE kaynak_kasa_id IS NOT NULL""")
        yazilmis = {r["kaynak_kasa_id"] for r in (cur.fetchall() or [])}

        plan, atlanan = [], []
        for r in satirlar:
            a = tr_kucuk(r.get("aciklama"))
            if "ev sat" in a or "satış fiyat" in a or "satis fiyat" in a:
                # 🏡 VARLIK SATIŞI — sahip 2026-09-09: "ev satışını da al".
                # ⚠️ BİLEREK AYRI BAYRAK (`varlik=true`): 3,88 M ₺'lik tek bir
                # satır, 46 küçük kira kaydıyla aynı komuta sığdırılmaz. Bir
                # gün yanlışlıkla çalıştırılırsa fark edilmesi gereken şey bu.
                if not varlik:
                    continue
                tur = "VARLIK_SATISI"
            elif "depozit" in a:
                tur = "DEPOZITO_ALINDI"
            elif "kira" in a:
                tur = "KIRA_TAHSILAT"
            else:
                continue                              # gerçek dış kaynak — DOKUNULMAZ
            if r["id"] in yazilmis:
                atlanan.append({"id": r["id"], "neden": "zaten aynalanmış",
                                "aciklama": r["aciklama"]})
                continue
            ad = kiraci_adi_ayikla((r.get("aciklama") or "").split(":", 1)[-1])
            _e = bagli.get(ad_anahtari(ad))
            plan.append({
                "kasa_id": r["id"], "tarih": r["tarih_m"], "tutar": r["tutar"],
                "tur": tur, "aciklama": r["aciklama"],
                "kiraci_id": _e[0] if _e else None,
                "kiraci_ad": _e[1] if _e else None,
            })

        ozet = {
            "kuru": kuru,
            "varlik_dahil": varlik,
            "yazilacak": len(plan),
            "varlik_satisi_adet": sum(1 for p in plan if p["tur"] == "VARLIK_SATISI"),
            "varlik_satisi_tutar": round(
                sum(p["tutar"] for p in plan if p["tur"] == "VARLIK_SATISI"), 2),
            "atlanan": len(atlanan),
            "kiraci_eslesen": sum(1 for p in plan if p["kiraci_id"]),
            "kiraci_bos": sum(1 for p in plan if not p["kiraci_id"]),
            "toplam_tutar": round(sum(p["tutar"] for p in plan), 2),
            "once": {"toplam": round(t0, 2), "tulipi": round(tu0, 2), "mulk": round(mu0, 2)},
            "plan": plan,
            "atlananlar": atlanan,
        }

        if kuru:
            ozet["not"] = ("KURU ÇALIŞTIRMA — hiçbir şey yazılmadı. Yazmak için "
                           "kuru=false gönderin. Yazınca TOPLAM KASA DEĞİŞMEZ: "
                           "her kira satırının karşısına aynı tutarda "
                           "'dükkâna aktarıldı' satırı düşer.")
            return ozet

        yazilan = 0
        for p in plan:
            _r = _mulk_yaz(cur, p["tur"], p["tarih"], abs(p["tutar"]),
                           p["aciklama"], kiraci_id=p["kiraci_id"],
                           donem=str(p["tarih"])[:7], kaynak_kasa_id=p["kasa_id"])
            # Para dükkâna girdi → aynı tutar mülk defterinden çıkar.
            # ⚠️ Bu satır OLMAZSA toplam kasa şişer: aynı para hem eski
            # DIS_KAYNAK satırında hem yeni MULK satırında sayılırdı.
            _mulk_yaz(cur, "MULK_AKTARIM_CIKIS", p["tarih"], -abs(p["tutar"]),
                      "Dükkâna aktarıldı — %s" % (p["aciklama"] or "")[:80],
                      kiraci_id=p["kiraci_id"], kaynak_kasa_id=p["kasa_id"],
                      mulk_id=p.get("mulk_id"))
            yazilan += 1

        t1 = kasa_bakiyesi(cur)
        tu1 = kasa_bakiyesi(cur, defter="TULIPI")
        mu1 = kasa_bakiyesi(cur, defter="MULK")
        ozet.update({
            "yazilan": yazilan,
            "sonra": {"toplam": round(t1, 2), "tulipi": round(tu1, 2), "mulk": round(mu1, 2)},
            "toplam_kasa_farki": round(t1 - t0, 2),
            "tulipi_farki": round(tu1 - tu0, 2),
        })
        # 🚨 DEĞİŞMEZLİK KONTROLÜ — tutmuyorsa sessiz geçilmez.
        if abs(t1 - t0) > 0.01 or abs(tu1 - tu0) > 0.01:
            ozet["ALARM"] = ("TOPLAM veya TULİPİ kasası DEĞİŞTİ — bu göç "
                             "hiçbir bakiyeyi değiştirmemeliydi. /goc-geri-al "
                             "ile geri alın ve sebebi araştırın.")
            logger.error("MULK GOC ALARM: toplam %.2f→%.2f  tulipi %.2f→%.2f",
                         t0, t1, tu0, tu1)
        else:
            ozet["not"] = ("Yazıldı. TOPLAM KASA ve TULİPİ kasası KURUŞU "
                           "KURUŞUNA aynı kaldı; mülk defteri artık kimin ne "
                           "zaman ödediğini biliyor.")
        return ozet


@router.post("/goc-geri-al")
def goc_geri_al():
    """Göçü geri alır: aynalanan satırlar `durum='iptal'` olur.

    Göç yalnız YENİ satır eklediği için geri alma tamdır — hiçbir mevcut
    kaydın tutarı, defteri ya da türü değişmediği için "geri alınamaz" nokta
    yoktur.
    """
    from finans_core import kasa_bakiyesi
    with db() as (conn, cur):
        t0 = kasa_bakiyesi(cur)
        cur.execute("""SELECT id, kasa_hareket_id FROM mulk_hareket
                       WHERE kaynak_kasa_id IS NOT NULL
                         AND COALESCE(durum,'aktif')='aktif'""")
        satirlar = [dict(r) for r in (cur.fetchall() or [])]
        for r in satirlar:
            if r["kasa_hareket_id"]:
                cur.execute("UPDATE kasa_hareketleri SET durum='iptal' WHERE id=%s",
                            (r["kasa_hareket_id"],))
            cur.execute("UPDATE mulk_hareket SET durum='iptal' WHERE id=%s", (r["id"],))
        t1 = kasa_bakiyesi(cur)
    return {"islem": "geri_alindi", "satir": len(satirlar),
            "toplam_kasa_farki": round(t1 - t0, 2),
            "not": "Aynalanan satırlar iptal edildi; eski kayıtlara hiç dokunulmamıştı."}


# ═══════════════════════════════════════════════════════════════════
# 📄 BELGE ARŞİVİ — sözleşme · tapu · fatura, MÜLK BANDINDA
# ═══════════════════════════════════════════════════════════════════
# 🔴 NEDEN (sahip 2026-09-11): *"sözleşmeyi yükle olsun ama bu mülk bandında
# olsun, yeniden eski tarihe doğru dosyalama kurulsun."*
#
# Belge mülke bağlanır; sözleşmeye bağlanması İSTEĞE BAĞLIdır. Sebep: tapu ve
# emlak vergisi kiracıdan bağımsızdır, kira sözleşmesi ise bir kiracı dönemine
# aittir. İkisini aynı zorunlulukla bağlamak, tapuyu bir kiracının dosyasına
# hapsederdi.
_BELGE_TAVAN = 15 * 1024 * 1024          # 15 MB
_BELGE_TURLERI = {"sozlesme", "tapu", "fatura", "tahliye", "fotograf", "diger"}
_MIME_UZANTI = {
    "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png",
    "image/webp": "webp", "image/heic": "heic",
}


@router.post("/{mid}/belge")
async def mulk_belge_yukle(
    mid: str,
    dosya: UploadFile = File(...),
    tur: str = Form("sozlesme"),
    ad: str = Form(None),
    belge_tarihi: str = Form(None),
    sozlesme_id: str = Form(None),
    aciklama: str = Form(None),
):
    """Mülke belge iliştir (PDF ya da fotoğraf).

    ⚠️ Dosya VERİTABANINA yazılır. Railway'de disk kalıcı değildir; diske
    yazılan belge ilk dağıtımda buhar olurdu. Emsal: `sube_fire_bildirim_foto`.

    ⚠️ `belge_tarihi` verilmezse sözleşmenin BAŞLANGICINDAN türetilir; o da
    yoksa boş kalır ve arşivin sonuna düşer. Yükleme anı ASLA belge tarihi
    yerine geçmez — geçseydi 2024 sözleşmesi bugün yüklendiği için "en yeni"
    görünürdü.
    """
    raw = await dosya.read()
    if not raw:
        raise HTTPException(400, "Boş dosya")
    if len(raw) > _BELGE_TAVAN:
        raise HTTPException(413,
            f"Dosya çok büyük ({len(raw)/1048576:.1f} MB). Sınır 15 MB — "
            "telefonla çekilmiş fotoğrafı küçültüp tekrar deneyin.")
    mime = (dosya.content_type or "").lower().split(";")[0]
    _adi = (dosya.filename or "").lower()
    if mime not in _MIME_UZANTI:
        if _adi.endswith(".pdf"):
            mime = "application/pdf"
        elif _adi.endswith((".jpg", ".jpeg")):
            mime = "image/jpeg"
        elif _adi.endswith(".png"):
            mime = "image/png"
        else:
            raise HTTPException(400,
                "Yalnız PDF ve fotoğraf (JPG/PNG/WEBP) yüklenebilir.")
    _tur = (tur or "sozlesme").strip().lower()
    if _tur not in _BELGE_TURLERI:
        _tur = "diger"
    sha = hashlib.sha256(raw).hexdigest()

    with db() as (conn, cur):
        cur.execute("SELECT id, ad FROM mulk WHERE id=%s", (mid,))
        m = cur.fetchone()
        if not m:
            raise HTTPException(404, "Mülk bulunamadı")

        # 🛑 MÜKERRER FRENİ: birebir aynı dosya bu mülke daha önce yüklendiyse
        # ikinci kopya AÇILMAZ. Arşivde aynı sözleşmenin iki nüshası, "hangisi
        # geçerli" sorusunu doğurur.
        cur.execute("""SELECT id, ad, belge_tarihi::text AS belge_tarihi
                       FROM mulk_belge
                       WHERE mulk_id=%s AND sha256=%s
                         AND COALESCE(durum,'aktif')='aktif'""", (mid, sha))
        es = cur.fetchone()
        if es:
            raise HTTPException(409,
                f"Bu dosya zaten yüklü: «{es['ad']}»"
                + (f" ({es['belge_tarihi']})" if es.get("belge_tarihi") else ""))

        _tarih = (belge_tarihi or "").strip() or None
        _soz = (sozlesme_id or "").strip() or None
        if _soz:
            cur.execute("""SELECT baslangic::text AS baslangic, mulk_id
                           FROM kira_sozlesme WHERE id=%s""", (_soz,))
            sz = cur.fetchone()
            if not sz:
                raise HTTPException(404, "Sözleşme bulunamadı")
            if str(sz["mulk_id"]) != str(mid):
                raise HTTPException(400,
                    "Bu sözleşme başka bir mülke ait — belge yanlış dosyaya "
                    "gidiyordu, yazılmadı.")
            if not _tarih:
                _tarih = sz["baslangic"]

        _ad = (ad or "").strip() or (dosya.filename or "Belge")
        bid = str(uuid.uuid4())
        cur.execute("""INSERT INTO mulk_belge
            (id, mulk_id, sozlesme_id, tur, ad, belge_tarihi, aciklama,
             veri, mime, boyut, sha256)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (bid, mid, _soz, _tur, _ad, _tarih, (aciklama or None),
                     raw, mime, len(raw), sha))
    return {
        "id": bid, "islem": "yuklendi", "ad": _ad, "tur": _tur,
        "belge_tarihi": _tarih, "boyut": len(raw), "mime": mime,
        "not": (None if _tarih else
                "Belge tarihi girilmedi — arşivin sonunda duracak. "
                "Sıralama belgenin KENDİ tarihine göredir, yüklenme anına göre değil."),
    }


@router.get("/{mid}/belge")
def mulk_belge_listele(mid: str, sozlesme_id: str = None):
    """Mülkün belge arşivi — YENİDEN ESKİYE. Dosya içeriği DÖNMEZ, yalnız künye."""
    kos, par = "", [mid]
    if sozlesme_id:
        kos = " AND b.sozlesme_id = %s"
        par.append(sozlesme_id)
    with db() as (conn, cur):
        cur.execute(f"""
            SELECT b.id, b.sozlesme_id, b.tur, b.ad, b.aciklama, b.mime, b.boyut,
                   b.belge_tarihi::text AS belge_tarihi,
                   b.olusturma::text AS olusturma, k.ad AS kiraci_ad
            FROM mulk_belge b
            LEFT JOIN kira_sozlesme s ON s.id = b.sozlesme_id
            LEFT JOIN kiraci k ON k.id = s.kiraci_id
            WHERE b.mulk_id=%s AND COALESCE(b.durum,'aktif')='aktif'{kos}
            ORDER BY b.belge_tarihi DESC NULLS LAST, b.olusturma DESC
        """, par)
        satirlar = [dict(r) for r in (cur.fetchall() or [])]
    return {
        "belgeler": satirlar,
        "adet": len(satirlar),
        "toplam_boyut": sum(int(r["boyut"] or 0) for r in satirlar),
        "tarihsiz": sum(1 for r in satirlar if not r.get("belge_tarihi")),
        "not": ("Arşiv YENİDEN ESKİYE dizilidir ve sıra belgenin KENDİ "
                "tarihindendir — yüklenme anından değil."),
    }


@router.get("/belge/{bid}/veri")
def mulk_belge_veri(bid: str):
    """Belgenin kendisi — <img> ya da yeni sekmede PDF için."""
    with db() as (conn, cur):
        cur.execute("""SELECT veri, mime, ad FROM mulk_belge
                       WHERE id=%s AND COALESCE(durum,'aktif')='aktif'""", (bid,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Belge bulunamadı")
        # inline: tarayıcı PDF'i yeni sekmede AÇSIN, indirmeye zorlamasın.
        return Response(
            content=bytes(r["veri"]), media_type=r["mime"],
            headers={"Content-Disposition": "inline"})


class BelgeGuncelle(BaseModel):
    ad: Optional[str] = None
    tur: Optional[str] = None
    belge_tarihi: Optional[str] = None
    sozlesme_id: Optional[str] = None
    aciklama: Optional[str] = None


@router.put("/belge/{bid}")
def mulk_belge_guncelle(bid: str, b: BelgeGuncelle):
    """Künyeyi düzelt (dosyanın kendisi değişmez).

    ⚠️ Asıl işi `belge_tarihi` düzeltmektir: yanlış tarih arşivi yanlış sıraya
    dizer ve "hangi sözleşme güncel" sorusu yanlış cevaplanır.
    """
    with db() as (conn, cur):
        cur.execute("SELECT id FROM mulk_belge WHERE id=%s", (bid,))
        if not cur.fetchone():
            raise HTTPException(404, "Belge bulunamadı")
        cur.execute("""UPDATE mulk_belge SET
                         ad = COALESCE(%s, ad),
                         tur = COALESCE(%s, tur),
                         belge_tarihi = COALESCE(%s::date, belge_tarihi),
                         sozlesme_id = COALESCE(%s, sozlesme_id),
                         aciklama = COALESCE(%s, aciklama)
                       WHERE id=%s""",
                    ((b.ad or None), (b.tur or None), (b.belge_tarihi or None),
                     (b.sozlesme_id or None), (b.aciklama or None), bid))
    return {"islem": "guncellendi"}


@router.delete("/belge/{bid}")
def mulk_belge_kaldir(bid: str):
    """Belge SİLİNMEZ, arşivden kaldırılır (`durum='iptal'`).

    Dosyanın baytları DURUR: bir sözleşme yanlışlıkla kaldırılırsa geri
    getirilebilmeli. Kalıcı silme ayrı bir karardır ve bu uçtan yapılmaz.
    """
    with db() as (conn, cur):
        cur.execute("UPDATE mulk_belge SET durum='iptal' WHERE id=%s", (bid,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Belge bulunamadı")
    return {"islem": "arsivden_kaldirildi"}


# ═══════════════════════════════════════════════════════════════════
# 🔔 UYARI MOTORU — YALNIZ MÜLK ALANINDA
# ═══════════════════════════════════════════════════════════════════
# 🔴 NEDEN (sahip 2026-09-11/12): *"sadece bu alanda uyarıcılar çalışacak bir
# durum olmalı; kiracı ödeme girişi yapılmamışsa kirası ödenmedi, her ay bilgi
# verilsin."*
#
# ⚠️ UYARILAR SAKLANMAZ, HER OKUMADA YENİDEN ÖLÇÜLÜR. Saklansaydı kiracı
# ödediği hâlde uyarı defterde kalır ve "gördüm" işaretlemek gerekirdi; o da
# gerçeği değil OKUNMUŞLUĞU takip eden bir sisteme dönerdi.
#
# ⚠️ KAHVE İŞİNİN UYARILARINA KARIŞMAZ: bu uç yalnız mülk modülünce okunur.
# Panel'in uyarı listesine eklenmedi — sahip "sadece bu alanda" dedi.
#
# ⏰ "ÖDEME GÜNÜ GEÇTİ Mİ" AYRIMI: ayın 5'i ödeme günüyse ve bugün 3'ü ise o ay
# GECİKMİŞ değil BEKLENİYOR'dur. Bu ayrım olmasaydı her ayın 1'inde bütün
# kiracılar "ödemedi" diye alarm verirdi ve uyarı anlamsızlaşırdı.
_SEVIYE_SIRA = {"KRITIK": 0, "UYARI": 1, "BILGI": 2}


@router.get("/uyarilar")
def mulk_uyarilar():
    """Mülk alanının kendi uyarıları. Hesaplanır, saklanmaz."""
    from tr_saat import bugun_tr
    bugun = bugun_tr()
    u = []

    with db() as (conn, cur):
        satirlar = _tahsilat_hesapla(cur, bugun)

        # ── 1) KİRA ÖDENMEDİ — sahibin asıl istediği uyarı ──────────
        for r in satirlar:
            gecikenler = [a for a in (r.get("aylar") or []) if a.get("uyari") == "gecikti"]
            if not gecikenler:
                continue
            _aylar = [donem_ad_tr(a["donem"]) for a in gecikenler]
            _tutar = round(sum(a["acik"] for a in gecikenler), 2)
            u.append({
                "tip": "KIRA_ODENMEDI",
                "seviye": "KRITIK",
                "baslik": f"{r['kiraci_ad']} — {len(gecikenler)} kira ödenmedi",
                "detay": (f"{r['mulk_ad']} · açık aylar: {', '.join(_aylar)}"
                          + (f" · {r['telefon']}" if r.get("telefon") else "")),
                "tutar": _tutar,
                "adet": len(gecikenler),
                "sozlesme_id": r["sozlesme_id"], "mulk_id": r["mulk_id"],
                "kiraci_id": r["kiraci_id"], "kiraci_ad": r["kiraci_ad"],
                "mulk_ad": r["mulk_ad"], "telefon": r.get("telefon"),
                "aylar": [a["donem"] for a in gecikenler],
            })

        # ── 2) BU AYIN KİRASI BEKLENİYOR (vadesi gelmemiş) ──────────
        _bu_ay = bugun.strftime("%Y-%m")
        for r in satirlar:
            a = next((x for x in (r.get("aylar") or [])
                      if x["donem"] == _bu_ay and x.get("uyari") == "bekleniyor"), None)
            if not a:
                continue
            u.append({
                "tip": "KIRA_BEKLENIYOR", "seviye": "BILGI",
                "baslik": f"{r['kiraci_ad']} — {donem_ad_tr(_bu_ay)} kirası bekleniyor",
                "detay": f"{r['mulk_ad']} · vade {a['vade']}",
                "tutar": a["acik"], "adet": 1,
                "sozlesme_id": r["sozlesme_id"], "mulk_id": r["mulk_id"],
                "kiraci_id": r["kiraci_id"], "kiraci_ad": r["kiraci_ad"],
                "mulk_ad": r["mulk_ad"],
            })

        # ── 3) SÖZLEŞME BİTİYOR (60 gün) ────────────────────────────
        cur.execute("""
            SELECT s.id, s.bitis::text AS bitis, s.aylik_kira::float AS aylik_kira,
                   m.ad AS mulk_ad, m.id AS mulk_id, k.ad AS kiraci_ad, k.id AS kiraci_id
            FROM kira_sozlesme s
            JOIN mulk m ON m.id=s.mulk_id JOIN kiraci k ON k.id=s.kiraci_id
            WHERE s.durum='aktif' AND s.bitis IS NOT NULL
              AND s.bitis <= CURRENT_DATE + INTERVAL '60 days'
            ORDER BY s.bitis
        """)
        for r in (cur.fetchall() or []):
            _kalan = (_dt.date.fromisoformat(r["bitis"]) - bugun).days
            u.append({
                "tip": "SOZLESME_BITIYOR",
                "seviye": "KRITIK" if _kalan <= 15 else "UYARI",
                "baslik": (f"{r['kiraci_ad']} — sözleşme "
                           + (f"{_kalan} gün sonra bitiyor" if _kalan >= 0
                              else f"{-_kalan} gün önce BİTTİ")),
                "detay": f"{r['mulk_ad']} · bitiş {r['bitis']}",
                "tutar": r["aylik_kira"], "adet": 1,
                "sozlesme_id": r["id"], "mulk_id": r["mulk_id"],
                "kiraci_id": r["kiraci_id"], "kiraci_ad": r["kiraci_ad"],
                "mulk_ad": r["mulk_ad"],
            })

        # ── 4) RİSKLİ ABONELİK ──────────────────────────────────────
        cur.execute("""
            SELECT a.id, a.tur, m.ad AS mulk_ad, m.id AS mulk_id
            FROM mulk_abonelik a JOIN mulk m ON m.id=a.mulk_id
            WHERE COALESCE(a.durum,'aktif')='aktif'
              AND a.abone_kime='sahip' AND a.odeyen='kiraci'
        """)
        _ab = [dict(r) for r in (cur.fetchall() or [])]
        if _ab:
            u.append({
                "tip": "ABONELIK_RISKLI", "seviye": "UYARI",
                "baslik": f"{len(_ab)} abonelik sizin üstünüze kayıtlı",
                "detay": ("Faturayı kiracı ödüyor. Kiracı ödemezse ya da çıkarsa "
                          "borç sağlayıcı nezdinde SİZE kalır. — "
                          + ", ".join(f"{x['mulk_ad']}/{x['tur']}" for x in _ab[:4])),
                "tutar": 0, "adet": len(_ab),
            })

        # ── 5) DEPOZİTO KÂĞITTA, KASADA YOK ─────────────────────────
        cur.execute("""
            SELECT s.id, s.depozito::float AS depozito, m.ad AS mulk_ad,
                   m.id AS mulk_id, k.ad AS kiraci_ad, k.id AS kiraci_id
            FROM kira_sozlesme s
            JOIN mulk m ON m.id=s.mulk_id JOIN kiraci k ON k.id=s.kiraci_id
            WHERE s.durum='aktif' AND COALESCE(s.depozito,0) > 0
              AND NOT EXISTS (
                SELECT 1 FROM mulk_hareket h
                WHERE h.sozlesme_id=s.id AND h.tur='DEPOZITO_ALINDI'
                  AND COALESCE(h.durum,'aktif')='aktif')
        """)
        for r in (cur.fetchall() or []):
            u.append({
                "tip": "DEPOZITO_KASADA_YOK", "seviye": "UYARI",
                "baslik": f"{r['kiraci_ad']} — depozito kasaya girmemiş",
                "detay": (f"{r['mulk_ad']} · sözleşmede {r['depozito']:,.0f} ₺ yazıyor "
                          "ama defterde hareketi yok. Parayı aldıysanız kaydedin."),
                "tutar": r["depozito"], "adet": 1,
                "sozlesme_id": r["id"], "mulk_id": r["mulk_id"],
                "kiraci_id": r["kiraci_id"], "kiraci_ad": r["kiraci_ad"],
                "mulk_ad": r["mulk_ad"],
            })

        # ── 6) SÖZLEŞME BELGESİ YÜKLENMEMİŞ ─────────────────────────
        cur.execute("""
            SELECT s.id, m.ad AS mulk_ad, m.id AS mulk_id, k.ad AS kiraci_ad
            FROM kira_sozlesme s
            JOIN mulk m ON m.id=s.mulk_id JOIN kiraci k ON k.id=s.kiraci_id
            WHERE s.durum='aktif'
              AND NOT EXISTS (
                SELECT 1 FROM mulk_belge b
                WHERE b.sozlesme_id=s.id AND COALESCE(b.durum,'aktif')='aktif')
        """)
        _bs = [dict(r) for r in (cur.fetchall() or [])]
        if _bs:
            u.append({
                "tip": "BELGE_YOK", "seviye": "BILGI",
                "baslik": f"{len(_bs)} sözleşmenin belgesi yüklenmemiş",
                "detay": ("Kira sözleşmesinin taranmış hâli arşivde yok — "
                          + ", ".join(f"{x['kiraci_ad']} ({x['mulk_ad']})" for x in _bs[:4])),
                "tutar": 0, "adet": len(_bs),
            })

        # ── 7) KASA İZİ OLMAYAN HAREKET ─────────────────────────────
        cur.execute("""
            SELECT COUNT(*) AS n FROM mulk_hareket
            WHERE COALESCE(durum,'aktif')='aktif' AND kasa_hareket_id IS NULL
        """)
        _iz = int((cur.fetchone() or {}).get("n") or 0)
        if _iz:
            u.append({
                "tip": "KASA_IZI_YOK", "seviye": "KRITIK",
                "baslik": f"{_iz} hareketin kasa izi yok",
                "detay": ("Bu satırlar mülk defterinde görünüyor ama KASAYA "
                          "yansımamış — mülk kasası o tutarları içermiyor."),
                "tutar": 0, "adet": _iz,
            })

        # ── 8) BOŞ MÜLK ─────────────────────────────────────────────
        cur.execute("""
            SELECT m.id, m.ad, m.aylik_kira::float AS aylik_kira
            FROM mulk m
            WHERE m.aktif = TRUE
              AND NOT EXISTS (SELECT 1 FROM kira_sozlesme s
                              WHERE s.mulk_id=m.id AND s.durum='aktif')
        """)
        _bos = [dict(r) for r in (cur.fetchall() or [])]
        if _bos:
            u.append({
                "tip": "MULK_BOS", "seviye": "BILGI",
                "baslik": f"{len(_bos)} mülk boş",
                "detay": ("Kiracısı yok — aylık kayıp: "
                          + ", ".join(x["ad"] for x in _bos[:4])),
                "tutar": round(sum(float(x.get("aylik_kira") or 0) for x in _bos), 2),
                "adet": len(_bos),
            })

    u.sort(key=lambda x: (_SEVIYE_SIRA.get(x["seviye"], 9), -float(x.get("tutar") or 0)))
    return {
        "uyarilar": u,
        "adet": len(u),
        "kritik": sum(1 for x in u if x["seviye"] == "KRITIK"),
        "uyari": sum(1 for x in u if x["seviye"] == "UYARI"),
        "bilgi": sum(1 for x in u if x["seviye"] == "BILGI"),
        "odenmeyen_kira": round(sum(float(x.get("tutar") or 0)
                                    for x in u if x["tip"] == "KIRA_ODENMEDI"), 2),
        "not": ("Uyarılar SAKLANMAZ, her okumada yeniden ölçülür — kiracı "
                "ödediği an uyarı kendiliğinden kaybolur, 'gördüm' demeye gerek "
                "yok. Bu liste yalnız MÜLK alanına aittir; kahve işinin "
                "uyarılarına karışmaz. Vadesi gelmemiş ay 'gecikti' sayılmaz."),
    }


def donem_ad_tr(d: str) -> str:
    """'2026-07' → 'Temmuz'. Uyarı metni ay ADIYLA konuşur; '2026-07' bir
    insanın telefonda kiracıya söyleyeceği şey değildir."""
    _AY = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz",
           "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"]
    try:
        return _AY[int(str(d).split("-")[1]) - 1]
    except Exception:
        return str(d)
