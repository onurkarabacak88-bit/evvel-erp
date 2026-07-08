"""
REÇETE KONTROL MODÜLÜ (2026-07-08) — İZOLE.

KURGU (kullanıcı tarifi): ürün-aç stok düşümü ve maliyetin SAHİBİ olarak kalır;
reçete DEĞİŞTİRMEZ, KONTROL EDER: Evo satışı × reçete = beklenen tüketim ↔
ürün-aç/stok hareketi = gerçek düşüş → fark TESPİTİ (öneri-only, hüküm yok).

Katmanlar:
  1) recete + recete_kalem: reçete kitabının yapılandırılmış hali (kaynak_metin
     korunur — ayrıştırma hatası geriye dönük düzeltilebilir).
  2) recete_parametre: pump=ml, kaşık=gr gibi ÇEVRİM VARSAYIMLARI — kullanıcı
     teyidiyle kesinleşir (varsayim=TRUE görünür kalır).
  3) recete_eslestirme: reçete ürün adı ↔ Evo satış adı; reçete malzemesi ↔
     depo kalem kodu. Otomatik ÖNERİ üretilir, İNSAN onaylar (durum makinesi).
  4) /api/duyu/recete-kontrol: eşleşmesi ONAYLI malzemeler için gün×şube
     beklenen-gerçek kıyası. Eşleşme yoksa dürüstçe 'bekliyor' der.

İzole: kendi tablolarına yazar; ürün-aç, stok, maliyet akışına DOKUNMAZ.
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import date, timedelta
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/recete", tags=["recete"])

_TR_FOLD = str.maketrans("çğıöşüÇĞİÖŞÜI", "cgiosucgiosui")


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").translate(_TR_FOLD).lower()).strip()


def _ensure(cur) -> None:
    cur.execute("""
        CREATE TABLE IF NOT EXISTS recete (
            id TEXT PRIMARY KEY,
            kategori TEXT NOT NULL DEFAULT '',
            urun_ad TEXT NOT NULL,
            urun_ad_norm TEXT NOT NULL,
            boyut TEXT NOT NULL DEFAULT '',
            bardak_tipi TEXT NOT NULL DEFAULT '',
            aktif BOOLEAN NOT NULL DEFAULT TRUE,
            surum INT NOT NULL DEFAULT 1,
            olusturma TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (urun_ad_norm, boyut)
        );
        CREATE TABLE IF NOT EXISTS recete_kalem (
            id TEXT PRIMARY KEY,
            recete_id TEXT NOT NULL REFERENCES recete(id) ON DELETE CASCADE,
            malzeme_sinif TEXT NOT NULL,      -- espresso/surup/sos/pure_toz/sut/su/diger
            malzeme_ad TEXT NOT NULL DEFAULT '',
            miktar NUMERIC(10,2),
            birim TEXT,                        -- shot/pump/ml/g/kasik/yuzde_bardak/adet
            kesinlik TEXT NOT NULL DEFAULT 'belirsiz',  -- kesin/yaklasik/belirsiz
            kaynak_metin TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS recete_parametre (
            ad TEXT PRIMARY KEY,
            deger NUMERIC(10,3) NOT NULL,
            birim TEXT NOT NULL,
            varsayim BOOLEAN NOT NULL DEFAULT TRUE,   -- kullanıcı teyidiyle FALSE olur
            aciklama TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS recete_ambalaj (
            kalem_kodu TEXT PRIMARY KEY,
            kalem_adi TEXT NOT NULL DEFAULT '',
            icerik NUMERIC(10,1) NOT NULL,     -- 1 ambalajın içeriği (ml veya g)
            birim TEXT NOT NULL,               -- ml | g
            varsayim BOOLEAN NOT NULL DEFAULT TRUE
        );
        CREATE TABLE IF NOT EXISTS recete_eslestirme (
            id TEXT PRIMARY KEY,
            tip TEXT NOT NULL,                 -- 'urun' (recete↔Evo adı) | 'malzeme' (↔depo kalemi)
            kaynak_ad TEXT NOT NULL,           -- reçetedeki ad (norm)
            hedef_ad TEXT NOT NULL,            -- Evo ürün adı VEYA depo kalem_adi
            hedef_kod TEXT,                    -- depo kalem_kodu (malzeme için)
            benzerlik NUMERIC(4,3),
            durum TEXT NOT NULL DEFAULT 'oneri',  -- oneri/onayli/reddedildi
            olusturma TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (tip, kaynak_ad, hedef_ad)
        );
    """)
    # Çevrim varsayımları (yalnız yoksa eklenir; kullanıcı teyidi 'varsayim=FALSE' yapar)
    for ad, deger, birim, acik in (
        ("pump_ml", 5, "ml", "1 pump şurup ≈ 5 ml (sektör standardı; teyit edilecek)"),
        ("shot_gram", 9, "g", "1 shot espresso ≈ 9 g çekirdek (makine ayarına göre 8-10)"),
        ("silme_kasik_g", 10, "g", "1 silme kaşık toz ≈ 10 g (kaşık boyu teyit edilecek)"),
        ("bardak_14oz_ml", 414, "ml", "14 oz bardak hacmi"),
        ("bardak_8oz_ml", 237, "ml", "8 oz bardak hacmi"),
        ("fincan_ml", 70, "ml", "Türk kahvesi fincanı"),
    ):
        cur.execute(
            """INSERT INTO recete_parametre (ad, deger, birim, aciklama)
               VALUES (%s,%s,%s,%s) ON CONFLICT (ad) DO NOTHING""",
            (ad, deger, birim, acik),
        )


class KalemGirdi(BaseModel):
    malzeme_sinif: str
    malzeme_ad: str = ""
    miktar: Optional[float] = None
    birim: Optional[str] = None
    kesinlik: str = "belirsiz"
    kaynak_metin: str = ""


class ReceteGirdi(BaseModel):
    kategori: str = ""
    urun_ad: str
    boyut: str = ""
    bardak_tipi: str = ""
    kalemler: List[KalemGirdi] = []


class YuklePaket(BaseModel):
    receteler: List[ReceteGirdi]


@router.post("/yukle")
def recete_yukle(paket: YuklePaket):
    """Reçete kitabını topluca yükle (upsert: aynı ürün+boyut → kalemler tazelenir).
    Kaynak metin HEP saklanır — ayrıştırma varsayımı sonradan düzeltilebilir."""
    if not paket.receteler:
        raise HTTPException(400, "receteler boş")
    eklenen = guncellenen = 0
    with db() as (conn, cur):
        _ensure(cur)
        for r in paket.receteler:
            ad = (r.urun_ad or "").strip()
            if not ad:
                continue
            norm = _norm(ad)
            cur.execute("SELECT id FROM recete WHERE urun_ad_norm=%s AND boyut=%s",
                        (norm, r.boyut or ""))
            mevcut = cur.fetchone()
            if mevcut:
                rid = mevcut["id"]
                cur.execute("UPDATE recete SET kategori=%s, bardak_tipi=%s, "
                            "surum=surum+1 WHERE id=%s",
                            (r.kategori or "", r.bardak_tipi or "", rid))
                cur.execute("DELETE FROM recete_kalem WHERE recete_id=%s", (rid,))
                guncellenen += 1
            else:
                rid = str(uuid.uuid4())
                cur.execute(
                    """INSERT INTO recete (id, kategori, urun_ad, urun_ad_norm, boyut,
                                           bardak_tipi)
                       VALUES (%s,%s,%s,%s,%s,%s)""",
                    (rid, r.kategori or "", ad, norm, r.boyut or "", r.bardak_tipi or ""))
                eklenen += 1
            for k in r.kalemler:
                cur.execute(
                    """INSERT INTO recete_kalem (id, recete_id, malzeme_sinif, malzeme_ad,
                                                 miktar, birim, kesinlik, kaynak_metin)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (str(uuid.uuid4()), rid, k.malzeme_sinif, k.malzeme_ad,
                     k.miktar, k.birim, k.kesinlik, (k.kaynak_metin or "")[:400]))
        conn.commit()
    return {"ok": True, "eklenen": eklenen, "guncellenen": guncellenen}


@router.get("/liste")
def recete_liste():
    with db() as (_, cur):
        _ensure(cur)
        cur.execute("""
            SELECT r.id, r.kategori, r.urun_ad, r.boyut, r.bardak_tipi, r.surum,
                   COUNT(k.id)::int AS kalem_sayisi,
                   COUNT(*) FILTER (WHERE k.kesinlik='kesin')::int AS kesin_kalem
            FROM recete r LEFT JOIN recete_kalem k ON k.recete_id=r.id
            WHERE r.aktif=TRUE
            GROUP BY r.id ORDER BY r.kategori, r.urun_ad""")
        return {"receteler": [dict(x) for x in cur.fetchall() or []]}


@router.get("/detay")
def recete_detay(urun: str):
    n = _norm(urun)
    with db() as (_, cur):
        _ensure(cur)
        cur.execute("SELECT * FROM recete WHERE urun_ad_norm LIKE %s AND aktif=TRUE",
                    (f"%{n}%",))
        out = []
        for r in [dict(x) for x in cur.fetchall() or []]:
            cur.execute("""SELECT malzeme_sinif, malzeme_ad, miktar, birim, kesinlik,
                                  kaynak_metin
                           FROM recete_kalem WHERE recete_id=%s""", (r["id"],))
            r["kalemler"] = [dict(k) for k in cur.fetchall() or []]
            for k in r["kalemler"]:
                if k.get("miktar") is not None:
                    k["miktar"] = float(k["miktar"])
            out.append(r)
        return {"receteler": out}


@router.get("/parametreler")
def parametreler():
    with db() as (_, cur):
        _ensure(cur)
        cur.execute("SELECT ad, deger, birim, varsayim, aciklama FROM recete_parametre")
        rows = [dict(r) for r in cur.fetchall() or []]
        for r in rows:
            r["deger"] = float(r["deger"])
        return {"parametreler": rows,
                "not": "varsayim=true satırlar kullanıcı teyidi bekler — "
                       "POST /api/recete/parametre ile kesinleştirilir."}


@router.post("/parametre")
def parametre_guncelle(payload: dict):
    ad = str(payload.get("ad") or "").strip()
    deger = payload.get("deger")
    if not ad or deger is None:
        raise HTTPException(400, "ad + deger zorunlu")
    with db() as (conn, cur):
        _ensure(cur)
        cur.execute("UPDATE recete_parametre SET deger=%s, varsayim=FALSE WHERE ad=%s",
                    (float(deger), ad))
        if cur.rowcount == 0:
            raise HTTPException(404, "parametre yok")
        conn.commit()
    return {"ok": True, "ad": ad, "deger": float(deger), "varsayim": False}


# ── EŞLEŞTİRME: otomatik ÖNERİ + insan onayı ─────────────────────────────────
def _benzerlik(a: str, b: str) -> float:
    """Basit token-kesişim benzerliği (0-1). LLM yok — deterministik."""
    ta, tb = set(_norm(a).split()), set(_norm(b).split())
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


@router.post("/eslestirme-oner")
def eslestirme_oner():
    """Reçete ürünleri ↔ Evo satış adları ve reçete malzemeleri ↔ depo kalemleri
    için otomatik ÖNERİ üretir (benzerlik ≥ 0.34). KURULMAZ — 'oneri' durumunda
    bekler, insan /eslestirme-karar ile onaylar (duyu anayasası)."""
    uretilen = 0
    with db() as (conn, cur):
        _ensure(cur)
        # Evo satış adları (son 7 günün cache'inden)
        cur.execute("""SELECT veri_json FROM evo_rapor_cache
                       WHERE anahtar='sube-grup-detay' AND bastar=bittar
                       ORDER BY bastar DESC LIMIT 7""")
        evo_adlar = set()
        for row in cur.fetchall() or []:
            for _s, sd in (dict(row)["veri_json"].get("subeler") or {}).items():
                for u in sd.get("cok_satilan") or []:
                    ad = str(u.get("ad") or "").strip()
                    if ad:
                        evo_adlar.add(ad)
        cur.execute("SELECT urun_ad FROM recete WHERE aktif=TRUE")
        recete_urunler = [dict(r)["urun_ad"] for r in cur.fetchall() or []]
        for ru in recete_urunler:
            for ea in evo_adlar:
                b = _benzerlik(ru, ea)
                if b >= 0.34:
                    cur.execute(
                        """INSERT INTO recete_eslestirme (id, tip, kaynak_ad, hedef_ad,
                                                          benzerlik)
                           VALUES (%s,'urun',%s,%s,%s)
                           ON CONFLICT (tip, kaynak_ad, hedef_ad) DO NOTHING""",
                        (str(uuid.uuid4()), _norm(ru), ea, round(b, 3)))
                    uretilen += cur.rowcount
        # Malzemeler ↔ depo kalemleri
        cur.execute("""SELECT DISTINCT malzeme_ad FROM recete_kalem
                       WHERE malzeme_ad <> ''""")
        malzemeler = [dict(r)["malzeme_ad"] for r in cur.fetchall() or []]
        # iki kaynak: son 60 gün HAREKET görenler + depo stok tablosunun KENDİSİ
        # (hareketsiz kalemler de eşleşebilsin — '14 OZ BARDAK' dersi, 2026-07-08)
        cur.execute("""
            SELECT DISTINCT kalem_kodu, kalem_adi FROM (
                SELECT kalem_kodu, kalem_adi FROM sube_depo_stok_hareket
                WHERE zaman >= NOW() - INTERVAL '60 days'
                UNION
                SELECT kalem_kodu, kalem_adi FROM sube_depo_stok
            ) t WHERE COALESCE(kalem_adi,'') <> ''""")
        kalemler = [dict(r) for r in cur.fetchall() or []]
        for m in malzemeler:
            for k in kalemler:
                b = _benzerlik(m, k["kalem_adi"] or "")
                if b >= 0.34:
                    cur.execute(
                        """INSERT INTO recete_eslestirme (id, tip, kaynak_ad, hedef_ad,
                                                          hedef_kod, benzerlik)
                           VALUES (%s,'malzeme',%s,%s,%s,%s)
                           ON CONFLICT (tip, kaynak_ad, hedef_ad) DO NOTHING""",
                        (str(uuid.uuid4()), _norm(m), k["kalem_adi"], k["kalem_kodu"],
                         round(b, 3)))
                    uretilen += cur.rowcount
        conn.commit()
    return {"ok": True, "yeni_oneri": uretilen,
            "not": "Öneriler 'oneri' durumunda bekler — hiçbiri onaysız kullanılmaz."}


@router.get("/eslestirmeler")
def eslestirmeler(durum: str = ""):
    with db() as (_, cur):
        _ensure(cur)
        if durum:
            cur.execute("""SELECT id, tip, kaynak_ad, hedef_ad, hedef_kod,
                                  benzerlik, durum FROM recete_eslestirme
                           WHERE durum=%s ORDER BY tip, benzerlik DESC""", (durum,))
        else:
            cur.execute("""SELECT id, tip, kaynak_ad, hedef_ad, hedef_kod,
                                  benzerlik, durum FROM recete_eslestirme
                           ORDER BY tip, durum, benzerlik DESC""")
        rows = [dict(r) for r in cur.fetchall() or []]
        for r in rows:
            if r.get("benzerlik") is not None:
                r["benzerlik"] = float(r["benzerlik"])
        return {"eslestirmeler": rows}


@router.post("/eslestirme-karar")
def eslestirme_karar(payload: dict):
    eid = str(payload.get("id") or "").strip()
    karar = str(payload.get("karar") or "").strip()
    if karar not in ("onayli", "reddedildi"):
        raise HTTPException(400, "karar: onayli | reddedildi")
    with db() as (conn, cur):
        _ensure(cur)
        cur.execute("UPDATE recete_eslestirme SET durum=%s WHERE id=%s", (karar, eid))
        if cur.rowcount == 0:
            raise HTTPException(404, "eşleştirme yok")
        conn.commit()
    return {"ok": True, "id": eid, "durum": karar}


# ── KONTROL DUYUSU: beklenen ↔ gerçek (öneri-only) ───────────────────────────
# Bar sayımında DEVİR-BİLİNÇLİ izlenen malzemeler (Kullanılan Ürünler hesabı):
# malzeme(norm) → (bar_key, 1 birimin içeriği, içerik birimi). Bunlar için depo
# eşleşmesi GEREKMEZ — gerçek taraf bar satilan'dan (açılış + ürün-aç − kapanış).
_RECETE_BAR_ES = {
    "sut": ("sut_litre", 1000.0, "ml"),
    "plastik bardak": ("bardak_plastik", 1.0, "adet"),
    "14 oz karton bardak": ("karton_bardak", 1.0, "adet"),
    "8 oz bardak": ("bardak_kucuk", 1.0, "adet"),
}
@router.get("/kontrol")
def recete_kontrol(gun: int = 7):
    """REÇETE KONTROLÜ: onaylı eşleşmeler üzerinden gün bazında
    beklenen tüketim (Evo satış × reçete) ↔ gerçek düşüş (stok hareketi).
    Ürün-aç akışına DOKUNMAZ; yalnız FARKI gösterir. Eşleşme onaysızsa hesap
    o kalem için 'bekliyor' — dürüst boşluk, sıfır uydurma."""
    g = max(3, min(30, int(gun or 7)))
    bugun = date.today()
    with db() as (_, cur):
        _ensure(cur)
        cur.execute("SELECT ad, deger FROM recete_parametre")
        prm = {dict(r)["ad"]: float(dict(r)["deger"]) for r in cur.fetchall() or []}
        # onaylı eşleştirmeler
        cur.execute("""SELECT tip, kaynak_ad, hedef_ad, hedef_kod
                       FROM recete_eslestirme WHERE durum='onayli'""")
        onayli = [dict(r) for r in cur.fetchall() or []]
        urun_es = {r["kaynak_ad"]: r["hedef_ad"] for r in onayli if r["tip"] == "urun"}
        # malzeme → KOD LİSTESİ: depoda kopya kalemler var (örn. 'Plastik bardak' ×2)
        # — aynı malzemenin tüm onaylı kodlarının açılışları TOPLANIR (çift kod kıyası bozmasın)
        malzeme_es: Dict[str, list] = {}
        for r in onayli:
            if r["tip"] == "malzeme" and r.get("hedef_kod"):
                malzeme_es.setdefault(r["kaynak_ad"], []).append(r["hedef_kod"])
        if not urun_es or not malzeme_es:
            cur.execute("""SELECT COUNT(*)::int AS n FROM recete_eslestirme
                           WHERE durum='oneri'""")
            bekleyen = dict(cur.fetchone() or {}).get("n", 0)
            return {"durum": "eslestirme_bekliyor",
                    "onayli_urun": len(urun_es), "onayli_malzeme": len(malzeme_es),
                    "bekleyen_oneri": bekleyen,
                    "not": "Kontrol için en az 1 onaylı ürün + 1 onaylı malzeme "
                           "eşleşmesi gerekir. Öneriler /api/recete/eslestirmeler'de."}
        # reçete kalemleri (ml/g cinsine çevrilebilirler)
        cur.execute("""
            SELECT r.urun_ad_norm, k.malzeme_ad, k.miktar, k.birim
            FROM recete r JOIN recete_kalem k ON k.recete_id = r.id
            WHERE r.aktif=TRUE AND k.miktar IS NOT NULL AND k.birim IS NOT NULL""")
        recete_map: Dict[str, list] = {}
        for row in [dict(x) for x in cur.fetchall() or []]:
            mik, b = float(row["miktar"]), row["birim"]
            if b == "pump":
                mik, b = mik * prm.get("pump_ml", 5), "ml"
            elif b == "shot":
                mik, b = mik * prm.get("shot_gram", 9), "g"
            elif b == "kasik":
                mik, b = mik * prm.get("silme_kasik_g", 10), "g"
            elif b == "yuzde_bardak":
                mik, b = mik / 100.0 * prm.get("bardak_14oz_ml", 414), "ml"
            elif b == "fincan":
                mik, b = mik * prm.get("fincan_ml", 70), "ml"
            recete_map.setdefault(row["urun_ad_norm"], []).append(
                {"malzeme": _norm(row["malzeme_ad"]), "miktar": mik, "birim": b})
        # Evo satışları gün gün
        cur.execute("""SELECT bastar::text AS gun, veri_json FROM evo_rapor_cache
                       WHERE anahtar='sube-grup-detay' AND bastar=bittar
                         AND bastar >= %s ORDER BY bastar""",
                    (str(bugun - timedelta(days=g)),))
        # beklenen: MALZEME bazında (kod değil) — (malzeme, birim) → {gun: miktar}
        # BUGÜN kıyasa GİRMEZ: gün bitmeden (kapanış sayımı yokken) fark anlamsız —
        # dünün tamamlanmış günleri kıyaslanır (2026-07-08 dersi: %2400 sahte fark).
        beklenen: Dict[tuple, Dict[str, float]] = {}
        for row in cur.fetchall() or []:
            gun_s = dict(row)["gun"]
            if gun_s >= str(bugun):
                continue
            for _s, sd in (dict(row)["veri_json"].get("subeler") or {}).items():
                for u in sd.get("cok_satilan") or []:
                    ad_n = None
                    for rn, ea in urun_es.items():
                        if _norm(str(u.get("ad") or "")) == _norm(ea):
                            ad_n = rn
                            break
                    if not ad_n or ad_n not in recete_map:
                        continue
                    adet = float(u.get("adet") or 0)
                    for kal in recete_map[ad_n]:
                        if (kal["malzeme"] not in malzeme_es
                                and kal["malzeme"] not in _RECETE_BAR_ES):
                            continue
                        anahtar = (kal["malzeme"], kal["birim"])
                        beklenen.setdefault(anahtar, {}).setdefault(gun_s, 0.0)
                        beklenen[anahtar][gun_s] += adet * kal["miktar"]
        # GERÇEK tüketim = ÜRÜN-AÇ DEFTERİ (operasyon_defter URUN_AC JSON yükü):
        # ambalaj ADEDİ sayılır. Reçete ml/g konuştuğu için köprü = recete_ambalaj
        # (1 ambalaj kaç ml/g). Ambalaj içeriği tanımsızsa fark HESAPLANMAZ —
        # iki sayı yan yana dürüstçe verilir (uydurma yok).
        import json as _json
        _dec = _json.JSONDecoder()

        def _payload(a: str):
            try:
                i = a.index("URUN_AC_JSON:") + len("URUN_AC_JSON:")
                obj, _ = _dec.raw_decode(a[i:])
                return obj if isinstance(obj, dict) else None
            except Exception:  # noqa: BLE001
                return None

        cur.execute(
            """SELECT tarih::date::text AS gun,
                      REPLACE(aciklama,'URUN_KULLANIMA_AL_JSON:','URUN_AC_JSON:') AS aciklama
               FROM operasyon_defter
               WHERE etiket IN ('URUN_AC','URUN_KULLANIMA_AL')
                 AND NOT (etiket='URUN_AC' AND aciklama LIKE %s)
                 AND tarih >= %s""",
            ("%[BİTTİ]%", str(bugun - timedelta(days=g))),
        )
        try:
            from operasyon_stok_motor import depo_kalem_kodu_resolve as _resolve
        except Exception:  # noqa: BLE001
            _resolve = None
        acilan: Dict[str, Dict[str, float]] = {}  # kalem_kodu → {gun: ambalaj adedi}

        def _acilan_ekle(kod: str, gun_s: str, adet: float) -> None:
            acilan.setdefault(kod, {}).setdefault(gun_s, 0.0)
            acilan[kod][gun_s] += adet

        for row in cur.fetchall() or []:
            r = dict(row)
            p = _payload(str(r["aciklama"] or ""))
            if not p:
                continue
            # delta anahtarları = havuz kodları (doğrudan kalem_kodu — dörtgen deseni)
            for kod, v in (p.get("delta") or {}).items():
                try:
                    adet = float(v or 0)
                except (TypeError, ValueError):
                    continue
                if adet > 0:
                    _acilan_ekle(str(kod), r["gun"], adet)
            # kalemler = ürün id/ad → depo kalem koduna çözümlenir (dörtgen deseni)
            for kal in (p.get("kalemler") or []):
                try:
                    adet = float(kal.get("adet") or 0)
                except (TypeError, ValueError):
                    continue
                if adet <= 0:
                    continue
                uid = str(kal.get("urun_id") or "").strip()
                uad = str(kal.get("urun_ad") or "").strip()
                kod = ""
                if _resolve and uid:
                    try:
                        kod = _resolve(cur, uid, uad) or ""
                    except Exception:  # noqa: BLE001
                        kod = ""
                if kod:
                    _acilan_ekle(kod, r["gun"], adet)
        cur.execute("SELECT kalem_kodu, icerik, birim, varsayim FROM recete_ambalaj")
        ambalaj = {dict(r)["kalem_kodu"]: dict(r) for r in cur.fetchall() or []}
    # ── DEVİR-BİLİNÇLİ GERÇEK (kullanıcı düzeltmesi 2026-07-08): bardak/süt bir önceki
    # günden DEVİRLE gelir — ham 'açılan' günlük tüketim DEĞİLDİR. Kullanılan Ürünler
    # hesabı (ops_bar_ozet.satilan = açılış + ürün-aç − kapanış) devri zaten çözer;
    # bar sayımında izlenen malzemeler için gerçek taraf ORADAN okunur.
    _BAR_ES = _RECETE_BAR_ES
    bar_gercek: Dict[tuple, float] = {}   # (bar_key, gun) → satilan toplam (şubeler)
    bar_gecici: set = set()               # kapanışı henüz kesinleşmemiş günler
    try:
        from operasyon_merkez_api import ops_bar_ozet
        aylar = {str(bugun - timedelta(days=i))[:7] for i in range(g + 1)}
        for ay in sorted(aylar):
            try:
                rows = ops_bar_ozet(sube_id=None, year_month=ay, gun=None,
                                    limit=365, kapanis_fallback=True,
                                    evo_yenile=False).get("satirlar") or []
            except Exception as e:  # noqa: BLE001
                logger.warning("recete kontrol bar-ozet %s okunamadi: %s", ay, str(e)[:100])
                continue
            for r in rows:
                gun_s = str(r.get("tarih") or "")
                if not gun_s or gun_s < str(bugun - timedelta(days=g)):
                    continue
                if not r.get("kapanis_gercek"):
                    bar_gecici.add(gun_s)
                for bk, sat in (r.get("satilan") or {}).items():
                    try:
                        bar_gercek[(bk, gun_s)] = bar_gercek.get((bk, gun_s), 0.0) + float(sat or 0)
                    except (TypeError, ValueError):
                        continue
    except Exception as e:  # noqa: BLE001
        logger.warning("recete kontrol bar-ozet modulu yok: %s", str(e)[:100])

    with db() as (_, cur):
        sonuc = []
        for (malzeme, birim), gunler in beklenen.items():
            bar_bilgi = _BAR_ES.get(malzeme)
            if bar_bilgi:
                bk, icerik, _ib = bar_bilgi
                for gun_s, bek in sorted(gunler.items()):
                    sat = bar_gercek.get((bk, gun_s))
                    satir = {"malzeme": malzeme, "birim": birim, "gun": gun_s,
                             "beklenen_miktar": round(bek, 1),
                             "kaynak": "bar_sayim_devirli"}
                    if sat is not None:
                        ger = sat * icerik
                        satir["gercek_miktar"] = round(ger, 1)
                        satir["fark"] = round(ger - bek, 1)
                        satir["fark_yuzde"] = round((ger - bek) / bek * 100, 1) if bek else None
                        if gun_s in bar_gecici:
                            satir["kapanis_gecici"] = True
                    else:
                        satir["fark"] = None
                        satir["eksik"] = "bar_sayim_yok"
                    sonuc.append(satir)
                continue
            kodlar = malzeme_es.get(malzeme) or []
            for gun_s, bek in sorted(gunler.items()):
                toplam_adet = 0.0
                adet_var = False
                ger = 0.0
                ger_tam = True  # tüm açılan kodların ambalaj içeriği biliniyor mu
                varsayimli = False
                for kod in kodlar:
                    adet = (acilan.get(kod) or {}).get(gun_s)
                    if adet is None:
                        continue
                    adet_var = True
                    toplam_adet += adet
                    amb = ambalaj.get(kod)
                    if amb:
                        ger += adet * float(amb["icerik"])
                        if amb.get("varsayim"):
                            varsayimli = True
                    else:
                        ger_tam = False
                satir = {"malzeme": malzeme, "birim": birim, "gun": gun_s,
                         "beklenen_miktar": round(bek, 1),
                         "acilan_ambalaj": (toplam_adet if adet_var else None)}
                if adet_var and ger_tam:
                    satir["gercek_miktar"] = round(ger, 1)
                    satir["fark"] = round(ger - bek, 1)
                    satir["fark_yuzde"] = round((ger - bek) / bek * 100, 1) if bek else None
                    if varsayimli:
                        satir["ambalaj_varsayim"] = True
                else:
                    satir["fark"] = None
                    satir["eksik"] = ("urun_ac_kaydi_yok" if not adet_var
                                      else "ambalaj_icerigi_tanimsiz")
                sonuc.append(satir)
    return {
        "kesit_gun": g,
        "onayli_urun_es": len(urun_es), "onayli_malzeme_es": len(malzeme_es),
        "kiyas": sonuc[:100],
        "not": "GÖZLEMDİR, hüküm değil: beklenen=Evo satış × reçete (çevrimler "
               "/parametreler'de, varsayım olabilir); gerçek=ürün-aç defteri × ambalaj "
               "içeriği (/ambalajlar). Fark ± fire/işçilik payı normaldir; KALICI ve "
               "TEK YÖNLÜ fark insanın bakacağı yerdir. Ürün-aç stok/maliyet akışı "
               "DEĞİŞMEDİ — reçete yalnız kontrol eder.",
    }


@router.get("/ambalajlar")
def ambalajlar():
    """Kalem başına 1 ambalajın içeriği (ml/g). Kontrol köprüsü: ürün-aç ADET sayar,
    reçete ml/g konuşur. varsayim=true satırlar kullanıcı teyidi bekler."""
    with db() as (_, cur):
        _ensure(cur)
        cur.execute("""SELECT kalem_kodu, kalem_adi, icerik, birim, varsayim
                       FROM recete_ambalaj ORDER BY kalem_adi""")
        rows = [dict(r) for r in cur.fetchall() or []]
        for r in rows:
            r["icerik"] = float(r["icerik"])
        return {"ambalajlar": rows}


@router.post("/ambalaj")
def ambalaj_kaydet(payload: dict):
    """Ambalaj içeriği tanımla/güncelle: {kalem_kodu, icerik, birim, kalem_adi?}.
    Kullanıcı eliyle girilen değer varsayim=FALSE olur (teyitli)."""
    kod = str(payload.get("kalem_kodu") or "").strip()
    icerik = payload.get("icerik")
    birim = str(payload.get("birim") or "").strip()
    if not kod or icerik is None or birim not in ("ml", "g", "adet"):
        raise HTTPException(400, "kalem_kodu + icerik + birim(ml|g|adet) zorunlu")
    varsayim = bool(payload.get("varsayim", False))
    with db() as (conn, cur):
        _ensure(cur)
        cur.execute(
            """INSERT INTO recete_ambalaj (kalem_kodu, kalem_adi, icerik, birim, varsayim)
               VALUES (%s,%s,%s,%s,%s)
               ON CONFLICT (kalem_kodu) DO UPDATE
               SET icerik=EXCLUDED.icerik, birim=EXCLUDED.birim,
                   varsayim=EXCLUDED.varsayim,
                   kalem_adi=COALESCE(NULLIF(EXCLUDED.kalem_adi,''), recete_ambalaj.kalem_adi)""",
            (kod, str(payload.get("kalem_adi") or "")[:80], float(icerik), birim, varsayim))
        conn.commit()
    return {"ok": True, "kalem_kodu": kod, "icerik": float(icerik),
            "birim": birim, "varsayim": varsayim}
