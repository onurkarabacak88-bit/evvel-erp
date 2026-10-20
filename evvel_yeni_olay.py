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
    from database import db, savepoint
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
            cur.execute("CREATE INDEX IF NOT EXISTS idx_ey_sube_olay_hedef ON ey_sube_olay (hedef_kok) WHERE hedef_kok IS NOT NULL")
            try:   # Fable (altyapı #11): aynı kök + sürüm iki kez olamaz (eşzamanlı yazım). Eski çakışan satır varsa kilit yine korur.
                with savepoint(cur, "sp_ey_olay_ux"):
                    cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_ey_sube_olay_kok_surum ON ey_sube_olay (kok, surum)")
            except Exception:  # noqa: BLE001
                log.warning("ux_ey_sube_olay_kok_surum kurulamadı (eski çakışma) — kök kilidi korur")
        _HAZIR = True
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("evvel-yeni olay defteri kurulamadı: %s", str(e)[:200])
        return False


def _kurus(x) -> Optional[int]:
    """Olay tutarı → kuruş (yuvarlayarak; None kalır) — çekirdeğin TEK kuralı (Dalga 4, F#5)."""
    from evvel_yeni_cekirdek import kurus_yuvarla
    return None if x is None else kurus_yuvarla(x)


def olay_yaz(cur, *, sube_id: Any, tur: str, is_gunu: Any, kok: str, veri: dict, kaynak_tablo: Optional[str] = None,
             kaynak_id: Any = None, tutar: Any = None, personel_id: Any = None, personel_ad: Optional[str] = None,
             hedef_kok: Optional[str] = None, neden: Optional[str] = None, sema_surumu: int = 1) -> Optional[str]:
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
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("ey_olay_kok:" + kok,))   # Fable: MAX+1 yarışı (eski panel kilitsiz yazıyordu)
        cur.execute("SELECT COALESCE(MAX(surum), 0) AS s FROM ey_sube_olay WHERE kok=%s", (kok,))
        surum = int(dict(cur.fetchone() or {}).get("s") or 0) + 1
        gun = is_gunu.isoformat() if hasattr(is_gunu, "isoformat") else str(is_gunu)[:10]
        oid = str(uuid.uuid4())
        cur.execute("""INSERT INTO ey_sube_olay (id, sube_id, tur, is_gunu, kok, surum, kaynak_ref, kaynak_tablo, kaynak_id,
                                                  personel_id, personel_ad, tutar_kurus, veri, hedef_kok, neden, sema_surumu)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s)""",
                    (oid, str(sube_id), tur, gun, kok, surum, ref, kaynak_tablo, None if kaynak_id is None else str(kaynak_id),
                     None if personel_id is None else str(personel_id), (personel_ad or None), _kurus(tutar), govde,
                     hedef_kok, (neden or None), int(sema_surumu or 1)))
        return oid
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        log.error("evvel-yeni olay yazılamadı (%s %s): %s", tur, kok, str(e)[:300])
        raise HTTPException(503, TEKRAR_DENE)


# ── PUBLIC küçük kapılar (tekrar denetimi F#25 / C-T2-13: panel ey_sube_olay'a ham SQL atıyordu — tablo şeması tek yerde) ──
def kok_durumu(cur, kok: str) -> dict:
    """{son: kökün en son (iptal olmayan) olay zamanı, iptal: o köke yazılmış en son iptal zamanı} — sürüm/iptal kararı için."""
    cur.execute("""SELECT (SELECT MAX(olay_zamani) FROM ey_sube_olay WHERE kok=%s AND tur<>'iptal') AS son,
                          (SELECT MAX(olay_zamani) FROM ey_sube_olay WHERE hedef_kok=%s AND tur='iptal') AS iptal""", (kok, kok))
    return dict(cur.fetchone() or {})


def kok_var(cur, kok: str) -> bool:
    cur.execute("SELECT 1 FROM ey_sube_olay WHERE kok=%s LIMIT 1", (kok,))
    return cur.fetchone() is not None


def olay_veri_ekle(cur, olay_id: Optional[str], ek: dict) -> None:
    """Yazılmış olayın verisine EK alan (uyarılar, sorumlu…) — kaynak_ref ilk veriden üretildiği için oynak alanlar sonra eklenir."""
    if not olay_id:
        return
    cur.execute("UPDATE ey_sube_olay SET veri = veri || %s::jsonb WHERE id=%s", (json.dumps(ek, ensure_ascii=False, default=str), olay_id))


def yakin_ayni_olay(cur, *, sube_id: str, tur: str, veri_alan: str, deger: str, dakika: int, istek_haric: Optional[str] = None) -> bool:
    """Son N dakikada aynı şubede aynı türde, verisinin bir alanı aynı olan BAŞKA istekli olay var mı (çift basış kilidi)."""
    cur.execute("""SELECT 1 FROM ey_sube_olay WHERE sube_id=%s AND tur=%s AND veri->>%s=%s
                     AND olay_zamani > NOW() - make_interval(mins => %s) AND COALESCE(veri->>'istek_id','') <> %s LIMIT 1""",
                (str(sube_id), tur, veri_alan, str(deger), int(dakika), istek_haric or ""))
    return cur.fetchone() is not None


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


# ── PUBLIC (Dalga 4, F#11/F#12): "yeni panelin iptal edilmemiş olayları" süzgeci 10 yerde, "gün kapandı mı" 3 yerde ayrı yazılıydı ──
def panel_olaylari(cur, sube_id: Optional[str] = None, bas: Any = None, son: Any = None, turler=None) -> list:
    """Yeni şube panelinin (kaynak 'panel') İPTAL EDİLMEMİŞ olayları; her birine açılmış veri 'v' (sözlük) eklenir."""
    out = []
    for o in olaylar(cur, sube_id=sube_id, bas=bas, son=son, turler=turler):
        if o.get("iptal") or (o.get("kaynak_tablo") or "") != "panel":
            continue
        v = o.get("veri")
        out.append({**o, "v": v if isinstance(v, dict) else json.loads(v or "{}")})
    return out


def gun_kapandi(cur, sube_id: str, gun) -> bool:
    """Şubenin o iş günü için panel KAPANIŞ olayı var mı (iptal edilmemiş) — gün kapalıysa ürün aç / fire / devir yazılmaz (D7)."""
    return bool(panel_olaylari(cur, sube_id=sube_id, bas=gun, son=gun, turler={"kapanis"}))

