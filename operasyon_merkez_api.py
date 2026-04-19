"""
Operasyon merkezi API — CFO panelinden ayrı; tüm şubelerin canlı operasyon özeti.
Prefix: /api/ops
"""
from __future__ import annotations

import csv
import io
import json
import logging
import os
import re
import uuid
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

from database import db
from tr_saat import bugun_tr, dt_now_tr, dt_now_tr_naive
from operasyon_defter import (
    operasyon_defter_ekle,
    operasyon_defter_satir_imza_gecerli,
    operasyon_defter_zincir_satirlari_dogrula,
)
from operasyon_kurallar import vardiya_devri_bugun_baslamis_mi
from sube_kapanis_dual import vardiya_devri_tamamlandi_mi
from sube_operasyon import build_panel_operasyon_blob, _sube_getir
from ciro_taslak_api import _taslak_dict
from operasyon_stok_motor import (
    build_virtual_merkez_uyarilari,
    STOK_KEYS,
    STOK_LABEL_TR,
    merkez_stok_kart_guncelle,
    teorik_stok_bugun,
    stok_from_event_meta,
    merkez_stok_kart_haritasi,
    enrich_siparis_kalemleri_stok_inplace,
    siparis_cift_gonderim_bilgi_notu,
    # disiplin motoru — sevkiyat adaptasyonu
    OLAY_TAHSIS_TAM,
    OLAY_SEVK_CIKTI,
    sevk_cikti_kaydet as _disiplin_sevk_cikti,
)
from siparis_sevkiyat_islem import (
    sevkiyat_kalem_durumlari_normalize,
    siparis_sevkiyat_kalem_guncelle_execute,
)
from kasa_service import audit
from sube_panel import (
    _bugun_ciro_taslak_bekliyor,
    _bugun_ciro_var_mi,
    _bugun_kasa_acildi_mi,
    _bugun_sube_acildi_mi,
    _norm_ad_tr,
    _siparis_katalog_getir,
)
from kontrol_motoru import tum_subeler_kontrol, sube_kontrol_calistir
from kontrol_motoru import kontrol_personel_risk_profili
from finans_core import nakit_akis_tahmin_dogruluk

router = APIRouter(prefix="/api/ops", tags=["operasyon-merkez"])
logger = logging.getLogger(__name__)


class OpsGiderFisKontrolBody(BaseModel):
    gider_id: str
    durum: str  # geldi | gelmedi | muaf
    notu: Optional[str] = None


def _depoda_var_miydi(cur: Any, sube_id: str, tarih: str) -> bool:
    """Basit sinyal kararı için: o gün stok hareketi/teslim var mı?"""
    cur.execute(
        """
        SELECT 1
        FROM operasyon_defter
        WHERE sube_id=%s AND tarih=%s::date
          AND etiket IN ('URUN_SEVK','URUN_AC','URUN_STOK_EKLE')
        LIMIT 1
        """,
        (sube_id, tarih),
    )
    return cur.fetchone() is not None


@router.get("/personel-takip")
def ops_personel_takip_liste(sube_id: Optional[str] = None):
    sid = (sube_id or "").strip() or None
    with db() as (conn, cur):
        qp: List[Any] = []
        q = """
            SELECT t.*, COALESCE(p.ad_soyad, u.ad, t.personel_id) AS personel_ad
            FROM personel_takip t
            LEFT JOIN personel p ON p.id = t.personel_id
            LEFT JOIN sube_panel_kullanici u ON u.id = t.personel_id
            WHERE TRUE
        """
        if sid:
            # sinyal tablosundan son 30 günde bu şubede sinyal var mı filtrele
            q += """
              AND EXISTS (
                SELECT 1 FROM personel_risk_sinyal s
                WHERE s.personel_id = t.personel_id
                  AND s.sube_id = %s
                  AND s.tarih >= (CURRENT_DATE - INTERVAL '30 day')
              )
            """
            qp.append(sid)
        q += " ORDER BY CASE t.takip_seviyesi WHEN 'kritik' THEN 0 WHEN 'uyari' THEN 1 ELSE 2 END, t.guncelleme DESC"
        cur.execute(q, tuple(qp))
        rows = []
        for r in cur.fetchall():
            d = dict(r)
            if d.get("takip_baslangic"):
                d["takip_baslangic"] = str(d["takip_baslangic"])
            if d.get("guncelleme"):
                d["guncelleme"] = str(d["guncelleme"])
            rows.append(d)
    return {"satirlar": rows}


@router.get("/personel-risk-sinyal")
def ops_personel_risk_sinyal(personel_id: str, gun: int = 30):
    pid = (personel_id or "").strip()
    if not pid:
        raise HTTPException(400, "personel_id zorunlu")
    gun_sayi = max(1, min(365, int(gun or 30)))
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT id, personel_id, sube_id, tarih, sinyal_turu, agirlik, aciklama, referans_id, olusturma
            FROM personel_risk_sinyal
            WHERE personel_id=%s
              AND tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
            ORDER BY tarih DESC, olusturma DESC
            LIMIT 500
            """,
            (pid, gun_sayi),
        )
        rows = []
        for r in cur.fetchall():
            d = dict(r)
            if d.get("tarih"):
                d["tarih"] = str(d["tarih"])
            if d.get("olusturma"):
                d["olusturma"] = str(d["olusturma"])
            d["agirlik"] = int(d.get("agirlik") or 0)
            rows.append(d)
        cur.execute("SELECT * FROM personel_takip WHERE personel_id=%s", (pid,))
        takip = cur.fetchone()
        takip_d = dict(takip) if takip else None
        if takip_d:
            if takip_d.get("takip_baslangic"):
                takip_d["takip_baslangic"] = str(takip_d["takip_baslangic"])
            if takip_d.get("guncelleme"):
                takip_d["guncelleme"] = str(takip_d["guncelleme"])
    return {"personel_id": pid, "gun_sayi": gun_sayi, "takip": takip_d, "satirlar": rows}

_YM_RE = re.compile(r"^\d{4}-\d{2}$")


class GuvenlikAlarmIslemBody(BaseModel):
    personel_id: Optional[str] = None
    notu: Optional[str] = None
    sustur_dk: int = 120


class KasaUyumsuzlukCozBody(BaseModel):
    notu: Optional[str] = None
    personel_id: Optional[str] = None
    personel_ad: Optional[str] = None


def _coerce_year_month(ym: Optional[str]) -> str:
    v = (ym or "").strip()
    if not v:
        return bugun_tr().strftime("%Y-%m")
    if not _YM_RE.match(v):
        return bugun_tr().strftime("%Y-%m")
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
    cur.execute(
        """
        SELECT COALESCE(SUM(toplam), 0) AS toplam
        FROM ciro
        WHERE sube_id=%s
          AND tarih=CURRENT_DATE
          AND durum='aktif'
        """,
        (sid,),
    )
    bugun_ciro_tutar = float((cur.fetchone() or {}).get("toplam") or 0)

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

    virt = build_virtual_merkez_uyarilari(cur, sid, dt_now_tr_naive())
    uyarilar = virt + uyarilar

    fark_var = any(
        (u.get("fark_tl") is not None and abs(float(u["fark_tl"])) > 0.01)
        or (u.get("seviye") in ("uyari", "kritik"))
        for u in uyarilar
    )

    vd_gerek = vardiya_devri_bugun_baslamis_mi(cur, sid)
    vd_ok = vardiya_devri_tamamlandi_mi(cur, sid)
    vardiya_devri_durum = "Tamamlandı" if vd_ok else ("Devam ediyor" if vd_gerek else "—")

    now_naive = dt_now_tr_naive()

    def _event_ts_to_dt(raw: Any) -> Optional[datetime]:
        if raw is None:
            return None
        if isinstance(raw, datetime):
            dtv = raw
        else:
            s = str(raw).strip()
            if not s:
                return None
            s = s.replace("Z", "+00:00")
            try:
                dtv = datetime.fromisoformat(s)
            except Exception:
                try:
                    dtv = datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
                except Exception:
                    return None
        if dtv.tzinfo is not None:
            return dtv.astimezone().replace(tzinfo=None)
        return dtv

    def _json_dict_or_empty(raw: Any) -> Dict[str, Any]:
        if isinstance(raw, dict):
            return raw
        if isinstance(raw, str):
            txt = raw.strip()
            if not txt:
                return {}
            try:
                obj = json.loads(txt)
            except Exception:
                return {}
            return obj if isinstance(obj, dict) else {}
        return {}

    acilis_gercek_dt: Optional[datetime] = None
    for e in events:
        if e.get("tip") != "ACILIS" or e.get("durum") != "tamamlandi":
            continue
        dtv = _event_ts_to_dt(e.get("cevap_ts"))
        if not dtv:
            continue
        if acilis_gercek_dt is None or dtv > acilis_gercek_dt:
            acilis_gercek_dt = dtv

    kontrol_gecikme_dk = 0
    for e in events:
        if e.get("tip") != "KONTROL" or e.get("durum") != "gecikti":
            continue
        son_teslim_dt = _event_ts_to_dt(e.get("son_teslim_ts"))
        if not son_teslim_dt:
            continue
        dk = int((now_naive - son_teslim_dt).total_seconds() // 60)
        kontrol_gecikme_dk = max(kontrol_gecikme_dk, max(0, dk))
    cur.execute(
        """
        SELECT MAX(EXTRACT(EPOCH FROM (NOW() - son_teslim_ts)) / 60.0) AS gecikme_dk
        FROM sube_operasyon_event
        WHERE sube_id=%s
          AND tarih=CURRENT_DATE
          AND tip='KONTROL'
          AND durum='gecikti'
          AND son_teslim_ts IS NOT NULL
        """,
        (sid,),
    )
    gecikme_row = cur.fetchone() or {}
    try:
        kontrol_gecikme_dk = max(0, int(gecikme_row.get("gecikme_dk") or 0))
    except (TypeError, ValueError):
        kontrol_gecikme_dk = 0
    cur.execute(
        """
        SELECT COUNT(*) AS adet
        FROM siparis_talep
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='bekliyor'
        """,
        (sid,),
    )
    sip_bek = int((cur.fetchone() or {}).get("adet") or 0)
    cur.execute(
        """
        SELECT COUNT(*) AS adet
        FROM siparis_ozel_talep
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='bekliyor'
        """,
        (sid,),
    )
    sip_ozel_bek = int((cur.fetchone() or {}).get("adet") or 0)
    cur.execute(
        """
        SELECT COUNT(*) AS adet
        FROM siparis_talep
        WHERE hedef_depo_sube_id=%s
          AND sevkiyat_durumu IN ('depoda_hazirlaniyor', 'kismi_hazirlandi')
          AND tarih >= (CURRENT_DATE - INTERVAL '7 day')
        """,
        (sid,),
    )
    sevkiyat_bek = int((cur.fetchone() or {}).get("adet") or 0)
    cur.execute(
        """
        SELECT COUNT(*) AS adet
        FROM onay_kuyrugu
        WHERE kaynak_tablo='anlik_giderler' AND durum='bekliyor'
          AND kaynak_id IN (
            SELECT id FROM anlik_giderler WHERE sube=%s AND tarih=CURRENT_DATE
          )
        """,
        (sid,),
    )
    gider_bek = int((cur.fetchone() or {}).get("adet") or 0)
    cur.execute(
        """
        SELECT COUNT(*) AS adet
        FROM sube_merkez_not
        WHERE sube_id=%s AND DATE(olusturma)=CURRENT_DATE
        """,
        (sid,),
    )
    not_adet = int((cur.fetchone() or {}).get("adet") or 0)

    satis_tahmini_toplam = 0
    satis_tahmini_kalemler: Dict[str, int] = {}
    teorik = teorik_stok_bugun(cur, sid)
    cur.execute(
        """
        SELECT meta
        FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=CURRENT_DATE
          AND tip='KAPANIS' AND durum='tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST, id DESC
        LIMIT 1
        """,
        (sid,),
    )
    kap_row = cur.fetchone()
    if teorik is not None and kap_row:
        gercek = stok_from_event_meta((kap_row or {}).get("meta"), "kapanis_stok_sayim")
        for k in STOK_KEYS:
            diff = int(teorik.get(k) or 0) - int(gercek.get(k) or 0)
            if diff > 0:
                satis_tahmini_kalemler[k] = diff
                satis_tahmini_toplam += diff

    cur.execute(
        """
        INSERT INTO sube_operasyon_ozet (
            sube_id, tarih, acilis_gercek_ts, kontrol_gecikme_dk,
            vardiya_devri_durum, satis_tahmini_toplam, satis_tahmini_kalemler, guncelleme
        )
        VALUES (%s, CURRENT_DATE, %s, %s, %s, %s, %s::jsonb, NOW())
        ON CONFLICT (sube_id, tarih) DO UPDATE SET
            acilis_gercek_ts = EXCLUDED.acilis_gercek_ts,
            kontrol_gecikme_dk = EXCLUDED.kontrol_gecikme_dk,
            vardiya_devri_durum = EXCLUDED.vardiya_devri_durum,
            satis_tahmini_toplam = EXCLUDED.satis_tahmini_toplam,
            satis_tahmini_kalemler = EXCLUDED.satis_tahmini_kalemler,
            guncelleme = NOW()
        """,
        (
            sid,
            acilis_gercek_dt,
            kontrol_gecikme_dk,
            vardiya_devri_durum,
            satis_tahmini_toplam,
            json.dumps(satis_tahmini_kalemler, ensure_ascii=False),
        ),
    )

    readback_cols = (
        "satis_tahmini_toplam",
        "satis_tahmini_kalemler",
        "satis_tahmin_toplam",
        "satis_tahmin_json",
        "teorik_stok_json",
        "kapanis_stok_json",
    )
    cur.execute(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='sube_operasyon_ozet'
          AND column_name = ANY(%s)
        """,
        (list(readback_cols),),
    )
    mevcut_kolonlar = {str((r or {}).get("column_name") or "") for r in cur.fetchall()}
    secilecek = [c for c in readback_cols if c in mevcut_kolonlar]
    ozet_row: Dict[str, Any] = {}
    if secilecek:
        cur.execute(
            f"""
            SELECT {", ".join(secilecek)}
            FROM sube_operasyon_ozet
            WHERE sube_id=%s AND tarih=CURRENT_DATE
            LIMIT 1
            """,
            (sid,),
        )
        ozet_row = dict(cur.fetchone() or {})

    rb_satis_tahmini_toplam = int(ozet_row.get("satis_tahmini_toplam") or 0)
    rb_satis_tahmini_kalemler = _json_dict_or_empty(ozet_row.get("satis_tahmini_kalemler"))
    legacy_toplam = int(ozet_row.get("satis_tahmin_toplam") or 0)
    legacy_json = _json_dict_or_empty(ozet_row.get("satis_tahmin_json"))
    # Eski kolonlar varsa yeni kolonları beslemek için fallback olarak kullan.
    if rb_satis_tahmini_toplam <= 0 and legacy_toplam > 0:
        rb_satis_tahmini_toplam = legacy_toplam
    if not rb_satis_tahmini_kalemler and legacy_json:
        rb_satis_tahmini_kalemler = legacy_json
    teorik_stok_json = _json_dict_or_empty(ozet_row.get("teorik_stok_json"))
    kapanis_stok_json = _json_dict_or_empty(ozet_row.get("kapanis_stok_json"))
    # Geriye uyumluluk alanları yeni kolonlardan türetilir.
    satis_tahmin_toplam = rb_satis_tahmini_toplam
    satis_tahmin_json = rb_satis_tahmini_kalemler

    cur.execute(
        """
        SELECT personel_ad, bildirim_saati, olay_ts
        FROM operasyon_defter
        WHERE sube_id=%s
          AND tarih=CURRENT_DATE
          AND etiket='ACILIS_TAMAM'
        ORDER BY olay_ts DESC
        LIMIT 1
        """,
        (sid,),
    )
    acilis_row = dict(cur.fetchone() or {})
    acilis_personel_ad = (acilis_row.get("personel_ad") or "").strip() or None
    bildirim_saati = (acilis_row.get("bildirim_saati") or "").strip()
    acilis_saat = bildirim_saati or None
    if not acilis_saat:
        acilis_olay_ts = _event_ts_to_dt(acilis_row.get("olay_ts"))
        if acilis_olay_ts:
            acilis_saat = acilis_olay_ts.strftime("%H:%M:%S")

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
        "bugun_ciro_tutar": bugun_ciro_tutar,
        "operasyon": operasyon,
        "ozet": ozet,
        "uyarilar": uyarilar,
        "guvenlik": guvenlik,
        "vardiya_devri_basladi": vd_gerek,
        "vardiya_devri_tamam": vd_ok,
        "vardiya_devri_durum": vardiya_devri_durum,
        "acilis_gercek_ts": acilis_gercek_dt.isoformat() if acilis_gercek_dt else None,
        "kontrol_gecikme_dk": kontrol_gecikme_dk,
        "siparis_bekleyen": sip_bek,
        "siparis_ozel_bekleyen": sip_ozel_bek,
        "sevkiyat_bekleyen": sevkiyat_bek,
        "anlik_gider_bekleyen": gider_bek,
        "gunluk_not_adet": not_adet,
        "satis_tahmini_toplam": rb_satis_tahmini_toplam,
        "satis_tahmini_kalemler": rb_satis_tahmini_kalemler,
        "satis_tahmin_toplam": satis_tahmin_toplam,
        "satis_tahmin_json": satis_tahmin_json,
        "teorik_stok_json": teorik_stok_json,
        "kapanis_stok_json": kapanis_stok_json,
        "acilis_personel_ad": acilis_personel_ad,
        "acilis_saat": acilis_saat,
        "bayraklar": {
            "kritik": kritik,
            "geciken": geciken,
            "fark_var": fark_var,
            "fark_tl": fark_tl,
            "guvenlik_alarm": bool(guvenlik.get("alarm_goster")),
            "siparis_bekleyen": (sip_bek + sip_ozel_bek) > 0,
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
        hatalar: List[dict] = []
        for s in subeler:
            sdict = dict(s)
            try:
                kartlar.append(_kart_uret(cur, sdict, guvenlik_lim))
            except Exception as e:
                sid = str(sdict.get("id") or "")
                sad = sdict.get("ad")
                logger.exception("ops_dashboard kart üretim hatası: sube_id=%s", sid)
                hatalar.append({"sube_id": sid, "sube_adi": sad, "hata": str(e)})
                kartlar.append(
                    {
                        "sube_id": sid,
                        "sube_adi": sad,
                        "kasa_acik": False,
                        "sube_acik": False,
                        "ciro_girildi": False,
                        "ciro_taslak_bekliyor": False,
                        "operasyon": {"events": []},
                        "ozet": {},
                        "uyarilar": [
                            {
                                "tip": "OPS_DASHBOARD_HATA",
                                "seviye": "kritik",
                                "mesaj": f"Şube kartı üretilemedi: {e}",
                            }
                        ],
                        "guvenlik": {},
                        "vardiya_devri_basladi": False,
                        "vardiya_devri_tamam": False,
                        "vardiya_devri_durum": "—",
                        "kontrol_gecikme_dk": 0,
                        "siparis_bekleyen": 0,
                        "siparis_ozel_bekleyen": 0,
                        "anlik_gider_bekleyen": 0,
                        "gunluk_not_adet": 0,
                        "satis_tahmini_toplam": 0,
                        "satis_tahmini_kalemler": {},
                        "satis_tahmin_toplam": 0,
                        "satis_tahmin_json": {},
                        "teorik_stok_json": {},
                        "kapanis_stok_json": {},
                        "bayraklar": {
                            "kritik": True,
                            "geciken": True,
                            "fark_var": False,
                            "fark_tl": None,
                            "guvenlik_alarm": False,
                            "siparis_bekleyen": False,
                        },
                    }
                )

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
        "tarih": str(bugun_tr()),
        "filtre": f,
        "sube_sayisi": len(kartlar),
        "satis_tahmin_toplam": sum(int(k.get("satis_tahmin_toplam") or 0) for k in kartlar),
        "guvenlik_alarmli_sube_sayisi": sum(1 for k in kartlar if k["bayraklar"].get("guvenlik_alarm")),
        "kartlar": kartlar,
        "hatalar": hatalar,
        "guvenlik_alarm_limitleri": _guvenlik_alarm_limitleri(),
        "tolerans": {
            "normal_tl": 50,
            "uyari_tl": 200,
            "aciklama": "Açılış kasa farkı: |fark|≤50 normal, <200 uyarı, ≥200 kritik.",
        },
    }


@router.get("/kontrol-ozet")
def ops_kontrol_ozet(
    sube_id: Optional[str] = None,
    sadece_alarmlar: bool = False,
    kategori: Optional[str] = None,
):
    """
    Merkezi kontrol motoru.
    Tüm kontrolleri tek endpoint'te döner.
    """
    bugun = str(bugun_tr())
    sid = (sube_id or "").strip() or None
    kat = (kategori or "").strip().upper() or None
    if sid:
        with db() as (conn, cur):
            cur.execute(
                "SELECT * FROM subeler WHERE id=%s AND aktif=TRUE",
                (sid,),
            )
            sube = cur.fetchone()
            if not sube:
                raise HTTPException(404, "Şube bulunamadı")
            ozet = sube_kontrol_calistir(cur, sid, dict(sube), kategori=kat)
        return {"tarih": bugun, **ozet}

    sonuclar = tum_subeler_kontrol(sadece_alarmlar=sadece_alarmlar, kategori=kat)
    return {
        "tarih": bugun,
        "sube_sayisi": len(sonuclar),
        "kritik_toplam": sum(s["kritik_adet"] for s in sonuclar),
        "uyari_toplam": sum(s["uyari_adet"] for s in sonuclar),
        "temiz_sube": sum(1 for s in sonuclar if s["temiz"]),
        "subeler": sonuclar,
    }


@router.get("/motor-analitik-olay")
def ops_motor_analitik_olay(olay_tipi: Optional[str] = None, limit: int = 80):
    """Motor analitik append-only akışı (merkez incelemesi)."""
    lim = max(1, min(int(limit or 80), 300))
    ot = (olay_tipi or "").strip()
    with db() as (conn, cur):
        if ot:
            cur.execute(
                """
                SELECT id, olay_tipi, sube_id, tutar_yok_bilgi, payload_json, hesap_surumu, kaynak, olusturma
                FROM motor_analitik_olay
                WHERE olay_tipi = %s
                ORDER BY olusturma DESC
                LIMIT %s
                """,
                (ot, lim),
            )
        else:
            cur.execute(
                """
                SELECT id, olay_tipi, sube_id, tutar_yok_bilgi, payload_json, hesap_surumu, kaynak, olusturma
                FROM motor_analitik_olay
                ORDER BY olusturma DESC
                LIMIT %s
                """,
                (lim,),
            )
        satirlar = []
        for r in cur.fetchall():
            d = dict(r)
            if d.get("olusturma"):
                d["olusturma"] = str(d["olusturma"])
            satirlar.append(d)
    return {"satirlar": satirlar}


@router.get("/gider-fis-bekleyen")
def ops_gider_fis_bekleyen(gun: int = 7, sube_id: Optional[str] = None):
    gun_sayi = max(1, min(60, int(gun or 7)))
    sid = (sube_id or "").strip() or None
    with db() as (conn, cur):
        qp: List[Any] = [gun_sayi]
        q = """
            SELECT
                g.id, g.tarih, g.kategori, g.tutar, g.aciklama, g.sube,
                s.ad AS sube_adi,
                g.personel_id,
                COALESCE(p.ad_soyad, u.ad, g.personel_id) AS personel_ad,
                COALESCE(g.fis_gonderildi, FALSE) AS fis_gonderildi,
                COALESCE(NULLIF(TRIM(g.fis_kontrol_durumu), ''), 'bekliyor') AS fis_kontrol_durumu,
                g.olusturma
            FROM anlik_giderler g
            LEFT JOIN subeler s ON s.id = g.sube
            LEFT JOIN personel p ON p.id = g.personel_id
            LEFT JOIN sube_panel_kullanici u ON u.id = g.personel_id
            WHERE g.tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
              AND COALESCE(NULLIF(TRIM(g.fis_kontrol_durumu), ''), 'bekliyor') = 'bekliyor'
              AND COALESCE(g.fis_gonderildi, FALSE) = FALSE
        """
        if sid:
            q += " AND g.sube=%s"
            qp.append(sid)
        q += " ORDER BY g.tarih DESC, g.olusturma DESC NULLS LAST, g.id LIMIT 400"
        cur.execute(q, tuple(qp))
        rows: List[Dict[str, Any]] = []
        for r in cur.fetchall():
            d = dict(r)
            if d.get("tarih"):
                d["tarih"] = str(d["tarih"])
            if d.get("olusturma"):
                d["olusturma"] = str(d["olusturma"])
            if d.get("tutar") is not None:
                d["tutar"] = float(d["tutar"])
            d["fis_gonderildi"] = bool(d.get("fis_gonderildi"))
            rows.append(d)
    return {"gun_sayi": gun_sayi, "sube_id": sid, "satirlar": rows}


@router.post("/gider-fis-kontrol")
def ops_gider_fis_kontrol(body: OpsGiderFisKontrolBody):
    gid = (body.gider_id or "").strip()
    durum = (body.durum or "").strip().lower()
    notu = (body.notu or "").strip() or None
    if not gid:
        raise HTTPException(400, "gider_id zorunlu")
    if durum not in ("geldi", "gelmedi", "muaf"):
        raise HTTPException(400, "durum: geldi | gelmedi | muaf")
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT id, sube, tarih, kategori, tutar, personel_id, fis_gonderildi, fis_kontrol_durumu
            FROM anlik_giderler
            WHERE id=%s
            FOR UPDATE
            """,
            (gid,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Gider bulunamadı")
        g = dict(row)
        cur.execute(
            """
            UPDATE anlik_giderler
            SET fis_kontrol_durumu=%s
            WHERE id=%s
            """,
            (durum, gid),
        )
        audit(cur, "anlik_giderler", gid, f"OPS_FIS_KONTROL_{durum.upper()}")

        if durum == "gelmedi":
            sid = str(g.get("sube") or "")
            pid = str(g.get("personel_id") or "").strip()
            tg = str(g.get("tarih") or bugun_tr())
            depoda_var = _depoda_var_miydi(cur, sid, tg) if sid else False
            sinyal_turu = "DEPODA_VAR_FIS_YOK" if depoda_var else "FIS_EKSIK_DUSUK_RISK"
            agirlik = 10 if depoda_var else 4
            acik = (
                f"Fiş gelmedi — gider={gid} kategori={g.get('kategori')} tutar={float(g.get('tutar') or 0):.0f} TL"
                + (" (depoda hareket var)" if depoda_var else "")
            )
            cur.execute(
                """
                INSERT INTO personel_risk_sinyal
                    (id, personel_id, sube_id, tarih, sinyal_turu, agirlik, aciklama, referans_id)
                VALUES (%s, %s, %s, %s::date, %s, %s, %s, %s)
                """,
                (str(uuid.uuid4()), pid or "—", sid or None, tg, sinyal_turu, int(agirlik), (acik + (f" · not={notu}" if notu else ""))[:1800], gid),
            )
            if pid:
                kontrol_personel_risk_profili(cur, pid, gun=30)
    return {"success": True, "gider_id": gid, "durum": durum}


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
                SELECT d.id, d.sube_id, s.ad AS sube_adi, d.tarih, d.olay_ts, d.etiket, d.aciklama, d.ref_event_id,
                       d.personel_id, d.personel_ad, d.bildirim_saati, d.imza_hmac,
                       d.defter_onceki_id, d.defter_zincir_hmac
                FROM operasyon_defter d
                LEFT JOIN subeler s ON s.id = d.sube_id
                WHERE d.sube_id=%s
                  AND to_char(d.tarih, 'YYYY-MM') = %s
                  AND (NULLIF(%s, '') IS NULL OR d.tarih = NULLIF(%s, '')::date)
                ORDER BY d.olay_ts DESC
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
        sube_map = {str(s["id"]): s.get("ad") for s in subeler}

        # Tek sorguda tüm şubelerin o ayki defter satırları — N+1 önleme
        cur.execute(
            """
            SELECT id, sube_id, tarih, olay_ts, etiket, aciklama, ref_event_id,
                   personel_id, personel_ad, bildirim_saati, imza_hmac,
                   defter_onceki_id, defter_zincir_hmac
            FROM operasyon_defter
            WHERE to_char(tarih, 'YYYY-MM') = %s
            ORDER BY sube_id, olay_ts ASC NULLS LAST, id ASC
            """,
            (ym,),
        )
        tum_satirlar: Dict[str, List[dict]] = {sid: [] for sid in sube_map}
        for row in cur.fetchall():
            sid = str(row["sube_id"])
            if sid in tum_satirlar:
                tum_satirlar[sid].append(dict(row))

        sube_satirlar: List[dict] = []
        for sid, sube_adi in sube_map.items():
            rows = tum_satirlar.get(sid, [])
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
                    "sube_adi": sube_adi,
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

        # Süresi dolan susturmaları toplu temizle
        cur.execute(
            """
            DELETE FROM operasyon_guvenlik_alarm_durum
            WHERE durum='susturuldu'
              AND sustur_bitis_ts IS NOT NULL
              AND sustur_bitis_ts <= NOW()
            """
        )

        # Tek sorguda tüm şubelerin alarm istatistikleri — N+1 önleme
        cur.execute(
            """
            SELECT
              sube_id,
              COUNT(*) FILTER (WHERE tip='PIN_KILIT')::int      AS pin_kilit_adet,
              COUNT(*) FILTER (WHERE tip='PIN_HATALI')::int     AS pin_hatali_adet,
              COUNT(*) FILTER (WHERE tip='PIN_KILITTE_DENEME')::int AS pin_kilitte_deneme_adet,
              MAX(olay_ts) AS son_olay_ts
            FROM operasyon_guvenlik_olay
            WHERE olay_ts >= NOW() - (%s * INTERVAL '1 minute')
            GROUP BY sube_id
            """,
            (lim["pencere_dk"],),
        )
        alarm_istatistik: Dict[str, dict] = {
            str(r["sube_id"]): dict(r) for r in cur.fetchall()
        }

        # Tek sorguda tüm alarm durum kayıtları
        cur.execute(
            """
            SELECT sube_id, durum, islem_ts, islem_personel_id, islem_notu, sustur_bitis_ts
            FROM operasyon_guvenlik_alarm_durum
            """
        )
        alarm_durum_map: Dict[str, dict] = {
            str(r["sube_id"]): dict(r) for r in cur.fetchall()
        }

        alarmlar: List[dict] = []
        for s in subeler:
            sid = str(s["id"])
            ist = alarm_istatistik.get(sid, {})
            pin_kilit = int(ist.get("pin_kilit_adet") or 0)
            pin_hatali = int(ist.get("pin_hatali_adet") or 0)
            pin_kilitte_deneme = int(ist.get("pin_kilitte_deneme_adet") or 0)
            alarm = pin_kilit >= lim["pin_kilit_esik"] or pin_hatali >= lim["pin_hatali_esik"]
            if not alarm:
                continue
            seviye = "kritik" if pin_kilit >= lim["pin_kilit_esik"] else "uyari"
            mesaj = None
            if pin_kilit >= lim["pin_kilit_esik"]:
                mesaj = f"PIN_KILIT son {lim['pencere_dk']} dk: {pin_kilit} (eşik {lim['pin_kilit_esik']})"
            elif pin_hatali >= lim["pin_hatali_esik"]:
                mesaj = f"PIN_HATALI son {lim['pencere_dk']} dk: {pin_hatali} (eşik {lim['pin_hatali_esik']})"
            ozet = {
                "pencere_dk": lim["pencere_dk"],
                "pin_kilit_adet": pin_kilit,
                "pin_hatali_adet": pin_hatali,
                "pin_kilitte_deneme_adet": pin_kilitte_deneme,
                "alarm": alarm,
                "seviye": seviye,
                "mesaj": mesaj,
            }
            if ist.get("son_olay_ts"):
                ozet["son_olay_ts"] = str(ist["son_olay_ts"])
            alarm_durum = alarm_durum_map.get(sid)
            sustur_aktif = bool(alarm_durum and alarm_durum.get("durum") == "susturuldu")
            alarmlar.append(
                {
                    "sube_id": sid,
                    "sube_adi": s.get("ad"),
                    "seviye": seviye,
                    "mesaj": mesaj,
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


# ── Bar Günlük Özet ───────────────────────────────────────────────────────────
# Açılış + Ürün Aç + Kapanış → Satılan hesabı (kasa güvenliği için)
# Formül: satılan = açılış + ürün_aç - kapanış  (negatif = fire/fark)
# ─────────────────────────────────────────────────────────────────────────────

_BAR_KEYS = [
    "bardak_kucuk", "bardak_buyuk", "bardak_plastik",
    "su_adet", "redbull_adet", "soda_adet", "cookie_adet", "pasta_adet",
]

def _bar_stok_from_meta(meta_raw: Any, alan: str) -> Dict[str, int]:
    """meta JSONB'den belirli alanı (acilis_stok_sayim / kapanis_stok_sayim) okur."""
    if isinstance(meta_raw, str) and meta_raw.strip():
        try:
            meta_raw = json.loads(meta_raw)
        except Exception:
            return {}
    if not isinstance(meta_raw, dict):
        return {}
    stok = meta_raw.get(alan) or {}
    if not isinstance(stok, dict):
        return {}
    return {k: max(0, int(stok.get(k) or 0)) for k in _BAR_KEYS}


def _urun_ac_delta_parse(aciklama: str) -> Dict[str, int]:
    """operasyon_defter URUN_AC satırındaki delta JSON'unu ayrıştırır."""
    if not aciklama:
        return {}
    raw = aciklama
    # "URUN_AC_JSON:{...}" veya doğrudan JSON
    if raw.startswith("URUN_AC_JSON:"):
        raw = raw[len("URUN_AC_JSON:"):]
    try:
        obj = json.loads(raw)
    except Exception:
        return {}
    if not isinstance(obj, dict):
        return {}
    delta = obj.get("delta") or {}
    if not isinstance(delta, dict):
        return {}
    return {k: max(0, int(delta.get(k) or 0)) for k in _BAR_KEYS if (delta.get(k) or 0) > 0}


@router.get("/bar-ozet")
def ops_bar_ozet(
    sube_id: Optional[str] = None,
    year_month: Optional[str] = None,
    gun: Optional[str] = None,
    limit: int = Query(60, ge=1, le=365),
):
    """
    Günlük bar özeti: Açılış + Ürün Aç − Kapanış = Satılan (kasa güvenliği).
    Her şube+tarih için tek satır döner.
    """
    lim = max(1, min(365, int(limit)))
    ym = _coerce_year_month(year_month)
    gun_v = (gun or "").strip()

    with db() as (conn, cur):
        # ── 1. ACILIS eventleri ────────────────────────────────────────────
        acilis_params: list = [ym, gun_v, gun_v]
        acilis_sube_filter = ""
        if sube_id:
            acilis_sube_filter = "AND e.sube_id = %s"
            acilis_params.append(sube_id)
        acilis_params.append(lim)

        cur.execute(
            f"""
            SELECT e.sube_id, s.ad AS sube_adi, e.tarih,
                   e.cevap_ts AS acilis_ts, e.meta AS acilis_meta
            FROM sube_operasyon_event e
            JOIN subeler s ON s.id = e.sube_id
            WHERE e.tip='ACILIS' AND e.durum='tamamlandi'
              AND to_char(e.tarih, 'YYYY-MM') = %s
              AND (NULLIF(%s, '') IS NULL OR e.tarih = NULLIF(%s, '')::date)
              {acilis_sube_filter}
            ORDER BY e.tarih DESC, s.ad
            LIMIT %s
            """,
            acilis_params,
        )
        acilis_rows = {(str(r["sube_id"]), str(r["tarih"])): dict(r) for r in cur.fetchall()}

        if not acilis_rows:
            return {"satirlar": [], "year_month": ym, "gun": gun_v or None}

        # ── 2. KAPANIS eventleri — aynı dönem ─────────────────────────────
        kap_params: list = [ym, gun_v, gun_v]
        kap_sube_filter = ""
        if sube_id:
            kap_sube_filter = "AND e.sube_id = %s"
            kap_params.append(sube_id)

        cur.execute(
            f"""
            SELECT e.sube_id, e.tarih, e.meta AS kapanis_meta
            FROM sube_operasyon_event e
            WHERE e.tip='KAPANIS' AND e.durum='tamamlandi'
              AND to_char(e.tarih, 'YYYY-MM') = %s
              AND (NULLIF(%s, '') IS NULL OR e.tarih = NULLIF(%s, '')::date)
              {kap_sube_filter}
            """,
            kap_params,
        )
        kapanis_map: Dict[tuple, Dict[str, int]] = {}
        for r in cur.fetchall():
            key = (str(r["sube_id"]), str(r["tarih"]))
            kapanis_map[key] = _bar_stok_from_meta(r["kapanis_meta"], "kapanis_stok_sayim")

        # ── 3. URUN_AC gün toplamları ──────────────────────────────────────
        urun_params: list = [ym, gun_v, gun_v]
        urun_sube_filter = ""
        if sube_id:
            urun_sube_filter = "AND sube_id = %s"
            urun_params.append(sube_id)

        cur.execute(
            f"""
            SELECT sube_id, (olay_ts AT TIME ZONE 'Europe/Istanbul')::date AS tarih, aciklama
            FROM operasyon_defter
            WHERE etiket='URUN_AC'
              AND to_char((olay_ts AT TIME ZONE 'Europe/Istanbul')::date, 'YYYY-MM') = %s
              AND (NULLIF(%s, '') IS NULL
                   OR (olay_ts AT TIME ZONE 'Europe/Istanbul')::date = NULLIF(%s,'')::date)
              {urun_sube_filter}
            """,
            urun_params,
        )
        urun_ac_map: Dict[tuple, Dict[str, int]] = {}
        for r in cur.fetchall():
            key = (str(r["sube_id"]), str(r["tarih"]))
            delta = _urun_ac_delta_parse(r["aciklama"] or "")
            existing = urun_ac_map.setdefault(key, {k: 0 for k in _BAR_KEYS})
            for k, v in delta.items():
                existing[k] = existing.get(k, 0) + v

        # ── 4. Birleştir ───────────────────────────────────────────────────
        satirlar: List[Dict[str, Any]] = []
        for (sid, tarih_str), ac_row in acilis_rows.items():
            key = (sid, tarih_str)
            acilis  = _bar_stok_from_meta(ac_row.get("acilis_meta"), "acilis_stok_sayim")
            kapanis = kapanis_map.get(key, {})
            urun_ac = urun_ac_map.get(key, {k: 0 for k in _BAR_KEYS})

            satilan:  Dict[str, int] = {}
            fark_var: bool = False
            for k in _BAR_KEYS:
                a = acilis.get(k, 0)
                u = urun_ac.get(k, 0)
                kap = kapanis.get(k, 0)
                sat = a + u - kap
                satilan[k] = sat
                if sat < 0:
                    fark_var = True

            satirlar.append({
                "sube_id":    sid,
                "sube_adi":   ac_row.get("sube_adi") or sid,
                "tarih":      tarih_str,
                "acilis_ts":  str(ac_row.get("acilis_ts") or ""),
                "kapanis_var": bool(kapanis),
                "acilis":     acilis,
                "urun_ac":    urun_ac,
                "kapanis":    kapanis,
                "satilan":    satilan,
                "fark_var":   fark_var,
            })

        satirlar.sort(key=lambda x: (x["tarih"], x["sube_adi"]), reverse=True)
        return {"satirlar": satirlar, "year_month": ym, "gun": gun_v or None}


def _ops_parse_meta_obj(raw: Any) -> Dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            o = json.loads(raw)
            return o if isinstance(o, dict) else {}
        except Exception:
            return {}
    return {}


def _ops_parse_defter_delta(raw_aciklama: str, prefix: str) -> Dict[str, int]:
    out = {k: 0 for k in STOK_KEYS}
    s = (raw_aciklama or "").strip()
    if not s.startswith(prefix):
        return out
    try:
        obj = json.loads(s[len(prefix) :])
    except Exception:
        return out
    if not isinstance(obj, dict):
        return out
    delta = obj.get("delta") if isinstance(obj.get("delta"), dict) else obj
    if not isinstance(delta, dict):
        return out
    for k in STOK_KEYS:
        try:
            out[k] = max(0, int(delta.get(k) or 0))
        except (TypeError, ValueError):
            out[k] = 0
    return out


def _ops_int(v: Any, default: int = 0) -> int:
    """Eski/yeni meta formatlarındaki sayıları güvenli int'e çevir."""
    try:
        if v is None:
            return default
        if isinstance(v, bool):
            return int(v)
        if isinstance(v, (int, float)):
            return int(v)
        s = str(v).strip()
        if not s:
            return default
        s = s.replace(",", ".")
        return int(float(s))
    except Exception:
        return default


@router.get("/merkez-stok-kart")
def ops_merkez_stok_kart():
    with db() as (conn, cur):
        merkez_stok_kart_guncelle(cur)
        cur.execute(
            """
            SELECT kalem_kodu, kalem_adi, siparis_adet, sevk_adet, kullanilan_adet, kalan_adet, guncelleme
            FROM merkez_stok_kart
            ORDER BY kalem_adi ASC
            """
        )
        satirlar = []
        for r in cur.fetchall():
            d = dict(r)
            d["siparis_adet"] = int(d.get("siparis_adet") or 0)
            d["sevk_adet"] = int(d.get("sevk_adet") or 0)
            d["kullanilan_adet"] = int(d.get("kullanilan_adet") or 0)
            d["kalan_adet"] = int(d.get("kalan_adet") or 0)
            if d.get("guncelleme"):
                d["guncelleme"] = str(d["guncelleme"])
            satirlar.append(d)
    return {
        "satirlar": satirlar,
        "ozet": {
            "siparis_toplam": sum(int(x.get("siparis_adet") or 0) for x in satirlar),
            "sevk_toplam": sum(int(x.get("sevk_adet") or 0) for x in satirlar),
            "kullanilan_toplam": sum(int(x.get("kullanilan_adet") or 0) for x in satirlar),
            "kalan_toplam": sum(int(x.get("kalan_adet") or 0) for x in satirlar),
        },
    }


@router.get("/stok-kayip-analiz")
def ops_stok_kayip_analiz(
    sube_id: Optional[str] = None,
    gun: int = 45,
    urun: Optional[str] = None,
):
    """
    Açılış stok + (URUN_STOK_EKLE + URUN_AC) - kapanış stok = tahmini tüketim/kayıp.
    Şube / personel / gün kırılımı ile kümülatif takip.
    """
    gun_sayi = max(7, min(180, int(gun)))
    urun_f = (urun or "").strip()
    if urun_f and urun_f not in STOK_KEYS:
        raise HTTPException(400, f"urun geçersiz: {urun_f}")

    with db() as (conn, cur):
        qp: List[Any] = [gun_sayi]
        qk = """
            SELECT e.id, e.sube_id, s.ad AS sube_adi, e.tarih, e.cevap_ts, e.personel_id, e.personel_ad, e.meta
            FROM sube_operasyon_event e
            JOIN subeler s ON s.id = e.sube_id
            WHERE e.tip='KAPANIS'
              AND e.durum='tamamlandi'
              AND e.tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
        """
        if sube_id:
            qk += " AND e.sube_id=%s"
            qp.append(sube_id)
        qk += " ORDER BY e.tarih DESC, e.cevap_ts DESC NULLS LAST"
        cur.execute(qk, qp)
        kapanis_rows = [dict(r) for r in cur.fetchall()]

        qa = """
            SELECT e.sube_id, e.tarih, e.meta
            FROM sube_operasyon_event e
            WHERE e.tip='ACILIS'
              AND e.durum='tamamlandi'
              AND e.tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
        """
        qpa: List[Any] = [gun_sayi]
        if sube_id:
            qa += " AND e.sube_id=%s"
            qpa.append(sube_id)
        cur.execute(qa, qpa)
        acilis_rows = [dict(r) for r in cur.fetchall()]

        qd = """
            SELECT sube_id, tarih, etiket, aciklama
            FROM operasyon_defter
            WHERE tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
              AND etiket IN ('URUN_STOK_EKLE', 'URUN_AC')
        """
        qpd: List[Any] = [gun_sayi]
        if sube_id:
            qd += " AND sube_id=%s"
            qpd.append(sube_id)
        cur.execute(qd, qpd)
        defter_rows = [dict(r) for r in cur.fetchall()]

    acilis_map: Dict[tuple, Dict[str, int]] = {}
    for r in acilis_rows:
        key = (str(r.get("sube_id") or ""), str(r.get("tarih") or ""))
        meta = _ops_parse_meta_obj(r.get("meta"))
        blk = meta.get("acilis_stok_sayim")
        if not isinstance(blk, dict):
            blk = meta.get("stok_sayim")
        vals = {k: _ops_int((blk or {}).get(k), 0) for k in STOK_KEYS}
        acilis_map[key] = vals

    ek_map: Dict[tuple, Dict[str, int]] = {}
    for r in defter_rows:
        key = (str(r.get("sube_id") or ""), str(r.get("tarih") or ""))
        if key not in ek_map:
            ek_map[key] = {k: 0 for k in STOK_KEYS}
        if r.get("etiket") == "URUN_STOK_EKLE":
            d = _ops_parse_defter_delta(str(r.get("aciklama") or ""), "URUN_STOK_JSON:")
        else:
            d = _ops_parse_defter_delta(str(r.get("aciklama") or ""), "URUN_AC_JSON:")
        for k in STOK_KEYS:
            ek_map[key][k] += int(d.get(k) or 0)

    gun_adlari = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"]
    gunluk: List[Dict[str, Any]] = []
    sube_agg: Dict[str, Dict[str, Any]] = {}
    personel_agg: Dict[str, Dict[str, Any]] = {}
    pattern_agg: Dict[tuple, Dict[str, Any]] = {}

    for r in kapanis_rows:
        sid = str(r.get("sube_id") or "")
        tarih_s = str(r.get("tarih") or "")
        key = (sid, tarih_s)
        ac = acilis_map.get(key) or {k: 0 for k in STOK_KEYS}
        ek = ek_map.get(key) or {k: 0 for k in STOK_KEYS}
        meta = _ops_parse_meta_obj(r.get("meta"))
        kap_blk = meta.get("kapanis_stok_sayim")
        if not isinstance(kap_blk, dict):
            kap_blk = {}
        try:
            dt_obj = datetime.strptime(tarih_s, "%Y-%m-%d")
            hafta_gun = gun_adlari[dt_obj.weekday()]
        except Exception:
            hafta_gun = "—"
        pid = str(r.get("personel_id") or "").strip()
        pad = (r.get("personel_ad") or "").strip() or (pid or "—")

        for k in STOK_KEYS:
            if urun_f and k != urun_f:
                continue
            acilis_v = _ops_int(ac.get(k), 0)
            ek_v = _ops_int(ek.get(k), 0)
            kapanis_v = _ops_int((kap_blk or {}).get(k), 0)
            tahmini = acilis_v + ek_v - kapanis_v
            if tahmini == 0:
                continue
            sat = {
                "tarih": tarih_s,
                "hafta_gun": hafta_gun,
                "sube_id": sid,
                "sube_adi": r.get("sube_adi"),
                "personel_id": pid or None,
                "personel_ad": pad,
                "urun": k,
                "urun_ad": STOK_LABEL_TR.get(k, k),
                "acilis": acilis_v,
                "eklenen": ek_v,
                "kapanis": kapanis_v,
                "tahmini_tuketim_kayip": tahmini,
                "acik": max(0, tahmini),
                "fazla": max(0, -tahmini),
                "cevap_ts": str(r["cevap_ts"]) if r.get("cevap_ts") else None,
            }
            gunluk.append(sat)

            if sat["acik"] > 0:
                sagg = sube_agg.setdefault(
                    sid,
                    {
                        "sube_id": sid,
                        "sube_adi": r.get("sube_adi"),
                        "toplam_acik": 0,
                        "acik_kalem": 0,
                        "gunler": set(),
                    },
                )
                sagg["toplam_acik"] += sat["acik"]
                sagg["acik_kalem"] += 1
                sagg["gunler"].add(tarih_s)

                pkey = pid or f"anon:{pad}"
                pagg = personel_agg.setdefault(
                    pkey,
                    {
                        "personel_id": pid or None,
                        "personel_ad": pad,
                        "sube_id": sid,
                        "sube_adi": r.get("sube_adi"),
                        "toplam_acik": 0,
                        "acik_kalem": 0,
                        "gunler": set(),
                    },
                )
                pagg["toplam_acik"] += sat["acik"]
                pagg["acik_kalem"] += 1
                pagg["gunler"].add(tarih_s)

                ptn_key = (sid, k, hafta_gun)
                ptn = pattern_agg.setdefault(
                    ptn_key,
                    {
                        "sube_id": sid,
                        "sube_adi": r.get("sube_adi"),
                        "urun": k,
                        "urun_ad": STOK_LABEL_TR.get(k, k),
                        "hafta_gun": hafta_gun,
                        "toplam_acik": 0,
                        "ornek_sayisi": 0,
                    },
                )
                ptn["toplam_acik"] += sat["acik"]
                ptn["ornek_sayisi"] += 1

    gunluk.sort(key=lambda x: (x["tarih"], x["sube_id"], x["urun"]), reverse=True)

    sube_ozet = []
    for v in sube_agg.values():
        sube_ozet.append(
            {
                "sube_id": v["sube_id"],
                "sube_adi": v["sube_adi"],
                "toplam_acik": int(v["toplam_acik"]),
                "acik_kalem": int(v["acik_kalem"]),
                "acik_gun_sayisi": len(v["gunler"]),
            }
        )
    sube_ozet.sort(key=lambda x: (x["toplam_acik"], x["acik_gun_sayisi"]), reverse=True)

    personel_ozet = []
    for v in personel_agg.values():
        personel_ozet.append(
            {
                "personel_id": v["personel_id"],
                "personel_ad": v["personel_ad"],
                "sube_id": v["sube_id"],
                "sube_adi": v["sube_adi"],
                "toplam_acik": int(v["toplam_acik"]),
                "acik_kalem": int(v["acik_kalem"]),
                "acik_gun_sayisi": len(v["gunler"]),
            }
        )
    personel_ozet.sort(key=lambda x: (x["toplam_acik"], x["acik_gun_sayisi"]), reverse=True)

    surekli_acik_personel = [
        p
        for p in personel_ozet
        if int(p.get("acik_gun_sayisi") or 0) >= 3 and int(p.get("toplam_acik") or 0) > 0
    ]

    haftalik_pattern = []
    for v in pattern_agg.values():
        adet = int(v["ornek_sayisi"] or 0)
        if adet <= 0:
            continue
        haftalik_pattern.append(
            {
                **v,
                "ortalama_acik": round(float(v["toplam_acik"]) / float(adet), 2),
            }
        )
    haftalik_pattern.sort(key=lambda x: (x["ortalama_acik"], x["ornek_sayisi"]), reverse=True)

    return {
        "gun_sayi": gun_sayi,
        "sube_id": sube_id,
        "urun": urun_f or None,
        "gunluk_satirlar": gunluk[:1200],
        "sube_ozet": sube_ozet[:50],
        "personel_ozet": personel_ozet[:120],
        "surekli_acik_personel": surekli_acik_personel[:40],
        "haftalik_pattern": haftalik_pattern[:80],
    }


@router.get("/personel-davranis-analiz")
def ops_personel_davranis_analiz(
    sube_id: Optional[str] = None,
    gun: int = 45,
):
    """
    Personel açılış/kapanış davranışı:
    - açılış kasa farkı
    - bardak sayımı düşük başlatma eğilimi (dünkü kapanışa göre)
    - vardiya devrini eksik bırakma (adım-1'de kalma)
    """
    gun_sayi = max(7, min(180, int(gun)))
    with db() as (conn, cur):
        qp: List[Any] = [gun_sayi]
        qa = """
            SELECT e.id, e.sube_id, s.ad AS sube_adi, e.tarih, e.personel_id, e.personel_ad, e.meta
            FROM sube_operasyon_event e
            JOIN subeler s ON s.id = e.sube_id
            WHERE e.tip='ACILIS'
              AND e.durum='tamamlandi'
              AND e.tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
        """
        if sube_id:
            qa += " AND e.sube_id=%s"
            qp.append(sube_id)
        qa += " ORDER BY e.tarih DESC, e.id DESC"
        cur.execute(qa, qp)
        acilis_rows = [dict(r) for r in cur.fetchall()]

        qk = """
            SELECT e.sube_id, e.tarih, e.meta
            FROM sube_operasyon_event e
            WHERE e.tip='KAPANIS'
              AND e.durum='tamamlandi'
              AND e.tarih >= (CURRENT_DATE - ((%s + 1) * INTERVAL '1 day'))
        """
        qkp: List[Any] = [gun_sayi]
        if sube_id:
            qk += " AND e.sube_id=%s"
            qkp.append(sube_id)
        cur.execute(qk, qkp)
        kapanis_rows = [dict(r) for r in cur.fetchall()]

        qu = """
            SELECT sube_id, tarih, ABS(COALESCE(fark_tl, 0)) AS abs_fark
            FROM sube_operasyon_uyari
            WHERE tip='ACILIS_KASA_FARK'
              AND tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
        """
        qup: List[Any] = [gun_sayi]
        if sube_id:
            qu += " AND sube_id=%s"
            qup.append(sube_id)
        cur.execute(qu, qup)
        u_rows = [dict(r) for r in cur.fetchall()]

        # Şema farkı toleransı: bazı ortamlarda kapanisci_id yerine sabahci_personel_id mevcut.
        qvp: List[Any] = [gun_sayi]
        qv_suffix = """
            WHERE k.olay='vardiya_sabah_aksam_devri'
              AND k.durum='acilis_bekliyor'
              AND k.tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
        """
        if sube_id:
            qv_suffix += " AND k.sube_id=%s"
            qvp.append(sube_id)
        try:
            cur.execute(
                """
                SELECT k.sube_id, s.ad AS sube_adi, k.tarih,
                       k.kapanisci_id AS sabahci_personel_id, p.ad_soyad AS sabahci_ad
                FROM kapanis_kayit k
                JOIN subeler s ON s.id = k.sube_id
                LEFT JOIN personel p ON p.id = k.kapanisci_id
                """
                + qv_suffix,
                qvp,
            )
        except Exception:
            conn.rollback()  # aborted transaction temizle
            try:
                cur.execute(
                    """
                    SELECT k.sube_id, s.ad AS sube_adi, k.tarih,
                           k.sabahci_personel_id AS sabahci_personel_id, p.ad_soyad AS sabahci_ad
                    FROM kapanis_kayit k
                    JOIN subeler s ON s.id = k.sube_id
                    LEFT JOIN personel p ON p.id = k.sabahci_personel_id
                    """
                    + qv_suffix,
                    qvp,
                )
            except Exception:
                conn.rollback()
                cur.execute("SELECT 1 WHERE FALSE")  # boş cursor
        v_rows = [dict(r) for r in cur.fetchall()]

    kapanis_map: Dict[tuple, Dict[str, int]] = {}
    for r in kapanis_rows:
        key = (str(r.get("sube_id") or ""), str(r.get("tarih") or ""))
        meta = _ops_parse_meta_obj(r.get("meta"))
        blk = meta.get("kapanis_stok_sayim")
        if not isinstance(blk, dict):
            blk = {}
        kapanis_map[key] = {
            "bardak_kucuk": _ops_int(blk.get("bardak_kucuk"), 0),
            "bardak_buyuk": _ops_int(blk.get("bardak_buyuk"), 0),
            "bardak_plastik": _ops_int(blk.get("bardak_plastik"), 0),
        }

    uyari_map: Dict[tuple, float] = {}
    for r in u_rows:
        key = (str(r.get("sube_id") or ""), str(r.get("tarih") or ""))
        uyari_map[key] = max(float(uyari_map.get(key) or 0.0), float(r.get("abs_fark") or 0.0))

    personel: Dict[str, Dict[str, Any]] = {}
    gunluk_satirlar: List[Dict[str, Any]] = []
    for a in acilis_rows:
        sid = str(a.get("sube_id") or "")
        tarih_s = str(a.get("tarih") or "")
        pid = str(a.get("personel_id") or "").strip() or f"anon:{(a.get('personel_ad') or '').strip() or sid}"
        pad = (a.get("personel_ad") or "").strip() or pid
        base = personel.setdefault(
            pid,
            {
                "personel_id": None if pid.startswith("anon:") else pid,
                "personel_ad": pad,
                "sube_id": sid,
                "sube_adi": a.get("sube_adi"),
                "acilis_sayisi": 0,
                "acilis_kasa_fark_adet": 0,
                "acilis_kasa_fark_toplam": 0.0,
                "bardak_dusuk_adet": 0,
                "bardak_dusuk_toplam": 0,
                "vardiya_eksik_adet": 0,
            },
        )
        base["acilis_sayisi"] += 1

        kf = float(uyari_map.get((sid, tarih_s)) or 0.0)
        if kf > 0:
            base["acilis_kasa_fark_adet"] += 1
            base["acilis_kasa_fark_toplam"] += kf

        meta = _ops_parse_meta_obj(a.get("meta"))
        ac_blk = meta.get("acilis_stok_sayim")
        if not isinstance(ac_blk, dict):
            ac_blk = meta.get("stok_sayim")
        if not isinstance(ac_blk, dict):
            ac_blk = {}
        ac_b = {
            "bardak_kucuk": _ops_int(ac_blk.get("bardak_kucuk"), 0),
            "bardak_buyuk": _ops_int(ac_blk.get("bardak_buyuk"), 0),
            "bardak_plastik": _ops_int(ac_blk.get("bardak_plastik"), 0),
        }
        try:
            prev_s = str(date.fromisoformat(tarih_s) - timedelta(days=1))
        except Exception:
            prev_s = ""
        dk = kapanis_map.get((sid, prev_s)) if prev_s else None
        bardak_dusuk = 0
        if dk:
            for k in ("bardak_kucuk", "bardak_buyuk", "bardak_plastik"):
                diff = int(dk.get(k) or 0) - int(ac_b.get(k) or 0)
                if diff > 0:
                    bardak_dusuk += diff
        if bardak_dusuk > 0:
            base["bardak_dusuk_adet"] += 1
            base["bardak_dusuk_toplam"] += int(bardak_dusuk)

        gunluk_satirlar.append(
            {
                "tarih": tarih_s,
                "sube_id": sid,
                "sube_adi": a.get("sube_adi"),
                "personel_id": base["personel_id"],
                "personel_ad": pad,
                "acilis_kasa_fark_abs": round(kf, 2),
                "bardak_dusuk_toplam": int(bardak_dusuk),
            }
        )

    for v in v_rows:
        pid = str(v.get("sabahci_personel_id") or "").strip()
        if not pid:
            continue
        base = personel.setdefault(
            pid,
            {
                "personel_id": pid,
                "personel_ad": (v.get("sabahci_ad") or "").strip() or pid,
                "sube_id": str(v.get("sube_id") or ""),
                "sube_adi": v.get("sube_adi"),
                "acilis_sayisi": 0,
                "acilis_kasa_fark_adet": 0,
                "acilis_kasa_fark_toplam": 0.0,
                "bardak_dusuk_adet": 0,
                "bardak_dusuk_toplam": 0,
                "vardiya_eksik_adet": 0,
            },
        )
        base["vardiya_eksik_adet"] += 1

    ozet = []
    surekli_riskli = []
    for p in personel.values():
        risk = (
            int(p["acilis_kasa_fark_adet"]) * 15
            + float(p["acilis_kasa_fark_toplam"]) * 0.6
            + int(p["bardak_dusuk_toplam"]) * 0.9
            + int(p["vardiya_eksik_adet"]) * 22
        )
        row = {
            **p,
            "acilis_kasa_fark_toplam": round(float(p["acilis_kasa_fark_toplam"]), 2),
            "davranis_risk_skoru": round(risk, 2),
        }
        ozet.append(row)
        if row["davranis_risk_skoru"] >= 35 and (
            row["acilis_kasa_fark_adet"] >= 2 or row["bardak_dusuk_adet"] >= 2 or row["vardiya_eksik_adet"] >= 1
        ):
            surekli_riskli.append(row)

    ozet.sort(key=lambda x: x["davranis_risk_skoru"], reverse=True)
    surekli_riskli.sort(key=lambda x: x["davranis_risk_skoru"], reverse=True)
    gunluk_satirlar.sort(key=lambda x: (x["tarih"], x["sube_id"], x["personel_ad"]), reverse=True)
    return {
        "gun_sayi": gun_sayi,
        "sube_id": sube_id,
        "personel_ozet": ozet[:200],
        "surekli_riskli_personel": surekli_riskli[:60],
        "gunluk_satirlar": gunluk_satirlar[:1200],
    }


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


def _trend_yonu(onceki: float, simdiki: float, esik_pct: float = 5.0) -> str:
    baz = abs(float(onceki)) if abs(float(onceki)) > 1e-9 else 1.0
    degisim = ((float(simdiki) - float(onceki)) / baz) * 100.0
    if degisim > esik_pct:
        return "artiyor"
    if degisim < -esik_pct:
        return "azaliyor"
    return "stabil"


def _safe_float(v: Any) -> float:
    try:
        return float(v or 0.0)
    except Exception:
        return 0.0


def _weighted_avg(rows: List[Dict[str, Any]], value_key: str, weight_key: str) -> Optional[float]:
    toplam_agirlik = 0.0
    toplam_deger = 0.0
    for r in rows:
        w = _safe_float(r.get(weight_key))
        v = _safe_float(r.get(value_key))
        if w <= 0:
            continue
        toplam_agirlik += w
        toplam_deger += (v * w)
    if toplam_agirlik <= 0:
        return None
    return round(toplam_deger / toplam_agirlik, 4)


def _quality(status: str, mesaj: str) -> Dict[str, str]:
    return {"durum": status, "mesaj": mesaj}


@router.get("/metrics/personel-verimlilik")
def ops_metrics_personel_verimlilik(
    sube_id: Optional[str] = None,
    gun: int = 30,
):
    gun_sayi = max(7, min(365, int(gun)))
    sid = (sube_id or "").strip() or None
    with db() as (conn, cur):
        qp: List[Any] = [gun_sayi]
        q_acilis = """
            WITH ep AS (
                SELECT DISTINCT ON (e.id)
                    e.id,
                    e.sube_id,
                    d.personel_id,
                    COALESCE(NULLIF(TRIM(d.personel_ad), ''), p.ad_soyad, d.personel_id) AS personel_ad,
                    EXTRACT(EPOCH FROM (e.cevap_ts - e.sistem_slot_ts)) / 60.0 AS fark_dk
                FROM sube_operasyon_event e
                JOIN operasyon_defter d ON d.ref_event_id = e.id
                LEFT JOIN personel p ON p.id = d.personel_id
                WHERE e.tip='ACILIS'
                  AND e.cevap_ts IS NOT NULL
                  AND e.sistem_slot_ts IS NOT NULL
                  AND d.personel_id IS NOT NULL
                  AND e.tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
        """
        if sid:
            q_acilis += " AND e.sube_id=%s"
            qp.append(sid)
        q_acilis += """
                ORDER BY e.id, d.olay_ts DESC
            )
            SELECT personel_id, personel_ad,
                   COUNT(*)::int AS ornek_sayi,
                   ROUND(AVG(fark_dk)::numeric, 2) AS ort_sapma_dk,
                   ROUND(COALESCE(STDDEV_SAMP(fark_dk), 0)::numeric, 2) AS std_sapma_dk
            FROM ep
            GROUP BY personel_id, personel_ad
            ORDER BY ort_sapma_dk DESC, personel_ad
        """
        cur.execute(q_acilis, tuple(qp))
        acilis_sapma = [dict(r) for r in cur.fetchall()]

        qp2: List[Any] = [gun_sayi]
        q_kontrol = """
            WITH ep AS (
                SELECT DISTINCT ON (e.id)
                    e.id,
                    e.sube_id,
                    d.personel_id,
                    COALESCE(NULLIF(TRIM(d.personel_ad), ''), p.ad_soyad, d.personel_id) AS personel_ad,
                    EXTRACT(EPOCH FROM (e.cevap_ts - e.sistem_slot_ts)) / 60.0 AS cevap_dk
                FROM sube_operasyon_event e
                JOIN operasyon_defter d ON d.ref_event_id = e.id
                LEFT JOIN personel p ON p.id = d.personel_id
                WHERE e.tip='KONTROL'
                  AND e.cevap_ts IS NOT NULL
                  AND e.sistem_slot_ts IS NOT NULL
                  AND d.personel_id IS NOT NULL
                  AND e.tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
        """
        if sid:
            q_kontrol += " AND e.sube_id=%s"
            qp2.append(sid)
        q_kontrol += """
                ORDER BY e.id, d.olay_ts DESC
            )
            SELECT personel_id, personel_ad,
                   COUNT(*)::int AS ornek_sayi,
                   ROUND(AVG(cevap_dk)::numeric, 2) AS ort_cevap_dk,
                   ROUND(COALESCE(STDDEV_SAMP(cevap_dk), 0)::numeric, 2) AS std_cevap_dk
            FROM ep
            GROUP BY personel_id, personel_ad
            ORDER BY ort_cevap_dk DESC, personel_ad
        """
        cur.execute(q_kontrol, tuple(qp2))
        kontrol_hizi = [dict(r) for r in cur.fetchall()]

        qp3: List[Any] = [gun_sayi]
        q_frekans = """
            SELECT
                x.personel_id,
                x.personel_ad,
                COUNT(*)::int AS stok_kapanis_uyari_adet
            FROM sube_operasyon_uyari u
            JOIN sube_operasyon_event e
              ON e.sube_id=u.sube_id
             AND e.tarih=u.tarih
             AND e.tip='KAPANIS'
             AND e.durum='tamamlandi'
            JOIN LATERAL (
                SELECT d.personel_id,
                       COALESCE(NULLIF(TRIM(d.personel_ad), ''), p.ad_soyad, d.personel_id) AS personel_ad
                FROM operasyon_defter d
                LEFT JOIN personel p ON p.id = d.personel_id
                WHERE d.ref_event_id = e.id
                  AND d.personel_id IS NOT NULL
                ORDER BY d.olay_ts DESC
                LIMIT 1
            ) x ON TRUE
            WHERE u.tip='STOK_KAPANIS_OZET'
              AND u.tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
        """
        if sid:
            q_frekans += " AND u.sube_id=%s"
            qp3.append(sid)
        q_frekans += """
            GROUP BY x.personel_id, x.personel_ad
            ORDER BY stok_kapanis_uyari_adet DESC, x.personel_ad
        """
        cur.execute(q_frekans, tuple(qp3))
        kasa_fark_frekansi = [dict(r) for r in cur.fetchall()]

        qp4: List[Any] = [gun_sayi]
        q_pin = """
            SELECT
                CASE
                    WHEN EXTRACT(HOUR FROM (g.olay_ts AT TIME ZONE 'Europe/Istanbul')) BETWEEN 5 AND 10 THEN 'sabah'
                    WHEN EXTRACT(HOUR FROM (g.olay_ts AT TIME ZONE 'Europe/Istanbul')) BETWEEN 11 AND 16 THEN 'ogle'
                    WHEN EXTRACT(HOUR FROM (g.olay_ts AT TIME ZONE 'Europe/Istanbul')) BETWEEN 17 AND 22 THEN 'aksam'
                    ELSE 'gece'
                END AS dilim,
                COUNT(*)::int AS adet
            FROM operasyon_guvenlik_olay g
            WHERE g.tip IN ('PIN_HATALI','PIN_KILIT','PIN_KILITTE_DENEME')
              AND g.olay_ts >= (NOW() - (%s * INTERVAL '1 day'))
        """
        if sid:
            q_pin += " AND g.sube_id=%s"
            qp4.append(sid)
        q_pin += " GROUP BY dilim ORDER BY adet DESC, dilim"
        cur.execute(q_pin, tuple(qp4))
        pin_hata_saat_dagilimi = [dict(r) for r in cur.fetchall()]

    acilis_ort = _weighted_avg(acilis_sapma, "ort_sapma_dk", "ornek_sayi")
    kontrol_ort = _weighted_avg(kontrol_hizi, "ort_cevap_dk", "ornek_sayi")
    toplam_stok_kapanis_uyari = sum(int(x.get("stok_kapanis_uyari_adet") or 0) for x in kasa_fark_frekansi)
    aktif_personel_adet = max(
        len({str(x.get("personel_id") or "") for x in acilis_sapma if x.get("personel_id")}),
        len({str(x.get("personel_id") or "") for x in kontrol_hizi if x.get("personel_id")}),
        len({str(x.get("personel_id") or "") for x in kasa_fark_frekansi if x.get("personel_id")}),
        1,
    )
    kasa_fark_frekans = round((toplam_stok_kapanis_uyari * 100.0) / float(aktif_personel_adet * max(1, gun_sayi)), 4)

    veri_kalite = {
        "acilis_sapma": _quality(
            "tamam" if acilis_ort is not None else "yetersiz_veri",
            "Açılış sapma ortalaması hesaplandı." if acilis_ort is not None else "Açılış sapma ortalaması için örnek bulunamadı.",
        ),
        "kontrol_cevap": _quality(
            "tamam" if kontrol_ort is not None else "yetersiz_veri",
            "Kontrol cevap süresi hesaplandı." if kontrol_ort is not None else "Kontrol cevap süresi için örnek bulunamadı.",
        ),
        "kasa_fark_frekans": _quality(
            "tamam" if kasa_fark_frekansi else "yetersiz_veri",
            "Kasa fark frekansı hesaplandı." if kasa_fark_frekansi else "Kasa fark frekansı için kayıt bulunamadı.",
        ),
    }

    return {
        "gun_sayi": gun_sayi,
        "sube_id": sid,
        "acilis_sapma_ort_dk": acilis_ort,
        "kontrol_cevap_ort_dk": kontrol_ort,
        "kasa_fark_frekans": kasa_fark_frekans,
        "veri_kalite": veri_kalite,
        "acilis_saati_sapmasi": acilis_sapma,
        "kontrol_cevap_hizi": kontrol_hizi,
        "kasa_farki_frekansi": kasa_fark_frekansi,
        "pin_hata_saat_dagilimi": pin_hata_saat_dagilimi,
    }


@router.get("/metrics/sube-operasyon-kalite")
def ops_metrics_sube_operasyon_kalite(
    sube_id: Optional[str] = None,
    gun: int = 30,
):
    gun_sayi = max(7, min(365, int(gun)))
    sid = (sube_id or "").strip() or None
    with db() as (conn, cur):
        qp1: List[Any] = [gun_sayi]
        q1 = """
            SELECT
                k.sube_id,
                s.ad AS sube_adi,
                COUNT(*)::int AS toplam_devri,
                COUNT(*) FILTER (
                    WHERE k.durum='tamamlandi'
                      AND k.acilisci_onay_ts IS NOT NULL
                      AND k.kapanisci_onay_ts IS NOT NULL
                )::int AS tam_tik,
                COUNT(*) FILTER (
                    WHERE k.durum!='tamamlandi'
                       OR k.acilisci_onay_ts IS NULL
                       OR k.kapanisci_onay_ts IS NULL
                )::int AS eksik_tik
            FROM kapanis_kayit k
            JOIN subeler s ON s.id = k.sube_id
            WHERE k.olay='vardiya_sabah_aksam_devri'
              AND k.tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
        """
        if sid:
            q1 += " AND k.sube_id=%s"
            qp1.append(sid)
        q1 += " GROUP BY k.sube_id, s.ad ORDER BY eksik_tik DESC, k.sube_id"
        cur.execute(q1, tuple(qp1))
        vardiya_oran = []
        for r in cur.fetchall():
            d = dict(r)
            toplam = int(d.get("toplam_devri") or 0)
            eksik = int(d.get("eksik_tik") or 0)
            d["eksik_tik_orani_pct"] = round((eksik * 100.0 / toplam), 2) if toplam > 0 else 0.0
            vardiya_oran.append(d)

        qp2: List[Any] = [gun_sayi]
        q2 = """
            SELECT
                n.sube_id,
                s.ad AS sube_adi,
                COUNT(*)::int AS not_adet
            FROM sube_merkez_not n
            JOIN subeler s ON s.id = n.sube_id
            WHERE n.olusturma >= (NOW() - (%s * INTERVAL '1 day'))
        """
        if sid:
            q2 += " AND n.sube_id=%s"
            qp2.append(sid)
        q2 += " GROUP BY n.sube_id, s.ad ORDER BY not_adet DESC, n.sube_id"
        cur.execute(q2, tuple(qp2))
        not_sikligi = []
        for r in cur.fetchall():
            d = dict(r)
            d["gunluk_ortalama_not"] = round(float(d.get("not_adet") or 0) / float(gun_sayi), 2)
            not_sikligi.append(d)

        qp3: List[Any] = [gun_sayi]
        q3 = """
            SELECT
                t.id,
                t.sube_id,
                s.ad AS sube_adi,
                t.tarih AS talep_tarih,
                MIN(ms.tarih) AS teslim_tarih
            FROM siparis_talep t
            JOIN subeler s ON s.id = t.sube_id
            LEFT JOIN merkez_stok_sevk ms ON ms.siparis_talep_id = t.id
            WHERE t.tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
        """
        if sid:
            q3 += " AND t.sube_id=%s"
            qp3.append(sid)
        q3 += " GROUP BY t.id, t.sube_id, s.ad, t.tarih ORDER BY t.tarih DESC, t.id"
        cur.execute(q3, tuple(qp3))
        siparis_dongu = []
        for r in cur.fetchall():
            d = dict(r)
            tt = d.get("talep_tarih")
            ts = d.get("teslim_tarih")
            if tt is not None:
                d["talep_tarih"] = str(tt)
            if ts is not None:
                d["teslim_tarih"] = str(ts)
                try:
                    d["talep_teslim_gun"] = int((ts - tt).days)
                except Exception:
                    d["talep_teslim_gun"] = None
            else:
                d["talep_teslim_gun"] = None
            d["talep_onay_gun"] = None  # mevcut modelde siparis_talep için açık onay timestamp yok
            siparis_dongu.append(d)

        tamamlanan = [x for x in siparis_dongu if x.get("talep_teslim_gun") is not None]
        ort_dongu = (
            round(sum(int(x["talep_teslim_gun"]) for x in tamamlanan) / float(len(tamamlanan)), 2)
            if tamamlanan
            else None
        )

        qp4: List[Any] = [gun_sayi]
        q4 = """
            SELECT
                DATE_TRUNC('week', e.tarih)::date AS hafta,
                ROUND(AVG(GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(e.cevap_ts, NOW()) - e.son_teslim_ts)) / 60.0))::numeric, 2) AS ort_gecikme_dk,
                COUNT(*)::int AS kayit_adet
            FROM sube_operasyon_event e
            WHERE e.tip='KONTROL'
              AND e.durum='gecikti'
              AND e.son_teslim_ts IS NOT NULL
              AND e.tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
        """
        if sid:
            q4 += " AND e.sube_id=%s"
            qp4.append(sid)
        q4 += " GROUP BY hafta ORDER BY hafta"
        cur.execute(q4, tuple(qp4))
        kontrol_trend = [dict(r) for r in cur.fetchall()]
        for r in kontrol_trend:
            if r.get("hafta") is not None:
                r["hafta"] = str(r["hafta"])

    onceki = float(kontrol_trend[-2]["ort_gecikme_dk"]) if len(kontrol_trend) >= 2 else 0.0
    simdiki = float(kontrol_trend[-1]["ort_gecikme_dk"]) if len(kontrol_trend) >= 1 else 0.0
    trend_yonu = _trend_yonu(onceki, simdiki) if len(kontrol_trend) >= 2 else "yetersiz_veri"
    vardiya_eksik_oran = _weighted_avg(vardiya_oran, "eksik_tik_orani_pct", "toplam_devri")
    toplam_not = sum(int(x.get("not_adet") or 0) for x in not_sikligi)
    sube_adet = max(1, len({str(x.get("sube_id") or "") for x in not_sikligi if x.get("sube_id")}))
    not_gonderim_gunluk_ort = round(float(toplam_not) / float(max(1, gun_sayi) * sube_adet), 4)
    siparis_cevrim_sure_gun = ort_dongu

    veri_kalite = {
        "vardiya_eksik_oran": _quality(
            "tamam" if vardiya_eksik_oran is not None else "yetersiz_veri",
            "Vardiya devir verisi mevcut." if vardiya_eksik_oran is not None else "Vardiya devir kaydı bulunamadı.",
        ),
        "not_gonderim_gunluk_ort": _quality(
            "tamam" if not_sikligi else "yetersiz_veri",
            "Şube not verisi mevcut." if not_sikligi else "Şube not verisi bulunamadı.",
        ),
        "siparis_cevrim_sure_gun": _quality(
            "tamam" if siparis_cevrim_sure_gun is not None else "yetersiz_veri",
            "Sipariş talep->teslim çevrimi hesaplandı." if siparis_cevrim_sure_gun is not None else "Sipariş çevrim süresi için teslim verisi yok.",
        ),
    }

    return {
        "gun_sayi": gun_sayi,
        "sube_id": sid,
        "vardiya_eksik_oran": vardiya_eksik_oran,
        "not_gonderim_gunluk_ort": not_gonderim_gunluk_ort,
        "siparis_cevrim_sure_gun": siparis_cevrim_sure_gun,
        "veri_kalite": veri_kalite,
        "vardiya_devri_eksik_tik_orani": vardiya_oran,
        "not_gonderme_sikligi": not_sikligi,
        "siparis_dongusu": {
            "satirlar": siparis_dongu[:300],
            "ozet": {
                "toplam_talep": len(siparis_dongu),
                "teslim_edilen": len(tamamlanan),
                "teslim_bekleyen": len(siparis_dongu) - len(tamamlanan),
                "ortalama_talep_teslim_gun": ort_dongu,
            },
        },
        "kontrol_gecikmesi_trend": {
            "haftalik": kontrol_trend,
            "yon": trend_yonu,
            "onceki_hafta_ort_dk": round(onceki, 2) if len(kontrol_trend) >= 2 else None,
            "son_hafta_ort_dk": round(simdiki, 2) if len(kontrol_trend) >= 1 else None,
        },
    }


@router.get("/metrics/finans-ozet")
def ops_metrics_finans_ozet(
    sube_id: Optional[str] = None,
    gun: int = 30,
):
    gun_sayi = max(7, min(365, int(gun)))
    sid = (sube_id or "").strip() or None
    with db() as (conn, cur):
        qp1: List[Any] = [gun_sayi, gun_sayi]
        q1 = """
            WITH c AS (
                SELECT tarih, sube_id, SUM(toplam)::numeric AS ciro
                FROM ciro
                WHERE durum='aktif'
                  AND tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
                GROUP BY tarih, sube_id
            ),
            g AS (
                SELECT tarih, sube AS sube_id, SUM(tutar)::numeric AS gider
                FROM anlik_giderler
                WHERE durum='aktif'
                  AND tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
                GROUP BY tarih, sube
            )
            SELECT
                COALESCE(c.tarih, g.tarih) AS tarih,
                COALESCE(c.sube_id, g.sube_id) AS sube_id,
                s.ad AS sube_adi,
                COALESCE(c.ciro, 0)::numeric AS ciro,
                COALESCE(g.gider, 0)::numeric AS gider
            FROM c
            FULL OUTER JOIN g
              ON c.tarih = g.tarih
             AND c.sube_id = g.sube_id
            LEFT JOIN subeler s ON s.id = COALESCE(c.sube_id, g.sube_id)
            WHERE (%s IS NULL OR COALESCE(c.sube_id, g.sube_id) = %s)
            ORDER BY tarih DESC, sube_id
        """
        cur.execute(q1, (gun_sayi, gun_sayi, sid, sid))
        ciro_gider = []
        for r in cur.fetchall():
            d = dict(r)
            ciro_v = float(d.get("ciro") or 0.0)
            gider_v = float(d.get("gider") or 0.0)
            d["tarih"] = str(d.get("tarih")) if d.get("tarih") is not None else None
            d["ciro"] = ciro_v
            d["gider"] = gider_v
            d["ciro_gider_orani"] = round(ciro_v / gider_v, 4) if gider_v > 0 else None
            ciro_gider.append(d)

        qp2: List[Any] = [gun_sayi]
        q2 = """
            SELECT
                DATE_TRUNC('week', tarih)::date AS hafta,
                kategori,
                COUNT(*)::int AS kayit_adet,
                ROUND(SUM(tutar)::numeric, 2) AS toplam_tutar
            FROM anlik_giderler
            WHERE durum='aktif'
              AND tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
        """
        if sid:
            q2 += " AND sube=%s"
            qp2.append(sid)
        q2 += " GROUP BY hafta, kategori ORDER BY hafta DESC, toplam_tutar DESC"
        cur.execute(q2, tuple(qp2))
        kategori_trend = [dict(r) for r in cur.fetchall()]
        for r in kategori_trend:
            if r.get("hafta") is not None:
                r["hafta"] = str(r["hafta"])

        cur.execute(
            """
            WITH f AS (
                SELECT DATE_TRUNC('month', tarih)::date AS ay,
                       SUM(ABS(tutar))::numeric AS faiz_toplam
                FROM kart_hareketleri
                WHERE durum='aktif' AND islem_turu='FAIZ'
                GROUP BY DATE_TRUNC('month', tarih)
            ),
            c AS (
                SELECT DATE_TRUNC('month', tarih)::date AS ay,
                       SUM(toplam)::numeric AS ciro_toplam
                FROM ciro
                WHERE durum='aktif'
                GROUP BY DATE_TRUNC('month', tarih)
            )
            SELECT
                COALESCE(f.ay, c.ay) AS ay,
                COALESCE(f.faiz_toplam, 0)::numeric AS faiz_toplam,
                COALESCE(c.ciro_toplam, 0)::numeric AS ciro_toplam
            FROM f
            FULL OUTER JOIN c ON c.ay = f.ay
            ORDER BY ay DESC
            LIMIT 12
            """
        )
        faiz_yuku = [dict(r) for r in cur.fetchall()]
        for r in faiz_yuku:
            faiz_v = float(r.get("faiz_toplam") or 0.0)
            ciro_v = float(r.get("ciro_toplam") or 0.0)
            r["ay"] = str(r.get("ay"))[:7] if r.get("ay") else None
            r["faiz_toplam"] = faiz_v
            r["ciro_toplam"] = ciro_v
            r["finansman_maliyeti_orani"] = round((faiz_v / ciro_v), 6) if ciro_v > 0 else None

        qp3: List[Any] = [gun_sayi]
        q3 = """
            SELECT
                COALESCE(SUM(c.toplam), 0)::numeric AS toplam_ciro,
                COALESCE(SUM(c.pos), 0)::numeric AS toplam_pos,
                COALESCE(SUM(c.online), 0)::numeric AS toplam_online,
                COALESCE(SUM(c.pos * COALESCE(s.pos_oran, 0) / 100.0), 0)::numeric AS pos_kesinti,
                COALESCE(SUM(c.online * COALESCE(s.online_oran, 0) / 100.0), 0)::numeric AS online_kesinti
            FROM ciro c
            LEFT JOIN subeler s ON s.id = c.sube_id
            WHERE c.durum='aktif'
              AND c.tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
        """
        if sid:
            q3 += " AND c.sube_id=%s"
            qp3.append(sid)
        cur.execute(q3, tuple(qp3))
        komisyon_ozet = dict(cur.fetchone() or {})
        nakit_akis_tahmin_dogrulugu = nakit_akis_tahmin_dogruluk(
            cur,
            gun_sayisi=min(max(gun_sayi, 14), 60),
            min_ornek=5,
            sube_id=sid,
        )

    toplam_ciro = sum(_safe_float(x.get("ciro")) for x in ciro_gider)
    toplam_gider = sum(_safe_float(x.get("gider")) for x in ciro_gider)
    ciro_gider_orani_ozet = round(toplam_ciro / toplam_gider, 6) if toplam_gider > 0 else None

    toplam_faiz = sum(_safe_float(x.get("faiz_toplam")) for x in faiz_yuku)
    kart_faiz_yuku_orani = round(toplam_faiz / toplam_ciro, 6) if toplam_ciro > 0 else None

    pos_kesinti = _safe_float(komisyon_ozet.get("pos_kesinti"))
    online_kesinti = _safe_float(komisyon_ozet.get("online_kesinti"))
    yanan_para_toplam = pos_kesinti + online_kesinti
    pos_yanan_para_orani = round(yanan_para_toplam / toplam_ciro, 6) if toplam_ciro > 0 else None
    toplam_kart_maliyeti_orani = round((toplam_faiz + yanan_para_toplam) / toplam_ciro, 6) if toplam_ciro > 0 else None

    veri_kalite = {
        "ciro_gider_orani_ozet": _quality(
            "tamam" if ciro_gider_orani_ozet is not None else "yetersiz_veri",
            "Ciro/gider oranı hesaplandı." if ciro_gider_orani_ozet is not None else "Gider toplamı sıfır veya kayıt yok.",
        ),
        "kart_faiz_yuku_orani": _quality(
            "tamam" if kart_faiz_yuku_orani is not None else "yetersiz_veri",
            "Kart faiz yükü oranı hesaplandı." if kart_faiz_yuku_orani is not None else "Ciro verisi olmadığı için faiz oranı hesaplanamadı.",
        ),
        "pos_yanan_para_orani": _quality(
            "tamam" if pos_yanan_para_orani is not None else "yetersiz_veri",
            "POS/online kesinti oranı hesaplandı." if pos_yanan_para_orani is not None else "Ciro verisi olmadığı için POS kesinti oranı hesaplanamadı.",
        ),
        "nakit_akis_tahmin_dogrulugu": _quality(
            str(nakit_akis_tahmin_dogrulugu.get("durum") or "yetersiz_veri"),
            str(nakit_akis_tahmin_dogrulugu.get("mesaj") or "Nakit akış doğruluğu hesaplanamadı."),
        ),
    }

    return {
        "gun_sayi": gun_sayi,
        "sube_id": sid,
        "ciro_gider_orani_ozet": ciro_gider_orani_ozet,
        "kart_faiz_yuku_orani": kart_faiz_yuku_orani,
        "pos_yanan_para_orani": pos_yanan_para_orani,
        "toplam_kart_maliyeti_orani": toplam_kart_maliyeti_orani,
        "veri_kalite": veri_kalite,
        "ciro_gider_orani": ciro_gider[:1500],
        "anlik_gider_kategori_trend": kategori_trend[:600],
        "kart_faiz_yuku": faiz_yuku,
        "nakit_akis_tahmin_dogrulugu": nakit_akis_tahmin_dogrulugu,
    }


@router.get("/metrics/stok-tedarik")
def ops_metrics_stok_tedarik(
    sube_id: Optional[str] = None,
    gun: int = 30,
):
    gun_sayi = max(7, min(365, int(gun)))
    sid = (sube_id or "").strip() or None
    with db() as (conn, cur):
        qp1: List[Any] = [gun_sayi]
        q1 = """
            SELECT
                o.tarih,
                o.sube_id,
                s.ad AS sube_adi,
                COALESCE(o.satis_tahmini_toplam, 0)::int AS teorik_satis
            FROM sube_operasyon_ozet o
            JOIN subeler s ON s.id = o.sube_id
            WHERE o.tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
        """
        if sid:
            q1 += " AND o.sube_id=%s"
            qp1.append(sid)
        q1 += " ORDER BY o.tarih DESC, o.sube_id"
        cur.execute(q1, tuple(qp1))
        gunluk_bardak = [dict(r) for r in cur.fetchall()]
        for r in gunluk_bardak:
            if r.get("tarih") is not None:
                r["tarih"] = str(r["tarih"])

        qp2: List[Any] = [gun_sayi]
        q2 = """
            SELECT sube_id, tarih, aciklama
            FROM operasyon_defter
            WHERE etiket='URUN_AC'
              AND tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
        """
        if sid:
            q2 += " AND sube_id=%s"
            qp2.append(sid)
        cur.execute(q2, tuple(qp2))
        ac_rows = [dict(r) for r in cur.fetchall()]

        qp3: List[Any] = [gun_sayi]
        q3 = """
            SELECT sube_id, tarih, kalem_kodu, adet
            FROM merkez_stok_sevk
            WHERE tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
        """
        if sid:
            q3 += " AND sube_id=%s"
            qp3.append(sid)
        cur.execute(q3, tuple(qp3))
        sevk_rows = [dict(r) for r in cur.fetchall()]

        qp4: List[Any] = [gun_sayi]
        q4 = """
            SELECT
                u.sube_id,
                s.ad AS sube_adi,
                COUNT(*)::int AS stok_uyari_adet
            FROM sube_operasyon_uyari u
            JOIN subeler s ON s.id = u.sube_id
            WHERE u.tip='STOK_KAPANIS_OZET'
              AND u.tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
        """
        if sid:
            q4 += " AND u.sube_id=%s"
            qp4.append(sid)
        q4 += " GROUP BY u.sube_id, s.ad ORDER BY stok_uyari_adet DESC"
        cur.execute(q4, tuple(qp4))
        uyari_ozet = [dict(r) for r in cur.fetchall()]

    # URUN_AC parse: sarf tüketim hızı + approx depo bekletme süresi için kalem bazında ayrıştır.
    ac_gunluk: Dict[tuple, Dict[str, int]] = {}
    gun_set: Dict[tuple, set] = {}
    for r in ac_rows:
        sidv = str(r.get("sube_id") or "")
        tarih_s = str(r.get("tarih") or "")
        key = (sidv, tarih_s)
        if key not in ac_gunluk:
            ac_gunluk[key] = {k: 0 for k in STOK_KEYS}
        d = _ops_parse_defter_delta(str(r.get("aciklama") or ""), "URUN_AC_JSON:")
        for k in STOK_KEYS:
            ac_gunluk[key][k] += int(d.get(k) or 0)
            if int(d.get(k) or 0) > 0:
                gun_set.setdefault((sidv, k), set()).add(tarih_s)

    sarf_tuketim_hizi: List[Dict[str, Any]] = []
    for k in STOK_KEYS:
        toplam = 0
        aktif_gun = set()
        for (sidv, tarih_s), d in ac_gunluk.items():
            v = int(d.get(k) or 0)
            if v > 0:
                toplam += v
                aktif_gun.add((sidv, tarih_s))
        gun_adet = max(1, len(aktif_gun))
        sarf_tuketim_hizi.append(
            {
                "kalem_kodu": k,
                "kalem_adi": STOK_LABEL_TR.get(k, k),
                "toplam_tuketim": int(toplam),
                "aktif_gun_sayisi": int(len(aktif_gun)),
                "gunluk_ortalama_tuketim": round(float(toplam) / float(gun_adet), 2),
            }
        )
    sarf_tuketim_hizi.sort(key=lambda x: x["gunluk_ortalama_tuketim"], reverse=True)

    # Yaklaşık depo bekletme süresi (proxy): sevk ve AC tarih ağırlıklı merkez farkı.
    sevk_agg: Dict[tuple, Dict[str, float]] = {}
    for r in sevk_rows:
        sidv = str(r.get("sube_id") or "")
        kalem = str(r.get("kalem_kodu") or "")
        if kalem not in STOK_KEYS:
            continue
        adet = max(0, int(r.get("adet") or 0))
        if adet <= 0:
            continue
        try:
            tord = date.fromisoformat(str(r.get("tarih"))).toordinal()
        except Exception:
            continue
        x = sevk_agg.setdefault((sidv, kalem), {"adet": 0.0, "gun_agirlik": 0.0})
        x["adet"] += float(adet)
        x["gun_agirlik"] += float(adet) * float(tord)

    ac_agg: Dict[tuple, Dict[str, float]] = {}
    for (sidv, tarih_s), d in ac_gunluk.items():
        try:
            tord = date.fromisoformat(tarih_s).toordinal()
        except Exception:
            continue
        for kalem in STOK_KEYS:
            adet = max(0, int(d.get(kalem) or 0))
            if adet <= 0:
                continue
            x = ac_agg.setdefault((sidv, kalem), {"adet": 0.0, "gun_agirlik": 0.0})
            x["adet"] += float(adet)
            x["gun_agirlik"] += float(adet) * float(tord)

    depo_bekletme = []
    for key, sagg in sevk_agg.items():
        aagg = ac_agg.get(key)
        if not aagg or sagg["adet"] <= 0 or aagg["adet"] <= 0:
            continue
        sevk_avg_ord = sagg["gun_agirlik"] / sagg["adet"]
        ac_avg_ord = aagg["gun_agirlik"] / aagg["adet"]
        lag = max(0.0, ac_avg_ord - sevk_avg_ord)
        depo_bekletme.append(
            {
                "sube_id": key[0],
                "kalem_kodu": key[1],
                "kalem_adi": STOK_LABEL_TR.get(key[1], key[1]),
                "ortalama_bekletme_gun_proxy": round(float(lag), 2),
                "sevk_adet": int(round(sagg["adet"])),
                "ac_adet": int(round(aagg["adet"])),
            }
        )
    depo_bekletme.sort(key=lambda x: x["ortalama_bekletme_gun_proxy"], reverse=True)

    # Açıklanamayan stok eksilmesi proxy: uyarı adedi + satis_tahmini_toplam kümülatif
    eksilme_map: Dict[str, Dict[str, Any]] = {}
    for r in gunluk_bardak:
        sidv = str(r.get("sube_id") or "")
        m = eksilme_map.setdefault(
            sidv,
            {
                "sube_id": sidv,
                "sube_adi": r.get("sube_adi"),
                "kumulatif_tahmini_eksilme": 0,
                "stok_kapanis_uyari_adet": 0,
            },
        )
        m["kumulatif_tahmini_eksilme"] += int(r.get("teorik_satis") or 0)
    for r in uyari_ozet:
        sidv = str(r.get("sube_id") or "")
        m = eksilme_map.setdefault(
            sidv,
            {
                "sube_id": sidv,
                "sube_adi": r.get("sube_adi"),
                "kumulatif_tahmini_eksilme": 0,
                "stok_kapanis_uyari_adet": 0,
            },
        )
        m["stok_kapanis_uyari_adet"] = int(r.get("stok_uyari_adet") or 0)
    aciklanamayan_eksilme = sorted(
        list(eksilme_map.values()),
        key=lambda x: (int(x.get("kumulatif_tahmini_eksilme") or 0), int(x.get("stok_kapanis_uyari_adet") or 0)),
        reverse=True,
    )

    gunluk_bardak_kullanim = None
    if gunluk_bardak:
        toplam_teorik = sum(int(x.get("teorik_satis") or 0) for x in gunluk_bardak)
        gun_adet = max(
            1,
            len({(str(x.get("sube_id") or ""), str(x.get("tarih") or "")) for x in gunluk_bardak}),
        )
        gunluk_bardak_kullanim = round(float(toplam_teorik) / float(gun_adet), 4)

    depo_bekletme_sure_gun = None
    if depo_bekletme:
        toplam_sevk = sum(max(1, int(x.get("sevk_adet") or 0)) for x in depo_bekletme)
        agirlikli = sum(_safe_float(x.get("ortalama_bekletme_gun_proxy")) * max(1, int(x.get("sevk_adet") or 0)) for x in depo_bekletme)
        depo_bekletme_sure_gun = round(agirlikli / float(max(1, toplam_sevk)), 4)

    aciklanamayan_stok_eksilmesi = None
    if aciklanamayan_eksilme:
        toplam_uyari = sum(int(x.get("stok_kapanis_uyari_adet") or 0) for x in aciklanamayan_eksilme)
        sube_adet = max(1, len(aciklanamayan_eksilme))
        aciklanamayan_stok_eksilmesi = round(float(toplam_uyari) / float(sube_adet), 4)

    veri_kalite = {
        "gunluk_bardak_kullanim": _quality(
            "tamam" if gunluk_bardak_kullanim is not None else "yetersiz_veri",
            "Günlük bardak kullanımı hesaplandı." if gunluk_bardak_kullanim is not None else "Bardak kullanımı için veri yok.",
        ),
        "depo_bekletme_sure_gun": _quality(
            "tamam" if depo_bekletme_sure_gun is not None else "yetersiz_veri",
            "Depo bekletme süresi hesaplandı." if depo_bekletme_sure_gun is not None else "Sevk->aç kayıt eşleşmesi yeterli değil.",
        ),
        "aciklanamayan_stok_eksilmesi": _quality(
            "tamam" if aciklanamayan_stok_eksilmesi is not None else "yetersiz_veri",
            "Açıklanamayan stok eksilmesi sinyali üretildi." if aciklanamayan_stok_eksilmesi is not None else "Stok uyarı verisi bulunamadı.",
        ),
    }

    return {
        "gun_sayi": gun_sayi,
        "sube_id": sid,
        "gunluk_bardak_kullanim": gunluk_bardak_kullanim,
        "depo_bekletme_sure_gun": depo_bekletme_sure_gun,
        "aciklanamayan_stok_eksilmesi": aciklanamayan_stok_eksilmesi,
        "veri_kalite": veri_kalite,
        "gunluk_bardak_kullanimi": gunluk_bardak[:1500],
        "sarf_malzeme_tuketim_hizi": sarf_tuketim_hizi,
        "depo_bekletme_suresi_proxy": depo_bekletme[:300],
        "aciklanamayan_stok_eksilmesi_proxy": aciklanamayan_eksilme,
    }


@router.get("/sube/{sube_id}/canli")
def ops_sube_canli(sube_id: str):
    """Tek şube canlı operasyon blob (ops panel detay / iframe)."""
    with db() as (conn, cur):
        sube = _sube_getir(cur, sube_id)
        return _kart_uret(cur, sube, _guvenlik_alarm_limitleri())


@router.get("/sube/{sube_id}/satis-ozet")
def ops_sube_satis_ozet(sube_id: str, tarih: Optional[date] = None):
    """
    Şube günlük satış/tüketim özeti:
    teorik stok (açılış + gün içi ekleme/açma), kapanış stok ve fark.
    """
    hedef_tarih = tarih or bugun_tr()
    with db() as (conn, cur):
        sube = _sube_getir(cur, sube_id)

        cur.execute(
            """
            SELECT meta
            FROM sube_operasyon_event
            WHERE sube_id=%s
              AND tarih=%s
              AND tip='ACILIS'
              AND durum='tamamlandi'
            ORDER BY cevap_ts DESC NULLS LAST, id DESC
            LIMIT 1
            """,
            (sube_id, hedef_tarih),
        )
        ac_row = cur.fetchone()
        ac_meta = _ops_parse_meta_obj((ac_row or {}).get("meta")) if ac_row else {}
        ac_blk = ac_meta.get("acilis_stok_sayim")
        if not isinstance(ac_blk, dict):
            ac_blk = ac_meta.get("stok_sayim")
        if not isinstance(ac_blk, dict):
            ac_blk = {}
        acilis = {k: int(ac_blk.get(k) or 0) for k in STOK_KEYS}

        cur.execute(
            """
            SELECT etiket, aciklama
            FROM operasyon_defter
            WHERE sube_id=%s
              AND tarih=%s
              AND etiket IN ('URUN_STOK_EKLE', 'URUN_AC')
            """,
            (sube_id, hedef_tarih),
        )
        eklenen = {k: 0 for k in STOK_KEYS}
        for row in cur.fetchall():
            etiket = str((row or {}).get("etiket") or "")
            aciklama = str((row or {}).get("aciklama") or "")
            if etiket == "URUN_STOK_EKLE":
                delta = _ops_parse_defter_delta(aciklama, "URUN_STOK_JSON:")
            else:
                delta = _ops_parse_defter_delta(aciklama, "URUN_AC_JSON:")
            for k in STOK_KEYS:
                eklenen[k] += int(delta.get(k) or 0)

        cur.execute(
            """
            SELECT meta
            FROM sube_operasyon_event
            WHERE sube_id=%s
              AND tarih=%s
              AND tip='KAPANIS'
              AND durum='tamamlandi'
            ORDER BY cevap_ts DESC NULLS LAST, id DESC
            LIMIT 1
            """,
            (sube_id, hedef_tarih),
        )
        kap_row = cur.fetchone()
        kap_meta = _ops_parse_meta_obj((kap_row or {}).get("meta")) if kap_row else {}
        kap_blk = kap_meta.get("kapanis_stok_sayim")
        if not isinstance(kap_blk, dict):
            kap_blk = {}
        kapanis = {k: int(kap_blk.get(k) or 0) for k in STOK_KEYS}

    satirlar: List[Dict[str, Any]] = []
    for k in STOK_KEYS:
        teorik = int(acilis.get(k) or 0) + int(eklenen.get(k) or 0)
        kap = int(kapanis.get(k) or 0)
        fark = teorik - kap
        satirlar.append(
            {
                "kalem_kodu": k,
                "kalem_adi": STOK_LABEL_TR.get(k, k),
                "acilis": int(acilis.get(k) or 0),
                "eklenen": int(eklenen.get(k) or 0),
                "teorik_stok": teorik,
                "kapanis_stok": kap,
                "fark": fark,
                "satis_tahmini": max(0, fark),
            }
        )

    return {
        "sube_id": sube_id,
        "sube_adi": sube.get("ad"),
        "tarih": str(hedef_tarih),
        "acilis_var": bool(ac_row),
        "kapanis_var": bool(kap_row),
        "satirlar": satirlar,
        "ozet": {
            "teorik_toplam": sum(int(x["teorik_stok"]) for x in satirlar),
            "kapanis_toplam": sum(int(x["kapanis_stok"]) for x in satirlar),
            "fark_toplam": sum(int(x["fark"]) for x in satirlar),
            "satis_tahmini_toplam": sum(int(x["satis_tahmini"]) for x in satirlar),
        },
    }


def _fetch_int_count(cur: Any) -> int:
    """
    COUNT(*) sonucunu güvenle okur. RealDictCursor bazen sütun adıyla döner;
    bazı psycopg sürümlerinde row[0] güvenilir olmayabilir.
    """
    row = cur.fetchone()
    if row is None:
        return 0
    try:
        vals = list(row.values())  # type: ignore[arg-type]
        if vals:
            return int(vals[0] or 0)
    except Exception:
        pass
    try:
        return int(row[0])  # type: ignore[index]
    except Exception:
        pass
    return 0


def _serialize_onay_row(r: dict) -> dict:
    d = dict(r)
    for k in ("tarih", "olusturma", "onay_tarihi"):
        if d.get(k) is not None:
            d[k] = str(d[k])
    return d


def _ops_panel_ozet_from_cur(cur: Any, bugun: str) -> Dict[str, Any]:
    """Operasyon hub sayıları — panel-ozet ile aynı (tek kaynak)."""
    cur.execute("SELECT COUNT(*) FROM subeler WHERE aktif=TRUE")
    aktif_sube = _fetch_int_count(cur)

    cur.execute("SELECT COUNT(*) FROM siparis_talep WHERE durum='bekliyor'")
    siparis_talep_bekleyen = _fetch_int_count(cur)
    cur.execute("SELECT COUNT(*) FROM siparis_ozel_talep WHERE durum='bekliyor'")
    siparis_ozel_bekleyen = _fetch_int_count(cur)
    try:
        cur.execute("SELECT COUNT(*) FROM siparis_urun WHERE aktif=TRUE")
        siparis_katalog_urun = _fetch_int_count(cur)
    except Exception:
        siparis_katalog_urun = 0

    cur.execute("SELECT COUNT(*) FROM onay_kuyrugu WHERE durum='bekliyor'")
    onay_bekleyen = _fetch_int_count(cur)

    try:
        cur.execute("""
            SELECT COUNT(*) FROM anlik_giderler
            WHERE tarih >= CURRENT_DATE - INTERVAL '7 days'
              AND COALESCE(NULLIF(TRIM(fis_kontrol_durumu),''),'bekliyor') = 'bekliyor'
              AND COALESCE(fis_gonderildi, FALSE) = FALSE
        """)
        fis_bekleyen = _fetch_int_count(cur)
    except Exception:
        try:
            cur.connection.rollback()
        except Exception:
            pass
        fis_bekleyen = 0

    cur.execute("SELECT COUNT(*) FROM sube_merkez_mesaj WHERE aktif=TRUE")
    mesaj_aktif = _fetch_int_count(cur)

    cur.execute("SELECT COUNT(*) FROM operasyon_defter WHERE tarih=%s::date", (bugun,))
    defter_bugun = _fetch_int_count(cur)

    cur.execute("""
        SELECT COUNT(*) FROM sube_operasyon_event
        WHERE tip='ACILIS' AND durum='tamamlandi' AND tarih=%s::date
    """, (bugun,))
    sayim_bugun = _fetch_int_count(cur)

    cur.execute("SELECT COUNT(*) FROM merkez_stok_kart")
    stok_kart_adet = _fetch_int_count(cur)

    cur.execute("""
        SELECT COUNT(*) FROM sube_operasyon_event
        WHERE tip='KONTROL' AND durum='gecikti' AND tarih=%s::date
    """, (bugun,))
    kontrol_gecikti = _fetch_int_count(cur)

    try:
        cur.execute("""
            SELECT COUNT(*) FROM sube_operasyon_uyari
            WHERE tarih >= CURRENT_DATE - INTERVAL '30 days'
              AND seviye IN ('uyari','kritik')
        """)
        uyari_30d = _fetch_int_count(cur)
    except Exception:
        try:
            cur.connection.rollback()
        except Exception:
            pass
        uyari_30d = 0

    cur.execute("""
        SELECT COUNT(DISTINCT sube_id) FROM sube_operasyon_event
        WHERE tip='KAPANIS' AND durum='tamamlandi'
          AND tarih >= CURRENT_DATE - INTERVAL '7 days'
    """)
    stok_kayip_sube = _fetch_int_count(cur)

    cur.execute("""
        SELECT COUNT(DISTINCT personel_id) FROM sube_operasyon_event
        WHERE tip='ACILIS' AND durum='tamamlandi'
          AND tarih >= CURRENT_DATE - INTERVAL '30 days'
          AND personel_id IS NOT NULL
    """)
    davranis_personel = _fetch_int_count(cur)

    cur.execute("SELECT COUNT(*) FROM personel WHERE aktif=TRUE")
    aktif_personel = _fetch_int_count(cur)

    try:
        cur.execute(
            """
            SELECT COUNT(*) FROM (
              SELECT sube_id FROM siparis_talep
              WHERE durum NOT IN ('teslim_edildi','iptal')
              GROUP BY sube_id
              HAVING COUNT(*) > 1
            ) t
            """
        )
        siparis_paralel_sube_sayisi = _fetch_int_count(cur)

        cur.execute(
            """
            SELECT COALESCE(SUM(cnt - 1), 0) FROM (
              SELECT COUNT(*)::bigint AS cnt FROM siparis_talep
              WHERE durum NOT IN ('teslim_edildi','iptal')
              GROUP BY sube_id
              HAVING COUNT(*) > 1
            ) t
            """
        )
        siparis_paralel_fazla_talep = _fetch_int_count(cur)
    except Exception:
        try:
            cur.connection.rollback()
        except Exception:
            pass
        siparis_paralel_sube_sayisi = 0
        siparis_paralel_fazla_talep = 0

    try:
        cur.execute("""
            SELECT COUNT(*) FROM sube_operasyon_uyari
            WHERE tip='STOK_ALARM' AND okundu=FALSE
              AND tarih >= CURRENT_DATE - INTERVAL '3 days'
        """)
        stok_alarm_bekleyen = _fetch_int_count(cur)
    except Exception:
        stok_alarm_bekleyen = 0

    return {
        "aktif_sube": aktif_sube,
        # Hub kartı toplamı (geri uyumluluk); ayrım: katalog siparis_talep vs özel talep
        "siparis_bekleyen": siparis_talep_bekleyen + siparis_ozel_bekleyen,
        "siparis_talep_bekleyen": siparis_talep_bekleyen,
        "siparis_ozel_bekleyen": siparis_ozel_bekleyen,
        "siparis_katalog_urun": siparis_katalog_urun,
        "onay_bekleyen": onay_bekleyen,
        "fis_bekleyen": fis_bekleyen,
        "mesaj_aktif": mesaj_aktif,
        "defter_bugun": defter_bugun,
        "sayim_bugun": sayim_bugun,
        "stok_kart_adet": stok_kart_adet,
        "kontrol_gecikti": kontrol_gecikti,
        "uyari_30d": uyari_30d,
        "stok_kayip_sube": stok_kayip_sube,
        "davranis_personel": davranis_personel,
        "aktif_personel": aktif_personel,
        "siparis_paralel_sube_sayisi": siparis_paralel_sube_sayisi,
        "siparis_paralel_fazla_talep": siparis_paralel_fazla_talep,
        "stok_alarm_bekleyen": stok_alarm_bekleyen,
    }


def _hub_ozet_fallback_panel() -> Dict[str, Any]:
    """Özet sorguları tamamen patlarsa hub'un yanıt verebilmesi için sıfır gövde."""
    return {
        "aktif_sube": 0,
        "siparis_bekleyen": 0,
        "siparis_talep_bekleyen": 0,
        "siparis_ozel_bekleyen": 0,
        "siparis_katalog_urun": 0,
        "onay_bekleyen": 0,
        "fis_bekleyen": 0,
        "mesaj_aktif": 0,
        "defter_bugun": 0,
        "sayim_bugun": 0,
        "stok_kart_adet": 0,
        "kontrol_gecikti": 0,
        "uyari_30d": 0,
        "stok_kayip_sube": 0,
        "davranis_personel": 0,
        "aktif_personel": 0,
        "siparis_paralel_sube_sayisi": 0,
        "siparis_paralel_fazla_talep": 0,
        "stok_alarm_bekleyen": 0,
    }


def _hub_alarm_satirlari(cur: Any, *, ozet: Optional[Dict[str, Any]] = None, limit: int = 40) -> List[Dict[str, Any]]:
    """
    Hub için okunaklı alarm satırları (sipariş + depo hattı + özet kuyruklar).

    Katalog siparişleri: yalnızca ``siparis_talep.durum = 'bekliyor'`` — ``/ops/bekleyen-merkez``
    içindeki sipariş listesi ile aynı küme (tarih / sevkiyat öncesi süzme yok; hub sayısıyla tutarlı).
    """
    satirlar: List[Dict[str, Any]] = []
    merkez_map = merkez_stok_kart_haritasi(cur)
    _sevk_baslik_tr = {
        "bekliyor": "sıra · onay öncesi",
        "depoda_hazirlaniyor": "depoda hazırlanıyor",
        "kismi_hazirlandi": "kısmi hazırlandı",
        "hazirlaniyor": "hazırlanıyor",
        "gonderildi": "gönderildi",
    }

    cur.execute(
        """
        SELECT st.id, st.sube_id, s.ad AS sube_adi, st.tarih, st.olusturma,
               st.personel_ad, st.not_aciklama, st.kalemler,
               COALESCE(st.hedef_depo_sube_id, st.sevkiyat_sube_id) AS hedef_depo_sube_id,
               COALESCE(NULLIF(TRIM(st.sevkiyat_durumu), ''), st.sevkiyat_durum, 'bekliyor') AS sevkiyat_durumu_norm
        FROM siparis_talep st
        JOIN subeler s ON s.id = st.sube_id
        WHERE st.durum = 'bekliyor'
        ORDER BY st.olusturma DESC NULLS LAST, st.id DESC
        LIMIT %s
        """,
        (limit,),
    )
    for row in cur.fetchall() or []:
        d = dict(row)
        tid = str(d.get("id") or "")
        sid = str(d.get("sube_id") or "")
        kalemler = d.get("kalemler") or []
        if isinstance(kalemler, str):
            try:
                kalemler = json.loads(kalemler)
            except Exception:
                kalemler = []
        if not isinstance(kalemler, list):
            kalemler = []
        hedef_raw = str(d.get("hedef_depo_sube_id") or "").strip()
        fl = enrich_siparis_kalemleri_stok_inplace(
            cur,
            sid,
            kalemler,
            merkez_map=merkez_map,
            hedef_depo_sube_id=hedef_raw or None,
        )
        cur.execute(
            """
            SELECT kural, mesaj, puan FROM sube_operasyon_uyari
            WHERE siparis_talep_id=%s AND tip='DAVRANIS' ORDER BY puan DESC
            """,
            (tid,),
        )
        davranis = [
            {"kural": r.get("kural"), "mesaj": r.get("mesaj"), "puan": int(r.get("puan") or 0)}
            for r in cur.fetchall()
        ]
        n_kalem = sum(
            1 for x in kalemler
            if isinstance(x, dict) and max(0, int((x or {}).get("adet") or 0)) > 0
        )
        parca: List[str] = []
        hesap_dep = fl.get("stok_hesap_kaynagi") == "hedef_depo"
        if fl.get("stok_alarm_var"):
            parca.append(
                "Sevkiyat deposunda yetersiz stok (veya sıfır)"
                if hesap_dep
                else "Merkez stoğu gönderimde yetmiyor veya sıfırlanır",
            )
        if fl.get("barem_risk_var"):
            parca.append(
                "Depo minimum (barem) altına düşme riski"
                if hesap_dep
                else "Merkez minimum stok (barem) altına iner",
            )
        if fl.get("gereksiz_var"):
            parca.append("Şubede talep miktarı zaten depoda var (gereksiz talep riski)")
        if fl.get("merkez_kayit_eksik_var"):
            parca.append("Bazı kalemler merkez stok kartında tanımsız")
        if davranis:
            parca.append(f"{len(davranis)} davranış uyarısı")
        cn_hub = siparis_cift_gonderim_bilgi_notu(
            cur,
            talep_id=tid,
            sube_id=sid,
            kalemler=kalemler,
            olusturma=d.get("olusturma"),
        )
        if cn_hub:
            parca.insert(0, "Önceki teslim bekleyen sipariş varken geldi — kalemleri karşılaştırın")
        if fl.get("stok_alarm_var"):
            sev = "kritik"
        elif fl.get("barem_risk_var") or fl.get("gereksiz_var") or fl.get("merkez_kayit_eksik_var") or davranis or cn_hub:
            sev = "uyari"
        else:
            sev = "bilgi"
        meta_hub = {
                "talep_id": tid,
                "sube_id": sid,
                "sube_adi": d.get("sube_adi"),
                "tarih": str(d.get("tarih") or ""),
                "olusturma": str(d.get("olusturma") or ""),
                "personel_ad": d.get("personel_ad"),
                "not_aciklama": d.get("not_aciklama"),
                "kalemler": kalemler,
                "davranis_uyarilari": davranis,
                "bayraklar": fl,
                "hedef_sekme": "siparis",
                "stok_hesap_kaynagi": fl.get("stok_hesap_kaynagi"),
                "hedef_depo_sube_id": fl.get("hedef_depo_sube_id"),
            }
        if cn_hub:
            meta_hub["cift_siparis_bilgi_notu"] = cn_hub
        sd_norm = str(d.get("sevkiyat_durumu_norm") or "bekliyor").strip().lower()
        ev_label = _sevk_baslik_tr.get(sd_norm) or (sd_norm.replace("_", " ") if sd_norm else "bekliyor")
        satirlar.append({
            "tip": "siparis_merkez_bekliyor",
            "id": f"sip:{tid}",
            "seviye": sev,
            "baslik": f"{d.get('sube_adi') or sid} — katalog sipariş ({ev_label})",
            "ozet": " · ".join(parca) if parca else f"{n_kalem} kalem; ek stok uyarısı yok",
            "meta": meta_hub,
        })

    cur.execute(
        """
        SELECT COUNT(*) AS c FROM siparis_talep st
        WHERE st.durum = 'bekliyor'
          AND COALESCE(NULLIF(TRIM(st.sevkiyat_durumu), ''), st.sevkiyat_durum, 'bekliyor') <> 'bekliyor'
        """,
    )
    depo_c = int((cur.fetchone() or {}).get("c") or 0)
    if depo_c > 0:
        satirlar.append({
            "tip": "depo_sevkiyat",
            "id": "ozet:depo_hatti",
            "seviye": "uyari",
            "baslik": "Depo / sevkiyat hattı",
            "ozet": f"{depo_c} sipariş depo veya sevkiyat aşamasında.",
            "meta": {"hedef_sekme": "stok-disiplin", "hedef_panel": "kuyruk"},
        })

    oz = ozet or {}
    # Genel onay kuyruğu sayısı hub alarm satırlarında tekrarlanmasın (ayrı modül / API üzerinden).
    if (oz.get("fis_bekleyen") or 0) > 0:
        satirlar.append({
            "tip": "fis_bekleyen",
            "id": "ozet:fis",
            "seviye": "uyari",
            "baslik": "Fiş kontrol",
            "ozet": f"{oz['fis_bekleyen']} anlık giderde fiş / kanıt bekleniyor.",
            "meta": {"hedef_sekme": "fis"},
        })

    try:
        cur.execute(
            """
            SELECT t.id, s.ad AS talep_sube_adi, d.ad AS depo_adi,
                   t.depo_sevkiyat_rapor_metni, t.depo_sevkiyat_rapor_ts
            FROM siparis_talep t
            JOIN subeler s ON s.id = t.sube_id
            LEFT JOIN subeler d ON d.id = COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id)
            WHERE t.depo_sevkiyat_rapor_ts IS NOT NULL
              AND COALESCE(t.depo_sevkiyat_rapor_uyari, FALSE) = TRUE
              AND t.depo_sevkiyat_rapor_ts >= NOW() - INTERVAL '96 hours'
            ORDER BY t.depo_sevkiyat_rapor_ts DESC
            LIMIT 8
            """
        )
        for rr in cur.fetchall() or []:
            dd = dict(rr)
            tid = str(dd.get("id") or "")
            oz_txt = (dd.get("depo_sevkiyat_rapor_metni") or "").strip()
            if len(oz_txt) > 240:
                oz_txt = oz_txt[:237] + "…"
            satirlar.append({
                "tip": "depo_sevkiyat_eksik",
                "id": f"depo_rap:{tid}",
                "seviye": "uyari",
                "baslik": f"Depo kalem raporu — {dd.get('talep_sube_adi') or tid}",
                "ozet": oz_txt or "Eksik / kısmi kalem bildirildi (son 96 saat).",
                "meta": {
                    "talep_id": tid,
                    "hedef_sekme": "siparis",
                    "depo_adi": dd.get("depo_adi"),
                },
            })
    except Exception:
        pass

    skor = {"kritik": 0, "uyari": 1, "bilgi": 2}
    satirlar.sort(key=lambda x: skor.get(x.get("seviye"), 5))
    return satirlar


@router.get("/bekleyen-merkez")
def ops_bekleyen_merkez(
    year_month: Optional[str] = None,
    sube_id: Optional[str] = None,
):
    """
    Ciro taslağı + onay kuyruğu + kasa uyarıları: year_month ile süzülür.
    Şube sipariş talepleri (siparis_talep, durum=bekliyor): ay filtresi uygulanmaz — hub /hub-ozet sayısı ile uyumlu kuyruk.
    Şube filtresi: ciro için sube_id; kuyruk için anlık gider satırının sube alanı; sipariş talebi için sube_id.
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

        # Bekleyen katalog siparişleri: ay filtresi YOK — hub siparis_bekleyen ile aynı kuyruk olmalı
        # (tarih başka ayda/null olsa bile merkez işlem sırasında görünür).
        qp3: List[Any] = []
        q3 = """
            SELECT t.id, t.sube_id, s.ad AS sube_adi, t.tarih, t.durum,
                   t.personel_id, t.personel_ad, t.bildirim_saati,
                   t.not_aciklama, t.kalemler, t.olusturma,
                   COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id) AS hedef_depo_sube_id,
                   ss.ad AS hedef_depo_sube_adi,
                   COALESCE(NULLIF(TRIM(t.sevkiyat_durumu), ''), t.sevkiyat_durum, 'bekliyor') AS sevkiyat_durumu,
                   COALESCE(NULLIF(TRIM(t.sevkiyat_notu), ''), t.sevkiyat_notlari) AS sevkiyat_notu,
                   t.kalem_durumlari,
                   NULLIF(TRIM(t.operasyon_yonlendirme_talimati), '') AS operasyon_yonlendirme_talimati
            FROM siparis_talep t
            JOIN subeler s ON s.id = t.sube_id
            LEFT JOIN subeler ss ON ss.id = COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id)
            WHERE t.durum = 'bekliyor'
        """
        if sid_f:
            q3 += " AND t.sube_id = %s"
            qp3.append(sid_f)
        q3 += " ORDER BY t.olusturma ASC NULLS LAST, t.id"
        cur.execute(q3, qp3)
        siparis_talepleri: List[Dict[str, Any]] = []
        merkez_harita_sip = merkez_stok_kart_haritasi(cur)
        for row in cur.fetchall():
            d = dict(row)
            if d.get("tarih"):
                d["tarih"] = str(d["tarih"])
            if d.get("olusturma"):
                d["olusturma"] = str(d["olusturma"])
            kalemler = d.get("kalemler")
            if isinstance(kalemler, str):
                try:
                    kalemler = json.loads(kalemler)
                except Exception:
                    kalemler = []
            if not isinstance(kalemler, list):
                kalemler = []
            d["kalemler"] = kalemler
            kalem_durum = d.get("kalem_durumlari")
            if isinstance(kalem_durum, str):
                try:
                    kalem_durum = json.loads(kalem_durum)
                except Exception:
                    kalem_durum = []
            if not isinstance(kalem_durum, list):
                kalem_durum = []
            d["kalem_durumlari"] = kalem_durum
            d["sevkiyat_sube_id"] = d.get("hedef_depo_sube_id")
            d["sevkiyat_sube_adi"] = d.get("hedef_depo_sube_adi")
            d["sevkiyat_durum"] = d.get("sevkiyat_durumu")
            d["sevkiyat_notlari"] = d.get("sevkiyat_notu")
            d["kalem_adet_toplam"] = sum(max(0, int((it or {}).get("adet") or 0)) for it in kalemler if isinstance(it, dict))
            sube_id_talep = d.get("sube_id") or ""
            hedef_dep = str(d.get("hedef_depo_sube_id") or "").strip() or None
            fl = enrich_siparis_kalemleri_stok_inplace(
                cur,
                str(sube_id_talep),
                kalemler,
                merkez_map=merkez_harita_sip,
                hedef_depo_sube_id=hedef_dep,
            )
            d["stok_hesap_kaynagi"] = fl.get("stok_hesap_kaynagi")
            cur.execute(
                "SELECT kural, mesaj, puan FROM sube_operasyon_uyari WHERE siparis_talep_id=%s AND tip='DAVRANIS'",
                (d.get("id"),),
            )
            d["davranis_uyarilari"] = [
                {"kural": r.get("kural"), "mesaj": r.get("mesaj"), "puan": int(r.get("puan") or 0)}
                for r in cur.fetchall()
            ]
            d["stok_alarm_var"] = fl["stok_alarm_var"]
            d["gereksiz_var"] = fl["gereksiz_var"]
            d["barem_risk_var"] = fl["barem_risk_var"]
            d["merkez_kayit_eksik_var"] = fl["merkez_kayit_eksik_var"]
            cn = siparis_cift_gonderim_bilgi_notu(
                cur,
                talep_id=str(d.get("id") or ""),
                sube_id=str(sube_id_talep),
                kalemler=kalemler,
                olusturma=d.get("olusturma"),
            )
            if cn:
                d["cift_siparis_bilgi_notu"] = cn
            siparis_talepleri.append(d)

        qp4 = [ym]
        q4 = """
            SELECT u.id, u.sube_id, s.ad AS sube_adi, u.tarih, u.seviye,
                   u.beklenen_tl, u.gercek_tl, u.fark_tl, u.mesaj, u.okundu, u.olusturma,
                   u.acilis_personel_id, u.acilis_personel_ad, u.kapanis_personel_id, u.kapanis_personel_ad
            FROM sube_operasyon_uyari u
            JOIN subeler s ON s.id = u.sube_id
            WHERE u.tip='ACILIS_KASA_FARK'
              AND u.okundu=FALSE
              AND to_char(u.tarih, 'YYYY-MM') = %s
        """
        if sid_f:
            q4 += " AND u.sube_id = %s"
            qp4.append(sid_f)
        q4 += " ORDER BY ABS(COALESCE(u.fark_tl, 0)) DESC, u.olusturma ASC NULLS LAST, u.id"
        cur.execute(q4, qp4)
        kasa_uyumsuzluklar: List[Dict[str, Any]] = []
        personel_hata_adet: Dict[str, Dict[str, Any]] = {}
        for row in cur.fetchall():
            d = dict(row)
            if d.get("tarih"):
                d["tarih"] = str(d["tarih"])
            if d.get("olusturma"):
                d["olusturma"] = str(d["olusturma"])
            for k in ("beklenen_tl", "gercek_tl", "fark_tl"):
                if d.get(k) is not None:
                    d[k] = float(d[k])
            kasa_uyumsuzluklar.append(d)

        qp5 = [ym]
        q5 = """
            SELECT acilis_personel_id, acilis_personel_ad, kapanis_personel_id, kapanis_personel_ad
            FROM sube_operasyon_uyari
            WHERE tip='ACILIS_KASA_FARK'
              AND to_char(tarih, 'YYYY-MM') = %s
        """
        if sid_f:
            q5 += " AND sube_id = %s"
            qp5.append(sid_f)
        cur.execute(q5, qp5)
        for r in cur.fetchall():
            for pid_key, pad_key in (
                ("acilis_personel_id", "acilis_personel_ad"),
                ("kapanis_personel_id", "kapanis_personel_ad"),
            ):
                pid = str((r or {}).get(pid_key) or "").strip()
                pad = str((r or {}).get(pad_key) or "").strip()
                if not pid and not pad:
                    continue
                pkey = pid or f"ad:{pad}"
                st = personel_hata_adet.setdefault(
                    pkey,
                    {"personel_id": pid or None, "personel_ad": pad or pid or "—", "aylik_hata_adet": 0},
                )
                st["aylik_hata_adet"] = int(st.get("aylik_hata_adet") or 0) + 1

        kritik_personeller = sorted(
            [v for v in personel_hata_adet.values() if int(v.get("aylik_hata_adet") or 0) >= 2],
            key=lambda x: int(x.get("aylik_hata_adet") or 0),
            reverse=True,
        )
        p_adet_map = {k: int(v.get("aylik_hata_adet") or 0) for k, v in personel_hata_adet.items()}
        for d in kasa_uyumsuzluklar:
            apid = str(d.get("acilis_personel_id") or "").strip()
            akey = apid or (f"ad:{str(d.get('acilis_personel_ad') or '').strip()}" if d.get("acilis_personel_ad") else "")
            kpid = str(d.get("kapanis_personel_id") or "").strip()
            kkey = kpid or (f"ad:{str(d.get('kapanis_personel_ad') or '').strip()}" if d.get("kapanis_personel_ad") else "")
            a_cnt = int(p_adet_map.get(akey) or 0) if akey else 0
            k_cnt = int(p_adet_map.get(kkey) or 0) if kkey else 0
            d["acilis_personel_aylik_hata_adet"] = a_cnt
            d["kapanis_personel_aylik_hata_adet"] = k_cnt
            d["kritik_personel_var"] = (a_cnt >= 2) or (k_cnt >= 2)

    return {
        "year_month": ym,
        "sube_id_filtre": sid_f,
        "ciro_taslaklari": ciro_taslaklari,
        "onay_kuyrugu": onay_satirlar,
        "siparis_talepleri": siparis_talepleri,
        "kasa_uyumsuzluklar": kasa_uyumsuzluklar,
        "kritik_kasa_personelleri": kritik_personeller,
        "ozet": {
            "ciro_taslak": len(ciro_taslaklari),
            "onay_satir": len(onay_satirlar),
            "siparis_talep": len(siparis_talepleri),
            "kasa_uyumsuzluk": len(kasa_uyumsuzluklar),
            "kritik_kasa_personel": len(kritik_personeller),
        },
    }


@router.post("/kasa-uyumsuzluk/{uyari_id}/coz")
def ops_kasa_uyumsuzluk_coz(uyari_id: str, body: KasaUyumsuzlukCozBody = KasaUyumsuzlukCozBody()):
    """
    Açılış kasa farkı uyarısını merkezden çözüldü olarak işaretler.
    """
    notu = (body.notu or "").strip()
    pid = (body.personel_id or "").strip() or None
    pad = (body.personel_ad or "").strip() or None
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT id, sube_id, beklenen_tl, gercek_tl, fark_tl, okundu
            FROM sube_operasyon_uyari
            WHERE id=%s
              AND tip='ACILIS_KASA_FARK'
            FOR UPDATE
            """,
            (uyari_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Kasa uyumsuzluk kaydı bulunamadı")
        r = dict(row)
        if bool(r.get("okundu")):
            return {"success": True, "durum": "zaten_cozulmus", "id": uyari_id}
        cur.execute(
            "UPDATE sube_operasyon_uyari SET okundu=TRUE WHERE id=%s",
            (uyari_id,),
        )
        bek = float(r.get("beklenen_tl") or 0)
        ger = float(r.get("gercek_tl") or 0)
        fark = float(r.get("fark_tl") or 0)
        aciklama = (
            f"Kasa uyumsuzluk çözüldü — uyari_id={uyari_id} "
            f"beklenen={bek:,.2f} gercek={ger:,.2f} fark={fark:,.2f}"
        )
        if notu:
            aciklama += f" | not={notu[:300]}"
        operasyon_defter_ekle(
            cur,
            str(r.get("sube_id") or ""),
            "KASA_UYUMSUZLUK_COZULDU",
            aciklama,
            None,
            personel_id=pid,
            personel_ad=pad,
            bildirim_saati=dt_now_tr().strftime("%H:%M"),
        )
        audit(cur, "sube_operasyon_uyari", uyari_id, "KASA_UYUMSUZLUK_COZULDU")
    return {"success": True, "durum": "cozuldu", "id": uyari_id}


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


# ─────────────────────────────────────────────────────────────
# MERKEZ MESAJ — Merkezden şubeye zorunlu okunması gereken mesaj
# ─────────────────────────────────────────────────────────────

class MerkezMesajOlusturBody(BaseModel):
    sube_id: str
    mesaj: str
    oncelik: str = "normal"  # normal | kritik
    ttl_saat: int = 72  # şube listesinde gösterim süresi (saat)


@router.post("/merkez-mesaj-gonder")
def ops_merkez_mesaj_gonder(body: MerkezMesajOlusturBody):
    """
    Merkezden şubeye zorunlu mesaj gönder.
    Şube paneli mesaj okunmadan kapanmaz (panel bu kontrolü yapar).
    """
    mesaj = (body.mesaj or "").strip()
    if len(mesaj) < 3:
        raise HTTPException(400, "Mesaj en az 3 karakter olmalı")
    if len(mesaj) > 2000:
        raise HTTPException(400, "Mesaj çok uzun (max 2000 karakter)")
    oncelik = (body.oncelik or "normal").strip()
    if oncelik not in ("normal", "kritik"):
        oncelik = "normal"
    try:
        ttl_h = int(body.ttl_saat)
    except (TypeError, ValueError):
        ttl_h = 72
    ttl_h = max(1, min(8760, ttl_h))

    with db() as (conn, cur):
        cur.execute("SELECT id FROM subeler WHERE id=%s AND aktif=TRUE", (body.sube_id,))
        if not cur.fetchone():
            raise HTTPException(404, "Şube bulunamadı")
        mid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO sube_merkez_mesaj
                (id, sube_id, mesaj, oncelik, okundu, aktif, ttl_saat)
            VALUES (%s, %s, %s, %s, FALSE, TRUE, %s)
            """,
            (mid, body.sube_id, mesaj, oncelik, ttl_h),
        )
    return {"success": True, "id": mid, "oncelik": oncelik, "ttl_saat": ttl_h}


@router.get("/merkez-mesajlar")
def ops_merkez_mesajlar_liste(
    sube_id: Optional[str] = None,
    okunmamis: bool = False,
    limit: int = 100,
):
    """Gönderilmiş merkez mesajları listesi (merkez paneli için)."""
    lim = max(10, min(500, int(limit)))
    sid_f = (sube_id or "").strip() or None
    with db() as (conn, cur):
        qp: list = []
        q = """
            SELECT m.id, m.sube_id, s.ad AS sube_adi, m.mesaj, m.oncelik,
                   m.okundu, m.okundu_ts, m.olusturma, m.okuyan_personel_id,
                   m.ttl_saat,
                   p.ad_soyad AS okuyan_ad
            FROM sube_merkez_mesaj m
            JOIN subeler s ON s.id = m.sube_id
            LEFT JOIN personel p ON p.id = m.okuyan_personel_id
            WHERE m.aktif = TRUE
        """
        if sid_f:
            q += " AND m.sube_id = %s"
            qp.append(sid_f)
        if okunmamis:
            q += " AND m.okundu = FALSE"
        q += " ORDER BY m.olusturma DESC LIMIT %s"
        qp.append(lim)
        cur.execute(q, qp)
        rows = []
        for r in cur.fetchall():
            d = dict(r)
            for k in ("olusturma", "okundu_ts"):
                if d.get(k):
                    d[k] = str(d[k])
            rows.append(d)
    return {"satirlar": rows, "toplam": len(rows)}


@router.delete("/merkez-mesaj/{mesaj_id}")
def ops_merkez_mesaj_sil(mesaj_id: str):
    """Merkez mesajını pasife al (silinmez, aktif=FALSE)."""
    with db() as (conn, cur):
        cur.execute(
            "UPDATE sube_merkez_mesaj SET aktif=FALSE WHERE id=%s",
            (mesaj_id,),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "Mesaj bulunamadı")
    return {"success": True}


# ─────────────────────────────────────────────────────────────
# PERSONEL PUANI
# ─────────────────────────────────────────────────────────────

@router.get("/personel-puan/{personel_id}")
def ops_personel_puan(personel_id: str, gun: int = 30):
    """
    Personel performans özeti:
    - Zamanında tamamlanan açılış/kontrol/kapanış sayısı
    - Geciken / kritik işlem sayısı
    - Gönderilen not sayısı
    - Hatalı PIN deneme sayısı
    - Son işlem zamanı
    """
    gun_sayi = max(7, min(90, int(gun)))
    with db() as (conn, cur):
        cur.execute("SELECT id, ad_soyad, sube_id FROM personel WHERE id=%s", (personel_id,))
        p = cur.fetchone()
        if not p:
            raise HTTPException(404, "Personel bulunamadı")
        p = dict(p)

        # Defter kayıtları — bu personelin son N günlük imzaları
        cur.execute(
            """
            SELECT etiket, COUNT(*) AS adet,
                   MAX(olay_ts) AS son_islem
            FROM operasyon_defter
            WHERE personel_id=%s
              AND tarih >= CURRENT_DATE - (%s * INTERVAL '1 day')
            GROUP BY etiket
            ORDER BY adet DESC
            """,
            (personel_id, gun_sayi),
        )
        defter_ozet = [dict(r) for r in cur.fetchall()]
        for d in defter_ozet:
            if d.get("son_islem"):
                d["son_islem"] = str(d["son_islem"])

        # Operasyon eventleri — tamamlama hızı
        cur.execute(
            """
            SELECT
                COUNT(*) FILTER (WHERE durum='tamamlandi') AS tamam,
                COUNT(*) FILTER (WHERE durum='gecikti') AS gecikti,
                COUNT(*) FILTER (WHERE cevap_ts IS NOT NULL
                    AND EXTRACT(EPOCH FROM (cevap_ts - son_teslim_ts)) > 0) AS geç_tamam,
                ROUND(AVG(CASE WHEN cevap_ts IS NOT NULL AND sistem_slot_ts IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (cevap_ts - sistem_slot_ts)) / 60.0 END)::numeric, 1) AS ort_cevap_dk
            FROM sube_operasyon_event e
            JOIN operasyon_defter d ON d.ref_event_id = e.id
            WHERE d.personel_id=%s
              AND e.tarih >= CURRENT_DATE - (%s * INTERVAL '1 day')
            """,
            (personel_id, gun_sayi),
        )
        op_row = cur.fetchone()
        op_ozet = dict(op_row) if op_row else {}

        # Güvenlik olayları
        cur.execute(
            """
            SELECT tip, COUNT(*) AS adet
            FROM operasyon_guvenlik_olay
            WHERE personel_id=%s
              AND olay_ts >= NOW() - (%s * INTERVAL '1 day')
            GROUP BY tip
            """,
            (personel_id, gun_sayi),
        )
        guvenlik = {r["tip"]: r["adet"] for r in cur.fetchall()}

        # Not sayısı
        cur.execute(
            """
            SELECT COUNT(*) AS adet FROM sube_merkez_not
            WHERE personel_id=%s
              AND olusturma >= NOW() - (%s * INTERVAL '1 day')
            """,
            (personel_id, gun_sayi),
        )
        not_sayisi = int((cur.fetchone() or {}).get("adet") or 0)

        # Puan hesabı (100 üzerinden)
        tamam = int(op_ozet.get("tamam") or 0)
        gecikti = int(op_ozet.get("gecikti") or 0)
        gec_tamam = int(op_ozet.get("gec_tamam") or 0)
        hatali_pin = int(guvenlik.get("PIN_HATALI") or 0)
        kilit = int(guvenlik.get("PIN_KILIT") or 0)

        toplam_op = tamam + gecikti
        if toplam_op > 0:
            temel_puan = round((tamam / toplam_op) * 80)
        else:
            temel_puan = 80

        gecikme_ceza = min(20, gecikti * 3 + gec_tamam * 1)
        pin_ceza = min(10, hatali_pin * 2 + kilit * 5)
        not_bonus = min(5, not_sayisi)

        puan = max(0, min(100, temel_puan - gecikme_ceza - pin_ceza + not_bonus))

        # Seviye
        if puan >= 90:
            seviye = "Mükemmel"
        elif puan >= 75:
            seviye = "İyi"
        elif puan >= 55:
            seviye = "Orta"
        else:
            seviye = "Gelişmeli"

    return {
        "personel_id": personel_id,
        "ad_soyad": p.get("ad_soyad"),
        "sube_id": p.get("sube_id"),
        "puan": puan,
        "seviye": seviye,
        "gun_sayi": gun_sayi,
        "op_ozet": {
            "tamam": tamam,
            "gecikti": gecikti,
            "gec_tamam": gec_tamam,
            "ort_cevap_dk": float(op_ozet.get("ort_cevap_dk") or 0),
        },
        "guvenlik": guvenlik,
        "not_sayisi": not_sayisi,
        "defter_ozet": defter_ozet,
        "puan_detay": {
            "temel": temel_puan,
            "gecikme_ceza": -gecikme_ceza,
            "pin_ceza": -pin_ceza,
            "not_bonus": not_bonus,
        },
    }


@router.get("/sube-personel-puan")
def ops_sube_personel_puan(sube_id: Optional[str] = None, gun: int = 30):
    """Tüm aktif personelin puan özeti (merkez için)."""
    gun_sayi = max(7, min(90, int(gun)))
    with db() as (conn, cur):
        q = """
            WITH op_agg AS (
                SELECT
                    d.personel_id,
                    COUNT(*) FILTER (WHERE e.durum='tamamlandi')::int AS tamam,
                    COUNT(*) FILTER (WHERE e.durum='gecikti')::int AS gecikti
                FROM sube_operasyon_event e
                JOIN operasyon_defter d ON d.ref_event_id = e.id
                WHERE e.tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
                  AND d.personel_id IS NOT NULL
                GROUP BY d.personel_id
            )
            SELECT
                p.id,
                p.ad_soyad,
                p.sube_id,
                COALESCE(oa.tamam, 0) AS tamam,
                COALESCE(oa.gecikti, 0) AS gecikti
            FROM personel p
            LEFT JOIN op_agg oa ON oa.personel_id = p.id
            WHERE p.aktif=TRUE
        """
        qp: list = [gun_sayi]
        if sube_id:
            q += " AND p.sube_id=%s"
            qp.append(sube_id)
        q += " ORDER BY p.ad_soyad"
        cur.execute(q, qp)
        personeller = [dict(r) for r in cur.fetchall()]

    sonuclar = []
    for p in personeller:
        tamam = int(p.get("tamam") or 0)
        gecikti = int(p.get("gecikti") or 0)
        toplam = tamam + gecikti
        puan = round((tamam / toplam) * 100) if toplam > 0 else None
        sonuclar.append({
            "personel_id": p["id"],
            "ad_soyad": p["ad_soyad"],
            "sube_id": p["sube_id"],
            "puan": puan,
            "tamam": tamam,
            "gecikti": gecikti,
        })

    sonuclar.sort(key=lambda x: (x["puan"] or 0), reverse=True)
    return {"personeller": sonuclar, "gun_sayi": gun_sayi}


# ─────────────────────────────────────────────────────────────
# SİPARİŞ — Merkez katalog + özel ürün talepleri
# ─────────────────────────────────────────────────────────────


def _ops_sube_anchor(cur) -> str:
    cur.execute("SELECT id FROM subeler WHERE aktif=TRUE ORDER BY id LIMIT 1")
    r = cur.fetchone()
    if not r:
        raise HTTPException(503, "Aktif şube kaydı yok; defter için şube gerekli.")
    return str(dict(r)["id"])


def _ops_defter_sube_sevkiyat_hedef(hedef_depo_sube_id: Optional[str], cur) -> str:
    """
    Operasyonun siparişi yönlendirdiği hedef depo şubesi (Tema, Zafer, …), o iş için
    merkez depo ile aynı mantıkta «çıkış deposu»dur: stok ve operasyon_defter izi bu şube
    üzerinden tutulur; rastgele ilk şubeye yazılmaz.
    Hedef bilinmiyorsa geriye dönük uyumluluk için anchor kullanılır.
    """
    hid = (hedef_depo_sube_id or "").strip()
    if hid:
        return hid
    return _ops_sube_anchor(cur)


def _siparis_urun_insert(cur, kategori_kod: str, urun_adi: str) -> Dict[str, Any]:
    ad = (urun_adi or "").strip()
    if len(ad) < 2:
        raise HTTPException(400, "Ürün adı en az 2 karakter olmalı")
    cur.execute(
        "SELECT id FROM siparis_kategori WHERE kod=%s AND aktif=TRUE",
        (kategori_kod.strip(),),
    )
    kr = cur.fetchone()
    if not kr:
        raise HTTPException(404, "Kategori bulunamadı")
    kategori_db_id = str(dict(kr)["id"])
    norm = _norm_ad_tr(ad)
    if not norm:
        raise HTTPException(400, "Ürün adı geçersiz")
    cur.execute(
        """
        INSERT INTO siparis_urun (kategori_id, ad, norm_ad, sira, aktif, guncelleme)
        VALUES (
            %s, %s, %s,
            COALESCE((SELECT MAX(sira)+10 FROM siparis_urun WHERE kategori_id=%s), 10),
            TRUE, NOW()
        )
        ON CONFLICT (kategori_id, norm_ad)
        DO UPDATE SET ad=EXCLUDED.ad, aktif=TRUE, guncelleme=NOW()
        RETURNING id, ad
        """,
        (kategori_db_id, ad, norm, kategori_db_id),
    )
    return dict(cur.fetchone())


def _siparis_kategori_kod_unique(cur, base: str) -> str:
    b = (base or "kat").strip().strip("_")[:50] or "kat"
    kod = b
    n = 2
    while True:
        cur.execute("SELECT 1 FROM siparis_kategori WHERE kod=%s", (kod,))
        if not cur.fetchone():
            return kod
        kod = f"{b}_{n}"[:60]
        n += 1


@router.get("/siparis/katalog")
def ops_siparis_katalog():
    with db() as (conn, cur):
        return {"kategoriler": _siparis_katalog_getir(cur)}


@router.get("/siparis/ozel-bekleyen")
def ops_siparis_ozel_bekleyen():
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT t.id, t.sube_id, s.ad AS sube_adi, t.tarih, t.urun_adi, t.kategori_kod,
                   t.adet, t.not_aciklama, t.personel_ad, t.bildirim_saati, t.olusturma
            FROM siparis_ozel_talep t
            JOIN subeler s ON s.id = t.sube_id
            WHERE t.durum = 'bekliyor'
            ORDER BY t.olusturma ASC
            """
        )
        rows = []
        for r in cur.fetchall():
            d = dict(r)
            if d.get("olusturma"):
                d["olusturma"] = str(d["olusturma"])
            if d.get("tarih"):
                d["tarih"] = str(d["tarih"])
            rows.append(d)
    return {"talepler": rows}


@router.get("/siparis/sevk-eksik")
def ops_siparis_sevk_eksik(gun: int = 3):
    gun = max(1, min(int(gun or 3), 30))
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT
                e.id,
                e.sube_id,
                s.ad AS sube_adi,
                e.tarih,
                e.tedarikci_ad,
                e.eksik_kategori,
                e.eksik_aciklama,
                e.bildiren_personel_ad,
                e.siparis_personel_ad,
                e.olusturma
            FROM siparis_sevk_eksik e
            JOIN subeler s ON s.id = e.sube_id
            WHERE e.tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
            ORDER BY e.olusturma DESC
            LIMIT 300
            """,
            (gun,),
        )
        rows = []
        for r in cur.fetchall():
            d = dict(r)
            if d.get("olusturma"):
                d["olusturma"] = str(d["olusturma"])
            if d.get("tarih"):
                d["tarih"] = str(d["tarih"])
            rows.append(d)
    return {"kayitlar": rows}


class OpsSiparisUrunBody(BaseModel):
    kategori_kod: str
    urun_adi: str


class OpsSiparisSevkiyataGonderBody(BaseModel):
    talep_id: str
    hedef_depo_sube_id: Optional[str] = None
    sevkiyat_sube_id: Optional[str] = None  # legacy compatibility
    not_aciklama: Optional[str] = None
    # Dağıtım / öncelik talimatı — depo + talep şubesi panelinde gösterilir
    operasyon_yonlendirme_talimati: Optional[str] = None


class OpsSiparisSevkiyatKalemDurum(BaseModel):
    urun_id: Optional[str] = None
    urun_ad: Optional[str] = None
    istenen_adet: Optional[int] = None
    durum: str  # bekliyor | var | yok | kismi
    gonderilen_adet: Optional[int] = None
    notu: Optional[str] = None
    not_aciklama: Optional[str] = None


class OpsSiparisSevkiyatGuncelleBody(BaseModel):
    talep_id: str
    hedef_depo_sube_id: Optional[str] = None
    sevkiyat_sube_id: Optional[str] = None  # legacy compatibility
    kalem_durumlari: List[OpsSiparisSevkiyatKalemDurum]
    not_aciklama: Optional[str] = None
    sevkiyat_notu: Optional[str] = None
    personel_ad: Optional[str] = None
    pin: Optional[str] = None
    gonderildi: bool = False


@router.post("/siparis/urun")
def ops_siparis_urun_ekle(body: OpsSiparisUrunBody):
    """Merkez: katalog ürünü ekle veya (norm_ad çakışırsa) yeniden aktif et."""
    with db() as (conn, cur):
        r = _siparis_urun_insert(cur, body.kategori_kod, body.urun_adi)
        audit(cur, "siparis_urun", str(r["id"]), "OPS_SIPARIS_URUN_EKLE")
        from operasyon_defter import operasyon_defter_ekle

        sid = _ops_sube_anchor(cur)
        saat = dt_now_tr().strftime("%H:%M:%S")
        operasyon_defter_ekle(
            cur,
            sid,
            "OPS_SIPARIS_URUN",
            f"Merkez katalog — ürün eklendi/aktif: kategori={body.kategori_kod} urun={r['ad']}",
            bildirim_saati=saat,
        )
    return {"success": True, "urun_id": str(r["id"]), "urun_ad": r["ad"]}


class OpsSiparisUrunDurumBody(BaseModel):
    kategori_kod: str
    urun_id: str
    aktif: bool


@router.post("/siparis/urun-durum")
def ops_siparis_urun_durum(body: OpsSiparisUrunDurumBody):
    with db() as (conn, cur):
        cur.execute(
            "SELECT id FROM siparis_kategori WHERE kod=%s",
            ((body.kategori_kod or "").strip(),),
        )
        kr = cur.fetchone()
        if not kr:
            raise HTTPException(404, "Kategori bulunamadı")
        kid = str(dict(kr)["id"])
        cur.execute(
            """
            UPDATE siparis_urun SET aktif=%s, guncelleme=NOW()
            WHERE id=%s AND kategori_id=%s
            RETURNING id, ad, aktif
            """,
            (bool(body.aktif), (body.urun_id or "").strip(), kid),
        )
        ur = cur.fetchone()
        if not ur:
            raise HTTPException(404, "Ürün bulunamadı")
        ud = dict(ur)
        audit(cur, "siparis_urun", str(ud["id"]), "OPS_SIPARIS_URUN_DURUM")
        from operasyon_defter import operasyon_defter_ekle

        sid = _ops_sube_anchor(cur)
        saat = dt_now_tr().strftime("%H:%M:%S")
        operasyon_defter_ekle(
            cur,
            sid,
            "OPS_SIPARIS_URUN_DURUM",
            f"Merkez — ürün aktif={bool(ud['aktif'])} kategori={body.kategori_kod} urun={ud['ad']}",
            bildirim_saati=saat,
        )
    return {"success": True, "urun_id": str(ud["id"]), "aktif": bool(ud["aktif"])}


class OpsSiparisKategoriBody(BaseModel):
    ad: str
    emoji: str = "📦"


@router.post("/siparis/kategori")
def ops_siparis_kategori_olustur(body: OpsSiparisKategoriBody):
    ad = (body.ad or "").strip()
    if len(ad) < 2:
        raise HTTPException(400, "Kategori adı en az 2 karakter olmalı")
    emoji = ((body.emoji or "") or "📦").strip() or "📦"
    base_kod = _norm_ad_tr(ad) or "kategori"
    with db() as (conn, cur):
        kod = _siparis_kategori_kod_unique(cur, base_kod)
        cur.execute(
            """
            INSERT INTO siparis_kategori (kod, ad, emoji, sira, aktif)
            VALUES (
                %s, %s, %s,
                COALESCE((SELECT MAX(sira)+10 FROM siparis_kategori), 10),
                TRUE
            )
            RETURNING id, kod, ad
            """,
            (kod, ad, emoji),
        )
        row = dict(cur.fetchone())
        audit(cur, "siparis_kategori", str(row["id"]), "OPS_SIP_KATEGORI")
        from operasyon_defter import operasyon_defter_ekle

        sid = _ops_sube_anchor(cur)
        saat = dt_now_tr().strftime("%H:%M:%S")
        operasyon_defter_ekle(
            cur,
            sid,
            "OPS_SIPARIS_KATEGORI",
            f"Yeni sipariş kategorisi — kod={row['kod']} ad={row['ad']}",
            bildirim_saati=saat,
        )
    return {"success": True, "kategori": row}


@router.post("/siparis/sevkiyata-gonder")
def ops_siparis_sevkiyata_gonder(body: OpsSiparisSevkiyataGonderBody):
    tid = (body.talep_id or "").strip()
    sevk_sube_id = (body.hedef_depo_sube_id or body.sevkiyat_sube_id or "").strip()
    if not tid or not sevk_sube_id:
        raise HTTPException(400, "talep_id ve hedef_depo_sube_id zorunlu")
    notu = (body.not_aciklama or "").strip() or None
    _tal = body.operasyon_yonlendirme_talimati
    talimat_param = (str(_tal).strip() if _tal is not None else None) or None
    with db() as (conn, cur):
        cur.execute("SELECT id, ad, sube_tipi, aktif FROM subeler WHERE id=%s", (sevk_sube_id,))
        sr = cur.fetchone()
        if not sr:
            raise HTTPException(404, "Sevkiyat şubesi bulunamadı")
        srow = dict(sr)
        if not bool(srow.get("aktif")):
            raise HTTPException(400, "Sevkiyat şubesi pasif")
        if str(srow.get("sube_tipi") or "normal") not in ("depo", "karma", "sevkiyat", "merkez"):
            raise HTTPException(400, "Seçilen şube depo/karma tipi değil")
        cur.execute(
            """
            SELECT id, sube_id, durum, kalemler, kalem_durumlari,
                   COALESCE(hedef_depo_sube_id, sevkiyat_sube_id) AS hedef_depo_sube_id,
                   COALESCE(NULLIF(TRIM(sevkiyat_durumu), ''), sevkiyat_durum, 'bekliyor') AS sevkiyat_durumu
            FROM siparis_talep
            WHERE id=%s
            FOR UPDATE
            """,
            (tid,),
        )
        tr = cur.fetchone()
        if not tr:
            raise HTTPException(404, "Sipariş talebi bulunamadı")
        t = dict(tr)
        if str(t.get("durum") or "") not in ("bekliyor", "hazirlaniyor", "gonderildi"):
            raise HTTPException(409, "Talep sevkiyat akışı için uygun durumda değil")
        kalemler = t.get("kalemler")
        if isinstance(kalemler, str):
            try:
                kalemler = json.loads(kalemler)
            except Exception:
                kalemler = []
        if not isinstance(kalemler, list):
            kalemler = []
        # Önceki tahsis kararlarını koru: merkez_tahsis_yap yeni format yazmış olabilir
        # {kalem_kodu, talep_adet, tahsis_adet} → urun_id ile eşleştir
        onceki_kd = t.get("kalem_durumlari")
        if isinstance(onceki_kd, str):
            try:
                onceki_kd = json.loads(onceki_kd)
            except Exception:
                onceki_kd = []
        if not isinstance(onceki_kd, list):
            onceki_kd = []
        # Tahsis bilgisini kalem_kodu'ya göre indeksle
        tahsis_map: Dict[str, Dict[str, Any]] = {}
        for kd in onceki_kd:
            if not isinstance(kd, dict):
                continue
            kk = str(kd.get("kalem_kodu") or kd.get("urun_id") or "").strip()
            if kk:
                tahsis_map[kk] = kd
        kalem_durumlari: List[Dict[str, Any]] = []
        for k in kalemler:
            if not isinstance(k, dict):
                continue
            istenen = _ops_int(k.get("adet") or k.get("istened_adet") or k.get("istenen_adet") or 0, 0)
            uid = (k.get("urun_id") or "").strip() or None
            uad = (k.get("urun_ad") or k.get("ad") or "").strip() or None
            # Tahsis verisini urun_id ile bul (kalem_kodu = urun_id varsayımı)
            tahsis = tahsis_map.get(uid or "") if uid else {}
            tahsis_adet = int((tahsis or {}).get("tahsis_adet") or 0)
            tahsis_durum = str((tahsis or {}).get("durum") or "").strip() or None
            entry: Dict[str, Any] = {
                "urun_id": uid,
                "urun_ad": uad,
                "istenen_adet": max(0, istenen),
                "gonderilen_adet": 0,
                "durum": "bekliyor",
                "not": None,
            }
            # Tahsis bilgisi varsa ekle — depo hazırlık aşaması için referans
            if tahsis_adet > 0:
                entry["tahsis_adet"] = tahsis_adet
                entry["tahsis_durum"] = tahsis_durum
            kalem_durumlari.append(entry)
        cur.execute(
            """
            UPDATE siparis_talep
            SET durum='hazirlaniyor',
                hedef_depo_sube_id=%s,
                sevkiyat_sube_id=%s,
                sevkiyat_durumu='depoda_hazirlaniyor',
                sevkiyat_durum='hazirlaniyor',
                kalem_durumlari=%s::jsonb,
                sevkiyat_notu=%s,
                sevkiyat_notlari=%s,
                operasyon_yonlendirme_talimati = COALESCE(NULLIF(TRIM(%s), ''), operasyon_yonlendirme_talimati),
                sevkiyat_ts=NOW()
            WHERE id=%s
            """,
            (sevk_sube_id, sevk_sube_id, json.dumps(kalem_durumlari, ensure_ascii=False), notu, notu, talimat_param, tid),
        )
        defter_sube = _ops_defter_sube_sevkiyat_hedef(sevk_sube_id, cur)
        operasyon_defter_ekle(
            cur,
            defter_sube,
            "SIPARIS_SEVKIYAT_BASLADI",
            f"Sipariş sevkiyata gönderildi (depo hub hedef şube) — talep={tid} hedef_sube={sevk_sube_id}"
            + (f" not={notu}" if notu else "")
            + (
                f" talimat={(talimat_param[:180] + '…')}"
                if talimat_param and len(talimat_param) > 180
                else (f" talimat={talimat_param}" if talimat_param else "")
            ),
            bildirim_saati=dt_now_tr().strftime("%H:%M:%S"),
        )
        audit(cur, "siparis_talep", tid, "OPS_SIPARIS_SEVKIYATA_GONDER")
        # Disiplin motoru: tahsis olayını deftere yaz (kalem_durumlari değiştirilmez — eski format korunur)
        try:
            talep_sube_id = str(t.get("sube_id") or "")
            if talep_sube_id:
                operasyon_defter_ekle(
                    cur, talep_sube_id,
                    OLAY_TAHSIS_TAM,
                    json.dumps({"hedef_sube": sevk_sube_id, "kalem_sayisi": len(kalemler)},
                               ensure_ascii=False),
                    ref_event_id=tid,
                )
        except Exception:
            pass
    return {
        "success": True,
        "talep_id": tid,
        "hedef_depo_sube_id": sevk_sube_id,
        "sevkiyat_sube_id": sevk_sube_id,
        "sevkiyat_durumu": "depoda_hazirlaniyor",
    }


@router.get("/subeler/depolar")
def ops_subeler_depolar():
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT id, ad, sube_tipi, aktif
            FROM subeler
            WHERE aktif=TRUE
              AND sube_tipi IN ('depo', 'karma', 'sevkiyat', 'merkez')
            ORDER BY ad
            """
        )
        rows = []
        for r in cur.fetchall():
            d = dict(r)
            st = str(d.get("sube_tipi") or "normal")
            if st == "sevkiyat":
                st = "depo"
            elif st == "merkez":
                st = "karma"
            d["sube_tipi"] = st
            rows.append(d)
    return {"satirlar": rows}


@router.get("/siparis/sevkiyat-listesi")
def ops_siparis_sevkiyat_listesi(
    sevkiyat_sube_id: Optional[str] = None,
    durum: str = "hazirlaniyor",
    gun: int = 7,
):
    gun_sayi = max(1, min(60, int(gun or 7)))
    sid = (sevkiyat_sube_id or "").strip() or None
    durum_f = (durum or "hazirlaniyor").strip().lower()
    if durum_f == "all":
        durum_f = "all"
    elif durum_f not in ("hazirlaniyor", "depoda_hazirlaniyor", "kismi_hazirlandi", "gonderildi", "teslim_edildi"):
        raise HTTPException(400, "durum: hazirlaniyor | depoda_hazirlaniyor | kismi_hazirlandi | gonderildi | teslim_edildi | all")
    with db() as (conn, cur):
        qp: List[Any] = [gun_sayi]
        q = """
            SELECT t.id, t.sube_id, s.ad AS sube_adi, t.tarih, t.durum,
                   t.personel_id, t.personel_ad, t.bildirim_saati, t.not_aciklama,
                   t.kalemler,
                   COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id) AS hedef_depo_sube_id,
                   ss.ad AS hedef_depo_sube_adi,
                   COALESCE(NULLIF(TRIM(t.sevkiyat_durumu), ''), t.sevkiyat_durum, 'bekliyor') AS sevkiyat_durumu,
                   COALESCE(NULLIF(TRIM(t.sevkiyat_notu), ''), t.sevkiyat_notlari) AS sevkiyat_notu,
                   t.kalem_durumlari, t.olusturma, t.sevkiyat_ts, t.sevkiyat_personel_ad
            FROM siparis_talep t
            JOIN subeler s ON s.id = t.sube_id
            LEFT JOIN subeler ss ON ss.id = COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id)
            WHERE t.tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
              AND COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id) IS NOT NULL
        """
        if sid:
            q += " AND COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id)=%s"
            qp.append(sid)
        if durum_f != "all":
            if durum_f == "hazirlaniyor":
                q += " AND COALESCE(NULLIF(TRIM(t.sevkiyat_durumu), ''), t.sevkiyat_durum, 'bekliyor') IN ('depoda_hazirlaniyor', 'kismi_hazirlandi', 'hazirlaniyor')"
            else:
                q += " AND COALESCE(NULLIF(TRIM(t.sevkiyat_durumu), ''), t.sevkiyat_durum, 'bekliyor')=%s"
                qp.append(durum_f)
        q += " ORDER BY t.tarih DESC, t.olusturma DESC NULLS LAST, t.id"
        cur.execute(q, qp)
        rows: List[Dict[str, Any]] = []
        for r in cur.fetchall():
            d = dict(r)
            d["sevkiyat_sube_id"] = d.get("hedef_depo_sube_id")
            d["sevkiyat_sube_adi"] = d.get("hedef_depo_sube_adi")
            d["sevkiyat_durum"] = d.get("sevkiyat_durumu")
            d["sevkiyat_notlari"] = d.get("sevkiyat_notu")
            for k in ("tarih", "olusturma"):
                if d.get(k):
                    d[k] = str(d[k])
            if d.get("sevkiyat_ts"):
                d["sevkiyat_ts"] = str(d["sevkiyat_ts"])
            for k in ("kalemler", "kalem_durumlari"):
                v = d.get(k)
                if isinstance(v, str):
                    try:
                        v = json.loads(v)
                    except Exception:
                        v = []
                if not isinstance(v, list):
                    v = []
                d[k] = v
            rows.append(d)
    return {
        "satirlar": rows,
        "durum": durum_f,
        "hedef_depo_sube_id": sid,
        "sevkiyat_sube_id": sid,
        "gun_sayi": gun_sayi,
    }


@router.get("/siparis/depo-bekleyen")
def ops_siparis_depo_bekleyen(sube_id: str, gun: int = 15):
    sid = (sube_id or "").strip()
    if not sid:
        raise HTTPException(400, "sube_id zorunlu")
    gun_sayi = max(1, min(60, int(gun or 15)))
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT t.id, t.sube_id, s.ad AS sube_adi, t.tarih, t.durum,
                   t.kalemler, t.kalem_durumlari,
                   COALESCE(NULLIF(TRIM(t.sevkiyat_durumu), ''), t.sevkiyat_durum, 'bekliyor') AS sevkiyat_durumu,
                   COALESCE(NULLIF(TRIM(t.sevkiyat_notu), ''), t.sevkiyat_notlari) AS sevkiyat_notu,
                   t.olusturma
            FROM siparis_talep t
            JOIN subeler s ON s.id = t.sube_id
            WHERE COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id)=%s
              AND t.tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
              AND COALESCE(NULLIF(TRIM(t.sevkiyat_durumu), ''), t.sevkiyat_durum, 'bekliyor') IN ('depoda_hazirlaniyor', 'kismi_hazirlandi')
            ORDER BY t.tarih DESC, t.olusturma DESC NULLS LAST, t.id
            """,
            (sid, gun_sayi),
        )
        rows: List[Dict[str, Any]] = []
        for r in cur.fetchall():
            d = dict(r)
            for k in ("tarih", "olusturma"):
                if d.get(k):
                    d[k] = str(d[k])
            for k in ("kalemler", "kalem_durumlari"):
                v = d.get(k)
                if isinstance(v, str):
                    try:
                        v = json.loads(v)
                    except Exception:
                        v = []
                if not isinstance(v, list):
                    v = []
                d[k] = v
            rows.append(d)
    return {"satirlar": rows, "sube_id": sid, "gun_sayi": gun_sayi}


@router.get("/siparis/depo-sevkiyat-raporlari")
def ops_siparis_depo_sevkiyat_raporlari(gun: int = 21, limit: int = 40):
    """Depo şubesinin işlediği kalem bazlı özet raporlar (isten / gönderilen / yok)."""
    gun_i = max(1, min(90, int(gun or 21)))
    lim = max(1, min(80, int(limit or 40)))
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT t.id, t.sube_id, s.ad AS talep_sube_adi, t.tarih, t.durum,
                   COALESCE(NULLIF(TRIM(t.sevkiyat_durumu), ''), t.sevkiyat_durum, 'bekliyor')
                     AS sevkiyat_durumu,
                   COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id) AS hedef_depo_sube_id,
                   hd.ad AS hedef_depo_adi,
                   t.depo_sevkiyat_rapor_metni, t.depo_sevkiyat_rapor_ts,
                   t.depo_sevkiyat_rapor_uyari,
                   COALESCE(NULLIF(TRIM(t.sevkiyat_personel_ad), ''), '') AS depo_personel_ad
            FROM siparis_talep t
            JOIN subeler s ON s.id = t.sube_id
            LEFT JOIN subeler hd ON hd.id = COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id)
            WHERE t.depo_sevkiyat_rapor_metni IS NOT NULL
              AND TRIM(t.depo_sevkiyat_rapor_metni) <> ''
              AND t.tarih >= CURRENT_DATE - (%s * INTERVAL '1 day')
            ORDER BY t.depo_sevkiyat_rapor_ts DESC NULLS LAST, t.olusturma DESC NULLS LAST
            LIMIT %s
            """,
            (gun_i, lim),
        )
        raporlar: List[Dict[str, Any]] = []
        for r in cur.fetchall() or []:
            d = dict(r)
            if d.get("tarih"):
                d["tarih"] = str(d["tarih"])
            if d.get("depo_sevkiyat_rapor_ts"):
                d["depo_sevkiyat_rapor_ts"] = str(d["depo_sevkiyat_rapor_ts"])
            d["id"] = str(d.get("id") or "")
            raporlar.append(d)
    return {"gun": gun_i, "limit": lim, "raporlar": raporlar}


@router.post("/siparis/sevkiyat-guncelle")
def ops_siparis_sevkiyat_guncelle(body: OpsSiparisSevkiyatGuncelleBody):
    tid = (body.talep_id or "").strip()
    sevk_sid = (body.hedef_depo_sube_id or body.sevkiyat_sube_id or "").strip()
    if not tid or not sevk_sid:
        raise HTTPException(400, "talep_id ve hedef_depo_sube_id zorunlu")
    pin = (body.pin or "").strip()
    if pin and (len(pin) != 4 or not pin.isdigit()):
        raise HTTPException(400, "pin 4 haneli sayı olmalı")
    durumlar, bekleyen_var, kismi_var = sevkiyat_kalem_durumlari_normalize(body.kalem_durumlari)
    notu = (body.sevkiyat_notu or body.not_aciklama or "").strip() or None
    with db() as (conn, cur):
        defter_sube = _ops_defter_sube_sevkiyat_hedef(sevk_sid, cur)
        return siparis_sevkiyat_kalem_guncelle_execute(
            cur,
            talep_id=tid,
            hedef_depo_sube_id=sevk_sid,
            durumlar=durumlar,
            bekleyen_var=bekleyen_var,
            kismi_var=kismi_var,
            notu=notu,
            personel_ad=(body.personel_ad or "").strip() or None,
            gonderildi=bool(body.gonderildi),
            defter_sube_id=defter_sube,
        )


class OpsSiparisOzelIslemBody(BaseModel):
    talep_id: str
    islem: str  # katalog | tek_sefer | red
    not_aciklama: Optional[str] = None


@router.post("/siparis/ozel-islem")
def ops_siparis_ozel_islem(body: OpsSiparisOzelIslemBody):
    """
    bekliyor talep için:
    - katalog: ürünü kataloga ekle, talep onaylandi
    - tek_sefer: kataloga eklemeden siparis_talep satırı (tek seferlik sipariş)
    - red: reddedildi
    """
    tid = (body.talep_id or "").strip()
    islem = (body.islem or "").strip().lower()
    if islem not in ("katalog", "tek_sefer", "red"):
        raise HTTPException(400, "islem: katalog | tek_sefer | red")
    notu = (body.not_aciklama or "").strip() or None

    with db() as (conn, cur):
        cur.execute(
            "SELECT * FROM siparis_ozel_talep WHERE id=%s FOR UPDATE",
            (tid,),
        )
        raw = cur.fetchone()
        if not raw:
            raise HTTPException(404, "Talep bulunamadı")
        rd = dict(raw)
        if (rd.get("durum") or "") != "bekliyor":
            raise HTTPException(409, "Talep artık bekleyen durumda değil")
        sube_id = str(rd["sube_id"])
        saat = dt_now_tr().strftime("%H:%M:%S")
        from operasyon_defter import operasyon_defter_ekle

        if islem == "red":
            cur.execute(
                """
                UPDATE siparis_ozel_talep
                SET durum='reddedildi', islem_ts=NOW(), onaylayan_not=%s
                WHERE id=%s
                """,
                (notu, tid),
            )
            operasyon_defter_ekle(
                cur,
                sube_id,
                "SIPARIS_OZEL_RED",
                f"Özel ürün talebi reddedildi — {rd.get('urun_adi')} (talep={tid})",
                bildirim_saati=saat,
            )
            return {"success": True, "durum": "reddedildi"}

        if islem == "katalog":
            rur = _siparis_urun_insert(cur, str(rd["kategori_kod"]), str(rd["urun_adi"]))
            uid = str(rur["id"])
            audit(cur, "siparis_urun", uid, "OZEL_ONAY_KATALOG")
            cur.execute(
                """
                UPDATE siparis_ozel_talep
                SET durum='onaylandi', olusturulan_urun_id=%s,
                    islem_ts=NOW(), onaylayan_not=%s
                WHERE id=%s
                """,
                (uid, notu, tid),
            )
            operasyon_defter_ekle(
                cur,
                sube_id,
                "SIPARIS_OZEL_KATALOG",
                f"Özel talep kataloga alındı — {rd.get('urun_adi')} → ürün_id={uid}",
                bildirim_saati=saat,
            )
            return {"success": True, "durum": "onaylandi", "urun_id": uid, "urun_ad": rur.get("ad")}

        # tek_sefer
        stid = str(uuid.uuid4())
        adet = max(1, int(rd.get("adet") or 1))
        kalem = [
            {
                "kategori_id": str(rd["kategori_kod"]),
                "urun_id": f"ozel_{tid[:10]}",
                "urun_ad": str(rd["urun_adi"]),
                "adet": adet,
                "ozel_tek_sefer": True,
            }
        ]
        not_st = (
            f"Tek seferlik sipariş (özel talep {tid})"
            + (f" | {notu}" if notu else "")
        )
        cur.execute(
            """
            INSERT INTO siparis_talep
                (id, sube_id, tarih, durum, personel_id, personel_ad, bildirim_saati, not_aciklama, kalemler)
            VALUES (%s, %s, CURRENT_DATE, 'bekliyor', NULL, 'MERKEZ_TEK_SEFER', %s, %s, %s::jsonb)
            """,
            (stid, sube_id, saat, not_st, json.dumps(kalem, ensure_ascii=False)),
        )
        audit(cur, "siparis_talep", stid, "SIPARIS_TEK_SEFER")
        cur.execute(
            """
            UPDATE siparis_ozel_talep
            SET durum='tek_sefer', iliskili_talep_id=%s, islem_ts=NOW(), onaylayan_not=%s
            WHERE id=%s
            """,
            (stid, notu, tid),
        )
        operasyon_defter_ekle(
            cur,
            sube_id,
            "SIPARIS_OZEL_TEK_SEFER",
            f"Özel talep tek seferlik siparişe çevrildi — talep={tid} siparis_talep={stid}",
            bildirim_saati=saat,
        )
    return {"success": True, "durum": "tek_sefer", "siparis_talep_id": stid}


@router.get("/panel-ozet")
def ops_panel_ozet():
    """Operasyon merkezi modül kartları için hafif sayısal özet."""
    bugun = str(bugun_tr())
    with db() as (conn, cur):
        return _ops_panel_ozet_from_cur(cur, bugun)


@router.get("/hub-ozet")
def ops_hub_ozet(skip_alarms: bool = Query(False, description="True ise yalnızca sayılar; alarm satırları atlanır (proxy zaman aşımına karşı).")):
    """Hub sayıları + operasyon alarm satırları (tek istek, panel-ozet ile uyumlu)."""
    bugun = str(bugun_tr())
    log = logging.getLogger(__name__)
    try:
        with db() as (conn, cur):
            try:
                oz = _ops_panel_ozet_from_cur(cur, bugun)
            except Exception:
                log.exception("hub-ozet: panel_ozet_from_cur")
                # Deadlock vb. sonrası txn aborted kalır; rollback olmadan sonraki SQL patlar (InFailedSqlTransaction)
                try:
                    conn.rollback()
                except Exception:
                    pass
                oz = _hub_ozet_fallback_panel()
            if skip_alarms:
                oz["alarm_satirlari"] = []
            else:
                try:
                    oz["alarm_satirlari"] = _hub_alarm_satirlari(cur, ozet=oz)
                except Exception:
                    log.exception("hub-ozet: alarm_satirlari hesaplanamadi")
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                    oz["alarm_satirlari"] = []
            return oz
    except Exception:
        # DATABASE_URL yok, pool hatası veya bağlantı reddi — arayüz tamamen kırılmasın
        log.exception("hub-ozet: veritabani veya kritik hata")
        out = _hub_ozet_fallback_panel()
        out["alarm_satirlari"] = []
        return out


# ══════════════════════════════════════════════════════════════════
# STOK DİSİPLİN MOTORU v2  —  /ops/v2/...
# ══════════════════════════════════════════════════════════════════
from operasyon_stok_motor import (
    siparis_olustu_kaydet,
    merkez_tahsis_yap,
    sevk_cikti_kaydet,
    sube_kabul_kaydet,
    kullanim_kaydet,
    stok_alarm_kontrol,
    eksik_kullanim_kontrol,
    sube_skor_hesapla,
    tum_subeler_skor_guncelle,
    siparis_akis_ozet,
)


# ── Request modelleri ──────────────────────────────────────────────

class TahsisItem(BaseModel):
    kalem_kodu:  str
    kalem_adi:   str = ""
    talep_adet:  int = 0
    tahsis_adet: int = 0


class TahsisBody(BaseModel):
    tahsis: List[TahsisItem]
    yapan_id: Optional[str] = None
    yapan_ad: Optional[str] = None


class SevkItem(BaseModel):
    kalem_kodu: str
    kalem_adi:  str = ""
    sevk_adet:  int = 0


class SevkBody(BaseModel):
    sevk: List[SevkItem]
    yapan_id: Optional[str] = None
    yapan_ad: Optional[str] = None


class KabulItem(BaseModel):
    kalem_kodu: str
    kalem_adi:  str = ""
    kabul_adet: int = 0


class KabulBody(BaseModel):
    kabul: List[KabulItem]
    yapan_id: Optional[str] = None
    yapan_ad: Optional[str] = None


class KullanimItem(BaseModel):
    kalem_kodu: str
    adet:       int = 0


class KullanimBody(BaseModel):
    kullanim: List[KullanimItem]
    yapan_id: Optional[str] = None
    yapan_ad: Optional[str] = None


class MerkezDepoGuncelle(BaseModel):
    kalem_kodu:  str
    kalem_adi:   str = ""
    mevcut_adet: int = 0
    min_stok:    int = 0


# ── Aşama 2: Merkez tahsis ────────────────────────────────────────

@router.post("/v2/siparis/{siparis_id}/tahsis")
def ops_v2_tahsis(siparis_id: str, body: TahsisBody):
    """
    Merkez siparişi tahsis eder. Her kalem için talep_adet ve tahsis_adet girilir.
    Sistem TAHSIS_TAM / KISMI / YOK kararını verir ve merkez deposunda rezerv ayırır.
    """
    with db() as (conn, cur):
        sonuc = merkez_tahsis_yap(
            cur, siparis_id,
            [t.model_dump() for t in body.tahsis],
            body.yapan_id, body.yapan_ad,
        )
        conn.commit()
    return sonuc


# ── Aşama 3: Sevk çıktı ───────────────────────────────────────────

@router.post("/v2/siparis/{siparis_id}/sevk-cikti")
def ops_v2_sevk_cikti(siparis_id: str, body: SevkBody):
    """
    Merkez depodan ürün çıktı, yola girdi.
    Merkez stoğu azalır, stok_yolda kaydı açılır.
    """
    with db() as (conn, cur):
        yolda_ids = sevk_cikti_kaydet(
            cur, siparis_id,
            [s.model_dump() for s in body.sevk],
            body.yapan_id, body.yapan_ad,
        )
        conn.commit()
    return {"success": True, "yolda_ids": yolda_ids}


# ── Aşama 4: Şube kabul ───────────────────────────────────────────

@router.post("/v2/siparis/{siparis_id}/kabul")
def ops_v2_kabul(siparis_id: str, body: KabulBody):
    """
    Şube teslim aldı ve onayladı. Şube deposu artar.
    Eksik teslimatta KABUL_FARKI davranış uyarısı üretilir.
    """
    with db() as (conn, cur):
        cur.execute("SELECT sube_id FROM siparis_talep WHERE id=%s", (siparis_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Sipariş bulunamadı")
        sube_id = row.get("sube_id") or row[0]
        sonuc = sube_kabul_kaydet(
            cur, siparis_id, sube_id,
            [k.model_dump() for k in body.kabul],
            body.yapan_id, body.yapan_ad,
        )
        conn.commit()
    return sonuc


# ── Aşama 5: Kullanım (bara açılan) ──────────────────────────────

@router.post("/v2/sube/{sube_id}/kullanim")
def ops_v2_kullanim(sube_id: str, body: KullanimBody):
    """
    Personel depodan bara ürün açtı. Şube depo stoğu azalır.
    """
    with db() as (conn, cur):
        kullanim_kaydet(
            cur, sube_id,
            [k.model_dump() for k in body.kullanim],
            body.yapan_id, body.yapan_ad,
        )
        conn.commit()
    return {"success": True}


# ── Panel: Kritik Stok ────────────────────────────────────────────

@router.get("/v2/kritik-stok")
def ops_v2_kritik_stok():
    """
    Merkez + tüm şube depolarında kritik stok alarmları.
    Seviye: KRİZ (0 adet) | KRİTİK (1 adet) | DÜŞÜK (≤ min_stok)
    """
    with db() as (conn, cur):
        alarmlar = stok_alarm_kontrol(cur)
        # Bekleyen sipariş sayısı (hangi şubeler sipariş açmış)
        cur.execute("""
            SELECT sube_id, COUNT(*) as adet
            FROM siparis_talep
            WHERE durum IN ('bekliyor','onaylandi')
            GROUP BY sube_id
        """)
        bekleyen = {r.get("sube_id"): int(r.get("adet") or 0) for r in cur.fetchall()}
    # Alarmlara bekleyen sipariş sayısı ekle
    for a in alarmlar:
        a["bekleyen_siparis"] = bekleyen.get(a.get("sube_id"), 0)
    return {"alarmlar": alarmlar, "toplam": len(alarmlar)}


# ── Panel: Sipariş Akışı ──────────────────────────────────────────

@router.get("/v2/siparis-akis")
def ops_v2_siparis_akis(limit: int = Query(50, ge=1, le=200)):
    """
    Son N siparişin uçtan uca durumu.
    Şube | Ürünler | Talep | Tahsis | Sevk | Kabul | Durum
    """
    with db() as (conn, cur):
        akis = siparis_akis_ozet(cur, limit)
    return {"siparis_akis": akis, "toplam": len(akis)}


# ── Panel: Sipariş Timeline ───────────────────────────────────────

@router.get("/v2/siparis/{siparis_id}/timeline")
def ops_v2_siparis_timeline(siparis_id: str):
    """
    Tek siparişin olay zinciri: ne zaman oluştu, tahsis, sevk, kabul.
    """
    with db() as (conn, cur):
        cur.execute("SELECT * FROM siparis_talep WHERE id=%s", (siparis_id,))
        talep = cur.fetchone()
        if not talep:
            raise HTTPException(404, "Sipariş bulunamadı")

        # Olay logu: operasyon_defter'dan ref_event_id ile oku
        cur.execute("""
            SELECT etiket AS olay, personel_ad AS yapan_ad, aciklama AS detay, olay_ts AS olusturma
            FROM operasyon_defter
            WHERE ref_event_id=%s
            ORDER BY olay_ts ASC
        """, (siparis_id,))
        olaylar = []
        for r in cur.fetchall():
            olaylar.append({
                "olay":     r.get("olay"),
                "yapan_ad": r.get("yapan_ad"),
                "detay":    r.get("detay"),
                "zaman":    str(r.get("olusturma") or ""),
            })

        # Tahsis kararı: siparis_talep.kalem_durumlari JSONB'den oku
        kd_raw = talep.get("kalem_durumlari") or []
        if isinstance(kd_raw, str):
            try:
                kd_raw = json.loads(kd_raw)
            except Exception:
                kd_raw = []
        tahsis = kd_raw if isinstance(kd_raw, list) else []

        cur.execute("""
            SELECT kalem_kodu, kalem_adi, sevk_adet, kabul_adet, durum
            FROM stok_yolda WHERE siparis_talep_id=%s
        """, (siparis_id,))
        yolda = [dict(r) for r in cur.fetchall()]

    kalemler = talep.get("kalemler") or []
    if isinstance(kalemler, str):
        try:
            kalemler = json.loads(kalemler)
        except Exception:
            kalemler = []

    return {
        "siparis_id": siparis_id,
        "sube_id":    talep.get("sube_id"),
        "tarih":      str(talep.get("tarih") or ""),
        "durum":      talep.get("durum"),
        "kalemler":   kalemler,
        "tahsis":     tahsis,
        "yolda":      yolda,
        "olaylar":    olaylar,
    }


# ── Panel: Şube Davranış ─────────────────────────────────────────

@router.get("/v2/sube-davranis")
def ops_v2_sube_davranis(gun: int = Query(30, ge=7, le=90)):
    """
    Son N günde tüm şubelerin davranış ihlalleri ve skorları.
    """
    with db() as (conn, cur):
        cur.execute("""
            SELECT
                d.sube_id, s.ad AS sube_adi,
                d.kural, COUNT(*) AS ihlal_sayisi, SUM(d.puan) AS toplam_puan
            FROM sube_operasyon_uyari d
            JOIN subeler s ON s.id = d.sube_id
            WHERE d.tip = 'DAVRANIS'
              AND d.olusturma >= CURRENT_DATE - (%s * INTERVAL '1 day')
            GROUP BY d.sube_id, s.ad, d.kural
            ORDER BY toplam_puan DESC, s.ad
        """, (gun,))
        rows = cur.fetchall() or []

        # Şube bazında grupla
        subeler: Dict[str, Any] = {}
        for r in rows:
            sid = r.get("sube_id")
            if sid not in subeler:
                subeler[sid] = {
                    "sube_id":    sid,
                    "sube_adi":   r.get("sube_adi"),
                    "toplam_puan": 0,
                    "ihlaller":   [],
                }
            puan = int(r.get("toplam_puan") or 0)
            subeler[sid]["toplam_puan"] += puan
            subeler[sid]["ihlaller"].append({
                "kural":        r.get("kural"),
                "ihlal_sayisi": int(r.get("ihlal_sayisi") or 0),
                "puan":         puan,
            })

        # Skor durumu ekle
        for sid, v in subeler.items():
            p = v["toplam_puan"]
            v["durum"] = "normal" if p < 4 else ("dikkat" if p < 7 else "problemli")

        # Güncel skor tablosundan da al
        cur.execute("""
            SELECT sube_id, toplam_puan, durum, detay
            FROM sube_skor
            WHERE yil = EXTRACT(YEAR FROM CURRENT_DATE)
              AND ay  = EXTRACT(MONTH FROM CURRENT_DATE)
        """)
        for r in cur.fetchall():
            sid = r.get("sube_id")
            if sid in subeler:
                subeler[sid]["skor_bu_ay"] = {
                    "toplam_puan": int(r.get("toplam_puan") or 0),
                    "durum":       r.get("durum"),
                }

    liste = sorted(subeler.values(), key=lambda x: x["toplam_puan"], reverse=True)
    return {"subeler": liste, "gun": gun, "toplam_sube": len(liste)}


# ── Panel: Skor tablosu ──────────────────────────────────────────

@router.get("/v2/sube-skor")
def ops_v2_sube_skor(yil: Optional[int] = None, ay: Optional[int] = None):
    """
    Tüm şubelerin skor tablosu (bu ay veya belirtilen dönem).
    """
    from datetime import date as _date
    bugun = _date.today()
    yil = yil or bugun.year
    ay  = ay  or bugun.month

    with db() as (conn, cur):
        # Önce güncel hesapla
        tum_subeler_skor_guncelle(cur)
        conn.commit()

        cur.execute("""
            SELECT ss.sube_id, s.ad AS sube_adi,
                   ss.toplam_puan, ss.durum, ss.detay, ss.guncelleme
            FROM sube_skor ss
            JOIN subeler s ON s.id = ss.sube_id
            WHERE ss.yil=%s AND ss.ay=%s
            ORDER BY ss.toplam_puan DESC, s.ad
        """, (yil, ay))
        rows = cur.fetchall() or []

    sonuc = []
    for r in rows:
        detay = r.get("detay") or {}
        if isinstance(detay, str):
            try:
                detay = json.loads(detay)
            except Exception:
                detay = {}
        sonuc.append({
            "sube_id":    r.get("sube_id"),
            "sube_adi":   r.get("sube_adi"),
            "toplam_puan": int(r.get("toplam_puan") or 0),
            "durum":      r.get("durum"),
            "detay":      detay,
        })

    return {"skorlar": sonuc, "yil": yil, "ay": ay}


# ── Merkez depo stok yönetimi ─────────────────────────────────────

@router.get("/v2/merkez-depo")
def ops_v2_merkez_depo():
    """Merkez depo anlık stok listesi."""
    with db() as (conn, cur):
        cur.execute("""
            SELECT kalem_kodu, kalem_adi,
                   COALESCE(mevcut_adet, 0)  AS mevcut_adet,
                   COALESCE(rezerve_adet, 0) AS rezerve_adet,
                   COALESCE(min_stok, 0)     AS min_stok,
                   guncelleme
            FROM merkez_stok_kart
            ORDER BY kalem_adi
        """)
        rows = [dict(r) for r in cur.fetchall()]
    return {"stok": rows, "toplam": len(rows)}


@router.post("/v2/merkez-depo/guncelle")
def ops_v2_merkez_depo_guncelle(body: MerkezDepoGuncelle):
    """Merkez depo stok girişi / düzeltme."""
    with db() as (conn, cur):
        cur.execute(
            """
            INSERT INTO merkez_stok_kart (kalem_kodu, kalem_adi, mevcut_adet, min_stok)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (kalem_kodu) DO UPDATE
            SET kalem_adi   = EXCLUDED.kalem_adi,
                mevcut_adet = EXCLUDED.mevcut_adet,
                min_stok    = EXCLUDED.min_stok,
                guncelleme  = NOW()
            """,
            (body.kalem_kodu, body.kalem_adi or body.kalem_kodu,
             body.mevcut_adet, body.min_stok),
        )
        conn.commit()
    return {"success": True}


# ── Şube depo görüntüle ───────────────────────────────────────────

@router.get("/v2/sube/{sube_id}/depo")
def ops_v2_sube_depo(sube_id: str):
    """Şubenin depo stok listesi."""
    with db() as (conn, cur):
        cur.execute("""
            SELECT kalem_kodu, kalem_adi, mevcut_adet, min_stok, guncelleme
            FROM sube_depo_stok
            WHERE sube_id=%s
            ORDER BY kalem_adi
        """, (sube_id,))
        rows = [dict(r) for r in cur.fetchall()]
        # Alarm var mı?
        alarmlar = [r for r in rows if r["mevcut_adet"] <= r["min_stok"]]
    return {"sube_id": sube_id, "stok": rows, "alarm_sayisi": len(alarmlar)}


# ── Sipariş Kuyruğu: bekleyen siparişler + stok etki bilgisi ─────

@router.get("/v2/bekleyen-siparisler")
def ops_v2_bekleyen_siparisler(gun: int = Query(7, ge=1, le=30)):
    """
    Merkez paneli için bekleyen sipariş kuyruğu.
    Her sipariş için:
      - Şubenin deposunda bu ürün var mı? (sube_depo_stok)
      - Gönderirsek merkezde ne kalır? (merkez_stok_kart)
      - Davranış uyarısı tetiklendi mi? (sube_operasyon_uyari)
    """
    with db() as (conn, cur):
        cur.execute("""
            SELECT st.id, st.sube_id, s.ad AS sube_adi,
                   st.tarih, st.olusturma, st.personel_ad,
                   st.not_aciklama, st.kalemler,
                   COALESCE(st.hedef_depo_sube_id, st.sevkiyat_sube_id) AS hedef_depo_sube_id,
                   st.tahsis_kaynak_depo_sube_id,
                   NULLIF(TRIM(st.operasyon_yonlendirme_talimati), '') AS operasyon_yonlendirme_talimati
            FROM siparis_talep st
            JOIN subeler s ON s.id = st.sube_id
            WHERE st.durum = 'bekliyor'
              AND st.tarih >= CURRENT_DATE - (%s * INTERVAL '1 day')
            ORDER BY st.olusturma ASC NULLS LAST, st.id
        """, (gun,))
        talepler = cur.fetchall() or []
        merkez_map = merkez_stok_kart_haritasi(cur)

        sonuc = []
        for talep in talepler:
            tid = talep.get("id")
            sube_id = talep.get("sube_id")
            kalemler = talep.get("kalemler") or []
            if isinstance(kalemler, str):
                try:
                    kalemler = json.loads(kalemler)
                except Exception:
                    kalemler = []
            if not isinstance(kalemler, list):
                kalemler = []

            hedef_v2 = str(talep.get("hedef_depo_sube_id") or "").strip() or None
            fl = enrich_siparis_kalemleri_stok_inplace(
                cur,
                str(sube_id or ""),
                kalemler,
                merkez_map=merkez_map,
                hedef_depo_sube_id=hedef_v2,
            )

            cur.execute("""
                SELECT kural, mesaj, puan
                FROM sube_operasyon_uyari
                WHERE siparis_talep_id=%s AND tip='DAVRANIS'
                ORDER BY puan DESC
            """, (tid,))
            davranis = [
                {"kural": r.get("kural"), "mesaj": r.get("mesaj"), "puan": int(r.get("puan") or 0)}
                for r in cur.fetchall()
            ]

            kalem_detay: List[Dict[str, Any]] = []
            for it in kalemler:
                if not isinstance(it, dict):
                    continue
                kk = str(it.get("kalem_kodu") or "").strip()
                urun_ad = str(it.get("urun_ad") or kk or "")
                ist = max(0, int(it.get("adet") or 0))
                kalem_detay.append({
                    "kalem_kodu": kk,
                    "urun_ad": urun_ad,
                    "istenen_adet": ist,
                    "merkez_mevcut": int(it.get("merkez_mevcut", -1)),
                    "merkez_rezerve": int(it.get("merkez_rezerve") or 0),
                    "merkez_min_stok": int(it.get("merkez_min_stok") or 0),
                    "kaynak_kullanilabilir": it.get("kaynak_kullanilabilir"),
                    "kalan_gonderince": it.get("kalan_gonderince"),
                    "alarm_merkez": bool(it.get("alarm_merkez")),
                    "merkez_barem_risk": bool(it.get("merkez_barem_risk")),
                    "sube_depo_mevcut": int(it.get("sube_depo_mevcut") or 0),
                    "sube_zaten_var": bool(it.get("sube_zaten_var")),
                    "gonderim_kaynagi": it.get("gonderim_kaynagi"),
                    "hedef_depo_mevcut": it.get("hedef_depo_mevcut"),
                    "hedef_depo_rezerve": it.get("hedef_depo_rezerve"),
                    "hedef_depo_min_stok": it.get("hedef_depo_min_stok"),
                })

            cn_v2 = siparis_cift_gonderim_bilgi_notu(
                cur,
                talep_id=str(tid),
                sube_id=str(sube_id or ""),
                kalemler=kalemler,
                olusturma=talep.get("olusturma"),
            )
            row_v2: Dict[str, Any] = {
                "id": tid,
                "sube_id": sube_id,
                "sube_adi": talep.get("sube_adi"),
                "tarih": str(talep.get("tarih") or ""),
                "olusturma": str(talep.get("olusturma") or ""),
                "personel_ad": talep.get("personel_ad"),
                "not_aciklama": talep.get("not_aciklama"),
                "kalemler": kalem_detay,
                "davranis_uyarilari": davranis,
                "stok_alarm_var": fl["stok_alarm_var"],
                "barem_risk_var": fl["barem_risk_var"],
                "gereksiz_var": fl["gereksiz_var"],
                "merkez_kayit_eksik_var": fl["merkez_kayit_eksik_var"],
                "uyari_var": (
                    len(davranis) > 0
                    or fl["barem_risk_var"]
                    or fl["merkez_kayit_eksik_var"]
                    or fl["stok_alarm_var"]
                    or fl["gereksiz_var"]
                ),
                "stok_hesap_kaynagi": fl.get("stok_hesap_kaynagi"),
                "hedef_depo_sube_id": fl.get("hedef_depo_sube_id"),
                "operasyon_yonlendirme_talimati": talep.get("operasyon_yonlendirme_talimati"),
                "tahsis_kaynak_depo_sube_id": talep.get("tahsis_kaynak_depo_sube_id"),
            }
            if cn_v2:
                row_v2["cift_siparis_bilgi_notu"] = cn_v2
                row_v2["uyari_var"] = True
            sonuc.append(row_v2)

    return {"siparisler": sonuc, "toplam": len(sonuc)}
