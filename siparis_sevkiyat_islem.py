"""
Sipariş sevkiyat kalem durumu — operasyon merkezi ve depo şube paneli ortak iş mantığı.

Operasyonun yönlendirdiği hedef depo şubesi (ör. Tema, Zafer), bu sipariş için
«merkez depo» ile aynı roldedir: çıkış stoğu ``sube_depo_stok`` üzerinden,
operasyon_defter kaydı ise ``defter_sube_id`` = hedef şube ile tutulur (tüm zincir
aynı çıkış deposunda izlenir).
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException

from kasa_service import audit
from operasyon_defter import operasyon_defter_ekle
from operasyon_stok_motor import sevk_cikti_kaydet as _disiplin_sevk_cikti
from tr_saat import dt_now_tr


def sevkiyat_kalem_durumlari_normalize(items: Any) -> Tuple[List[Dict[str, Any]], bool, bool]:
    """Kalem satırlarını JSONB ile uyumlu dict listesine çevirir; bekleyen/kısmi bayrakları döner."""
    bekleyen_var = False
    kismi_var = False
    durumlar: List[Dict[str, Any]] = []
    for it in items or []:
        if hasattr(it, "model_dump"):
            raw = it.model_dump()
        elif isinstance(it, dict):
            raw = it
        else:
            raw = dict(it)
        dd = (raw.get("durum") or raw.get("sevkiyat_durum") or "").strip().lower()
        if dd.startswith("tahsis"):
            dd = "bekliyor"
        if dd not in ("bekliyor", "var", "yok", "kismi"):
            raise HTTPException(400, "kalem durumları: bekliyor | var | yok | kismi")
        ist = max(0, int(raw.get("istenen_adet") or 0))
        g_adet = max(0, int(raw.get("gonderilen_adet") or 0))
        if dd == "var" and g_adet <= 0 and ist > 0:
            g_adet = ist
        if dd == "yok":
            g_adet = 0
        if ist > 0 and g_adet > ist and dd in ("var", "kismi"):
            g_adet = ist
        if dd == "kismi" and g_adet <= 0:
            raise HTTPException(400, "kısmi için gonderilen_adet > 0 olmalı")
        if dd == "bekliyor":
            bekleyen_var = True
        if dd == "kismi":
            kismi_var = True
        notu = raw.get("notu") or raw.get("not_aciklama") or raw.get("not")
        row_out: Dict[str, Any] = {
            "urun_id": (str(raw.get("urun_id") or "").strip()) or None,
            "urun_ad": (str(raw.get("urun_ad") or "").strip()) or None,
            "istenen_adet": ist,
            "durum": dd,
            "gonderilen_adet": g_adet,
            "not": (str(notu).strip() if notu else None) or None,
        }
        kk = str(raw.get("kalem_kodu") or "").strip()
        if kk:
            row_out["kalem_kodu"] = kk
        # Tahsis alanları korunur (merkez_tahsis + sevkiyat aynı JSON'da)
        if raw.get("talep_adet") is not None:
            row_out["talep_adet"] = max(0, int(raw.get("talep_adet") or 0))
        if raw.get("tahsis_adet") is not None:
            row_out["tahsis_adet"] = max(0, int(raw.get("tahsis_adet") or 0))
        if raw.get("tahsis_durum"):
            row_out["tahsis_durum"] = str(raw.get("tahsis_durum") or "").strip()
        durumlar.append(row_out)
    return durumlar, bekleyen_var, kismi_var


def hesapla_yeni_sevkiyat_durumu(
    durumlar: List[Dict[str, Any]],
    bekleyen_var: bool,
    kismi_var: bool,
    gonderildi: bool,
) -> str:
    if bool(gonderildi) or (durumlar and not bekleyen_var):
        return "gonderildi"
    if kismi_var:
        return "kismi_hazirlandi"
    return "depoda_hazirlaniyor"


def build_depo_sevkiyat_rapor(
    durumlar: List[Dict[str, Any]],
    *,
    personel_ad: Optional[str] = None,
) -> Tuple[str, bool]:
    """
    Operasyon / şube panelleri için okunaklı satır satır rapor.
    Dönüş: (metin, eksik_veya_kismi_uyari) — yok / kismi / bekleyen kalem varsa True.
    """
    satirlar: List[str] = []
    uyari = False
    for d in durumlar or []:
        if not isinstance(d, dict):
            continue
        ad = (d.get("urun_ad") or d.get("urun_id") or "Ürün").strip() or "Ürün"
        ist = int(d.get("istenen_adet") or 0)
        gon = int(d.get("gonderilen_adet") or 0)
        dur = (d.get("durum") or "").strip().lower()
        # Tahsis notu: merkez ne kadar tahsis etti?
        tahsis_notu = ""
        tahsis_adet = int(d.get("tahsis_adet") or 0)
        if tahsis_adet > 0 and tahsis_adet < ist:
            tahsis_notu = f" [tahsis: {tahsis_adet}/{ist}]"
        if dur == "yok":
            uyari = True
            satirlar.append(f"• {ad}: istenen {ist} adet — depoda yok, 0 gönderildi.{tahsis_notu}")
        elif dur == "kismi":
            uyari = True
            satirlar.append(f"• {ad}: istenen {ist} adet — kısmi, {gon} adet gönderildi.{tahsis_notu}")
        elif dur == "var":
            satirlar.append(f"• {ad}: istenen {ist} adet — tamam, {gon} adet gönderildi.{tahsis_notu}")
        elif dur == "bekliyor":
            uyari = True
            satirlar.append(f"• {ad}: istenen {ist} adet — depo hazırlığı beklemede.{tahsis_notu}")
        else:
            satirlar.append(f"• {ad}: istenen {ist} adet — durum: {dur or '—'}.{tahsis_notu}")
    saat = dt_now_tr().strftime("%d.%m.%Y %H:%M")
    imza = (personel_ad or "").strip() or "—"
    bas = f"Depo sevkiyat özeti ({saat}) — onay: {imza}\n"
    if not satirlar:
        return (bas + "Kalem yok.", False)
    return (bas + "\n".join(satirlar), uyari)


def _kaynak_depo_aktif_uyumsuzluk_sayisi(cur: Any, kaynak_depo_sube_id: str, haric_talep_id: str) -> int:
    """Çözülmemiş kabul uyumsuzluğu olan sevkiyat satırlarını sayar."""
    cur.execute(
        """
        SELECT COUNT(*)
        FROM stok_yolda y
        JOIN siparis_talep t ON t.id = y.siparis_talep_id
        WHERE COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id) = %s
          AND t.id <> %s
          AND (
            y.durum = 'kabul_uyusmazlik'
            OR (
              y.durum IN ('kabul_edildi', 'yolda')
              AND y.kabul_ts IS NOT NULL
              AND COALESCE(y.sevk_adet, 0) <> COALESCE(y.kabul_adet, 0)
            )
          )
        """,
        (kaynak_depo_sube_id, haric_talep_id),
    )
    rr = cur.fetchone()
    try:
        return int((rr or [0])[0] or 0)
    except Exception:
        return 0


def siparis_sevkiyat_kalem_guncelle_execute(
    cur: Any,
    *,
    talep_id: str,
    hedef_depo_sube_id: str,
    durumlar: List[Dict[str, Any]],
    bekleyen_var: bool,
    kismi_var: bool,
    notu: Optional[str],
    personel_ad: Optional[str],
    gonderildi: bool,
    defter_sube_id: str,
) -> Dict[str, Any]:
    """FOR UPDATE ile talebi kilitleyip kalem_durumlari ve sevkiyat alanlarını günceller."""
    tid = (talep_id or "").strip()
    sevk_sid = (hedef_depo_sube_id or "").strip()
    if not tid or not sevk_sid:
        raise HTTPException(400, "talep_id ve hedef_depo_sube_id zorunlu")

    yeni_durum = hesapla_yeni_sevkiyat_durumu(durumlar, bekleyen_var, kismi_var, gonderildi)
    eski_durum_karsilik = "gonderildi" if yeni_durum == "gonderildi" else "hazirlaniyor"

    cur.execute(
        """
        SELECT id, COALESCE(hedef_depo_sube_id, sevkiyat_sube_id) AS hedef_depo_sube_id,
               COALESCE(NULLIF(TRIM(sevkiyat_durumu), ''), sevkiyat_durum, 'bekliyor') AS sevkiyat_durumu,
               durum
        FROM siparis_talep
        WHERE id=%s
        FOR UPDATE
        """,
        (tid,),
    )
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Sipariş talebi bulunamadı")
    row = dict(r)
    if str(row.get("hedef_depo_sube_id") or "") != sevk_sid:
        raise HTTPException(409, "Talep farklı sevkiyat şubesine atanmış")
    if str(row.get("durum") or "") == "teslim_edildi":
        raise HTTPException(409, "Talep zaten teslim edildi")
    if yeni_durum == "gonderildi":
        uyumsuz_sayi = _kaynak_depo_aktif_uyumsuzluk_sayisi(cur, sevk_sid, tid)
        if uyumsuz_sayi > 0:
            raise HTTPException(
                409,
                f"Sevkiyat blokajı aktif: {uyumsuz_sayi} çözülmemiş kabul uyumsuzluğu var. "
                "Önce Operasyon Merkezi > Sevkiyat uyumsuzlukları ekranından uzlaştırın.",
            )

    rapor_metni, rapor_uyari = build_depo_sevkiyat_rapor(durumlar, personel_ad=personel_ad)

    cur.execute(
        """
        UPDATE siparis_talep
        SET sevkiyat_durumu=%s,
            sevkiyat_durum=%s,
            durum=CASE WHEN %s='gonderildi' THEN 'gonderildi' ELSE 'hazirlaniyor' END,
            kalem_durumlari=%s::jsonb,
            sevkiyat_notu=COALESCE(%s, sevkiyat_notu),
            sevkiyat_notlari=COALESCE(%s, sevkiyat_notlari),
            sevkiyat_personel_ad=COALESCE(%s, sevkiyat_personel_ad),
            depo_sevkiyat_rapor_metni=%s,
            depo_sevkiyat_rapor_ts=NOW(),
            depo_sevkiyat_rapor_uyari=%s,
            sevkiyat_ts=NOW()
        WHERE id=%s
        """,
        (
            yeni_durum,
            eski_durum_karsilik,
            yeni_durum,
            json.dumps(durumlar, ensure_ascii=False),
            notu,
            notu,
            personel_ad,
            rapor_metni,
            rapor_uyari,
            tid,
        ),
    )
    defter_aciklama = (
        f"Sipariş sevkiyat güncellendi — talep={tid} sevkiyat_sube={sevk_sid} durum={yeni_durum}"
        + (f" | Rapor: {(rapor_metni or '')[:380]}" if rapor_metni else "")
    )
    operasyon_defter_ekle(
        cur,
        defter_sube_id,
        "SIPARIS_SEVKIYAT_TAMAM" if yeni_durum == "gonderildi" else "OPS_SIPARIS_SEVKIYAT_GUNCELLE",
        defter_aciklama,
        bildirim_saati=dt_now_tr().strftime("%H:%M:%S"),
    )
    audit(cur, "siparis_talep", tid, "OPS_SIPARIS_SEVKIYAT_GUNCELLE")
    if yeni_durum == "gonderildi":
        try:
            sevk_kalemleri = [
                {
                    "kalem_kodu": str(d.get("urun_id") or d.get("kalem_kodu") or "").strip()
                    or str(d.get("urun_ad") or "").strip(),
                    "kalem_adi": str(d.get("urun_ad") or d.get("urun_id") or "").strip(),
                    "sevk_adet": d.get("gonderilen_adet") or 0,
                }
                for d in durumlar
                if d.get("durum") in ("var", "kismi") and (d.get("gonderilen_adet") or 0) > 0
            ]
            if sevk_kalemleri:
                _disiplin_sevk_cikti(
                    cur,
                    tid,
                    sevk_kalemleri,
                    None,
                    personel_ad,
                )
        except Exception:
            pass
    return {
        "success": True,
        "talep_id": tid,
        "sevkiyat_durumu": yeni_durum,
        "sevkiyat_durum": eski_durum_karsilik,
        "depo_sevkiyat_rapor_metni": rapor_metni,
        "depo_sevkiyat_rapor_uyari": rapor_uyari,
    }
