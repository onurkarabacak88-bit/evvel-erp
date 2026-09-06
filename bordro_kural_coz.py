# -*- coding: utf-8 -*-
"""BORDRO V2 · KURAL ÇÖZÜCÜ — "o AY hangi parametre geçerliydi?" TEK KAPI.

🔴 NEDEN (MAAS_V2_PLAN.md · Adım 3):
Bordronun parametreleri bugün ÜÇ AYRI DOSYADA sabit yazılı:
    maas_service.py:30-31   GUNLUK_SAAT=9.5 · AYLIK_GUN=30 · PART_GUNLUK_SAAT=5.5
    gorev_api.py:2175       STANDART = 9.5
    gorev_api.py:2260-2262  GUNLUK_SAAT=9.5 · AYLIK_GUN=30.0
İki somut sonucu var:
  1) ÇELİŞKİ — part-time "tam gün" eşiği bir yerde 9,4 (gorev_api.py:2214),
     diğer yerde 9,5. Aynı personel iki ekranda iki farklı gün sayısı gösteriyor.
  2) GEÇMİŞ KAYAR — sahip "artık 8 saat çalışıyoruz" derse kod değişir ve
     KAPANMIŞ Haziran bordrosu da yeni sayıyla yeniden hesaplanır
     ([[feedback-kayan-pencere-capa]]). Oysa Haziran 9,5 saatle çalışılmıştı.

Çözüm: parametre bir TARİH ARALIĞINA bağlanır. Kural değişince yeni satır
açılır, eski satır kapanır; geçmiş ay eski kuralla hesaplanmaya devam eder.

── DOKTRİNLER ───────────────────────────────────────────────────────────────
· TEK ÇEKİRDEK — parametre okuyan HERKES buradan okur.
· GEÇİŞ GÜVENLİĞİ — tablo boşken `VARSAYILAN` döner ve bu değerler bugün
  kodda yazılı olanların BİREBİR aynısıdır. Davranış değişmez.
· KAPSAM SIRASI — KISI > SUBE > GENEL. En dar olan kazanır (bir şubenin mesai
  kavramı farklı olabilir; sahip: "her işletmenin mesai kavramı var").
· UYDURMA YOK — `gerekce` alanına SÖZLEŞME/KARAR METNİ yazılır; boş bırakılan
  kural denetimde savunulamaz.
"""
from __future__ import annotations

import logging
from datetime import date, datetime
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# Bugün kodda yazılı olan değerler — BİREBİR. Değiştirmeyin; kural değişikliği
# VERİ olarak (`bordro_kural` satırı) yapılır, burada değil.
VARSAYILAN: Dict[str, Any] = {
    "gunluk_saat": 9.5,            # maas_service.py:30
    "aylik_gun": 30.0,             # maas_service.py:31 — İş K. izin günleri dahil
    "haftalik_calisma_gun": 6,     # maas_service.py:HAFTALIK_CALISMA_GUN
    "part_gunluk_saat": 5.5,       # maas_service.py:PART_GUNLUK_SAAT
    "part_tam_gun_esigi": 9.4,     # gorev_api.py:2214 ⚠️ 9.5 ile ÇELİŞİYOR
    "fm_gunluk_esik": 9.5,         # gorev_api.py:2175 STANDART
    "yemek_mola_limit_dk": 60,     # sube.yemek_mola_limit_dk varsayılanı
    "varsayilan_saatlik": 99.0,    # maas_service.py — ücreti tanımsız part-time
    # 🍽 YEMEK PAYDASI — "hak edilen gün / PAYDA" oranındaki payda ne olsun?
    #   'planli_gun'   → sisteme GİRİLEN vardiya sayısı (bugünkü davranış)
    #   'beklenen_gun' → kişinin o dönemde ÇALIŞMASI BEKLENEN gün sayısı
    #   sayı           → sabit payda (ör. 26)
    # 🔴 NEDEN SEÇENEK (Fable+Claude denetimi 2026-09-06): 'planli_gun' paydası
    # "kaç gün çalışması gerekiyordu"yu değil "kaç gün KAYIT GİRİLDİ"yi ölçüyor.
    # Veri seyrekleşince bir mola ihlalinin bedeli patlıyor — canlı kanıt,
    # DENİZ KÜÇÜKKIRLI, aynı kişi/aynı sözleşme:
    #     Haziran  8 planlı gün → 1 ihlal   875,00 ₺
    #     Temmuz  25 planlı gün → 1 ihlal   280,00 ₺
    #     Ağustos  6 planlı gün → 1 ihlal 1.166,67 ₺   (4,2 KAT)
    # Ayrıca ters teşvik: kaydı eksik tutan TAM yemek alıyor, düzgün tutan
    # ceza yiyor (MERVE AKTA 7 kayıt/4 hak = 4.000; 4 kayıt girilseydi 7.000).
    # İhlal YOKSA hangi payda seçilirse seçilsin sonuç aynıdır (oran 1,0) —
    # bu yüzden değişiklik geçmişi kaydırmaz.
    "yemek_paydasi": "planli_gun",
    # 🍽 MOLA KAYDI OLMAYAN GÜN NE SAYILIR? (Adım 7 · sahip kararı 2026-09-06)
    #   'hak_dogmaz' → bugünkü davranış: kayıt yoksa yemek ödenmez
    #   'hak_dogar'  → vardiya varsa çalışılmış VE molasını kullanmış kabul edilir
    #   'askida'     → hak doğmaz ama listelenir, sahip gün gün onaylar
    # ⚠️ VARSAYILAN 'hak_dogmaz' KALIR. Değişiklik `bordro_kural` satırıyla,
    # TARİHLİ olarak yapılır; geçmiş ay kendi kuralıyla hesaplanmaya devam eder.
    # Sahip 2026-09-06: "B" → Eylül'den itibaren 'hak_dogar'.
    "mola_kayit_yok": "hak_dogmaz",
}

# Kod içinde kalması gereken tek gerçek: bu değerlerin kaynağı.
KAYNAK_NOT = "kodda sabit (bordro_kural tablosu bos)"


def _gun(t) -> date:
    if isinstance(t, datetime):
        return t.date()
    if isinstance(t, date):
        return t
    return datetime.strptime(str(t)[:10], "%Y-%m-%d").date()


def kural_coz(cur, tarih, personel_id: Optional[str] = None,
              sube_id: Optional[str] = None) -> Dict[str, Any]:
    """O tarihte geçerli parametre seti. Kapsam sırası: KISI > SUBE > GENEL.

    Dönen sözlükte `_iz` her parametrenin hangi kural satırından geldiğini
    söyler; bordro kalemi bunu `kanit`e yazar.
    """
    g = _gun(tarih)
    p = dict(VARSAYILAN)
    iz: Dict[str, Any] = {k: KAYNAK_NOT for k in p}
    kural_id = None

    # GENEL → SUBE → KISI sırasıyla üst üste bindirilir (dar olan ezer).
    for kapsam, deger in (("GENEL", None), ("SUBE", sube_id), ("KISI", personel_id)):
        if kapsam != "GENEL" and not deger:
            continue
        kolon = "sube_id" if kapsam == "SUBE" else "personel_id"
        # 🔴 TÜM GEÇERLİ SATIRLAR ÜST ÜSTE BİNER — "LIMIT 1" DEĞİL.
        # Eski hâli en yeni TEK satırı okuyordu. Sonuç: aynı kapsam+aynı tarihe
        # ikinci bir satır yazınca ÖNCEKİNİN PARAMETRELERİ SESSİZCE KAYBOLUYORDU.
        # Canlı kanıt (2026-09-06): `yemek_paydasi` satırı eklenince aynı tarihli
        # `mola_kayit_yok='askida'` satırı görünmez oldu, Eylül kuralı sessizce
        # varsayılana döndü. Kural KAYBI en sinsi tür: hata vermez, sadece
        # davranış eski hâline döner.
        # Artık satırlar (gecerli_bas, olusturma) ARTAN sırayla ALAN ALAN
        # bindirilir: sonraki satır yalnız KENDİ yazdığı alanı ezer.
        sql = ("SELECT id, parametre, gerekce, gecerli_bas FROM bordro_kural "
               " WHERE kapsam=%s AND gecerli_bas <= %s "
               "   AND (gecerli_bit IS NULL OR gecerli_bit >= %s) ")
        args = [kapsam, g, g]
        if kapsam != "GENEL":
            sql += " AND %s = %%s" % kolon
            args.append(str(deger))
        sql += " ORDER BY gecerli_bas ASC, olusturma ASC"
        cur.execute(sql, tuple(args))
        for r in (cur.fetchall() or []):
            par = r["parametre"] or {}
            if isinstance(par, str):
                import json as _json
                try:
                    par = _json.loads(par)
                except Exception:  # noqa: BLE001
                    par = {}
            for k, v in par.items():
                if k not in VARSAYILAN:
                    logger.warning("bordro_kural: bilinmeyen parametre %s (yok sayildi)", k)
                    continue
                p[k] = v
                iz[k] = {"kural_id": r["id"], "kapsam": kapsam,
                         "gecerli_bas": str(r["gecerli_bas"]), "gerekce": r.get("gerekce")}
            kural_id = r["id"]

    p["_iz"] = iz
    p["_kural_id"] = kural_id
    p["_tarih"] = str(g)
    p["_tablodan"] = kural_id is not None
    return p


def celiski_var_mi(p: Dict[str, Any]) -> Optional[str]:
    """Bilinen çelişkiyi ADIYLA söyler — sessizce düzeltmez (ÖNERİ-ONLY).

    part_tam_gun_esigi (9,4) ile fm_gunluk_esik (9,5) farklıysa aynı vardiya
    bir ekranda "tam gün", diğerinde "eksik" görünür. Sahip kararı gerekir:
    ikisi de 9,5 mi olacak, yoksa fark kasıtlı mı.
    """
    a = float(p.get("part_tam_gun_esigi") or 0)
    b = float(p.get("fm_gunluk_esik") or 0)
    if abs(a - b) > 0.001:
        return ("part_tam_gun_esigi=%.2f ile fm_gunluk_esik=%.2f FARKLI — "
                "ayni vardiya iki ekranda iki turlu sayilir (SAHIP KARARI)" % (a, b))
    return None
