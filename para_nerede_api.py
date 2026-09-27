"""💰 PARA NEREDE — izole okuma ucu (2026-09-27).

Sahip: *"Paranın nerede olduğu tamamen karmaşık ve hatalı hale geldi; eski
haldeyken daha kolay bakıyorduk, kart borçlarımız da dahil."*

Bu modül TEK soruya TEK cevap verir ve başka hiçbir şey yapmaz:
  · Yazma yok, tablo yok, migration yok — yalnız SELECT.
  · Tüm uçlar hata yutar; modül tamamen çökse ana akış etkilenmez
    ([[feedback_duyu_izole_toplayici_kurali]]).
  · Hesabın tamamı `finans_core.para_nerede()` içindedir — ekran ve bu uç
    kendi aritmetiğini KURMAZ ("ekran kendi aritmetiğini kurmaz" doktrini).
"""

import logging

from fastapi import APIRouter

from database import db
from finans_core import para_nerede as _para_nerede

log = logging.getLogger(__name__)
router = APIRouter(tags=["para-nerede"])


@router.get("/api/para-nerede")
def para_nerede_uc():
    """Kasa → gecikmiş → 7 gün vadesi → kart borcu şelalesi.

    Hata hâlinde 500 dönmez: `hata` alanı dolu, `selale` boş bir cevap döner.
    Sebep — ekran bu bloğu EN ÜSTTE gösteriyor; 500 alsa sahip "para yok"
    değil "ekran bozuk" görür, ve bu blok yüzünden bütün sayfa boş kalırdı.
    """
    try:
        with db() as (conn, cur):
            return _para_nerede(cur)
    except Exception as e:  # noqa: BLE001
        log.warning("para-nerede okunamadi: %s", str(e)[:300])
        return {
            "hata": "okunamadi",
            "selale": [],
            "uyarilar": [],
            "eksikler": ["tamami"],
            "not": "Bu blok okunamadı — ekrandaki diğer rakamlar etkilenmedi.",
        }
