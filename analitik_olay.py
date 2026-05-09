"""
Motor / kontrol çıktılarının append-only analitik akışı.

audit_log kayıt değişikliğine odaklanır; bu tablo ise 'o anda motor ne gördü?'
snapshot'ları için kullanılır. Yazım hataları ana işlemi bozmamalıdır.
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any, Dict, Optional

logger = logging.getLogger("evvel-erp")

# Aynı olay tipi için çok sık INSERT önleme (çok işçili ortamda tam garanti değildir)
_throttle_epoch: Dict[str, float] = {}


def analitik_olay_ekle(
    cur,
    olay_tipi: str,
    *,
    sube_id: Optional[str] = None,
    tutar_yok_bilgi: bool = False,
    hesap_surumu: str = "basarili",
    payload: Optional[Dict[str, Any]] = None,
    kaynak: Optional[str] = None,
    throttle_sn: float = 0,
) -> None:
    """
    Aynı transaction içindeki cursor ile INSERT (commit db() çıkışında).

    olay_tipi: örn. FINANS_OZET_PAKET, KONTROL_TUM_SUBELER
    tutar_yok_bilgi: True ise payload'ta kasa tutarı yok / kasıtlı gizlilik anlamında işaretlenebilir.
    hesap_surumu: basarili | kismi | cache | hata
    """
    tip = (olay_tipi or "").strip()[:160]
    if not tip:
        return
    if throttle_sn and throttle_sn > 0:
        now = time.time()
        last = _throttle_epoch.get(tip, 0.0)
        if now - last < throttle_sn:
            return
        _throttle_epoch[tip] = now
    oid = str(uuid.uuid4())
    sid = (sube_id or "").strip()[:80] or None
    durum = (hesap_surumu or "basarili").strip()[:40] or "basarili"
    src = ((kaynak or "").strip()[:120] or None)
    pload: Dict[str, Any] = dict(payload) if payload else {}
    try:
        body = json.dumps(pload, default=str, ensure_ascii=False)
    except Exception:
        body = json.dumps({"_serialize_hata": True}, ensure_ascii=False)
        durum = "hata" if durum == "basarili" else durum
    try:
        cur.execute(
            """
            INSERT INTO motor_analitik_olay
                (id, olay_tipi, sube_id, tutar_yok_bilgi, payload_json, hesap_surumu, kaynak)
            VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s)
            """,
            (oid, tip, sid, bool(tutar_yok_bilgi), body, durum, src),
        )
    except Exception:
        logger.warning("motor_analitik_olay yazılamadı: tip=%s", tip, exc_info=True)
