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
    ok = True
    with db() as (conn, cur):
        cur.execute("SELECT pg_advisory_xact_lock(7012041)")   # ilk kopya çok işçide bir kez (Fable: lock_timeout bu beklemeye uygulanmasın)
        cur.execute("SET LOCAL lock_timeout = '3s'")
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_urun_kategori (
            id TEXT PRIMARY KEY, ad TEXT NOT NULL, emoji TEXT, sira INT NOT NULL DEFAULT 0, aktif BOOLEAN NOT NULL DEFAULT TRUE)""")
        cur.execute("ALTER TABLE ey_urun_kategori ADD COLUMN IF NOT EXISTS kod TEXT")
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
            ok = _ilk_kopya(cur)
    _HAZIR = ok          # Fable: kopya başarısızsa bir sonraki istekte yeniden denensin (boş katalogla kalınmasın)


def _ilk_kopya(cur) -> bool:
    """KÖPRÜ (bir kez): siparis_kategori → ey_urun_kategori, siparis_urun → ey_urun (kimlikler AYNI), depo kodu → takma ad, KDV → ürüne.
    Birim: eski 'birim' doluysa ve 'adet' ise teyitli; değilse 'adet' + birim_teyit=FALSE ("birim belirsiz" — tek tek çözülür)."""
    try:
        with savepoint(cur, "sp_ey_urun_kopya"):
            cur.execute("""INSERT INTO ey_urun_kategori (id, ad, emoji, sira, aktif, kod)
                           SELECT id::text, ad, emoji, sira, aktif, kod FROM siparis_kategori ON CONFLICT DO NOTHING""")
            kdv = {}
            try:
                with savepoint(cur, "sp_ey_urun_kdv"):
                    cur.execute("SELECT kalem_kodu, kdv_oran FROM kalem_kdv_oran")
                    kdv = {str(dict(r)["kalem_kodu"]): dict(r)["kdv_oran"] for r in cur.fetchall() or []}
            except Exception:  # noqa: BLE001 — tablo yoksa KDV boş başlar
                kdv = {}
            from sevkiyat_helpers import ad_anahtar
            cur.execute("""SELECT id::text AS id, ad, kategori_id::text AS kategori_id, sira, aktif, depo_stok_kalem_kodu AS kod,
                                  NULLIF(TRIM(COALESCE(birim, '')), '') AS birim,
                                  koli_ic_adet AS k1, koli_adet AS k2
                             FROM siparis_urun ORDER BY sira, ad""")   # Fable: paylaşılan depo kodunda sonuç sıraya bağlı olmasın
            n = 0
            for r in cur.fetchall() or []:
                r = dict(r)
                birim_eski = _n(r.get("birim"))
                k1 = int(r["k1"]) if r.get("k1") and int(r["k1"]) > 1 else None
                k2 = int(r["k2"]) if r.get("k2") and int(r["k2"]) > 1 else None
                celiski = bool(k1 and k2 and k1 != k2)        # Codex: ikiz kolon çelişirse sessizce büyüğü SEÇME → boş + teyitsiz
                koli = None if celiski else (k1 or k2)
                k_ = next((kdv[a] for a in (str(r.get("kod") or ""), r["id"], ad_anahtar(r["ad"])) if a and a in kdv), None)   # eski sıra: kod → id → ad
                cur.execute("""INSERT INTO ey_urun (id, ad, kategori_id, birim, birim_teyit, koli_ici, kdv_oran, aktif, sira)
                               VALUES (%s,%s,%s,'adet',%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                            (r["id"], r["ad"], r["kategori_id"], birim_eski == "adet" and not celiski, koli, k_, bool(r["aktif"]), int(r.get("sira") or 0)))
                kod_cakisma = None
                if r.get("kod"):
                    cur.execute("INSERT INTO ey_urun_takma (takma, urun_id, kaynak) VALUES (%s,%s,'eski_kod') ON CONFLICT DO NOTHING RETURNING takma",
                                (str(r["kod"]), r["id"]))
                    if not cur.fetchone():
                        kod_cakisma = str(r["kod"])     # aynı depo kodu başka üründe — izde görünür (1b'de karar)
                eski_bilgi = {"ad": r["ad"], "birim": r.get("birim"), "koli_ic_adet": r.get("k1"), "koli_adet": r.get("k2"), "depo_kodu": r.get("kod"),
                              "kdv": str(k_) if k_ is not None else None, "koli_celiski": celiski, "kod_baska_urunde": kod_cakisma}
                cur.execute("""INSERT INTO ey_urun_iz (id, urun_id, alan, eski, yeni, kim, kaynak_ref) VALUES (%s,%s,'kopya',%s,%s,'eski sistem kopyası',%s)
                               ON CONFLICT DO NOTHING""", (str(uuid.uuid4()), r["id"], json.dumps(eski_bilgi, ensure_ascii=False), r["ad"],
                                                         f"eski:siparis_urun:{r['id']}"))
                n += 1
            log.info("ürün kataloğu: eski sistemden %s ürün kopyalandı", n)
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("ürün kataloğu: eski katalog kopyalanamadı: %s", str(e)[:200])
        return False


# ─────────────────────────── PUBLIC SERVİSLER ───────────────────────────
def urun_haritasi(cur):
    """Kimlik / takma ad (eski depo kodu) / ad → (urun_id, ad). Depo'nun eski `_urun_haritasi` ile AYNI imza:
    bulunamayan kod 'kod:<kod>', ad 'ad:<ad>' olarak döner (kaybolmaz, izlenir)."""
    _hazirla()
    cur.execute("SELECT id, ad FROM ey_urun ORDER BY aktif DESC, sira, ad")
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
    cur.execute("SELECT * FROM ey_urun_kategori ORDER BY sira, ad")
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
    """Geçiş süresince ŞUBE PANELİ eski siparis_urun'u okuyor → aynı kimlikle eskiye de yazılır (iki koli kolonu birlikte).
    Codex: hata GİZLENMEZ — eskiye yazılamazsa işlem bütünüyle geri alınır ve sebep söylenir (panel ile katalog ayrışmasın)."""
    from sevkiyat_helpers import ad_anahtar
    try:
        with savepoint(cur, "sp_ey_urun_eskiye"):
            cur.execute("SELECT id::text AS id FROM siparis_urun WHERE kategori_id=%s AND norm_ad=%s AND id::text<>%s",
                        (u["kategori_id"], ad_anahtar(u["ad"]), u["id"]))
            r = cur.fetchone()
            if r:
                raise HTTPException(409, "Bu kategoride aynı adlı (büyük/küçük harf, Türkçe karakter farkı dahil) başka ürün var")
            cur.execute("""INSERT INTO siparis_urun (id, kategori_id, ad, norm_ad, sira, aktif, birim, koli_ic_adet, koli_adet)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                           ON CONFLICT (id) DO UPDATE SET kategori_id=EXCLUDED.kategori_id, ad=EXCLUDED.ad, norm_ad=EXCLUDED.norm_ad,
                               aktif=EXCLUDED.aktif, koli_ic_adet=EXCLUDED.koli_ic_adet,
                               koli_adet=EXCLUDED.koli_adet, guncelleme=NOW()""",
                        (u["id"], u["kategori_id"], u["ad"], ad_anahtar(u["ad"]), int(u.get("sira") or 0), bool(u["aktif"]),
                         u["birim"], u.get("koli_ici"), u.get("koli_ici")))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        log.warning("ürün kataloğu: eski kataloğa yazılamadı (%s): %s", u.get("id"), str(e)[:160])
        raise HTTPException(409, "Şube paneli kataloğu güncellenemedi — kayıt yapılmadı, tekrar dene")


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


def _ayni_ad(cur, kategori_id: str, ad: str, haric: Optional[str]) -> None:
    """Aynı kategoride aynı ad (Türkçe büyük/küçük ve İ/I farkı dahil — eski katalogla aynı anahtar) → 409."""
    from sevkiyat_helpers import ad_anahtar
    hedef = ad_anahtar(ad.strip()[:120])
    cur.execute("SELECT id, ad FROM ey_urun WHERE kategori_id=%s", (kategori_id,))
    for r in cur.fetchall() or []:
        if dict(r)["id"] != haric and ad_anahtar(dict(r)["ad"]) == hedef:
            raise HTTPException(409, f"Bu kategoride aynı adlı ürün var: {dict(r)['ad']}")


@router.post("")
def urun_ekle(b: UrunBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    _hazirla()
    _dogrula(b)
    with db() as (conn, cur):
        kim = _aktor(cur, x_evvel_oturum)
        cur.execute("SELECT 1 FROM ey_urun_kategori WHERE id=%s", (b.kategori_id,))
        if not cur.fetchone():
            raise HTTPException(400, "Kategori seç")
        cur.execute("SELECT pg_advisory_xact_lock(7012042)")   # Fable: eşzamanlı iki ekleme çift ürün açmasın
        _ayni_ad(cur, b.kategori_id, b.ad, None)
        cur.execute("SELECT COALESCE(MAX(sira), 0) + 10 AS s FROM ey_urun WHERE kategori_id=%s", (b.kategori_id,))
        uid = str(uuid.uuid4())
        u = {"id": uid, "ad": b.ad.strip()[:120], "kategori_id": b.kategori_id, "birim": b.birim, "koli_ici": b.koli_ici,
             "kdv_oran": b.kdv_oran, "aktif": b.aktif, "sira": int(dict(cur.fetchone())["s"])}
        cur.execute("""INSERT INTO ey_urun (id, ad, kategori_id, birim, birim_teyit, koli_ici, kdv_oran, aktif, sira) VALUES (%s,%s,%s,%s,TRUE,%s,%s,%s,%s)""",
                    (uid, u["ad"], b.kategori_id, b.birim, b.koli_ici, b.kdv_oran, b.aktif, u["sira"]))
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
        def _es(a, b_):
            if a is None or b_ is None:
                return a is None and b_ is None
            if isinstance(a, (Decimal, float)) or isinstance(b_, (Decimal, float)):
                return Decimal(str(a)).quantize(Decimal("0.0001")) == Decimal(str(b_)).quantize(Decimal("0.0001"))   # Fable: 0.1000 = 0.1
            return str(a) == str(b_)
        degisen = [k for k, v in yeni.items() if not _es(e.get(k), v)]
        if "ad" in degisen or "kategori_id" in degisen:
            _ayni_ad(cur, b.kategori_id, b.ad, uid)
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
        cur.execute("SELECT alan, eski, yeni, kim, zaman FROM ey_urun_iz WHERE urun_id=%s AND NOT iptal ORDER BY zaman DESC, alan", (uid,))
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
