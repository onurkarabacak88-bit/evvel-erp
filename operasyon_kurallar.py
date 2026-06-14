"""
Operasyon disiplin kuralları.
Merkezi kontrol mantığı kontrol_motoru.py'de.
Bu dosya geriye dönük uyumluluk için korunuyor.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from tr_saat import is_gunu_tr

def tolerans_seviyesi(fark_tl: float) -> str:
    """±50 normal, 50–200 uyarı, 200+ kritik (mutlak fark)."""
    a = abs(float(fark_tl or 0))
    if a <= 50:
        return "normal"
    if a < 200:
        return "uyari"
    return "kritik"


# Kasa mutabakat/açılış farkı bu eşiğin altındaysa "önemsiz" sayılır:
# CFO/merkez tarafına kasa uyumsuzluğu olarak YİNE GÖSTERİLİR (sube_operasyon_uyari,
# onay kuyruğu, gunluk raporlar değişmez) — ama personelin kasası "açık" gibi
# algılanmaması için personel_risk_sinyal'e yansıtılmaz (puan/risk skoruna girmez).
KASA_FARK_ONEMSIZ_TL = 5.0


def kasa_fark_onemsiz_mi(fark_tl: float) -> bool:
    """Kasa açılış/kapanış farkı, personel risk skoruna yansıtılmayacak kadar
    küçük mü? (|fark| <= KASA_FARK_ONEMSIZ_TL)"""
    return abs(float(fark_tl or 0)) <= KASA_FARK_ONEMSIZ_TL


def stok_tolerans_seviyesi(fark_adet: int) -> str:
    """0-2 adet normal, 3-4 uyarı, 5+ kritik (mutlak fark)."""
    a = abs(int(fark_adet or 0))
    if a <= 2:
        return "normal"
    if a < 5:
        return "uyari"
    return "kritik"


def beklenen_dunku_kapanis_stok(cur: Any, sube_id: str) -> Optional[dict]:
    """Dün tamamlanmış KAPANIS olayındaki stok sayımını döner (meta.kapanis_stok_sayim)."""
    cur.execute(
        """
        SELECT meta FROM sube_operasyon_event
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
    if not r or not r.get("meta"):
        return None
    import json as _json
    try:
        meta = _json.loads(r["meta"]) if isinstance(r["meta"], str) else r["meta"]
        return meta.get("kapanis_stok_sayim") or None
    except Exception:
        return None


def beklenen_onceki_kapanis_kasa(
    cur: Any, sube_id: str, acilis_tarih: Any,
) -> Optional[float]:
    """
  Belirli bir açılış günü için beklenen kasa = bir önceki gün tamamlanmış KAPANIS devir.
  `acilis_tarih` = uyarı / açılış kaydının tarihi (YYYY-MM-DD).
    """
    gun = str(acilis_tarih)[:10] if acilis_tarih else None
    if not gun:
        return None
    cur.execute(
        """
        SELECT COALESCE(
            devir,
            GREATEST(0, COALESCE(kasa_sayim, 0) - COALESCE(teslim, 0))
        ) AS ref
        FROM sube_operasyon_event
        WHERE sube_id=%s
          AND tarih = (%s::date - INTERVAL '1 day')
          AND tip = 'KAPANIS'
          AND durum = 'tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST
        LIMIT 1
        """,
        (sube_id, gun),
    )
    r = cur.fetchone()
    if not r:
        return None
    ref = dict(r).get("ref")
    if ref is None:
        return None
    return float(ref)


def beklenen_dunku_kapanis_kasa(cur: Any, sube_id: str) -> Optional[float]:
    """
    Bugünkü açılış için beklenen kasa (iş günü - 1 gün KAPANIS devir).
    Geriye dönük: `beklenen_onceki_kapanis_kasa(cur, sube_id, is_gunu_tr())`.
    """
    from tr_saat import is_gunu_tr

    return beklenen_onceki_kapanis_kasa(cur, sube_id, is_gunu_tr())


def vardiya_devri_bugun_baslamis_mi(cur: Any, sube_id: str) -> bool:
    """Yalnızca sabah→akşam vardiya devri kaydı (akşam kapanış kaydı değil)."""
    cur.execute(
        """
        SELECT 1 FROM kapanis_kayit
        WHERE sube_id=%s AND tarih=%s AND olay='vardiya_sabah_aksam_devri'
        LIMIT 1
        """,
        (sube_id, is_gunu_tr()),
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

