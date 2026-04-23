"""Test / geliştirme aracı — tabloları sıfırlar.

KULLANIM:
    DATABASE_URL=postgresql://... python teshis.py
"""
import os
import psycopg2

db_url = os.environ.get("DATABASE_URL")
if not db_url:
    raise SystemExit(
        "HATA: DATABASE_URL ortam değişkeni tanımlı değil.\n"
        "  Örnek: DATABASE_URL=postgresql://user:pass@host/db python teshis.py"
    )

conn = psycopg2.connect(db_url)
cur = conn.cursor()
cur.execute("TRUNCATE kasa_hareketleri")
cur.execute("TRUNCATE ciro")
cur.execute("TRUNCATE audit_log")
cur.execute("TRUNCATE onay_kuyrugu")
conn.commit()
cur.execute("SELECT COUNT(*) FROM kasa_hareketleri")
print("Kasa:", cur.fetchone())
conn.close()
