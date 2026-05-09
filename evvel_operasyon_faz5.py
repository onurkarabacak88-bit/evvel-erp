"""
EVVEL operasyon — Faz 5: güvenlik olay gözlemi.

1) Olay kaydı
-------------
Yeni tablo: ``operasyon_guvenlik_olay`` (ts, tip, personel, sube, detay).
``personel_panel_auth`` içinde PIN akışında:

- ``PIN_HATALI``
- ``PIN_KILIT``
- ``PIN_KILITTE_DENEME``

2) Merkez API
-------------
- ``GET /api/ops/guvenlik-olaylar`` (filtre: ay/gün/şube/tip)
- ``GET /api/ops/guvenlik-ozet`` (tip bazında adet + son olay zamanı)

Faz 6: ``evvel_operasyon_faz6.py`` — kısa pencere güvenlik alarm eşikleri.

3) Not
------
Bu faz görünürlük katmanıdır; karar/aksiyon (bildirim, webhook, ceza politikası)
bir sonraki faza bırakılabilir.
"""

from __future__ import annotations

FAZ5_DEPLOY_PYTHON: tuple[str, ...] = (
    "database.py",
    "personel_panel_auth.py",
    "operasyon_merkez_api.py",
)
