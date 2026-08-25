"""
BAKIŞ ÖLÇÜM — "ekran işe yarıyor mu?" sorusunun TEK cevap yeri. İZOLE.

── NEDEN VAR (2026-08-26, BAKIŞ yeniden kurgusu) ────────────────────────────
BAKIŞ ekranı "envanter"den "iş kuyruğu"na çevrildi. Ama bir tasarım değişikliği
"daha iyi oldu" diye İDDİA EDİLEMEZ, ÖLÇÜLMESİ gerekir. Ölçmeden yapılan her
düzeltme bir zevk beyanıdır; ölçülen düzeltme bir mühendislik kararıdır.

Ölçtüğümüz asıl şey şu: sahip ekranı açıp KAPATIYOR mu, yoksa BİR İŞ YAPIYOR mu?
Eski ekranın kusuru rakamlarının yanlışlığı değildi — iş üretmemesiydi. O yüzden
metrikler "kaç tıklama" değil, "ilk anlamlı eyleme kaç saniye" ve "hiç dokunmadan
çıkma oranı" üzerine kurulu.

── İZOLASYON (feedback_duyu_izole_toplayici_kurali) ─────────────────────────
  · KENDİ tablolarına yazar (bakis_oturum, bakis_kuyruk_izi). Başka hiçbir
    tabloya DOKUNMAZ — ne okur ne yazar. Tam anlamıyla tek yönlü.
  · Tüm uçlar HATA YUTAR: ölçüm çökerse ekran çalışmaya devam eder. Ölçüm aleti
    ölçtüğü şeyi bozamaz.
  · main.py'ye try/except ile takılır; modül patlasa da uygulama ayakta kalır.
  · Rapor ucu SALT OKUR.

── METRİKLER ────────────────────────────────────────────────────────────────
  M1 · İlk anlamlı eyleme süre (medyan sn) — ekran ne kadar çabuk işe döküyor
  M2 · Boş çıkış oranı — hiç dokunulmadan kapanan oturum payı (ASIL METRİK)
  M3 · Madde ömrü (medyan gün) — kuyruğa giren iş kaç günde veriden düşüyor
  M4 · Kronik kuyruk — 7 günden uzun süredir kuyrukta duran madde sayısı
  M5 · S1 (ölçüm bozuk) isabeti — ölçüm maddeleri 7 gün içinde kapanıyor mu

⚠️ M3–M5 KUYRUK İZİNDEN türer: ekran her açılışta O ANKİ kuyruğun madde
anahtarlarını bildirir; sunucu ilk/son görülme damgasını tutar. Madde kaybolunca
"kapandı" sayılır — çünkü kuyruk maddesi ELLE kapatılmaz, VERİDEN düşer.

⚠️ NEDEN "kapanma" ayrı bir olay değil: elle kapatma düğmesi koysaydık sahip
uyarıyı okumadan susturabilirdi ve ölçüm de yalan söylerdi. Kaybolma = gerçek.
"""
from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter
from pydantic import BaseModel

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/bakis-olcum", tags=["bakis-olcum"])


def _tablolar(cur) -> None:
    """Modülün KENDİ tabloları — lazy ensure, idempotent, izole."""
    # 1) OTURUM — bir ekran açılışı ve ilk anlamlı eylemi (M1, M2)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS bakis_oturum (
            id             BIGSERIAL PRIMARY KEY,
            acilis_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            gorunum        TEXT,
            ilk_eylem_ts   TIMESTAMPTZ,
            ilk_eylem_tur  TEXT,
            kuyruk_adet    INTEGER
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_bakis_oturum_ts "
                "ON bakis_oturum (acilis_ts DESC)")
    # 2) KUYRUK İZİ — hangi madde ne zaman göründü, ne zaman kayboldu (M3-M5)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS bakis_kuyruk_izi (
            madde_anahtari TEXT PRIMARY KEY,
            sinif          SMALLINT,
            ilk_gorulme    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            son_gorulme    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)


class AcilisBody(BaseModel):
    gorunum: Optional[str] = None
    kuyruk: Optional[List[str]] = None        # madde anahtarları
    kuyruk_sinif: Optional[List[int]] = None  # aynı sırayla sınıfları


@router.post("/acilis")
def acilis(body: AcilisBody):
    """📥 Ekran açıldı — oturum aç + o anki kuyruğu damgala. HATA YUTAR.

    Dönen `oturum_id` ile sahip ilk anlamlı eylemi yaptığında /eylem çağrılır.
    Hiç çağrılmazsa oturum "boş çıkış" olarak kalır — M2 tam olarak budur.
    """
    try:
        with db() as (conn, cur):
            _tablolar(cur)
            anahtarlar = [str(x)[:180] for x in (body.kuyruk or [])][:40]
            siniflar = list(body.kuyruk_sinif or [])
            cur.execute(
                "INSERT INTO bakis_oturum (gorunum, kuyruk_adet) VALUES (%s,%s) RETURNING id",
                ((body.gorunum or "")[:40], len(anahtarlar)))
            oid = int(dict(cur.fetchone() or {}).get("id") or 0)
            # Kuyruk izi: yeni madde ilk_gorulme ile doğar, mevcut madde
            # son_gorulme'si tazelenir. Kaybolan maddeye DOKUNULMAZ — son
            # damgası olduğu yerde kalır, ömrü oradan okunur.
            for i, a in enumerate(anahtarlar):
                s = siniflar[i] if i < len(siniflar) else None
                cur.execute(
                    "INSERT INTO bakis_kuyruk_izi (madde_anahtari, sinif) VALUES (%s,%s) "
                    "ON CONFLICT (madde_anahtari) DO UPDATE SET son_gorulme = NOW()",
                    (a, s))
            conn.commit()
        return {"ok": True, "oturum_id": oid}
    except Exception as e:  # noqa: BLE001 — ölçüm ekranı ASLA bozmaz
        logger.warning("bakis-olcum acilis yazilamadi: %s", str(e)[:160])
        return {"ok": False, "oturum_id": None}


class EylemBody(BaseModel):
    oturum_id: int
    tur: Optional[str] = None     # cekmece | kopru | kuyruk | katman


@router.post("/eylem")
def eylem(body: EylemBody):
    """👆 İlk ANLAMLI eylem — yalnız İLKİ yazılır (M1 medyanı bundan çıkar).

    ⚠️ `ilk_eylem_ts IS NULL` koşulu şart: ikinci tıklama ilkini ezseydi
    "ilk eyleme süre" değil "son eyleme süre" ölçerdik ve metrik sessizce
    başka bir şeyi ölçmeye başlardı.
    """
    try:
        with db() as (conn, cur):
            _tablolar(cur)
            cur.execute(
                "UPDATE bakis_oturum SET ilk_eylem_ts = NOW(), ilk_eylem_tur = %s "
                " WHERE id = %s AND ilk_eylem_ts IS NULL",
                ((body.tur or "")[:40], int(body.oturum_id)))
            conn.commit()
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        logger.warning("bakis-olcum eylem yazilamadi: %s", str(e)[:160])
        return {"ok": False}


@router.get("/ozet")
def ozet(gun: int = 30):
    """📊 M1–M5 — SALT OKUR. Veri yetersizse SAYI UYDURULMAZ, "yetersiz" denir.

    ⚠️ Az örnekten medyan çıkarmak sahte kesinliktir: 3 oturumluk "medyan 4 sn"
    ölçüm değil gürültüdür. Eşik altında metrik `null` döner ve kaç örnek
    gerektiği söylenir — böylece sahip rakamın olgunluğunu bilir.
    """
    g = max(1, min(365, int(gun or 30)))
    ESIK = 10  # bu sayıdan az oturumda medyan yazılmaz
    try:
        with db() as (_, cur):
            _tablolar(cur)
            cur.execute(
                "SELECT COUNT(*) AS n, "
                "       COUNT(*) FILTER (WHERE ilk_eylem_ts IS NULL) AS bos, "
                "       PERCENTILE_CONT(0.5) WITHIN GROUP ( "
                "         ORDER BY EXTRACT(EPOCH FROM (ilk_eylem_ts - acilis_ts)) "
                "       ) FILTER (WHERE ilk_eylem_ts IS NOT NULL) AS m1 "
                "  FROM bakis_oturum WHERE acilis_ts >= NOW() - make_interval(days => %s)", (g,))
            o = dict(cur.fetchone() or {})
            cur.execute(
                "SELECT PERCENTILE_CONT(0.5) WITHIN GROUP ( "
                "         ORDER BY EXTRACT(EPOCH FROM (son_gorulme - ilk_gorulme))/86400.0) AS m3, "
                "       COUNT(*) FILTER (WHERE son_gorulme < NOW() - INTERVAL '1 day') AS kapanan, "
                "       COUNT(*) FILTER (WHERE son_gorulme >= NOW() - INTERVAL '1 day' "
                "                          AND ilk_gorulme < NOW() - INTERVAL '7 days') AS kronik, "
                "       COUNT(*) FILTER (WHERE sinif = 1 AND son_gorulme < NOW() - INTERVAL '1 day' "
                "                          AND son_gorulme - ilk_gorulme < INTERVAL '7 days') AS s1_hizli, "
                "       COUNT(*) FILTER (WHERE sinif = 1 AND son_gorulme < NOW() - INTERVAL '1 day') AS s1_kapanan "
                "  FROM bakis_kuyruk_izi")
            k = dict(cur.fetchone() or {})
    except Exception as e:  # noqa: BLE001
        logger.warning("bakis-olcum ozet okunamadi: %s", str(e)[:160])
        return {"ok": False, "hata": "ölçüm okunamadı"}

    n = int(o.get("n") or 0)
    bos = int(o.get("bos") or 0)
    s1k = int(k.get("s1_kapanan") or 0)
    yeterli = n >= ESIK
    return {
        "gun": g,
        "oturum_sayisi": n,
        "yeterli_veri": yeterli,
        "esik": ESIK,
        "M1_ilk_eyleme_sn": (round(float(o["m1"]), 1)
                             if yeterli and o.get("m1") is not None else None),
        "M2_bos_cikis_orani": (round(bos * 100.0 / n, 1) if yeterli and n else None),
        "M3_madde_omru_gun": (round(float(k["m3"]), 1) if k.get("m3") is not None else None),
        "M4_kronik_madde": int(k.get("kronik") or 0),
        "M5_s1_isabet_orani": (round(int(k.get("s1_hizli") or 0) * 100.0 / s1k, 1)
                               if s1k else None),
        "not": ("M2 ASIL METRİKTİR: ekran iş üretiyorsa 'açıp hiç dokunmadan çıkma' "
                "oranı düşer. M1 hızı değil ERİŞİLEBİLİRLİĞİ ölçer — doğru iş üstte "
                "duruyorsa süre kısalır. M5 düşükse 'ölçüm bozuk' maddeleri "
                "kapanmıyor demektir: ya eşik yanlış ya eylem yolu yok. "
                f"{ESIK} oturumdan az veride medyan YAZILMAZ (sahte kesinlik yasağı)."),
    }
