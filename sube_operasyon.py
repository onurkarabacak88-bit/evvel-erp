"""
Şube operasyon olay motoru (ACILIS / KONTROL / CIKIS / KAPANIS).
Ödeme onay kuyruğundan bağımsız; /api/sube-panel prefix ile ana panel API'sine paralel.
"""
from __future__ import annotations

import json
import secrets
import uuid
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db
from kasa_service import audit, onay_ekle
from vardiya_v2 import sube_gun_acilis_vardiya_plan, sube_gun_kapanis_vardiya_plan
from tr_saat import (
    bugun_tr,
    dt_format_api_tr,
    dt_now_tr as _display_now_tr,
    dt_now_tr_naive,
    is_gunu_tr,
    tr_acilis_tamam_saat_uygun_mu,
    tr_kapanis_son_teslim_ts,
)

router = APIRouter(prefix="/api/sube-panel", tags=["sube-operasyon"])

ACILIS_TOLERANS_DK = 10
# KONTROL: açılış sonrası sabit saat yok — rastgele gecikme + rastgele cevap penceresi; tamamlamada yalnızca kasa sayımı + PIN.
CIKIS_TOLERANS_DK = 5


def _sube_getir(cur, sube_id: str) -> dict:
    cur.execute("SELECT * FROM subeler WHERE id=%s AND aktif=TRUE", (sube_id,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Şube bulunamadı")
    return dict(row)


def _parse_hhmm(s: str) -> tuple[int, int]:
    p = (s or "09:00").strip().split(":")
    h = int(p[0])
    m = int(p[1]) if len(p) > 1 else 0
    return h, m


def _dt(d: date, hhmm: str) -> datetime:
    h, m = _parse_hhmm(hhmm)
    return datetime(d.year, d.month, d.day, h, m, 0)


def _row_event(r) -> dict:
    d = dict(r)
    for k in (
        "sistem_slot_ts",
        "son_teslim_ts",
        "cevap_ts",
        "olusturma",
    ):
        v = d.get(k)
        if v is not None:
            if isinstance(v, datetime):
                d[k] = dt_format_api_tr(v)
            else:
                d[k] = str(v)
    for k in (
        "kasa_sayim",
        "teslim",
        "devir",
        "snap_nakit",
        "snap_pos",
        "snap_online",
    ):
        if d.get(k) is not None:
            d[k] = float(d[k])
    if d.get("tarih"):
        d["tarih"] = str(d["tarih"])
    raw_meta = d.get("meta")
    if raw_meta is not None and raw_meta != "":
        if isinstance(raw_meta, dict):
            d["meta"] = raw_meta
        else:
            try:
                d["meta"] = json.loads(str(raw_meta))
            except Exception:
                d["meta"] = {}
    else:
        d["meta"] = {}
    return d


def _ensure_events(cur, sube_id: str, sube: dict) -> None:
    d = is_gunu_tr()   # gece 00:00–02:00 → önceki iş günü (kapanış 02:00'a kadar aynı gün sayılır)
    acilis_t = sube.get("acilis_saati") or "09:00"
    kapanis_t = sube.get("kapanis_saati") or "22:00"
    vp_ac = sube_gun_acilis_vardiya_plan(cur, sube_id, d)
    vp_kap = sube_gun_kapanis_vardiya_plan(cur, sube_id, d)
    slot_ac = vp_ac["sistem_slot_dt"] if vp_ac else _dt(d, acilis_t)
    slot_kap = vp_kap["sistem_slot_dt"] if vp_kap else _dt(d, kapanis_t)

    cur.execute(
        """
        SELECT 1 FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=%s AND tip='ACILIS' AND sira_no=0
        """,
        (sube_id, d),
    )
    if not cur.fetchone():
        eid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO sube_operasyon_event
                (id, sube_id, tarih, tip, sira_no, sistem_slot_ts, son_teslim_ts, durum)
            VALUES (%s, %s, %s, 'ACILIS', 0, %s, %s, 'bekliyor')
            """,
            (
                eid,
                sube_id,
                d,
                slot_ac,
                slot_ac + timedelta(minutes=ACILIS_TOLERANS_DK),
            ),
        )

    cur.execute(
        """
        SELECT 1 FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=%s AND tip='KAPANIS' AND sira_no=0
        """,
        (sube_id, d),
    )
    if not cur.fetchone():
        eid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO sube_operasyon_event
                (id, sube_id, tarih, tip, sira_no, sistem_slot_ts, son_teslim_ts, durum)
            VALUES (%s, %s, %s, 'KAPANIS', 0, %s, %s, 'bekliyor')
            """,
            (
                eid,
                sube_id,
                d,
                slot_kap,
                tr_kapanis_son_teslim_ts(d),
            ),
        )

    if vp_ac:
        cur.execute(
            """
            UPDATE sube_operasyon_event
            SET sistem_slot_ts=%s, son_teslim_ts=%s
            WHERE sube_id=%s AND tarih=%s AND tip='ACILIS' AND sira_no=0
              AND durum IN ('bekliyor', 'gecikti')
            """,
            (
                slot_ac,
                slot_ac + timedelta(minutes=ACILIS_TOLERANS_DK),
                sube_id,
                d,
            ),
        )

    if vp_kap:
        cur.execute(
            """
            UPDATE sube_operasyon_event
            SET sistem_slot_ts=%s
            WHERE sube_id=%s AND tarih=%s AND tip='KAPANIS' AND sira_no=0
              AND durum IN ('bekliyor', 'gecikti')
            """,
            (slot_kap, sube_id, d),
        )

    cur.execute(
        """
        UPDATE sube_operasyon_event
        SET son_teslim_ts=%s
        WHERE sube_id=%s AND tarih=%s AND tip='KAPANIS' AND sira_no=0
          AND durum IN ('bekliyor', 'gecikti')
        """,
        (tr_kapanis_son_teslim_ts(d), sube_id, d),
    )

    # KONTROL: yalnızca bugün ACILIS tamamlandıktan sonra oluşturulur (_sync_kontrol_slot_after_acilis)


def _sync_kontrol_slot_after_acilis(cur, sube_id: str) -> None:
    """ACILIS tamamlandıysa tek bir KONTROL satırı oluşturur.

    - Başlama zamanı sabit değildir: açılış cevabından sonra 60–180 dk arası rastgele.
    - Cevap penceresi 18–55 dk arası rastgele.
    - meta.denetim_mod: her zaman kasa_only (yalnızca kasa sayımı + PIN).
    Mevcut bekleyen satırın slotunu güncellemez (tahmin edilebilir kaymayı önler).
    """
    cur.execute(
        """
        SELECT cevap_ts FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND tip='ACILIS' AND durum='tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST
        LIMIT 1
        """,
        (sube_id,),
    )
    ra = cur.fetchone()
    if not ra or not ra.get("cevap_ts"):
        return
    ac_cevap = ra["cevap_ts"]
    cur.execute(
        """
        SELECT id, durum FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND tip='KONTROL' AND sira_no=1
        LIMIT 1
        """,
        (sube_id,),
    )
    rk = cur.fetchone()
    if rk:
        return
    delay_min = secrets.randbelow(121) + 60  # 60–180 dk (min 1 saat)
    pencere_min = secrets.randbelow(38) + 18  # 18–55
    slot = ac_cevap + timedelta(minutes=delay_min)
    deadline = slot + timedelta(minutes=pencere_min)
    meta_obj = {
        "denetim_mod": "kasa_only",
        "rastgele_kontrol": True,
        "tetikleyen": "acilis",
        "acilis_sonrasi_dk": delay_min,
        "cevap_penceresi_dk": pencere_min,
    }
    meta_sql = json.dumps(meta_obj, ensure_ascii=False)
    eid = str(uuid.uuid4())
    cur.execute(
        """
        INSERT INTO sube_operasyon_event
            (id, sube_id, tarih, tip, sira_no, sistem_slot_ts, son_teslim_ts, durum, meta)
        VALUES (%s, %s, CURRENT_DATE, 'KONTROL', 1, %s, %s, 'bekliyor', %s)
        """,
        (eid, sube_id, slot, deadline, meta_sql),
    )


def plan_kontrol_after_devir(cur, sube_id: str, devir_ts) -> None:
    """Vardiya devri tamamlanınca 60–120 dk sonrası için ansızın kasa sayımı planlar (sira_no=2)."""
    cur.execute(
        """
        SELECT id FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND tip='KONTROL' AND sira_no=2
        LIMIT 1
        """,
        (sube_id,),
    )
    if cur.fetchone():
        return
    delay_min = secrets.randbelow(61) + 60  # 60–120 dk (min 1 saat)
    pencere_min = secrets.randbelow(38) + 18  # 18–55
    slot = devir_ts + timedelta(minutes=delay_min)
    deadline = slot + timedelta(minutes=pencere_min)
    meta_obj = {
        "denetim_mod": "kasa_only",
        "rastgele_kontrol": True,
        "tetikleyen": "vardiya_devir",
        "devir_sonrasi_dk": delay_min,
        "cevap_penceresi_dk": pencere_min,
    }
    eid = str(uuid.uuid4())
    cur.execute(
        """
        INSERT INTO sube_operasyon_event
            (id, sube_id, tarih, tip, sira_no, sistem_slot_ts, son_teslim_ts, durum, meta)
        VALUES (%s, %s, CURRENT_DATE, 'KONTROL', 2, %s, %s, 'bekliyor', %s)
        """,
        (eid, sube_id, slot, deadline, json.dumps(meta_obj, ensure_ascii=False)),
    )


def _sync_acilis_event_if_acik(cur, sube_id: str) -> None:
    cur.execute(
        """
        SELECT 1 FROM sube_acilis
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='acildi'
        """,
        (sube_id,),
    )
    if not cur.fetchone():
        return
    cur.execute(
        """
        UPDATE sube_operasyon_event
        SET durum='tamamlandi',
            cevap_ts = COALESCE(cevap_ts, NOW())
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND tip='ACILIS'
          AND durum IN ('bekliyor','gecikti')
        """,
        (sube_id,),
    )


def _refresh_durum(cur, sube_id: str) -> None:
    cur.execute(
        """
        UPDATE sube_operasyon_event
        SET durum='gecikti'
        WHERE sube_id=%s AND tarih=CURRENT_DATE
          AND durum='bekliyor'
          AND cevap_ts IS NULL
          AND NOW() > son_teslim_ts
        """,
        (sube_id,),
    )


def _list_events(cur, sube_id: str) -> List[dict]:
    """
    Bugünün operasyon satırları + bir önceki takvim gününden henüz bitmemiş KAPANIS
    (00:00–02:00 arası kasa/kapanış hâlâ önceki iş gününe yazılabilir).
    """
    cur.execute(
        """
        SELECT * FROM sube_operasyon_event
        WHERE sube_id=%s
          AND (
            tarih = CURRENT_DATE
            OR (
              tarih = (CURRENT_DATE - INTERVAL '1 day')::date
              AND tip = 'KAPANIS'
              AND durum IN ('bekliyor', 'gecikti')
            )
          )
        ORDER BY tarih DESC, sistem_slot_ts, tip
        """,
        (sube_id,),
    )
    return [_row_event(r) for r in cur.fetchall()]


def _pick_aktif(rows: List[dict], simdi: datetime) -> Optional[dict]:
    def parse_ts(s: str) -> datetime:
        return datetime.fromisoformat(s.replace(" ", "T"))

    def slot_basladi(e: dict) -> bool:
        """KONTROL/KAPANIS + ACILIS: vardiya planındaki slot saatine kadar zorunlu adım açılmaz."""
        slot = parse_ts(e["sistem_slot_ts"])
        return simdi >= slot

    cands: List[dict] = []
    pending_all: List[dict] = []
    for e in rows:
        if e["durum"] not in ("bekliyor", "gecikti"):
            continue
        pending_all.append(e)
        slot = parse_ts(e["sistem_slot_ts"])
        if simdi < slot:
            continue
        cands.append(e)
    if not cands:
        # Slotu henüz gelmemiş olaylar (ACILIS dahil) için zorunlu overlay açılmasın.
        # Sadece slotu gelmiş ama cands dışı kalan (öncelik) durumunda erken kuyruk.
        if not pending_all:
            return None
        erken = [e for e in pending_all if slot_basladi(e)]
        if not erken:
            return None
        erken.sort(key=lambda x: parse_ts(x["sistem_slot_ts"]))
        return erken[0]
    cands.sort(
        key=lambda x: (
            0 if x["durum"] == "gecikti" else 1,
            parse_ts(x["son_teslim_ts"]),
        )
    )
    return cands[0]


def build_panel_operasyon_blob(cur, sube_id: str, sube: dict) -> Dict[str, Any]:
    _ensure_events(cur, sube_id, sube)
    _sync_acilis_event_if_acik(cur, sube_id)
    _sync_kontrol_slot_after_acilis(cur, sube_id)
    _refresh_durum(cur, sube_id)
    simdi = dt_now_tr_naive()
    simdi_display = _display_now_tr()
    rows = _list_events(cur, sube_id)
    aktif = _pick_aktif(rows, simdi)
    out = {
        "sunucu_saati": simdi_display.strftime("%H:%M:%S"),
        "sunucu_iso": simdi_display.isoformat(timespec="seconds"),
        "events": rows,
        "aktif": aktif,
        "esikler": {"suphe": 5, "kritik": 10},
    }
    if aktif:
        st = datetime.fromisoformat(aktif["sistem_slot_ts"].replace(" ", "T"))
        dk = max(0, int((simdi - st).total_seconds() // 60))
        out["aktif_gecikme_dk"] = dk
        out["aktif_kritik"] = aktif["durum"] == "gecikti" and dk >= 10
        out["aktif_suphe"] = aktif["durum"] == "gecikti" and dk >= 5
        from operasyon_kurallar import alarm_politikasi

        out["alarm_politikasi"] = alarm_politikasi(dk, str(aktif.get("durum") or ""))
    return out


class OperasyonTamamla(BaseModel):
    personel_saat: Optional[str] = None
    kasa_sayim: Optional[float] = None
    teslim: Optional[float] = None
    devir: Optional[float] = None
    snap_nakit: Optional[float] = None
    snap_pos: Optional[float] = None
    snap_online: Optional[float] = None
    x_raporu_gonderildi: bool = False
    ciro_gonderim_onay: bool = False
    # KAPANIS — iki ayrı kanal (birbirine karıştırılmaz):
    # 1) X ciro: ciro_nakit / ciro_pos / ciro_online → yalnızca ciro_taslak (+ event meta.x_rapor)
    # 2) Kasa devir/teslim: teslim, devir, kasa_sayim, kasa_kime_teslim → sube_operasyon_event + kasa_teslim tablosu
    ciro_nakit: Optional[float] = None
    ciro_pos: Optional[float] = None
    ciro_online: Optional[float] = None
    kasa_kime_teslim: Optional[str] = None
    personel_id: Optional[str] = None
    pin: Optional[str] = None
    bardak_kucuk: Optional[int] = None
    bardak_buyuk: Optional[int] = None
    bardak_plastik: Optional[int] = None
    su_adet: Optional[int] = None
    redbull_adet: Optional[int] = None
    soda_adet: Optional[int] = None
    cookie_adet: Optional[int] = None
    pasta_adet: Optional[int] = None
    sut_litre: Optional[int] = None
    surup_adet: Optional[int] = None
    kahve_paket: Optional[int] = None
    karton_bardak: Optional[int] = None
    kapak_adet: Optional[int] = None
    pecete_paket: Optional[int] = None
    diger_sarf: Optional[int] = None
    # Bireysel pasta kalemleri
    pasta_porsiyon_sade: Optional[int] = None
    pasta_porsiyon_antep: Optional[int] = None
    pasta_porsiyon_cik: Optional[int] = None
    pasta_mag_cilek: Optional[int] = None
    pasta_mag_lotus: Optional[int] = None
    pasta_buyuk_tart: Optional[int] = None
    pasta_kucuk_tart: Optional[int] = None
    pasta_snickers: Optional[int] = None
    pasta_malaga: Optional[int] = None
    pasta_latte: Optional[int] = None
    pasta_muzlu_rulo: Optional[int] = None
    pasta_cik_rulo: Optional[int] = None
    pasta_meyveli_rulo: Optional[int] = None
    pasta_browni: Optional[int] = None
    pasta_dilim_ss_sade: Optional[int] = None
    pasta_cream_puff: Optional[int] = None
    pasta_kavala: Optional[int] = None
    pasta_cup_limon: Optional[int] = None
    pasta_cup_yerfistik: Optional[int] = None
    pasta_cup_cilek: Optional[int] = None
    pasta_cup_karamel: Optional[int] = None
    pasta_cup_lotus: Optional[int] = None
    pasta_cup_antep: Optional[int] = None
    pasta_cup_hindistan: Optional[int] = None
    pasta_profiterol: Optional[int] = None
    pasta_kare_cik: Optional[int] = None
    pasta_kare_yerfistik: Optional[int] = None
    pasta_kare_karamel: Optional[int] = None
    pasta_kare_limon: Optional[int] = None
    pasta_dilim_sade: Optional[int] = None
    pasta_dilim_antep: Optional[int] = None
    pasta_dilim_cik: Optional[int] = None
    pasta_dilim_yaban: Optional[int] = None


def _insert_acilis_if_needed(cur, sube_id: str, personel_id: Optional[str], aciklama: str) -> None:
    from sube_panel import _bugun_kasa_acildi_mi

    if not _bugun_kasa_acildi_mi(cur, sube_id):
        raise HTTPException(
            403,
            "Önce günlük kasa kilidini şube panelinden PIN ile açmalısınız.",
        )
    pid = (personel_id or "").strip()
    if not pid:
        raise HTTPException(400, "Açılış için personel doğrulaması zorunlu.")
    cur.execute(
        """
        SELECT a.sube_id, COALESCE(s.ad, a.sube_id) AS sube_adi, a.tarih
        FROM sube_acilis a
        LEFT JOIN subeler s ON s.id = a.sube_id
        WHERE a.personel_id=%s AND a.tarih=CURRENT_DATE AND a.durum='acildi' AND a.sube_id<>%s
        LIMIT 1
        """,
        (pid, sube_id),
    )
    diger = cur.fetchone()
    if diger:
        gun = str(diger.get("tarih") or bugun_tr())
        raise HTTPException(
            409,
            (
                f"Bu personel {gun} tarihinde başka şubede açılış yapmış: "
                f"{diger.get('sube_adi') or diger.get('sube_id')}"
            ),
        )
    cur.execute(
        """
        SELECT id FROM sube_acilis
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='acildi'
        """,
        (sube_id,),
    )
    if cur.fetchone():
        return
    aid = str(uuid.uuid4())
    saat_str = _display_now_tr().strftime("%H:%M")
    cur.execute(
        """
        INSERT INTO sube_acilis
            (id, sube_id, tarih, acilis_saati, personel_id, durum, aciklama)
        VALUES (%s, %s, CURRENT_DATE, %s, %s, 'acildi', %s)
        """,
        (aid, sube_id, saat_str, pid, aciklama),
    )
    audit(cur, "sube_acilis", aid, "ACILIS_OPERASYON")


@router.post("/{sube_id}/operasyon/event/{event_id}/tamamla")
def operasyon_tamamla(sube_id: str, event_id: str, body: OperasyonTamamla):
    simdi = dt_now_tr_naive()
    simdi_tr = _display_now_tr()
    with db() as (conn, cur):
        sube = _sube_getir(cur, sube_id)
        cur.execute(
            """
            SELECT * FROM sube_operasyon_event
            WHERE id=%s AND sube_id=%s FOR UPDATE
            """,
            (event_id, sube_id),
        )
        ev = cur.fetchone()
        if not ev:
            raise HTTPException(404, "Olay bulunamadı")
        ev = dict(ev)
        if ev["durum"] == "tamamlandi":
            return {"success": True, "idempotent": True}
        if ev["durum"] not in ("bekliyor", "gecikti"):
            raise HTTPException(400, "Bu olay tamamlanamaz")

        tip = ev["tip"]
        if tip == "ACILIS":
            if not tr_acilis_tamam_saat_uygun_mu(simdi):
                raise HTTPException(
                    400,
                    "Açılış onayı yalnızca 07:00 ve sonrasında yapılabilir.",
                )
            from personel_panel_auth import dogrula_personel_panel_pin

            if body.kasa_sayim is None or body.kasa_sayim < 0:
                raise HTTPException(400, "Açılış için kasa sayımı girilmeli")
            if body.kasa_sayim > 9_999_999:
                raise HTTPException(400, "Kasa sayımı geçersiz: 9.999.999₺ üstü kabul edilmez")
            pid_in = (body.personel_id or "").strip()
            pin = (body.pin or "").replace(" ", "")
            if not pid_in:
                raise HTTPException(400, "Açılış onayı için personel seçilmeli.")
            if len(pin) != 4 or not pin.isdigit():
                raise HTTPException(400, "Açılış için 4 haneli panel PIN gerekli.")
            ku = dogrula_personel_panel_pin(cur, pid_in, pin)
            onay_ad = (ku.get("ad_soyad") or "").strip() or "—"
            pid_panel = str(ku.get("id") or "").strip() or None
            zorunlu_int = (
                ("bardak_kucuk", body.bardak_kucuk),
                ("bardak_buyuk", body.bardak_buyuk),
                ("bardak_plastik", body.bardak_plastik),
                ("su_adet", body.su_adet),
                ("sut_litre", body.sut_litre),
                ("redbull_adet", body.redbull_adet),
                ("soda_adet", body.soda_adet),
                ("cookie_adet", body.cookie_adet),
                ("pasta_adet", body.pasta_adet),
            )
            for ad, deger in zorunlu_int:
                if deger is None:
                    raise HTTPException(400, f"Açılış için {ad} zorunlu")
                if int(deger) < 0:
                    raise HTTPException(400, f"Açılış için {ad} negatif olamaz")
            for ad, deger in (
                ("sut_litre", body.sut_litre),
                ("surup_adet", body.surup_adet),
                ("kahve_paket", body.kahve_paket),
                ("karton_bardak", body.karton_bardak),
                ("kapak_adet", body.kapak_adet),
                ("pecete_paket", body.pecete_paket),
                ("diger_sarf", body.diger_sarf),
            ):
                if deger is not None and int(deger) < 0:
                    raise HTTPException(400, f"Açılış için {ad} negatif olamaz")
            saat_sistem = simdi_tr.strftime("%H:%M:%S")
            from operasyon_stok_motor import PASTA_KEYS as _PK
            _pasta_f = {k: int(getattr(body, k) or 0) for k in _PK}
            stok = {
                "bardak_kucuk": int(body.bardak_kucuk),
                "bardak_buyuk": int(body.bardak_buyuk),
                "bardak_plastik": int(body.bardak_plastik),
                "su_adet": int(body.su_adet),
                "redbull_adet": int(body.redbull_adet),
                "soda_adet": int(body.soda_adet),
                "cookie_adet": int(body.cookie_adet),
                "pasta_adet": max(sum(_pasta_f.values()), int(body.pasta_adet or 0)),
                "sut_litre": int(body.sut_litre or 0),
                "surup_adet": int(body.surup_adet or 0),
                "kahve_paket": int(body.kahve_paket or 0),
                "karton_bardak": int(body.karton_bardak or 0),
                "kapak_adet": int(body.kapak_adet or 0),
                "pecete_paket": int(body.pecete_paket or 0),
                "diger_sarf": int(body.diger_sarf or 0),
                **_pasta_f,
            }
            aciklama_ins = (
                f"Operasyon ACILIS — {onay_ad} — tarih={simdi_tr.strftime('%Y-%m-%d')} saat={saat_sistem} kasa={body.kasa_sayim}"
            )
            _insert_acilis_if_needed(cur, sube_id, pid_panel, aciklama_ins)
            tarih_ev = ev.get("tarih")
            if isinstance(tarih_ev, datetime):
                tarih_ev = tarih_ev.date()
            elif isinstance(tarih_ev, str):
                tarih_ev = date.fromisoformat((tarih_ev or "")[:10])
            elif not isinstance(tarih_ev, date):
                tarih_ev = bugun_tr()
            vp_open = sube_gun_acilis_vardiya_plan(cur, sube_id, tarih_ev)
            plan_pid = str((vp_open or {}).get("plan_personel_id") or "").strip() or None
            plan_pad = str((vp_open or {}).get("plan_personel_ad") or "").strip() or None
            if plan_pid and pid_panel and plan_pid != pid_panel:
                cur.execute(
                    """
                    SELECT 1 FROM sube_operasyon_uyari
                    WHERE sube_id=%s AND tarih=%s AND tip='ACILIS_VARDIYA_PERSONEL'
                    LIMIT 1
                    """,
                    (sube_id, tarih_ev),
                )
                if not cur.fetchone():
                    uidm = str(uuid.uuid4())
                    mpu = (
                        f"Personel uyumsuzluğu: vardiya planında açılış {plan_pad or plan_pid} "
                        f"için; onaylayan: {onay_ad}."
                    )
                    cur.execute(
                        """
                        INSERT INTO sube_operasyon_uyari
                            (
                                id, sube_id, tarih, tip, seviye, beklenen_tl, gercek_tl, fark_tl, mesaj,
                                acilis_personel_id, acilis_personel_ad, kapanis_personel_id, kapanis_personel_ad
                            )
                        VALUES (%s, %s, %s, 'ACILIS_VARDIYA_PERSONEL', 'kritik', NULL, NULL, NULL, %s,
                                %s, %s, NULL, NULL)
                        """,
                        (uidm, sube_id, tarih_ev, mpu, pid_panel, onay_ad),
                    )
            cur.execute(
                """
                UPDATE sube_operasyon_event
                SET durum='tamamlandi', cevap_ts=%s,
                    personel_saat=%s, kasa_sayim=%s, meta=%s,
                    personel_id=%s, personel_ad=%s
                WHERE id=%s
                """,
                (
                    simdi,
                    saat_sistem,
                    body.kasa_sayim,
                    json.dumps({"acilis_stok_sayim": stok, "acilis_tr_ts": simdi_tr.isoformat(timespec="seconds")}, ensure_ascii=False),
                    pid_panel,
                    onay_ad,
                    event_id,
                ),
            )
            audit(cur, "sube_operasyon_event", event_id, "ACILIS_TAMAMLANDI")

            # ── RAPOR CACHE HOOK — açılış sonrası şube özeti güncel kalsın ──
            try:
                from rapor_cache import gunluk_ozet_yenile
                _ev_tarih = ev.get("tarih")
                if isinstance(_ev_tarih, datetime):
                    _ev_tarih = _ev_tarih.date()
                gunluk_ozet_yenile(cur, sube_id, _ev_tarih, kaynak='event_acilis')
            except Exception:
                pass

            from operasyon_defter import operasyon_defter_ekle
            from operasyon_kurallar import beklenen_dunku_kapanis_kasa, tolerans_seviyesi

            bek = beklenen_dunku_kapanis_kasa(cur, sube_id)
            ks = float(body.kasa_sayim or 0)
            if bek is not None:
                fark = round(ks - float(bek), 2)
                if abs(fark) > 0.01:
                    sev = tolerans_seviyesi(fark)
                    kap_pid = None
                    kap_pad = None
                    cur.execute(
                        """
                        SELECT personel_id, personel_ad
                        FROM sube_operasyon_event
                        WHERE sube_id=%s
                          AND tip='KAPANIS'
                          AND durum='tamamlandi'
                          AND tarih=(CURRENT_DATE - INTERVAL '1 day')
                        ORDER BY cevap_ts DESC NULLS LAST, id DESC
                        LIMIT 1
                        """,
                        (sube_id,),
                    )
                    prev_kap = cur.fetchone()
                    if prev_kap:
                        kap_pid = (prev_kap.get("personel_id") or "").strip() or None
                        kap_pad = (prev_kap.get("personel_ad") or "").strip() or None
                    mesaj_kf = (
                        f"Açılış kasası dün devirine göre fark: {fark:+,.2f} TL "
                        f"(beklenen {bek:,.0f}₺ → gerçek {ks:,.0f}₺, {sev})"
                    )
                    # Upsert: aynı gün için tek ACILIS_KASA_FARK (panel + operasyon yolu çakışmasın)
                    cur.execute(
                        "SELECT id FROM sube_operasyon_uyari "
                        "WHERE sube_id=%s AND tarih=CURRENT_DATE AND tip='ACILIS_KASA_FARK' LIMIT 1",
                        (sube_id,),
                    )
                    mevcut_kf = cur.fetchone()
                    if mevcut_kf:
                        cur.execute(
                            """UPDATE sube_operasyon_uyari
                               SET seviye=%s, beklenen_tl=%s, gercek_tl=%s, fark_tl=%s, mesaj=%s,
                                   acilis_personel_id=%s, acilis_personel_ad=%s,
                                   kapanis_personel_id=%s, kapanis_personel_ad=%s,
                                   okundu=FALSE
                               WHERE id=%s""",
                            (sev, bek, ks, fark, mesaj_kf,
                             pid_panel, onay_ad, kap_pid, kap_pad,
                             mevcut_kf["id"]),
                        )
                    else:
                        cur.execute(
                            """
                            INSERT INTO sube_operasyon_uyari
                                (
                                    id, sube_id, tarih, tip, seviye, beklenen_tl, gercek_tl, fark_tl, mesaj,
                                    acilis_personel_id, acilis_personel_ad, kapanis_personel_id, kapanis_personel_ad
                                )
                            VALUES (%s, %s, CURRENT_DATE, 'ACILIS_KASA_FARK', %s, %s, %s, %s, %s, %s, %s, %s, %s)
                            """,
                            (
                                str(uuid.uuid4()),
                                sube_id,
                                sev,
                                bek,
                                ks,
                                fark,
                                mesaj_kf,
                                pid_panel,
                                onay_ad,
                                kap_pid,
                                kap_pad,
                            ),
                        )
            operasyon_defter_ekle(
                cur,
                sube_id,
                "ACILIS_TAMAM",
                (
                    f"Operasyon ACILIS tamamlandı — {onay_ad} — tarih={bugun_tr()} saat={saat_sistem} "
                    f"kasa_sayim={ks} | stok bardak(kucuk/buyuk/plastik)=({stok['bardak_kucuk']}/"
                    f"{stok['bardak_buyuk']}/{stok['bardak_plastik']}) "
                    f"urun(su/sut/redbull/soda/cookie/pasta)=({stok['su_adet']}/{stok['sut_litre']}/{stok['redbull_adet']}/"
                    f"{stok['soda_adet']}/{stok['cookie_adet']}/{stok['pasta_adet']})"
                ),
                event_id,
                personel_id=pid_panel,
                personel_ad=onay_ad,
                bildirim_saati=saat_sistem,
            )

        elif tip == "KONTROL":
            from personel_panel_auth import dogrula_personel_panel_pin

            meta_prev: Dict[str, Any] = {}
            raw_m = ev.get("meta")
            if raw_m:
                if isinstance(raw_m, dict):
                    meta_prev = dict(raw_m)
                else:
                    try:
                        meta_prev = json.loads(str(raw_m))
                    except Exception:
                        meta_prev = {}
            _plan_mod = str(meta_prev.get("denetim_mod") or "").strip() or "legacy_kasa_snap"

            pid_in = (body.personel_id or "").strip()
            pin = (body.pin or "").replace(" ", "")
            if not pid_in or len(pin) != 4 or not pin.isdigit():
                raise HTTPException(400, "Kontrol için personel ve 4 haneli PIN zorunlu")
            ku = dogrula_personel_panel_pin(cur, pid_in, pin)
            onay_ad = (ku.get("ad_soyad") or "").strip() or "—"
            pid_panel = str(ku.get("id") or "").strip() or pid_in
            saat_kayit = simdi_tr.strftime("%H:%M:%S")
            psaat = (body.personel_saat or "").strip() or saat_kayit

            if body.kasa_sayim is None or body.kasa_sayim < 0:
                raise HTTPException(400, "Kontrol için kasa sayımı zorunlu")
            if body.kasa_sayim > 9_999_999:
                raise HTTPException(400, "Kasa sayımı geçersiz: 9.999.999₺ üstü kabul edilmez")
            ks_out = float(body.kasa_sayim)
            sn_out = 0.0
            sp_out = 0.0
            so_out = 0.0

            meta_prev["kontrol_tamam"] = {
                "mod": "kasa_only",
                "plan_mod_arsiv": _plan_mod,
                "saat": saat_kayit,
                "personel_id": pid_panel,
                "personel_ad": onay_ad,
                "bardak": None,
                "kasa_sayim": ks_out,
                "snap": {"nakit": sn_out, "pos": sp_out, "online": so_out},
            }
            meta_sql = json.dumps(meta_prev, ensure_ascii=False)

            cur.execute(
                """
                UPDATE sube_operasyon_event
                SET durum='tamamlandi', cevap_ts=%s,
                    personel_saat=%s, kasa_sayim=%s,
                    snap_nakit=%s, snap_pos=%s, snap_online=%s,
                    meta=%s
                WHERE id=%s
                """,
                (
                    simdi,
                    psaat,
                    ks_out,
                    sn_out,
                    sp_out,
                    so_out,
                    meta_sql,
                    event_id,
                ),
            )
            audit(cur, "sube_operasyon_event", event_id, "KONTROL_TAMAMLANDI")
            from operasyon_defter import operasyon_defter_ekle

            ozet = f"kasa_only kasa={ks_out}"
            operasyon_defter_ekle(
                cur,
                sube_id,
                "KONTROL_TAMAM_PIN",
                f"KONTROL tamamlandı — {onay_ad} — {ozet}",
                event_id,
                personel_id=pid_panel,
                personel_ad=onay_ad,
                bildirim_saati=saat_kayit,
            )

        elif tip == "KAPANIS":
            from operasyon_kurallar import vardiya_devri_bugun_baslamis_mi
            from personel_panel_auth import dogrula_personel_panel_pin
            from sube_kapanis_dual import _upsert_ciro_taslak, vardiya_devri_tamamlandi_mi

            if vardiya_devri_bugun_baslamis_mi(
                cur, sube_id
            ) and not vardiya_devri_tamamlandi_mi(cur, sube_id):
                raise HTTPException(
                    403,
                    "Kapanış için önce vardiya (sabah–akşam) devrinin tamamlanması gerekir.",
                )
            if body.teslim is None or body.teslim < 0:
                raise HTTPException(400, "Kapanış için teslim kasa tutarı girilmeli")
            if not (body.kasa_kime_teslim or "").strip():
                raise HTTPException(400, "Kapanış için kasa kime teslim bilgisi zorunlu")
            if not body.x_raporu_gonderildi:
                raise HTTPException(400, "Kapanış: X raporu gönderildi onayı gerekli.")
            pid_in = (body.personel_id or "").strip()
            pin = (body.pin or "").replace(" ", "")
            if not pid_in:
                raise HTTPException(400, "Kapanış: onaylayan personel seçilmeli.")
            if len(pin) != 4 or not pin.isdigit():
                raise HTTPException(400, "Kapanış: 4 haneli PIN gerekli.")
            ku = dogrula_personel_panel_pin(cur, pid_in, pin)
            onay_ad = (ku.get("ad_soyad") or "").strip() or "—"
            pid_panel = str(ku.get("id") or "").strip() or None
            bildirim_saat = (body.personel_saat or "").strip() or simdi_tr.strftime("%H:%M:%S")

            for ad, deger in (
                ("ciro_nakit", body.ciro_nakit),
                ("ciro_pos", body.ciro_pos),
                ("ciro_online", body.ciro_online),
                ("bardak_kucuk", body.bardak_kucuk),
                ("bardak_buyuk", body.bardak_buyuk),
                ("bardak_plastik", body.bardak_plastik),
                ("su_adet", body.su_adet),
                ("sut_litre", body.sut_litre),
                ("redbull_adet", body.redbull_adet),
                ("soda_adet", body.soda_adet),
                ("cookie_adet", body.cookie_adet),
                ("pasta_adet", body.pasta_adet),
            ):
                if deger is None:
                    raise HTTPException(400, f"Kapanış için {ad} zorunlu")
                if float(deger) < 0:
                    raise HTTPException(400, f"Kapanış için {ad} negatif olamaz")
            for ad, deger in (
                ("sut_litre", body.sut_litre),
                ("surup_adet", body.surup_adet),
                ("kahve_paket", body.kahve_paket),
                ("karton_bardak", body.karton_bardak),
                ("kapak_adet", body.kapak_adet),
                ("pecete_paket", body.pecete_paket),
                ("diger_sarf", body.diger_sarf),
            ):
                if deger is not None and int(deger) < 0:
                    raise HTTPException(400, f"Kapanış için {ad} negatif olamaz")

            cn = float(body.ciro_nakit)
            cp = float(body.ciro_pos)
            co = float(body.ciro_online)
            # Çift sayım kontrolü: tolerans 1 kuruş (eski 50 kuruş hile riskini önler)
            if co > 0.001 and cn > 0.001 and cp > 0.001 and abs(co - (cn + cp)) < 0.01:
                raise HTTPException(
                    400,
                    "Online tutarı nakit ile POS toplamına eşit olamaz — "
                    "online satış yoksa 0 girin; günlük toplamı yalnızca nakit ve POS alanlarına yazın.",
                )
            tarih_ev_ciro = ev.get("tarih")
            if isinstance(tarih_ev_ciro, datetime):
                tarih_ev_ciro = tarih_ev_ciro.date()
            elif isinstance(tarih_ev_ciro, str):
                try:
                    tarih_ev_ciro = date.fromisoformat((tarih_ev_ciro or "")[:10])
                except ValueError:
                    tarih_ev_ciro = is_gunu_tr()
            elif not isinstance(tarih_ev_ciro, date):
                tarih_ev_ciro = is_gunu_tr()
            from operasyon_stok_motor import PASTA_KEYS as _PK2
            _pasta_f2 = {k: int(getattr(body, k) or 0) for k in _PK2}
            k_stok = {
                "bardak_kucuk": int(body.bardak_kucuk),
                "bardak_buyuk": int(body.bardak_buyuk),
                "bardak_plastik": int(body.bardak_plastik),
                "su_adet": int(body.su_adet),
                "redbull_adet": int(body.redbull_adet),
                "soda_adet": int(body.soda_adet),
                "cookie_adet": int(body.cookie_adet),
                "pasta_adet": max(sum(_pasta_f2.values()), int(body.pasta_adet or 0)),
                "sut_litre": int(body.sut_litre or 0),
                "surup_adet": int(body.surup_adet or 0),
                "kahve_paket": int(body.kahve_paket or 0),
                "karton_bardak": int(body.karton_bardak or 0),
                "kapak_adet": int(body.kapak_adet or 0),
                "pecete_paket": int(body.pecete_paket or 0),
                "diger_sarf": int(body.diger_sarf or 0),
                **_pasta_f2,
            }
            _upsert_ciro_taslak(
                cur,
                sube_id,
                cn,
                cp,
                co,
                "Operasyon KAPANIS — X raporu (nakit/POS/online); teslim/devir bu taslağa yazılmaz.",
                personel_id=pid_panel,
                gonderen_ad=onay_ad,
                bildirim_saati=bildirim_saat,
                panel_kullanici_id=None,
                audit_etiket="KAPANIS_TASLAK",
                taslak_tarih=tarih_ev_ciro,
            )
            # ── KÖR SAYIM: kasa_sayim ZORUNLU — panel kullanıcısı beklenen değeri görmeden sayar ──
            # Dünya standardı (Toast / Square / Lightspeed / McDonald's):
            #   Kasiyer kasadaki nakit toplamını fiziksel sayarak girer (kasa_sayim).
            #   Sistem beklenen değeri yalnızca SONRA hesaplar ve farkı operasyon merkezine iletir.
            #   Sayım yapılmadan kapanış gönderilemez — session "open" kalır.
            if body.kasa_sayim is None or body.kasa_sayim < 0:
                raise HTTPException(
                    400,
                    "Kapanış: fiziksel kasa sayımı zorunludur. "
                    "Kasadaki nakit tutarını sayıp girin (kör sayım — beklenen bu aşamada gösterilmez).",
                )
            if body.kasa_sayim > 9_999_999:
                raise HTTPException(400, "Kasa sayımı geçersiz: 9.999.999₺ üstü kabul edilmez")

            # Devir zorunlu — kasiyer kasada bıraktığı tutarı beyan eder
            if body.devir is None or body.devir < 0:
                raise HTTPException(400, "Kapanış: kasada bırakılan devir tutarı zorunludur")
            teslim_f = max(0.0, float(body.teslim or 0))
            devir_kayit = round(float(body.devir), 2)
            # ks = fiziksel sayım (kasa_sayim) — teslim+devir'in toplamına eşit olmak zorunda değil
            # ancak tutarsızsa çapraz kontrol farkı operasyon merkezine gider
            ks = round(float(body.kasa_sayim), 2)
            kasa_kime_teslim = (body.kasa_kime_teslim or "").strip()

            # ── Kasa Mutabakatı (Cash Reconciliation) ──────────────────────────────
            # Formül: Açılış Kasası + Z Nakit Ciro − Nakit Giderler − Teslim − Devir = 0
            #
            # 1. Bugünkü açılış kasa sayımı
            cur.execute(
                """SELECT kasa_sayim FROM sube_operasyon_event
                   WHERE sube_id=%s AND tarih=%s AND tip='ACILIS' AND durum='tamamlandi'
                   ORDER BY cevap_ts DESC NULLS LAST LIMIT 1""",
                (sube_id, tarih_ev_ciro),
            )
            acilis_kasa = float((cur.fetchone() or {}).get("kasa_sayim") or 0)

            # 2. Gün içi nakit giderler — panelden girilen onay_bekliyor dahil (kasadan çıkan nakit)
            cur.execute(
                """SELECT
                       COALESCE(SUM(tutar), 0) AS toplam,
                       COALESCE(SUM(tutar) FILTER (WHERE durum = 'aktif'), 0) AS aktif,
                       COALESCE(SUM(tutar) FILTER (WHERE durum = 'onay_bekliyor'), 0) AS bekleyen
                   FROM anlik_giderler
                   WHERE sube=%s AND tarih=%s
                     AND LOWER(COALESCE(NULLIF(TRIM(odeme_yontemi), ''), 'nakit')) = 'nakit'
                     AND durum IN ('aktif', 'onay_bekliyor')""",
                (sube_id, tarih_ev_ciro),
            )
            _gider_row = cur.fetchone() or {}
            nakit_giderler = float(_gider_row.get("toplam") or 0)
            nakit_giderler_aktif = float(_gider_row.get("aktif") or 0)
            nakit_giderler_bekleyen = float(_gider_row.get("bekleyen") or 0)

            # 3. Gün içi ara teslimler (müdüre kasa_teslim)
            cur.execute(
                """SELECT COALESCE(SUM(tutar), 0) AS ara_toplam
                   FROM kasa_teslim
                   WHERE sube_id=%s AND tarih=%s AND teslim_turu='ara'""",
                (sube_id, tarih_ev_ciro),
            )
            ara_teslim_toplam = float((cur.fetchone() or {}).get("ara_toplam") or 0)

            # 4. Z raporu nakit ciro (kapanışta girilen)
            z_nakit = round(cn, 2)  # body.ciro_nakit

            # 5. Mutabakat hesabı
            # acilis_kasa + z_nakit − giderler − teslim(müdür) − ara_teslim − devir = 0
            mutabakat_fark = round(
                acilis_kasa + z_nakit - nakit_giderler - teslim_f - ara_teslim_toplam - devir_kayit, 2
            )

            # Eski uyumluluk için sistem_beklenen_devir korunuyor (meta'da kullanılıyor)
            sistem_beklenen_devir = round(ks - teslim_f - ara_teslim_toplam, 2)
            kasa_acigi = mutabakat_fark  # yeni formül

            _meta_kapanis = {
                "kapanis_stok_sayim": k_stok,
                "x_rapor": {"nakit": cn, "pos": cp, "online": co},
                "kasa_kime_teslim": kasa_kime_teslim,
                "kasiyer_devir_beyan": devir_kayit,
                "sistem_beklenen_devir": sistem_beklenen_devir,
                "ara_teslim_toplam": ara_teslim_toplam,
                "kasa_acigi": kasa_acigi,
                "mutabakat": {
                    "acilis_kasa": acilis_kasa,
                    "z_nakit": z_nakit,
                    "nakit_giderler": nakit_giderler,
                    "nakit_giderler_aktif": nakit_giderler_aktif,
                    "nakit_giderler_bekleyen": nakit_giderler_bekleyen,
                    "ara_teslim": ara_teslim_toplam,
                    "teslim": teslim_f,
                    "devir": devir_kayit,
                    "fark": mutabakat_fark,
                },
            }

            # KAPANIS_KASA_FARK uyarısı — sadece merkez görür, kasiyer panelinde gösterilmez
            if abs(kasa_acigi) > 0.01:
                from operasyon_kurallar import tolerans_seviyesi
                sev_kf = tolerans_seviyesi(kasa_acigi)
                mesaj_kf = (
                    f"Kasa mutabakat farkı: {kasa_acigi:+,.2f} TL "
                    f"(açılış {acilis_kasa:,.0f}₺ + Z nakit {z_nakit:,.0f}₺"
                    + (f" − gider {nakit_giderler:,.0f}₺" if nakit_giderler > 0 else "")
                    + (f" − ara teslim {ara_teslim_toplam:,.0f}₺" if ara_teslim_toplam > 0 else "")
                    + f" − teslim {teslim_f:,.0f}₺ − devir {devir_kayit:,.0f}₺ = {kasa_acigi:+,.2f}₺)"
                )
                detay_json = json.dumps({
                    "acilis_kasa":    acilis_kasa,
                    "z_nakit":        z_nakit,
                    "nakit_giderler": nakit_giderler,
                    "nakit_giderler_aktif": nakit_giderler_aktif,
                    "nakit_giderler_bekleyen": nakit_giderler_bekleyen,
                    "ara_teslim":     ara_teslim_toplam,
                    "teslim":         teslim_f,
                    "devir":          devir_kayit,
                    "fark":           mutabakat_fark,
                }, ensure_ascii=False)
                cur.execute(
                    "SELECT id FROM sube_operasyon_uyari WHERE sube_id=%s AND tarih=%s AND tip='KAPANIS_KASA_FARK' LIMIT 1",
                    (sube_id, tarih_ev_ciro),
                )
                mevcut_kkf = cur.fetchone()
                if mevcut_kkf:
                    cur.execute(
                        """UPDATE sube_operasyon_uyari
                           SET seviye=%s, beklenen_tl=0, gercek_tl=%s, fark_tl=%s, mesaj=%s,
                               kapanis_personel_id=%s, kapanis_personel_ad=%s,
                               detay_json=%s::jsonb, okundu=FALSE
                           WHERE id=%s""",
                        (sev_kf, mutabakat_fark, kasa_acigi, mesaj_kf,
                         pid_panel, onay_ad, detay_json, mevcut_kkf["id"]),
                    )
                else:
                    cur.execute(
                        """INSERT INTO sube_operasyon_uyari
                           (id, sube_id, tarih, tip, seviye, beklenen_tl, gercek_tl, fark_tl, mesaj,
                            kapanis_personel_id, kapanis_personel_ad, detay_json)
                           VALUES (%s, %s, %s, 'KAPANIS_KASA_FARK', %s, 0, %s, %s, %s, %s, %s, %s::jsonb)""",
                        (str(uuid.uuid4()), sube_id, tarih_ev_ciro,
                         sev_kf, mutabakat_fark, kasa_acigi, mesaj_kf,
                         pid_panel, onay_ad, detay_json),
                    )

                # ── Onay kuyruğuna ekle (idempotent) ──
                try:
                    cur.execute(
                        """SELECT 1 FROM onay_kuyrugu
                           WHERE kaynak_tablo='kasa_farki' AND islem_turu='KAPANIS_KASA_FARK'
                             AND tarih=%s AND aciklama LIKE %s AND durum='bekliyor' LIMIT 1""",
                        (tarih_ev_ciro, f"%{sube_id}%"),
                    )
                    if not cur.fetchone():
                        onay_ekle(
                            cur,
                            "KAPANIS_KASA_FARK",
                            "kasa_farki",
                            str(uuid.uuid4()),
                            f"[{sube_id}] {mesaj_kf}"[:500],
                            kasa_acigi,
                            tarih_ev_ciro,
                        )
                except Exception:
                    pass  # onay_kuyrugu yazımı kritik değil

                # ── Personel risk sinyali ──
                if pid_panel:
                    try:
                        agirlik_kf = 20 if sev_kf == "kritik" else 10
                        cur.execute(
                            """INSERT INTO personel_risk_sinyal
                                   (id, personel_id, sube_id, tarih, sinyal_turu, agirlik, aciklama, referans_id)
                               VALUES (%s, %s, %s, %s::date, 'KAPANIS_KASA_FARK', %s, %s, %s)""",
                            (str(uuid.uuid4()), pid_panel, sube_id, str(tarih_ev_ciro),
                             agirlik_kf, mesaj_kf[:1800], str(sube_id)),
                        )
                    except Exception:
                        pass  # risk sinyal yazımı kritik değil

            cur.execute(
                """
                UPDATE sube_operasyon_event
                SET durum='tamamlandi', cevap_ts=%s,
                    personel_saat=%s, kasa_sayim=%s, teslim=%s, devir=%s,
                    x_raporu_onay=TRUE, ciro_gonderim_onay=TRUE, meta=%s
                WHERE id=%s
                """,
                (
                    simdi,
                    body.personel_saat,
                    ks,
                    body.teslim,
                    devir_kayit,
                    json.dumps(_meta_kapanis, ensure_ascii=False),
                    event_id,
                ),
            )
            audit(cur, "sube_operasyon_event", event_id, "KAPANIS_TAMAMLANDI")

            # ── RAPOR CACHE HOOK — kapanış sonrası şube özeti güncel kalsın ──
            try:
                from rapor_cache import gunluk_ozet_yenile
                gunluk_ozet_yenile(cur, sube_id, tarih_ev_ciro, kaynak='event_kapanis')
            except Exception:
                pass  # cache güncelleme kritik değil — gece batch düzeltir

            # Kasa teslim kaydı otomatik oluştur (gün sonu teslimi)
            if body.teslim is not None and float(body.teslim) > 0:
                try:
                    cur.execute(
                        "SELECT id, ad, unvan FROM kasa_teslim_alici WHERE id=%s AND aktif=TRUE",
                        (kasa_kime_teslim,),
                    )
                    alici_row = cur.fetchone()
                    if alici_row:
                        alici_d = dict(alici_row)
                        alici_ad = alici_d["ad"] + (
                            " — " + alici_d["unvan"] if alici_d.get("unvan") else ""
                        )
                        devir_not = float(devir_kayit or 0)
                        kt_id = str(uuid.uuid4())
                        cur.execute(
                            """INSERT INTO kasa_teslim
                               (id, sube_id, tarih, tutar,
                                teslim_eden_personel_id, teslim_eden_ad,
                                teslim_alan_id, teslim_alan_ad,
                                teslim_turu, aciklama)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'gun_sonu', %s)""",
                            (
                                kt_id, sube_id, tarih_ev_ciro,
                                float(body.teslim),
                                pid_panel, onay_ad,
                                alici_d["id"], alici_ad,
                                f"Kapanış otomatik — devir: {devir_not:.0f}₺",
                            ),
                        )
                except Exception:
                    pass  # Teslim alıcı bulunamazsa sessiz geç

            from operasyon_defter import operasyon_defter_ekle

            defter_satir = (
                f"KAPANIS teslim={body.teslim} devir={devir_kayit} kasa_sayim={ks} | "
                f"kasa_kime_teslim={kasa_kime_teslim} | "
                f"X ciro(nakit,pos,online)=({cn},{cp},{co}) | "
                f"stok bardak(kucuk/buyuk/plastik)=({k_stok['bardak_kucuk']}/{k_stok['bardak_buyuk']}/{k_stok['bardak_plastik']}) "
                f"urun(su/sut/redbull/soda/cookie/pasta)=({k_stok['su_adet']}/{k_stok['sut_litre']}/{k_stok['redbull_adet']}/{k_stok['soda_adet']}/{k_stok['cookie_adet']}/{k_stok['pasta_adet']}) | "
                f"onaylayan={onay_ad} tarih={simdi_tr.strftime('%Y-%m-%d')} saat={bildirim_saat}"
            )
            operasyon_defter_ekle(
                cur,
                sube_id,
                "KAPANIS_TAMAM",
                defter_satir,
                event_id,
                personel_id=pid_panel,
                personel_ad=onay_ad,
                bildirim_saati=bildirim_saat,
            )
            from operasyon_stok_motor import (
                kapanis_stok_uyarilari_yaz,
                sube_operasyon_ozet_yaz,
                satis_anomali_kontrol_yaz,
                fire_tespiti_kontrol_yaz,
                pattern_uyari_kontrol_yaz,
                bugun_acilis_stok,
                sum_urun_ac_bugun,
                STOK_LABEL_TR,
            )

            kapanis_stok_uyarilari_yaz(cur, sube_id, k_stok)
            sube_operasyon_ozet_yaz(cur, sube_id, k_stok)
            satis_anomali_kontrol_yaz(cur, sube_id)
            fire_tespiti_kontrol_yaz(cur, sube_id)
            pattern_uyari_kontrol_yaz(cur, sube_id)
            # Ürün Aç hiç girilmediyse ama kapanışta stok azalmışsa operasyon uyarısı yaz.
            try:
                acilis_stok = bugun_acilis_stok(cur, sube_id) or {}
                urun_ac_toplam = sum_urun_ac_bugun(cur, sube_id) or {}
                urun_ac_sum = sum(max(0, int(urun_ac_toplam.get(k) or 0)) for k in urun_ac_toplam.keys())
                azalanlar: List[str] = []
                if urun_ac_sum <= 0:
                    for k, ac_val in acilis_stok.items():
                        try:
                            ac_n = int(ac_val or 0)
                            kap_n = int(k_stok.get(k) or 0)
                        except Exception:
                            continue
                        if ac_n > kap_n:
                            azalanlar.append(f"{STOK_LABEL_TR.get(k, k)} {ac_n-kap_n}")
                    if azalanlar:
                        msg = (
                            "Bugün Ürün Aç kaydı yok; kapanış sayımında stok düşüşü var: "
                            + ", ".join(azalanlar[:6])
                            + (f" (+{len(azalanlar)-6} kalem)" if len(azalanlar) > 6 else "")
                        )
                        cur.execute(
                            """
                            INSERT INTO sube_operasyon_uyari
                                (id, sube_id, tarih, tip, seviye, mesaj)
                            VALUES (%s, %s, CURRENT_DATE, 'URUN_AC_EKSIK_KAYIT', 'uyari', %s)
                            ON CONFLICT (id) DO NOTHING
                            """,
                            (f"uac-missing:{sube_id}:{bugun_tr()}", sube_id, msg),
                        )
            except Exception:
                pass

        elif tip == "CIKIS":
            if body.kasa_sayim is None or body.kasa_sayim < 0:
                raise HTTPException(400, "Çıkış için kasa sayımı zorunlu")
            if body.kasa_sayim > 9_999_999:
                raise HTTPException(400, "Kasa sayımı geçersiz: 9.999.999₺ üstü kabul edilmez")
            cur.execute(
                """
                UPDATE sube_operasyon_event
                SET durum='tamamlandi', cevap_ts=%s,
                    personel_saat=%s, kasa_sayim=%s
                WHERE id=%s
                """,
                (simdi, body.personel_saat, body.kasa_sayim, event_id),
            )
            audit(cur, "sube_operasyon_event", event_id, "CIKIS_TAMAMLANDI")
            from operasyon_defter import operasyon_defter_ekle

            operasyon_defter_ekle(
                cur,
                sube_id,
                "CIKIS_TAMAM",
                f"CIKIS tamamlandı kasa_sayim={body.kasa_sayim}",
                event_id,
            )
        else:
            raise HTTPException(400, "Bilinmeyen olay tipi")

    return {"success": True, "event_id": event_id}


@router.post("/{sube_id}/operasyon/event/{event_id}/alarm-arttir")
def operasyon_alarm_arttir(sube_id: str, event_id: str):
    """Bekleyen/gecikmiş olay için alarm döngüsü sayacı (şube UI ses/tekrar ile eşleşir)."""
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        cur.execute(
            """
            UPDATE sube_operasyon_event
            SET alarm_sayisi = COALESCE(alarm_sayisi, 0) + 1
            WHERE id=%s AND sube_id=%s AND tarih=CURRENT_DATE
              AND durum IN ('bekliyor', 'gecikti')
            RETURNING alarm_sayisi
            """,
            (event_id, sube_id),
        )
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Olay bulunamadı veya alarm artırılamaz durumda")
        audit(cur, "sube_operasyon_event", event_id, "ALARM_ARTTIR")
    return {"success": True, "alarm_sayisi": int(r["alarm_sayisi"])}


@router.post("/{sube_id}/operasyon/cikis-baslat")
def operasyon_cikis_baslat(sube_id: str):
    """Anlık çıkış olayı (deadline birkaç dakika)."""
    simdi = dt_now_tr_naive()
    with db() as (conn, cur):
        sube = _sube_getir(cur, sube_id)
        blob = build_panel_operasyon_blob(cur, sube_id, sube)
        aktif = blob.get("aktif")
        if aktif and aktif.get("tip") != "CIKIS":
            raise HTTPException(
                403,
                f"Önce bekleyen operasyonu tamamlayın: {aktif.get('tip')}",
            )
        cur.execute(
            """
            SELECT id FROM sube_operasyon_event
            WHERE sube_id=%s AND tarih=CURRENT_DATE AND tip='CIKIS' AND durum IN ('bekliyor','gecikti')
            """,
            (sube_id,),
        )
        if cur.fetchone():
            raise HTTPException(400, "Açık bir çıkış olayı zaten var")
        eid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO sube_operasyon_event
                (id, sube_id, tarih, tip, sira_no, sistem_slot_ts, son_teslim_ts, durum)
            VALUES (%s, %s, CURRENT_DATE, 'CIKIS', 0, %s, %s, 'bekliyor')
            """,
            (
                eid,
                sube_id,
                simdi,
                simdi + timedelta(minutes=CIKIS_TOLERANS_DK),
            ),
        )
        audit(cur, "sube_operasyon_event", eid, "CIKIS_BASLADI")
    return {"success": True, "event_id": eid}


@router.get("/{sube_id}/operasyon/durum")
def operasyon_durum_api(sube_id: str):
    with db() as (conn, cur):
        sube = _sube_getir(cur, sube_id)
        blob = build_panel_operasyon_blob(cur, sube_id, sube)
    return blob
