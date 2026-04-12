"""Operasyon defteri — yalnızca INSERT (append-only)."""
from __future__ import annotations

import uuid
from typing import Optional

from typing import Any


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
    cur.execute(
        """
        INSERT INTO operasyon_defter
            (id, sube_id, tarih, olay_ts, etiket, aciklama, ref_event_id,
             personel_id, personel_ad, bildirim_saati)
        VALUES (%s, %s, CURRENT_DATE, NOW(), %s, %s, %s, %s, %s, %s)
        """,
        (
            rid,
            sube_id,
            etiket[:120],
            (aciklama or "")[:2000],
            ref_event_id,
            personel_id,
            personel_ad,
            bildirim_saati,
        ),
    )
    return rid
