#!/usr/bin/env python3
"""CLI: depo sipariş akışı kalıntılarını listele veya temizle."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from database import db
from siparis_depo_temizlik import ONAY_METNI, siparis_depo_akisi_ozet, siparis_depo_akisi_temizle


def main() -> int:
    ap = argparse.ArgumentParser(description="Depo sipariş akışı kalıntı temizliği")
    ap.add_argument("--sube-id", default="", help="Yalnızca bu şube (boş = tümü)")
    ap.add_argument("--execute", action="store_true", help="Silme işlemini uygula")
    ap.add_argument("--onay", default="", help=f"Silme için: {ONAY_METNI}")
    args = ap.parse_args()
    sid = (args.sube_id or "").strip() or None

    with db() as (conn, cur):
        ozet = siparis_depo_akisi_ozet(cur, sid)
        print(json.dumps(ozet, ensure_ascii=False, indent=2))
        if not args.execute:
            print("\nDry-run. Silmek için: --execute --onay EVET_SIL", file=sys.stderr)
            return 0
        sonuc = siparis_depo_akisi_temizle(cur, sube_id=sid, onay=args.onay)
        conn.commit()
        print(json.dumps(sonuc, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
