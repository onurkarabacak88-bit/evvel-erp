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


# ═══════════════════════════════════════════════════════════════════════════════
# DUYU SAĞLIK DUYUSU (proprioception) — FAZ 1f (2026-07-06, Claude+Codex sentezi)
#
# Codex'in ana vuruşu: "OLAY YOKLUĞU ≠ DUYU KÖRLÜĞÜ." Anomali-üreten duyuda sessizlik
# çoğu zaman SAĞLIKTIR (fark yok = olay yok). Körlüğü ölçmek için ÇIKTI telemetrisi değil
# ÇALIŞMA telemetrisi gerekir: nabız (koştu mu), fırsat sayısı (kaç kayıt taradı),
# yutulan hata (hata-yutma güçlüyse körlük saklanır). Sistem kendi sessizliğini değil
# kendi KÖRLÜĞÜNÜ ölçmeli.
#
# MİMARİ SINIR (god-object freni): meta-duyu yalnız freshness/liveness/lag/shape bakar;
# İŞ ANLAMI ÇIKARMAZ. Domain eşikleri REGISTRY'de, değerlendirici GENERIC kalır.
# Meta olaylar omurgaya yalnız DURUM GEÇİŞİ olarak yazılır (her gece "hâlâ sessiz" spam'i
# YASAK); meta.% olayları sağlık hesabına dahil edilmez (özyineleme kesilir).
# ═══════════════════════════════════════════════════════════════════════════════

# Üretici kayıt defteri: sınıf + beklenen ritim. Codex rozet merdiveni değerlendiricide.
#   zamanli               → scheduler'a bağlı; period biliniyor (SLA)
#   olay_gudumlu_normal   → iş aktivitesiyle düzenli doğar; tarihsel ritim öğrenilebilir (N>=6)
#   olay_gudumlu_anomali  → yalnız SORUN olunca doğar; çıktı-sessizliği SAĞLIK GÖSTERGESİ DEĞİL
#                           (nabız yoksa dürüst rozet: 'izlenemez')
_DUYU_REGISTRY = {
    "k1_mutabakat":       {"sinif": "zamanli", "period_gun": 1.2, "grace": 2.0},
    "kdv_pozisyon":       {"sinif": "zamanli", "period_gun": 32.0, "grace": 1.5},
    "borc_plan_selfheal": {"sinif": "olay_gudumlu_anomali"},
    "acik_teslimat":      {"sinif": "olay_gudumlu_normal"},
    "finansal_duyu":      {"sinif": "olay_gudumlu_normal"},
    "stok_sayim":         {"sinif": "olay_gudumlu_normal"},
    "avans":              {"sinif": "olay_gudumlu_normal"},
    "fatura_ocr":         {"sinif": "olay_gudumlu_normal"},
    "hayalet_stok":       {"sinif": "olay_gudumlu_anomali"},
    "kabul_varyans":      {"sinif": "olay_gudumlu_anomali"},
    "bar_stok_uyum":      {"sinif": "olay_gudumlu_anomali"},
}


def _ensure_nabiz(cur) -> None:
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS duyu_nabiz (
            id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            duyu          TEXT NOT NULL,
            run_ts        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            durum         TEXT NOT NULL DEFAULT 'basari',   -- basari | hata
            taranan_adet  INT,                               -- fırsat sayısı (kaç kayıt bakıldı)
            uretilen_olay INT,                               -- bu koşuda üretilen olay
            yutulan_hata  INT NOT NULL DEFAULT 0,            -- hata-yutma sayacı (körlük saklanmasın)
            not_metin     TEXT
        )
        """
    )
    cur.execute("CREATE INDEX IF NOT EXISTS idx_duyu_nabiz ON duyu_nabiz (duyu, run_ts DESC)")


def duyu_nabiz_yaz(duyu: str, *, durum: str = "basari", taranan: Optional[int] = None,
                   uretilen: Optional[int] = None, yutulan_hata: int = 0,
                   not_metin: Optional[str] = None) -> None:
    """ÇALIŞMA TELEMETRİSİ — üretici her koştuğunda yazar (çıktı üretmese bile!).
    'Koştum, N kayıt taradım, M olay ürettim, K hata yuttum.' Hata-yutar, izole."""
    try:
        with db() as (_, cur):
            _ensure_nabiz(cur)
            cur.execute(
                """INSERT INTO duyu_nabiz (duyu, durum, taranan_adet, uretilen_olay, yutulan_hata, not_metin)
                   VALUES (%s,%s,%s,%s,%s,%s)""",
                ((duyu or "").strip(), durum if durum in ("basari", "hata") else "basari",
                 taranan, uretilen, int(yutulan_hata or 0), not_metin),
            )
    except Exception as e:  # noqa: BLE001
        logger.warning("duyu_nabiz_yaz yutuldu (%s): %s", duyu, str(e)[:120])


def _rozet_degerlendir(sinif: str, yas_gun: Optional[float], beklenen_gun: Optional[float],
                       nabiz_var: bool, olay_n: int) -> str:
    """GENERIC rozet merdiveni (Codex): canli / gecikmeli / ritmini_asti / kopuk_supheli /
    ritim_bilinmiyor / firsat_yok_veya_sessiz / izlenemez. İş anlamı YOK — yalnız freshness."""
    if sinif == "olay_gudumlu_anomali" and not nabiz_var:
        return "izlenemez"  # anomali duyusu + nabız telemetrisi yok → sessizlik ölçülemez (dürüst)
    if yas_gun is None:
        return "izlenemez" if not nabiz_var else "hic_olay_yok"
    if beklenen_gun is None or beklenen_gun <= 0:
        return "ritim_bilinmiyor" if olay_n < 6 else "canli"
    oran = yas_gun / beklenen_gun
    if oran <= 1.25:
        return "canli"
    if oran <= 2.0:
        return "gecikmeli"
    if oran <= 4.0:
        return "ritmini_asti"
    return "kopuk_supheli"


def saglik_hesapla(cur) -> dict:
    """Üretici + sinaps + besleme sağlığı — SALT HESAP (yazmaz). meta.% olayları hariç."""
    _ensure(cur)
    _ensure_nabiz(cur)
    # Üretici başına: son olay + olay sayısı + öğrenilen ritim (N>=6: max(p50*2, p90))
    cur.execute(
        """
        SELECT duyu,
               MAX(observed_at) AS son_olay,
               COUNT(*)::int AS olay_n,
               GREATEST(0, EXTRACT(EPOCH FROM (NOW() - MAX(observed_at))) / 86400.0) AS yas_gun
        FROM duyu_olay
        WHERE olay_tipi NOT LIKE 'meta.%%'
        GROUP BY duyu
        """
    )
    olaylar = {str(r["duyu"]): dict(r) for r in (cur.fetchall() or [])}
    # Öğrenilen ritim: ardışık olay aralıkları (yalnız olay_gudumlu_normal için anlamlı)
    cur.execute(
        """
        WITH sirali AS (
            SELECT duyu, observed_at,
                   EXTRACT(EPOCH FROM (observed_at - LAG(observed_at) OVER
                       (PARTITION BY duyu ORDER BY observed_at))) / 86400.0 AS aralik_gun
            FROM duyu_olay WHERE olay_tipi NOT LIKE 'meta.%%'
        )
        SELECT duyu,
               PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY aralik_gun) AS p50,
               PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY aralik_gun) AS p90,
               COUNT(aralik_gun)::int AS n
        FROM sirali WHERE aralik_gun IS NOT NULL GROUP BY duyu
        """
    )
    ritimler = {str(r["duyu"]): dict(r) for r in (cur.fetchall() or [])}
    # Son nabızlar + son 7 gün yutulan hata toplamı
    cur.execute(
        """
        SELECT DISTINCT ON (duyu) duyu, run_ts, durum, taranan_adet, uretilen_olay
        FROM duyu_nabiz ORDER BY duyu, run_ts DESC
        """
    )
    nabizlar = {str(r["duyu"]): dict(r) for r in (cur.fetchall() or [])}
    cur.execute(
        """SELECT duyu, SUM(yutulan_hata)::int AS yutulan
           FROM duyu_nabiz WHERE run_ts >= NOW() - INTERVAL '7 days' GROUP BY duyu"""
    )
    yutulanlar = {str(r["duyu"]): int(r["yutulan"] or 0) for r in (cur.fetchall() or [])}

    ureticiler = []
    for duyu, reg in _DUYU_REGISTRY.items():
        ol = olaylar.get(duyu) or {}
        rt = ritimler.get(duyu) or {}
        nb = nabizlar.get(duyu)
        sinif = reg["sinif"]
        yas = float(ol["yas_gun"]) if ol.get("yas_gun") is not None else None
        if sinif == "zamanli":
            beklenen = float(reg["period_gun"]) * float(reg.get("grace", 1.5))
            # zamanlıda asıl ölçü NABIZ yaşı (çıktı değil çalışma!)
            if nb and nb.get("run_ts") is not None:
                cur.execute("SELECT GREATEST(0, EXTRACT(EPOCH FROM (NOW() - %s)) / 86400.0) AS y", (nb["run_ts"],))
                yas = float(dict(cur.fetchone())["y"])
        elif sinif == "olay_gudumlu_normal" and int(rt.get("n") or 0) >= 6:
            beklenen = max(float(rt["p50"] or 0) * 2, float(rt["p90"] or 0), 1.0)
        else:
            beklenen = None
        rozet = _rozet_degerlendir(sinif, yas, beklenen, nb is not None, int(ol.get("olay_n") or 0))
        ureticiler.append({
            "duyu": duyu, "sinif": sinif, "rozet": rozet,
            "son_olay": str(ol.get("son_olay") or "") or None,
            "olay_n": int(ol.get("olay_n") or 0),
            "yas_gun": round(yas, 2) if yas is not None else None,
            "beklenen_gun": round(beklenen, 2) if beklenen else None,
            "son_nabiz": str(nb["run_ts"]) if nb else None,
            "nabiz_durum": (nb or {}).get("durum"),
            "yutulan_hata_7g": yutulanlar.get(duyu, 0),
        })

    # SİNAPS sağlığı: cursor kaç olay geride (backlog) + imleç yaşı
    cur.execute("SELECT okuyucu, son_observed, son_event_id, guncelleme FROM duyu_okuma_cursor")
    okuyucular = []
    for r in (cur.fetchall() or []):
        d = dict(r)
        cur.execute(
            """SELECT COUNT(*)::int AS geride FROM duyu_olay
               WHERE olay_tipi NOT LIKE 'meta.%%'
                 AND (observed_at, event_id) > (%s, %s)""",
            (d.get("son_observed"), d.get("son_event_id") or ""),
        )
        d["backlog"] = int(dict(cur.fetchone())["geride"])
        d["son_observed"] = str(d.get("son_observed") or "")
        d["guncelleme"] = str(d.get("guncelleme") or "")
        okuyucular.append(d)

    # BESLEME sağlığı: Evo son başarılı çekim (cache tablosundan — hata-yutar)
    beslemeler = []
    try:
        cur.execute("SELECT MAX(cekim_ts) AS son FROM evo_rapor_cache")
        _e = dict(cur.fetchone() or {})
        beslemeler.append({"besleme": "evo_hs_rapor",
                           "son_basarili_cekim": str(_e.get("son") or "") or None})
    except Exception:  # noqa: BLE001
        beslemeler.append({"besleme": "evo_hs_rapor", "hata": "cache okunamadı"})

    return {"ureticiler": sorted(ureticiler, key=lambda u: u["duyu"]),
            "sinapslar": okuyucular, "beslemeler": beslemeler}


def gece_saglik_degerlendir() -> None:
    """GECE: sağlık hesapla; kopuk_supheli/ritmini_asti DURUM GEÇİŞLERİNİ meta olaya yaz.
    Spam yok: source_ref=duyu+rozet+gün → aynı durum aynı gün tek olay; DÜZELME de olay
    (sessizlik_bitti). Hata-yutar."""
    try:
        with db() as (_, cur):
            s = saglik_hesapla(cur)
            # önceki rozetler (dünkü meta olaylardan değil — basit: son meta olay tipine bak)
            for u in s["ureticiler"]:
                if u["rozet"] in ("ritmini_asti", "kopuk_supheli"):
                    duyu_olay_yaz(
                        "duyu_saglik", "meta.duyu.sessizlik_basladi",
                        f"{u['duyu']}:{u['rozet']}",  # durum değişmedikçe idempotent (gün eklenmez!)
                        entity_scope="genel", signal_name=f"Duyu ritmini aştı: {u['duyu']}",
                        evidence_class="gozlem",
                        payload={"rozet": u["rozet"], "yas_gun": u["yas_gun"],
                                 "beklenen_gun": u["beklenen_gun"], "sinif": u["sinif"]},
                    )
        duyu_nabiz_yaz("duyu_saglik", taranan=len(_DUYU_REGISTRY), not_metin="gece degerlendirme")
    except Exception as e:  # noqa: BLE001
        logger.warning("gece_saglik_degerlendir yutuldu: %s", str(e)[:150])


@router.get("/saglik")
def duyu_saglik():
    """PROPRIOCEPTION — sistemin kendini hissetmesi. Salt-okur; hüküm yok, rozet var.
    'izlenemez' = dürüst itiraf (nabız telemetrisi henüz yok); 'kopuk_supheli' = bakılmalı."""
    with db() as (_, cur):
        s = saglik_hesapla(cur)
    s["not"] = ("Rozetler: canli(≤1.25x) · gecikmeli(≤2x) · ritmini_asti(≤4x) · kopuk_supheli(>4x) "
                "· ritim_bilinmiyor(N<6) · izlenemez(nabız yok — anomali duyusunda sessizlik "
                "SAĞLIK GÖSTERGESİ DEĞİLDİR, Codex kuralı). Zamanlı duyularda ölçü ÇALIŞMA "
                "nabzıdır, çıktı değil. yutulan_hata_7g>0 = hata-yutma körlük saklıyor olabilir.")
    return s


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
