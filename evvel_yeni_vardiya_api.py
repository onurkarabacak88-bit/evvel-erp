"""🗓️ EVVEL YENİ · VARDİYA PLANI (2026-10-20) — tak-çıkar modül (sayfası Personel altında). Tasarım: VARDIYA_PLANI_TASARIM.md.

Sahip (20 Eki): "baştan ele al — daha kolay, mantığı daha hoş; ama en az eskisi kadar işe yarar." Eski ekranın 9 tablosu / 40 ucu
yerine ÜÇ kavram:
  · KALIP  = şubenin kadro iskeleti ("Zafer · Sabah 09:00–18:30 · 1 kişi · her gün"). Eski slot + hedef + preset → tek satır.
  · PLAN   = kişi × iş günü × şube × saat (tür 'calisma') ya da kişi × gün 'izin' (gri hücre, Y6). APPEND-ONLY: değişiklik = eski satır
             iptal + yeni satır (onceki_id) → iz. Gün geçtikten sonra yazılan 'sonradan' damgalı (Y5; maaşta uyarı, geç ölçülmez R4).
             TEK sert kural: aynı kişi aynı saatte iki yerde olamaz (409). Aynı gün iki şube farklı saatte SERBEST (split shift).
  · YAYIN  = şube × hafta (Y2). Yayınlanana kadar taslak: personel görmez, Günlük yoklama / Maaş okumaz (R2). Yayından sonra
             değişiklik anında geçerli (R3). Bugün ve geçmiş günün satırı her zaman geçerli (R4 — geçmişin taslağı olmaz).
Yazan = yayınlayan (Y9); V0'da merkez oturumu olan herkes (Y10 — kişiye özel yetki giriş kapısıyla, EN SONDA).
Başka modül YALNIZ PUBLIC servisleri çağırır: gun_plani · kisi_gunleri · ay_ozet · hafta_yayinda. Bu modül maaş / yoklama / panel
gerektirmez; onlar `moduller.acik("vardiya")` ise buradan okur (tak-çıkar).
Eski sistem: kalıplar eski vardiya_slot'tan BİR KEZ kopyalanır; eski plan haftası merkezin "Eski plandan al" düğmesiyle (en geç
9 Kasım haftası, Y4) — köprü değil, eski tablo sonra okunmaz (KESIM 17). Olay defterindeki tur='vardiya' KASA DEVRİDİR, bu plan değil.
"""

import logging
import uuid
from datetime import date, time, timedelta
from typing import Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from database import db, savepoint
from evvel_yeni_cekirdek import (ayar_oku, saat_oku, ayar_yaz, bekleyen_is_kaydet, bir_kez, is_gunu, merkez_aktor, tablo_var,
                                 lock_timeout_ayarla)

router = APIRouter(prefix="/api/evvel-yeni/vardiya", tags=["evvel-yeni-vardiya"])
log = logging.getLogger(__name__)

ESKI_KOPYA_SON = date(2026, 11, 9)   # Y4: eski plandan en geç bu haftanın pazartesisi alınır (27 Eki–9 Kas)
ILK_HAFTA = date(2026, 10, 26)       # Bekleyen 'plan yok' bu haftadan önce sorulmaz (öncesi eski ekranda yazılıyor)
GUNLUK_SAAT = "9.5"                  # K1: tam zamanlıda günlük saat üstü = fazla mesai (ayar 'vardiya_gunluk_saat')
_HAZIR = False


# ─────────────────────────── kurulum ───────────────────────────
def _ddl(cur) -> None:
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_vardiya_kalip (
        id TEXT PRIMARY KEY, sube_id TEXT NOT NULL, ad TEXT NOT NULL, bas TIME NOT NULL, bit TIME NOT NULL,
        gece BOOLEAN NOT NULL DEFAULT FALSE, kisi INT NOT NULL DEFAULT 1, gunler INT[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',
        sira INT NOT NULL DEFAULT 0, aktif BOOLEAN NOT NULL DEFAULT TRUE, kaynak TEXT NOT NULL DEFAULT 'elle',
        degistiren TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_vardiya_plan (
        id TEXT PRIMARY KEY, personel_id TEXT NOT NULL, gun DATE NOT NULL, tur TEXT NOT NULL DEFAULT 'calisma',
        sube_id TEXT, bas TIME, bit TIME, gece BOOLEAN NOT NULL DEFAULT FALSE, kalip_id TEXT,
        kaynak TEXT NOT NULL DEFAULT 'elle', iptal BOOLEAN NOT NULL DEFAULT FALSE, iptal_neden TEXT, iptal_kim TEXT,
        iptal_zaman TIMESTAMPTZ, onceki_id TEXT, degistiren TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (tur IN ('calisma','izin')), CHECK (tur = 'izin' OR (sube_id IS NOT NULL AND bas IS NOT NULL AND bit IS NOT NULL)))""")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ey_vplan_gun ON ey_vardiya_plan (gun, sube_id) WHERE NOT iptal")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ey_vplan_kisi ON ey_vardiya_plan (personel_id, gun) WHERE NOT iptal")
    cur.execute("""CREATE UNIQUE INDEX IF NOT EXISTS ux_ey_vplan_izin ON ey_vardiya_plan (personel_id, gun)
                    WHERE tur = 'izin' AND NOT iptal""")
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_vardiya_yayin (
        sube_id TEXT NOT NULL, pazartesi DATE NOT NULL, yayinlayan TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (sube_id, pazartesi))""")


def _eski_kalip_kopya(cur) -> None:
    """BİR KEZ: eski vardiya_slot (aktif, Evvel Yeni'de olan şube) → kalıp. Eski 'Serbest' otomatik slotlar alınmaz (sahip V3)."""
    if not tablo_var(cur, "vardiya_slot"):
        return
    cur.execute("""INSERT INTO ey_vardiya_kalip (id, sube_id, ad, bas, bit, gece, kisi, gunler, sira, kaynak, degistiren)
                   SELECT 'vk-' || s.id, s.sube_id, s.ad, s.baslangic_saat, s.bitis_saat, COALESCE(s.gece_vardiyasi, FALSE),
                          GREATEST(COALESCE(s.ideal_personel, 1), 1), COALESCE(s.aktif_gunler, '{1,2,3,4,5,6,7}'), COALESCE(s.sira, 0),
                          'eski_kopya', 'eski sistem kopyası'
                     FROM vardiya_slot s JOIN ey_sube e ON e.id = s.sube_id::text
                    WHERE s.aktif AND s.ad <> 'Serbest'
                   ON CONFLICT (id) DO NOTHING""")


def vardiya_hazirla(cur=None) -> None:
    """Tablolar yalnız eksikse (çağıranın işleminde savepoint + 3 sn kilit bekleme — 19 Eki dersi). Kurulumda hata olursa modül yine
    yüklenir; ilk istekte yeniden denenir (503)."""
    global _HAZIR
    if _HAZIR:
        return
    if cur is None:
        try:
            with db() as (_c, c2):
                vardiya_hazirla(c2)
        except Exception:  # noqa: BLE001
            log.warning("vardiya kurulumu ertelendi", exc_info=True)
        return
    from evvel_yeni_tanim_api import tanim_hazirla
    tanim_hazirla(cur)
    if not tablo_var(cur, "ey_vardiya_kalip", "ey_vardiya_plan", "ey_vardiya_yayin"):
        try:
            with savepoint(cur, "sp_ey_vardiya_hazirla"):
                onceki = lock_timeout_ayarla(cur, "3s")
                _ddl(cur)
                lock_timeout_ayarla(cur, onceki)
        except Exception:  # noqa: BLE001
            log.warning("vardiya tabloları kurulamadı", exc_info=True)
            raise HTTPException(503, "Vardiya hazırlanıyor — birkaç saniye sonra tekrar dene")
    bir_kez(cur, "vardiya_kalip_kopya", _eski_kalip_kopya, "vardiya kalıp kopyası")
    _HAZIR = True


# ─────────────────────────── saat yardımcıları ───────────────────────────
def _hm(t: Optional[time]) -> Optional[str]:
    return t.strftime("%H:%M") if t else None


def _dk(t: time) -> int:
    return t.hour * 60 + t.minute


def sure_saat(bas: time, bit: time) -> float:
    """PUBLIC — vardiya süresi (saat). Bitiş başlangıçtan önce/eşitse ertesi güne geçer (gece vardiyası, +24 s)."""
    d = _dk(bit) - _dk(bas)
    return (d + 1440 if d <= 0 else d) / 60.0


def _aralik(gun: date, bas: time, bit: time) -> tuple:
    a = gun.toordinal() * 1440 + _dk(bas)
    return a, a + int(round(sure_saat(bas, bit) * 60))


def _etiket(bas: time) -> str:
    """K6: sabah / gün / akşam etiketi saatten türer (ayrı 'vardiya türü' yok)."""
    return "sabah" if bas.hour < 12 else ("akşam" if bas.hour >= 14 else "gün")


def _pazartesi(g: date) -> date:
    return g - timedelta(days=g.weekday())


def _tarih(x, ad: str = "Gün") -> date:
    try:
        return date.fromisoformat(str(x)[:10])
    except Exception:  # noqa: BLE001
        raise HTTPException(400, f"{ad} YYYY-AA-GG olmalı")


# ─────────────────────────── yayın kuralı (R2/R4) ───────────────────────────
def _yayin_haritasi(cur, bas: date, son: date) -> Dict[tuple, dict]:
    cur.execute("SELECT sube_id, pazartesi, yayinlayan, zaman FROM ey_vardiya_yayin WHERE pazartesi BETWEEN %s AND %s",
                (_pazartesi(bas), son))
    return {(dict(r)["sube_id"], dict(r)["pazartesi"]): dict(r) for r in cur.fetchall() or []}


def _gecerli(r: dict, yayin: Dict[tuple, dict], bugun: date) -> bool:
    """Satır personel / maaş / yoklama için GEÇERLİ mi: izin her zaman · bugün ve geçmiş her zaman (R4) · ileri gün yalnız
    şubenin o haftası yayınlandıysa (R2)."""
    if r["tur"] == "izin" or r["gun"] <= bugun:
        return True
    return (r["sube_id"], _pazartesi(r["gun"])) in yayin


def _satirlar(cur, bas: date, son: date, sube_id: Optional[str] = None, personel_id: Optional[str] = None) -> List[dict]:
    kos, prm = ["NOT iptal", "gun BETWEEN %s AND %s"], [bas, son]
    if sube_id:
        kos.append("(sube_id = %s OR tur = 'izin')")
        prm.append(str(sube_id))
    if personel_id:
        kos.append("personel_id = %s")
        prm.append(str(personel_id))
    cur.execute(f"SELECT * FROM ey_vardiya_plan WHERE {' AND '.join(kos)} ORDER BY gun, bas NULLS FIRST, personel_id", tuple(prm))
    return [dict(r) for r in cur.fetchall() or []]


def _disa(r: dict) -> dict:
    return {"id": r["id"], "gun": r["gun"].isoformat(), "personel_id": r["personel_id"], "sube_id": r.get("sube_id"), "tur": r["tur"],
            "bas": _hm(r.get("bas")), "bit": _hm(r.get("bit")), "gece": bool(r.get("gece")), "kalip_id": r.get("kalip_id"),
            "kaynak": r["kaynak"], "saat": round(sure_saat(r["bas"], r["bit"]), 2) if r["tur"] == "calisma" else 0,
            "etiket": _etiket(r["bas"]) if r["tur"] == "calisma" else "izinli", "degistiren": r.get("degistiren"),
            "zaman": str(r.get("zaman") or "")[:16]}


# ─────────────────────────── PUBLIC servisler ───────────────────────────
def gun_plani(cur, bas: date, son: date, sube_id: Optional[str] = None, izin: bool = False) -> List[dict]:
    """PUBLIC — GEÇERLİ (yayınlanmış ya da geçmiş) çalışma satırları [{gun, personel_id, sube_id, bas, bit, gece, saat, etiket,
    kaynak, kalip_id}]; izin=True ise 'izin' satırları da (tur alanıyla). Günlük yoklama, panel 'Bugün' ve Maaş buradan okur."""
    vardiya_hazirla(cur)
    yayin, bugun = _yayin_haritasi(cur, bas, son), is_gunu()
    return [_disa(r) for r in _satirlar(cur, bas, son, sube_id) if _gecerli(r, yayin, bugun) and (izin or r["tur"] == "calisma")]


def kisi_gunleri(cur, personel_id: str, bas: date, son: date) -> List[dict]:
    """PUBLIC — telefon 'Bugün / Bu hafta' (V2): kişinin geçerli satırları, şube adıyla."""
    vardiya_hazirla(cur)
    from evvel_yeni_tanim_api import adlar
    yayin, bugun = _yayin_haritasi(cur, bas, son), is_gunu()
    rows = [r for r in _satirlar(cur, bas, son, personel_id=personel_id) if _gecerli(r, yayin, bugun)]
    sad = adlar(cur, "ey_sube", {r["sube_id"] for r in rows if r.get("sube_id")})
    return [{**_disa(r), "sube": sad.get(str(r.get("sube_id")))} for r in rows]


def hafta_yayinda(cur, sube_id: str, pazartesi: date) -> bool:
    """PUBLIC — şubenin o haftası yayınlandı mı."""
    vardiya_hazirla(cur)
    return (str(sube_id), _pazartesi(pazartesi)) in _yayin_haritasi(cur, pazartesi, pazartesi)


def ay_ozet(cur, ay: str) -> Dict[str, dict]:
    """PUBLIC — Maaş (K1/K2): {pid: {planli_gun, calisma_saat, mesai_saat, sonradan_gun, izin_gun, gunler:{gun: saat}}}.
    Yalnız BUGÜNE KADARKİ geçerli plan (gelecek vardiya hak edişe girmez — Codex P1 dersi); aynı gün iki şube TOPLANIR (eski FIX M2);
    mesai = Σ gün max(0, gün saati − günlük saat) — müdür / yarı zamanlı ayrımını Maaş yapar (tek kural orada)."""
    vardiya_hazirla(cur)
    y_, m_ = int(ay[:4]), int(ay[5:7])
    bas = date(y_, m_, 1)
    son = min(date(y_ + (m_ == 12), m_ % 12 + 1, 1) - timedelta(days=1), is_gunu())
    if son < bas:
        return {}
    esik = float(ayar_oku(cur, "vardiya_gunluk_saat", GUNLUK_SAAT) or GUNLUK_SAAT)
    out: Dict[str, dict] = {}
    for r in gun_plani(cur, bas, son, izin=True):
        o = out.setdefault(r["personel_id"], {"planli_gun": 0, "calisma_saat": 0.0, "mesai_saat": 0.0, "sonradan_gun": 0,
                                              "izin_gun": 0, "gunler": {}, "_sonradan": set()})
        if r["tur"] == "izin":
            o["izin_gun"] += 1
            continue
        o["gunler"][r["gun"]] = o["gunler"].get(r["gun"], 0.0) + r["saat"]
        if r["kaynak"] == "sonradan":
            o["_sonradan"].add(r["gun"])
    for o in out.values():
        o["planli_gun"] = len(o["gunler"])
        o["calisma_saat"] = round(sum(o["gunler"].values()), 2)
        o["mesai_saat"] = round(sum(max(0.0, s - esik) for s in o["gunler"].values()), 2)
        o["sonradan_gun"] = len(o.pop("_sonradan"))
        o["gunler"] = {g: round(s, 2) for g, s in o["gunler"].items()}
    return out


# ─────────────────────────── yazma çekirdeği ───────────────────────────
def _kisi(cur, pid: str) -> dict:
    from evvel_yeni_tanim_api import tanim_oku
    p = tanim_oku(cur, "ey_personel", pid, ("ad", "aktif", "giris", "cikis", "sube_id"))
    if not p:
        raise HTTPException(404, "Personel bulunamadı")
    return p


def _calisir_mi(p: dict, gun: date) -> None:
    if p.get("giris") and gun < p["giris"]:
        raise HTTPException(409, f"{p['ad']} {p['giris'].strftime('%d.%m')} tarihinde işe başladı — bu güne yazılamaz")
    if p.get("cikis") and gun > p["cikis"]:
        raise HTTPException(409, f"{p['ad']} {p['cikis'].strftime('%d.%m')} tarihinde ayrıldı — bu güne yazılamaz")


def _cakisma(cur, pid: str, gun: date, tur: str, bas: Optional[time], bit: Optional[time], haric: Optional[str] = None) -> Optional[str]:
    """TEK sert kural: aynı kişi aynı anda iki yerde olamaz (gece vardiyası komşu güne taşar → ±1 gün bakılır). İzinli gün çalışma
    alamaz, çalışılan gün izin olamaz. Dönüş: çakışma metni ya da None."""
    from evvel_yeni_tanim_api import adlar
    cur.execute("""SELECT * FROM ey_vardiya_plan WHERE personel_id=%s AND NOT iptal AND gun BETWEEN %s AND %s AND id <> %s""",
                (str(pid), gun - timedelta(days=1), gun + timedelta(days=1), haric or ""))
    rows = [dict(r) for r in cur.fetchall() or []]
    for r in rows:
        if r["gun"] != gun:
            continue
        if r["tur"] == "izin" and tur == "izin":
            return "o gün zaten izinli"
        if r["tur"] == "izin":
            return "o gün izinli (önce izni kaldır)"
        if tur == "izin":
            return "o gün planı var (önce vardiyayı kaldır)"
    if tur == "izin":
        return None
    a1, b1 = _aralik(gun, bas, bit)
    for r in rows:
        if r["tur"] != "calisma":
            continue
        a2, b2 = _aralik(r["gun"], r["bas"], r["bit"])
        if a1 < b2 and a2 < b1:
            s = adlar(cur, "ey_sube", [r["sube_id"]]).get(str(r["sube_id"])) or "başka şube"
            return f"o saatte {s}'de ({_hm(r['bas'])}–{_hm(r['bit'])}, {r['gun'].strftime('%d.%m')})"
    return None


def _yaz(cur, *, pid: str, gun: date, tur: str, kim: str, sube_id: Optional[str] = None, bas: Optional[time] = None,
         bit: Optional[time] = None, kalip_id: Optional[str] = None, kaynak: str = "elle", onceki_id: Optional[str] = None,
         sessiz: bool = False) -> Optional[str]:
    """Plan satırı yazar (kişi kilidi altında). sessiz=True → çakışmada hata yerine None döner (kopyalama atlar)."""
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("ey_vardiya:" + str(pid),))
    try:
        p = _kisi(cur, pid)
        _calisir_mi(p, gun)
        if tur == "calisma" and sure_saat(bas, bit) > 16:
            raise HTTPException(400, "Bir vardiya 16 saatten uzun olamaz — saatleri kontrol et")
        c = _cakisma(cur, pid, gun, tur, bas, bit, haric=onceki_id)
        if c:
            raise HTTPException(409, f"{p['ad']} {c}")
    except HTTPException:
        if sessiz:
            return None
        raise
    if kaynak in ("elle", "kopya") and gun < is_gunu():
        kaynak = "sonradan"   # Y5: geçmiş güne yazılan damgalı (maaşta uyarı, geç ölçülmez)
    vid = "vp-" + uuid.uuid4().hex[:12]
    cur.execute("""INSERT INTO ey_vardiya_plan (id, personel_id, gun, tur, sube_id, bas, bit, gece, kalip_id, kaynak, onceki_id, degistiren)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (vid, str(pid), gun, tur, sube_id if tur == "calisma" else None, bas, bit,
                 bool(tur == "calisma" and _dk(bit) <= _dk(bas)), kalip_id, kaynak, onceki_id, kim))
    return vid


def _iptal(cur, vid: str, kim: str, neden: str) -> dict:
    cur.execute("""UPDATE ey_vardiya_plan SET iptal=TRUE, iptal_neden=%s, iptal_kim=%s, iptal_zaman=NOW()
                    WHERE id=%s AND NOT iptal RETURNING *""", (neden[:200], kim, vid))
    r = cur.fetchone()
    if not r:
        raise HTTPException(409, "Satır bulunamadı ya da değişmiş — sayfayı yenile")
    return dict(r)


# ─────────────────────────── uçlar ───────────────────────────
@router.get("/hafta")
def hafta(pazartesi: Optional[str] = None):
    """Merkez ekranı: haftanın TÜM satırları (taslak dahil) + kalıplar + yayın durumu + uyarılar (modülün kendi sekmesi, K4)."""
    with db() as (conn, cur):
        vardiya_hazirla(cur)
        from evvel_yeni_tanim_api import subeler, tanim_listesi, mudur_mu
        bugun = is_gunu()
        pzt = _pazartesi(_tarih(pazartesi) if pazartesi else bugun)
        paz = pzt + timedelta(days=6)
        sb = [s for s in subeler(cur) if not s.get("depo") or _kalip_var(cur, s["id"])]
        cur.execute("SELECT * FROM ey_vardiya_kalip WHERE aktif ORDER BY sube_id, sira, bas")
        kaliplar = [dict(r) for r in cur.fetchall() or []]
        rows = _satirlar(cur, pzt - timedelta(days=6), paz)   # 7 gün kuralı için önceki 6 gün de
        yayin = _yayin_haritasi(cur, pzt, pzt)
        kisiler = [p for p in tanim_listesi(cur, "ey_personel", ("ad", "sube_id", "gorev", "giris", "cikis", "calisma_turu", "aktif"))
                   if (p.get("aktif") or (p.get("cikis") and p["cikis"] >= pzt)) and not (p.get("giris") and p["giris"] > paz)]
        hafta_rows = [r for r in rows if r["gun"] >= pzt]
        uyarilar = _uyarilar(cur, pzt, sb, kaliplar, rows, kisiler, bugun)
        return {
            "pazartesi": pzt.isoformat(), "bugun": bugun.isoformat(), "gunler": [(pzt + timedelta(days=i)).isoformat() for i in range(7)],
            "subeler": [{"id": s["id"], "ad": s["ad"],
                         "yayin": ({"kim": yayin[(s["id"], pzt)]["yayinlayan"], "zaman": str(yayin[(s["id"], pzt)]["zaman"])[:16]}
                                   if (s["id"], pzt) in yayin else None),
                         "degisen": sum(1 for r in hafta_rows if r.get("sube_id") == s["id"] and (s["id"], pzt) in yayin
                                        and r["zaman"] > yayin[(s["id"], pzt)]["zaman"]),
                         "satir": sum(1 for r in hafta_rows if r.get("sube_id") == s["id"])} for s in sb],
            "kaliplar": [{"id": k["id"], "sube_id": k["sube_id"], "ad": k["ad"], "bas": _hm(k["bas"]), "bit": _hm(k["bit"]),
                          "kisi": k["kisi"], "gunler": list(k["gunler"] or []), "sira": k["sira"]} for k in kaliplar],
            "plan": [_disa(r) for r in hafta_rows],
            "personel": [{"id": p["id"], "ad": p["ad"], "sube_id": p.get("sube_id"), "calisma_turu": p.get("calisma_turu") or "tam",
                          "mudur": mudur_mu(p.get("gorev")), "aktif": bool(p.get("aktif")),
                          "cikis": p["cikis"].isoformat() if p.get("cikis") else None} for p in kisiler],
            "uyarilar": uyarilar,
            "eski_kopya": pzt <= ESKI_KOPYA_SON and tablo_var(cur, "vardiya_atama"),
        }


def _kalip_var(cur, sid: str) -> bool:
    cur.execute("SELECT 1 FROM ey_vardiya_kalip WHERE sube_id=%s AND aktif LIMIT 1", (str(sid),))
    return bool(cur.fetchone())


def _uyarilar(cur, pzt: date, sb: list, kaliplar: list, rows: list, kisiler: list, bugun: date) -> List[dict]:
    """Modülün Uyarılar listesi (personele gitmez, Bekleyen işler'e düşmez — K4): kalıp eksik · 7 gün üst üste (Y11) ·
    sonradan yazılan · yayınlanmamış hafta."""
    out = []
    sad = {s["id"]: s["ad"] for s in sb}
    pad = {p["id"]: p["ad"] for p in kisiler}
    hafta_rows = [r for r in rows if r["gun"] >= pzt and r["tur"] == "calisma"]
    for k in kaliplar:
        if k["sube_id"] not in sad:
            continue
        for i in range(7):
            g = pzt + timedelta(days=i)
            if g < bugun or (g.isoweekday() not in (k["gunler"] or [])):
                continue
            n = sum(1 for r in hafta_rows if r["gun"] == g and r["kalip_id"] == k["id"])
            if n < k["kisi"]:
                out.append({"tur": "kalip_eksik", "gun": g.isoformat(), "sube_id": k["sube_id"],
                            "metin": f"{sad[k['sube_id']]} · {g.strftime('%d.%m')} {k['ad']} {n}/{k['kisi']} kişi"})
    gunler: Dict[str, set] = {}
    for r in rows:
        if r["tur"] == "calisma":
            gunler.setdefault(r["personel_id"], set()).add(r["gun"])
    for pid, gs in gunler.items():
        seri, en = 0, 0
        for i in range(13):
            g = pzt - timedelta(days=6) + timedelta(days=i)
            seri = seri + 1 if g in gs else 0
            if g >= pzt:
                en = max(en, seri)
        if en >= 7:
            out.append({"tur": "yedi_gun", "personel_id": pid,
                        "metin": f"{pad.get(pid, '—')} 7 gün üst üste planlı — hafta tatili verilmemiş"})
    for r in rows:
        if r["gun"] >= pzt and r["kaynak"] == "sonradan":
            out.append({"tur": "sonradan", "personel_id": r["personel_id"],
                        "metin": f"{pad.get(r['personel_id'], '—')} · {r['gun'].strftime('%d.%m')} sonradan yazıldı ({r.get('degistiren') or '—'})"})
    return out


class PlanBody(BaseModel):
    personel_id: str
    gun: str
    tur: str = "calisma"          # calisma | izin
    sube_id: Optional[str] = None
    bas: Optional[str] = None
    bit: Optional[str] = None
    kalip_id: Optional[str] = None


@router.post("/plan")
def plan_ekle(b: PlanBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    if b.tur not in ("calisma", "izin"):
        raise HTTPException(400, "tür: calisma | izin")
    with db() as (conn, cur):
        vardiya_hazirla(cur)
        kim = merkez_aktor(cur, x_evvel_oturum)
        gun = _tarih(b.gun)
        if b.tur == "izin":
            vid = _yaz(cur, pid=b.personel_id, gun=gun, tur="izin", kim=kim)
            return {"ok": True, "id": vid, "mesaj": "İzinli olarak yazıldı"}
        if not b.sube_id:
            raise HTTPException(400, "Şube seç")
        from evvel_yeni_tanim_api import tanim_oku
        s = tanim_oku(cur, "ey_sube", b.sube_id, ("aktif",))
        if not s or not s["aktif"]:
            raise HTTPException(400, "Şube bulunamadı ya da pasif")
        kalip = None
        if b.kalip_id:
            cur.execute("SELECT id FROM ey_vardiya_kalip WHERE id=%s AND sube_id=%s", (b.kalip_id, str(b.sube_id)))
            kalip = b.kalip_id if cur.fetchone() else None
        vid = _yaz(cur, pid=b.personel_id, gun=gun, tur="calisma", kim=kim, sube_id=str(b.sube_id),
                   bas=saat_oku(b.bas, "Başlangıç"), bit=saat_oku(b.bit, "Bitiş"), kalip_id=kalip)
        return {"ok": True, "id": vid, "mesaj": "Plana yazıldı"}


class DegistirBody(BaseModel):
    bas: str
    bit: str


@router.post("/plan/{vid}/degistir")
def plan_degistir(vid: str, b: DegistirBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Saat değişikliği = eski satır iptal + yeni satır (onceki_id) — iz kalır (append-only)."""
    with db() as (conn, cur):
        vardiya_hazirla(cur)
        kim = merkez_aktor(cur, x_evvel_oturum)
        cur.execute("SELECT * FROM ey_vardiya_plan WHERE id=%s AND NOT iptal", (vid,))
        r = cur.fetchone()
        if not r or dict(r)["tur"] != "calisma":
            raise HTTPException(409, "Satır bulunamadı ya da değişmiş — sayfayı yenile")
        r = dict(r)
        bas, bit = saat_oku(b.bas, "Başlangıç"), saat_oku(b.bit, "Bitiş")
        yeni = _yaz(cur, pid=r["personel_id"], gun=r["gun"], tur="calisma", kim=kim, sube_id=r["sube_id"], bas=bas, bit=bit,
                    kalip_id=r.get("kalip_id"), onceki_id=vid)
        _iptal(cur, vid, kim, f"saat değişti → {_hm(bas)}–{_hm(bit)}")
        return {"ok": True, "id": yeni, "mesaj": "Saat değişti"}


class IptalBody(BaseModel):
    neden: Optional[str] = None


@router.post("/plan/{vid}/iptal")
def plan_iptal(vid: str, b: IptalBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    with db() as (conn, cur):
        vardiya_hazirla(cur)
        kim = merkez_aktor(cur, x_evvel_oturum)
        _iptal(cur, vid, kim, (b.neden or "plandan kaldırıldı"))
        return {"ok": True, "mesaj": "Plandan kaldırıldı"}


class KopyaBody(BaseModel):
    pazartesi: str                 # HEDEF hafta; kaynak = bir önceki hafta
    sube_id: Optional[str] = None  # boş → bütün şubeler


@router.post("/hafta-kopyala")
def hafta_kopyala(b: KopyaBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Geçen haftanın çalışma satırları bu haftaya (taslak, R7). Dolu / çakışan / izinli / ayrılmış kişi ve geçmiş gün ATLANIR."""
    with db() as (conn, cur):
        vardiya_hazirla(cur)
        kim = merkez_aktor(cur, x_evvel_oturum)
        pzt = _pazartesi(_tarih(b.pazartesi))
        bugun = is_gunu()
        cur.execute("SELECT id FROM ey_vardiya_kalip WHERE aktif")
        aktif_kalip = {dict(r)["id"] for r in cur.fetchall() or []}
        kaynak = [r for r in _satirlar(cur, pzt - timedelta(days=7), pzt - timedelta(days=1), b.sube_id) if r["tur"] == "calisma"]
        n, atla = 0, 0
        for r in kaynak:
            g = r["gun"] + timedelta(days=7)
            if g < bugun:
                atla += 1
                continue
            vid = _yaz(cur, pid=r["personel_id"], gun=g, tur="calisma", kim=kim, sube_id=r["sube_id"], bas=r["bas"], bit=r["bit"],
                       kalip_id=r["kalip_id"] if r.get("kalip_id") in aktif_kalip else None, kaynak="kopya", sessiz=True)
            n, atla = (n + 1, atla) if vid else (n, atla + 1)
        if not kaynak:
            raise HTTPException(409, "Geçen haftada kopyalanacak plan yok")
        return {"ok": True, "kopyalanan": n, "atlanan": atla,
                "mesaj": f"{n} satır kopyalandı" + (f", {atla} atlandı (dolu / izinli / geçmiş gün)" if atla else "") + " — taslak, yayınlamayı unutma"}


class YayinBody(BaseModel):
    pazartesi: str
    sube_id: Optional[str] = None  # boş → planı olan bütün şubeler


@router.post("/yayinla")
def yayinla(b: YayinBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Y2/Y9: yazan yayınlar. Yayından sonra değişiklik anında geçerli (R3) — 'yayın zamanı' yenilenir, 'değişti' sayacı sıfırlanır."""
    with db() as (conn, cur):
        vardiya_hazirla(cur)
        kim = merkez_aktor(cur, x_evvel_oturum)
        pzt = _pazartesi(_tarih(b.pazartesi))
        if b.sube_id:
            sids = [str(b.sube_id)]
        else:
            cur.execute("""SELECT DISTINCT sube_id FROM ey_vardiya_plan WHERE NOT iptal AND tur='calisma' AND gun BETWEEN %s AND %s""",
                        (pzt, pzt + timedelta(days=6)))
            sids = [dict(r)["sube_id"] for r in cur.fetchall() or []]
        if not sids:
            raise HTTPException(409, "Bu haftada yayınlanacak plan yok")
        for s in sids:
            cur.execute("""INSERT INTO ey_vardiya_yayin (sube_id, pazartesi, yayinlayan) VALUES (%s,%s,%s)
                           ON CONFLICT (sube_id, pazartesi) DO UPDATE SET yayinlayan=EXCLUDED.yayinlayan, zaman=NOW()""", (s, pzt, kim))
        return {"ok": True, "mesaj": f"{len(sids)} şubenin haftası yayınlandı — personel görür"}


class EskiBody(BaseModel):
    pazartesi: str


@router.post("/eski-kopya")
def eski_kopya(b: EskiBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Y4/R6: eski ekranda yazılmış haftayı BİR KEZ al (en geç 9 Kasım haftası). Yeni planda o kişi-gün dolu ise atlar; alınan
    hafta YAYIN sayılır (eski sistemde personel zaten görüyordu). Eski tablo yalnız bu düğmede okunur — köprü değil."""
    with db() as (conn, cur):
        vardiya_hazirla(cur)
        kim = merkez_aktor(cur, x_evvel_oturum)
        pzt = _pazartesi(_tarih(b.pazartesi))
        if pzt > ESKI_KOPYA_SON:
            raise HTTPException(409, "Eski plandan en geç 9 Kasım haftası alınır — sonrası yalnız burada yazılır")
        if not tablo_var(cur, "vardiya_atama"):
            raise HTTPException(409, "Eski plan tablosu yok")
        cur.execute("SELECT id FROM ey_vardiya_kalip")
        kaliplar = {dict(r)["id"] for r in cur.fetchall() or []}
        with savepoint(cur, "sp_ey_vardiya_eski"):
            cur.execute("""SELECT a.personel_id::text AS pid, a.tarih, a.baslangic_saat AS bas, a.bitis_saat AS bit,
                                  a.slot_id::text AS slot_id, s.sube_id::text AS sube_id
                             FROM vardiya_atama a JOIN vardiya_slot s ON s.id = a.slot_id
                            WHERE a.tarih BETWEEN %s AND %s AND COALESCE(a.durum,'') <> 'iptal'
                            ORDER BY a.tarih, a.baslangic_saat""", (pzt, pzt + timedelta(days=6)))
            eski = [dict(r) for r in cur.fetchall() or []]
        from evvel_yeni_tanim_api import tanim_listesi
        ey_sube = {s["id"] for s in tanim_listesi(cur, "ey_sube", ("ad",))}
        n, atla = 0, 0
        subeler_ = set()
        for r in eski:
            if r["sube_id"] not in ey_sube:
                atla += 1
                continue
            try:
                with savepoint(cur, "sp_ey_vardiya_eski_satir"):
                    vid = _yaz(cur, pid=r["pid"], gun=r["tarih"], tur="calisma", kim=kim, sube_id=r["sube_id"], bas=r["bas"], bit=r["bit"],
                               kalip_id=("vk-" + r["slot_id"]) if ("vk-" + str(r["slot_id"])) in kaliplar else None,
                               kaynak="eski_kopya", sessiz=True)
            except HTTPException:
                vid = None   # personel Evvel Yeni'de yok
            if vid:
                n += 1
                subeler_.add(r["sube_id"])
            else:
                atla += 1
        for s in subeler_:
            cur.execute("""INSERT INTO ey_vardiya_yayin (sube_id, pazartesi, yayinlayan) VALUES (%s,%s,%s)
                           ON CONFLICT (sube_id, pazartesi) DO NOTHING""", (s, pzt, f"{kim} (eski plan)"))
        if not eski:
            raise HTTPException(409, "Eski ekranda bu hafta için plan yok")
        return {"ok": True, "mesaj": f"Eski plandan {n} satır alındı" + (f", {atla} atlandı (zaten var / çakışıyor / kişi yok)" if atla else "")
                + " — hafta yayında sayıldı"}


# ── Kalıplar ──
class KalipBody(BaseModel):
    sube_id: Optional[str] = None
    ad: Optional[str] = None
    bas: Optional[str] = None
    bit: Optional[str] = None
    kisi: Optional[int] = None
    gunler: Optional[List[int]] = None
    aktif: Optional[bool] = None


def _kalip_alan(b: KalipBody) -> dict:
    a = {}
    if b.ad is not None:
        if not b.ad.strip():
            raise HTTPException(400, "Kalıba ad ver (ör. Sabah)")
        a["ad"] = b.ad.strip()[:40]
    if b.bas is not None:
        a["bas"] = saat_oku(b.bas, "Başlangıç")
    if b.bit is not None:
        a["bit"] = saat_oku(b.bit, "Bitiş")
    if b.kisi is not None:
        if not 0 <= int(b.kisi) <= 20:
            raise HTTPException(400, "Kişi sayısı 0–20")
        a["kisi"] = int(b.kisi)
    if b.gunler is not None:
        g = sorted({int(x) for x in b.gunler if 1 <= int(x) <= 7})
        if not g:
            raise HTTPException(400, "En az bir gün seç")
        a["gunler"] = g
    if b.aktif is not None:
        a["aktif"] = bool(b.aktif)
    return a


@router.post("/kalip")
def kalip_ekle(b: KalipBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    with db() as (conn, cur):
        vardiya_hazirla(cur)
        kim = merkez_aktor(cur, x_evvel_oturum)
        a = _kalip_alan(b)
        if not b.sube_id or not all(k in a for k in ("ad", "bas", "bit")):
            raise HTTPException(400, "Şube, ad, başlangıç ve bitiş gerekli")
        cur.execute("SELECT COALESCE(MAX(sira),0)+1 AS s FROM ey_vardiya_kalip WHERE sube_id=%s", (str(b.sube_id),))
        sira = dict(cur.fetchone())["s"]
        kid = "vk-" + uuid.uuid4().hex[:10]
        cur.execute("""INSERT INTO ey_vardiya_kalip (id, sube_id, ad, bas, bit, gece, kisi, gunler, sira, degistiren)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (kid, str(b.sube_id), a["ad"], a["bas"], a["bit"], _dk(a["bit"]) <= _dk(a["bas"]), a.get("kisi", 1),
                     a.get("gunler", [1, 2, 3, 4, 5, 6, 7]), sira, kim))
        return {"ok": True, "id": kid, "mesaj": "Kalıp eklendi"}


@router.post("/kalip/{kid}/degistir")
def kalip_degistir(kid: str, b: KalipBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Kalıp değişir / pasife alınır; SİLİNMEZ. Planda saatler kopyalı durduğu için eski satırlar etkilenmez."""
    with db() as (conn, cur):
        vardiya_hazirla(cur)
        kim = merkez_aktor(cur, x_evvel_oturum)
        a = _kalip_alan(b)
        if not a:
            raise HTTPException(400, "Değişiklik yok")
        cur.execute("SELECT bas, bit FROM ey_vardiya_kalip WHERE id=%s", (kid,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Kalıp bulunamadı")
        bas, bit = a.get("bas", dict(r)["bas"]), a.get("bit", dict(r)["bit"])
        a["gece"] = _dk(bit) <= _dk(bas)
        ek = ", ".join(f"{k}=%s" for k in a)
        cur.execute(f"UPDATE ey_vardiya_kalip SET {ek}, degistiren=%s, zaman=NOW() WHERE id=%s", (*a.values(), kim, kid))
        return {"ok": True, "mesaj": "Kalıp pasife alındı" if a.get("aktif") is False else "Kalıp güncellendi"}


# ── Ayar ──
@router.get("/ayar")
def ayar():
    with db() as (conn, cur):
        return {"gec_tolerans_dk": int(ayar_oku(cur, "vardiya_gec_tolerans_dk", "10") or 10),
                "gunluk_saat": float(ayar_oku(cur, "vardiya_gunluk_saat", GUNLUK_SAAT) or GUNLUK_SAAT)}


class AyarBody(BaseModel):
    gec_tolerans_dk: int


@router.post("/ayar")
def ayar_kaydet(b: AyarBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    if not 0 <= b.gec_tolerans_dk <= 60:
        raise HTTPException(400, "Tolerans 0–60 dakika")
    with db() as (conn, cur):
        kim = merkez_aktor(cur, x_evvel_oturum)
        ayar_yaz(cur, "vardiya_gec_tolerans_dk", str(int(b.gec_tolerans_dk)), kim)
        return {"ok": True, "mesaj": f"Geç kalma toleransı {b.gec_tolerans_dk} dk"}


# ─────────────────────────── Bekleyen işler (K4 — yalnız 'plan yok'; 'gelmedi' V1'de Maaş/yoklamayla) ───────────────────────────
def _bekleyen(cur, baglam: dict) -> list:
    """Kalıbı olan şubenin bu haftası (ya da Cuma'dan itibaren gelecek haftası) YAYINLANMAMIŞSA tek satır (R5)."""
    if not tablo_var(cur, "ey_vardiya_kalip", "ey_vardiya_yayin"):
        return []
    from evvel_yeni_tanim_api import subeler
    bugun = is_gunu()
    haftalar = [_pazartesi(bugun)] + ([_pazartesi(bugun) + timedelta(days=7)] if bugun.weekday() >= 4 else [])
    cur.execute("SELECT DISTINCT sube_id FROM ey_vardiya_kalip WHERE aktif")
    kalipli = {dict(r)["sube_id"] for r in cur.fetchall() or []}
    yayin = _yayin_haritasi(cur, haftalar[0], haftalar[-1])
    out = []
    for s in subeler(cur):
        if s["id"] not in kalipli:
            continue
        for h in haftalar:
            if h < ILK_HAFTA or (s["id"], h) in yayin:
                continue
            out.append({"tur": "vardiya_plan_yok", "genel": True, "grup": "personel", "id": f"vardiya:{s['id']}:{h.isoformat()}",
                        "tarih": h.isoformat(), "etiket": "🗓 Vardiya planı yayınlanmadı", "ad": s["ad"],
                        "alt": f"{h.strftime('%d.%m')}–{(h + timedelta(days=6)).strftime('%d.%m')} haftası — planla ve yayınla",
                        "sayfa": "vardiya_plani", "dugme": "Vardiya planı"})
    return out


bekleyen_is_kaydet("vardiya", _bekleyen)
