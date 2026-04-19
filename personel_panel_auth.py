"""Şube paneli PIN — personel bazlı (tüm şubelerde aynı PIN).

Test / geliştirme: ortamda **yalnızca yerel veya güvenli ortamda**
`SUBE_PANEL_TEST_PIN=1234` (4 rakam) verilirse bu PIN, veritabanında
PIN tanımı olmayan aktif personel ile de doğrulamayı geçirir.
Üretimde bu değişkeni tanımlamayın.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException

_log = logging.getLogger(__name__)


def _panel_pin_limitleri() -> Tuple[int, int]:
    """(max_yanlis, kilit_dakika) — ortamla sınırlı makul aralık."""
    try:
        my = int((os.environ.get("EVVEL_PANEL_PIN_MAX_YANLIS") or "5").strip())
    except ValueError:
        my = 5
    try:
        dk = int((os.environ.get("EVVEL_PANEL_PIN_KILIT_DK") or "15").strip())
    except ValueError:
        dk = 15
    return max(3, min(my, 20)), max(5, min(dk, 120))


def _ts_aware(ts: Any) -> datetime:
    if ts is None:
        return datetime.now(timezone.utc)
    if isinstance(ts, datetime):
        if ts.tzinfo is None:
            return ts.replace(tzinfo=timezone.utc)
        return ts.astimezone(timezone.utc)
    return datetime.now(timezone.utc)


def _guvenlik_olay_yaz(
    cur: Any,
    *,
    tip: str,
    personel_id: Optional[str] = None,
    sube_id: Optional[str] = None,
    detay: Optional[Dict[str, Any]] = None,
) -> None:
    """Faz 5: PIN güvenlik olayları (izleme/rapor)."""
    try:
        cur.execute(
            """
            INSERT INTO operasyon_guvenlik_olay
                (id, olay_ts, tip, personel_id, sube_id, detay)
            VALUES (%s, NOW(), %s, %s, %s, %s)
            """,
            (
                str(uuid.uuid4()),
                (tip or "")[:120],
                personel_id,
                sube_id,
                json.dumps(detay or {}, ensure_ascii=False),
            ),
        )
    except Exception:
        _log.exception("operasyon_guvenlik_olay insert basarisiz")


def panel_pin_guvenlik_kontrol(
    cur: Any,
    personel_id: str,
    *,
    sube_id: Optional[str] = None,
) -> None:
    """Kilit aktifse 429; süresi dolmuşsa sayaç sıfırlanır."""
    cur.execute(
        """
        SELECT yanlis_sayaci, kilit_bitis_ts
        FROM panel_pin_guvenlik
        WHERE personel_id=%s
        FOR UPDATE
        """,
        (personel_id,),
    )
    row = cur.fetchone()
    if not row:
        return
    r = dict(row)
    kb = r.get("kilit_bitis_ts")
    if not kb:
        return
    now = datetime.now(timezone.utc)
    kb_a = _ts_aware(kb)
    if now < kb_a:
        kalan = max(1, math.ceil((kb_a - now).total_seconds() / 60.0))
        _guvenlik_olay_yaz(
            cur,
            tip="PIN_KILITTE_DENEME",
            personel_id=personel_id,
            sube_id=sube_id,
            detay={"kalan_dk": kalan},
        )
        raise HTTPException(
            429,
            f"PIN çok kez hatalı girildi. Yaklaşık {kalan} dakika sonra tekrar deneyin.",
        )
    cur.execute(
        "UPDATE panel_pin_guvenlik SET yanlis_sayaci=0, kilit_bitis_ts=NULL WHERE personel_id=%s",
        (personel_id,),
    )


def panel_pin_yanlis_isaretle(
    cur: Any,
    personel_id: str,
    *,
    sube_id: Optional[str] = None,
) -> None:
    my, dk = _panel_pin_limitleri()
    cur.execute(
        """
        INSERT INTO panel_pin_guvenlik (personel_id, yanlis_sayaci, son_yanlis_ts)
        VALUES (%s, 1, NOW())
        ON CONFLICT (personel_id) DO UPDATE SET
          yanlis_sayaci = panel_pin_guvenlik.yanlis_sayaci + 1,
          son_yanlis_ts = EXCLUDED.son_yanlis_ts
        RETURNING yanlis_sayaci
        """,
        (personel_id,),
    )
    c = int(cur.fetchone()["yanlis_sayaci"])
    _guvenlik_olay_yaz(
        cur,
        tip="PIN_HATALI",
        personel_id=personel_id,
        sube_id=sube_id,
        detay={"yanlis_sayac": c},
    )
    if c >= my:
        cur.execute(
            """
            UPDATE panel_pin_guvenlik
            SET kilit_bitis_ts = NOW() + (%s * INTERVAL '1 minute')
            WHERE personel_id = %s
            """,
            (dk, personel_id),
        )
        _guvenlik_olay_yaz(
            cur,
            tip="PIN_KILIT",
            personel_id=personel_id,
            sube_id=sube_id,
            detay={"kilit_dk": dk, "esik": my},
        )


def panel_pin_basarili_temizle(cur: Any, personel_id: str) -> None:
    cur.execute("DELETE FROM panel_pin_guvenlik WHERE personel_id=%s", (personel_id,))


def panel_pin_hash(pin: str, salt: str) -> str:
    return hashlib.sha256(f"{salt}:{pin}".encode()).hexdigest()


def sube_panel_test_pin_aktif() -> bool:
    p = (os.environ.get("SUBE_PANEL_TEST_PIN") or "").strip()
    return len(p) == 4 and p.isdigit()


def _sube_panel_test_pin_deger() -> str:
    return (os.environ.get("SUBE_PANEL_TEST_PIN") or "").strip()


def dogrula_personel_panel_pin(cur: Any, personel_id: str, pin: str) -> Dict[str, Any]:
    cur.execute(
        """
        SELECT id, ad_soyad, aktif, sube_id,
               panel_pin_salt, panel_pin_hash, COALESCE(panel_yonetici, FALSE) AS panel_yonetici
        FROM personel WHERE id=%s
        """,
        (personel_id,),
    )
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Personel bulunamadı")
    u = dict(r)
    if not u.get("aktif"):
        raise HTTPException(403, "Personel aktif değil")
    salt = (u.get("panel_pin_salt") or "").strip()
    ph = (u.get("panel_pin_hash") or "").strip()
    if not salt or not ph:
        raise HTTPException(403, "Bu personel için panel PIN merkezde tanımlanmamış.")
    p = (pin or "").strip()
    if len(p) != 4 or not p.isdigit():
        raise HTTPException(400, "4 haneli PIN gerekli")
    sube_id = (u.get("sube_id") or "").strip() or None
    panel_pin_guvenlik_kontrol(cur, personel_id, sube_id=sube_id)
    if panel_pin_hash(p, salt) != ph:
        panel_pin_yanlis_isaretle(cur, personel_id, sube_id=sube_id)
        raise HTTPException(403, "PIN hatalı")
    panel_pin_basarili_temizle(cur, personel_id)
    u["yonetici"] = bool(u.get("panel_yonetici"))
    return u


def dogrula_personel_panel_yonetici(cur: Any, personel_id: str, pin: str) -> Dict[str, Any]:
    u = dogrula_personel_panel_pin(cur, personel_id, pin)
    if not u.get("yonetici"):
        raise HTTPException(403, "Bu işlem için panel yöneticisi (personel) olmalısınız.")
    return u


def list_personel_panel_secim(cur: Any) -> List[Dict[str, Any]]:
    if sube_panel_test_pin_aktif():
        cur.execute(
            """
            SELECT id, ad_soyad AS ad, COALESCE(panel_yonetici, FALSE) AS yonetici
            FROM personel
            WHERE aktif = TRUE
            ORDER BY ad_soyad
            """
        )
    else:
        # Merkez (CFO) tarafında "PIN tanımlı" yalnızca hash ile işaretlenir; aynı kişiler şube
        # panelinde görünmeli. PIN doğrulaması yine salt+hash ister (dogrula_personel_panel_pin).
        cur.execute(
            """
            SELECT id, ad_soyad AS ad, COALESCE(panel_yonetici, FALSE) AS yonetici
            FROM personel
            WHERE aktif = TRUE
              AND panel_pin_hash IS NOT NULL
              AND TRIM(COALESCE(panel_pin_hash, '')) <> ''
            ORDER BY ad_soyad
            """
        )
    rows = [dict(x) for x in cur.fetchall()]
    for r in rows:
        r["yonetici"] = bool(r.get("yonetici"))
    return rows


def count_personel_panel_yonetici(cur: Any) -> int:
    cur.execute(
        """
        SELECT COUNT(*)::int AS c FROM personel
        WHERE aktif = TRUE AND COALESCE(panel_yonetici, FALSE) = TRUE
        """
    )
    return int(cur.fetchone()["c"])
