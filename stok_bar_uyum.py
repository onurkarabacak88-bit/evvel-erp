# -*- coding: utf-8 -*-
"""Depo stok bar uyumsuzlukları — kasa uyumsuzluk API deseni."""
from __future__ import annotations

import hashlib
import json
from datetime import date, timedelta
from typing import Any, Dict, List, Optional, Tuple

from operasyon_stok_motor import (
    STOK_LABEL_TR,
    _stok_key_from_urun_ad,
    depo_kalem_gorunen_ad,
    stok_from_event_meta,
)
from operasyon_defter import operasyon_defter_ekle

_BAR_KEYS = [
    "bardak_kucuk", "bardak_buyuk", "bardak_plastik", "karton_bardak",
    "su_adet", "sut_litre", "redbull_adet", "soda_adet", "cookie_adet", "pasta_adet",
    "surup_adet", "kahve_paket", "kapak_adet", "pecete_paket", "diger_sarf",
    "pasta_porsiyon_sade", "pasta_porsiyon_antep", "pasta_porsiyon_cik",
    "pasta_mag_cilek", "pasta_mag_lotus", "pasta_buyuk_tart", "pasta_kucuk_tart",
    "pasta_snickers", "pasta_malaga", "pasta_latte", "pasta_muzlu_rulo", "pasta_cik_rulo",
    "pasta_meyveli_rulo", "pasta_browni", "pasta_dilim_ss_sade", "pasta_cream_puff",
    "pasta_kavala", "pasta_cup_limon", "pasta_cup_yerfistik", "pasta_cup_cilek",
    "pasta_cup_karamel", "pasta_cup_lotus", "pasta_cup_antep", "pasta_cup_hindistan",
    "pasta_profiterol", "pasta_kare_cik", "pasta_kare_yerfistik", "pasta_kare_karamel",
    "pasta_kare_limon", "pasta_dilim_sade", "pasta_dilim_antep", "pasta_dilim_cik",
    "pasta_dilim_yaban",
]

# Gün sonu denetimi: açılış + ürün aç − kapanış < 0 → ürün aç kaydı eksik (depo hatası)
GUN_ICI_DENETIM_KEYS = frozenset({
    "bardak_kucuk", "bardak_buyuk", "bardak_plastik",
    "su_adet", "sut_litre", "redbull_adet", "soda_adet", "pasta_adet",
    *[k for k in _BAR_KEYS if k.startswith("pasta_")],
})

STOK_UYUM_TIPS = ("STOK_BAR_DEVIR_FARK", "STOK_BAR_GUN_ICI_FARK", "URUN_AC_UYUMSUZLUK")


def _bar_stok_from_meta(meta_raw: Any, alan: str) -> Dict[str, int]:
    base = stok_from_event_meta(meta_raw, alan)
    return {k: max(0, int(base.get(k) or 0)) for k in _BAR_KEYS}


def _bar_prev_calendar_iso(tarih_str: str) -> str:
    d = date.fromisoformat(str(tarih_str)[:10])
    return (d - timedelta(days=1)).isoformat()


def _event_meta_dict(meta_raw: Any) -> Dict[str, Any]:
    if meta_raw is None or meta_raw == "":
        return {}
    if isinstance(meta_raw, dict):
        return meta_raw
    if isinstance(meta_raw, str):
        try:
            parsed = json.loads(meta_raw)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _stok_uyum_id(tip: str, sube_id: str, tarih: str, kalem: str = "") -> str:
    raw = f"{tip}|{sube_id}|{tarih}|{kalem}"
    h = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:28]
    return f"stok-{h}"


def _urun_ac_delta_parse(aciklama: str) -> Dict[str, int]:
    """URUN_AC defter satırı — delta + kalemler (operasyon_merkez_api ile aynı mantık)."""
    if not aciklama:
        return {}
    raw = aciklama
    if raw.startswith("URUN_AC_JSON:"):
        raw = raw[len("URUN_AC_JSON:"):]
    if " | " in raw:
        raw = raw.split(" | ", 1)[0].strip()
    try:
        obj = json.loads(raw)
    except Exception:
        return {}
    if not isinstance(obj, dict):
        return {}
    delta = obj.get("delta") or {}
    if not isinstance(delta, dict):
        delta = {}
    kalemler = obj.get("kalemler") or []
    if not isinstance(kalemler, list):
        kalemler = []
    s_map: Dict[str, int] = {k: 0 for k in _BAR_KEYS}
    for item in kalemler:
        if not isinstance(item, dict):
            continue
        urun_ad = str(item.get("urun_ad") or item.get("kalem_adi") or item.get("kalem_kodu") or "").strip()
        try:
            adet = max(0, int(item.get("adet") or 0))
        except (TypeError, ValueError):
            adet = 0
        if not urun_ad or adet <= 0:
            continue
        stok_key = _stok_key_from_urun_ad(urun_ad)
        if stok_key and stok_key in _BAR_KEYS:
            s_map[stok_key] += adet
    result: Dict[str, int] = {}
    for k in _BAR_KEYS:
        try:
            dv = max(0, int(delta.get(k) or 0))
        except (TypeError, ValueError):
            dv = 0
        merged = max(dv, int(s_map.get(k) or 0))
        if merged > 0:
            result[k] = merged
    return result


def _urun_sevk_delta_parse(aciklama: str) -> Dict[str, int]:
    """URUN_SEVK defter satırı (gelen kabul) → bar anahtarları. URUN_AC ile aynı JSON formatı."""
    if aciklama and aciklama.startswith("URUN_SEVK_JSON:"):
        return _urun_ac_delta_parse("URUN_AC_JSON:" + aciklama[len("URUN_SEVK_JSON:"):])
    return {}


def gelen_sevk_bar_map(cur: Any, sube_id: str, tarihler) -> Dict[str, int]:
    """Verilen tarih(ler)de şubeye GELEN kabul (URUN_SEVK: tedarikçi + şubeler-arası depo
    teslim) kalemlerini bar anahtarlarına toplar. Devir karşılaştırmasında
    'beklenen açılış = dün kapanış + gelen sevk' için kullanılır → transferler 'karşılıksız' sayılmaz."""
    tlist = [str(t)[:10] for t in (tarihler or []) if t]
    if not tlist:
        return {}
    cur.execute(
        "SELECT aciklama FROM operasyon_defter "
        "WHERE sube_id=%s AND etiket='URUN_SEVK' AND tarih = ANY(%s::date[])",
        (sube_id, tlist),
    )
    toplam: Dict[str, int] = {k: 0 for k in _BAR_KEYS}
    for r in cur.fetchall():
        m = _urun_sevk_delta_parse(str(dict(r).get("aciklama") or ""))
        for k in _BAR_KEYS:
            toplam[k] += int(m.get(k) or 0)
    return {k: v for k, v in toplam.items() if v > 0}


def fetch_bar_satirlar_gun(
    cur: Any,
    hedef_tarih: date,
    sube_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Tek gün bar özeti (kapanis_fallback=False — gerçek kapanış)."""
    gun_v = str(hedef_tarih)
    acilis_params: list = [gun_v]
    acilis_sube_filter = ""
    if sube_id:
        acilis_sube_filter = "AND e.sube_id = %s"
        acilis_params.append(sube_id)
    acilis_params.append(120)

    cur.execute(
        f"""
        SELECT DISTINCT ON (e.sube_id, e.tarih)
               e.sube_id, s.ad AS sube_adi, e.tarih,
               e.cevap_ts AS acilis_ts, e.meta AS acilis_meta,
               e.personel_ad AS acilis_personel_ad
        FROM sube_operasyon_event e
        JOIN subeler s ON s.id = e.sube_id
        WHERE e.tip='ACILIS' AND e.durum='tamamlandi'
          AND e.tarih = %s::date
          {acilis_sube_filter}
        ORDER BY e.sube_id, e.tarih, e.cevap_ts ASC NULLS LAST, e.id ASC
        LIMIT %s
        """,
        acilis_params,
    )
    acilis_rows = {(str(r["sube_id"]), str(r["tarih"])): dict(r) for r in cur.fetchall()}
    if not acilis_rows:
        return []

    kap_params: list = [gun_v]
    kap_sube_filter = ""
    if sube_id:
        kap_sube_filter = "AND e.sube_id = %s"
        kap_params.append(sube_id)
    cur.execute(
        f"""
        SELECT DISTINCT ON (e.sube_id, e.tarih)
               e.sube_id, e.tarih, e.meta AS kapanis_meta,
               e.personel_ad AS kapanis_personel_ad
        FROM sube_operasyon_event e
        WHERE e.tip='KAPANIS' AND e.durum='tamamlandi'
          AND e.tarih = %s::date
          {kap_sube_filter}
        ORDER BY e.sube_id, e.tarih, e.cevap_ts DESC NULLS LAST, e.id DESC
        """,
        kap_params,
    )
    kapanis_map: Dict[tuple, Dict[str, int]] = {}
    kapanis_personel: Dict[tuple, str] = {}
    for r in cur.fetchall():
        key = (str(r["sube_id"]), str(r["tarih"]))
        kapanis_map[key] = _bar_stok_from_meta(r["kapanis_meta"], "kapanis_stok_sayim")
        kapanis_personel[key] = str(r.get("kapanis_personel_ad") or "").strip()

    urun_params: list = [gun_v]
    urun_sube_filter = ""
    if sube_id:
        urun_sube_filter = "AND sube_id = %s"
        urun_params.append(sube_id)
    cur.execute(
        f"""
        SELECT sube_id, tarih::text AS tarih, aciklama
        FROM operasyon_defter
        WHERE etiket='URUN_AC'
          AND tarih = %s::date
          {urun_sube_filter}
        """,
        urun_params,
    )
    urun_ac_map: Dict[tuple, Dict[str, int]] = {}
    for r in cur.fetchall():
        key = (str(r["sube_id"]), str(r["tarih"]))
        delta = _urun_ac_delta_parse(r["aciklama"] or "")
        existing = urun_ac_map.setdefault(key, {k: 0 for k in _BAR_KEYS})
        for k, v in delta.items():
            existing[k] = existing.get(k, 0) + v

    prev_pairs = [(sid, _bar_prev_calendar_iso(ts)) for sid, ts in acilis_rows.keys()]
    kapanis_dun_map: Dict[Tuple[str, str], Dict[str, int]] = {}
    if prev_pairs:
        sid_list = [p[0] for p in prev_pairs]
        tarih_list = [date.fromisoformat(p[1]) for p in prev_pairs]
        cur.execute(
            """
            SELECT DISTINCT ON (e.sube_id, e.tarih)
                   e.sube_id, e.tarih::text, e.meta AS kapanis_meta
            FROM sube_operasyon_event e
            INNER JOIN (
                SELECT * FROM unnest(%s::text[], %s::date[]) AS j(sube_id, tarih)
            ) q ON e.sube_id = q.sube_id AND e.tarih = q.tarih
            WHERE e.tip = 'KAPANIS' AND e.durum = 'tamamlandi'
            ORDER BY e.sube_id, e.tarih, e.cevap_ts DESC NULLS LAST, e.id DESC
            """,
            (sid_list, tarih_list),
        )
        for r in cur.fetchall() or []:
            kk = (str(r["sube_id"]), str(r["tarih"]))
            kapanis_dun_map[kk] = _bar_stok_from_meta(r.get("kapanis_meta"), "kapanis_stok_sayim")

    satirlar: List[Dict[str, Any]] = []
    for (sid, tarih_str), ac_row in acilis_rows.items():
        key = (sid, tarih_str)
        acilis = _bar_stok_from_meta(ac_row.get("acilis_meta"), "acilis_stok_sayim")
        kapanis = kapanis_map.get(key, {})
        urun_ac = urun_ac_map.get(key, {k: 0 for k in _BAR_KEYS})
        satilan: Dict[str, int] = {}
        for k in _BAR_KEYS:
            satilan[k] = int(acilis.get(k, 0)) + int(urun_ac.get(k, 0)) - int(kapanis.get(k, 0))

        prev_key = (sid, _bar_prev_calendar_iso(tarih_str))
        dun_blk = kapanis_dun_map.get(prev_key)
        onceki_kapanis_yok = dun_blk is None
        devir_uyumsuz_kalemleri: List[str] = []
        devir_farklari: Dict[str, Dict[str, int]] = {}
        if dun_blk is not None:
            for k2 in _BAR_KEYS:
                vd = int(dun_blk.get(k2, 0) or 0)
                va = int(acilis.get(k2, 0) or 0)
                if vd != va:
                    devir_uyumsuz_kalemleri.append(k2)
                    devir_farklari[k2] = {"dun_kapanis": vd, "bugun_acilis": va, "fark": va - vd}
        elif onceki_kapanis_yok:
            for k2 in _BAR_KEYS:
                if int(acilis.get(k2, 0) or 0) > 0:
                    devir_uyumsuz_kalemleri.append(k2)

        satirlar.append({
            "sube_id": sid,
            "sube_adi": ac_row.get("sube_adi") or sid,
            "tarih": tarih_str,
            "acilis_personel_ad": str(ac_row.get("acilis_personel_ad") or "").strip() or None,
            "kapanis_personel_ad": kapanis_personel.get(key),
            "kapanis_var": bool(kapanis),
            "acilis": acilis,
            "urun_ac": urun_ac,
            "kapanis": kapanis,
            "satilan": satilan,
            "onceki_kapanis_yok": onceki_kapanis_yok,
            "onceki_kapanis_tarihi": _bar_prev_calendar_iso(tarih_str),
            "dun_kapanis": dun_blk,
            "devir_uyumsuz_kalemleri": devir_uyumsuz_kalemleri,
            "devir_farklari": devir_farklari,
        })
    return satirlar


def _uyari_upsert(
    cur: Any,
    uid: str,
    sube_id: str,
    tarih: date,
    tip: str,
    seviye: str,
    beklenen: float,
    gercek: float,
    fark: float,
    mesaj: str,
    kalem_kodu: str,
    detay_json: Dict[str, Any],
) -> None:
    dj = json.dumps(detay_json, ensure_ascii=False)
    cur.execute(
        """
        INSERT INTO sube_operasyon_uyari
            (id, sube_id, tarih, tip, seviye, beklenen_tl, gercek_tl, fark_tl, mesaj,
             kalem_kodu, detay_json)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
        ON CONFLICT (id) DO UPDATE SET
            seviye = EXCLUDED.seviye,
            beklenen_tl = EXCLUDED.beklenen_tl,
            gercek_tl = EXCLUDED.gercek_tl,
            fark_tl = EXCLUDED.fark_tl,
            mesaj = EXCLUDED.mesaj,
            kalem_kodu = EXCLUDED.kalem_kodu,
            detay_json = EXCLUDED.detay_json,
            okundu = CASE
                WHEN ABS(COALESCE(sube_operasyon_uyari.cozum_duzeltilen_tl, sube_operasyon_uyari.fark_tl, 0)) > 0.01
                     AND ABS(COALESCE(EXCLUDED.fark_tl, 0)) <= 0.01
                THEN TRUE
                ELSE sube_operasyon_uyari.okundu
            END
        """,
        (uid, sube_id, tarih, tip, seviye, beklenen, gercek, fark, mesaj, kalem_kodu, dj),
    )


def _seviye_adet(abs_fark: int) -> str:
    if abs_fark >= 20:
        return "kritik"
    if abs_fark >= 5:
        return "uyari"
    return "normal"


def build_stok_uyum_liste(
    cur: Any,
    hedef_tarih: date,
    sadece_bekleyen: bool,
    sadece_cozuldu: bool,
) -> Dict[str, Any]:
    bar_rows = fetch_bar_satirlar_gun(cur, hedef_tarih)
    gun_str = str(hedef_tarih)
    aktif_ids: List[str] = []

    for row in bar_rows:
        sid = str(row["sube_id"])
        sube_adi = str(row.get("sube_adi") or sid)
        ac = row.get("acilis") or {}
        ua = row.get("urun_ac") or {}
        kap = row.get("kapanis") or {}
        sat = row.get("satilan") or {}

        for k in row.get("devir_uyumsuz_kalemleri") or []:
            df = (row.get("devir_farklari") or {}).get(k) or {}
            vd = int(df.get("dun_kapanis") or 0)
            va = int(df.get("bugun_acilis") or ac.get(k, 0) or 0)
            fark = int(df.get("fark") or (va - vd))
            if row.get("onceki_kapanis_yok") and not df:
                va = int(ac.get(k, 0) or 0)
                fark = va
                vd = 0
            uid = _stok_uyum_id("STOK_BAR_DEVIR_FARK", sid, gun_str, k)
            aktif_ids.append(uid)
            lab = STOK_LABEL_TR.get(k, k)
            mesaj = (
                f"Devir uyumsuzluğu — {lab}: dün kapanış {vd}, bugün açılış {va} (Δ {fark:+d})"
            )
            detay = {
                "kalem_kodu": k,
                "kalem_adi": lab,
                "dun_kapanis": vd,
                "bugun_acilis": va,
                "onceki_kapanis_yok": bool(row.get("onceki_kapanis_yok")),
                "onceki_kapanis_tarihi": row.get("onceki_kapanis_tarihi"),
            }
            _uyari_upsert(
                cur, uid, sid, hedef_tarih, "STOK_BAR_DEVIR_FARK",
                _seviye_adet(abs(fark)), float(vd), float(va), float(fark), mesaj, k, detay,
            )

        for k, fark_val in (sat or {}).items():
            if k not in GUN_ICI_DENETIM_KEYS:
                continue
            fark = int(fark_val or 0)
            if fark >= 0:
                continue
            uid = _stok_uyum_id("STOK_BAR_GUN_ICI_FARK", sid, gun_str, k)
            aktif_ids.append(uid)
            lab = STOK_LABEL_TR.get(k, k)
            ac_v = int(ac.get(k, 0) or 0)
            ua_v = int(ua.get(k, 0) or 0)
            kap_v = int(kap.get(k, 0) or 0)
            eksik_ua = abs(fark)
            mesaj = (
                f"Ürün aç kaydı eksik (depo stok hatası) — {lab}: "
                f"açılış {ac_v} + ürün aç {ua_v} − kapanış {kap_v} = {fark} ad · "
                f"≈{eksik_ua} ad Ürün Aç paneline girilmemiş"
            )
            detay = {
                "kalem_kodu": k,
                "kalem_adi": lab,
                "acilis": ac_v,
                "urun_ac": ua_v,
                "kapanis": kap_v,
                "kullanilan": fark,
                "eksik_urun_ac": eksik_ua,
                "hata_turu": "urun_ac_eksik",
            }
            _uyari_upsert(
                cur, uid, sid, hedef_tarih, "STOK_BAR_GUN_ICI_FARK",
                _seviye_adet(abs(fark)), float(ac_v + ua_v), float(kap_v), float(fark), mesaj, k, detay,
            )

    cur.execute(
        """
        SELECT u.id, u.tip, u.sube_id::text, COALESCE(s.ad, u.sube_id::text) AS sube_adi,
               u.tarih, u.seviye, u.fark_tl, u.beklenen_tl, u.gercek_tl,
               u.mesaj, u.okundu, u.olusturma, u.kalem_kodu, u.detay_json, u.detay,
               u.cozum_duzeltilen_tl, u.cozum_notu, u.cozum_ts,
               u.acilis_personel_ad, u.kapanis_personel_ad
        FROM sube_operasyon_uyari u
        LEFT JOIN subeler s ON s.id = u.sube_id
        WHERE u.tarih = %s
          AND u.tip IN ('STOK_BAR_DEVIR_FARK', 'STOK_BAR_GUN_ICI_FARK', 'URUN_AC_UYUMSUZLUK')
        ORDER BY u.okundu ASC, ABS(COALESCE(u.cozum_duzeltilen_tl, u.fark_tl, 0)) DESC, u.olusturma DESC
        """,
        (hedef_tarih,),
    )
    tum_satirlar: List[Dict[str, Any]] = []
    for r in cur.fetchall() or []:
        d = dict(r)
        tip = str(d.get("tip") or "")
        uid = str(d.get("id") or "")
        cozuldu_flag = bool(d.get("okundu"))
        # Aktif bar uyumsuzluğu yoksa kayıt silinmesin: çözülmüş (okundu) arşiv olarak kalsın.
        if tip.startswith("STOK_BAR_") and uid not in aktif_ids and not cozuldu_flag:
            continue
        d["cozuldu"] = cozuldu_flag
        for k in ("fark_tl", "beklenen_tl", "gercek_tl", "cozum_duzeltilen_tl"):
            if d.get(k) is not None:
                d[k] = float(d[k])
        d["detay_json"] = _uyari_detay_dict(d)
        if tip == "URUN_AC_UYUMSUZLUK" and not d.get("fark_tl"):
            d["fark_tl"] = float(_urun_ac_eksik_adet(d))
        if d.get("tarih"):
            d["tarih"] = str(d["tarih"])
        if d.get("olusturma"):
            d["olusturma"] = str(d["olusturma"])
        efektif = d.get("cozum_duzeltilen_tl")
        if efektif is None:
            efektif = d.get("fark_tl")
        d["efektif_fark_tl"] = efektif
        det = d.get("detay_json") or {}
        fb_ad = str(det.get("kalem_adi") or det.get("urun_ad") or "").strip()
        d["kalem_adi"] = depo_kalem_gorunen_ad(
            cur,
            str(d.get("sube_id") or ""),
            str(d.get("kalem_kodu") or ""),
            fb_ad,
        )
        tum_satirlar.append(d)

    gun_toplam = len(tum_satirlar)
    gun_bekleyen = sum(1 for x in tum_satirlar if not x["cozuldu"])
    gun_cozuldu = sum(1 for x in tum_satirlar if x["cozuldu"])

    rows = tum_satirlar
    if sadece_bekleyen:
        rows = [x for x in tum_satirlar if not x["cozuldu"]]
    elif sadece_cozuldu:
        rows = [x for x in tum_satirlar if x["cozuldu"]]

    return {
        "tarih": gun_str,
        "liste": rows,
        "toplam": len(rows),
        "gun_toplam": gun_toplam,
        "gun_bekleyen": gun_bekleyen,
        "gun_cozuldu": gun_cozuldu,
    }


def _uyari_detay_dict(u: Dict[str, Any]) -> Dict[str, Any]:
    raw = u.get("detay_json") if u.get("detay_json") is not None else u.get("detay")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = {}
    return raw if isinstance(raw, dict) else {}


def _urun_ac_eksik_adet(u: Dict[str, Any]) -> int:
    detay = _uyari_detay_dict(u)
    eksik = int(detay.get("eksik_miktar") or 0)
    if eksik > 0:
        return eksik
    try:
        f = int(abs(float(u.get("fark_tl") or 0)))
        return f if f > 0 else 0
    except (TypeError, ValueError):
        return 0


def stok_uyum_depo_girisi(
    cur: Any,
    uyari_id: str,
    adet: int,
    notu: Optional[str],
    personel_ad: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Karşılıksız ürün aç uyarısını depo girişi ile kapatır.
    Fiziksel stok artar, borç mahsup edilir, deftere URUN_STOK_EKLE yazılır.
    """
    from operasyon_stok_motor import sube_depo_stok_depo_giris_ekle
    from operasyon_defter import operasyon_defter_ekle
    from tr_saat import is_gunu_tr

    cur.execute(
        """
        SELECT id, sube_id::text, tarih::text, tip, kalem_kodu, detay, detay_json, fark_tl, okundu
        FROM sube_operasyon_uyari
        WHERE id=%s AND tip='URUN_AC_UYUMSUZLUK'
        FOR UPDATE
        """,
        (uyari_id,),
    )
    row = cur.fetchone()
    if not row:
        raise ValueError("Karşılıksız ürün aç kaydı bulunamadı")
    u = dict(row)
    if u.get("okundu"):
        return {"uyari_id": uyari_id, "durum": "zaten_cozulmus", "otomatik_cozuldu": True}

    sube_id = str(u["sube_id"])
    kalem = str(u.get("kalem_kodu") or "").strip()
    if not kalem:
        raise ValueError("Uyarıda kalem_kodu yok")
    eksik = _urun_ac_eksik_adet(u)
    if eksik <= 0:
        raise ValueError("Eksik miktar tespit edilemedi")

    giris = max(1, int(adet or eksik))
    mahsup = min(giris, eksik)
    lab = STOK_LABEL_TR.get(kalem, kalem)

    uyari_gun = date.fromisoformat(str(u["tarih"])[:10])
    bugun = is_gunu_tr()

    sube_depo_stok_depo_giris_ekle(cur, sube_id, kalem, lab, giris)

    delta = {k: 0 for k in _BAR_KEYS}
    if kalem in _BAR_KEYS:
        delta[kalem] = giris
    payload = json.dumps({"delta": delta}, ensure_ascii=False, separators=(",", ":"))
    acik = f"URUN_STOK_JSON:{payload} | Merkez depo girişi — karşılıksız ürün aç kapatma ({uyari_id[:8]}…)"
    if notu:
        acik += f" | {notu[:200]}"
    operasyon_defter_ekle(
        cur,
        sube_id,
        "URUN_STOK_EKLE",
        acik,
        personel_ad=(personel_ad or "Operasyon Merkezi").strip() or "Operasyon Merkezi",
    )

    # Geçmiş gün uyarısı: otomatik mahsup yalnızca bugünkü girişlerde çalışır
    if uyari_gun != bugun and mahsup > 0:
        cur.execute(
            """
            UPDATE sube_depo_stok
            SET mevcut_adet = GREATEST(0, COALESCE(mevcut_adet, 0) - %s),
                guncelleme = NOW()
            WHERE sube_id = %s AND kalem_kodu = %s
            """,
            (mahsup, sube_id, kalem),
        )

    kalan = eksik - mahsup
    if uyari_gun == bugun:
        cur.execute("SELECT okundu FROM sube_operasyon_uyari WHERE id=%s", (uyari_id,))
        chk = cur.fetchone()
        if chk and chk.get("okundu"):
            kalan = 0
    cozum_not = notu or f"Depo girişi: +{giris} adet, borç mahsup {mahsup}"
    if kalan <= 0:
        cur.execute(
            """
            UPDATE sube_operasyon_uyari
            SET okundu=TRUE, cozum_duzeltilen_tl=0, cozum_notu=%s, cozum_ts=NOW()
            WHERE id=%s
            """,
            (cozum_not, uyari_id),
        )
        otomatik = True
    else:
        detay = _uyari_detay_dict(u)
        detay["eksik_miktar"] = kalan
        cur.execute(
            """
            UPDATE sube_operasyon_uyari
            SET detay=%s::jsonb, mesaj=%s, cozum_notu=%s
            WHERE id=%s
            """,
            (
                json.dumps(detay, ensure_ascii=False),
                f"Karşılıksız açma: {lab} — kalan borç {kalan} adet",
                f"Kısmi depo girişi (+{giris}, mahsup {mahsup})",
                uyari_id,
            ),
        )
        otomatik = False

    operasyon_defter_ekle(
        cur,
        sube_id,
        "STOK_UYUM_DEPO_GIRISI",
        f"uyari={uyari_id} kalem={kalem} giris={giris} mahsup={mahsup} kalan={kalan}",
        None,
    )
    return {
        "uyari_id": uyari_id,
        "kalem_kodu": kalem,
        "kalem_adi": lab,
        "giris_adet": giris,
        "mahsup_adet": mahsup,
        "kalan_borc": kalan,
        "eski_eksik": eksik,
        "otomatik_cozuldu": otomatik,
    }


def _event_guncelle_stok_kalem(
    cur: Any,
    sube_id: str,
    tarih: str,
    event_tip: str,
    block_key: str,
    kalem: str,
    yeni_adet: int,
) -> Optional[str]:
    cur.execute(
        """
        SELECT id, meta FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=%s::date AND tip=%s AND durum='tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST, id DESC
        LIMIT 1
        FOR UPDATE
        """,
        (sube_id, tarih, event_tip),
    )
    row = cur.fetchone()
    if not row:
        return None
    ev_id = str(row["id"])
    meta = _event_meta_dict(row.get("meta"))
    block = meta.get(block_key) if isinstance(meta.get(block_key), dict) else {}
    if not isinstance(block, dict):
        block = stok_from_event_meta(meta, block_key)
    block = dict(block)
    block[kalem] = max(0, int(yeni_adet))
    meta[block_key] = block
    cur.execute(
        "UPDATE sube_operasyon_event SET meta=%s::jsonb WHERE id=%s",
        (json.dumps(meta, ensure_ascii=False), ev_id),
    )
    return ev_id


def stok_uyum_kaynak_duzelt(
    cur: Any,
    uyari_id: str,
    sebep: str,
    payload: Dict[str, Any],
    notu: Optional[str],
) -> Dict[str, Any]:
    cur.execute(
        """
        SELECT id, sube_id::text, tarih::text, tip, fark_tl, kalem_kodu, detay_json, okundu
        FROM sube_operasyon_uyari
        WHERE id=%s AND tip IN ('STOK_BAR_DEVIR_FARK', 'STOK_BAR_GUN_ICI_FARK', 'URUN_AC_UYUMSUZLUK')
        FOR UPDATE
        """,
        (uyari_id,),
    )
    row = cur.fetchone()
    if not row:
        raise ValueError("Ürün uyumsuzluk kaydı bulunamadı")
    u = dict(row)
    if str(u.get("tip")) == "URUN_AC_UYUMSUZLUK":
        if sebep == "depo_girisi":
            adet = payload.get("giris_adet") or payload.get("yeni_adet")
            try:
                adet_i = int(adet) if adet is not None else 0
            except (TypeError, ValueError):
                adet_i = 0
            return stok_uyum_depo_girisi(
                cur, uyari_id, adet_i, notu, personel_ad=(payload.get("personel_ad") or None),
            )
        if sebep == "gercek_uyumsuzluk":
            cur.execute(
                """
                UPDATE sube_operasyon_uyari
                SET okundu=TRUE, cozum_notu=COALESCE(cozum_notu, %s), cozum_ts=COALESCE(cozum_ts, NOW())
                WHERE id=%s
                """,
                (notu or "Gerçek karşılıksız açma — kaynak değişmedi", uyari_id),
            )
            eksik = _urun_ac_eksik_adet(u)
            return {
                "uyari_id": uyari_id,
                "eski_fark": float(eksik),
                "yeni_fark": float(eksik),
                "otomatik_cozuldu": True,
                "tip": "URUN_AC_UYUMSUZLUK",
            }
        raise ValueError("Karşılıksız ürün aç için «Depo girişi» veya «Gerçek uyumsuzluk» seçin")
    if sebep == "gercek_uyumsuzluk":
        cur.execute(
            """
            UPDATE sube_operasyon_uyari
            SET okundu=TRUE, cozum_notu=COALESCE(cozum_notu, %s), cozum_ts=COALESCE(cozum_ts, NOW())
            WHERE id=%s
            """,
            (notu or "Gerçek uyumsuzluk — kaynak düzeltilmedi", uyari_id),
        )
        return {"uyari_id": uyari_id, "eski_fark": float(u.get("fark_tl") or 0), "yeni_fark": float(u.get("fark_tl") or 0), "otomatik_cozuldu": True}
    if sebep == "urun_ac_eksik":
        cur.execute(
            """
            UPDATE sube_operasyon_uyari
            SET okundu=TRUE, cozum_notu=COALESCE(cozum_notu, %s), cozum_ts=COALESCE(cozum_ts, NOW())
            WHERE id=%s
            """,
            (
                notu or "Ürün Aç panelinde eksik kayıt tamamlanacak — depo stok hatası",
                uyari_id,
            ),
        )
        return {"uyari_id": uyari_id, "eski_fark": float(u.get("fark_tl") or 0), "yeni_fark": float(u.get("fark_tl") or 0), "otomatik_cozuldu": True}

    sube_id = str(u["sube_id"])
    tarih = str(u["tarih"])[:10]
    kalem = str(u.get("kalem_kodu") or payload.get("kalem_kodu") or "").strip()
    if not kalem:
        raise ValueError("Kalem kodu gerekli")
    tip = str(u.get("tip"))

    if sebep == "acilis_yanlis":
        adet = payload.get("yeni_acilis_adet")
        if adet is None:
            raise ValueError("yeni_acilis_adet zorunlu")
        _event_guncelle_stok_kalem(cur, sube_id, tarih, "ACILIS", "acilis_stok_sayim", kalem, int(adet))
    elif sebep == "kapanis_yanlis":
        adet = payload.get("yeni_kapanis_adet")
        if adet is None:
            raise ValueError("yeni_kapanis_adet zorunlu")
        _event_guncelle_stok_kalem(cur, sube_id, tarih, "KAPANIS", "kapanis_stok_sayim", kalem, int(adet))
    elif sebep == "devir_yanlis":
        adet = payload.get("yeni_dun_kapanis_adet")
        if adet is None:
            raise ValueError("yeni_dun_kapanis_adet zorunlu")
        prev = _bar_prev_calendar_iso(tarih)
        _event_guncelle_stok_kalem(cur, sube_id, prev, "KAPANIS", "kapanis_stok_sayim", kalem, int(adet))
    elif sebep == "urun_ac_yanlis":
        raise ValueError("Ürün aç düzeltmesi henüz desteklenmiyor — şube panelinden düzeltin")
    else:
        raise ValueError(f"Geçersiz sebep: {sebep}")

    ozet = build_stok_uyum_liste(cur, date.fromisoformat(tarih), False, False)
    yeni = next((x for x in ozet["liste"] if x["id"] == uyari_id), None)
    yeni_fark = float((yeni or {}).get("fark_tl") or 0)
    eski_fark = float(u.get("fark_tl") or 0)
    otomatik = abs(yeni_fark) <= 0.01
    if otomatik:
        cur.execute(
            """
            UPDATE sube_operasyon_uyari
            SET okundu=TRUE, cozum_duzeltilen_tl=0, cozum_notu=%s, cozum_ts=NOW()
            WHERE id=%s
            """,
            (notu or f"Kaynak düzeltildi ({sebep})", uyari_id),
        )
    else:
        cur.execute(
            "UPDATE sube_operasyon_uyari SET cozum_notu=%s WHERE id=%s",
            (notu or f"Kısmi düzeltme ({sebep})", uyari_id),
        )
    operasyon_defter_ekle(
        cur, sube_id, "STOK_UYUM_KAYNAK_DUZELTME",
        f"uyari={uyari_id} sebep={sebep} eski={eski_fark} yeni={yeni_fark} kalem={kalem}",
        None,
    )
    return {
        "uyari_id": uyari_id,
        "eski_fark": eski_fark,
        "yeni_fark": yeni_fark,
        "otomatik_cozuldu": otomatik,
        "tip": tip,
    }


def stok_uyum_coz(cur: Any, uyari_id: str, notu: Optional[str], duzeltilen: Optional[float]) -> Dict[str, Any]:
    cur.execute(
        """
        SELECT id, sube_id::text, fark_tl, okundu
        FROM sube_operasyon_uyari
        WHERE id=%s AND tip IN ('STOK_BAR_DEVIR_FARK', 'STOK_BAR_GUN_ICI_FARK', 'URUN_AC_UYUMSUZLUK')
        FOR UPDATE
        """,
        (uyari_id,),
    )
    row = cur.fetchone()
    if not row:
        raise ValueError("Kayıt bulunamadı")
    r = dict(row)
    if r.get("okundu"):
        return {"success": True, "durum": "zaten_cozulmus", "id": uyari_id}
    duz = duzeltilen
    if duz is not None:
        duz = round(float(duz), 2)
    cur.execute(
        """
        UPDATE sube_operasyon_uyari
        SET okundu=TRUE, cozum_duzeltilen_tl=%s, cozum_notu=%s, cozum_ts=NOW()
        WHERE id=%s
        """,
        (duz, notu, uyari_id),
    )
    return {"success": True, "durum": "cozuldu", "id": uyari_id, "duzeltilen_fark_tl": duz}
