"""Operasyon defteri — yalnızca INSERT (append-only).

Faz 1: Her satır, sunucu sırrı ile HMAC-SHA256 (payload + zaman damgası) taşır.
Faz 2: Şube bazlı zincir (önceki satırın zincir özeti + satır imzası) — sıra bütünlüğü.

PIN düz metin olarak asla deftere yazılmaz veya ayrıca hashlenmez; satır, PIN
doğrulamasından sonra üretilen HMAC + şube zinciri ile bütünlük mührüdür
(blueprint’teki hash(pin+tarih+veri) yerine sunucu sırlı imza — inkâr edilemez
satır içeriği, PIN ise yalnızca kapı).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import uuid
from datetime import date, datetime
from typing import Any, Dict, List, Optional

_log = logging.getLogger(__name__)

_IMZA_UYARI_VERILDI = False
_DEV_FALLBACK_KEY = "evvel-dev-imza-anahtari-degistir"


def _imza_anahtari_oku() -> str:
    """HMAC anahtarını env'den okur. Eksikse fallback anahtar ile devam eder (uyarı ile).

    NOT: Üretimde güvenlik için `EVVEL_OPERASYON_DEFTER_IMZA_ANAHTARI` tanımlanmalıdır;
    aksi halde defter imzaları tahmin edilebilir fallback anahtar ile üretilir.
    """
    s = (os.environ.get("EVVEL_OPERASYON_DEFTER_IMZA_ANAHTARI") or "").strip()
    if s:
        return s
    global _IMZA_UYARI_VERILDI
    if not _IMZA_UYARI_VERILDI:
        env = (os.environ.get("EVVEL_ENV") or os.environ.get("RAILWAY_ENVIRONMENT") or "").lower() or "unknown"
        _log.warning(
            "EVVEL_OPERASYON_DEFTER_IMZA_ANAHTARI boş (ortam=%s); fallback anahtar kullanılıyor. "
            "Üretimde Railway → Variables bölümünden güçlü bir değer tanımlamanız önerilir.",
            env,
        )
        _IMZA_UYARI_VERILDI = True
    return _DEV_FALLBACK_KEY


def _imza_anahtar_baytlari() -> bytes:
    """HMAC anahtarı: env uzun dizgesi → SHA-256 türev (sabit 32 bayt)."""
    s = _imza_anahtari_oku()
    return hashlib.sha256(f"evvel-defter-hmac-v1:{s}".encode("utf-8")).digest()


def _zincir_anahtar_baytlari() -> bytes:
    s = _imza_anahtari_oku()
    return hashlib.sha256(f"evvel-defter-zincir-v1:{s}".encode("utf-8")).digest()


def _pg_advisory_lock_sube_defter(cur: Any, sube_id: str) -> None:
    """Aynı şubede eşzamanlı defter eklerinde zincir çatallanmasını önler."""
    h = hashlib.sha256(f"evvel:operasyon_defter:{sube_id}".encode()).digest()
    k1 = int.from_bytes(h[:4], "big") & 0x7FFFFFFF
    k2 = int.from_bytes(h[4:8], "big") & 0x7FFFFFFF
    cur.execute("SELECT pg_advisory_xact_lock(%s, %s)", (k1, k2))


def operasyon_defter_zincir_satirlari_dogrula(rows_eski_yeniye: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    ``rows_eski_yeniye``: ``olay_ts ASC, id ASC`` sıralı satırlar (dict).
    ``defter_zincir_hmac`` olmayan (eski) satırlar atlanır; zincir sürekliliği korunur.
    """
    running = ""
    incelenen = 0
    for row in rows_eski_yeniye:
        z = (row.get("defter_zincir_hmac") or "").strip()
        imz = (row.get("imza_hmac") or "").strip()
        rid = str(row.get("id") or "")
        if not z:
            continue
        incelenen += 1
        if not imz:
            return {
                "gecerli": False,
                "neden": "imza_yok",
                "id": rid,
                "incelenen_zincir_satir": incelenen,
            }
        chain_input = json.dumps(
            ["z1", running, imz, rid],
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        exp = hmac.new(_zincir_anahtar_baytlari(), chain_input, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(z, exp):
            return {
                "gecerli": False,
                "neden": "zincir_uyusmazlik",
                "id": rid,
                "incelenen_zincir_satir": incelenen,
            }
        running = z
    return {"gecerli": True, "incelenen_zincir_satir": incelenen}


def operasyon_defter_canonical_v1(
    rid: str,
    sube_id: str,
    tarih: Any,
    olay_ts: Any,
    etiket: str,
    aciklama: str,
    ref_event_id: Optional[str],
    personel_id: Optional[str],
    personel_ad: Optional[str],
    bildirim_saati: Optional[str],
) -> bytes:
    if isinstance(tarih, datetime):
        td = tarih.date().strftime("%Y-%m-%d")
    elif isinstance(tarih, date):
        td = tarih.strftime("%Y-%m-%d")
    else:
        td = str(tarih)[:10]
    if not isinstance(olay_ts, datetime):
        raise TypeError("olay_ts datetime olmali")
    ts_u = int(olay_ts.timestamp())
    parts = [
        "v1",
        rid,
        sube_id,
        td,
        ts_u,
        etiket,
        aciklama or "",
        ref_event_id or "",
        personel_id or "",
        personel_ad or "",
        bildirim_saati or "",
    ]
    return json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def operasyon_defter_imza_uret(canonical_body: bytes) -> str:
    return hmac.new(_imza_anahtar_baytlari(), canonical_body, hashlib.sha256).hexdigest()


def operasyon_defter_satir_imza_gecerli(row: Any) -> Optional[bool]:
    """Satır sözlüğünde kayıtlı imza ile yeniden hesaplanan imzayı karşılaştırır."""
    stored = (row.get("imza_hmac") or "").strip()
    if not stored:
        return None
    try:
        rid = str(row.get("id") or "")
        sube_id = str(row.get("sube_id") or "")
        tarih = row.get("tarih")
        olay_ts = row.get("olay_ts")
        etiket = str(row.get("etiket") or "")
        aciklama = str(row.get("aciklama") or "")
        ref = row.get("ref_event_id")
        ref_s = str(ref) if ref is not None else ""
        pid = row.get("personel_id")
        pid_s = str(pid) if pid is not None else ""
        pad = row.get("personel_ad")
        pad_s = str(pad) if pad is not None else ""
        bs = row.get("bildirim_saati")
        bs_s = str(bs) if bs is not None else ""
        body = operasyon_defter_canonical_v1(
            rid,
            sube_id,
            tarih,
            olay_ts,
            etiket,
            aciklama,
            ref_s or None,
            pid_s or None,
            pad_s or None,
            bs_s or None,
        )
        exp = operasyon_defter_imza_uret(body)
        return hmac.compare_digest(stored, exp)
    except Exception:
        _log.exception("operasyon_defter imza dogrulama hatasi")
        return False


def operasyon_defter_ekle(
    cur: Any,
    sube_id: str,
    etiket: str,
    aciklama: str,
    ref_event_id: Optional[str] = None,
    *,
    personel_id: Optional[str] = None,
    personel_ad: Optional[str] = None,
    bildirim_saati: Optional[str] = None,
) -> str:
    rid = str(uuid.uuid4())
    etik = etiket[:120]
    acik = (aciklama or "")[:2000]
    cur.execute("SELECT CURRENT_DATE AS d, NOW() AS ts")
    trow = cur.fetchone()
    tarih_val = trow["d"]
    olay_ts_val = trow["ts"]
    body = operasyon_defter_canonical_v1(
        rid,
        sube_id,
        tarih_val,
        olay_ts_val,
        etik,
        acik,
        ref_event_id,
        personel_id,
        personel_ad,
        bildirim_saati,
    )
    imza = operasyon_defter_imza_uret(body)
    _pg_advisory_lock_sube_defter(cur, sube_id)
    cur.execute(
        """
        SELECT id, defter_zincir_hmac
        FROM operasyon_defter
        WHERE sube_id = %s
        ORDER BY olay_ts DESC NULLS LAST, id DESC
        LIMIT 1
        FOR UPDATE
        """,
        (sube_id,),
    )
    prow = cur.fetchone()
    prev_id = str(prow["id"]) if prow else None
    prev_z = (str(prow["defter_zincir_hmac"] or "") if prow else "").strip()
    chain_input = json.dumps(
        ["z1", prev_z, imza, rid],
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    zincir_hmac = hmac.new(_zincir_anahtar_baytlari(), chain_input, hashlib.sha256).hexdigest()
    cur.execute(
        """
        INSERT INTO operasyon_defter
            (id, sube_id, tarih, olay_ts, etiket, aciklama, ref_event_id,
             personel_id, personel_ad, bildirim_saati, imza_hmac,
             defter_onceki_id, defter_zincir_hmac)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            rid,
            sube_id,
            tarih_val,
            olay_ts_val,
            etik,
            acik,
            ref_event_id,
            personel_id,
            personel_ad,
            bildirim_saati,
            imza,
            prev_id,
            zincir_hmac,
        ),
    )
    return rid
