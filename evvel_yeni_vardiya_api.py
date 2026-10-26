"""🗓️ EVVEL YENİ · VARDİYA PLANI (2026-10-20) — tak-çıkar modül (sayfası Personel altında). Tasarım: VARDIYA_PLANI_TASARIM.md.

Sahip (20 Eki): "baştan ele al — daha kolay, mantığı daha hoş; ama en az eskisi kadar işe yarar." Eski ekranın 9 tablosu / 40 ucu
yerine ÜÇ kavram:
  · KALIP  = şubenin kadro iskeleti ("Zafer · Sabah 09:00–18:30 · 1 kişi · her gün"). Eski slot + hedef + preset → tek satır.
  · PLAN   = kişi × iş günü × şube × saat. İZİN burada DEĞİL: Maaş'ın izin defteri TEK gerçek (sahip 20 Eki "tek yer + tarih
             aralığı") — ızgaradaki gri hücre oradan okunur, "İzinli … gününe kadar" oraya yazar (Maaş PUBLIC izin_*). APPEND-ONLY: değişiklik = eski satır
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
from evvel_yeni_cekirdek import (ayar_oku, saat_oku, ayar_yaz, bekleyen_is_kaydet, bir_kez, ddl_kur, is_gunu, merkez_aktor, tablo_var,
                                 tr_gun)

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
        CHECK (tur = 'calisma'), CHECK (sube_id IS NOT NULL AND bas IS NOT NULL AND bit IS NOT NULL))   -- izin Maaş'ta (TEK gerçek)""")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ey_vplan_gun ON ey_vardiya_plan (gun, sube_id) WHERE NOT iptal")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ey_vplan_kisi ON ey_vardiya_plan (personel_id, gun) WHERE NOT iptal")
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_vardiya_yayin (
        sube_id TEXT NOT NULL, pazartesi DATE NOT NULL, yayinlayan TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (sube_id, pazartesi))""")


def _eski_kalip_kopya(cur) -> None:
    """BİR KEZ: eski vardiya_slot (aktif, Evvel Yeni'de olan şube) → kalıp. Eski 'Serbest' otomatik slotlar alınmaz (sahip V3)."""
    if not tablo_var(cur, "vardiya_slot"):
        return
    from evvel_yeni_tanim_api import tanim_listesi   # şube kimliği Tanımlar'ın kapısından (başka modülün tablosuna SQL yok)
    ey_sube = [x["id"] for x in tanim_listesi(cur, "ey_sube", ("ad",))]
    cur.execute("""INSERT INTO ey_vardiya_kalip (id, sube_id, ad, bas, bit, gece, kisi, gunler, sira, kaynak, degistiren)
                   SELECT 'vk-' || s.id, s.sube_id, s.ad, s.baslangic_saat, s.bitis_saat, COALESCE(s.gece_vardiyasi, FALSE),
                          GREATEST(COALESCE(s.ideal_personel, 1), 1), COALESCE(s.aktif_gunler, '{1,2,3,4,5,6,7}'), COALESCE(s.sira, 0),
                          'eski_kopya', 'eski sistem kopyası'
                     FROM vardiya_slot s
                    WHERE s.aktif AND s.ad <> 'Serbest' AND s.sube_id::text = ANY(%s)
                   ON CONFLICT (id) DO NOTHING""", (ey_sube,))


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
    hazirdi = tablo_var(cur, "ey_vardiya_kalip", "ey_vardiya_plan", "ey_vardiya_yayin")
    if not hazirdi:
        try:
            ddl_kur(cur, "sp_ey_vardiya_ddl", _ddl)   # TEK DDL modeli (çekirdek): savepoint + 3 sn kilit, çağıranın işleminde
        except Exception:  # noqa: BLE001
            log.warning("vardiya tabloları kurulamadı", exc_info=True)
            raise HTTPException(503, "Vardiya hazırlanıyor — birkaç saniye sonra tekrar dene")
    kopyali = ayar_oku(cur, "vardiya_kalip_kopya") is not None
    if not kopyali:
        bir_kez(cur, "vardiya_kalip_kopya", _eski_kalip_kopya, "vardiya kalıp kopyası")
    # Fable D-V0: bayrak ancak nesneler bu çağrıdan ÖNCE varsa açılır (bu işlem geri alınırsa tablolar da gider — 'relation yok' 500 olmasın)
    _HAZIR = hazirdi and kopyali


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
    """Satır personel / maaş / yoklama için GEÇERLİ mi (Y2 + R4, Fable D-V0): izin her zaman · şubenin o haftası yayınlandıysa ·
    yayınlanmadıysa yalnız GÜNÜ GELMİŞKEN YAZILAN satır (geçmiş/bugün için yazılan — 'sonradan' / bugünkü düzeltme). Önceden
    yazılıp YAYINLANMADAN unutulan taslak, gün geçince kendiliğinden geçerli olmaz (personel görmediği planla ölçülmesin)."""
    if r["tur"] == "izin" or (r["sube_id"], _pazartesi(r["gun"])) in yayin:
        return True
    return tr_gun(r["zaman"]) >= r["gun"]


def _izinler(cur, bas: date, son: date, personel_id: Optional[str] = None) -> List[dict]:
    """İzin TEK gerçek Maaş'ta (sahip 20 Eki): Maaş PUBLIC izin_araliklari — Maaş kapalıysa izin yok (tak-çıkar yumuşak bağ)."""
    from evvel_yeni_moduller import acik
    if not acik("maas"):
        return []
    from evvel_yeni_maas_api import izin_araliklari
    return izin_araliklari(cur, bas, son, personel_id)


def _izin_satirlari(cur, bas: date, son: date, personel_id: Optional[str] = None) -> List[dict]:
    """İzin aralıklarını gün gün plan satırı biçimine açar (tur='izin', id 'izin:<kayıt>'). Bitişi belli olmayan izin 'son'a kadar."""
    out = []
    for z in _izinler(cur, bas, son, personel_id):
        g = max(z["bas"], bas)
        while g <= min(z["bit"] or son, son):
            out.append({"id": f"izin:{z['id']}", "personel_id": str(z["personel_id"]), "gun": g, "tur": "izin", "sube_id": None,
                        "bas": None, "bit": None, "gece": False, "kalip_id": None, "kaynak": "izin", "zaman": None,
                        "degistiren": z.get("degistiren"), "izin_bas": z["bas"], "izin_bit": z["bit"]})
            g += timedelta(days=1)
    return out


def _satirlar(cur, bas: date, son: date, sube_id: Optional[str] = None, personel_id: Optional[str] = None) -> List[dict]:
    """Plan tablosunun ÇALIŞMA satırları (izin Maaş'ta — _izin_satirlari)."""
    kos, prm = ["NOT iptal", "tur = 'calisma'", "gun BETWEEN %s AND %s"], [bas, son]
    if sube_id:
        kos.append("sube_id = %s")
        prm.append(str(sube_id))
    if personel_id:
        kos.append("personel_id = %s")
        prm.append(str(personel_id))
    cur.execute(f"SELECT * FROM ey_vardiya_plan WHERE {' AND '.join(kos)} ORDER BY gun, bas NULLS FIRST, personel_id", tuple(prm))
    return [dict(r) for r in cur.fetchall() or []]


def _ayrilis(cur) -> Dict[str, date]:
    """{personel_id: ayrılış günü} — ayrılış tarihi girilmiş kişiler (Tanımlar'ın kapısı)."""
    from evvel_yeni_tanim_api import tanim_listesi
    return {p["id"]: p["cikis"] for p in tanim_listesi(cur, "ey_personel", ("cikis",)) if p.get("cikis")}


def _ayrildi(r: dict, ayr: Dict[str, date]) -> bool:
    """S-B8: satır kişinin ayrılış gününden SONRA mı (Tanımlar TEK kural ayrildi_mi). Ayrılış tarihi plan yazıldıktan sonra
    girilince eski satırlar planda kalıyor, ihtiyacı dolduruyor, maaşa/panele gidiyordu."""
    return __import__("evvel_yeni_tanim_api").ayrildi_mi(ayr.get(str(r["personel_id"])), r["gun"])


def _disa(r: dict) -> dict:
    return {"id": r["id"], "gun": r["gun"].isoformat(), "personel_id": r["personel_id"], "sube_id": r.get("sube_id"), "tur": r["tur"],
            "bas": _hm(r.get("bas")), "bit": _hm(r.get("bit")), "gece": bool(r.get("gece")), "kalip_id": r.get("kalip_id"),
            "kaynak": r["kaynak"], "saat": round(sure_saat(r["bas"], r["bit"]), 2) if r["tur"] == "calisma" else 0,
            "etiket": _etiket(r["bas"]) if r["tur"] == "calisma" else "izinli", "degistiren": r.get("degistiren"),
            "zaman": str(r.get("zaman") or "")[:16],
            **({"izin_bas": r["izin_bas"].isoformat(), "izin_bit": r["izin_bit"].isoformat() if r.get("izin_bit") else None}
               if r["tur"] == "izin" else {})}


# ─────────────────────────── PUBLIC servisler ───────────────────────────
def plan_baslangic() -> date:
    """PUBLIC (B44): yeni Vardiya planının geçerli olduğu ilk gün — öncesi eski ekranda yazıldı (sınır TEK yerde)."""
    return ILK_HAFTA


def gun_plani(cur, bas: date, son: date, sube_id: Optional[str] = None, izin: bool = False) -> List[dict]:
    """PUBLIC — GEÇERLİ (yayınlanmış ya da geçmiş) çalışma satırları [{gun, personel_id, sube_id, bas, bit, gece, saat, etiket,
    kaynak, kalip_id}]; izin=True ise 'izin' satırları da (tur alanıyla). Günlük yoklama, panel 'Bugün' ve Maaş buradan okur."""
    vardiya_hazirla(cur)
    yayin, bugun, ayr = _yayin_haritasi(cur, bas, son), is_gunu(), _ayrilis(cur)
    out = [_disa(r) for r in _satirlar(cur, bas, son, sube_id) if _gecerli(r, yayin, bugun) and not _ayrildi(r, ayr)
           and r.get("bas") is not None and r.get("bit") is not None]   # Fable: saatsiz satır bütün ayın planını düşürmesin
    return out + ([_disa(r) for r in _izin_satirlari(cur, bas, son)] if izin else [])


def kisi_gunleri(cur, personel_id: str, bas: date, son: date) -> List[dict]:
    """PUBLIC — telefon 'Bugün / Bu hafta' (V2): kişinin geçerli satırları, şube adıyla."""
    vardiya_hazirla(cur)
    from evvel_yeni_tanim_api import adlar
    yayin, bugun = _yayin_haritasi(cur, bas, son), is_gunu()
    ayr = _ayrilis(cur)
    rows = [r for r in _satirlar(cur, bas, son, personel_id=personel_id) if _gecerli(r, yayin, bugun) and not _ayrildi(r, ayr)]
    rows += _izin_satirlari(cur, bas, son, personel_id)
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


AY_ADI = ('Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık')


def _kisi_kilitleri(cur, pids) -> None:
    """Çok kişili işlemde (geri al · kopya · temizlik · yayın) kişi kilitleri BAŞTA ve SIRALI alınır (Codex 2. tur: aksi halde
    iki toplu işlem birbirinin kişisini / maaş ayını bekleyip kilitlenebilir). Sıra her yerde: hafta → kişiler → maaş ayı."""
    for pid in sorted({str(x) for x in pids}):
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("ey_vardiya:" + pid,))


def _maas_kilitli_mi(cur, pid: str, gun: date) -> bool:
    from evvel_yeni_moduller import acik
    if not acik("maas"):
        return False
    from evvel_yeni_maas_api import ay_kilitli
    return ay_kilitli(cur, pid, gun.strftime("%Y-%m"))


def _yayin_kilidi(cur, sids, pzt: date) -> None:
    """Yayın kaydı EKLENİNCE ya da SİLİNİNCE şubenin o haftasındaki yayınlanmamış satırların geçerliliği değişir (_gecerli) →
    etkilenen HER kişi-ay maaş kilidinden geçer (Codex P1: yayınla · eski plandan al · eski planı geri al)."""
    sids = [str(s) for s in sids]
    if not sids:
        return
    cur.execute("""SELECT DISTINCT personel_id, to_char(gun, 'YYYY-MM') AS ay FROM ey_vardiya_plan
                    WHERE NOT iptal AND tur='calisma' AND sube_id = ANY(%s) AND gun BETWEEN %s AND %s
                    ORDER BY personel_id, ay""", (sids, pzt, pzt + timedelta(days=6)))   # ay kilitleri sıralı (izin_kaldir da artan ay)
    rows = [dict(r) for r in cur.fetchall() or []]
    _kisi_kilitleri(cur, [r["personel_id"] for r in rows])
    kilitli = [r for r in rows if _maas_kilitli_mi(cur, r["personel_id"], date.fromisoformat(r["ay"] + "-01"))]
    if kilitli:
        from evvel_yeni_tanim_api import adlar
        ad = adlar(cur, "ey_personel", [k["personel_id"] for k in kilitli])
        raise HTTPException(409, "Maaşı onaylı: " + ", ".join(f"{ad.get(str(k['personel_id'])) or '—'} ({AY_ADI[int(k['ay'][5:7]) - 1]})"
                                                             for k in kilitli) + " — yayın durumu değişirse plan değişir; önce Maaş'ta onayı kaldır")


def _maas_kilidi(cur, p: dict, pid: str, gun: date) -> None:
    """IS 4k (Opus + Fable + Codex 26 Eki): kişinin o ayki maaşı kilitliyse (Maaş PUBLIC ay_kilitli — bugün: onaylı) o ayın gününe
    yazılmaz / kaldırılmaz — maaş donmuş kalemle kapanır, plan değişirse iz maaşla tutmaz. Maaş kapalıysa kontrol yok (tak-çıkar).
    Ekim ve öncesi eski sistemle kapanır (ey_maas_ay onayı yok) → bu kilit Kasım'dan itibaren çalışır."""
    if _maas_kilitli_mi(cur, pid, gun):
        raise HTTPException(409, f"{p['ad']} · {AY_ADI[gun.month - 1]} maaşı onaylı — plan değişirse maaşla iz tutmaz; önce Maaş'ta onayı kaldır")


def _calisir_mi(p: dict, gun: date) -> None:
    if p.get("giris") and gun < p["giris"]:
        raise HTTPException(409, f"{p['ad']} {p['giris'].strftime('%d.%m')} tarihinde işe başladı — bu güne yazılamaz")
    if p.get("cikis") and gun > p["cikis"]:
        raise HTTPException(409, f"{p['ad']} {p['cikis'].strftime('%d.%m')} tarihinde ayrıldı — bu güne yazılamaz")


def _cakisma(cur, pid: str, gun: date, tur: str, bas: Optional[time], bit: Optional[time], haric: Optional[str] = None) -> Optional[str]:
    """TEK sert kural: aynı kişi aynı anda iki yerde olamaz (gece vardiyası komşu güne taşar → ±1 gün bakılır). İzinli güne
    (Maaş izin kaydı) çalışma yazılmaz. Dönüş: çakışma metni ya da None."""
    from evvel_yeni_tanim_api import adlar
    z = _izinler(cur, gun, gun, pid)
    if z:
        return (f"o gün izinli ({z[0]['bas'].strftime('%d.%m')}–{z[0]['bit'].strftime('%d.%m') if z[0]['bit'] else 'bitişi belli değil'})"
                " — önce izni kaldır")
    cur.execute("""SELECT * FROM ey_vardiya_plan WHERE personel_id=%s AND NOT iptal AND tur='calisma' AND gun BETWEEN %s AND %s AND id <> %s""",
                (str(pid), gun - timedelta(days=1), gun + timedelta(days=1), haric or ""))
    rows = [dict(r) for r in cur.fetchall() or []]
    a1, b1 = _aralik(gun, bas, bit)
    for r in rows:
        a2, b2 = _aralik(r["gun"], r["bas"], r["bit"])
        if a1 < b2 and a2 < b1:
            s = adlar(cur, "ey_sube", [r["sube_id"]]).get(str(r["sube_id"])) or "başka şube"
            return f"o saatte {s}'de ({_hm(r['bas'])}–{_hm(r['bit'])}, {r['gun'].strftime('%d.%m')})"
    return None


def _yaz(cur, *, pid: str, gun: date, tur: str, kim: str, sube_id: Optional[str] = None, bas: Optional[time] = None,
         bit: Optional[time] = None, kalip_id: Optional[str] = None, kaynak: str = "elle", onceki_id: Optional[str] = None,
         sessiz: bool = False, damga: bool = True) -> Optional[str]:
    """Plan satırı yazar (hafta + kişi kilidi altında). sessiz=True → çakışmada hata yerine None döner (kopyalama atlar).
    damga=False → geri alma: satır ORİJİNAL kaynağıyla döner, geçmiş günde 'sonradan' basılmaz (Fable IS 4k)."""
    _hafta_kilidi(cur, gun)
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("ey_vardiya:" + str(pid),))
    try:
        p = _kisi(cur, pid)
        _calisir_mi(p, gun)
        _maas_kilidi(cur, p, pid, gun)
        if tur == "calisma" and sure_saat(bas, bit) > 16:
            raise HTTPException(400, "Bir vardiya 16 saatten uzun olamaz — saatleri kontrol et")
        c = _cakisma(cur, pid, gun, tur, bas, bit, haric=onceki_id)
        if c:
            raise HTTPException(409, f"{p['ad']} {c}")
    except HTTPException:
        if sessiz:
            return None
        raise
    if damga and tur == "calisma" and kaynak in ("elle", "kopya") and gun < is_gunu():
        kaynak = "sonradan"   # Y5: geçmiş güne yazılan damgalı (maaşta uyarı, geç ölçülmez)
    vid = "vp-" + uuid.uuid4().hex[:12]
    cur.execute(f"""INSERT INTO ey_vardiya_plan (id, personel_id, gun, tur, sube_id, bas, bit, gece, kalip_id, kaynak, onceki_id, degistiren, zaman)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,{_an_sql()})""",
                (vid, str(pid), gun, tur, sube_id if tur == "calisma" else None, bas, bit,
                 bool(tur == "calisma" and _dk(bit) <= _dk(bas)), kalip_id, kaynak, onceki_id, kim))
    return vid


def _iptal(cur, vid: str, kim: str, neden: str) -> dict:
    cur.execute("SELECT personel_id, gun FROM ey_vardiya_plan WHERE id=%s AND NOT iptal", (vid,))
    o = cur.fetchone()
    if o:
        o = dict(o)
        _hafta_kilidi(cur, o["gun"])
        _kisi_kilitleri(cur, [o["personel_id"]])   # sıra: hafta → kişi → maaş ayı (_yaz ile aynı)
        from evvel_yeni_tanim_api import tanim_oku
        p = tanim_oku(cur, "ey_personel", o["personel_id"], ("ad",)) or {"ad": "Personel"}   # tanımı silinmiş kişinin satırı da kalkar
        _maas_kilidi(cur, p, o["personel_id"], o["gun"])
    cur.execute(f"""UPDATE ey_vardiya_plan SET iptal=TRUE, iptal_neden=%s, iptal_kim=%s, iptal_zaman={_an_sql()}
                    WHERE id=%s AND NOT iptal RETURNING *""", (neden[:200], kim, vid))
    r = cur.fetchone()
    if not r:
        raise HTTPException(409, "Satır bulunamadı ya da değişmiş — sayfayı yenile")
    return dict(r)


# ─────────── 🕘 DEĞİŞİKLİK GEÇMİŞİ + GERİ AL (IS 4k · sahip 24 Eki vaka: Furkan 19.10 yanlışlıkla kaldırıldı) ───────────
# Yeni tablo YOK — olaylar append-only plan satırlarından türetilir. İŞLEM = aynı kişi + aynı işlem zamanı (Postgres NOW() bir
# işlem boyunca sabit: _yaz.zaman + _iptal.iptal_zaman = işlem damgası (_hafta_kilidi'nde kilitten SONRA bir kez üretilir);
# toplu kopya / temizlik tek işlem). ⛔ Plan tablosuna yazan her yol _yaz / _iptal'den geçer — damgasız yazma gruplamayı bozar.
# Kapsam (Opus + Fable + Codex): haftanın SON işlemi, kim yaptıysa; tek seviye (geri almanın kendisi geri alınmaz).

def _hafta_kilidi(cur, gun: date) -> None:
    """Haftanın TEK yazma kilidi (Fable IS 4k: 'son işlem' denetimi ile yazma arasına başka yazma girmesin). Aynı işlemde tekrar
    alınması serbest (advisory xact kilidi yeniden girilebilir). Sıra: önce hafta, sonra kişi kilidi."""
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("ey_vardiya_hafta:" + _pazartesi(gun).isoformat(),))
    # İŞLEM DAMGASI (Codex 3. tur): NOW() işlem BAŞLANGICIDIR, kilit sırasını göstermez → ilk hafta kilidinden SONRA bir kez
    # clock_timestamp() üretilir (işlem-yerel ayar); _yaz.zaman · _iptal.iptal_zaman · yayın zamanı hep bu damga → gruplama aynı,
    # sıra = kilit alma sırası (son işlem / yayın farkı doğru).
    cur.execute("""SELECT set_config('evvel.vardiya_an', clock_timestamp()::text, true)
                    WHERE COALESCE(current_setting('evvel.vardiya_an', true), '') = ''""")


def _an_sql() -> str:
    """Yazmalarda kullanılan işlem damgası (yoksa NOW())."""
    return "COALESCE(NULLIF(current_setting('evvel.vardiya_an', true), '')::timestamptz, NOW())"


def _yayin_farki(cur, pzt: date, paz: date) -> Dict[str, int]:
    """Rozet = yayın ANINDAKİ plan ile ŞİMDİKİ planın farkı, değişen kişi-gün sayısı (şube başına). Kaldır + geri al = 0,
    saati değiştirip eskiye döndürmek = 0 (Codex IS 4k: 'yayına göre KALAN fark')."""
    cur.execute("""SELECT p.sube_id, p.personel_id, p.gun, p.bas, p.bit,
                          (p.zaman <= y.zaman AND (NOT p.iptal OR p.iptal_zaman > y.zaman)) AS yayinda, NOT p.iptal AS simdi
                     FROM ey_vardiya_plan p JOIN ey_vardiya_yayin y ON y.sube_id = p.sube_id AND y.pazartesi = %s
                    WHERE p.tur = 'calisma' AND p.gun BETWEEN %s AND %s""", (pzt, pzt, paz))
    once: Dict[tuple, list] = {}
    simdi: Dict[tuple, list] = {}
    for r in cur.fetchall() or []:
        r = dict(r)
        k = (r["sube_id"], r["personel_id"], r["gun"])
        if r["yayinda"]:
            once.setdefault(k, []).append((r["bas"], r["bit"]))
        if r["simdi"]:
            simdi.setdefault(k, []).append((r["bas"], r["bit"]))
    out: Dict[str, int] = {}
    for k in set(once) | set(simdi):
        if sorted(once.get(k, [])) != sorted(simdi.get(k, [])):
            out[k[0]] = out.get(k[0], 0) + 1
    return out


def _islemler(cur, pzt: date, adli: bool = True) -> List[dict]:
    """Haftanın işlemleri, en yeni üstte: [{anahtar, kim, zaman, tur, etiket, satirlar:[…], geri_al}]. adli=False → ad sorgusu yok
    (Geri al düğmesi için yalnız son işlem gerekir)."""
    paz = pzt + timedelta(days=6)
    cur.execute("""SELECT *, zaman::text AS z_txt, iptal_zaman::text AS iz_txt FROM ey_vardiya_plan
                    WHERE tur = 'calisma' AND gun BETWEEN %s AND %s""", (pzt, paz))
    rows = [dict(r) for r in cur.fetchall() or []]
    if not rows:
        return []
    by_id = {r["id"]: r for r in rows}
    gr: Dict[tuple, dict] = {}
    for r in rows:
        gr.setdefault((r["degistiren"] or "—", r["z_txt"]), {"ekle": [], "kaldir": []})["ekle"].append(r)
        if r["iptal"] and r.get("iz_txt"):
            gr.setdefault((r["iptal_kim"] or "—", r["iz_txt"]), {"ekle": [], "kaldir": []})["kaldir"].append(r)
    from evvel_yeni_tanim_api import adlar
    pad = adlar(cur, "ey_personel", list({r["personel_id"] for r in rows})) if adli else {}
    sad = adlar(cur, "ey_sube", list({r["sube_id"] for r in rows})) if adli else {}
    out = []
    for (kim, z), g in gr.items():
        kalkan = {r["id"] for r in g["kaldir"]}
        satirlar, geri = [], False
        degisen_eski = set()
        for r in g["ekle"]:
            o = by_id.get(r.get("onceki_id"))
            if o and o["id"] in kalkan:
                degisen_eski.add(o["id"])
                satirlar.append({"tur": "saat", "o": o, "r": r})
            elif r.get("onceki_id"):
                geri = True   # onceki_id hedefi BAŞKA işlemde kaldırılmış → geri getirildi (Fable IS 4k tanıma kuralı)
                satirlar.append({"tur": "geri", "r": r})
            else:
                satirlar.append({"tur": "ekle", "r": r})
        for r in g["kaldir"]:
            if r["id"] in degisen_eski:
                continue
            if (r.get("iptal_neden") or "") == "geri alındı":
                geri = True
            satirlar.append({"tur": "kaldir", "r": r})

        def yaz(s):
            r = s["r"]
            ss = f"{_hm(r['bas'])}–{_hm(r['bit'])}"
            n = (f"saat {_hm(s['o']['bas'])}–{_hm(s['o']['bit'])} → {ss}" if s["tur"] == "saat"
                 else f"eklemesi geri alındı ({ss})" if s["tur"] == "kaldir" and r.get("iptal_neden") == "geri alındı"
                 else {"ekle": f"eklendi ({ss})", "kaldir": f"kaldırıldı ({ss})", "geri": f"geri getirildi ({ss})"}[s["tur"]])
            if s["tur"] == "kaldir" and r.get("iptal_neden") not in (None, "", "plandan kaldırıldı", "geri alındı") \
                    and not str(r.get("iptal_neden")).startswith("saat değişti"):
                n += f" · {r['iptal_neden']}"
            return {"personel_id": r["personel_id"], "ad": pad.get(str(r["personel_id"])) or "—", "gun": r["gun"].isoformat(),
                    "sube": sad.get(str(r["sube_id"])) or "—", "metin": n, "id": r["id"], "canli": not r["iptal"]}
        kay = {s["r"].get("kaynak") for s in satirlar if s["tur"] == "ekle"}
        nd = {s["r"].get("iptal_neden") for s in satirlar if s["tur"] == "kaldir"}
        if geri:
            et = "Geri alındı"
        elif "eski_kopya" in kay:
            et = "Eski plandan alındı"
        elif "kopya" in kay:
            et = "Geçen hafta kopyalandı"
        elif "taslak temizlendi" in nd:
            et = "Taslak temizlendi"
        elif len(satirlar) == 1:
            s = satirlar[0]
            et = {"ekle": "Eklendi", "kaldir": "Kaldırıldı", "saat": "Saat değişti", "geri": "Geri alındı"}[s["tur"]]
        else:
            et = f"{len(satirlar)} değişiklik"
        if not satirlar:
            continue
        out.append({"anahtar": f"{kim}|{z}", "kim": kim, "zaman": z[:16], "etiket": et, "geri": geri, "adet": len(satirlar),
                    "satirlar": [yaz(s) for s in sorted(satirlar, key=lambda s: (s["r"]["gun"], str(s["r"]["personel_id"])))],
                    "_g": g})
    # sıra = zaman METNİ (aynı oturum saat dilimi, +03 sabit; dilim değişirse metin kıyası bozulur — o gün timestamptz'e çevir)
    out.sort(key=lambda x: x["anahtar"].split("|", 1)[1], reverse=True)
    return out


def _son_islem(cur, pzt: date) -> Optional[dict]:
    """Ekrandaki 'Geri al' düğmesi: haftanın EN SON işlemi (geri almanın kendisi değilse)."""
    ls = _islemler(cur, pzt, adli=False)
    if not ls or ls[0]["geri"]:
        return None
    x = ls[0]
    ozet = None
    if x["adet"] == 1:   # Fable (5 göz · telaş): NEYİN geri alınacağı düğmede yazsın — tek satırlık işlemde kişi + gün
        from evvel_yeni_tanim_api import adlar
        s = x["satirlar"][0]
        ozet = {"ad": adlar(cur, 'ey_personel', [s['personel_id']]).get(str(s['personel_id'])) or '—', "gun": s["gun"]}   # gün adı ekranda (gunKisa TEK kaynak)
    return {"anahtar": x["anahtar"], "kim": x["kim"], "zaman": x["zaman"], "etiket": x["etiket"], "adet": x["adet"], "ozet": ozet}


@router.get("/gecmis")
def gecmis(pazartesi: str):
    """Haftanın değişiklik listesi (taslak dahil — kopya hatası da geri alınabilsin), en yeni üstte."""
    with db() as (conn, cur):
        vardiya_hazirla(cur)
        pzt = _pazartesi(_tarih(pazartesi))
        return {"pazartesi": pzt.isoformat(), "islemler": [{k: v for k, v in x.items() if k != "_g"} for x in _islemler(cur, pzt)]}


class GeriBody(BaseModel):
    pazartesi: str
    anahtar: str   # sunucunun verdiği ham metin (kim|zaman) — istemci ayrıştırmaz (Fable: JS Date mikrosaniyeyi yutar)


@router.post("/geri-al")
def geri_al(b: GeriBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """YALNIZ haftanın son işlemi geri alınır; araya başka işlem girdiyse 409. Eklenen satır iptal ('geri alındı'), kaldırılan satır
    aynı saat / şube / kalıp ve ORİJİNAL kaynağıyla geri yazılır (onceki_id = kaldırılan). Hepsi ya da hiçbiri: bir kişi-gün
    kilitli / çakışıyorsa tüm işlem 409 (Opus — yarım geri alma iz karmaşası)."""
    with db() as (conn, cur):
        vardiya_hazirla(cur)
        kim = merkez_aktor(cur, x_evvel_oturum)
        pzt = _pazartesi(_tarih(b.pazartesi))
        _hafta_kilidi(cur, pzt)
        ls = _islemler(cur, pzt)
        if not ls or ls[0]["anahtar"] != b.anahtar:
            raise HTTPException(409, "Bu arada başka bir değişiklik yapıldı — sayfayı yenile, yalnız son işlem geri alınır")
        if ls[0]["geri"]:
            raise HTTPException(409, "Son işlem zaten bir geri alma — tekrar geri alınmaz")
        g = ls[0]["_g"]
        ek_kisi = []
        if any(r.get("kaynak") == "eski_kopya" for r in g["ekle"]):
            cur.execute("""SELECT DISTINCT p.personel_id FROM ey_vardiya_plan p JOIN ey_vardiya_yayin y
                             ON y.sube_id = p.sube_id AND y.pazartesi = %s AND y.yayinlayan LIKE '%%(eski plan)' AND y.zaman::text = %s
                            WHERE NOT p.iptal AND p.tur='calisma' AND p.gun BETWEEN %s AND %s""",
                        (pzt, b.anahtar.split("|", 1)[1], pzt, pzt + timedelta(days=6)))
            ek_kisi = [dict(r)["personel_id"] for r in cur.fetchall() or []]
        _kisi_kilitleri(cur, [r["personel_id"] for r in g["ekle"] + g["kaldir"]] + ek_kisi)
        yayin = _yayin_haritasi(cur, pzt, pzt)
        bugun = is_gunu()
        cur.execute(f"SELECT {_an_sql()} AS an")
        an = dict(cur.fetchone())["an"]   # geri yazılacak satırın damgası — geçerlilik onunla ölçülür (_gecerli ile aynı ölçüt)
        for r in g["kaldir"]:
            # Codex 2. tur: yayınlanmadan günü geçmiş ESKİ taslak (personel görmedi, maaşa girmedi) yeni zamanla geri yazılırsa geçerli olur
            if not _gecerli(r, yayin, bugun) and _gecerli({**r, "zaman": an}, yayin, bugun):
                from evvel_yeni_tanim_api import adlar
                ad = adlar(cur, "ey_personel", [r["personel_id"]]).get(str(r["personel_id"])) or "—"
                raise HTTPException(409, f"{ad} · {r['gun'].strftime('%d.%m')} satırı yayınlanmamış eski taslaktı (personel görmedi, maaşa "
                                         "girmedi) — geri alınırsa maaşa girer; gerekiyorsa elle yaz")
        for r in g["ekle"]:
            if not r["iptal"]:
                _iptal(cur, r["id"], kim, "geri alındı")
        for r in g["kaldir"]:
            _yaz(cur, pid=r["personel_id"], gun=r["gun"], tur="calisma", kim=kim, sube_id=r["sube_id"], bas=r["bas"], bit=r["bit"],
                 kalip_id=r.get("kalip_id"), kaynak=r["kaynak"], onceki_id=r["id"], damga=False)
        if any(r.get("kaynak") == "eski_kopya" for r in g["ekle"]):
            # Fable P2: "Eski plandan al" haftayı yayında sayar (ON CONFLICT DO NOTHING → yalnız YENİ yayın kaydı, zamanı aynı NOW()).
            # Geri alınınca o işlemin açtığı yayın kaydı da kalkar — yoksa boş hafta "yayında" görünür. Önceden var olan yayına dokunulmaz.
            cur.execute("""DELETE FROM ey_vardiya_yayin WHERE pazartesi=%s AND yayinlayan LIKE '%%(eski plan)' AND zaman::text=%s
                           RETURNING sube_id""", (pzt, b.anahtar.split("|", 1)[1]))
            _yayin_kilidi(cur, [dict(r)["sube_id"] for r in cur.fetchall() or []], pzt)   # yayın kalkınca kalan taslak geçersizleşir
        return {"ok": True, "mesaj": f"Geri alındı — {ls[0]['etiket'].lower()} ({ls[0]['adet']} satır)"}


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
        # B43: depo + satış şubesi (Tema) personeli varsa planlanır — yalnız depo olan (personelsiz) yer çıkmaz
        cur.execute("SELECT DISTINCT sube_id FROM ey_personel WHERE aktif AND sube_id IS NOT NULL")
        _kadrolu = {str(dict(r)["sube_id"]) for r in cur.fetchall() or []}
        sb = [s for s in subeler(cur) if not s.get("depo") or _kalip_var(cur, s["id"]) or str(s["id"]) in _kadrolu]
        cur.execute("SELECT * FROM ey_vardiya_kalip WHERE aktif ORDER BY sube_id, sira, bas")
        kaliplar = [dict(r) for r in cur.fetchall() or []]
        rows = _satirlar(cur, pzt - timedelta(days=6), paz)   # 7 gün kuralı için önceki 6 gün de
        yayin = _yayin_haritasi(cur, pzt, pzt)
        hafta_rows = [r for r in rows if r["gun"] >= pzt]
        planli = {r["personel_id"] for r in hafta_rows}
        # Fable D-V0: o hafta satırı olan pasif kişi de listede (yoksa rozet '—', kaldırılamaz)
        kisiler = [p for p in tanim_listesi(cur, "ey_personel", ("ad", "sube_id", "gorev", "giris", "cikis", "calisma_turu", "aktif"))
                   if p["id"] in planli or ((p.get("aktif") or (p.get("cikis") and p["cikis"] >= pzt)) and not (p.get("giris") and p["giris"] > paz))]
        ayr = _ayrilis(cur)
        _kalip_esle([r for r in rows if not _ayrildi(r, ayr)], kaliplar)   # S-B8: ayrılanın satırı ihtiyacı doldurmaz
        uyarilar = _uyarilar(cur, pzt, sb, kaliplar, [r for r in rows if not _ayrildi(r, ayr)], kisiler, bugun)   # Fable: ayrılanın satırı başka uyarı üretmez
        fazla: Dict[str, list] = {}
        for r in hafta_rows:
            if _ayrildi(r, ayr):
                fazla.setdefault(r["personel_id"], []).append(r["gun"].strftime("%d.%m"))
        pad_ = {p["id"]: p["ad"] for p in kisiler}
        for pid, gl in fazla.items():   # kişi başına TEK satır
            uyarilar.insert(0, {"tur": "ayrildi", "personel_id": pid,
                                "metin": f"{pad_.get(pid, '—')} {ayr[pid].strftime('%d.%m')} tarihinde ayrıldı — sonrasında {len(gl)} vardiyası var "
                                         f"({', '.join(gl)}): sayılmıyor, kaldır"})
        degisen = _yayin_farki(cur, pzt, paz)
        return {
            "pazartesi": pzt.isoformat(), "bugun": bugun.isoformat(), "gunler": [(pzt + timedelta(days=i)).isoformat() for i in range(7)],
            "subeler": [{"id": s["id"], "ad": s["ad"],
                         "yayin": ({"kim": yayin[(s["id"], pzt)]["yayinlayan"], "zaman": str(yayin[(s["id"], pzt)]["zaman"])[:16]}
                                   if (s["id"], pzt) in yayin else None),
                         "degisen": degisen.get(s["id"], 0),
                         "satir": sum(1 for r in hafta_rows if r.get("sube_id") == s["id"])} for s in sb],
            "kaliplar": [{"id": k["id"], "sube_id": k["sube_id"], "ad": k["ad"], "bas": _hm(k["bas"]), "bit": _hm(k["bit"]),
                          "kisi": k["kisi"], "gunler": list(k["gunler"] or []), "sira": k["sira"]} for k in kaliplar],
            "plan": [{**_disa(r), "kalip_es": r.get("kalip_es"), "ayrildi": _ayrildi(r, ayr)} for r in hafta_rows] + [_disa(r) for r in _izin_satirlari(cur, pzt, paz)],
            "izin_acik": __import__("evvel_yeni_moduller").acik("maas"),
            "personel": [{"id": p["id"], "ad": p["ad"], "sube_id": p.get("sube_id"), "calisma_turu": p.get("calisma_turu") or "tam",
                          "mudur": mudur_mu(p.get("gorev")), "aktif": bool(p.get("aktif")),
                          "giris": p["giris"].isoformat() if p.get("giris") else None,
                          "cikis": p["cikis"].isoformat() if p.get("cikis") else None} for p in kisiler],
            "uyarilar": uyarilar,
            "eski_kopya": pzt <= ESKI_KOPYA_SON and tablo_var(cur, "vardiya_atama"),
            "son_islem": _son_islem(cur, pzt),
        }


def _kalip_var(cur, sid: str) -> bool:
    cur.execute("SELECT 1 FROM ey_vardiya_kalip WHERE sube_id=%s AND aktif LIMIT 1", (str(sid),))
    return bool(cur.fetchone())


def _kalip_esle(rows: list, kaliplar: list) -> None:
    """Satırın EKRANDAKİ kalıbı (kalip_es): kendi kalıbı o şubede aktifse o; değilse aynı şube + aynı saatli aktif kalıp (Fable D-V0:
    'Diğer saatler'den ya da eski Serbest slottan gelen 09:00–18:30 satırı Sabah'ı doldurmuyor, sahte 'eksik' uyarısı üretiyordu)."""
    aktif = {k["id"]: k for k in kaliplar}
    for r in rows:
        k = aktif.get(r.get("kalip_id"))
        if r["tur"] != "calisma":
            r["kalip_es"] = None
        elif k and k["sube_id"] == r["sube_id"]:
            r["kalip_es"] = k["id"]
        else:
            r["kalip_es"] = next((x["id"] for x in kaliplar if x["sube_id"] == r["sube_id"] and x["bas"] == r["bas"] and x["bit"] == r["bit"]), None)


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
        eksik = []
        for i in range(7):
            g = pzt + timedelta(days=i)
            if g < bugun or (g.isoweekday() not in (k["gunler"] or [])):
                continue
            if sum(1 for r in hafta_rows if r["gun"] == g and r.get("kalip_es") == k["id"]) < k["kisi"]:
                eksik.append(g.strftime("%d.%m"))
        if eksik:   # kalıp başına TEK satır (ızgaradaki sarı hücre gün gün gösteriyor) — liste sahte alarmla dolmasın
            out.append({"tur": "kalip_eksik", "sube_id": k["sube_id"],
                        "metin": f"{sad[k['sube_id']]} · {k['ad']} ({k['kisi']} kişi) — {len(eksik)} gün eksik: {', '.join(eksik)}"})
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
    # B94 (Fable 22 Eki): yarı zamanlı kişi günlük standardın üstünde planlı — UYARI, engel değil (maaş saat üstünden ödenir)
    from evvel_yeni_cekirdek import PART_GUNLUK_SAAT
    yari = {p["id"] for p in kisiler if (p.get("calisma_turu") or "tam") == "yari"}
    uzun: Dict[str, list] = {}
    for r in hafta_rows:
        if r["personel_id"] in yari and r.get("bas") and r.get("bit") and sure_saat(r["bas"], r["bit"]) > PART_GUNLUK_SAAT:
            ss = f"{sure_saat(r['bas'], r['bit']):g}".replace(".", ",")
            uzun.setdefault(r["personel_id"], []).append(f"{r['gun'].strftime('%d.%m')} {_hm(r['bas'])}–{_hm(r['bit'])} ({ss} sa)")
    for pid, gl in uzun.items():   # kişi başına haftada TEK satır
        out.append({"tur": "yari_uzun", "personel_id": pid,
                    "metin": f"{pad.get(pid, '—')} yarı zamanlı — günlük {str(PART_GUNLUK_SAAT).replace('.', ',')} sa üstü: "
                             f"{', '.join(gl)} (maaş planlanan saat üstünden ödenir)"})
    for r in rows:
        if r["gun"] >= pzt and r["kaynak"] == "sonradan" and r["tur"] == "calisma":
            out.append({"tur": "sonradan", "personel_id": r["personel_id"],
                        "metin": f"{pad.get(r['personel_id'], '—')} · {r['gun'].strftime('%d.%m')} sonradan yazıldı ({r.get('degistiren') or '—'})"})
    return out


class PlanBody(BaseModel):
    personel_id: str
    gun: str
    sube_id: Optional[str] = None
    bas: Optional[str] = None
    bit: Optional[str] = None
    kalip_id: Optional[str] = None


@router.post("/plan")
def plan_ekle(b: PlanBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    with db() as (conn, cur):
        vardiya_hazirla(cur)
        kim = merkez_aktor(cur, x_evvel_oturum)
        gun = _tarih(b.gun)
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


class IzinBody(BaseModel):
    personel_id: str
    bas: str
    bit: Optional[str] = None   # boş → tek gün


@router.post("/izin")
def izin_ekle(b: IzinBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """İzinli (tarih aralığı, tek hamlede) → Maaş'ın izin defterine (TEK gerçek). O günlerde vardiyası olan kişiye yazılmaz (önce kaldır)."""
    from evvel_yeni_moduller import acik
    if not acik("maas"):
        raise HTTPException(409, "İzin Personel (Maaş) modülünde tutulur — modül kapalı")
    from evvel_yeni_maas_api import izin_yaz
    with db() as (conn, cur):
        vardiya_hazirla(cur)
        kim = merkez_aktor(cur, x_evvel_oturum)
        bas = _tarih(b.bas, "Başlangıç")
        bit = _tarih(b.bit, "Bitiş") if b.bit else bas
        if (bit - bas).days > 62:
            raise HTTPException(400, "İzin en çok 2 ay — daha uzunsa Tanımlar'dan ayrılış/pasif")
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("ey_vardiya:" + str(b.personel_id),))
        p = _kisi(cur, b.personel_id)
        _calisir_mi(p, bas)
        _calisir_mi(p, bit)
        dolu = sorted({r["gun"] for r in _satirlar(cur, bas, bit, personel_id=b.personel_id)})
        if dolu:
            raise HTTPException(409, f"{p['ad']} şu günlerde planlı: {', '.join(g.strftime('%d.%m') for g in dolu)} — önce o vardiyaları kaldır")
        izin_yaz(cur, personel_id=b.personel_id, bas=bas, bit=bit, kim=kim)
        n = (bit - bas).days + 1
        return {"ok": True, "mesaj": f"{p['ad']} {n} gün izinli ({bas.strftime('%d.%m')}–{bit.strftime('%d.%m')})"}


@router.post("/izin/{kid}/kaldir")
def izin_sil(kid: str, x_evvel_oturum: Optional[str] = Header(default=None)):
    from evvel_yeni_moduller import acik
    if not acik("maas"):
        raise HTTPException(409, "İzin Personel (Maaş) modülünde tutulur — modül kapalı")
    from evvel_yeni_maas_api import izin_kaldir
    with db() as (conn, cur):
        kim = merkez_aktor(cur, x_evvel_oturum)
        izin_kaldir(cur, kid.removeprefix("izin:"), kim)
        return {"ok": True, "mesaj": "İzin kaldırıldı"}


class TemizleBody(BaseModel):
    pazartesi: str
    sube_id: str


@router.post("/taslak-temizle")
def taslak_temizle(b: TemizleBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Yanlış kopyalanan haftayı geri al: YAYINLANMAMIŞ haftanın bugünden sonraki satırları iptal (silinmez, iz). Yayınlanmış hafta
    temizlenmez (personel görmüş) — tek tek kaldırılır."""
    with db() as (conn, cur):
        vardiya_hazirla(cur)
        kim = merkez_aktor(cur, x_evvel_oturum)
        pzt = _pazartesi(_tarih(b.pazartesi))
        _hafta_kilidi(cur, pzt)   # Fable 2. tur: yayın denetimi + satır listesi kilit ALTINDA (araya yayın / iptal giremez)
        if hafta_yayinda(cur, b.sube_id, pzt):
            raise HTTPException(409, "Bu hafta yayınlanmış — personel gördü; satırları tek tek kaldır")
        cur.execute("""SELECT id, personel_id, gun FROM ey_vardiya_plan WHERE NOT iptal AND tur='calisma' AND sube_id=%s
                          AND gun BETWEEN %s AND %s AND gun > %s ORDER BY gun""", (str(b.sube_id), pzt, pzt + timedelta(days=6), is_gunu()))
        rows = [dict(r) for r in cur.fetchall() or []]
        _kisi_kilitleri(cur, [r["personel_id"] for r in rows])
        n, kilit = 0, 0
        for r in rows:   # TEK yol _iptal; maaşı onaylı (ör. ayrılan kişinin ayı biten ay sayılır) satır ÖNDEN ayıklanır
            if _maas_kilitli_mi(cur, r["personel_id"], r["gun"]):
                kilit += 1
                continue
            _iptal(cur, r["id"], kim, "taslak temizlendi")
            n += 1
        ek = f"{kilit} satır temizlenmedi: maaşı onaylı" if kilit else ""
        if not n:
            return {"ok": True, "mesaj": ek or "Temizlenecek ileri gün taslağı yok"}
        return {"ok": True, "mesaj": f"{n} taslak satır temizlendi" + (f" · {ek}" if ek else "")}


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
        # not (Fable 3. tur): kaynak hafta kilitsiz okunur — iz bozulmaz, en kötü eşzamanlı değişiklik kopyaya girmez / girer
        kaynak = [r for r in _satirlar(cur, pzt - timedelta(days=7), pzt - timedelta(days=1), b.sube_id) if r["tur"] == "calisma"]
        _hafta_kilidi(cur, pzt)
        _kisi_kilitleri(cur, [r["personel_id"] for r in kaynak])
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
        _hafta_kilidi(cur, pzt)   # Codex P2: yayın anı ile plan yazması aynı sırada (rozet küme farkı tutarlı)
        # Codex P1: İLK yayın, önceden yazılıp yayınlanmamış satırları geçerli yapar (_gecerli) → maaşı onaylı kişi-ayda yayınlanmaz
        yayinli = _yayin_haritasi(cur, pzt, pzt)
        _yayin_kilidi(cur, [s for s in sids if (s, pzt) not in yayinli], pzt)
        for s in sids:
            cur.execute(f"""INSERT INTO ey_vardiya_yayin (sube_id, pazartesi, yayinlayan, zaman) VALUES (%s,%s,%s,{_an_sql()})
                           ON CONFLICT (sube_id, pazartesi) DO UPDATE SET yayinlayan=EXCLUDED.yayinlayan, zaman=EXCLUDED.zaman""", (s, pzt, kim))
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
        _hafta_kilidi(cur, pzt)
        _kisi_kilitleri(cur, [r["pid"] for r in eski] + [r["personel_id"] for r in _satirlar(cur, pzt, pzt + timedelta(days=6))])
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
        _yayinli = _yayin_haritasi(cur, pzt, pzt)
        _yayin_kilidi(cur, [s for s in subeler_ if (s, pzt) not in _yayinli], pzt)   # Codex P1: yeni yayın başkalarının taslağını da geçerli yapar
        for s in subeler_:
            cur.execute(f"""INSERT INTO ey_vardiya_yayin (sube_id, pazartesi, yayinlayan, zaman) VALUES (%s,%s,%s,{_an_sql()})
                           ON CONFLICT (sube_id, pazartesi) DO NOTHING""", (s, pzt, f"{kim} (eski plan)"))
        if not eski:
            raise HTTPException(409, "Eski ekranda bu hafta için plan yok")
        if not n:
            return {"ok": True, "mesaj": f"Yeni satır yok — {atla} satırın hepsi zaten var / çakışıyor / kişi Evvel Yeni'de yok"}
        return {"ok": True, "mesaj": f"Eski plandan {n} satır alındı" + (f", {atla} atlandı (zaten var / çakışıyor / kişi yok)" if atla else "")
                + f" — {len(subeler_)} şubenin haftası yayında sayıldı"}


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
    cur.execute("""SELECT DISTINCT sube_id, gun FROM ey_vardiya_plan
                    WHERE NOT iptal AND tur='calisma' AND gun BETWEEN %s AND %s""", (haftalar[0], haftalar[-1] + timedelta(days=6)))
    taslak = {(dict(r)["sube_id"], _pazartesi(dict(r)["gun"])) for r in cur.fetchall() or []}
    out = []
    for s in subeler(cur):
        if s["id"] not in kalipli:
            continue
        for h in haftalar:
            if h < ILK_HAFTA or (s["id"], h) in yayin:
                continue
            out.append({"tur": "vardiya_plan_yok", "genel": True, "grup": "personel", "id": f"vardiya:{s['id']}:{h.isoformat()}",
                        "tarih": bugun.isoformat(), "etiket": "🗓 Vardiya planı yayınlanmadı", "ad": s["ad"],
                        "alt": f"{h.strftime('%d.%m')}–{(h + timedelta(days=6)).strftime('%d.%m')} haftası — "
                               + ("taslak hazır, yayınla" if (s["id"], h) in taslak else "planla ve yayınla"),
                        "sayfa": "vardiya_plani", "dugme": "Vardiya planı"})
    return out


bekleyen_is_kaydet("vardiya", _bekleyen)
