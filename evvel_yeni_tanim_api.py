"""⚙️ EVVEL YENİ · TANIMLAR (2026-10-16) — şube · personel · banka · kart · toptancı.

Sahip: "Eski sistem tamamen kaldırılacak; ekleme/düzeltme buraya yazılsın." · "Şube sayısı artarsa şube
ekle, personel artarsa personel ekle (maaş/yemek bilgisiyle), banka, kart, toptancı ekle."

Kural:
  · Evvel Yeni KENDİ tablolarını tutar (ey_sube, ey_personel, ey_kart, ey_toptanci; bankalar = Kasa cepleri).
  · Eski tablolardan KİMLİĞİ AYNEN koruyarak kopyalanır; ON CONFLICT DO NOTHING → burada yapılan
    düzeltmenin üstüne ASLA yazılmaz. Eski tablo silinince kopyalama sessizce durur, hiçbir şey bozulmaz.
  · Hiçbir şey SİLİNMEZ — "pasif" yapılır (geçmiş kayıtlar adı kaybetmesin).
Bu dosya eski sisteme YAZMAZ.
"""

import logging
import re
import uuid
from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from database import db, savepoint

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/evvel-yeni/tanim", tags=["evvel-yeni-tanim"])

_HAZIR = False


def tanim_hazirla(cur) -> None:
    """Tabloları kurar + eski sistemden EKSİK olanları kopyalar (var olana dokunmaz). Kasa'nın _hazirla'sı da çağırır."""
    global _HAZIR
    if _HAZIR:
        return
    cur.execute("SET LOCAL lock_timeout = '3s'")
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_sube (
        id TEXT PRIMARY KEY, ad TEXT NOT NULL, pos_oran NUMERIC(6,3) NOT NULL DEFAULT 0, online_oran NUMERIC(6,3) NOT NULL DEFAULT 0,
        aktif BOOLEAN NOT NULL DEFAULT TRUE, kaynak TEXT NOT NULL DEFAULT 'evvel_yeni', degistiren TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_personel (
        id TEXT PRIMARY KEY, ad TEXT NOT NULL, sube_id TEXT, gorev TEXT, giris DATE,
        aktif BOOLEAN NOT NULL DEFAULT TRUE, kaynak TEXT NOT NULL DEFAULT 'evvel_yeni', degistiren TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_kart (
        id TEXT PRIMARY KEY, ad TEXT NOT NULL, banka TEXT, kimin TEXT, acilis_borc BIGINT NOT NULL DEFAULT 0,
        aktif BOOLEAN NOT NULL DEFAULT TRUE, kaynak TEXT NOT NULL DEFAULT 'evvel_yeni', degistiren TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_toptanci (
        id TEXT PRIMARY KEY, ad TEXT NOT NULL, kategori TEXT, telefon TEXT, acilis_bakiye BIGINT NOT NULL DEFAULT 0,
        aktif BOOLEAN NOT NULL DEFAULT TRUE, kaynak TEXT NOT NULL DEFAULT 'evvel_yeni', degistiren TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_personel_ucret (
        personel_id TEXT NOT NULL, gecerli_ay TEXT NOT NULL, maas BIGINT NOT NULL DEFAULT 0, yemek BIGINT NOT NULL DEFAULT 0,
        degistiren TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (personel_id, gecerli_ay))""")
    # Maaş için personel kartı (2026-10-16, Codex): çıkış, çalışma türü, kişi kimliği; ücrette saatlik + yol
    cur.execute("ALTER TABLE ey_personel ADD COLUMN IF NOT EXISTS cikis DATE")
    cur.execute("ALTER TABLE ey_personel ADD COLUMN IF NOT EXISTS calisma_turu TEXT NOT NULL DEFAULT 'tam'")
    cur.execute("ALTER TABLE ey_personel ADD COLUMN IF NOT EXISTS kisi_id TEXT")
    cur.execute("ALTER TABLE ey_personel_ucret ADD COLUMN IF NOT EXISTS saatlik BIGINT NOT NULL DEFAULT 0")
    cur.execute("ALTER TABLE ey_personel_ucret ADD COLUMN IF NOT EXISTS yol BIGINT NOT NULL DEFAULT 0")
    # ── Eski sistemden kopya (yalnız EKSİK kimlikler) ──
    kopyalar = [
        ("sp_ey_k_sube", """INSERT INTO ey_sube (id, ad, pos_oran, online_oran, aktif, kaynak, degistiren)
             SELECT id::text, ad, COALESCE(pos_oran,0), COALESCE(online_oran,0), COALESCE(aktif,TRUE), 'eski_sistem', 'eski sistem kopyası'
               FROM subeler ON CONFLICT (id) DO NOTHING"""),
        ("sp_ey_k_per", """INSERT INTO ey_personel (id, ad, sube_id, gorev, aktif, kaynak, degistiren)
             SELECT id::text, ad_soyad, sube_id::text, gorev, COALESCE(aktif,TRUE), 'eski_sistem', 'eski sistem kopyası'
               FROM personel ON CONFLICT (id) DO NOTHING"""),
        ("sp_ey_k_ucret", """INSERT INTO ey_personel_ucret (personel_id, gecerli_ay, maas, yemek, degistiren)
             SELECT p.id::text, '2000-01', ROUND(COALESCE(p.maas,0)*100)::bigint, ROUND(COALESCE(p.yemek_ucreti,0)*100)::bigint, 'eski sistem kopyası'
               FROM personel p WHERE NOT EXISTS (SELECT 1 FROM ey_personel_ucret u WHERE u.personel_id = p.id::text)
             ON CONFLICT DO NOTHING"""),
        ("sp_ey_k_kart", """INSERT INTO ey_kart (id, ad, banka, aktif, kaynak, degistiren)
             SELECT id::text, kart_adi, banka, COALESCE(aktif,TRUE), 'eski_sistem', 'eski sistem kopyası'
               FROM kartlar ON CONFLICT (id) DO NOTHING"""),
        ("sp_ey_k_top", """INSERT INTO ey_toptanci (id, ad, kategori, telefon, aktif, kaynak, degistiren)
             SELECT id::text, ad, kategori, telefon, COALESCE(aktif,TRUE), 'eski_sistem', 'eski sistem kopyası'
               FROM tedarikciler ON CONFLICT (id) DO NOTHING"""),
    ]
    kopyalar += [
        # Yalnız BOŞ alanları doldur — burada düzeltilen ezilmez
        ("sp_ey_k_per2", """UPDATE ey_personel e SET giris = COALESCE(e.giris, p.baslangic_tarihi::date),
                                   cikis = COALESCE(e.cikis, p.cikis_tarihi::date),
                                   calisma_turu = CASE WHEN e.kaynak = 'eski_sistem' AND e.degistiren = 'eski sistem kopyası'
                                                       THEN (CASE WHEN COALESCE(p.calisma_turu,'surekli') = 'surekli' THEN 'tam' ELSE 'yari' END)
                                                       ELSE e.calisma_turu END
                              FROM personel p WHERE p.id::text = e.id"""),
        ("sp_ey_k_kisi", """UPDATE ey_personel e SET kisi_id = p.kisi_id::text FROM personel p
                              WHERE p.id::text = e.id AND e.kisi_id IS NULL AND p.kisi_id IS NOT NULL"""),
        ("sp_ey_k_ucret2", """UPDATE ey_personel_ucret u SET saatlik = ROUND(COALESCE(p.saatlik_ucret,0)*100)::bigint,
                                     yol = ROUND(COALESCE(p.yol_ucreti,0)*100)::bigint
                                FROM personel p WHERE p.id::text = u.personel_id AND u.degistiren = 'eski sistem kopyası'
                                 AND u.saatlik = 0 AND u.yol = 0"""),
    ]
    for sp, sql in kopyalar:
        try:
            with savepoint(cur, sp):
                cur.execute(sql)
        except Exception as e:  # noqa: BLE001 — eski tablo kalktıysa kopya biter, Evvel Yeni yaşar
            log.info("evvel-yeni tanım: eski kopya atlandı (%s): %s", sp, str(e)[:120])
    _HAZIR = True


# ── OKUMA YARDIMCILARI (öbür modüller bunları kullanır) ──
def subeler(cur, hepsi: bool = False):
    tanim_hazirla(cur)
    cur.execute(f"SELECT id, ad, pos_oran, online_oran, aktif FROM ey_sube {'' if hepsi else 'WHERE aktif'} ORDER BY ad")
    return [dict(r) for r in cur.fetchall() or []]


def secim_listeleri(cur) -> dict:
    """Ödeme formunun açılır listeleri — YALNIZ aktif olanlar."""
    tanim_hazirla(cur)
    out = {}
    for ad, sql in (
        ("toptancilar", "SELECT id, ad, kategori FROM ey_toptanci WHERE aktif ORDER BY ad"),
        ("personel", "SELECT id, ad, sube_id, gorev, aktif, cikis::text AS cikis FROM ey_personel ORDER BY aktif DESC, ad"),
        ("kartlar", "SELECT id, ad, banka, kimin FROM ey_kart WHERE aktif ORDER BY ad"),
    ):
        cur.execute(sql)
        out[ad] = [{k: (float(v) if isinstance(v, Decimal) else v) for k, v in dict(r).items()} for r in cur.fetchall() or []]
    return out


# ── EKRAN UÇLARI ──
TURLER = {
    "sube": "ey_sube", "personel": "ey_personel", "kart": "ey_kart", "toptanci": "ey_toptanci",
}


def _tl(k) -> float:
    return round(int(k or 0) / 100, 2)


def _kurus(x) -> int:
    try:
        return int((Decimal(str(x or 0)) * 100).quantize(Decimal("1")))
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "Tutar sayı olmalı")


def _slug(ad: str) -> str:
    tr = str.maketrans("çğıöşüÇĞİÖŞÜ", "cgiosuCGIOSU")
    return re.sub(r"[^a-z0-9]+", "-", ad.translate(tr).lower()).strip("-")[:30] or uuid.uuid4().hex[:8]


@router.get("/liste")
def liste():
    """Bütün tanımlar tek seferde (aktif + pasif)."""
    from evvel_yeni_kasa_api import _hazirla
    from evvel_yeni_cekirdek import bugun as _bugun
    _hazirla()
    ay = _bugun().strftime("%Y-%m")
    with db() as (conn, cur):
        tanim_hazirla(cur)
        sube = subeler(cur, hepsi=True)
        sube_ad = {s["id"]: s["ad"] for s in sube}
        cur.execute("""SELECT p.*, u.maas, u.yemek, u.saatlik, u.yol, u.gecerli_ay, u.degistiren AS ucret_kim
                         FROM ey_personel p LEFT JOIN LATERAL (
                           SELECT maas, yemek, saatlik, yol, gecerli_ay, degistiren FROM ey_personel_ucret
                            WHERE personel_id = p.id AND gecerli_ay <= %s ORDER BY gecerli_ay DESC LIMIT 1) u ON TRUE
                        ORDER BY p.aktif DESC, p.ad""", (ay,))
        personel = []
        for r in cur.fetchall() or []:
            r = dict(r)
            personel.append({"id": r["id"], "ad": r["ad"], "sube_id": r["sube_id"], "sube_ad": sube_ad.get(r["sube_id"]) or "Ortak",
                             "gorev": r["gorev"], "giris": r["giris"].isoformat() if r["giris"] else None, "aktif": r["aktif"],
                             "maas": _tl(r["maas"]), "yemek": _tl(r["yemek"]), "saatlik": _tl(r["saatlik"]), "yol": _tl(r["yol"]),
                             "cikis": r["cikis"].isoformat() if r.get("cikis") else None, "calisma_turu": r.get("calisma_turu") or "tam",
                             "ucret_eski": (r["ucret_kim"] == "eski sistem kopyası"), "kaynak": r["kaynak"]})
        try:
            from evvel_yeni_kira_api import kira_tanimlari
            with savepoint(cur, "sp_ey_t_kira"):
                kira_t = kira_tanimlari(cur)
        except Exception:  # noqa: BLE001
            kira_t = {}
        cur.execute("SELECT * FROM ey_kart ORDER BY aktif DESC, ad")
        kart = [{**{k: v for k, v in dict(r).items() if k not in ("zaman", "acilis_borc", "limit_tutar")}, "acilis_borc": _tl(dict(r)["acilis_borc"]),
                 "limit_tutar": _tl(dict(r)["limit_tutar"]) if dict(r).get("limit_tutar") is not None else None} for r in cur.fetchall() or []]
        cur.execute("SELECT * FROM ey_toptanci ORDER BY aktif DESC, ad")
        top = [{**{k: v for k, v in dict(r).items() if k not in ("zaman", "acilis_bakiye")}, "acilis_bakiye": _tl(dict(r)["acilis_bakiye"])} for r in cur.fetchall() or []]
        cur.execute("SELECT id, ad, kisa, tur, sube_id, aktif FROM para_izi_cep WHERE tur IN ('banka','hesap') ORDER BY aktif DESC, sira, ad")
        banka = [{**dict(r), "sube_ad": sube_ad.get(dict(r)["sube_id"])} for r in cur.fetchall() or []]
    return {
        "subeler": [{"id": s["id"], "ad": s["ad"], "pos_oran": float(s["pos_oran"]), "online_oran": float(s["online_oran"]), "aktif": s["aktif"],
                     "kira": (kira_t.get(s["id"]) or {}).get("kira"), "kira_artis_ayi": (kira_t.get(s["id"]) or {}).get("artis_ayi"),
                     "kira_odeme_gunu": (kira_t.get(s["id"]) or {}).get("odeme_gunu"), "kira_gecmis": (kira_t.get(s["id"]) or {}).get("gecmis", []),
                     "kira_yok": (kira_t.get(s["id"]) or {}).get("kira_yok", False)}
                    for s in sube],
        "personel": personel, "kartlar": kart, "toptancilar": top, "bankalar": banka, "ay": ay,
    }


class TanimBody(BaseModel):
    ad: Optional[str] = None
    aktif: Optional[bool] = None
    # şube
    pos_oran: Optional[Decimal] = None
    online_oran: Optional[Decimal] = None
    # personel
    sube_id: Optional[str] = None
    gorev: Optional[str] = None
    giris: Optional[str] = None
    maas: Optional[Decimal] = None
    yemek: Optional[Decimal] = None
    ucret_ay: Optional[str] = None       # maaş/yemek değişikliği hangi aydan itibaren
    cikis: Optional[str] = None          # işten ayrılış (YYYY-AA-GG) — son maaş için
    calisma_turu: Optional[str] = None   # 'tam' | 'yari'
    saatlik: Optional[Decimal] = None    # yarı zamanlı saatlik ücret
    yol: Optional[Decimal] = None        # aylık yol
    # kart / banka
    banka: Optional[str] = None
    kimin: Optional[str] = None
    acilis_borc: Optional[Decimal] = None
    limit_tutar: Optional[Decimal] = None
    vade_gun: Optional[int] = None           # toptancı: teslimden kaç gün sonra ödenir
    kira: Optional[Decimal] = None           # şube aylık kirası
    kira_ay: Optional[str] = None            # kira hangi aydan geçerli (YYYY-AA)
    kira_artis_ayi: Optional[int] = None     # her yıl hangi ay artar (1–12)
    kira_odeme_gunu: Optional[int] = None
    kira_yok: Optional[bool] = None          # mülk bizim — kira gideri yok
    kesim_gunu: Optional[int] = None
    son_odeme_gunu: Optional[int] = None
    limit_grup: Optional[str] = None
    tur: Optional[str] = None            # banka cebi: 'banka' | 'hesap'
    # toptancı
    kategori: Optional[str] = None
    telefon: Optional[str] = None
    acilis_bakiye: Optional[Decimal] = None


def _ad(b: TanimBody, zorunlu: bool) -> Optional[str]:
    ad = (b.ad or "").strip()
    if zorunlu and len(ad) < 2:
        raise HTTPException(400, "Ad yaz")
    return ad[:80] or None


@router.post("/{tur}")
def ekle(tur: str, body: TanimBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    return _yaz(tur, None, body, x_evvel_oturum)


@router.post("/{tur}/{tid}")
def duzelt(tur: str, tid: str, body: TanimBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    return _yaz(tur, tid, body, x_evvel_oturum)


def _yaz(tur: str, tid: Optional[str], b: TanimBody, jeton: Optional[str]):
    if tur not in ("sube", "personel", "kart", "toptanci", "banka"):
        raise HTTPException(404, "Bilinmeyen tanım")
    from evvel_yeni_kasa_api import sube_cepleri_yaz
    from evvel_yeni_cekirdek import aktor as _aktor, bugun as _bugun, kilit as _kilit
    yeni = tid is None
    with db() as (conn, cur):
        tanim_hazirla(cur)
        _kilit(cur)
        kim = _aktor(cur, jeton)
        ad = _ad(b, yeni)
        if tur == "banka":
            if yeni:
                if b.tur not in ("banka", "hesap"):
                    raise HTTPException(400, "Türü seç: şube/patron bankası ya da geçiş hesabı")
                tid = f"{b.tur}:{_slug(ad)}"
                cur.execute("SELECT 1 FROM para_izi_cep WHERE id=%s", (tid,))
                if cur.fetchone():
                    tid += "-" + uuid.uuid4().hex[:4]
                cur.execute("INSERT INTO para_izi_cep (id, ad, kisa, tur, sube_id, sira) VALUES (%s,%s,%s,%s,%s,90)",
                            (tid, ad, ad, b.tur, b.sube_id or None))
            else:
                cur.execute("SELECT id FROM para_izi_cep WHERE id=%s AND tur IN ('banka','hesap')", (tid,))
                if not cur.fetchone():
                    raise HTTPException(404, "Banka bulunamadı")
                cur.execute("UPDATE para_izi_cep SET ad=COALESCE(%s,ad), kisa=COALESCE(%s,kisa), aktif=COALESCE(%s,aktif) WHERE id=%s",
                            (ad, ad, b.aktif, tid))
            return {"ok": True, "id": tid, "mesaj": f"Banka {'eklendi' if yeni else 'güncellendi'}"}

        if tur == "sube":
            if yeni:
                tid = "sube-" + _slug(ad)
                cur.execute("SELECT 1 FROM ey_sube WHERE id=%s", (tid,))
                if cur.fetchone():
                    raise HTTPException(409, "Bu adla şube zaten var")
                cur.execute("""INSERT INTO ey_sube (id, ad, pos_oran, online_oran, degistiren) VALUES (%s,%s,%s,%s,%s)""",
                            (tid, ad, b.pos_oran or 0, b.online_oran or 0, kim))
            else:
                cur.execute("""UPDATE ey_sube SET ad=COALESCE(%s,ad), pos_oran=COALESCE(%s,pos_oran), online_oran=COALESCE(%s,online_oran),
                                 aktif=COALESCE(%s,aktif), degistiren=%s, zaman=NOW() WHERE id=%s""",
                            (ad, b.pos_oran, b.online_oran, b.aktif, kim, tid))
            sube_cepleri_yaz(cur)   # dükkân nakdi + şube bankası cepleri hemen açılır / adı güncellenir
            if any(x is not None for x in (b.kira, b.kira_artis_ayi, b.kira_odeme_gunu, b.kira_yok)):
                from evvel_yeni_kira_api import kira_yaz
                kira_yaz(cur, tid, kim, b.kira, b.kira_ay, b.kira_artis_ayi, b.kira_odeme_gunu, b.kira_yok)
            return {"ok": True, "id": tid, "mesaj": f"Şube {'eklendi — dükkân nakdi ve banka cebi açıldı' if yeni else 'güncellendi'}"}

        if tur == "personel":
            if b.sube_id and b.sube_id != "ortak":
                cur.execute("SELECT 1 FROM ey_sube WHERE id=%s", (b.sube_id,))
                if not cur.fetchone():
                    raise HTTPException(400, "Şube bulunamadı")
            if b.calisma_turu is not None and b.calisma_turu not in ("tam", "yari"):
                raise HTTPException(400, "Çalışma türü: tam | yari")
            cikis = None
            if b.cikis:
                try:
                    cikis = date.fromisoformat(b.cikis[:10])
                except ValueError:
                    raise HTTPException(400, "Ayrılış tarihi YYYY-AA-GG olmalı")
            giris = None
            if b.giris:
                try:
                    giris = date.fromisoformat(b.giris[:10])
                except ValueError:
                    raise HTTPException(400, "İşe giriş tarihi YYYY-AA-GG olmalı")
            if yeni:
                if b.maas is None:
                    raise HTTPException(400, "Maaşı yaz (0 olabilir)")
                tid = "ey-" + uuid.uuid4().hex[:12]
                cur.execute("""INSERT INTO ey_personel (id, ad, sube_id, gorev, giris, cikis, calisma_turu, degistiren)
                               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                            (tid, ad, None if b.sube_id in (None, "", "ortak") else b.sube_id, (b.gorev or "").strip()[:40] or None, giris,
                             cikis, b.calisma_turu or "tam", kim))
            else:
                cur.execute("""UPDATE ey_personel SET ad=COALESCE(%s,ad),
                                 sube_id=CASE WHEN %s THEN NULL ELSE COALESCE(%s,sube_id) END, gorev=COALESCE(%s,gorev),
                                 giris=COALESCE(%s,giris), cikis=COALESCE(%s,cikis), calisma_turu=COALESCE(%s,calisma_turu),
                                 aktif=COALESCE(%s,aktif), degistiren=%s, zaman=NOW() WHERE id=%s""",
                            (ad, b.sube_id == "ortak", None if b.sube_id == "ortak" else b.sube_id,
                             (b.gorev or "").strip()[:40] or None, giris, cikis, b.calisma_turu, b.aktif, kim, tid))
            if any(x is not None for x in (b.maas, b.yemek, b.saatlik, b.yol)):
                ay = (b.ucret_ay or (giris.isoformat() if giris else _bugun().isoformat()))[:7]
                cur.execute("""SELECT maas, yemek, saatlik, yol FROM ey_personel_ucret WHERE personel_id=%s AND gecerli_ay <= %s
                                ORDER BY gecerli_ay DESC LIMIT 1""", (tid, ay))
                o = dict(cur.fetchone() or {"maas": 0, "yemek": 0, "saatlik": 0, "yol": 0})
                yu = {k: (_kurus(getattr(b, k)) if getattr(b, k) is not None else o[k]) for k in ("maas", "yemek", "saatlik", "yol")}
                cur.execute("""INSERT INTO ey_personel_ucret (personel_id, gecerli_ay, maas, yemek, saatlik, yol, degistiren)
                               VALUES (%s,%s,%s,%s,%s,%s,%s)
                               ON CONFLICT (personel_id, gecerli_ay) DO UPDATE SET maas=EXCLUDED.maas, yemek=EXCLUDED.yemek,
                                 saatlik=EXCLUDED.saatlik, yol=EXCLUDED.yol, degistiren=EXCLUDED.degistiren, zaman=NOW()""",
                            (tid, ay, yu["maas"], yu["yemek"], yu["saatlik"], yu["yol"], kim))
            return {"ok": True, "id": tid, "mesaj": f"Personel {'eklendi' if yeni else 'güncellendi'}"}

        if tur == "kart":
            from evvel_yeni_kart_api import kart_hazirla
            kart_hazirla(cur)
            for g_ in (b.kesim_gunu, b.son_odeme_gunu):
                if g_ is not None and not 1 <= g_ <= 31:
                    raise HTTPException(400, "Kesim / son ödeme günü 1–31 olmalı")
            if yeni:
                tid = "ey-" + uuid.uuid4().hex[:12]
                cur.execute("""INSERT INTO ey_kart (id, ad, banka, kimin, acilis_borc, degistiren) VALUES (%s,%s,%s,%s,%s,%s)""",
                            (tid, ad, (b.banka or "").strip()[:40] or None, (b.kimin or "").strip()[:40] or None, _kurus(b.acilis_borc or 0), kim))
            else:
                cur.execute("""UPDATE ey_kart SET ad=COALESCE(%s,ad), banka=COALESCE(%s,banka), kimin=COALESCE(%s,kimin),
                                 acilis_borc=COALESCE(%s,acilis_borc), aktif=COALESCE(%s,aktif), degistiren=%s, zaman=NOW() WHERE id=%s""",
                            (ad, (b.banka or "").strip()[:40] or None, (b.kimin or "").strip()[:40] or None,
                             _kurus(b.acilis_borc) if b.acilis_borc is not None else None, b.aktif, kim, tid))
            cur.execute("""UPDATE ey_kart SET limit_tutar=COALESCE(%s,limit_tutar), kesim_gunu=COALESCE(%s,kesim_gunu),
                             son_odeme_gunu=COALESCE(%s,son_odeme_gunu), limit_grup=COALESCE(%s,limit_grup) WHERE id=%s""",
                        (_kurus(b.limit_tutar) if b.limit_tutar is not None else None, b.kesim_gunu, b.son_odeme_gunu,
                         (b.limit_grup or "").strip()[:40] or None, tid))
            return {"ok": True, "id": tid, "mesaj": f"Kart {'eklendi' if yeni else 'güncellendi'}"}

        # toptancı
        if yeni:
            cur.execute("SELECT 1 FROM ey_toptanci WHERE LOWER(TRIM(ad)) = LOWER(TRIM(%s))", (ad,))
            if cur.fetchone():
                raise HTTPException(409, "Bu adla toptancı zaten var")
            tid = "ey-" + uuid.uuid4().hex[:12]
            cur.execute("""INSERT INTO ey_toptanci (id, ad, kategori, telefon, acilis_bakiye, degistiren) VALUES (%s,%s,%s,%s,%s,%s)""",
                        (tid, ad, (b.kategori or "").strip()[:40] or None, (b.telefon or "").strip()[:20] or None, _kurus(b.acilis_bakiye or 0), kim))
        else:
            cur.execute("""UPDATE ey_toptanci SET ad=COALESCE(%s,ad), kategori=COALESCE(%s,kategori), telefon=COALESCE(%s,telefon),
                             acilis_bakiye=COALESCE(%s,acilis_bakiye), aktif=COALESCE(%s,aktif), degistiren=%s, zaman=NOW() WHERE id=%s""",
                        (ad, (b.kategori or "").strip()[:40] or None, (b.telefon or "").strip()[:20] or None,
                         _kurus(b.acilis_bakiye) if b.acilis_bakiye is not None else None, b.aktif, kim, tid))
        if b.vade_gun is not None:
            if not 0 <= int(b.vade_gun) <= 365:
                raise HTTPException(400, "Vade günü 0–365 olmalı")
            from evvel_yeni_toptanci_api import toptanci_hazirla
            toptanci_hazirla(cur)
            cur.execute("UPDATE ey_toptanci SET vade_gun=%s WHERE id=%s", (int(b.vade_gun), tid))
        return {"ok": True, "id": tid, "mesaj": f"Toptancı {'eklendi' if yeni else 'güncellendi'}"}
