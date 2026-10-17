"""📚 EVVEL YENİ · ÜRÜN KATALOĞU — tak-çıkar modül "urun" (sektor genel, gerekir []).

SIFIRDAN KURULUM (sahip 2026-10-18): "Hataları tespit ettik; bunu sıfırdan kuruyoruz, uçları da sıfırdan yazacağız —
kopyalayıp oradan tekrar bağlayıp Evvel'in ilk versiyonu gibi olmasın."
  · Eski sisteme HİÇBİR bağ yok: eski kimlik, eski depo kodu / takma ad, eski kataloğa geri yazma YOK. Eski tablolar okunmaz.
  · Başlangıç listesi: 2026-10-17/18 akşamı sahiple temizlenen liste (mükerrerler ayıklanmış, birim / koli / KDV düzeltilmiş) — YENİ kimliklerle,
    bir kez yazılır (sürüm 2). İlk denemenin tabloları silinmez, *_v1_yedek adıyla saklanır (sürümleri sakla).
  · DEĞİŞİKLİK İZİ: ürünün güncel kartı + her değişiklik bir kayıt (alan, eski → yeni, kim, zaman). Silme yok: pasif + iz.
  · BİRİM: tek sayım birimi (ilk sürüm 'adet'); koli = giriş yardımcısı (1 koli kaç adet). KDV ürün kartında. FİYAT katalogda değil.
  · PUBLIC servis: urun_haritasi(cur) · katalog(cur) · urun_bilgi(cur, idler) · urun_ad(cur, id) · urun_olustur(cur, …).
"""

import json
import logging
import uuid
from decimal import Decimal
from typing import Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from database import db
from evvel_yeni_cekirdek import aktor as _aktor, bekleyen_is_kaydet

router = APIRouter(prefix="/api/evvel-yeni/urun", tags=["evvel-yeni-urun"])
log = logging.getLogger(__name__)
BIRIMLER = ("adet",)          # kg / lt: miktar zinciri ondalığa geçince açılır
SURUM = 2
_HAZIR = False


def _n(x) -> str:
    """Ad anahtarı (Türkçe İ/I tuzağı güvenli): büyük/küçük harf ve boşluk farkı yok sayılır."""
    return " ".join(str(x or "").replace("İ", "i").replace("I", "ı").lower().split())


def _tablo_var(cur, ad: str) -> bool:
    cur.execute("SELECT to_regclass(%s) IS NOT NULL AS v", (ad,))
    return bool(dict(cur.fetchone())["v"])


def _hazirla():
    global _HAZIR
    if _HAZIR:
        return
    with db() as (conn, cur):
        cur.execute("SELECT pg_advisory_xact_lock(7012041)")   # kurulum çok işçide bir kez
        cur.execute("SET LOCAL lock_timeout = '3s'")
        cur.execute("CREATE TABLE IF NOT EXISTS ey_urun_surum (surum INT NOT NULL)")
        cur.execute("SELECT MAX(surum) AS s FROM ey_urun_surum")
        s = dict(cur.fetchone())["s"] or 0
        if s < SURUM:
            _surum2(cur)
            cur.execute("INSERT INTO ey_urun_surum (surum) VALUES (%s)", (SURUM,))
    _HAZIR = True


def _tablolar(cur):
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_urun_kategori (
        id TEXT PRIMARY KEY, ad TEXT NOT NULL, emoji TEXT, sira INT NOT NULL DEFAULT 0, aktif BOOLEAN NOT NULL DEFAULT TRUE)""")
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_urun (
        id TEXT PRIMARY KEY, ad TEXT NOT NULL, kategori_id TEXT NOT NULL, birim TEXT NOT NULL DEFAULT 'adet', birim_teyit BOOLEAN NOT NULL DEFAULT FALSE,
        koli_ici INT, kdv_oran NUMERIC(5,4), aktif BOOLEAN NOT NULL DEFAULT TRUE, sira INT NOT NULL DEFAULT 0,
        olusturma TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_urun_iz (
        id TEXT PRIMARY KEY, urun_id TEXT NOT NULL, alan TEXT NOT NULL, eski TEXT, yeni TEXT, kim TEXT,
        zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ey_urun_iz_urun ON ey_urun_iz (urun_id, zaman)")


def _surum2(cur):
    """İlk deneme (sürüm 1: eski sistemden kopya + köprü) varsa yedeğe kaldırılır; temizlenmiş liste YENİ kimliklerle yazılır.
    İlk deneme yoksa (yeni kurulum / başka iş kolu) katalog boş başlar."""
    eski = _tablo_var(cur, "ey_urun") and not _tablo_var(cur, "ey_urun_v1_yedek")
    if eski:
        for t in ("ey_urun", "ey_urun_kategori", "ey_urun_iz", "ey_urun_takma"):
            if _tablo_var(cur, t):
                cur.execute(f"ALTER TABLE {t} RENAME TO {t}_v1_yedek")
        for i in ("ey_urun_pkey", "ey_urun_kategori_pkey", "ey_urun_iz_pkey", "ey_urun_iz_kaynak_ref_key", "ey_urun_takma_pkey"):
            cur.execute(f"ALTER INDEX IF EXISTS {i} RENAME TO {i.replace('ey_urun', 'ey_urun_v1y', 1)}")
    _tablolar(cur)
    if not eski:
        return
    # Başlangıç listesi = sahiple temizlenen kullanımdaki ürünler (mükerrer / pasif / birleştirilmiş HARİÇ), yeni kimlik, eski bağ YOK
    cur.execute("SELECT id, ad, emoji, sira FROM ey_urun_kategori_v1_yedek WHERE aktif ORDER BY sira, ad")
    kat = {}
    for r in [dict(x) for x in cur.fetchall() or []]:
        kat[r["id"]] = str(uuid.uuid4())
        cur.execute("INSERT INTO ey_urun_kategori (id, ad, emoji, sira, aktif) VALUES (%s,%s,%s,%s,TRUE)",
                    (kat[r["id"]], r["ad"], r["emoji"], int(r["sira"] or 0)))
    cur.execute("""SELECT ad, kategori_id, birim_teyit, koli_ici, kdv_oran, sira FROM ey_urun_v1_yedek
                    WHERE aktif AND birlesti IS NULL ORDER BY sira, ad""")
    n = 0
    for r in [dict(x) for x in cur.fetchall() or []]:
        if r["kategori_id"] not in kat:
            continue
        uid = str(uuid.uuid4())
        cur.execute("""INSERT INTO ey_urun (id, ad, kategori_id, birim, birim_teyit, koli_ici, kdv_oran, aktif, sira)
                       VALUES (%s,%s,%s,'adet',%s,%s,%s,TRUE,%s)""",
                    (uid, r["ad"].strip(), kat[r["kategori_id"]], bool(r["birim_teyit"]), r["koli_ici"], r["kdv_oran"], int(r["sira"] or 0)))
        cur.execute("INSERT INTO ey_urun_iz (id, urun_id, alan, eski, yeni, kim) VALUES (%s,%s,'olusturma',NULL,%s,%s)",
                    (str(uuid.uuid4()), uid, r["ad"].strip(), "başlangıç listesi (2026-10-18, sahiple temizlendi)"))
        n += 1
    log.info("ürün kataloğu: sıfırdan kuruldu, başlangıç listesi %s ürün", n)


# ─────────────────────────── PUBLIC SERVİSLER ───────────────────────────
def urun_haritasi(cur):
    """Kimlik ya da ad → (urun_id, ad). Bulunamayan 'ad:<ad>' / 'kod:<kod>' döner (kaybolmaz, okuyan modül Bekleyen işlere yazar)."""
    _hazirla()
    cur.execute("SELECT id, ad FROM ey_urun ORDER BY aktif DESC, sira, ad")
    ad = {dict(r)["id"]: dict(r)["ad"] for r in cur.fetchall() or []}
    by_ad: Dict[str, str] = {}
    for uid, a in ad.items():
        by_ad.setdefault(_n(a), uid)

    def coz(kod, adi=None):
        kod = str(kod or "").strip()
        if kod in ad:
            return kod, ad[kod]
        if adi and _n(adi) in by_ad:
            u = by_ad[_n(adi)]
            return u, ad[u]
        return ("kod:" + kod if kod else "ad:" + _n(adi)), (adi or kod)
    return coz


def katalog(cur, hepsi: bool = False) -> List[dict]:
    """Kategori → ürünler (birim, koli, KDV, aktif). Fiyat YOK."""
    _hazirla()
    cur.execute("SELECT * FROM ey_urun_kategori" + ("" if hepsi else " WHERE aktif") + " ORDER BY sira, ad")
    kats = [dict(r) for r in cur.fetchall() or []]
    cur.execute("SELECT * FROM ey_urun" + ("" if hepsi else " WHERE aktif") + " ORDER BY sira, ad")
    by_k: Dict[str, list] = {}
    for u in [dict(r) for r in cur.fetchall() or []]:
        by_k.setdefault(u["kategori_id"], []).append({
            "id": u["id"], "ad": u["ad"], "birim": u["birim"], "birim_teyit": u["birim_teyit"], "koli_ici": u.get("koli_ici"),
            "kdv_oran": float(u["kdv_oran"]) if u.get("kdv_oran") is not None else None, "aktif": u["aktif"]})
    return [{"id": k["id"], "ad": k["ad"], "emoji": k.get("emoji"), "aktif": k["aktif"], "urunler": by_k.get(k["id"], [])} for k in kats]


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


def _ayni_ad(cur, kategori_id: str, ad: str, haric: Optional[str]) -> None:
    """Aynı kategoride aynı adlı KULLANIMDAKİ ürün (büyük/küçük harf, Türkçe İ/I, boşluk farkı dahil) → 409."""
    cur.execute("SELECT id, ad FROM ey_urun WHERE kategori_id=%s AND aktif", (kategori_id,))
    for r in cur.fetchall() or []:
        if dict(r)["id"] != haric and _n(dict(r)["ad"]) == _n(ad):
            raise HTTPException(409, f"Bu kategoride aynı adlı ürün var: {dict(r)['ad']}")


def urun_olustur(cur, kategori_id: str, ad: str, kim: str, koli_ici: Optional[int] = None, kdv_oran=None,
                 aktif: bool = True, birim_teyit: bool = True) -> dict:
    """PUBLIC servis: yeni ürün + iz. Çağıranın işleminde çalışır (ya tam ya hiç)."""
    _hazirla()
    ad = " ".join(str(ad or "").split())[:120]
    if len(ad) < 2:
        raise HTTPException(400, "Ürün adı en az 2 harf")
    cur.execute("SELECT 1 FROM ey_urun_kategori WHERE id=%s AND aktif", (kategori_id,))
    if not kategori_id or not cur.fetchone():
        raise HTTPException(400, "Kategori seç")
    cur.execute("SELECT pg_advisory_xact_lock(7012042)")   # eşzamanlı iki ekleme çift ürün açmasın
    _ayni_ad(cur, kategori_id, ad, None)
    cur.execute("SELECT COALESCE(MAX(sira), 0) + 10 AS s FROM ey_urun WHERE kategori_id=%s", (kategori_id,))
    sira = int(dict(cur.fetchone())["s"])
    uid = str(uuid.uuid4())
    cur.execute("""INSERT INTO ey_urun (id, ad, kategori_id, birim, birim_teyit, koli_ici, kdv_oran, aktif, sira) VALUES (%s,%s,%s,'adet',%s,%s,%s,%s,%s)""",
                (uid, ad, kategori_id, bool(birim_teyit) or koli_ici is not None, koli_ici, kdv_oran, bool(aktif), sira))
    cur.execute("INSERT INTO ey_urun_iz (id, urun_id, alan, eski, yeni, kim) VALUES (%s,%s,'olusturma',NULL,%s,%s)",
                (str(uuid.uuid4()), uid, json.dumps({"ad": ad, "koli_ici": koli_ici, "kdv_oran": None if kdv_oran is None else str(kdv_oran),
                                                     "aktif": bool(aktif)}, ensure_ascii=False), kim))
    return {"id": uid, "ad": ad, "kategori_id": kategori_id}


# ─────────────────────────── UÇLAR ───────────────────────────
@router.get("/katalog")
def katalog_ucu(hepsi: bool = True):
    with db() as (conn, cur):
        k = katalog(cur, hepsi=hepsi)
        cur.execute("SELECT COUNT(*) AS n FROM ey_urun WHERE aktif AND NOT birim_teyit")
        belirsiz = int(dict(cur.fetchone())["n"])
    return {"kategoriler": k, "birim_belirsiz": belirsiz, "birimler": list(BIRIMLER)}


class KategoriBody(BaseModel):
    ad: str
    emoji: Optional[str] = None
    aktif: bool = True


def _kategori_dogrula(cur, b: KategoriBody, haric: Optional[str]) -> str:
    ad = " ".join(b.ad.split())[:60]
    if len(ad) < 2:
        raise HTTPException(400, "Kategori adı en az 2 harf")
    cur.execute("SELECT id, ad FROM ey_urun_kategori WHERE aktif")
    for r in cur.fetchall() or []:
        if dict(r)["id"] != haric and _n(dict(r)["ad"]) == _n(ad):
            raise HTTPException(409, f"Bu adla kategori var: {dict(r)['ad']}")
    return ad


@router.post("/kategori")
def kategori_ekle(b: KategoriBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    _hazirla()
    with db() as (conn, cur):
        _aktor(cur, x_evvel_oturum)
        cur.execute("SELECT pg_advisory_xact_lock(7012043)")
        ad = _kategori_dogrula(cur, b, None)
        cur.execute("SELECT COALESCE(MAX(sira), 0) + 10 AS s FROM ey_urun_kategori")
        kid = str(uuid.uuid4())
        cur.execute("INSERT INTO ey_urun_kategori (id, ad, emoji, sira, aktif) VALUES (%s,%s,%s,%s,TRUE)",
                    (kid, ad, (b.emoji or "").strip()[:4] or None, int(dict(cur.fetchone())["s"])))
    return {"ok": True, "id": kid, "mesaj": f"{ad} kategorisi eklendi"}


@router.post("/kategori/{kid}")
def kategori_duzelt(kid: str, b: KategoriBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    _hazirla()
    with db() as (conn, cur):
        _aktor(cur, x_evvel_oturum)
        cur.execute("SELECT 1 FROM ey_urun_kategori WHERE id=%s FOR UPDATE", (kid,))
        if not cur.fetchone():
            raise HTTPException(404, "Kategori bulunamadı")
        ad = _kategori_dogrula(cur, b, kid) if b.aktif else " ".join(b.ad.split())[:60]
        if not b.aktif:
            cur.execute("SELECT COUNT(*) AS n FROM ey_urun WHERE kategori_id=%s AND aktif", (kid,))
            if int(dict(cur.fetchone())["n"]):
                raise HTTPException(409, "Kategoride kullanımdaki ürün var — önce ürünleri taşı ya da pasif yap")
        cur.execute("UPDATE ey_urun_kategori SET ad=%s, emoji=%s, aktif=%s WHERE id=%s", (ad, (b.emoji or "").strip()[:4] or None, b.aktif, kid))
    return {"ok": True, "mesaj": "Kaydedildi"}


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
        r = urun_olustur(cur, b.kategori_id, b.ad, kim, koli_ici=b.koli_ici, kdv_oran=b.kdv_oran, aktif=b.aktif)
    return {"ok": True, "id": r["id"], "mesaj": f"{r['ad']} eklendi"}


@router.post("/{uid}")
def urun_duzelt(uid: str, b: UrunBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Değişen her alan ayrı iz kaydı. Kaydetmek birimi TEYİT eder (değişmese bile)."""
    _hazirla()
    _dogrula(b)
    with db() as (conn, cur):
        kim = _aktor(cur, x_evvel_oturum)
        cur.execute("SELECT * FROM ey_urun WHERE id=%s FOR UPDATE", (uid,))
        e = cur.fetchone()
        if not e:
            raise HTTPException(404, "Ürün bulunamadı")
        e = dict(e)
        cur.execute("SELECT 1 FROM ey_urun_kategori WHERE id=%s AND aktif", (b.kategori_id,))
        if not cur.fetchone():
            raise HTTPException(400, "Kategori seç")
        yeni = {"ad": " ".join(b.ad.split())[:120], "kategori_id": b.kategori_id, "birim": b.birim, "koli_ici": b.koli_ici,
                "kdv_oran": b.kdv_oran, "aktif": b.aktif}

        def _es(a, b_):
            if a is None or b_ is None:
                return a is None and b_ is None
            if isinstance(a, (Decimal, float)) or isinstance(b_, (Decimal, float)):
                return Decimal(str(a)).quantize(Decimal("0.0001")) == Decimal(str(b_)).quantize(Decimal("0.0001"))
            return str(a) == str(b_)
        degisen = [k for k, v in yeni.items() if not _es(e.get(k), v)]
        if b.aktif and ("ad" in degisen or "kategori_id" in degisen or "aktif" in degisen):
            cur.execute("SELECT pg_advisory_xact_lock(7012042)")
            _ayni_ad(cur, b.kategori_id, yeni["ad"], uid)
        if e["birim"] != b.birim and e.get("birim_teyit"):
            raise HTTPException(409, "Sayım birimi teyitli ürünün birimi değiştirilemez — farklı paket ayrı ürün olur")
        if not degisen and e["birim_teyit"]:
            return {"ok": True, "mesaj": "Değişiklik yok"}
        cur.execute("""UPDATE ey_urun SET ad=%s, kategori_id=%s, birim=%s, birim_teyit=TRUE, koli_ici=%s, kdv_oran=%s, aktif=%s WHERE id=%s""",
                    (yeni["ad"], b.kategori_id, b.birim, b.koli_ici, b.kdv_oran, b.aktif, uid))
        for k in degisen + ([] if e["birim_teyit"] else ["birim_teyit"]):
            cur.execute("INSERT INTO ey_urun_iz (id, urun_id, alan, eski, yeni, kim) VALUES (%s,%s,%s,%s,%s,%s)",
                        (str(uuid.uuid4()), uid, k, None if e.get(k) is None else str(e.get(k)),
                         "TRUE" if k == "birim_teyit" else (None if yeni.get(k) is None else str(yeni.get(k))), kim))
    return {"ok": True, "mesaj": "Kaydedildi" + (" (birim teyit edildi)" if not e["birim_teyit"] else "")}


@router.get("/{uid}/iz")
def urun_iz(uid: str):
    _hazirla()
    with db() as (conn, cur):
        cur.execute("SELECT alan, eski, yeni, kim, zaman FROM ey_urun_iz WHERE urun_id=%s ORDER BY zaman DESC, alan", (uid,))
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
             "etiket": "📚 Birim belirsiz", "ad": f"{n} üründe koli bilgisi teyit edilmedi",
             "alt": "Ürünler'de ürünü açıp 'kaydet' — koliyle geliyorsa 1 koli kaç adet", "sayfa": "urunler", "dugme": "Ürünler"}]


bekleyen_is_kaydet("urun_birim", _bekleyen)
