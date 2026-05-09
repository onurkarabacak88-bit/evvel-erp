"""
Europe/Istanbul — tüm iş mantığı ve panel tarih/saatleri buradan.

- `bugun_tr()` / `dt_now_tr_naive()` — Python tarafı (sunucu OS diliminden bağımsız).
- `database.db()` her oturumda `SET TIME ZONE 'Europe/Istanbul'` ile PostgreSQL
  `CURRENT_DATE`, `NOW()`, `CURRENT_TIMESTAMP` değerlerini TR ile hizalar.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from zoneinfo import ZoneInfo

TR_TZ = ZoneInfo("Europe/Istanbul")

# İş kuralları — şube operasyon (panel + API)
# Açılış onayı (sayımlı) en erken bu saatte; kapanış son teslim ertesi gün bu saate kadar.
ACILIS_TAMAM_EN_ERKEN_SAAT = 7
KAPANIS_SON_TESLIM_ERTESI_GUN_SAAT = 2


def dt_now_tr() -> datetime:
    """Şu an, tz bilgili Europe/Istanbul."""
    return datetime.now(timezone.utc).astimezone(TR_TZ)


def dt_now_tr_naive() -> datetime:
    """TR duvar saati, tz'siz (PostgreSQL naive timestamp ile uyumlu yazım/kıyas)."""
    return dt_now_tr().replace(tzinfo=None)


def bugun_tr() -> date:
    """İstanbul takvimine göre bugün (takvim günü)."""
    return dt_now_tr().date()


def is_gunu_tr() -> date:
    """
    Operasyonel iş günü: gece yarısı ile 02:00 arasında hâlâ önceki günün
    iş gününde sayılırız (kapanış son teslim 02:00). Bu tarih açılış/kapanış
    ve kasa sorgularında CURRENT_DATE yerine kullanılır.
    """
    now = dt_now_tr()
    if now.hour < KAPANIS_SON_TESLIM_ERTESI_GUN_SAAT:
        return (now - timedelta(days=1)).date()
    return now.date()


def tr_ertesi_gun_saat(tr_date: date, saat: int, dakika: int = 0) -> datetime:
    """Verilen TR takvim gününün ertesi günü, belirtilen saat (naive TR duvar saati)."""
    nd = tr_date + timedelta(days=1)
    return datetime(nd.year, nd.month, nd.day, saat, dakika, 0)


def tr_kapanis_son_teslim_ts(tr_is_gunu: date) -> datetime:
    """İş günü `tr_is_gunu` kapanışı için son teslim: ertesi gün 02:00 (TR)."""
    return tr_ertesi_gun_saat(tr_is_gunu, KAPANIS_SON_TESLIM_ERTESI_GUN_SAAT, 0)


def tr_acilis_tamam_saat_uygun_mu(simdi_naive: datetime) -> bool:
    """Açılış tamamlanabilir mi? Aynı takvim günü 07:00 öncesi hayır (naive TR saati)."""
    lim = simdi_naive.replace(hour=ACILIS_TAMAM_EN_ERKEN_SAAT, minute=0, second=0, microsecond=0)
    return simdi_naive >= lim


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
