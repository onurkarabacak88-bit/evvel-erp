"""📒 EVVEL YENİ · ŞUBE OLAY DEFTERİ (2026-10-16) — panel artık YENİ ALANA da yazar.

Sahip: "Panel yeni alana da yazsın." · "Hata olursa panelde TEKRAR DENE uyarısı görünsün."
Codex planı: (a) mevcut panel uçlarında ÇİFT YAZIM → okuyucular yeni deftere taşınır → 1 Kasım'dan sonra yalnız yeni.

Kurallar:
  · TEK tablo (ey_sube_olay). Kasa para defteri (para_izi_hareket) ayrı kalır; bu defter panelin HAM olaylarıdır.
  · SİLME/DEĞİŞTİRME YOK: düzeltme = aynı 'kok' altında yeni sürüm; geri alma/iptal = 'iptal' türünde yeni olay.
  · TEKİLLİK: kaynak_ref = tür:kaynak:kimlik:içerik_özeti → aynı istek tekrar gelirse İKİNCİ KEZ yazılmaz;
    içerik değiştiyse (yeniden kapanış) aynı kök altında yeni sürüm olur.
  · PANELİN TRANSACTION'INDA, aynı imleçle. Yazılamazsa HTTP 503 → panel "Kaydedilemedi, tekrar deneyin" gösterir
    ve eski tabloya da HİÇBİR ŞEY yazılmaz (yarım kayıt yok).
  · Tablo, panel işlemlerinden ÖNCE uygulama açılırken kurulur (panelin transaction'ında DDL çalıştırılmaz).
"""

import hashlib
import json
import logging
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Optional

from fastapi import APIRouter, HTTPException

log = logging.getLogger(__name__)
_HAZIR = False

TEKRAR_DENE = "Evvel Yeni kaydı yapılamadı — lütfen TEKRAR DENEYİN (hiçbir şey kaydedilmedi)."


def _json_def(o):
    if isinstance(o, Decimal):
        return float(o)
    if isinstance(o, (date, datetime)):
        return o.isoformat()
    return str(o)


def olay_tablosu_kur() -> bool:
    """Uygulama açılışında KENDİ bağlantısıyla çağrılır (main.py). Panel transaction'ında DDL yok."""
    global _HAZIR
    if _HAZIR:
        return True
    from database import db
    try:
        with db() as (conn, cur):
            cur.execute("SET LOCAL lock_timeout = '5s'")
            cur.execute("""CREATE TABLE IF NOT EXISTS ey_sube_olay (
                id           TEXT PRIMARY KEY,
                sube_id      TEXT NOT NULL,
                tur          TEXT NOT NULL,
                is_gunu      DATE NOT NULL,
                olay_zamani  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
                kok          TEXT NOT NULL,
                surum        INTEGER NOT NULL DEFAULT 1,
                kaynak_ref   TEXT NOT NULL UNIQUE,
                kaynak_tablo TEXT,
                kaynak_id    TEXT,
                personel_id  TEXT,
                personel_ad  TEXT,
                tutar_kurus  BIGINT,
                veri         JSONB NOT NULL DEFAULT '{}'::jsonb,
                hedef_kok    TEXT,
                neden        TEXT,
                sema_surumu  INTEGER NOT NULL DEFAULT 1)""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_ey_sube_olay_gun ON ey_sube_olay (sube_id, is_gunu, tur)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_ey_sube_olay_kok ON ey_sube_olay (kok, surum)")
        _HAZIR = True
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("evvel-yeni olay defteri kurulamadı: %s", str(e)[:200])
        return False


def _kurus(x) -> Optional[int]:
    if x is None:
        return None
    return int((Decimal(str(x)) * 100).quantize(Decimal("1")))


def olay_yaz(cur, *, sube_id: Any, tur: str, is_gunu: Any, kok: str, veri: dict, kaynak_tablo: Optional[str] = None,
             kaynak_id: Any = None, tutar: Any = None, personel_id: Any = None, personel_ad: Optional[str] = None,
             hedef_kok: Optional[str] = None, neden: Optional[str] = None) -> Optional[str]:
    """Panelin işlemiyle AYNI transaction'da olay yazar. Başarısızsa HTTP 503 (panel 'tekrar dene' der, hepsi geri alınır)."""
    import uuid
    if not _HAZIR and not olay_tablosu_kur():
        raise HTTPException(503, TEKRAR_DENE)
    try:
        govde = json.dumps(veri or {}, ensure_ascii=False, sort_keys=True, default=_json_def)
        ozet = hashlib.sha1(f"{tutar}|{hedef_kok}|{govde}".encode("utf-8")).hexdigest()[:16]
        ref = f"{kok}:{ozet}"
        cur.execute("SELECT 1 FROM ey_sube_olay WHERE kaynak_ref=%s", (ref,))
        if cur.fetchone():
            return None   # aynı istek tekrar geldi — ikinci kez yazılmaz
        cur.execute("SELECT COALESCE(MAX(surum), 0) AS s FROM ey_sube_olay WHERE kok=%s", (kok,))
        surum = int(dict(cur.fetchone() or {}).get("s") or 0) + 1
        gun = is_gunu.isoformat() if hasattr(is_gunu, "isoformat") else str(is_gunu)[:10]
        oid = str(uuid.uuid4())
        cur.execute("""INSERT INTO ey_sube_olay (id, sube_id, tur, is_gunu, kok, surum, kaynak_ref, kaynak_tablo, kaynak_id,
                                                  personel_id, personel_ad, tutar_kurus, veri, hedef_kok, neden)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s)""",
                    (oid, str(sube_id), tur, gun, kok, surum, ref, kaynak_tablo, None if kaynak_id is None else str(kaynak_id),
                     None if personel_id is None else str(personel_id), (personel_ad or None), _kurus(tutar), govde,
                     hedef_kok, (neden or None)))
        return oid
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        log.error("evvel-yeni olay yazılamadı (%s %s): %s", tur, kok, str(e)[:300])
        raise HTTPException(503, TEKRAR_DENE)


def olaylar(cur, sube_id: Optional[str] = None, bas: Any = None, son: Any = None, turler=None) -> list:
    """Okuyucu: her KÖKÜN son sürümü; iptal edilmiş kökler 'iptal=True' işaretli."""
    q = "SELECT * FROM ey_sube_olay WHERE 1=1"
    p = []
    if sube_id:
        q += " AND sube_id=%s"
        p.append(str(sube_id))
    if bas:
        q += " AND is_gunu >= %s"
        p.append(bas)
    if son:
        q += " AND is_gunu <= %s"
        p.append(son)
    cur.execute(q + " ORDER BY olay_zamani", p)
    rows = [dict(r) for r in cur.fetchall() or []]
    iptal = {}   # kök → en son iptal anı (iptalden SONRA gelen yeni sürüm geçerlidir: geri al → yeniden kapat)
    for r in rows:
        if r["tur"] == "iptal" and r.get("hedef_kok"):
            iptal[r["hedef_kok"]] = max(iptal.get(r["hedef_kok"], r["olay_zamani"]), r["olay_zamani"])
    son_surum = {}
    for r in rows:
        if r["tur"] == "iptal":
            continue
        if r["kok"] not in son_surum or r["surum"] > son_surum[r["kok"]]["surum"]:
            son_surum[r["kok"]] = r
    out = []
    for r in son_surum.values():
        if turler and r["tur"] not in turler:
            continue
        r["iptal"] = r["kok"] in iptal and iptal[r["kok"]] >= r["olay_zamani"]
        out.append(r)
    out.sort(key=lambda r: r["olay_zamani"])
    return out


# ── DOĞRULAMA: eski tablo ↔ yeni defter (Codex: "adet/kuruş farkı 0") ──
router = APIRouter(prefix="/api/evvel-yeni/olay", tags=["evvel-yeni-olay"])


@router.get("/kontrol")
def olay_kontrol(gun: str, baslangic_ts: Optional[str] = None):
    """Seçilen günün panel işlemleri eski tablolarda kaç tane/kaç ₺ — yeni defterde kaç tane/kaç ₺.
    baslangic_ts: çift yazımın açıldığı an, TÜRKİYE duvar saati (eski tablolar TR saatiyle tutuluyor — Fable).
    Çift yazım: 1. kısım 2026-10-16T11:47, 2. kısım (ürün aç/fire/açılış) 2026-10-16T12:30 (TR)."""
    from database import db
    olay_tablosu_kur()
    bas = baslangic_ts or "1970-01-01"
    with db() as (conn, cur):
        eski = {}
        cur.execute("""SELECT COUNT(*) n, COALESCE(SUM(NULLIF(meta::jsonb->'x_rapor'->>'nakit','')::numeric),0) t FROM sube_operasyon_event
                        WHERE tarih=%s AND tip='KAPANIS' AND durum='tamamlandi' AND cevap_ts >= %s::timestamp""", (gun, bas))
        eski["kapanis"] = dict(cur.fetchone())
        cur.execute("""SELECT COUNT(*) n, COALESCE(SUM(tutar),0) t FROM kasa_teslim
                        WHERE tarih=%s AND olusturma >= %s::timestamp
                          AND NOT (teslim_turu='gun_sonu' AND COALESCE(aciklama,'') LIKE 'Kapanış otomatik%%')""", (gun, bas))
        eski["teslim"] = dict(cur.fetchone())
        cur.execute("""SELECT COUNT(*) n, COALESCE(SUM(tutar),0) t FROM anlik_giderler
                        WHERE tarih=%s AND odeme_yontemi='nakit' AND COALESCE(kaynak_tablo,'') <> 'personel_avans'
                          AND id NOT LIKE 'avans_%%' AND olusturma >= %s::timestamp""", (gun, bas))
        eski["gider"] = dict(cur.fetchone())
        for et, t in (("URUN_AC", "urun_ac_hepsi"), ("URUN_KULLANIMA_AL", "urun_kullanima_al"),
                      ("URUN_STOK_EKLE", "stok_ekle"), ("SUBE_FIRE", "fire")):
            cur.execute("""SELECT COUNT(*) n, 0 t FROM operasyon_defter WHERE tarih=%s AND etiket=%s AND olay_ts >= %s::timestamp""",
                        (gun, et, bas))
            eski[t] = dict(cur.fetchone())
        cur.execute("""SELECT COUNT(*) n, COALESCE(SUM(kasa_sayim),0) t FROM sube_operasyon_event
                        WHERE tarih=%s AND tip='ACILIS' AND durum='tamamlandi' AND cevap_ts >= %s::timestamp""", (gun, bas))
        eski["acilis"] = dict(cur.fetchone())
        yeni = {}
        cur.execute("""SELECT COUNT(DISTINCT kok) n, 0 t FROM ey_sube_olay WHERE is_gunu=%s AND tur IN ('urun_ac','urun_bitti')""", (gun,))
        yeni["urun_ac_hepsi"] = dict(cur.fetchone())
        for t in ("kapanis", "teslim", "gider", "avans", "iptal", "urun_kullanima_al", "stok_ekle", "fire", "acilis"):
            cur.execute("""SELECT COUNT(DISTINCT kok) n, COALESCE(SUM(tutar_kurus) FILTER (WHERE surum=1),0)/100.0 t
                             FROM ey_sube_olay WHERE is_gunu=%s AND tur=%s""", (gun, t))
            yeni[t] = dict(cur.fetchone())
    f = lambda d: {"adet": int(d["n"]), "tutar": float(d["t"])}  # noqa: E731
    sonuc = {k: {"eski": f(eski[k]) if k in eski else None, "yeni": f(yeni[k])} for k in yeni}
    for k, v in sonuc.items():
        v["tutuyor"] = v["eski"] is None or v["eski"]["adet"] == v["yeni"]["adet"]
    return {"gun": gun, "karsilastirma": sonuc, "not": "Eski tablo satırı (çift yazım başladıktan sonra) = yeni defter kökü olmalı."}
