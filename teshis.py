"""Destructive development helper for resetting selected operational tables.

This script is intentionally NOT part of the production Docker image.

Usage, local/dev only:
    set DATABASE_URL=postgresql://...
    set TESHIS_CONFIRM=KASA_CIRO_AUDIT_ONAY_SIFIRLA
    python teshis.py

Remote databases require a second explicit acknowledgement:
    set TESHIS_ALLOW_REMOTE=REMOTE_DB_RISKINI_KABUL_EDIYORUM
"""

import os
from urllib.parse import urlparse

import psycopg2


TABLES_TO_RESET = (
    "kasa_hareketleri",
    "ciro",
    "audit_log",
    "onay_kuyrugu",
)

CONFIRM_VALUE = "KASA_CIRO_AUDIT_ONAY_SIFIRLA"
REMOTE_CONFIRM_VALUE = "REMOTE_DB_RISKINI_KABUL_EDIYORUM"
REMOTE_HOST_MARKERS = (
    "railway",
    "render",
    "neon",
    "supabase",
    "amazonaws",
    "rds",
    "azure",
    "google",
)


def _require_confirmation() -> None:
    if os.environ.get("TESHIS_CONFIRM") != CONFIRM_VALUE:
        raise SystemExit(
            "HATA: Bu script kasa/ciro/audit/onay tablolarini sifirlar.\n"
            "Calistirmak icin once su onayi verin:\n"
            f"  set TESHIS_CONFIRM={CONFIRM_VALUE}"
        )


def _is_remote_database(db_url: str) -> bool:
    parsed = urlparse(db_url)
    host = (parsed.hostname or "").lower()
    if not host:
        return False
    if host in {"localhost", "127.0.0.1", "::1"}:
        return False
    return True


def _require_remote_confirmation(db_url: str) -> None:
    parsed = urlparse(db_url)
    host = (parsed.hostname or "").lower()
    looks_like_managed_db = any(marker in host for marker in REMOTE_HOST_MARKERS)

    if (_is_remote_database(db_url) or looks_like_managed_db) and (
        os.environ.get("TESHIS_ALLOW_REMOTE") != REMOTE_CONFIRM_VALUE
    ):
        raise SystemExit(
            "HATA: DATABASE_URL local olmayan bir veritabanina benziyor.\n"
            "Yanlislikla canli veriyi silmemek icin ikinci onay gerekiyor:\n"
            f"  set TESHIS_ALLOW_REMOTE={REMOTE_CONFIRM_VALUE}"
        )


def main() -> None:
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        raise SystemExit(
            "HATA: DATABASE_URL ortam degiskeni tanimli degil.\n"
            "Ornek: set DATABASE_URL=postgresql://user:pass@host/db"
        )

    _require_confirmation()
    _require_remote_confirmation(db_url)

    with psycopg2.connect(db_url) as conn:
        with conn.cursor() as cur:
            for table in TABLES_TO_RESET:
                cur.execute(f"TRUNCATE {table}")
            conn.commit()

            for table in TABLES_TO_RESET:
                cur.execute(f"SELECT COUNT(*) FROM {table}")
                print(f"{table}: {cur.fetchone()[0]}")


if __name__ == "__main__":
    main()
