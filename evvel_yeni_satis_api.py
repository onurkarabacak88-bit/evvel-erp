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

from database import db, savepoint

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
    return __import__("evvel_yeni_cekirdek").ay_kaydir(ay, -1)   # ay aritmetiği TEK yerde (Codex T1-22)


def _gunluk(ay: str) -> dict:
    """{(sube_id, gun): {bardak, ciro, nakit, neden}} — bar sayımı + kasa kapanışı, iki ay."""
    from evvel_yeni_bar_api import bar_ozet
    from evvel_yeni_kasa_api import kasa_hazirla as _hazirla, kasa_kayitlari as _yukle
    out = {}
    for a in (_ay_onceki(_ay_onceki(ay)), _ay_onceki(ay), ay):
        try:
            b = bar_ozet(a)
        except Exception as e:  # noqa: BLE001
            log.warning("satış kontrolü: bar okunamadı %s: %s", a, str(e)[:120])
            continue
        for s in b["subeler"]:
            for g in s["gunler"]:
                k = {(x.get("anahtar") or x["kod"]): x for x in g["kalemler"]}   # yeni dönem: kod=ürün kimliği, anahtar=anlam
                bt = [c for c in BARDAKLAR if c in k]   # E2E #17: katalogda OLAN bardak türleriyle hesapla (üçü birden şart değil)
                if not bt:   # Fable: yeni dönemde bardak kalemi katalogda yoksa 500 olmasın
                    out[(s["sube_id"], g["gun"])] = {"bardak": 0, "neden": "bardak kalemi katalogda yok (panelde sayılır işaretli değil)",
                                                     "sayim_var": bool(g.get("acilis_var") or g.get("kapanis_var")), "bardak_kalem": {}}
                    continue
                nets = [k[c]["net_eksilme"] for c in bt]
                neden = None
                if g["durum"] in ("kapanis_yok", "acilis_yok"):
                    neden = "sayım yok"
                elif any(n is None for n in nets):
                    neden = "bardak sayılmamış"
                elif any(n < 0 for n in nets):
                    neden = "ürün aç eksik (bardak eksiye düştü)"
                elif any(abs(k[c]["devir_fark"] or 0) > DEVIR_SINIR for c in bt):
                    neden = "bardak devir farkı büyük (dün akşam ≠ bu sabah)"
                out[(s["sube_id"], g["gun"])] = {"bardak": sum(n for n in nets if n is not None and n > 0), "neden": neden,
                                                 "sayim_var": bool(g.get("acilis_var") or g.get("kapanis_var")),
                                                 "bardak_kalem": {c: k[c]["net_eksilme"] for c in bt},
                                                 "eksik_bardak_turu": [c for c in BARDAKLAR if c not in k]}
    _hazirla()
    with db() as (conn, cur):
        cep_list, C, kayit, _ = _yukle(cur, tum_donemler=True)
    from evvel_yeni_kasa_api import kapanis_kanallari as _kapanis_kanallari, pos_sifir_supheli
    from evvel_yeni_kasa_api import kasa_baslangic as _kb
    with db() as (conn, cur):
        _bas = _kb(cur).isoformat()
    supheli = pos_sifir_supheli([h for h in kayit if h["is_gunu"] >= _bas])   # Kasa ile AYNI pencere (dönem) — Fable D4-9
    for h in kayit:
        if h["tur"] != "kapanis":
            continue
        sid = (C.get(h["cep"]) or {}).get("sube_id")
        if not sid:
            continue
        v = h["veri"]
        nakit, pos, onl, _ = _kapanis_kanallari(h)   # Kasa'nın TEK kanal kuralı (T1-14)
        d = out.setdefault((str(sid), h["is_gunu"]), {"bardak": 0, "neden": "sayım yok", "bardak_kalem": {}})
        d["ciro"] = (nakit + pos + onl) / 100
        d["nakit"] = nakit / 100
        d["evo"] = v.get("eski_kaynak") == "evo_taslak"
        d["onayli"] = h.get("durum") == "onaylandi"
        d["pos_sifir"] = h["id"] in supheli   # Kasa'nın TEK kuralı — merkezin "POS yoktu" kabulü dahil (T1-15)
    for d in out.values():
        if d.get("ciro") is None and not d["neden"]:
            d["neden"] = "kapanış cirosu yok"
        elif d.get("evo") and not d["neden"]:
            d["neden"] = "kapanış Evo tahmini (şube kapanış yapmadı)"
        elif not d["neden"] and d.get("pos_sifir"):
            d["neden"] = "POS 0 girilmiş — kart satışı kapanışa yazılmamış olabilir"
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
    from evvel_yeni_cekirdek import bugun as _bugun
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
                      "panel_yok": not any(d.get("sayim_var") for (ss, gg), d in G.items() if ss == sid and gg[:7] == a_),
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


def kasa_mutabakat(cur, gun: str, evren: Optional[str] = None) -> dict:
    """PUBLIC (tek kapı): şube → kasa mutabakatı. Yeni dönemde (panel_baslangic) yeni panelin olay defterinden, öncesinde eski
    panel tablolarından toplar; HESAP tek (mutabakat_hesapla) — kapanış uyarısı da aynı hesabı kullanır (sahip: "tekrar yazma")."""
    from datetime import date as _date
    from evvel_yeni_cekirdek import yeni_donem
    # Fable B2: evren bakılan GÜNE göre (1 Kasım sonrası eski bir güne bakınca eski panel verisi okunur) — tek kural (Fable D-1)
    yeni = (evren == "yeni") if evren in ("yeni", "eski") else yeni_donem(cur, _date.fromisoformat(gun[:10]))
    out = _mut_veri_yeni(cur, gun) if yeni else _mut_veri_eski(cur, gun)
    _cift_kayit_dus(cur, gun, out)   # Codex P2: eski ve yeni evrende AYNI düzeltme (Kasa 'kartla' çift kayıt)
    for x in out.values():
        mutabakat_hesapla(x)
    return out


def _cift_kayit_dus(cur, gun: str, out: dict) -> None:
    """Kasa'daki 'kartla ödenmiş — nakit olarak da yazılmış' düzeltmesi → nakit satış o kadar az (TEK gerçek Kasa; yumuşak bağ)."""
    try:   # Kasa'da 'kartla ödenmiş — nakit olarak da yazılmış' düzeltmesi → nakit satış o kadar az (TEK gerçek Kasa)
        from evvel_yeni_kasa_api import cift_kayit_duzeltmeleri
        for sid, t_ in cift_kayit_duzeltmeleri(cur, gun).items():
            x = out.get(sid)
            if x and x.get("z_nakit") is not None:
                x["z_nakit"] = round(x["z_nakit"] - t_, 2)
                x["z_duzeltme"] = t_
    except Exception:  # noqa: BLE001 — Fable R: yumuşak bağ; düzeltme okunamazsa sağlama yine çıkar
        log.warning("satış: çift kayıt düzeltmeleri okunamadı", exc_info=True)


def _kr_tl(k):
    """Panel olayındaki kuruş → ₺ (yoksa None)."""
    return None if k is None else int(k) / 100


def _panel_olaylari(cur, bas, son, turler) -> list:
    """Yeni panelin (kaynak 'panel') iptal edilmemiş olayları, verisi açılmış ('v'). Mutabakat / fire / devir defteri TEK okuyucu
    (Fable T-1: üç yerde ayrı ayrı süzgeç + JSON açma vardı)."""
    from evvel_yeni_olay import panel_olaylari   # süzgeç + veri açma Olay'da TEK (F#12)
    return panel_olaylari(cur, bas=bas, son=son, turler=set(turler))


ZINCIR_GERI_GUN = 14   # B84: son kapanış en çok bu kadar gün geriden aranır (daha eskisi = zincir kopuk, kıyas yok)


def son_kapanislar(cur, gun, subeler=None) -> dict:
    """B84 (Fable 22 Eki): {şube: (gün, bırakılan ₺)} — `gun`den ÖNCEKİ en son kapanış (dün değilse kapalı gün(ler) atlanır).
    Sabah sağlaması 'dün'e değil SON kapanışa bakar: pazar kapalıysa pazartesi sabahı cumartesi akşamıyla kıyaslanır."""
    from datetime import date as _date
    g = gun if isinstance(gun, _date) else _date.fromisoformat(str(gun)[:10])
    out, acilis = {}, {}
    for o in _panel_olaylari(cur, g - timedelta(days=ZINCIR_GERI_GUN), g - timedelta(days=1), {"kapanis", "acilis"}):
        sid = str(o["sube_id"])
        if subeler is not None and sid not in subeler:
            continue
        if o["tur"] == "acilis":
            acilis[sid] = max(acilis.get(sid, o["is_gunu"]), o["is_gunu"])
        elif sid not in out or o["is_gunu"] >= out[sid][0]:   # aynı gün birden çok sürüm: SON kazanır (olay sırası)
            out[sid] = (o["is_gunu"], _kr_tl(o["v"].get("birakilan")))
    # Fable: kapalı gün ≠ KAPANIŞSIZ gün — son kapanıştan sonra açılıp kapanmamış gün varsa zincir kopuk (sahte fark üretme)
    return {sid: v for sid, v in out.items() if not (sid in acilis and acilis[sid] > v[0])}


def _elle_teslimler() -> dict:
    """{(şube, gün): ["Fethi 1.500", …]} — yönetimin Kasa'ya ELLE girdiği teslimler (panelden / eski panelden gelmeyen).
    Devir defterinin eski ve yeni okuyucusu ORTAK (Fable T-1: blok birebir kopyaydı)."""
    elle_tes = {}
    try:   # yönetimin Kasa'ya ELLE girdiği teslimler (panelden gelmeyen) — "kime"de görünsün
        from evvel_yeni_kasa_api import kasa_hazirla as _kh, kasa_kayitlari as _ky
        _kh()
        with db() as (conn2, cur2):
            _, C2, kayit2, _ = _ky(cur2, tum_donemler=True)
        for h in kayit2:
            ref = h.get("kaynak_ref") or ""
            if h["tur"] != "teslim" or ref.startswith("kasa_teslim:") or ref.startswith("panel:"):
                continue
            ks = (C2.get(h.get("kaynak")) or {}).get("sube_id")
            if ks:
                elle_tes.setdefault((str(ks), h["is_gunu"]), []).append(
                    f"{(C2.get(h.get('hedef')) or {}).get('kisa') or h.get('hedef')} {h['tutar'] / 100:,.0f}".replace(",", "."))
    except Exception as e:  # noqa: BLE001
        log.warning("devir defteri: Kasa teslimleri okunamadı: %s", str(e)[:150])
    return elle_tes


def _eski_birakilan(r: dict, meta: Optional[dict] = None) -> Optional[float]:
    """ESKİ panel kapanışında kasada BIRAKILAN (₺) — TEK kural (Codex T1-33): devir → kasiyerin devir beyanı → kasa sayımı − teslim.
    Mutabakat (dün / bugün) ve devir defteri (dün / akşam) dört ayrı yedek kullanıyordu → aynı sabah iki ekranda farklı fark."""
    from evvel_yeni_cekirdek import json_ac
    m = meta if meta is not None else json_ac(r.get("meta"), {})
    if r.get("devir") is not None:
        return float(r["devir"])
    if m.get("kasiyer_devir_beyan") is not None:
        return float(m["kasiyer_devir_beyan"])
    if r.get("kasa_sayim") is not None:
        return float(r["kasa_sayim"]) - float(r.get("teslim") or 0)
    return None


def _mut_veri_yeni(cur, gun: str) -> dict:
    """YENİ DÖNEM toplayıcısı — yeni şube panelinin olay defteri (ey_sube_olay, kaynak 'panel'; kuruş → ₺):
    açılış kasa_sayim · kapanış nakit / kor_sayim / teslimler / birakilan · gün içi 'teslim' (ara teslim) · dünün kapanış bırakılanı.
    Çekmeceden çıkan nakit (anlık gider + elden avans): Kasa PUBLIC cekmece_cikislari — tek gerçek Kasa (Fable O-5), ekranda 'ad' (B-1)."""
    from datetime import date as _date
    g = _date.fromisoformat(gun)
    dun = g - timedelta(days=1)
    out = {}
    tl = _kr_tl
    for o in _panel_olaylari(cur, dun, g, {"acilis", "kapanis", "teslim", "ara_sayim"}):
        v = o["v"]
        x = out.setdefault(str(o["sube_id"]), mut_bos())
        x["kor_ara_dahil"] = False   # yeni kapanış: kör sayım ara teslim GİTTİKTEN sonra çekmecede kalan → ara düşülmez
        if o["is_gunu"] == dun:
            if o["tur"] == "kapanis":
                x["dun_devir"] = tl(v.get("birakilan"))
            continue
        if o["tur"] == "acilis":
            x["acilis"] = tl(v.get("kasa_sayim"))
        elif o["tur"] == "kapanis":
            x["z_nakit"] = tl(v.get("nakit"))
            x["kor_sayim"] = tl(v.get("kor_sayim"))
            x["teslim"] = sum(int(t.get("tutar") or 0) for t in v.get("teslimler") or []) / 100
            x["devir"] = tl(v.get("birakilan"))
        elif o["tur"] == "teslim":
            x["ara_teslimler"].append({"tutar": tl(v.get("tutar")) or 0.0, "alan": v.get("alan"), "eden": o.get("personel_ad"),
                                       "not": v.get("aciklama")})
        elif o["tur"] == "ara_sayim":   # ⏱ panel ara sayımı (A1 iki sınır) — gün başına tek kök; iptal sonrası yeni sürüm gelirse SON kazanır
            x["ara_sayim"] = {"sayilan": tl(v.get("sayilan")), "taban": tl(v.get("taban")) if v.get("taban") is not None else None,
                              "kim": o.get("personel_ad"), "saat": str(v.get("yapilma") or "")[11:16]}
    eksik = {sid for sid, x in out.items() if x.get("acilis") is not None and x.get("dun_devir") is None}
    if eksik:   # B84: dün kapanış yok (şube kapalıydı) → son kapanışın bırakılanı
        for sid, (kg, bir) in son_kapanislar(cur, g, eksik).items():
            out[sid]["dun_devir"], out[sid]["dun_devir_gunu"] = bir, kg.isoformat()
    from evvel_yeni_kasa_api import cekmece_cikislari
    if any(x.get("ara_teslimler") for x in out.values()):
        try:   # ara teslim alıcısı: cep kimliği ('ev:onur') yerine ad (Kasa PUBLIC)
            from evvel_yeni_kasa_api import cep_kisa_adlari
            adl = cep_kisa_adlari(cur, gun)
            for x in out.values():
                for a in x.get("ara_teslimler") or []:
                    a["alan_ad"] = adl.get(a.get("alan") or "", a.get("alan"))
        except Exception:  # noqa: BLE001
            log.warning("satış: cep adları okunamadı", exc_info=True)
    try:   # S-B4: merkezin Kasa'dan aldığı şube teslimi de çekmeceden çıkan para (ara teslim gibi düşülür)
        from evvel_yeni_kasa_api import merkez_teslimleri
        with savepoint(cur, "sp_ey_mut_mt"):
            mt = merkez_teslimleri(cur, gun)
        for t in mt:
            out.setdefault(t["sube_id"], {**mut_bos(), "kor_ara_dahil": False})["ara_teslimler"].append(
                {k: t[k] for k in ("tutar", "alan", "alan_ad", "eden", "not")})
    except Exception:  # noqa: BLE001
        log.warning("satış: merkez teslimleri okunamadı", exc_info=True)
    for c in cekmece_cikislari(cur, gun):
        out.setdefault(c["sube_id"], {**mut_bos(), "kor_ara_dahil": False})["giderler"].append({"tutar": c["tutar"], "ad": c["ad"], "kim": c["kim"], "bekliyor": False})
    return out


def mut_bos() -> dict:
    return {"acilis": None, "z_nakit": None, "giderler": [], "ara_teslimler": [], "teslim": None,
            "devir": None, "kor_sayim": None, "dun_devir": None, "vardiya": [], "eski_fark": None}


def mutabakat_hesapla(x: dict) -> dict:
    """PUBLIC — TEK HESAP (Satış günlük döküm + yeni panel kapanış uyarısı):
         fark = sabah sayılan + nakit satış − nakit gider − ara teslim − gün sonu teslim − bırakılan  (0 olmalı)
         kör sağlama = kör sayım − teslim (− ara, eski panelde) ↔ bırakılan · sabah farkı = bu sabah − dün bırakılan."""
    gid = round(sum(y["tutar"] for y in x.get("giderler") or []), 2)
    ara = round(sum(y["tutar"] for y in x.get("ara_teslimler") or []), 2)
    x["gider_toplam"], x["ara_toplam"] = gid, ara
    tam = x.get("acilis") is not None and x.get("z_nakit") is not None and x.get("devir") is not None and not x.get("gider_kaynak_yok")
    x["fark"] = round(x["acilis"] + x["z_nakit"] - gid - ara - (x.get("teslim") or 0) - x["devir"], 2) if tam else None
    x["eksik"] = None if tam else ("nakit gider defteri henüz yok — kasa farkı hesaplanmaz (anlık gider basamağı)" if x.get("gider_kaynak_yok") else
                                   "sabah kasa sayımı yok" if x.get("acilis") is None else
                                   "kapanış (nakit satış / devir) yok" if x.get("z_nakit") is None or x.get("devir") is None else None)
    x["sabah_fark"] = round(x["acilis"] - x["dun_devir"], 2) if (x.get("acilis") is not None and x.get("dun_devir") is not None) else None
    tes = (x.get("teslim") or 0) + (ara if x.get("kor_ara_dahil", True) else 0)
    x["kor_kalan"] = round(x["kor_sayim"] - tes, 2) if x.get("kor_sayim") is not None else None
    x["kor_fark"] = round(x["kor_kalan"] - x["devir"], 2) if (x["kor_kalan"] is not None and x.get("devir") is not None) else None
    # Sayılan, bırakılan tutara eşit ve teslim varsa: sayım teslimden SONRA yapılmış — sağlama yapılamaz (sahte açık gösterme)
    x["kor_belirsiz"] = bool(x.get("kor_sayim") is not None and tes > 0 and (
        (x.get("devir") is not None and abs(x["kor_sayim"] - x["devir"]) < 1) or x["kor_sayim"] < tes))
    # ⏱ ARA SAYIM — iki sınır (gün ortasında 'beklenen' hesaplanamaz; Fable + Codex 21 Eki, sahip A1):
    #   1) sayılan ≥ taban (sabah sayımı − o ana kadar çekmece çıkışı − ara teslim) — altındaysa kasadan para çıkmış
    #   2) kapanışta ara SONRASI nakit satış = nakit satış − (sayılan − taban) ≥ 0 — eksiyse ara sayım şişik ya da nakit eksik beyan
    a = x.get("ara_sayim") or {}
    x["ara_uyari"] = []
    if a.get("taban") is not None and a.get("sayilan") is not None:
        if a["sayilan"] < a["taban"] - 1:
            x["ara_uyari"].append(f"Ara sayım ({a.get('saat') or '—'}, {a.get('kim') or '—'}): çekmece {_tl_tr(int(round(a['sayilan'] * 100)))} — sabah tabanının "
                                  f"({_tl_tr(int(round(a['taban'] * 100)))}) altında")
        if x.get("z_nakit") is not None:
            sonra = round(x["z_nakit"] - (a["sayilan"] - a["taban"]), 2)
            x["ara_sonra_satis"] = sonra
            if sonra < -1:
                x["ara_uyari"].append(f"Ara sayımdan sonraki nakit satış eksi çıkıyor ({_tl_tr(int(round(sonra * 100)))}) — ara sayım şişik ya da kapanış nakdi eksik")
    return x


def _mut_veri_eski(cur, gun: str) -> dict:
    """💵 KASA AÇIĞI — eski Evvel'in kapanış mutabakatı (sube_operasyon.py:1255), Evvel Yeni'de PARÇALARINDAN yeniden:
         sabah kasada sayılan + girilen nakit satış − nakit giderler − ara teslim − gün sonu teslim − kasada bırakılan (devir) = 0
       Sıfır değilse PARASAL AÇIK (+) ya da FAZLA (−). Ek sağlamalar (sahip: "personeller kasaları devrederek sağlama yapıyor"):
         · SABAH FARKI   = bu sabah sayılan − dün akşam bırakılan (devir)
         · KÖR SAYIM     = akşam kör sayımına göre kasada kalan (sayılan − teslim − ara) ↔ beyan edilen devir
         · VARDİYA DEVRİ = gün içi devir sayımları (sabahçı → akşamcı), saatiyle
    """
    import json as _json
    from datetime import date as _date
    g = _date.fromisoformat(gun)
    dun = (g - timedelta(days=1)).isoformat()
    out = {}

    def sube(sid):
        return out.setdefault(str(sid), mut_bos())
    cur.execute("""SELECT sube_id::text AS sid, tarih::text AS t, tip, kasa_sayim, teslim, devir, cevap_ts, meta, personel_saat
                     FROM sube_operasyon_event
                    WHERE tarih IN (%s, %s) AND durum='tamamlandi' AND tip IN ('ACILIS','KAPANIS','CIKIS')
                    ORDER BY cevap_ts NULLS LAST""", (gun, dun))
    for r in cur.fetchall() or []:
        r = dict(r)
        m = r["meta"] if isinstance(r["meta"], dict) else (_json.loads(r["meta"]) if r["meta"] else {})
        x = sube(r["sid"])
        f = lambda v: float(v) if v is not None else None  # noqa: E731
        if r["t"] == dun:
            if r["tip"] == "KAPANIS":
                x["dun_devir"] = _eski_birakilan(r, m)   # TEK kural (T1-33)
            continue
        if r["tip"] == "ACILIS":
            x["acilis"] = f(r["kasa_sayim"])
        elif r["tip"] == "KAPANIS":
            x["kor_sayim"] = f(r["kasa_sayim"])
            x["teslim"] = f(r["teslim"]) or 0.0
            x["devir"] = _eski_birakilan(r, m)   # TEK kural (T1-33)
            xr = m.get("x_rapor") or {}
            x["z_nakit"] = f(xr.get("nakit")) if xr.get("nakit") is not None else f((m.get("mutabakat") or {}).get("z_nakit"))
            x["eski_fark"] = f((m.get("mutabakat") or {}).get("fark"))
        elif r["tip"] == "CIKIS":
            x["vardiya"].append({"saat": r["cevap_ts"].strftime("%H:%M") if r.get("cevap_ts") else None,
                                 "sayilan": f(r["kasa_sayim"]), "kim": r.get("personel_saat")})
    cur.execute("""SELECT sube::text AS sid, tutar, kategori, aciklama, durum FROM anlik_giderler
                    WHERE tarih = %s AND LOWER(COALESCE(NULLIF(TRIM(odeme_yontemi), ''), 'nakit')) = 'nakit'
                      AND durum IN ('aktif', 'onay_bekliyor')""", (gun,))
    for r in cur.fetchall() or []:
        r = dict(r)
        sube(r["sid"])["giderler"].append({"tutar": float(r["tutar"] or 0), "ad": " · ".join(x for x in [r.get("kategori"), r.get("aciklama")] if x) or "Gider",
                                           "bekliyor": r["durum"] == "onay_bekliyor"})
    ara_rows = []
    try:
        with savepoint(cur, "sp_ey_mut_ara"):
            cur.execute("""SELECT sube_id::text AS sid, tutar, teslim_alan_ad, teslim_eden_ad FROM kasa_teslim
                            WHERE tarih = %s AND teslim_turu = 'ara' AND COALESCE(durum,'aktif') = 'aktif'""", (gun,))
            ara_rows = cur.fetchall() or []
    except Exception:  # noqa: BLE001 — durum kolonu olmayan kurulum
        cur.execute("""SELECT sube_id::text AS sid, tutar, teslim_alan_ad, teslim_eden_ad FROM kasa_teslim
                        WHERE tarih = %s AND teslim_turu = 'ara'""", (gun,))
        ara_rows = cur.fetchall() or []
    # Panelin teslim tablosu (her tür) — Kasa'ya henüz aktarılmamış / alıcısı eşleşmemiş teslimi ayırt etmek için (Fable c)
    try:
        with savepoint(cur, "sp_ey_mut_kt"):
            cur.execute("""SELECT sube_id::text AS sid, tutar, teslim_alan_ad, teslim_turu FROM kasa_teslim WHERE tarih = %s""", (gun,))
            for r in cur.fetchall() or []:
                r = dict(r)
                sube(r["sid"]).setdefault("panel_teslimleri", []).append(
                    {"tutar": float(r["tutar"] or 0), "alan": r.get("teslim_alan_ad"), "tur": r.get("teslim_turu")})
    except Exception:  # noqa: BLE001
        pass
    for r in ara_rows:
        r = dict(r)
        sube(r["sid"])["ara_teslimler"].append({"tutar": float(r["tutar"] or 0), "alan": r.get("teslim_alan_ad"), "eden": r.get("teslim_eden_ad")})
    return out   # hesap: mutabakat_hesapla (kasa_mutabakat çağırır)


_URUN_AD = {}


def _urun_ad(cur, kod):
    """Fire kaleminde ad yoksa ürün kataloğundan (Fable P3: ekranda UUID görünüyordu)."""
    k = str(kod or "")
    if not k:
        return "?"
    if k not in _URUN_AD:
        try:
            with savepoint(cur, "sp_ey_urun_ad"):
                cur.execute("SELECT ad FROM siparis_urun WHERE id::text=%s", (k,))
                r = cur.fetchone()
                _URUN_AD[k] = (dict(r)["ad"] if r else None) or k
        except Exception:  # noqa: BLE001
            _URUN_AD[k] = k
    return _URUN_AD[k]


class _YeniGun(Exception):
    pass


def _fire_yeni(cur, gun: str) -> dict:
    """YENİ DÖNEM fire listesi — yeni panelin 'fire' olayı (sebep, açıklama, kim, saat, kalemler: ey_urun kimliği). Bar'ın anlam
    anahtarıyla eşleşir (bardak / pasta) — eşleşmeyen ürün kendi kimliğiyle listelenir. Ürün adı/pasta: Ürün kataloğu PUBLIC."""
    from evvel_yeni_bar_api import anahtar_ad as _anahtar_ad
    from evvel_yeni_cekirdek import tr_saat
    from evvel_yeni_urun_api import urun_bilgi
    g = date.fromisoformat(gun)
    vs = [(o, o["v"]) for o in _panel_olaylari(cur, g, g, {"fire"})]
    bil = urun_bilgi(cur, sorted({str(k.get("urun_id")) for _, v in vs for k in v.get("kalemler") or [] if k.get("urun_id")}))
    out = {}
    for o, v in vs:
        for k in v.get("kalemler") or []:
            uid = str(k.get("urun_id") or "")
            adet = int(k.get("adet") or 0)
            if adet <= 0:
                continue
            b = bil.get(uid) or {}
            ad = k.get("ad") or b.get("ad") or uid
            kod = "pasta" if __import__("evvel_yeni_urun_api").gununde_tuketilir(b) else (_anahtar_ad(ad) or uid)
            out.setdefault(str(o["sube_id"]), []).append({"kod": kod, "ad": ad, "adet": adet, "sebep": v.get("sebep_ad"),
                                                          "aciklama": v.get("aciklama"), "kim": o.get("personel_ad"),
                                                          "saat": tr_saat(o.get("olay_zamani"), g)})
    return out


@router.get("/gun")
def satis_gun(gun: Optional[str] = None):
    """GÜNLÜK DÖKÜM (sahip: "bugün 14 adet 8oz vs. görmek istiyorum; kasada açık var mı, satıştan gelen açık var mı;
    satıştan kaynaklı fireyi de görmeli"). Şube şube: kalem kalem sabah · giren · akşam · KULLANILAN · FİRE · SATILAN,
    fire listesi (sebep), ciro, bardaktan BEKLENEN ciro → SATIŞTAN AÇIK, kör kasa sayımı → KASA AÇIĞI."""
    from evvel_yeni_bar_api import bar_ozet, kod_anahtar as _kod_anahtar, anahtar_ad as _anahtar_ad, KALEMLER
    from evvel_yeni_kasa_api import kapanis_kanallari as _kapanis_kanallari, kasa_hazirla as _hazirla, kasa_kayitlari as _yukle
    from evvel_yeni_cekirdek import bugun as _bugun
    g_ = (gun or (_bugun() - timedelta(days=1)).isoformat())[:10]
    ay = g_[:7]
    bar = {s["sube_id"]: s for s in bar_ozet(ay)["subeler"]}
    kontrol = {s["sube_id"]: s for s in satis_kontrol(ay)["subeler"]}
    fire = {}
    with db() as (conn, cur):
        from evvel_yeni_cekirdek import yeni_donem
        yeni_gun = yeni_donem(cur, date.fromisoformat(g_))
    if yeni_gun:   # T3-19: 1 Kasım'dan itibaren fire YENİ panelin olayından (eski sube_fire_bildirim / siparis_urun okunmaz)
        with db() as (conn, cur):
            fire = _fire_yeni(cur, g_)
    with db() as (conn, cur):
        try:
            if yeni_gun:
                raise _YeniGun()
            cur.execute("""SELECT sube_id::text AS sube_id, sebep_label, aciklama, kalemler, personel_ad, olusturma
                             FROM sube_fire_bildirim WHERE tarih = %s ORDER BY olusturma""", (g_,))
            for r in cur.fetchall() or []:
                r = dict(r)
                kal = __import__("evvel_yeni_cekirdek").json_ac(r["kalemler"], [])
                for k in kal:
                    kod = _kod_anahtar(k.get("kalem_kodu")) or _anahtar_ad(k.get("label"))
                    try:
                        adet = int(float(k.get("miktar") or 0))
                    except (TypeError, ValueError):
                        adet = 0
                    if adet <= 0:
                        continue
                    fire.setdefault(r["sube_id"], []).append({"kod": kod, "ad": k.get("label") or _urun_ad(cur, k.get("kalem_kodu")), "adet": adet,
                                                              "sebep": r["sebep_label"], "aciklama": r.get("aciklama"),
                                                              "kim": r.get("personel_ad"), "saat": r["olusturma"].strftime("%H:%M") if r.get("olusturma") else None})
        except _YeniGun:
            pass
        except Exception as e:  # noqa: BLE001
            log.warning("satış günlük: fire okunamadı: %s", str(e)[:150])
    try:
        with db() as (conn, cur):
            mut = kasa_mutabakat(cur, g_)
    except Exception as e:  # noqa: BLE001
        log.warning("satış günlük: kasa mutabakatı okunamadı: %s", str(e)[:150])
        mut = {}
    _hazirla()
    with db() as (conn, cur):
        cep_list, C, kayit, _ = _yukle(cur, tum_donemler=True)
    kap, say, tes = {}, {}, {}
    for h in kayit:
        if h["tur"] == "teslim" and h["is_gunu"] == g_:
            ksid = (C.get(h.get("kaynak")) or {}).get("sube_id")
            if ksid:
                v = h["veri"]
                onayli = h.get("durum") == "onaylandi"
                tes.setdefault(str(ksid), []).append({
                    "tutar": h["tutar"] / 100, "alan": (C.get(h.get("hedef")) or {}).get("kisa") or h.get("hedef"),
                    "durum": "alindi" if onayli else "bekliyor",
                    "otomatik": bool(onayli and "otomatik" in str(h.get("onaylayan") or "")),
                    "alinan": int(v.get("alinan", h["tutar"])) / 100 if onayli else None,
                    "fark": (h["tutar"] - int(v.get("alinan", h["tutar"]))) / 100 if onayli else None,
                    "onaylayan": h.get("onaylayan")})
        if h["is_gunu"] != g_:
            continue
        sid = (C.get(h["cep"]) or {}).get("sube_id")
        if h["tur"] == "kapanis" and sid:
            v = h["veri"]
            _n, _p, _o, _ = _kapanis_kanallari(h)   # Kasa'nın TEK kanal kuralı (T1-14)
            kap[str(sid)] = {"nakit": _n / 100, "pos": _p / 100, "online": _o / 100, "evo": v.get("eski_kaynak") == "evo_taslak",
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
            kk_ = k.get("anahtar") or k["kod"]   # yeni dönem: anlam anahtarıyla eşleşir (fire + bardak toplamı)
            f_ = sum(x["adet"] for x in fr if x["kod"] == kk_)
            net = k.get("net_eksilme")
            kalemler.append({"kod": kk_, "ad": k["ad"], "sabah": k.get("acilis"), "giren": (k.get("gun_ici_ac") or 0),
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
            "kasa_mutabakat": _mut_aciklama(mut.get(sid), kap.get(sid)),
            "teslimler": tes.get(sid, []),
        })
    return {"gun": g_, "subeler": out,
            "not": "Kullanılan = sabah + gün içi giren − akşam. Satılan = kullanılan − fire (ikram, dökülme, yanlış ürün…). "
                   "Kasa açığı (Evvel hesabı) = sabah kasada sayılan + girilen nakit satış − nakit giderler − ara teslim − gün sonu "
                   "teslim − kasada bırakılan; sıfır olmalı. Bardaktan beklenen ciro 'Beklenen satış' sekmesinde."}


@router.get("/devir-defteri")
def devir_defteri(ay: Optional[str] = None):
    """🔁 KASA DEVİR DEFTERİ — 1 Kasım'dan (panel_baslangic, iş günü) itibaren YENİ panelin olay defterinden (açılış · vardiya devri ·
    kapanış · ara teslim). Sahip (20 Eki): Ekim (eski) defteri 1 Kasım'da KALKAR — eski okuyucu yalnız geçişe kadar (T3-21)."""
    from evvel_yeni_cekirdek import yeni_donem
    with db() as (conn, cur):
        yeni = yeni_donem(cur)
    return _devir_defteri_yeni(ay) if yeni else _devir_defteri_eski(ay)


def _devir_defteri_yeni(ay: Optional[str] = None):
    from evvel_yeni_cekirdek import is_gunu as _ig, tr_saat
    from evvel_yeni_kasa_api import TESLIM_HEDEFLERI
    from evvel_yeni_tanim_api import subeler as _ey_subeler
    bugun = _ig()
    a_ = (ay or bugun.strftime("%Y-%m"))[:7]
    ay_bas = date.fromisoformat(a_ + "-01")
    ay_son = (ay_bas.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    alan_ad = {cid: ad for ad, cid in TESLIM_HEDEFLERI.items()}
    ev = {}
    with db() as (conn, cur):
        subeler = _ey_subeler(cur)
        for o in _panel_olaylari(cur, ay_bas - timedelta(days=ZINCIR_GERI_GUN), ay_son + timedelta(days=1), {"acilis", "kapanis", "vardiya", "teslim"}):
            ev.setdefault((str(o["sube_id"]), o["is_gunu"].isoformat(), o["tur"]), []).append(o)
    elle_tes = _elle_teslimler()
    vk_bekleyen = []
    tl = _kr_tl
    son = lambda lst: lst[-1] if lst else None  # noqa: E731
    out = []
    for s_ in subeler:
        sid = s_["id"]
        gunler = []
        g = ay_bas
        while g <= min(ay_son, bugun):
            gi, ert, dn = g.isoformat(), (g + timedelta(days=1)).isoformat(), (g - timedelta(days=1)).isoformat()
            a = son(ev.get((sid, gi, "acilis"), []))
            k = son(ev.get((sid, gi, "kapanis"), []))
            ka = son(ev.get((sid, ert, "acilis"), []))
            dk = son(ev.get((sid, dn, "kapanis"), []))
            dk_gun = None
            if dk is None and a:   # B84: dün kapalıydı → son kapanış (ZINCIR_GERI_GUN içinde)
                for i in range(1, ZINCIR_GERI_GUN + 1):
                    gg = (g - timedelta(days=i)).isoformat()
                    dk = son(ev.get((sid, gg, "kapanis"), []))
                    if dk:
                        dk_gun = gg
                        break
                    if ev.get((sid, gg, "acilis")):   # Fable: açılmış ama kapanmamış gün → zincir kopuk, eski kapanışla kıyaslama
                        break
            vd = son(ev.get((sid, gi, "vardiya"), []))
            dun_birak = tl(dk["v"].get("birakilan")) if dk else None
            sab = tl(a["v"].get("kasa_sayim")) if a else None
            sabah = {"kim": a.get("personel_ad"), "saat": tr_saat(a.get("olay_zamani"), g), "sayilan": sab, "dun_birakilan": dun_birak, "dun_gunu": dk_gun,
                     "fark": round(sab - dun_birak, 2) if (sab is not None and dun_birak is not None) else None} if a else None
            def _vrd(o):   # devir v2 (sahip 23 Eki): 'sayilan' = RESMİ rakam (tutmadıysa devralanın); iki kör sayım + fark ayrıca
                vv = o["v"]
                return {"devreden": (vv.get("devreden") or {}).get("ad") or "?", "devralan": (vv.get("devralan") or {}).get("ad") or "?",
                        "saat": tr_saat(o.get("olay_zamani"), g), "nakit": tl(vv.get("sayilan")), "teslim": None,
                        "birakilan": tl(vv.get("sayilan")),   # Fable D-3: yeni devirde çekmece BÜTÜN devredilir (ara teslim ayrı satır)
                        "durum": "merkez" if vv.get("merkez_istisna") else ("tamam" if vv.get("tutuyor", True) else "tutmadi"), "tur": vv.get("tur") or 1,
                        "merkez_not": vv.get("aciklama") if vv.get("merkez_istisna") else None,   # Opus B5: merkezin kapattığı devir işaretli
                        "devreden_sayilan": tl(vv.get("devreden_sayilan")), "devralan_sayilan": tl(vv.get("devralan_sayilan")),
                        "fark": tl(vv.get("fark")), "fark_kalem": vv.get("fark_kalem") or [],
                        # G64 (sim 23 Eki): 1. sayım tutmadıysa iki taraf ne saymıştı — merkez kişi desenini izler
                        "tur1": ({"devreden": tl(((vv.get("tur1") or {}).get("devreden") or {}).get("kasa")),
                                  "devralan": tl(((vv.get("tur1") or {}).get("devralan") or {}).get("kasa")),
                                  "fark_kalem": (vv.get("tur1") or {}).get("fark_kalem") or []} if vv.get("tur1") else None)}
            # D4 (sim 23 Eki): günde birden çok devir olur — HEPSİ (saat sırasıyla); 'vardiya' = son devir (eski okuyucular için)
            vardiyalar = [_vrd(o) for o in sorted(ev.get((sid, gi, "vardiya"), []), key=lambda o: o.get("olay_zamani") or g)]
            vardiya = _vrd(vd) if vd else None
            ara = [f"{alan_ad.get(t['v'].get('alan'), t['v'].get('alan'))} {tl(t['v'].get('tutar')) or 0:.0f}" for t in ev.get((sid, gi, "teslim"), [])]
            aksam = None
            if k:
                kv = k["v"]
                tes = kv.get("teslimler") or []
                aksam = {"kim": k.get("personel_ad"), "saat": tr_saat(k.get("olay_zamani"), g), "kor_toplam": tl(kv.get("kor_sayim")),
                         "teslim": sum(int(t.get("tutar") or 0) for t in tes) / 100,
                         "kime": ", ".join(f"{alan_ad.get(t.get('alan'), t.get('alan'))} {int(t.get('tutar') or 0) / 100:.0f}" for t in tes) or None,
                         "ara_teslim": ", ".join(ara) or None, "birakilan": tl(kv.get("birakilan"))}
            ertesi = {"kim": ka.get("personel_ad"), "saat": tr_saat(ka.get("olay_zamani"), g + timedelta(days=1)),
                      "sayilan": tl(ka["v"].get("kasa_sayim"))} if ka else None
            kopuk = None
            if aksam and ertesi and aksam["birakilan"] is not None and ertesi["sayilan"] is not None:
                kopuk = round(ertesi["sayilan"] - aksam["birakilan"], 2)
            gunler.append({"gun": gi, "sabah": sabah, "vardiya": vardiya, "vardiyalar": vardiyalar, "aksam": aksam, "ertesi_sabah": ertesi,
                           "vardiya_kasa": None,
                           "elle_teslim": ", ".join(elle_tes.get((sid, gi), [])) or None,
                           "zincir_fark": kopuk, "zincir_tutuyor": (kopuk is not None and abs(kopuk) < 1)})
            if a and vd and k and len(ev.get((sid, gi, "vardiya"), [])) > 1:   # Opus E1: iki vardiyaya bölme tek devir içindir
                gunler[-1]["vardiya_kasa"] = {"neden": "günde birden çok devir — vardiyalara bölünmedi"}
            elif a and vd and k:   # Faz 2 — ay sonunda TEK bağlantıda doldurulur (Opus Y7)
                vk_bekleyen.append((gunler[-1], sid, g, a, vd, k, ev.get((sid, gi, "teslim"), [])))
            g += timedelta(days=1)
        out.append({"sube_id": sid, "ad": s_["ad"], "gunler": gunler,
                    "panel_yok": not any(x["sabah"] or x["aksam"] for x in gunler),
                    "ozet": {"tutan": sum(1 for x in gunler if x["zincir_tutuyor"]),
                             "kopuk": sum(1 for x in gunler if x["zincir_fark"] is not None and not x["zincir_tutuyor"])}})
    _vardiya_kasa_doldur(vk_bekleyen)
    return {"ay": a_, "subeler": out, "not": "Zincir: akşam bırakılan = ertesi sabah sayılan olmalı. Kopukluk kırmızı. (Yeni panel kayıtları)"}


def _zaman(x):
    """Opus Y9: kaynak zamanı (aware datetime ya da ISO metin) → karşılaştırılabilir aware datetime; okunamazsa None."""
    from datetime import datetime as _dt
    if x is None:
        return None
    if isinstance(x, str):
        try:
            x = _dt.fromisoformat(x)
        except ValueError:
            return None
    return x if getattr(x, "tzinfo", None) else None


def _vardiya_kasa_doldur(bekleyen: list) -> None:
    """FAZ 2 (DEVIR_KURGU_V2, sahip 24 Eki): günü kasa devriyle iki vardiyaya böler — YALNIZ OKUR, yeni tablo yok. Ay başına TEK bağlantı +
    TEK defter yüklemesi (Opus Y7). Nakit satış / gider / ara teslim / kör sayım güvenilirliği Kasa mutabakatının TEK HESABINDAN
    (mutabakat_hesapla + kartla-nakit düzeltmesi — Opus Y3/Y4/Y5), bardak Bar PUBLIC'ten (yumuşak bağ — Y8):
      1. vardiya nakit = devir sayımı − sabah sayımı + (devre kadar) çekmece çıkışı + ara teslim (panel + merkez)
      2. vardiya nakit = akşam kör sayım − devir sayımı + (devirden sonra) çekmece çıkışı + ara teslim
      beklenen = günün nakit satışı × vardiyanın bardak payı (kart vardiyada bilinmez — devirde X yok, sahip).
    Bölünemeyen gün (saati belirsiz kayıt, kör sayım teslimden sonra, bardak eksik) hesaplanmaz, NEDENİ yazılır. Eşik günlük kontrolle
    AYNI (ESIK_ORAN / TL_TABAN, en az MIN_BARDAK — Y10). Fire düşülmez — günlük hesapla aynı (Y11)."""
    if not bekleyen:
        return
    try:
        from evvel_yeni_moduller import acik as _acik
        if not _acik("bar"):
            for gun_d, *_r in bekleyen:
                gun_d["vardiya_kasa"] = {"neden": "Bar modülü kapalı"}
            return
        from evvel_yeni_bar_api import vardiya_bardaklari
        from evvel_yeni_kasa_api import cekmece_cikislari, merkez_teslimleri, cift_kayit_duzeltmeleri, kasa_kayitlari
        fn = (vardiya_bardaklari, cekmece_cikislari, merkez_teslimleri, cift_kayit_duzeltmeleri)
        with db() as (conn, cur):
            _cl, C, kayit, _ = kasa_kayitlari(cur, tum_donemler=True)
            for gun_d, sid, g, a, vd, k, teslimler in bekleyen:
                try:
                    with savepoint(cur, "sp_ey_vardiya_kasa"):
                        gun_d["vardiya_kasa"] = _vardiya_kasa(cur, kayit, C, sid, g, a, vd, k, teslimler, *fn)
                except Exception:  # noqa: BLE001
                    log.warning("satış: vardiya kasası okunamadı %s %s", sid, g, exc_info=True)
                    gun_d["vardiya_kasa"] = {"neden": "okunamadı"}
    except Exception:  # noqa: BLE001 — Y8: Faz 2 düşerse defterin geri kalanı yine gelir
        log.warning("satış: vardiya kasası (Faz 2) okunamadı", exc_info=True)
        for gun_d, *_r in bekleyen:
            gun_d["vardiya_kasa"] = gun_d.get("vardiya_kasa") or {"neden": "okunamadı"}


def _vardiya_kasa(cur, kayit, C, sid, g, a, vd, k, teslimler, vardiya_bardaklari, cekmece_cikislari, merkez_teslimleri,
                  cift_kayit_duzeltmeleri) -> dict:
    vv, kv, av = vd["v"], k["v"], a["v"]
    if vv.get("merkez_istisna") and not _zaman(vv.get("sayim_ts")):   # Opus N1: merkez kapattı, sayım anı yok → kapatma anı sınır OLAMAZ
        return {"neden": "merkez kapattı, sayım anı belirsiz — vardiyaya bölünemedi"}
    kesim = _zaman(vv.get("sayim_ts")) or _zaman(vd.get("olay_zamani"))   # Opus Y2: gerçek SAYIM anı (merkez saatler sonra kapatsa da)
    kap_ts = _zaman(k.get("olay_zamani"))
    if None in (av.get("kasa_sayim"), vv.get("sayilan"), kv.get("kor_sayim"), kv.get("nakit")) or not kesim or not kap_ts:
        return {"neden": "sabah / devir / akşam sayımı ya da nakit satış eksik"}
    gi = g.isoformat()
    cik = [c for c in cekmece_cikislari(cur, gi, kayit, C) if str(c["sube_id"]) == str(sid)]
    mt = [t for t in merkez_teslimleri(cur, gi, kayit, C) if str(t["sube_id"]) == str(sid)]
    # Opus Y6/Y3: saati olay anı olmayan (merkezin sonradan girdiği) ya da kapanıştan SONRA kaydedilen çıkış vardiyaya bölünemez
    belirsiz = [c for c in cik if not c.get("panel") or not _zaman(c.get("zaman")) or _zaman(c.get("zaman")) > kap_ts]
    belirsiz += mt   # Opus N2: merkezin Kasa'dan girdiği teslimin kayıt anı teslim anı DEĞİL → gün bölünmez
    belirsiz += [t for t in teslimler if not _zaman(t.get("olay_zamani"))]   # Opus N4
    if belirsiz:
        return {"neden": "saati belirsiz çekmece çıkışı / merkez teslimi var — vardiyaya bölünemedi"}
    # Kasa mutabakatının TEK hesabı (kör sayım güvenilir mi · kartla-nakit düzeltmesi) — Opus Y4/Y5
    x = {**mut_bos(), "kor_ara_dahil": False, "acilis": int(av["kasa_sayim"]) / 100, "z_nakit": int(kv["nakit"]) / 100,
         "kor_sayim": int(kv["kor_sayim"]) / 100, "devir": _kr_tl(kv.get("birakilan")),
         "teslim": sum(int(t.get("tutar") or 0) for t in kv.get("teslimler") or []) / 100,
         "giderler": [{"tutar": c["tutar"]} for c in cik],
         "ara_teslimler": [{"tutar": int(t["v"].get("tutar") or 0) / 100} for t in teslimler] + [{"tutar": t["tutar"]} for t in mt]}
    x["z_nakit"] = round(x["z_nakit"] - (cift_kayit_duzeltmeleri(cur, gi, kayit, C).get(str(sid)) or 0), 2)
    mutabakat_hesapla(x)
    if x.get("kor_belirsiz"):
        return {"neden": "akşam kör sayımı teslimden sonra yapılmış — vardiyaya bölünemedi"}
    b = vardiya_bardaklari(cur, sid, g, kesim, vv.get("bardak") or [])
    if not b or b["v1"] < 0 or b["v2"] < 0:
        return {"neden": "bardak sayımı eksik ya da eksiye düştü (ürün aç eksik)"}
    hareket = [(c["tutar"], c.get("zaman")) for c in cik] + [(t["tutar"], t.get("zaman")) for t in mt]
    hareket += [(int(t["v"].get("tutar") or 0) / 100, t.get("olay_zamani")) for t in teslimler]
    c1 = sum(tt for tt, zz in hareket if _zaman(zz) and _zaman(zz) <= kesim)
    c2 = sum(tt for tt, zz in hareket) - c1
    sab, dsay, kor, z = x["acilis"], int(vv["sayilan"]) / 100, x["kor_sayim"], x["z_nakit"]
    n1, n2 = dsay - sab + c1, kor - dsay + c2
    tb = b["v1"] + b["v2"]
    out = {}
    for ad, kim, bardak, nakit in (("v1", (vv.get("devreden") or {}).get("ad"), b["v1"], n1),
                                   ("v2", (vv.get("devralan") or {}).get("ad"), b["v2"], n2)):
        bek = z * bardak / tb if tb else None
        fark = round(nakit - bek, 2) if bek is not None else None
        az = bardak < MIN_BARDAK
        bak = (not az) and fark is not None and fark < -max(TL_TABAN, ESIK_ORAN * (bek or 0))
        out[ad] = {"kim": kim, "bardak": bardak, "nakit": round(nakit, 2), "beklenen": round(bek, 2) if bek is not None else None,
                   "fark": fark, "durum": "bak" if bak else ("az" if az else "normal"),
                   "nakit_bardak": round(nakit / bardak, 2) if bardak else None}
    return out


def _devir_defteri_eski(ay: Optional[str] = None):
    """🔁 KASA DEVİR DEFTERİ (sahip 2026-10-16): "açılış kasası sayımlarını, kapanış sayımlarını ve devrin kimden kime
    yapıldığını takip etmek." Şube × gün zinciri:
      SABAH: kim saydı, saat, sayılan ↔ dün akşam bırakılan
      VARDİYA DEVRİ: sabahçı → akşamcı, devredilen nakit / teslim / bırakılan
      AKŞAM: kim kapattı, kör toplam, kime ne teslim, ne bıraktı → ERTESİ SABAH kim devraldı, ne saydı
    Kopukluk (bırakılan ≠ ertesi sabah sayılan) kırmızı. YALNIZ OKUR (panel tabloları)."""
    from evvel_yeni_cekirdek import bugun as _bugun
    from evvel_yeni_tanim_api import subeler as _ey_subeler
    bugun = _bugun()
    a_ = (ay or bugun.strftime("%Y-%m"))[:7]
    ay_bas = date.fromisoformat(a_ + "-01")
    ay_son = (ay_bas.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    with db() as (conn, cur):
        subeler = _ey_subeler(cur)
        pad = __import__("evvel_yeni_tanim_api").adlar(cur, "ey_personel")   # Tanımlar'ın kapısı (F#31)
        ev = {}
        cur.execute("""SELECT sube_id::text AS sid, tarih, tip, kasa_sayim, teslim, devir, cevap_ts, personel_id, personel_ad, meta
                         FROM sube_operasyon_event
                        WHERE tarih BETWEEN %s AND %s AND durum='tamamlandi' AND tip IN ('ACILIS','KAPANIS')
                        ORDER BY cevap_ts NULLS LAST""", (ay_bas - timedelta(days=1), ay_son + timedelta(days=1)))
        for r in cur.fetchall() or []:
            r = dict(r)
            ev[(r["sid"], r["tarih"].isoformat(), r["tip"])] = r
        devir = {}
        try:
            with savepoint(cur, "sp_ey_devir_kk"):
                cur.execute("""SELECT sube_id::text AS sid, tarih, nakit, teslim, devir, durum, kapanisci_onay_ts, acilisci_onay_ts,
                                      sabahci_personel_id::text AS sabahci, aksamci_personel_id::text AS aksamci
                                 FROM kapanis_kayit WHERE olay='vardiya_sabah_aksam_devri' AND tarih BETWEEN %s AND %s""", (ay_bas, ay_son))
                for r in cur.fetchall() or []:
                    r = dict(r)
                    devir[(r["sid"], r["tarih"].isoformat())] = r
        except Exception as e:  # noqa: BLE001
            log.warning("devir defteri: vardiya devri okunamadı: %s", str(e)[:150])
        kapanan = {}
        try:
            with savepoint(cur, "sp_ey_devir_ct"):
                cur.execute("""SELECT DISTINCT ON (sube_id, tarih) sube_id::text AS sid, tarih, gonderen_ad FROM ciro_taslak
                                WHERE tarih BETWEEN %s AND %s AND COALESCE(gonderen_ad,'') NOT ILIKE '%%evo%%'
                                ORDER BY sube_id, tarih, olusturma DESC""", (ay_bas, ay_son))
                for r in cur.fetchall() or []:
                    r = dict(r)
                    kapanan[(r["sid"], r["tarih"].isoformat())] = r["gonderen_ad"]
        except Exception:  # noqa: BLE001
            pass
        teslim_alan = {}
        try:
            with savepoint(cur, "sp_ey_devir_kt"):
                cur.execute("""SELECT sube_id::text AS sid, tarih, teslim_turu, tutar, teslim_alan_ad, teslim_eden_ad FROM kasa_teslim
                                WHERE tarih BETWEEN %s AND %s ORDER BY olusturma""", (ay_bas, ay_son))
                for r in cur.fetchall() or []:
                    r = dict(r)
                    teslim_alan.setdefault((r["sid"], r["tarih"].isoformat()), []).append(
                        {"tur": r["teslim_turu"], "tutar": float(r["tutar"] or 0), "alan": r.get("teslim_alan_ad"), "eden": r.get("teslim_eden_ad")})
        except Exception:  # noqa: BLE001
            pass
    # Fable: yönetimin Kasa'ya ELLE girdiği teslimler (panelde yok) devir defterinde "kime"de görünmüyordu — ortak okuyucu
    elle_tes = _elle_teslimler()
    f = lambda v: float(v) if v is not None else None  # noqa: E731
    saat = lambda ts, gun=None: _tr_saat(ts, gun)  # noqa: E731
    out = []
    for s in subeler:
        sid = s["id"]
        gunler = []
        g = ay_bas
        while g <= min(ay_son, bugun):
            gi, ert = g.isoformat(), (g + timedelta(days=1)).isoformat()
            a, k, ka = ev.get((sid, gi, "ACILIS")), ev.get((sid, gi, "KAPANIS")), ev.get((sid, ert, "ACILIS"))
            dun_k = ev.get((sid, (g - timedelta(days=1)).isoformat(), "KAPANIS"))
            vd = devir.get((sid, gi))
            km = (__import__("evvel_yeni_cekirdek").json_ac(k["meta"], {})) if k else {}
            dun_birak = _eski_birakilan(dun_k) if dun_k else None   # TEK kural (T1-33) — mutabakatla aynı
            sabah = {"kim": a.get("personel_ad") if a else None, "saat": saat(a["cevap_ts"], g) if a else None,
                     "sayilan": f(a["kasa_sayim"]) if a else None, "dun_birakilan": dun_birak,
                     "fark": round(f(a["kasa_sayim"]) - dun_birak, 2) if (a and dun_birak is not None and a["kasa_sayim"] is not None) else None}
            vardiya = None
            if vd:
                vardiya = {"devreden": pad.get(vd.get("sabahci")) or "?", "devralan": pad.get(vd.get("aksamci")) or ("bekliyor" if vd["durum"] == "acilis_bekliyor" else "?"),
                           "saat": saat(vd.get("kapanisci_onay_ts"), g), "nakit": f(vd["nakit"]), "teslim": f(vd["teslim"]), "birakilan": f(vd["devir"]),
                           "durum": vd["durum"]}
            tes = teslim_alan.get((sid, gi), [])
            aksam = None
            if k:
                aksam = {"kim": kapanan.get((sid, gi)) or k.get("personel_ad"), "saat": saat(k["cevap_ts"], g), "kor_toplam": f(k["kasa_sayim"]),
                         "teslim": f(k["teslim"]) or 0.0, "kime": ", ".join(f"{t['alan']} {t['tutar']:.0f}" for t in tes if t["tur"] == "gun_sonu") or None,
                         "ara_teslim": ", ".join(f"{t['alan']} {t['tutar']:.0f}" for t in tes if t["tur"] != "gun_sonu") or None,
                         "birakilan": _eski_birakilan(k, km)}   # TEK kural (T1-33) — beyan önce (sahip 24 Eki canlı vaka + Codex: sıra değişmez)
                # Alsancak 23 Eki (sahip "neden +3243, tuttu görünmüyor"): personel beyanı 0, kör sayım 3230, teslim yok → beyan ile
                # SAYIMDAN KALAN ayrıca gösterilir (Codex: hangisinin yanlış olduğu kesin bilinemez; 0 geçerli değer)
                ara = sum(t["tutar"] for t in tes if t["tur"] != "gun_sonu")
                aksam["sayimdan_kalan"] = round(f(k["kasa_sayim"]) - (f(k["teslim"]) or 0.0) - ara, 2) if k["kasa_sayim"] is not None else None
            ertesi = {"kim": ka.get("personel_ad"), "saat": saat(ka["cevap_ts"], g + timedelta(days=1)), "sayilan": f(ka["kasa_sayim"])} if ka else None
            kopuk = kopuk_say = None
            if aksam and ertesi and aksam["birakilan"] is not None and ertesi["sayilan"] is not None:
                kopuk = round(ertesi["sayilan"] - aksam["birakilan"], 2)
                if aksam.get("sayimdan_kalan") is not None:
                    kopuk_say = round(ertesi["sayilan"] - aksam["sayimdan_kalan"], 2)
            beyan_var = bool(k and (k.get("devir") is not None or km.get("kasiyer_devir_beyan") is not None))   # Fable #2: beyansız gün yedek kuralı (sayım − teslim) ara düşmez → sahte çelişki olmasın
            celiski = bool(beyan_var and aksam and aksam.get("sayimdan_kalan") is not None and aksam["birakilan"] is not None
                           and round(aksam["sayimdan_kalan"] - aksam["birakilan"], 2) != 0)
            tutuyor = kopuk is not None and kopuk == 0 and not celiski   # sahip: devirde 0 ₺ tolerans (kuruş) — eski 'abs < 1' gevşekliği kalktı (Codex)
            durum = None if kopuk is None else ("tuttu" if tutuyor else ("celiskili" if (kopuk == 0 or kopuk_say == 0) else "kopuk"))
            gunler.append({"gun": gi, "sabah": sabah if a else None, "vardiya": vardiya, "aksam": aksam, "ertesi_sabah": ertesi,
                           "elle_teslim": ", ".join(elle_tes.get((sid, gi), [])) or None,
                           "zincir_fark": kopuk, "zincir_fark_sayim": kopuk_say, "zincir_celiski": celiski, "zincir_durum": durum,
                           "zincir_tutuyor": tutuyor})
            g += timedelta(days=1)
        out.append({"sube_id": sid, "ad": s["ad"], "gunler": gunler,
                    "panel_yok": not any(x["sabah"] or x["aksam"] for x in gunler),
                    "ozet": {"tutan": sum(1 for x in gunler if x["zincir_tutuyor"]),
                             "kopuk": sum(1 for x in gunler if x.get("zincir_durum") == "kopuk"),
                             "celiskili": sum(1 for x in gunler if x.get("zincir_durum") == "celiskili")}})
    return {"ay": a_, "subeler": out, "not": "Zincir: akşam bırakılan (devir) = ertesi sabah sayılan olmalı. Kopukluk kırmızı."}


from evvel_yeni_cekirdek import tr_saat as _tr_saat   # Dalga 4 (F#4): saat biçimi TEK yerde — çekirdek (birebir kopyasıydı)
from evvel_yeni_cekirdek import tl as _tl_tr   # Türkçe para biçimi TEK yer (f-string içinde iç içe tırnak YOK — canlı Python 3.11)



def _mut_aciklama(m, kap):
    """Fable: Gelir o günü ciro sayarken kasa mutabakatı "kapanış yok" diyordu (biri Kasa defterine, biri panel kapanışına bakıyor).
    Ciro defterde varsa eksik olanın PANEL KAPANIŞI (kasa sayımı) olduğu açıkça yazılır."""
    if not m:
        return m
    m = dict(m)
    if kap and m.get("eksik") and "kapanış" in m["eksik"]:
        m["eksik"] = ("panel kapanışı yok — ciro " + ("Evo'dan" if kap.get("evo") else "Kasa'dan") +
                      " geldi ama çekmece sayılmadı / devir yazılmadı; kasa açığı hesaplanamaz")
    return m


# 🌅 SABAH SAYIMI TUTMADI — B62/B63 (Fable 22 Eki; sahip: "sistemi şişirmeden, veriyi gözden kaçırmadan"). O İŞ GÜNÜ Bekleyen işler'e
# şube başına TEK satır (bilgi + Satış kontrolü düğmesi). Yeni hesap yok: kasa = mutabakat_hesapla 'sabah_fark', ürün = Bar devir farkı.
# Gördüm / kalıcı kayıt yok: ertesi gün satır kendiliğinden kalkar — kasa farkı o sabah Kasa › Açık farklar'a yazılır (karar ORADA, bir kez),
# ürün farkı Bar sayımı gün kutusunda sarı kalır. Ürün FAZLASI (sabah > dün akşam) satıra girmez — Bar'da görünür (veri kaybolmaz).
# Deneme dönemi merkeze iş üretmez. Personel görmez (yalnız merkez Bekleyen işler).
def _sabah_isleri(cur, _baglam) -> list:
    from evvel_yeni_cekirdek import deneme_mi, is_gunu, kurus
    from evvel_yeni_tanim_api import subeler
    gun = is_gunu()
    if deneme_mi(cur, gun):
        return []
    mut = kasa_mutabakat(cur, gun.isoformat(), evren="yeni")
    try:
        from evvel_yeni_moduller import acik as _acik
        from evvel_yeni_bar_api import bar_gunu
        bar = {}
        if _acik("bar"):   # tak-çıkar: Bar kapalıysa ürün parçası yok
            with savepoint(cur, "sp_satis_sabah_bar"):   # Codex P2: Bar SQL hatası işlemi bozup kasa parçasını düşürmesin
                bar = bar_gunu(cur, gun)
    except Exception:  # noqa: BLE001 — Bar okunamazsa kasa parçası yine gelir
        log.warning("satış: sabah satırı için bar okunamadı", exc_info=True)
        bar = {}
    out = []
    for s in subeler(cur):
        sid = str(s["id"])
        parca = []
        m = mut.get(sid) or {}
        f = m.get("sabah_fark")
        if f is not None and abs(f) >= 1:
            yon = "eksik" if f < 0 else "fazla"
            _dg = m.get("dun_devir_gunu")
            _ne = f"{_dg[8:10]}.{_dg[5:7]} akşamı" if _dg else "dün"   # B84: kapalı gün sonrası son kapanış
            parca.append(f"Kasa: {_ne} bırakılan {_tl_tr(kurus(m['dun_devir']))} · bu sabah {_tl_tr(kurus(m['acilis']))} → "
                         f"{_tl_tr(kurus(abs(f)))} {yon}")
        urun = []
        _bg = (bar.get(sid) or {}).get("dun_gunu")
        _bne = f"{_bg[8:10]}.{_bg[5:7]} akşamı" if _bg else "dün akşam"   # B84: Bar da son kapanışla kıyaslar
        for k in (bar.get(sid) or {}).get("kalemler") or []:
            if (k.get("devir_fark") or 0) < 0:
                gece = f" + gece açılan {k['gece_ac']}" if k.get("gece_ac") else ""
                urun.append(f"{k['ad']}: {-k['devir_fark']} eksik ({_bne} {k['dun_kapanis']}{gece} → bu sabah {k['acilis']})")
        if urun:
            parca.append("Ürün: " + ", ".join(urun))
        if parca:
            out.append({"genel": True, "grup": "kasa", "tur": "sabah_sayimi", "id": f"sabah:{sid}:{gun.isoformat()}", "tarih": gun.isoformat(),
                        "etiket": "🌅 Sabah sayımı tutmadı", "ad": s["ad"], "alt": " · ".join(parca),
                        "sayfa": f"satis_kontrol?gun={gun.isoformat()}", "dugme": "Satış kontrolü"})
    return out


from evvel_yeni_cekirdek import bekleyen_is_kaydet as _bekleyen_is_kaydet   # tak-çıkar: Satış kapalıysa satır da yok
_bekleyen_is_kaydet("satis_sabah", _sabah_isleri)
