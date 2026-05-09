"""
EVVEL operasyon — Faz 7: güvenlik alarmı okundu / susturuldu.

Ne eklendi
----------
- Yeni tablo: ``operasyon_guvenlik_alarm_durum``
  - ``durum``: ``okundu`` | ``susturuldu``
  - ``islem_ts`` (işlem saati), ``islem_personel_id``, ``islem_notu``
  - ``sustur_bitis_ts``

- API:
  - ``POST /api/ops/guvenlik-alarmlar/{sube_id}/okundu``
  - ``POST /api/ops/guvenlik-alarmlar/{sube_id}/sustur``
  - ``GET /api/ops/guvenlik-alarmlar`` yanıtında ``alarm_durum`` ve işlem saati
  - Dashboard kartlarında ``guvenlik.alarm_durum`` bilgisi

Davranış
--------
- Susturulan alarm, süre bitene kadar ``alarm_sayisi`` hesaplamasında aktif sayılmaz.
- İşlem saati string olarak merkez panel çıktısına taşınır.
"""

from __future__ import annotations

FAZ7_DEPLOY_PYTHON: tuple[str, ...] = (
    "database.py",
    "operasyon_merkez_api.py",
)
