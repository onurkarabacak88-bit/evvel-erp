# -*- coding: utf-8 -*-
"""👻 BULUNAN STOK birim testi — GERCEK sevk_cikti_kaydet'e karsi (sahte imlecle).

Kural: hareket defterindeki HER satir kendi aritmetigini saglamali:
    sonraki_miktar - onceki_miktar == miktar   (isaretli)

Eskiden depoda 0 varken 12 sevk edilince TEK satir yaziliyordu:
    miktar=-12, onceki=0, sonraki=0   ->  0-0 = 0 != -12   (satir kendini yalanliyor)
Artik iki satir yaziliyor:
    SAYIM_DUZELTME +12 (0 -> 12)  ve  SEVK_CIKIS -12 (12 -> 0)
Ikisi de kurali saglar, stok sonucu yine 0'dir.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import operasyon_stok_motor as M  # noqa: E402


class SahteCur:
    """Testin ihtiyaci kadar: talep SELECT'i, depo stok SELECT'i, hareket INSERT'i."""

    def __init__(self, depo_mevcut):
        self.depo_mevcut = depo_mevcut      # {kalem_kodu: defterdeki adet}
        self.hareketler = []                # yazilan defter satirlari
        self.rowcount = 1
        self._son = None

    def execute(self, sql, params=None):
        s = " ".join(str(sql).split())
        self._son = None
        if s.startswith("SELECT sube_id,") and "siparis_talep" in s:
            self._son = {"sube_id": "SUBE1", "kaynak_depo_sube_id": "DEPO1",
                         "durum": "hazirlaniyor", "kalem_durumlari": json.dumps([])}
        elif "SELECT MAX(COALESCE(mevcut_adet" in s:
            kodlar = params[1] if params and len(params) > 1 else []
            deger = None
            for k in (kodlar or []):
                if k in self.depo_mevcut:
                    deger = self.depo_mevcut[k]
                    break
            self._son = {"m": deger}
        elif "INSERT INTO sube_depo_stok_hareket" in s:
            # (id, sube, kod, ad, miktar, onceki, sonraki, yid, aciklama)
            tur = "SAYIM_DUZELTME" if "'SAYIM_DUZELTME'" in s else "SEVK_CIKIS"
            self.hareketler.append({
                "tur": tur, "kalem": params[2], "miktar": params[4],
                "onceki": params[5], "sonraki": params[6],
            })
        elif s.startswith("SELECT"):
            self._son = {}
        self.rowcount = 1

    def fetchone(self):
        return self._son

    def fetchall(self):
        return []


def kos(ad, defter_mevcut, sevk_adet, bekle_satir, bekle_bulunan):
    cur = SahteCur({"K1": defter_mevcut})
    try:
        M.sevk_cikti_kaydet(
            cur, "TALEP1",
            [{"kalem_kodu": "K1", "urun_ad": "Test Kalem", "adet": sevk_adet}],
            "u1", "Test")
    except Exception as e:  # noqa: BLE001
        print("  KALDI  %s -> HATA %s: %s" % (ad, type(e).__name__, str(e)[:70]))
        return False

    har = cur.hareketler
    # 1) Her satir kendi aritmetigini saglamali
    yalanci = []
    for h in har:
        try:
            fark = float(h["sonraki"]) - float(h["onceki"])
            if abs(fark - float(h["miktar"])) > 0.01:
                yalanci.append(h)
        except (TypeError, ValueError):
            pass
    bulunan = sum(float(h["miktar"]) for h in har if h["tur"] == "SAYIM_DUZELTME")
    # 2) Net stok etkisi degismemeli: toplam hareket = -(gercekte dusen)
    net = sum(float(h["miktar"]) for h in har)
    bekle_net = -min(defter_mevcut, sevk_adet) if defter_mevcut is not None else -sevk_adet

    ok = (not yalanci) and len(har) == bekle_satir and abs(bulunan - bekle_bulunan) < 0.01 \
        and abs(net - bekle_net) < 0.01
    print("  %s  %s" % ("GECTI" if ok else "KALDI", ad))
    print("         satir=%d (beklenen %d) · bulunan=%g (beklenen %g) · net=%g (beklenen %g)"
          % (len(har), bekle_satir, bulunan, bekle_bulunan, net, bekle_net))
    for h in har:
        print("           %-15s miktar=%+g  %s -> %s" % (h["tur"], h["miktar"], h["onceki"], h["sonraki"]))
    if yalanci:
        print("         🔴 ARITMETIGI TUTMAYAN SATIR: %s" % yalanci)
    return ok


print("BULUNAN STOK — gercek motora karsi")
sonuc = []
# defterde yeterli varsa: tek satir, bulunan yok
sonuc.append(kos("1) defter yeterli (mevcut 20, sevk 12) -> tek satir",
                 20, 12, bekle_satir=1, bekle_bulunan=0))
# defter TAM yeterli (sinir)
sonuc.append(kos("2) defter tam yeterli (mevcut 12, sevk 12) -> tek satir",
                 12, 12, bekle_satir=1, bekle_bulunan=0))
# defter kismen yeterli
sonuc.append(kos("3) defter kismen (mevcut 9, sevk 12) -> bulunan 3",
                 9, 12, bekle_satir=2, bekle_bulunan=3))
# defter SIFIR — canli vakanin ta kendisi (Mango 0/12)
sonuc.append(kos("4) defter SIFIR (mevcut 0, sevk 12) -> bulunan 12",
                 0, 12, bekle_satir=2, bekle_bulunan=12))
# buyuk fark (Redbull 2/72 vakasi)
sonuc.append(kos("5) buyuk fark (mevcut 2, sevk 72) -> bulunan 70",
                 2, 72, bekle_satir=2, bekle_bulunan=70))

print()
print("SONUC: %d/%d gecti" % (sum(1 for x in sonuc if x), len(sonuc)))
sys.exit(0 if all(sonuc) else 1)
