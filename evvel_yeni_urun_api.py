"""📚 EVVEL YENİ · ÜRÜN KATALOĞU (2026-10-17) — tak-çıkar modül "urun" (sektor genel, gerekir []).

Sahip: "Katalog örüntüsü ile depo örüntüsü AYNI MANTIKTA olmalı; yeni Evvel'in altyapısını yok sayma." (SIPARIS_TASARIM.md §1, Codex + Fable)
  · TEK KİMLİK: eski siparis_urun kimlikleri BİR KEZ, aynen korunarak kopyalanır (Depo / Toptancı kayıtları bu kimlikleri kullanıyor → köprü gerekmez).
  · DEĞİŞİKLİK İZİ (Depo deseni): ürünün güncel kartı + her değişiklik bir kayıt (alan, eski → yeni, kim, zaman, kaynak_ref TEKİL). Silme yok: pasif + iz.
  · BİRİM: tek sayım birimi (ilk sürüm 'adet'); koli = giriş yardımcısı (koli_ici). Eski ikiz kolon (koli_ic_adet / koli_adet) kopyada TEK alana iner.
  · KDV kataloğa taşınır (eski kalem_kdv_oran: ürün kimliği ya da depo kodu anahtarlı). FİYAT katalogda DEĞİL (Ürün fiyatları altyapısında kalır).
  · TAKMA AD: eski depo kodu + (ileride) fatura adları — ürün eşlemenin TEK yeri.
  · PUBLIC servis: urun_haritasi(cur) · katalog(cur) · urun_bilgi(cur, idler) · urun_ad(cur, id). Depo, Toptancılar, Bar, Gider, Satış bunu okur (adım 1b).
KÖPRÜ (eski sistem kalkınca SİL — KESIM_LISTESI 13): `_ilk_kopya` (bir kez) ve `_eskiye_yaz` (geçiş süresince ŞUBE PANELİ eski kataloğu okuduğu için
katalog değişikliği eski siparis_urun'a da yazılır — "hem yeniye hem eskiye").
"""

import json
import logging
import uuid
from decimal import Decimal
from typing import Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from database import db, savepoint
from evvel_yeni_cekirdek import aktor as _aktor, bekleyen_is_kaydet

router = APIRouter(prefix="/api/evvel-yeni/urun", tags=["evvel-yeni-urun"])
log = logging.getLogger(__name__)
BIRIMLER = ("adet",)          # kg / lt: mevcut tam sayı miktar zinciri dönüştürülünce açılır (Codex)
_HAZIR = False


def _n(x) -> str:
    """Ad anahtarı (Türkçe İ/I tuzağı güvenli) — eşleme için."""
    return " ".join(str(x or "").replace("İ", "i").replace("I", "ı").lower().split())


def _hazirla():
    global _HAZIR
    if _HAZIR:
        return
    with db() as (conn, cur):
        cur.execute("SET LOCAL lock_timeout = '3s'")
        cur.execute("SELECT pg_advisory_xact_lock(7012041)")   # ilk kopya çok işçide bir kez
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_urun_kategori (
            id TEXT PRIMARY KEY, ad TEXT NOT NULL, emoji TEXT, sira INT NOT NULL DEFAULT 0, aktif BOOLEAN NOT NULL DEFAULT TRUE)""")
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_urun (
            id TEXT PRIMARY KEY, ad TEXT NOT NULL, kategori_id TEXT, birim TEXT NOT NULL DEFAULT 'adet', birim_teyit BOOLEAN NOT NULL DEFAULT FALSE,
            koli_ici INT, kdv_oran NUMERIC(5,4), aktif BOOLEAN NOT NULL DEFAULT TRUE, sira INT NOT NULL DEFAULT 0,
            olusturma TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_urun_takma (
            takma TEXT PRIMARY KEY, urun_id TEXT NOT NULL, kaynak TEXT NOT NULL DEFAULT 'elle')""")
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_urun_iz (
            id TEXT PRIMARY KEY, urun_id TEXT NOT NULL, alan TEXT NOT NULL, eski TEXT, yeni TEXT, kim TEXT,
            zaman TIMESTAMPTZ NOT NULL DEFAULT NOW(), kaynak_ref TEXT UNIQUE, iptal BOOLEAN NOT NULL DEFAULT FALSE)""")
        cur.execute("SELECT COUNT(*) AS n FROM ey_urun")
        if int(dict(cur.fetchone())["n"]) == 0:
            _ilk_kopya(cur)
    _HAZIR = True


def _ilk_kopya(cur) -> None:
    """KÖPRÜ (bir kez): siparis_kategori → ey_urun_kategori, siparis_urun → ey_urun (kimlikler AYNI), depo kodu → takma ad, KDV → ürüne.
    Birim: eski 'birim' doluysa ve 'adet' ise teyitli; değilse 'adet' + birim_teyit=FALSE ("birim belirsiz" — tek tek çözülür)."""
    try:
        with savepoint(cur, "sp_ey_urun_kopya"):
            cur.execute("""INSERT INTO ey_urun_kategori (id, ad, emoji, sira, aktif)
                           SELECT id::text, ad, emoji, sira, aktif FROM siparis_kategori ON CONFLICT DO NOTHING""")
            kdv = {}
            try:
                with savepoint(cur, "sp_ey_urun_kdv"):
                    cur.execute("SELECT kalem_kodu, kdv_oran FROM kalem_kdv_oran")
                    kdv = {str(dict(r)["kalem_kodu"]): dict(r)["kdv_oran"] for r in cur.fetchall() or []}
            except Exception:  # noqa: BLE001 — tablo yoksa KDV boş başlar
                kdv = {}
            cur.execute("""SELECT id::text AS id, ad, kategori_id::text AS kategori_id, sira, aktif, depo_stok_kalem_kodu AS kod,
                                  NULLIF(TRIM(COALESCE(birim, '')), '') AS birim,
                                  GREATEST(COALESCE(koli_ic_adet, 0), COALESCE(koli_adet, 0)) AS koli
                             FROM siparis_urun""")
            n = 0
            for r in cur.fetchall() or []:
                r = dict(r)
                birim_eski = _n(r.get("birim"))
                koli = int(r["koli"]) if r.get("koli") and int(r["koli"]) > 1 else None
                k_ = kdv.get(r["id"]) if r["id"] in kdv else kdv.get(str(r.get("kod") or ""))
                cur.execute("""INSERT INTO ey_urun (id, ad, kategori_id, birim, birim_teyit, koli_ici, kdv_oran, aktif, sira)
                               VALUES (%s,%s,%s,'adet',%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                            (r["id"], r["ad"], r["kategori_id"], birim_eski == "adet", koli, k_, bool(r["aktif"]), int(r.get("sira") or 0)))
                if r.get("kod"):
                    cur.execute("INSERT INTO ey_urun_takma (takma, urun_id, kaynak) VALUES (%s,%s,'eski_kod') ON CONFLICT DO NOTHING",
                                (str(r["kod"]), r["id"]))
                cur.execute("""INSERT INTO ey_urun_iz (id, urun_id, alan, eski, yeni, kim, kaynak_ref) VALUES (%s,%s,'kopya',NULL,%s,'eski sistem kopyası',%s)
                               ON CONFLICT DO NOTHING""", (str(uuid.uuid4()), r["id"], r["ad"], f"eski:siparis_urun:{r['id']}"))
                n += 1
            log.info("ürün kataloğu: eski sistemden %s ürün kopyalandı", n)
    except Exception as e:  # noqa: BLE001
        log.warning("ürün kataloğu: eski katalog kopyalanamadı: %s", str(e)[:200])


# ─────────────────────────── PUBLIC SERVİSLER ───────────────────────────
def urun_haritasi(cur):
    """Kimlik / takma ad (eski depo kodu) / ad → (urun_id, ad). Depo'nun eski `_urun_haritasi` ile AYNI imza:
    bulunamayan kod 'kod:<kod>', ad 'ad:<ad>' olarak döner (kaybolmaz, izlenir)."""
    _hazirla()
    cur.execute("SELECT id, ad FROM ey_urun")
    ad = {dict(r)["id"]: dict(r)["ad"] for r in cur.fetchall() or []}
    cur.execute("SELECT takma, urun_id FROM ey_urun_takma")
    takma = {dict(r)["takma"]: dict(r)["urun_id"] for r in cur.fetchall() or []}
    by_ad: Dict[str, str] = {}
    for uid, a in ad.items():
        by_ad.setdefault(_n(a), uid)

    def coz(kod, adi=None):
        kod = str(kod or "").strip()
        if kod in ad:
            return kod, ad[kod]
        if kod in takma:
            u = takma[kod]
            return u, ad.get(u) or adi
        if adi and _n(adi) in by_ad:
            u = by_ad[_n(adi)]
            return u, ad.get(u)
        return ("kod:" + kod if kod else "ad:" + _n(adi)), (adi or kod)
    return coz


def katalog(cur, hepsi: bool = False) -> List[dict]:
    """Kategori → ürünler (birim, koli, KDV, aktif). Fiyat YOK (Ürün fiyatları'nda)."""
    _hazirla()
    cur.execute("SELECT * FROM ey_urun_kategori" + ("" if hepsi else " WHERE aktif") + " ORDER BY sira, ad")
    kats = [dict(r) for r in cur.fetchall() or []]
    cur.execute("SELECT * FROM ey_urun" + ("" if hepsi else " WHERE aktif") + " ORDER BY sira, ad")
    uruns = [dict(r) for r in cur.fetchall() or []]
    by_k: Dict[str, list] = {}
    for u in uruns:
        by_k.setdefault(u.get("kategori_id") or "", []).append({
            "id": u["id"], "ad": u["ad"], "birim": u["birim"], "birim_teyit": u["birim_teyit"], "koli_ici": u.get("koli_ici"),
            "kdv_oran": float(u["kdv_oran"]) if u.get("kdv_oran") is not None else None, "aktif": u["aktif"]})
    out = [{"id": k["id"], "ad": k["ad"], "emoji": k.get("emoji"), "aktif": k["aktif"], "urunler": by_k.pop(k["id"], [])} for k in kats]
    if by_k:
        out.append({"id": "", "ad": "Kategorisiz", "emoji": "❔", "aktif": True, "urunler": [x for v in by_k.values() for x in v]})
    return out


def urun_bilgi(cur, idler) -> Dict[str, dict]:
    """{urun_id: {ad, birim, koli_ici, kdv_oran, aktif}} — okuyucular için toplu bilgi."""
    _hazirla()
    idler = [str(i) for i in (idler or []) if i]
    if not idler:
        return {}
    cur.execute("SELECT id, ad, birim, koli_ici, kdv_oran, aktif FROM ey_urun WHERE id = ANY(%s)", (idler,))
    return {dict(r)["id"]: {**dict(r), "kdv_oran": float(dict(r)["kdv_oran"]) if dict(r)["kdv_oran"] is not None else None}
            for r in cur.fetchall() or []}


def urun_ad(cur, uid: str) -> Optional[str]:
    return (urun_bilgi(cur, [uid]).get(str(uid)) or {}).get("ad")


# ─────────────────────────── KÖPRÜ: eski kataloğa geri yaz (panel görsün) ───────────────────────────
def _eskiye_yaz(cur, u: dict) -> None:
    """Geçiş süresince ŞUBE PANELİ eski siparis_urun'u okuyor → aynı kimlikle eskiye de yazılır. Hata olursa yeni kayıt yine geçerli (log)."""
    try:
        with savepoint(cur, "sp_ey_urun_eskiye"):
            from sevkiyat_helpers import ad_anahtar
            cur.execute("""INSERT INTO siparis_urun (id, kategori_id, ad, norm_ad, sira, aktif, birim, koli_ic_adet)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                           ON CONFLICT (id) DO UPDATE SET kategori_id=EXCLUDED.kategori_id, ad=EXCLUDED.ad, norm_ad=EXCLUDED.norm_ad,
                               aktif=EXCLUDED.aktif, birim=EXCLUDED.birim, koli_ic_adet=EXCLUDED.koli_ic_adet, guncelleme=NOW()""",
                        (u["id"], u["kategori_id"], u["ad"], ad_anahtar(u["ad"]), int(u.get("sira") or 0), bool(u["aktif"]),
                         u["birim"], u.get("koli_ici")))
    except Exception as e:  # noqa: BLE001
        log.warning("ürün kataloğu: eski kataloğa yazılamadı (%s): %s", u.get("id"), str(e)[:160])


# ─────────────────────────── UÇLAR ───────────────────────────
@router.get("/katalog")
def katalog_ucu(hepsi: bool = True):
    with db() as (conn, cur):
        k = katalog(cur, hepsi=hepsi)
        cur.execute("SELECT COUNT(*) AS n FROM ey_urun WHERE aktif AND NOT birim_teyit")
        belirsiz = int(dict(cur.fetchone())["n"])
    return {"kategoriler": k, "birim_belirsiz": belirsiz, "birimler": list(BIRIMLER)}


class UrunBody(BaseModel):
    ad: str
    kategori_id: str
    birim: str = "adet"
    koli_ici: Optional[int] = None
    kdv_oran: Optional[Decimal] = None     # 0.01 · 0.10 · 0.20
    aktif: bool = True


def _dogrula(b: UrunBody) -> None:
    if not b.ad.strip():
        raise HTTPException(400, "Ürünün adını yaz")
    if b.birim not in BIRIMLER:
        raise HTTPException(400, "Sayım birimi: " + " / ".join(BIRIMLER))
    if b.koli_ici is not None and not 2 <= int(b.koli_ici) <= 10000:
        raise HTTPException(400, "1 koli kaç adet? (2 ya da daha fazla; koliyle gelmiyorsa boş bırak)")
    if b.kdv_oran is not None and not Decimal("0") <= b.kdv_oran <= Decimal("0.30"):
        raise HTTPException(400, "KDV oranı 0–0,30 arası (ör. 0,10)")


@router.post("")
def urun_ekle(b: UrunBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    _hazirla()
    _dogrula(b)
    with db() as (conn, cur):
        kim = _aktor(cur, x_evvel_oturum)
        cur.execute("SELECT 1 FROM ey_urun_kategori WHERE id=%s", (b.kategori_id,))
        if not cur.fetchone():
            raise HTTPException(400, "Kategori seç")
        cur.execute("SELECT id FROM ey_urun WHERE kategori_id=%s AND lower(ad)=lower(%s)", (b.kategori_id, b.ad.strip()))
        if cur.fetchone():
            raise HTTPException(409, "Bu kategoride aynı adlı ürün zaten var")
        uid = str(uuid.uuid4())
        u = {"id": uid, "ad": b.ad.strip()[:120], "kategori_id": b.kategori_id, "birim": b.birim, "koli_ici": b.koli_ici,
             "kdv_oran": b.kdv_oran, "aktif": b.aktif, "sira": 0}
        cur.execute("""INSERT INTO ey_urun (id, ad, kategori_id, birim, birim_teyit, koli_ici, kdv_oran, aktif) VALUES (%s,%s,%s,%s,TRUE,%s,%s,%s)""",
                    (uid, u["ad"], b.kategori_id, b.birim, b.koli_ici, b.kdv_oran, b.aktif))
        cur.execute("INSERT INTO ey_urun_iz (id, urun_id, alan, eski, yeni, kim, kaynak_ref) VALUES (%s,%s,'olusturma',NULL,%s,%s,%s)",
                    (str(uuid.uuid4()), uid, json.dumps({k: str(v) if v is not None else None for k, v in u.items()}, ensure_ascii=False), kim, f"olustur:{uid}"))
        _eskiye_yaz(cur, u)
    return {"ok": True, "id": uid, "mesaj": f"{u['ad']} eklendi"}


@router.post("/{uid}")
def urun_duzelt(uid: str, b: UrunBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Değişen her alan ayrı iz kaydı. Birim TEYİT edilir (değişmese bile kaydetmek 'teyitli' yapar)."""
    _hazirla()
    _dogrula(b)
    with db() as (conn, cur):
        kim = _aktor(cur, x_evvel_oturum)
        cur.execute("SELECT * FROM ey_urun WHERE id=%s FOR UPDATE", (uid,))
        e = cur.fetchone()
        if not e:
            raise HTTPException(404, "Ürün bulunamadı")
        e = dict(e)
        yeni = {"ad": b.ad.strip()[:120], "kategori_id": b.kategori_id, "birim": b.birim, "koli_ici": b.koli_ici,
                "kdv_oran": b.kdv_oran, "aktif": b.aktif}
        degisen = [k for k, v in yeni.items() if str(e.get(k) if e.get(k) is not None else "") != str(v if v is not None else "")]
        if e["birim"] != b.birim and e.get("birim_teyit"):
            raise HTTPException(409, "Sayım birimi teyitli ürünün birimi değiştirilemez — farklı paket ayrı ürün olur")
        if not degisen and e["birim_teyit"]:
            return {"ok": True, "mesaj": "Değişiklik yok"}
        cur.execute("""UPDATE ey_urun SET ad=%s, kategori_id=%s, birim=%s, birim_teyit=TRUE, koli_ici=%s, kdv_oran=%s, aktif=%s WHERE id=%s""",
                    (yeni["ad"], b.kategori_id, b.birim, b.koli_ici, b.kdv_oran, b.aktif, uid))
        for k in degisen + ([] if e["birim_teyit"] else ["birim_teyit"]):
            cur.execute("""INSERT INTO ey_urun_iz (id, urun_id, alan, eski, yeni, kim, kaynak_ref) VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                        (str(uuid.uuid4()), uid, k, None if e.get(k) is None else str(e.get(k)),
                         "TRUE" if k == "birim_teyit" else (None if yeni.get(k) is None else str(yeni.get(k))), kim, f"duzelt:{uuid.uuid4()}"))
        _eskiye_yaz(cur, {**e, **yeni, "id": uid})
    return {"ok": True, "mesaj": "Kaydedildi" + (" (birim teyit edildi)" if not e["birim_teyit"] else "")}


@router.get("/{uid}/iz")
def urun_iz(uid: str):
    _hazirla()
    with db() as (conn, cur):
        cur.execute("SELECT alan, eski, yeni, kim, zaman FROM ey_urun_iz WHERE urun_id=%s AND NOT iptal ORDER BY zaman DESC", (uid,))
        return {"iz": [{**dict(r), "zaman": str(dict(r)["zaman"])[:16]} for r in cur.fetchall() or []]}


def _bekleyen(cur, baglam: dict) -> list:
    """Bekleyen işler › Tedarik & depo: birimi teyit edilmemiş aktif ürünler (tek satır)."""
    _hazirla()
    cur.execute("SELECT COUNT(*) AS n FROM ey_urun WHERE aktif AND NOT birim_teyit")
    n = int(dict(cur.fetchone())["n"])
    if not n:
        return []
    from evvel_yeni_cekirdek import bugun
    return [{"tur": "urun_birim", "genel": True, "grup": "tedarik", "id": "urun_birim", "tarih": bugun().isoformat(),
             "etiket": "📚 Birim belirsiz", "ad": f"{n} üründe sayım birimi / koli teyit edilmedi",
             "alt": "Ürünler'de her ürünü açıp 'kaydet' — koliyle geliyorsa 1 koli kaç adet", "sayfa": "urunler", "dugme": "Ürünler"}]


bekleyen_is_kaydet("urun_birim", _bekleyen)
