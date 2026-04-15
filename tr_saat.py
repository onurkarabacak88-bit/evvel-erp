"""
Europe/Istanbul — tüm iş mantığı ve panel tarih/saatleri buradan.

- `bugun_tr()` / `dt_now_tr_naive()` — Python tarafı (sunucu OS diliminden bağımsız).
- `database.db()` her oturumda `SET TIME ZONE 'Europe/Istanbul'` ile PostgreSQL
  `CURRENT_DATE`, `NOW()`, `CURRENT_TIMESTAMP` değerlerini TR ile hizalar.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

from zoneinfo import ZoneInfo

TR_TZ = ZoneInfo("Europe/Istanbul")


def dt_now_tr() -> datetime:
    """Şu an, tz bilgili Europe/Istanbul."""
    return datetime.now(timezone.utc).astimezone(TR_TZ)


def dt_now_tr_naive() -> datetime:
    """TR duvar saati, tz'siz (PostgreSQL naive timestamp ile uyumlu yazım/kıyas)."""
    return dt_now_tr().replace(tzinfo=None)


def bugun_tr() -> date:
    """İstanbul takvimine göre bugün."""
    return dt_now_tr().date()


def dt_format_api_tr(v: Any) -> str:
    """datetime -> panel/API metni: YYYY-MM-DD HH:MM:SS (TR)."""
    if v is None:
        return ""
    if isinstance(v, datetime):
        if v.tzinfo is not None:
            d = v.astimezone(TR_TZ)
        else:
            d = v.replace(tzinfo=TR_TZ)
        return d.strftime("%Y-%m-%d %H:%M:%S")
    return str(v)


def dt_coerce_naive_tr(v: Any) -> datetime | None:
    """DB/driver'dan gelen datetime'ı TR duvar saati, tz'siz — fark/dk hesapları için."""
    if not isinstance(v, datetime):
        return None
    if v.tzinfo is None:
        return v
    return v.astimezone(TR_TZ).replace(tzinfo=None)
