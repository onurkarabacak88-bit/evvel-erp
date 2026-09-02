"""
🛡️ İSTEK İZİ — ağ retry'ına karşı paylaşılan idempotency defteri.

NEDEN AYRI MODÜL (2026-09-02):
  Bu defter önce `main.py` içinde doğdu (PARA-011: vadeli alımda ağ retry'ı
  borcu sessizce ikiye katlıyordu). Sonra aynı desen `sube_panel.py`'de de
  gerekti (SUBE-004: ad-hoc ürün sevkinde mükerrer POST stoğu iki kez
  artırıyor). `sube_panel` `main`i import EDEMEZ — `main` zaten o router'ı
  import ediyor, döngü olur.
  İki seçenek vardı: mantığı KOPYALAMAK ya da ortak yere almak. Kopya, gün
  gelir ayrışır ve o gün iki uç farklı davranır — "aynı iş iki yerde ayrı
  yazılmaz" kuralının idempotency hâli.

NASIL ÇALIŞIR:
  İşin ANLAMINI taşıyan alanlardan bir parmak izi üretilir. Pencere içinde
  aynı parmak yeniden gelirse iş TEKRAR YAPILMAZ; önceki sonuç geri verilir.
  Çağıran isterse bunu bir uyarıya çevirir, isterse 409 atar.

⚠️ Pencere seçimi asimetriktir: mükerrer yazım SESSİZDİR (kimse fark etmez),
   engellenen yazım ise EKRANDA GÖRÜNÜR (kullanıcı tekrar dener). Bu yüzden
   şüphede kalınca engellemek doğrudur.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, Optional

# Varsayılan pencere. Ağ retry'ı saniyeler içinde olur; 3 dakika arayla
# gelen birebir aynı istek gerçek bir ikinci iştir.
ISTEK_IZI_PENCERE_SN = 180


def ensure_istek_izi(cur: Any) -> None:
    cur.execute("""
        CREATE TABLE IF NOT EXISTS istek_izi (
            parmak     TEXT PRIMARY KEY,
            kapsam     TEXT NOT NULL,
            sonuc      JSONB,
            olusturma  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS ix_istek_izi_ts ON istek_izi (olusturma DESC)")


def istek_parmak(kapsam: str, *parcalar: Any) -> str:
    """Kapsam + anlamlı alanlardan deterministik parmak izi."""
    ham = kapsam + "|" + "|".join(
        str(p if p is not None else "").strip().lower() for p in parcalar)
    return hashlib.md5(ham.encode("utf-8")).hexdigest()


def istek_izi_tazeyse(cur: Any, parmak: str,
                      pencere_sn: int = ISTEK_IZI_PENCERE_SN) -> Optional[Dict[str, Any]]:
    """Pencere içinde aynı parmak varsa ÖNCEKİ sonucu döner; yoksa None."""
    ensure_istek_izi(cur)
    cur.execute(
        """SELECT sonuc FROM istek_izi
           WHERE parmak=%s AND olusturma >= NOW() - (%s || ' seconds')::interval""",
        (parmak, pencere_sn),
    )
    r = cur.fetchone()
    if not r:
        return None
    s = dict(r).get("sonuc")
    if isinstance(s, dict):
        return s
    try:
        return json.loads(s) if s else {}
    except Exception:
        return {}


def istek_izi_yaz(cur: Any, parmak: str, kapsam: str, sonuc: Dict[str, Any]) -> None:
    """İşi izle. Aynı transaction'da olduğu için iş geri sarılırsa iz de sarılır."""
    ensure_istek_izi(cur)
    cur.execute(
        """INSERT INTO istek_izi (parmak, kapsam, sonuc, olusturma)
           VALUES (%s, %s, %s::jsonb, NOW())
           ON CONFLICT (parmak) DO UPDATE SET sonuc=EXCLUDED.sonuc, olusturma=NOW()""",
        (parmak, kapsam, json.dumps(sonuc, default=str)),
    )
