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
        else:   # Fable: kod'suz eski kopyada kategori kodunu tamamla (özel talep kategoriyi koddan bulur)
            try:
                with savepoint(cur, "sp_ey_kat_kod"):
                    cur.execute("UPDATE ey_urun_kategori k SET kod=s.kod FROM siparis_kategori s WHERE k.id=s.id::text AND k.kod IS NULL")
            except Exception:  # noqa: BLE001
                log.warning("ey_urun_kategori kod tamamlanamadı", exc_info=True)
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
            cur.execute("SELECT id::text AS id FROM siparis_urun WHERE kategori_id=%s AND norm_ad=%s AND id::text<>%s AND aktif",
                        (u["kategori_id"], ad_anahtar(u["ad"]), u["id"]))
            r = cur.fetchone() if u.get("aktif", True) else None
            if r:
                raise HTTPException(409, "Bu kategoride aynı adlı (büyük/küçük harf, Türkçe karakter farkı dahil) başka ürün var")
            cur.execute("""INSERT INTO siparis_urun (id, kategori_id, ad, norm_ad, sira, aktif, birim, koli_ic_adet, koli_adet)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                           ON CONFLICT (id) DO UPDATE SET kategori_id=EXCLUDED.kategori_id, ad=EXCLUDED.ad,
                               norm_ad=CASE WHEN TRIM(siparis_urun.ad) IS DISTINCT FROM TRIM(EXCLUDED.ad) OR siparis_urun.kategori_id IS DISTINCT FROM EXCLUDED.kategori_id
                                            THEN EXCLUDED.norm_ad ELSE siparis_urun.norm_ad END,   -- ad değişmediyse eski anahtar kalır (pasif ikizle çakışmasın)
                               aktif=EXCLUDED.aktif, koli_ic_adet=EXCLUDED.koli_ic_adet,
                               koli_adet=EXCLUDED.koli_adet, guncelleme=NOW()""",
                        (u["id"], u["kategori_id"], u["ad"], ad_anahtar(u["ad"]), int(u.get("sira") or 0), bool(u["aktif"]),
                         u["birim"], u.get("koli_ici"), u.get("koli_ici")))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        log.warning("ürün kataloğu: eski kataloğa yazılamadı (%s): %s", u.get("id"), str(e)[:160])
        if "norm_ad" in str(e) or "unique" in str(e).lower():
            raise HTTPException(409, "Bu kategoride bu adla kayıtlı başka bir ürün var — farklı bir ad yaz ya da pasif olanı yeniden aç")
        raise HTTPException(409, "Şube paneli kataloğu güncellenemedi — kayıt yapılmadı, tekrar dene")


# ─────────────────────────── UÇLAR ───────────────────────────
@router.get("/denetim")
def urun_denetim():
    """SALT-OKUR: her ürünün eski + yeni sistemde nerede kullanıldığı (stok, hareket, sipariş, teslim, fatura, eşleme, koli kanıtı).
    Sahip (2026-10-17): "aynı ürün iki kez kodlanmış; eski sistem doğru kurulmadı — dikkatli denetle". Hiçbir şey YAZMAZ."""
    _hazirla()
    sorgular = {
        "eski": """SELECT id::text AS id, ad, norm_ad, aktif, depo_stok_kalem_kodu AS depo_kodu, birim, koli_ic_adet, koli_adet, birim_fiyat_tl FROM siparis_urun""",
        "stok": """SELECT kalem_kodu AS id, COUNT(*) AS satir, SUM(mevcut_adet) AS mevcut, string_agg(sube_id || ':' || mevcut_adet, ' ') AS dagilim
                   FROM sube_depo_stok GROUP BY kalem_kodu""",
        "stok_hareket": """SELECT kalem_kodu AS id, COUNT(*) AS n, MAX(zaman)::date::text AS son FROM sube_depo_stok_hareket GROUP BY kalem_kodu""",
        "ey_hareket": """SELECT urun_id AS id, COUNT(*) AS n, MAX(is_gunu)::text AS son FROM ey_stok_hareket WHERE NOT iptal GROUP BY urun_id""",
        "siparis": """SELECT k->>'urun_id' AS id, COUNT(*) AS n, MAX(t.tarih)::text AS son, SUM(COALESCE((k->>'adet')::numeric,0)) AS adet
                      FROM siparis_talep t, jsonb_array_elements(CASE WHEN jsonb_typeof(t.kalemler)='array' THEN t.kalemler ELSE '[]'::jsonb END) k
                      GROUP BY 1""",
        "teslim": """SELECT k->>'urun_id' AS id, COUNT(*) AS n, MAX(t.tarih)::text AS son
                     FROM ey_toptanci_teslim t, jsonb_array_elements(t.kalemler) k WHERE NOT t.iptal GROUP BY 1""",
        "alis": """SELECT DISTINCT ON (kalem_kodu) kalem_kodu AS id, birim, birim_maliyet_tl AS fiyat, gecerli_baslangic::text AS tarih, tedarikci
                   FROM urun_alis_fiyat ORDER BY kalem_kodu, gecerli_baslangic DESC""",
        "fatura_esleme": """SELECT kalem_kodu AS id, string_agg(anahtar || ' ×' || adet, ' | ') AS eslesmeler FROM fatura_kalem_eslestirme GROUP BY kalem_kodu""",
        "fatura_satir": """SELECT eslesen_stok_kodu AS id, COUNT(*) AS n,
                                  string_agg(DISTINCT COALESCE(ocr_ad,'?') || ' [' || COALESCE(birim,'?') || ']', ' | ') AS adlar,
                                  MIN(birim_fiyat) AS min_fiyat, MAX(birim_fiyat) AS max_fiyat
                           FROM tedarikci_fatura_kalem WHERE eslesen_stok_kodu IS NOT NULL GROUP BY 1""",
        "acilis_birimi": """SELECT kalem_kodu AS id, acilis_birim, fatura_icerik, notlar FROM urun_acilis_birimi""",
        "kullanimda": """SELECT urun_id AS id, COUNT(*) AS n FROM sube_kullanimda_urun GROUP BY urun_id""",
        "takma": """SELECT urun_id AS id, string_agg(takma, ' | ') AS takmalar FROM ey_urun_takma GROUP BY urun_id""",
    }
    veri, hatalar = {}, {}
    with db() as (conn, cur):
        try:
            with savepoint(cur, "sp_den_ro"):
                cur.execute("SET LOCAL statement_timeout = '20s'")
        except Exception:  # noqa: BLE001
            pass
        for ad, q in sorgular.items():
            try:
                with savepoint(cur, f"sp_den_{ad}"):
                    cur.execute(q)
                    veri[ad] = {str(dict(r)["id"]): {k: (float(v) if isinstance(v, Decimal) else v) for k, v in dict(r).items() if k != "id"}
                                for r in cur.fetchall() or [] if dict(r).get("id") is not None}
            except Exception as e:  # noqa: BLE001 — tablo yoksa o kanıt boş
                hatalar[ad] = str(e)[:160]
                veri[ad] = {}
        cur.execute("""SELECT u.id, u.ad, u.aktif, u.birim_teyit, u.koli_ici, u.kdv_oran, k.ad AS kategori
                       FROM ey_urun u LEFT JOIN ey_urun_kategori k ON k.id=u.kategori_id ORDER BY k.sira, u.sira""")
        urunler = [dict(r) for r in cur.fetchall() or []]
    bilinen = {u["id"] for u in urunler}
    satirlar = []
    for u in urunler:
        u["kdv_oran"] = float(u["kdv_oran"]) if u["kdv_oran"] is not None else None
        satirlar.append({**u, **{ad: veri[ad].get(u["id"]) for ad in sorgular}})
    # Hiçbir ürüne bağlanmamış kodlar (eski ad/kod ile kalmış stok, fatura eşlemesi…) — "aynı ürün iki kodla" kanıtı
    yetim = {ad: {k: v for k, v in veri[ad].items() if k not in bilinen} for ad in ("stok", "stok_hareket", "fatura_esleme", "fatura_satir", "alis", "acilis_birimi", "siparis", "ey_hareket")}
    return {"urunler": satirlar, "yetim_kodlar": yetim, "hatalar": hatalar}


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
    """Aynı kategoride aynı adlı KULLANIMDAKİ ürün (Türkçe büyük/küçük ve İ/I farkı dahil) → 409.
    Pasif eski ikizler engellemez (eski katalogda 30+ aynı adlı pasif kopya var; yoksa aktif kardeşi hiç düzeltilemiyordu)."""
    from sevkiyat_helpers import ad_anahtar
    hedef = ad_anahtar(ad.strip()[:120])
    cur.execute("SELECT id, ad FROM ey_urun WHERE kategori_id=%s AND aktif", (kategori_id,))
    for r in cur.fetchall() or []:
        if dict(r)["id"] != haric and ad_anahtar(dict(r)["ad"]) == hedef:
            raise HTTPException(409, f"Bu kategoride aynı adlı ürün var: {dict(r)['ad']}")


def urun_olustur(cur, kategori_id: str, ad: str, kim: str, koli_ici: Optional[int] = None, kdv_oran=None,
                 kategori_kod: Optional[str] = None, aktif: bool = True, birim_teyit: bool = True, varsa_bagla: bool = False) -> dict:
    """PUBLIC servis: yeni ürün — katalog + iz + (geçişte) eski kataloğa da. Çağıranın işleminde çalışır (ya tam ya hiç).
    Eski sistemin özel talep → "kataloğa al" akışı da bunu kullanır (Fable 2. tur: eski ekleme kapısı kapanınca o akış kırılmasın)."""
    _hazirla()
    if not str(ad or "").strip() or len(ad.strip()) < 2:
        raise HTTPException(400, "Ürün adı en az 2 harf")
    if kategori_kod and not kategori_id:
        # KÖPRÜ (eski kategori yazıcısı kesilene kadar): eski sistemde sonradan açılmış kategori katalogda yoksa bir kez kopyalanır (Fable)
        cur.execute("""INSERT INTO ey_urun_kategori (id, ad, emoji, sira, aktif, kod)
                       SELECT id::text, ad, emoji, sira, aktif, kod FROM siparis_kategori WHERE kod=%s ON CONFLICT DO NOTHING""", (kategori_kod.strip(),))
        cur.execute("SELECT id FROM ey_urun_kategori WHERE kod=%s AND aktif", (kategori_kod.strip(),))
        r = cur.fetchone()
        kategori_id = dict(r)["id"] if r else None
    cur.execute("SELECT 1 FROM ey_urun_kategori WHERE id=%s", (kategori_id,))
    if not kategori_id or not cur.fetchone():
        raise HTTPException(400, "Kategori seç")
    cur.execute("SELECT pg_advisory_xact_lock(7012042)")   # Fable: eşzamanlı iki ekleme çift ürün açmasın
    if varsa_bagla:   # Fable: özel talep katalogda zaten olan (pasif dahil) ürünü isterse ona bağlanır; pasifse izle aktiflenir
        from sevkiyat_helpers import ad_anahtar
        cur.execute("SELECT id, ad, aktif FROM ey_urun WHERE kategori_id=%s ORDER BY aktif DESC, sira", (kategori_id,))
        for r in cur.fetchall() or []:
            r = dict(r)
            if ad_anahtar(r["ad"]) == ad_anahtar(ad.strip()[:120]):
                if not r["aktif"]:
                    cur.execute("UPDATE ey_urun SET aktif=TRUE WHERE id=%s", (r["id"],))
                    cur.execute("UPDATE siparis_urun SET aktif=TRUE WHERE id::text=%s", (r["id"],))   # KÖPRÜ: panel eskiyi okuyor
                    cur.execute("INSERT INTO ey_urun_iz (id, urun_id, alan, eski, yeni, kim, kaynak_ref) VALUES (%s,%s,'aktif','False','True',%s,NULL)",
                                (str(uuid.uuid4()), r["id"], kim))
                return {"id": r["id"], "ad": r["ad"], "kategori_id": kategori_id, "kategori_kod": kategori_kod, "mevcut": True}
    _ayni_ad(cur, kategori_id, ad, None)
    cur.execute("SELECT COALESCE(MAX(sira), 0) + 10 AS s FROM ey_urun WHERE kategori_id=%s", (kategori_id,))
    uid = str(uuid.uuid4())
    u = {"id": uid, "ad": ad.strip()[:120], "kategori_id": kategori_id, "birim": "adet", "koli_ici": koli_ici,
         "kdv_oran": kdv_oran, "aktif": bool(aktif), "sira": int(dict(cur.fetchone())["s"])}
    cur.execute("""INSERT INTO ey_urun (id, ad, kategori_id, birim, birim_teyit, koli_ici, kdv_oran, aktif, sira) VALUES (%s,%s,%s,'adet',%s,%s,%s,%s,%s)""",
                (uid, u["ad"], kategori_id, bool(birim_teyit) or koli_ici is not None, koli_ici, kdv_oran, u["aktif"], u["sira"]))
    cur.execute("INSERT INTO ey_urun_iz (id, urun_id, alan, eski, yeni, kim, kaynak_ref) VALUES (%s,%s,'olusturma',NULL,%s,%s,%s)",
                (str(uuid.uuid4()), uid, json.dumps({k: str(v) if v is not None else None for k, v in u.items()}, ensure_ascii=False), kim, f"olustur:{uid}"))
    _eskiye_yaz(cur, u)
    cur.execute("SELECT kod FROM ey_urun_kategori WHERE id=%s", (kategori_id,))
    k = cur.fetchone()
    return {"id": uid, "ad": u["ad"], "kategori_id": kategori_id, "kategori_kod": (dict(k)["kod"] if k else kategori_kod)}


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
        if b.aktif and ("ad" in degisen or "kategori_id" in degisen or "aktif" in degisen):   # pasif ikiz yeniden açılırken de
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
