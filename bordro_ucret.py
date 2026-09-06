# -*- coding: utf-8 -*-
"""BORDRO V2 · ÜCRET ÇÖZÜCÜ — "bu kişi O TARİHTE ne kazanıyordu?" TEK KAPI.

🔴 NEDEN (MAAS_V2_PLAN.md · Adım 2, sahip 2026-09-06):
    "ASGARİ ÜCRET ALANI HER YIL DEĞİŞTİĞİ İÇİN, TASARIMDA ŞU ANDA 28075 OLARAK
     GİRSEK BİLE BU DÜZELTİLEBİLİR OLMALI. ... BU SÜREKLİLİK DEĞİL, BİR KERE
     DEĞİŞTİĞİNDE HEPSİNE BİRDEN UYGULANMALI. BAZI PERSONELLER ASGARİ ÜCRETİN
     ÜSTÜNDE ANLAŞMA YAPILABİLİR, SİSTEM BUNLARI ANLAMALI."

Bugün ücret `personel.maas` kolonunda TEK DEĞER. İki kırık üretiyor:
  1) Asgari artınca 30 kart elle güncellenecek — biri unutulursa sessiz hata.
  2) Kart güncellenince GEÇMİŞ AYLAR da yeni tutarla hesaplanıyor; kapanmış
     Haziran bordrosu Eylül'de değişiyor ([[feedback-kayan-pencere-capa]]).

Çözüm ZAMAN ÇİZGİSİ: her ücret bir tarih aralığında geçerlidir.
    mod='ASGARIYE_BAGLI' → o tarihte geçerli ASGARI + fark  (asgari artınca birlikte artar)
    mod='SABIT'          → tutar sabit                       (asgari artsa da değişmez)

── DOKTRİNLER ───────────────────────────────────────────────────────────────
· TEK ÇEKİRDEK — ücreti okuyan HERKES buradan okur. İkinci bir formül yazma.
· UYDURMA YOK — `ucret_tanim`'da satır yoksa personel kartına düşer ve bunu
  `kaynak='personel_karti_ayna'` diye SÖYLER. Sessizce 0 dönmez, sessizce
  varsayım da üretmez ([[feedback-duyu-ham-veri-once]]).
· GEÇİŞ GÜVENLİĞİ — tablo boşken davranış bugünküyle BİRE BİR aynıdır.
  Golden çıpası (scripts/bordro_golden.py --karsilastir) 0,00 vermek zorunda.
· İZ BIRAKIR — çözüm her zaman hangi satırdan geldiğini (`ucret_tanim_id`)
  ve gerekçesini taşır; bordro kalemi bunu `kanit` JSONB'sine yazacak.
"""
from __future__ import annotations

import logging
from datetime import date, datetime
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

TURLER = ("TABAN", "YEMEK", "YOL", "SAATLIK")
# personel kartındaki ayna kolonlar (tablo boşken geçiş güvenliği)
AYNA_KOLON = {"TABAN": "maas", "YEMEK": "yemek_ucreti",
              "YOL": "yol_ucreti", "SAATLIK": "saatlik_ucret"}


def _gun(t) -> date:
    if isinstance(t, datetime):
        return t.date()
    if isinstance(t, date):
        return t
    return datetime.strptime(str(t)[:10], "%Y-%m-%d").date()


def _f(x) -> float:
    try:
        return float(x or 0)
    except (TypeError, ValueError):
        return 0.0


# ── ASGARİ ÜCRET ────────────────────────────────────────────────────────────
def asgari_coz(cur, tarih) -> Dict[str, Any]:
    """O TARİHTE geçerli asgari ücret. Yoksa tutar=None döner — 0 DEĞİL.

    ⚠️ 0 ile None farkı kritik: 0 "asgari sıfırdır" der ve ASGARIYE_BAGLI olan
    herkesi sıfırlar. None "bilinmiyor" der; çağıran aynaya düşer.
    """
    g = _gun(tarih)
    cur.execute(
        "SELECT id, tutar, gerekce, gecerli_bas "
        "  FROM ucret_tanim "
        " WHERE kapsam = 'GENEL' AND tur = 'ASGARI' "
        "   AND gecerli_bas <= %s "
        "   AND (gecerli_bit IS NULL OR gecerli_bit >= %s) "
        " ORDER BY gecerli_bas DESC, olusturma DESC LIMIT 1", (g, g))
    r = cur.fetchone()
    if not r:
        return {"tutar": None, "ucret_tanim_id": None, "kaynak": "tanimsiz",
                "gerekce": None, "gecerli_bas": None}
    return {"tutar": _f(r["tutar"]), "ucret_tanim_id": r["id"],
            "kaynak": "ucret_tanim", "gerekce": r.get("gerekce"),
            "gecerli_bas": str(r["gecerli_bas"])}


# ── KİŞİ ÜCRETİ ─────────────────────────────────────────────────────────────
def kalem_coz(cur, personel_id: str, tur: str, tarih,
              personel_satiri: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Tek ücret kalemini (TABAN/YEMEK/YOL/SAATLIK) o tarihe göre çözer.

    Dönen sözlük HER ZAMAN `tutar` + `kaynak` + `iz` taşır; bordro kalemi bunu
    olduğu gibi `kanit`e yazar, böylece "bu rakam nereden geldi" cevaplanabilir.
    """
    if tur not in TURLER:
        raise ValueError("bilinmeyen ucret turu: %s" % tur)
    g = _gun(tarih)

    cur.execute(
        "SELECT id, mod, tutar, fark, gerekce, gecerli_bas, gecerli_bit, kaynak "
        "  FROM ucret_tanim "
        " WHERE kapsam = 'KISI' AND personel_id = %s AND tur = %s "
        "   AND gecerli_bas <= %s "
        "   AND (gecerli_bit IS NULL OR gecerli_bit >= %s) "
        " ORDER BY gecerli_bas DESC, olusturma DESC LIMIT 1",
        (str(personel_id), tur, g, g))
    r = cur.fetchone()

    if r:
        if r["mod"] == "ASGARIYE_BAGLI":
            a = asgari_coz(cur, g)
            if a["tutar"] is None:
                # Asgari tanımlı değil → bağlı ücret HESAPLANAMAZ. Aynaya düş ve
                # bunu açıkça söyle; sessizce yalnız fark kadar ödeme yapma.
                return _aynadan(personel_id, tur, personel_satiri, g,
                                uyari="asgari_tanimsiz_asgariye_bagli_cozulemedi",
                                tanim_id=r["id"])
            return {"tutar": round(a["tutar"] + _f(r["fark"]), 2),
                    "kaynak": "ucret_tanim", "mod": "ASGARIYE_BAGLI",
                    "ucret_tanim_id": r["id"], "uyari": None,
                    "iz": {"asgari": a["tutar"], "fark": _f(r["fark"]),
                           "asgari_tanim_id": a["ucret_tanim_id"],
                           "gecerli_bas": str(r["gecerli_bas"]),
                           "gerekce": r.get("gerekce")}}
        return {"tutar": round(_f(r["tutar"]), 2), "kaynak": "ucret_tanim",
                "mod": "SABIT", "ucret_tanim_id": r["id"], "uyari": None,
                "iz": {"gecerli_bas": str(r["gecerli_bas"]),
                       "gecerli_bit": str(r["gecerli_bit"]) if r["gecerli_bit"] else None,
                       "gerekce": r.get("gerekce")}}

    return _aynadan(personel_id, tur, personel_satiri, g)


def _aynadan(personel_id: str, tur: str, p: Optional[Dict[str, Any]], g: date,
             uyari: Optional[str] = None,
             tanim_id: Optional[str] = None) -> Dict[str, Any]:
    """GEÇİŞ GÜVENLİĞİ: zaman çizgisinde satır yoksa personel kartını kullan.

    Bu bir "varsayım" değil AYNA'dır — bugünkü sistemin okuduğu değerin ta
    kendisi. Tablo dolduğunda bu yol kendiliğinden sönümlenir.
    """
    kol = AYNA_KOLON[tur]
    v = _f((p or {}).get(kol)) if p is not None else 0.0
    return {"tutar": round(v, 2), "kaynak": "personel_karti_ayna", "mod": "SABIT",
            "ucret_tanim_id": tanim_id, "uyari": uyari,
            "iz": {"kolon": kol, "tarih": str(g),
                   "not": "ucret_tanim'da bu tarih icin satir yok"}}


def sozlesme_coz(cur, personel_id: str, tarih,
                 personel_satiri: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """SÖZLEŞME EKSENİ — kişinin o tarihteki tüm ücret kalemleri tek çağrıda.

    Ölçüm (kaç gün çalıştı, kaç saat mesai) BURAYA GİRMEZ. Sözleşme her zaman
    hesaplanabilir; ölçüm ancak KANIT varsa ekler/çıkarır.
    """
    p = personel_satiri
    if p is None:
        cur.execute("SELECT id, ad_soyad, maas, yemek_ucreti, yol_ucreti, "
                    "       saatlik_ucret, calisma_turu, baslangic_tarihi "
                    "  FROM personel WHERE id = %s", (str(personel_id),))
        p = cur.fetchone() or {}
    out = {"personel_id": str(personel_id), "tarih": str(_gun(tarih)),
           "calisma_turu": (p.get("calisma_turu") or "surekli"),
           "asgari": asgari_coz(cur, tarih), "kalem": {}}
    for tur in TURLER:
        out["kalem"][tur] = kalem_coz(cur, personel_id, tur, tarih, p)
    out["ayna_kullanildi"] = any(
        k["kaynak"] == "personel_karti_ayna" and k["tutar"] > 0
        for k in out["kalem"].values())
    return out
