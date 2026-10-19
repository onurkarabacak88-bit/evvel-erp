"""📈 EVVEL YENİ · GELİR (2026-10-15).

Sahip: "Önce gelir mekanizmasını kuracağım, sonra gider mekanizmasını." · "Şubenin nakit
işleri toplansa da aslında o şubenin parası, sadece bende duruyor."
→ Bu bölüm tek soruya cevap verir: HANGİ ŞUBE NE KADAR KAZANDIRDI (gelir tarafı).
Gider gelince "şube kazancı = gelir − gider" buradan beslenecek.

Kaynak: Evvel Yeni Kasa'nın kendi kapanış kayıtları (para_izi_hareket, tur='kapanis';
nakit = tutar, POS/online = veri). Yazma YOK — yalnız okur, hesap burada yapılır,
ekran yalnız dizer. Satış dışı gelirler 'dis' kayıtlarından; borç/kredi/patron
desteği GELİR SAYILMAZ (para girişi ama kazanç değil), ayrıca listelenir.
"""

from datetime import date
from typing import Optional

from fastapi import APIRouter, HTTPException

from database import db
from evvel_yeni_kasa_api import (DIS_TURLERI, KIRA_CEPLERI, kasa_baslangic as _baslangic, kasa_hazirla as _hazirla, pos_oranlari as _oranlar, kasa_kayitlari as _yukle)
from evvel_yeni_cekirdek import bugun as _bugun, tl_sayi as _tl_sayi

router = APIRouter(prefix="/api/evvel-yeni/gelir", tags=["evvel-yeni-gelir"])

GELIR_SAYILMAZ = {"borc", "kredi", "destek"}     # para girişi ama kazanç değil


def _ay_sinirlari(ay: Optional[str]):
    bugun = _bugun()
    a_ = (ay or bugun.strftime("%Y-%m"))[:7]
    try:
        bas = date.fromisoformat(a_ + "-01")
    except ValueError:
        raise HTTPException(400, "ay YYYY-AA olmalı")
    sonraki = date(bas.year + (bas.month == 12), 1 if bas.month == 12 else bas.month + 1, 1)
    son = date.fromordinal(sonraki.toordinal() - 1)
    return a_, bas, son, bugun


def _kapanis_kanallari(h: dict) -> tuple:
    """(nakit, pos, online) kuruş — eski kayıtta ayrım yoksa kart'ın tamamı POS sayılır (etiketli)."""
    v = h["veri"]
    if "pos" in v:
        return h["tutar"], int(v.get("pos", 0)), int(v.get("online", 0)), False
    return h["tutar"], int(v.get("kart", 0)), 0, True


def _toplamla(kayit, C, bas_i, son_i, kesim_gun=None):
    """Belirtilen aralıkta şube başına gelir. kesim_gun: ayın en fazla bu gününe kadar (kıyas için)."""
    sube = {}
    for h in kayit:
        if h["tur"] != "kapanis" or not (bas_i <= h["is_gunu"] <= son_i):
            continue
        if kesim_gun and int(h["is_gunu"][8:10]) > kesim_gun:
            continue
        n, p, o, ayrimsiz = _kapanis_kanallari(h)
        s = sube.setdefault(h["cep"], {"nakit": 0, "pos": 0, "online": 0, "gunler": {}, "onaysiz": 0, "ayrimsiz": 0})
        s["nakit"] += n
        s["pos"] += p
        s["online"] += o
        s["onaysiz"] += h["durum"] != "onaylandi"
        s["ayrimsiz"] += ayrimsiz
        s["gunler"][h["is_gunu"]] = {"nakit": n, "pos": p, "online": o, "onay": h["durum"] == "onaylandi", "ayrimsiz": ayrimsiz,
                                     "kaydeden": h.get("kaydeden")}
    return sube


@router.get("/ozet")
def gelir_ozet(ay: Optional[str] = None):
    """Ayın gelir tablosu: toplam · şube şube · gün gün · eksik/onaysız gün · satış dışı gelirler."""
    _hazirla()
    a_, ay_bas, ay_son, bugun = _ay_sinirlari(ay)
    with db() as (conn, cur):
        cep_list, C, kayit, _ = _yukle(cur, tum_donemler=True)
        oranlar = _oranlar(cur)
        donem_bas = _baslangic(cur)
    sube_cep = [c for c in cep_list if c["tur"] == "sube"]
    bas_i, son_i = ay_bas.isoformat(), ay_son.isoformat()
    S = _toplamla(kayit, C, bas_i, son_i)

    # Kıyas: geçen ayın AYNI günlerine kadar (ay bitmediyse adil kıyas)
    gecen_son = date.fromordinal(ay_bas.toordinal() - 1)
    gecen_bas = date(gecen_son.year, gecen_son.month, 1)
    kesim = None if ay_son < bugun else bugun.day
    G = _toplamla(kayit, C, gecen_bas.isoformat(), gecen_son.isoformat(), kesim_gun=kesim)

    # Eksik gün: takip başlangıcından (dönem/ilk kapanış) dün'e kadar kapanışı olmayan günler
    takip_bas = max(ay_bas, date(2026, 10, 1))
    takip_son = min(ay_son, date.fromordinal(bugun.toordinal() - 1))
    gun_listesi = [date.fromordinal(d).isoformat() for d in range(takip_bas.toordinal(), takip_son.toordinal() + 1)] if takip_son >= takip_bas else []

    subeler = []
    for c in sube_cep:
        s = S.get(c["id"], {"nakit": 0, "pos": 0, "online": 0, "gunler": {}, "onaysiz": 0, "ayrimsiz": 0})
        g = G.get(c["id"], {"nakit": 0, "pos": 0, "online": 0})
        top = s["nakit"] + s["pos"] + s["online"]
        gtop = g["nakit"] + g["pos"] + g["online"]
        eksik = [d for d in gun_listesi if d not in s["gunler"]]
        oran = oranlar.get(str(c.get("sube_id"))) or (0, 0)
        gun_sayisi = len(s["gunler"])
        subeler.append({
            "cep": c["id"], "ad": c["kisa"],
            "nakit": _tl_sayi(s["nakit"]), "pos": _tl_sayi(s["pos"]), "online": _tl_sayi(s["online"]), "toplam": _tl_sayi(top),
            "gun_sayisi": gun_sayisi, "gunluk_ort": _tl_sayi(round(top / gun_sayisi)) if gun_sayisi else 0,
            "gecen_ay_ayni_gunler": _tl_sayi(gtop), "degisim_yuzde": round((top - gtop) * 100 / gtop, 1) if gtop else None,
            "eksik_gunler": eksik, "onaysiz": s["onaysiz"], "ayrimsiz": s["ayrimsiz"],
            "tahmini_komisyon": _tl_sayi(round(s["pos"] * oran[0] / 100 + s["online"] * oran[1] / 100)),
            "gunler": [{"gun": d, **{k: (_tl_sayi(v) if isinstance(v, int) and not isinstance(v, bool) else v) for k, v in x.items()},
                        "toplam": _tl_sayi(x["nakit"] + x["pos"] + x["online"])} for d, x in sorted(s["gunler"].items())],
        })

    # Gün × şube matrisi (Excel)
    tum_gunler = sorted({d for x in subeler for d in (g["gun"] for g in x["gunler"])} | set(gun_listesi))
    matris = []
    for d in tum_gunler:
        satir = {"gun": d, "subeler": {}, "toplam": 0.0}
        for x in subeler:
            g = next((y for y in x["gunler"] if y["gun"] == d), None)
            satir["subeler"][x["cep"]] = None if not g else g["toplam"]
            satir["toplam"] = round(satir["toplam"] + (g["toplam"] if g else 0), 2)
        matris.append(satir)

    # Satış dışı girişler
    diger, sayilmaz = {}, {}
    for h in kayit:
        if h["tur"] != "dis" or not (bas_i <= h["is_gunu"] <= son_i):
            continue
        alt = h["veri"].get("alt", "diger")
        ad = DIS_TURLERI.get(alt, DIS_TURLERI["diger"])[0]
        hedef = sayilmaz if alt in GELIR_SAYILMAZ else diger
        k = ad + (" (kira hesabı · işletmeden ayrı)" if h.get("cep") in KIRA_CEPLERI else "")
        hedef[k] = hedef.get(k, 0) + h["tutar"]

    T = {k: sum(s_.get(k, 0) for s_ in S.values()) for k in ("nakit", "pos", "online")}
    TG = sum(g_["nakit"] + g_["pos"] + g_["online"] for g_ in G.values())
    top_all = T["nakit"] + T["pos"] + T["online"]
    return {
        "ay": a_, "ay_basi": bas_i, "ay_sonu": son_i, "ay_bitti": ay_son < bugun, "donem_basi": donem_bas.isoformat(),
        "toplam": _tl_sayi(top_all), "nakit": _tl_sayi(T["nakit"]), "pos": _tl_sayi(T["pos"]), "online": _tl_sayi(T["online"]),
        "gecen_ay_ayni_gunler": _tl_sayi(TG), "degisim_yuzde": round((top_all - TG) * 100 / TG, 1) if TG else None,
        "eksik_gun_toplam": sum(len(x["eksik_gunler"]) for x in subeler),
        "onaysiz_toplam": sum(x["onaysiz"] for x in subeler),
        "subeler": subeler, "matris": matris,
        "diger_gelirler": [{"ad": k, "tutar": _tl_sayi(v)} for k, v in diger.items()],
        "gelir_sayilmayanlar": [{"ad": k, "tutar": _tl_sayi(v)} for k, v in sayilmaz.items()],
    }


# ── AÇIK KAPILAR (sök-tak): başka modüller iç '_' fonksiyonu değil BU adları kullanır — içerik aynı, kapı tek ──
ay_sinirlari = _ay_sinirlari
kapanis_kanallari = _kapanis_kanallari
