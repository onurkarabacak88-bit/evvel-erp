"""🔍 EVVEL YENİ · SATIŞ KONTROLÜ (2026-10-16) — "bu kadar bardak gittiyse kasaya şu kadar girmeliydi".

Sahip: "Ürün aç mantığından satışları hesaplatıyorduk ve kasada farkı hesaplatıyorduk — bununla ilgili bir alan kur."
Eski sistemde 19 ayrı, birbirini tutmayan hesap vardı (bardak+süt litresi+peçete+pasta(iki kez) karışık toplam,
sabit fiyat, Evo ortalaması). Evvel Yeni'de TEK hesap:

  KULLANILAN BARDAK  = Bar sayımının günlük NET EKSİLMESİ (8oz + 14oz + plastik)  [evvel_yeni_bar_api]
  BARDAK BAŞINA CİRO = şubenin ÖNCEKİ (en çok 14) TEMİZ gününde Σciro / Σbardak  (bugün hariç; en az 5 gün)
  BEKLENEN CİRO      = bugünkü bardak × bardak başına ciro
  GERÇEK CİRO        = kapanış nakit + POS + online  [Kasa 'kapanis']
  Aynısı NAKİT için de (kayıt dışı satış şüphesi yalnız nakitte anlamlı; POS kayıt dışı yapılamaz).

TEMİZ GÜN = açılış + kapanış sayımı var, üç bardak da sayılmış, hiçbir bardakta ürün aç eksik (net<0) yok,
kapanış Evo tahmini DEĞİL, en az 10 bardak. Temiz olmayan gün HESAPLANMAZ (sebebi yazılır).
Sapma eşiğin altındaysa yalnız "bakılacak gün" işareti — kimseye suç yazılmaz. YALNIZ OKUR.
"""

import logging
from datetime import date, timedelta
from statistics import median
from typing import Optional

from fastapi import APIRouter

from database import db

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/evvel-yeni/satis", tags=["evvel-yeni-satis"])

BARDAKLAR = ("bardak_kucuk", "bardak_buyuk", "bardak_plastik")
# Codex (2026-10-16): %25 TEK BAŞINA kullanılmaz; şubenin kendi dalgalanması (medyan ± MAD) ve TL tabanıyla birlikte.
# Aşamalı güven: <14 temiz gün → yalnız veri birikir; 14–27 → geçici referans; ≥28 → tam. Geçmiş: son 56 takvim günü.
PENCERE_GUN = 56
GECICI_GUN = 14
TAM_GUN = 28
MIN_BARDAK = 10
ESIK_ORAN = 0.25      # beklenenin en az %25'i kadar eksik
MAD_KAT = 3           # ve şubenin günlük yayılımının 3 katı
TL_TABAN = 500        # ve en az 500 ₺
DEVIR_SINIR = 5       # bardak devir farkı bundan büyükse gün temiz değil


def _ay_onceki(ay: str) -> str:
    y, m = int(ay[:4]), int(ay[5:7]) - 1
    return f"{y - 1:04d}-12" if m == 0 else f"{y:04d}-{m:02d}"


def _gunluk(ay: str) -> dict:
    """{(sube_id, gun): {bardak, ciro, nakit, neden}} — bar sayımı + kasa kapanışı, iki ay."""
    from evvel_yeni_bar_api import bar_ozet
    from evvel_yeni_kasa_api import _hazirla, _yukle
    out = {}
    for a in (_ay_onceki(_ay_onceki(ay)), _ay_onceki(ay), ay):
        try:
            b = bar_ozet(a)
        except Exception as e:  # noqa: BLE001
            log.warning("satış kontrolü: bar okunamadı %s: %s", a, str(e)[:120])
            continue
        for s in b["subeler"]:
            for g in s["gunler"]:
                k = {x["kod"]: x for x in g["kalemler"]}
                nets = [k[c]["net_eksilme"] for c in BARDAKLAR]
                neden = None
                if g["durum"] in ("kapanis_yok", "acilis_yok"):
                    neden = "sayım yok"
                elif any(n is None for n in nets):
                    neden = "bardak sayılmamış"
                elif any(n < 0 for n in nets):
                    neden = "ürün aç eksik (bardak eksiye düştü)"
                elif any(abs(k[c]["devir_fark"] or 0) > DEVIR_SINIR for c in BARDAKLAR):
                    neden = "bardak devir farkı büyük (dün akşam ≠ bu sabah)"
                out[(s["sube_id"], g["gun"])] = {"bardak": sum(n for n in nets if n is not None and n > 0), "neden": neden,
                                                 "bardak_kalem": {c: k[c]["net_eksilme"] for c in BARDAKLAR}}
    _hazirla()
    with db() as (conn, cur):
        cep_list, C, kayit, _ = _yukle(cur, tum_donemler=True)
    for h in kayit:
        if h["tur"] != "kapanis":
            continue
        sid = (C.get(h["cep"]) or {}).get("sube_id")
        if not sid:
            continue
        v = h["veri"]
        nakit = int(h["tutar"])
        pos = int(v.get("pos", 0)) if "pos" in v else int(v.get("kart", 0))
        onl = int(v.get("online", 0)) if "pos" in v else 0
        d = out.setdefault((str(sid), h["is_gunu"]), {"bardak": 0, "neden": "sayım yok", "bardak_kalem": {}})
        d["ciro"] = (nakit + pos + onl) / 100
        d["nakit"] = nakit / 100
        d["evo"] = v.get("eski_kaynak") == "evo_taslak"
        d["onayli"] = h.get("durum") == "onaylandi"
    for d in out.values():
        if d.get("ciro") is None and not d["neden"]:
            d["neden"] = "kapanış cirosu yok"
        elif d.get("evo") and not d["neden"]:
            d["neden"] = "kapanış Evo tahmini (şube kapanış yapmadı)"
        elif not d["neden"] and not d.get("onayli"):
            d["neden"] = "kapanış henüz onaylanmadı"
        elif not d["neden"] and d["bardak"] < MIN_BARDAK:
            d["neden"] = f"çok az bardak ({d['bardak']})"
    # Kör kasa sayımı (aynı gün, akşam) — yan yana gösterilir, ciroyla TOPLANMAZ
    for h in kayit:
        if h["tur"] == "sayim" and (h.get("kaynak_ref") or "").startswith("sayim_kapanis:"):
            sid = (C.get(h["cep"]) or {}).get("sube_id")
            d = out.get((str(sid), h["is_gunu"]))
            if d is not None:
                v = h["veri"]
                d["kasa_fark"] = (int(v.get("beklenen", 0)) - int(v.get("sayilan", 0))) / 100
                d["kasa_baslangic"] = bool(v.get("baslangic"))
    return out


def _mad(xs, m):
    return median([abs(x - m) for x in xs]) if xs else 0


@router.get("/kontrol")
def satis_kontrol(ay: Optional[str] = None):
    from evvel_yeni_kasa_api import _bugun
    from evvel_yeni_tanim_api import subeler as _ey_subeler
    bugun = _bugun()
    a_ = (ay or bugun.strftime("%Y-%m"))[:7]
    G = _gunluk(a_)
    with db() as (conn, cur):
        subeler = _ey_subeler(cur)
    ay_bas = date.fromisoformat(a_ + "-01")
    sonuc = []
    for s in subeler:
        sid = s["id"]
        temiz = sorted((g, d) for (ss, g), d in G.items() if ss == sid and not d["neden"])
        gunler = []
        g = ay_bas
        while g.month == ay_bas.month and g <= bugun:
            gi = g.isoformat()
            d = G.get((sid, gi)) or {"bardak": 0, "neden": "sayım yok"}
            sinir = (g - timedelta(days=PENCERE_GUN)).isoformat()
            gecmis = [x for x in temiz if sinir <= x[0] < gi]
            satir = {"gun": gi, "bardak": d.get("bardak"), "ciro": d.get("ciro"), "nakit": d.get("nakit"), "neden": d["neden"],
                     "bardak_kalem": d.get("bardak_kalem") or {}, "gecmis_gun": len(gecmis),
                     "kasa_fark": d.get("kasa_fark"), "kasa_baslangic": d.get("kasa_baslangic")}
            if not d["neden"] and gecmis:
                oranlar = [x[1]["ciro"] / x[1]["bardak"] for x in gecmis if x[1]["bardak"]]
                m = median(oranlar)
                s_ = 1.4826 * _mad(oranlar, m)
                bek = d["bardak"] * m
                eksik = bek - d["ciro"]
                esik_tl = max(ESIK_ORAN * bek, MAD_KAT * s_ * d["bardak"], TL_TABAN)
                guven = "tam" if len(gecmis) >= TAM_GUN else "gecici" if len(gecmis) >= GECICI_GUN else "birikiyor"
                satir.update(oran=round(m, 2), yayilim=round(s_, 2), beklenen=round(bek, 2),
                             aralik_alt=round(bek - esik_tl, 2), sapma=round((d["ciro"] - bek) / bek * 100, 1) if bek else None,
                             eksik_tl=round(eksik, 2), esik_tl=round(esik_tl, 2), guven=guven)
                if guven == "birikiyor":
                    satir["durum"] = "birikiyor"
                    satir["neden"] = f"({len(gecmis)}/{GECICI_GUN} temiz gün) — uyarı verilmez"
                else:
                    satir["durum"] = "bak" if eksik >= esik_tl else "normal"
            elif not d["neden"]:
                satir["neden"] = "karşılaştırılacak geçmiş temiz gün yok"
            satir.setdefault("durum", "hesaplanmadi")
            gunler.append(satir)
            g += timedelta(days=1)
        sonuc.append({"sube_id": sid, "ad": s["ad"], "gunler": gunler,
                      "temiz_gun": len(temiz),
                      "ozet": {"bak": sum(1 for x in gunler if x["durum"] == "bak"), "normal": sum(1 for x in gunler if x["durum"] == "normal"),
                               "birikiyor": sum(1 for x in gunler if x["durum"] == "birikiyor"),
                               "hesaplanmadi": sum(1 for x in gunler if x["durum"] == "hesaplanmadi"),
                               "beklenen": round(sum(x.get("beklenen") or 0 for x in gunler), 2),
                               "gercek": round(sum(x["ciro"] or 0 for x in gunler if x.get("beklenen")), 2)}})
    return {"ay": a_, "kural": {"esik_oran": ESIK_ORAN, "mad_kat": MAD_KAT, "tl_taban": TL_TABAN, "gecici_gun": GECICI_GUN,
                                "tam_gun": TAM_GUN, "pencere_gun": PENCERE_GUN}, "subeler": sonuc,
            "not": "Beklenen ciro = bugün kullanılan bardak (8oz+14oz+plastik) × şubenin önceki temiz günlerinde bardak başına "
                   "cironun MEDYANI. 'İncele' için eksik; beklenenin %25'inden, şubenin günlük dalgalanmasının 3 katından ve 500 ₺'den "
                   "büyük olmalı. 14 temiz gün birikmeden uyarı verilmez (28 günde tam güven). Kör kasa farkı yan yana gösterilir, ciroyla "
                   "toplanmaz. Sebep fire, ikram, kayıt dışı satış ya da sayım hatası olabilir — kimseye suç yazılmaz."}


@router.get("/gun")
def satis_gun(gun: Optional[str] = None):
    """GÜNLÜK DÖKÜM (sahip: "bugün 14 adet 8oz vs. görmek istiyorum; kasada açık var mı, satıştan gelen açık var mı;
    satıştan kaynaklı fireyi de görmeli"). Şube şube: kalem kalem sabah · giren · akşam · KULLANILAN · FİRE · SATILAN,
    fire listesi (sebep), ciro, bardaktan BEKLENEN ciro → SATIŞTAN AÇIK, kör kasa sayımı → KASA AÇIĞI."""
    import json as _json
    from evvel_yeni_bar_api import bar_ozet, _kod_anahtar, _anahtar_ad, KALEMLER
    from evvel_yeni_kasa_api import _bugun, _hazirla, _yukle
    g_ = (gun or (_bugun() - timedelta(days=1)).isoformat())[:10]
    ay = g_[:7]
    bar = {s["sube_id"]: s for s in bar_ozet(ay)["subeler"]}
    kontrol = {s["sube_id"]: s for s in satis_kontrol(ay)["subeler"]}
    fire = {}
    with db() as (conn, cur):
        try:
            cur.execute("""SELECT sube_id::text AS sube_id, sebep_label, aciklama, kalemler, personel_ad, olusturma
                             FROM sube_fire_bildirim WHERE tarih = %s ORDER BY olusturma""", (g_,))
            for r in cur.fetchall() or []:
                r = dict(r)
                kal = r["kalemler"] if isinstance(r["kalemler"], list) else _json.loads(r["kalemler"] or "[]")
                for k in kal:
                    kod = _kod_anahtar(k.get("kalem_kodu")) or _anahtar_ad(k.get("label"))
                    try:
                        adet = int(float(k.get("miktar") or 0))
                    except (TypeError, ValueError):
                        adet = 0
                    if adet <= 0:
                        continue
                    fire.setdefault(r["sube_id"], []).append({"kod": kod, "ad": k.get("label") or k.get("kalem_kodu"), "adet": adet,
                                                              "sebep": r["sebep_label"], "aciklama": r.get("aciklama"),
                                                              "kim": r.get("personel_ad"), "saat": r["olusturma"].strftime("%H:%M") if r.get("olusturma") else None})
        except Exception as e:  # noqa: BLE001
            log.warning("satış günlük: fire okunamadı: %s", str(e)[:150])
    _hazirla()
    with db() as (conn, cur):
        cep_list, C, kayit, _ = _yukle(cur, tum_donemler=True)
    kap, say = {}, {}
    for h in kayit:
        if h["is_gunu"] != g_:
            continue
        sid = (C.get(h["cep"]) or {}).get("sube_id")
        if h["tur"] == "kapanis" and sid:
            v = h["veri"]
            kap[str(sid)] = {"nakit": h["tutar"] / 100, "pos": int(v.get("pos", v.get("kart", 0))) / 100,
                             "online": int(v.get("online", 0)) / 100, "evo": v.get("eski_kaynak") == "evo_taslak",
                             "onayli": h.get("durum") == "onaylandi"}
        if h["tur"] == "sayim" and sid and (h.get("kaynak_ref") or "").startswith("sayim_kapanis:"):
            v = h["veri"]
            say[str(sid)] = {"beklenen": int(v.get("beklenen", 0)) / 100, "sayilan": int(v.get("sayilan", 0)) / 100,
                             "fark": (int(v.get("beklenen", 0)) - int(v.get("sayilan", 0))) / 100, "baslangic": bool(v.get("baslangic"))}
    out = []
    for sid, b in bar.items():
        gr = next((x for x in b["gunler"] if x["gun"] == g_), None)
        fr = fire.get(sid, [])
        kalemler = []
        for k in (gr["kalemler"] if gr else [{"kod": c, "ad": a} for c, a in KALEMLER]):
            f_ = sum(x["adet"] for x in fr if x["kod"] == k["kod"])
            net = k.get("net_eksilme")
            kalemler.append({"kod": k["kod"], "ad": k["ad"], "sabah": k.get("acilis"), "giren": (k.get("gun_ici_ac") or 0),
                             "aksam": k.get("kapanis"), "kullanilan": net, "fire": f_,
                             "satilan": (net - f_) if net is not None else None, "devir_fark": k.get("devir_fark")})
        kr = next((x for x in kontrol.get(sid, {}).get("gunler", []) if x["gun"] == g_), {})
        c = kap.get(sid)
        ciro = round(c["nakit"] + c["pos"] + c["online"], 2) if c else None
        bek = kr.get("beklenen")
        out.append({
            "sube_id": sid, "ad": b["ad"], "durum": gr["durum"] if gr else "kapanis_yok",
            "kalemler": kalemler, "fire": fr, "fire_toplam": sum(x["adet"] for x in fr),
            "bardak_satilan": sum((x["satilan"] or 0) for x in kalemler if x["kod"] in BARDAKLAR and x["satilan"] is not None),
            "ciro": ({**c, "toplam": ciro} if c else None),
            "beklenen_ciro": bek, "oran": kr.get("oran"),
            "satis_acik": round(bek - ciro, 2) if (bek is not None and ciro is not None) else None,
            "satis_durum": kr.get("durum"), "satis_neden": kr.get("neden"), "guven": kr.get("guven"),
            "kasa": say.get(sid),
        })
    return {"gun": g_, "subeler": out,
            "not": "Kullanılan = sabah + gün içi giren − akşam. Satılan = kullanılan − fire (ikram, dökülme, yanlış ürün…). "
                   "Satıştan açık = bardaktan beklenen ciro − girilen ciro (referans oluşana kadar yalnız bilgi). "
                   "Kasa açığı = akşam kör sayımı (17 Ekim'den itibaren)."}
