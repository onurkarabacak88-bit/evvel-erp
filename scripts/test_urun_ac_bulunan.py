# -*- coding: utf-8 -*-
"""📖 BULUNDU DOKTRINI birim testi — GERCEK motora karsi (sahte imlecle).

Kural: hareket defterindeki HER satir kendi aritmetigini saglamali:
    sonraki_miktar - onceki_miktar == miktar   (isaretli)

Eskiden depoda 0 varken 50 acilinca TEK satir yaziliyordu:
    miktar=-50, onceki=0, sonraki=0   ->  0-0 = 0 != -50
90 gunde 120 satir / 3.815 adet boyle gorunmez oldu.
Artik: SAYIM_DUZELTME +50 (0->50) ve URUN_AC -50 (50->0). Stok sonucu yine 0.
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import operasyon_stok_motor as M  # noqa: E402


class SahteCur:
    """Testin ihtiyaci kadar: depo stok SELECT'i, UPDATE, hareket INSERT'i."""

    def __init__(self, mevcut):
        self.mevcut = mevcut          # depodaki defter adedi (None = satir yok)
        self.hareketler = []
        self.rowcount = 1
        self._son = None

    def execute(self, sql, params=None):
        s = " ".join(str(sql).split())
        self._son = None
        if s.startswith("SELECT mevcut_adet FROM sube_depo_stok"):
            self._son = None if self.mevcut is None else {"mevcut_adet": self.mevcut}
        elif "UPDATE sube_depo_stok" in s and "GREATEST(0" in s:
            if self.mevcut is None:
                self.rowcount = 0
                return
            self.mevcut = max(0, self.mevcut - (params[0] if params else 0))
            self.rowcount = 1
            return
        elif "INSERT INTO sube_depo_stok_hareket" in s:
            tur = ("SAYIM_DUZELTME" if "'SAYIM_DUZELTME'" in s
                   else ("URUN_AC" if "'URUN_AC'" in s else "?"))
            self.hareketler.append({
                "tur": tur, "miktar": params[3], "onceki": params[4],
                "sonraki": params[5], "kaynak_tip": params[6] if len(params) > 6 else "",
            })
            self.rowcount = 1
            return
        elif s.startswith("SELECT"):
            self._son = {}
        self.rowcount = 1

    def fetchone(self):
        return self._son

    def fetchall(self):
        return []


def kos(ad, mevcut, ac, bekle_satir, bekle_bulunan, defter_satiri=True):
    cur = SahteCur(mevcut)
    try:
        M.sube_depo_stok_depo_cikis_dus(cur, "SUBE1", "K1", "Test Kalem", ac,
                                        defter_satiri=defter_satiri)
    except Exception as e:  # noqa: BLE001
        print("  KALDI  %s -> HATA %s: %s" % (ad, type(e).__name__, str(e)[:70]))
        return False

    har = cur.hareketler
    yalanci = []
    for h in har:
        try:
            if abs((float(h["sonraki"]) - float(h["onceki"])) - float(h["miktar"])) > 0.01:
                yalanci.append(h)
        except (TypeError, ValueError):
            pass
    bulunan = sum(float(h["miktar"]) for h in har if h["tur"] == "SAYIM_DUZELTME")
    urun_ac = sum(1 for h in har if h["tur"] == "URUN_AC")

    ok = (not yalanci) and len(har) == bekle_satir and abs(bulunan - bekle_bulunan) < 0.01 \
        and cur.mevcut == max(0, (mevcut or 0) - ac) \
        and (urun_ac == (1 if defter_satiri else 0))
    print("  %s  %s" % ("GECTI" if ok else "KALDI", ad))
    print("         satir=%d (bek %d) · bulunan=%g (bek %g) · URUN_AC=%d · stok=%s"
          % (len(har), bekle_satir, bulunan, bekle_bulunan, urun_ac, cur.mevcut))
    for h in har:
        print("           %-15s %+8g  %s -> %s   [%s]"
              % (h["tur"], h["miktar"], h["onceki"], h["sonraki"], h["kaynak_tip"]))
    if yalanci:
        print("         🔴 ARITMETIGI TUTMAYAN SATIR: %s" % yalanci)
    return ok


def mahsup_kapali_mi():
    """Sessiz borc mahsubu gercekten devre disi mi? SQL suzgeci ile kapatildi."""
    src = io.open(os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "operasyon_stok_motor.py"), encoding="utf-8").read()
    ok = ("WHERE %s = 'borc'" in src
          and "(STOK_CIKIS_DOKTRIN, sube_id, kk)" in src
          and M.STOK_CIKIS_DOKTRIN == "bulundu")
    print("  %s  6) sessiz borc mahsubu devre disi (doktrin=%s)"
          % ("GECTI" if ok else "KALDI", M.STOK_CIKIS_DOKTRIN))
    return ok


print("BULUNDU DOKTRINI — gercek motora karsi")
s = []
s.append(kos("1) defter yeterli (depo 20, ac 5) -> tek satir", 20, 5, 1, 0))
s.append(kos("2) defter tam yeterli (depo 5, ac 5) -> tek satir", 5, 5, 1, 0))
s.append(kos("3) defter kismen (depo 3, ac 5) -> bulunan 2", 3, 5, 2, 2))
s.append(kos("4) defter SIFIR (depo 0, ac 50) -> bulunan 50", 0, 50, 2, 50))
s.append(kos("5) FIRE yolu (depo 0, ac 2, defter_satiri=False) -> URUN_AC YOK",
             0, 2, 1, 2, defter_satiri=False))
s.append(mahsup_kapali_mi())

print()
print("SONUC: %d/%d gecti" % (sum(1 for x in s if x), len(s)))
sys.exit(0 if all(s) else 1)
