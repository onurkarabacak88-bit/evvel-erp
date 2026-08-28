"""
OPS ÖLÇÜM — "iş kuyruğu işe yarıyor mu?" sorusunun TEK cevap yeri. İZOLE.

OPS akış ekranı 2026-08-27'de "kanban envanteri"nden "iş kuyruğu"na çevrildi
(BAKIŞ'ta 2026-08-26'da yapılan kurgunun aynısı). Ama bir tasarım değişikliği
kendi başarısını ilan edemez: kuyruk gerçekten iş ürettirdi mi, yoksa yeni bir
duvar kâğıdı mı oldu — bunu yalnız ÖLÇÜM söyler.

Ölçtüğümüz asıl şey: merkez ekranı açıp KAPATIYOR mu, yoksa BİR İŞE
GİRİYOR mu? Eski kanban'ın kusuru rakamlarının yanlışlığı değildi — hangi işin
önce yapılacağını söylememesiydi.

⚠️ NEDEN AYRI MODÜL (bakis_olcum'a yazılmadı):
`bakis_olcum_api.ozet` sorguları `gorunum`a göre SÜZMÜYOR. OPS oturumları oraya
yazılsaydı BAKIŞ'ın M1–M5 medyanları iki farklı ekranın davranışını tek kovada
birleştirirdi — bu oturum boyunca defalarca düzelttiğimiz "kapsam karışması"
tuzağının aynısı. Projenin kendi kuralı da bunu söylüyor: yeni ölçüm = İZOLE
tablo + append-only + hata-yutar.

⚠️ TASARIM KURALLARI (BAKIŞ'tan devralındı):
  · Tüm uçlar HATA YUTAR: ölçüm çökerse ekran çalışmaya devam eder. Ölçüm aleti
    ölçtüğü şeyi bozamaz.
  · Kuyruk maddesi ELLE KAPATILMAZ, veriden düşer — o yüzden "kapanma" ayrı bir
    olay değil, maddenin KAYBOLMASIDIR. Elle kapatma düğmesi koysaydık merkez
    işi yapmadan susturabilirdi ve ölçüm de yalan söylerdi.
  · Eşik altı veride medyan YAZILMAZ (sahte kesinlik yasağı).

METRİKLER
  M1 · İlk anlamlı eyleme süre (medyan sn) — kuyruk işi ne kadar çabuk
       erişilebilir kılıyor. Hız değil ERİŞİLEBİLİRLİK ölçer.
  M2 · Eylemsiz oturum oranı (%) — ASIL METRİK. Ekran açıldı, hiçbir işe
       girilmedi. Yüksekse kuyruk iş üretmiyor demektir.
  M3 · Madde ömrü (gün, medyan) — bir iş kuyrukta ne kadar duruyor.
  M4 · Kronik madde — 7 günden uzun süredir kuyruktan düşmeyen iş sayısı.
  M5 · S1 isabet oranı (%) — "karar bekleyen" maddeler gerçekten kapanıyor mu.
"""
from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter
from pydantic import BaseModel

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/ops-olcum", tags=["ops-olcum"])

ESIK = 10   # bu kadar oturumdan az veride medyan yazılmaz


def _tablolar(cur) -> None:
    """Modülün KENDİ tabloları — lazy ensure, idempotent, izole."""
    cur.execute("""
        CREATE TABLE IF NOT EXISTS ops_oturum (
            id             BIGSERIAL PRIMARY KEY,
            acilis_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            gorunum        TEXT,
            ilk_eylem_ts   TIMESTAMPTZ,
            ilk_eylem_tur  TEXT,
            kuyruk_adet    INTEGER
        )
    """)
    # ⚠️ `ekran` sütunu (2026-08-28): bu modül artık İKİ kuyruğa hizmet ediyor
    # (OPS akış + EKİP kadro). Üçüncü kez neredeyse aynı dosyayı kopyalamak
    # yerine tek modül genelleştirildi — AMA bu ancak SÜZGEÇ varsa doğrudur.
    # `bakis_olcum_api`nin kusuru paylaşması değil, SÜZMEMESİYDİ: iki ekranın
    # davranışı tek medyanda birleşiyordu. Burada her sorgu `ekran`a göre süzer.
    cur.execute("ALTER TABLE ops_oturum ADD COLUMN IF NOT EXISTS ekran TEXT DEFAULT 'ops'")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ops_oturum_ts "
                "ON ops_oturum (ekran, acilis_ts DESC)")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS ops_kuyruk_izi (
            madde_anahtari TEXT PRIMARY KEY,
            sinif          SMALLINT,
            ilk_gorulme    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            son_gorulme    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("ALTER TABLE ops_kuyruk_izi ADD COLUMN IF NOT EXISTS ekran TEXT DEFAULT 'ops'")


class AcilisBody(BaseModel):
    ekran: Optional[str] = "ops"          # ops | ekip — hangi kuyruğun ölçümü
    gorunum: Optional[str] = None
    kuyruk: Optional[List[str]] = None        # madde anahtarları
    kuyruk_sinif: Optional[List[int]] = None  # aynı sırayla sınıfları


@router.post("/acilis")
def acilis(body: AcilisBody):
    """📥 Ekran açıldı — oturum aç + o anki kuyruğu damgala. HATA YUTAR."""
    try:
        with db() as (conn, cur):
            _tablolar(cur)
            anahtarlar = [str(x)[:180] for x in (body.kuyruk or [])][:40]
            siniflar = list(body.kuyruk_sinif or [])
            ekran = (body.ekran or "ops")[:20]
            cur.execute(
                "INSERT INTO ops_oturum (ekran, gorunum, kuyruk_adet) VALUES (%s,%s,%s) RETURNING id",
                (ekran, (body.gorunum or "")[:40], len(anahtarlar)))
            oid = int(dict(cur.fetchone() or {}).get("id") or 0)
            for i, a in enumerate(anahtarlar):
                s = siniflar[i] if i < len(siniflar) else None
                # `sinif` DE güncellenir: bir iş sınıf değiştirirse (takılmış iş
                # karar bekleyene dönerse) eski kovada kalmamalı — yoksa M5
                # yanlış kovadan sayar (BAKIŞ'ta Codex'in yakaladığı kusur).
                cur.execute(
                    "INSERT INTO ops_kuyruk_izi (madde_anahtari, sinif, ekran) VALUES (%s,%s,%s) "
                    "ON CONFLICT (madde_anahtari) DO UPDATE "
                    "   SET son_gorulme = NOW(), sinif = COALESCE(EXCLUDED.sinif, ops_kuyruk_izi.sinif)",
                    (a, s, ekran))
            conn.commit()
        return {"ok": True, "oturum_id": oid}
    except Exception as e:  # noqa: BLE001 — ölçüm ekranı ASLA bozmaz
        logger.warning("ops-olcum acilis yazilamadi: %s", str(e)[:160])
        return {"ok": False, "oturum_id": None}


class EylemBody(BaseModel):
    oturum_id: int
    tur: Optional[str] = None     # kuyruk | cekmece | kopru | sekme


@router.post("/eylem")
def eylem(body: EylemBody):
    """👆 İlk ANLAMLI eylem — yalnız İLKİ yazılır (M1 medyanı bundan çıkar).

    ⚠️ `ilk_eylem_ts IS NULL` koşulu şart: ikinci tıklama ilkini ezseydi
    "ilk eyleme süre" değil "son eyleme süre" ölçerdik.
    """
    try:
        with db() as (conn, cur):
            _tablolar(cur)
            cur.execute(
                "UPDATE ops_oturum SET ilk_eylem_ts = NOW(), ilk_eylem_tur = %s "
                " WHERE id = %s AND ilk_eylem_ts IS NULL",
                ((body.tur or "")[:40], int(body.oturum_id)))
            conn.commit()
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        logger.warning("ops-olcum eylem yazilamadi: %s", str(e)[:160])
        return {"ok": False}


@router.get("/ozet")
def ozet(gun: int = 30, ekran: str = "ops"):
    """📊 Beş metrik — hepsi AYNI pencereden ve AYNI EKRANDAN.

    ⚠️ `ekran` süzgeci ŞART: iki farklı kuyruğun oturumları tek medyanda
    birleşirse metrik sessizce başka bir şeyi ölçmeye başlar. `bakis_olcum`un
    kusuru paylaşması değil SÜZMEMESİYDİ; bu modül tam o yüzden ayrılmıştı.
    """
    g = max(1, min(365, int(gun or 30)))
    e = (ekran or "ops")[:20]
    try:
        with db() as (conn, cur):
            _tablolar(cur)
            cur.execute(
                "SELECT COUNT(*) AS n, "
                "       COUNT(*) FILTER (WHERE ilk_eylem_ts IS NULL) AS bos, "
                "       PERCENTILE_CONT(0.5) WITHIN GROUP ( "
                "         ORDER BY EXTRACT(EPOCH FROM (ilk_eylem_ts - acilis_ts)) "
                "       ) FILTER (WHERE ilk_eylem_ts IS NOT NULL) AS m1 "
                "  FROM ops_oturum WHERE ekran = %s "
                "   AND acilis_ts >= NOW() - make_interval(days => %s)", (e, g))
            o = dict(cur.fetchone() or {})
            # ⚠️ M3–M5 de AYNI pencereden okunur; farklı ufuk birleştirmek
            # "son 30 gün" diyen bir özeti sessizce yalancı yapar.
            cur.execute(
                "SELECT PERCENTILE_CONT(0.5) WITHIN GROUP ( "
                "         ORDER BY EXTRACT(EPOCH FROM (son_gorulme - ilk_gorulme))/86400.0) AS m3, "
                "       COUNT(*) FILTER (WHERE son_gorulme >= NOW() - INTERVAL '1 day' "
                "                          AND ilk_gorulme < NOW() - INTERVAL '7 days') AS kronik, "
                "       COUNT(*) FILTER (WHERE sinif = 1 AND son_gorulme < NOW() - INTERVAL '1 day' "
                "                          AND (son_gorulme - ilk_gorulme) < INTERVAL '3 days') AS s1_hizli, "
                "       COUNT(*) FILTER (WHERE sinif = 1 AND son_gorulme < NOW() - INTERVAL '1 day') AS s1_kapanan "
                "  FROM ops_kuyruk_izi "
                " WHERE ekran = %s "
                "   AND ilk_gorulme >= NOW() - make_interval(days => %s)", (e, g))
            k = dict(cur.fetchone() or {})
    except Exception as e:  # noqa: BLE001
        logger.warning("ops-olcum ozet okunamadi: %s", str(e)[:160])
        return {"gun": g, "ekran": e, "hata": "ölçüm okunamadı", "oturum_sayisi": None}

    n = int(o.get("n") or 0)
    bos = int(o.get("bos") or 0)
    s1k = int(k.get("s1_kapanan") or 0)
    yeterli = n >= ESIK
    return {
        "gun": g,
        "ekran": e,
        "oturum_sayisi": n,
        "yeterli_veri": yeterli,
        "esik": ESIK,
        "M1_ilk_eyleme_sn": (round(float(o["m1"]), 1)
                             if yeterli and o.get("m1") is not None else None),
        "M2_eylemsiz_oturum_orani": (round(bos * 100.0 / n, 1) if yeterli and n else None),
        "M3_madde_omru_gun": (round(float(k["m3"]), 1) if k.get("m3") is not None else None),
        "M4_kronik_madde": int(k.get("kronik") or 0),
        "M5_s1_isabet_orani": (round(int(k.get("s1_hizli") or 0) * 100.0 / s1k, 1)
                               if s1k else None),
        "not": ("Bu ölçüm OPS iş kuyruğuna aittir; BAKIŞ ölçümüyle KARIŞTIRILMAZ "
                "(ayrı tablolar). M2 ASIL METRİKTİR ama sınırı var: 'eylemsiz oturum' "
                "= ekranda hiçbir işe girilmedi demektir, 'hiçbir şey öğrenmeden çıktı' "
                "demek DEĞİL — oturum kapanış olayı yok, açık sekme/yenileme de "
                "eylemsiz sayılır. M1 hızı değil ERİŞİLEBİLİRLİĞİ ölçer: doğru iş "
                "üstte duruyorsa süre kısalır. M3 gerçek yaşam süresi değil GÖRÜNÜRLÜK "
                "İZİ ömrüdür — madde ancak ekran açıldığında damgalanır, merkez "
                "haftalarca açmazsa ömür olduğundan kısa çıkar. M5 düşükse 'karar "
                "bekleyen' işler kapanmıyor demektir: ya eşik yanlış ya eylem yolu yok. "
                f"{ESIK} oturumdan az veride medyan YAZILMAZ (sahte kesinlik yasağı).")
    }
