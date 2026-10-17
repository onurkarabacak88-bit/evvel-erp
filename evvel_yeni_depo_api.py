"""📦 EVVEL YENİ · DEPO TAKİBİ (2026-10-17) — sahip + Codex + Fable kurgusu.

Eski Evvel'de aynı stok 7 yerde hesaplanıyordu (bakiye tablosu, defter, merkez stok kartı, teorik bar stoğu...), sayım iz
bırakmıyor, yetmeyen stok sıfıra kırpılıp "bulundu" yazılıyordu (90 günde 509 karşılıksız sevk). Burada:

  · TEK HAREKET DEFTERİ `ey_stok_hareket`: ürün · ADET · kaynak konum → hedef konum · tür · gün · kim. Bakiye = defter toplamı;
    ayrı saklanan bakiye YOK. Düzeltme silmeyle değil iptal/ters kayıtla. `kaynak_ref` UNIQUE → aynı olay iki kez yazılmaz.
  · KONUMLAR: depo:<şube> (her şubenin deposu; Tema = merkez depo + Tema kafe — sahip "2 olsun": Tema'da ürün aç depodan düşer),
    yolda (sevk edildi, kabul bekliyor), dışarı:toptanci / dışarı:tuketim (ürün aç) / dışarı:fire / dışarı:sayim (sayım farkı).
  · KAYNAK: panelin kendi kayıtları KÖPRÜYLE okunur (panel akışına dokunulmaz): Ürün Teslim Al (URUN_SEVK, geri alınan iptal),
    stok_yolda (sevk + kabul), Ürün Aç (URUN_AC/URUN_KULLANIMA_AL, [BİTTİ] hariç), fire bildirimi. 1 Ekim'den itibaren.
  · EKSİ KIRPILMAZ: eksiye düşen kırmızı "kayıt eksik olabilir". Uydurma "bulundu" yok.
  · SAYIM: kör sayım; sayılan − o anki defter = FARK hareketi (çıpa). Sayılmayan ürün 0 sayılmaz. Konumdaki ilk sayım = açılış.
  · Her şey ADET (fiyatlar gibi).
"""

import json
import logging
import time
import uuid
from datetime import date, datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from database import db, savepoint
from evvel_yeni_kasa_api import _aktor, _bugun

router = APIRouter(prefix="/api/evvel-yeni/depo", tags=["evvel-yeni-depo"])
log = logging.getLogger(__name__)

BASLANGIC = date(2026, 10, 1)
SENKRON_SN = 300
GEC_KABUL_GUN = 2
_HAZIR = False
_SON_SENKRON = {"zaman": 0.0, "sonuc": None}
DISARI = {"dışarı:toptanci": "Toptancı", "dışarı:tuketim": "Ürün aç (tüketim)", "dışarı:fire": "Fire",
          "dışarı:sayim": "Sayım farkı", "dışarı:bilinmeyen": "Kaynağı belirsiz"}


def depo_hazirla(cur) -> None:
    global _HAZIR
    if _HAZIR:
        return
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_stok_hareket (
        id TEXT PRIMARY KEY, kaynak_ref TEXT UNIQUE NOT NULL, tur TEXT NOT NULL, urun_id TEXT NOT NULL, urun_ad TEXT,
        adet INT NOT NULL, kaynak TEXT NOT NULL, hedef TEXT NOT NULL, is_gunu DATE NOT NULL, olay_zaman TIMESTAMPTZ,
        kim TEXT, aciklama TEXT, bag TEXT, iptal BOOLEAN NOT NULL DEFAULT FALSE, iptal_sebep TEXT,
        zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ey_stok_h_urun ON ey_stok_hareket (urun_id, is_gunu)")
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_stok_sayim (
        id TEXT PRIMARY KEY, konum TEXT NOT NULL, is_gunu DATE NOT NULL, kim TEXT, acilis BOOLEAN NOT NULL DEFAULT FALSE,
        satirlar JSONB NOT NULL DEFAULT '[]'::jsonb, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    _HAZIR = True


def _n(x) -> str:
    return " ".join(str(x or "").replace("İ", "i").replace("I", "ı").lower().split())


def _urun_haritasi(cur):
    """siparis_urun: id / depo kalem kodu / ad → (urun_id, ad). Bulunamayan kod 'kod:<kod>' olarak izlenir (kaybolmaz)."""
    cur.execute("SELECT id::text AS id, ad, depo_stok_kalem_kodu FROM siparis_urun")
    by_kod, by_ad, ad = {}, {}, {}
    for r in cur.fetchall() or []:
        r = dict(r)
        by_kod[r["id"]] = r["id"]
        ad[r["id"]] = r["ad"]
        if r.get("depo_stok_kalem_kodu"):
            by_kod.setdefault(str(r["depo_stok_kalem_kodu"]), r["id"])
        by_ad.setdefault(_n(r["ad"]), r["id"])

    def coz(kod, adi=None):
        kod = str(kod or "").strip()
        if kod in by_kod:
            u = by_kod[kod]
            return u, ad.get(u) or adi
        if adi and _n(adi) in by_ad:
            u = by_ad[_n(adi)]
            return u, ad.get(u)
        return ("kod:" + kod if kod else "ad:" + _n(adi)), (adi or kod)
    return coz


def _depo_sube(cur) -> str:
    try:
        from evvel_yeni_gider_api import _depo_id
        return _depo_id(cur) or "sube-tema"
    except Exception:  # noqa: BLE001
        return "sube-tema"


def _yaz(cur, rows: List[tuple]) -> int:
    n = 0
    for r in rows:
        cur.execute("""INSERT INTO ey_stok_hareket (id, kaynak_ref, tur, urun_id, urun_ad, adet, kaynak, hedef, is_gunu, olay_zaman, kim, aciklama, bag)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (kaynak_ref) DO NOTHING""",
                    ("sh-" + uuid.uuid4().hex[:16],) + r)
        n += cur.rowcount
    return n


def _json_parca(acik: str, on: str) -> dict:
    s = acik or ""
    if not s.startswith(on):
        return {}
    try:
        return json.JSONDecoder().raw_decode(s[len(on):])[0]
    except Exception:  # noqa: BLE001
        return {}


def senkron(cur) -> dict:
    """Panel kayıtlarını deftere aktar (idempotent). Her kaynak kendi savepoint'inde — biri bozulursa diğerleri yazılır."""
    depo_hazirla(cur)
    coz = _urun_haritasi(cur)
    depo = _depo_sube(cur)
    rapor = {}

    # 1) GİRİŞ — Ürün Teslim Al (toptancıdan)
    try:
        with savepoint(cur, "sp_dp_giris"):
            cur.execute("""SELECT id, sube_id::text AS sid, tarih, olay_ts, aciklama, ref_event_id, etiket FROM operasyon_defter
                            WHERE etiket IN ('URUN_SEVK','URUN_SEVK_IPTAL') AND tarih >= %s ORDER BY olay_ts""", (BASLANGIC,))
            rs = [dict(x) for x in cur.fetchall() or []]
            rows, iptaller = [], []
            for r in rs:
                if r["etiket"] == "URUN_SEVK_IPTAL":
                    if r.get("ref_event_id"):
                        iptaller.append(str(r["ref_event_id"]))
                    continue
                p = _json_parca(r["aciklama"], "URUN_SEVK_JSON:")
                for i, k in enumerate(p.get("kalemler") or []):
                    try:
                        adet = int(k.get("adet") or 0)
                    except (TypeError, ValueError):
                        adet = 0
                    if adet <= 0:
                        continue
                    uid, uad = coz(k.get("urun_id"), k.get("urun_ad"))
                    rows.append((f"urun_sevk:{r['id']}:{i}", "giris", uid, uad, adet, "dışarı:toptanci", f"depo:{r['sid']}",
                                 r["tarih"], r["olay_ts"], None, f"Ürün teslim al · {p.get('tedarikci') or 'toptancı'}", None))
            rapor["giris"] = _yaz(cur, rows)
            for did in iptaller:
                cur.execute("""UPDATE ey_stok_hareket SET iptal=TRUE, iptal_sebep='panelde geri alındı'
                                WHERE kaynak_ref LIKE %s AND NOT iptal""", (f"urun_sevk:{did}:%",))
    except Exception as e:  # noqa: BLE001
        log.warning("depo senkron giriş: %s", str(e)[:200])

    # 2) SEVK + KABUL — stok_yolda
    try:
        with savepoint(cur, "sp_dp_yolda"):
            cur.execute("""SELECT y.id, y.sube_id::text AS hedef, y.kalem_kodu, y.kalem_adi, y.sevk_adet, y.sevk_ts, y.kabul_ts, y.kabul_adet, y.durum,
                                  COALESCE(y.sevk_kaynak_depo_sube_id, %s) AS kaynak
                             FROM stok_yolda y WHERE y.sevk_ts >= %s ORDER BY y.sevk_ts""", (depo, BASLANGIC))
            rows = []
            for r in [dict(x) for x in cur.fetchall() or []]:
                if str(r["kaynak"]) == str(r["hedef"]):
                    continue   # kendinden kendine (Tema → Tema): net sıfır
                uid, uad = coz(r["kalem_kodu"], r["kalem_adi"])
                sv = int(r["sevk_adet"] or 0)
                gun = (r["sevk_ts"] + timedelta(hours=3)).date()
                if sv > 0:
                    rows.append((f"yolda:{r['id']}:sevk", "sevk", uid, uad, sv, f"depo:{r['kaynak']}", "yolda", gun, r["sevk_ts"], None,
                                 "Depodan sevk", r["id"]))
                if r.get("kabul_ts") is not None and r.get("kabul_adet") is not None:
                    kb = int(r["kabul_adet"] or 0)
                    kgun = (r["kabul_ts"] + timedelta(hours=3)).date()
                    if min(kb, sv) > 0:
                        rows.append((f"yolda:{r['id']}:kabul", "kabul", uid, uad, min(kb, sv), "yolda", f"depo:{r['hedef']}", kgun, r["kabul_ts"],
                                     None, "Şube kabulü" + (f" (sevk {sv}, kabul {kb})" if kb != sv else ""), r["id"]))
                    if kb > sv:
                        rows.append((f"yolda:{r['id']}:fazla", "fazla_kabul", uid, uad, kb - sv, "dışarı:bilinmeyen", f"depo:{r['hedef']}", kgun,
                                     r["kabul_ts"], None, f"Sevkten FAZLA kabul (sevk {sv}, kabul {kb}) — birim karışmış olabilir", r["id"]))
            rapor["yolda"] = _yaz(cur, rows)
    except Exception as e:  # noqa: BLE001
        log.warning("depo senkron yolda: %s", str(e)[:200])

    # 3) ÜRÜN AÇ — tüketim
    try:
        with savepoint(cur, "sp_dp_ac"):
            from evvel_yeni_gider_api import _urun_ac_parcala
            cur.execute("""SELECT id, sube_id::text AS sid, tarih, olay_ts, aciklama, etiket FROM operasyon_defter
                            WHERE etiket IN ('URUN_AC','URUN_KULLANIMA_AL') AND tarih >= %s
                              AND NOT (etiket='URUN_AC' AND aciklama LIKE '%%[BİTTİ]%%')""", (BASLANGIC,))
            rows = []
            for r in [dict(x) for x in cur.fetchall() or []]:
                for i, (u, ad, adet) in enumerate(_urun_ac_parcala(r["aciklama"])):
                    uid, uad = coz(u, ad)
                    rows.append((f"ac:{r['id']}:{i}", "ac", uid, uad, int(adet), f"depo:{r['sid']}", "dışarı:tuketim", r["tarih"], r["olay_ts"],
                                 None, "Ürün aç" if r["etiket"] == "URUN_AC" else "Kullanıma al", None))
            rapor["ac"] = _yaz(cur, rows)
    except Exception as e:  # noqa: BLE001
        log.warning("depo senkron ürün aç: %s", str(e)[:200])

    # 4) FİRE
    try:
        with savepoint(cur, "sp_dp_fire"):
            cur.execute("""SELECT id, sube_id::text AS sid, tarih, olusturma, kalemler, sebep_label, personel_ad FROM sube_fire_bildirim
                            WHERE tarih >= %s""", (BASLANGIC,))
            rows = []
            for r in [dict(x) for x in cur.fetchall() or []]:
                kal = r["kalemler"] if isinstance(r["kalemler"], list) else json.loads(r["kalemler"] or "[]")
                for i, k in enumerate(kal):
                    try:
                        adet = int(float(k.get("miktar") or 0))
                    except (TypeError, ValueError):
                        adet = 0
                    if adet <= 0:
                        continue
                    uid, uad = coz(k.get("kalem_kodu"), k.get("label"))
                    rows.append((f"fire:{r['id']}:{i}", "fire", uid, uad, adet, f"depo:{r['sid']}", "dışarı:fire", r["tarih"], r["olusturma"],
                                 r.get("personel_ad"), f"Fire · {r.get('sebep_label') or ''}", None))
            rapor["fire"] = _yaz(cur, rows)
    except Exception as e:  # noqa: BLE001
        log.warning("depo senkron fire: %s", str(e)[:200])
    return rapor


def _otomatik_senkron() -> None:
    simdi = time.time()
    if simdi - _SON_SENKRON["zaman"] < SENKRON_SN:
        return
    _SON_SENKRON["zaman"] = simdi
    try:
        with db() as (conn, cur):
            _SON_SENKRON["sonuc"] = senkron(cur)
    except Exception as e:  # noqa: BLE001
        log.warning("depo otomatik senkron: %s", str(e)[:200])


def _bakiyeler(cur) -> dict:
    """{(urun_id, konum): adet} — iptal olmayan hareketlerden."""
    cur.execute("""SELECT urun_id, konum, SUM(d) AS adet FROM (
                     SELECT urun_id, hedef AS konum, adet AS d FROM ey_stok_hareket WHERE NOT iptal
                     UNION ALL SELECT urun_id, kaynak AS konum, -adet AS d FROM ey_stok_hareket WHERE NOT iptal) x
                   GROUP BY urun_id, konum""")
    return {(dict(r)["urun_id"], dict(r)["konum"]): int(dict(r)["adet"] or 0) for r in cur.fetchall() or []}


def _konumlar(cur) -> list:
    from evvel_yeni_tanim_api import subeler as _ey_subeler
    depo = _depo_sube(cur)
    out = []
    for s in sorted(_ey_subeler(cur), key=lambda x: (x["id"] != depo, x["ad"])):
        out.append({"id": f"depo:{s['id']}", "ad": s["ad"] + (" (merkez depo + kafe)" if s["id"] == depo else ""), "merkez": s["id"] == depo,
                    "sube_id": s["id"]})
    out.append({"id": "yolda", "ad": "Yolda", "merkez": False, "sube_id": None})
    return out


@router.get("/ozet")
def depo_ozet():
    """📦 NEREDE? — ürün × konum (kategori sırasıyla). Eski sistemin bakiyesi yalnız KARŞILAŞTIRMA için."""
    _otomatik_senkron()
    with db() as (conn, cur):
        depo_hazirla(cur)
        konumlar = _konumlar(cur)
        B = _bakiyeler(cur)
        cur.execute("""SELECT k.id::text AS kid, k.ad AS kat, k.emoji, k.sira AS ks, u.id::text AS id, u.ad, u.sira
                         FROM siparis_urun u JOIN siparis_kategori k ON k.id = u.kategori_id
                        WHERE u.aktif AND k.aktif ORDER BY k.sira, k.ad, u.sira, u.ad""")
        katalog = [dict(r) for r in cur.fetchall() or []]
        cur.execute("SELECT DISTINCT urun_id, urun_ad FROM ey_stok_hareket")
        hareketli = {dict(r)["urun_id"]: dict(r)["urun_ad"] for r in cur.fetchall() or []}
        eski = {}
        try:
            with savepoint(cur, "sp_dp_eski"):
                cur.execute("SELECT sube_id::text AS sid, kalem_kodu, mevcut_adet FROM sube_depo_stok")
                for r in cur.fetchall() or []:
                    r = dict(r)
                    eski[(str(r["kalem_kodu"]), f"depo:{r['sid']}")] = int(r["mevcut_adet"] or 0)
        except Exception:  # noqa: BLE001
            pass
        cur.execute("SELECT konum, MAX(is_gunu) AS son, BOOL_OR(acilis) AS acilis FROM ey_stok_sayim GROUP BY konum")
        sayimlar = {dict(r)["konum"]: dict(r) for r in cur.fetchall() or []}
    kat_ad = {}
    satirlar = []
    goruldu = set()
    for u in katalog:
        goruldu.add(u["id"])
        kat_ad[u["kid"]] = f"{u['emoji'] or ''} {u['kat']}".strip()
        satirlar.append({"urun_id": u["id"], "ad": u["ad"], "kategori": kat_ad[u["kid"]]})
    for uid, uad in hareketli.items():   # katalogda olmayan ama hareketi olan (eski kod) — kaybolmasın
        if uid not in goruldu:
            satirlar.append({"urun_id": uid, "ad": uad or uid, "kategori": "❔ Katalogda eşleşmeyen"})
    eksi = 0
    for s in satirlar:
        s["bakiye"] = {k["id"]: B.get((s["urun_id"], k["id"]), 0) for k in konumlar}
        s["eski"] = {k["id"]: eski.get((s["urun_id"], k["id"])) for k in konumlar}
        s["eksi"] = [k for k, v in s["bakiye"].items() if v < 0]
        eksi += len(s["eksi"])
    satirlar = [s for s in satirlar if any(s["bakiye"].values()) or s["kategori"] != "❔ Katalogda eşleşmeyen"]
    return {"konumlar": [{**k, "son_sayim": (sayimlar.get(k["id"]) or {}).get("son").isoformat() if (sayimlar.get(k["id"]) or {}).get("son") else None,
                          "acilis_sayimi": bool((sayimlar.get(k["id"]) or {}).get("acilis"))} for k in konumlar],
            "satirlar": satirlar, "eksi_sayi": eksi, "senkron": _SON_SENKRON["sonuc"],
            "baslangic": BASLANGIC.isoformat(),
            "not": "Stok = 1 Ekim'den bu yana panel kayıtlarının toplamı (Ürün Teslim Al + kabul − sevk − ürün aç − fire ± sayım). "
                   "Konumda AÇILIŞ SAYIMI yapılana kadar rakamlar başlangıç stoğunu içermez. Tema'da ürün aç depodan düşer."}


@router.get("/iz")
def depo_iz(urun_id: str, konum: str):
    """Bir ürünün bir konumdaki izi: ne geldi/gitti, nereden/nereye, ne zaman, kalan."""
    with db() as (conn, cur):
        depo_hazirla(cur)
        cur.execute("""SELECT * FROM ey_stok_hareket WHERE urun_id=%s AND (kaynak=%s OR hedef=%s)
                        ORDER BY is_gunu, olay_zaman NULLS LAST, zaman""", (urun_id, konum, konum))
        rs = [dict(r) for r in cur.fetchall() or []]
        konum_ad = {k["id"]: k["ad"] for k in _konumlar(cur)}
    konum_ad.update(DISARI)
    kalan, out = 0, []
    for r in rs:
        d = r["adet"] if r["hedef"] == konum else -r["adet"]
        if not r["iptal"]:
            kalan += d
        karsi = r["kaynak"] if r["hedef"] == konum else r["hedef"]
        out.append({"gun": r["is_gunu"].isoformat(), "tur": r["tur"], "aciklama": r["aciklama"], "d": d,
                    "karsi": ("← " if d > 0 else "→ ") + konum_ad.get(karsi, karsi), "kim": r.get("kim"),
                    "iptal": r["iptal"], "iptal_sebep": r.get("iptal_sebep"), "kalan": kalan})
    return {"urun_id": urun_id, "konum": konum, "konum_ad": konum_ad.get(konum, konum), "iz": out[::-1], "kalan": kalan}


@router.get("/yolda")
def depo_yolda():
    """Yoldakiler (sevk edildi, kabul edilmedi) + sevk ≠ kabul olanlar. GEC_KABUL_GUN'den eski olan kırmızı."""
    _otomatik_senkron()
    bugun = _bugun()
    with db() as (conn, cur):
        depo_hazirla(cur)
        cur.execute("""SELECT bag, MAX(urun_ad) AS urun_ad, MAX(urun_id) AS urun_id,
                              SUM(CASE WHEN tur='sevk' THEN adet ELSE 0 END) AS sevk,
                              SUM(CASE WHEN tur='kabul' THEN adet ELSE 0 END) AS kabul,
                              SUM(CASE WHEN tur='fazla_kabul' THEN adet ELSE 0 END) AS fazla,
                              MIN(CASE WHEN tur='sevk' THEN is_gunu END) AS sevk_gunu,
                              MAX(CASE WHEN tur='sevk' THEN kaynak END) AS kaynak,
                              MAX(CASE WHEN tur IN ('kabul','fazla_kabul') THEN hedef END) AS hedef_k
                         FROM ey_stok_hareket WHERE bag IS NOT NULL AND NOT iptal GROUP BY bag""")
        rs = [dict(r) for r in cur.fetchall() or []]
        cur.execute("SELECT id, sube_id::text AS hedef FROM stok_yolda WHERE sevk_ts >= %s", (BASLANGIC,))
        hedefler = {dict(r)["id"]: dict(r)["hedef"] for r in cur.fetchall() or []}
        konum_ad = {k["id"]: k["ad"] for k in _konumlar(cur)}
    bekleyen, fark = [], []
    for r in rs:
        hedef = r.get("hedef_k") or (f"depo:{hedefler.get(r['bag'])}" if hedefler.get(r["bag"]) else None)
        x = {"id": r["bag"], "urun": r["urun_ad"], "urun_id": r["urun_id"], "sevk": int(r["sevk"] or 0), "kabul": int(r["kabul"] or 0),
             "fazla": int(r["fazla"] or 0), "sevk_gunu": r["sevk_gunu"].isoformat() if r["sevk_gunu"] else None,
             "nereden": konum_ad.get(r["kaynak"], r["kaynak"]), "nereye": konum_ad.get(hedef, hedef)}
        x["gun"] = (bugun - r["sevk_gunu"]).days if r["sevk_gunu"] else None
        if x["sevk"] and x["kabul"] == 0 and x["fazla"] == 0:
            x["gec"] = bool(x["gun"] is not None and x["gun"] >= GEC_KABUL_GUN)
            bekleyen.append(x)
        elif x["sevk"] and (x["kabul"] < x["sevk"] or x["fazla"]):
            fark.append(x)
    bekleyen.sort(key=lambda z: z["sevk_gunu"] or "")
    fark.sort(key=lambda z: z["sevk_gunu"] or "", reverse=True)
    return {"bekleyen": bekleyen, "fark": fark, "gec_sayi": sum(1 for x in bekleyen if x["gec"]), "gec_gun": GEC_KABUL_GUN}


class SayimBody(BaseModel):
    konum: str
    satirlar: List[dict]          # [{urun_id, sayilan}] — boş bırakılan ürün SAYILMAZ (0 sayılmaz)
    acilis: bool = False
    gun: Optional[str] = None


@router.post("/sayim")
def depo_sayim(body: SayimBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Kör sayım → her sayılan ürün için FARK hareketi (sayılan − defter). Defter sayım ANINDAKİ haliyle karşılaştırılır."""
    gun = date.fromisoformat((body.gun or _bugun().isoformat())[:10])
    if gun > _bugun():
        raise HTTPException(400, "Gelecek tarihli sayım olmaz")
    with db() as (conn, cur):
        depo_hazirla(cur)
        if body.konum not in {k["id"] for k in _konumlar(cur)} or body.konum == "yolda":
            raise HTTPException(400, "Sayım yalnız bir şube deposunda yapılır")
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("ey_depo_sayim:" + body.konum,))
        kim = _aktor(cur, x_evvel_oturum)
        B = _bakiyeler(cur)
        coz = _urun_haritasi(cur)
        sid = "ss-" + uuid.uuid4().hex[:12]
        rows, kayit = [], []
        for s in body.satirlar:
            if s.get("sayilan") in (None, ""):
                continue
            try:
                say = int(s["sayilan"])
            except (TypeError, ValueError):
                raise HTTPException(400, f"Sayı yaz: {s.get('urun_id')}")
            if say < 0:
                raise HTTPException(400, "Sayılan eksi olamaz")
            uid = str(s["urun_id"])
            onceki = B.get((uid, body.konum), 0)
            f_ = say - onceki
            kayit.append({"urun_id": uid, "sayilan": say, "defter": onceki, "fark": f_})
            if f_:
                uad = coz(uid)[1]
                rows.append((f"sayim:{sid}:{uid}", "acilis_sayim" if body.acilis else "sayim", uid, uad, abs(f_),
                             "dışarı:sayim" if f_ > 0 else body.konum, body.konum if f_ > 0 else "dışarı:sayim", gun, datetime.now(),
                             kim, ("Açılış sayımı" if body.acilis else "Sayım") + f" — defter {onceki}, sayılan {say}", sid))
        if not kayit:
            raise HTTPException(400, "Hiç ürün sayılmadı")
        cur.execute("INSERT INTO ey_stok_sayim (id, konum, is_gunu, kim, acilis, satirlar) VALUES (%s,%s,%s,%s,%s,%s::jsonb)",
                    (sid, body.konum, gun, kim, body.acilis, json.dumps(kayit, ensure_ascii=False)))
        _yaz(cur, rows)
    return {"ok": True, "mesaj": f"{len(kayit)} ürün sayıldı · {sum(1 for k in kayit if k['fark'])} üründe fark yazıldı", "sayim_id": sid,
            "farklar": [k for k in kayit if k["fark"]]}


class KabulBody(BaseModel):
    sebep: Optional[str] = None


@router.post("/yolda/{yid}/merkez-kabul")
def merkez_kabul(yid: str, body: KabulBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Fable: şube kabulü unutursa sevk sonsuza dek 'yolda' kalmasın — merkez, sevk adediyle kabul eder (iz: merkez adına).
    Şube sonradan kabul ederse aynı kayıt kimliği olduğu için İKİNCİ kez yazılmaz."""
    with db() as (conn, cur):
        depo_hazirla(cur)
        kim = _aktor(cur, x_evvel_oturum)
        cur.execute("SELECT * FROM ey_stok_hareket WHERE kaynak_ref=%s AND NOT iptal", (f"yolda:{yid}:sevk",))
        sv = cur.fetchone()
        if not sv:
            raise HTTPException(404, "Sevk bulunamadı")
        sv = dict(sv)
        cur.execute("SELECT sube_id::text AS hedef FROM stok_yolda WHERE id=%s", (yid,))
        h = cur.fetchone()
        if not h:
            raise HTTPException(404, "Sevkin hedef şubesi bulunamadı")
        n = _yaz(cur, [(f"yolda:{yid}:kabul", "kabul", sv["urun_id"], sv["urun_ad"], sv["adet"], "yolda", f"depo:{dict(h)['hedef']}",
                        _bugun(), datetime.now(), kim, "Merkez adına kabul" + (f" · {body.sebep}" if body.sebep else ""), yid)])
    if not n:
        raise HTTPException(409, "Bu sevk zaten kabul edilmiş")
    return {"ok": True, "mesaj": "Merkez adına kabul edildi"}


@router.post("/senkron")
def depo_senkron_simdi():
    with db() as (conn, cur):
        r = senkron(cur)
    _SON_SENKRON["zaman"] = time.time()
    _SON_SENKRON["sonuc"] = r
    return {"ok": True, "rapor": r}


def depo_isleri(cur) -> list:
    """Bekleyen işler: GEC_KABUL_GUN'den uzun süredir yolda olan sevkler."""
    depo_hazirla(cur)
    cur.execute("""SELECT bag, MAX(urun_ad) AS urun, MIN(is_gunu) AS gun FROM ey_stok_hareket WHERE bag IS NOT NULL AND NOT iptal
                    GROUP BY bag HAVING SUM(CASE WHEN tur='sevk' THEN 1 ELSE 0 END) > 0
                       AND SUM(CASE WHEN tur IN ('kabul','fazla_kabul') THEN 1 ELSE 0 END) = 0
                       AND MIN(is_gunu) <= %s""", (_bugun() - timedelta(days=GEC_KABUL_GUN),))
    rs = [dict(r) for r in cur.fetchall() or []]
    if not rs:
        return []
    return [{"tur": "depo_yolda", "id": "dy", "tarih": min(r["gun"] for r in rs).isoformat(), "ad": f"{len(rs)} sevk kalemi",
             "sayi": len(rs), "ornek": ", ".join(str(r["urun"]) for r in rs[:3])}]
