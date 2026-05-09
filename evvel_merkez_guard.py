"""
Faz 3: Merkez mutasyon uçları için isteğe bağlı ek koruma.

``EVVEL_MERKEZ_MUTASYON_ANAHTARI`` ortamda tanımlıysa, aşağıdaki uçlar
``X-Evvel-Merkez-Key`` başlığında aynı değeri bekler (timing-safe karşılaştırma).

Tanımlı değilse davranış değişmez (yerel geliştirme / geriye uyumluluk).
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
from typing import Annotated, Optional

from fastapi import Header, HTTPException

_log = logging.getLogger(__name__)
_UYARI = False


def _beklenen_anahtar() -> str:
    return (os.environ.get("EVVEL_MERKEZ_MUTASYON_ANAHTARI") or "").strip()


def _anahtar_kabul(sent: str, expected: str) -> bool:
    if not sent or not expected:
        return False
    hs = hashlib.sha256(sent.encode("utf-8")).digest()
    he = hashlib.sha256(expected.encode("utf-8")).digest()
    return hmac.compare_digest(hs, he)


def merkez_mutasyon_korumasi(
    x_evvel_merkez_key: Annotated[Optional[str], Header(alias="X-Evvel-Merkez-Key")] = None,
) -> None:
    global _UYARI
    exp = _beklenen_anahtar()
    if not exp:
        return
    got = (x_evvel_merkez_key or "").strip()
    if not _anahtar_kabul(got, exp):
        raise HTTPException(
            401,
            "Merkez mutasyon anahtarı gerekli veya hatalı. Başlık: X-Evvel-Merkez-Key",
        )
    if not _UYARI:
        _log.info("EVVEL_MERKEZ_MUTASYON_ANAHTARI aktif — merkez mutasyon uçları korunuyor.")
        _UYARI = True
