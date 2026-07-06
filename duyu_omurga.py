"""
DUYU OMURGASI — FAZ 0 (2026-07-06, Claude+Codex sentezi; tasarım: EVVEL_Duyu_Agi_Master_Plani.md)

Sistemin sinir sistemi çekirdeği: duyular (izole toplayıcılar) olaylarını TEK append-only
omurgaya yazar; sinapslar (gece çalışan izole okuyucular) cursor'la kaldıkları yerden okur.
MQ/pub-sub YOK — 4 şubelik işletmede gece batch + cursor yeterli (Codex teyitli).

KATMAN AYRIMI (4-katman kuralı — god-object panzehiri):
  duyu_olay            = Katman-2 (append-only OLAY — fenomen dili, hüküm yok)
  duyu_etiket          = ground-truth ETİKET defteri (baskın sonuçları + insan kararları —
                         gelecekteki istatistiğin ÖĞRETMENİ; Codex: sona değil BAŞA)
  denetim_hipotez_gozlem = Katman-4 (öğrenme/yorum) — AYRI KALIR, birleştirilmez.

TAKSONOMİ (ontology-first): olay_tipi = alan.özne.fenomen — HÜKÜM İÇEREMEZ.
  Örnek: tedarik.teslimat.acik_dogdu · tedarik.teslimat.kapandi · kasa.sube.defter_farki
         stok.sube.tuketim_farki · odeme.tedarikci.aday_eslesme
  Hüküm/itham dili (zimmet, hırsızlık, şişirme) olay_tipi'nde YASAK — o dil ancak
  motor katmanının İNSAN-yüzü etiketlerinde yaşayabilir (o da arındırılacak, Faz 4).

KİMLİK GÜVENLİK DUVARI (kural #15'in şema garantisi): bu tabloda PERSONEL ALANI YOK ve
yazıcı payload'dan kimlik anahtarlarını SOYAR. Hiçbir sinaps yapısal olarak isme inemez;
isme dokunma tek yetkili kapı = consistency motoru (≥2-3 bağımsız duyu kuralıyla).

ZAMAN KESİTİ (Codex vuruşu #2): occurred_at (işin OLDUĞU an) ≠ observed_at (KAYDIN anı).
İki alan ayrı tutulur; yan-yana görünümler kesit uyuşmazlığını rozetle göstermek zorunda.

YAZICI SÖZLEŞMESİ: kendi bağlantısını açar (çağıranın transaction'ı ASLA etkilenmez),
her hatayı yutar (duyu çökse ana akış yaşar), source_ref ile idempotent (çift yazım imkânsız),
confidence<1 kayıt 'aday' dilindedir — hiçbir okuyucu onu 'olmuş olay' gibi yorumlayamaz.

Kaldırmak: main.py'den router'ı çıkar + üretici kancalardaki tek satırları sil. Tablolar zararsız kalır.
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Optional

from fastapi import APIRouter, Query

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/duyu", tags=["duyu-omurga"])

# ── Sözleşme sabitleri ────────────────────────────────────────────────────────
EVIDENCE_CLASSES = ("gozlem", "mutabakat", "patern", "oneri")
ASSERTION_LEVELS = ("ham", "baglamli", "korele")
ENTITY_SCOPES = ("sube", "tedarikci", "kalem", "kart", "genel")  # PERSONEL bilinçli olarak YOK

# Kimlik güvenlik duvarı: payload'dan sessizce soyulan anahtarlar
_KIMLIK_ANAHTARLARI = frozenset({
    "personel_id", "personel_ad", "ad_soyad", "personel", "sabahci_id", "aksamci_id",
    "sabahci_ad", "aksamci_ad", "acan_personel_id", "acan_personel_ad",
    "biten_personel_id", "biten_personel_ad", "teslim_eden_personel_id", "teslim_eden_ad",
})


def _ensure(cur) -> None:
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS duyu_olay (
            event_id        TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            duyu            TEXT NOT NULL,
            olay_tipi       TEXT NOT NULL,
            signal_name     TEXT,
            evidence_class  TEXT NOT NULL DEFAULT 'gozlem',
            assertion_level TEXT NOT NULL DEFAULT 'ham',
            entity_scope    TEXT,
            entity_id       TEXT,
            occurred_at     TIMESTAMPTZ,
            observed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            source_ref      TEXT NOT NULL,
            confidence      NUMERIC(4,3) NOT NULL DEFAULT 1.0,
            schema_version  INT NOT NULL DEFAULT 1,
            payload_json    JSONB,
            UNIQUE (duyu, olay_tipi, source_ref)
        )
        """
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_duyu_olay_okuma "
        "ON duyu_olay (observed_at, event_id)"
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_duyu_olay_tip "
        "ON duyu_olay (olay_tipi, observed_at DESC)"
    )
    # Sinaps okuma imleci — her okuyucu kaldığı yerden devam eder (replay/idempotent)
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS duyu_okuma_cursor (
            okuyucu       TEXT PRIMARY KEY,
            son_observed  TIMESTAMPTZ,
            son_event_id  TEXT,
            guncelleme    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    # Ground-truth etiket defteri — istatistik fazının öğretmeni (append-only)
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS duyu_etiket (
            etiket_id     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            kaynak        TEXT NOT NULL,       -- baskin | insan_karar | manuel_kapanis | onay | red
            iliskili_ref  TEXT NOT NULL,       -- event_id / tanı referansı / talep id
            insan_karari  TEXT,                -- insanın ne dediği (serbest metin)
            gercek_sonuc  TEXT,                -- doğrulanan sonuç (varsa)
            detay_json    JSONB,
            olusturma     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (kaynak, iliskili_ref)
        )
        """
    )


def _payload_temizle(payload: Optional[dict]) -> Optional[dict]:
    """Kimlik güvenlik duvarı: payload'dan kimlik anahtarlarını soy (iç içe dahil, tek seviye derin)."""
    if not isinstance(payload, dict):
        return payload
    temiz = {}
    for k, v in payload.items():
        if str(k).lower() in _KIMLIK_ANAHTARLARI:
            continue
        if isinstance(v, dict):
            v = {ik: iv for ik, iv in v.items() if str(ik).lower() not in _KIMLIK_ANAHTARLARI}
        temiz[k] = v
    return temiz


def duyu_olay_yaz(
    duyu: str,
    olay_tipi: str,
    source_ref: str,
    *,
    entity_scope: Optional[str] = None,
    entity_id: Optional[str] = None,
    occurred_at: Optional[Any] = None,   # date/datetime/str — iş anı; None → observed_at ile aynı kabul
    signal_name: Optional[str] = None,
    evidence_class: str = "gozlem",
    assertion_level: str = "ham",
    confidence: float = 1.0,
    payload: Optional[dict] = None,
) -> None:
    """OMURGAYA OLAY YAZ — hata-yutar, izole, idempotent.

    KENDİ bağlantısını açar: çağıranın transaction'ı asla etkilenmez; bu fonksiyon
    çökse üretici akış yaşar (duyu = yan his, ana işlev değil). Aynı (duyu, olay_tipi,
    source_ref) üçlüsü ikinci kez yazılamaz (ON CONFLICT DO NOTHING)."""
    try:
        d = (duyu or "").strip()
        t = (olay_tipi or "").strip().lower()
        ref = str(source_ref or "").strip()
        if not d or not t or not ref:
            return
        if t.count(".") < 2:
            # Taksonomi sözleşmesi: alan.özne.fenomen — eksikse kaydet ama işaretle
            logger.warning("duyu_olay taksonomi dışı olay_tipi: %s (yine de yazılıyor)", t)
        ec = evidence_class if evidence_class in EVIDENCE_CLASSES else "gozlem"
        al = assertion_level if assertion_level in ASSERTION_LEVELS else "ham"
        es = entity_scope if entity_scope in ENTITY_SCOPES else ("genel" if entity_scope is None else None)
        if es is None:
            logger.warning("duyu_olay bilinmeyen entity_scope '%s' → genel", entity_scope)
            es = "genel"
        conf = max(0.0, min(1.0, float(confidence)))
        pj = _payload_temizle(payload)
        with db() as (_, cur):
            _ensure(cur)
            cur.execute(
                """
                INSERT INTO duyu_olay
                    (duyu, olay_tipi, signal_name, evidence_class, assertion_level,
                     entity_scope, entity_id, occurred_at, source_ref, confidence, payload_json)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
                ON CONFLICT (duyu, olay_tipi, source_ref) DO NOTHING
                """,
                (d, t, signal_name, ec, al, es,
                 str(entity_id) if entity_id is not None else None,
                 str(occurred_at) if occurred_at is not None else None,
                 ref, conf,
                 json.dumps(pj, ensure_ascii=False, default=str) if pj is not None else None),
            )
    except Exception as e:  # noqa: BLE001 — bilerek yutulur (üretici akış bozulmaz)
        logger.warning("duyu_olay_yaz yutuldu (%s/%s): %s", duyu, olay_tipi, str(e)[:150])


def duyu_etiket_yaz(
    kaynak: str,
    iliskili_ref: str,
    insan_karari: Optional[str] = None,
    gercek_sonuc: Optional[str] = None,
    detay: Optional[dict] = None,
) -> None:
    """GROUND-TRUTH ETİKET YAZ — hata-yutar, izole, idempotent.
    Baskın sonuçları + insan onay/red/açıklamaları buraya birikir; Faz 4 istatistiği
    bu öğretmenle çalışır (Codex: etiket omurgası sona değil başa)."""
    try:
        k = (kaynak or "").strip()
        ref = str(iliskili_ref or "").strip()
        if not k or not ref:
            return
        with db() as (_, cur):
            _ensure(cur)
            cur.execute(
                """
                INSERT INTO duyu_etiket (kaynak, iliskili_ref, insan_karari, gercek_sonuc, detay_json)
                VALUES (%s,%s,%s,%s,%s::jsonb)
                ON CONFLICT (kaynak, iliskili_ref) DO NOTHING
                """,
                (k, ref, insan_karari, gercek_sonuc,
                 json.dumps(_payload_temizle(detay), ensure_ascii=False, default=str) if detay else None),
            )
    except Exception as e:  # noqa: BLE001
        logger.warning("duyu_etiket_yaz yutuldu (%s): %s", kaynak, str(e)[:150])


def cursor_ile_oku(cur, okuyucu: str, limit: int = 500) -> list:
    """SİNAPS OKUYUCU YARDIMCISI: okuyucunun imlecinden sonraki olayları döndürür ve imleci
    İLERLETMEZ — okuyucu işini bitirince cursor_ilerlet çağırır (at-least-once semantiği).
    Sıralama deterministik: (observed_at, event_id)."""
    _ensure(cur)
    cur.execute("SELECT son_observed, son_event_id FROM duyu_okuma_cursor WHERE okuyucu=%s", (okuyucu,))
    row = cur.fetchone()
    if row and row.get("son_observed"):
        cur.execute(
            """
            SELECT * FROM duyu_olay
            WHERE (observed_at, event_id) > (%s, %s)
            ORDER BY observed_at, event_id LIMIT %s
            """,
            (row["son_observed"], row.get("son_event_id") or "", limit),
        )
    else:
        cur.execute("SELECT * FROM duyu_olay ORDER BY observed_at, event_id LIMIT %s", (limit,))
    return [dict(r) for r in (cur.fetchall() or [])]


def cursor_ilerlet(cur, okuyucu: str, son_olay: dict) -> None:
    """Okuyucu imlecini son işlenen olaya taşı (upsert)."""
    cur.execute(
        """
        INSERT INTO duyu_okuma_cursor (okuyucu, son_observed, son_event_id, guncelleme)
        VALUES (%s,%s,%s,NOW())
        ON CONFLICT (okuyucu) DO UPDATE
            SET son_observed=EXCLUDED.son_observed, son_event_id=EXCLUDED.son_event_id, guncelleme=NOW()
        """,
        (okuyucu, son_olay.get("observed_at"), son_olay.get("event_id")),
    )


# ── SALT-OKUR UÇLAR ───────────────────────────────────────────────────────────

@router.get("/ozet")
def duyu_ozet(gun: int = Query(30, ge=1, le=365)):
    """Omurga özeti: son N günün olay tipleri + adetleri + etiket sayısı. Salt-okur."""
    with db() as (_, cur):
        _ensure(cur)
        cur.execute(
            """
            SELECT olay_tipi, evidence_class, COUNT(*)::int AS adet,
                   MIN(observed_at)::text AS ilk, MAX(observed_at)::text AS son
            FROM duyu_olay
            WHERE observed_at >= NOW() - (%s * INTERVAL '1 day')
            GROUP BY olay_tipi, evidence_class
            ORDER BY adet DESC
            """,
            (gun,),
        )
        tipler = [dict(r) for r in (cur.fetchall() or [])]
        cur.execute("SELECT COUNT(*)::int AS n FROM duyu_olay")
        toplam = int(dict(cur.fetchone())["n"])
        cur.execute("SELECT COUNT(*)::int AS n FROM duyu_etiket")
        etiket = int(dict(cur.fetchone())["n"])
        cur.execute("SELECT okuyucu, son_observed::text, guncelleme::text FROM duyu_okuma_cursor")
        okuyucular = [dict(r) for r in (cur.fetchall() or [])]
    return {"toplam_olay": toplam, "etiket_sayisi": etiket,
            "son_gun_tipleri": tipler, "okuyucular": okuyucular,
            "not": "Katman-2 olay omurgası — fenomen dili, hüküm yok, kimlik yok. "
                   "confidence<1 = aday; occurred_at≠observed_at = kesit farkı."}


@router.get("/olaylar")
def duyu_olaylar(
    olay_tipi: Optional[str] = Query(None),
    duyu: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=1000),
):
    """Ham olay listesi (filtreli). Salt-okur — hiçbir yorum/çıkarım eklemez."""
    with db() as (_, cur):
        _ensure(cur)
        q = "SELECT * FROM duyu_olay WHERE 1=1"
        params: list = []
        if olay_tipi:
            q += " AND olay_tipi = %s"
            params.append(olay_tipi.strip().lower())
        if duyu:
            q += " AND duyu = %s"
            params.append(duyu.strip())
        q += " ORDER BY observed_at DESC, event_id DESC LIMIT %s"
        params.append(limit)
        cur.execute(q, params)
        rows = []
        for r in (cur.fetchall() or []):
            d = dict(r)
            for k in ("occurred_at", "observed_at"):
                if d.get(k) is not None:
                    d[k] = str(d[k])
            d["confidence"] = float(d.get("confidence") or 0)
            rows.append(d)
    return {"toplam": len(rows), "olaylar": rows}


@router.get("/etiketler")
def duyu_etiketler(limit: int = Query(100, ge=1, le=1000)):
    """Ground-truth etiket defteri (salt-okur)."""
    with db() as (_, cur):
        _ensure(cur)
        cur.execute(
            "SELECT * FROM duyu_etiket ORDER BY olusturma DESC LIMIT %s", (limit,)
        )
        rows = []
        for r in (cur.fetchall() or []):
            d = dict(r)
            d["olusturma"] = str(d.get("olusturma") or "")
            rows.append(d)
    return {"toplam": len(rows), "etiketler": rows}
