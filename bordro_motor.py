# -*- coding: utf-8 -*-
"""BORDRO V2 · SAF MOTOR — net bir SONUÇ değil, KALEMLERİN TOPLAMIDIR.

🔴 NEDEN (MAAS_V2_PLAN.md · Adım 6, sahip 2026-09-06):
Bugün bordro tek bir `hesaplanan_net` sayısıdır. "Bu 259 ₺ nereden çıktı?"
sorusunun teknik olarak cevaplanması imkânsız — formül kodun içinde dağılmış,
ara değerler hiçbir yere yazılmıyor. Canlı bedeli: DENİZ KÜÇÜKKIRLI Temmuz
2026'da 1.166,67 ₺ eksik hesaplandı ve DÖRT AY fark edilmedi.

Bu modül bordroyu bir DEFTERE çevirir: her satır kendi
    kaynağını (hangi sözleşme/kural satırı),
    ölçüsünü (kaç gün, kaç saat, birim tutar),
    kanıtını (neye dayanıyor, sınıfı ne)
taşır. Net = Σ kalem. Başka bir yerden gelmez.

── SAFLIK SÖZLEŞMESİ (bu modülün varlık sebebi) ─────────────────────────────
· DB YOK, I/O YOK, ZAMAN YOK. Üç sözlük girer, kalem listesi çıkar.
· Aynı girdi → HER ZAMAN aynı çıktı. Test edilebilir olmasının tek yolu bu.
· Ölçümü ÜRETMEZ, ölçümü ALIR. "Kaç gün çalıştı" bu modülün işi değil;
  o bir KANIT toplama işidir ve dışarıda yapılır. Burası yalnız ARİTMETİK.
· Kalem ÜRETMEYEN durum da bilgidir: hak doğmayan gün `kanit`e yazılır,
  sıfır tutarlı sahte kalem üretilmez.

── EKSENLER ─────────────────────────────────────────────────────────────────
  SOZLESME → her zaman hesaplanabilir (taban, yol). Ölçüm olmasa da vardır.
  OLCUM    → ancak KANIT varsa ekler/çıkarır (yemek, fazla mesai, saatlik).
  KARAR    → sahibin açık kararı (onaylanan mola günü, elden mesai).
  MAHSUP   → avans ve devir (burada değil; ödeme katmanında).
"""
from __future__ import annotations

from typing import Any, Dict, List

SURUM = 1  # kalem şeması sürümü — kural değişince değil, ŞEMA değişince artar


def _r(x: float, n: int = 2) -> float:
    return round(float(x or 0), n)


def _kalem(tur: str, eksen: str, tutar: float, kaynak: str, kanit_sinifi: str,
           kanit: Dict[str, Any], miktar=None, birim=None, birim_tutar=None,
           ucret_tanim_id=None, kural_id=None) -> Dict[str, Any]:
    return {"tur": tur, "eksen": eksen, "tutar": _r(tutar), "kaynak": kaynak,
            "kanit_sinifi": kanit_sinifi, "kanit": kanit,
            "miktar": (None if miktar is None else _r(miktar, 3)),
            "birim": birim,
            "birim_tutar": (None if birim_tutar is None else _r(birim_tutar, 4)),
            "ucret_tanim_id": ucret_tanim_id, "kural_id": kural_id}


def hesapla(sozlesme: Dict[str, Any], kural: Dict[str, Any],
            olcum: Dict[str, Any]) -> Dict[str, Any]:
    """SAF. Üç sözlük → kalem listesi + net.

    sozlesme: bordro_ucret.sozlesme_coz() çıktısı (kalem başına tutar + iz)
    kural   : bordro_kural_coz.kural_coz() çıktısı (aylik_gun, gunluk_saat…)
    olcum   : KANIT — {gecen_gun, planli_gun, yemek_hak_gun, ihlal_gun,
                       kayit_yok_gun, onayli_gun, fazla_mesai_saat,
                       calisilan_saat, ay_tamam}
    """
    K = sozlesme.get("kalem") or {}
    part = (sozlesme.get("calisma_turu") or "surekli") != "surekli"
    kural_id = kural.get("_kural_id")

    aylik_gun = float(kural.get("aylik_gun") or 30.0)
    gunluk_saat = float(kural.get("gunluk_saat") or 9.5)
    aylik_saat = gunluk_saat * aylik_gun

    gecen = float(olcum.get("gecen_gun") or 0)
    donem_orani = (gecen / aylik_gun) if aylik_gun > 0 else 0.0

    kalemler: List[Dict[str, Any]] = []
    notlar: List[str] = []

    # ── TABAN / SAATLİK ─────────────────────────────────────────────────────
    if not part:
        maas = float(K.get("TABAN", {}).get("tutar") or 0)
        if maas > 0 and gecen > 0:
            gunluk = maas / aylik_gun if aylik_gun > 0 else 0.0
            kalemler.append(_kalem(
                "TABAN", "SOZLESME", gunluk * gecen,
                kaynak=K.get("TABAN", {}).get("kaynak") or "?",
                kanit_sinifi="sozlesme",
                kanit={"aylik_maas": maas, "aylik_gun": aylik_gun,
                       "gecen_gun": gecen, "mod": K.get("TABAN", {}).get("mod"),
                       "iz": K.get("TABAN", {}).get("iz")},
                miktar=gecen, birim="gun", birim_tutar=gunluk,
                ucret_tanim_id=K.get("TABAN", {}).get("ucret_tanim_id"),
                kural_id=kural_id))
        elif maas <= 0:
            notlar.append("taban tanımsız — sözleşmede maaş yok")
    else:
        saatlik = float(K.get("SAATLIK", {}).get("tutar") or 0)
        saat = float(olcum.get("calisilan_saat") or 0)
        if saatlik > 0 and saat > 0:
            kalemler.append(_kalem(
                "SAATLIK", "OLCUM", saat * saatlik,
                kaynak=K.get("SAATLIK", {}).get("kaynak") or "?",
                kanit_sinifi=olcum.get("saat_kanit_sinifi") or "olcum",
                kanit={"saat": saat, "saatlik_ucret": saatlik,
                       "saat_kaynagi": olcum.get("saat_kaynagi"),
                       "iz": K.get("SAATLIK", {}).get("iz")},
                miktar=saat, birim="saat", birim_tutar=saatlik,
                ucret_tanim_id=K.get("SAATLIK", {}).get("ucret_tanim_id"),
                kural_id=kural_id))
        elif saat <= 0:
            notlar.append("saat kanıtı yok — part-time hakedişi ölçülemedi")

    # ── FAZLA MESAİ (yalnız sürekli) ────────────────────────────────────────
    if not part:
        fm_saat = float(olcum.get("fazla_mesai_saat") or 0)
        maas = float(K.get("TABAN", {}).get("tutar") or 0)
        if fm_saat > 0 and maas > 0 and aylik_saat > 0:
            saatlik = maas / aylik_saat
            kalemler.append(_kalem(
                "FAZLA_MESAI", "OLCUM", fm_saat * saatlik,
                kaynak="vardiya_plani", kanit_sinifi="olcum",
                kanit={"saat": fm_saat, "saatlik": _r(saatlik, 4),
                       "aylik_saat": aylik_saat,
                       "esik": kural.get("fm_gunluk_esik")},
                miktar=fm_saat, birim="saat", birim_tutar=saatlik,
                kural_id=kural_id))

    # ── YEMEK ───────────────────────────────────────────────────────────────
    # KOŞULLU HAK: sözleşme "molasına zamanında girene ÖDENİR" der. Hak
    # doğmayan gün KESİNTİ değildir (İş K. m.38 dışı) — kalem üretmez, gerekçe
    # `kanit`te durur. Sahip kararı 2026-09-06: "A HAK DOĞMAMASI!"
    aylik_yemek = float(K.get("YEMEK", {}).get("tutar") or 0)
    planli = int(olcum.get("planli_gun") or 0)
    hak_gun = int(olcum.get("yemek_hak_gun") or 0)
    payda = float(olcum.get("yemek_paydasi_deger") or planli or 0)
    if aylik_yemek > 0 and donem_orani > 0:
        if payda > 0:
            oran = max(0.0, min(1.0, hak_gun / payda))
            tutar = aylik_yemek * donem_orani * oran
            if tutar > 0:
                kalemler.append(_kalem(
                    "YEMEK", "OLCUM", tutar,
                    kaynak=K.get("YEMEK", {}).get("kaynak") or "?",
                    kanit_sinifi="olcum",
                    kanit={"aylik_yemek": aylik_yemek, "donem_orani": _r(donem_orani, 6),
                           "hak_dogan_gun": hak_gun, "payda": payda,
                           "payda_kurali": kural.get("yemek_paydasi"),
                           "planli_gun": planli,
                           "ihlal_gun": olcum.get("ihlal_gun"),
                           "kayit_yok_gun": olcum.get("kayit_yok_gun"),
                           "onayli_gun": olcum.get("onayli_gun"),
                           "iz": K.get("YEMEK", {}).get("iz")},
                    miktar=hak_gun, birim="gun",
                    birim_tutar=(aylik_yemek / payda) if payda else None,
                    ucret_tanim_id=K.get("YEMEK", {}).get("ucret_tanim_id"),
                    kural_id=kural_id))
            if hak_gun < payda:
                notlar.append(
                    "yemek: %d/%d gün hak doğdu (ihlal %s · kayıt yok %s · onaylı %s)"
                    % (hak_gun, payda, olcum.get("ihlal_gun"),
                       olcum.get("kayit_yok_gun"), olcum.get("onayli_gun")))
        else:
            # Vardiya HİÇ girilmemiş. Sahip doktrini: "vardiya ataması TEYİT
            # katmanıdır — yoksa sabit tanımdan aktarılır." Kayıp yerine TAM HAK
            # varsayılır ve DAMGALANIR (varsayim), ekran uyarsın.
            if not part:
                kalemler.append(_kalem(
                    "YEMEK", "OLCUM", aylik_yemek * donem_orani,
                    kaynak="varsayim_vardiya_yok", kanit_sinifi="varsayim",
                    kanit={"aylik_yemek": aylik_yemek,
                           "donem_orani": _r(donem_orani, 6),
                           "not": "vardiya hiç girilmemiş — tam hak VARSAYILDI"},
                    miktar=None, birim=None,
                    ucret_tanim_id=K.get("YEMEK", {}).get("ucret_tanim_id"),
                    kural_id=kural_id))
                notlar.append("yemek VARSAYIMDIR: vardiya kaydı hiç yok")

    # ── YOL ─────────────────────────────────────────────────────────────────
    yol = float(K.get("YOL", {}).get("tutar") or 0)
    if yol > 0 and gecen > 0 and aylik_gun > 0:
        gunluk = yol / aylik_gun
        kalemler.append(_kalem(
            "YOL", "SOZLESME", gunluk * gecen,
            kaynak=K.get("YOL", {}).get("kaynak") or "?", kanit_sinifi="sozlesme",
            kanit={"aylik_yol": yol, "aylik_gun": aylik_gun, "gecen_gun": gecen,
                   "iz": K.get("YOL", {}).get("iz")},
            miktar=gecen, birim="gun", birim_tutar=gunluk,
            ucret_tanim_id=K.get("YOL", {}).get("ucret_tanim_id"),
            kural_id=kural_id))

    net = _r(sum(k["tutar"] for k in kalemler))
    return {"surum": SURUM, "kalemler": kalemler, "net": net, "notlar": notlar,
            "eksen_toplam": {
                e: _r(sum(k["tutar"] for k in kalemler if k["eksen"] == e))
                for e in ("SOZLESME", "OLCUM", "KARAR", "MAHSUP")}}
