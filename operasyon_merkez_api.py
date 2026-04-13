"""
Operasyon merkezi API — CFO panelinden ayrı; tüm şubelerin canlı operasyon özeti.
Prefix: /api/ops
"""
from __future__ import annotations

import json
import re
from datetime import date
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Query

from database import db
from operasyon_kurallar import vardiya_devri_bugun_baslamis_mi
from sube_kapanis_dual import vardiya_devri_tamamlandi_mi
from sube_operasyon import build_panel_operasyon_blob, _sube_getir
from sube_panel import (
    _bugun_ciro_taslak_bekliyor,
    _bugun_ciro_var_mi,
    _bugun_kasa_acildi_mi,
    _bugun_sube_acildi_mi,
)

router = APIRouter(prefix="/api/ops", tags=["operasyon-merkez"])

_YM_RE = re.compile(r"^\d{4}-\d{2}$")


def _coerce_year_month(ym: Optional[str]) -> str:
    v = (ym or "").strip()
    if not v:
        return date.today().strftime("%Y-%m")
    if not _YM_RE.match(v):
        return date.today().strftime("%Y-%m")
    return v


def _ozet_events(events: List[dict]) -> Dict[str, Any]:
    by_tip: Dict[str, List[dict]] = {}
    for e in events:
        t = e.get("tip") or ""
        by_tip.setdefault(t, []).append(e)

    def _durum_list(tip: str) -> List[str]:
        return [x.get("durum") or "" for x in by_tip.get(tip, [])]

    def _any_tamam(tip: str) -> bool:
        return any(x.get("durum") == "tamamlandi" for x in by_tip.get(tip, []))

    def _any_gecikti(tip: str) -> bool:
        return any(x.get("durum") == "gecikti" for x in by_tip.get(tip, []))

    alarm_toplam = sum(int(e.get("alarm_sayisi") or 0) for e in events)
    return {
        "acilis_tamam": _any_tamam("ACILIS"),
        "acilis_gecikti": _any_gecikti("ACILIS"),
        "kontrol_bekleyen": sum(1 for x in by_tip.get("KONTROL", []) if x.get("durum") in ("bekliyor", "gecikti")),
        "kontrol_gecikti": _any_gecikti("KONTROL"),
        "kapanis_tamam": _any_tamam("KAPANIS"),
        "kapanis_gecikti": _any_gecikti("KAPANIS"),
        "cikis_acik": any(x.get("durum") in ("bekliyor", "gecikti") for x in by_tip.get("CIKIS", [])),
        "alarm_sayisi_toplam": alarm_toplam,
        "tip_durumlar": {k: _durum_list(k) for k in ("ACILIS", "KONTROL", "CIKIS", "KAPANIS")},
    }


def _kart_uret(cur, sube_row: dict) -> Dict[str, Any]:
    sid = sube_row["id"]
    sube = dict(sube_row)
    operasyon = build_panel_operasyon_blob(cur, sid, sube)
    events = operasyon.get("events") or []
    ozet = _ozet_events(events)

    ciro_girildi = _bugun_ciro_var_mi(cur, sid)
    sube_acik = _bugun_sube_acildi_mi(cur, sid)
    kasa_acik = _bugun_kasa_acildi_mi(cur, sid)
    taslak_bek = _bugun_ciro_taslak_bekliyor(cur, sid) is not None

    kritik = bool(operasyon.get("aktif_kritik"))
    geciken = kritik or bool(operasyon.get("aktif_suphe")) or any(
        e.get("durum") == "gecikti" for e in events
    )

    cur.execute(
        """
        SELECT id, tip, seviye, fark_tl, mesaj, okundu, olusturma
        FROM sube_operasyon_uyari
        WHERE sube_id=%s AND tarih=CURRENT_DATE
        ORDER BY olusturma DESC
        LIMIT 12
        """,
        (sid,),
    )
    uyarilar: List[dict] = []
    fark_tl: Optional[float] = None
    for r in cur.fetchall():
        d = dict(r)
        if d.get("olusturma"):
            d["olusturma"] = str(d["olusturma"])
        if d.get("fark_tl") is not None:
            d["fark_tl"] = float(d["fark_tl"])
            if fark_tl is None and abs(float(d["fark_tl"])) > 0.01:
                fark_tl = float(d["fark_tl"])
        uyarilar.append(d)

    fark_var = any(
        (u.get("fark_tl") is not None and abs(float(u["fark_tl"])) > 0.01)
        or (u.get("seviye") in ("uyari", "kritik"))
        for u in uyarilar
    )

    vd_gerek = vardiya_devri_bugun_baslamis_mi(cur, sid)
    vd_ok = vardiya_devri_tamamlandi_mi(cur, sid)

    return {
        "sube_id": sid,
        "sube_adi": sube.get("ad"),
        "kasa_acik": kasa_acik,
        "sube_acik": sube_acik,
        "ciro_girildi": ciro_girildi,
        "ciro_taslak_bekliyor": taslak_bek,
        "operasyon": operasyon,
        "ozet": ozet,
        "uyarilar": uyarilar,
        "vardiya_devri_basladi": vd_gerek,
        "vardiya_devri_tamam": vd_ok,
        "bayraklar": {
            "kritik": kritik,
            "geciken": geciken,
            "fark_var": fark_var,
            "fark_tl": fark_tl,
        },
    }


@router.get("/dashboard")
def ops_dashboard(
    filtre: Optional[str] = Query(
        "all",
        description="all | kritik | geciken | fark",
    ),
):
    """
    Tüm aktif şubeler için operasyon + günlük durum kartları.
    """
    f = (filtre or "all").strip().lower()
    if f not in ("all", "kritik", "geciken", "fark"):
        f = "all"

    with db() as (conn, cur):
        cur.execute("SELECT * FROM subeler WHERE aktif=TRUE ORDER BY ad")
        subeler = cur.fetchall()
        kartlar: List[dict] = []
        for s in subeler:
            kartlar.append(_kart_uret(cur, dict(s)))

    if f == "kritik":
        kartlar = [k for k in kartlar if k["bayraklar"]["kritik"]]
    elif f == "geciken":
        kartlar = [k for k in kartlar if k["bayraklar"]["geciken"]]
    elif f == "fark":
        kartlar = [k for k in kartlar if k["bayraklar"]["fark_var"]]

    return {
        "tarih": str(date.today()),
        "filtre": f,
        "sube_sayisi": len(kartlar),
        "kartlar": kartlar,
        "tolerans": {
            "normal_tl": 50,
            "uyari_tl": 200,
            "aciklama": "Açılış kasa farkı: |fark|≤50 normal, <200 uyarı, ≥200 kritik.",
        },
    }


@router.get("/defter")
def ops_defter(
    sube_id: Optional[str] = None,
    limit: int = 300,
    year_month: Optional[str] = None,
    gun: Optional[str] = None,
):
    lim = max(10, min(800, int(limit)))
    ym = _coerce_year_month(year_month)
    gun_v = (gun or "").strip()
    with db() as (conn, cur):
        if sube_id:
            cur.execute(
                """
                SELECT id, sube_id, tarih, olay_ts, etiket, aciklama, ref_event_id,
                       personel_id, personel_ad, bildirim_saati
                FROM operasyon_defter
                WHERE sube_id=%s
                  AND to_char(tarih, 'YYYY-MM') = %s
                  AND (NULLIF(%s, '') IS NULL OR tarih = NULLIF(%s, '')::date)
                ORDER BY olay_ts DESC
                LIMIT %s
                """,
                (sube_id, ym, gun_v, gun_v, lim),
            )
        else:
            cur.execute(
                """
                SELECT d.id, d.sube_id, s.ad AS sube_adi, d.tarih, d.olay_ts, d.etiket, d.aciklama, d.ref_event_id,
                       d.personel_id, d.personel_ad, d.bildirim_saati
                FROM operasyon_defter d
                JOIN subeler s ON s.id = d.sube_id
                WHERE to_char(d.tarih, 'YYYY-MM') = %s
                  AND (NULLIF(%s, '') IS NULL OR d.tarih = NULLIF(%s, '')::date)
                ORDER BY d.olay_ts DESC
                LIMIT %s
                """,
                (ym, gun_v, gun_v, lim),
            )
        rows = [dict(x) for x in cur.fetchall()]
        for d in rows:
            if d.get("olay_ts"):
                d["olay_ts"] = str(d["olay_ts"])
            if d.get("tarih"):
                d["tarih"] = str(d["tarih"])
    return {"satirlar": rows, "limit": lim, "year_month": ym, "gun": gun_v or None}


@router.get("/sayimlar")
def ops_sayimlar(
    sube_id: Optional[str] = None,
    limit: int = 300,
    year_month: Optional[str] = None,
    gun: Optional[str] = None,
):
    lim = max(10, min(800, int(limit)))
    ym = _coerce_year_month(year_month)
    gun_v = (gun or "").strip()
    with db() as (conn, cur):
        if sube_id:
            cur.execute(
                """
                SELECT e.id AS event_id, e.sube_id, s.ad AS sube_adi,
                       e.tarih, e.cevap_ts, e.meta,
                       d.personel_id, d.personel_ad, d.bildirim_saati
                FROM sube_operasyon_event e
                JOIN subeler s ON s.id = e.sube_id
                LEFT JOIN LATERAL (
                    SELECT x.personel_id, x.personel_ad, x.bildirim_saati
                    FROM operasyon_defter x
                    WHERE x.ref_event_id = e.id
                      AND x.etiket = 'ACILIS_TAMAM'
                    ORDER BY x.olay_ts DESC
                    LIMIT 1
                ) d ON TRUE
                WHERE e.tip='ACILIS'
                  AND e.durum='tamamlandi'
                  AND e.sube_id=%s
                  AND to_char(e.tarih, 'YYYY-MM') = %s
                  AND (NULLIF(%s, '') IS NULL OR e.tarih = NULLIF(%s, '')::date)
                ORDER BY e.cevap_ts DESC NULLS LAST
                LIMIT %s
                """,
                (sube_id, ym, gun_v, gun_v, lim),
            )
        else:
            cur.execute(
                """
                SELECT e.id AS event_id, e.sube_id, s.ad AS sube_adi,
                       e.tarih, e.cevap_ts, e.meta,
                       d.personel_id, d.personel_ad, d.bildirim_saati
                FROM sube_operasyon_event e
                JOIN subeler s ON s.id = e.sube_id
                LEFT JOIN LATERAL (
                    SELECT x.personel_id, x.personel_ad, x.bildirim_saati
                    FROM operasyon_defter x
                    WHERE x.ref_event_id = e.id
                      AND x.etiket = 'ACILIS_TAMAM'
                    ORDER BY x.olay_ts DESC
                    LIMIT 1
                ) d ON TRUE
                WHERE e.tip='ACILIS'
                  AND e.durum='tamamlandi'
                  AND to_char(e.tarih, 'YYYY-MM') = %s
                  AND (NULLIF(%s, '') IS NULL OR e.tarih = NULLIF(%s, '')::date)
                ORDER BY e.cevap_ts DESC NULLS LAST
                LIMIT %s
                """,
                (ym, gun_v, gun_v, lim),
            )

        rows: List[dict] = []
        for r in cur.fetchall():
            d = dict(r)
            if d.get("tarih"):
                d["tarih"] = str(d["tarih"])
            if d.get("cevap_ts"):
                d["cevap_ts"] = str(d["cevap_ts"])
            meta_raw = d.get("meta")
            meta_obj: Dict[str, Any] = {}
            if isinstance(meta_raw, str) and meta_raw.strip():
                try:
                    meta_obj = json.loads(meta_raw)
                except Exception:
                    meta_obj = {}
            stok = meta_obj.get("acilis_stok_sayim") if isinstance(meta_obj, dict) else {}
            if not isinstance(stok, dict):
                stok = {}
            d["stok_sayim"] = {
                "bardak_kucuk": int(stok.get("bardak_kucuk") or 0),
                "bardak_buyuk": int(stok.get("bardak_buyuk") or 0),
                "bardak_plastik": int(stok.get("bardak_plastik") or 0),
                "su_adet": int(stok.get("su_adet") or 0),
                "redbull_adet": int(stok.get("redbull_adet") or 0),
                "soda_adet": int(stok.get("soda_adet") or 0),
                "cookie_adet": int(stok.get("cookie_adet") or 0),
                "pasta_adet": int(stok.get("pasta_adet") or 0),
            }
            d.pop("meta", None)
            rows.append(d)
    return {"satirlar": rows, "limit": lim, "year_month": ym, "gun": gun_v or None}


@router.get("/skor")
def ops_skor_30gun():
    """Şube bazlı gecikme / tamamlanma sayıları (son 30 gün)."""
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT e.sube_id, s.ad AS sube_adi,
                COUNT(*) FILTER (WHERE e.durum = 'gecikti') AS gecikme_adet,
                COUNT(*) FILTER (WHERE e.durum = 'tamamlandi') AS tamam_adet,
                COUNT(*) AS toplam_olay
            FROM sube_operasyon_event e
            JOIN subeler s ON s.id = e.sube_id
            WHERE e.tarih >= (CURRENT_DATE - INTERVAL '30 days')
            GROUP BY e.sube_id, s.ad
            ORDER BY gecikme_adet DESC, e.sube_id
            """
        )
        sube = [dict(x) for x in cur.fetchall()]
        cur.execute(
            """
            SELECT COUNT(*) AS uyari_kritik_30d
            FROM sube_operasyon_uyari
            WHERE tarih >= (CURRENT_DATE - INTERVAL '30 days')
              AND seviye IN ('uyari','kritik')
            """
        )
        u = dict(cur.fetchone())
    return {"son_30_gun": sube, "uyari_sayisi_uyari_kritik": int(u.get("uyari_kritik_30d") or 0)}


@router.get("/sube/{sube_id}/canli")
def ops_sube_canli(sube_id: str):
    """Tek şube canlı operasyon blob (ops panel detay / iframe)."""
    with db() as (conn, cur):
        sube = _sube_getir(cur, sube_id)
        return _kart_uret(cur, sube)
