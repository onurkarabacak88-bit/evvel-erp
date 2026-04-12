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
        SELECT id, ad, yonetici, personel_id
        FROM sube_panel_kullanici
        WHERE sube_id=%s AND aktif=TRUE
        ORDER BY yonetici DESC, ad
        """,
        (sube_id,),
    )
    rows = [dict(x) for x in cur.fetchall()]
    for r in rows:
        r["yonetici"] = bool(r.get("yonetici"))
    return rows


def _dogrula_yonetici(cur, sube_id: str, kullanici_id: str, pin: str) -> dict:
    u = _dogrula_pin(cur, kullanici_id, pin)
    if str(u.get("sube_id") or "") != str(sube_id):
        raise HTTPException(400, "Panel kullanıcısı bu şubeye ait değil")
    if not u.get("yonetici"):
        raise HTTPException(403, "Bu işlem için panel yöneticisi olmalısınız")
    return u


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


def _upsert_ciro_taslak(
    cur,
    sube_id: str,
    nakit: float,
    pos: float,
    online: float,
    aciklama: str,
    *,
    personel_id: Optional[str] = None,
    gonderen_ad: Optional[str] = None,
    bildirim_saati: Optional[str] = None,
    panel_kullanici_id: Optional[str] = None,
    audit_etiket: str = "VARDIYA_DEVIR_TASLAK",
) -> None:
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
        sets = ["nakit=%s", "pos=%s", "online=%s", "aciklama=%s"]
        vals: List[Any] = [nakit, pos, online, aciklama]
        if personel_id is not None:
            sets.append("personel_id=%s")
            vals.append(personel_id)
        if gonderen_ad is not None:
            sets.append("gonderen_ad=%s")
            vals.append(gonderen_ad)
        if bildirim_saati is not None:
            sets.append("bildirim_saati=%s")
            vals.append(bildirim_saati)
        if panel_kullanici_id is not None:
            sets.append("panel_kullanici_id=%s")
            vals.append(panel_kullanici_id)
        vals.append(ex["id"])
        cur.execute(
            f"UPDATE ciro_taslak SET {', '.join(sets)} WHERE id=%s",
            tuple(vals),
        )
        audit(cur, "ciro_taslak", ex["id"], audit_etiket)
        return
    tid = str(uuid.uuid4())
    cur.execute(
        """
        INSERT INTO ciro_taslak
            (id, sube_id, tarih, nakit, pos, online, aciklama, personel_id, durum,
             gonderen_ad, bildirim_saati, panel_kullanici_id)
        VALUES (%s, %s, CURRENT_DATE, %s, %s, %s, %s, %s, 'bekliyor', %s, %s, %s)
        """,
        (
            tid,
            sube_id,
            nakit,
            pos,
            online,
            aciklama,
            personel_id,
            gonderen_ad,
            bildirim_saati,
            panel_kullanici_id,
        ),
    )
    audit(cur, "ciro_taslak", tid, audit_etiket)


class PanelKullaniciOlustur(BaseModel):
    ad: str
    pin: str
    personel_id: Optional[str] = None
    """Şubede zaten aktif panel kullanıcısı varsa zorunlu (yönetici PIN doğrulaması)."""
    yetkili_panel_kullanici_id: Optional[str] = None
    yetkili_pin: Optional[str] = None


class PanelYoneticiAtamaBody(BaseModel):
    yetkili_panel_kullanici_id: str
    yetkili_pin: str
    hedef_panel_kullanici_id: str
    yonetici: bool = True


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
            SELECT COUNT(*) AS c FROM sube_panel_kullanici
            WHERE sube_id=%s AND aktif=TRUE
            """,
            (sube_id,),
        )
        aktif_n = int(cur.fetchone()["c"])
        ytid = (body.yetkili_panel_kullanici_id or "").strip()
        ytp = (body.yetkili_pin or "").strip()
        if aktif_n >= 1:
            if not ytid or len(ytp) != 4 or not ytp.isdigit():
                raise HTTPException(
                    403,
                    "Bu şubede kayıtlı panel kullanıcısı var: yeni eklemek için yönetici seçip PIN girin.",
                )
            _dogrula_yonetici(cur, sube_id, ytid, ytp)
        ilk_kullanici = aktif_n == 0

        pid = (body.personel_id or "").strip() or None
        if pid:
            cur.execute(
                "SELECT id, sube_id FROM personel WHERE id=%s AND aktif=TRUE",
                (pid,),
            )
            pr = cur.fetchone()
            if not pr:
                raise HTTPException(404, "Personel bulunamadı veya pasif")
            ps = pr.get("sube_id")
            if ps and str(ps) != str(sube_id):
                raise HTTPException(400, "Personel kaydı bu şubeye bağlı değil")
        cur.execute(
            """
            INSERT INTO sube_panel_kullanici
                (id, sube_id, ad, pin_salt, pin_hash, aktif, personel_id, yonetici)
            VALUES (%s, %s, %s, %s, %s, TRUE, %s, %s)
            """,
            (kid, sube_id, body.ad.strip(), salt, ph, pid, ilk_kullanici),
        )
        audit(cur, "sube_panel_kullanici", kid, "INSERT")
    return {"success": True, "id": kid, "yonetici": ilk_kullanici}


@router.post("/{sube_id}/panel-yonetici-atama")
def panel_yonetici_atama(sube_id: str, body: PanelYoneticiAtamaBody):
    hid = (body.hedef_panel_kullanici_id or "").strip()
    if not hid:
        raise HTTPException(400, "hedef_panel_kullanici_id gerekli")
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        _dogrula_yonetici(
            cur,
            sube_id,
            (body.yetkili_panel_kullanici_id or "").strip(),
            (body.yetkili_pin or "").strip(),
        )
        cur.execute(
            """
            SELECT id, yonetici FROM sube_panel_kullanici
            WHERE id=%s AND sube_id=%s AND aktif=TRUE
            """,
            (hid, sube_id),
        )
        hedef = cur.fetchone()
        if not hedef:
            raise HTTPException(404, "Hedef panel kullanıcısı bulunamadı")
        if not body.yonetici and hedef.get("yonetici"):
            cur.execute(
                """
                SELECT COUNT(*) AS c FROM sube_panel_kullanici
                WHERE sube_id=%s AND aktif=TRUE AND yonetici=TRUE AND id != %s
                """,
                (sube_id, hid),
            )
            if int(cur.fetchone()["c"]) < 1:
                raise HTTPException(400, "En az bir panel yöneticisi kalmalıdır.")
        cur.execute(
            """
            UPDATE sube_panel_kullanici
            SET yonetici=%s
            WHERE id=%s AND sube_id=%s
            """,
            (body.yonetici, hid, sube_id),
        )
        audit(cur, "sube_panel_kullanici", hid, "YONETICI_ATAMA" if body.yonetici else "YONETICI_KALDIR")
    return {"success": True, "hedef_id": hid, "yonetici": body.yonetici}


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
