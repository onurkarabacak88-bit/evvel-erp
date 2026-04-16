"""
Şube personel paneli — CFO verisi yok.
Prefix: /api/sube-panel
Statik arayüz: GET /sube-panel veya /sube-panel/{sube_id}

X rapor OCR: OPENAI_API_KEY, isteğe OPENAI_X_RAPOR_MODEL (varsayılan gpt-4o-mini).
"""
import base64
import json
import os
import pathlib
import re
import uuid
from typing import Any, Optional, List, Dict

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from database import db
from tr_saat import bugun_tr, dt_now_tr as _now_tr
from evvel_merkez_guard import merkez_mutasyon_korumasi
from finans_core import kasa_bakiyesi
from kasa_service import insert_kasa_hareketi, audit, onay_ekle
from personel_panel_auth import (
    count_personel_panel_yonetici,
    dogrula_personel_panel_pin,
    dogrula_personel_panel_yonetici,
    list_personel_panel_secim,
    panel_pin_hash,
)

router = APIRouter(prefix="/api/sube-panel", tags=["sube-panel"])


class MerkezPanelOnayBody(BaseModel):
    """En az bir panel yöneticisi tanımlıyken PIN / yönetici rolü değişiminde zorunlu."""

    onaylayan_personel_id: Optional[str] = None
    onaylayan_pin: Optional[str] = None


def _merkez_yonetici_onayla(cur: Any, body: MerkezPanelOnayBody) -> None:
    oid = (body.onaylayan_personel_id or "").strip()
    op = (body.onaylayan_pin or "").strip().replace(" ", "")
    if not oid or len(op) != 4 or not op.isdigit():
        raise HTTPException(
            400,
            "Panel yöneticisi onayı gerekli: onaylayan_personel_id ve 4 haneli onaylayan_pin gönderin.",
        )
    dogrula_personel_panel_yonetici(cur, oid, op)


_X_RAPOR_MAX_BYTES = 8 * 1024 * 1024
_X_UPLOAD_ROOT = pathlib.Path("data/x_rapor_uploads")


def _x_parse_model_json(raw: str) -> dict:
    """Model çıktısından JSON nesnesi çıkar (markdown code fence toleransı)."""
    t = (raw or "").strip()
    if "```" in t:
        m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", t, re.IGNORECASE)
        if m:
            t = m.group(1).strip()
    return json.loads(t)


def _x_to_float(v: Any, default: float = 0.0) -> float:
    if v is None:
        return default
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(" ", "").replace("₺", "").replace("TL", "")
    if not s:
        return default
    # TR: 12.345,67 → 12345.67
    if "," in s:
        a, b = s.rsplit(",", 1)
        a = a.replace(".", "")
        try:
            return float(f"{a}.{b}")
        except ValueError:
            return default
    try:
        return float(s.replace(",", "."))
    except ValueError:
        return default


def _x_extract_amounts(obj: dict) -> dict:
    low = {str(k).lower().strip(): v for k, v in obj.items()}
    nakit = _x_to_float(low.get("nakit"), 0)
    pos = _x_to_float(low.get("pos"), 0)
    online = _x_to_float(low.get("online"), 0)
    toplam = _x_to_float(low.get("toplam"), 0)
    if toplam <= 0 and (nakit + pos + online) > 0:
        toplam = nakit + pos + online
    return {"nakit": nakit, "pos": pos, "online": online, "toplam": toplam}


def _norm_ad_tr(v: str) -> str:
    s = (v or "").strip().lower()
    repl = (
        ("ğ", "g"),
        ("ü", "u"),
        ("ş", "s"),
        ("ı", "i"),
        ("ö", "o"),
        ("ç", "c"),
    )
    for a, b in repl:
        s = s.replace(a, b)
    s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    return s


def _sube_getir(cur, sube_id: str) -> dict:
    cur.execute("SELECT * FROM subeler WHERE id=%s AND aktif=TRUE", (sube_id,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Şube bulunamadı")
    return dict(row)


def _bugun_ciro_var_mi(cur, sube_id: str) -> bool:
    cur.execute("""
        SELECT 1 FROM ciro
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='aktif'
        LIMIT 1
    """, (sube_id,))
    return cur.fetchone() is not None


def _bugun_ciro_taslak_bekliyor(cur, sube_id: str) -> Optional[dict]:
    cur.execute("""
        SELECT id, nakit, pos, online, olusturma, aciklama, personel_id,
               gonderen_ad, bildirim_saati, panel_kullanici_id
        FROM ciro_taslak
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='bekliyor'
        ORDER BY olusturma DESC
        LIMIT 1
    """, (sube_id,))
    r = cur.fetchone()
    if not r:
        return None
    d = dict(r)
    if d.get("olusturma"):
        d["olusturma"] = str(d["olusturma"])
    for k in ("nakit", "pos", "online"):
        if d.get(k) is not None:
            d[k] = float(d[k])
    return d


def _ciro_insert_aktif_ve_kasa(
    cur,
    sube: dict,
    sube_id: str,
    nakit: float,
    pos: float,
    online: float,
    aciklama: Optional[str],
    audit_etiket: str = "INSERT_PANEL",
) -> dict:
    """Onaylı ciro satırı + kasa hareketi (şube kesintileri dahil)."""
    pos_oran = float(sube.get("pos_oran") or 0)
    online_oran = float(sube.get("online_oran") or 0)
    pos_kesinti = pos * pos_oran / 100.0
    online_kesinti = online * online_oran / 100.0
    net_tutar = nakit + (pos - pos_kesinti) + (online - online_kesinti)

    cid = str(uuid.uuid4())
    cur.execute(
        """
        INSERT INTO ciro (id, tarih, sube_id, nakit, pos, online, aciklama)
        VALUES (%s, CURRENT_DATE, %s, %s, %s, %s, %s)
        """,
        (cid, sube_id, nakit, pos, online, aciklama or "Onaylı ciro"),
    )
    insert_kasa_hareketi(
        cur,
        bugun_tr(),
        "CIRO",
        net_tutar,
        f"Ciro — {sube['ad']} ({audit_etiket})",
        "ciro",
        cid,
        ref_id=cid,
        ref_type="CIRO",
    )
    audit(cur, "ciro", cid, audit_etiket)
    return {
        "id": cid,
        "net_tutar": round(net_tutar, 2),
        "pos_kesinti": round(pos_kesinti, 2),
        "online_kesinti": round(online_kesinti, 2),
    }


def _bugun_anlik_gider_sayisi(cur, sube_id: str) -> int:
    cur.execute("""
        SELECT COUNT(*) as adet FROM anlik_giderler
        WHERE sube=%s AND tarih=CURRENT_DATE AND durum='aktif'
    """, (sube_id,))
    return int(cur.fetchone()['adet'])


def _bugun_sube_acildi_mi(cur, sube_id: str) -> bool:
    cur.execute("""
        SELECT 1 FROM sube_acilis
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='acildi'
        LIMIT 1
    """, (sube_id,))
    return cur.fetchone() is not None


def _bugun_kasa_acildi_mi(cur, sube_id: str) -> bool:
    cur.execute(
        """
        SELECT 1 FROM sube_kasa_gun_acma
        WHERE sube_id=%s AND tarih=CURRENT_DATE
        LIMIT 1
        """,
        (sube_id,),
    )
    return cur.fetchone() is not None


def _bugun_kasa_acma_kaydi(cur, sube_id: str) -> Optional[dict]:
    cur.execute(
        """
        SELECT k.personel_id, k.panel_kullanici_id, k.olusturma,
               COALESCE(p.ad_soyad, u.ad) AS panel_kullanici_ad
        FROM sube_kasa_gun_acma k
        LEFT JOIN personel p ON p.id = k.personel_id
        LEFT JOIN sube_panel_kullanici u ON u.id = k.panel_kullanici_id
        WHERE k.sube_id=%s AND k.tarih=CURRENT_DATE
        LIMIT 1
        """,
        (sube_id,),
    )
    r = cur.fetchone()
    if not r:
        return None
    d = dict(r)
    if d.get("olusturma"):
        d["olusturma"] = str(d["olusturma"])
    return d


def _bugun_acilis_kaydi(cur, sube_id: str) -> Optional[dict]:
    cur.execute("""
        SELECT id, sube_id, tarih, acilis_saati, olusturma, personel_id, durum
        FROM sube_acilis
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='acildi'
        LIMIT 1
    """, (sube_id,))
    r = cur.fetchone()
    if not r:
        return None
    d = dict(r)
    if d.get("tarih"):
        d["tarih"] = str(d["tarih"])
    if d.get("olusturma"):
        d["olusturma"] = str(d["olusturma"])
    return d


def _gorev_listesi_uret(
    sube: dict,
    ciro_girildi: bool,
    anlik_adet: int,
    sube_acildi_mi: bool,
    ciro_taslak_bekliyor: bool = False,
    kasa_acildi_mi: bool = True,
    kasa_acma_kaydi: Optional[dict] = None,
) -> list:
    """Günlük görev listesi. Önce kasa PIN, sonra şube açılış (sube_acilis)."""
    _ = anlik_adet
    simdi = _now_tr().strftime("%H:%M")
    gorevler = []

    acilis = sube.get("acilis_saati") or "09:00"
    kapanis = sube.get("kapanis_saati") or "22:00"

    kasa_aciklama = "Günlük kasa kilitlidir. Sabah personel, kayıtlı PIN ile kilidi açmalıdır."
    if kasa_acildi_mi and kasa_acma_kaydi:
        ad = str((kasa_acma_kaydi.get("panel_kullanici_ad") or "—")).strip() or "—"
        ts = str(kasa_acma_kaydi.get("olusturma") or "").strip()
        saat = ts[11:16] if len(ts) >= 16 else ""
        if saat:
            kasa_aciklama = f"Kasa kilidi açıldı. PIN onayı: {ad} ({saat})."
        else:
            kasa_aciklama = f"Kasa kilidi açıldı. PIN onayı: {ad}."

    gorevler.append({
        "id":       "kasa_kilit",
        "baslik":   "Kasa kilidi",
        "aciklama": kasa_aciklama,
        "saat":     acilis,
        "tur":      "kasa_kilit",
        "tamamlandi": kasa_acildi_mi,
        "aksiyon":  "kasa_ac" if not kasa_acildi_mi else None,
    })

    gorevler.append({
        "id":       "acilis",
        "baslik":   "Şube Açılışı",
        "aciklama": f"Planlanan açılış {acilis}. Kasa ve ekipman kontrolü — \"Şubeyi Aç\" ile kayıt oluşturun.",
        "saat":     acilis,
        "tur":      "acilis",
        "tamamlandi": sube_acildi_mi,
        "aksiyon":  "sube_ac" if (kasa_acildi_mi and not sube_acildi_mi) else None,
    })

    if ciro_taslak_bekliyor and not ciro_girildi:
        ciro_baslik = "Günlük Ciro (merkez onayında)"
        ciro_aciklama = (
            "Ciro taslağınız gönderildi; merkez onayından sonra sisteme işlenir. "
            "X raporu fotoğrafını WhatsApp ile yöneticiye iletin."
        )
        ciro_tamam = True
        ciro_aksiyon = None
    else:
        ciro_baslik = "Günlük Ciro Girişi"
        ciro_aciklama = "Bugünkü nakit, POS ve online satışlarını girin — merkez onayından sonra ciroya işlenir."
        ciro_tamam = ciro_girildi
        ciro_aksiyon = "ciro_gir" if (kasa_acildi_mi and sube_acildi_mi and not ciro_girildi) else None

    gorevler.append({
        "id":           "ciro",
        "baslik":       ciro_baslik,
        "aciklama":     ciro_aciklama,
        "saat":         kapanis,
        "tur":          "ciro",
        "tamamlandi":   ciro_tamam,
        "aksiyon":      ciro_aksiyon,
    })

    gorevler.append({
        "id":       "kapanis",
        "baslik":   "Kapanış Kontrolü",
        "aciklama": f"Şube {kapanis} kapanıyor. Son kontroller.",
        "saat":     kapanis,
        "tur":      "kapanis",
        "tamamlandi": ciro_girildi and simdi >= kapanis,
        "aksiyon":  None,
    })

    return gorevler


@router.get("/merkez/durum")
def tum_subeler_durum():
    """Tüm şubelerin bugünkü ciro özeti (CFO / merkez)."""
    with db() as (conn, cur):
        cur.execute("SELECT * FROM subeler WHERE aktif=TRUE ORDER BY ad")
        subeler = cur.fetchall()

        sonuc = []
        for s in subeler:
            sid = s['id']
            ciro_girildi = _bugun_ciro_var_mi(cur, sid)
            sube_acik = _bugun_sube_acildi_mi(cur, sid)
            kasa_acik = _bugun_kasa_acildi_mi(cur, sid)

            cur.execute("""
                SELECT COALESCE(SUM(toplam), 0) as toplam
                FROM ciro
                WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='aktif'
            """, (sid,))
            bugun_ciro = float(cur.fetchone()['toplam'])

            cur.execute("""
                SELECT COALESCE(SUM(tutar), 0) as toplam
                FROM anlik_giderler
                WHERE sube=%s AND tarih=CURRENT_DATE AND durum='aktif'
            """, (sid,))
            bugun_gider = float(cur.fetchone()['toplam'])

            taslak_bek = _bugun_ciro_taslak_bekliyor(cur, sid) is not None
            if sube_acik and ciro_girildi:
                durum_txt = "✅ Tamamlandı"
            elif not kasa_acik:
                durum_txt = "🔒 Kasa kilidi (PIN)"
            elif not sube_acik:
                durum_txt = "🌅 Açılış bekliyor"
            elif taslak_bek:
                durum_txt = "📩 Ciro taslağı merkezde"
            else:
                durum_txt = "⏳ Ciro bekliyor"

            cur.execute(
                """
                SELECT tip, durum,
                    to_char(sistem_slot_ts, 'HH24:MI') AS sistem_saat,
                    to_char(cevap_ts, 'HH24:MI') AS cevap_saat,
                    CASE WHEN cevap_ts IS NOT NULL THEN
                        EXTRACT(EPOCH FROM (cevap_ts - sistem_slot_ts)) / 60.0
                    END AS fark_dk
                FROM sube_operasyon_event
                WHERE sube_id=%s AND tarih=CURRENT_DATE AND tip='KAPANIS' AND sira_no=0
                LIMIT 1
                """,
                (sid,),
            )
            kop = cur.fetchone()
            kapanis_op = None
            if kop:
                kapanis_op = {
                    "durum":       kop["durum"],
                    "sistem_saat": kop["sistem_saat"],
                    "cevap_saat":  kop["cevap_saat"],
                    "fark_dk":     float(kop["fark_dk"]) if kop["fark_dk"] is not None else None,
                }

            sonuc.append({
                "sube_id":        sid,
                "sube_adi":       s['ad'],
                "acilis_saati":   s.get('acilis_saati') or '09:00',
                "kapanis_saati":  s.get('kapanis_saati') or '22:00',
                "kasa_acik":      kasa_acik,
                "sube_acik":      sube_acik,
                "ciro_girildi":   ciro_girildi,
                "ciro_taslak_bekliyor": taslak_bek,
                "bugun_ciro":     bugun_ciro,
                "bugun_gider":    bugun_gider,
                "durum":          durum_txt,
                "kapanis_operasyon": kapanis_op,
            })

    return {
        "tarih":   str(bugun_tr()),
        "subeler": sonuc,
        "tamamlanan": sum(1 for s in sonuc if s['sube_acik'] and s['ciro_girildi']),
        "toplam":     len(sonuc),
    }


class SubeAcilisModel(BaseModel):
    """Manuel şube açılış kaydı."""
    personel_id: Optional[str] = None
    aciklama: Optional[str] = None


class KasaKilitAcModel(BaseModel):
    """Şube paneli: personel_id + şirket geneli panel PIN (tüm şubelerde geçerli)."""
    personel_id: str
    pin: str


class PanelKullaniciPinGuncelle(MerkezPanelOnayBody):
    pin: str


class PersonelPanelYoneticiBody(MerkezPanelOnayBody):
    yonetici: bool = True


@router.post("/{sube_id}/kasa-kilit-ac")
def kasa_kilit_ac(sube_id: str, body: KasaKilitAcModel):
    """Günlük kasa kilidini personel + şirket geneli panel PIN ile aç (tüm şubelerde aynı PIN)."""
    pid = (body.personel_id or "").strip()
    pin = (body.pin or "").strip()
    if not pid:
        raise HTTPException(400, "personel_id gerekli")
    if len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "4 haneli PIN gerekli")
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        ku = dogrula_personel_panel_pin(cur, pid, pin)
        onay_ad = (ku.get("ad_soyad") or "").strip() or "—"
        tr_now = _now_tr()
        tarih_sistem = tr_now.strftime("%Y-%m-%d")
        saat_sistem = tr_now.strftime("%H:%M:%S")
        from operasyon_defter import operasyon_defter_ekle

        cur.execute(
            """
            SELECT k.sube_id, COALESCE(s.ad, k.sube_id) AS sube_adi
            FROM sube_kasa_gun_acma k
            LEFT JOIN subeler s ON s.id = k.sube_id
            WHERE k.personel_id=%s AND k.tarih=CURRENT_DATE AND k.sube_id<>%s
            LIMIT 1
            """,
            (pid, sube_id),
        )
        diger = cur.fetchone()
        if diger:
            raise HTTPException(
                409,
                f"Bu personel bugün başka şubede kasa açmış: {diger.get('sube_adi') or diger.get('sube_id')}",
            )

        cur.execute(
            "SELECT 1 FROM sube_kasa_gun_acma WHERE sube_id=%s AND tarih=CURRENT_DATE",
            (sube_id,),
        )
        if cur.fetchone():
            operasyon_defter_ekle(
                cur,
                sube_id,
                "KASA_KILIT_PIN_ONAY_IDEMPOTENT",
                (
                    f"PIN onayı tekrarlandı (idempotent) — personel={onay_ad} "
                    f"tarih={tarih_sistem} saat={saat_sistem}"
                ),
                personel_id=pid,
                personel_ad=onay_ad,
                bildirim_saati=saat_sistem,
            )
            return {
                "success": True,
                "idempotent": True,
                "mesaj": "Kasa kilidi bugün zaten açılmış.",
            }
        cur.execute(
            """
            INSERT INTO sube_kasa_gun_acma (sube_id, tarih, personel_id, panel_kullanici_id)
            VALUES (%s, CURRENT_DATE, %s, NULL)
            """,
            (sube_id, pid),
        )
        audit(
            cur,
            "sube_kasa_gun_acma",
            f"{sube_id}:{bugun_tr()}",
            "KASA_ACILDI",
        )
        operasyon_defter_ekle(
            cur,
            sube_id,
            "KASA_KILIT_PIN_ONAY",
            (
                f"Kasa kilidi PIN ile açıldı — personel={onay_ad} "
                f"tarih={tarih_sistem} saat={saat_sistem}"
            ),
            personel_id=pid,
            personel_ad=onay_ad,
            bildirim_saati=saat_sistem,
        )
    return {"success": True, "idempotent": False}


@router.get("/merkez/personel-panel-pin")
def merkez_personel_panel_pin_liste():
    """Tüm şubeler için geçerli personel panel PIN listesi (şube seçimi yok)."""
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT p.id, p.ad_soyad, p.sube_id, s.ad AS sube_adi, p.aktif,
                   COALESCE(p.panel_yonetici, FALSE) AS yonetici,
                   (p.panel_pin_hash IS NOT NULL AND TRIM(COALESCE(p.panel_pin_hash,'')) <> '') AS panel_pin_tanimli
            FROM personel p
            LEFT JOIN subeler s ON s.id = p.sube_id
            WHERE p.aktif = TRUE
            ORDER BY p.ad_soyad
            """
        )
        rows = [dict(x) for x in cur.fetchall()]
        for r in rows:
            r["yonetici"] = bool(r.get("yonetici"))
            r["panel_pin_tanimli"] = bool(r.get("panel_pin_tanimli"))
        return rows


@router.get("/merkez/{sube_id}/panel-pin-kullanicilar")
def merkez_panel_pin_kullanicilar_legacy(sube_id: str):
    """Legacy endpoint uyumluluğu: şube parametresi artık kullanılmıyor."""
    with db() as (conn, cur):
        return list_personel_panel_secim(cur)


@router.put(
    "/merkez/personel/{personel_id}/panel-pin",
    dependencies=[Depends(merkez_mutasyon_korumasi)],
)
def merkez_personel_panel_pin_guncelle(personel_id: str, body: PanelKullaniciPinGuncelle):
    """Personel panel PIN — tüm şube panellerinde aynı PIN ile geçerli olur."""
    p = (body.pin or "").strip()
    if len(p) != 4 or not p.isdigit():
        raise HTTPException(400, "4 haneli PIN gerekli")
    salt = uuid.uuid4().hex[:12]
    ph = panel_pin_hash(p, salt)
    with db() as (conn, cur):
        cur.execute(
            "SELECT id, ad_soyad, sube_id FROM personel WHERE id=%s",
            (personel_id,),
        )
        hedef = cur.fetchone()
        if not hedef:
            raise HTTPException(404, "Personel bulunamadı")
        hedef = dict(hedef)
        hedef_ad = (hedef.get("ad_soyad") or "").strip() or "—"
        sube_defter = (hedef.get("sube_id") or "").strip() or "sube-merkez"

        n_yon = count_personel_panel_yonetici(cur)
        onay_ad = ""
        if n_yon >= 1:
            _merkez_yonetici_onayla(cur, body)
            oid = (body.onaylayan_personel_id or "").strip()
            cur.execute("SELECT ad_soyad FROM personel WHERE id=%s", (oid,))
            oa = cur.fetchone()
            onay_ad = (dict(oa).get("ad_soyad") or "").strip() if oa else "—"

        cur.execute(
            """
            UPDATE personel
            SET panel_pin_salt=%s, panel_pin_hash=%s
            WHERE id=%s
            """,
            (salt, ph, personel_id),
        )
        audit(cur, "personel", personel_id, "PANEL_PIN_GUNCELLE")

        from operasyon_defter import operasyon_defter_ekle

        tr = _now_tr()
        saat = tr.strftime("%H:%M:%S")
        acik = (
            f"Merkez panel PIN güncellendi — hedef={hedef_ad}"
            + (f" — onaylayan={onay_ad}" if onay_ad else " — ilk kurulum (onaysız)")
        )
        operasyon_defter_ekle(
            cur,
            sube_defter,
            "MERKEZ_PANEL_PIN_DEGISTI",
            acik,
            personel_id=(body.onaylayan_personel_id or "").strip() or personel_id,
            personel_ad=onay_ad or hedef_ad,
            bildirim_saati=saat,
        )
    return {"success": True}


@router.put(
    "/merkez/personel/{personel_id}/panel-yonetici",
    dependencies=[Depends(merkez_mutasyon_korumasi)],
)
def merkez_personel_panel_yonetici(personel_id: str, body: PersonelPanelYoneticiBody):
    """Panel yöneticisi (personel) — şube panelinde başka personele PIN atayabilen rol."""
    yon = bool(body.yonetici)
    with db() as (conn, cur):
        cur.execute(
            "SELECT id, aktif, ad_soyad, sube_id FROM personel WHERE id=%s",
            (personel_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Personel bulunamadı")
        row = dict(row)
        hedef_ad = (row.get("ad_soyad") or "").strip() or "—"
        sube_defter = (row.get("sube_id") or "").strip() or "sube-merkez"

        n_yon = count_personel_panel_yonetici(cur)
        onay_ad = ""
        if n_yon >= 1:
            _merkez_yonetici_onayla(cur, body)
            oid = (body.onaylayan_personel_id or "").strip()
            cur.execute("SELECT ad_soyad FROM personel WHERE id=%s", (oid,))
            oa = cur.fetchone()
            onay_ad = (dict(oa).get("ad_soyad") or "").strip() if oa else "—"

        if not yon:
            cur.execute(
                """
                SELECT COUNT(*)::int AS c FROM personel
                WHERE aktif = TRUE AND COALESCE(panel_yonetici, FALSE) = TRUE AND id != %s
                """,
                (personel_id,),
            )
            if int(cur.fetchone()["c"]) < 1:
                raise HTTPException(400, "En az bir panel yöneticisi (personel) kalmalıdır.")
        cur.execute(
            "UPDATE personel SET panel_yonetici=%s WHERE id=%s",
            (yon, personel_id),
        )
        audit(cur, "personel", personel_id, "PANEL_YONETICI" if yon else "PANEL_YONETICI_KALDIR")

        from operasyon_defter import operasyon_defter_ekle

        tr = _now_tr()
        saat = tr.strftime("%H:%M:%S")
        acik = (
            f"Panel yöneticiliği={'evet' if yon else 'hayır'} — hedef={hedef_ad}"
            + (f" — onaylayan={onay_ad}" if onay_ad else " — ilk kurulum (onaysız)")
        )
        operasyon_defter_ekle(
            cur,
            sube_defter,
            "MERKEZ_PANEL_YONETICI_DEGISTI",
            acik,
            personel_id=(body.onaylayan_personel_id or "").strip() or personel_id,
            personel_ad=onay_ad or hedef_ad,
            bildirim_saati=saat,
        )
    return {"success": True, "yonetici": yon}


@router.post("/{sube_id}/acilis")
def sube_acilis_kaydet(sube_id: str, body: SubeAcilisModel = SubeAcilisModel()):
    """
    Şubeyi aç — gün başına tek aktif kayıt (durum=acildi).
    Saat geçmiş olsa bile açılış, bu kayıt olmadan tamamlanmış sayılmaz.
    """
    simdi = _now_tr()
    saat_str = simdi.strftime("%H:%M")
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        if not _bugun_kasa_acildi_mi(cur, sube_id):
            raise HTTPException(
                403,
                "Önce günlük kasa kilidini PIN ile açmalısınız.",
            )
        cur.execute("""
            SELECT personel_id, COALESCE(p.ad_soyad, '') AS ad_soyad
            FROM sube_kasa_gun_acma k
            LEFT JOIN personel p ON p.id = k.personel_id
            WHERE k.sube_id=%s AND k.tarih=CURRENT_DATE
            LIMIT 1
        """, (sube_id,))
        ka = cur.fetchone()
        pid = (body.personel_id or "").strip() or str((ka or {}).get("personel_id") or "").strip()
        if not pid:
            raise HTTPException(400, "Açılış için PIN onaylayan personel bulunamadı.")
        cur.execute("SELECT ad_soyad FROM personel WHERE id=%s", (pid,))
        pr = cur.fetchone()
        onay_ad = str((pr or {}).get("ad_soyad") or (ka or {}).get("ad_soyad") or "—").strip() or "—"

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
        diger_acilis = cur.fetchone()
        if diger_acilis:
            raise HTTPException(
                409,
                f"Bu personel bugün başka şubede açılış yapmış: {diger_acilis.get('sube_adi') or diger_acilis.get('sube_id')}",
            )

        cur.execute("""
            SELECT id FROM sube_acilis
            WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='acildi'
        """, (sube_id,))
        mevcut = cur.fetchone()
        if mevcut:
            return {
                "success": True,
                "idempotent": True,
                "id":         str(mevcut["id"]),
                "acilis_saati": saat_str,
                "mesaj":      "Bugün bu şube zaten açılmış kayıtlı.",
            }
        aid = str(uuid.uuid4())
        cur.execute("""
            INSERT INTO sube_acilis
                (id, sube_id, tarih, acilis_saati, personel_id, durum, aciklama)
            VALUES (%s, %s, CURRENT_DATE, %s, %s, 'acildi', %s)
        """, (
            aid,
            sube_id,
            saat_str,
            pid,
            (body.aciklama or f"Açılış onayı — {onay_ad} — {simdi.strftime('%Y-%m-%d %H:%M:%S')}"),
        ))
        audit(cur, "sube_acilis", aid, "ACILIS_PANEL")
        tarih_sistem = simdi.strftime("%Y-%m-%d")
        saat_sistem = simdi.strftime("%H:%M:%S")
        from operasyon_defter import operasyon_defter_ekle

        operasyon_defter_ekle(
            cur,
            sube_id,
            "ACILIS_PANEL_KAYIT",
            (
                f"Şube açılış kaydı — personel={onay_ad} "
                f"tarih={tarih_sistem} saat={saat_sistem} acilis_id={aid}"
            ),
            personel_id=pid,
            personel_ad=onay_ad,
            bildirim_saati=saat_sistem,
        )
    return {
        "success":       True,
        "id":            aid,
        "acilis_saati":  saat_str,
        "idempotent":    False,
    }


@router.get("/x-rapor/{kayit_id}/foto")
def x_rapor_foto_getir(kayit_id: str):
    """OCR için yüklenen fiş görüntüsü (denetim / kanıt)."""
    with db() as (conn, cur):
        cur.execute(
            "SELECT dosya_yolu, mime_type FROM x_rapor_kayit WHERE id=%s",
            (kayit_id,),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Kayıt bulunamadı")
    p = pathlib.Path(row["dosya_yolu"])
    if not p.is_file():
        raise HTTPException(404, "Dosya bulunamadı")
    return FileResponse(
        str(p),
        media_type=row.get("mime_type") or "image/jpeg",
        filename=p.name,
    )


@router.post("/{sube_id}/x-rapor-oku")
async def x_rapor_oku(
    sube_id: str,
    file: UploadFile = File(...),
    personel_id: Optional[str] = Form(None),
):
    """
    Yazarkasa X raporu fotoğrafından nakit / POS / online / toplam çıkarır.
    Görüntü diske yazılır, model cevabı DB'de saklanır (kanıt).
    """
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(
            503,
            "OPENAI_API_KEY ortam değişkeni tanımlı değil — OCR kullanılamaz.",
        )

    raw_bytes = await file.read()
    if len(raw_bytes) > _X_RAPOR_MAX_BYTES:
        raise HTTPException(413, "Dosya çok büyük (en fazla 8 MB)")

    mime = (file.content_type or "image/jpeg").split(";")[0].strip().lower()
    if not mime.startswith("image/"):
        raise HTTPException(400, "Sadece görüntü dosyası kabul edilir")

    ext = ".jpg"
    if "png" in mime:
        ext = ".png"
    elif "webp" in mime:
        ext = ".webp"
    elif "gif" in mime:
        ext = ".gif"

    rid = str(uuid.uuid4())
    sub_dir = _X_UPLOAD_ROOT / sube_id
    sub_dir.mkdir(parents=True, exist_ok=True)
    rel_path = sub_dir / f"{rid}{ext}"
    abs_path = pathlib.Path(rel_path).resolve()

    kasa_snap: Optional[float] = None
    ham_text = ""
    amounts = {"nakit": 0.0, "pos": 0.0, "online": 0.0, "toplam": 0.0}

    try:
        abs_path.write_bytes(raw_bytes)
        b64 = base64.b64encode(raw_bytes).decode("ascii")
        data_url = f"data:{mime};base64,{b64}"

        try:
            from openai import OpenAI
        except ImportError as e:
            raise HTTPException(503, "openai paketi yüklü değil: pip install openai") from e

        model = os.getenv("OPENAI_X_RAPOR_MODEL", "gpt-4o-mini")
        client = OpenAI(api_key=api_key)

        prompt = """Bu görüntü bir Türkiye yazarkasa X raporu veya günlük satış özeti olabilir.

Şu alanları mümkün olduğunca sayısal çıkar (yoksa 0):
- nakit (nakit satış / nakit tahsilat)
- pos (kredi kartı / POS)
- online (online ödeme / QR / havale satış vb.)
- toplam (rapordaki genel satış toplamı varsa; yoksa nakit+pos+online ile uyumlu bir toplam)

Sadece geçerli bir JSON nesnesi döndür. Başka metin, markdown veya açıklama yazma.
Örnek: {"nakit":10000,"pos":13000,"online":0,"toplam":23000}
"""

        resp = client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }
            ],
            max_tokens=400,
        )
        msg = resp.choices[0].message
        raw_content = msg.content
        if isinstance(raw_content, list):
            parts = []
            for c in raw_content:
                if isinstance(c, dict) and c.get("type") == "text":
                    parts.append(c.get("text") or "")
            ham_text = "\n".join(parts).strip()
        else:
            ham_text = (raw_content or "").strip()

        parsed = _x_parse_model_json(ham_text)
        if not isinstance(parsed, dict):
            raise ValueError("Model geçerli JSON nesnesi döndürmedi")
        amounts = _x_extract_amounts(parsed)

        with db() as (conn, cur):
            if not _bugun_kasa_acildi_mi(cur, sube_id):
                raise HTTPException(
                    403,
                    "Önce kasa kilidini PIN ile açmalısınız.",
                )
            if not _bugun_sube_acildi_mi(cur, sube_id):
                raise HTTPException(
                    403,
                    "Önce şubeyi açmalısınız — OCR yalnızca açılış sonrası kullanılabilir.",
                )
            _sube_getir(cur, sube_id)
            kasa_snap = float(kasa_bakiyesi(cur))

            cur.execute(
                """
                INSERT INTO x_rapor_kayit
                    (id, sube_id, tarih, personel_id, dosya_yolu, mime_type, ham_cevap,
                     nakit, pos, online, toplam_ocr, kasa_snapshot)
                VALUES (%s, %s, CURRENT_DATE, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    rid,
                    sube_id,
                    personel_id or None,
                    str(abs_path),
                    mime,
                    ham_text[:12000],
                    amounts["nakit"],
                    amounts["pos"],
                    amounts["online"],
                    amounts["toplam"],
                    kasa_snap,
                ),
            )
            audit(cur, "x_rapor_kayit", rid, "OCR_X_RAPOR")

        fark = abs(float(amounts["toplam"] or 0) - float(kasa_snap or 0))
        kasa_uyari = None
        if amounts["toplam"] > 0 and fark > max(500.0, 0.05 * float(amounts["toplam"])):
            kasa_uyari = (
                f"OCR toplamı ({amounts['toplam']:,.0f} ₺) ile güncel kasa ({kasa_snap:,.0f} ₺) "
                f"arasında belirgin fark var — değerleri kontrol edin."
            )

        return {
            "nakit":       amounts["nakit"],
            "pos":         amounts["pos"],
            "online":      amounts["online"],
            "toplam":      amounts["toplam"],
            "kayit_id":    rid,
            "foto_url":    f"/api/sube-panel/x-rapor/{rid}/foto",
            "kasa_bakiye": kasa_snap,
            "kasa_uyari":  kasa_uyari,
        }
    except HTTPException:
        if abs_path.is_file():
            try:
                abs_path.unlink()
            except OSError:
                pass
        raise
    except Exception as e:
        if abs_path.is_file():
            try:
                abs_path.unlink()
            except OSError:
                pass
        raise HTTPException(400, f"OCR işlenemedi: {e!s}") from e


def _build_sube_panel_payload(cur, sube_id: str) -> dict:
    """Şube panel tam JSON (CFO / tam yetki)."""
    sube = _sube_getir(cur, sube_id)
    ciro_girildi = _bugun_ciro_var_mi(cur, sube_id)
    taslak_row = _bugun_ciro_taslak_bekliyor(cur, sube_id)
    ciro_taslak_bekliyor = taslak_row is not None
    anlik_adet = _bugun_anlik_gider_sayisi(cur, sube_id)
    sube_acildi_mi = _bugun_sube_acildi_mi(cur, sube_id)
    kasa_acildi_mi = _bugun_kasa_acildi_mi(cur, sube_id)
    kasa_acma = _bugun_kasa_acma_kaydi(cur, sube_id)
    acilis_kaydi = _bugun_acilis_kaydi(cur, sube_id)

    cur.execute("""
        SELECT
            COALESCE(SUM(nakit), 0)  as nakit,
            COALESCE(SUM(pos), 0)    as pos,
            COALESCE(SUM(online), 0) as online,
            COALESCE(SUM(toplam), 0) as toplam
        FROM ciro
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='aktif'
    """, (sube_id,))
    ciro_ozet = dict(cur.fetchone())

    gorevler = _gorev_listesi_uret(
        sube,
        ciro_girildi,
        anlik_adet,
        sube_acildi_mi,
        ciro_taslak_bekliyor,
        kasa_acildi_mi=kasa_acildi_mi,
        kasa_acma_kaydi=kasa_acma,
    )
    panel_pin_kullanicilar = list_personel_panel_secim(cur)
    panel_yonetici_sayisi = count_personel_panel_yonetici(cur)
    tamamlanan = sum(1 for g in gorevler if g["tamamlandi"])

    # Kasa teslim alıcıları
    cur.execute(
        """
        SELECT id, ad, unvan
        FROM kasa_teslim_alici
        WHERE aktif=TRUE AND (sube_id=%s OR sube_id IS NULL)
        ORDER BY ad
        """,
        (sube_id,),
    )
    kasa_teslim_alicilari = [dict(r) for r in cur.fetchall()]

    from sube_operasyon import build_panel_operasyon_blob
    from sube_kapanis_dual import vardiya_devir_panel_blob

    operasyon = build_panel_operasyon_blob(cur, sube_id, sube)
    vardiya_devir = vardiya_devir_panel_blob(cur, sube_id)

    personel_operasyon_secim: list = []
    akt_op = operasyon.get("aktif") if isinstance(operasyon, dict) else None
    if (
        isinstance(akt_op, dict)
        and akt_op.get("tip") == "ACILIS"
        and akt_op.get("durum") in ("bekliyor", "gecikti")
    ):
        cur.execute(
            """
            SELECT id, ad_soyad
            FROM personel
            WHERE aktif = TRUE
            ORDER BY ad_soyad
            """
        )
        personel_operasyon_secim = [
            {"id": str(r["id"]), "ad": (r["ad_soyad"] or "").strip()}
            for r in cur.fetchall()
        ]

    kasa_kilitli = not kasa_acildi_mi
    panel_blok = kasa_kilitli or (not sube_acildi_mi)


    # Merkez mesajları — okunmamış önce
    cur.execute(
        """
        SELECT id, mesaj, oncelik, okundu, olusturma, ttl_saat
        FROM sube_merkez_mesaj
        WHERE sube_id=%s AND aktif=TRUE
          AND olusturma + (COALESCE(ttl_saat, 72) * INTERVAL '1 hour') > NOW()
        ORDER BY okundu ASC, olusturma DESC
        LIMIT 20
        """,
        (sube_id,),
    )
    merkez_mesajlar = []
    for mr in cur.fetchall():
        md = dict(mr)
        if md.get("olusturma"):
            md["olusturma"] = str(md["olusturma"])
        merkez_mesajlar.append(md)

    okunmamis_mesaj_var = any(not m.get("okundu") for m in merkez_mesajlar)

    sube_tipi = str(sube.get("sube_tipi") or "normal").strip().lower()
    if sube_tipi == "sevkiyat":
        sube_tipi = "depo"
    elif sube_tipi == "merkez":
        sube_tipi = "karma"

    return {
        "sube_id":        sube_id,
        "sube_adi":       sube["ad"],
        "sube_tipi":      sube_tipi,
        "acilis_saati":   sube.get("acilis_saati") or "09:00",
        "kapanis_saati":  sube.get("kapanis_saati") or "22:00",
        "tarih":          str(bugun_tr()),
        "kasa_kilitli":   kasa_kilitli,
        "kasa_acma":      kasa_acma,
        "sube_acik":      sube_acildi_mi,
        "panel_kilitli":  panel_blok,
        "panel_blok_asama": (
            "kasa" if kasa_kilitli else ("acilis" if not sube_acildi_mi else None)
        ),
        "panel_pin_kullanicilar": panel_pin_kullanicilar,
        "panel_yonetici_sayisi": panel_yonetici_sayisi,
        "kasa_teslim_alicilari": kasa_teslim_alicilari,
        "acilis_kaydi":   acilis_kaydi,
        "gorevler":       gorevler,
        "tamamlanan":     tamamlanan,
        "toplam_gorev":   len(gorevler),
        "ciro_girildi":   ciro_girildi,
        "ciro_taslak_bekliyor": ciro_taslak_bekliyor,
        "ciro_taslak":    taslak_row,
        "ciro_ozet":      {k: float(v) for k, v in ciro_ozet.items()},
        "anlik_gider_adet": anlik_adet,
        "operasyon":      operasyon,
        "vardiya_devir":  vardiya_devir,
        "personel_operasyon_secim": personel_operasyon_secim,
        "merkez_mesajlar": merkez_mesajlar,
        "okunmamis_mesaj_var": okunmamis_mesaj_var,
    }


def sube_personel_panel_public(payload: dict) -> dict:
    """
    Personel paneli: finansal sonuç / fark / detaylı vardiya nakitleri gösterilmez.
    """
    p = dict(payload)
    p.pop("ciro_ozet", None)
    p.pop("ciro_taslak", None)
    p.pop("anlik_gider_adet", None)
    vd = p.get("vardiya_devir")
    if isinstance(vd, dict):
        pk = vd.get("panel_kullanicilar")
        row = vd.get("vardiya_devir")
        vdur = None
        if isinstance(row, dict):
            vdur = row.get("durum")
        p["vardiya_devir"] = {
            "bilgi": "Nakit/POS/online tutarları özetlenmez; imza adımları panelde.",
            "vardiya_devir_pin_zorunlu": vd.get("vardiya_devir_pin_zorunlu"),
            "panel_kullanici_sayisi": len(pk) if isinstance(pk, list) else 0,
            "sabahci_zorunlu_id": vd.get("sabahci_zorunlu_id"),
            "vardiya_durum": vdur,
        }
    op = p.get("operasyon")
    if isinstance(op, dict):
        evs = op.get("events") or []
        akt = op.get("aktif")
        akt_kisa = None
        if isinstance(akt, dict):
            akt_kisa = {
                k: akt.get(k)
                for k in (
                    "id",
                    "tip",
                    "durum",
                    "sistem_slot_ts",
                    "son_teslim_ts",
                    "cevap_ts",
                    "personel_ad",
                    "personel_id",
                    "alarm_sayisi",
                )
            }
            # KONTROL formu (bardak_only / kasa_only / full) — rastgele slot meta verisini sızdırmadan yalnızca mod
            if str(akt.get("tip") or "").upper() == "KONTROL":
                raw_m = akt.get("meta")
                dm = None
                if isinstance(raw_m, dict):
                    dm = raw_m.get("denetim_mod")
                elif isinstance(raw_m, str) and raw_m.strip():
                    try:
                        md = json.loads(raw_m)
                        if isinstance(md, dict):
                            dm = md.get("denetim_mod")
                    except Exception:
                        dm = None
                if dm:
                    akt_kisa["meta"] = {"denetim_mod": str(dm).strip()}
        p["operasyon"] = {
            "sunucu_saati": op.get("sunucu_saati"),
            "sunucu_iso": op.get("sunucu_iso"),
            "aktif": akt_kisa,
            "aktif_gecikme_dk": op.get("aktif_gecikme_dk"),
            "aktif_kritik": op.get("aktif_kritik"),
            "aktif_suphe": op.get("aktif_suphe"),
            "alarm_politikasi": op.get("alarm_politikasi"),
            "events_ozet": [
                {
                    "tip": e.get("tip"),
                    "durum": e.get("durum"),
                    "sistem_slot_ts": e.get("sistem_slot_ts"),
                    "cevap_ts": e.get("cevap_ts"),
                    "personel_ad": e.get("personel_ad"),
                    "personel_id": e.get("personel_id"),
                }
                for e in evs
            ],
            "esikler": op.get("esikler"),
        }
    p["uyari"] = (
        "Bu ekranda yalnızca günlük görev ve operasyon özeti yer alır; "
        "ciro toplamları ve kasa farkı burada gösterilmez."
    )
    return p


@router.get("/{sube_id}")
def sube_panel_getir(sube_id: str):
    with db() as (conn, cur):
        return _build_sube_panel_payload(cur, sube_id)


class SubeCiroModel(BaseModel):
    nakit:       float = 0
    pos:         float = 0
    online:      float = 0
    aciklama:    Optional[str] = None
    force:       bool = False
    personel_id: str
    pin:         str


@router.post("/{sube_id}/ciro")
def sube_ciro_gir(sube_id: str, body: SubeCiroModel):
    """
    Personel ciro girişi — doğrudan ciroya yazılmaz; ciro_taslak (bekliyor) oluşturur.
    Merkez «Ciro onayı» ekranından onaylanınca ciro + kasa işlenir.
    Panel PIN zorunlu; gönderen adı ve bildirim saati merkez ekranına yazılır.
    """
    nakit = float(body.nakit or 0)
    pos = float(body.pos or 0)
    online = float(body.online or 0)
    toplam = nakit + pos + online

    if toplam <= 0:
        raise HTTPException(400, "En az bir tutar girilmeli")

    pid_in = (body.personel_id or "").strip()
    pin = (body.pin or "").replace(" ", "")
    if not pid_in:
        raise HTTPException(400, "personel_id gerekli")
    if len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "4 haneli panel PIN gerekli")

    with db() as (conn, cur):
        sube = _sube_getir(cur, sube_id)
        if not _bugun_kasa_acildi_mi(cur, sube_id):
            raise HTTPException(
                403,
                "Önce günlük kasa kilidini PIN ile açmalısınız.",
            )
        if not _bugun_sube_acildi_mi(cur, sube_id):
            raise HTTPException(
                403,
                "Önce şubeyi açmalısınız — panelde «Şubeyi Aç» ile kayıt oluşturun.",
            )

        ku = dogrula_personel_panel_pin(cur, pid_in, pin)
        onay_ad = (ku.get("ad_soyad") or "").strip() or "—"
        pid_panel = str(ku.get("id") or "").strip() or pid_in
        tr_now = _now_tr()
        saat_sistem = tr_now.strftime("%H:%M:%S")

        if _bugun_ciro_var_mi(cur, sube_id):
            raise HTTPException(
                400,
                f"Bugün {sube['ad']} için onaylı ciro zaten kayıtlı. "
                "Düzeltme için merkez ile iletişime geçin.",
            )

        mevcut_taslak = _bugun_ciro_taslak_bekliyor(cur, sube_id)
        if mevcut_taslak and not body.force:
            return {
                "warning": True,
                "taslak_id": mevcut_taslak["id"],
                "mesaj": (
                    f"Bugün {sube['ad']} için bekleyen bir ciro taslağınız var. "
                    "Tutarları güncellemek için «Yine de Kaydet» ile yeniden gönderin."
                ),
            }

        if mevcut_taslak and body.force:
            cur.execute(
                "DELETE FROM ciro_taslak WHERE id=%s AND durum='bekliyor'",
                (mevcut_taslak["id"],),
            )

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
                body.aciklama or "Şube panelinden",
                pid_panel,
                onay_ad,
                saat_sistem,
                pid_panel,
            ),
        )
        audit(cur, "ciro_taslak", tid, "TASLAK_BEKLIYOR")
        from operasyon_defter import operasyon_defter_ekle
        operasyon_defter_ekle(
            cur,
            sube_id,
            "CIRO_TASLAK_PIN",
            (
                f"Ciro taslağı merkeze gönderildi — personel={onay_ad} "
                f"saat={saat_sistem} nakit={nakit:.2f} pos={pos:.2f} online={online:.2f}"
            ),
            personel_id=pid_panel,
            personel_ad=onay_ad,
            bildirim_saati=saat_sistem,
        )

    return {
        "success":     True,
        "taslak_id":   tid,
        "bekliyor":    True,
        "mesaj":       "Ciro merkez onayına gönderildi. Onay sonrası sisteme işlenir.",
    }


class SubeAnlikGiderModel(BaseModel):
    kategori: str
    tutar: float
    aciklama: Optional[str] = None
    personel_id: str
    pin: str
    fis_gonderildi: bool = False


@router.post("/{sube_id}/anlik-gider")
def sube_anlik_gider_gir(sube_id: str, body: SubeAnlikGiderModel):
    if body.tutar <= 0:
        raise HTTPException(400, "Tutar sıfırdan büyük olmalı")

    pid_in = (body.personel_id or "").strip()
    pin = (body.pin or "").replace(" ", "")
    if not pid_in:
        raise HTTPException(400, "personel_id gerekli")
    if len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "4 haneli panel PIN gerekli")

    with db() as (conn, cur):
        sube = _sube_getir(cur, sube_id)
        if not _bugun_kasa_acildi_mi(cur, sube_id):
            raise HTTPException(
                403,
                "Önce günlük kasa kilidini PIN ile açmalısınız.",
            )
        if not _bugun_sube_acildi_mi(cur, sube_id):
            raise HTTPException(
                403,
                "Önce şubeyi açmalısınız — panelde «Şubeyi Aç» ile kayıt oluşturun.",
            )

        ku = dogrula_personel_panel_pin(cur, pid_in, pin)
        onay_ad = (ku.get("ad_soyad") or "").strip() or "—"
        pid_panel = str(ku.get("id") or "").strip() or pid_in

        gid = str(uuid.uuid4())
        acik = (body.aciklama or "").strip() or body.kategori
        cur.execute(
            """
            INSERT INTO anlik_giderler
                (id, tarih, kategori, tutar, aciklama, sube, odeme_yontemi, durum, personel_id,
                 fis_gonderildi, fis_kontrol_durumu)
            VALUES (%s, CURRENT_DATE, %s, %s, %s, %s, 'nakit', 'onay_bekliyor', %s,
                    %s, 'bekliyor')
            """,
            (gid, body.kategori, body.tutar, acik, sube_id, pid_panel, bool(body.fis_gonderildi)),
        )
        onay_ekle(
            cur,
            "ANLIK_GIDER",
            "anlik_giderler",
            gid,
            f"Şube anlık gider (bekliyor): {acik} — {sube.get('ad') or sube_id} — {onay_ad}",
            float(body.tutar),
            bugun_tr(),
        )
        audit(cur, "anlik_giderler", gid, "INSERT_PANEL_ONAY_BEKLIYOR")
        from operasyon_defter import operasyon_defter_ekle

        tr_now = _now_tr()
        saat_sistem = tr_now.strftime("%H:%M:%S")
        operasyon_defter_ekle(
            cur,
            sube_id,
            "ANLIK_GIDER_ONAY_BEKLIYOR",
            (
                f"Anlık gider merkez onayına gönderildi — tutar={body.tutar} kategori={body.kategori} "
                f"personel={onay_ad} anlik_id={gid}"
            ),
            personel_id=pid_panel,
            personel_ad=onay_ad,
            bildirim_saati=saat_sistem,
        )

    return {
        "success": True,
        "id": gid,
        "bekliyor": True,
        "mesaj": "Anlık gider merkez onayına iletildi. Onay sonrası kasaya işlenir.",
    }


class SubeMerkezNotBody(BaseModel):
    metin: str
    personel_id: str
    pin: str


@router.post("/{sube_id}/merkez-not")
def sube_merkez_not_gonder(sube_id: str, body: SubeMerkezNotBody):
    """Şube personeli: iade, sorun vb. metin — operasyon merkezinde listelenir."""
    metin = (body.metin or "").strip()
    if len(metin) < 3:
        raise HTTPException(400, "Not metni en az 3 karakter olmalı")
    if len(metin) > 4000:
        raise HTTPException(400, "Not çok uzun (en fazla 4000 karakter)")
    pid_in = (body.personel_id or "").strip()
    pin = (body.pin or "").replace(" ", "")
    if not pid_in:
        raise HTTPException(400, "personel_id gerekli")
    if len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "4 haneli panel PIN gerekli")

    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        if not _bugun_kasa_acildi_mi(cur, sube_id):
            raise HTTPException(403, "Önce günlük kasa kilidini PIN ile açmalısınız.")
        ku = dogrula_personel_panel_pin(cur, pid_in, pin)
        onay_ad = (ku.get("ad_soyad") or "").strip() or "—"
        pid_panel = str(ku.get("id") or "").strip() or pid_in
        nid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO sube_merkez_not (id, sube_id, metin, personel_id, personel_ad)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (nid, sube_id, metin, pid_panel, onay_ad),
        )
        audit(cur, "sube_merkez_not", nid, "INSERT")
        from operasyon_defter import operasyon_defter_ekle

        tr_now = _now_tr()
        saat_sistem = tr_now.strftime("%H:%M:%S")
        operasyon_defter_ekle(
            cur,
            sube_id,
            "SUBE_MERKEZ_NOT",
            f"Merkez notu — personel={onay_ad} — {(metin[:200] + '…') if len(metin) > 200 else metin}",
            personel_id=pid_panel,
            personel_ad=onay_ad,
            bildirim_saati=saat_sistem,
        )

    return {"success": True, "id": nid}


class SubeUrunStokEkleBody(BaseModel):
    """Şubeye gelen bardak/ürün/sarf (pozitif delta). PIN ile imzalanır; deftere URUN_STOK_EKLE."""

    personel_id: str
    pin: str
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
    not_aciklama: Optional[str] = None


@router.post("/{sube_id}/urun-stok-ekle")
def sube_urun_stok_ekle(sube_id: str, body: SubeUrunStokEkleBody):
    from operasyon_stok_motor import normalize_delta_body

    pid_in = (body.personel_id or "").strip()
    pin = (body.pin or "").replace(" ", "")
    if not pid_in:
        raise HTTPException(400, "personel_id gerekli")
    if len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "4 haneli panel PIN gerekli")
    try:
        delta = normalize_delta_body(body.model_dump())
    except ValueError as e:
        raise HTTPException(400, str(e))

    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        if not _bugun_kasa_acildi_mi(cur, sube_id):
            raise HTTPException(403, "Önce günlük kasa kilidini PIN ile açmalısınız.")
        if not _bugun_sube_acildi_mi(cur, sube_id):
            raise HTTPException(403, "Önce şubeyi açmalısınız.")
        ku = dogrula_personel_panel_pin(cur, pid_in, pin)
        onay_ad = (ku.get("ad_soyad") or "").strip() or "—"
        pid_panel = str(ku.get("id") or "").strip() or pid_in
        from operasyon_defter import operasyon_defter_ekle
        import json as _json

        tr_now = _now_tr()
        saat_sistem = tr_now.strftime("%H:%M:%S")
        payload = _json.dumps({"delta": delta}, ensure_ascii=False, separators=(",", ":"))
        acik = "URUN_STOK_JSON:" + payload
        if (body.not_aciklama or "").strip():
            acik += " | " + (body.not_aciklama or "").strip()[:400]
        rid = operasyon_defter_ekle(
            cur,
            sube_id,
            "URUN_STOK_EKLE",
            acik,
            personel_id=pid_panel,
            personel_ad=onay_ad,
            bildirim_saati=saat_sistem,
        )
        audit(cur, "operasyon_defter", rid, "URUN_STOK_EKLE")

    return {"success": True, "defter_id": rid, "delta": delta}


# ─────────────────────────────────────────────────────────────
# SEVK — Depoya teslim alınan ürün (potansiyel stok)
# ─────────────────────────────────────────────────────────────

class SubeSevkBody(BaseModel):
    """Tedarikçiden/depodan gelen ürün teslim alımı. Aktif stoka girmez; SEVK defterine yazılır."""
    personel_id: str
    pin: str
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
    tedarikci_id: Optional[str] = None
    tedarikci: Optional[str] = None
    kalemler: Optional[List[Dict[str, Any]]] = None
    siparis_talep_id: Optional[str] = None
    teslim_durumu: str = "tam_geldi"  # tam_geldi | eksik_var
    eksik_kategori: Optional[str] = None  # sipariste_vardi | sipariste_yoktu
    teslim_aciklama: Optional[str] = None
    eksik_aciklama: Optional[str] = None
    not_aciklama: Optional[str] = None


def _stok_kalemleri_temizle(kalemler: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for k in (kalemler or []):
        if not isinstance(k, dict):
            continue
        urun_ad = str(k.get("urun_ad") or "").strip()
        kategori_id = str(k.get("kategori_id") or "").strip()
        urun_id = str(k.get("urun_id") or "").strip()
        try:
            adet = int(k.get("adet") or 0)
        except (TypeError, ValueError):
            adet = 0
        if not urun_ad or adet <= 0:
            continue
        out.append(
            {
                "kategori_id": kategori_id,
                "urun_id": urun_id,
                "urun_ad": urun_ad,
                "adet": adet,
            }
        )
    return out


@router.post("/{sube_id}/urun-sevk")
def sube_urun_sevk(sube_id: str, body: SubeSevkBody):
    """
    Depoya/şubeye teslim alınan ürün kaydı (SEVK = potansiyel stok).
    Aktif stok sayımını değiştirmez — yalnızca deftere URUN_SEVK etiketiyle yazılır.
    Merkez bu kaydı sevk listesinde izler.
    """
    from operasyon_stok_motor import STOK_KEYS, normalize_delta_body, _stok_key_from_urun_ad

    pid_in = (body.personel_id or "").strip()
    pin = (body.pin or "").replace(" ", "")
    if not pid_in:
        raise HTTPException(400, "personel_id gerekli")
    if len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "4 haneli panel PIN gerekli")
    teslim_durumu = (body.teslim_durumu or "").strip().lower()
    if teslim_durumu not in ("tam_geldi", "eksik_var"):
        raise HTTPException(400, "teslim_durumu: tam_geldi | eksik_var")
    teslim_acik = (body.teslim_aciklama or "").strip()
    if len(teslim_acik) < 3:
        raise HTTPException(400, "Teslim açıklaması zorunlu (en az 3 karakter)")
    eksik_kat = (body.eksik_kategori or "").strip().lower() or None
    eksik_acik = (body.eksik_aciklama or "").strip() or None
    if teslim_durumu == "eksik_var":
        if eksik_kat not in ("sipariste_vardi", "sipariste_yoktu"):
            raise HTTPException(400, "eksik_kategori: sipariste_vardi | sipariste_yoktu")
        if not eksik_acik or len(eksik_acik) < 3:
            raise HTTPException(400, "Eksik ürün açıklaması zorunlu (gelmeyen ürünleri yazın)")
    else:
        eksik_kat = None
        eksik_acik = None

    delta_raw = body.model_dump()
    kalemler = _stok_kalemleri_temizle(delta_raw.get("kalemler"))
    try:
        delta = normalize_delta_body(delta_raw)
    except ValueError:
        delta = {
            "bardak_kucuk": 0,
            "bardak_buyuk": 0,
            "bardak_plastik": 0,
            "su_adet": 0,
            "redbull_adet": 0,
            "soda_adet": 0,
            "cookie_adet": 0,
            "pasta_adet": 0,
        }
    if sum(int(v or 0) for v in delta.values()) <= 0 and not kalemler:
        raise HTTPException(400, "En az bir stok kaleminde pozitif adet girin")

    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        if not _bugun_kasa_acildi_mi(cur, sube_id):
            raise HTTPException(403, "Önce günlük kasa kilidini PIN ile açmalısınız.")
        ku = dogrula_personel_panel_pin(cur, pid_in, pin)
        onay_ad = (ku.get("ad_soyad") or "").strip() or "—"
        pid_panel = str(ku.get("id") or "").strip() or pid_in

        from operasyon_defter import operasyon_defter_ekle
        import json as _json

        tr_now = _now_tr()
        saat_sistem = tr_now.strftime("%H:%M:%S")

        tedarikci_id = (body.tedarikci_id or "").strip()
        tedarikci_ad = ""
        if tedarikci_id:
            cur.execute(
                "SELECT id, ad FROM tedarikciler WHERE id=%s AND aktif=TRUE",
                (tedarikci_id,),
            )
            trw = cur.fetchone()
            if not trw:
                raise HTTPException(400, "Geçerli bir tedarikçi seçin")
            tedarikci_id = str(dict(trw)["id"])
            tedarikci_ad = (dict(trw).get("ad") or "").strip()
        else:
            # Geriye dönük uyumluluk: id gelmezse ad ile eşleştir.
            tedarikci_ad_in = (body.tedarikci or "").strip()
            if not tedarikci_ad_in:
                raise HTTPException(400, "Tedarikçi seçimi zorunlu")
            cur.execute(
                """
                SELECT id, ad
                FROM tedarikciler
                WHERE aktif=TRUE AND LOWER(TRIM(ad)) = LOWER(TRIM(%s))
                LIMIT 1
                """,
                (tedarikci_ad_in,),
            )
            trw = cur.fetchone()
            if not trw:
                raise HTTPException(400, "Geçerli bir tedarikçi seçin")
            tedarikci_id = str(dict(trw)["id"])
            tedarikci_ad = (dict(trw).get("ad") or "").strip()

        payload_obj = {
            "delta": delta,
            "kalemler": kalemler,
            "tedarikci_id": tedarikci_id,
            "tedarikci": tedarikci_ad,
            "teslim_durumu": teslim_durumu,
            "eksik_kategori": eksik_kat,
            "teslim_aciklama": teslim_acik,
            "eksik_aciklama": eksik_acik,
        }
        payload = _json.dumps(payload_obj, ensure_ascii=False, separators=(",", ":"))
        acik = "URUN_SEVK_JSON:" + payload
        acik += " | " + teslim_acik[:400]
        if eksik_acik:
            acik += " | EKSİK: " + eksik_acik[:400]
        elif (body.not_aciklama or "").strip():
            acik += " | " + (body.not_aciklama or "").strip()[:400]

        rid = operasyon_defter_ekle(
            cur,
            sube_id,
            "URUN_SEVK",
            acik,
            personel_id=pid_panel,
            personel_ad=onay_ad,
            bildirim_saati=saat_sistem,
        )
        audit(cur, "operasyon_defter", rid, "URUN_SEVK")

        siparis_talep_id = (body.siparis_talep_id or "").strip() or None
        if siparis_talep_id:
            cur.execute(
                """
                SELECT id, durum
                FROM siparis_talep
                WHERE id=%s AND sube_id=%s
                LIMIT 1
                """,
                (siparis_talep_id, sube_id),
            )
            _st = cur.fetchone()
            if not _st:
                raise HTTPException(400, "Geçersiz siparis_talep_id (şube ile eşleşmiyor)")
            st = str(dict(_st).get("durum") or "")
            if st not in ("hazirlaniyor", "gonderildi", "bekliyor"):
                raise HTTPException(409, "Sipariş talebi sevkiyat/teslim akışına uygun değil")
            cur.execute(
                """
                UPDATE siparis_talep
                SET durum='teslim_edildi',
                    sevkiyat_durumu='teslim_edildi',
                    sevkiyat_durum='teslim_edildi',
                    sevkiyat_ts=NOW()
                WHERE id=%s
                """,
                (siparis_talep_id,),
            )
        else:
            cur.execute(
                """
                SELECT id
                FROM siparis_talep
                WHERE sube_id=%s AND tarih=CURRENT_DATE
                  AND durum IN ('gonderildi','hazirlaniyor','bekliyor')
                  AND COALESCE(NULLIF(TRIM(sevkiyat_durumu), ''), sevkiyat_durum, 'bekliyor')
                      IN ('gonderildi', 'kismi_hazirlandi', 'depoda_hazirlaniyor', 'hazirlaniyor', 'bekliyor')
                ORDER BY
                  CASE durum
                    WHEN 'gonderildi' THEN 0
                    WHEN 'hazirlaniyor' THEN 1
                    ELSE 2
                  END,
                  CASE
                    WHEN COALESCE(NULLIF(TRIM(sevkiyat_durumu), ''), sevkiyat_durum, 'bekliyor')='gonderildi' THEN 0
                    WHEN COALESCE(NULLIF(TRIM(sevkiyat_durumu), ''), sevkiyat_durum, 'bekliyor')='kismi_hazirlandi' THEN 1
                    ELSE 2
                  END,
                  olusturma DESC NULLS LAST
                LIMIT 1
                """,
                (sube_id,),
            )
            rw = cur.fetchone()
            siparis_talep_id = str((rw or {}).get("id") or "") or None

        sevk_kalemleri = {k: max(0, int(delta.get(k) or 0)) for k in STOK_KEYS}
        if sum(sevk_kalemleri.values()) <= 0 and kalemler:
            for it in kalemler:
                if not isinstance(it, dict):
                    continue
                key = _stok_key_from_urun_ad(it.get("urun_ad"))
                if not key:
                    continue
                try:
                    sevk_kalemleri[key] = sevk_kalemleri.get(key, 0) + max(0, int(it.get("adet") or 0))
                except (TypeError, ValueError):
                    continue

        for kalem_kodu, adet in sevk_kalemleri.items():
            adet_i = int(adet or 0)
            if adet_i <= 0:
                continue
            cur.execute(
                """
                INSERT INTO merkez_stok_sevk
                    (id, sube_id, kalem_kodu, adet, siparis_talep_id, tarih)
                VALUES
                    (%s, %s, %s, %s, %s, CURRENT_DATE)
                """,
                (str(uuid.uuid4()), sube_id, str(kalem_kodu), adet_i, siparis_talep_id),
            )

        if teslim_durumu == "eksik_var":
            cur.execute(
                """
                SELECT id, personel_id, personel_ad
                FROM siparis_talep
                WHERE sube_id=%s AND tarih=CURRENT_DATE
                ORDER BY olusturma DESC
                LIMIT 1
                """,
                (sube_id,),
            )
            sr = cur.fetchone()
            sip_tid = None
            sip_pid = None
            sip_pad = None
            if sr:
                sd = dict(sr)
                sip_tid = sd.get("id")
                sip_pid = sd.get("personel_id")
                sip_pad = sd.get("personel_ad")
            cur.execute(
                """
                INSERT INTO siparis_sevk_eksik
                    (sube_id, tarih, tedarikci_id, tedarikci_ad, teslim_durumu,
                     eksik_kategori, eksik_aciklama, siparis_talep_id, siparis_personel_id,
                     siparis_personel_ad, bildiren_personel_id, bildiren_personel_ad)
                VALUES
                    (%s, CURRENT_DATE, %s, %s, %s,
                     %s, %s, %s, %s,
                     %s, %s, %s)
                """,
                (
                    sube_id,
                    tedarikci_id or None,
                    tedarikci_ad or None,
                    teslim_durumu,
                    eksik_kat,
                    eksik_acik,
                    sip_tid,
                    sip_pid,
                    sip_pad,
                    pid_panel,
                    onay_ad,
                ),
            )

    return {"success": True, "defter_id": rid, "delta": delta, "kalemler": kalemler, "tip": "SEVK"}


# ─────────────────────────────────────────────────────────────
# ÜRÜN AÇ — Depodan aktif kullanıma alınan ürün
# ─────────────────────────────────────────────────────────────

class SubeUrunAcBody(BaseModel):
    """Depodan aktif stoka açılan ürün. Teorik stok hesabına dahil edilir."""
    personel_id: str
    pin: str
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
    kalemler: Optional[List[Dict[str, Any]]] = None
    not_aciklama: Optional[str] = None


@router.post("/{sube_id}/urun-ac")
def sube_urun_ac(sube_id: str, body: SubeUrunAcBody):
    """
    Depodan aktif kullanıma açılan ürün (URUN_AC).
    Bu kayıt teorik stok hesabına girer: açılış + URUN_STOK_EKLE + URUN_AC = beklenen stok.
    """
    from operasyon_stok_motor import normalize_delta_body

    pid_in = (body.personel_id or "").strip()
    pin = (body.pin or "").replace(" ", "")
    if not pid_in:
        raise HTTPException(400, "personel_id gerekli")
    if len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "4 haneli panel PIN gerekli")

    body_raw = body.model_dump()
    kalemler = _stok_kalemleri_temizle(body_raw.get("kalemler"))
    try:
        delta = normalize_delta_body(body_raw)
    except ValueError:
        delta = {
            "bardak_kucuk": 0,
            "bardak_buyuk": 0,
            "bardak_plastik": 0,
            "su_adet": 0,
            "redbull_adet": 0,
            "soda_adet": 0,
            "cookie_adet": 0,
            "pasta_adet": 0,
        }
    if sum(int(v or 0) for v in delta.values()) <= 0 and not kalemler:
        raise HTTPException(400, "En az bir stok kaleminde pozitif adet girin")

    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        if not _bugun_kasa_acildi_mi(cur, sube_id):
            raise HTTPException(403, "Önce günlük kasa kilidini PIN ile açmalısınız.")
        if not _bugun_sube_acildi_mi(cur, sube_id):
            raise HTTPException(403, "Önce şubeyi açmalısınız.")
        ku = dogrula_personel_panel_pin(cur, pid_in, pin)
        onay_ad = (ku.get("ad_soyad") or "").strip() or "—"
        pid_panel = str(ku.get("id") or "").strip() or pid_in

        from operasyon_defter import operasyon_defter_ekle
        import json as _json

        tr_now = _now_tr()
        saat_sistem = tr_now.strftime("%H:%M:%S")
        payload = _json.dumps({"delta": delta, "kalemler": kalemler}, ensure_ascii=False, separators=(",", ":"))
        acik = "URUN_AC_JSON:" + payload
        if (body.not_aciklama or "").strip():
            acik += " | " + (body.not_aciklama or "").strip()[:400]

        rid = operasyon_defter_ekle(
            cur,
            sube_id,
            "URUN_AC",
            acik,
            personel_id=pid_panel,
            personel_ad=onay_ad,
            bildirim_saati=saat_sistem,
        )
        audit(cur, "operasyon_defter", rid, "URUN_AC")

    return {"success": True, "defter_id": rid, "delta": delta, "kalemler": kalemler, "tip": "URUN_AC"}


# ─────────────────────────────────────────────────────────────
# MERKEZ MESAJI — Push mesaj okuma ve onaylama
# ─────────────────────────────────────────────────────────────

@router.get("/{sube_id}/merkez-mesajlari")
def sube_merkez_mesajlari_getir(sube_id: str):
    """Şubeye gönderilmiş, okunmamış merkez mesajlarını listele."""
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        cur.execute(
            """
            SELECT id, mesaj, olusturma, okundu, okundu_ts, oncelik, ttl_saat
            FROM sube_merkez_mesaj
            WHERE sube_id=%s AND aktif=TRUE
              AND olusturma + (COALESCE(ttl_saat, 72) * INTERVAL '1 hour') > NOW()
            ORDER BY olusturma DESC
            LIMIT 50
            """,
            (sube_id,),
        )
        rows = []
        for r in cur.fetchall():
            d = dict(r)
            for k in ("olusturma", "okundu_ts"):
                if d.get(k):
                    d[k] = str(d[k])
            rows.append(d)
    return {"mesajlar": rows, "okunmamis": sum(1 for r in rows if not r.get("okundu"))}


class MesajOkuBody(BaseModel):
    personel_id: str
    pin: str


@router.post("/{sube_id}/merkez-mesaj/{mesaj_id}/oku")
def sube_merkez_mesaj_oku(sube_id: str, mesaj_id: str, body: MesajOkuBody):
    """Personel mesajı PIN ile onaylar → okundu işaretlenir, deftere yazılır."""
    pid_in = (body.personel_id or "").strip()
    pin = (body.pin or "").replace(" ", "")
    if not pid_in or len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "personel_id ve 4 haneli PIN gerekli")

    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        ku = dogrula_personel_panel_pin(cur, pid_in, pin)
        onay_ad = (ku.get("ad_soyad") or "").strip() or "—"
        pid_panel = str(ku.get("id") or "").strip() or pid_in

        cur.execute(
            "SELECT id, mesaj, okundu FROM sube_merkez_mesaj WHERE id=%s AND sube_id=%s",
            (mesaj_id, sube_id),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Mesaj bulunamadı")
        row = dict(row)

        cur.execute(
            """
            UPDATE sube_merkez_mesaj
            SET okundu=TRUE, okundu_ts=NOW(), okuyan_personel_id=%s
            WHERE id=%s
            """,
            (pid_panel, mesaj_id),
        )
        audit(cur, "sube_merkez_mesaj", mesaj_id, "OKUNDU")

        from operasyon_defter import operasyon_defter_ekle
        tr_now = _now_tr()
        saat = tr_now.strftime("%H:%M:%S")
        operasyon_defter_ekle(
            cur, sube_id, "MERKEZ_MESAJ_OKUNDU",
            f"Merkez mesajı okundu — personel={onay_ad} mesaj_id={mesaj_id}",
            personel_id=pid_panel, personel_ad=onay_ad, bildirim_saati=saat,
        )

    return {"success": True, "okundu": True}


class SiparisOzelTalepBody(BaseModel):
    """Katalogda olmayan ürün — merkez onayından sonra kataloga alınır veya tek seferlik siparişe döner."""

    urun_adi: str
    kategori_kod: str
    adet: int = 1
    not_aciklama: Optional[str] = None
    personel_id: str
    pin: str


class SiparisOnayKalem(BaseModel):
    kategori_id: str
    urun_id: str
    urun_ad: str
    adet: int


class SiparisOnayBody(BaseModel):
    kalemler: List[SiparisOnayKalem]
    personel_id: str
    pin: str
    not_aciklama: Optional[str] = None


def _siparis_katalog_getir(cur) -> List[Dict[str, Any]]:
    cur.execute(
        """
        SELECT id, kod, ad, emoji, sira
        FROM siparis_kategori
        WHERE aktif = TRUE
        ORDER BY sira ASC, ad ASC
        """
    )
    kats = [dict(r) for r in cur.fetchall()]
    out: List[Dict[str, Any]] = []
    for k in kats:
        cur.execute(
            """
            SELECT id, ad, aktif, sira
            FROM siparis_urun
            WHERE kategori_id=%s
            ORDER BY sira ASC, ad ASC
            """,
            (k["id"],),
        )
        items = [
            {
                "id": str(x["id"]),
                "ad": x["ad"],
                "aktif": bool(x["aktif"]),
            }
            for x in cur.fetchall()
        ]
        out.append(
            {
                "id": str(k["kod"]),
                "db_kategori_id": str(k["id"]),
                "label": f"{(k.get('emoji') or '').strip()} {k['ad']}".strip(),
                "ad": k["ad"],
                "emoji": k.get("emoji"),
                "items": items,
            }
        )
    return out


@router.get("/{sube_id}/siparis-katalog")
def sube_siparis_katalog_getir(sube_id: str):
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        return {"kategoriler": _siparis_katalog_getir(cur)}


@router.get("/{sube_id}/siparis-ozel-liste")
def sube_siparis_ozel_liste(sube_id: str, limit: int = 40):
    lim = max(1, min(200, int(limit)))
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        cur.execute(
            """
            SELECT id, tarih, urun_adi, kategori_kod, adet, not_aciklama, durum,
                   bildirim_saati, olusturma, onaylayan_not, iliskili_talep_id
            FROM siparis_ozel_talep
            WHERE sube_id=%s
            ORDER BY olusturma DESC
            LIMIT %s
            """,
            (sube_id, lim),
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


@router.get("/{sube_id}/siparis-bekleyen-liste")
def sube_siparis_bekleyen_liste(sube_id: str, limit: int = 30):
    """Bugün bekleyen sipariş talepleri; tek seferlik (katalog dışı) kalemler ayrı işaretlenir."""
    lim = max(1, min(100, int(limit)))
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        cur.execute(
            """
            SELECT id, durum, bildirim_saati, not_aciklama, personel_ad, kalemler, olusturma
            FROM siparis_talep
            WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='bekliyor'
            ORDER BY olusturma DESC
            LIMIT %s
            """,
            (sube_id, lim),
        )
        out: List[Dict[str, Any]] = []
        for r in cur.fetchall():
            d = dict(r)
            kms = d.get("kalemler") or []
            if isinstance(kms, str):
                try:
                    kms = json.loads(kms)
                except Exception:
                    kms = []
            if not isinstance(kms, list):
                kms = []
            tek = any(bool(x.get("ozel_tek_sefer")) for x in kms if isinstance(x, dict))
            ozet = []
            for x in kms:
                if not isinstance(x, dict):
                    continue
                ozet.append(
                    {
                        "urun_ad": (x.get("urun_ad") or "").strip(),
                        "adet": int(x.get("adet") or 0),
                        "tek_sefer": bool(x.get("ozel_tek_sefer")),
                    }
                )
            out.append(
                {
                    "id": str(d["id"]),
                    "tur": "tek_sefer" if tek else "standart",
                    "bildirim_saati": d.get("bildirim_saati"),
                    "not_aciklama": d.get("not_aciklama"),
                    "personel_ad": d.get("personel_ad"),
                    "kalemler_ozet": ozet,
                }
            )
    return {"bekleyen": out}


@router.post("/{sube_id}/siparis-ozel-talep")
def sube_siparis_ozel_talep(sube_id: str, body: SiparisOzelTalepBody):
    """Katalogda olmayan ürün talebi — yalnızca merkez onayı sonrası kataloga girer."""
    pid_in = (body.personel_id or "").strip()
    pin = (body.pin or "").replace(" ", "")
    ad = (body.urun_adi or "").strip()
    kk = (body.kategori_kod or "").strip()
    if len(ad) < 2:
        raise HTTPException(400, "Ürün adı en az 2 karakter olmalı")
    if not kk:
        raise HTTPException(400, "Kategori seçilmeli")
    try:
        adet = int(body.adet or 0)
    except (TypeError, ValueError):
        adet = 0
    if adet < 1:
        raise HTTPException(400, "Adet en az 1 olmalı")
    if not pid_in or len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "personel_id ve 4 haneli PIN gerekli")

    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        if not _bugun_kasa_acildi_mi(cur, sube_id):
            raise HTTPException(403, "Önce günlük kasa kilidini PIN ile açmalısınız.")
        ku = dogrula_personel_panel_pin(cur, pid_in, pin)
        onay_ad = (ku.get("ad_soyad") or "").strip() or "—"
        pid_panel = str(ku.get("id") or "").strip() or pid_in
        cur.execute(
            "SELECT 1 FROM siparis_kategori WHERE kod=%s AND aktif=TRUE",
            (kk,),
        )
        if not cur.fetchone():
            raise HTTPException(400, "Geçersiz kategori kodu")
        tr_now = _now_tr()
        saat = tr_now.strftime("%H:%M:%S")
        tid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO siparis_ozel_talep
                (id, sube_id, tarih, urun_adi, kategori_kod, adet, not_aciklama,
                 personel_id, personel_ad, bildirim_saati, durum)
            VALUES (%s, %s, CURRENT_DATE, %s, %s, %s, %s, %s, %s, %s, 'bekliyor')
            """,
            (
                tid,
                sube_id,
                ad,
                kk,
                adet,
                (body.not_aciklama or "").strip() or None,
                pid_panel,
                onay_ad,
                saat,
            ),
        )
        audit(cur, "siparis_ozel_talep", tid, "OZEL_TALEP")
        from operasyon_defter import operasyon_defter_ekle

        operasyon_defter_ekle(
            cur,
            sube_id,
            "SIPARIS_OZEL_TALEP",
            f"Özel ürün talebi — {ad} ×{adet} (kat:{kk}) — {onay_ad}",
            personel_id=pid_panel,
            personel_ad=onay_ad,
            bildirim_saati=saat,
        )
    return {"success": True, "talep_id": tid}


@router.post("/{sube_id}/siparis-onay")
def sube_siparis_onay(sube_id: str, body: SiparisOnayBody):
    pid_in = (body.personel_id or "").strip()
    pin = (body.pin or "").replace(" ", "")
    if not pid_in or len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "personel_id ve 4 haneli PIN gerekli")
    kalemler = body.kalemler or []
    temiz: List[Dict[str, Any]] = []
    for k in kalemler:
        ad = (k.urun_ad or "").strip()
        if not ad:
            continue
        adet = int(k.adet or 0)
        if adet <= 0:
            continue
        temiz.append(
            {
                "kategori_id": (k.kategori_id or "").strip(),
                "urun_id": (k.urun_id or "").strip(),
                "urun_ad": ad,
                "adet": adet,
            }
        )
    if not temiz:
        raise HTTPException(400, "Onay için en az bir kalemde adet girin")

    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        ku = dogrula_personel_panel_pin(cur, pid_in, pin)
        onay_ad = (ku.get("ad_soyad") or "").strip() or "—"
        pid_panel = str(ku.get("id") or "").strip() or pid_in
        tr_now = _now_tr()
        saat = tr_now.strftime("%H:%M:%S")
        tid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO siparis_talep
                (id, sube_id, tarih, durum, personel_id, personel_ad, bildirim_saati, not_aciklama, kalemler)
            VALUES (%s, %s, CURRENT_DATE, 'bekliyor', %s, %s, %s, %s, %s::jsonb)
            """,
            (
                tid,
                sube_id,
                pid_panel,
                onay_ad,
                saat,
                (body.not_aciklama or "").strip() or None,
                json.dumps(temiz, ensure_ascii=False),
            ),
        )
        audit(cur, "siparis_talep", tid, "SIPARIS_ONAY")
        from operasyon_defter import operasyon_defter_ekle

        toplam = sum(int(x.get("adet") or 0) for x in temiz)
        operasyon_defter_ekle(
            cur,
            sube_id,
            "SIPARIS_ONAY_PIN",
            f"Sipariş onaylandı — personel={onay_ad} kalem={len(temiz)} toplam_adet={toplam}",
            personel_id=pid_panel,
            personel_ad=onay_ad,
            bildirim_saati=saat,
        )
        return {"success": True, "talep_id": tid, "kalem_sayisi": len(temiz), "toplam_adet": toplam}


# ─────────────────────────────────────────────────────────────
# KASA FARKI ONAY KUYRUĞU
# ─────────────────────────────────────────────────────────────

def _kasa_farki_onay_kuyruguna_ekle(
    cur,
    sube_id: str,
    tip: str,
    beklenen: float,
    gercek: float,
    personel_id: Optional[str],
    personel_ad: str,
    aciklama: str,
) -> Optional[str]:
    """
    Kasa / stok farkı varsa onay_kuyrugu'na KASA_FARKI kaydı ekler.
    Aynı gün aynı şube için aynı tip zaten varsa tekrar eklemez (idempotent).
    """
    fark = round(gercek - beklenen, 2)
    if fark == 0:
        return None

    # Aynı gün aynı tip zaten varsa atla
    cur.execute(
        """
        SELECT 1 FROM onay_kuyrugu
        WHERE kaynak_tablo='kasa_farki' AND islem_turu=%s
          AND tarih=CURRENT_DATE
          AND aciklama LIKE %s
          AND durum='bekliyor'
        LIMIT 1
        """,
        (tip, f"%{sube_id}%"),
    )
    if cur.fetchone():
        return None

    fark_id = str(uuid.uuid4())
    tam_acik = f"[{sube_id}] {aciklama} | beklenen={beklenen:.2f} gerçek={gercek:.2f} fark={fark:+.2f}"
    onay_ekle(
        cur,
        tip,
        "kasa_farki",
        fark_id,
        tam_acik[:500],
        fark,
        bugun_tr(),
    )
    return fark_id
