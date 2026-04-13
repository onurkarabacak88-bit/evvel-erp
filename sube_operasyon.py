"""
Şube operasyon olay motoru (ACILIS / KONTROL / CIKIS / KAPANIS).
Ödeme onay kuyruğundan bağımsız; /api/sube-panel prefix ile ana panel API'sine paralel.
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db
from kasa_service import audit

router = APIRouter(prefix="/api/sube-panel", tags=["sube-operasyon"])

ACILIS_TOLERANS_DK = 10
# KONTROL: açılış cevabından 30 dk sonra slot; slot açıldıktan sonra 30 dk içinde cevap (toplam ~60 dk hedef)
KONTROL_SLOT_ACILIS_SONRASI_DK = 30
KONTROL_CEVAP_PENCERE_DK = 30
KAPANIS_TOLERANS_DK = 15
CIKIS_TOLERANS_DK = 5

_TR_TZ = ZoneInfo("Europe/Istanbul")


def _display_now_tr() -> datetime:
    """UI'da gösterilecek sunucu saatini TR saat diliminde üret."""
    return datetime.now(timezone.utc).astimezone(_TR_TZ)


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

    # KONTROL: yalnızca bugün ACILIS tamamlandıktan sonra oluşturulur (_sync_kontrol_slot_after_acilis)


def _sync_kontrol_slot_after_acilis(cur, sube_id: str) -> None:
    """ACILIS tamamlandıysa KONTROL satırını oluştur veya slotu cevap+30 dk (+30 dk cevap penceresi) yap."""
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
    slot = ac_cevap + timedelta(minutes=KONTROL_SLOT_ACILIS_SONRASI_DK)
    deadline = slot + timedelta(minutes=KONTROL_CEVAP_PENCERE_DK)
    cur.execute(
        """
        SELECT id, durum FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND tip='KONTROL' AND sira_no=1
        LIMIT 1
        """,
        (sube_id,),
    )
    rk = cur.fetchone()
    if not rk:
        eid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO sube_operasyon_event
                (id, sube_id, tarih, tip, sira_no, sistem_slot_ts, son_teslim_ts, durum)
            VALUES (%s, %s, CURRENT_DATE, 'KONTROL', 1, %s, %s, 'bekliyor')
            """,
            (eid, sube_id, slot, deadline),
        )
        return
    if rk["durum"] not in ("bekliyor", "gecikti"):
        return
    cur.execute(
        """
        UPDATE sube_operasyon_event
        SET sistem_slot_ts=%s, son_teslim_ts=%s
        WHERE id=%s AND durum IN ('bekliyor','gecikti')
        """,
        (slot, deadline, rk["id"]),
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
        # Saat slotu henüz gelmemiş olsa da panel akışı (özellikle açılış)
        # bugünün ilk bekleyen olayı üzerinden ilerleyebilsin.
        if not pending_all:
            return None
        pending_all.sort(key=lambda x: parse_ts(x["sistem_slot_ts"]))
        return pending_all[0]
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
    simdi = datetime.now()
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
    # KAPANIS: merkez ciro taslağı (nakit/POS/online) + PIN ile onaylayan
    ciro_nakit: Optional[float] = None
    ciro_pos: Optional[float] = None
    ciro_online: Optional[float] = None
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
        SELECT a.sube_id, COALESCE(s.ad, a.sube_id) AS sube_adi
        FROM sube_acilis a
        LEFT JOIN subeler s ON s.id = a.sube_id
        WHERE a.personel_id=%s AND a.tarih=CURRENT_DATE AND a.durum='acildi' AND a.sube_id<>%s
        LIMIT 1
        """,
        (pid, sube_id),
    )
    diger = cur.fetchone()
    if diger:
        raise HTTPException(
            409,
            f"Bu personel bugün başka şubede açılış yapmış: {diger.get('sube_adi') or diger.get('sube_id')}",
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
    simdi = datetime.now()
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
            zorunlu_int = (
                ("bardak_kucuk", body.bardak_kucuk),
                ("bardak_buyuk", body.bardak_buyuk),
                ("bardak_plastik", body.bardak_plastik),
                ("su_adet", body.su_adet),
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
            saat_sistem = simdi_tr.strftime("%H:%M:%S")
            stok = {
                "bardak_kucuk": int(body.bardak_kucuk),
                "bardak_buyuk": int(body.bardak_buyuk),
                "bardak_plastik": int(body.bardak_plastik),
                "su_adet": int(body.su_adet),
                "redbull_adet": int(body.redbull_adet),
                "soda_adet": int(body.soda_adet),
                "cookie_adet": int(body.cookie_adet),
                "pasta_adet": int(body.pasta_adet),
            }
            aciklama_ins = (
                f"Operasyon ACILIS — {onay_ad} — tarih={simdi_tr.strftime('%Y-%m-%d')} saat={saat_sistem} kasa={body.kasa_sayim}"
            )
            _insert_acilis_if_needed(cur, sube_id, pid_panel, aciklama_ins)
            cur.execute(
                """
                UPDATE sube_operasyon_event
                SET durum='tamamlandi', cevap_ts=%s,
                    personel_saat=%s, kasa_sayim=%s, meta=%s
                WHERE id=%s
                """,
                (
                    simdi,
                    saat_sistem,
                    body.kasa_sayim,
                    json.dumps({"acilis_stok_sayim": stok, "acilis_tr_ts": simdi_tr.isoformat(timespec="seconds")}, ensure_ascii=False),
                    event_id,
                ),
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
                (
                    f"Operasyon ACILIS tamamlandı — {onay_ad} — tarih={date.today()} saat={saat_sistem} "
                    f"kasa_sayim={ks} | stok bardak(kucuk/buyuk/plastik)=({stok['bardak_kucuk']}/"
                    f"{stok['bardak_buyuk']}/{stok['bardak_plastik']}) "
                    f"urun(su/redbull/soda/cookie/pasta)=({stok['su_adet']}/{stok['redbull_adet']}/"
                    f"{stok['soda_adet']}/{stok['cookie_adet']}/{stok['pasta_adet']})"
                ),
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
            bildirim_saat = (body.personel_saat or "").strip() or simdi_tr.strftime("%H:%M:%S")

            for ad, deger in (
                ("ciro_nakit", body.ciro_nakit),
                ("ciro_pos", body.ciro_pos),
                ("ciro_online", body.ciro_online),
                ("bardak_kucuk", body.bardak_kucuk),
                ("bardak_buyuk", body.bardak_buyuk),
                ("bardak_plastik", body.bardak_plastik),
                ("su_adet", body.su_adet),
                ("redbull_adet", body.redbull_adet),
                ("soda_adet", body.soda_adet),
                ("cookie_adet", body.cookie_adet),
                ("pasta_adet", body.pasta_adet),
            ):
                if deger is None:
                    raise HTTPException(400, f"Kapanış için {ad} zorunlu")
                if float(deger) < 0:
                    raise HTTPException(400, f"Kapanış için {ad} negatif olamaz")

            cn = float(body.ciro_nakit)
            cp = float(body.ciro_pos)
            co = float(body.ciro_online)
            k_stok = {
                "bardak_kucuk": int(body.bardak_kucuk),
                "bardak_buyuk": int(body.bardak_buyuk),
                "bardak_plastik": int(body.bardak_plastik),
                "su_adet": int(body.su_adet),
                "redbull_adet": int(body.redbull_adet),
                "soda_adet": int(body.soda_adet),
                "cookie_adet": int(body.cookie_adet),
                "pasta_adet": int(body.pasta_adet),
            }
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
            ks = body.kasa_sayim if body.kasa_sayim is not None else body.teslim
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
                    body.devir,
                    json.dumps({"kapanis_stok_sayim": k_stok, "x_rapor": {"nakit": cn, "pos": cp, "online": co}}, ensure_ascii=False),
                    event_id,
                ),
            )
            audit(cur, "sube_operasyon_event", event_id, "KAPANIS_TAMAMLANDI")
            from operasyon_defter import operasyon_defter_ekle

            defter_satir = (
                f"KAPANIS teslim={body.teslim} devir={body.devir} kasa_sayim={ks} | "
                f"X ciro(nakit,pos,online)=({cn},{cp},{co}) | "
                f"stok bardak(kucuk/buyuk/plastik)=({k_stok['bardak_kucuk']}/{k_stok['bardak_buyuk']}/{k_stok['bardak_plastik']}) "
                f"urun(su/redbull/soda/cookie/pasta)=({k_stok['su_adet']}/{k_stok['redbull_adet']}/{k_stok['soda_adet']}/{k_stok['cookie_adet']}/{k_stok['pasta_adet']}) | "
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
            from operasyon_stok_motor import kapanis_stok_uyarilari_yaz

            kapanis_stok_uyarilari_yaz(cur, sube_id, k_stok)

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
