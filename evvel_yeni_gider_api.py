"""💸 EVVEL YENİ · GİDER (2026-10-15) — ŞUBENİN KENDİ İŞLETME YÜKÜ.

Sahip kararları:
  · "Şubeler sanki hiç borcu yokmuş gibi — yalnız malı ve tükettiği giderleri ödemekle
    mükellef. Krediler, ev taksiti vb. şubenin değil" → borç/kredi/patron şahsi buraya
    GİRMEZ (patron katmanı).
  · ORTAK KARAR (sahip + Codex + Claude, 2026-10-15): ŞUBE MAL GİDERİ = ÜRÜN AÇ × fiyat
    (gerçekten açılıp kullanılan). DEPODAN SEVK BEDELİ AYRI hesaplanır, gidere EKLENMEZ —
    sevk stoktur, tüketim giderdir; aradaki fark "şubenin rafında bekleyen mal".
  · "Depo Gazze'de; fatura vergisel sebeple Zafer'e kesiliyor" → fatura şubesi KULLANILMAZ.
  · Ödeme formundan girilen kira / fatura / personel / anlık / diğer → AİT OLDUĞU AYA,
    seçilen şubeye (ya da Ortak satırına) gider olarak yazılır. Ödeme yolu gideri değiştirmez.
  · "Depoya geliş fiyatından değil GÜNCELLENMİŞ fiyattan" → sevk gününde geçerli EN SON
    onaylı alış fiyatı (urun_alis_fiyat; adet başına, KDV hariç) → KDV eklenir (gelir
    KDV dahil olduğu için iki taraf aynı dilde).
  · Fiyat yoksa katalog fiyatı; o da yoksa UYDURULMAZ, "fiyatı eksik" sayılır.
  · Dükkân çekmecesinden yapılan harcamalar şubenin küçük gideri; ama PATRON ŞAHSİ olanlar
    (ör. "Onur bey sigara") tek tıkla ÇEKİŞ'e ayrılır — şube gideri sayılmaz.

Eski tablolardan YALNIZ OKUR. Kendi küçük tablosu: ey_gider_sinif (elle sınıflandırma).
"""

import json
import logging
from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from database import db, savepoint
from evvel_yeni_kasa_api import _hazirla, _oranlar, _yukle
from evvel_yeni_cekirdek import aktor as _aktor, kilit as _kilit, kurus as _kurus, tl_sayi as _tl_sayi
from evvel_yeni_gelir_api import _ay_sinirlari, _kapanis_kanallari

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/evvel-yeni/gider", tags=["evvel-yeni-gider"])

TURLER = {"mal": "Mal (ürün aç)", "kira": "Kira", "fatura": "Fatura / abonelik", "personel": "Personel",
          "dukkan": "Dükkân küçük giderleri", "anlik": "Anlık gider", "diger": "Diğer", "komisyon": "POS / online komisyonu"}
KALEMLER = list(TURLER)
VARSAYILAN_KDV = Decimal("0.10")
_SINIF_HAZIR = False


def _sinif_tablosu(cur):
    global _SINIF_HAZIR
    if _SINIF_HAZIR:
        return
    cur.execute("SET LOCAL lock_timeout = '3s'")
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_gider_sinif (
                     kaynak_ref TEXT PRIMARY KEY, tur TEXT NOT NULL, kimin TEXT,
                     degistiren TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    _SINIF_HAZIR = True


def _depo_id(cur) -> Optional[str]:
    """Depo şubesi: sevkiyatların EN ÇOK çıktığı kaynak (subeler'de depo bayrağı yok)."""
    try:
        with savepoint(cur, "sp_ey_depo"):
            cur.execute("""SELECT COALESCE(y.sevk_kaynak_depo_sube_id, t.hedef_depo_sube_id, t.sevkiyat_sube_id) AS d, COUNT(*) n
                             FROM stok_yolda y LEFT JOIN siparis_talep t ON t.id = y.siparis_talep_id
                            WHERE y.sevk_ts >= NOW() - INTERVAL '120 days'
                            GROUP BY 1 ORDER BY 2 DESC LIMIT 1""")
            r = cur.fetchone()
            if r and dict(r).get("d"):
                return str(dict(r)["d"])
    except Exception:  # noqa: BLE001
        pass
    return "sube-tema"


_FIYAT_SQL = """
  LEFT JOIN LATERAL (
    SELECT birim_maliyet_tl, gecerli_baslangic FROM urun_alis_fiyat
     WHERE kalem_kodu = s.kalem_kodu AND gecerli_baslangic <= s.gun
     ORDER BY gecerli_baslangic DESC, created_at DESC LIMIT 1) f ON TRUE
  LEFT JOIN siparis_urun su ON su.id::text = s.kalem_kodu
  LEFT JOIN kalem_kdv_oran k ON k.kalem_kodu = s.kalem_kodu
"""


def _mal_satirlari(cur, bas: date, son: date, depo: str):
    """(şube_id, gün, kalem, adet, net_birim, kdv_oran, kaynak, fiyat_kaynak) — sevk + doğrudan teslim."""
    satir = []
    # 1) Depo → şube sevkiyatları (stok_yolda; adet = sevk_adet; iptaller zaten silinmiş)
    try:
        with savepoint(cur, "sp_ey_sevk"):
            cur.execute(f"""
              WITH s AS (
                SELECT y.sube_id, y.kalem_kodu, y.kalem_adi, y.sevk_adet::numeric AS adet,
                       (y.sevk_ts AT TIME ZONE 'Europe/Istanbul')::date AS gun,
                       COALESCE(y.sevk_kaynak_depo_sube_id, t.hedef_depo_sube_id, t.sevkiyat_sube_id) AS kaynak_depo
                  FROM stok_yolda y LEFT JOIN siparis_talep t ON t.id = y.siparis_talep_id
                 WHERE y.sevk_adet > 0
                   AND (y.sevk_ts AT TIME ZONE 'Europe/Istanbul')::date BETWEEN %s AND %s)
              SELECT s.sube_id, s.gun, s.kalem_kodu, COALESCE(s.kalem_adi, su.ad, s.kalem_kodu) AS ad, s.adet,
                     COALESCE(f.birim_maliyet_tl, su.birim_fiyat_tl) AS birim,
                     CASE WHEN f.birim_maliyet_tl IS NOT NULL THEN 'alış fiyatı'
                          WHEN su.birim_fiyat_tl IS NOT NULL THEN 'katalog' END AS fk,
                     f.gecerli_baslangic AS fiyat_tarihi, COALESCE(k.kdv_oran, %s) AS kdv
                FROM s {_FIYAT_SQL}
               WHERE s.sube_id IS DISTINCT FROM s.kaynak_depo""", (bas, son, VARSAYILAN_KDV))
            for r in cur.fetchall() or []:
                satir.append({**dict(r), "kaynak": "depodan sevk"})
    except Exception as e:  # noqa: BLE001
        log.warning("evvel-yeni gider: sevk okunamadı: %s", str(e)[:200])
    # 2) Toptancının doğrudan şubeye getirdiği (merkez_stok_sevk; depoya girişler hariç)
    try:
        with savepoint(cur, "sp_ey_dogrudan"):
            cur.execute(f"""
              WITH s AS (SELECT sube_id, kalem_kodu, adet::numeric AS adet, tarih AS gun FROM merkez_stok_sevk
                          WHERE tarih BETWEEN %s AND %s AND adet > 0 AND sube_id IS DISTINCT FROM %s)
              SELECT s.sube_id, s.gun, s.kalem_kodu, COALESCE(su.ad, s.kalem_kodu) AS ad, s.adet,
                     COALESCE(f.birim_maliyet_tl, su.birim_fiyat_tl) AS birim,
                     CASE WHEN f.birim_maliyet_tl IS NOT NULL THEN 'alış fiyatı'
                          WHEN su.birim_fiyat_tl IS NOT NULL THEN 'katalog' END AS fk,
                     f.gecerli_baslangic AS fiyat_tarihi, COALESCE(k.kdv_oran, %s) AS kdv
                FROM s {_FIYAT_SQL}""", (bas, son, depo, VARSAYILAN_KDV))
            for r in cur.fetchall() or []:
                satir.append({**dict(r), "kaynak": "toptancıdan doğrudan"})
    except Exception as e:  # noqa: BLE001
        log.warning("evvel-yeni gider: doğrudan teslim okunamadı: %s", str(e)[:200])
    return satir


def _urun_ac_parcala(aciklama: str):
    """URUN_AC / URUN_KULLANIMA_AL JSON'undan (urun_id, ad, adet) — bozuk metin sessizce atlanır."""
    raw = (aciklama or "")
    for on in ("URUN_AC_JSON:", "URUN_KULLANIMA_AL_JSON:"):
        if raw.startswith(on):
            raw = raw[len(on):]
            break
    else:
        return []
    raw = raw.split(" | ", 1)[0].strip()
    try:
        obj = json.loads(raw)
    except Exception:  # noqa: BLE001
        return []
    out = []
    for it in (obj.get("kalemler") or []) if isinstance(obj, dict) else []:
        if not isinstance(it, dict):
            continue
        uid = str(it.get("urun_id") or "").strip()
        try:
            adet = max(0, int(it.get("adet") or 0))
        except (TypeError, ValueError):
            adet = 0
        if uid and adet:
            out.append((uid, str(it.get("urun_ad") or "").strip(), adet))
    return out


def _tuketim_satirlari(cur, bas: date, son: date):
    """ŞUBE MAL GİDERİ = ÜRÜN AÇ (gerçekten açılıp kullanılan) × o gün geçerli son alış fiyatı.

    · Kaynak: operasyon_defter URUN_AC + URUN_KULLANIMA_AL; '[BİTTİ]' satırları HARİÇ (aynı ürün iki kez sayılmasın).
    · Adet AÇILIŞ biriminde; urun_alis_fiyat.birim_maliyet_tl zaten açılış birimi başına (KDV hariç) → çevirme yok.
    · Fiyat zinciri: ürün kimliği → depo kalem kodu → katalog; hiçbiri yoksa UYDURULMAZ (fiyatı eksik).
    · Gün kesin mi: o gün tamamlanmış KAPANIS var mı (yoksa gün içi ürün aç sürebilir)."""
    satir = []
    try:
        with savepoint(cur, "sp_ey_tuketim"):
            cur.execute("""SELECT sube_id, tarih, aciklama FROM operasyon_defter
                            WHERE etiket IN ('URUN_AC','URUN_KULLANIMA_AL') AND tarih BETWEEN %s AND %s
                              AND NOT (etiket='URUN_AC' AND aciklama LIKE '%%[BİTTİ]%%')""", (bas, son))
            ham = cur.fetchall() or []
            top = {}
            for r in ham:
                r = dict(r)
                for uid, ad, adet in _urun_ac_parcala(r["aciklama"]):
                    k = (str(r["sube_id"]), r["tarih"], uid)
                    if k in top:
                        top[k][1] += adet
                    else:
                        top[k] = [ad, adet]
            if not top:
                return satir
            idler = sorted({k[2] for k in top})
            cur.execute("""SELECT id::text AS id, ad, depo_stok_kalem_kodu, birim_fiyat_tl FROM siparis_urun
                            WHERE id::text = ANY(%s)""", (idler,))
            urun = {dict(r)["id"]: dict(r) for r in cur.fetchall() or []}
            kodlar = set(idler) | {u["depo_stok_kalem_kodu"] for u in urun.values() if u.get("depo_stok_kalem_kodu")}
            cur.execute("""SELECT kalem_kodu, gecerli_baslangic, birim_maliyet_tl FROM urun_alis_fiyat
                            WHERE kalem_kodu = ANY(%s) AND birim_maliyet_tl > 0
                            ORDER BY kalem_kodu, gecerli_baslangic DESC, created_at DESC""", (list(kodlar),))
            fiyat = {}
            for r in cur.fetchall() or []:
                r = dict(r)
                fiyat.setdefault(r["kalem_kodu"], []).append((r["gecerli_baslangic"], r["birim_maliyet_tl"]))
            cur.execute("SELECT kalem_kodu, kdv_oran FROM kalem_kdv_oran WHERE kalem_kodu = ANY(%s)", (list(kodlar),))
            kdv = {dict(r)["kalem_kodu"]: dict(r)["kdv_oran"] for r in cur.fetchall() or []}
            cur.execute("""SELECT DISTINCT sube_id::text AS s, tarih FROM sube_operasyon_event
                            WHERE tip='KAPANIS' AND durum='tamamlandi' AND tarih BETWEEN %s AND %s""", (bas, son))
            kesin = {(dict(r)["s"], dict(r)["tarih"]) for r in cur.fetchall() or []}
    except Exception as e:  # noqa: BLE001
        log.warning("evvel-yeni gider: ürün aç okunamadı: %s", str(e)[:200])
        return satir

    def _bul(kod, gun):
        for bg, b in fiyat.get(kod) or []:
            if bg <= gun:
                return b, bg
        return None, None

    for (sid, gun, uid), (ad, adet) in top.items():
        u = urun.get(uid) or {}
        birim, ft, fk, kod = None, None, None, uid
        for k in (uid, u.get("depo_stok_kalem_kodu")):
            if k:
                birim, ft = _bul(k, gun)
                if birim is not None:
                    fk, kod = "alış fiyatı", k
                    break
        if birim is None and u.get("birim_fiyat_tl"):
            birim, fk = u["birim_fiyat_tl"], "katalog"
        satir.append({"sube_id": sid, "gun": gun, "kalem_kodu": uid, "ad": u.get("ad") or ad or uid, "adet": adet,
                      "birim": birim, "fk": fk, "fiyat_tarihi": ft, "kdv": kdv.get(kod, kdv.get(uid)),
                      "kaynak": "ürün aç", "gun_kesin": (sid, gun) in kesin})
    return satir


@router.get("/ozet")
def gider_ozet(ay: Optional[str] = None):
    """Şube şube kendi işletme gideri: mal (sevk × güncel fiyat, KDV dahil) · dükkân küçük
    giderleri · POS/online komisyonu. Patron şahsi çekişler AYRI (gider değil)."""
    _hazirla()
    a_, ay_bas, ay_son, bugun = _ay_sinirlari(ay)
    bas_i, son_i = ay_bas.isoformat(), ay_son.isoformat()
    with db() as (conn, cur):
        _sinif_tablosu(cur)
        cep_list, C, kayit, _ = _yukle(cur, tum_donemler=True)
        oranlar = _oranlar(cur)
        depo = _depo_id(cur)
        mal = _tuketim_satirlari(cur, ay_bas, min(ay_son, bugun))
        sevk = _mal_satirlari(cur, ay_bas, min(ay_son, bugun), depo)
        cur.execute("SELECT kaynak_ref, tur, kimin FROM ey_gider_sinif")
        sinif = {dict(r)["kaynak_ref"]: dict(r) for r in cur.fetchall() or []}
    subeler = {c["sube_id"]: c for c in cep_list if c["tur"] == "sube"}
    sube_cep = {sid: "sube:" + sid for sid in subeler}
    S = {sid: {**{k: 0 for k in KALEMLER}, "satirlar": [], "fiyat_eksik": 0, "katalog": 0, "kesin_degil": set(),
               "sevk": 0, "sevk_eksik": 0, "sevk_satir": []} for sid in subeler}
    ORTAK = {"toplam": 0, "satirlar": []}
    disarida = 0
    # 1) MAL
    for r in mal:
        sid = str(r["sube_id"])
        if sid not in S:
            disarida += 1
            continue
        adet = Decimal(str(r["adet"] or 0))
        if not r.get("gun_kesin", True):
            S[sid]["kesin_degil"].add(r["gun"].isoformat())
        if r["birim"] is None:
            S[sid]["fiyat_eksik"] += 1
            S[sid]["satirlar"].append({"gun": r["gun"].isoformat(), "tur": "mal", "aciklama": f"{r['ad']} · {r['kaynak']}", "adet": float(adet),
                                       "birim": None, "tutar": 0, "not": "FİYATI EKSİK"})
            continue
        kdv = Decimal(str(r["kdv"] or VARSAYILAN_KDV))
        birim_kdvli = Decimal(str(r["birim"])) * (1 + kdv)
        t = _kurus((adet * birim_kdvli).quantize(Decimal("0.01")))
        S[sid]["mal"] += t
        S[sid]["katalog"] += r["fk"] == "katalog"
        S[sid]["satirlar"].append({"gun": r["gun"].isoformat(), "tur": "mal", "aciklama": f"{r['ad']} · {r['kaynak']}",
                                   "adet": float(adet), "birim": float(birim_kdvli.quantize(Decimal('0.01'))), "tutar": _tl_sayi(t),
                                   "not": f"{r['fk']}" + (f" ({r['fiyat_tarihi']})" if r.get("fiyat_tarihi") else "") + f" · KDV %{int(kdv * 100)} dahil"})
    # 1b) DEPODAN SEVK BEDELİ — AYRI hesap, gidere EKLENMEZ (sevk = stok; tüketim = gider)
    for r in sevk:
        sid = str(r["sube_id"])
        if sid not in S:
            continue
        adet = Decimal(str(r["adet"] or 0))
        if r["birim"] is None:
            S[sid]["sevk_eksik"] += 1
            S[sid]["sevk_satir"].append({"gun": r["gun"].isoformat(), "aciklama": f"{r['ad']} · {r['kaynak']}", "adet": float(adet), "birim": None, "tutar": 0})
            continue
        birim_kdvli = Decimal(str(r["birim"])) * (1 + Decimal(str(r["kdv"] or VARSAYILAN_KDV)))
        t = _kurus((adet * birim_kdvli).quantize(Decimal("0.01")))
        S[sid]["sevk"] += t
        S[sid]["sevk_satir"].append({"gun": r["gun"].isoformat(), "aciklama": f"{r['ad']} · {r['kaynak']}", "adet": float(adet),
                                     "birim": float(birim_kdvli.quantize(Decimal('0.01'))), "tutar": _tl_sayi(t)})
    # 1c) ÖDEME FORMUNDAN GİDERLER — ait olduğu ay; şubeye ya da Ortak'a
    for h in kayit:
        v = h["veri"]
        if h["tur"] != "odeme" or v.get("kaynak") != "odeme_formu" or not v.get("gider"):
            continue
        if (v.get("ait_ay") or h["is_gunu"][:7]) != a_:
            continue
        tip = (v.get("konu") or {}).get("tip") or "diger"
        if tip in ("personel", "kira"):
            continue   # personel hak edişten, kira TAHAKKUKTAN yazılır (aşağıda) — ödeme yalnız kasayı etkiler
        tip = tip if tip in TURLER else "diger"
        t = int(v.get("toplam", h["tutar"]))
        satir = {"gun": h["is_gunu"], "tur": tip, "aciklama": v.get("aciklama"), "adet": None, "birim": None, "tutar": _tl_sayi(t),
                 "not": "ödeme: " + " + ".join(sorted(set(v.get("yontemler") or [])))}
        sid = v.get("kimin_kod")
        if sid in S:
            S[sid][tip] += t
            S[sid]["satirlar"].append(satir)
        else:
            ORTAK["toplam"] += t
            ORTAK["satirlar"].append(satir)
    # 1c') KİRA — TAHAKKUK (sahip 2026-10-17): o ayın tanımlı kirası, ödenmiş olsun olmasın; "mülk bizim" şubede yok
    try:
        with db() as (_c3, cur3):
            from evvel_yeni_kira_api import kira_tahakkuk
            kt = kira_tahakkuk(cur3, a_)
    except Exception as e:  # noqa: BLE001
        log.warning("evvel-yeni gider: kira tahakkuku okunamadı: %s", str(e)[:200])
        kt = {}
    for sid in S:
        k_ = kt.get(sid)
        S[sid]["kira_durum"] = "yok" if k_ == "yok" else ("tanimsiz" if k_ is None else "var")
        if isinstance(k_, int) and k_ > 0:
            S[sid]["kira"] += k_
            S[sid]["satirlar"].append({"gun": a_ + "-01", "tur": "kira", "aciklama": "Kira (ayın tahakkuku — ödeme durumu Kira takviminde)",
                                       "adet": None, "birim": None, "tutar": _tl_sayi(k_), "not": "tahakkuk"})
    # 1d) PERSONEL — Maaşlar'ın HAK EDİŞİ (sahip + Codex: gider bir kez, çalışma ayına; avans/ödeme gider değil)
    try:
        with db() as (_c2, cur2):
            from evvel_yeni_maas_api import personel_giderleri
            pg = personel_giderleri(cur2, a_)
    except Exception as e:  # noqa: BLE001
        log.warning("evvel-yeni gider: maaş hak edişi okunamadı: %s", str(e)[:200])
        pg = []
    for x in pg:
        satir = {"gun": a_ + "-01", "tur": "personel", "aciklama": x["ad"] + (" · tahmini (ay onaylanmadı)" if x["tahmini"] else ""),
                 "adet": None, "birim": None, "tutar": _tl_sayi(x["tutar"]), "not": "hak ediş" + (" · eski sistem" if x["kaynak"] == "eski_sistem" else "")}
        sid = x["sube_id"]
        if sid in S:
            S[sid]["personel"] += x["tutar"]
            S[sid]["satirlar"].append(satir)
        else:
            ORTAK["toplam"] += x["tutar"]
            ORTAK["satirlar"].append(satir)
    # 2) DÜKKÂN KÜÇÜK GİDERLERİ (Kasa'daki 'dukkan_gideri' ödemeleri) + patron şahsi ayrımı
    cekisler = []
    for h in kayit:
        if h["tur"] != "odeme" or h["veri"].get("kaynak") != "dukkan_gideri" or not (bas_i <= h["is_gunu"] <= son_i):
            continue
        cep = (h["veri"].get("parcalar") or [{}])[0].get("cep") or ""
        sid = cep.replace("sube:", "", 1)
        ref = h.get("kaynak_ref") or h["id"]
        sn = sinif.get(ref)
        satir = {"gun": h["is_gunu"], "tur": "dukkan", "aciklama": h["veri"].get("aciklama"), "adet": None, "birim": None,
                 "tutar": _tl_sayi(h["tutar"]), "kaynak_ref": ref,
                 "oneri_cekis": any(k in (h["veri"].get("aciklama") or "").lower() for k in ("sigara",))}
        if sn and sn["tur"] == "cekis":
            cekisler.append({**satir, "kim": sn.get("kimin") or "Patron", "sube": subeler.get(sid, {}).get("kisa")})
            continue
        if sid in S:
            S[sid]["dukkan"] += h["tutar"]
            S[sid]["satirlar"].append(satir)
    # 3) KOMİSYON (kapanıştaki POS/online × şube oranı — tahmini; gerçek kesinti belgesi gelince değişir)
    for h in kayit:
        if h["tur"] != "kapanis" or not (bas_i <= h["is_gunu"] <= son_i):
            continue
        sid = (C.get(h["cep"]) or {}).get("sube_id")
        if sid not in S:
            continue
        _, pos, onl, _ = _kapanis_kanallari(h)
        po, oo = oranlar.get(str(sid)) or (0, 0)
        k = int((Decimal(pos) * Decimal(str(po)) / 100 + Decimal(onl) * Decimal(str(oo)) / 100).quantize(Decimal("1")))
        if k:
            S[sid]["komisyon"] += k
            S[sid]["satirlar"].append({"gun": h["is_gunu"], "tur": "komisyon", "aciklama": f"POS %{po} · online %{oo} (tahmini)",
                                       "adet": None, "birim": None, "tutar": _tl_sayi(k)})
    out = []
    for sid, s in S.items():
        top = sum(s[k] for k in KALEMLER)
        out.append({"sube_id": sid, "cep": sube_cep[sid], "ad": subeler[sid]["kisa"], "depo_mu": sid == depo,
                    "toplam": _tl_sayi(top), **{k: _tl_sayi(s[k]) for k in KALEMLER},
                    "fiyat_eksik": s["fiyat_eksik"], "katalog_fiyatli": s["katalog"], "kesin_olmayan_gun": sorted(s["kesin_degil"]),
                    "kira_durum": s.get("kira_durum"),
                    "sevk_bedeli": _tl_sayi(s["sevk"]), "sevk_fiyat_eksik": s["sevk_eksik"],
                    "rafta_fark": _tl_sayi(s["sevk"] - s["mal"]),
                    "sevk_satirlar": sorted(s["sevk_satir"], key=lambda x: x["gun"]),
                    "satirlar": sorted(s["satirlar"], key=lambda x: (x["gun"], x["tur"]))})
    T = {k: sum(_kurus(x[k]) for x in out) for k in KALEMLER}
    sube_top = sum(T.values())
    return {"ay": a_, "ay_basi": bas_i, "ay_sonu": son_i, "ay_bitti": ay_son < bugun, "depo_sube_id": depo,
            "turler": TURLER, "toplam": _tl_sayi(sube_top + ORTAK["toplam"]), "sube_toplam": _tl_sayi(sube_top),
            **{k: _tl_sayi(v) for k, v in T.items()},
            "ortak": {"toplam": _tl_sayi(ORTAK["toplam"]), "satirlar": sorted(ORTAK["satirlar"], key=lambda x: x["gun"])},
            "sevk_bedeli": _tl_sayi(sum(_kurus(x["sevk_bedeli"]) for x in out)),
            "subeler": out, "cekisler": cekisler, "cekis_toplam": _tl_sayi(sum(_kurus(x["tutar"]) for x in cekisler)),
            "fiyat_eksik_toplam": sum(x["fiyat_eksik"] for x in out), "sube_disi_satir": disarida,
            "kapsam_notu": "Mal gideri = şubede ÜRÜN AÇ ile açılan ürün × o günkü son alış fiyatı (KDV dahil). "
                           "Depodan sevk bedeli AYRI gösterilir, gidere eklenmez; fark şubenin rafında bekleyen maldır. "
                           "Kira / fatura / personel / anlık gider: Ödeme formundan, ait olduğu aya."}


class SinifBody(BaseModel):
    kaynak_ref: str
    tur: str          # 'cekis' (patron şahsi) | 'gider' (şube gideri — geri al)
    kimin: Optional[str] = None


@router.post("/siniflandir")
def siniflandir(body: SinifBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Dükkân giderini PATRON ŞAHSİ (çekiş) olarak ayır ya da geri al. Para hareketine dokunmaz
    (çekmeceden çıkış gerçek); yalnız şube kazancındaki yeri değişir."""
    if body.tur not in ("cekis", "gider"):
        raise HTTPException(400, "tur: cekis | gider")
    with db() as (conn, cur):
        _sinif_tablosu(cur)
        _kilit(cur)
        kim = _aktor(cur, x_evvel_oturum)
        # Silinmez — son karar üzerine yazılır, kim/ne zaman izi kalır
        cur.execute("""INSERT INTO ey_gider_sinif (kaynak_ref, tur, kimin, degistiren) VALUES (%s,%s,%s,%s)
                       ON CONFLICT (kaynak_ref) DO UPDATE SET tur=EXCLUDED.tur, kimin=EXCLUDED.kimin, degistiren=EXCLUDED.degistiren, zaman=NOW()""",
                    (body.kaynak_ref, body.tur, (body.kimin or ("Patron" if body.tur == "cekis" else None)), kim))
    return {"ok": True}
