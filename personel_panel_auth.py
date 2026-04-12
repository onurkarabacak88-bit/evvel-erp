"""Şube paneli PIN — personel bazlı (tüm şubelerde aynı PIN).

Test / geliştirme: ortamda **yalnızca yerel veya güvenli ortamda**
`SUBE_PANEL_TEST_PIN=1234` (4 rakam) verilirse bu PIN, veritabanında
PIN tanımı olmayan aktif personel ile de doğrulamayı geçirir.
Üretimde bu değişkeni tanımlamayın.
"""
from __future__ import annotations

import hashlib
import logging
import os
from typing import Any, Dict, List

from fastapi import HTTPException

_log = logging.getLogger(__name__)


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
    if panel_pin_hash(p, salt) != ph:
        raise HTTPException(403, "PIN hatalı")
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
        cur.execute(
            """
            SELECT id, ad_soyad AS ad, COALESCE(panel_yonetici, FALSE) AS yonetici
            FROM personel
            WHERE aktif = TRUE
              AND panel_pin_hash IS NOT NULL
              AND TRIM(COALESCE(panel_pin_hash, '')) <> ''
              AND panel_pin_salt IS NOT NULL
              AND TRIM(COALESCE(panel_pin_salt, '')) <> ''
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
