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
from datetime import date
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
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
    return {
        "toplam": round(toplam, 2),
        "tulipi": round(tulipi, 2),
        "mulk": round(mulk, 2),
        "depozito_emanet": round(emanet, 2),
        "kirilim": kirilim,
        "not": ("TOPLAM KASA = TULİPİ + MÜLK. Toplam, sistemin bugüne kadar "
                "gösterdiği rakamın aynısıdır; para yerinden oynamadı, yalnız "
                "hangi çekmeceye ait olduğu yazıldı. Depozito emanettir — "
                "mülk kasasının içindedir ama GELİR değildir."),
    }


# ═══════════════════════════════════════════════════════════════════
# MÜLKLER
# ═══════════════════════════════════════════════════════════════════
class MulkBody(BaseModel):
    ad: str
    adres: Optional[str] = None
    tur: Optional[str] = None
    simge: Optional[str] = None          # 🏠 🏢 🏬 … her mülkün kendi sembolü
    aylik_kira: Optional[float] = None
    notlar: Optional[str] = None


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
    return {
        "mulkler": satirlar,
        "adet": len(satirlar),
        "dolu": dolu,
        "bos": len(satirlar) - dolu,
        "aylik_beklenen": round(sum(float(r.get("sozlesme_kira") or 0) for r in satirlar), 2),
    }


@router.post("")
def mulk_ekle(b: MulkBody):
    mid = str(uuid.uuid4())
    with db() as (conn, cur):
        cur.execute("""INSERT INTO mulk (id, ad, adres, tur, simge, aylik_kira, notlar)
                       VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                    (mid, b.ad.strip(), b.adres, b.tur, b.simge, b.aylik_kira, b.notlar))
    return {"id": mid, "islem": "eklendi"}


@router.put("/{mid}")
def mulk_guncelle(mid: str, b: MulkBody):
    with db() as (conn, cur):
        cur.execute("""UPDATE mulk SET ad=%s, adres=%s, tur=%s, simge=%s,
                              aylik_kira=%s, notlar=%s
                       WHERE id=%s""",
                    (b.ad.strip(), b.adres, b.tur, b.simge, b.aylik_kira, b.notlar, mid))
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
    return {"id": sid, "islem": "eklendi"}


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
@router.get("/tahsilat")
def tahsilat_durum(donem: str = None):
    """Her aktif sözleşme için: bugüne kadar beklenen − tahsil edilen.

    ⚠️ Beklenen satırlar SAKLANMAZ, burada türetilir. Yaşanmamış ay hiçbir
    zaman borç sayılmaz: sayaç sözleşme başlangıcından BUGÜNÜN AYINA kadar.
    """
    from tr_saat import bugun_tr
    bugun = bugun_tr()
    with db() as (conn, cur):
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
        })
    satirlar.sort(key=lambda r: -r["bakiye"])
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
              odeme_yontemi=None) -> Dict[str, str]:
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
         aciklama, kasa_hareket_id)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (hid, tarih, tur, sozlesme_id, mulk_id, kiraci_id, donem,
                 tutar, aciklama, (_k or {}).get("id")))
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
    grup = str(uuid.uuid4())
    cikis = _mulk_yaz(cur, "MULK_AKTARIM_CIKIS", tarih, -abs(tutar), aciklama)
    insert_kasa_hareketi(cur, tarih, "MULK_AKTARIM_GIRIS", abs(tutar), aciklama,
                         "mulk_hareket", grup)
    return {"grup": grup, "cikis": cikis["id"], "tutar": abs(tutar)}


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
def mulk_defteri(ay: str = None, limit: int = 300):
    kos, par = "", []
    if ay and re.match(r"^\d{4}-\d{2}$", ay):
        kos = " AND to_char(h.tarih,'YYYY-MM') = %s"
        par = [ay]
    with db() as (conn, cur):
        cur.execute(f"""
            SELECT h.*, h.tarih::text AS tarih, h.tutar::float AS tutar,
                   m.ad AS mulk_ad, k.ad AS kiraci_ad,
                   kh.id AS kasa_iz, kh.islem_turu AS kasa_turu,
                   COALESCE(kh.defter,'TULIPI') AS kasa_defter
            FROM mulk_hareket h
            LEFT JOIN mulk m ON m.id = h.mulk_id
            LEFT JOIN kiraci k ON k.id = h.kiraci_id
            LEFT JOIN kasa_hareketleri kh ON kh.id = h.kasa_hareket_id
            WHERE COALESCE(h.durum,'aktif')='aktif'{kos}
            ORDER BY h.tarih DESC, h.olusturma DESC
            LIMIT %s
        """, par + [max(1, min(1000, limit))])
        satirlar = [dict(r) for r in (cur.fetchall() or [])]
    return {
        "satirlar": satirlar,
        "adet": len(satirlar),
        "not": ("Her satırın kasa izi vardır (kasa_iz). İz yoksa o satır "
                "kasaya yansımamış demektir — sessiz geçilmez, görünür olur."),
    }


@router.delete("/hareket/{hid}")
def hareket_iptal(hid: str):
    """Satır SİLİNMEZ, iptal edilir; kasa karşılığı da ters kayıtla kapanır."""
    from kasa_service import iptal_kasa_hareketi
    with db() as (conn, cur):
        cur.execute("SELECT * FROM mulk_hareket WHERE id=%s", (hid,))
        h = cur.fetchone()
        if not h:
            raise HTTPException(404, "Hareket bulunamadı")
        if str(h.get("durum") or "aktif") != "aktif":
            return {"islem": "zaten_iptal"}
        tur = str(h["tur"])
        _iptal_turu = {
            "KIRA_TAHSILAT": "KIRA_TAHSILAT_IPTAL",
            "MULK_GIDER": "MULK_GIDER_IPTAL",
        }.get(tur)
        if _iptal_turu:
            try:
                iptal_kasa_hareketi(cur, hid, "mulk_hareket", tur, _iptal_turu,
                                    f"{tur} iptali")
            except Exception as e:
                logger.warning("mülk kasa iptali atlandı (%s): %s", hid, e)
        cur.execute("UPDATE mulk_hareket SET durum='iptal' WHERE id=%s", (hid,))
    return {"islem": "iptal"}


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
        ham = (r.get("aciklama") or "").split(":", 1)[-1]
        ad = re.sub(r"(?i)kira( bedeli)?|geliri|gecikmi[şs]|[0-9]+ ?ayl[ıi]k|ay[ıi]|"
                    r"ocak|[şs]ubat|mart|nisan|may[ıi]s|haziran|temmuz|a[ğg]ustos|"
                    r"eyl[üu]l|ekim|kas[ıi]m|aral[ıi]k", "", tr_kucuk(ham)).strip(" -–—.")
        anahtar = ad_anahtari(ad)
        if not anahtar:
            anahtar = "(adsız)"
        k = kume.setdefault(anahtar, {"onerilen_ad": ad.strip().title() or "(adsız)",
                                      "yazimlar": set(), "adet": 0, "toplam": 0.0,
                                      "aylar": set(), "kayit_id": []})
        k["yazimlar"].add(ad.strip())
        k["adet"] += 1
        k["toplam"] += float(r["tutar"])
        k["aylar"].add(r["tarih"][:7])
        k["kayit_id"].append(r["id"])

    kumeler = sorted(
        ({"anahtar": a, "onerilen_ad": v["onerilen_ad"],
          "yazimlar": sorted(v["yazimlar"]), "yazim_adedi": len(v["yazimlar"]),
          "adet": v["adet"], "toplam": round(v["toplam"], 2),
          "aylar": sorted(v["aylar"]), "kayit_id": v["kayit_id"]}
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

    def _t(x):
        return round(sum(float(r["tutar"]) for r in x), 2)

    return {
        "kira": {"adet": len(kira), "toplam": _t(kira)},
        "depozito": {"adet": len(depozito), "toplam": _t(depozito),
                     "satirlar": depozito},
        "mulk_gideri": {"adet": len(gider), "toplam": _t(gider), "satirlar": gider},
        "varlik_satisi": {"adet": len(varlik), "toplam": _t(varlik), "satirlar": varlik},
        "gercek_dis_kaynak": {"adet": len(disi), "toplam": _t(disi)},
        "kiraci_kumeleri": kumeler,
        "birlestirme_onerileri": oneriler,
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
                   k.ad AS kiraci_ad, h.kasa_hareket_id AS kasa_iz
            FROM mulk_hareket h LEFT JOIN kiraci k ON k.id=h.kiraci_id
            WHERE h.mulk_id=%s AND COALESCE(h.durum,'aktif')='aktif'
            ORDER BY h.tarih DESC LIMIT 200
        """, (mid,))
        hareketler = [dict(r) for r in (cur.fetchall() or [])]
    return {
        "mulk": dict(m),
        "sozlesmeler": sozlesmeler,
        "abonelikler": abonelikler,
        "hareketler": hareketler,
        "kiraci_gecmisi": len(sozlesmeler),
        "toplam_kira": round(sum(float(h["tutar"]) for h in hareketler
                                 if h["tur"] == "KIRA_TAHSILAT"), 2),
    }
