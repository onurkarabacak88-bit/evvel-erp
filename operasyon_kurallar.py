"""
Operasyon disiplin kuralları — saf mantık (HTTP yok).
Tolerans (kasa farkı), dün kapanış referansı, alarm periyotları (gecikme dk).
"""
from __future__ import annotations

from typing import Any, Dict, Optional


def tolerans_seviyesi(fark_tl: float) -> str:
    """±50 normal, 50–200 uyarı, 200+ kritik (mutlak fark)."""
    a = abs(float(fark_tl or 0))
    if a <= 50:
        return "normal"
    if a < 200:
        return "uyari"
    return "kritik"


def beklenen_dunku_kapanis_kasa(cur: Any, sube_id: str) -> Optional[float]:
    """Dün tamamlanmış KAPANIS olayındaki kasa/teslim referansı (yoksa None)."""
    cur.execute(
        """
        SELECT COALESCE(kasa_sayim, teslim) AS ref
        FROM sube_operasyon_event
        WHERE sube_id=%s
          AND tarih = (CURRENT_DATE - INTERVAL '1 day')
          AND tip = 'KAPANIS'
          AND durum = 'tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST
        LIMIT 1
        """,
        (sube_id,),
    )
    r = cur.fetchone()
    if not r or r.get("ref") is None:
        return None
    return float(r["ref"])


def vardiya_devri_bugun_baslamis_mi(cur: Any, sube_id: str) -> bool:
    """Bugün için kapanis_kayit satırı varsa vardiya devri süreci başlamış sayılır."""
    cur.execute(
        """
        SELECT 1 FROM kapanis_kayit
        WHERE sube_id=%s AND tarih=CURRENT_DATE
        LIMIT 1
        """,
        (sube_id,),
    )
    return cur.fetchone() is not None


def alarm_politikasi(gecikme_dk: int, durum: str) -> Dict[str, Any]:
    """
    >10 dk kritik (sık bip), >5 dk uyarı; bekliyor iken daha seyrek.
    Dönüş: beep_s, alarm_arttir_s, seviye (personel UI).
    """
    d = max(0, int(gecikme_dk or 0))
    st = (durum or "").strip().lower()
    if st == "gecikti":
        if d >= 10:
            return {"beep_s": 3, "alarm_arttir_s": 30, "seviye": "kritik"}
        if d >= 5:
            return {"beep_s": 5, "alarm_arttir_s": 40, "seviye": "uyari"}
        return {"beep_s": 7, "alarm_arttir_s": 50, "seviye": "bekliyor_gec"}
    return {"beep_s": 12, "alarm_arttir_s": 60, "seviye": "bekliyor"}

