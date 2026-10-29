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


_ILETIM_HAZIR = False


def _iletim_hazirla(cur) -> bool:
    """Sahip 28 Eki ("toptancıya yönlendirdik, PC WhatsApp açıktı ama bağlantı olmadı") · L4b Fable: yön satırında "WhatsApp'a aktarıldı"
    izi (kim / zaman — KANIT DEĞİL, sahip Gönder'e basmamış olabilir). Yalnız eksikse, çağıranın işleminde (ddl_kur). Kurulamazsa False."""
    global _ILETIM_HAZIR
    from evvel_yeni_cekirdek import ddl_kur, kolon_var
    if _ILETIM_HAZIR:
        return True
    if kolon_var(cur, "ey_siparis_yon", "iletim_zaman"):
        _ILETIM_HAZIR = True   # Fable L6-109: her listede information_schema sorgusu olmasın
        return True
    try:
        ddl_kur(cur, "sp_ey_siparis_iletim", lambda c: (
            c.execute("ALTER TABLE ey_siparis_yon ADD COLUMN IF NOT EXISTS iletim_zaman TIMESTAMPTZ"),
            c.execute("ALTER TABLE ey_siparis_yon ADD COLUMN IF NOT EXISTS iletim_kim TEXT")))
        return True
    except Exception:  # noqa: BLE001
        log.warning("sipariş: iletim kolonları kurulamadı", exc_info=True)
        return False


def _toptanci_iletimleri(cur, siparisler: List[dict], bil: dict) -> None:
    """Her açık siparişe toptancı başına iletim grubu: bekleyen (teslim alınmamış) toptancı payı → WhatsApp metni (SUNUCU üretir — tek
    gerçek) + numara + aktarıldı izi. Fiyat / adres / iç not YOK (L4b Fable). Telefon Tanımlar'ın kapısından okunur."""
    from evvel_yeni_cekirdek import telefon_wa, tr_tarih_saat
    from evvel_yeni_tanim_api import tanim_listesi
    tel = {str(t["id"]): t for t in tanim_listesi(cur, "ey_toptanci", ("ad", "telefon"))}
    for s in siparisler:
        grup = {}
        for k in s["kalemler"]:
            for y in k.get("yonler") or []:
                t, _, tid = str(y.get("kaynak") or "").partition(":")
                if t != "toptanci" or y.get("durum") != "bekleniyor":
                    continue
                g = grup.setdefault(tid, {"toptanci_id": tid, "ad": y.get("kaynak_ad") or tid, "kalemler": [], "iletim": []})
                birim = (bil.get(str(k.get("urun_id") or ""), {}) or {}).get("birim") or "adet"
                g["kalemler"].append(f"• {k['ad']} — {int(y.get('adet') or 0)} {birim}")
                g["iletim"].append((y.get("iletim_zaman"), y.get("iletim_kim")))
        out = []
        for tid, g in sorted(grup.items(), key=lambda kv: kv[1]["ad"]):
            hepsi = all(z for z, _k in g["iletim"])   # yeniden yönlendirilen satır yeni açılır → izi yoktur → yeniden gönderilmeli görünür
            son = max(g["iletim"], key=lambda x: x[0]) if hepsi else None   # Fable L6-109: kim = en son aktaranın
            gun = s["gun"][8:10] + "." + s["gun"][5:7] + "." + s["gun"][:4]
            out.append({"toptanci_id": tid, "ad": g["ad"], "kalem_sayi": len(g["kalemler"]),
                        "wa_no": telefon_wa((tel.get(tid) or {}).get("telefon")),
                        # sahip 29 Eki: "daha kibar kuralım, teşekkürler vs gibi"
                        "wa_metin": (f"Merhaba, iyi günler 🌷\n\nTULİPİ {s['sube']} şubemiz için {gun} tarihli siparişimiz:\n\n"
                                     + "\n".join(g["kalemler"])
                                     + "\n\nTeslimat zamanını bize bildirirseniz çok seviniriz.\nŞimdiden teşekkür ederiz, iyi çalışmalar dileriz.\n\nTULİPİ Coffee"),
                        "aktarildi": tr_tarih_saat(son[0]) if son else None, "aktaran": son[1] if son else None})   # TR saat sunucuda (tek yer)
        s["toptancilar"] = out


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
    # G (24 Eki): bir paket kalemine BİRDEN ÇOK yön bağlı olabilir (aynı ürün iki sipariş tek kutu) → kabul toplamı paylaştırılır.
    # Paylaştırma o bag'ın BÜTÜN yönleri üzerinden (ekrandaki sipariş alt kümesi değil): eski sipariş → kalem → yön kimliği sırası.
    pay = {}
    cur.execute("""SELECT y.id, y.adet, y.parti_id, y.parti_i, s.zaman AS s_zaman, y.kalem_i FROM ey_siparis_yon y JOIN ey_siparis s ON s.id = y.siparis_id
                    WHERE NOT y.iptal AND y.parti_id = ANY(%s)""", (sorted({y["parti_id"] for y in yonler if y.get("parti_id")}),))
    grup = {}
    for r in [dict(x) for x in cur.fetchall() or []]:
        if r["parti_i"] is not None:
            grup.setdefault(f"sevk:{r['parti_id']}:{r['parti_i']}", []).append(r)
    for b, rs in grup.items():
        kalan = (D.get(b) or {}).get("kabul")
        if kalan is None:
            continue
        for r in sorted(rs, key=lambda r: (str(r["s_zaman"]), r["kalem_i"], str(r["id"]))):
            pay[r["id"]] = min(int(r["adet"]), kalan)
            kalan -= pay[r["id"]]
        if kalan > 0:   # sayılan, bağlı taleplerden fazla (fazla askıya düşmediyse) → son talebe; toplam korunur
            pay[sorted(rs, key=lambda r: (str(r["s_zaman"]), r["kalem_i"], str(r["id"])))[-1]["id"]] += kalan
    out = {}
    for yid, b in bag.items():
        d = D.get(b) or {"iptal": True}
        out[yid] = {"durum": "geri_alindi", "kabul": None} if d["iptal"] else (
            {"durum": "karsilandi", "kabul": pay.get(yid, d["kabul"]), "acik": bool(d.get("acik"))} if d.get("kabul") is not None
            else {"durum": "yolda", "kabul": None})
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
    tid = sorted({y["teslim_id"] for y in yonler if y.get("teslim_id")})
    if not f or not tid:
        return {}
    T = f(cur, tid)
    # Codex (kısmen kapalı #9): paylaştırma o teslime bağlı BÜTÜN yönler üzerinden — yalnız ekrana gelenler değil (eski talep tarih
    # aralığından çıkınca yenisi '0 yerine 10 karşılandı' görünüyordu). Kendi tablosu (Sipariş) — başka modüle SQL yok.
    cur.execute("""SELECT y.id, y.siparis_id, y.kalem_i, y.adet, y.teslim_id, y.zaman, s.kalemler FROM ey_siparis_yon y
                     JOIN ey_siparis s ON s.id = y.siparis_id WHERE y.teslim_id = ANY(%s) AND NOT y.iptal""", (tid,))
    tum = [dict(r) for r in cur.fetchall() or []]
    for y in tum:
        urunler.setdefault((y["siparis_id"], y["kalem_i"]), next((k.get("urun_id") for k in y.get("kalemler") or [] if k.get("i") == y["kalem_i"]), None))
    istenen = {y["id"] for y in yonler}
    grup = {}
    for y in sorted(tum, key=lambda y: (str(y.get("teslim_id")), str(y.get("zaman") or ""), str(y["id"]))):   # oluşturma sırası (Fable D4-7)
        if not y.get("teslim_id") or str(y["teslim_id"]) not in T:
            continue
        u = str(urunler.get((y["siparis_id"], y["kalem_i"])))
        grup.setdefault((str(y["teslim_id"]), u), []).append(y)
    out = {}
    for (t, u), ys in grup.items():
        kalan = int(T[t].get(u, 0) or 0)
        for n, y in enumerate(ys):
            pay = kalan if n == len(ys) - 1 else min(kalan, int(y["adet"]))
            if y["id"] in istenen:
                out[y["id"]] = pay
            kalan -= pay
    return out


def _alanlar(cur, yonler: List[dict]) -> dict:
    """{yon_id: 'Ali · 21.10 14:05'} — toptancı teslimi Toptancılar'ın, depo sevki Depo'nun PUBLIC kapısından (başka modüle SQL yok).
    Okunamazsa boş (kart yine açılır)."""
    out = {}
    try:
        with savepoint(cur, "sp_sip_alanlar"):
            f = _toptanci("teslim_alanlari")
            T = f(cur, [y["teslim_id"] for y in yonler if y.get("teslim_id")]) if f else {}
            from evvel_yeni_depo_api import sevk_kabul_alanlari
            bag = {y["id"]: f"sevk:{y['parti_id']}:{y['parti_i']}" for y in yonler if y.get("parti_id") and y.get("parti_i") is not None}
            D = sevk_kabul_alanlari(cur, list(bag.values()))
    except Exception:  # noqa: BLE001
        log.warning("sipariş: teslim alanları okunamadı", exc_info=True)
        return {}
    for y in yonler:
        x = T.get(str(y.get("teslim_id"))) if y.get("teslim_id") else D.get(bag.get(y["id"]))
        if x and (x.get("kim") or x.get("zaman")):
            out[y["id"]] = " · ".join(v for v in (x.get("kim"), x.get("zaman")) if v)
    return out


def _derle(cur, rows: List[dict], kor: bool = False) -> List[dict]:
    """Siparişleri kalem + yön durumlarıyla. kor=True (şube paneli): sevk / kabul ADEDİ DÖNMEZ (kör sayım — Fable R3)."""
    Y = _yonler(cur, [r["id"] for r in rows])
    hepsi = [y for v in Y.values() for y in v]
    urunler = {(r["id"], k["i"]): k.get("urun_id") for r in rows for k in (r["kalemler"] or [])}
    sv = _sevk_durumlari(cur, hepsi)
    tv = _teslim_durumlari(cur, hepsi, urunler)
    alan = {} if kor else _alanlar(cur, hepsi)   # E26: karşılanan yönde kim / ne zaman aldı (yalnız merkez)
    sube_ad, top_ad = _sube_adlari(cur), _toptanci_adlari(cur)
    depo_yok = {}   # B91: depo 'YOK' dediği kalem yönlendirilmemişe döner — kim dediği kartta görünsün (merkez yine depoya yollamasın)
    if rows and not kor:
        cur.execute("""SELECT siparis_id, kalem_i, kim FROM ey_siparis_yon WHERE siparis_id = ANY(%s) AND iptal
                         AND iptal_sebep LIKE 'depoda yok%%' ORDER BY zaman""", ([r["id"] for r in rows],))
        for y in cur.fetchall() or []:
            y = dict(y)
            depo_yok[(y["siparis_id"], y["kalem_i"])] = (y.get("kim") or "depo").split(" · ")[-1]   # "şube paneli · Ali" → "Ali"
    out = []
    for r in rows:
        kal_out, tamam = [], True
        for k in r["kalemler"] or []:
            if k.get("iptal"):
                kal_out.append({**k, "durum": "iptal", "yonler": [], "yonsuz": 0})
                continue
            ys, dagitilan, karsilanan, gonderilmis, fark_acik = [], 0, 0, False, False
            for y in [y for y in Y.get(r["id"], []) if y["kalem_i"] == k["i"]]:
                tur = y["kaynak"].split(":", 1)[0]
                if tur == "depo":
                    s = sv.get(y["id"])
                    if s and s["durum"] == "geri_alindi":
                        continue   # sevk geri alındı → kalem yeniden yönlendirilmemiş sayılır
                    d = "hazirlaniyor" if not y.get("parti_id") else s["durum"] if s else "yolda"
                    gelen = s["kabul"] if s else None
                    # Codex H: kabul farkı merkezde henüz çözülmedi — yalnız PAYINA eksik düşen yön (G: tek pakette eski sipariş dolduysa ona yansımaz)
                    acik_y = bool(s and s.get("acik") and (gelen is None or int(gelen) < int(y["adet"])))
                    fark_acik = fark_acik or acik_y
                else:
                    acik_y = False
                    # Codex P1: bağlı teslim İPTAL edildiyse (okuyucu döndürmez) yön yeniden 'bekleniyor' — iptal teslim siparişi tamamlamaz
                    bagli = bool(y.get("teslim_id")) and y["id"] in tv
                    d = "karsilandi" if bagli else "bekleniyor"
                    gelen = tv.get(y["id"]) if bagli else None
                dagitilan += int(y["adet"])
                gonderilmis = gonderilmis or bool(y.get("parti_id") or y.get("teslim_id"))   # B27 (Fable): geri alınan sevk sayılmaz (yukarıda atlandı)
                if d == "karsilandi":
                    karsilanan += int(gelen if gelen is not None else y["adet"])
                yy = {"id": y["id"], "kaynak": y["kaynak"], "kaynak_ad": _kaynak_ad(y["kaynak"], sube_ad, top_ad), "durum": d}
                if not kor:   # Fable B3: şube paneli sevk / hazır / gelen ADEDİNİ görmez (kör sayım)
                    # Codex I-2 (24 Eki): yeniden yönlendirmede KİLİTLİ sayılan adet — gelmesi süren (yolda / farkı açık) tam adet,
                    # farkı çözülmüş ya da teslim alınmışsa GELEN adet (10 gitti 8 geldi, fark çözüldü → kalan 2 yeniden yönlendirilebilir)
                    kilit = int(y["adet"]) if (d != "karsilandi" or acik_y or gelen is None) else min(int(y["adet"]), int(gelen))
                    if d == "karsilandi" and alan.get(y["id"]):
                        yy["alan"] = alan[y["id"]]
                    yy.update({"adet": int(y["adet"]), "hazir": y.get("hazir"), "gelen": gelen, "kilit": kilit, "fark_acik": acik_y,
                               "iletim_zaman": y.get("iletim_zaman"), "iletim_kim": y.get("iletim_kim")})
                ys.append(yy)
            yonsuz = max(0, int(k["adet"]) - dagitilan)
            # B27 (Fable 22 Eki): kısmi gönderimden kalan — yola çıkmış/teslim bağlı yön varsa merkez "eksiği kapat" diyebilir;
            # kapatıldıysa kalan artık 'yönlendirilmedi' sayılmaz (sipariş sonsuza açık kalmaz)
            if k.get("oneri") and not k.get("urun_id"):
                d = "oneri"
            elif yonsuz > 0 and not k.get("eksik_kapandi"):
                d = "yonlendirilmedi"
            elif k.get("eksik_kapandi") and not ys:   # Fable: hiç gönderilmeden eksiği kapatılan kalem sipariş açık tutmaz
                d = "karsilandi"
            elif ys and all(y["durum"] == "karsilandi" for y in ys):
                d = "karsilandi"
            else:
                d = "yolda" if any(y["durum"] == "yolda" for y in ys) else (
                    "bekleniyor" if any(y["durum"] == "bekleniyor" for y in ys) else "hazirlaniyor")
            if d != "karsilandi":
                tamam = False
            kk = {"i": k["i"], "urun_id": k.get("urun_id"), "ad": k["ad"], "adet": int(k["adet"]), "oneri": bool(k.get("oneri")),
                  "durum": d, "yonler": ys}
            if not kor:   # G1 (sim 24 Eki): kör modda yönsüz adet sevk adedini ele verir (istenen − yönsüz = giden)
                kk["yonsuz"] = yonsuz
            if d == "yonlendirilmedi" and (r["id"], k["i"]) in depo_yok:
                kk["depo_yok"] = depo_yok[(r["id"], k["i"])]
            # Fable #1 (24 Eki): fark çözülüp kalan yeniden yönlendirilince dağıtılan istenenden büyük olur (10 kilitli + 2 yeni, 8+2 geldi)
            # → eksik istenen adede göre ölçülür (yoksa tam gelmiş sipariş sonsuza 'eksik' kalıyordu)
            eksik = 0 if k.get("eksik_kapandi") else ((max(0, min(dagitilan, int(k["adet"])) - karsilanan) if d == "karsilandi" else 0)
                                                     + (yonsuz if (d == "yonlendirilmedi" and gonderilmis) else 0))
            if fark_acik:   # Codex H (24 Eki): önce sevk farkı çözülür (şube yanlış saydıysa eksik yoktur) — eksik ancak sonra 'gerçek'
                eksik, tamam = 0, False
                kk["fark_bekliyor"] = True
            if eksik:
                tamam = False   # Codex P1: istenenden az geldi → sipariş AÇIK kalır (yoksa Bekleyen işler'den düşüyordu)
            if kor:
                kk.pop("fark_bekliyor", None)
            else:
                kk["eksik"] = eksik
                kk["eksik_kapandi"] = k.get("eksik_kapandi")
            kk["_eksik"] = eksik or (1 if fark_acik else 0)   # Fable #3 testi (24 Eki): sevk farkı açıkken sipariş merkezde 'tamamlandı' görünüyordu
            kal_out.append(kk)
        tamam = tamam and any(k["durum"] != "iptal" for k in kal_out)
        eksik_var = any([k.pop("_eksik", 0) for k in kal_out])   # LİSTE: hepsinden silinsin (any kısa devre panele sızdırıyordu — Fable D4-2)
        durum = "iptal" if r["iptal"] else ("tamamlandi" if not eksik_var and (tamam or all(k["durum"] in ("iptal", "karsilandi") for k in kal_out))
                                            else "acik")
        if kor and not r["iptal"]:   # Fable #3 + sahip 24 Eki "KAPAT": şube 'açık kaldı = sayımım tutmadı'yı öğrenmesin — durum YALNIZ kalemlerden
            durum = "tamamlandi" if all(k["durum"] in ("iptal", "karsilandi") for k in kal_out) else "acik"   # Fable d1: hepsi iptal → merkezle aynı
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


def _simdi_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _son_gun_mu(z, gun: int) -> bool:
    """z (ISO metin ya da datetime) son `gun` gün içinde mi — kalem ret zamanı yoksa siparişin zamanı verilir."""
    from datetime import datetime, timedelta, timezone
    try:
        d = z if isinstance(z, datetime) else datetime.fromisoformat(str(z))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d > datetime.now(timezone.utc) - timedelta(days=gun)
    except (TypeError, ValueError):
        return True


def sube_redleri(cur, sube_id: str, gun_sayisi: int = 7) -> List[dict]:
    """PUBLIC (panel ana sayfa 'Reddedilen sipariş talepleri', eski siparis_red_bildirimleri): son N günde MERKEZİN iptal ettiği
    sipariş ya da kalem (sebebiyle). Şubenin kendi iptali ve deneme siparişleri dönmez. Hafif sorgu — yön/sevk hesabı yapılmaz
    (panel durumu sık yenilenir). Adet dönmez."""
    if not _var(cur):
        return []
    # Codex 22 Eki: sipariş iptali İPTAL ZAMANINA göre (eski açılıp bugün reddedilen görünsün); kalem retinin ayrı zamanı yok →
    # takip penceresindeki (TAKIP_GUN) açık siparişlerin kalem retleri
    cur.execute("""SELECT is_gunu, iptal, iptal_kim, iptal_sebep, kalemler, zaman, COALESCE(iptal_zaman, zaman) AS sira FROM ey_siparis
                   WHERE sube_id=%s AND NOT deneme
                     AND NOT (iptal AND COALESCE(iptal_kim, '') LIKE 'şube paneli%%')   -- Codex P3: şubenin kendi iptali sınırdan ÖNCE elenir
                     AND ((iptal AND COALESCE(iptal_zaman, zaman) > NOW() - make_interval(days => %s))
                          OR (NOT iptal AND kalemler @> '[{"iptal": true}]'::jsonb AND zaman > NOW() - make_interval(days => %s)))
                   ORDER BY sira DESC LIMIT 20""", (str(sube_id), gun_sayisi, TAKIP_GUN))
    out = []
    for r in cur.fetchall() or []:
        r = dict(r)
        tarih = r["is_gunu"].isoformat()
        if r["iptal"]:
            if (r.get("iptal_kim") or "").startswith("şube paneli"):   # şubenin kendi iptali red değildir
                continue
            out.append({"tarih": tarih, "mesaj": "Sipariş iptal edildi" + (f" — {r['iptal_sebep']}" if r.get("iptal_sebep") else "")})
            continue
        for k in r.get("kalemler") or []:
            if k.get("iptal") and _son_gun_mu(k.get("iptal_zaman") or r["zaman"], gun_sayisi):   # Codex 22 Eki: kalem RET ZAMANI
                out.append({"tarih": tarih, "mesaj": f"{k.get('ad') or 'ürün'}" + (f" — {k['iptal_sebep']}" if k.get("iptal_sebep") else " — iptal")})
    return out[:15]


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
    rows = [dict(r) for r in cur.fetchall() or []]   # E2E #3: ÖNCE oku — _toptanci_adlari aynı imleçle sorgu atıyor (sonuç kayboluyordu)
    top_ad = _toptanci_adlari(cur)
    grup = {}
    for y in rows:
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
    # Codex D (24 Eki): merkezin yeniden yönlendirmesiyle AYNI kilit + sürüm — yoksa merkez "hazırlık yok" sanıp satırı kaldırırken
    # depocu aynı anda kaydedebiliyordu (L1 koruması delinirdi). Kilit kümesi yön satırlarının GERÇEK siparişinden (yola_cikar kalıbı).
    cur.execute("SELECT DISTINCT siparis_id FROM ey_siparis_yon WHERE id = ANY(%s)", ([str(x.get("yon_id")) for x in satirlar],))
    for sid in sorted(str(dict(r)["siparis_id"]) for r in cur.fetchall() or []):
        _kilit(cur, sid)
    n, degisen = 0, set()
    for x in satirlar:
        h = x.get("hazir")
        if h is not None:
            h = adet_oku(h, "Hazır adet")
        cur.execute("""SELECT y.siparis_id, y.hazir, s.surum FROM ey_siparis_yon y JOIN ey_siparis s ON s.id = y.siparis_id
                        WHERE y.id=%s AND y.kaynak=%s AND y.parti_id IS NULL AND NOT y.iptal AND NOT s.iptal""", (str(x.get("yon_id")), f"depo:{depo_sube}"))
        r = cur.fetchone()
        if not r:
            raise HTTPException(409, "Bu kalem değişti (merkez yeniden yönlendirdi / yola çıktı / iptal) — sayfayı yenile")
        r = dict(r)
        if x.get("surum") is not None and int(x["surum"]) != int(r["surum"]):
            raise HTTPException(409, "Merkez bu siparişi değiştirdi — sayfayı yenile")
        cur.execute("UPDATE ey_siparis_yon SET hazir=%s WHERE id=%s", (h, str(x.get("yon_id"))))
        n += cur.rowcount
        if r["hazir"] != h:
            degisen.add(r["siparis_id"])
    for sid in degisen:   # merkez ekranı bayat sürümle kaydedemesin (hazırlık başladı bilgisini görmeden satırı değiştirmesin)
        _surum_artir(cur, sid)
    return n


def yola_cikar(cur, *, depo_sube: str, hedef_sube: str, satirlar: List[dict], kim: str, istek_id: str) -> dict:
    """Tema 'Yola çıkar' (A9): satirlar [{yon_id, surum, gonderilen}] — 0 = YOK. Depo PUBLIC sevk_yaz (tek işlem) + yön satırına parti bağı.
    Kısmi (gönderilen < adet) → yön adedi gönderilene iner, kalan yönlendirilmemişe DÖNER (Fable R1); YOK → yön iptal (merkez yeniden karar)."""
    siparis_hazirla(cur)
    from evvel_yeni_depo_api import sevk_yaz
    if not satirlar:
        raise HTTPException(400, "Gönderilecek kalem yok")
    from evvel_yeni_depo_api import konum_kilitle
    konum_kilitle(cur, f"depo:{depo_sube}")   # Fable S9: KİLİT SIRASI her yerde önce Depo konumu, sonra sipariş (teslim al / iptal ile aynı)
    # Fable 21 Eki: kilit kümesi İSTEMCİNİN siparis_id'sinden değil, yön satırlarının GERÇEK siparişinden (teslime_bagla ile aynı kalıp)
    cur.execute("SELECT DISTINCT siparis_id FROM ey_siparis_yon WHERE id = ANY(%s)", ([str(x.get("yon_id")) for x in satirlar],))
    for sid in sorted(str(dict(r)["siparis_id"]) for r in cur.fetchall() or []):
        _kilit(cur, sid)
    from evvel_yeni_depo_api import sevk_istekle
    once = sevk_istekle(cur, istek_id)   # Codex I-3 (24 Eki): aynı "Yola çıkar" tekrarı (bağlantı koptu, iki kez basıldı) → önceki başarı
    if once and not once["iptal"]:
        cur.execute("SELECT COUNT(*) AS n FROM ey_siparis_yon WHERE id = ANY(%s) AND (parti_id=%s OR (iptal AND iptal_sebep LIKE 'depoda yok%%'))",
                    ([str(x.get("yon_id")) for x in satirlar], once["parti_id"]))
        if int(dict(cur.fetchone())["n"]) == len({str(x.get("yon_id")) for x in satirlar}):
            return {"parti_id": once["parti_id"], "kalem": once["kalem"], "eksi": [], "yok": 0, "kismi": 0, "tekrar": True}
    from evvel_yeni_cekirdek import yeni_donem
    gercek = yeni_donem(cur, sube_id=hedef_sube)   # 🧪 pilot şubeye giden sevk 1 Kasım'dan önce de GERÇEK (Fable L4b A)
    ys = {}
    for x in satirlar:
        cur.execute("""SELECT y.*, s.sube_id AS hedef, s.surum, s.iptal AS s_iptal, s.kalemler, s.is_gunu AS s_gun FROM ey_siparis_yon y
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
    # G (Fable + Codex, 24 Eki): gerçekte kutu TEK — aynı ürün bütün siparişlerden TOPLANIR, tek paket + tek kör sayım. Eskiden (Fable B2)
    # kabul iki kez sayılmasın diye ayrı paket yapılıyordu; artık kabul toplamı siparişlere _sevk_durumlari'nda BİR KEZ, eski sipariş
    # önce paylaştırılır (eksik en yeniye düşer; hasar/fazla paket düzeyinde, merkez Sevk farkları'nda çözer).
    gonder = [(y, g) for y, g in ys.values() if g > 0]
    sonuc = {"parti_id": None, "kalem": 0, "eksi": []}
    if gonder:
        top = {}
        for y, g in gonder:
            top[urun(y)] = top.get(urun(y), 0) + g
        r = sevk_yaz(cur, kaynak_sube=depo_sube, hedef_sube=hedef_sube, kalemler=[{"urun_id": u, "adet": a} for u, a in top.items()], kim=kim,
                     istek_id=istek_id,
                     # B23: personele kod değil talep günü ("22.10 siparişi"); kimlik bağı yön satırında (parti_id) zaten var
                     notu=", ".join(f"{g:%d.%m}" for g in sorted({y["s_gun"] for y, _ in gonder})) + " siparişi")
        idx = {k["urun_id"]: i for i, k in enumerate(r["kalemler"])}   # #5: sıralı kalemler sevk_yaz'dan (Depo tablosuna uzanma yok)
        for y, g in gonder:
            cur.execute("UPDATE ey_siparis_yon SET parti_id=%s, parti_i=%s, adet=%s, hazir=%s WHERE id=%s",
                        (r["parti_id"], idx[urun(y)], g, g, y["id"]))
        sonuc.update({"parti_id": r["parti_id"], "kalem": r["kalem"], "eksi": r.get("eksi") or []})
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
        _iletim_hazirla(cur)
        depo, depo_stok = _merkez_depo(cur), {}
        if depo and gorunum != "gecmis":   # Y3 (sim 24 Eki): merkez depoda kaç var — Depo'nun PUBLIC bakiyesi.
            # SIRA ÖNEMLİ: stok tablosu bu işlemde okunmadan ÖNCE (bakiye → depo_hazirla ayrı bağlantıda DDL dener; önce okursak
            # kendi kilidimizi bekler → 503 döngüsü — sim 24 Eki yakalandı, 19 Eki dersi)
            from evvel_yeni_depo_api import bakiye
            depo_stok = {u: a for (u, _k), a in bakiye(cur, f"depo:{depo}").items()}
        cur.execute("""SELECT * FROM ey_siparis WHERE zaman > NOW() - make_interval(days => %s) ORDER BY zaman""",
                    (max(1, min(int(gun_sayisi), 120)),))
        hepsi = _derle(cur, [dict(r) for r in cur.fetchall() or []])
        from evvel_yeni_urun_api import urun_bilgi
        uids = sorted({k["urun_id"] for s in hepsi for k in s["kalemler"] if k.get("urun_id")})
        bil = urun_bilgi(cur, uids)
        son_top = _son_toptancilar(cur, uids)
        aktif_top = set(_toptanci_adlari(cur))
        try:   # sahip 28 Eki: toptancıya WhatsApp — okunamazsa liste bozulmaz, yalnız iletim bloğu çıkmaz
            with savepoint(cur, "sp_sip_iletim"):
                _toptanci_iletimleri(cur, hepsi, bil)
        except Exception:  # noqa: BLE001
            log.warning("sipariş: toptancı iletimleri okunamadı", exc_info=True)
    for s in hepsi:
        for k in s["kalemler"]:
            for y in k.get("yonler") or []:
                y.pop("iletim_zaman", None)
                y.pop("iletim_kim", None)
    for s in hepsi:
        for k in s["kalemler"]:
            b = bil.get(str(k.get("urun_id") or ""), {})
            k["pasta"] = __import__("evvel_yeni_urun_api").gununde_tuketilir(b)
            top = f"toptanci:{son_top[k['urun_id']]}" if k.get("urun_id") in son_top else None
            if depo and k.get("urun_id") and not k["pasta"]:
                k["depo_stok"] = depo_stok.get(str(k["urun_id"]), 0)
            # Y6 (sim 24 Eki): depocu rafa bakıp YOK dediyse ya da kısmi gönderdiyse yeni satır yine "Merkez depo" ile açılmasın → son
            # toptancı (o da yoksa boş: merkez bilerek seçer). Sahip 24 Eki: SİSTEM KAYDINA bakılmaz — sayım hatasıyla kayıt eksi/0 olup
            # rafta mal olabilir; tek gerçek depocunun VAR/YOK'u (kayıt yalnız bilgi olarak gösterilir)
            # Codex A (24 Eki): yalnız KALAN adedi doğuran depo cevabı — depocu YOK dedi ya da kalan, depodan KISMİ gönderimin artığı
            depo_yetmedi = k.get("durum") == "yonlendirilmedi" and (k.get("depo_yok") or (
                (k.get("yonsuz") or 0) > 0 and any(str(y.get("kaynak", "")).startswith("depo:") and y["durum"] in ("yolda", "karsilandi")
                                                   for y in k.get("yonler") or [])))
            if top and top.split(":", 1)[1] not in aktif_top:   # Codex A: son toptancı artık aktif değilse varsayılan BOŞ
                top = None
            k["oneri_kaynak"] = top if (k["pasta"] or depo_yetmedi) else (f"depo:{depo}" if k.get("urun_id") else None)
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


class IletBody(BaseModel):
    toptanci_id: str


@router.post("/{sid}/ilet")
def ilet(sid: str, body: IletBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez "📲 WhatsApp ile gönder"e bastı → o siparişin bu toptancıya giden, teslim alınmamış yön satırlarına "aktarıldı" izi
    (kim / zaman). KANIT DEĞİL (Gönder'e WhatsApp'ta sahip basar); tekrar basılırsa üstüne yazar. Bekleyen işlere düşmez."""
    with db() as (conn, cur):
        siparis_hazirla(cur)
        kim = _merkez(cur, x_evvel_oturum)
        if not _iletim_hazirla(cur):
            raise HTTPException(503, "Sipariş hazırlanıyor — birkaç saniye sonra tekrar dene")
        _kilit(cur, sid)
        cur.execute("""UPDATE ey_siparis_yon SET iletim_zaman=NOW(), iletim_kim=%s
                        WHERE siparis_id=%s AND kaynak=%s AND NOT iptal AND teslim_id IS NULL""",
                    (kim, sid, "toptanci:" + str(body.toptanci_id or "")))
        if not cur.rowcount:
            raise HTTPException(409, "Bu siparişte bu toptancıya bekleyen kalem yok — sayfayı yenile")
    return {"ok": True, "mesaj": "WhatsApp'a aktarıldı olarak işaretlendi — mesajı WhatsApp'ta Gönder'e basmayı unutma"}


class YonBody(BaseModel):
    surum: int
    kalemler: List[dict]   # [{i, yonler: [{kaynak, adet}]}] — kalemin YOLA ÇIKMAMIŞ yönleri bununla DEĞİŞİR · ya da {i, iptal: "sebep"}
    hazir_onay: bool = False   # L1: depocu hazırlamaya başladığı satırı değiştirmeyi merkez onayladı


def _hazir_kontrol(k: dict, dusen: List[dict], onay: bool) -> None:
    """L1 (sim 24 Eki): depocu 'Hazırlığı kaydet' dediği satır değişecekse merkez bilerek onaylasın (depocu ürünü raftan indirmiş olabilir)."""
    h = [y for y in dusen if y.get("hazir") is not None and str(y.get("kaynak") or "").startswith("depo:")]
    if h and not onay:
        n = sum(int(y["hazir"] or 0) for y in h)
        raise HTTPException(409, f"{k['ad']}: depo hazırlamaya başladı ({n} adet hazır) — değiştirirsen depocunun listesinden düşer. "
                                 "Depoyla konuştuysan onaylayıp tekrar kaydet")


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
        gor = _derle(cur, [s])[0] if s else None   # Codex I-2: kilit adedi TEK hesaptan (gelen / fark durumu)
        kilit_adet = {y["id"]: y.get("kilit", y.get("adet")) for kk_ in (gor or {}).get("kalemler", []) for y in kk_.get("yonler", [])}
        kalemler = list(s["kalemler"] or [])
        for x in body.kalemler:
            i = x.get("i")
            if i not in kal:
                raise HTTPException(400, "Kalem bulunamadı — sayfayı yenile")
            k = kal[i]
            if k.get("iptal"):   # Fable #9
                raise HTTPException(409, f"{k['ad']}: kalem iptal edilmiş — sayfayı yenile")
            cur.execute("""SELECT id, kaynak, adet, hazir, parti_id, teslim_id FROM ey_siparis_yon WHERE siparis_id=%s AND kalem_i=%s AND NOT iptal""", (sid, i))
            mevcut = [dict(r) for r in cur.fetchall() or []]
            kilitli_var = any(y["parti_id"] or y["teslim_id"] for y in mevcut)
            kilitli = sum(int(kilit_adet.get(y["id"], y["adet"])) for y in mevcut if y["parti_id"] or y["teslim_id"])
            if x.get("iptal"):
                if kilitli_var:
                    raise HTTPException(409, f"{k['ad']}: bir kısmı yola çıktı / teslim alındı — iptal edilemez")
                _hazir_kontrol(k, [y for y in mevcut if not (y["parti_id"] or y["teslim_id"])], body.hazir_onay)
                cur.execute("UPDATE ey_siparis_yon SET iptal=TRUE, iptal_sebep='kalem iptal', kim=%s WHERE siparis_id=%s AND kalem_i=%s AND NOT iptal",
                            (kim, sid, i))
                kalemler = [{**kk, "iptal": True, "iptal_sebep": str(x["iptal"])[:200], "iptal_zaman": _simdi_iso()} if kk["i"] == i else kk for kk in kalemler]
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
            birlesik = {}   # Y7 (sim 24 Eki): aynı kaynağa iki satır ("Ata 2 + Ata 1") → tek satır (şube kartında da tek görünür)
            for kn, a in yeni:
                birlesik[kn] = birlesik.get(kn, 0) + a
            yeni = list(birlesik.items())
            # L1 (sim 24 Eki): değişmeyen açık satır YERİNDE kalır — eskiden hepsi silinip yeniden yazılıyor, depocunun hazırlığı (hazir) kayboluyordu
            acik_y, kalan = [y for y in mevcut if not (y["parti_id"] or y["teslim_id"])], list(yeni)
            dusen = []
            for y in acik_y:
                if (y["kaynak"], int(y["adet"])) in kalan:
                    kalan.remove((y["kaynak"], int(y["adet"])))
                else:
                    dusen.append(y)
            _hazir_kontrol(k, dusen, body.hazir_onay)
            for y in dusen:
                cur.execute("UPDATE ey_siparis_yon SET iptal=TRUE, iptal_sebep='yeniden yönlendirildi', kim=%s WHERE id=%s AND parti_id IS NULL AND teslim_id IS NULL",
                            (kim, y["id"]))
            yeni = kalan
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
            k.update({"iptal": True, "iptal_sebep": ("öneri reddedildi" + (f": {body.sebep}" if body.sebep else ""))[:200], "baglayan": kim,
                      "iptal_zaman": _simdi_iso()})
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
    hazir_onay: bool = False   # Codex D: depocu hazırlamaya başladıysa merkez bilerek iptal etsin


@router.post("/{sid}/iptal")
def merkez_iptal(sid: str, body: IptalBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    if len((body.sebep or "").strip()) < 3:
        raise HTTPException(400, "Sebep yaz")
    with db() as (conn, cur):
        siparis_hazirla(cur)
        kim = _merkez(cur, x_evvel_oturum)
        siparis_iptal(cur, sid=sid, kim=kim, sebep=body.sebep.strip(), surum=body.surum, hazir_onay=body.hazir_onay)
    return {"ok": True, "mesaj": "Sipariş iptal edildi"}


def siparis_iptal(cur, *, sid: str, kim: str, sebep: str, surum: Optional[int] = None, sube_id: Optional[str] = None,
                  hazir_onay: bool = False) -> None:
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
    cur.execute("SELECT kaynak, hazir FROM ey_siparis_yon WHERE siparis_id=%s AND NOT iptal", (sid,))   # Codex D: iptal de hazırlık korumasından geçer
    _hazir_kontrol({"ad": "Sipariş"}, [dict(x) for x in cur.fetchall() or []], hazir_onay)
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


# ─────────────────────────── BEKLEYEN İŞLER (yalnız merkez KARARI) ───────────────────────────
# 4f (sahip 23-24 Eki): "sipariş geldiğinde oradan yönlendirme" + "sipariş yönlendirme Bekleyen işler'de AYRI isimde, içine girmeden anlaşılsın"
# → AYRI grup 'siparis'; yönlendirilmemiş HER sipariş GELDİĞİ AN tek satır (şube · kalem · süre · Yönlendir); YONSUZ_SAAT aşınca 'gecikti'.
def _kalan_yazi(k: dict) -> str:
    """Opus 4f-6: kısmen yönlendirilmiş kalemde kalan adet görünsün — 'Süt (4 kaldı)'."""
    kalan, adet = k.get("yonsuz"), k.get("adet")
    return f"{k['ad']} ({kalan} kaldı)" if kalan and adet and kalan != adet else k["ad"]


def _donus_yazi(yon: List[dict]) -> str:
    """Y4 (sim 24 Eki): kalem depodan GERİ döndüyse nedeni Bekleyen satırında yazsın (merkez yine depoya yollamasın)."""
    yok = sorted({k["depo_yok"] for k in yon if k.get("depo_yok")})
    kismi = [k["ad"] for k in yon if not k.get("depo_yok") and any(y["durum"] in ("yolda", "karsilandi") for y in k.get("yonler") or [])]
    p = ([f"↩ depo YOK dedi ({', '.join(yok)})"] if yok else []) + ([f"↩ depo kısmi gönderdi ({', '.join(kismi[:2])})"] if kismi else [])
    return " · ".join(p) + (" — toptancıya yönlendir ya da kalanı kapat" if p else "")


def siparis_isleri(cur) -> list:
    if not _var(cur):
        return []
    from evvel_yeni_cekirdek import yeni_donem
    gercek = yeni_donem(cur)
    cur.execute("SELECT * FROM ey_siparis WHERE NOT iptal AND zaman > NOW() - INTERVAL '90 days' AND NOT (deneme AND %s) ORDER BY zaman",   # Opus 4f-10
                (gercek,))
    acik = [s for s in _derle(cur, [dict(r) for r in cur.fetchall() or []]) if s["durum"] == "acik"]
    out, simdi = [], _is_gunu()   # F#23: sunucu UTC date.today() değil
    oneri = [k["ad"] for s in acik for k in s["kalemler"] if k["durum"] == "oneri"]
    if oneri:
        out.append({"genel": True, "tur": "siparis_oneri", "grup": "siparis", "id": "so", "tarih": simdi.isoformat(), "etiket": "🛒 Katalog dışı istek",
                    "ad": f"{len(oneri)} ürün önerisi", "alt": ", ".join(oneri[:3]) + (" …" if len(oneri) > 3 else "") + " — ürünü aç ve bağla ya da reddet",
                    "sayfa": "siparis_yon", "dugme": "Sipariş"})
    eksik = [(s, k) for s in acik for k in s["kalemler"] if k.get("eksik") and k["durum"] != "yonlendirilmedi"]   # Opus 4f-7
    if eksik:   # Y10 (sim 24 Eki): adet yazılır (merkez görür) · Y1: ilk siparişe odak
        out.append({"genel": True, "tur": "siparis_eksik", "grup": "siparis", "id": "se", "tarih": simdi.isoformat(), "etiket": "🛒 Eksik karşılandı",
                    "ad": f"{len(eksik)} kalem istenenden az geldi",
                    "alt": ", ".join(f"{s['sube']}: {k['ad']} {k['eksik']} eksik" for s, k in eksik[:3]) + (" …" if len(eksik) > 3 else "")
                           + " — yeniden yönlendir ya da kapat",
                    "sayfa": "siparis_yon", "sorgu": f"?odak={eksik[0][0]['id']}", "dugme": "Sipariş"})
    from datetime import datetime, timezone
    for s in acik:
        yon = [k for k in s["kalemler"] if k["durum"] == "yonlendirilmedi"]
        if not yon:
            continue
        dk = int((datetime.now(timezone.utc) - datetime.fromisoformat(s["zaman"])).total_seconds() // 60)
        sa = dk // 60
        sure = f"{sa} sa" if sa else (f"{dk} dk" if dk >= 1 else "az önce")   # Opus 4f-11
        out.append({"genel": True, "tur": "siparis_yonsuz", "grup": "siparis", "id": f"sy-{s['id']}", "tarih": s["gun"],
                    "etiket": "🛒 Sipariş yönlendirme bekliyor" + (" · gecikti" if sa >= YONSUZ_SAAT else ""),
                    "ad": f"{s['sube']} · {len(yon)} kalem · {sure}" + (" · deneme" if s.get("deneme") else ""),   # Opus 4f-5
                    "alt": ", ".join(_kalan_yazi(k) for k in yon[:3]) + (" …" if len(yon) > 3 else "") + " — "
                           + (_donus_yazi(yon) or "depoya ya da toptancıya yönlendir"),
                    "sayfa": "siparis_yon", "sorgu": f"?odak={s['id']}", "dugme": "Yönlendir"})
    return out


bekleyen_is_kaydet("siparis", lambda cur, b: siparis_isleri(cur))
