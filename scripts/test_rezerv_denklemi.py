# -*- coding: utf-8 -*-
"""D-8 birim testi — GERCEK sevk_cikti_kaydet'e karsi (sahte imlecle)."""
import json, sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import operasyon_stok_motor as M


class SahteCur:
    """Yalnizca bu testin ihtiyaci kadar: SELECT talep, UPDATE stok, INSERT iz."""
    def __init__(self, kd, rezerv):
        self.kd = kd
        self.rezerv = rezerv          # {kalem_kodu: rezerve_adet}
        self.stok_dusum = []          # (kalem, mevcut_dus, rezerv_dus)
        self.rowcount = 1
        self._son = None
        self.yazilan_kd = None

    def execute(self, sql, params=None):
        s = " ".join(str(sql).split())
        self._son = None
        if s.startswith("SELECT sube_id,") and "siparis_talep" in s:
            self._son = {"sube_id": "SUBE1", "kaynak_depo_sube_id": "DEPO1",
                         "durum": "hazirlaniyor",
                         "kalem_durumlari": json.dumps(self.kd, ensure_ascii=False)}
        elif "UPDATE sube_depo_stok" in s and "rezerve_adet" in s:
            mev, rez, _sube, kod = params
            self.rezerv[kod] = max(0, self.rezerv.get(kod, 0) - rez)
            self.stok_dusum.append((kod, mev, rez))
            self.rowcount = 1
        elif "UPDATE siparis_talep SET kalem_durumlari" in s:
            self.yazilan_kd = json.loads(params[0])
        elif s.startswith("SELECT"):
            self._son = {}
        self.rowcount = 1

    def fetchone(self): return self._son
    def fetchall(self): return []


def kos(ad, kd, sevk, bekle_rez, bekle_defter):
    cur = SahteCur([dict(x) for x in kd], {"K": 10, "A": 5, "B": 0})
    try:
        M.sevk_cikti_kaydet(cur, "TALEP1", sevk, "u1", "Test")
    except Exception as e:
        print(f"  {ad}: HATA {type(e).__name__}: {str(e)[:70]}")
        return
    rez = sum(d[2] for d in cur.stok_dusum)
    defter = None
    if cur.yazilan_kd:
        defter = [x.get("tahsis_adet") for x in cur.yazilan_kd]
    else:
        defter = [x.get("tahsis_adet") for x in kd]
    ok = (rez == bekle_rez) and (defter == bekle_defter)
    print(f"  {'GECTI' if ok else 'KALDI'}  {ad}")
    print(f"         rezerv dusumu={rez} (beklenen {bekle_rez}) · defter={defter} (beklenen {bekle_defter})")


print("D-8 REZERV DENKLEMI — gercek motora karsi")
kos("1) tahsissiz sevk, baskasinin rezervini yemez",
    [{"kalem_kodu": "K", "urun_ad": "Sut", "tahsis_adet": 0, "istenen_adet": 8}],
    [{"kalem_kodu": "K", "urun_ad": "Sut", "sevk_adet": 8}], 0, [0])
kos("2) tahsisli tam sevk, defter sifirlanir",
    [{"kalem_kodu": "K", "urun_ad": "Sut", "tahsis_adet": 5, "istenen_adet": 5}],
    [{"kalem_kodu": "K", "urun_ad": "Sut", "sevk_adet": 5}], 5, [0])
kos("3) tahsisten fazla sevk, yalniz tahsis kadar duser",
    [{"kalem_kodu": "K", "urun_ad": "Sut", "tahsis_adet": 3, "istenen_adet": 10}],
    [{"kalem_kodu": "K", "urun_ad": "Sut", "sevk_adet": 8}], 3, [0])
kos("4) kismi sevk, kalan tahsis defterde durur",
    [{"kalem_kodu": "K", "urun_ad": "Sut", "tahsis_adet": 10, "istenen_adet": 10}],
    [{"kalem_kodu": "K", "urun_ad": "Sut", "sevk_adet": 4}], 4, [6])
kos("5) id'siz kalem, Turkce I ile ad eslesmesi",
    [{"kalem_kodu": "", "urun_id": "", "urun_ad": "FİLTRE KAHVE", "tahsis_adet": 6, "istenen_adet": 6}],
    [{"kalem_kodu": "K", "urun_ad": "Filtre Kahve", "sevk_adet": 6}], 6, [0])
kos("6) iki kalem karismaz (biri tahsisli biri degil)",
    [{"kalem_kodu": "A", "urun_ad": "Sut", "tahsis_adet": 5, "istenen_adet": 5},
     {"kalem_kodu": "B", "urun_ad": "Ayran", "tahsis_adet": 0, "istenen_adet": 7}],
    [{"kalem_kodu": "A", "urun_ad": "Sut", "sevk_adet": 5},
     {"kalem_kodu": "B", "urun_ad": "Ayran", "sevk_adet": 7}], 5, [0, 0])
