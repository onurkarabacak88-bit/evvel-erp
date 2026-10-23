"""🥤 EVVEL YENİ · BAR SAYIMI (2026-10-16) — açılış/kapanış bardak + bar içi ürün sayımı.

Ortak karar (sahip + Codex + Fable + Claude):
  · SAYIM KALIR, üstüne yapışmış motorlar (satış tahmini, kayıp, zimmet, Truth, reçete–Evo) GELMEZ.
  · Kalemler: 8oz · 14oz · plastik bardak · su · Redbull · soda · cookie · PASTA TOPLAM (sahip: "toplam").
    Süt / şurup / kahve / kapak / peçete sayılmaz — ürün aç ile izlenir.
  · İki hesap, tek yerde:
      DEVİR FARKI   = bugün açılış − (dün kapanış + gece ürün aç)      → "gece bir şey eksildi mi?"
      NET EKSİLME   = açılış + gün içi ürün aç − kapanış                → satış+fire+ikram karışık; "kayıp" DENMEZ
      ÜRÜN AÇ EKSİK = net eksilme < 0 (sayılandan fazlası çıkamaz)      → ürün aç girilmemiş olabilir
  · Sayım GİDERİ değiştirmez (gider = ürün aç × fiyat), KASAYA para olarak bağlanmaz. Kimseye suç yazılmaz.
  · Ürün aç kaynağı GİDERLE AYNI: URUN_AC + URUN_KULLANIMA_AL, [BİTTİ] hariç. Gece/gün içi ayrımı OLAY SAATİYLE
    (kapanıştan sonra + ertesi açılıştan önce açılan = gece).
  · Eksik kalem = "sayılmadı" (0 sayılmaz). Kapanışı olmayan gün hesaplanmaz.
YALNIZ OKUR — eski tablolara yazmaz.
"""

import json
import logging
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter

from database import db, savepoint

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/evvel-yeni/bar", tags=["evvel-yeni-bar"])

KALEMLER = [
    ("bardak_kucuk", "8oz bardak"), ("bardak_buyuk", "14oz bardak"), ("bardak_plastik", "Plastik bardak"),
    ("su_adet", "Su"), ("redbull_adet", "Redbull"), ("soda_adet", "Soda"), ("cookie_adet", "Cookie"), ("pasta", "Pasta (toplam)"),
]
KODLAR = [k for k, _ in KALEMLER]
_PASTA_IZ = ("pasta", "porsiyon", "san sebast", "magnolya", "tart", "snickers", "malaga", "rulo", "browni", "cream puff",
             "kavala", "cup", "profiterol", "kare ", "dilim", "cheesecake", "tiramisu")


def _anahtar_ad(ad: str) -> Optional[str]:
    """Ürün adından sayım kalemi — eski motorun eşlemesinin sade kopyası (eski dosya kalkınca da çalışsın)."""
    n = (ad or "").strip().lower()
    if not n:
        return None
    if "bardak" in n:
        if "plastik" in n:
            return "bardak_plastik"
        if "karton" in n and not ("oz" in n):
            return None
        if "14" in n and "oz" in n or any(w in n for w in ("buyuk", "büyük", "large", "orta")):
            return "bardak_buyuk"
        if "8" in n and "oz" in n or any(w in n for w in ("kucuk", "küçük", "small")):
            return "bardak_kucuk"
        return None
    if n in ("su", "su adet", "su_adet", "su sisesi", "su şişesi") or (" su " in f" {n} " and len(n) <= 15):
        return "su_adet"
    if "sade maden" in n or "soda" in n:   # Fable B3 (21 Eki): katalog adı 'Sade Maden Suyu'; aromalılar tezgahta sayılmaz (P2-b)
        return "soda_adet"
    if "cookie" in n and not any(w in n for w in ("şurup", "surup")):   # Fable S5: 'Cookie Şurup' kurabiye değil
        return "cookie_adet"
    for w, k in (("redbull", "redbull_adet"), ("red bull", "redbull_adet")):
        if w in n:
            return k
    if any(w in n for w in _PASTA_IZ):
        return "pasta"
    return None


def _kod_anahtar(kod: Optional[str]) -> Optional[str]:
    k = (kod or "").strip()
    if k in KODLAR:
        return k
    if k == "pasta_adet" or k.startswith("pasta_"):
        return "pasta"
    return None


def _sayim(meta, alan: str) -> Optional[dict]:
    """meta.<alan> → {kalem: adet|None}. Pasta toplam = pasta_adet + bütün pasta_* çeşitleri."""
    m = meta if isinstance(meta, dict) else (json.loads(meta) if meta else {})
    blok = m.get(alan)
    if blok is None and alan == "acilis_stok_sayim":
        blok = m.get("stok_sayim")
    if not isinstance(blok, dict) or not blok:
        return None
    out = {}
    for k in KODLAR[:-1]:
        v = blok.get(k)
        out[k] = int(v) if isinstance(v, (int, float)) or (isinstance(v, str) and v.strip().lstrip("-").isdigit()) else None
    # Pasta: çeşitler varsa ONLARIN toplamı; yoksa pasta_adet (ikisi birden toplanmaz — çift sayım, Codex)
    cesit = [int(v) for kk, v in blok.items() if kk.startswith("pasta_") and kk != "pasta_adet" and isinstance(v, (int, float))]
    tek = blok.get("pasta_adet")
    out["pasta"] = sum(cesit) if cesit and sum(cesit) > 0 else (int(tek) if isinstance(tek, (int, float)) else (sum(cesit) if cesit else None))
    return out


from evvel_yeni_kopru import urun_ac_parcala as _urun_ac_parcala   # köprü tek yerde (kesimde dosya silinir)


def _sevk_pasta_parcala(aciklama: str) -> list:
    """URUN_SEVK_JSON (eski panel tedarikçiden teslim) → pasta kategorisindeki kalemlerin adetleri."""
    raw = aciklama or ""
    if not raw.startswith("URUN_SEVK_JSON:"):
        return []
    try:
        obj = json.loads(raw[len("URUN_SEVK_JSON:"):].split(" | ", 1)[0].strip())
    except Exception:  # noqa: BLE001
        return []
    out = []
    for it in (obj.get("kalemler") or []) if isinstance(obj, dict) else []:
        if (isinstance(it, dict) and str(it.get("kategori_id") or "").lower() == "pasta"
                and _anahtar_ad(str(it.get("urun_ad") or "")) in (None, "pasta")):   # Fable P2-a: 'Cookie (Kurabiye)' pasta değil
            try:
                n = int(it.get("adet") or 0)
            except (TypeError, ValueError):
                n = 0
            if n > 0:
                out.append(n)
    return out


def _sevk_kaydi_mi(x: tuple, sevk: list) -> bool:
    """ac listesindeki satır bir teslim (URUN_SEVK) satırından mı geldi (olay saati eşleşmesi)."""
    return any(x[0] == d["olay_ts"] for d in sevk)


def _stok_ekle_parcala(aciklama: str):
    """URUN_STOK_EKLE: 'URUN_STOK_JSON:{"delta":{stok_key:adet}}' → [(kalem, adet)] — bara doğrudan giriş."""
    raw = aciklama or ""
    if not raw.startswith("URUN_STOK_JSON:"):
        return []
    try:
        obj = json.loads(raw[len("URUN_STOK_JSON:"):].split(" | ", 1)[0].strip())
    except Exception:  # noqa: BLE001
        return []
    out = []
    for k, v in ((obj or {}).get("delta") or {}).items():
        kk = _kod_anahtar(k)
        try:
            n = int(v or 0)
        except (TypeError, ValueError):
            n = 0
        if kk and n > 0:
            out.append((kk, n))
    return out


def _bos():
    return {k: 0 for k in KODLAR}


from evvel_yeni_cekirdek import tr_duvar as _tr_saat, tr_tarih_saat as _saat   # Dalga 4 (F#4): saat biçimi TEK yerde — çekirdek


def _bar_yeni(cur, subeler: list, ay_bas: date, bas: date, son: date) -> dict:
    """YENİ DÖNEM (1 Kasım — panel_baslangic): Evvel Yeni defterlerinden. Formül AYNI (eski panel):
    DEVİR FARKI = bugün açılış − (dün kapanış + gece bara giren) · NET EKSİLME = açılış + gün içi bara giren − kapanış.
    Kalemler = katalogda 'panelde sayılır' ürünler (ey_urun kimliği) + PASTA TOPLAM. Bara giren = Ürün Aç'ta açılan tezgah ürünü
    (olay saati) + pasta sevk kabulü (Depo defteri, yeni evren). Sahip (2026-10-19): açılış/kapanışta YALNIZ tezgah sayılır."""
    from evvel_yeni_urun_api import katalog
    kat = katalog(cur, hepsi=True)   # Fable: sayımı yapılmış ürün sonradan pasife alınırsa kalem kaybolmasın
    sayilan = [(str(u["id"]), u["ad"]) for k in kat for u in k["urunler"] if __import__("evvel_yeni_urun_api").tezgahta_sayilir(u)]
    sayilan_id = {i for i, _ in sayilan}
    # sahip P1 (20 Eki): katalogdaki 'gününde tüketilir' TEK GERÇEK (Dalga 4, F#8: işaretli yoksa ADDAN tahmin eden ikinci kural kalktı —
    # tahmin başka ekranlarla ayrışıyordu). İşaretli ürün yoksa ekranda uyarı.
    pasta_id = {str(u["id"]) for k in kat for u in k["urunler"] if __import__("evvel_yeni_urun_api").gununde_tuketilir(u)}
    # sahip (21 Eki): pastalar 'gününde' işaretlenmeyecek → KATALOG KATEGORİSİ 'Pasta' (ürün adı tahmini değil) da pasta girişidir
    pasta_id |= {str(u["id"]) for k in kat if "pasta" in str(k.get("ad") or "").lower() for u in k["urunler"]
                 if not __import__("evvel_yeni_urun_api").tezgahta_sayilir(u)}   # Fable P2-a: tezgahta ayrı sayılan (Cookie) pasta değil
    kalemler = sayilan + [("pasta", "Pasta (toplam)")]
    kodlar = [k for k, _ in kalemler]
    # Satış kontrolü bardakları anlam anahtarıyla arar (bardak_kucuk/buyuk/plastik) — ürün adından TEK eşleştiriciyle
    anahtar_of = {k: ("pasta" if k == "pasta" else _anahtar_ad(ad)) for k, ad in kalemler}
    sids = {s_["id"] for s_ in subeler}
    ev, ac = {}, {}
    # B84 (Fable 22 Eki): dün kapalıysa SON kapanışla kıyas — 14 gün geriye okunur (Satış son_kapanislar ile aynı sınır)
    for o in __import__("evvel_yeni_olay").panel_olaylari(cur, bas=bas - timedelta(days=14), son=son + timedelta(days=1), turler={"acilis", "kapanis", "urun_ac"}):
        if str(o["sube_id"]) not in sids:   # F#12: iptal/panel süzgeci Olay'da
            continue
        sid = str(o["sube_id"])
        v = o["v"]   # panel_olaylari açtı
        if o["tur"] == "urun_ac":
            for x in v.get("kalemler") or []:
                if str(x.get("urun_id")) in sayilan_id:
                    ac.setdefault(sid, []).append((o["olay_zamani"], o["is_gunu"], str(x["urun_id"]), int(x.get("adet") or 0)))
            continue
        say = {str(x.get("urun_id")): (int(x["sayilan"]) if x.get("sayilan") is not None else None) for x in v.get("sayim") or []}
        say["pasta"] = None if v.get("pasta_toplam") is None else int(v["pasta_toplam"])
        ev.setdefault(sid, {}).setdefault(o["is_gunu"], {})[o["tur"]] = {"say": say, "ts": o["olay_zamani"], "kim": o.get("personel_ad")}
    if pasta_id:   # pasta vitrine sevkle gelir (ürün aç ile değil) — şubenin KABUL ettiği pasta = bara giren pasta
        try:
            from evvel_yeni_moduller import acik as _acik
            if _acik("depo"):
                # Fable #7 / sahip P1: şubeye DOĞRUDAN gelen pasta (Tedarikçiden teslim al = giris) da bara girer
                from evvel_yeni_depo_api import hareketler   # Depo'nun kapısı (F#34)
                for h in hareketler(cur, turler=("kabul", "giris", "fazla_onay"), bas=bas - timedelta(days=14), son=son + timedelta(days=1),
                                    hedef_onek=["depo:"], urun_idler=list(pasta_id)):
                    ac.setdefault(h["hedef"].split(":", 1)[1], []).append((h["olay_zaman"], h["is_gunu"], "pasta", int(h["adet"])))
        except Exception:  # noqa: BLE001
            log.warning("bar: pasta kabulü okunamadı", exc_info=True)

    def bos():
        return {k: 0 for k in kodlar}

    def ac_topla(sid, t0, t1):
        out = bos()
        t0, t1 = _tr_saat(t0), _tr_saat(t1)
        for ts, _g, k, adet in ac.get(sid, []):
            ts = _tr_saat(ts)
            if ts is not None and t0 is not None and t1 is not None and t0 < ts <= t1:
                out[k] += adet
        return out

    sonuc = []
    for s_ in subeler:
        sid = s_["id"]
        gunler = []
        g = ay_bas
        while g <= son:
            e = ev.get(sid, {}).get(g, {})
            dun = ev.get(sid, {}).get(g - timedelta(days=1), {})
            acil, kap, dkap = e.get("acilis"), e.get("kapanis"), dun.get("kapanis")
            dkap_gun = None
            if dkap is None and acil and not dun.get("acilis"):   # B84: dün kapalı → son kapanış; araya kapanışsız açılış girerse zincir kopuk
                for i in range(2, 15):
                    gg = ev.get(sid, {}).get(g - timedelta(days=i), {})
                    if gg.get("kapanis"):
                        dkap, dkap_gun = gg["kapanis"], (g - timedelta(days=i)).isoformat()
                        break
                    if gg.get("acilis"):
                        break
            A, K, DK = (acil or {}).get("say"), (kap or {}).get("say"), (dkap or {}).get("say")
            gun = {"gun": g.isoformat(), "acilis_var": bool(acil), "kapanis_var": bool(kap), "kalemler": [], "devir_fark": 0, "ac_eksik": 0,
                   "kapanisci": (kap or {}).get("kim"), "kapanis_saat": _saat(kap["ts"]) if kap else None,
                   "acilisci": (acil or {}).get("kim"), "acilis_saat": _saat(acil["ts"]) if acil else None,
                   "dun_kapanisci": (dkap or {}).get("kim"), "dun_gunu": dkap_gun}
            if acil and kap:
                gun_ici = ac_topla(sid, acil["ts"], kap["ts"])
            elif acil:   # Codex P2 (B63): kapanış yokken de giren görünsün — açılıştan ertesi açılışa, o yoksa İŞ GÜNÜ SONUNA (02:00) kadar
                # (Codex 2. kontrol: açık uç geçmiş kapanışsız güne ertesi günün girişlerini taşırdı)
                from evvel_yeni_cekirdek import is_gunu_zamani as _igz
                gun_ici = ac_topla(sid, acil["ts"], (ev.get(sid, {}).get(g + timedelta(days=1), {}).get("acilis") or {}).get("ts") or _igz(g, 1, 59))
            else:
                gun_ici = bos()
            gece = ac_topla(sid, dkap["ts"], acil["ts"]) if (dkap and acil) else bos()
            for k, ad in kalemler:
                a = A.get(k) if A else None
                kk = K.get(k) if K else None
                dk = DK.get(k) if DK else None
                net = (a + gun_ici[k] - kk) if (a is not None and kk is not None) else None
                devir = (a - (dk + gece[k])) if (a is not None and dk is not None) else None
                gun["kalemler"].append({"kod": k, "ad": ad, "anahtar": anahtar_of[k], "dun_kapanis": dk, "gece_ac": gece[k], "acilis": a,
                                        "devir_fark": devir, "gun_ici_ac": gun_ici[k], "kapanis": kk, "net_eksilme": net,
                                        "ac_eksik": (-net if net is not None and net < 0 else 0)})
                if devir:
                    gun["devir_fark"] += 1
                if net is not None and net < 0:
                    gun["ac_eksik"] += 1
            gun["durum"] = ("kapanis_yok" if not kap else "acilis_yok" if not acil else
                            "sorun" if (gun["devir_fark"] or gun["ac_eksik"]) else "tamam")
            gunler.append(gun)
            g += timedelta(days=1)
        sonuc.append({"sube_id": sid, "ad": s_["ad"], "gunler": gunler,
                      "panel_yok": not any(x["acilis_var"] or x["kapanis_var"] for x in gunler),
                      "ozet": {"devir_sorunlu_gun": sum(1 for x in gunler if x["devir_fark"]),
                               "ac_eksik_gun": sum(1 for x in gunler if x["ac_eksik"]),
                               "kapanis_yok": sum(1 for x in gunler if x["durum"] == "kapanis_yok"),
                               "tamam": sum(1 for x in gunler if x["durum"] == "tamam")}})
    return {"kalemler": [{"kod": k, "ad": a, "anahtar": anahtar_of[k]} for k, a in kalemler], "subeler": sonuc, "evren": "yeni",
            "uyari": None if pasta_id else "Katalogda 'gününde tüketilir' işaretli ürün yok — pasta girişi sayılamıyor (Ürün kataloğu)",
            "not": "YENİ PANEL — tezgah sayımı (açılış/kapanış) + Ürün Aç'ta bara açılan + pasta kabulü. Devir farkı = bugün açılış − "
                   "(dün kapanış + gece giren). Net eksilme = açılış + gün içi giren − kapanış (satış + fire + ikram; kayıp değildir). "
                   "Eksiye düşerse Ürün Aç girilmemiş olabilir. Sayım gideri ve kasayı değiştirmez."}


@router.get("/ozet")
def bar_ozet(ay: Optional[str] = None, sube_id: Optional[str] = None, evren: Optional[str] = None):
    from evvel_yeni_tanim_api import subeler as _ey_subeler
    from evvel_yeni_cekirdek import bugun as _bugun, yeni_donem
    bugun = _bugun()
    a_ = (ay or bugun.strftime("%Y-%m"))[:7]
    ay_bas = date.fromisoformat(a_ + "-01")
    ay_son = (ay_bas.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    bas, son = ay_bas - timedelta(days=1), min(ay_son, bugun)
    with db() as (conn, cur):
        subeler = [s for s in _ey_subeler(cur) if not sube_id or s["id"] == sube_id]
        # A2/B4 (köprü taraması 23 Eki): kaynak BAKILAN aya göre (bugüne değil) — 1 Kasım'dan sonra Ekim raporu eski köprüden dolu gelir
        if (evren == "yeni") if evren in ("yeni", "eski") else yeni_donem(cur, son):   # Evvel Yeni defterleri; eski okuma yalnız geçişte
            return {"ay": a_, **_bar_yeni(cur, subeler, ay_bas, bas, son)}
        sids = [s["id"] for s in subeler]
        cur.execute("""SELECT sube_id::text AS sube_id, tarih, tip, cevap_ts, meta, personel_ad FROM sube_operasyon_event
                        WHERE tarih BETWEEN %s AND %s AND durum='tamamlandi' AND tip IN ('ACILIS','KAPANIS')
                          AND sube_id::text = ANY(%s) ORDER BY tarih, cevap_ts NULLS LAST""", (bas, son + timedelta(days=1), sids))
        olaylar = [dict(r) for r in cur.fetchall() or []]
        # Kapanış olayında personel_ad boş gelir → kapanışı gönderen kişi panelin ciro taslağından (devir defteriyle aynı kaynak)
        kapanan = {}
        try:
            with savepoint(cur, "sp_ey_bar_kapanan"):
                cur.execute("""SELECT DISTINCT ON (sube_id, tarih) sube_id::text AS sid, tarih, gonderen_ad FROM ciro_taslak
                                WHERE tarih BETWEEN %s AND %s AND COALESCE(gonderen_ad,'') NOT ILIKE '%%evo%%'
                                ORDER BY sube_id, tarih, olusturma DESC""", (bas - timedelta(days=1), son))
                kapanan = {(dict(r)["sid"], dict(r)["tarih"]): dict(r)["gonderen_ad"] for r in cur.fetchall() or []}
        except Exception:  # noqa: BLE001
            pass
        cur.execute("""SELECT sube_id::text AS sube_id, tarih, olay_ts, aciklama FROM operasyon_defter
                        WHERE etiket IN ('URUN_AC','URUN_KULLANIMA_AL') AND tarih BETWEEN %s AND %s
                          AND NOT (etiket='URUN_AC' AND aciklama LIKE '%%[BİTTİ]%%') AND sube_id::text = ANY(%s)
                        ORDER BY olay_ts""", (bas, son + timedelta(days=1), sids))
        defter = [dict(r) for r in cur.fetchall() or []]
        # Bara doğrudan giriş (sahip: pasta vitrine sevkle gelir, ürün aç ile değil)
        cur.execute("""SELECT sube_id::text AS sube_id, tarih, olay_ts, aciklama FROM operasyon_defter
                        WHERE etiket = 'URUN_STOK_EKLE' AND tarih BETWEEN %s AND %s AND sube_id::text = ANY(%s)""",
                    (bas, son + timedelta(days=1), sids))
        stok_ekle = [dict(r) for r in cur.fetchall() or []]
        # Fable B2 (21 Eki): pasta şubeye TEDARİKÇİDEN doğrudan gelir (eski panel 'Ürün Teslim Al' = URUN_SEVK) — bara giren pasta
        cur.execute("""SELECT id::text AS id, sube_id::text AS sube_id, tarih, olay_ts, aciklama FROM operasyon_defter
                        WHERE etiket = 'URUN_SEVK' AND tarih BETWEEN %s AND %s AND sube_id::text = ANY(%s)
                          AND id::text NOT IN (SELECT ref_event_id::text FROM operasyon_defter
                                                WHERE etiket = 'URUN_SEVK_IPTAL' AND ref_event_id IS NOT NULL)""",
                    (bas, son + timedelta(days=1), sids))
        sevk = [dict(r) for r in cur.fetchall() or []]
        pasta_kabul = []
        try:
            with savepoint(cur, "sp_ey_bar_kabul"):
                cur.execute("""SELECT y.sube_id::text AS sube_id, y.kabul_ts, y.kalem_kodu, COALESCE(y.kalem_adi, su.ad) AS ad,
                                      COALESCE(y.kabul_adet, 0) AS adet, su.depo_stok_kalem_kodu
                                 FROM stok_yolda y LEFT JOIN siparis_urun su ON su.id::text = y.kalem_kodu
                                WHERE y.kabul_ts IS NOT NULL AND y.kabul_adet > 0 AND y.sube_id::text = ANY(%s)
                                  AND (y.kabul_ts AT TIME ZONE 'Europe/Istanbul')::date BETWEEN %s AND %s""",
                            (sids, bas, son + timedelta(days=1)))
                pasta_kabul = [dict(r) for r in cur.fetchall() or []]
        except Exception:  # noqa: BLE001
            pasta_kabul = []
        idler = sorted({u for d in defter for u, _, _ in _urun_ac_parcala(d["aciklama"]) if u})
        urun = {}
        if idler:
            try:
                with savepoint(cur, "sp_ey_bar_urun"):
                    cur.execute("SELECT id::text AS id, ad, depo_stok_kalem_kodu FROM siparis_urun WHERE id::text = ANY(%s)", (idler,))
                    urun = {dict(r)["id"]: dict(r) for r in cur.fetchall() or []}
            except Exception:  # noqa: BLE001
                urun = {}

    def anahtar(uid, ad):
        u = urun.get(uid) or {}
        return _kod_anahtar(u.get("depo_stok_kalem_kodu")) or _anahtar_ad(u.get("ad") or ad)

    # şube → [(ts, kalem, adet)] ürün aç; şube → gün → {ACILIS, KAPANIS}
    ac = {}
    for d in defter:
        for uid, ad, adet in _urun_ac_parcala(d["aciklama"]):
            k = anahtar(uid, ad)
            if k:
                ac.setdefault(d["sube_id"], []).append((d["olay_ts"], d["tarih"], k, adet))
    for d in stok_ekle:
        for k, adet in _stok_ekle_parcala(d["aciklama"]):
            ac.setdefault(d["sube_id"], []).append((d["olay_ts"], d["tarih"], k, adet))
    sevk_pasta_gun = set()
    for d in sevk:
        for adet in _sevk_pasta_parcala(d["aciklama"]):
            ac.setdefault(d["sube_id"], []).append((d["olay_ts"], d["tarih"], "pasta", adet))
            sevk_pasta_gun.add((d["sube_id"], d["tarih"]))
    if sevk_pasta_gun:   # pasta hem teslim hem ürün aç ile girildiyse (Tema 20 Eki) TEK kaynak teslim: teslimden sonraki 24 saatteki ürün aç pastası düşer
        sevk_ts = {}
        for d in sevk:
            if _sevk_pasta_parcala(d["aciklama"]):
                sevk_ts.setdefault(d["sube_id"], []).append(_tr_saat(d["olay_ts"]))
        for sid_, lst in ac.items():
            ac[sid_] = [x for x in lst if not (x[2] == "pasta" and not _sevk_kaydi_mi(x, sevk) and _tr_saat(x[0]) is not None
                                                and any(s is not None and s <= _tr_saat(x[0]) <= s + timedelta(hours=24)
                                                        for s in sevk_ts.get(sid_, [])))]
    for r in pasta_kabul:
        k = _kod_anahtar(r.get("depo_stok_kalem_kodu")) or _kod_anahtar(r.get("kalem_kodu")) or _anahtar_ad(r.get("ad"))
        if k == "pasta":   # yalnız pasta: diğer kalemler depoya girer, bara ürün aç ile geçer
            ac.setdefault(r["sube_id"], []).append((r["kabul_ts"], None, k, int(r["adet"])))
    ev = {}
    for e in olaylar:
        ev.setdefault(e["sube_id"], {}).setdefault(e["tarih"], {})[e["tip"]] = e   # aynı gün ikinci kayıt sonuncuyu tutar

    _tr = _tr_saat   # TR duvar saati (çekirdek tr_duvar — aynı dosyadaki ikinci kopya kalktı)

    def ac_topla(sid, t0, t1, gun_yedek=None):
        """(t0, t1] aralığında açılan; saat yoksa iş gününe göre."""
        out = _bos()
        t0, t1 = _tr(t0), _tr(t1)
        for ts, tarih, k, adet in ac.get(sid, []):
            ts = _tr(ts)
            if ts is not None and t0 is not None and t1 is not None:
                if t0 < ts <= t1:
                    out[k] += adet
            elif gun_yedek is not None and tarih == gun_yedek:
                out[k] += adet
        return out

    sonuc = []
    for s in subeler:
        sid = s["id"]
        gunler = []
        g = ay_bas
        while g <= son:
            e = ev.get(sid, {}).get(g, {})
            dun = ev.get(sid, {}).get(g - timedelta(days=1), {})
            acil, kap, dkap = e.get("ACILIS"), e.get("KAPANIS"), dun.get("KAPANIS")
            A = _sayim(acil["meta"], "acilis_stok_sayim") if acil else None
            K = _sayim(kap["meta"], "kapanis_stok_sayim") if kap else None
            DK = _sayim(dkap["meta"], "kapanis_stok_sayim") if dkap else None
            gun = {"gun": g.isoformat(), "acilis_var": bool(A), "kapanis_var": bool(K), "kalemler": [], "devir_fark": 0, "ac_eksik": 0,
                   # sahip: "bar sayımında tıklandığında akşam kapanışçı olan personellerin isimlerini yazsın"
                   "kapanisci": (kap or {}).get("personel_ad") or (kapanan.get((sid, g)) if kap else None), "kapanis_saat": _saat(kap["cevap_ts"]) if kap else None,
                   "acilisci": (acil or {}).get("personel_ad"), "acilis_saat": _saat(acil["cevap_ts"]) if acil else None,
                   "dun_kapanisci": (dkap or {}).get("personel_ad") or (kapanan.get((sid, g - timedelta(days=1))) if dkap else None)}
            gun_ici = ac_topla(sid, acil["cevap_ts"] if acil else None, kap["cevap_ts"] if kap else None) if (acil and kap) else _bos()
            gece = ac_topla(sid, dkap["cevap_ts"] if dkap else None, acil["cevap_ts"] if acil else None) if (dkap and acil) else _bos()
            for k, ad in KALEMLER:
                a = A.get(k) if A else None
                kk = K.get(k) if K else None
                dk = DK.get(k) if DK else None
                net = (a + gun_ici[k] - kk) if (a is not None and kk is not None) else None
                devir = (a - (dk + gece[k])) if (a is not None and dk is not None) else None
                gun["kalemler"].append({"kod": k, "ad": ad, "dun_kapanis": dk, "gece_ac": gece[k], "acilis": a, "devir_fark": devir,
                                        "gun_ici_ac": gun_ici[k], "kapanis": kk, "net_eksilme": net,
                                        "ac_eksik": (-net if net is not None and net < 0 else 0)})
                if devir:
                    gun["devir_fark"] += 1
                if net is not None and net < 0:
                    gun["ac_eksik"] += 1
            gun["durum"] = ("kapanis_yok" if not K else "acilis_yok" if not A else
                            "sorun" if (gun["devir_fark"] or gun["ac_eksik"]) else "tamam")
            gunler.append(gun)
            g += timedelta(days=1)
        sonuc.append({"sube_id": sid, "ad": s["ad"], "gunler": gunler,
                      # Fable: Alsancak panelde sayım yapmıyor — ekranlar bunu "sorun" gibi göstermesin
                      "panel_yok": not any(x["acilis_var"] or x["kapanis_var"] for x in gunler),
                      "ozet": {"devir_sorunlu_gun": sum(1 for x in gunler if x["devir_fark"]),
                               "ac_eksik_gun": sum(1 for x in gunler if x["ac_eksik"]),
                               "kapanis_yok": sum(1 for x in gunler if x["durum"] == "kapanis_yok"),
                               "tamam": sum(1 for x in gunler if x["durum"] == "tamam")}})
    return {"ay": a_, "kalemler": [{"kod": k, "ad": a} for k, a in KALEMLER], "subeler": sonuc, "evren": "eski",
            "not": "Bara giriş = ürün aç + panelden stok ekle + pasta sevk kabulü. Devir farkı = bugün açılış − (dün kapanış + gece giren). Net eksilme = açılış + gün içi açılan − kapanış "
                   "(satış + fire + ikram birlikte; kayıp değildir). Net eksilme eksiye düşerse ürün aç girilmemiş olabilir. "
                   "Sayım gideri ve kasayı değiştirmez."}





# ── AÇIK KAPILAR (sök-tak): başka modüller iç '_' fonksiyonu değil BU adları kullanır — içerik aynı, kapı tek ──
kod_anahtar = _kod_anahtar
anahtar_ad = _anahtar_ad


def bar_gunu(cur, gun: date, sube_id: Optional[str] = None) -> dict:
    """PUBLIC — TEK iş gününün bar kaydı, çağıranın işleminde (Satış › sabah satırı, B62/B63): {şube: gün} — hesap _bar_yeni (tek formül;
    ay boyu hesap ve ikinci bağlantı açılmaz). Yalnız yeni evren."""
    from evvel_yeni_tanim_api import subeler as _ey_subeler
    subeler = [s for s in _ey_subeler(cur) if not sube_id or s["id"] == sube_id]
    r = _bar_yeni(cur, subeler, gun, gun - timedelta(days=1), gun)
    return {s["sube_id"]: s["gunler"][-1] for s in r["subeler"] if s["gunler"]}
