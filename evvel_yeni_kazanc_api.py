"""📈 EVVEL YENİ · ŞUBE KAZANCI (2026-10-15) — gelir − şubenin KENDİ gideri.

Sahip kararları:
  · "Para şubenin ama bende duruyor" → kazanç PARANIN YERİNDEN bağımsız; Kasa'ya bakmaz.
  · "Şubeler sanki hiç borcu yokmuş gibi" → kredi / ev taksiti / patron şahsi YOK (patron katmanı).
  · "Hangi şube kâr ediyor, zarar edenin yükü hangisinin üstünde — bunu görmeliyim."
  · Ortak giderler şubelere DAĞITILMAZ; ayrı satırda işletme toplamından düşer.

Hiçbir şey yazmaz; Gelir ve Gider modüllerinin hesabını yan yana koyar (iki taraf KDV dahil).
"""

from typing import Optional

from fastapi import APIRouter

from evvel_yeni_gelir_api import gelir_ozet
from evvel_yeni_gider_api import KALEMLER, TURLER, gider_ozet

router = APIRouter(prefix="/api/evvel-yeni/kazanc", tags=["evvel-yeni-kazanc"])


def _r(x) -> float:
    return round(float(x or 0), 2)


@router.get("/ozet")
def kazanc_ozet(ay: Optional[str] = None):
    gel = gelir_ozet(ay)
    gid = gider_ozet(ay)
    gider_by = {s["cep"]: s for s in gid["subeler"]}
    subeler = []
    for g in gel["subeler"]:
        d = gider_by.get(g["cep"]) or {}
        gelir = _r(g["toplam"])
        gider = _r(d.get("toplam"))
        uyarilar = []
        if gelir > 0 and not d.get("mal"):
            uyarilar.append("Ürün aç girilmemiş — mal gideri 0, kazanç olduğundan YÜKSEK görünür")
        if d.get("fiyat_eksik"):
            uyarilar.append(f"{d['fiyat_eksik']} ürünün fiyatı yok — gider eksik")
        if g.get("eksik_gunler"):
            uyarilar.append(f"{len(g['eksik_gunler'])} günün kapanışı eksik — gelir eksik")
        if d.get("kesin_olmayan_gun"):
            uyarilar.append(f"{len(d['kesin_olmayan_gun'])} gün kesinleşmedi")
        if not d.get("kira"):
            uyarilar.append("Bu ay kira girilmemiş")
        if not d.get("personel"):
            uyarilar.append("Bu ay personel ödemesi girilmemiş")
        subeler.append({
            "cep": g["cep"], "ad": g["ad"], "gelir": gelir, "gider": gider, "kazanc": _r(gelir - gider),
            "marj_yuzde": round((gelir - gider) * 100 / gelir, 1) if gelir else None,
            "gelir_kirilim": {"nakit": _r(g["nakit"]), "pos": _r(g["pos"]), "online": _r(g["online"])},
            "gider_kirilim": {k: _r(d.get(k)) for k in KALEMLER},
            "uyarilar": uyarilar,
        })
    subeler.sort(key=lambda x: -x["kazanc"])
    ortak = _r(gid["ortak"]["toplam"])
    kar = [s for s in subeler if s["kazanc"] > 0]
    zarar = [s for s in subeler if s["kazanc"] < 0]
    toplam_kar = sum(s["kazanc"] for s in kar)
    toplam_zarar = -sum(s["kazanc"] for s in zarar)
    # YÜK: zarar edenlerin açığı + ortak gider, kâr edenlerin kârı ORANINDA onların üstündedir
    yuk_toplam = toplam_zarar + ortak
    for s in subeler:
        if s["kazanc"] > 0 and toplam_kar:
            pay = s["kazanc"] / toplam_kar
            s["tasidigi_yuk"] = _r(yuk_toplam * pay)
            s["yuk_sonrasi"] = _r(s["kazanc"] - yuk_toplam * pay)
            s["tasidiklari"] = [{"ad": z["ad"], "tutar": _r(-z["kazanc"] * pay)} for z in zarar] + \
                               ([{"ad": "Ortak giderler", "tutar": _r(ortak * pay)}] if ortak else [])
        else:
            s["tasidigi_yuk"] = 0.0
            s["yuk_sonrasi"] = s["kazanc"]
            s["tasidiklari"] = []
    isletme = _r(sum(s["kazanc"] for s in subeler) - ortak)
    return {
        "ay": gel["ay"], "ay_basi": gel["ay_basi"], "ay_bitti": gel["ay_bitti"], "turler": TURLER,
        "gelir": _r(gel["toplam"]), "sube_gideri": _r(gid["sube_toplam"]), "ortak_gider": ortak,
        "isletme_kazanci": isletme, "subeler": subeler,
        "zarar_eden_acigi": _r(toplam_zarar), "kar_edenlerin_kari": _r(toplam_kar),
        "cekis_toplam": _r(gid["cekis_toplam"]),
        "not": "Kazanç = gelir (kapanış, KDV dahil) − şubenin kendi gideri (mal=ürün aç × fiyat, kira, personel, fatura, "
               "dükkân, komisyon). Kredi, ev taksiti ve patron şahsi DAHİL DEĞİL. Zarar eden şubelerin açığı ve ortak "
               "giderler, kâr eden şubelerin üstüne kârları oranında yük olarak gösterilir.",
    }
