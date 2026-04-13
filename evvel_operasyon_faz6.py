"""
EVVEL operasyon — Faz 6: güvenlik alarm eşikleri.

Faz 5'te toplanan ``operasyon_guvenlik_olay`` verilerinden, kısa zaman
penceresinde otomatik alarm üretir.

Uygulama
--------
- ``/api/ops/dashboard`` kartlarında:
  - ``guvenlik`` bloğu (PIN_HATALI / PIN_KILIT / PIN_KILITTE_DENEME sayaçları)
  - ``bayraklar.guvenlik_alarm`` alanı
  - filtre: ``filtre=guvenlik``
- Yeni uç: ``GET /api/ops/guvenlik-alarmlar`` (sadece aktif alarmlar)

Ortam eşikleri
--------------
- ``EVVEL_GUV_ALARM_DK`` (varsayılan 15, aralık 5–240)
- ``EVVEL_GUV_ALARM_PIN_KILIT`` (varsayılan 2, aralık 1–50)
- ``EVVEL_GUV_ALARM_PIN_HATALI`` (varsayılan 8, aralık 1–200)

Faz 7: ``evvel_operasyon_faz7.py`` — alarm okundu/susturuldu + işlem saati.
"""

from __future__ import annotations

FAZ6_DEPLOY_PYTHON: tuple[str, ...] = (
    "operasyon_merkez_api.py",
)
