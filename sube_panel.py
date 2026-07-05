"""
Şube personel paneli — CFO verisi yok.
Prefix: /api/sube-panel (JSON API)
Statik arayüz: GET /sube-panel veya /sube-panel/{sube_id} — main.py kökteki veya static/sube_panel.html

X rapor OCR: OPENAI_API_KEY, isteğe OPENAI_X_RAPOR_MODEL (varsayılan gpt-4o-mini).
"""
import base64
import json
import os
import pathlib
import re
import traceback
import uuid
from typing import Any, Dict, List, Optional, Set

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from database import db
from tr_saat import (
    bugun_tr,
    is_gunu_tr,
    dt_now_tr as _now_tr,
    dt_now_tr_naive,
    tr_acilis_tamam_saat_uygun_mu,
)
from evvel_merkez_guard import merkez_mutasyon_korumasi
from finans_core import kasa_bakiyesi
from kasa_service import insert_kasa_hareketi, audit, onay_ekle
from operasyon_stok_motor import (
    STOK_KEYS,
    STOK_LABEL_TR,
    PASTA_KEYS,
    PASTA_GRUPLAR,
    sube_kabul_kaydet,
    sube_yeni_siparis_oncesi_cift_kontrol,
)
from siparis_sevkiyat_islem import (
    sevkiyat_kalem_durumlari_normalize,
    siparis_sevkiyat_kalem_guncelle_execute,
)
from sevkiyat_helpers import (
    sevkiyat_durumu_coz,
    sevkiyat_durumu_guncelle_params,
    SD_T,
    SD_NOALIAS,
)
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


class SubeDepoSevkiyatKalemSatir(BaseModel):
    """Depo şube panelinden kalem bazlı kısmi / tam gönderim kaydı."""

    urun_id: Optional[str] = None
    urun_ad: Optional[str] = None
    istenen_adet: int = 0
    durum: str
    gonderilen_adet: int = 0
    not_aciklama: Optional[str] = None


class SubeDepoSevkiyatKaydetBody(BaseModel):
    talep_id: str
    personel_id: str
    pin: str
    kalemler: List[SubeDepoSevkiyatKalemSatir]
    sevkiyat_notu: Optional[str] = None
    gonderildi: bool = False


class SubeTeslimKabulSatir(BaseModel):
    yolda_id: Optional[str] = None
    kalem_kodu: str
    kalem_adi: str = ""
    kabul_adet: int = 0


class SubeSiparisTeslimKabulBody(BaseModel):
    """Şube paketi teslim aldı — stok_yolda kapanır, sube_depo_stok artar."""

    talep_id: str
    personel_id: str
    pin: str
    kabul: List[SubeTeslimKabulSatir]


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
    # Çift sayım kontrolü: tolerans 1 kuruş (eski 50 kuruş hile riskini önler)
    if online > 0.001 and nakit > 0.001 and pos > 0.001 and abs(online - (nakit + pos)) < 0.01:
        online = 0.0
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
        WHERE sube_id=%s AND tarih=%s AND durum='aktif'
        LIMIT 1
    """, (sube_id, is_gunu_tr()))
    return cur.fetchone() is not None


def _bugun_ciro_taslak_bekliyor(cur, sube_id: str) -> Optional[dict]:
    cur.execute("""
        SELECT id, nakit, pos, online, olusturma, aciklama, personel_id,
               gonderen_ad, bildirim_saati, panel_kullanici_id
        FROM ciro_taslak
        WHERE sube_id=%s AND tarih=%s AND durum='bekliyor'
        ORDER BY olusturma DESC
        LIMIT 1
    """, (sube_id, is_gunu_tr()))
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
    tarih=None,  # None → bugün; taslak onayında gerçek gelir tarihi geçilmeli
) -> dict:
    """Onaylı ciro satırı + kasa hareketi (şube kesintileri dahil).

    tarih: cironun ait olduğu gün (YYYY-MM-DD str veya date).
           None verilirse bugün kullanılır.
           Taslak onayında mutlaka taslak.tarih geçirilmeli — aksi hâlde
           geçmiş günün cirosu bugün tarihiyle yazılır.
    """
    from datetime import date as _date
    gercek_tarih = tarih if tarih is not None else is_gunu_tr()
    if isinstance(gercek_tarih, str):
        try:
            gercek_tarih = _date.fromisoformat(gercek_tarih)
        except ValueError:
            gercek_tarih = is_gunu_tr()

    pos_oran = float(sube.get("pos_oran") or 0)
    online_oran = float(sube.get("online_oran") or 0)
    pos_kesinti = pos * pos_oran / 100.0
    online_kesinti = online * online_oran / 100.0
    net_tutar = nakit + (pos - pos_kesinti) + (online - online_kesinti)

    cid = str(uuid.uuid4())
    cur.execute(
        """
        INSERT INTO ciro (id, tarih, sube_id, nakit, pos, online, aciklama)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (cid, gercek_tarih, sube_id, nakit, pos, online, aciklama or "Onaylı ciro"),
    )
    insert_kasa_hareketi(
        cur,
        gercek_tarih,
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
        WHERE sube=%s AND tarih=%s AND durum='aktif'
    """, (sube_id, is_gunu_tr()))
    return int(cur.fetchone()['adet'])


def _bugun_bekleyen_gider_sayisi(cur, sube_id: str) -> int:
    """Bugün girilen ama onay kuyruğunda hâlâ bekleyen anlık gider sayısı."""
    cur.execute(
        """
        SELECT COUNT(*) AS adet FROM onay_kuyrugu
        WHERE kaynak_tablo = 'anlik_giderler'
          AND durum = 'bekliyor'
          AND kaynak_id IN (
              SELECT id FROM anlik_giderler
              WHERE sube = %s AND tarih = %s
          )
        """,
        (sube_id, is_gunu_tr()),
    )
    return int((cur.fetchone() or {}).get("adet") or 0)


def _bugun_sube_acildi_mi(cur, sube_id: str) -> bool:
    cur.execute("""
        SELECT 1 FROM sube_acilis
        WHERE sube_id=%s AND tarih=%s AND durum='acildi'
        LIMIT 1
    """, (sube_id, is_gunu_tr()))
    return cur.fetchone() is not None


def _bugun_kasa_acildi_mi(cur, sube_id: str) -> bool:
    cur.execute(
        """
        SELECT 1 FROM sube_kasa_gun_acma
        WHERE sube_id=%s AND tarih=%s
        LIMIT 1
        """,
        (sube_id, is_gunu_tr()),
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
        WHERE k.sube_id=%s AND k.tarih=%s
        LIMIT 1
        """,
        (sube_id, is_gunu_tr()),
    )
    r = cur.fetchone()
    if not r:
        return None
    d = dict(r)
    if d.get("olusturma"):
        d["olusturma"] = str(d["olusturma"])
    return d


def _kasa_gunu_pin_sonrasi_ac(cur, sube_id: str, pid: str, onay_ad: str) -> bool:
    """
    Günlük kasa kaydı yoksa oluşturur (PIN doğrulaması sonrası).
    Dönüş: True = bugün bu şube için kayıt zaten vardı (idempotent).
    """
    tr_now = _now_tr()
    tarih_sistem = tr_now.strftime("%Y-%m-%d")
    saat_sistem = tr_now.strftime("%H:%M:%S")
    from operasyon_defter import operasyon_defter_ekle

    cur.execute(
        """
        SELECT k.sube_id, COALESCE(s.ad, k.sube_id) AS sube_adi, k.tarih
        FROM sube_kasa_gun_acma k
        LEFT JOIN subeler s ON s.id = k.sube_id
        WHERE k.personel_id=%s AND k.tarih=%s AND k.sube_id<>%s
        LIMIT 1
        """,
        (pid, is_gunu_tr(), sube_id),
    )
    diger = cur.fetchone()
    if diger:
        is_gunu = str(diger.get("tarih") or is_gunu_tr())
        raise HTTPException(
            409,
            (
                f"Bu personel {is_gunu} iş gününde başka şubede kasa açmış: "
                f"{diger.get('sube_adi') or diger.get('sube_id')}"
            ),
        )

    cur.execute(
        "SELECT 1 FROM sube_kasa_gun_acma WHERE sube_id=%s AND tarih=%s",
        (sube_id, is_gunu_tr()),
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
        return True

    cur.execute(
        """
        INSERT INTO sube_kasa_gun_acma (sube_id, tarih, personel_id, panel_kullanici_id)
        VALUES (%s, %s, %s, NULL)
        """,
        (sube_id, is_gunu_tr(), pid),
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
    return False


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
    yoklama_yapildi_mi: bool = False,
) -> list:
    """Günlük görev listesi. Önce QR yoklama, sonra kasa PIN, sonra şube açılış."""
    _ = anlik_adet
    simdi = _now_tr().strftime("%H:%M")
    gorevler = []

    acilis = sube.get("acilis_saati") or "09:00"
    kapanis = sube.get("kapanis_saati") or "22:00"

    # ── QR Yoklama (kasa açılışından önce zorunlu) ─────────────────────
    if yoklama_yapildi_mi:
        yoklama_aciklama = "Personel girişi QR ile doğrulandı. Görevler telefona iletildi."
    else:
        yoklama_aciklama = "Kasa açılışı için önce personelin QR kodu telefona okutması gerekiyor."

    gorevler.append({
        "id":       "yoklama_qr",
        "baslik":   "Personel QR Girişi",
        "aciklama": yoklama_aciklama,
        "saat":     acilis,
        "tur":      "yoklama_qr",
        "tamamlandi": yoklama_yapildi_mi,
        "aksiyon":  "yoklama_bekle" if not yoklama_yapildi_mi else None,
    })

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
        # Yoklama yapılmadan kasa açılamaz
        "aksiyon":  "kasa_ac" if (yoklama_yapildi_mi and not kasa_acildi_mi) else None,
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


class KapanisGeriAlBody(BaseModel):
    onay_pin: Optional[str] = None     # İşletme onayı (Merve Karabacak 4 haneli PIN)
    tarih: Optional[str] = None        # YYYY-MM-DD; boşsa bugünün iş günü
    sebep: Optional[str] = None


@router.post("/{sube_id}/kapanis-geri-al")
def sube_kapanis_geri_al(sube_id: str, body: KapanisGeriAlBody):
    """Merkez: bir şubenin BUGÜNKÜ (veya verilen tarihteki) mühürlenmiş kapanışını geri al.
    İşletme onayı (Merve Karabacak PIN) şart — mali/operasyon kaydını değiştirir, auditli.
    Geri alır: (1) yalnızca GÜN SONU kapanış kaydı → iptal, (2) KAPANIS operasyon olayı →
    'bekliyor' (mühür açılır), (3) o günün kasa teslim kayıtları → sil.
    KORUR: ciro taslağı (günün satış verisi) + vardiya/kasa devri (varsa yanlış iptali geri yükler).
    Kasaya dokunmaz."""
    from operasyon_merkez_api import _isletme_onay_dogrula
    tarih = (body.tarih or str(is_gunu_tr()))[:10]
    with db() as (conn, cur):
        cur.execute("SELECT ad FROM subeler WHERE id=%s AND aktif=TRUE", (sube_id,))
        s = cur.fetchone()
        if not s:
            raise HTTPException(404, "Şube bulunamadı")
        sube_adi = dict(s)["ad"]
        onayci = _isletme_onay_dogrula(cur, body.onay_pin)  # PIN hatalı → 403

        # 1) Ciro taslağı KORUNUR — günün satış verisi (nakit/pos/online) silinmemeli.
        #    Mührü açmak ciroyu uçurmamalı; yeniden kapanışta veri hazır olur (upsert günceller).
        cur.execute(
            "SELECT COUNT(*) AS n FROM ciro_taslak "
            "WHERE sube_id=%s AND tarih=%s AND durum='bekliyor'",
            (sube_id, tarih),
        )
        taslak_korunan = int(dict(cur.fetchone())["n"])
        taslak_iptal = 0  # artık iptal edilmiyor

        # 2) Yalnızca GÜN SONU kapanış kaydı → iptal. VARDİYA/KASA DEVRİNE DOKUNMA.
        cur.execute(
            "UPDATE kapanis_kayit SET durum='iptal' "
            "WHERE sube_id=%s AND tarih=%s AND durum='tamamlandi' AND olay='gun_sonu'",
            (sube_id, tarih),
        )
        kapanis_iptal = cur.rowcount

        # 2b) DÜZELTME: önceki hatalı geri-al vardiya/kasa devrini iptal ettiyse geri yükle.
        cur.execute(
            "UPDATE kapanis_kayit SET durum='tamamlandi' "
            "WHERE sube_id=%s AND tarih=%s AND olay='vardiya_sabah_aksam_devri' AND durum='iptal'",
            (sube_id, tarih),
        )
        devir_geri_yuklendi = cur.rowcount

        # 2c) O günün kasa teslim kayıtları (gün sonu + gün içi 'ara' teslim) → sil.
        #     kasa_teslim kasaya doğrudan dokunmaz; yeniden kapanışta tekrar yazılır.
        cur.execute("DELETE FROM kasa_teslim WHERE sube_id=%s AND tarih=%s", (sube_id, tarih))
        teslim_silindi = cur.rowcount

        # 3) KAPANIS operasyon olayını yeniden aç (panel kapanışı tekrar görsün)
        cur.execute(
            "UPDATE sube_operasyon_event "
            "SET durum='bekliyor', cevap_ts=NULL "
            "WHERE sube_id=%s AND tarih=%s AND tip='KAPANIS' AND sira_no=0 "
            "AND durum IN ('tamamlandi','gecikti')",
            (sube_id, tarih),
        )
        event_acildi = cur.rowcount

        audit(cur, "sube_operasyon_event", f"{sube_id}|{tarih}|KAPANIS", "KAPANIS_GERI_AL",
              yeni={"onayci": onayci.get("ad_soyad"), "sebep": body.sebep,
                    "taslak_iptal": taslak_iptal, "kapanis_iptal": kapanis_iptal,
                    "event_acildi": event_acildi, "devir_geri_yuklendi": devir_geri_yuklendi,
                    "teslim_silindi": teslim_silindi, "taslak_korunan": taslak_korunan})

    return {
        "success": True,
        "sube": sube_adi,
        "tarih": tarih,
        "geri_alindi": {
            "ciro_taslak_korundu": taslak_korunan,
            "kapanis_kayit_iptal": kapanis_iptal,
            "kapanis_olayi_acildi": event_acildi,
            "vardiya_devri_geri_yuklendi": devir_geri_yuklendi,
            "kasa_teslim_silindi": teslim_silindi,
        },
        "not": "Kapanış mührü açıldı. Ciro/satış verisi KORUNDU, vardiya/kasa devrine dokunulmadı. Şube kapanışı yeniden yapabilir; ciro hazır gelir.",
    }


class SubeAcilisModel(BaseModel):
    """
    Manuel şube açılış kaydı.
    kasa_sayim gönderilirse: operasyon ACILIS ile aynı zorunlu sayımlar + PIN —
    tek istekte günlük kasa açılır ve sayımlar deftere yazılır (şube paneli sihirbazı).
    kasa_sayim boşsa: önce `/kasa-kilit-ac` ile kasa açılmış olmalıdır (eski tek adım).
    """

    personel_id: Optional[str] = None
    aciklama: Optional[str] = None
    pin: Optional[str] = None
    kasa_sayim: Optional[float] = None
    bardak_kucuk: Optional[int] = None
    bardak_buyuk: Optional[int] = None
    bardak_plastik: Optional[int] = None
    su_adet: Optional[int] = None
    sut_litre: Optional[int] = None
    redbull_adet: Optional[int] = None
    soda_adet: Optional[int] = None
    cookie_adet: Optional[int] = None
    pasta_adet: Optional[int] = None
    # ── Bireysel pasta kalemleri (Excel listesi) ─────────────────
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


def _sayimli_panel_acilis_dogrula(body: SubeAcilisModel) -> None:
    """Operasyon ACILIS tamamla ile aynı sayım kuralları."""
    pid_in = (body.personel_id or "").strip()
    pin = (body.pin or "").replace(" ", "")
    if not pid_in:
        raise HTTPException(400, "Açılış onayı için personel seçilmeli.")
    if len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "Açılış için 4 haneli panel PIN gerekli.")
    if body.kasa_sayim is None or body.kasa_sayim < 0:
        raise HTTPException(400, "Açılış için kasa sayımı girilmeli")
    if body.kasa_sayim > 9_999_999:
        raise HTTPException(400, "Kasa sayımı geçersiz: 9.999.999₺ üstü kabul edilmez")
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
        pid_v = str(ku.get("id") or pid).strip()
        idem = _kasa_gunu_pin_sonrasi_ac(cur, sube_id, pid_v, onay_ad)
        if idem:
            return {
                "success": True,
                "idempotent": True,
                "mesaj": "Kasa kilidi bugün zaten açılmış.",
            }
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


@router.post("/{sube_id}/acilis-geri-al")
def sube_acilis_geri_al(sube_id: str, uygula: bool = False):
    """Bugünkü şube açılışını GERİ AL (test/yanlış açılış temizliği).
    Geri alınan: sube_acilis(durum='iptal') + sube_kasa_gun_acma(silinir) + ACILIS
    event(durum='bekliyor'a döner). GÜVENLİK: bugün ciro taslağı / kapanış / başka
    tamamlanmış operasyon varsa BLOKE (kasa-ciro defteri bozulmasın).
    uygula=False → KURU ÇALIŞMA (durum + bloke nedenleri, yazma yok)."""
    sid = (sube_id or "").strip()
    g = is_gunu_tr()
    with db() as (conn, cur):
        _sube_getir(cur, sid)

        def _say(sql, par=()):  # SAVEPOINT'li güvenli sayım
            try:
                cur.execute("SAVEPOINT sp_ag"); cur.execute(sql, par)
                n = (cur.fetchone() or {}).get("n", 0); cur.execute("RELEASE SAVEPOINT sp_ag")
                return int(n or 0)
            except Exception:
                try: cur.execute("ROLLBACK TO SAVEPOINT sp_ag"); cur.execute("RELEASE SAVEPOINT sp_ag")
                except Exception: pass
                return 0

        acilis_n = _say("SELECT COUNT(*) AS n FROM sube_acilis WHERE sube_id=%s AND tarih=%s AND durum='acildi'", (sid, g))
        kasa_gun_n = _say("SELECT COUNT(*) AS n FROM sube_kasa_gun_acma WHERE sube_id=%s AND tarih=%s", (sid, g))
        # ── GÜVENLİK: bugün gerçek hareket var mı (varsa açılış geri alınmaz) ──
        bloke: List[str] = []
        if _say("SELECT COUNT(*) AS n FROM ciro_taslak WHERE sube_id=%s AND tarih=%s", (sid, g)) > 0:
            bloke.append("ciro_taslagi")
        if _say("SELECT COUNT(*) AS n FROM sube_operasyon_event WHERE sube_id=%s AND tarih=%s AND tip='KAPANIS' AND durum='tamamlandi'", (sid, g)) > 0:
            bloke.append("kapanis_yapilmis")
        # KONTROL = açılışın otomatik companion'ı (rastgele kasa-sayım slotu, para hareketi
        # DEĞİL) → bloke SAYILMAZ, açılışla birlikte temizlenir. Gerçek operasyon (KAPANIS,
        # vardiya devri vb.) bloke eder.
        if _say("SELECT COUNT(*) AS n FROM sube_operasyon_event WHERE sube_id=%s AND tarih=%s AND tip NOT IN ('ACILIS','KAPANIS','KONTROL') AND durum='tamamlandi'", (sid, g)) > 0:
            bloke.append("diger_tamamlanmis_operasyon")

        durum = {"acilis_kaydi": acilis_n, "kasa_gun_acma": kasa_gun_n, "is_gunu": str(g), "bloke_nedenleri": bloke}
        if not uygula:
            # Bloke detayı: hangi event(ler) engelliyor (teşhis için, salt-okur)
            bloke_detay = []
            try:
                cur.execute("SAVEPOINT sp_bd")
                cur.execute(
                    """SELECT tip, durum, cevap_ts::text AS cevap_ts, personel_ad
                       FROM sube_operasyon_event
                       WHERE sube_id=%s AND tarih=%s AND tip NOT IN ('ACILIS','KAPANIS','KONTROL') AND durum='tamamlandi'
                       ORDER BY cevap_ts NULLS LAST LIMIT 20""",
                    (sid, g),
                )
                bloke_detay = [dict(r) for r in (cur.fetchall() or [])]
                cur.execute("RELEASE SAVEPOINT sp_bd")
            except Exception:
                try: cur.execute("ROLLBACK TO SAVEPOINT sp_bd"); cur.execute("RELEASE SAVEPOINT sp_bd")
                except Exception: pass
            return {"kuru_calisma": True, **durum, "bloke_detay": bloke_detay,
                    "geri_alinabilir": (acilis_n > 0 or kasa_gun_n > 0) and not bloke}
        if bloke:
            raise HTTPException(409, "Açılış geri alınamaz — bugün gerçek hareket var: " + ", ".join(bloke))
        if acilis_n == 0 and kasa_gun_n == 0:
            raise HTTPException(404, "Bugün geri alınacak açılış yok")
        # ── GERİ AL ──
        cur.execute("UPDATE sube_acilis SET durum='iptal' WHERE sube_id=%s AND tarih=%s AND durum='acildi'", (sid, g))
        cur.execute("DELETE FROM sube_kasa_gun_acma WHERE sube_id=%s AND tarih=%s", (sid, g))
        cur.execute(
            """UPDATE sube_operasyon_event
               SET durum='bekliyor', cevap_ts=NULL, personel_saat=NULL, kasa_sayim=NULL,
                   meta=NULL, personel_id=NULL, personel_ad=NULL
               WHERE sube_id=%s AND tarih=%s AND tip='ACILIS' AND sira_no=0""",
            (sid, g),
        )
        # Açılışın otomatik companion'ı KONTROL slotunu da temizle (açılışsız anlamsız)
        cur.execute(
            "DELETE FROM sube_operasyon_event WHERE sube_id=%s AND tarih=%s AND tip='KONTROL'",
            (sid, g),
        )
        conn.commit()
    return {"uygulandi": True, **durum}


@router.post("/{sube_id}/acilis")
def sube_acilis_kaydet(sube_id: str, body: SubeAcilisModel = SubeAcilisModel()):
    """
    Şubeyi aç — gün başına tek aktif kayıt (durum=acildi).
    Sayımlı gövde (kasa_sayim dolu): PIN ile günlük kasayı açar + sayımları deftere yazar.
    Basit gövde: önce `/kasa-kilit-ac` ile kasa açılmış olmalıdır.
    """
    simdi = _now_tr()
    saat_str = simdi.strftime("%H:%M")
    tarih_sistem = simdi.strftime("%Y-%m-%d")
    saat_sistem = simdi.strftime("%H:%M:%S")
    sayimli = body.kasa_sayim is not None
    if not tr_acilis_tamam_saat_uygun_mu(dt_now_tr_naive()):
        raise HTTPException(
            400,
            "Açılış onayı yalnızca 07:00 ve sonrasında yapılabilir.",
        )

    with db() as (conn, cur):
        _sube_getir(cur, sube_id)

        if sayimli:
            _sayimli_panel_acilis_dogrula(body)
            pid_in = (body.personel_id or "").strip()
            pin = (body.pin or "").replace(" ", "")
            ku = dogrula_personel_panel_pin(cur, pid_in, pin)
            pid = str(ku.get("id") or "").strip()
            if not pid:
                raise HTTPException(400, "PIN doğrulaması başarısız.")
            onay_ad = (ku.get("ad_soyad") or "").strip() or "—"

            _kasa_gunu_pin_sonrasi_ac(cur, sube_id, pid, onay_ad)

            cur.execute(
                """
                SELECT a.sube_id, COALESCE(s.ad, a.sube_id) AS sube_adi, a.tarih
                FROM sube_acilis a
                LEFT JOIN subeler s ON s.id = a.sube_id
                WHERE a.personel_id=%s AND a.tarih=%s AND a.durum='acildi' AND a.sube_id<>%s
                LIMIT 1
                """,
                (pid, is_gunu_tr(), sube_id),
            )
            diger_acilis = cur.fetchone()
            if diger_acilis:
                is_gunu = str(diger_acilis.get("tarih") or is_gunu_tr())
                raise HTTPException(
                    409,
                    (
                        f"Bu personel {is_gunu} iş gününde başka şubede açılış yapmış: "
                        f"{diger_acilis.get('sube_adi') or diger_acilis.get('sube_id')}"
                    ),
                )

            cur.execute(
                """
                SELECT id FROM sube_acilis
                WHERE sube_id=%s AND tarih=%s AND durum='acildi'
                """,
                (sube_id, is_gunu_tr()),
            )
            mevcut = cur.fetchone()
            if mevcut:
                return {
                    "success": True,
                    "idempotent": True,
                    "id": str(mevcut["id"]),
                    "acilis_saati": saat_str,
                    "mesaj": "Bugün bu şube zaten açılmış kayıtlı.",
                }

            ks = float(body.kasa_sayim or 0)
            # Bireysel pasta adetleri
            _pasta_fields = {k: int(getattr(body, k) or 0) for k in PASTA_KEYS}
            _pasta_toplam = sum(_pasta_fields.values())
            stok = {
                "bardak_kucuk": int(body.bardak_kucuk),
                "bardak_buyuk": int(body.bardak_buyuk),
                "bardak_plastik": int(body.bardak_plastik),
                "su_adet": int(body.su_adet),
                "sut_litre": int(body.sut_litre),
                "redbull_adet": int(body.redbull_adet),
                "soda_adet": int(body.soda_adet),
                "cookie_adet": int(body.cookie_adet),
                # pasta_adet = bireysel toplamı; eski API uyumu için gönderilen değer ≥ toplam ise onu kullan
                "pasta_adet": max(_pasta_toplam, int(body.pasta_adet or 0)),
                "surup_adet": 0,
                "kahve_paket": 0,
                "karton_bardak": 0,
                "kapak_adet": 0,
                "pecete_paket": 0,
                "diger_sarf": 0,
                **_pasta_fields,
            }
            meta_json = json.dumps(
                {"acilis_stok_sayim": stok, "panel_acilis_tr_ts": simdi.strftime("%Y-%m-%d %H:%M:%S")},
                ensure_ascii=False,
            )
            aid = str(uuid.uuid4())
            aciklama_row = (
                body.aciklama
                or (
                    f"Sayımlı panel açılış — {onay_ad} — kasa={ks} — "
                    f"{simdi.strftime('%Y-%m-%d %H:%M:%S')}"
                )
            )
            ins_ack = aciklama_row + (" | meta: " + meta_json[:350] if meta_json else "")
            if len(ins_ack) > 1900:
                ins_ack = ins_ack[:1900]
            cur.execute(
                """
                INSERT INTO sube_acilis
                    (id, sube_id, tarih, acilis_saati, personel_id, durum, aciklama)
                VALUES (%s, %s, %s, %s, %s, 'acildi', %s)
                """,
                (aid, sube_id, is_gunu_tr(), saat_str, pid, ins_ack),
            )
            audit(cur, "sube_acilis", aid, "ACILIS_PANEL_SAYIMLI")

            # sube_operasyon_event ACILIS kaydını tamamlandı yap (upsert) — bar-ozet buradan okur
            _eid_ev = str(uuid.uuid4())
            cur.execute(
                """
                INSERT INTO sube_operasyon_event
                    (id, sube_id, tarih, tip, sira_no,
                     sistem_slot_ts, son_teslim_ts,
                     durum, cevap_ts, personel_saat,
                     kasa_sayim, meta, personel_id, personel_ad)
                VALUES (%s, %s, %s, 'ACILIS', 0,
                        %s, %s,
                        'tamamlandi', %s, %s,
                        %s, %s, %s, %s)
                ON CONFLICT (sube_id, tarih, tip, sira_no) DO UPDATE SET
                    durum        = 'tamamlandi',
                    cevap_ts     = COALESCE(sube_operasyon_event.cevap_ts, EXCLUDED.cevap_ts),
                    personel_saat= COALESCE(sube_operasyon_event.personel_saat, EXCLUDED.personel_saat),
                    kasa_sayim   = EXCLUDED.kasa_sayim,
                    meta         = EXCLUDED.meta,
                    personel_id  = COALESCE(sube_operasyon_event.personel_id, EXCLUDED.personel_id),
                    personel_ad  = COALESCE(sube_operasyon_event.personel_ad, EXCLUDED.personel_ad)
                -- WHERE kaldırıldı: kör sayım değeri her durumda yazılır (durum=tamamlandi olsa bile)
                """,
                (
                    _eid_ev, sube_id, is_gunu_tr(),
                    simdi, simdi,
                    simdi, saat_str,
                    ks, meta_json, pid, onay_ad,
                ),
            )

            from operasyon_defter import operasyon_defter_ekle
            from operasyon_kurallar import (
                beklenen_dunku_kapanis_kasa,
                beklenen_dunku_kapanis_stok,
                tolerans_seviyesi, stok_tolerans_seviyesi,
                kasa_fark_onemsiz_mi,
            )

            # ── Önceki kapanış personelini bir kez çek (hem kasa hem stok uyumsuzluğunda kullanılır) ──
            cur.execute(
                """
                SELECT personel_id, personel_ad
                FROM sube_operasyon_event
                WHERE sube_id=%s AND tip='KAPANIS' AND durum='tamamlandi'
                  AND tarih=(CURRENT_DATE - INTERVAL '1 day')
                ORDER BY cevap_ts DESC NULLS LAST, id DESC
                LIMIT 1
                """,
                (sube_id,),
            )
            prev_kap = cur.fetchone()
            kap_pid = (prev_kap.get("personel_id") or "").strip() or None if prev_kap else None
            kap_pad = (prev_kap.get("personel_ad") or "").strip() or None if prev_kap else None

            # ── 1. KASA FARK KONTROLÜ ──
            _kasa_fark_sonuc: Optional[dict] = None  # açılış sonrası panel'e iletilecek
            bek = beklenen_dunku_kapanis_kasa(cur, sube_id)
            if bek is not None:
                fark = round(ks - float(bek), 2)
                _kasa_fark_sonuc = {"fark": fark, "beklenen": float(bek), "gercek": float(ks)}
                if abs(fark) > 0.01:
                    sev = tolerans_seviyesi(fark)
                    _kasa_fark_sonuc["seviye"] = sev
                    mesaj_kf = (
                        f"Açılış kasası dün devirine göre fark: {fark:+,.2f} TL "
                        f"(beklenen {bek:,.0f}₺ → gerçek {ks:,.0f}₺, {sev})"
                    )
                    # Upsert: aynı gün için tek ACILIS_KASA_FARK kaydı (iki açılış yolu çakışmasın)
                    # Açılış event'i is_gunu_tr() ile tarihlenir → uyarı da AYNI iş gününü kullanmalı.
                    # (CURRENT_DATE takvim günüydü; gece 00:00–02:00 arası yanlış güne yazıyordu.)
                    _kf_isgun = is_gunu_tr()
                    _acilis_kf_uyari_id: Optional[str] = None
                    # SAVEPOINT: uyarı yazımı hata verse bile açılış çekirdeği geri sarılmasın
                    try:
                        cur.execute("SAVEPOINT sp_acilis_kfuyari")
                        cur.execute(
                            "SELECT id FROM sube_operasyon_uyari "
                            "WHERE sube_id=%s AND tarih=%s AND tip='ACILIS_KASA_FARK' LIMIT 1",
                            (sube_id, _kf_isgun),
                        )
                        mevcut_kf = cur.fetchone()
                        if mevcut_kf:
                            _acilis_kf_uyari_id = mevcut_kf["id"]
                            cur.execute(
                                """UPDATE sube_operasyon_uyari
                                   SET seviye=%s, beklenen_tl=%s, gercek_tl=%s, fark_tl=%s, mesaj=%s,
                                       acilis_personel_id=%s, acilis_personel_ad=%s,
                                       kapanis_personel_id=%s, kapanis_personel_ad=%s,
                                       okundu=FALSE
                                   WHERE id=%s""",
                                (sev, bek, ks, fark, mesaj_kf,
                                 pid, onay_ad, kap_pid, kap_pad,
                                 _acilis_kf_uyari_id),
                            )
                        else:
                            _acilis_kf_uyari_id = str(uuid.uuid4())
                            cur.execute(
                                """
                                INSERT INTO sube_operasyon_uyari
                                    (id, sube_id, tarih, tip, seviye, beklenen_tl, gercek_tl, fark_tl, mesaj,
                                     acilis_personel_id, acilis_personel_ad, kapanis_personel_id, kapanis_personel_ad)
                                VALUES (%s, %s, %s, 'ACILIS_KASA_FARK', %s, %s, %s, %s, %s, %s, %s, %s, %s)
                                """,
                                (
                                    _acilis_kf_uyari_id, sube_id, _kf_isgun, sev,
                                    bek, ks, fark, mesaj_kf,
                                    pid, onay_ad, kap_pid, kap_pad,
                                ),
                            )
                        cur.execute("RELEASE SAVEPOINT sp_acilis_kfuyari")
                    except Exception:
                        try:
                            cur.execute("ROLLBACK TO SAVEPOINT sp_acilis_kfuyari")
                        except Exception:
                            pass

                    # ── Onay kuyruğuna ekle (hem update hem insert yolunda) ──
                    # SAVEPOINT: hata transaction'ı zehirlemesin → açılış geri sarılmasın
                    try:
                        cur.execute("SAVEPOINT sp_acilis_onay")
                        _kasa_farki_onay_kuyruguna_ekle(
                            cur, sube_id, "ACILIS_KASA_FARK",
                            float(bek), float(ks), pid, onay_ad, mesaj_kf,
                            uyari_id=_acilis_kf_uyari_id,
                        )
                        cur.execute("RELEASE SAVEPOINT sp_acilis_onay")
                    except Exception:
                        try:
                            cur.execute("ROLLBACK TO SAVEPOINT sp_acilis_onay")
                        except Exception:
                            pass  # onay_kuyrugu yazımı kritik değil

                    # ── Personel risk sinyali ──
                    # Not: ±5 TL içindeki farklar "önemsiz" sayılır — kasa uyumsuzluğu
                    # yukarıda (sube_operasyon_uyari) yine de kaydedildi/CFO'ya görünür,
                    # ama personelin kasası "açık" gibi algılanıp risk skoruna yansımaz.
                    if pid and not kasa_fark_onemsiz_mi(fark):
                        try:
                            cur.execute("SAVEPOINT sp_acilis_risk")
                            agirlik_kf = 20 if sev == "kritik" else 10
                            cur.execute(
                                """INSERT INTO personel_risk_sinyal
                                       (id, personel_id, sube_id, tarih, sinyal_turu, agirlik, aciklama, referans_id)
                                   VALUES (%s, %s, %s, %s, 'ACILIS_KASA_FARK', %s, %s, %s)""",
                                (str(uuid.uuid4()), pid, sube_id, _kf_isgun,
                                 agirlik_kf, mesaj_kf[:1800], str(sube_id)),
                            )
                            cur.execute("RELEASE SAVEPOINT sp_acilis_risk")
                        except Exception:
                            try:
                                cur.execute("ROLLBACK TO SAVEPOINT sp_acilis_risk")
                            except Exception:
                                pass  # risk sinyal yazımı kritik değil

            # ── 2. STOK FARK KONTROLÜ ── (SAVEPOINT: açılışı asla riske atma)
            try:
                cur.execute("SAVEPOINT sp_acilis_stokfark")
                bek_stok = beklenen_dunku_kapanis_stok(cur, sube_id)
                if bek_stok is not None:
                    for kalem, acilis_adet in stok.items():
                        beklenen_adet = int(bek_stok.get(kalem) or 0)
                        fark_adet = acilis_adet - beklenen_adet
                        if abs(fark_adet) == 0:
                            continue
                        sev = stok_tolerans_seviyesi(fark_adet)
                        if sev == "normal":
                            continue
                        cur.execute(
                            """
                            INSERT INTO sube_operasyon_uyari
                                (id, sube_id, tarih, tip, seviye, mesaj,
                                 acilis_personel_id, acilis_personel_ad, kapanis_personel_id, kapanis_personel_ad)
                            VALUES (%s, %s, CURRENT_DATE, 'ACILIS_STOK_FARK', %s, %s, %s, %s, %s, %s)
                            """,
                            (
                                str(uuid.uuid4()), sube_id, sev,
                                f"Stok uyumsuzluğu [{kalem}]: dün kapanış {beklenen_adet} adet, "
                                f"bugün açılış {acilis_adet} adet, fark {fark_adet:+d} ({sev})",
                                pid, onay_ad, kap_pid, kap_pad,
                            ),
                        )
                cur.execute("RELEASE SAVEPOINT sp_acilis_stokfark")
            except Exception:
                try:
                    cur.execute("ROLLBACK TO SAVEPOINT sp_acilis_stokfark")
                except Exception:
                    pass

            # SAVEPOINT: defter (hash-zincir) yazımı hata verse bile açılış geri sarılmasın
            try:
                cur.execute("SAVEPOINT sp_acilis_defter")
                operasyon_defter_ekle(
                    cur,
                    sube_id,
                    "ACILIS_TAMAM",
                    (
                        f"Şube panel sayımlı açılış — {onay_ad} — tarih={bugun_tr()} saat={saat_sistem} "
                        f"kasa_sayim={ks} | bardak(k/b/p)=({stok['bardak_kucuk']}/"
                        f"{stok['bardak_buyuk']}/{stok['bardak_plastik']}) "
                        f"urun(su/sut/r/s/c/p)=({stok['su_adet']}/{stok['sut_litre']}/"
                        f"{stok['redbull_adet']}/{stok['soda_adet']}/{stok['cookie_adet']}/{stok['pasta_adet']})"
                    ),
                    aid,
                    personel_id=pid,
                    personel_ad=onay_ad,
                    bildirim_saati=saat_sistem,
                )
                cur.execute("RELEASE SAVEPOINT sp_acilis_defter")
            except Exception:
                try:
                    cur.execute("ROLLBACK TO SAVEPOINT sp_acilis_defter")
                except Exception:
                    pass

            return {
                "success": True,
                "id": aid,
                "acilis_saati": saat_str,
                "idempotent": False,
                "sayimli": True,
                "kasa_fark": _kasa_fark_sonuc,  # Kör sayım sonucu: sayım bittikten SONRA göster
            }

        if not _bugun_kasa_acildi_mi(cur, sube_id):
            raise HTTPException(
                403,
                "Önce günlük kasa kilidini PIN ile açmalısınız veya sayımlı şube açılışını (kasa+bardak+ürün+PIN) tamamlayın.",
            )
        cur.execute(
            """
            SELECT personel_id, COALESCE(p.ad_soyad, '') AS ad_soyad
            FROM sube_kasa_gun_acma k
            LEFT JOIN personel p ON p.id = k.personel_id
            WHERE k.sube_id=%s AND k.tarih=%s
            LIMIT 1
            """,
            (sube_id, is_gunu_tr()),
        )
        ka = cur.fetchone()
        pid = (body.personel_id or "").strip() or str((ka or {}).get("personel_id") or "").strip()
        if not pid:
            raise HTTPException(400, "Açılış için PIN onaylayan personel bulunamadı.")
        cur.execute("SELECT ad_soyad FROM personel WHERE id=%s", (pid,))
        pr = cur.fetchone()
        onay_ad = str((pr or {}).get("ad_soyad") or (ka or {}).get("ad_soyad") or "—").strip() or "—"

        cur.execute(
            """
            SELECT a.sube_id, COALESCE(s.ad, a.sube_id) AS sube_adi, a.tarih
            FROM sube_acilis a
            LEFT JOIN subeler s ON s.id = a.sube_id
            WHERE a.personel_id=%s AND a.tarih=%s AND a.durum='acildi' AND a.sube_id<>%s
            LIMIT 1
            """,
            (pid, is_gunu_tr(), sube_id),
        )
        diger_acilis = cur.fetchone()
        if diger_acilis:
            is_gunu = str(diger_acilis.get("tarih") or is_gunu_tr())
            raise HTTPException(
                409,
                (
                    f"Bu personel {is_gunu} iş gününde başka şubede açılış yapmış: "
                    f"{diger_acilis.get('sube_adi') or diger_acilis.get('sube_id')}"
                ),
            )

        cur.execute(
            """
            SELECT id FROM sube_acilis
            WHERE sube_id=%s AND tarih=%s AND durum='acildi'
            """,
            (sube_id, is_gunu_tr()),
        )
        mevcut = cur.fetchone()
        if mevcut:
            return {
                "success": True,
                "idempotent": True,
                "id": str(mevcut["id"]),
                "acilis_saati": saat_str,
                "mesaj": "Bugün bu şube zaten açılmış kayıtlı.",
            }
        aid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO sube_acilis
                (id, sube_id, tarih, acilis_saati, personel_id, durum, aciklama)
            VALUES (%s, %s, %s, %s, %s, 'acildi', %s)
            """,
            (
                aid,
                sube_id,
                is_gunu_tr(),
                saat_str,
                pid,
                (
                    body.aciklama
                    or f"Açılış onayı — {onay_ad} — {simdi.strftime('%Y-%m-%d %H:%M:%S')}"
                ),
            ),
        )
        audit(cur, "sube_acilis", aid, "ACILIS_PANEL")
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
        "success": True,
        "id": aid,
        "acilis_saati": saat_str,
        "idempotent": False,
        "sayimli": False,
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
    """Şube panel tam JSON (CFO / tam yetki).

    Kasa / açılış–kapanış ürün tutarsızlığı uyarıları şube panelinde gösterilmez
    (operasyon merkezi); bu yüzden operasyon[\"uyarilar\"] eklenmez.
    Depo (bitmeye yakın) bilgisi: stok_alarmlari (STOK_ALARM).
    """
    sube = _sube_getir(cur, sube_id)
    ciro_girildi = _bugun_ciro_var_mi(cur, sube_id)
    taslak_row = _bugun_ciro_taslak_bekliyor(cur, sube_id)
    ciro_taslak_bekliyor = taslak_row is not None
    anlik_adet = _bugun_anlik_gider_sayisi(cur, sube_id)
    bekleyen_gider_sayisi = _bugun_bekleyen_gider_sayisi(cur, sube_id)
    sube_acildi_mi = _bugun_sube_acildi_mi(cur, sube_id)
    kasa_acildi_mi = _bugun_kasa_acildi_mi(cur, sube_id)
    kasa_acma = _bugun_kasa_acma_kaydi(cur, sube_id)
    acilis_kaydi = _bugun_acilis_kaydi(cur, sube_id)

    cur.execute(
        """
        SELECT
            COALESCE(SUM(nakit), 0)  as nakit,
            COALESCE(SUM(pos), 0)    as pos,
            COALESCE(SUM(online), 0) as online,
            COALESCE(SUM(toplam), 0) as toplam
        FROM ciro
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='aktif'
        """,
        (sube_id,),
    )
    ciro_ozet = dict(cur.fetchone())

    # Bugün bu şubede yoklama kaydı var mı?
    cur.execute("""
        SELECT 1 FROM gorev_yoklama
        WHERE sube_id=%s AND tarih=%s LIMIT 1
    """, (sube_id, is_gunu_tr()))
    yoklama_yapildi_mi = cur.fetchone() is not None

    gorevler = _gorev_listesi_uret(
        sube,
        ciro_girildi,
        anlik_adet,
        sube_acildi_mi,
        ciro_taslak_bekliyor,
        kasa_acildi_mi=kasa_acildi_mi,
        kasa_acma_kaydi=kasa_acma,
        yoklama_yapildi_mi=yoklama_yapildi_mi,
    )
    panel_pin_kullanicilar = list_personel_panel_secim(cur)
    panel_yonetici_sayisi = count_personel_panel_yonetici(cur)
    tamamlanan = sum(1 for g in gorevler if g["tamamlandi"])

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

    # Şube paneli «Kasa teslim» sekmesi: son hareketler (ara + kapanış/gün_sonu aynı tabloda)
    kasa_teslim_son_hareketler: List[Dict[str, Any]] = []
    try:
        from datetime import timedelta as _td

        _ig = is_gunu_tr()
        _bas = _ig - _td(days=29)
        cur.execute(
            """
            SELECT
                id::text,
                tarih::text AS tarih,
                tutar::float,
                COALESCE(teslim_eden_ad, '') AS teslim_eden_ad,
                COALESCE(teslim_alan_ad, '') AS teslim_alan_ad,
                COALESCE(teslim_turu, 'ara') AS teslim_turu,
                COALESCE(aciklama, '') AS aciklama,
                to_char(olusturma AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI:SS') AS olusturma_tr
            FROM kasa_teslim
            WHERE sube_id = %s
              AND tarih >= %s
              AND tarih <= %s
            ORDER BY olusturma DESC NULLS LAST
            LIMIT 80
            """,
            (sube_id, _bas, _ig),
        )
        for r in cur.fetchall() or []:
            rr = dict(r)
            kasa_teslim_son_hareketler.append(
                {
                    "id": str(rr.get("id") or ""),
                    "tarih": str(rr.get("tarih") or ""),
                    "tutar": float(rr.get("tutar") or 0),
                    "teslim_eden_ad": str(rr.get("teslim_eden_ad") or ""),
                    "teslim_alan_ad": str(rr.get("teslim_alan_ad") or ""),
                    "teslim_turu": str(rr.get("teslim_turu") or "ara"),
                    "aciklama": str(rr.get("aciklama") or ""),
                    "olusturma_tr": str(rr.get("olusturma_tr") or ""),
                }
            )
    except Exception:
        kasa_teslim_son_hareketler = []

    from sube_operasyon import build_panel_operasyon_blob
    from sube_kapanis_dual import vardiya_devir_panel_blob

    operasyon = build_panel_operasyon_blob(cur, sube_id, sube)
    vardiya_devir = vardiya_devir_panel_blob(cur, sube_id)

    # Okunmamış sipariş red bildirimleri (son 7 gün)
    try:
        cur.execute(
            """
            SELECT id, tarih, mesaj, olusturma
            FROM sube_operasyon_uyari
            WHERE sube_id = %s
              AND tip = 'SIPARIS_RED'
              AND okundu = FALSE
              AND tarih >= CURRENT_DATE - INTERVAL '7 days'
            ORDER BY olusturma DESC
            LIMIT 10
            """,
            (sube_id,),
        )
        siparis_red_bildirimleri = [
            {
                "id": str(r.get("id") or ""),
                "tarih": str(r.get("tarih") or ""),
                "mesaj": r.get("mesaj") or "",
                "olusturma": str(r.get("olusturma") or ""),
            }
            for r in cur.fetchall()
        ]
    except Exception:
        siparis_red_bildirimleri = []

    # Şube paneli açılır listeleri: tüm aktif personel (isimler).
    # PIN ile kasa kilidi için ayrıca panel_pin_kullanicilar kullanılır (frontend birleştirir).
    cur.execute(
        """
        SELECT id, ad_soyad
        FROM personel
        WHERE aktif = TRUE
        ORDER BY ad_soyad
        """
    )
    personel_operasyon_secim = []
    for r in cur.fetchall():
        rr = dict(r)
        personel_operasyon_secim.append(
            {
                "id": str(rr["id"]).strip(),
                "ad": (rr.get("ad_soyad") or "").strip(),
            }
        )

    akt_op = operasyon.get("aktif") if isinstance(operasyon, dict) else None

    kasa_kilitli = not kasa_acildi_mi
    panel_blok = kasa_kilitli or (not sube_acildi_mi)

    cur.execute(
        """
        SELECT id, mesaj, oncelik, okundu, olusturma, ttl_saat, aktif
        FROM sube_merkez_mesaj
        WHERE sube_id=%s
          AND olusturma + (COALESCE(ttl_saat, 72) * INTERVAL '1 hour') > NOW()
        ORDER BY okundu ASC, olusturma DESC
        LIMIT 30
        """,
        (sube_id,),
    )
    merkez_mesajlar = []
    for mr in cur.fetchall():
        md = dict(mr)
        if md.get("olusturma"):
            md["olusturma"] = str(md["olusturma"])
        merkez_mesajlar.append(md)

    okunmamis_mesaj_var = any(
        not m.get("okundu") and m.get("aktif", True) for m in merkez_mesajlar
    )

    # Stok uyarısı: şube deposunda mevcutu sıfır olan tüm kalemler (havuz anahtarı, katalog ürün id, özel kod).
    try:
        cur.execute(
            """
            SELECT kalem_kodu, kalem_adi, COALESCE(mevcut_adet, 0) AS mevcut_adet, guncelleme
            FROM sube_depo_stok
            WHERE sube_id=%s
              AND COALESCE(mevcut_adet, 0) = 0
            ORDER BY kalem_adi ASC
            LIMIT 120
            """,
            (sube_id,),
        )
        from operasyon_stok_motor import pasta_kalem_kodu_seti, pasta_kalemi_mi
        _pasta_set = pasta_kalem_kodu_seti(cur)
        stok_alarmlari = []
        for ar in cur.fetchall():
            ad = dict(ar)
            kk = str(ad.get("kalem_kodu") or "")
            # Pasta/kek MUAF: her zaman tam gelmez, "tükendi" uyarısı gürültü olur
            if pasta_kalemi_mi(kk, _pasta_set):
                continue
            urun_adi = ad.get("kalem_adi") or kk
            mesaj = f"{urun_adi} — stokta tükendi. Depodan kontrol edin, sipariş girmeyi unutmayın."
            stok_alarmlari.append(
                {
                    "id": f"live:{sube_id}:{kk}",
                    "tip": "STOK_ALARM",
                    "seviye": "KRIZ",
                    "mesaj": mesaj,
                    "urun_adi": str(urun_adi),
                    "tarih": str(ad.get("guncelleme") or bugun_tr()),
                    "okundu": False,
                    "kalem_kodu": kk,
                }
            )
    except Exception:
        stok_alarmlari = []

    # Sevkiyat akışı uyarıları:
    # - Depodan çıkmış ama şube kabulü henüz girilmemiş satırlar
    # - Kabul girilmiş ancak sevk/kabul adedi uyumsuz satırlar (uzlaşma bekler)
    try:
        cur.execute(
            """
            SELECT y.id, y.siparis_talep_id, y.kalem_kodu, y.kalem_adi,
                   COALESCE(y.sevk_adet, 0) AS sevk_adet,
                   y.sevk_ts, t.sube_id AS hedef_sube_id, hs.ad AS hedef_sube_adi,
                   COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id) AS kaynak_depo_sube_id,
                   ks.ad AS kaynak_depo_sube_adi
            FROM stok_yolda y
            JOIN siparis_talep t ON t.id = y.siparis_talep_id
            LEFT JOIN subeler hs ON hs.id = t.sube_id
            LEFT JOIN subeler ks ON ks.id = COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id)
            WHERE (
                    t.sube_id=%s
                    OR COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id)=%s
                  )
              AND y.durum='yolda'
              AND y.sevk_ts >= NOW() - INTERVAL '7 days'
            ORDER BY y.sevk_ts DESC
            LIMIT 20
            """,
            (sube_id, sube_id),
        )
        for rr in cur.fetchall() or []:
            rd = dict(rr)
            hedef_sid = str(rd.get("hedef_sube_id") or "")
            kaynak_sid = str(rd.get("kaynak_depo_sube_id") or "")
            if hedef_sid == sube_id:
                msg = "Depodan siparişiniz çıktı — şube kabulü bekleniyor."
            elif kaynak_sid == sube_id:
                msg = "Gönderdiğiniz sevkiyat karşı şubede henüz kabul edilmedi."
            else:
                msg = "Sevkiyat kabul bekleniyor."
            stok_alarmlari.append(
                {
                    "id": f"yolda:{rd.get('id')}",
                    "tip": "SEVKIYAT_KABUL_BEKLIYOR",
                    "seviye": "KRITIK",
                    "mesaj": msg,
                    "tarih": str(rd.get("sevk_ts") or bugun_tr()),
                    "okundu": False,
                    "kalem_kodu": rd.get("kalem_kodu"),
                    "siparis_talep_id": rd.get("siparis_talep_id"),
                }
            )
    except Exception:
        pass

    try:
        cur.execute(
            """
            SELECT
                y.id, y.siparis_talep_id, y.kalem_kodu, y.kalem_adi,
                COALESCE(y.sevk_adet, 0) AS sevk_adet,
                COALESCE(y.kabul_adet, 0) AS kabul_adet,
                y.kabul_ts,
                t.sube_id AS hedef_sube_id,
                hs.ad AS hedef_sube_adi,
                COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id) AS kaynak_depo_sube_id,
                ks.ad AS kaynak_depo_sube_adi
            FROM stok_yolda y
            JOIN siparis_talep t ON t.id = y.siparis_talep_id
            LEFT JOIN subeler hs ON hs.id = t.sube_id
            LEFT JOIN subeler ks ON ks.id = COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id)
            WHERE (
                    t.sube_id=%s
                    OR COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id)=%s
                  )
              AND (
                    y.durum='kabul_uyusmazlik'
                    OR (
                      y.durum IN ('kabul_edildi', 'yolda')
                      AND y.kabul_ts IS NOT NULL
                      AND COALESCE(y.sevk_adet, 0) <> COALESCE(y.kabul_adet, 0)
                    )
                  )
            ORDER BY y.kabul_ts DESC NULLS LAST, y.sevk_ts DESC
            LIMIT 20
            """,
            (sube_id, sube_id),
        )
        for rr in cur.fetchall() or []:
            rd = dict(rr)
            sevk_ad = int(rd.get("sevk_adet") or 0)
            kabul_ad = int(rd.get("kabul_adet") or 0)
            fark = sevk_ad - kabul_ad
            stok_alarmlari.append(
                {
                    "id": f"uyumsuz:{rd.get('id')}",
                    "tip": "SEVKIYAT_UYUMSUZLUK",
                    "seviye": "KRIZ",
                    "mesaj": (
                        f"Sevkiyat uyumsuzluğu: {(rd.get('kalem_adi') or rd.get('kalem_kodu') or 'Kalem')} "
                        f"— sevk {sevk_ad}, kabul {kabul_ad}, fark {fark}."
                    ),
                    "tarih": str(rd.get("kabul_ts") or rd.get("sevk_ts") or bugun_tr()),
                    "okundu": False,
                    "kalem_kodu": rd.get("kalem_kodu"),
                    "siparis_talep_id": rd.get("siparis_talep_id"),
                    "kaynak_depo_sube_id": rd.get("kaynak_depo_sube_id"),
                    "kaynak_depo_sube_adi": rd.get("kaynak_depo_sube_adi"),
                    "hedef_sube_id": rd.get("hedef_sube_id"),
                    "hedef_sube_adi": rd.get("hedef_sube_adi"),
                    "fark_adet": fark,
                }
            )
    except Exception:
        pass

    stok_alarm_var = len(stok_alarmlari) > 0

    # Zorunlu görev var mı? — Windows arka plan scripti bu alanı okuyarak pencereyi öne getirir.
    zorunlu_gorev_var = False
    zorunlu_gorev_tip = None
    zorunlu_gorev_aciklama = None
    if akt_op and akt_op.get("durum") in ("bekliyor", "gecikti"):
        zorunlu_gorev_var = True
        _tip = akt_op.get("tip", "")
        _tip_tr = {"ACILIS": "Açılış", "KONTROL": "Kasa Sayımı", "KAPANIS": "Kapanış", "CIKIS": "Çıkış"}.get(_tip, _tip)
        zorunlu_gorev_tip = _tip
        zorunlu_gorev_aciklama = f"{_tip_tr} bekleniyor"
    elif any(not m.get("okundu") for m in merkez_mesajlar):
        zorunlu_gorev_var = True
        zorunlu_gorev_tip = "MERKEZ_MESAJ"
        zorunlu_gorev_aciklama = "Kritik merkez mesajı var"
    elif any(a.get("tip") == "SEVKIYAT_KABUL_BEKLIYOR" for a in stok_alarmlari):
        zorunlu_gorev_var = True
        zorunlu_gorev_tip = "SEVKIYAT_KABUL"
        zorunlu_gorev_aciklama = "Depo sevkiyatı kabul bekliyor"

    # Şube paneli kabul defteri (URUN_SEVK) — sadece özet görüntü, depo adedi göstermez.
    try:
        cur.execute(
            """
            SELECT id, tarih, bildirim_saati, personel_ad, personel_id, aciklama
            FROM operasyon_defter
            WHERE sube_id=%s AND etiket='URUN_SEVK'
              AND tarih >= CURRENT_DATE - INTERVAL '7 days'
            ORDER BY tarih DESC, olay_ts DESC NULLS LAST, id DESC
            LIMIT 20
            """,
            (sube_id,),
        )
        son_kabul_kayitlari = []
        for rr in cur.fetchall():
            rd = dict(rr)
            acik = str(rd.get("aciklama") or "")
            ozet = ""
            toplam_adet = 0
            if acik.startswith("URUN_SEVK_JSON:"):
                body = acik[len("URUN_SEVK_JSON:") :]
                if " | " in body:
                    body = body.split(" | ", 1)[0]
                try:
                    payload = json.loads(body)
                except Exception:
                    payload = {}
                if isinstance(payload, dict):
                    delta = payload.get("delta") if isinstance(payload.get("delta"), dict) else {}
                    parcalar = []
                    for k in STOK_KEYS:
                        try:
                            n = max(0, int(delta.get(k) or 0))
                        except Exception:
                            n = 0
                        if n <= 0:
                            continue
                        toplam_adet += n
                        parcalar.append(f"{n} {STOK_LABEL_TR.get(k) or k}")
                    kalemler = payload.get("kalemler") if isinstance(payload.get("kalemler"), list) else []
                    for it in kalemler:
                        if not isinstance(it, dict):
                            continue
                        ad = str(it.get("urun_ad") or "").strip()
                        try:
                            n = max(0, int(it.get("adet") or 0))
                        except Exception:
                            n = 0
                        if not ad or n <= 0:
                            continue
                        toplam_adet += n
                        parcalar.append(f"{n} {ad}")
                    ozet = " · ".join(parcalar[:4])
                    if len(parcalar) > 4:
                        ozet += f" · +{len(parcalar) - 4} kalem"
            son_kabul_kayitlari.append(
                {
                    "id": rd.get("id"),
                    "tarih": str(rd.get("tarih") or ""),
                    "saat": (str(rd.get("bildirim_saati") or "").strip() or "—"),
                    "personel": rd.get("personel_ad") or rd.get("personel_id") or "Personel ?",
                    "toplam_adet": toplam_adet,
                    "ozet": ozet or "Kayıt",
                    "kalemler_liste": parcalar,
                    "geri_alindi": False,
                }
            )
        # Geri alınmış (URUN_SEVK_IPTAL) kayıtları işaretle — UI pasif gösterir.
        if son_kabul_kayitlari:
            cur.execute(
                """
                SELECT ref_event_id FROM operasyon_defter
                WHERE sube_id=%s AND etiket='URUN_SEVK_IPTAL' AND ref_event_id IS NOT NULL
                  AND tarih >= CURRENT_DATE - INTERVAL '7 days'
                """,
                (sube_id,),
            )
            _iptal_set = {str(x.get("ref_event_id")) for x in (cur.fetchall() or [])}
            for _k in son_kabul_kayitlari:
                if str(_k.get("id")) in _iptal_set:
                    _k["geri_alindi"] = True
    except Exception:
        son_kabul_kayitlari = []

    try:
        cur.execute(
            """
            SELECT COUNT(*) FROM siparis_talep
            WHERE sube_id=%s AND durum NOT IN ('teslim_edildi', 'iptal')
              AND tarih >= CURRENT_DATE - INTERVAL '21 days'
            """,
            (sube_id,),
        )
        br = cur.fetchone()
        bekleyen_siparis_sayisi = int(list(br.values())[0]) if br else 0
    except Exception:
        bekleyen_siparis_sayisi = 0

    try:
        cur.execute(
            """
            SELECT COUNT(*) FROM siparis_talep t
            WHERE COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id) = %s
              AND t.tarih >= CURRENT_DATE - INTERVAL '21 days'
              AND t.durum NOT IN ('iptal', 'teslim_edildi', 'gonderilmedi', 'bekliyor', 'gonderildi')
            """,
            (sube_id,),
        )
        dr = cur.fetchone()
        depo_hazirlik_bekleyen_sayisi = int(list(dr.values())[0]) if dr else 0
    except Exception:
        depo_hazirlik_bekleyen_sayisi = 0

    try:
        cur.execute(
            """
            SELECT COUNT(*) AS adet
            FROM operasyon_defter
            WHERE sube_id=%s
              AND etiket='URUN_AC'
              AND tarih=CURRENT_DATE
            """,
            (sube_id,),
        )
        bugun_urun_ac_kayit = int((cur.fetchone() or {}).get("adet") or 0)
    except Exception:
        bugun_urun_ac_kayit = 0

    sube_tipi = str(sube.get("sube_tipi") or "normal").strip().lower()
    if sube_tipi == "sevkiyat":
        sube_tipi = "depo"
    elif sube_tipi == "merkez":
        sube_tipi = "karma"

    return {
        "sube_id": sube_id,
        "sube_adi": sube["ad"],
        "sube_tipi": sube_tipi,
        "acilis_saati": sube.get("acilis_saati") or "09:00",
        "kapanis_saati": sube.get("kapanis_saati") or "22:00",
        "tarih": str(bugun_tr()),
        "kasa_kilitli": kasa_kilitli,
        "yoklama_var": yoklama_yapildi_mi,
        "kasa_acma": kasa_acma,
        "sube_acik": sube_acildi_mi,
        "panel_kilitli": panel_blok,
        "panel_blok_asama": (
            "kasa" if kasa_kilitli else ("acilis" if not sube_acildi_mi else None)
        ),
        "panel_pin_kullanicilar": panel_pin_kullanicilar,
        "panel_yonetici_sayisi": panel_yonetici_sayisi,
        "kasa_teslim_alicilari": kasa_teslim_alicilari,
        "kasa_teslim_son_hareketler": kasa_teslim_son_hareketler,
        "acilis_kaydi": acilis_kaydi,
        "gorevler": gorevler,
        "tamamlanan": tamamlanan,
        "toplam_gorev": len(gorevler),
        "ciro_girildi": ciro_girildi,
        "ciro_taslak_bekliyor": ciro_taslak_bekliyor,
        "ciro_taslak": taslak_row,
        "ciro_ozet": {k: float(v) for k, v in ciro_ozet.items()},
        "anlik_gider_adet": anlik_adet,
        "bekleyen_gider_sayisi": bekleyen_gider_sayisi,
        "operasyon": operasyon,
        "vardiya_devir": vardiya_devir,
        "personel_operasyon_secim": personel_operasyon_secim,
        "merkez_mesajlar": merkez_mesajlar,
        "okunmamis_mesaj_var": okunmamis_mesaj_var,
        "stok_alarmlari": stok_alarmlari,
        "stok_alarm_var": stok_alarm_var,
        "son_kabul_kayitlari": son_kabul_kayitlari,
        "bekleyen_siparis_sayisi": bekleyen_siparis_sayisi,
        "depo_hazirlik_bekleyen_sayisi": depo_hazirlik_bekleyen_sayisi,
        "bugun_urun_ac_kayit": bugun_urun_ac_kayit,
        "siparis_red_bildirimleri": siparis_red_bildirimleri,
        "zorunlu_gorev_var": zorunlu_gorev_var,
        "zorunlu_gorev_tip": zorunlu_gorev_tip,
        "zorunlu_gorev_aciklama": zorunlu_gorev_aciklama,
    }


def sube_personel_panel_public(payload: dict) -> dict:
    """
    Personel şube paneli — KÖR FİLTRE: parasal ve ürünsel veriler çıkarılır.
    Kasa / ürün sayım tutarsızlığı şube panelinde gösterilmez (operasyon merkezi).
    Depo uyarıları (stok_alarmlari) geçirilir. Vardiya devri blob'u korunur (imza akışı).
    """
    p = dict(payload)
    # Parasal alanlar — tamamen kaldır
    p.pop("ciro_ozet", None)
    p.pop("ciro_taslak", None)
    p.pop("anlik_gider_adet", None)
    p.pop("bekleyen_gider_sayisi", None)
    # Ürünsel alanlar — tamamen kaldır
    p.pop("bugun_urun_ac_kayit", None)
    # Kasa teslim geçmişi: tarih/isim bilgisi kalır, TL tutarı çıkar
    kt = p.get("kasa_teslim_son_hareketler")
    if isinstance(kt, list):
        p["kasa_teslim_son_hareketler"] = [
            {k: v for k, v in item.items() if k != "tutar"} for item in kt
        ]
    # Stok alarmlari: sevkiyat uyumsuzluğunda adet/fark sayıları çıkar
    sa = p.get("stok_alarmlari")
    if isinstance(sa, list):
        temiz = []
        for alarm in sa:
            if alarm.get("tip") == "SEVKIYAT_UYUMSUZLUK":
                alarm = {
                    k: v for k, v in alarm.items()
                    if k not in ("sevk_adet", "kabul_adet", "fark_adet")
                }
                alarm["mesaj"] = "Sevkiyat uyumsuzluğu var — depo ile kontrol edin."
            temiz.append(alarm)
        p["stok_alarmlari"] = temiz
    # Kabul kayıtları: ürün adedi ve özeti çıkar, sadece tarih/personel kalır
    sk = p.get("son_kabul_kayitlari")
    if isinstance(sk, list):
        p["son_kabul_kayitlari"] = [
            {k: v for k, v in item.items() if k not in ("toplam_adet", "ozet")}
            for item in sk
        ]
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
            "kapanis_tamamlandi_bugun": op.get("kapanis_tamamlandi_bugun"),
            "events_ozet": [
                {
                    "id": e.get("id"),
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
            "uyarilar": [],
        }
    p["uyari"] = (
        "Kasa ve açılış/kapanış ürün tutarsızlıkları bu ekranda gösterilmez (operasyon merkezi). "
        "Depo stok uyarıları Ana ekranda listelenir."
    )
    return p


@router.post("/{sube_id}/kasa-yoklama-ac")
def kasa_yoklama_ile_ac(sube_id: str):
    """QR yoklama onaylandıktan sonra kasa kilidini PIN'siz aç."""
    with db() as (conn, cur):
        # Bugün yoklama var mı kontrol et
        cur.execute("SELECT personel_id FROM gorev_yoklama WHERE sube_id=%s AND tarih=%s ORDER BY giris_ts LIMIT 1", (sube_id, is_gunu_tr()))
        row = cur.fetchone()
        if not row:
            raise HTTPException(403, "Yoklama kaydı bulunamadı")
        pid = str(row["personel_id"])
        _kasa_gunu_pin_sonrasi_ac(cur, sube_id, pid, "QR Yoklama")
        conn.commit()
    return {"success": True}


@router.get("/{sube_id}/yoklama-durum")
def sube_panel_yoklama_durum(sube_id: str):
    """Panel sayfası polling için: bugün yoklama var mı + QR URL."""
    import os as _os
    base = _os.getenv("APP_URL", "https://evvel-erp-production.up.railway.app")
    with db() as (conn, cur):
        cur.execute("""
            SELECT personel_id, vardiya_tip, giris_ts, konum_onaylandi
            FROM gorev_yoklama
            WHERE sube_id=%s AND tarih=%s
            ORDER BY giris_ts DESC LIMIT 1
        """, (sube_id, is_gunu_tr()))
        row = cur.fetchone()
    return {
        "yoklama_var": row is not None,
        "son_giris": dict(row) if row else None,
        "qr_url": f"{base}/api/gorev/qr/{sube_id}",
        "giris_url": f"{base}/gorev-giris/{sube_id}",
    }


@router.get("/{sube_id}")
def sube_panel_getir(sube_id: str):
    with db() as (conn, cur):
        return _build_sube_panel_payload(cur, sube_id)


@router.post("/{sube_id}/aktivite")
def sube_panel_aktivite(sube_id: str):
    """Panel sekme hareketi sinyali — latent KONTROL eventlerini aktive eder.

    Frontend her sekme değişikliğinde bu endpoint'e POST atar.
    Mevcut latent KONTROL eventleri varsa 'bekliyor' durumuna geçirilir ve
    gerçek deadline hesaplanır (NOW + cevap_penceresi_dk).
    Sonuç: kasa kontrol uyarısı yalnızca personel panelde aktifken çıkar.
    """
    from sube_operasyon import aktivasyon_kontrol
    with db() as (conn, cur):
        aktivasyon_kontrol(cur, sube_id)
        conn.commit()
    return {"ok": True}


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
    raise HTTPException(
        410,
        "Bu uç kapatıldı. Ciro yalnızca operasyon KAPANIS adımıyla merkeze gönderilir.",
    )


class SubeAnlikGiderModel(BaseModel):
    kategori: str
    tutar: float
    aciklama: Optional[str] = None
    personel_id: str
    pin: str
    fis_gonderildi: bool = False


class AraTeslimModel(BaseModel):
    tutar: float
    teslim_alan_id: str
    personel_id: str
    pin: str
    aciklama: Optional[str] = None


@router.post("/{sube_id}/ara-kasa-teslim")
def sube_ara_kasa_teslim(sube_id: str, body: AraTeslimModel):
    """Gün içi ara kasa teslimi — kasa_teslim tablosuna 'ara' tipiyle yazar."""
    if body.tutar <= 0:
        raise HTTPException(400, "Tutar sıfırdan büyük olmalı")
    pid_in = (body.personel_id or "").strip()
    pin = (body.pin or "").replace(" ", "")
    if not pid_in:
        raise HTTPException(400, "personel_id gerekli")
    if len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "4 haneli panel PIN gerekli")

    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        if not _bugun_kasa_acildi_mi(cur, sube_id):
            raise HTTPException(403, "Günlük kasa henüz açılmamış")
        ku = dogrula_personel_panel_pin(cur, pid_in, pin)
        onay_ad = (ku.get("ad_soyad") or "").strip() or "—"
        pid_panel = str(ku.get("id") or "").strip() or pid_in

        cur.execute(
            "SELECT id, ad, unvan FROM kasa_teslim_alici WHERE id=%s AND aktif=TRUE",
            ((body.teslim_alan_id or "").strip(),),
        )
        alici_row = cur.fetchone()
        if not alici_row:
            raise HTTPException(404, "Teslim alıcı bulunamadı")
        alici_d = dict(alici_row)
        alici_ad = alici_d["ad"] + (" — " + alici_d["unvan"] if alici_d.get("unvan") else "")

        kt_id = str(uuid.uuid4())
        cur.execute(
            """INSERT INTO kasa_teslim
               (id, sube_id, tarih, tutar,
                teslim_eden_personel_id, teslim_eden_ad,
                teslim_alan_id, teslim_alan_ad,
                teslim_turu, aciklama)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'ara', %s)""",
            (
                kt_id, sube_id, is_gunu_tr(), float(body.tutar),
                pid_panel, onay_ad,
                alici_d["id"], alici_ad,
                (body.aciklama or "").strip() or None,
            ),
        )
        from operasyon_defter import operasyon_defter_ekle
        from tr_saat import dt_now_tr
        saat = dt_now_tr().strftime("%H:%M:%S")
        operasyon_defter_ekle(
            cur, sube_id, "KASA_ARA_TESLIM",
            f"Ara kasa teslim — {onay_ad} → {alici_ad} — {body.tutar:,.0f}₺",
            bildirim_saati=saat, personel_id=pid_panel, personel_ad=onay_ad,
        )
    return {"success": True, "id": kt_id}


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
            VALUES (%s, %s, %s, %s, %s, %s, 'nakit', 'onay_bekliyor', %s,
                    %s, 'bekliyor')
            """,
            # FIX KP4 (2026-07-06): CURRENT_DATE (UTC sunucu takvimi) yerine is_gunu_tr() — gece
            # yarısı sonrası (TR 00:00-03:00) girilen gider yanlış güne düşüp o günün kapanış
            # farkını iki uçtan bozuyordu (dosyadaki tüm diğer yazımlar zaten is_gunu_tr kullanıyor).
            (gid, is_gunu_tr(), body.kategori, body.tutar, acik, sube_id, pid_panel, bool(body.fis_gonderildi)),
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
    from operasyon_stok_motor import (
        normalize_delta_body,
        STOK_KEYS,
        sube_depo_stok_depo_giris_ekle,
    )

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

        # Fiziksel şube deposu: defterle aynı miktarları ekle (Operasyon Merkezi depo listesi)
        for kalem_kodu in STOK_KEYS:
            miktar = int(delta.get(kalem_kodu) or 0)
            if miktar <= 0:
                continue
            sube_depo_stok_depo_giris_ekle(cur, sube_id, kalem_kodu, None, miktar)

    return {"success": True, "defter_id": rid, "delta": delta}


class SubeFireBildirBody(BaseModel):
    """Şube fire / zayi bildirimi — depo düşer, merkez listesine düşer."""

    personel_id: str
    pin: str
    sebep_kodu: str
    aciklama: Optional[str] = ""  # backward-compat: bazı sebepler için boş geçilebilir; backend zorunluluk kontrolü iş katmanında
    kalemler: List[Dict[str, Any]] = []
    not_aciklama: Optional[str] = None
    fis_no: Optional[str] = None
    iade_zaman: Optional[str] = None
    iade_musteri_ad: Optional[str] = None
    iade_musteri_telefon: Optional[str] = None
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


@router.post("/{sube_id}/fire-bildir")
def sube_fire_bildir(sube_id: str, body: SubeFireBildirBody):
    from fire_bildirim import fire_bildirim_kaydet, fire_bildirim_sube_yanit, FIRE_SEBEP
    from tr_saat import bugun_tr

    pid_in = (body.personel_id or "").strip()
    pin = (body.pin or "").replace(" ", "")
    if not pid_in:
        raise HTTPException(400, "personel_id gerekli")
    if len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "4 haneli panel PIN gerekli")
    kod = (body.sebep_kodu or "").strip().lower()
    if kod not in FIRE_SEBEP:
        raise HTTPException(400, "Geçersiz fire sebebi")

    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        if not _bugun_kasa_acildi_mi(cur, sube_id):
            raise HTTPException(403, "Önce günlük kasa kilidini PIN ile açmalısınız.")
        if not _bugun_sube_acildi_mi(cur, sube_id):
            raise HTTPException(403, "Önce şubeyi açmalısınız.")
        ku = dogrula_personel_panel_pin(cur, pid_in, pin)
        onay_ad = (ku.get("ad_soyad") or "").strip() or "—"
        pid_panel = str(ku.get("id") or "").strip() or pid_in
        try:
            out = fire_bildirim_kaydet(
                cur,
                sube_id,
                personel_id=pid_panel,
                personel_ad=onay_ad,
                sebep_kodu=kod,
                aciklama=(body.aciklama or "").strip(),
                kalemler=body.kalemler or [],
                body_delta=body.model_dump(),
                not_aciklama=body.not_aciklama,
                tarih=bugun_tr(),
                fis_no=body.fis_no,
                iade_zaman=body.iade_zaman,
                iade_musteri_ad=body.iade_musteri_ad,
                iade_musteri_telefon=body.iade_musteri_telefon,
            )
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        audit(cur, "sube_fire_bildirim", out["id"], "SUBE_FIRE")

    return fire_bildirim_sube_yanit(out)


# ─────────────────────────────────────────────────────────────
# SEVK — Tedarikçi/toptancı teslimi (potansiyel stok, URUN_SEVK)
# ─────────────────────────────────────────────────────────────

class SubeSevkBody(BaseModel):
    """Tedarikçi/toptancıdan gelen ürün teslim alımı. Depo stoğuna yazar; URUN_SEVK defterine kaydedilir."""
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
    toptanci_siparis_id: Optional[str] = None  # bekleyen toptancı siparişine bağla (Faz 2)
    varyans_notlari: Optional[List[Dict[str, Any]]] = None  # [{urun_ad, not}] görünür fazla/eksik açıklaması
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


@router.get("/{sube_id}/toptanci-siparis-bekleyen")
def sube_toptanci_siparis_bekleyen(sube_id: str):
    """
    Şubeye gelmesi beklenen (henüz teslim alınmamış) toptancı siparişleri.
    Her satır = bir tedarikçiye giden gönderim + O tedarikçinin N2 kalemleri.
    Şube bunu görerek KÖR saymaz; beklenen listeye göre kabul eder.
    """
    out: List[Dict[str, Any]] = []
    with db() as (conn, cur):
        try:
            cur.execute(
                """
                SELECT ts.id, ts.talep_id, ts.tedarikci_id, ts.tedarikci_ad,
                       ts.kalemler, ts.not_aciklama, ts.olusturma,
                       ts.wa_gonderim_ts, ts.wa_durum, ts.kaynak
                FROM toptanci_siparis ts
                JOIN siparis_talep t ON t.id = ts.talep_id
                WHERE ts.sube_id = %s
                  AND ts.durum = 'gonderildi'
                  AND t.durum NOT IN ('teslim_edildi', 'iptal')
                ORDER BY ts.olusturma DESC
                """,
                (sube_id,),
            )
            rows = cur.fetchall() or []
        except Exception:
            rows = []
        for r in rows:
            d = dict(r)
            kl = d.get("kalemler") or []
            if isinstance(kl, str):
                try:
                    kl = json.loads(kl)
                except Exception:
                    kl = []
            kalemler = [
                {
                    "urun_ad": str(k.get("urun_ad") or "").strip(),
                    "adet": int(k.get("adet") or 0),
                    "urun_id": k.get("urun_id"),
                    "kalem_kodu": k.get("kalem_kodu"),
                    "kategori_kod": k.get("kategori_kod"),
                }
                for k in kl
                if str(k.get("urun_ad") or "").strip()
            ]
            out.append({
                "id": str(d.get("id")),
                "talep_id": str(d.get("talep_id") or ""),
                "tedarikci_id": (str(d.get("tedarikci_id") or "").strip() or None),
                "tedarikci_ad": (str(d.get("tedarikci_ad") or "").strip() or "—"),
                "kalemler": kalemler,
                "kalem_sayisi": len(kalemler),
                "not_aciklama": (str(d.get("not_aciklama") or "").strip() or None),
                "olusturma": str(d.get("olusturma") or "")[:16].replace("T", " "),
                "wa_gonderildi": (str(d.get("wa_durum") or "") == "gonderildi"),
                "kaynak": (str(d.get("kaynak") or "sube")),
            })
    return {"siparisler": out}


@router.post("/{sube_id}/urun-sevk")
def sube_urun_sevk(sube_id: str, body: SubeSevkBody):
    """
    Tedarikçi/toptancı teslim kaydı (URUN_SEVK).
    Teslim alınan kalemler şube deposuna +stok olarak yazılır; aktif kullanım (Ürün Aç) ayrı akıştır.
    Merkez bu kaydı «Toptancıdan Gelenler» ekranında izler; sipariş kapatma şube tarafında yapılmaz.
    """
    from operasyon_stok_motor import (
        depo_kalem_kodu_resolve,
        sube_depo_stok_depo_giris_ekle,
    )

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
    # Havuz (pool) kaldırıldı — artık sadece kalemler listesi geçerli
    delta: dict = {}
    if not kalemler:
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
            # Siparişsiz teslim ayırımı için: bağlı sipariş varsa id, yoksa null.
            "siparis_talep_id": ((body.siparis_talep_id or "").strip() or None),
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

        # ── BODY'den siparis_talep_id'yi al — toptancıdan gelen ürünü siparişle eşleştir ──
        # Eğer dolu ise: bu sevk kaydı belirli bir şube siparişine karşılık geliyor demek.
        # Siparişi 'teslim_edildi' olarak kapat, kabul timestamp/personel kaydet.
        siparis_talep_id = (body.siparis_talep_id or "").strip() or None
        toptanci_siparis_id = (body.toptanci_siparis_id or "").strip() or None
        # Şubenin yazdığı görünür fazla/eksik açıklamaları: {urun_ad(lower): not}
        _varyans_not_map: Dict[str, str] = {}
        for _vn in (body.varyans_notlari or []):
            if isinstance(_vn, dict):
                _vad = str(_vn.get("urun_ad") or "").strip().lower()
                _vnot = str(_vn.get("not") or _vn.get("aciklama") or "").strip()
                if _vad and _vnot:
                    _varyans_not_map[_vad] = _vnot[:300]
        siparis_kapama_sonucu: Optional[Dict[str, Any]] = None
        if siparis_talep_id:
            cur.execute(
                """
                SELECT id, sube_id, durum, sevkiyat_durumu,
                       merkez_karar_kalemleri, kalemler
                FROM siparis_talep
                WHERE id=%s
                FOR UPDATE
                """,
                (siparis_talep_id,),
            )
            _talep_row = cur.fetchone()
            if not _talep_row:
                raise HTTPException(404, "Eşleştirilecek sipariş bulunamadı (talep_id geçersiz)")
            _talep = dict(_talep_row)
            _talep_sube = str(_talep.get("sube_id") or "")
            if _talep_sube != sube_id:
                raise HTTPException(403, "Bu sipariş bu şubeye ait değil")
            _talep_durum = str(_talep.get("durum") or "")
            _talep_sevkiyat = str(_talep.get("sevkiyat_durumu") or "")
            # Kabul uygunluk kontrolü:
            # - toptanci_siparis_id VARSA: BU tedarikçi siparişi seviyesinde bak. Kısmi
            #   dağıtımda (bazı kalemler henüz dağıtılmadı) talep 'bekliyor' kalır AMA bu
            #   tedarikçiye gönderilmiş sipariş kabul edilebilir olmalı (talep-seviyesi şart değil).
            # - toptanci_siparis_id YOKSA (ad-hoc): eski talep-seviyesi kural geçerli.
            if toptanci_siparis_id:
                cur.execute(
                    "SELECT durum FROM toptanci_siparis WHERE id=%s AND talep_id=%s",
                    (toptanci_siparis_id, siparis_talep_id),
                )
                _ts_chk = cur.fetchone()
                if not _ts_chk:
                    raise HTTPException(404, "Toptancı siparişi bulunamadı (bu talebe ait değil).")
                if str(dict(_ts_chk).get("durum") or "") == "iptal":
                    raise HTTPException(400, "Bu toptancı siparişi iptal edilmiş — teslim alınamaz.")
            elif _talep_sevkiyat != "toptanciya_yonlendirildi":
                raise HTTPException(
                    400,
                    f"Bu sipariş toptancıya yönlendirilmemiş (sevkiyat_durumu: {_talep_sevkiyat or '—'}). "
                    "Depodan gelen siparişler için 'Depo Kabul' kullanın.",
                )
            if _talep_durum in ("teslim_edildi", "iptal"):
                raise HTTPException(
                    400,
                    f"Bu sipariş zaten kapatılmış (durum: {_talep_durum}). Yeniden teslim alınamaz.",
                )
            # Sipariş kalemleriyle kabul kalemlerini karşılaştır → uyuşmazlık varsa uyarı (kör denetim)
            # REFERANS: N2 (merkez_karar_kalemleri = ops'un toptancıya sipariş ettiği
            # miktar) varsa ONUNLA karşılaştır; yoksa N1'e (kalemler_ozet = şube
            # talebi) düş. Böylece "5 istedim 6 sipariş ettim" zincirinde kabul
            # DOĞRU referansla (6) karşılaştırılır, yanlış fazla/eksik alarmı olmaz.
            try:
                import json as _j2
                _ref_kaynak = "N1_talep"
                _orig_kalemler = None
                # En kesin referans: belirli toptancı siparişinin (bu tedarikçiye
                # giden) kendi N2 kalemleri. Split'te aggregate yanıltır; satır kesin.
                if toptanci_siparis_id:
                    cur.execute(
                        "SELECT kalemler FROM toptanci_siparis WHERE id=%s AND talep_id=%s",
                        (toptanci_siparis_id, siparis_talep_id),
                    )
                    _ts_row = cur.fetchone()
                    if _ts_row:
                        _orig_kalemler = dict(_ts_row).get("kalemler")
                        _ref_kaynak = "N2_toptanci_siparis"
                if not _orig_kalemler:
                    _orig_kalemler = _talep.get("merkez_karar_kalemleri")
                    if _orig_kalemler:
                        _ref_kaynak = "N2_merkez"
                    else:
                        # N1 = şube talebi kalemleri. 'kalemler_ozet' bir DB kolonu
                        # DEĞİL (kalemler'den hesaplanan görünüm alanı) → gerçek
                        # kolon 'kalemler' kullanılır (UndefinedColumn fix 2026-06-16).
                        _orig_kalemler = _talep.get("kalemler") or []
                if isinstance(_orig_kalemler, str):
                    _orig_kalemler = _j2.loads(_orig_kalemler)
                _orig_map = {}
                for _ok in (_orig_kalemler or []):
                    _ad = str(_ok.get("urun_ad") or "").strip().lower()
                    if _ad:
                        _orig_map[_ad] = _orig_map.get(_ad, 0) + int(_ok.get("adet") or 0)
                _kabul_map = {}
                for _kk in kalemler:
                    _ad = str(_kk.get("urun_ad") or "").strip().lower()
                    if _ad:
                        _kabul_map[_ad] = _kabul_map.get(_ad, 0) + int(_kk.get("adet") or 0)
                _uyusmazlik_satirlar = []
                for _ad, _ist in _orig_map.items():
                    _kab = _kabul_map.get(_ad, 0)
                    if _kab != _ist:
                        _satir = {
                            "urun_ad": _ad, "istenen": _ist, "kabul": _kab, "fark": _kab - _ist,
                        }
                        if _varyans_not_map.get(_ad):
                            _satir["aciklama"] = _varyans_not_map[_ad]
                        _uyusmazlik_satirlar.append(_satir)
                # Sadece sipariş listesinde olmayan ekstra ürün de uyarı (fazladan ürün?)
                for _ad, _kab in _kabul_map.items():
                    if _ad not in _orig_map:
                        _satir = {
                            "urun_ad": _ad, "istenen": 0, "kabul": _kab, "fark": _kab,
                            "ekstra": True,
                        }
                        if _varyans_not_map.get(_ad):
                            _satir["aciklama"] = _varyans_not_map[_ad]
                        _uyusmazlik_satirlar.append(_satir)
                if _uyusmazlik_satirlar:
                    import json as _j3
                    _uyari_id = str(uuid.uuid4())
                    cur.execute(
                        """
                        INSERT INTO sube_operasyon_uyari
                            (id, sube_id, tarih, tip, seviye, mesaj, detay_json,
                             kapanis_personel_id, kapanis_personel_ad)
                        VALUES (%s, %s, CURRENT_DATE, 'TOPTANCI_KABUL_FARKI', 'uyari', %s, %s::jsonb, %s, %s)
                        """,
                        (
                            _uyari_id, sube_id,
                            f"Toptancı teslim kabulü uyuşmazlık ({len(_uyusmazlik_satirlar)} kalem)",
                            _j3.dumps({
                                "siparis_talep_id": siparis_talep_id,
                                "uyusmazlik_satirlar": _uyusmazlik_satirlar,
                                "referans_kaynak": _ref_kaynak,
                                "tedarikci_id": tedarikci_id,
                                "tedarikci_ad": tedarikci_ad,
                            }, ensure_ascii=False),
                            pid_panel, onay_ad,
                        ),
                    )
            except Exception:
                pass  # Uyuşmazlık tespit hatası kabul'u engellemez

            # Bu toptancı siparişi satırını teslim_alindi yap (tamamlanma kontrolünden ÖNCE)
            if toptanci_siparis_id:
                cur.execute(
                    """
                    UPDATE toptanci_siparis
                    SET durum='teslim_alindi', teslim_ts=NOW()
                    WHERE id=%s AND talep_id=%s
                    """,
                    (toptanci_siparis_id, siparis_talep_id),
                )
                # İZOLE — Belge Talep Motoru: teslim alınınca tedarikçiden fatura PDF'i
                # kovalamak için bir "belge talep" kaydı aç. Kendi transaction'ında çalışır,
                # her hata YUTULUR → teslim-al akışını ASLA bozmaz. (Kaldırmak = bu blok sil.)
                try:
                    from belge_talep_api import belge_talep_olustur_izole
                    belge_talep_olustur_izole(toptanci_siparis_id)
                except Exception:
                    pass

            _yeni_durum = "kabul_uyusmazlik" if (teslim_durumu == "eksik_var") else "teslim_edildi"
            _kabul_durum = "kabul_uyusmazlik" if (teslim_durumu == "eksik_var") else "kabul_tam"

            # ── Çok-tedarikçili akış: talep ancak HER ŞEY dağıtılıp HER GÖNDERİM
            # teslim alınınca kapanır. Aksi halde açık kalır → kalan kalemler/
            # bekleyen diğer tedarikçi teslimleri KAYBOLMAZ. (split veri kaybı fix)
            _kapat = True
            if toptanci_siparis_id:
                # (a) Dağıtılmamış kalan var mı? N1 (kalemler) − tüm dağıtılan
                _n1 = _talep.get("kalemler") or []
                if isinstance(_n1, str):
                    try:
                        _n1 = _j2.loads(_n1)
                    except Exception:
                        _n1 = []
                _n1_map: Dict[str, int] = {}
                for _o in (_n1 or []):
                    _oad = str((_o or {}).get("urun_ad") or "").strip().lower()
                    if _oad:
                        _n1_map[_oad] = _n1_map.get(_oad, 0) + max(0, int((_o or {}).get("adet") or 0))
                cur.execute(
                    "SELECT kalemler FROM toptanci_siparis WHERE talep_id=%s AND durum <> 'iptal'",
                    (siparis_talep_id,),
                )
                _disp_map: Dict[str, int] = {}
                for _dr in cur.fetchall() or []:
                    _dkl = dict(_dr).get("kalemler") or []
                    if isinstance(_dkl, str):
                        try:
                            _dkl = _j2.loads(_dkl)
                        except Exception:
                            _dkl = []
                    for _dk in _dkl:
                        _dad = str((_dk or {}).get("urun_ad") or "").strip().lower()
                        if _dad:
                            _disp_map[_dad] = _disp_map.get(_dad, 0) + int((_dk or {}).get("adet") or 0)
                # Kalem-bazlı coverage: hiç dağıtılmamış ÜRÜN sayısı (miktar farkı değil)
                _kalan_dagitilmamis = sum(
                    1 for _ad in _n1_map if _ad not in _disp_map
                )
                # (b) Henüz teslim alınmamış başka gönderim var mı?
                cur.execute(
                    "SELECT COUNT(*) AS n FROM toptanci_siparis WHERE talep_id=%s AND durum='gonderildi'",
                    (siparis_talep_id,),
                )
                _bekleyen_gonderim = int(dict(cur.fetchone() or {}).get("n") or 0)
                _kapat = (_kalan_dagitilmamis <= 0) and (_bekleyen_gonderim == 0)

            if _kapat:
                cur.execute(
                    """
                    UPDATE siparis_talep
                    SET durum=%s,
                        kabul_durum=%s,
                        kabul_ts=NOW(),
                        kabul_personel_id=%s,
                        kabul_personel_ad=%s
                    WHERE id=%s
                    """,
                    (_yeni_durum, _kabul_durum, pid_panel, onay_ad, siparis_talep_id),
                )
            else:
                # Kısmen teslim — talebi kapatma; kabul bilgisini kaydet (durum dokunma).
                cur.execute(
                    """
                    UPDATE siparis_talep
                    SET kabul_ts=NOW(),
                        kabul_personel_id=%s,
                        kabul_personel_ad=%s
                    WHERE id=%s
                    """,
                    (pid_panel, onay_ad, siparis_talep_id),
                )
            siparis_kapama_sonucu = {
                "kapatildi": _kapat,
                "yeni_durum": (_yeni_durum if _kapat else str(_talep.get("durum") or "")),
                "kabul_durum": _kabul_durum,
            }

        # Havuz (pool) mantığı tamamen kaldırıldı — her ürün kendi UUID'siyle işlenir.
        # STOK_KEYS döngüsü yok; sadece kalemler listesindeki UUID satırlar işlenir.
        for it in kalemler:
            if not isinstance(it, dict):
                continue
            urun_ad = str(it.get("urun_ad") or "").strip()
            if not urun_ad:
                continue
            try:
                adet_i = max(0, int(it.get("adet") or 0))
            except (TypeError, ValueError):
                adet_i = 0
            if adet_i <= 0:
                continue
            urun_id = str(it.get("urun_id") or "").strip()
            if not urun_id:
                # Masaüstü/şube paneli sipariş kabulü urun_id TAŞIMAZ ama kalem_kodu =
                # KANONİK siparis_urun UUID'sidir (sube_panel.html:10829). Onu siparis_urun'da
                # DOĞRULAYIP urun_id gibi kullan → kanonik depo artar, ozel__ tuzağına düşmez.
                # (Cep siparişi kalem_kodu='k_0' gibi index → siparis_urun'da YOK → aşağıda
                #  ada göre çözülür; bu kontrol onu bozmaz.)
                _gelen_kod = str(it.get("kalem_kodu") or "").strip()
                if _gelen_kod:
                    try:
                        cur.execute("SELECT 1 FROM siparis_urun WHERE id::text=%s LIMIT 1", (_gelen_kod,))
                        if cur.fetchone():
                            urun_id = _gelen_kod
                    except Exception:
                        pass
            if urun_id:
                depo_kalem = depo_kalem_kodu_resolve(cur, urun_id, urun_ad)
                cur.execute(
                    """
                    INSERT INTO merkez_stok_sevk
                        (id, sube_id, kalem_kodu, adet, siparis_talep_id, tarih)
                    VALUES
                        (%s, %s, %s, %s, %s, CURRENT_DATE)
                    """,
                    (str(uuid.uuid4()), sube_id, depo_kalem, adet_i, siparis_talep_id),
                )
                sube_depo_stok_depo_giris_ekle(
                    cur, sube_id, depo_kalem, urun_ad, adet_i
                )
                continue
            # urun_id eksik (örn. Cep'ten gelen toptancı siparişi urun_id taşımıyor) →
            # ÖNCE ada göre kanonik katalog kalemini çöz; ozel__ fallback'e SON çare olarak düş.
            # Aksi halde teslim alınan ürün ozel__espresso gibi ayrı kaleme yazılıp
            # kanonik depo "artmadı" görünür (ozel__ kopya tuzağı).
            kalem_kodu = None
            try:
                cur.execute(
                    "SELECT id FROM siparis_urun WHERE lower(btrim(ad))=lower(btrim(%s)) "
                    "ORDER BY (depo_stok_kalem_kodu IS NULL) DESC LIMIT 1",
                    (urun_ad,),
                )
                _ur = cur.fetchone()
                if _ur:
                    kalem_kodu = depo_kalem_kodu_resolve(cur, str(dict(_ur)["id"]), urun_ad) or None
            except Exception:
                kalem_kodu = None
            if not kalem_kodu:
                kalem_kodu = f"ozel__{_norm_ad_tr(urun_ad)}"  # son çare
            sube_depo_stok_depo_giris_ekle(cur, sube_id, kalem_kodu, urun_ad, adet_i)

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
# HATALI TESLİM GERİ AL — yanlış "Ürün Teslim Al" (URUN_SEVK) kaydını
# işletme (Merve Karabacak) çift onayıyla tersine çevir.
# ─────────────────────────────────────────────────────────────
def _isletme_onay_personel(cur: Any) -> Dict[str, Any]:
    """Geri-al gibi hassas işlemler için sabit işletme (sahip) onay kişisi: Merve Karabacak.
    İsimle bulunur; tam tek eşleşme şarttır. İşletme hesabı mantığı."""
    cur.execute(
        """
        SELECT id, ad_soyad
        FROM personel
        WHERE aktif = TRUE AND ad_soyad ILIKE '%merve%karabacak%'
        ORDER BY ad_soyad
        LIMIT 2
        """
    )
    rows = [dict(x) for x in (cur.fetchall() or [])]
    if not rows:
        raise HTTPException(403, "İşletme onay yetkilisi (Merve Karabacak) tanımlı değil.")
    if len(rows) > 1:
        raise HTTPException(409, "Birden fazla 'Merve Karabacak' kaydı var — merkeze bildirin.")
    return rows[0]


def _urun_sevk_payload_coz(aciklama: str) -> Dict[str, Any]:
    """'URUN_SEVK_JSON:{...} | ...' biçiminden JSON gövdesini güvenli ayıkla."""
    acik = str(aciklama or "")
    pre = "URUN_SEVK_JSON:"
    if not acik.startswith(pre):
        raise HTTPException(400, "Bu kayıt bir teslim alım (URUN_SEVK) kaydı değil.")
    govde = acik[len(pre):]
    try:
        obj, _ = json.JSONDecoder().raw_decode(govde)
    except Exception:
        raise HTTPException(400, "Teslim kaydı çözümlenemedi.")
    if not isinstance(obj, dict):
        raise HTTPException(400, "Teslim kaydı çözümlenemedi.")
    return obj


class SubeSevkGeriAlBody(BaseModel):
    """Hatalı 'Ürün Teslim Al' (URUN_SEVK) kaydını geri al — çift imza."""
    defter_id: str
    personel_id: str          # işlemi yapan operatör
    pin: str                  # operatör PIN
    onay_pin: str             # İŞLETME onayı — her zaman Merve Karabacak PIN'i
    sebep: str                # neden geri alınıyor (zorunlu)


@router.post("/{sube_id}/urun-sevk-geri-al")
def sube_urun_sevk_geri_al(sube_id: str, body: SubeSevkGeriAlBody):
    """
    Yanlış kullanılan 'Ürün Teslim Al' (URUN_SEVK) kaydını tersine çevirir:
    eklenen depo stoğunu düşer, dengeleyici ters defter kaydı (URUN_SEVK_IPTAL) yazar.
    İki imza gerekir: işlemi yapan personel + işletme onayı (Merve Karabacak).
    Bir siparişi kapatmış (talep_id'li) sevk buradan geri alınamaz — o merkez işidir.
    """
    from operasyon_stok_motor import (
        depo_kalem_kodu_resolve,
        sube_depo_stok_depo_cikis_dus,
    )
    from operasyon_defter import operasyon_defter_ekle

    did = (body.defter_id or "").strip()
    pid_in = (body.personel_id or "").strip()
    pin = (body.pin or "").replace(" ", "")
    onay_pin = (body.onay_pin or "").replace(" ", "")
    sebep = (body.sebep or "").strip()
    if not did:
        raise HTTPException(400, "defter_id gerekli")
    if not pid_in or len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "İşlemi yapan personel + 4 haneli PIN gerekli")
    if len(onay_pin) != 4 or not onay_pin.isdigit():
        raise HTTPException(400, "İşletme onayı için 4 haneli PIN gerekli")
    if len(sebep) < 3:
        raise HTTPException(400, "Geri alma sebebi zorunlu (en az 3 karakter)")

    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        if not _bugun_kasa_acildi_mi(cur, sube_id):
            raise HTTPException(403, "Önce günlük kasa kilidini PIN ile açmalısınız.")
        # 1) Operatör imzası
        ku = dogrula_personel_panel_pin(cur, pid_in, pin)
        op_ad = (ku.get("ad_soyad") or "").strip() or "—"
        op_id = str(ku.get("id") or "").strip() or pid_in
        # 2) İşletme (Merve Karabacak) imzası — her zaman zorunlu
        merve = _isletme_onay_personel(cur)
        if str(merve.get("id")) == op_id:
            raise HTTPException(409, "İşletme onayı operatörden farklı kişi (Merve Karabacak) olmalı.")
        dogrula_personel_panel_pin(cur, str(merve["id"]), onay_pin)
        merve_ad = (merve.get("ad_soyad") or "Merve Karabacak").strip()

        # 3) Orijinal kaydı yükle
        cur.execute(
            "SELECT id, sube_id, etiket, aciklama FROM operasyon_defter WHERE id=%s",
            (did,),
        )
        rr = cur.fetchone()
        if not rr:
            raise HTTPException(404, "Teslim kaydı bulunamadı")
        orig = dict(rr)
        if str(orig.get("sube_id") or "") != sube_id:
            raise HTTPException(403, "Bu kayıt bu şubeye ait değil")
        if str(orig.get("etiket") or "") != "URUN_SEVK":
            raise HTTPException(400, "Yalnızca 'Ürün Teslim Al' (URUN_SEVK) kayıtları geri alınabilir.")

        # 4) Zaten geri alınmış mı?
        cur.execute(
            """
            SELECT 1 FROM operasyon_defter
            WHERE sube_id=%s AND etiket='URUN_SEVK_IPTAL' AND ref_event_id=%s
            LIMIT 1
            """,
            (sube_id, did),
        )
        if cur.fetchone():
            raise HTTPException(409, "Bu teslim kaydı zaten geri alınmış.")

        payload = _urun_sevk_payload_coz(orig.get("aciklama") or "")
        _stid = payload.get("siparis_talep_id")
        if isinstance(_stid, str):
            _stid = _stid.strip()
        if _stid:
            raise HTTPException(
                409,
                "Bu teslim bir siparişi kapatmış — buradan geri alınamaz. "
                "Operasyon Merkezi üzerinden düzeltilmelidir.",
            )

        kalemler = payload.get("kalemler") if isinstance(payload.get("kalemler"), list) else []
        if not kalemler:
            raise HTTPException(400, "Geri alınacak kalem bulunamadı.")

        # 5) Stok düşümü (eklenen miktarları geri al)
        geri_ozet: List[str] = []
        for it in kalemler:
            if not isinstance(it, dict):
                continue
            urun_ad = str(it.get("urun_ad") or "").strip()
            try:
                adet_i = max(0, int(it.get("adet") or 0))
            except (TypeError, ValueError):
                adet_i = 0
            if not urun_ad or adet_i <= 0:
                continue
            urun_id = str(it.get("urun_id") or "").strip()
            if urun_id:
                depo_kalem = depo_kalem_kodu_resolve(cur, urun_id, urun_ad)
            else:
                depo_kalem = f"ozel__{_norm_ad_tr(urun_ad)}"
            # Depo stoğundan eklenen miktarı geri düş (merkez_stok_sevk tarihsel kayıt olarak kalır)
            sube_depo_stok_depo_cikis_dus(cur, sube_id, depo_kalem, urun_ad, adet_i)
            geri_ozet.append(f"{adet_i} {urun_ad}")

        if not geri_ozet:
            raise HTTPException(400, "Geri alınacak geçerli kalem yok.")

        # 6) Ters defter kaydı (append-only — orijinale ref'li)
        tr_now = _now_tr()
        saat_sistem = tr_now.strftime("%H:%M:%S")
        ozet_metin = ", ".join(geri_ozet[:8]) + (f" · +{len(geri_ozet) - 8} kalem" if len(geri_ozet) > 8 else "")
        aci = (
            "Hatalı teslim al GERİ ALINDI — " + ozet_metin
            + f" | sebep: {sebep[:300]}"
            + f" | işletme onayı: {merve_ad}"
        )
        rid = operasyon_defter_ekle(
            cur,
            sube_id,
            "URUN_SEVK_IPTAL",
            aci,
            ref_event_id=did,
            personel_id=op_id,
            personel_ad=op_ad,
            bildirim_saati=saat_sistem,
        )
        audit(cur, "operasyon_defter", rid, "URUN_SEVK_IPTAL")

    return {"success": True, "defter_id": rid, "geri_alinan": geri_ozet}


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
    siparis_talep_id: Optional[str] = None


class SubeUrunAcTaslakBody(BaseModel):
    kalemler: List[Dict[str, Any]] = []
    not_aciklama: Optional[str] = None
    personel_id: Optional[str] = None


class SubeUrunBittiBody(BaseModel):
    """'bitince' modlu kullanımdaki ürün bitti → depodan düş + sipariş alarmı."""
    personel_id: str
    pin: str
    kullanim_id: str
    not_aciklama: Optional[str] = None


def _taslak_ozet_metin(kalemler: List[Dict[str, Any]], not_aciklama: Optional[str]) -> str:
    rows = kalemler or []
    secili = []
    toplam = 0
    for r in rows:
        try:
            adet = int(r.get("adet") or 0)
        except Exception:
            adet = 0
        if adet <= 0:
            continue
        ad = str(r.get("urun_ad") or r.get("kalem_kodu") or r.get("urun_id") or "Kalem").strip()
        secili.append(f"{ad} x{adet}")
        toplam += adet
    k_say = len(secili)
    kisit = ", ".join(secili[:8]) + (f", +{k_say-8} kalem" if k_say > 8 else "")
    notu = (not_aciklama or "").strip()
    out = f"kalem={k_say}, toplam_adet={toplam}"
    if kisit:
        out += f" | {kisit}"
    if notu:
        out += f" | not={notu[:400]}"
    return out


@router.get("/{sube_id}/urun-ac/taslak")
def sube_urun_ac_taslak_oku(sube_id: str):
    """Yarım kalmış (PIN onaylanmamış) ürün aç seçimini döner."""
    with db() as (conn, cur):
        cur.execute(
            "SELECT * FROM urun_ac_taslak WHERE sube_id = %s",
            (sube_id,),
        )
        r = cur.fetchone()
        if not r:
            return {"sube_id": sube_id, "kalemler": [], "not_aciklama": "",
                    "personel_id": "", "guncelleme": None}
        return {
            "sube_id": sube_id,
            "kalemler": r["kalemler_json"] or [],
            "not_aciklama": r.get("not_aciklama") or "",
            "personel_id": r.get("personel_id") or "",
            "guncelleme": str(r.get("guncelleme")) if r.get("guncelleme") else None,
        }


@router.post("/{sube_id}/urun-ac/taslak")
def sube_urun_ac_taslak_kaydet(sube_id: str, body: SubeUrunAcTaslakBody):
    """Otomatik kaydet — kullanıcı her seçim/adet değişiminde tetikler."""
    import json as _json
    with db() as (conn, cur):
        cur.execute(
            "SELECT kalemler_json, not_aciklama FROM urun_ac_taslak WHERE sube_id=%s",
            (sube_id,),
        )
        onceki = cur.fetchone()
        onceki_kalem = (onceki or {}).get("kalemler_json") or []
        onceki_secili = any(int((x or {}).get("adet") or 0) > 0 for x in onceki_kalem)
        yeni_secili = any(int((x or {}).get("adet") or 0) > 0 for x in (body.kalemler or []))
        cur.execute(
            """
            INSERT INTO urun_ac_taslak (sube_id, kalemler_json, not_aciklama, personel_id)
            VALUES (%s, %s::jsonb, %s, %s)
            ON CONFLICT (sube_id) DO UPDATE SET
                kalemler_json = EXCLUDED.kalemler_json,
                not_aciklama  = EXCLUDED.not_aciklama,
                personel_id   = EXCLUDED.personel_id,
                guncelleme    = NOW()
            """,
            (sube_id, _json.dumps(body.kalemler or []),
             body.not_aciklama or None, body.personel_id or None),
        )
        if yeni_secili and not onceki_secili:
            nid = str(uuid.uuid4())
            metin = (
                "[YARIM_ISLEM_BILDIRIM] URUN_AC taslak oluştu. "
                + _taslak_ozet_metin(body.kalemler or [], body.not_aciklama)
            )
            cur.execute(
                """
                INSERT INTO sube_merkez_not (id, sube_id, metin, personel_id, personel_ad)
                VALUES (%s, %s, %s, NULL, %s)
                """,
                (nid, sube_id, metin, "SISTEM"),
            )
            audit(cur, "sube_merkez_not", nid, "YARIM_ISLEM_URUN_AC_TASLAK")
    return {"basarili": True}


@router.delete("/{sube_id}/urun-ac/taslak")
def sube_urun_ac_taslak_sil(sube_id: str):
    """Onay sonrası veya kullanıcı manuel temizlerse."""
    with db() as (conn, cur):
        cur.execute(
            "SELECT kalemler_json, not_aciklama FROM urun_ac_taslak WHERE sube_id=%s",
            (sube_id,),
        )
        ex = cur.fetchone()
        if ex:
            kalemler = ex.get("kalemler_json") or []
            if any(int((x or {}).get("adet") or 0) > 0 for x in kalemler):
                nid = str(uuid.uuid4())
                metin = (
                    "[YARIM_ISLEM_TEMIZLENDI] URUN_AC taslak kullanıcı tarafından silindi. "
                    + _taslak_ozet_metin(kalemler, ex.get("not_aciklama"))
                )
                cur.execute(
                    """
                    INSERT INTO sube_merkez_not (id, sube_id, metin, personel_id, personel_ad)
                    VALUES (%s, %s, %s, NULL, %s)
                    """,
                    (nid, sube_id, metin, "SISTEM"),
                )
                audit(cur, "sube_merkez_not", nid, "YARIM_ISLEM_URUN_AC_SILINDI")
        cur.execute("DELETE FROM urun_ac_taslak WHERE sube_id = %s", (sube_id,))
    return {"basarili": True}


@router.get("/{sube_id}/urun-ac/bugun-sayisi")
def sube_urun_ac_bugun_sayisi(sube_id: str):
    """
    Bugün şubede yapılmış URUN_AC kayıtlarının özeti.
    Kapanış öncesi "hiç ürün aç kaydı yok" uyarısı için kullanılır.
    """
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT COUNT(*) AS adet
            FROM operasyon_defter
            WHERE sube_id = %s
              AND etiket = 'URUN_AC'
              AND tarih = CURRENT_DATE
            """,
            (sube_id,),
        )
        r = cur.fetchone() or {}
        return {"sube_id": sube_id, "bugun_kayit": int(r.get("adet") or 0)}


@router.post("/{sube_id}/urun-ac")
def sube_urun_ac(sube_id: str, body: SubeUrunAcBody):
    """
    Depodan aktif kullanıma açılan ürün (URUN_AC).
    Bu kayıt teorik stok hesabına girer: açılış + URUN_STOK_EKLE + URUN_AC = beklenen stok.
    """
    from operasyon_stok_motor import (
        depo_kalem_kodu_resolve,
        sube_depo_stok_depo_cikis_dus,
    )

    pid_in = (body.personel_id or "").strip()
    pin = (body.pin or "").replace(" ", "")
    if not pid_in:
        raise HTTPException(400, "personel_id gerekli")
    if len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "4 haneli panel PIN gerekli")

    body_raw = body.model_dump()
    kalemler = _stok_kalemleri_temizle(body_raw.get("kalemler"))
    # Havuz (pool) kaldırıldı — artık sadece kalemler listesi geçerli
    if not kalemler:
        raise HTTPException(400, "En az bir stok kaleminde pozitif adet girin")

    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        if not _bugun_kasa_acildi_mi(cur, sube_id):
            raise HTTPException(403, "Önce günlük kasa kilidini PIN ile açmalısınız.")
        if not _bugun_sube_acildi_mi(cur, sube_id):
            raise HTTPException(403, "Önce şubeyi açmalısınız.")

        # ── Çift gönderim koruması: aynı şubeden 60 sn içinde URUN_AC tekrarı reddet ──
        cur.execute(
            """
            SELECT id FROM operasyon_defter
            WHERE sube_id = %s AND etiket = 'URUN_AC'
              AND olay_ts >= NOW() - INTERVAL '60 seconds'
            LIMIT 1
            """,
            (sube_id,),
        )
        if cur.fetchone():
            raise HTTPException(409, "Bu şubeden son 60 saniye içinde ürün açma kaydı oluşturuldu. Tekrar göndermeden önce 1 dakika bekleyin.")
        ku = dogrula_personel_panel_pin(cur, pid_in, pin)
        onay_ad = (ku.get("ad_soyad") or "").strip() or "—"
        pid_panel = str(ku.get("id") or "").strip() or pid_in

        from operasyon_defter import operasyon_defter_ekle
        import json as _json

        tr_now = _now_tr()
        saat_sistem = tr_now.strftime("%H:%M:%S")
        _talep_id = (body.siparis_talep_id or "").strip() or None
        _not_ek = ""
        if (body.not_aciklama or "").strip():
            _not_ek = " | " + (body.not_aciklama or "").strip()[:400]

        # ── Düşüm modunu ürün bazında çöz (bitince vs açılınca) ──
        _urun_ids = [str(k.get("urun_id") or "").strip() for k in kalemler if str(k.get("urun_id") or "").strip()]
        _mod_map: dict = {}
        if _urun_ids:
            cur.execute(
                "SELECT id, dusum_modu FROM siparis_urun WHERE id = ANY(%s)",
                (_urun_ids,),
            )
            for _r in cur.fetchall():
                _mod_map[str(_r["id"])] = (str(_r.get("dusum_modu") or "acilinca").strip() or "acilinca")

        def _is_bitince(k) -> bool:
            return _mod_map.get(str(k.get("urun_id") or "").strip(), "acilinca") == "bitince"

        acilinca_kalemler = [k for k in kalemler if not _is_bitince(k)]
        bitince_kalemler = [k for k in kalemler if _is_bitince(k)]

        # Açılınca modu: teorik stoğa giren klasik URUN_AC kaydı (depodan düşer)
        rid = None
        if acilinca_kalemler:
            payload = _json.dumps({"kalemler": acilinca_kalemler}, ensure_ascii=False, separators=(",", ":"))
            acik = "URUN_AC_JSON:" + payload + _not_ek
            rid = operasyon_defter_ekle(
                cur,
                sube_id,
                "URUN_AC",
                acik,
                ref_event_id=_talep_id,
                personel_id=pid_panel,
                personel_ad=onay_ad,
                bildirim_saati=saat_sistem,
            )
            audit(cur, "operasyon_defter", rid, "URUN_AC")

        # ── Şube deposundan düş — bara giren ürün depoda azalır ──
        # Havuz (pool) kaldırıldı. Depo çıkışı yalnızca kalemler[] UUID satırlarıyla yapılır.
        import uuid as _uuid

        def _uyumsuzluk_yaz(cur, sube_id, kalem_kodu, mevcut_oncesi, istenen, urun_ad_fallback=""):
            """Karşılıksız URUN_AC borcunu loglar.
            Aynı gün aynı kalem için kayıt varsa eksik_miktar toplanır (borç birikir).
            Sevkiyat geldiğinde sube_depo_stok_depo_giris_ekle bu borcu otomatik uygular.
            (Deferred Reconciliation — SAP/NetSuite/Dynamics 365 yaklaşımı)
            """
            import json as _json2
            from operasyon_stok_motor import depo_kalem_gorunen_ad

            eksik = max(0, istenen - mevcut_oncesi)
            if eksik <= 0:
                return
            kalem_adi = depo_kalem_gorunen_ad(cur, sube_id, kalem_kodu, urun_ad_fallback)
            # Aynı gün aynı kalem için mevcut kayıt var mı?
            cur.execute("""
                SELECT id, detay FROM sube_operasyon_uyari
                WHERE sube_id=%s AND tip='URUN_AC_UYUMSUZLUK'
                  AND tarih=CURRENT_DATE AND kalem_kodu=%s
                LIMIT 1
            """, (sube_id, kalem_kodu))
            mevcut_kayit = cur.fetchone()
            if mevcut_kayit:
                # Borcu topla — her URUN_AC açığı birikir
                eski_detay = mevcut_kayit.get("detay") or {}
                if isinstance(eski_detay, str):
                    try: eski_detay = _json2.loads(eski_detay)
                    except: eski_detay = {}
                toplam_eksik = int(eski_detay.get("eksik_miktar") or 0) + eksik
                yeni_detay = {
                    **eski_detay,
                    "kalem_kodu": kalem_kodu,
                    "kalem_adi": kalem_adi,
                    "eksik_miktar": toplam_eksik,
                }
                cur.execute("""
                    UPDATE sube_operasyon_uyari
                    SET detay=%s, mesaj=%s
                    WHERE id=%s
                """, (
                    _json2.dumps(yeni_detay, ensure_ascii=False),
                    f"Karşılıksız açma: {kalem_adi} — toplam {toplam_eksik} adet borç birikti.",
                    str(mevcut_kayit["id"]),
                ))
            else:
                detay = _json2.dumps({
                    "kalem_kodu": kalem_kodu,
                    "kalem_adi": kalem_adi,
                    "eksik_miktar": eksik,
                    "mevcut_oncesi": mevcut_oncesi,
                    "istenen": istenen,
                }, ensure_ascii=False)
                cur.execute("""
                    INSERT INTO sube_operasyon_uyari
                        (id, sube_id, tarih, tip, seviye, mesaj, kalem_kodu, detay)
                    VALUES (%s, %s, CURRENT_DATE, 'URUN_AC_UYUMSUZLUK', 'kritik', %s, %s, %s)
                """, (
                    str(_uuid.uuid4()), sube_id,
                    f"Karşılıksız açma: {kalem_adi} — depoda {mevcut_oncesi} adet varken {istenen} adet açıldı.",
                    kalem_kodu,
                    detay,
                ))

        # Havuz (STOK_KEYS) döngüsü kaldırıldı — sadece UUID kalemler işlenir.
        # UUID katalog kalemleri (yalnızca AÇILINCA modu depodan düşer)
        # Pasta/kek MUAF: her zaman tam gelmez → "depo stok azaldı" alarmı yazılmaz
        from operasyon_stok_motor import pasta_kalem_kodu_seti as _pks, pasta_kalemi_mi as _pkm
        _pasta_set = _pks(cur)
        _islendi_kalemler: set = set()  # Aynı kalem_kodu'nun tek request'te iki kez düşmesini önler
        for k in acilinca_kalemler:
            uid = str(k.get("urun_id") or "").strip()
            uad = str(k.get("urun_ad") or "").strip()
            if uid:
                kk = depo_kalem_kodu_resolve(cur, uid, uad)
            else:
                # urun_id eksik — isme göre çözme artık YOK (migration v5 sonrası her ürün UUID'li)
                continue
            if not kk:
                continue
            # Aynı kalem_kodu bu request'te zaten işlendiyse atla
            if kk in _islendi_kalemler:
                continue
            _islendi_kalemler.add(kk)
            adet = max(0, int(k.get("adet") or 0))
            if adet <= 0:
                continue
            # Depo stoku açmadan önce kontrol — yetersizse uyumsuzluk logla
            cur.execute("SELECT mevcut_adet FROM sube_depo_stok WHERE sube_id=%s AND kalem_kodu=%s",
                        (sube_id, kk))
            _stok_r2 = cur.fetchone()
            _mevcut_oncesi2 = int(_stok_r2["mevcut_adet"] if _stok_r2 else 0)
            if _mevcut_oncesi2 < adet:
                _uyumsuzluk_yaz(cur, sube_id, kk, _mevcut_oncesi2, adet, str(k.get("urun_ad") or "").strip())
            sube_depo_stok_depo_cikis_dus(
                cur,
                sube_id,
                kk,
                str(k.get("urun_ad") or "").strip() or None,
                adet,
            )
            cur.execute(
                """
                SELECT mevcut_adet, min_stok, kalem_adi FROM sube_depo_stok
                WHERE sube_id = %s AND kalem_kodu = %s
                  AND mevcut_adet <= GREATEST(1, min_stok)
                """,
                (sube_id, kk),
            )
            alarm_r = cur.fetchone()
            # FIX C1 (2026-07-05): _pasta_set/_pkm bitti-modu fonksiyonunda TANIMSIZDI → stok eşiğe
            # inince NameError → URUN_AC kaydı + depo düşümü rollback (COGS kaybı + 500). Yerel tanım.
            _pasta_set = _pks(cur)
            if alarm_r and not _pkm(kk, _pasta_set):
                mevcut = int(alarm_r.get("mevcut_adet") or 0)
                min_s   = int(alarm_r.get("min_stok")   or 0)
                k_adi   = alarm_r.get("kalem_adi") or k.get("urun_ad") or kk
                cur.execute(
                    """
                    SELECT 1 FROM sube_operasyon_uyari
                    WHERE sube_id=%s AND tip='STOK_ALARM'
                      AND tarih=CURRENT_DATE AND mesaj LIKE %s
                    LIMIT 1
                    """,
                    (sube_id, f"%{kk}%"),
                )
                if not cur.fetchone():
                    seviye = "kritik" if mevcut == 0 else "uyari"
                    cur.execute(
                        """
                        INSERT INTO sube_operasyon_uyari
                            (id, sube_id, tarih, tip, seviye, mesaj)
                        VALUES (%s, %s, CURRENT_DATE, 'STOK_ALARM', %s, %s)
                        """,
                        (
                            str(_uuid.uuid4()), sube_id, seviye,
                            f"Depo stok azaldı: {k_adi} — mevcut {mevcut} adet (min {min_s}). Sipariş gerekebilir.",
                        ),
                    )

        # ── BİTİNCE modu: depodan DÜŞME — "kullanımda" kaydı aç ──
        # Sipariş alarmı bu ürünlerde ürün açılınca DEĞİL, "Bitti" denince tetiklenir.
        for k in bitince_kalemler:
            uid = str(k.get("urun_id") or "").strip()
            uad = str(k.get("urun_ad") or "").strip()
            adet = max(0, int(k.get("adet") or 0))
            if adet <= 0:
                continue
            kk = depo_kalem_kodu_resolve(cur, uid, uad) if uid else ""
            cur.execute(
                """
                INSERT INTO sube_kullanimda_urun
                    (sube_id, urun_id, kalem_kodu, urun_ad, adet,
                     acan_personel_id, acan_personel_ad)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (sube_id, uid or None, (kk or None), uad or None, adet, pid_panel, onay_ad),
            )
        if bitince_kalemler:
            _bit_payload = _json.dumps(
                {"kalemler": bitince_kalemler}, ensure_ascii=False, separators=(",", ":")
            )
            _bit_rid = operasyon_defter_ekle(
                cur,
                sube_id,
                "URUN_KULLANIMA_AL",
                "URUN_KULLANIMA_AL_JSON:" + _bit_payload + _not_ek,
                personel_id=pid_panel,
                personel_ad=onay_ad,
                bildirim_saati=saat_sistem,
            )
            audit(cur, "operasyon_defter", _bit_rid, "URUN_KULLANIMA_AL")
            if rid is None:
                rid = _bit_rid

        # PIN onaylı URUN_AC tamamlandı: taslak satırını sil — aksi halde panel tekrar açılınca GET ile
        # eski kalemler yüklenir (istemci programatik sıfırlamada input/change tetiklenmeyebilir).
        cur.execute("DELETE FROM urun_ac_taslak WHERE sube_id = %s", (sube_id,))

    return {
        "success": True,
        "defter_id": rid,
        "delta": {},
        "kalemler": kalemler,
        "acilinca_adet": sum(max(0, int(k.get("adet") or 0)) for k in acilinca_kalemler),
        "bitince_adet": sum(max(0, int(k.get("adet") or 0)) for k in bitince_kalemler),
        "tip": "URUN_AC",
    }


@router.get("/{sube_id}/kullanimda")
def sube_kullanimda_listele(sube_id: str):
    """Şubede 'bitince' modunda açılmış, henüz bitmemiş ürünler."""
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        cur.execute(
            """
            SELECT id, urun_id, kalem_kodu, urun_ad, adet,
                   acan_personel_ad, ac_ts
            FROM sube_kullanimda_urun
            WHERE sube_id = %s AND durum = 'kullanimda'
            ORDER BY ac_ts DESC
            """,
            (sube_id,),
        )
        items = [
            {
                "id": str(r["id"]),
                "urun_id": (str(r["urun_id"]) if r.get("urun_id") else None),
                "urun_ad": (r.get("urun_ad") or "").strip() or "—",
                "adet": int(r.get("adet") or 0),
                "acan": (r.get("acan_personel_ad") or "").strip() or "—",
                "ac_ts": (r["ac_ts"].isoformat() if r.get("ac_ts") else None),
            }
            for r in cur.fetchall()
        ]
    return {"success": True, "items": items, "adet": len(items)}


@router.post("/{sube_id}/urun-bitti")
def sube_urun_bitti(sube_id: str, body: SubeUrunBittiBody):
    """'bitince' modlu kullanımdaki ürün bitti:
    şimdi URUN_AC yazılır, depodan düşülür ve sipariş alarmı tetiklenir."""
    from operasyon_stok_motor import (
        depo_kalem_kodu_resolve,
        sube_depo_stok_depo_cikis_dus,
        pasta_kalem_kodu_seti as _pks,
        pasta_kalemi_mi as _pkm,
    )
    import uuid as _uuid

    pid_in = (body.personel_id or "").strip()
    pin = (body.pin or "").replace(" ", "")
    kid = (body.kullanim_id or "").strip()
    if not pid_in:
        raise HTTPException(400, "personel_id gerekli")
    if len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "4 haneli panel PIN gerekli")
    if not kid:
        raise HTTPException(400, "kullanim_id gerekli")

    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        ku = dogrula_personel_panel_pin(cur, pid_in, pin)
        onay_ad = (ku.get("ad_soyad") or "").strip() or "—"
        pid_panel = str(ku.get("id") or "").strip() or pid_in

        cur.execute(
            """
            SELECT id, urun_id, kalem_kodu, urun_ad, adet, durum
            FROM sube_kullanimda_urun
            WHERE id = %s AND sube_id = %s
            """,
            (kid, sube_id),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Kullanımda kaydı bulunamadı.")
        if (row.get("durum") or "") != "kullanimda":
            raise HTTPException(409, "Bu kayıt zaten bitmiş.")

        uid = str(row.get("urun_id") or "").strip()
        uad = (row.get("urun_ad") or "").strip()
        adet = max(1, int(row.get("adet") or 1))
        kk = (str(row.get("kalem_kodu") or "").strip()
              or (depo_kalem_kodu_resolve(cur, uid, uad) if uid else ""))

        from operasyon_defter import operasyon_defter_ekle
        import json as _json

        saat_sistem = _now_tr().strftime("%H:%M:%S")
        _not_ek = ""
        if (body.not_aciklama or "").strip():
            _not_ek = " | " + (body.not_aciklama or "").strip()[:400]
        kalemler = [{"urun_id": uid, "urun_ad": uad, "adet": adet}]
        acik = ("URUN_AC_JSON:"
                + _json.dumps({"kalemler": kalemler}, ensure_ascii=False, separators=(",", ":"))
                + " | [BİTTİ] " + uad + _not_ek)
        rid = operasyon_defter_ekle(
            cur, sube_id, "URUN_AC", acik,
            personel_id=pid_panel, personel_ad=onay_ad, bildirim_saati=saat_sistem,
        )
        audit(cur, "operasyon_defter", rid, "URUN_AC")

        # Depodan düş — bitince ürünü artık tüketildi sayılır
        if kk:
            sube_depo_stok_depo_cikis_dus(cur, sube_id, kk, uad or None, adet)
            # Sipariş alarmı — depo eşiğin altına indiyse tetikle
            cur.execute(
                """
                SELECT mevcut_adet, min_stok, kalem_adi FROM sube_depo_stok
                WHERE sube_id = %s AND kalem_kodu = %s
                  AND mevcut_adet <= GREATEST(1, min_stok)
                """,
                (sube_id, kk),
            )
            alarm_r = cur.fetchone()
            # FIX C1 (2026-07-05): _pasta_set/_pkm bitti-modu fonksiyonunda TANIMSIZDI → stok eşiğe
            # inince NameError → URUN_AC kaydı + depo düşümü rollback (COGS kaybı + 500). Yerel tanım.
            _pasta_set = _pks(cur)
            if alarm_r and not _pkm(kk, _pasta_set):
                mevcut = int(alarm_r.get("mevcut_adet") or 0)
                min_s = int(alarm_r.get("min_stok") or 0)
                k_adi = alarm_r.get("kalem_adi") or uad or kk
                cur.execute(
                    """
                    SELECT 1 FROM sube_operasyon_uyari
                    WHERE sube_id=%s AND tip='STOK_ALARM'
                      AND tarih=CURRENT_DATE AND mesaj LIKE %s
                    LIMIT 1
                    """,
                    (sube_id, f"%{kk}%"),
                )
                if not cur.fetchone():
                    seviye = "kritik" if mevcut == 0 else "uyari"
                    cur.execute(
                        """
                        INSERT INTO sube_operasyon_uyari
                            (id, sube_id, tarih, tip, seviye, mesaj)
                        VALUES (%s, %s, CURRENT_DATE, 'STOK_ALARM', %s, %s)
                        """,
                        (str(_uuid.uuid4()), sube_id, seviye,
                         f"Depo stok azaldı: {k_adi} — mevcut {mevcut} adet (min {min_s}). Sipariş gerekebilir."),
                    )

        cur.execute(
            """
            UPDATE sube_kullanimda_urun
            SET durum = 'bitti', biten_personel_id = %s,
                biten_personel_ad = %s, bitti_ts = NOW()
            WHERE id = %s
            """,
            (pid_panel, onay_ad, kid),
        )

    return {"success": True, "defter_id": rid, "urun_ad": uad, "adet": adet, "tip": "URUN_BITTI"}


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
            SELECT id, mesaj, olusturma, okundu, okundu_ts, oncelik, ttl_saat, aktif
            FROM sube_merkez_mesaj
            WHERE sube_id=%s
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
    aciklama: Optional[str] = None
    adet: int


class SiparisOnayBody(BaseModel):
    kalemler: List[SiparisOnayKalem]
    personel_id: str
    pin: str
    not_aciklama: Optional[str] = None
    force_cift_siparis: bool = False


class SiparisYoklamaBody(BaseModel):
    kalemler: List[SiparisOnayKalem]
    personel_id: str
    not_aciklama: Optional[str] = None
    force_cift_siparis: bool = False


class PanelPinDogrulaBody(BaseModel):
    """Şube panelinde yalnızca PIN doğrulama (ör. adet girilmiş sipariş modalını kapatma)."""

    personel_id: str
    pin: str


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
            SELECT id, ad, aktif, sira, birim_fiyat_tl,
                   depo_stok_kalem_kodu, aciklama, dusum_modu
            FROM siparis_urun
            WHERE kategori_id=%s AND aktif=TRUE
            ORDER BY sira ASC, ad ASC
            """,
            (k["id"],),
        )
        items = [
            {
                "id": str(x["id"]),
                "ad": x["ad"],
                "aktif": bool(x["aktif"]),
                "birim_fiyat_tl": (float(x["birim_fiyat_tl"]) if x.get("birim_fiyat_tl") is not None else None),
                "depo_stok_kalem_kodu": (
                    str(x["depo_stok_kalem_kodu"]).strip()
                    if x.get("depo_stok_kalem_kodu") and str(x.get("depo_stok_kalem_kodu") or "").strip()
                    else None
                ),
                "aciklama": (str(x["aciklama"]).strip() if x.get("aciklama") else None),
                "dusum_modu": (str(x["dusum_modu"]).strip() if x.get("dusum_modu") else "acilinca"),
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


def _siparis_kalem_ozet_from_json(kalemler: Any) -> List[Dict[str, Any]]:
    kms = kalemler or []
    if isinstance(kms, str):
        try:
            kms = json.loads(kms)
        except Exception:
            kms = []
    if not isinstance(kms, list):
        kms = []
    ozet: List[Dict[str, Any]] = []
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
    return ozet


def _siparis_kalem_duzenle_panel(
    kalemler: Any, kalem_durumlari: Any, *, for_kalan: bool = False
) -> List[Dict[str, Any]]:
    """Sipariş kalemleri ile kalem_durumlari birleştirilir — depo panelinde kısmi gönderim formu için.
    for_kalan=True iken var için gönderilen tamamlanması yapılmaz (eksik kalan raporu için)."""
    kms = kalemler or []
    if isinstance(kms, str):
        try:
            kms = json.loads(kms)
        except Exception:
            kms = []
    if not isinstance(kms, list):
        kms = []
    kd_list = kalem_durumlari or []
    if isinstance(kd_list, str):
        try:
            kd_list = json.loads(kd_list)
        except Exception:
            kd_list = []
    if not isinstance(kd_list, list):
        kd_list = []
    used_idx: Set[int] = set()
    out: List[Dict[str, Any]] = []
    for x in kms:
        if not isinstance(x, dict):
            continue
        uid = (str(x.get("urun_id") or "").strip()) or None
        uad = (x.get("urun_ad") or "").strip() or ""
        ist = int(x.get("adet") or 0)
        match = None
        mj = -1
        for j, kd in enumerate(kd_list):
            if j in used_idx or not isinstance(kd, dict):
                continue
            kd_uid = (str(kd.get("urun_id") or "").strip()) or None
            kd_ad = (kd.get("urun_ad") or "").strip() or ""
            if uid and kd_uid and uid == kd_uid:
                match = kd
                mj = j
                break
            if (not uid or not kd_uid) and uad and kd_ad == uad:
                match = kd
                mj = j
                break
        if mj >= 0:
            used_idx.add(mj)
        dur = (match.get("durum") if match else None) or ""
        if not dur:
            dur = "var" if not kd_list else "bekliyor"
        gon = int((match.get("gonderilen_adet") if match else 0) or 0)
        if not for_kalan and dur == "var" and gon <= 0 and ist > 0:
            gon = ist
        notu = None
        if match:
            notu = match.get("not") or match.get("not_aciklama")
        out.append(
            {
                "urun_id": uid,
                "urun_ad": uad,
                "istenen_adet": ist,
                "durum": dur,
                "gonderilen_adet": gon,
                "not": (str(notu).strip() if notu else None) or None,
            }
        )
    return out


def _depo_kalan_kalemleri_listesi(
    cur: Any, depo_sube_id: str, gun_i: int, lim: int
) -> List[Dict[str, Any]]:
    """
    Bu depoya yönlendirilmiş siparişlerde, istenen ile gönderilen arasında kalan miktarı
    gösterir (0 gönderilen veya kısmi gönderim sonrası eksik kalan).
    """
    lim_i = max(1, min(80, int(lim)))
    gun_x = max(1, min(90, int(gun_i)))
    cur.execute(
        """
        SELECT t.id, t.durum, ts.ad AS talep_sube_adi, t.kalemler, t.kalem_durumlari
        FROM siparis_talep t
        JOIN subeler ts ON ts.id = t.sube_id
        WHERE COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id) = %s
          AND t.tarih >= CURRENT_DATE - (%s * INTERVAL '1 day')
          AND t.durum IN ('hazirlaniyor', 'gonderildi')
        ORDER BY t.sevkiyat_ts DESC NULLS LAST, t.olusturma DESC NULLS LAST
        LIMIT %s
        """,
        (depo_sube_id, gun_x, lim_i),
    )
    out: List[Dict[str, Any]] = []
    for r in cur.fetchall() or []:
        d = dict(r)
        oid = str(d.get("id") or "").strip()
        if not oid:
            continue
        rows = _siparis_kalem_duzenle_panel(
            d.get("kalemler"), d.get("kalem_durumlari"), for_kalan=True
        )
        satirlar: List[Dict[str, Any]] = []
        for row in rows:
            ist = int(row.get("istenen_adet") or 0)
            if ist <= 0:
                continue
            gon = int(row.get("gonderilen_adet") or 0)
            dur = str(row.get("durum") or "").strip().lower()
            kalan = max(0, ist - gon)
            if kalan <= 0:
                continue
            ua = (row.get("urun_ad") or "").strip() or "Ürün"
            uid = (str(row.get("urun_id") or "").strip()) or None
            satirlar.append(
                {
                    "urun_id": uid,
                    "urun_ad": ua,
                    "istenen_adet": ist,
                    "gonderilen_adet": gon,
                    "kalan_adet": kalan,
                    "durum": dur or "bekliyor",
                }
            )
        if not satirlar:
            continue
        out.append(
            {
                "talep_id": oid,
                "talep_sube_adi": (d.get("talep_sube_adi") or "").strip() or "Şube",
                "talep_durum": str(d.get("durum") or "").strip(),
                "satirlar": satirlar,
            }
        )
    return out


def _siparis_kalem_durum_ozet(kalem_durumlari: Any) -> List[Dict[str, Any]]:
    """Kalem durumları JSON → panelde okunaklı satır listesi."""
    raw = kalem_durumlari
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = []
    if not isinstance(raw, list):
        return []
    out: List[Dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        kod = str(item.get("kalem_kodu") or item.get("urun_id") or "").strip()
        ad = str(item.get("kalem_adi") or item.get("urun_ad") or kod or "—").strip()
        dur = str(item.get("durum") or "bekliyor").strip().lower()
        ist = int(item.get("istenen_adet") or item.get("adet") or 0)
        gon = int(item.get("gonderilen_adet") or 0)
        dur_tr = {
            "var": "Depoda var / gönderildi",
            "yok": "Depoda yok",
            "kismi": "Kısmi",
            "bekliyor": "Bekliyor",
        }.get(dur, dur or "—")
        out.append(
            {
                "kalem_kodu": kod,
                "kalem_adi": ad,
                "istenen_adet": ist,
                "gonderilen_adet": gon,
                "durum": dur,
                "durum_metni": dur_tr,
            }
        )
    return out


def _depo_yolda_teslim_haritasi(cur: Any, sube_id: str, gun_i: int) -> Dict[str, List[Dict[str, Any]]]:
    """
    Alıcı şubede kabul bekleyen stok_yolda satırları.
    Talep listesi LIMIT/tarih filtresinden bağımsız — yolda paket mutlaka panele düşer.

    SAVEPOINT kullanır: sorgu patlarsa (ör. migrasyon eksik kolon) transaction
    aborted durumuna girmez, çağrıcı devam edebilir.
    """
    gun_x = max(1, min(90, int(gun_i)))
    yolda_map: Dict[str, List[Dict[str, Any]]] = {}
    try:
        cur.execute("SAVEPOINT sp_yolda_harita")
        yolda_sql_v2 = """
            SELECT y.siparis_talep_id, y.id, y.kalem_kodu, y.kalem_adi, y.sevk_adet,
                   y.sevk_kaynak_depo_sube_id,
                   ks.ad AS sevk_kaynak_depo_adi
            FROM stok_yolda y
            JOIN siparis_talep t ON t.id = y.siparis_talep_id
            LEFT JOIN subeler ks ON ks.id = y.sevk_kaynak_depo_sube_id
            WHERE y.sube_id = %s
              AND t.sube_id = %s
              AND y.durum = 'yolda'
              AND t.durum NOT IN ('teslim_edildi', 'iptal', 'gonderilmedi', 'kabul_uyusmazlik')
            ORDER BY COALESCE(y.sevk_ts, t.sevkiyat_ts) ASC NULLS LAST, y.id ASC
        """
        yolda_sql_v1 = """
            SELECT y.siparis_talep_id, y.id, y.kalem_kodu, y.kalem_adi, y.sevk_adet,
                   NULL::text AS sevk_kaynak_depo_sube_id,
                   NULL::text AS sevk_kaynak_depo_adi
            FROM stok_yolda y
            JOIN siparis_talep t ON t.id = y.siparis_talep_id
            WHERE y.sube_id = %s
              AND t.sube_id = %s
              AND y.durum = 'yolda'
              AND t.durum NOT IN ('teslim_edildi', 'iptal', 'gonderilmedi', 'kabul_uyusmazlik')
            ORDER BY COALESCE(y.sevk_ts, t.sevkiyat_ts) ASC NULLS LAST, y.id ASC
        """
        params = (sube_id, sube_id)
        try:
            cur.execute(yolda_sql_v2, params)
        except Exception:
            cur.execute("ROLLBACK TO SAVEPOINT sp_yolda_harita")
            cur.execute("SAVEPOINT sp_yolda_harita")
            cur.execute(yolda_sql_v1, params)
        for yr in cur.fetchall() or []:
            yy = dict(yr)
            tid_y = str(yy.get("siparis_talep_id") or "").strip()
            if not tid_y:
                continue
            yolda_map.setdefault(tid_y, []).append(
                {
                    "yolda_id": str(yy.get("id") or ""),
                    "kalem_kodu": str(yy.get("kalem_kodu") or "").strip(),
                    "kalem_adi": str(yy.get("kalem_adi") or "").strip(),
                    "sevk_adet": int(yy.get("sevk_adet") or 0),
                    "sevk_kaynak_depo_sube_id": str(yy.get("sevk_kaynak_depo_sube_id") or "").strip() or None,
                    "sevk_kaynak_depo_adi": str(yy.get("sevk_kaynak_depo_adi") or "").strip() or None,
                }
            )
        cur.execute("RELEASE SAVEPOINT sp_yolda_harita")
    except Exception:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_yolda_harita")
        except Exception:
            pass
    return yolda_map


def _siparis_akisi_talep_satir_isle(d: Dict[str, Any]) -> Dict[str, Any]:
    """siparis-akisi talep satırını panel yanıtına dönüştür."""
    if d.get("tarih"):
        d["tarih"] = str(d["tarih"])
    if d.get("olusturma"):
        d["olusturma"] = str(d["olusturma"])
    if d.get("sevkiyat_ts"):
        d["sevkiyat_ts"] = str(d["sevkiyat_ts"])
    if d.get("depo_sevkiyat_rapor_ts"):
        d["depo_sevkiyat_rapor_ts"] = str(d["depo_sevkiyat_rapor_ts"])
    if d.get("tahsis_ts"):
        d["tahsis_ts"] = str(d["tahsis_ts"])
    if d.get("kabul_ts"):
        d["kabul_ts"] = str(d["kabul_ts"])
    # DB → frontend normalizasyonu: TAHSIS_TAM → tam, TAHSIS_KISMI → kismi, TAHSIS_YOK → yok
    td = str(d.get("tahsis_durum") or "").strip()
    if td:
        d["tahsis_durum"] = td.replace("TAHSIS_", "").lower()
    # kabul_durum: önce stok_yolda gerçek sayımından al (eski stuck kayıtları da yakalar)
    stok_kabul = str(d.pop("stok_kabul_durum", None) or "").strip() or None
    if stok_kabul:
        d["kabul_durum"] = stok_kabul
    elif not d.get("kabul_durum"):
        # Fallback: siparis_talep.durum'dan türet
        _talep_durum = str(d.get("durum") or "").strip()
        if _talep_durum == "teslim_edildi":
            d["kabul_durum"] = "kabul_tam"
        elif _talep_durum == "kabul_uyusmazlik":
            d["kabul_durum"] = "kabul_uyusmazlik"
    oid = str(d.get("id") or "")
    km_raw = d.get("kalemler")
    kd_raw = d.get("kalem_durumlari")
    ozet = _siparis_kalem_ozet_from_json(km_raw)
    d.pop("kalemler", None)
    d.pop("kalem_durumlari", None)
    d["kalemler_ozet"] = ozet
    d["kalem_durum_ozet"] = _siparis_kalem_durum_ozet(kd_raw)
    d["id"] = oid
    # MERKEZ siparişi işareti: patron/Cep siparişi talep'i personel_ad='MERKEZ' damgalar
    # (merkez-siparis-olustur). Sipariş Takip bunu farklı renk/etiketle gösterir.
    d["merkez"] = (str(d.get("personel_ad") or "").strip().upper() == "MERKEZ")
    return d


def _siparis_tamamlanabilir_yol(row: Dict[str, Any], panel_sube_id: str) -> str:
    """Şube panelinde hangi ekrandan işlem tamamlanır."""
    durum = str(row.get("durum") or "").strip().lower()
    sd = sevkiyat_durumu_coz(row.get("sevkiyat_durumu"), row.get("sevkiyat_durum"))
    hedef = str(row.get("hedef_depo_sube_id") or row.get("sevkiyat_sube_id") or "").strip()
    talep_sube = str(row.get("sube_id") or row.get("talep_sube_id") or panel_sube_id).strip()
    if durum in ("teslim_edildi", "iptal", "gonderilmedi"):
        return "tamamlandi"
    if sd == "toptanciya_yonlendirildi":
        return "toptanci_teslim"
    if row.get("teslim_bekleyen_kalemler"):
        return "depo_kabul"
    if durum == "bekliyor":
        return "bekliyor_merkez"
    if durum == "hazirlaniyor":
        if hedef and talep_sube and hedef == talep_sube == panel_sube_id:
            return "depo_hazirlik_ben"
        return "depo_bekliyor"
    if durum == "gonderildi":
        if row.get("teslim_bekleyen_kalemler"):
            return "depo_kabul"
        return "depo_yolda_bekliyor"
    return "islemde"


def _siparis_asama_metni_sube_panel(row: Dict[str, Any]) -> str:
    """Şube paneli için tek satır İngilizce kod değil, okunaklı Türkçe aşama."""
    durum = str(row.get("durum") or "").strip().lower()
    sd = sevkiyat_durumu_coz(row.get("sevkiyat_durumu"), row.get("sevkiyat_durum"))
    if sd == "toptanciya_yonlendirildi":
        return "Toptancıya yönlendirildi — Ürün Teslim Al ile kapatın"
    if durum == "iptal":
        return "İptal edildi"
    if durum == "teslim_edildi":
        return "Teslim alındı (tamamlandı)"
    if durum == "bekliyor":
        return "Merkezde sırada — onay veya sevkiyat yönlendirmesi bekleniyor"
    if durum == "gonderildi":
        return "Depodan çıktı — şubenize doğru yolda"
    if durum == "hazirlaniyor":
        if sd in ("depoda_hazirlaniyor", "hazirlaniyor"):
            return "Depoda hazırlanıyor"
        if sd == "kismi_hazirlandi":
            return "Depoda kısmi hazırlandı — devam ediyor"
        if sd == "bekliyor":
            return "Sevkiyata yönlendirildi — depo işlemi başlayacak"
        if sd == "gonderildi":
            return "Sevkiyat çıkışı yapıldı — yolda"
        return "Depo / sevkiyat işleniyor"
    return durum or "İşlemde"


@router.get("/{sube_id}/siparis-katalog")
def sube_siparis_katalog_getir(sube_id: str):
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        cur.execute(
            """
            SELECT COUNT(*) AS c FROM siparis_talep
            WHERE sube_id=%s AND durum NOT IN ('teslim_edildi','iptal')
            """,
            (sube_id,),
        )
        n_acik = int((cur.fetchone() or {}).get("c") or 0)
        uyari_panel = None
        if n_acik > 0:
            uyari_panel = (
                f"Tamamlanmamış {n_acik} sipariş talebiniz var. "
                "Önceki siparişlerinizin teslimi yapılmadan yeniden sipariş vermek istediğinize emin misiniz?"
            )
        return {
            "kategoriler": _siparis_katalog_getir(cur),
            "teslim_bekleyen_siparis_sayisi": n_acik,
            "teslim_bekleyen_uyari_metni": uyari_panel,
        }


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


@router.get("/{sube_id}/siparis-akisi")
def sube_siparis_akisi(
    sube_id: str,
    gun: int = Query(21, ge=1, le=90),
    limit: int = Query(25, ge=1, le=80),
    tamamlanan_dahil: bool = Query(False),
):
    """
    Şubenin katalog sipariş taleplerinin durum özeti — sevkiyat / depo adımları dahil.
    - talepler: bu şubenin verdiği talepler (sube_id = panel şubesi).
    - depo_hazirlik_talepleri: merkezin bu şubeyi hedef depo olarak atadığı, hazırlık / yolda
      kayıtlar (başka şubelerden gelen siparişler; kendi şubesine yönlendirilen talep burada
      tekrarlanmaz — yalnızca talep listesinde kalır).
    """
    gun_i = max(1, min(90, int(gun)))
    lim = max(1, min(80, int(limit)))
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        yolda_map = _depo_yolda_teslim_haritasi(cur, sube_id, gun_i)
        q = f"""
            SELECT t.id, t.tarih, t.durum, t.bildirim_saati, t.olusturma,
                   t.personel_ad,
                   {SD_T} AS sevkiyat_durumu,

                   COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id) AS hedef_depo_sube_id,
                   hd.ad AS hedef_depo_adi,
                   t.kalemler,
                   t.kalem_durumlari,
                   t.sevkiyat_ts,
                   t.depo_sevkiyat_rapor_metni,
                   t.depo_sevkiyat_rapor_ts,
                   t.depo_sevkiyat_rapor_uyari,
                   NULLIF(TRIM(t.operasyon_yonlendirme_talimati), '') AS operasyon_yonlendirme_talimati,
                   t.tahsis_durum,
                   t.tahsis_ts,
                   t.tahsis_yapan_ad,
                   (SELECT MAX(y.kabul_ts) FROM stok_yolda y
                    WHERE y.siparis_talep_id = t.id AND y.sube_id = t.sube_id) AS kabul_ts,
                   (SELECT
                      CASE
                        WHEN SUM(CASE WHEN y.durum='yolda'           THEN 1 ELSE 0 END) = 0
                             AND SUM(CASE WHEN y.durum IN ('kabul_edildi','kabul_uyusmazlik') THEN 1 ELSE 0 END) > 0
                        THEN CASE WHEN SUM(CASE WHEN y.durum='kabul_uyusmazlik' THEN 1 ELSE 0 END) > 0
                                  THEN 'kabul_uyusmazlik' ELSE 'kabul_tam' END
                        WHEN SUM(CASE WHEN y.durum='kabul_edildi'    THEN 1 ELSE 0 END) > 0
                        THEN 'kabul_kismi'
                        ELSE NULL
                      END
                    FROM stok_yolda y
                    WHERE y.siparis_talep_id = t.id AND y.sube_id = t.sube_id
                   ) AS stok_kabul_durum
            FROM siparis_talep t
            LEFT JOIN subeler hd ON hd.id = COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id)
            WHERE t.sube_id=%s
              AND t.tarih >= CURRENT_DATE - (%s * INTERVAL '1 day')
              AND t.durum <> 'iptal'
        """
        params: List[Any] = [sube_id, gun_i]
        if not tamamlanan_dahil:
            q += " AND t.durum <> 'teslim_edildi'"
        q += """
            ORDER BY t.olusturma DESC NULLS LAST, t.id DESC
            LIMIT %s
        """
        cur.execute(q, (sube_id, gun_i, lim))
        talepler: List[Dict[str, Any]] = []
        for r in cur.fetchall() or []:
            d = _siparis_akisi_talep_satir_isle(dict(r))
            d["asama_metni"] = _siparis_asama_metni_sube_panel(d)
            talepler.append(d)

        mevcut_ids = {str(d.get("id") or "").strip() for d in talepler}
        eksik_yolda = [
            tid
            for tid in yolda_map.keys()
            if tid and tid not in mevcut_ids
        ]
        if eksik_yolda:
            cur.execute(
                f"""
                SELECT t.id, t.tarih, t.durum, t.bildirim_saati, t.olusturma,
                       {SD_T} AS sevkiyat_durumu,
                       COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id) AS hedef_depo_sube_id,
                       hd.ad AS hedef_depo_adi,
                       t.kalemler,
                       t.kalem_durumlari,
                       t.sevkiyat_ts,
                       t.depo_sevkiyat_rapor_metni,
                       t.depo_sevkiyat_rapor_ts,
                       t.depo_sevkiyat_rapor_uyari,
                       NULLIF(TRIM(t.operasyon_yonlendirme_talimati), '') AS operasyon_yonlendirme_talimati,
                       t.tahsis_durum,
                       t.tahsis_ts,
                       t.tahsis_yapan_ad,
                       (SELECT MAX(y.kabul_ts) FROM stok_yolda y
                        WHERE y.siparis_talep_id = t.id AND y.sube_id = t.sube_id) AS kabul_ts,
                       (SELECT
                          CASE
                            WHEN SUM(CASE WHEN y.durum='yolda'           THEN 1 ELSE 0 END) = 0
                                 AND SUM(CASE WHEN y.durum IN ('kabul_edildi','kabul_uyusmazlik') THEN 1 ELSE 0 END) > 0
                            THEN CASE WHEN SUM(CASE WHEN y.durum='kabul_uyusmazlik' THEN 1 ELSE 0 END) > 0
                                      THEN 'kabul_uyusmazlik' ELSE 'kabul_tam' END
                            WHEN SUM(CASE WHEN y.durum='kabul_edildi'    THEN 1 ELSE 0 END) > 0
                            THEN 'kabul_kismi'
                            ELSE NULL
                          END
                        FROM stok_yolda y
                        WHERE y.siparis_talep_id = t.id AND y.sube_id = t.sube_id
                       ) AS stok_kabul_durum
                FROM siparis_talep t
                LEFT JOIN subeler hd ON hd.id = COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id)
                WHERE t.sube_id=%s AND t.id = ANY(%s)
                """,
                (sube_id, eksik_yolda),
            )
            ekstra: List[Dict[str, Any]] = []
            for r in cur.fetchall() or []:
                d = _siparis_akisi_talep_satir_isle(dict(r))
                d["asama_metni"] = _siparis_asama_metni_sube_panel(d)
                ekstra.append(d)
            talepler = ekstra + talepler

        for d in talepler:
            d["teslim_bekleyen_kalemler"] = yolda_map.get(str(d.get("id") or ""), [])
            d["tamamlanabilir_yol"] = _siparis_tamamlanabilir_yol(d, sube_id)
            if d.get("teslim_bekleyen_kalemler"):
                d["asama_metni"] = "Depodan çıktı — paket teslim kabulü bekliyor"

        depo_paket_teslim_bekleyen = [
            t for t in talepler if t.get("teslim_bekleyen_kalemler")
        ]

        q_dep = f"""
            SELECT t.id, t.tarih, t.durum, t.bildirim_saati, t.olusturma,
                   {SD_T} AS sevkiyat_durumu,

                   t.sube_id AS talep_sube_id,
                   ts.ad AS talep_sube_adi,
                   t.kalemler,
                   t.kalem_durumlari,
                   COALESCE(NULLIF(TRIM(t.sevkiyat_notu), ''), t.sevkiyat_notlari) AS sevkiyat_notu,
                   t.sevkiyat_ts,
                   t.depo_sevkiyat_rapor_metni,
                   t.depo_sevkiyat_rapor_ts,
                   t.depo_sevkiyat_rapor_uyari,
                   NULLIF(TRIM(t.operasyon_yonlendirme_talimati), '') AS operasyon_yonlendirme_talimati
            FROM siparis_talep t
            JOIN subeler ts ON ts.id = t.sube_id
            WHERE COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id) = %s
              AND t.tarih >= CURRENT_DATE - (%s * INTERVAL '1 day')
              AND t.durum NOT IN ('iptal', 'teslim_edildi', 'gonderilmedi', 'bekliyor', 'kabul_uyusmazlik')
              -- Yalnızca HENÜZ sevk edilmemiş (hazirlaniyor) talepler «Gönderilecek»te kalır.
              -- «Yola Çıkar» basıldığında durum=gonderildi olur ve kart bu listeden KAPANIR;
              -- kısmi/eksik kalemler depo sevkiyat raporuyla merkeze bildirilir (gönderilenler geçmişinde görünür).
              AND t.durum = 'hazirlaniyor'
            ORDER BY t.sevkiyat_ts DESC NULLS LAST, t.olusturma DESC NULLS LAST, t.id DESC
            LIMIT %s
        """
        cur.execute(q_dep, (sube_id, gun_i, lim))
        depo_hazirlik: List[Dict[str, Any]] = []
        for r in cur.fetchall() or []:
            d = dict(r)
            if d.get("tarih"):
                d["tarih"] = str(d["tarih"])
            if d.get("olusturma"):
                d["olusturma"] = str(d["olusturma"])
            if d.get("sevkiyat_ts"):
                d["sevkiyat_ts"] = str(d["sevkiyat_ts"])
            if d.get("depo_sevkiyat_rapor_ts"):
                d["depo_sevkiyat_rapor_ts"] = str(d["depo_sevkiyat_rapor_ts"])
            oid = str(d.get("id") or "")
            km_raw = d.get("kalemler")
            kd_raw = d.get("kalem_durumlari")
            ozet = _siparis_kalem_ozet_from_json(km_raw)
            d.pop("kalemler", None)
            d.pop("kalem_durumlari", None)
            d["kalemler_ozet"] = ozet
            d["kalem_duzenle"] = _siparis_kalem_duzenle_panel(km_raw, kd_raw)
            d["kalem_durum_ozet"] = _siparis_kalem_durum_ozet(kd_raw)
            sn = d.get("sevkiyat_notu")
            d["sevkiyat_notu"] = (str(sn).strip() if sn else "") or None
            d["asama_metni"] = _siparis_asama_metni_sube_panel(d)
            d["benim_talebim"] = str(d.get("talep_sube_id") or "") == sube_id
            d["id"] = oid
            depo_hazirlik.append(d)

        try:
            cur.execute(
                """
                SELECT COUNT(*) FROM siparis_talep t
                WHERE COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id) = %s
                  AND t.tarih >= CURRENT_DATE - (%s * INTERVAL '1 day')
                  AND t.durum NOT IN ('iptal', 'teslim_edildi', 'gonderilmedi', 'bekliyor', 'kabul_uyusmazlik')
                  AND t.durum = 'hazirlaniyor'
                """,
                (sube_id, gun_i),
            )
            drt = cur.fetchone()
            depo_hazirlik_toplam = int(list(drt.values())[0]) if drt else 0
        except Exception:
            depo_hazirlik_toplam = len(depo_hazirlik)

        depo_kalan_kalemleri = _depo_kalan_kalemleri_listesi(cur, sube_id, gun_i, lim)

        cur.execute(
            f"""
            SELECT t.id, t.tarih, t.durum, t.bildirim_saati, t.olusturma,
                   {SD_T} AS sevkiyat_durumu,
                   t.sube_id AS talep_sube_id,
                   ts.ad AS talep_sube_adi,
                   t.sevkiyat_ts,
                   t.sevkiyat_personel_ad,
                   t.depo_sevkiyat_rapor_metni,
                   t.depo_sevkiyat_rapor_uyari,
                   NULLIF(TRIM(t.operasyon_yonlendirme_talimati), '') AS operasyon_yonlendirme_talimati
            FROM siparis_talep t
            JOIN subeler ts ON ts.id = t.sube_id
            WHERE COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id) = %s
              AND t.tarih >= CURRENT_DATE - INTERVAL '7 days'
              AND t.durum = 'gonderildi'
            ORDER BY t.sevkiyat_ts DESC NULLS LAST, t.id DESC
            LIMIT 40
            """,
            (sube_id,),
        )
        depo_gonderilenler: List[Dict[str, Any]] = []
        for r in cur.fetchall() or []:
            d = dict(r)
            for fld in ("tarih", "olusturma", "sevkiyat_ts"):
                if d.get(fld):
                    d[fld] = str(d[fld])
            d["id"] = str(d.get("id") or "")
            depo_gonderilenler.append(d)

        toptanci_teslim_bekleyen = [
            t for t in talepler if t.get("tamamlanabilir_yol") == "toptanci_teslim"
        ]

    return {
        "gun": gun_i,
        "tamamlanan_dahil": bool(tamamlanan_dahil),
        "talepler": talepler,
        "depo_paket_teslim_bekleyen": depo_paket_teslim_bekleyen,
        "toptanci_teslim_bekleyen": toptanci_teslim_bekleyen,
        "depo_hazirlik_talepleri": depo_hazirlik,
        "depo_hazirlik_sayisi": depo_hazirlik_toplam,
        "depo_gonderilenler": depo_gonderilenler,
        "depo_kalan_kalemleri": depo_kalan_kalemleri,
    }


@router.post("/{sube_id}/siparis-teslim-kabul")
def sube_siparis_teslim_kabul(sube_id: str, body: SubeSiparisTeslimKabulBody):
    """
    Talep şubesi paketi teslim aldığını onaylar: stok_yolda → kabul, şube deposu güncellenir.
    Merkez API'deki /ops/v2/siparis/{id}/kabul ile aynı motor (sube_kabul_kaydet).
    """
    tid = (body.talep_id or "").strip()
    pid_in = (body.personel_id or "").strip()
    pin = (body.pin or "").replace(" ", "")
    if not tid or not pid_in or len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "talep_id, personel_id ve 4 haneli PIN gerekli")
    if not body.kabul:
        raise HTTPException(400, "En az bir kalem için kabul adedi girin")
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        if not _bugun_kasa_acildi_mi(cur, sube_id):
            raise HTTPException(403, "Önce günlük kasa kilidini PIN ile açmalısınız.")
        ku = dogrula_personel_panel_pin(cur, pid_in, pin)
        yapan_ad = (ku.get("ad_soyad") or "").strip() or None
        cur.execute(
            "SELECT sube_id, durum FROM siparis_talep WHERE id=%s",
            (tid,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Sipariş bulunamadı")
        talep_sube = str(row.get("sube_id") or row[0] or "")
        st = str(row.get("durum") or row[1] or "").strip()
        if talep_sube != sube_id:
            raise HTTPException(403, "Bu sipariş bu şubeye ait değil")
        if st not in ("gonderildi", "hazirlaniyor", "kabul_uyusmazlik"):
            raise HTTPException(
                400,
                f"Teslim onayı bu sipariş durumunda yapılamaz (şu an: {st or '—'})",
            )
        cur.execute(
            """
            SELECT id, kalem_kodu, kalem_adi, sevk_adet
            FROM stok_yolda
            WHERE siparis_talep_id=%s AND sube_id=%s AND durum='yolda'
            ORDER BY sevk_ts ASC NULLS LAST, id ASC
            """,
            (tid, sube_id),
        )
        bekleyen_yolda = [dict(r) for r in (cur.fetchall() or [])]
        if not bekleyen_yolda:
            raise HTTPException(
                400,
                "Yolda bekleyen paket kalemi yok — depo sevk çıkışı tamamlanmamış olabilir.",
            )
        bekleyen_ids = {str(r.get("id") or "") for r in bekleyen_yolda}
        gonderilen_ids = {
            str((k.yolda_id or "").strip())
            for k in body.kabul
            if str((k.yolda_id or "").strip())
        }
        # Sadece DB'de olmayan yabancı ID'leri reddet; eksik veya kısmi gönderim
        # sube_kabul_kaydet() içindeki dual-matching (ID → kalem_kodu) tarafından
        # graceful işlenir ve gerekirse kabul_uyusmazlik kaydı açılır.
        extra_ids = gonderilen_ids - bekleyen_ids
        if extra_ids:
            raise HTTPException(
                400,
                f"Kabul listesinde tanınmayan yolda_id var ({len(extra_ids)} adet). "
                "Sayfayı yenileyip tekrar deneyin.",
            )
        # FIX #3: hazirlaniyor durumu iki anlama gelebiliyor:
        #   (A) Depo hazırladı, yola çıkardı ama siparis_talep henüz 'gonderildi' olmadı
        #   (B) Depo henüz çıkarış yapmadı, stok_yolda satırı hiç yok
        # stok_yolda kontrolü ile (A)/(B) ayrımı yaparak net mesaj ver.
        if st == "hazirlaniyor":
            cur.execute(
                """
                SELECT COUNT(*) AS toplam,
                       SUM(CASE WHEN durum='yolda' THEN 1 ELSE 0 END) AS yolda_sayisi
                FROM stok_yolda
                WHERE siparis_talep_id=%s AND sube_id=%s
                """,
                (tid, sube_id),
            )
            _sy = dict(cur.fetchone() or {})
            _yolda = int(_sy.get("yolda_sayisi") or 0)
            _toplam = int(_sy.get("toplam") or 0)
            if _yolda == 0:
                if _toplam > 0:
                    raise HTTPException(
                        400,
                        "Tüm kalemler zaten kabul edilmiş veya uyumsuzluk kaydı var — "
                        "ops merkezinden durumu kontrol edin",
                    )
                raise HTTPException(
                    400,
                    "Paket henüz yola çıkmamış: depo sevk çıkışı yapılmadı. "
                    "Operasyon merkezi 'gönder' işlemini tamamlayana kadar bekleyin.",
                )
        sonuc = sube_kabul_kaydet(
            cur,
            tid,
            sube_id,
            [k.model_dump() for k in body.kabul],
            pid_in,
            yapan_ad,
        )
        conn.commit()
    return sonuc


@router.post("/{sube_id}/siparis-depo-sevkiyat-kaydet")
def sube_siparis_depo_sevkiyat_kaydet(sube_id: str, body: SubeDepoSevkiyatKaydetBody):
    """
    Bu endpointe yalnızca operasyonun atadığı hedef depo şubesi erişir; bu şube bu sipariş için
    merkez depo ile aynı iş kurallarıyla (kalem durumu, rapor, gönderildi → ``sube_depo_stok`` çıkışı)
    çalışır. Defter kaydı ``defter_sube_id=sube_id`` ile çıkış deposunda tutulur.
    """
    tid = (body.talep_id or "").strip()
    pid_in = (body.personel_id or "").strip()
    pin = (body.pin or "").replace(" ", "")
    if not tid or not pid_in or len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "talep_id, personel_id ve 4 haneli PIN gerekli")
    durumlar, bekleyen_var, kismi_var = sevkiyat_kalem_durumlari_normalize(body.kalemler)
    notu = (body.sevkiyat_notu or "").strip() or None
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        if not _bugun_kasa_acildi_mi(cur, sube_id):
            raise HTTPException(403, "Önce günlük kasa kilidini PIN ile açmalısınız.")
        ku = dogrula_personel_panel_pin(cur, pid_in, pin)
        pad = (ku.get("ad_soyad") or "").strip() or None
        return siparis_sevkiyat_kalem_guncelle_execute(
            cur,
            talep_id=tid,
            hedef_depo_sube_id=sube_id,
            durumlar=durumlar,
            bekleyen_var=bekleyen_var,
            kismi_var=kismi_var,
            notu=notu,
            personel_ad=pad,
            gonderildi=bool(body.gonderildi),
            defter_sube_id=sube_id,
        )


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
        if not _bugun_sube_acildi_mi(cur, sube_id):
            raise HTTPException(403, "Şube açılışı tamamlanmadan sipariş verilemez.")
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


def _siparis_bekliyor_yonlendirilmemis(cur, sube_id: str) -> Optional[Dict]:
    """
    Bu şubenin depoya yönlendirilmemiş (bekliyor) en son siparişini döner.
    Yönlendirme kriteri: hedef_depo_sube_id IS NULL VE sevkiyat_sube_id IS NULL.
    Bulunamazsa None döner.
    """
    cur.execute(
        """
        SELECT id, kalemler
        FROM siparis_talep
        WHERE sube_id = %s
          AND durum = 'bekliyor'
          AND (hedef_depo_sube_id IS NULL OR hedef_depo_sube_id = '')
          AND (sevkiyat_sube_id   IS NULL OR sevkiyat_sube_id   = '')
        ORDER BY olusturma DESC
        LIMIT 1
        FOR UPDATE
        """,
        (sube_id,),
    )
    row = cur.fetchone()
    return dict(row) if row else None


def _kalem_merge(mevcut: List[Dict], yeni: List[Dict]) -> List[Dict]:
    """
    İki kalem listesini birleştirir.
    Aynı ürün (urun_id öncelikli, yoksa urun_ad normalize) varsa adet toplanır.
    """
    sonuc: Dict[str, Dict] = {}
    for k in mevcut:
        anahtar = (str(k.get("urun_id") or "").strip()
                   or str(k.get("urun_ad") or "").strip().lower())
        if not anahtar:
            continue
        sonuc[anahtar] = dict(k)

    for k in yeni:
        uid = str(k.get("urun_id") or "").strip()
        uad = str(k.get("urun_ad") or "").strip()
        anahtar = uid or uad.lower()
        if not anahtar:
            continue
        if anahtar in sonuc:
            sonuc[anahtar]["adet"] = int(sonuc[anahtar].get("adet") or 0) + int(k.get("adet") or 0)
        else:
            sonuc[anahtar] = dict(k)

    return list(sonuc.values())


@router.post("/{sube_id}/siparis-kalem-ekle")
def sube_siparis_kalem_ekle(sube_id: str, body: SiparisOnayBody):
    """
    Akıllı sipariş ekleme — iş kuralı:

      • Depoya yönlendirilmemiş (bekliyor) açık sipariş VAR
        → Kalemler mevcut siparişe eklenir / adetler toplanır.
        → Ops tek sipariş görür, kafa karışmaz.

      • Açık sipariş YOK veya mevcut sipariş depoya yönlendirilmiş
        → Otomatik yeni sipariş oluşturulur, 409 çıkmaz.

    Şube panelinde "tekrar sipariş" butonu bu endpoint'i çağırmalı.
    Klasik /siparis-onay yerine bu kullanılırsa çift sipariş sorunu ortadan kalkar.
    """
    pid_in = (body.personel_id or "").strip()
    pin    = (body.pin or "").replace(" ", "")
    if not pid_in or len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "personel_id ve 4 haneli PIN gerekli")

    temiz: List[Dict[str, Any]] = []
    for k in (body.kalemler or []):
        ad   = (k.urun_ad or "").strip()
        adet = int(k.adet or 0)
        if not ad or adet <= 0:
            continue
        temiz.append({
            "kategori_id": (k.kategori_id or "").strip(),
            "urun_id":     (k.urun_id or "").strip(),
            "urun_ad":     ad,
            "aciklama":    (getattr(k, "aciklama", None) or "").strip() or None,
            "adet":        adet,
        })
    if not temiz:
        raise HTTPException(400, "En az bir kalemde adet girin")

    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        if not _bugun_kasa_acildi_mi(cur, sube_id):
            raise HTTPException(403, "Önce günlük kasa kilidini PIN ile açmalısınız.")
        if not _bugun_sube_acildi_mi(cur, sube_id):
            raise HTTPException(403, "Şube açılışı tamamlanmadan sipariş verilemez.")
        ku = dogrula_personel_panel_pin(cur, pid_in, pin)
        onay_ad   = (ku.get("ad_soyad") or "").strip() or "—"
        pid_panel = str(ku.get("id") or "").strip() or pid_in

        # Advisory lock — aynı şubeden eş zamanlı istek sıralansın
        cur.execute(
            "SELECT pg_advisory_xact_lock(hashtext(%s))",
            (f"siparis_onay_{sube_id}",),
        )

        acik = _siparis_bekliyor_yonlendirilmemis(cur, sube_id)

        if acik:
            # ── MERGE: mevcut siparişe ekle ──────────────────────────────
            talep_id = str(acik["id"])
            mevcut_kalemler = acik.get("kalemler") or []
            if isinstance(mevcut_kalemler, str):
                try:
                    mevcut_kalemler = json.loads(mevcut_kalemler)
                except Exception:
                    mevcut_kalemler = []

            birlesik = _kalem_merge(mevcut_kalemler, temiz)
            eklenen_adetler = {
                (k.get("urun_id") or k.get("urun_ad", "").lower()): k["adet"]
                for k in temiz
            }

            cur.execute(
                """
                UPDATE siparis_talep
                SET kalemler       = %s::jsonb,
                    not_aciklama   = CASE
                                       WHEN not_aciklama IS NULL THEN %s
                                       ELSE not_aciklama || ' | ' || %s
                                     END
                WHERE id = %s
                """,
                (
                    json.dumps(birlesik, ensure_ascii=False),
                    (body.not_aciklama or "").strip() or None,
                    (body.not_aciklama or "").strip() or None,
                    talep_id,
                ),
            )

            from operasyon_defter import operasyon_defter_ekle
            tr_now = _now_tr()
            operasyon_defter_ekle(
                cur, sube_id, "SIPARIS_KALEM_EKLENDI",
                f"Mevcut siparişe {len(temiz)} kalem eklendi — personel={onay_ad}",
                personel_id=pid_panel, personel_ad=onay_ad,
                bildirim_saati=tr_now.strftime("%H:%M:%S"),
            )
            audit(cur, "siparis_talep", talep_id, "SIPARIS_KALEM_EKLENDI")
            conn.commit()
            return {
                "islem":              "eklendi",
                "talep_id":           talep_id,
                "eklenen_kalem_sayisi": len(temiz),
                "toplam_kalem_sayisi":  len(birlesik),
                "mesaj": (
                    f"{len(temiz)} kalem mevcut siparişe eklendi. "
                    "Ops ekibi tek sipariş olarak görüyor."
                ),
            }

        else:
            # ── YENİ SİPARİŞ: yönlendirilmiş veya hiç sipariş yok ───────
            tr_now = _now_tr()
            saat   = tr_now.strftime("%H:%M:%S")
            tid    = str(uuid.uuid4())
            cur.execute(
                """
                INSERT INTO siparis_talep
                    (id, sube_id, tarih, durum, personel_id, personel_ad,
                     bildirim_saati, not_aciklama, kalemler)
                VALUES (%s, %s, CURRENT_DATE, 'bekliyor', %s, %s, %s, %s, %s::jsonb)
                """,
                (
                    tid, sube_id, pid_panel, onay_ad, saat,
                    (body.not_aciklama or "").strip() or None,
                    json.dumps(temiz, ensure_ascii=False),
                ),
            )
            audit(cur, "siparis_talep", tid, "SIPARIS_ONAY")
            from operasyon_defter import operasyon_defter_ekle
            operasyon_defter_ekle(
                cur, sube_id, "SIPARIS_ONAY_PIN",
                f"Yeni sipariş (önceki yönlendirilmişti) — personel={onay_ad} kalem={len(temiz)}",
                personel_id=pid_panel, personel_ad=onay_ad,
                bildirim_saati=saat,
            )
            try:
                from operasyon_stok_motor import siparis_olustu_kaydet
                siparis_olustu_kaydet(cur, tid, sube_id, temiz, pid_panel, onay_ad)
            except Exception:
                pass
            conn.commit()
            return {
                "islem":              "yeni_siparis",
                "talep_id":           tid,
                "eklenen_kalem_sayisi": len(temiz),
                "toplam_kalem_sayisi":  len(temiz),
                "mesaj": (
                    "Önceki sipariş depoya yönlendirilmişti — "
                    "yeni sipariş oluşturuldu."
                ),
            }


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
        aciklama_val = (getattr(k, "aciklama", None) or "").strip() or None
        temiz.append(
            {
                "kategori_id": (k.kategori_id or "").strip(),
                "urun_id": (k.urun_id or "").strip(),
                "urun_ad": ad,
                "aciklama": aciklama_val,
                "adet": adet,
            }
        )
    if not temiz:
        raise HTTPException(400, "Onay için en az bir kalemde adet girin")

    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        if not _bugun_kasa_acildi_mi(cur, sube_id):
            raise HTTPException(403, "Önce günlük kasa kilidini PIN ile açmalısınız.")
        if not _bugun_sube_acildi_mi(cur, sube_id):
            raise HTTPException(403, "Şube açılışı tamamlanmadan sipariş verilemez.")
        ku = dogrula_personel_panel_pin(cur, pid_in, pin)
        onay_ad = (ku.get("ad_soyad") or "").strip() or "—"
        pid_panel = str(ku.get("id") or "").strip() or pid_in
        # SORUN-1 FİX: check-then-insert zincirini advisory lock ile kilitle.
        # Aynı şubeden eş zamanlı iki istek aynı anda hem "0 açık sipariş" okuyup
        # hem insert yapamasın — biri lock alır, diğeri bekler.
        # pg_try_advisory_xact_lock: transaction bitince otomatik serbest kalır.
        cur.execute(
            "SELECT pg_advisory_xact_lock(hashtext(%s))",
            (f"siparis_onay_{sube_id}",),
        )
        acik_n, _ref_oid, uyari_metni, ortak = sube_yeni_siparis_oncesi_cift_kontrol(cur, sube_id, temiz)
        # Güncellenen iş kuralı:
        # 409 yalnızca depoya yönlendirilmemiş (bekliyor) açık sipariş varsa çıkar.
        # Siparişler depoya yönlendirildiyse (hazirlaniyor / gonderildi) zaten
        # ayrı akışta işleniyordur → yeni sipariş özgürce açılabilir.
        yonlendirilmemis_var = False
        if acik_n >= 1:
            cur.execute(
                """
                SELECT COUNT(*) AS c FROM siparis_talep
                WHERE sube_id = %s
                  AND durum = 'bekliyor'
                  AND (hedef_depo_sube_id IS NULL OR hedef_depo_sube_id = '')
                  AND (sevkiyat_sube_id   IS NULL OR sevkiyat_sube_id   = '')
                """,
                (sube_id,),
            )
            yonlendirilmemis_var = int((cur.fetchone() or {}).get("c") or 0) > 0

        if yonlendirilmemis_var and not bool(body.force_cift_siparis):
            raise HTTPException(
                status_code=409,
                detail={
                    "kod": "CIFT_SIPARIS_UYARI",
                    "mesaj": uyari_metni or "Tamamlanmamış sipariş talebiniz var.",
                    "onceki_acik_sayisi": acik_n,
                    "ortak_urun_etiketleri": ortak,
                    "ipucu": "Mevcut siparişe eklemek için /siparis-kalem-ekle kullanın.",
                },
            )
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
        # Davranış kontrol motoru: GEREKSIZ_SIPARIS + FAZLA_FREKANS
        try:
            from operasyon_stok_motor import siparis_olustu_kaydet
            siparis_olustu_kaydet(cur, tid, sube_id, temiz, pid_panel, onay_ad)
        except Exception:
            traceback.print_exc()
        # Eksik kullanım kontrolü: stok var ama sipariş geliyorsa uyar
        try:
            from operasyon_stok_motor import eksik_kullanim_kontrol
            eksik_kullanim_kontrol(cur)
        except Exception:
            pass
        out: Dict[str, Any] = {
            "success": True,
            "talep_id": tid,
            "kalem_sayisi": len(temiz),
            "toplam_adet": toplam,
        }
        if acik_n >= 1:
            out["cift_siparis_notu"] = (
                "Bu sipariş, teslimi bekleyen önceki talepler varken kaydedildi."
            )
        return out


@router.post("/{sube_id}/siparis-yoklama")
def sube_siparis_yoklama(sube_id: str, body: SiparisYoklamaBody):
    """QR yoklama oturumu ile sipariş ver — PIN gerekmez, yoklama kaydı yeterli."""
    pid_in = (body.personel_id or "").strip()
    if not pid_in:
        raise HTTPException(400, "personel_id gerekli")
    kalemler = body.kalemler or []
    temiz: List[Dict[str, Any]] = []
    for k in kalemler:
        ad = (k.urun_ad or "").strip()
        if not ad:
            continue
        adet = int(k.adet or 0)
        if adet <= 0:
            continue
        temiz.append({
            "kategori_id": (k.kategori_id or "").strip(),
            "urun_id": (k.urun_id or "").strip(),
            "urun_ad": ad,
            "aciklama": (getattr(k, "aciklama", None) or "").strip() or None,
            "adet": adet,
        })
    if not temiz:
        raise HTTPException(400, "En az bir kalem gerekli")

    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        # Yoklama kontrolü — QR oturumu geçerli mi?
        cur.execute("""
            SELECT id FROM gorev_yoklama
            WHERE sube_id=%s AND personel_id=%s AND tarih=%s LIMIT 1
        """, (sube_id, pid_in, is_gunu_tr()))
        if not cur.fetchone():
            raise HTTPException(403, "Bu şube için geçerli QR yoklama kaydı bulunamadı. Önce QR okutun.")
        # Personel adını al
        cur.execute("SELECT ad_soyad FROM personel WHERE id::text=%s", (pid_in,))
        p_row = cur.fetchone()
        onay_ad = (p_row["ad_soyad"] if p_row else pid_in).strip() or "—"

        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"siparis_onay_{sube_id}",))
        acik_n, _ref_oid, uyari_metni, ortak = sube_yeni_siparis_oncesi_cift_kontrol(cur, sube_id, temiz)
        yonlendirilmemis_var = False
        if acik_n >= 1:
            cur.execute("""
                SELECT COUNT(*) AS c FROM siparis_talep
                WHERE sube_id=%s AND durum='bekliyor'
                  AND (hedef_depo_sube_id IS NULL OR hedef_depo_sube_id='')
                  AND (sevkiyat_sube_id IS NULL OR sevkiyat_sube_id='')
            """, (sube_id,))
            yonlendirilmemis_var = int((cur.fetchone() or {}).get("c") or 0) > 0

        if yonlendirilmemis_var and not bool(body.force_cift_siparis):
            raise HTTPException(status_code=409, detail={
                "kod": "CIFT_SIPARIS_UYARI",
                "mesaj": uyari_metni or "Tamamlanmamış sipariş talebiniz var.",
                "onceki_acik_sayisi": acik_n,
                "ortak_urun_etiketleri": ortak,
            })

        tr_now = _now_tr()
        saat = tr_now.strftime("%H:%M:%S")
        tid = str(uuid.uuid4())
        cur.execute("""
            INSERT INTO siparis_talep
                (id, sube_id, tarih, durum, personel_id, personel_ad, bildirim_saati, not_aciklama, kalemler)
            VALUES (%s, %s, CURRENT_DATE, 'bekliyor', %s, %s, %s, %s, %s::jsonb)
        """, (tid, sube_id, pid_in, onay_ad, saat,
              (body.not_aciklama or "").strip() or None,
              json.dumps(temiz, ensure_ascii=False)))
        audit(cur, "siparis_talep", tid, "SIPARIS_YOKLAMA")
        from operasyon_defter import operasyon_defter_ekle
        toplam = sum(int(x.get("adet") or 0) for x in temiz)
        operasyon_defter_ekle(cur, sube_id, "SIPARIS_YOKLAMA",
            f"QR sipariş — personel={onay_ad} kalem={len(temiz)} adet={toplam}",
            personel_id=pid_in, personel_ad=onay_ad, bildirim_saati=saat)
        try:
            from operasyon_stok_motor import siparis_olustu_kaydet
            siparis_olustu_kaydet(cur, tid, sube_id, temiz, pid_in, onay_ad)
        except Exception:
            traceback.print_exc()
        conn.commit()
        return {"success": True, "talep_id": tid, "kalem_sayisi": len(temiz), "toplam_adet": toplam}


@router.get("/{sube_id}/geri-bildirimler")
def sube_geri_bildirimler(sube_id: str, gun: int = Query(default=14, ge=1, le=90)):
    """Operasyon merkezinin bu şubeye yönelik defter kayıtları (geri bildirim akışı)."""
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        cur.execute(
            """
            SELECT id, tarih, bildirim_saati, personel_ad, etiket, aciklama,
                   olusturma
            FROM operasyon_defter
            WHERE sube_id = %s
              AND etiket IN (
                  'MERKEZ_NOT', 'SEVK_UYUSMAZLIK_COZULDU', 'TAHSIS_KARAR',
                  'KABUL_FARKI', 'SIPARIS_IPTAL', 'MERKEZ_UYARI',
                  'OZEL_TALEP_MERKEZ', 'MERKEZ_MESAJ'
              )
              AND tarih >= CURRENT_DATE - (%s * INTERVAL '1 day')
            ORDER BY olusturma DESC
            LIMIT 60
            """,
            (sube_id, gun),
        )
        rows = cur.fetchall()
        bildirimler = []
        for r in rows:
            rd = dict(r)
            bildirimler.append({
                "id": str(rd.get("id") or ""),
                "tarih": str(rd.get("tarih") or ""),
                "saat": str(rd.get("bildirim_saati") or ""),
                "personel_ad": rd.get("personel_ad") or "—",
                "etiket": rd.get("etiket") or "",
                "aciklama": rd.get("aciklama") or "",
                "olusturma": str(rd.get("olusturma") or ""),
            })
        # Ayrıca merkez mesajlarını da çek (sube_merkez_mesaj tablosu)
        cur.execute(
            """
            SELECT id, olusturma, mesaj, gonderen_ad, okundu
            FROM sube_merkez_mesaj
            WHERE sube_id = %s
              AND olusturma >= NOW() - (%s * INTERVAL '1 day')
            ORDER BY olusturma DESC
            LIMIT 30
            """,
            (sube_id, gun),
        )
        mesaj_rows = cur.fetchall()
        merkez_mesajlar = []
        for m in mesaj_rows:
            md = dict(m)
            merkez_mesajlar.append({
                "id": str(md.get("id") or ""),
                "olusturma": str(md.get("olusturma") or ""),
                "mesaj": md.get("mesaj") or "",
                "gonderen_ad": md.get("gonderen_ad") or "Merkez",
                "okundu": bool(md.get("okundu")),
            })
        return {"bildirimler": bildirimler, "merkez_mesajlar": merkez_mesajlar}


@router.post("/{sube_id}/panel-pin-dogrula")
def sube_panel_pin_dogrula(sube_id: str, body: PanelPinDogrulaBody):
    """Şube panelinde (sipariş / ürün teslim / ürün aç kategori modalında) pencereyi kapatmadan önce PIN doğrular; girilen miktarları silmez."""
    pid_in = (body.personel_id or "").strip()
    pin = (body.pin or "").replace(" ", "")
    if not pid_in or len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "personel_id ve 4 haneli PIN gerekli")
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        ku = dogrula_personel_panel_pin(cur, pid_in, pin)
        ad = (ku.get("ad_soyad") or "").strip() or "—"
        return {"success": True, "personel_id": str(ku.get("id") or pid_in), "ad_soyad": ad}


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
    uyari_id: Optional[str] = None,
) -> Optional[str]:
    """
    Kasa / stok farkı varsa onay_kuyrugu'na KASA_FARKI kaydı ekler.
    Aynı gün aynı şube için aynı tip zaten varsa tekrar eklemez (idempotent).

    `uyari_id` verilirse (sube_operasyon_uyari.id), onay_kuyrugu kaydı
    kaynak_tablo='sube_operasyon_uyari' + kaynak_id=uyari_id ile eklenir —
    böylece onay kuyruğundan onaylama, CFO/Merkez tarafındaki
    sube_operasyon_uyari satırını da çözüldü (okundu=TRUE) olarak işaretler.
    """
    fark = round(gercek - beklenen, 2)
    if fark == 0:
        return None

    # Aynı gün aynı tip zaten varsa atla — İŞ GÜNÜ bazlı (uyarı/recalc ile tutarlı).
    # aciklama '[sube_id]' ile başlar → alt-dizgi çakışması olmadan eşleşir.
    _onay_isgun = is_gunu_tr()
    cur.execute(
        """
        SELECT 1 FROM onay_kuyrugu
        WHERE kaynak_tablo IN ('kasa_farki', 'sube_operasyon_uyari') AND islem_turu=%s
          AND tarih=%s
          AND aciklama LIKE %s
          AND durum='bekliyor'
        LIMIT 1
        """,
        (tip, _onay_isgun, f"[{sube_id}]%"),
    )
    if cur.fetchone():
        return None

    tam_acik = f"[{sube_id}] {aciklama} | beklenen={beklenen:.2f} gerçek={gercek:.2f} fark={fark:+.2f}"
    if uyari_id:
        kaynak_tablo, fark_id = "sube_operasyon_uyari", uyari_id
    else:
        kaynak_tablo, fark_id = "kasa_farki", str(uuid.uuid4())
    onay_ekle(
        cur,
        tip,
        kaynak_tablo,
        fark_id,
        tam_acik[:500],
        fark,
        _onay_isgun,
    )
    return fark_id
