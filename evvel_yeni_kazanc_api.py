"""📈 EVVEL YENİ · ŞUBE KAZANCI (2026-10-15) — gelir − şubenin KENDİ gideri.

Sahip kararları:
  · "Para şubenin ama bende duruyor" → kazanç PARANIN YERİNDEN bağımsız; Kasa'ya bakmaz.
  · "Şubeler sanki hiç borcu yokmuş gibi" → kredi / ev taksiti / patron şahsi YOK (patron katmanı).
  · "Hangi şube kâr ediyor, zarar edenin yükü hangisinin üstünde — bunu görmeliyim."
  · Ortak giderler (ortak personel dahil) şubelere CİRO payıyla yük gösterilir (IS 5db · Fable + Opus: kâr oranı döngüseldi —
    hiçbir şube zarara düşemiyor, Tema'nın açığı gizleniyordu); zarar eden açığı ayrı bilgi satırı, kimseye devredilmez.

Hiçbir şey yazmaz; Gelir ve Gider modüllerinin hesabını yan yana koyar (iki taraf KDV dahil).
"""

from decimal import Decimal
from typing import Optional

from fastapi import APIRouter

from evvel_yeni_gelir_api import gelir_ozet
from evvel_yeni_gider_api import KALEMLER, TURLER, gider_ozet

router = APIRouter(prefix="/api/evvel-yeni/kazanc", tags=["evvel-yeni-kazanc"])


def _r(x) -> float:
    return round(float(x or 0), 2)


# 📐 MARJ KATMANLARI (sahip 2 Kas "dünya sistemlerinde hesaplanan marjlar burada yok" · Fable + Codex L4b): KDV'siz net satış üzerinden
# brüt → katkı → FAVÖK (yaklaşık). FAVÖK = KDV dahil kazanç − tahmini ödenecek KDV → Kazanç ekranının ANA rakamı (sahip 2 Kas
# "KDV düşülmesi gerekiyor"); KDV dahil kazanç alanları değişmez, yanında gösterilir. Ödenecek KDV bir kez düşülür. Vergi, amortisman, kredi faizi YOK (veri yok — sonraki katman).
SATIS_KDV = Decimal("0.10")      # kafe satışı %10 (paket su / şişe ürün vb. farklı oranlar ayrıştırılmaz — tahmin)
FATURA_KDV = Decimal("0.20")     # elektrik / doğalgaz / internet %20 (su farklı olabilir — tahmin)
KATMAN_NOTU = ("KDV'siz katmanlar (tahmini): net satış = ciro ÷ 1,10 · brüt marj = net satış − mal (KDV hariç) · katkı payı = brüt − "
               "komisyon − dükkân − anlık · FAVÖK ≈ katkı − kira − personel − SGK − fatura (KDV hariç) − diğer − ortak pay (KDV dahil). Ödenecek KDV = "
               "satış KDV'si − mal KDV'si − fatura KDV'si (kira, komisyon, dükkân KDV'si dahil edilmedi; kesin rakam muhasebeciden). "
               "Vergi, amortisman ve kredi faizi bu katmanlarda YOK.")


def _yuzde(a, b):
    return round(a * 100 / b, 1) if b else None


def _katman(gelir: float, d: dict) -> dict:
    """Bir şubenin KDV'siz marj katmanları (FAVÖK ortak paydan sonra kazanc_ozet'te tamamlanır)."""
    g = Decimal(str(gelir or 0))
    net = g / (1 + SATIS_KDV)
    mal_kdv = Decimal(str(d.get("mal_kdv") or 0))
    fat = Decimal(str(d.get("fatura") or 0))
    fat_kdv = fat * FATURA_KDV / (1 + FATURA_KDV)
    if g <= 0:   # Fable L6: satışı olmayan şubede KDV mahsubu yok — KDV düşülmüş kazanç = KDV dahil kazanç (kart ile üst rakam tutar)
        mal_kdv = fat_kdv = Decimal(0)
    brut = net - (Decimal(str(d.get("mal") or 0)) - mal_kdv)
    katki = brut - sum(Decimal(str(d.get(k) or 0)) for k in ("komisyon", "dukkan", "anlik"))
    sabit = sum(Decimal(str(d.get(k) or 0)) for k in ("kira", "personel", "sgk", "diger")) + (fat - fat_kdv)
    n = float(net)
    return {"net_satis": _r(n), "satis_kdv": _r(float(g - net)), "mal_kdv": _r(float(mal_kdv)), "fatura_kdv": _r(float(fat_kdv)),
            "brut": _r(float(brut)), "brut_yuzde": _yuzde(float(brut), n), "katki": _r(float(katki)), "katki_yuzde": _yuzde(float(katki), n),
            "sabit": _r(float(sabit)), "odenecek_kdv": _r(float(g - net - mal_kdv - fat_kdv)),
            "kdv_varsayilan": int(d.get("kdv_varsayilan") or 0)}


@router.get("/ozet")
def kazanc_ozet(ay: Optional[str] = None):
    gel = gelir_ozet(ay)
    gid = gider_ozet(ay)
    gider_by = {s["cep"]: s for s in gid["subeler"]}
    # B83 (Fable 22 Eki): ay içinde gelir 'düne kadar', kira TAM AY tahakkuk → aynı paydaya indir. Gider defteri tam ay kalır
    # (tek gerçek); yalnız bu ekranda kira gün oranında. Personel zaten gün oranlı, mal/komisyon gün gün. Ay bitince oran 1.
    from datetime import date, timedelta
    from evvel_yeni_cekirdek import bugun as _bugun
    oran, gecen, ay_gun = 1.0, None, None
    if not gel["ay_bitti"]:
        ab, as_ = date.fromisoformat(str(gel["ay_basi"])[:10]), date.fromisoformat(str(gel["ay_sonu"])[:10])
        ay_gun = (as_ - ab).days + 1
        gecen = max(0, (min(_bugun() - timedelta(days=1), as_) - ab).days + 1)
        oran = gecen / ay_gun
    subeler = []
    for g in gel["subeler"]:
        d = dict(gider_by.get(g["cep"]) or {})
        kira_tam = _r(d.get("kira"))
        if oran < 1 and kira_tam:
            d["kira"] = _r(kira_tam * oran)
            d["toplam"] = _r(d.get("toplam")) - kira_tam + d["kira"]
        gelir = _r(g["toplam"])
        gider = _r(d.get("toplam"))
        if g.get("gizle") and not gider:
            continue   # B13: hareketsiz PASİF şube görünmez (gideri varsa görünür — gizli maliyet olmasın)
        uyarilar = []
        if gelir > 0 and not d.get("mal"):
            uyarilar.append("Mal tüketimi 0 (akşam bar sayımı yok) — kazanç ve ödenecek KDV olduğundan YÜKSEK görünür")
        if d.get("fiyat_eksik"):
            uyarilar.append(f"{d['fiyat_eksik']} ürünün fiyatı yok — gider eksik")
        if g.get("eksik_gunler"):
            uyarilar.append(f"{len(g['eksik_gunler'])} günün kapanışı eksik — gelir eksik")
        if d.get("kesin_olmayan_gun"):
            uyarilar.append(f"{len(d['kesin_olmayan_gun'])} gün kesinleşmedi")
        if d.get("kira_durum") == "tanimsiz":
            uyarilar.append("Kira tanımlı değil (Tanımlar → Şubeler)")
        if not d.get("personel"):
            uyarilar.append("Bu ay personel hak edişi yok (Personel › Maaşlar)")
        if gid.get("ay_bitti") and d.get("personel") and not ((gid.get("sgk_kayitlar") or {}).get("toplam")):   # SGK ertesi ay ödenir — biten ay;
            # o ay HİÇ SGK kaydı yoksa (norm tanımsızken ORTAK'a giden SGK yanlış alarm vermesin — Fable L6)
            uyarilar.append("Bu ay SGK kaydı yok (Ödeme › SGK) — kazanç olduğundan YÜKSEK görünür")
        km = _katman(gelir, d)
        subeler.append({
            "katman": km,
            # sahip 2 Kas "KDV düşülmesi gerekiyor · bunu da göstermeli" · Fable L4b: kartın büyük rakamı (ortak pay öncesi, tahmini KDV düşülmüş)
            "kazanc_kdvsiz": _r(gelir - gider - km["odenecek_kdv"]),
            "cep": g["cep"], "ad": g["ad"], "gelir": gelir, "gider": gider, "kazanc": _r(gelir - gider),
            "marj_yuzde": round((gelir - gider) * 100 / gelir, 1) if gelir else None,
            "gelir_kirilim": {"nakit": _r(g["nakit"]), "pos": _r(g["pos"]), "online": _r(g["online"])},
            "gider_kirilim": {k: _r(d.get(k)) for k in KALEMLER},
            "uyarilar": uyarilar,
            "kira_tam_ay": kira_tam if oran < 1 else None,
        })
    subeler.sort(key=lambda x: -x["kazanc_kdvsiz"])   # ekranda görünen büyük rakam neyse sıra o (Fable L4b)
    ortak = _r(gid["ortak"]["toplam"])
    kar = [s for s in subeler if s["kazanc"] > 0]
    zarar = [s for s in subeler if s["kazanc"] < 0]
    toplam_kar = sum(s["kazanc"] for s in kar)
    toplam_zarar = -sum(s["kazanc"] for s in zarar)
    # YÜK (IS 5db): ortak gider her şubeye CİRO payıyla; kâr / zarar devri YOK (zarar eden açığı yalnız bilgi)
    ciro_top = sum(s["gelir"] for s in subeler if s["gelir"] > 0)
    for s in subeler:
        pay = (s["gelir"] / ciro_top) if (ciro_top and s["gelir"] > 0) else 0
        s["ciro_payi"] = round(pay * 100, 1)
        s["tasidigi_yuk"] = _r(ortak * pay)
        s["yuk_sonrasi"] = _r(s["kazanc"] - ortak * pay)
        s["tasidiklari"] = [{"ad": f"Ortak giderler (ciro payı %{s['ciro_payi']})", "tutar": _r(ortak * pay)}] if (ortak and pay) else []
    isletme = _r(sum(s["kazanc"] for s in subeler) - ortak)
    for s in subeler:   # FAVÖK (yaklaşık) ortak pay SONRASI — katmanın son basamağı
        k = s["katman"]
        k["favok"] = _r(k["katki"] - k["sabit"] - s["tasidigi_yuk"])
        k["favok_yuzde"] = _yuzde(k["favok"], k["net_satis"])
    kt = {a: _r(sum(s["katman"][a] for s in subeler)) for a in ("net_satis", "satis_kdv", "mal_kdv", "fatura_kdv", "brut", "katki", "odenecek_kdv")}
    kt["favok"] = _r(sum(s["katman"]["favok"] for s in subeler) - (ortak - sum(s["tasidigi_yuk"] for s in subeler)))
    for a in ("brut", "katki", "favok"):
        kt[a + "_yuzde"] = _yuzde(kt[a], kt["net_satis"])
    kt["kdv_varsayilan"] = sum(s["katman"]["kdv_varsayilan"] for s in subeler)
    return {
        "ay": gel["ay"], "ay_basi": gel["ay_basi"], "ay_bitti": gel["ay_bitti"], "turler": TURLER,
        "gelir": _r(gel["toplam"]), "sube_gideri": _r(sum(s["gider"] for s in subeler)), "ortak_gider": ortak,
        "ay_ici": {"gecen_gun": gecen, "ay_gun": ay_gun} if oran < 1 else None,
        "isletme_kazanci": isletme, "subeler": subeler, "katman": kt, "katman_notu": KATMAN_NOTU,
        "zarar_eden_acigi": _r(toplam_zarar), "kar_edenlerin_kari": _r(toplam_kar),
        "cekis_toplam": _r(gid["cekis_toplam"]),
        "not": "Ana rakam KDV DÜŞÜLMÜŞ kazanç (≈, tahmini ödenecek KDV düşüldü; KDV dahil kazanç yanında). Kazanç = gelir (kapanış, KDV dahil) − şubenin kendi gideri (mal=sayımdan tüketim × fiyat, kira, personel, fatura, "
               "dükkân, komisyon, SGK işveren primi; personel ve SGK kadro normu oranında). Kredi, ev taksiti ve patron şahsi DAHİL DEĞİL. Ortak giderler "
               "(ortak personel dahil) şubelere CİRO payıyla yük olarak gösterilir; zarar eden şubenin açığı kimseye devredilmez.",
    }
