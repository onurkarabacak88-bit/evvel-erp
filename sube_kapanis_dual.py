"""
Şube sabahçı → akşamcı vardiya devri (her şubede bu devir çift kişi; kimlik panel kullanıcı id).

PIN: Vardiya adımlarında her imzacı kendi 4 haneli PIN’i ile onaylar (`VARDIYA_DEVIR_PIN_ZORUNLU`;
False yapılırsa yalnızca kullanıcı/şube kontrolü kalır).

Bu uçlar «genel kapanış» değildir: günlük operasyon / tek kişi kapanış ayrı kalır.
DB sütun adları tarihsel: kapanisci_* = devreden (sabah), acilisci_* = devralan (akşam).

Prefix: /api/sube-panel
"""
from __future__ import annotations

import hashlib
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel

from database import db
from kasa_service import audit

router = APIRouter(prefix="/api/sube-panel", tags=["sube-vardiya-devri"])

# Sabah/akşam vardiya imzasında PIN doğrulaması (True = 4 haneli PIN hash ile zorunlu).
VARDIYA_DEVIR_PIN_ZORUNLU = True


def _sube_getir(cur, sube_id: str) -> dict:
    cur.execute("SELECT * FROM subeler WHERE id=%s AND aktif=TRUE", (sube_id,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Şube bulunamadı")
    return dict(row)


def _pin_hash(pin: str, salt: str) -> str:
    return hashlib.sha256(f"{salt}:{pin}".encode()).hexdigest()


def _panel_kullanici_get(cur, kullanici_id: str) -> dict:
    cur.execute(
        """
        SELECT * FROM sube_panel_kullanici
        WHERE id=%s AND aktif=TRUE
        """,
        (kullanici_id,),
    )
    u = cur.fetchone()
    if not u:
        raise HTTPException(404, "Panel kullanıcısı bulunamadı")
    return dict(u)


def _dogrula_pin(cur, kullanici_id: str, pin: str) -> dict:
    u = _panel_kullanici_get(cur, kullanici_id)
    if _pin_hash(pin, u["pin_salt"]) != u["pin_hash"]:
        raise HTTPException(403, "PIN hatalı")
    return u


def _vardiya_imza_kullanici_dogrula(cur, kullanici_id: str, pin: Optional[str]) -> dict:
    """Vardiya adımı: PIN bayrağına göre sadece kayıt veya PIN+hash."""
    u = _panel_kullanici_get(cur, kullanici_id)
    if not VARDIYA_DEVIR_PIN_ZORUNLU:
        return u
    p = (pin or "").strip()
    if len(p) != 4 or not p.isdigit():
        raise HTTPException(400, "Vardiya devrinde 4 haneli PIN gerekli")
    if _pin_hash(p, u["pin_salt"]) != u["pin_hash"]:
        raise HTTPException(403, "PIN hatalı")
    return u


def vardiya_devri_tamamlandi_mi(cur, sube_id: str) -> bool:
    """Bugün bu şubede sabah→akşam devir kaydı kilitlendi mi?"""
    cur.execute(
        """
        SELECT 1 FROM kapanis_kayit
        WHERE sube_id=%s AND tarih=CURRENT_DATE
          AND olay = 'vardiya_sabah_aksam_devri'
          AND durum = 'tamamlandi'
        """,
        (sube_id,),
    )
    return cur.fetchone() is not None


# Geriye dönük isim
def kapanis_cift_tamam_mi(cur, sube_id: str) -> bool:
    return vardiya_devri_tamamlandi_mi(cur, sube_id)


def _bugun_acilis_kayitli_sabah_panel_id(cur, sube_id: str) -> Optional[str]:
    """Açılışta kayıtlı panel kullanıcısı (sabah devreden için zorunlu eşleşme)."""
    cur.execute(
        """
        SELECT personel_id FROM sube_acilis
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='acildi'
        LIMIT 1
        """,
        (sube_id,),
    )
    r = cur.fetchone()
    if not r or not r.get("personel_id"):
        return None
    pid = str(r["personel_id"])
    cur.execute(
        """
        SELECT id FROM sube_panel_kullanici
        WHERE id=%s AND sube_id=%s AND aktif=TRUE
        """,
        (pid, sube_id),
    )
    return pid if cur.fetchone() else None


def _list_panel_kullanici(cur, sube_id: str) -> List[dict]:
    cur.execute(
        """
        SELECT id, ad FROM sube_panel_kullanici
        WHERE sube_id=%s AND aktif=TRUE
        ORDER BY ad
        """,
        (sube_id,),
    )
    return [dict(x) for x in cur.fetchall()]


def vardiya_devir_panel_blob(cur, sube_id: str) -> Dict[str, Any]:
    cur.execute(
        """
        SELECT * FROM kapanis_kayit
        WHERE sube_id=%s AND tarih=CURRENT_DATE
          AND olay = 'vardiya_sabah_aksam_devri'
        LIMIT 1
        """,
        (sube_id,),
    )
    kk = cur.fetchone()
    row = dict(kk) if kk else None
    if row:
        for k in ("tarih", "olay"):
            if row.get(k) is not None:
                row[k] = str(row[k])
        for k in ("kapanisci_onay_ts", "acilisci_onay_ts", "olusturma"):
            if row.get(k):
                v = row[k]
                row[k] = v.isoformat(sep=" ", timespec="seconds") if hasattr(v, "isoformat") else str(v)
        for k in ("nakit", "pos", "online", "teslim", "devir"):
            if row.get(k) is not None:
                row[k] = float(row[k])
        row["aciklama_roller"] = (
            "kapanisci_* = sabahçı (devreden, 1. imza); acilisci_* = akşamçı (devralan, 2. imza)"
        )
    return {
        "vardiya_devir": row,
        "panel_kullanicilar": _list_panel_kullanici(cur, sube_id),
        "sabahci_zorunlu_id": _bugun_acilis_kayitli_sabah_panel_id(cur, sube_id),
        "vardiya_devir_pin_zorunlu": VARDIYA_DEVIR_PIN_ZORUNLU,
        "not": "Genel kapanış tek kişi olabilir; çift imza yalnızca sabah→akşam vardiya devrine aittir.",
    }


def get_kapanis_panel_blob(cur, sube_id: str) -> Dict[str, Any]:
    """Eski isim — vardiya_devir_panel_blob ile aynı."""
    return vardiya_devir_panel_blob(cur, sube_id)


def _upsert_ciro_taslak(cur, sube_id: str, nakit: float, pos: float, online: float, aciklama: str) -> None:
    cur.execute(
        """
        SELECT id FROM ciro_taslak
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='bekliyor'
        LIMIT 1
        """,
        (sube_id,),
    )
    ex = cur.fetchone()
    if ex:
        cur.execute(
            """
            UPDATE ciro_taslak
            SET nakit=%s, pos=%s, online=%s, aciklama=%s
            WHERE id=%s
            """,
            (nakit, pos, online, aciklama, ex["id"]),
        )
        audit(cur, "ciro_taslak", ex["id"], "VARDIYA_DEVIR_TASLAK")
        return
    tid = str(uuid.uuid4())
    cur.execute(
        """
        INSERT INTO ciro_taslak
            (id, sube_id, tarih, nakit, pos, online, aciklama, personel_id, durum)
        VALUES (%s, %s, CURRENT_DATE, %s, %s, %s, %s, NULL, 'bekliyor')
        """,
        (tid, sube_id, nakit, pos, online, aciklama),
    )
    audit(cur, "ciro_taslak", tid, "VARDIYA_DEVIR_TASLAK")


class PanelKullaniciOlustur(BaseModel):
    ad: str
    pin: str


class VardiyaDevirAdim1(BaseModel):
    """1. imza: sabahçı (devreden)."""
    sabahci_devreden_id: str
    pin: str
    nakit: float = 0
    pos: float = 0
    online: float = 0
    teslim: float
    devir: float = 0
    x_raporu_gonderildi: bool = False
    ciro_gonderildi: bool = False
    operasyon_event_id: Optional[str] = None


class VardiyaDevirAdim2(BaseModel):
    """2. imza: akşamçı (devralan)."""
    aksamci_devralan_id: str
    pin: str


@router.get("/{sube_id}/vardiya-devri/durum")
def vardiya_devri_durum(sube_id: str):
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        return vardiya_devir_panel_blob(cur, sube_id)


@router.post("/{sube_id}/panel-kullanici")
def panel_kullanici_ekle(sube_id: str, body: PanelKullaniciOlustur):
    if not body.ad or not body.pin or len(body.pin) != 4 or not body.pin.isdigit():
        raise HTTPException(400, "ad ve 4 haneli PIN gerekli")
    salt = uuid.uuid4().hex[:12]
    ph = _pin_hash(body.pin, salt)
    kid = str(uuid.uuid4())
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        cur.execute(
            """
            INSERT INTO sube_panel_kullanici (id, sube_id, ad, pin_salt, pin_hash, aktif)
            VALUES (%s, %s, %s, %s, %s, TRUE)
            """,
            (kid, sube_id, body.ad.strip(), salt, ph),
        )
        audit(cur, "sube_panel_kullanici", kid, "INSERT")
    return {"success": True, "id": kid}


@router.post("/{sube_id}/vardiya-devri/adim1")
def vardiya_devri_adim1(sube_id: str, body: VardiyaDevirAdim1):
    from sube_panel import _bugun_sube_acildi_mi

    simdi = datetime.now()
    if body.teslim < 0 or body.devir < 0:
        raise HTTPException(400, "Teslim / devir geçersiz")
    if body.nakit + body.pos + body.online <= 0:
        raise HTTPException(400, "Ciro tutarlarından en az biri girilmeli")
    if not body.x_raporu_gonderildi:
        raise HTTPException(400, "X raporu gönderildi onayı gerekli")

    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        if not _bugun_sube_acildi_mi(cur, sube_id):
            raise HTTPException(403, "Şube açılış kaydı olmadan vardiya devri başlatılamaz")

        zorunlu_sabah = _bugun_acilis_kayitli_sabah_panel_id(cur, sube_id)
        if zorunlu_sabah and body.sabahci_devreden_id != zorunlu_sabah:
            raise HTTPException(
                400,
                "Birinci imza, bugünkü açılış kaydında yazılı sabah panel kullanıcısı olmalıdır.",
            )

        ku = _vardiya_imza_kullanici_dogrula(cur, body.sabahci_devreden_id, body.pin)
        if ku["sube_id"] != sube_id:
            raise HTTPException(400, "Kullanıcı bu şubeye ait değil")

        cur.execute(
            """
            SELECT id FROM kapanis_kayit
            WHERE sube_id=%s AND tarih=CURRENT_DATE AND olay='vardiya_sabah_aksam_devri'
            """,
            (sube_id,),
        )
        if cur.fetchone():
            raise HTTPException(409, "Bugün için vardiya devri kaydı zaten başlatılmış")

        kid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO kapanis_kayit
                (id, sube_id, tarih, olay, nakit, pos, online, teslim, devir,
                 kapanisci_id, kapanisci_onay_ts, durum,
                 operasyon_event_id, x_raporu_onay, ciro_gonderim_onay)
            VALUES (%s, %s, CURRENT_DATE, 'vardiya_sabah_aksam_devri', %s, %s, %s, %s, %s, %s, %s, 'acilis_bekliyor', %s, %s, %s)
            """,
            (
                kid,
                sube_id,
                body.nakit,
                body.pos,
                body.online,
                body.teslim,
                body.devir,
                body.sabahci_devreden_id,
                simdi,
                body.operasyon_event_id,
                body.x_raporu_gonderildi,
                body.ciro_gonderildi,
            ),
        )
        audit(cur, "kapanis_kayit", kid, "VARDIYA_DEVIR_ADIM1_SABAH")

        _upsert_ciro_taslak(
            cur,
            sube_id,
            float(body.nakit),
            float(body.pos),
            float(body.online),
            "Sabahçı vardiya devri (adım-1)",
        )

    return {
        "success": True,
        "kapanis_id": kid,
        "durum": "aksam_imzasi_bekliyor",
        "not": "İç durum kodu: acilis_bekliyor (akşamçı imzası bekleniyor)",
    }


@router.post("/{sube_id}/vardiya-devri/adim2")
def vardiya_devri_adim2(sube_id: str, body: VardiyaDevirAdim2):
    simdi = datetime.now()
    kid_out = ""
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        cur.execute(
            """
            SELECT * FROM kapanis_kayit
            WHERE sube_id=%s AND tarih=CURRENT_DATE AND olay='vardiya_sabah_aksam_devri'
            FOR UPDATE
            """,
            (sube_id,),
        )
        kk = cur.fetchone()
        if not kk:
            raise HTTPException(404, "Vardiya devri kaydı yok — önce sabahçı adımı")
        kk = dict(kk)
        if kk["durum"] != "acilis_bekliyor":
            raise HTTPException(400, "Akşam imzası beklenmiyor veya kayıt tamamlanmış")

        if body.aksamci_devralan_id == kk["kapanisci_id"]:
            raise HTTPException(
                400,
                "Aynı kişi hem sabah devrini hem akşam kabulünü imzalayamaz — iki farklı kişi gerekir.",
            )

        ku = _vardiya_imza_kullanici_dogrula(cur, body.aksamci_devralan_id, body.pin)
        if ku["sube_id"] != sube_id:
            raise HTTPException(400, "Kullanıcı bu şubeye ait değil")

        cur.execute(
            """
            UPDATE kapanis_kayit
            SET acilisci_id=%s, acilisci_onay_ts=%s, durum='tamamlandi'
            WHERE id=%s
            """,
            (body.aksamci_devralan_id, simdi, kk["id"]),
        )
        audit(cur, "kapanis_kayit", kk["id"], "VARDIYA_DEVIR_ADIM2_AKSAM")
        kid_out = kk["id"]

        eid = kk.get("operasyon_event_id")
        if eid:
            cur.execute(
                """
                UPDATE sube_operasyon_event
                SET durum='tamamlandi', cevap_ts=%s,
                    teslim=%s, devir=%s,
                    kasa_sayim=%s,
                    x_raporu_onay=TRUE, ciro_gonderim_onay=TRUE
                WHERE id=%s AND sube_id=%s AND tip='KAPANIS'
                """,
                (
                    simdi,
                    float(kk["teslim"]),
                    float(kk["devir"] or 0),
                    float(kk["teslim"]),
                    eid,
                    sube_id,
                ),
            )

    return {"success": True, "kapanis_id": kid_out, "durum": "tamamlandi"}


@router.get("/{sube_id}/kapanis/dual/durum")
def legacy_kapanis_dual_durum(sube_id: str):
    """Eski yol — /vardiya-devri/durum kullanın."""
    return vardiya_devri_durum(sube_id)


@router.post("/{sube_id}/kapanis/dual/adim1")
def legacy_kapanis_adim1(sube_id: str, body: dict = Body(...)):
    sid = body.get("sabahci_devreden_id") or body.get("kapanisci_id")
    if not sid:
        raise HTTPException(400, "sabahci_devreden_id (veya eski kapanisci_id) gerekli")
    mapped = VardiyaDevirAdim1(
        sabahci_devreden_id=sid,
        pin=body.get("pin", ""),
        nakit=float(body.get("nakit") or 0),
        pos=float(body.get("pos") or 0),
        online=float(body.get("online") or 0),
        teslim=float(body.get("teslim", 0)),
        devir=float(body.get("devir") or 0),
        x_raporu_gonderildi=bool(body.get("x_raporu_gonderildi")),
        ciro_gonderildi=bool(body.get("ciro_gonderildi")),
        operasyon_event_id=body.get("operasyon_event_id"),
    )
    return vardiya_devri_adim1(sube_id, mapped)


@router.post("/{sube_id}/kapanis/dual/adim2")
def legacy_kapanis_adim2(sube_id: str, body: dict = Body(...)):
    aid = body.get("aksamci_devralan_id") or body.get("acilisci_id")
    if not aid:
        raise HTTPException(400, "aksamci_devralan_id (veya eski acilisci_id) gerekli")
    mapped = VardiyaDevirAdim2(aksamci_devralan_id=aid, pin=body.get("pin", ""))
    return vardiya_devri_adim2(sube_id, mapped)
