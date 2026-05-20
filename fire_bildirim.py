"""
Şube fire bildirimi — operasyonel kayıp/zayi girişi ve merkez listesi.
Depo stok düşer; stok hareket defterine FIRE yazılır; operasyon_defter SUBE_FIRE.
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple

from tr_saat import TR_TZ, dt_format_api_tr, dt_now_tr
from operasyon_stok_motor import (
    STOK_KEYS,
    STOK_LABEL_TR,
    depo_kalem_kodu_resolve,
    normalize_delta_body,
    sube_depo_stok_depo_cikis_dus,
    _stok_key_from_urun_ad,
)

FIRE_SEBEP: Dict[str, str] = {
    "iade": "Müşteri iadesi / bozuk ürün",
    "sayim_hatasi": "Sayım hatası",
    "panel_hatasi": "Panel kullanım hatası",
    "skt_bozulma": "SKT / bozulma",
    "hazirlik_deneme": "Hazırlık / deneme / eğitim",
    "kirilma_dokulme": "Kırılma / dökülme",
    "diger": "Diğer",
}

# Müşteri iadesi — şube panelinde zorunlu alanlar
FIRE_IADE_SEBEP = "iade"

# Şube API yanıtında ve defterde ASLA dönmez / yazılmaz (yalnızca merkez + DB)
SUBE_GIZLI_IADE_ALANLARI = frozenset({
    "iade_musteri_ad",
    "iade_musteri_telefon",
})


def parse_iade_zaman_tr(raw: str) -> datetime:
    """Panel datetime-local veya ISO → Europe/Istanbul tz bilgili."""
    s = (raw or "").strip()
    if not s:
        raise ValueError("İade zamanı zorunlu — kasa fişindeki saati girin")
    try:
        if "T" in s:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        else:
            dt = datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError as ex:
        raise ValueError("Geçersiz iade zamanı — tarih ve saat seçin") from ex
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TR_TZ)
    else:
        dt = dt.astimezone(TR_TZ)
    return dt


def _normalize_iade_telefon(raw: str) -> str:
    """TR cep: 10 hane, 5 ile başlar."""
    digits = re.sub(r"\D", "", (raw or ""))
    if digits.startswith("90") and len(digits) == 12:
        digits = digits[2:]
    if digits.startswith("0") and len(digits) == 11:
        digits = digits[1:]
    if len(digits) != 10 or not digits.startswith("5"):
        raise ValueError("Geçerli cep telefonu girin (5XX XXX XX XX)")
    return digits


def _normalize_iade_musteri_ad(raw: str) -> str:
    ad = " ".join((raw or "").strip().split())
    if len(ad) < 2:
        raise ValueError("Müşteri adı zorunlu (en az 2 karakter)")
    if len(ad) > 120:
        raise ValueError("Müşteri adı en fazla 120 karakter olabilir")
    return ad


def _iade_alanlari_dogrula(
    sebep_kodu: str,
    fis_no: Optional[str],
    iade_zaman_raw: Optional[str],
    cikis: List[Tuple[str, str, int]],
    musteri_ad: Optional[str] = None,
    musteri_telefon: Optional[str] = None,
) -> Tuple[Optional[str], Optional[datetime], Optional[str], Optional[str]]:
    """İade: fiş, zaman, ürün, müşteri adı ve telefon zorunlu."""
    if (sebep_kodu or "").strip().lower() != FIRE_IADE_SEBEP:
        return None, None, None, None
    fn = (fis_no or "").strip()
    if len(fn) < 1:
        raise ValueError("İade için fiş numarası zorunlu")
    if len(fn) > 64:
        raise ValueError("Fiş numarası en fazla 64 karakter olabilir")
    if not cikis:
        raise ValueError("İade için en az bir ürün kalemi seçin")
    iade_dt = parse_iade_zaman_tr(iade_zaman_raw or "")
    mad = _normalize_iade_musteri_ad(musteri_ad or "")
    mtel = _normalize_iade_telefon(musteri_telefon or "")
    return fn, iade_dt, mad, mtel


def fire_bildirim_sube_yanit(kayit: Dict[str, Any]) -> Dict[str, Any]:
    """Şube paneline dönen yanıt — müşteri adı/telefon ASLA dönmez."""
    safe = {k: v for k, v in (kayit or {}).items() if k not in SUBE_GIZLI_IADE_ALANLARI}
    return {
        "success": True,
        "id": safe.get("id"),
        "toplam_adet": safe.get("toplam_adet"),
        "kalem_sayisi": safe.get("kalem_sayisi"),
        "sebep_kodu": safe.get("sebep_kodu"),
        "mesaj": (
            "Fire bildirimi merkeze iletildi. "
            "Müşteri adı ve telefon yalnızca operasyon merkezinde görünür; "
            "şube panelinde tekrar gösterilmez veya saklanmaz."
        ),
    }


def ensure_fire_bildirim_tablosu(cur: Any) -> None:
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sube_fire_bildirim (
            id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            sube_id         TEXT NOT NULL REFERENCES subeler(id) ON DELETE CASCADE,
            tarih           DATE NOT NULL DEFAULT CURRENT_DATE,
            olusturma       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            personel_id     TEXT,
            personel_ad     TEXT,
            sebep_kodu      TEXT NOT NULL,
            sebep_label     TEXT NOT NULL,
            aciklama        TEXT NOT NULL,
            kalemler        JSONB NOT NULL DEFAULT '[]'::jsonb,
            toplam_adet     INT NOT NULL DEFAULT 0,
            defter_id       TEXT,
                goruldu         BOOLEAN NOT NULL DEFAULT FALSE,
                goruldu_ts      TIMESTAMPTZ,
                fis_no          TEXT,
                iade_zaman      TIMESTAMPTZ,
                iade_musteri_ad TEXT,
                iade_musteri_telefon TEXT
        )
    """)
    for kolon, tip in (
        ("fis_no", "TEXT"),
        ("iade_zaman", "TIMESTAMPTZ"),
        ("iade_musteri_ad", "TEXT"),
        ("iade_musteri_telefon", "TEXT"),
    ):
        cur.execute(
            f"""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'sube_fire_bildirim'
                      AND column_name = '{kolon}'
                ) THEN
                    ALTER TABLE sube_fire_bildirim ADD COLUMN {kolon} {tip};
                END IF;
            END $$;
            """
        )
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_sube_fire_bildirim_sube_tarih
        ON sube_fire_bildirim (sube_id, tarih DESC, olusturma DESC)
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_sube_fire_bildirim_tarih
        ON sube_fire_bildirim (tarih DESC, olusturma DESC)
    """)


def _ensure_stok_hareket_tablosu(cur: Any) -> None:
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sube_depo_stok_hareket (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            zaman           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            sube_id         TEXT NOT NULL,
            kalem_kodu      TEXT NOT NULL,
            kalem_adi       TEXT,
            hareket_turu    TEXT NOT NULL,
            miktar          NUMERIC(12,4) NOT NULL,
            onceki_miktar   NUMERIC(12,4),
            sonraki_miktar  NUMERIC(12,4),
            kaynak_tip      TEXT,
            kaynak_id       TEXT,
            kaynak_belge_no TEXT,
            personel_id     TEXT,
            personel_ad     TEXT,
            aciklama        TEXT,
            onay_durumu     TEXT NOT NULL DEFAULT 'otomatik',
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)


def _stok_onceki_adet(cur: Any, sube_id: str, kalem_kodu: str) -> float:
    cur.execute(
        """
        SELECT COALESCE(mevcut_adet, 0) AS mevcut_adet
        FROM sube_depo_stok
        WHERE sube_id=%s AND kalem_kodu=%s
        """,
        (sube_id, kalem_kodu),
    )
    row = cur.fetchone()
    if not row:
        return 0.0
    return float(dict(row).get("mevcut_adet") or 0)


def _fire_stok_hareket_yaz(
    cur: Any,
    *,
    sube_id: str,
    kalem_kodu: str,
    kalem_adi: str,
    adet: int,
    bildirim_id: str,
    personel_id: str,
    personel_ad: str,
    aciklama: str,
    kaynak_belge_no: Optional[str] = None,
) -> None:
    _ensure_stok_hareket_tablosu(cur)
    onceki = _stok_onceki_adet(cur, sube_id, kalem_kodu)
    sube_depo_stok_depo_cikis_dus(cur, sube_id, kalem_kodu, kalem_adi or None, adet)
    sonraki = _stok_onceki_adet(cur, sube_id, kalem_kodu)
    cur.execute(
        """
        INSERT INTO sube_depo_stok_hareket
            (sube_id, kalem_kodu, kalem_adi, hareket_turu, miktar,
             onceki_miktar, sonraki_miktar,
             kaynak_tip, kaynak_id, kaynak_belge_no,
             personel_id, personel_ad, aciklama, onay_durumu)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """,
        (
            sube_id,
            kalem_kodu,
            (kalem_adi or "").strip() or None,
            "FIRE",
            -round(float(adet), 4),
            round(onceki, 4),
            round(sonraki, 4),
            "SUBE_FIRE",
            bildirim_id,
            (kaynak_belge_no or "").strip() or None,
            personel_id or None,
            personel_ad or None,
            (aciklama or "").strip()[:500] or None,
            "otomatik",
        ),
    )


def _kalemler_to_cikis(
    cur: Any,
    kalemler: List[Dict[str, Any]],
    delta: Dict[str, int],
) -> List[Tuple[str, str, int]]:
    """(kalem_kodu, label, adet) — kalemler + delta; STOK_KEYS çift sayım önlenir."""
    merged: Dict[str, int] = {}
    kaplanan_stok: Dict[str, int] = {k: 0 for k in STOK_KEYS}

    for k in kalemler or []:
        if not isinstance(k, dict):
            continue
        uid = str(k.get("urun_id") or k.get("kalem_kodu") or "").strip()
        uad = str(k.get("urun_ad") or "").strip()
        try:
            adet_k = max(0, int(k.get("adet") or 0))
        except (TypeError, ValueError):
            adet_k = 0
        if adet_k <= 0:
            continue
        if uid and uid in STOK_KEYS:
            kk = uid
        elif uid:
            kk = depo_kalem_kodu_resolve(cur, uid, uad) or ""
        else:
            kk = _stok_key_from_urun_ad(uad) or ""
        if not kk:
            continue
        merged[kk] = merged.get(kk, 0) + adet_k
        if kk in kaplanan_stok:
            kaplanan_stok[kk] += adet_k

    for k in STOK_KEYS:
        ek = max(0, int(delta.get(k) or 0) - int(kaplanan_stok.get(k) or 0))
        if ek > 0:
            merged[k] = merged.get(k, 0) + ek

    out: List[Tuple[str, str, int]] = []
    for kk, ad in merged.items():
        if ad <= 0:
            continue
        lab = (STOK_LABEL_TR.get(kk) or kk).strip()
        out.append((kk, lab, int(ad)))
    return out


def fire_bildirim_kaydet(
    cur: Any,
    sube_id: str,
    *,
    personel_id: str,
    personel_ad: str,
    sebep_kodu: str,
    aciklama: str,
    kalemler: List[Dict[str, Any]],
    body_delta: Optional[Dict[str, Any]] = None,
    not_aciklama: Optional[str] = None,
    tarih: Optional[date] = None,
    fis_no: Optional[str] = None,
    iade_zaman: Optional[str] = None,
    iade_musteri_ad: Optional[str] = None,
    iade_musteri_telefon: Optional[str] = None,
) -> Dict[str, Any]:
    ensure_fire_bildirim_tablosu(cur)
    kod = (sebep_kodu or "").strip().lower()
    if kod not in FIRE_SEBEP:
        raise ValueError(f"Geçersiz fire sebebi: {kod}")
    acik = (aciklama or "").strip()
    if len(acik) < 3:
        raise ValueError("Açıklama en az 3 karakter olmalı")
    if kod == "diger" and len(acik) < 10:
        raise ValueError("Diğer sebebinde açıklama en az 10 karakter olmalı")

    try:
        delta = normalize_delta_body(body_delta or {})
    except ValueError:
        delta = {k: 0 for k in STOK_KEYS}

    cikis = _kalemler_to_cikis(cur, kalemler, delta)
    if not cikis:
        raise ValueError("En az bir kalemde fire adedi girin")

    fis_kayit, iade_dt, musteri_ad_k, musteri_tel_k = _iade_alanlari_dogrula(
        kod, fis_no, iade_zaman, cikis, iade_musteri_ad, iade_musteri_telefon,
    )

    toplam = sum(a for _, _, a in cikis)
    sebep_label = FIRE_SEBEP[kod]
    bid = str(uuid.uuid4())
    hedef_tarih = tarih or date.today()

    json_kalemler = [
        {"kalem_kodu": c, "label": l, "miktar": a}
        for c, l, a in cikis
    ]

    hareket_acik = f"{sebep_label}: {acik}"
    if fis_kayit:
        iz = dt_format_api_tr(iade_dt) if iade_dt else ""
        hareket_acik = f"İADE fiş={fis_kayit} zaman={iz} | {hareket_acik}"
    if (not_aciklama or "").strip():
        hareket_acik += f" | Not: {(not_aciklama or '').strip()[:200]}"

    panel_log = dt_format_api_tr(dt_now_tr())

    for kk, lab, adet in cikis:
        _fire_stok_hareket_yaz(
            cur,
            sube_id=sube_id,
            kalem_kodu=kk,
            kalem_adi=lab,
            adet=adet,
            bildirim_id=bid,
            personel_id=personel_id,
            personel_ad=personel_ad,
            aciklama=hareket_acik,
            kaynak_belge_no=fis_kayit,
        )

    from operasyon_defter import operasyon_defter_ekle

    payload = {
        "sebep_kodu": kod,
        "sebep_label": sebep_label,
        "aciklama": acik,
        "kalemler": json_kalemler,
        "toplam_adet": toplam,
        "panel_kayit_zaman": panel_log,
    }
    if fis_kayit and iade_dt:
        payload["fis_no"] = fis_kayit
        payload["iade_zaman"] = dt_format_api_tr(iade_dt)
    # Müşteri PII yalnızca DB + merkez API; defter JSON'da yok
    defter_acik = (
        f"SUBE_FIRE_JSON:{json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}"
    )
    if (not_aciklama or "").strip():
        defter_acik += " | " + (not_aciklama or "").strip()[:300]

    rid = operasyon_defter_ekle(
        cur,
        sube_id,
        "SUBE_FIRE",
        defter_acik,
        personel_id=personel_id,
        personel_ad=personel_ad,
    )

    cur.execute(
        """
        INSERT INTO sube_fire_bildirim
            (id, sube_id, tarih, personel_id, personel_ad,
             sebep_kodu, sebep_label, aciklama, kalemler, toplam_adet, defter_id,
             fis_no, iade_zaman, iade_musteri_ad, iade_musteri_telefon)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """,
        (
            bid,
            sube_id,
            hedef_tarih,
            personel_id,
            personel_ad,
            kod,
            sebep_label,
            acik,
            json.dumps(json_kalemler, ensure_ascii=False),
            toplam,
            rid,
            fis_kayit,
            iade_dt,
            musteri_ad_k,
            musteri_tel_k,
        ),
    )

    return {
        "id": bid,
        "defter_id": rid,
        "toplam_adet": toplam,
        "kalem_sayisi": len(cikis),
        "sebep_kodu": kod,
        "sebep_label": sebep_label,
        "fis_no": fis_kayit,
        "iade_zaman": dt_format_api_tr(iade_dt) if iade_dt else None,
        "panel_kayit_zaman": panel_log,
        "iade_musteri_ad": musteri_ad_k,
        "iade_musteri_telefon": musteri_tel_k,
    }


def _row_to_dict(row: Any, sube_ad_map: Dict[str, str]) -> Dict[str, Any]:
    d = dict(row)
    sid = str(d.get("sube_id") or "")
    kalemler = d.get("kalemler")
    if isinstance(kalemler, str):
        try:
            kalemler = json.loads(kalemler)
        except Exception:
            kalemler = []
    if not isinstance(kalemler, list):
        kalemler = []
    olusturma = d.get("olusturma")
    iade_z = d.get("iade_zaman")
    return {
        "id": d.get("id"),
        "sube_id": sid,
        "sube_ad": sube_ad_map.get(sid) or sid,
        "tarih": str(d.get("tarih") or "")[:10],
        "olusturma": olusturma.isoformat() if hasattr(olusturma, "isoformat") else str(olusturma or ""),
        "panel_kayit_zaman": dt_format_api_tr(olusturma) if olusturma else "",
        "personel_id": d.get("personel_id"),
        "personel_ad": d.get("personel_ad"),
        "sebep_kodu": d.get("sebep_kodu"),
        "sebep_label": d.get("sebep_label"),
        "aciklama": d.get("aciklama"),
        "kalemler": kalemler,
        "toplam_adet": int(d.get("toplam_adet") or 0),
        "defter_id": d.get("defter_id"),
        "goruldu": bool(d.get("goruldu")),
        "fis_no": (d.get("fis_no") or "").strip() or None,
        "iade_zaman": dt_format_api_tr(iade_z) if iade_z else None,
        "iade_musteri_ad": (d.get("iade_musteri_ad") or "").strip() or None,
        "iade_musteri_telefon": (d.get("iade_musteri_telefon") or "").strip() or None,
    }


def build_fire_bildirim_liste(
    cur: Any,
    hedef_tarih: date,
    *,
    sube_id: Optional[str] = None,
    sebep_kodu: Optional[str] = None,
    gun: int = 45,
) -> Dict[str, Any]:
    ensure_fire_bildirim_tablosu(cur)
    cur.execute("SELECT id, ad FROM subeler")
    sube_ad_map = {str(r["id"]): str(r["ad"] or r["id"]) for r in (cur.fetchall() or [])}

    params: List[Any] = [hedef_tarih]
    where = "f.tarih = %s"
    if sube_id:
        where += " AND f.sube_id = %s"
        params.append(sube_id)
    if sebep_kodu:
        where += " AND f.sebep_kodu = %s"
        params.append((sebep_kodu or "").strip().lower())

    cur.execute(
        f"""
        SELECT f.*
        FROM sube_fire_bildirim f
        WHERE {where}
        ORDER BY f.olusturma DESC
        """,
        tuple(params),
    )
    gun_kayitlar = [_row_to_dict(r, sube_ad_map) for r in (cur.fetchall() or [])]

    gun_aralik = max(1, min(int(gun), 365))
    cur.execute(
        """
        SELECT f.*
        FROM sube_fire_bildirim f
        WHERE f.tarih >= (%s::date - %s::integer)
        ORDER BY f.tarih DESC, f.olusturma DESC
        LIMIT 500
        """,
        (hedef_tarih, gun_aralik),
    )
    tum = [_row_to_dict(r, sube_ad_map) for r in (cur.fetchall() or [])]

    return {
        "tarih": str(hedef_tarih),
        "gun_toplam": len(gun_kayitlar),
        "toplam_adet_gun": sum(k.get("toplam_adet") or 0 for k in gun_kayitlar),
        "kayitlar": gun_kayitlar,
        "son_kayitlar": tum[:120],
        "sebep_secenekleri": [{"kod": k, "label": v} for k, v in FIRE_SEBEP.items()],
    }


def fire_bildirim_goruldu(cur: Any, bildirim_id: str) -> Dict[str, Any]:
    ensure_fire_bildirim_tablosu(cur)
    cur.execute(
        """
        UPDATE sube_fire_bildirim
        SET goruldu = TRUE, goruldu_ts = NOW()
        WHERE id = %s
        RETURNING id, goruldu
        """,
        (bildirim_id,),
    )
    row = cur.fetchone()
    if not row:
        raise ValueError("Fire bildirimi bulunamadı")
    return dict(row)
