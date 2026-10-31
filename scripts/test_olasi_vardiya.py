"""Kasa "olası vardiya" kuralı (IS 5co · KASA_FARK_ESASLARI E5) — veritabanısız varyasyon testi.

Çalıştır: python scripts/test_olasi_vardiya.py   (çıkış 0 = hepsi tuttu)
"""
import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import evvel_yeni_kasa_api as k  # noqa: E402
import evvel_yeni_moduller as m  # noqa: E402

m.acik = lambda ad: True


def v(f1, f2, d1="normal", d2="normal"):
    return {"v1": {"kim": "Ayşe", "fark": f1, "durum": d1}, "v2": {"kim": "Ali", "fark": f2, "durum": d2}}


# (gün, Kasa açığı TL, vardiya kasası, beklenen vardiya ya da None)
DURUMLAR = [
    ("2026-11-02", 300, v(-310, 40), "1. vardiya"),     # çoğu 1. vardiyada, öbürü ±100 içinde
    ("2026-11-03", 300, v(-150, -140), None),           # yarı yarıya
    ("2026-11-04", 300, v(-20, -300), "2. vardiya"),    # çoğu 2. vardiyada
    ("2026-11-05", 300, v(-300, -150), None),           # öbür vardiya da 100 ₺'den fazla eksik
    ("2026-11-06", 300, v(-300, 0, d1="az"), None),     # bardak az → güvenilmez
    ("2026-11-07", 300, None, None),                    # vardiya hesabı yok
    ("2026-11-08", 500, v(-5, 0), None),                # Fable L6: küçük vardiya farkı büyük açığa yapışmaz
    ("2026-11-09", -300, v(300, 0), None),              # fazla — yalnız eksikte
]
veri = {("sube-zafer", g): vk for g, _, vk, _ in DURUMLAR if vk}
sahte = types.ModuleType("evvel_yeni_satis_api")
sahte.vardiya_kasalari = lambda aylar: veri
sys.modules["evvel_yeni_satis_api"] = sahte

C = {"sube:sube-zafer": {"tur": "sube", "sube_id": "sube-zafer"}}
fl = [{"id": i, "tur": "sayim", "f": tl * 100, "cep": "sube:sube-zafer", "tarih": g, "coz": None}
      for i, (g, tl, _, _) in enumerate(DURUMLAR)]
k._olasi_vardiya(fl, C)
hata = 0
for x, (g, _, _, bek) in zip(fl, DURUMLAR):
    olan = (x.get("olasi_vardiya") or {}).get("vardiya")
    if olan != bek:
        hata += 1
        print(f"✗ {g}: beklenen {bek}, çıkan {olan}")
print("tamam" if not hata else f"{hata} hata")
sys.exit(1 if hata else 0)
