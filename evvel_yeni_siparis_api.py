"""🛒 EVVEL YENİ · SİPARİŞ (Basamak 5 S5 — SIPARIS_TASARIM.md rev 2 + PANEL_YENIDEN_KURULUM.md "S5", sahip D1–D4 2026-10-20).

Sipariş, mevcut Depo ve Toptancılar altyapısının ÜZERİNE bir TALEP + YÖNLENDİRME katmanıdır. Ayrı stok / yolda / teslim defteri YOK:
  · ey_siparis      — şubenin talebi (kalemler JSONB: i · urun_id|null · ad · adet). Katalog dışı istek = urun_id NULL "öneri" (D4).
  · ey_siparis_yon  — merkezin kararı: kalem i → kaynak 'depo:{şube}' ya da 'toptanci:{id}' · adet · hazir (Tema hazırlığı, stok yazmaz)
                      · parti_id/parti_i (Depo ey_sevk_parti — Yola çıkınca) · teslim_id (Toptancı teslimi bağlanınca).
  · DURUM SAKLANMAZ — satırlardan türetilir: yönlendirilmedi → hazırlanıyor / toptancıdan bekleniyor → yolda → karşılandı.
  · Depo (sevk_yaz/kabul_yaz) ve Toptancı (teslim_yaz) siparişi TANIMAZ — bağ yalnız burada (tak-çıkar: modül kapalıyken sevk/teslim çalışır).
  · D1 aynı gün ikinci sipariş = ayrı talep · D2 1 Kasım öncesi talep/yönlendirme/hazırlık GERÇEK (deneme=TRUE, stok yok), Yola çıkar DENEME
  · D3 toptancıya merkez iletir (panelde yalnız "beklenen") · Kısmi Yola çıkar → kalan yönlendirilmemişe döner (Fable R1).
"""

import json
import logging
import uuid
from datetime import date
from typing import List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from database import db, savepoint
from evvel_yeni_cekirdek import adet_oku, kalem_topla, merkez_aktor
from evvel_yeni_cekirdek import bekleyen_is_kaydet, is_gunu as _is_gunu

router = APIRouter(prefix="/api/evvel-yeni/siparis", tags=["evvel-yeni-siparis"])
log = logging.getLogger(__name__)

TAKIP_GUN = 21          # eski panel: son 21 gün
YONSUZ_SAAT = 24        # bu kadar saattir yönlendirilmemiş talep → Bekleyen işler


# ─────────────────────────── HAZIRLIK (19 Eki dersi: çağıranın işleminde, savepoint + lock_timeout, yalnız eksikse) ───────────────────────────
def siparis_hazirla(cur) -> None:
    if _var(cur):
        return
    try:
        with savepoint(cur, "sp_ey_siparis_hazirla"):
            _onceki_lt = __import__("evvel_yeni_cekirdek").lock_timeout_ayarla(cur, "3s")
            cur.execute("""CREATE TABLE IF NOT EXISTS ey_siparis (
                id TEXT PRIMARY KEY, sube_id TEXT NOT NULL, kim TEXT, personel_id TEXT, istek_id TEXT UNIQUE, notu TEXT,
                is_gunu DATE NOT NULL, kalemler JSONB NOT NULL DEFAULT '[]'::jsonb, surum INT NOT NULL DEFAULT 1,
                deneme BOOLEAN NOT NULL DEFAULT FALSE, iptal BOOLEAN NOT NULL DEFAULT FALSE, iptal_kim TEXT, iptal_sebep TEXT,
                iptal_zaman TIMESTAMPTZ, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_ey_siparis_sube ON ey_siparis (sube_id, zaman)")
            cur.execute("""CREATE TABLE IF NOT EXISTS ey_siparis_yon (
                id TEXT PRIMARY KEY, siparis_id TEXT NOT NULL, kalem_i INT NOT NULL, kaynak TEXT NOT NULL, adet INT NOT NULL,
                hazir INT, parti_id TEXT, parti_i INT, teslim_id TEXT, iptal BOOLEAN NOT NULL DEFAULT FALSE, iptal_sebep TEXT,
                kim TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_ey_siparis_yon_s ON ey_siparis_yon (siparis_id)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_ey_siparis_yon_k ON ey_siparis_yon (kaynak, iptal)")
            __import__("evvel_yeni_cekirdek").lock_timeout_ayarla(cur, _onceki_lt)   # çağıranın değeri geri (Fable D4-4)
    except Exception:  # noqa: BLE001
        log.warning("sipariş tabloları kurulamadı", exc_info=True)
        raise HTTPException(503, "Sipariş hazırlanıyor — birkaç saniye sonra tekrar dene")


def _var(cur) -> bool:
    return __import__("evvel_yeni_cekirdek").tablo_var(cur, "ey_siparis", "ey_siparis_yon")   # çekirdek (F#14)


def _kilit(cur, sid: str) -> None:
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("ey_siparis:" + str(sid),))


def _sube_adlari(cur) -> dict:
    return __import__("evvel_yeni_tanim_api").adlar(cur, "ey_sube")


def _toptanci_adlari(cur) -> dict:
    """Aktif toptancılar — Tanımlar'ın seçim listesi (TEK kaynak; sipariş toptancı tablosunu doğrudan okumaz)."""
    from evvel_yeni_tanim_api import secim_listeleri
    return {str(t["id"]): t["ad"] for t in secim_listeleri(cur).get("toptancilar") or []}


def _merkez_depo(cur) -> Optional[str]:
    from evvel_yeni_tanim_api import depo_sube_id
    return depo_sube_id(cur)


def _olu_yonleri_kapat(cur, sid: str) -> None:
    """Fable B1: merkez sevki geri aldıysa (paket iptal) o yön satırı ÖLÜ — kapatılır ki kalem yeniden yönlendirilebilsin / iptal edilebilsin.
    Durum Depo'nun TEK hesabından (sevk_kalem_durumlari); Depo siparişi tanımaz, temizlik sipariş tarafında."""
    cur.execute("SELECT * FROM ey_siparis_yon WHERE siparis_id=%s AND NOT iptal AND parti_id IS NOT NULL", (sid,))
    ys = [dict(r) for r in cur.fetchall() or []]
    for yid, d in _sevk_durumlari(cur, ys).items():
        if d["durum"] == "geri_alindi":
            cur.execute("UPDATE ey_siparis_yon SET iptal=TRUE, iptal_sebep='sevk geri alındı' WHERE id=%s", (yid,))


def _kaynak_ad(k: str, sube_ad: dict, top_ad: dict) -> str:
    t, _, x = k.partition(":")
    return (sube_ad.get(x, x) + " deposu") if t == "depo" else (top_ad.get(x, x) if t == "toptanci" else k)


# ─────────────────────────── PUBLIC: YAZ ───────────────────────────
def siparis_yaz(cur, *, sube_id: str, kalemler: List[dict], kim: str, personel_id: Optional[str], istek_id: str,
                notu: Optional[str] = None, deneme: bool = False, gun: Optional[date] = None) -> dict:
    """PUBLIC (panel Sipariş ver). kalemler [{urun_id, adet}] ya da öneri [{ad, adet}] (katalog dışı, D4).
    Aynı istek_id → tekrar; farklı içerik → 409. Her gönderim AYRI talep (D1)."""
    siparis_hazirla(cur)
    from evvel_yeni_urun_api import urun_bilgi
    istek_id = __import__("evvel_yeni_cekirdek").istek_dogrula(istek_id)   # TEK kural (F#15)
    top, oneriler = kalem_topla(kalemler, oneri_olur=True, birim="siparişte")   # Sevk ile TEK kalem kuralı (F#22)
    b = urun_bilgi(cur, list(top))
    yok = [u for u in top if u not in b or not b[u].get("aktif", True)]
    if yok:
        raise HTTPException(400, "Ürün katalogda yok ya da pasif — listeyi yenile")
    kal = [{"urun_id": u, "ad": b[u]["ad"], "adet": a} for u, a in sorted(top.items(), key=lambda kv: b[kv[0]]["ad"])]
    kal += [{"urun_id": None, "ad": o["ad"], "adet": o["adet"], "oneri": True} for o in oneriler]
    for i, k in enumerate(kal):
        k["i"] = i
    _kilit(cur, "istek:" + str(istek_id))
    cur.execute("SELECT id, sube_id, kalemler FROM ey_siparis WHERE istek_id=%s", (str(istek_id),))
    r = cur.fetchone()
    if r:
        r = dict(r)
        anahtar = lambda ks: sorted((k.get("urun_id") or "", k.get("ad") if not k.get("urun_id") else "", k["adet"]) for k in ks)  # noqa: E731
        if r["sube_id"] != str(sube_id) or anahtar(r["kalemler"] or []) != anahtar(kal):
            raise HTTPException(409, "Bu sipariş başka içerikle zaten gönderilmiş — sayfayı yenile")
        return {"siparis_id": r["id"], "tekrar": True, "kalem": len(kal)}
    sid = uuid.uuid4().hex[:12]
    cur.execute("""INSERT INTO ey_siparis (id, sube_id, kim, personel_id, istek_id, notu, is_gunu, kalemler, deneme)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s)""",
                (sid, str(sube_id), kim, personel_id, str(istek_id), (notu or "").strip()[:300] or None, gun or _is_gunu(),
                 json.dumps(kal, ensure_ascii=False), bool(deneme)))
    return {"siparis_id": sid, "tekrar": False, "kalem": len(kal)}


def _siparis_al(cur, sid: str, surum: Optional[int] = None) -> dict:
    cur.execute("SELECT * FROM ey_siparis WHERE id=%s", (sid,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Sipariş bulunamadı")
    r = dict(r)
    if r["iptal"]:
        raise HTTPException(409, "Sipariş iptal edilmiş")
    if surum is not None and int(surum) != int(r["surum"]):   # A13 bayat ekran kilidi
        raise HTTPException(409, "Bu sipariş başka biri tarafından değişti — sayfayı yenile")
    return r


def _surum_artir(cur, sid: str) -> None:
    cur.execute("UPDATE ey_siparis SET surum = surum + 1 WHERE id=%s", (sid,))


# ─────────────────────────── DURUM (türetilir) ───────────────────────────
def _yonler(cur, sids: List[str]) -> dict:
    if not sids:
        return {}
    cur.execute("SELECT * FROM ey_siparis_yon WHERE siparis_id = ANY(%s) AND NOT iptal ORDER BY zaman", (sids,))
    out = {}
    for y in [dict(r) for r in cur.fetchall() or []]:
        out.setdefault(y["siparis_id"], []).append(y)
    return out


def _sevk_durumlari(cur, yonler: List[dict]) -> dict:
    """{yon_id: {'durum': yolda|karsilandi|geri_alindi, 'kabul': n}} — Depo'nun TEK hesabından (sevk_kalem_durumlari)."""
    bag = {y["id"]: f"sevk:{y['parti_id']}:{y['parti_i']}" for y in yonler if y.get("parti_id") and y.get("parti_i") is not None}
    if not bag:
        return {}
    from evvel_yeni_depo_api import sevk_kalem_durumlari
    D = sevk_kalem_durumlari(cur, list(bag.values()))
    out = {}
    for yid, b in bag.items():
        d = D.get(b) or {"iptal": True}
        out[yid] = {"durum": "geri_alindi", "kabul": None} if d["iptal"] else (
            {"durum": "karsilandi", "kabul": d["kabul"]} if d.get("kabul") is not None else {"durum": "yolda", "kabul": None})
    return out


def _toptanci(fn: str):
    """Toptancılar modülünün PUBLIC fonksiyonu — modül kapalıysa None (yumuşak bağ: sipariş yine çalışır)."""
    from evvel_yeni_moduller import acik as _acik
    if not _acik("toptanci"):
        return None
    import evvel_yeni_toptanci_api as t
    return getattr(t, fn)


def _teslim_durumlari(cur, yonler: List[dict], urunler: dict) -> dict:
    """{yon_id: teslim edilen adet} — Toptancılar'ın teslim_kalemleri kapısından. İPTAL edilmiş teslim döndürülmez (çağıran o yönü
    'bekleniyor'a çevirir). Codex P1: aynı teslim + aynı ürün BİRDEN ÇOK yöne bağlıysa teslimin adedi yönlere SIRAYLA paylaştırılır
    (her yöne toplamın tamamı yazılıyordu → 10 fiziksel ürün 20 karşılanmış görünüyordu); artan son yöne (fazla gelen)."""
    f = _toptanci("teslim_kalemleri")
    tid = [y["teslim_id"] for y in yonler if y.get("teslim_id")]
    if not f or not tid:
        return {}
    T = f(cur, tid)
    grup = {}
    for y in sorted(yonler, key=lambda y: (str(y.get("teslim_id")), str(y.get("zaman") or ""), str(y["id"]))):   # oluşturma sırası (Fable D4-7)
        if not y.get("teslim_id") or str(y["teslim_id"]) not in T:
            continue
        u = str(urunler.get((y["siparis_id"], y["kalem_i"])))
        grup.setdefault((str(y["teslim_id"]), u), []).append(y)
    out = {}
    for (t, u), ys in grup.items():
        kalan = int(T[t].get(u, 0) or 0)
        for n, y in enumerate(ys):
            pay = kalan if n == len(ys) - 1 else min(kalan, int(y["adet"]))
            out[y["id"]] = pay
            kalan -= pay
    return out


def _derle(cur, rows: List[dict], kor: bool = False) -> List[dict]:
    """Siparişleri kalem + yön durumlarıyla. kor=True (şube paneli): sevk / kabul ADEDİ DÖNMEZ (kör sayım — Fable R3)."""
    Y = _yonler(cur, [r["id"] for r in rows])
    hepsi = [y for v in Y.values() for y in v]
    urunler = {(r["id"], k["i"]): k.get("urun_id") for r in rows for k in (r["kalemler"] or [])}
    sv = _sevk_durumlari(cur, hepsi)
    tv = _teslim_durumlari(cur, hepsi, urunler)
    sube_ad, top_ad = _sube_adlari(cur), _toptanci_adlari(cur)
    out = []
    for r in rows:
        kal_out, tamam = [], True
        for k in r["kalemler"] or []:
            if k.get("iptal"):
                kal_out.append({**k, "durum": "iptal", "yonler": [], "yonsuz": 0})
                continue
            ys, dagitilan, karsilanan = [], 0, 0
            for y in [y for y in Y.get(r["id"], []) if y["kalem_i"] == k["i"]]:
                tur = y["kaynak"].split(":", 1)[0]
                if tur == "depo":
                    s = sv.get(y["id"])
                    if s and s["durum"] == "geri_alindi":
                        continue   # sevk geri alındı → kalem yeniden yönlendirilmemiş sayılır
                    d = "hazirlaniyor" if not y.get("parti_id") else s["durum"] if s else "yolda"
                    gelen = s["kabul"] if s else None
                else:
                    # Codex P1: bağlı teslim İPTAL edildiyse (okuyucu döndürmez) yön yeniden 'bekleniyor' — iptal teslim siparişi tamamlamaz
                    bagli = bool(y.get("teslim_id")) and y["id"] in tv
                    d = "karsilandi" if bagli else "bekleniyor"
                    gelen = tv.get(y["id"]) if bagli else None
                dagitilan += int(y["adet"])
                if d == "karsilandi":
                    karsilanan += int(gelen if gelen is not None else y["adet"])
                yy = {"id": y["id"], "kaynak": y["kaynak"], "kaynak_ad": _kaynak_ad(y["kaynak"], sube_ad, top_ad), "durum": d}
                if not kor:   # Fable B3: şube paneli sevk / hazır / gelen ADEDİNİ görmez (kör sayım)
                    yy.update({"adet": int(y["adet"]), "hazir": y.get("hazir"), "gelen": gelen})
                ys.append(yy)
            yonsuz = max(0, int(k["adet"]) - dagitilan)
            if k.get("oneri") and not k.get("urun_id"):
                d = "oneri"
            elif yonsuz > 0:
                d = "yonlendirilmedi"
            elif ys and all(y["durum"] == "karsilandi" for y in ys):
                d = "karsilandi"
            else:
                d = "yolda" if any(y["durum"] == "yolda" for y in ys) else (
                    "bekleniyor" if any(y["durum"] == "bekleniyor" for y in ys) else "hazirlaniyor")
            if d != "karsilandi":
                tamam = False
            kk = {"i": k["i"], "urun_id": k.get("urun_id"), "ad": k["ad"], "adet": int(k["adet"]), "oneri": bool(k.get("oneri")),
                  "durum": d, "yonsuz": yonsuz, "yonler": ys}
            eksik = 0 if k.get("eksik_kapandi") else (max(0, dagitilan - karsilanan) if d == "karsilandi" else 0)
            if eksik:
                tamam = False   # Codex P1: istenenden az geldi → sipariş AÇIK kalır (yoksa Bekleyen işler'den düşüyordu)
            if not kor:
                kk["eksik"] = eksik
                kk["eksik_kapandi"] = k.get("eksik_kapandi")
            kk["_eksik"] = eksik
            kal_out.append(kk)
        tamam = tamam and any(k["durum"] != "iptal" for k in kal_out)
        eksik_var = any([k.pop("_eksik", 0) for k in kal_out])   # LİSTE: hepsinden silinsin (any kısa devre panele sızdırıyordu — Fable D4-2)
        durum = "iptal" if r["iptal"] else ("tamamlandi" if not eksik_var and (tamam or all(k["durum"] in ("iptal", "karsilandi") for k in kal_out))
                                            else "acik")
        out.append({"id": r["id"], "sube_id": r["sube_id"], "sube": sube_ad.get(r["sube_id"], r["sube_id"]), "kim": r["kim"],
                    "notu": r["notu"], "gun": r["is_gunu"].isoformat(), "zaman": r["zaman"].isoformat(), "surum": r["surum"],
                    "deneme": bool(r["deneme"]), "durum": durum, "iptal_sebep": r.get("iptal_sebep"), "kalemler": kal_out})
    return out


# ─────────────────────────── PUBLIC: OKU (panel) ───────────────────────────
def subenin_siparisleri(cur, sube_id: str) -> List[dict]:
    """PUBLIC (panel Sipariş takip): son 21 gün — KÖR (sevk / kabul adedi dönmez)."""
    if not _var(cur):
        return []
    cur.execute("SELECT * FROM ey_siparis WHERE sube_id=%s AND zaman > NOW() - make_interval(days => %s) ORDER BY zaman DESC",
                (str(sube_id), TAKIP_GUN))
    return _derle(cur, [dict(r) for r in cur.fetchall() or []], kor=True)


def bekleyen_urunler(cur, sube_id: str, siparisler: Optional[List[dict]] = None) -> dict:
    """PUBLIC (panel Sipariş ver rozeti — A2/A12): {urun_id: 'bekliyor'|'yolda'} — ADETSİZ (kör kural). siparisler verilirse yeniden türetmez."""
    out = {}
    for s in (siparisler if siparisler is not None else subenin_siparisleri(cur, sube_id)):
        if s["durum"] != "acik":
            continue
        for k in s["kalemler"]:
            if not k.get("urun_id") or k["durum"] in ("karsilandi", "iptal"):
                continue
            out[k["urun_id"]] = "yolda" if k["durum"] == "yolda" or out.get(k["urun_id"]) == "yolda" else "bekliyor"
    return out


def gonderilecek(cur, depo_sube: str) -> List[dict]:
    """PUBLIC (Tema paneli Gönderilecek — A9): kaynağı bu depo olan, henüz yola çıkmamış yön satırları, talep şubesine göre.
    Depo personeli GÖNDERECEĞİ adedi görür (kör değil — hazırlık listesi)."""
    if not _var(cur):
        return []
    cur.execute("""SELECT y.*, s.sube_id AS hedef, s.kalemler, s.zaman AS s_zaman, s.surum, s.notu, s.deneme FROM ey_siparis_yon y
                     JOIN ey_siparis s ON s.id = y.siparis_id
                    WHERE y.kaynak=%s AND NOT y.iptal AND y.parti_id IS NULL AND NOT s.iptal ORDER BY s.zaman""", (f"depo:{depo_sube}",))
    rows = [dict(r) for r in cur.fetchall() or []]
    sube_ad = _sube_adlari(cur)
    grup = {}
    for y in rows:
        k = next((x for x in y["kalemler"] or [] if x["i"] == y["kalem_i"]), {})
        if k.get("iptal"):
            continue
        g = grup.setdefault(y["hedef"], {"hedef": y["hedef"], "hedef_ad": sube_ad.get(y["hedef"], y["hedef"]), "kalemler": [], "deneme": False})
        g["deneme"] = g["deneme"] or bool(y["deneme"])
        g["kalemler"].append({"yon_id": y["id"], "siparis_id": y["siparis_id"], "surum": y["surum"], "urun_id": k.get("urun_id"),
                              "ad": k.get("ad"), "adet": int(y["adet"]), "hazir": y.get("hazir"), "not": y.get("notu")})
    return list(grup.values())


def toptanci_beklenen(cur, sube_id: str) -> List[dict]:
    """PUBLIC (panel Tedarikçiden teslim al kartları — A10, D3): bu şubeye toptancıdan BEKLENEN kalemler (beklenen adet dolu)."""
    if not _var(cur):
        return []
    cur.execute("""SELECT y.id, y.kaynak, y.adet, y.kalem_i, s.kalemler, s.zaman FROM ey_siparis_yon y JOIN ey_siparis s ON s.id = y.siparis_id
                    WHERE s.sube_id=%s AND y.kaynak LIKE 'toptanci:%%' AND NOT y.iptal AND y.teslim_id IS NULL AND NOT s.iptal
                    ORDER BY s.zaman""", (str(sube_id),))
    top_ad = _toptanci_adlari(cur)
    grup = {}
    for y in [dict(r) for r in cur.fetchall() or []]:
        tid = y["kaynak"].split(":", 1)[1]
        k = next((x for x in y["kalemler"] or [] if x["i"] == y["kalem_i"]), {})
        if k.get("iptal"):
            continue
        g = grup.setdefault(tid, {"toptanci_id": tid, "toptanci": top_ad.get(tid, tid), "kalemler": []})
        g["kalemler"].append({"yon_id": y["id"], "urun_id": k.get("urun_id"), "ad": k.get("ad"), "adet": int(y["adet"])})
    return list(grup.values())


# ─────────────────────────── PUBLIC: Gönderilecek → hazırlık / Yola çıkar (panel çağırır) ───────────────────────────
def hazirlik_yaz(cur, *, depo_sube: str, satirlar: List[dict]) -> int:
    """'Hazırlığı kaydet' (A9): yön satırına hazır adet — STOK YAZMAZ (SIPARIS_TASARIM §2.3)."""
    siparis_hazirla(cur)
    n = 0
    for x in satirlar:
        h = x.get("hazir")
        if h is not None:
            h = adet_oku(h, "Hazır adet")
        cur.execute("""UPDATE ey_siparis_yon SET hazir=%s WHERE id=%s AND kaynak=%s AND parti_id IS NULL AND NOT iptal""",
                    (h, str(x.get("yon_id")), f"depo:{depo_sube}"))
        n += cur.rowcount
    return n


def yola_cikar(cur, *, depo_sube: str, hedef_sube: str, satirlar: List[dict], kim: str, istek_id: str) -> dict:
    """Tema 'Yola çıkar' (A9): satirlar [{yon_id, surum, gonderilen}] — 0 = YOK. Depo PUBLIC sevk_yaz (tek işlem) + yön satırına parti bağı.
    Kısmi (gönderilen < adet) → yön adedi gönderilene iner, kalan yönlendirilmemişe DÖNER (Fable R1); YOK → yön iptal (merkez yeniden karar)."""
    siparis_hazirla(cur)
    from evvel_yeni_depo_api import sevk_yaz
    if not satirlar:
        raise HTTPException(400, "Gönderilecek kalem yok")
    for sid in sorted({str(x.get("siparis_id") or "") for x in satirlar}):
        _kilit(cur, sid)
    from evvel_yeni_cekirdek import yeni_donem
    gercek = yeni_donem(cur)
    ys = {}
    for x in satirlar:
        cur.execute("""SELECT y.*, s.sube_id AS hedef, s.surum, s.iptal AS s_iptal, s.kalemler FROM ey_siparis_yon y
                         JOIN ey_siparis s ON s.id=y.siparis_id WHERE y.id=%s FOR UPDATE OF y""", (str(x.get("yon_id")),))
        y = cur.fetchone()
        if not y:
            raise HTTPException(404, "Gönderilecek kalem bulunamadı — sayfayı yenile")
        y = dict(y)
        if y["iptal"] or y["s_iptal"] or y["parti_id"] or y["kaynak"] != f"depo:{depo_sube}" or y["hedef"] != str(hedef_sube):
            raise HTTPException(409, "Bu kalem değişti (yola çıkmış / iptal / başka yere yönlendirilmiş) — sayfayı yenile")
        if x.get("surum") is not None and int(x["surum"]) != int(y["surum"]):
            raise HTTPException(409, "Merkez bu siparişi değiştirdi — sayfayı yenile")
        cur.execute("SELECT deneme FROM ey_siparis WHERE id=%s", (y["siparis_id"],))
        if gercek and dict(cur.fetchone())["deneme"]:   # Fable #6: 1 Kasım öncesi deneme siparişi gerçek sevke dönüşmesin
            raise HTTPException(409, "Bu bir DENEME siparişi (1 Kasım öncesi) — merkez kapatsın, şube yeniden sipariş versin")
        if any(k.get("iptal") for k in y["kalemler"] if k["i"] == y["kalem_i"]):
            raise HTTPException(409, "Bu kalem iptal edilmiş — sayfayı yenile")
        g = x.get("gonderilen")
        if not isinstance(g, int) or isinstance(g, bool) or g < 0:
            raise HTTPException(400, "Gönderilen adet 0 ya da daha büyük tam sayı")
        if g > int(y["adet"]):
            raise HTTPException(400, f"{next((k['ad'] for k in y['kalemler'] if k['i'] == y['kalem_i']), 'Ürün')}: istenenden fazla gönderilemez")
        ys[y["id"]] = (y, g)
    urun = lambda y: next(k["urun_id"] for k in y["kalemler"] if k["i"] == y["kalem_i"])   # noqa: E731
    # Fable B2: sevk_yaz aynı ürünü TOPLAR → iki yön tek kaleme çöker, kabul iki kez sayılırdı. Aynı ürün ikinci kez geçiyorsa
    # AYRI paket (tur) — her yön kendi paket kalemine (bag) bağlanır, kabul ayrı sayılır.
    turlar = []
    for y, g in sorted((v for v in ys.values() if v[1] > 0), key=lambda v: (v[0]["siparis_id"], v[0]["kalem_i"])):
        t = next((t for t in turlar if urun(y) not in {urun(z) for z, _ in t}), None)
        if t is None:
            turlar.append([])
            t = turlar[-1]
        t.append((y, g))
    sonuc = {"parti_id": None, "kalem": 0, "eksi": [], "paket": len(turlar)}
    for n, tur in enumerate(turlar):
        r = sevk_yaz(cur, kaynak_sube=depo_sube, hedef_sube=hedef_sube, kalemler=[{"urun_id": urun(y), "adet": g} for y, g in tur], kim=kim,
                     istek_id=istek_id if n == 0 else f"{istek_id}-{n}",
                     notu="Sipariş: " + ", ".join(sorted({y["siparis_id"] for y, _ in tur})))
        idx = {k["urun_id"]: i for i, k in enumerate(r["kalemler"])}   # #5: sıralı kalemler sevk_yaz'dan (Depo tablosuna uzanma yok)
        for y, g in tur:
            cur.execute("UPDATE ey_siparis_yon SET parti_id=%s, parti_i=%s, adet=%s, hazir=%s WHERE id=%s",
                        (r["parti_id"], idx[urun(y)], g, g, y["id"]))
        sonuc["parti_id"] = sonuc["parti_id"] or r["parti_id"]
        sonuc["kalem"] += r["kalem"]
        sonuc["eksi"] += r.get("eksi") or []
    for y, g in ys.values():
        if g == 0:
            cur.execute("UPDATE ey_siparis_yon SET iptal=TRUE, iptal_sebep='depoda yok (Gönderilecek: YOK)', kim=%s WHERE id=%s", (kim, y["id"]))
    for sid in {y["siparis_id"] for y, _ in ys.values()}:
        _surum_artir(cur, sid)
    return {**sonuc, "yok": sum(1 for _, g in ys.values() if g == 0), "kismi": sum(1 for y, g in ys.values() if 0 < g < int(y["adet"]))}


def teslim_iptal_edildi(cur, teslim_id: str) -> int:
    """PUBLIC (Toptancı teslim iptali): o teslime bağlı yönler ÇÖZÜLÜR (teslim_id boşalır) → kalem yeniden 'bekleniyor', yeni teslime
    bağlanabilir / yeniden yönlendirilebilir (Fable D4-1: aksi hâlde sipariş sonsuza kadar açık, kilitli kalıyordu). Dönüş: çözülen yön."""
    if not _var(cur):
        return 0
    cur.execute("SELECT DISTINCT siparis_id FROM ey_siparis_yon WHERE teslim_id=%s AND NOT iptal", (str(teslim_id),))
    sidler = sorted({dict(x)["siparis_id"] for x in cur.fetchall() or []})
    for sid in sidler:
        _kilit(cur, sid)
    cur.execute("UPDATE ey_siparis_yon SET teslim_id=NULL WHERE teslim_id=%s AND NOT iptal", (str(teslim_id),))
    n = cur.rowcount
    for sid in sidler:
        _surum_artir(cur, sid)
    return n


def teslime_bagla(cur, *, sube_id: str, teslim_id: str, toptanci_id: str, yon_idler: List[str]) -> int:
    """PUBLIC (panel Tedarikçiden teslim al, A10): seçilen 'beklenen' kartlarının yön satırlarını teslime bağlar (aynı işlem)."""
    siparis_hazirla(cur)
    f = _toptanci("teslim_kalemleri")
    tk = (f(cur, [teslim_id]) if f else {}).get(str(teslim_id), {})
    n = 0
    yidler = sorted({str(x) for x in yon_idler or []})
    cur.execute("SELECT DISTINCT siparis_id FROM ey_siparis_yon WHERE id = ANY(%s)", (yidler,))
    sidler = sorted({dict(x)["siparis_id"] for x in cur.fetchall() or []})
    for sid in sidler:   # Codex P1: merkez yönlendirmesiyle AYNI sipariş kilidi (sabit sıra) — bağlama ile yeniden yönlendirme yarışmasın
        _kilit(cur, sid)
    for yid in yidler:
        cur.execute("""SELECT y.kalem_i, s.kalemler FROM ey_siparis_yon y JOIN ey_siparis s ON s.id=y.siparis_id WHERE y.id=%s""", (yid,))
        r = cur.fetchone()
        u = next((k.get("urun_id") for k in (dict(r)["kalemler"] if r else []) if k["i"] == dict(r)["kalem_i"]), None) if r else None
        if not u or not tk.get(str(u)):   # Fable #13: teslimde o ürün yoksa sahte 'eksik' doğmasın
            raise HTTPException(400, "Seçilen sipariş kartındaki ürün bu teslimde yok — kartı kaldır ya da ürünü ekle")
        cur.execute("""UPDATE ey_siparis_yon y SET teslim_id=%s FROM ey_siparis s
                        WHERE y.id=%s AND s.id=y.siparis_id AND s.sube_id=%s AND y.kaynak=%s AND y.teslim_id IS NULL AND NOT y.iptal""",
                    (str(teslim_id), yid, str(sube_id), f"toptanci:{toptanci_id}"))
        if not cur.rowcount:
            raise HTTPException(409, "Beklenen sipariş kartı değişti — sayfayı yenile")
        n += 1
    for sid in sidler:
        _surum_artir(cur, sid)   # merkez ekranı eski sürümle yönlendiremesin (409 → yenile)
    return n


# ─────────────────────────── MERKEZ UÇLARI ───────────────────────────
def _merkez(cur, jeton: Optional[str]) -> str:
    kim = merkez_aktor(cur, jeton)   # çekirdek kapısı (F#2)
    return kim


@router.get("/liste")
def liste(gorunum: str = "acik", gun_sayisi: int = 30, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez: açık siparişler (Yönlendirme + Takip) ya da geçmiş (tamamlanan / iptal)."""
    with db() as (conn, cur):
        siparis_hazirla(cur)
        _merkez(cur, x_evvel_oturum)
        cur.execute("""SELECT * FROM ey_siparis WHERE zaman > NOW() - make_interval(days => %s) ORDER BY zaman""",
                    (max(1, min(int(gun_sayisi), 120)),))
        hepsi = _derle(cur, [dict(r) for r in cur.fetchall() or []])
        depo = _merkez_depo(cur)
        from evvel_yeni_urun_api import urun_bilgi
        uids = sorted({k["urun_id"] for s in hepsi for k in s["kalemler"] if k.get("urun_id")})
        bil = urun_bilgi(cur, uids)
        son_top = _son_toptancilar(cur, uids)
    for s in hepsi:
        for k in s["kalemler"]:
            b = bil.get(str(k.get("urun_id") or ""), {})
            k["pasta"] = __import__("evvel_yeni_urun_api").gununde_tuketilir(b)
            k["oneri_kaynak"] = (f"toptanci:{son_top[k['urun_id']]}" if k.get("urun_id") in son_top else None) if k["pasta"] \
                else (f"depo:{depo}" if k.get("urun_id") else None)
    sec = [s for s in hepsi if (s["durum"] == "acik") == (gorunum != "gecmis")]
    return {"siparisler": sec if gorunum != "gecmis" else list(reversed(sec)), "depo": depo}


def _son_toptancilar(cur, uids: List[str]) -> dict:
    """'Varsayılanları uygula' (A11): Toptancılar'ın son_toptancilar kapısı (modül kapalıysa boş)."""
    f = _toptanci("son_toptancilar")
    if not f:
        return {}
    try:
        with savepoint(cur, "sp_sip_son_top"):
            return f(cur, uids)
    except Exception:  # noqa: BLE001
        log.warning("sipariş: son toptancılar okunamadı", exc_info=True)
        return {}


class YonBody(BaseModel):
    surum: int
    kalemler: List[dict]   # [{i, yonler: [{kaynak, adet}]}] — kalemin YOLA ÇIKMAMIŞ yönleri bununla DEĞİŞİR · ya da {i, iptal: "sebep"}


@router.post("/{sid}/yon")
def yonlendir(sid: str, body: YonBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez Yönlendirme (A11): kalem → depo:{şube} / toptanci:{id}; bölünebilir. Stok / borç YAZMAZ. Yola çıkmış / teslime bağlanmış
    yön satırına dokunulmaz. Pasta (gununde) depoya yönlendirilmez (Fable R6 — sevk edilmez)."""
    with db() as (conn, cur):
        siparis_hazirla(cur)
        kim = _merkez(cur, x_evvel_oturum)
        _kilit(cur, sid)
        s = _siparis_al(cur, sid, body.surum)
        _olu_yonleri_kapat(cur, sid)
        from evvel_yeni_urun_api import urun_bilgi
        merkez_depo = _merkez_depo(cur)
        top_ok = set(_toptanci_adlari(cur))
        kal = {k["i"]: k for k in s["kalemler"] or []}
        bil = urun_bilgi(cur, [k["urun_id"] for k in kal.values() if k.get("urun_id")])
        kalemler = list(s["kalemler"] or [])
        for x in body.kalemler:
            i = x.get("i")
            if i not in kal:
                raise HTTPException(400, "Kalem bulunamadı — sayfayı yenile")
            k = kal[i]
            if k.get("iptal"):   # Fable #9
                raise HTTPException(409, f"{k['ad']}: kalem iptal edilmiş — sayfayı yenile")
            cur.execute("""SELECT id, adet, parti_id, teslim_id FROM ey_siparis_yon WHERE siparis_id=%s AND kalem_i=%s AND NOT iptal""", (sid, i))
            mevcut = [dict(r) for r in cur.fetchall() or []]
            kilitli = sum(int(y["adet"]) for y in mevcut if y["parti_id"] or y["teslim_id"])
            if x.get("iptal"):
                if kilitli:
                    raise HTTPException(409, f"{k['ad']}: bir kısmı yola çıktı / teslim alındı — iptal edilemez")
                cur.execute("UPDATE ey_siparis_yon SET iptal=TRUE, iptal_sebep='kalem iptal', kim=%s WHERE siparis_id=%s AND kalem_i=%s AND NOT iptal",
                            (kim, sid, i))
                kalemler = [{**kk, "iptal": True, "iptal_sebep": str(x["iptal"])[:200]} if kk["i"] == i else kk for kk in kalemler]
                continue
            if not k.get("urun_id"):
                raise HTTPException(400, f"{k['ad']}: katalog dışı öneri — önce ürünü bağla ya da reddet")
            yeni, top = [], kilitli
            for yy in x.get("yonler") or []:
                kn, a = str(yy.get("kaynak") or ""), adet_oku(yy.get("adet"), "Yönlendirilen adet", en_az=1)   # TEK adet kuralı
                t, _, ref = kn.partition(":")
                if t == "depo":
                    if not merkez_depo or ref != merkez_depo:   # Fable #7: Gönderilecek yalnız merkez depoda — başka şube deposu görünmezdi
                        raise HTTPException(400, "Depodan yalnız merkez depo gönderir")
                    if ref == s["sube_id"]:
                        raise HTTPException(400, "Şube kendi deposundan kendine sevk edemez")
                    if __import__("evvel_yeni_urun_api").gununde_tuketilir(bil.get(k["urun_id"], {})):
                        raise HTTPException(400, f"{k['ad']}: pasta depodan gönderilmez — toptancıya yönlendir")
                elif t == "toptanci":
                    if ref not in top_ok:
                        raise HTTPException(400, "Toptancı bulunamadı")
                else:
                    raise HTTPException(400, "Kaynak: depo ya da toptancı")
                yeni.append((kn, a))
                top += a
            if top > int(k["adet"]):
                raise HTTPException(400, f"{k['ad']}: istenenden ({k['adet']}) fazla yönlendirilemez")
            cur.execute("""UPDATE ey_siparis_yon SET iptal=TRUE, iptal_sebep='yeniden yönlendirildi', kim=%s
                            WHERE siparis_id=%s AND kalem_i=%s AND NOT iptal AND parti_id IS NULL AND teslim_id IS NULL""", (kim, sid, i))
            for kn, a in yeni:
                cur.execute("""INSERT INTO ey_siparis_yon (id, siparis_id, kalem_i, kaynak, adet, kim) VALUES (%s,%s,%s,%s,%s,%s)""",
                            (uuid.uuid4().hex[:12], sid, i, kn, a, kim))
        cur.execute("UPDATE ey_siparis SET kalemler=%s::jsonb WHERE id=%s", (json.dumps(kalemler, ensure_ascii=False), sid))
        _surum_artir(cur, sid)
    return {"ok": True, "mesaj": "Yönlendirildi"}


class OneriBody(BaseModel):
    surum: int
    urun_id: Optional[str] = None   # boş = reddet
    sebep: Optional[str] = None


@router.post("/{sid}/kalem/{i}/oneri")
def oneri_karar(sid: str, i: int, body: OneriBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """D4: katalog dışı öneri → katalogdaki ürüne BAĞLA (merkez ürünü önce Tanımlar › Ürünler'de açar) ya da REDDET."""
    with db() as (conn, cur):
        siparis_hazirla(cur)
        kim = _merkez(cur, x_evvel_oturum)
        _kilit(cur, sid)
        s = _siparis_al(cur, sid, body.surum)
        kal = list(s["kalemler"] or [])
        k = next((x for x in kal if x["i"] == i), None)
        if not k or not k.get("oneri") or k.get("urun_id") or k.get("iptal"):
            raise HTTPException(409, "Bu kalem öneri değil ya da karar verilmiş — sayfayı yenile")
        if body.urun_id:
            from evvel_yeni_urun_api import urun_bilgi
            b = urun_bilgi(cur, [body.urun_id]).get(str(body.urun_id))
            if not b or not b.get("aktif", True):
                raise HTTPException(400, "Ürün katalogda yok ya da pasif")
            k.update({"urun_id": str(body.urun_id), "oneri_ad": k["ad"], "ad": b["ad"], "baglayan": kim})
            mesaj = f"'{k['oneri_ad']}' → {b['ad']} olarak bağlandı"
        else:
            k.update({"iptal": True, "iptal_sebep": ("öneri reddedildi" + (f": {body.sebep}" if body.sebep else ""))[:200], "baglayan": kim})
            mesaj = "Öneri reddedildi"
        cur.execute("UPDATE ey_siparis SET kalemler=%s::jsonb WHERE id=%s", (json.dumps(kal, ensure_ascii=False), sid))
        _surum_artir(cur, sid)
    return {"ok": True, "mesaj": mesaj}


class EksikBody(BaseModel):
    surum: int
    sebep: str


@router.post("/{sid}/kalem/{i}/eksik-kapat")
def eksik_kapat(sid: str, i: int, body: EksikBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Fable #4: istenenden az gelen kalemi GEREKÇEYLE kapat (iptal değil, karşılanmış da değil — 'eksik kapandı'). Kayıp/fire
    Depo'nun fark çözümünde; burada yalnız siparişin 'eksik' satırı Bekleyen işler'den kalkar. Yeniden istenecekse yönlendir."""
    if len((body.sebep or "").strip()) < 3:
        raise HTTPException(400, "Sebep yaz")
    with db() as (conn, cur):
        siparis_hazirla(cur)
        kim = _merkez(cur, x_evvel_oturum)
        _kilit(cur, sid)
        s = _siparis_al(cur, sid, body.surum)
        kal = list(s["kalemler"] or [])
        k = next((x for x in kal if x["i"] == i), None)
        if not k or k.get("iptal"):
            raise HTTPException(409, "Kalem bulunamadı — sayfayı yenile")
        k["eksik_kapandi"] = f"{body.sebep.strip()[:150]} · {kim}"
        cur.execute("UPDATE ey_siparis SET kalemler=%s::jsonb WHERE id=%s", (json.dumps(kal, ensure_ascii=False), sid))
        _surum_artir(cur, sid)
    return {"ok": True, "mesaj": "Eksik kapatıldı"}


class IptalBody(BaseModel):
    sebep: str
    surum: Optional[int] = None


@router.post("/{sid}/iptal")
def merkez_iptal(sid: str, body: IptalBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    if len((body.sebep or "").strip()) < 3:
        raise HTTPException(400, "Sebep yaz")
    with db() as (conn, cur):
        siparis_hazirla(cur)
        kim = _merkez(cur, x_evvel_oturum)
        siparis_iptal(cur, sid=sid, kim=kim, sebep=body.sebep.strip(), surum=body.surum)
    return {"ok": True, "mesaj": "Sipariş iptal edildi"}


def siparis_iptal(cur, *, sid: str, kim: str, sebep: str, surum: Optional[int] = None, sube_id: Optional[str] = None) -> None:
    """PUBLIC: yola çıkmış / teslim alınmış kalemi olan sipariş iptal edilmez (sevk kendi kuralıyla merkez Sevk et'ten geri alınır).
    sube_id verilirse (panel): yalnız o şubenin ve HİÇ yönlendirilmemiş siparişi."""
    _kilit(cur, sid)   # kilidi kendisi alır (çağıran sipariş modülünün özel fonksiyonuna uzanmasın)
    s = _siparis_al(cur, sid, surum)
    if sube_id is not None and s["sube_id"] != str(sube_id):
        raise HTTPException(403, "Bu sipariş başka şubenin")
    _olu_yonleri_kapat(cur, sid)
    cur.execute("SELECT COUNT(*) FILTER (WHERE parti_id IS NOT NULL OR teslim_id IS NOT NULL) AS k, COUNT(*) AS n FROM ey_siparis_yon WHERE siparis_id=%s AND NOT iptal", (sid,))
    r = dict(cur.fetchone())
    if r["k"]:
        raise HTTPException(409, "Bir kısmı yola çıktı / teslim alındı — iptal edilemez")
    if sube_id is not None and r["n"]:
        raise HTTPException(409, "Merkez yönlendirdi — iptal için merkeze haber ver")
    cur.execute("UPDATE ey_siparis_yon SET iptal=TRUE, iptal_sebep='sipariş iptal', kim=%s WHERE siparis_id=%s AND NOT iptal", (kim, sid))
    cur.execute("UPDATE ey_siparis SET iptal=TRUE, iptal_kim=%s, iptal_sebep=%s, iptal_zaman=NOW(), surum=surum+1 WHERE id=%s",
                (kim, sebep[:200], sid))


@router.post("/deneme-temizle")
def deneme_temizle(x_evvel_oturum: Optional[str] = Header(default=None)):
    """D2: 31 Ekim akşamı — 1 Kasım öncesi deneme siparişleri iptal (silinmez, iz kalır)."""
    with db() as (conn, cur):
        siparis_hazirla(cur)
        kim = _merkez(cur, x_evvel_oturum)
        cur.execute("UPDATE ey_siparis_yon SET iptal=TRUE, iptal_sebep='deneme' WHERE NOT iptal AND siparis_id IN (SELECT id FROM ey_siparis WHERE deneme AND NOT iptal)")
        cur.execute("UPDATE ey_siparis SET iptal=TRUE, iptal_kim=%s, iptal_sebep='deneme (1 Kasım öncesi)', iptal_zaman=NOW() WHERE deneme AND NOT iptal", (kim,))
        n = cur.rowcount
    return {"ok": True, "mesaj": f"{n} deneme siparişi kapatıldı"}


# ─────────────────────────── BEKLEYEN İŞLER (yalnız merkez KARARI — 3 satır; kuyruğun kendisi Sipariş ekranında) ───────────────────────────
def siparis_isleri(cur) -> list:
    if not _var(cur):
        return []
    from evvel_yeni_cekirdek import yeni_donem
    gercek = yeni_donem(cur)
    cur.execute("SELECT * FROM ey_siparis WHERE NOT iptal AND zaman > NOW() - INTERVAL '30 days' AND NOT (deneme AND %s) ORDER BY zaman",
                (gercek,))
    acik = [s for s in _derle(cur, [dict(r) for r in cur.fetchall() or []]) if s["durum"] == "acik"]
    out, simdi = [], _is_gunu()   # F#23: sunucu UTC date.today() değil
    oneri = [k["ad"] for s in acik for k in s["kalemler"] if k["durum"] == "oneri"]
    if oneri:
        out.append({"genel": True, "tur": "siparis_oneri", "grup": "tedarik", "id": "so", "tarih": simdi.isoformat(), "etiket": "🛒 Katalog dışı istek",
                    "ad": f"{len(oneri)} ürün önerisi", "alt": ", ".join(oneri[:3]) + (" …" if len(oneri) > 3 else "") + " — ürünü aç ve bağla ya da reddet",
                    "sayfa": "siparis_yon", "dugme": "Sipariş"})
    eksik = [f"{s['sube']}: {k['ad']}" for s in acik for k in s["kalemler"] if k.get("eksik")]
    if eksik:
        out.append({"genel": True, "tur": "siparis_eksik", "grup": "tedarik", "id": "se", "tarih": simdi.isoformat(), "etiket": "🛒 Eksik karşılandı",
                    "ad": f"{len(eksik)} kalem istenenden az geldi", "alt": ", ".join(eksik[:3]) + " — yeniden yönlendir ya da kapat",
                    "sayfa": "siparis_yon", "dugme": "Sipariş"})
    from datetime import datetime, timezone
    eski = [s for s in acik if any(k["durum"] == "yonlendirilmedi" for k in s["kalemler"])
            and (datetime.now(timezone.utc) - datetime.fromisoformat(s["zaman"])).total_seconds() > YONSUZ_SAAT * 3600]
    if eski:
        out.append({"genel": True, "tur": "siparis_yonsuz", "grup": "tedarik", "id": "sy", "tarih": min(s["gun"] for s in eski), "etiket": "🛒 Yönlendirilmedi",
                    "ad": f"{len(eski)} sipariş {YONSUZ_SAAT} saattir bekliyor", "alt": ", ".join(sorted({s["sube"] for s in eski})),
                    "sayfa": "siparis_yon", "dugme": "Yönlendir"})
    return out


bekleyen_is_kaydet("siparis", lambda cur, b: siparis_isleri(cur))
