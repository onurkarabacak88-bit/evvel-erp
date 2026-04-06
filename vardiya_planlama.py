"""
Şube vardiya planlama modeli: normalize kuralları (frontend = davranış sözleşmesi).
kisi_sayisi <= 0 → aktif False sayılır.
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Tuple


def normalize_vardiya_girdileri(raw: Any) -> List[Dict[str, Any]]:
    """Vardiya satırlarını motor + API için tek forma getirir."""
    if raw is None:
        return []
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return []
        try:
            raw = json.loads(s)
        except json.JSONDecodeError:
            return []
    if not isinstance(raw, list):
        return []
    out: List[Dict[str, Any]] = []
    for x in raw:
        if not isinstance(x, dict):
            continue
        tip_raw = str(x.get("tip", "")).strip().lower()
        if tip_raw in ("acilis", "açılış", "acılıs"):
            tip_norm = "ACILIS"
        elif tip_raw in ("ara",):
            tip_norm = "ARA"
        elif tip_raw in ("kapanis", "kapanış", "kapanis"):
            tip_norm = "KAPANIS"
        else:
            continue
        try:
            ks = int(x.get("kisi_sayisi") or 0)
        except (TypeError, ValueError):
            ks = 0
        # EN KRİTİK: kisi_sayisi = 0 → aktif false
        aktif = bool(x.get("aktif", True)) and ks > 0
        if not aktif:
            ks = 0
        pt = str(x.get("personel_turu") or "farketmez").strip().lower()
        if pt not in ("tam", "part", "farketmez"):
            pt = "farketmez"
        oc = str(x.get("oncelik") or "normal").strip().lower()
        if oc in ("düşük",):
            oc = "dusuk"
        if oc not in ("kritik", "normal", "dusuk"):
            oc = "normal"
        out.append(
            {
                "tip": tip_norm,
                "aktif": aktif,
                "kisi_sayisi": ks,
                "personel_turu": pt,
                "oncelik": oc,
            }
        )
    return out


def girdilerden_need_ve_minler(
    items: List[Dict[str, Any]],
) -> Tuple[int, int, int, int]:
    """Toplam ihtiyaç (kişi) ve tipe göre minimum adet."""
    ma = mara = mkap = 0
    for it in items:
        if not it.get("aktif"):
            continue
        k = int(it.get("kisi_sayisi") or 0)
        if k <= 0:
            continue
        t = it["tip"]
        if t == "ACILIS":
            ma += k
        elif t == "ARA":
            mara += k
        elif t == "KAPANIS":
            mkap += k
    need = ma + mara + mkap
    return need, ma, mara, mkap
