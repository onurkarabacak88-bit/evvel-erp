"""
Şube sabahçı → akşamcı vardiya devri (çift imza; kimlik = personel_id).

PIN: Personel kaydındaki şirket geneli panel PIN (tüm şubelerde aynı).
Eski şube bazlı `sube_panel_kullanici` uçları kaldırıldı — PIN merkezden personele atanır.

Bu uçlar «genel kapanış» değildir: günlük operasyon / tek kişi kapanış ayrı kalır.

Prefix: /api/sube-panel
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, Field

from database import db
from evvel_merkez_guard import merkez_mutasyon_korumasi
from kasa_service import audit
from personel_panel_auth import (
    count_personel_panel_yonetici,
    dogrula_personel_panel_pin,
    dogrula_personel_panel_yonetici,
    list_personel_panel_secim,
    panel_pin_hash,
)

router = APIRouter(prefix="/api/sube-panel", tags=["sube-vardiya-devri"])

# Sabah/akşam vardiya imzasında PIN doğrulaması (True = 4 haneli PIN hash ile zorunlu).
VARDIYA_DEVIR_PIN_ZORUNLU = True


def _sube_getir(cur, sube_id: str) -> dict:
    cur.execute("SELECT * FROM subeler WHERE id=%s AND aktif=TRUE", (sube_id,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Şube bulunamadı")
    return dict(row)


def _vardiya_imza_personel_dogrula(cur, personel_id: str, pin: Optional[str]) -> dict:
    """Vardiya adımı: personel + şirket geneli panel PIN."""
    if not VARDIYA_DEVIR_PIN_ZORUNLU:
        cur.execute(
            "SELECT id, ad_soyad, aktif FROM personel WHERE id=%s",
            (personel_id,),
        )
        r = cur.fetchone()
        if not r or not dict(r).get("aktif"):
            raise HTTPException(404, "Personel bulunamadı veya pasif")
        return dict(r)
    return dogrula_personel_panel_pin(cur, personel_id, pin or "")


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


def _bugun_acilis_kayitli_sabah_personel_id(cur, sube_id: str) -> Optional[str]:
    """Açılış kaydındaki personel (sabah devreden için zorunlu eşleşme)."""
    cur.execute(
        """
        SELECT personel_id FROM sube_acilis
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='acildi' AND personel_id IS NOT NULL
        LIMIT 1
        """,
        (sube_id,),
    )
    r = cur.fetchone()
    return str(r["personel_id"]) if r and r.get("personel_id") else None


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
        "panel_kullanicilar": list_personel_panel_secim(cur),
        "sabahci_zorunlu_id": _bugun_acilis_kayitli_sabah_personel_id(cur, sube_id),
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


def _legacy_personel_id_bul(cur, personel_id: Optional[str], ad: str) -> str:
    pid = (personel_id or "").strip()
    if pid:
        cur.execute("SELECT id, aktif FROM personel WHERE id=%s", (pid,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Personel bulunamadı")
        if not bool(dict(r).get("aktif")):
            raise HTTPException(403, "Personel aktif değil")
        return pid

    nm = (ad or "").strip()
    if not nm:
        raise HTTPException(400, "Personel adı gerekli")
    cur.execute(
        """
        SELECT id FROM personel
        WHERE aktif=TRUE AND LOWER(TRIM(ad_soyad)) = LOWER(TRIM(%s))
        ORDER BY ad_soyad
        """,
        (nm,),
    )
    rows = [dict(x) for x in cur.fetchall()]
    if not rows:
        raise HTTPException(404, "Bu adla aktif personel bulunamadı")
    if len(rows) > 1:
        raise HTTPException(409, "Aynı adda birden fazla personel var; personel_id ile tekrar deneyin.")
    return str(rows[0]["id"])


class VardiyaDevirAdim1(BaseModel):
    """1. imza: sabahçı (devreden) — `sabahci_devreden_id` = personel_id.

    Bardak ve ürün sayımları zorunludur (açılış / devir tutarlılığı; >= 0 tam sayı).
    """

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
    bardak_kucuk: int = Field(..., ge=0)
    bardak_buyuk: int = Field(..., ge=0)
    bardak_plastik: int = Field(..., ge=0)
    su_adet: int = Field(..., ge=0)
    redbull_adet: int = Field(..., ge=0)
    soda_adet: int = Field(..., ge=0)
    cookie_adet: int = Field(..., ge=0)
    pasta_adet: int = Field(..., ge=0)


class VardiyaDevirAdim2(BaseModel):
    """2. imza: akşamçı (devralan) — `aksamci_devralan_id` = personel_id."""
    aksamci_devralan_id: str
    pin: str


@router.get("/{sube_id}/vardiya-devri/durum")
def vardiya_devri_durum(sube_id: str):
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        return vardiya_devir_panel_blob(cur, sube_id)


@router.post(
    "/{sube_id}/panel-kullanici",
    dependencies=[Depends(merkez_mutasyon_korumasi)],
)
def panel_kullanici_ekle(sube_id: str, body: PanelKullaniciOlustur):
    # Legacy uyumluluk: eski endpoint çağrılarını personel bazlı yeni PIN modeline yönlendir.
    p = (body.pin or "").strip()
    if len(p) != 4 or not p.isdigit():
        raise HTTPException(400, "4 haneli PIN gerekli")
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        yetkili_id = (body.yetkili_panel_kullanici_id or "").strip()
        yetkili_pin = (body.yetkili_pin or "").strip().replace(" ", "")
        n_yon = count_personel_panel_yonetici(cur)
        if n_yon >= 1:
            if not yetkili_id or len(yetkili_pin) != 4 or not yetkili_pin.isdigit():
                raise HTTPException(
                    400,
                    "Panel yöneticisi onayı gerekli: yetkili_panel_kullanici_id ve 4 haneli yetkili_pin.",
                )
            dogrula_personel_panel_yonetici(cur, yetkili_id, yetkili_pin)
        elif yetkili_id or yetkili_pin:
            if not yetkili_id or len(yetkili_pin) != 4 or not yetkili_pin.isdigit():
                raise HTTPException(400, "Yetkili personel ve 4 haneli PIN eksik veya geçersiz.")
            dogrula_personel_panel_yonetici(cur, yetkili_id, yetkili_pin)
        hedef_pid = _legacy_personel_id_bul(cur, body.personel_id, body.ad)
        salt = uuid.uuid4().hex[:12]
        ph = panel_pin_hash(p, salt)
        cur.execute(
            """
            UPDATE personel
            SET panel_pin_salt=%s, panel_pin_hash=%s
            WHERE id=%s
            """,
            (salt, ph, hedef_pid),
        )
        audit(cur, "personel", hedef_pid, "LEGACY_PANEL_KULLANICI_ENDPOINT_PIN_GUNCELLE")
    return {"success": True, "legacy_compat": True, "personel_id": hedef_pid}


@router.get("/{sube_id}/panel-kullanici")
def panel_kullanici_liste_legacy(sube_id: str):
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        return list_personel_panel_secim(cur)


@router.post("/{sube_id}/panel-yonetici-atama")
def panel_yonetici_atama(sube_id: str, body: PanelYoneticiAtamaBody):
    raise HTTPException(
        410,
        "Şube bazlı yönetici ataması kaldırıldı. Personel için: PUT /api/sube-panel/merkez/personel/{id}/panel-yonetici",
    )


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

        zorunlu_sabah = _bugun_acilis_kayitli_sabah_personel_id(cur, sube_id)
        if zorunlu_sabah and body.sabahci_devreden_id != zorunlu_sabah:
            raise HTTPException(
                400,
                "Birinci imza, bugünkü açılış kaydında yazılı personel ile aynı olmalıdır.",
            )

        ku = _vardiya_imza_personel_dogrula(cur, body.sabahci_devreden_id, body.pin)
        onay_ad = (ku.get("ad_soyad") or "").strip() or "—"

        cur.execute(
            """
            SELECT id FROM kapanis_kayit
            WHERE sube_id=%s AND tarih=CURRENT_DATE AND olay='vardiya_sabah_aksam_devri'
            """,
            (sube_id,),
        )
        if cur.fetchone():
            raise HTTPException(409, "Bugün için vardiya devri kaydı zaten başlatılmış")

        stok_sayim = {
            "bardak_kucuk": int(body.bardak_kucuk),
            "bardak_buyuk": int(body.bardak_buyuk),
            "bardak_plastik": int(body.bardak_plastik),
            "su_adet": int(body.su_adet),
            "redbull_adet": int(body.redbull_adet),
            "soda_adet": int(body.soda_adet),
            "cookie_adet": int(body.cookie_adet),
            "pasta_adet": int(body.pasta_adet),
        }
        meta_obj = {"vardiya_devir_stok_sayim": stok_sayim}
        meta_sql = json.dumps(meta_obj, ensure_ascii=False)

        kid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO kapanis_kayit
                (id, sube_id, tarih, olay, nakit, pos, online, teslim, devir,
                 kapanisci_id, kapanisci_onay_ts, durum,
                 operasyon_event_id, x_raporu_onay, ciro_gonderim_onay,
                 sabahci_personel_id, aksamci_personel_id, meta)
            VALUES (%s, %s, CURRENT_DATE, 'vardiya_sabah_aksam_devri', %s, %s, %s, %s, %s, NULL, %s, 'acilis_bekliyor', %s, %s, %s, %s, NULL, %s::jsonb)
            """,
            (
                kid,
                sube_id,
                body.nakit,
                body.pos,
                body.online,
                body.teslim,
                body.devir,
                simdi,
                body.operasyon_event_id,
                body.x_raporu_gonderildi,
                body.ciro_gonderildi,
                body.sabahci_devreden_id,
                meta_sql,
            ),
        )
        audit(cur, "kapanis_kayit", kid, "VARDIYA_DEVIR_ADIM1_SABAH")
        from operasyon_defter import operasyon_defter_ekle

        operasyon_defter_ekle(
            cur,
            sube_id,
            "VARDIYA_DEVIR_IMZA1_PIN",
            (
                f"Vardiya devri 1. imza (PIN) — personel={onay_ad} "
                f"tarih={date.today()} saat={simdi.strftime('%H:%M:%S')}"
            ),
            ref_event_id=body.operasyon_event_id,
            personel_id=body.sabahci_devreden_id,
            personel_ad=onay_ad,
            bildirim_saati=simdi.strftime("%H:%M:%S"),
        )

        tr_s = simdi.strftime("%H:%M:%S")
        _upsert_ciro_taslak(
            cur,
            sube_id,
            float(body.nakit),
            float(body.pos),
            float(body.online),
            "Sabahçı vardiya devri (adım-1)",
            personel_id=str(body.sabahci_devreden_id),
            gonderen_ad=onay_ad,
            bildirim_saati=tr_s,
            panel_kullanici_id=str(body.sabahci_devreden_id),
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

        sabah_pid = kk.get("sabahci_personel_id") or kk.get("kapanisci_id")
        if sabah_pid and str(body.aksamci_devralan_id) == str(sabah_pid):
            raise HTTPException(
                400,
                "Aynı kişi hem sabah devrini hem akşam kabulünü imzalayamaz — iki farklı kişi gerekir.",
            )

        ku = _vardiya_imza_personel_dogrula(cur, body.aksamci_devralan_id, body.pin)
        onay_ad = (ku.get("ad_soyad") or "").strip() or "—"

        cur.execute(
            """
            UPDATE kapanis_kayit
            SET acilisci_id=NULL, acilisci_onay_ts=%s,
                aksamci_personel_id=%s, durum='tamamlandi'
            WHERE id=%s
            """,
            (simdi, body.aksamci_devralan_id, kk["id"]),
        )
        audit(cur, "kapanis_kayit", kk["id"], "VARDIYA_DEVIR_ADIM2_AKSAM")
        from operasyon_defter import operasyon_defter_ekle

        operasyon_defter_ekle(
            cur,
            sube_id,
            "VARDIYA_DEVIR_IMZA2_PIN",
            (
                f"Vardiya devri 2. imza (PIN) — personel={onay_ad} "
                f"tarih={date.today()} saat={simdi.strftime('%H:%M:%S')}"
            ),
            ref_event_id=kk.get("operasyon_event_id"),
            personel_id=body.aksamci_devralan_id,
            personel_ad=onay_ad,
            bildirim_saati=simdi.strftime("%H:%M:%S"),
        )
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
    def _zint(k: str) -> int:
        v = body.get(k)
        if v is None or (isinstance(v, str) and not str(v).strip()):
            return 0
        return int(v)

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
        bardak_kucuk=_zint("bardak_kucuk"),
        bardak_buyuk=_zint("bardak_buyuk"),
        bardak_plastik=_zint("bardak_plastik"),
        su_adet=_zint("su_adet"),
        redbull_adet=_zint("redbull_adet"),
        soda_adet=_zint("soda_adet"),
        cookie_adet=_zint("cookie_adet"),
        pasta_adet=_zint("pasta_adet"),
    )
    return vardiya_devri_adim1(sube_id, mapped)


@router.post("/{sube_id}/kapanis/dual/adim2")
def legacy_kapanis_adim2(sube_id: str, body: dict = Body(...)):
    aid = body.get("aksamci_devralan_id") or body.get("acilisci_id")
    if not aid:
        raise HTTPException(400, "aksamci_devralan_id (veya eski acilisci_id) gerekli")
    mapped = VardiyaDevirAdim2(aksamci_devralan_id=aid, pin=body.get("pin", ""))
    return vardiya_devri_adim2(sube_id, mapped)
