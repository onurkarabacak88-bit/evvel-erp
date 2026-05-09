"""
EVVEL operasyon — Faz 4: defter DB append-only, PIN kilit, CSV dışa aktarma.

1) ``operasyon_defter`` tetikleyici
-----------------------------------
``UPDATE`` / ``DELETE`` engellenir; yalnız ``INSERT`` (uygulama zaten öyleydi,
PostgreSQL ile garanti altına alındı).

2) Panel PIN yanlış deneme
--------------------------
Tablo ``panel_pin_guvenlik``. ``dogrula_personel_panel_pin`` içinde:

- Arka arkaya hatalı PIN (varsayılan 5) → kilit (varsayılan 15 dk).
- Ortam: ``EVVEL_PANEL_PIN_MAX_YANLIS`` (3–20), ``EVVEL_PANEL_PIN_KILIT_DK`` (5–120).
- Başarılı doğrulama satırı siler; HTTP ``429`` ile kilit mesajı.

Kod: ``personel_panel_auth.py``; migration: ``database.py``.

3) CSV export
-------------
``GET /api/ops/defter-export?year_month=YYYY-MM&sube_id=&gun=``
→ UTF-8 BOM + ``imza_gecerli`` sütunu; en fazla 25000 satır.

Deploy: ``database.py``, ``personel_panel_auth.py``, ``operasyon_merkez_api.py``.

Faz 5: ``evvel_operasyon_faz5.py`` — güvenlik olay listesi/özeti.
"""

from __future__ import annotations

FAZ4_DEPLOY_PYTHON: tuple[str, ...] = (
    "database.py",
    "personel_panel_auth.py",
    "operasyon_merkez_api.py",
)
