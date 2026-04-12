"""
Şube operasyon olay motoru (ACILIS / KONTROL / CIKIS / KAPANIS).
Ödeme onay kuyruğundan bağımsız; /api/sube-panel prefix ile ana panel API'sine paralel.
"""
from __future__ import annotations

import hashlib
import uuid
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db
from kasa_service import audit

router = APIRouter(prefix="/api/sube-panel", tags=["sube-operasyon"])

ACILIS_TOLERANS_DK = 10
KONTROL_TOLERANS_DK = 5
KAPANIS_TOLERANS_DK = 15
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
            if hasattr(v, "isoformat"):
                d[k] = v.isoformat(sep=" ", timespec="seconds")
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
    return d


def _ensure_events(cur, sube_id: str, sube: dict) -> None:
    d = date.today()
    acilis_t = sube.get("acilis_saati") or "09:00"
    kapanis_t = sube.get("kapanis_saati") or "22:00"
    slot_ac = _dt(d, acilis_t)
    slot_kap = _dt(d, kapanis_t)

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
                slot_kap + timedelta(minutes=KAPANIS_TOLERANS_DK),
            ),
        )

    cur.execute(
        """
        SELECT 1 FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=%s AND tip='KONTROL' AND sira_no=1
        """,
        (sube_id, d),
    )
    if not cur.fetchone():
        ws = slot_ac + timedelta(hours=2)
        we = slot_kap - timedelta(minutes=90)
        if we <= ws:
            kont_slot = ws + timedelta(minutes=30)
        else:
            span_min = max(1, int((we - ws).total_seconds() // 60))
            h = int(hashlib.md5(f"{sube_id}{d}".encode()).hexdigest()[:8], 16)
            off = h % span_min
            kont_slot = ws + timedelta(minutes=off)
        eid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO sube_operasyon_event
                (id, sube_id, tarih, tip, sira_no, sistem_slot_ts, son_teslim_ts, durum)
            VALUES (%s, %s, %s, 'KONTROL', 1, %s, %s, 'bekliyor')
            """,
            (
                eid,
                sube_id,
                d,
                kont_slot,
                kont_slot + timedelta(minutes=KONTROL_TOLERANS_DK),
            ),
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
    cur.execute(
        """
        SELECT * FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=CURRENT_DATE
        ORDER BY sistem_slot_ts, tip
        """,
        (sube_id,),
    )
    return [_row_event(r) for r in cur.fetchall()]


def _pick_aktif(rows: List[dict], simdi: datetime) -> Optional[dict]:
    def parse_ts(s: str) -> datetime:
        return datetime.fromisoformat(s.replace(" ", "T"))

    cands: List[dict] = []
    for e in rows:
        if e["durum"] not in ("bekliyor", "gecikti"):
            continue
        slot = parse_ts(e["sistem_slot_ts"])
        if simdi < slot:
            continue
        cands.append(e)
    if not cands:
        return None
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
    _refresh_durum(cur, sube_id)
    simdi = datetime.now()
    rows = _list_events(cur, sube_id)
    aktif = _pick_aktif(rows, simdi)
    out = {
        "sunucu_saati": simdi.strftime("%H:%M:%S"),
        "sunucu_iso": simdi.isoformat(sep=" ", timespec="seconds"),
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
    # KAPANIS: merkez ciro taslağı (nakit/POS/online) + PIN ile onaylayan
    ciro_nakit: Optional[float] = None
    ciro_pos: Optional[float] = None
    ciro_online: Optional[float] = None
    personel_id: Optional[str] = None
    pin: Optional[str] = None


def _insert_acilis_if_needed(cur, sube_id: str, personel_id: Optional[str], aciklama: str) -> None:
    from sube_panel import _bugun_kasa_acildi_mi

    if not _bugun_kasa_acildi_mi(cur, sube_id):
        raise HTTPException(
            403,
            "Önce günlük kasa kilidini şube panelinden PIN ile açmalısınız.",
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
    saat_str = datetime.now().strftime("%H:%M")
    cur.execute(
        """
        INSERT INTO sube_acilis
            (id, sube_id, tarih, acilis_saati, personel_id, durum, aciklama)
        VALUES (%s, %s, CURRENT_DATE, %s, %s, 'acildi', %s)
        """,
        (aid, sube_id, saat_str, personel_id, aciklama),
    )
    audit(cur, "sube_acilis", aid, "ACILIS_OPERASYON")


@router.post("/{sube_id}/operasyon/event/{event_id}/tamamla")
def operasyon_tamamla(sube_id: str, event_id: str, body: OperasyonTamamla):
    simdi = datetime.now()
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
            from personel_panel_auth import dogrula_personel_panel_pin

            if body.kasa_sayim is None or body.kasa_sayim < 0:
                raise HTTPException(400, "Açılış için kasa sayımı girilmeli")
            pid_in = (body.personel_id or "").strip()
            pin = (body.pin or "").replace(" ", "")
            if not pid_in:
                raise HTTPException(400, "Açılış onayı için personel seçilmeli.")
            if len(pin) != 4 or not pin.isdigit():
                raise HTTPException(400, "Açılış için 4 haneli panel PIN gerekli.")
            ku = dogrula_personel_panel_pin(cur, pid_in, pin)
            onay_ad = (ku.get("ad_soyad") or "").strip() or "—"
            pid_panel = str(ku.get("id") or "").strip() or None
            saat_sistem = simdi.strftime("%H:%M")
            aciklama_ins = (
                f"Operasyon ACILIS — {onay_ad} — sistem_saati={saat_sistem} kasa={body.kasa_sayim}"
            )
            _insert_acilis_if_needed(cur, sube_id, pid_panel, aciklama_ins)
            cur.execute(
                """
                UPDATE sube_operasyon_event
                SET durum='tamamlandi', cevap_ts=%s,
                    personel_saat=%s, kasa_sayim=%s
                WHERE id=%s
                """,
                (simdi, saat_sistem, body.kasa_sayim, event_id),
            )
            audit(cur, "sube_operasyon_event", event_id, "ACILIS_TAMAMLANDI")
            from operasyon_defter import operasyon_defter_ekle
            from operasyon_kurallar import beklenen_dunku_kapanis_kasa, tolerans_seviyesi

            bek = beklenen_dunku_kapanis_kasa(cur, sube_id)
            ks = float(body.kasa_sayim or 0)
            if bek is not None:
                fark = round(ks - float(bek), 2)
                if abs(fark) > 0.01:
                    sev = tolerans_seviyesi(fark)
                    uid = str(uuid.uuid4())
                    cur.execute(
                        """
                        INSERT INTO sube_operasyon_uyari
                            (id, sube_id, tarih, tip, seviye, beklenen_tl, gercek_tl, fark_tl, mesaj)
                        VALUES (%s, %s, CURRENT_DATE, 'ACILIS_KASA_FARK', %s, %s, %s, %s, %s)
                        """,
                        (
                            uid,
                            sube_id,
                            sev,
                            bek,
                            ks,
                            fark,
                            f"Açılış kasası dün kapanışa göre fark: {fark:,.2f} TL ({sev})",
                        ),
                    )
            operasyon_defter_ekle(
                cur,
                sube_id,
                "ACILIS_TAMAM",
                f"Operasyon ACILIS tamamlandı — {onay_ad} — saat={saat_sistem} kasa_sayim={ks}",
                event_id,
                personel_id=pid_panel,
                personel_ad=onay_ad,
                bildirim_saati=saat_sistem,
            )

        elif tip == "KONTROL":
            if body.kasa_sayim is None or body.kasa_sayim < 0:
                raise HTTPException(400, "Kontrol için kasa sayımı zorunlu")
            cur.execute(
                """
                UPDATE sube_operasyon_event
                SET durum='tamamlandi', cevap_ts=%s,
                    personel_saat=%s, kasa_sayim=%s,
                    snap_nakit=%s, snap_pos=%s, snap_online=%s
                WHERE id=%s
                """,
                (
                    simdi,
                    body.personel_saat,
                    body.kasa_sayim,
                    body.snap_nakit,
                    body.snap_pos,
                    body.snap_online,
                    event_id,
                ),
            )
            audit(cur, "sube_operasyon_event", event_id, "KONTROL_TAMAMLANDI")
            from operasyon_defter import operasyon_defter_ekle

            operasyon_defter_ekle(
                cur,
                sube_id,
                "KONTROL_TAMAM",
                f"KONTROL tamamlandı kasa_sayim={body.kasa_sayim}",
                event_id,
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
            bildirim_saat = (body.personel_saat or "").strip() or simdi.strftime("%H:%M")

            import sube_panel as sp

            cn = float(body.ciro_nakit or 0)
            cp = float(body.ciro_pos or 0)
            co = float(body.ciro_online or 0)
            ciro_form_toplam = cn + cp + co

            ciro_gitti = sp._bugun_ciro_taslak_bekliyor(cur, sube_id) is not None or sp._bugun_ciro_var_mi(
                cur, sube_id
            )
            if ciro_form_toplam > 0:
                _upsert_ciro_taslak(
                    cur,
                    sube_id,
                    cn,
                    cp,
                    co,
                    "Operasyon KAPANIS (X nakit/POS/online)",
                    personel_id=pid_panel,
                    gonderen_ad=onay_ad,
                    bildirim_saati=bildirim_saat,
                    panel_kullanici_id=None,
                    audit_etiket="KAPANIS_TASLAK",
                )
                ciro_gitti = True
            if not ciro_gitti and not body.ciro_gonderim_onay:
                raise HTTPException(
                    400,
                    "Kapanış: X’ten nakit/POS/online tutarlarını girin, veya önce ciro taslağı gönderin / «ciro gönderildi» onayını işaretleyin.",
                )
            ks = body.kasa_sayim if body.kasa_sayim is not None else body.teslim
            cur.execute(
                """
                UPDATE sube_operasyon_event
                SET durum='tamamlandi', cevap_ts=%s,
                    personel_saat=%s, kasa_sayim=%s, teslim=%s, devir=%s,
                    x_raporu_onay=TRUE, ciro_gonderim_onay=TRUE
                WHERE id=%s
                """,
                (
                    simdi,
                    body.personel_saat,
                    ks,
                    body.teslim,
                    body.devir,
                    event_id,
                ),
            )
            audit(cur, "sube_operasyon_event", event_id, "KAPANIS_TAMAMLANDI")
            from operasyon_defter import operasyon_defter_ekle

            defter_satir = (
                f"KAPANIS teslim={body.teslim} devir={body.devir} kasa_sayim={ks} | "
                f"X ciro(nakit,pos,online)=({cn},{cp},{co}) | onaylayan={onay_ad} bildirim_saati={bildirim_saat}"
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

        elif tip == "CIKIS":
            if body.kasa_sayim is None or body.kasa_sayim < 0:
                raise HTTPException(400, "Çıkış için kasa sayımı zorunlu")
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
    simdi = datetime.now()
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
