"""
Operasyon merkezi API — CFO panelinden ayrı; tüm şubelerin canlı operasyon özeti.
Prefix: /api/ops
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
from datetime import date, datetime
from typing import Any, Dict, List, Optional
from urllib.parse import quote

from fastapi import APIRouter, Query
from fastapi.responses import Response
from pydantic import BaseModel

from database import db
from operasyon_defter import (
    operasyon_defter_satir_imza_gecerli,
    operasyon_defter_zincir_satirlari_dogrula,
)
from operasyon_kurallar import vardiya_devri_bugun_baslamis_mi
from sube_kapanis_dual import vardiya_devri_tamamlandi_mi
from sube_operasyon import build_panel_operasyon_blob, _sube_getir
from ciro_taslak_api import _taslak_dict
from operasyon_stok_motor import build_virtual_merkez_uyarilari
from sube_panel import (
    _bugun_ciro_taslak_bekliyor,
    _bugun_ciro_var_mi,
    _bugun_kasa_acildi_mi,
    _bugun_sube_acildi_mi,
)

router = APIRouter(prefix="/api/ops", tags=["operasyon-merkez"])

_YM_RE = re.compile(r"^\d{4}-\d{2}$")


class GuvenlikAlarmIslemBody(BaseModel):
    personel_id: Optional[str] = None
    notu: Optional[str] = None
    sustur_dk: int = 120


def _coerce_year_month(ym: Optional[str]) -> str:
    v = (ym or "").strip()
    if not v:
        return date.today().strftime("%Y-%m")
    if not _YM_RE.match(v):
        return date.today().strftime("%Y-%m")
    return v


def _guvenlik_alarm_limitleri() -> Dict[str, int]:
    try:
        pencere = int((os.environ.get("EVVEL_GUV_ALARM_DK") or "15").strip())
    except ValueError:
        pencere = 15
    try:
        pin_kilit_esik = int((os.environ.get("EVVEL_GUV_ALARM_PIN_KILIT") or "2").strip())
    except ValueError:
        pin_kilit_esik = 2
    try:
        pin_hatali_esik = int((os.environ.get("EVVEL_GUV_ALARM_PIN_HATALI") or "8").strip())
    except ValueError:
        pin_hatali_esik = 8
    return {
        "pencere_dk": max(5, min(pencere, 240)),
        "pin_kilit_esik": max(1, min(pin_kilit_esik, 50)),
        "pin_hatali_esik": max(1, min(pin_hatali_esik, 200)),
    }


def _sube_guvenlik_alarm_ozet(cur: Any, sube_id: str, lim: Dict[str, int]) -> Dict[str, Any]:
    cur.execute(
        """
        SELECT
          COUNT(*) FILTER (WHERE tip='PIN_KILIT')::int AS pin_kilit_adet,
          COUNT(*) FILTER (WHERE tip='PIN_HATALI')::int AS pin_hatali_adet,
          COUNT(*) FILTER (WHERE tip='PIN_KILITTE_DENEME')::int AS pin_kilitte_deneme_adet,
          MAX(olay_ts) AS son_olay_ts
        FROM operasyon_guvenlik_olay
        WHERE sube_id=%s
          AND olay_ts >= NOW() - (%s * INTERVAL '1 minute')
        """,
        (sube_id, lim["pencere_dk"]),
    )
    r = dict(cur.fetchone() or {})
    pin_kilit = int(r.get("pin_kilit_adet") or 0)
    pin_hatali = int(r.get("pin_hatali_adet") or 0)
    pin_kilitte_deneme = int(r.get("pin_kilitte_deneme_adet") or 0)
    alarm = pin_kilit >= lim["pin_kilit_esik"] or pin_hatali >= lim["pin_hatali_esik"]
    seviye = "kritik" if pin_kilit >= lim["pin_kilit_esik"] else ("uyari" if alarm else "normal")
    mesaj = None
    if pin_kilit >= lim["pin_kilit_esik"]:
        mesaj = f"PIN_KILIT son {lim['pencere_dk']} dk: {pin_kilit} (eşik {lim['pin_kilit_esik']})"
    elif pin_hatali >= lim["pin_hatali_esik"]:
        mesaj = f"PIN_HATALI son {lim['pencere_dk']} dk: {pin_hatali} (eşik {lim['pin_hatali_esik']})"
    out = {
        "pencere_dk": lim["pencere_dk"],
        "pin_kilit_adet": pin_kilit,
        "pin_hatali_adet": pin_hatali,
        "pin_kilitte_deneme_adet": pin_kilitte_deneme,
        "alarm": alarm,
        "seviye": seviye,
        "mesaj": mesaj,
    }
    if r.get("son_olay_ts"):
        out["son_olay_ts"] = str(r["son_olay_ts"])
    return out


def _alarm_durum_get(cur: Any, sube_id: str) -> Optional[Dict[str, Any]]:
    cur.execute(
        """
        SELECT sube_id, durum, islem_ts, islem_personel_id, islem_notu, sustur_bitis_ts
        FROM operasyon_guvenlik_alarm_durum
        WHERE sube_id=%s
        """,
        (sube_id,),
    )
    row = cur.fetchone()
    if not row:
        return None
    d = dict(row)
    if d.get("durum") == "susturuldu" and d.get("sustur_bitis_ts"):
        # Süresi dolan susturma, otomatik pasife düşer.
        cur.execute(
            """
            DELETE FROM operasyon_guvenlik_alarm_durum
            WHERE sube_id=%s
              AND durum='susturuldu'
              AND sustur_bitis_ts IS NOT NULL
              AND sustur_bitis_ts <= NOW()
            """,
            (sube_id,),
        )
        if cur.rowcount:
            return None
    if d.get("islem_ts"):
        d["islem_ts"] = str(d["islem_ts"])
    if d.get("sustur_bitis_ts"):
        d["sustur_bitis_ts"] = str(d["sustur_bitis_ts"])
    return d


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


def _kart_uret(cur, sube_row: dict, guvenlik_lim: Dict[str, int]) -> Dict[str, Any]:
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

    virt = build_virtual_merkez_uyarilari(cur, sid, datetime.now())
    uyarilar = virt + uyarilar

    fark_var = any(
        (u.get("fark_tl") is not None and abs(float(u["fark_tl"])) > 0.01)
        or (u.get("seviye") in ("uyari", "kritik"))
        for u in uyarilar
    )

    vd_gerek = vardiya_devri_bugun_baslamis_mi(cur, sid)
    vd_ok = vardiya_devri_tamamlandi_mi(cur, sid)
    guvenlik = _sube_guvenlik_alarm_ozet(cur, sid, guvenlik_lim)
    alarm_durum = _alarm_durum_get(cur, sid)
    guvenlik["alarm_durum"] = alarm_durum
    sustur_aktif = bool(alarm_durum and alarm_durum.get("durum") == "susturuldu")
    guvenlik["alarm_goster"] = bool(guvenlik.get("alarm")) and not sustur_aktif

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
        "guvenlik": guvenlik,
        "vardiya_devri_basladi": vd_gerek,
        "vardiya_devri_tamam": vd_ok,
        "bayraklar": {
            "kritik": kritik,
            "geciken": geciken,
            "fark_var": fark_var,
            "fark_tl": fark_tl,
            "guvenlik_alarm": bool(guvenlik.get("alarm_goster")),
        },
    }


@router.get("/dashboard")
def ops_dashboard(
    filtre: Optional[str] = Query(
        "all",
        description="all | kritik | geciken | fark | guvenlik | stok",
    ),
):
    """
    Tüm aktif şubeler için operasyon + günlük durum kartları.
    """
    f = (filtre or "all").strip().lower()
    if f not in ("all", "kritik", "geciken", "fark", "guvenlik", "stok"):
        f = "all"

    with db() as (conn, cur):
        cur.execute("SELECT * FROM subeler WHERE aktif=TRUE ORDER BY ad")
        subeler = cur.fetchall()
        guvenlik_lim = _guvenlik_alarm_limitleri()
        kartlar: List[dict] = []
        for s in subeler:
            kartlar.append(_kart_uret(cur, dict(s), guvenlik_lim))

    if f == "kritik":
        kartlar = [k for k in kartlar if k["bayraklar"]["kritik"]]
    elif f == "geciken":
        kartlar = [k for k in kartlar if k["bayraklar"]["geciken"]]
    elif f == "fark":
        kartlar = [k for k in kartlar if k["bayraklar"]["fark_var"]]
    elif f == "guvenlik":
        kartlar = [k for k in kartlar if k["bayraklar"]["guvenlik_alarm"]]
    elif f == "stok":
        def _stok_es(k):
            for u in k.get("uyarilar") or []:
                t = (u.get("tip") or "")
                if t.startswith("STOK_") or t == "KONTROL_CEVAP_GECIKME":
                    return True
            return False

        kartlar = [k for k in kartlar if _stok_es(k)]

    return {
        "tarih": str(date.today()),
        "filtre": f,
        "sube_sayisi": len(kartlar),
        "guvenlik_alarmli_sube_sayisi": sum(1 for k in kartlar if k["bayraklar"].get("guvenlik_alarm")),
        "kartlar": kartlar,
        "guvenlik_alarm_limitleri": _guvenlik_alarm_limitleri(),
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
    zincir_dogrula: bool = False,
):
    lim = max(10, min(800, int(limit)))
    ym = _coerce_year_month(year_month)
    gun_v = (gun or "").strip()
    zincir_ozet: Optional[Dict[str, Any]] = None
    with db() as (conn, cur):
        if sube_id:
            cur.execute(
                """
                SELECT id, sube_id, tarih, olay_ts, etiket, aciklama, ref_event_id,
                       personel_id, personel_ad, bildirim_saati, imza_hmac,
                       defter_onceki_id, defter_zincir_hmac
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
                       d.personel_id, d.personel_ad, d.bildirim_saati, d.imza_hmac,
                       d.defter_onceki_id, d.defter_zincir_hmac
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
            d["imza_gecerli"] = operasyon_defter_satir_imza_gecerli(d)
            if d.get("olay_ts"):
                d["olay_ts"] = str(d["olay_ts"])
            if d.get("tarih"):
                d["tarih"] = str(d["tarih"])

        if zincir_dogrula and sube_id:
            cur.execute(
                """
                SELECT id, imza_hmac, defter_zincir_hmac, olay_ts
                FROM operasyon_defter
                WHERE sube_id=%s
                  AND to_char(tarih, 'YYYY-MM') = %s
                  AND (NULLIF(%s, '') IS NULL OR tarih = NULLIF(%s, '')::date)
                ORDER BY olay_ts ASC NULLS LAST, id ASC
                """,
                (sube_id, ym, gun_v, gun_v),
            )
            chrono = [dict(x) for x in cur.fetchall()]
            zincir_ozet = operasyon_defter_zincir_satirlari_dogrula(chrono)

    out: Dict[str, Any] = {
        "satirlar": rows,
        "limit": lim,
        "year_month": ym,
        "gun": gun_v or None,
    }
    if zincir_dogrula:
        out["zincir_dogrula"] = zincir_ozet
    return out


@router.get("/defter-guvenlik-ozet")
def ops_defter_guvenlik_ozet(year_month: Optional[str] = None):
    """
    Şube bazlı: seçilen ayda defter satır sayısı, imzasız / imza geçersiz sayıları,
    kronolojik zincir doğrulaması (Faz 2).
    """
    ym = _coerce_year_month(year_month)
    with db() as (conn, cur):
        cur.execute("SELECT id, ad FROM subeler WHERE aktif=TRUE ORDER BY ad")
        subeler = cur.fetchall()
        sube_satirlar: List[dict] = []
        for s in subeler:
            sid = str(s["id"])
            cur.execute(
                """
                SELECT id, sube_id, tarih, olay_ts, etiket, aciklama, ref_event_id,
                       personel_id, personel_ad, bildirim_saati, imza_hmac,
                       defter_onceki_id, defter_zincir_hmac
                FROM operasyon_defter
                WHERE sube_id=%s AND to_char(tarih, 'YYYY-MM') = %s
                ORDER BY olay_ts ASC NULLS LAST, id ASC
                """,
                (sid, ym),
            )
            rows = [dict(x) for x in cur.fetchall()]
            imzasiz = sum(1 for r in rows if not (str(r.get("imza_hmac") or "").strip()))
            imza_gecersiz = 0
            for r in rows:
                v = operasyon_defter_satir_imza_gecerli(r)
                if v is False:
                    imza_gecersiz += 1
            zincir = (
                operasyon_defter_zincir_satirlari_dogrula(rows)
                if rows
                else {"gecerli": True, "incelenen_zincir_satir": 0}
            )
            sube_satirlar.append(
                {
                    "sube_id": sid,
                    "sube_adi": s.get("ad"),
                    "ay_satir": len(rows),
                    "imzasiz_satir": imzasiz,
                    "imza_gecersiz_satir": imza_gecersiz,
                    "zincir_ay": zincir,
                }
            )
    return {"year_month": ym, "subeler": sube_satirlar}


@router.get("/guvenlik-olaylar")
def ops_guvenlik_olaylar(
    sube_id: Optional[str] = None,
    tip: Optional[str] = None,
    limit: int = 300,
    year_month: Optional[str] = None,
    gun: Optional[str] = None,
):
    """Faz 5: PIN güvenlik olayları listesini döndürür."""
    lim = max(10, min(2000, int(limit)))
    ym = _coerce_year_month(year_month)
    gun_v = (gun or "").strip()
    tip_v = (tip or "").strip()
    sube_v = (sube_id or "").strip()
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT id, olay_ts, tip, personel_id, sube_id, detay
            FROM operasyon_guvenlik_olay
            WHERE to_char(olay_ts::date, 'YYYY-MM') = %s
              AND (NULLIF(%s, '') IS NULL OR olay_ts::date = NULLIF(%s, '')::date)
              AND (NULLIF(%s, '') IS NULL OR sube_id = NULLIF(%s, ''))
              AND (NULLIF(%s, '') IS NULL OR tip = NULLIF(%s, ''))
            ORDER BY olay_ts DESC
            LIMIT %s
            """,
            (ym, gun_v, gun_v, sube_v, sube_v, tip_v, tip_v, lim),
        )
        rows = [dict(x) for x in cur.fetchall()]
    for d in rows:
        if d.get("olay_ts"):
            d["olay_ts"] = str(d["olay_ts"])
        raw = d.get("detay")
        if isinstance(raw, str) and raw.strip():
            try:
                d["detay"] = json.loads(raw)
            except Exception:
                pass
    return {"satirlar": rows, "limit": lim, "year_month": ym, "gun": gun_v or None}


@router.get("/guvenlik-ozet")
def ops_guvenlik_ozet(
    sube_id: Optional[str] = None,
    year_month: Optional[str] = None,
    gun: Optional[str] = None,
):
    """Faz 5: güvenlik olaylarını tip bazında özetler."""
    ym = _coerce_year_month(year_month)
    gun_v = (gun or "").strip()
    sube_v = (sube_id or "").strip()
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT tip, COUNT(*)::int AS adet, MAX(olay_ts) AS son_olay_ts
            FROM operasyon_guvenlik_olay
            WHERE to_char(olay_ts::date, 'YYYY-MM') = %s
              AND (NULLIF(%s, '') IS NULL OR olay_ts::date = NULLIF(%s, '')::date)
              AND (NULLIF(%s, '') IS NULL OR sube_id = NULLIF(%s, ''))
            GROUP BY tip
            ORDER BY adet DESC, tip
            """,
            (ym, gun_v, gun_v, sube_v, sube_v),
        )
        tipler = [dict(x) for x in cur.fetchall()]
    toplam = 0
    for t in tipler:
        t["adet"] = int(t.get("adet") or 0)
        toplam += t["adet"]
        if t.get("son_olay_ts"):
            t["son_olay_ts"] = str(t["son_olay_ts"])
    return {
        "year_month": ym,
        "gun": gun_v or None,
        "sube_id": sube_v or None,
        "toplam_olay": toplam,
        "tipler": tipler,
    }


@router.get("/guvenlik-alarmlar")
def ops_guvenlik_alarmlar():
    """
    Faz 6: aktif şube güvenlik alarmları (kısa pencere + eşik).
    Eşikler env:
      EVVEL_GUV_ALARM_DK (varsayılan 15)
      EVVEL_GUV_ALARM_PIN_KILIT (varsayılan 2)
      EVVEL_GUV_ALARM_PIN_HATALI (varsayılan 8)
    """
    lim = _guvenlik_alarm_limitleri()
    with db() as (conn, cur):
        cur.execute("SELECT id, ad FROM subeler WHERE aktif=TRUE ORDER BY ad")
        subeler = [dict(x) for x in cur.fetchall()]
        alarmlar: List[dict] = []
        for s in subeler:
            sid = str(s["id"])
            ozet = _sube_guvenlik_alarm_ozet(cur, sid, lim)
            if not ozet.get("alarm"):
                continue
            alarm_durum = _alarm_durum_get(cur, sid)
            sustur_aktif = bool(alarm_durum and alarm_durum.get("durum") == "susturuldu")
            alarmlar.append(
                {
                    "sube_id": sid,
                    "sube_adi": s.get("ad"),
                    "seviye": ozet.get("seviye"),
                    "mesaj": ozet.get("mesaj"),
                    "alarm_durum": alarm_durum,
                    "susturuldu": sustur_aktif,
                    "detay": ozet,
                }
            )
    aktif_alarmlar = [a for a in alarmlar if not a.get("susturuldu")]
    return {
        "limitler": lim,
        "alarm_sayisi": len(aktif_alarmlar),
        "toplam_alarm_kaydi": len(alarmlar),
        "alarmlar": alarmlar,
    }


@router.post("/guvenlik-alarmlar/{sube_id}/okundu")
def ops_guvenlik_alarm_okundu(sube_id: str, body: GuvenlikAlarmIslemBody = GuvenlikAlarmIslemBody()):
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        cur.execute(
            """
            INSERT INTO operasyon_guvenlik_alarm_durum
                (sube_id, durum, islem_ts, islem_personel_id, islem_notu, sustur_bitis_ts)
            VALUES (%s, 'okundu', NOW(), %s, %s, NULL)
            ON CONFLICT (sube_id) DO UPDATE SET
                durum='okundu',
                islem_ts=NOW(),
                islem_personel_id=EXCLUDED.islem_personel_id,
                islem_notu=EXCLUDED.islem_notu,
                sustur_bitis_ts=NULL
            """,
            (
                sube_id,
                (body.personel_id or "").strip() or None,
                (body.notu or "").strip()[:300] or None,
            ),
        )
        durum = _alarm_durum_get(cur, sube_id)
    return {"success": True, "sube_id": sube_id, "alarm_durum": durum}


@router.post("/guvenlik-alarmlar/{sube_id}/sustur")
def ops_guvenlik_alarm_sustur(sube_id: str, body: GuvenlikAlarmIslemBody = GuvenlikAlarmIslemBody()):
    sustur_dk = max(5, min(int(body.sustur_dk or 120), 24 * 60))
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        cur.execute(
            """
            INSERT INTO operasyon_guvenlik_alarm_durum
                (sube_id, durum, islem_ts, islem_personel_id, islem_notu, sustur_bitis_ts)
            VALUES (%s, 'susturuldu', NOW(), %s, %s, NOW() + (%s * INTERVAL '1 minute'))
            ON CONFLICT (sube_id) DO UPDATE SET
                durum='susturuldu',
                islem_ts=NOW(),
                islem_personel_id=EXCLUDED.islem_personel_id,
                islem_notu=EXCLUDED.islem_notu,
                sustur_bitis_ts=EXCLUDED.sustur_bitis_ts
            """,
            (
                sube_id,
                (body.personel_id or "").strip() or None,
                (body.notu or "").strip()[:300] or None,
                sustur_dk,
            ),
        )
        durum = _alarm_durum_get(cur, sube_id)
    return {"success": True, "sube_id": sube_id, "sustur_dk": sustur_dk, "alarm_durum": durum}


@router.get("/defter-export")
def ops_defter_export(
    year_month: Optional[str] = None,
    sube_id: Optional[str] = None,
    gun: Optional[str] = None,
):
    """Seçilen dönem için operasyon defteri CSV (UTF-8, Excel uyumu için BOM)."""
    ym = _coerce_year_month(year_month)
    gun_v = (gun or "").strip()
    max_rows = 25000
    with db() as (conn, cur):
        if sube_id:
            cur.execute(
                """
                SELECT id, sube_id, tarih, olay_ts, etiket, aciklama, ref_event_id,
                       personel_id, personel_ad, bildirim_saati, imza_hmac,
                       defter_onceki_id, defter_zincir_hmac
                FROM operasyon_defter
                WHERE sube_id=%s
                  AND to_char(tarih, 'YYYY-MM') = %s
                  AND (NULLIF(%s, '') IS NULL OR tarih = NULLIF(%s, '')::date)
                ORDER BY olay_ts ASC NULLS LAST, id ASC
                LIMIT %s
                """,
                (sube_id, ym, gun_v, gun_v, max_rows),
            )
        else:
            cur.execute(
                """
                SELECT id, sube_id, tarih, olay_ts, etiket, aciklama, ref_event_id,
                       personel_id, personel_ad, bildirim_saati, imza_hmac,
                       defter_onceki_id, defter_zincir_hmac
                FROM operasyon_defter
                WHERE to_char(tarih, 'YYYY-MM') = %s
                  AND (NULLIF(%s, '') IS NULL OR tarih = NULLIF(%s, '')::date)
                ORDER BY olay_ts ASC NULLS LAST, id ASC
                LIMIT %s
                """,
                (ym, gun_v, gun_v, max_rows),
            )
        raw_rows = [dict(x) for x in cur.fetchall()]

    buf = io.StringIO()
    buf.write("\ufeff")
    w = csv.writer(buf)
    w.writerow(
        [
            "id",
            "sube_id",
            "tarih",
            "olay_ts",
            "etiket",
            "aciklama",
            "ref_event_id",
            "personel_id",
            "personel_ad",
            "bildirim_saati",
            "imza_hmac",
            "imza_gecerli",
            "defter_onceki_id",
            "defter_zincir_hmac",
        ]
    )
    for r in raw_rows:
        ig = operasyon_defter_satir_imza_gecerli(r)
        ig_s = "" if ig is None else ("evet" if ig else "hayir")
        w.writerow(
            [
                r.get("id"),
                r.get("sube_id"),
                str(r.get("tarih") or ""),
                str(r.get("olay_ts") or ""),
                r.get("etiket"),
                (r.get("aciklama") or "").replace("\r\n", " ").replace("\n", " "),
                r.get("ref_event_id"),
                r.get("personel_id"),
                r.get("personel_ad"),
                r.get("bildirim_saati"),
                r.get("imza_hmac"),
                ig_s,
                r.get("defter_onceki_id"),
                r.get("defter_zincir_hmac"),
            ]
        )

    base = f"operasyon_defter_{ym.replace('-', '')}"
    if gun_v:
        base += f"_{gun_v}"
    if sube_id:
        base += "_sube"
    fname = quote(f"{base}.csv", safe="")
    return Response(
        content=buf.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{fname}",
        },
    )


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


def _serialize_onay_row(r: dict) -> dict:
    d = dict(r)
    for k in ("tarih", "olusturma", "onay_tarihi"):
        if d.get(k) is not None:
            d[k] = str(d[k])
    return d


@router.get("/bekleyen-merkez")
def ops_bekleyen_merkez(
    year_month: Optional[str] = None,
    sube_id: Optional[str] = None,
):
    """
    Ciro taslağı (bekleyen) + onay kuyruğu (bekleyen) — operasyon merkezi tek sekme.
    Şube filtresi: ciro için sube_id; kuyruk için anlık gider satırının sube alanı.
    """
    ym = _coerce_year_month(year_month)
    sid_f = (sube_id or "").strip() or None
    with db() as (conn, cur):
        qp = [ym]
        q = """
            SELECT t.*, s.ad AS sube_adi
            FROM ciro_taslak t
            JOIN subeler s ON s.id = t.sube_id
            WHERE t.durum = 'bekliyor'
              AND to_char(t.tarih, 'YYYY-MM') = %s
        """
        if sid_f:
            q += " AND t.sube_id = %s"
            qp.append(sid_f)
        q += " ORDER BY t.olusturma ASC NULLS LAST, t.id"
        cur.execute(q, qp)
        ciro_taslaklari = [_taslak_dict(dict(x)) for x in cur.fetchall()]

        qp2 = [ym]
        q2 = """
            SELECT o.*, ag.sube AS sube_from_anlik, s2.ad AS sube_adi_from_anlik
            FROM onay_kuyrugu o
            LEFT JOIN anlik_giderler ag
              ON o.kaynak_tablo = 'anlik_giderler' AND o.kaynak_id = ag.id
            LEFT JOIN subeler s2 ON s2.id = ag.sube
            WHERE o.durum = 'bekliyor'
              AND to_char(o.tarih, 'YYYY-MM') = %s
        """
        # Şube filtresi: yalnızca bu şubenin anlık gider onayı (diğer kuyruk türleri şube kolonu taşımıyor)
        if sid_f:
            q2 += " AND o.kaynak_tablo = 'anlik_giderler' AND ag.sube = %s"
            qp2.append(sid_f)
        q2 += " ORDER BY o.olusturma ASC NULLS LAST, o.id"
        cur.execute(q2, qp2)
        onay_satirlar = []
        for row in cur.fetchall():
            d = _serialize_onay_row(dict(row))
            if d.get("sube_from_anlik"):
                d["sube_id"] = d["sube_from_anlik"]
                d["sube_adi"] = d.get("sube_adi_from_anlik")
            d.pop("sube_from_anlik", None)
            d.pop("sube_adi_from_anlik", None)
            onay_satirlar.append(d)

    return {
        "year_month": ym,
        "sube_id_filtre": sid_f,
        "ciro_taslaklari": ciro_taslaklari,
        "onay_kuyrugu": onay_satirlar,
        "ozet": {
            "ciro_taslak": len(ciro_taslaklari),
            "onay_satir": len(onay_satirlar),
        },
    }


@router.get("/sube-notlar")
def ops_sube_notlar(
    year_month: Optional[str] = None,
    sube_id: Optional[str] = None,
    limit: int = 200,
):
    ym = _coerce_year_month(year_month)
    lim = max(10, min(500, int(limit)))
    sid_f = (sube_id or "").strip() or None
    with db() as (conn, cur):
        qp = [ym]
        q = """
            SELECT n.*, s.ad AS sube_adi
            FROM sube_merkez_not n
            JOIN subeler s ON s.id = n.sube_id
            WHERE to_char(n.olusturma, 'YYYY-MM') = %s
        """
        if sid_f:
            q += " AND n.sube_id = %s"
            qp.append(sid_f)
        q += " ORDER BY n.olusturma DESC LIMIT %s"
        qp.append(lim)
        cur.execute(q, qp)
        rows = []
        for r in cur.fetchall():
            d = dict(r)
            if d.get("olusturma"):
                d["olusturma"] = str(d["olusturma"])
            rows.append(d)
    return {"satirlar": rows, "year_month": ym, "limit": lim}
