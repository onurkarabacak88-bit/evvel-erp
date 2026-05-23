"""
Depo yönlendirmeli sipariş akışı — eski / yarım kalmış kalıntı temizliği.

Katalog, şube tanımları, merkez_stok_kart ve sube_depo_stok.mevcut_adet dokunulmaz.
Yalnızca sipariş-sevkiyat-kabul zinciri ve ilgili rezerveler sıfırlanır.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

ONAY_METNI = "EVET_SIL"


def _int_count(cur: Any, sql: str, params: tuple = ()) -> int:
    cur.execute(sql, params)
    row = cur.fetchone()
    if not row:
        return 0
    d = dict(row) if not isinstance(row, dict) else row
    return int(list(d.values())[0] or 0)


def siparis_depo_akisi_ozet(cur: Any, sube_id: Optional[str] = None) -> Dict[str, Any]:
    """Temizlenecek kayıt sayıları + panelde görünmeyen yolda uyarısı."""
    sid = (sube_id or "").strip() or None
    sube_filt = " AND sube_id=%s" if sid else ""
    sube_filt_t = " AND t.sube_id=%s" if sid else ""
    sube_filt_y = " AND y.sube_id=%s" if sid else ""
    params_sube = (sid,) if sid else ()

    stok_yolda = _int_count(
        cur,
        f"SELECT COUNT(*) FROM stok_yolda WHERE 1=1{sube_filt}",
        params_sube,
    )
    yolda_aktif = _int_count(
        cur,
        f"SELECT COUNT(*) FROM stok_yolda WHERE durum='yolda'{sube_filt}",
        params_sube,
    )
    yolda_yetim = _int_count(
        cur,
        f"SELECT COUNT(*) FROM stok_yolda WHERE durum='yolda' AND siparis_talep_id IS NULL{sube_filt}",
        params_sube,
    )
    # Panel JOIN dışında kalan: talep silinmiş veya tarih/durum filtresine takılmış yolda
    yolda_panel_dis = _int_count(
        cur,
        f"""
        SELECT COUNT(*)
        FROM stok_yolda y
        LEFT JOIN siparis_talep t ON t.id = y.siparis_talep_id
        WHERE y.durum = 'yolda'{sube_filt_y}
          AND (
                t.id IS NULL
                OR t.durum IN ('teslim_edildi', 'iptal', 'gonderilmedi', 'kabul_uyusmazlik')
              )
        """,
        params_sube,
    )
    siparis_talep_n = _int_count(
        cur,
        f"SELECT COUNT(*) FROM siparis_talep WHERE 1=1{sube_filt}",
        params_sube,
    )
    acik_siparis = _int_count(
        cur,
        f"""
        SELECT COUNT(*) FROM siparis_talep
        WHERE durum NOT IN ('teslim_edildi', 'iptal', 'gonderilmedi'){sube_filt}
        """,
        params_sube,
    )
    merkez_sevk = _int_count(
        cur,
        "SELECT COUNT(*) FROM merkez_stok_sevk WHERE siparis_talep_id IS NOT NULL"
        + (" AND sube_id=%s" if sid else ""),
        params_sube if sid else (),
    )
    sevk_eksik = _int_count(
        cur,
        f"SELECT COUNT(*) FROM siparis_sevk_eksik WHERE 1=1{sube_filt}",
        params_sube,
    )
    ozel_talep = _int_count(
        cur,
        f"SELECT COUNT(*) FROM siparis_ozel_talep WHERE 1=1{sube_filt}",
        params_sube,
    )
    rezerve = _int_count(
        cur,
        f"SELECT COUNT(*) FROM sube_depo_stok WHERE rezerve_adet > 0{sube_filt}",
        params_sube,
    )

    ornek_yolda: List[Dict[str, Any]] = []
    cur.execute(
        f"""
        SELECT y.id, y.sube_id, y.siparis_talep_id, y.kalem_adi, y.sevk_adet, y.durum,
               y.sevk_ts, t.durum AS talep_durum
        FROM stok_yolda y
        LEFT JOIN siparis_talep t ON t.id = y.siparis_talep_id
        WHERE y.durum = 'yolda'{sube_filt_y}
        ORDER BY y.sevk_ts ASC NULLS LAST
        LIMIT 12
        """,
        params_sube,
    )
    for r in cur.fetchall() or []:
        d = dict(r)
        ornek_yolda.append(
            {
                "yolda_id": str(d.get("id") or ""),
                "sube_id": str(d.get("sube_id") or ""),
                "siparis_talep_id": str(d.get("siparis_talep_id") or "") or None,
                "kalem_adi": str(d.get("kalem_adi") or ""),
                "sevk_adet": int(d.get("sevk_adet") or 0),
                "talep_durum": str(d.get("talep_durum") or "") or None,
                "sevk_ts": str(d.get("sevk_ts") or "")[:19],
            }
        )

    return {
        "sube_id": sid,
        "stok_yolda": stok_yolda,
        "yolda_aktif": yolda_aktif,
        "yolda_yetim": yolda_yetim,
        "yolda_panel_disinda": yolda_panel_dis,
        "siparis_talep": siparis_talep_n,
        "acik_siparis": acik_siparis,
        "merkez_stok_sevk_siparis": merkez_sevk,
        "siparis_sevk_eksik": sevk_eksik,
        "siparis_ozel_talep": ozel_talep,
        "depo_rezerve_satir": rezerve,
        "ornek_yolda": ornek_yolda,
    }


def siparis_depo_akisi_temizle(
    cur: Any,
    *,
    sube_id: Optional[str] = None,
    onay: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Depo sipariş akışı kalıntılarını siler.
    onay='EVET_SIL' zorunlu.
    """
    if (onay or "").strip() != ONAY_METNI:
        raise ValueError(f"Onay gerekli: onay='{ONAY_METNI}'")

    ozet_once = siparis_depo_akisi_ozet(cur, sube_id)
    sid = (sube_id or "").strip() or None
    params = (sid,) if sid else ()

    if sid:
        cur.execute(
            "UPDATE sube_depo_stok SET rezerve_adet=0, guncelleme=NOW() WHERE sube_id=%s AND rezerve_adet > 0",
            (sid,),
        )
    else:
        cur.execute(
            "UPDATE sube_depo_stok SET rezerve_adet=0, guncelleme=NOW() WHERE rezerve_adet > 0"
        )

    if sid:
        cur.execute("DELETE FROM stok_yolda WHERE sube_id=%s", (sid,))
        cur.execute("DELETE FROM siparis_sevk_eksik WHERE sube_id=%s", (sid,))
        cur.execute(
            "DELETE FROM merkez_stok_sevk WHERE siparis_talep_id IS NOT NULL AND sube_id=%s",
            (sid,),
        )
        cur.execute("DELETE FROM siparis_ozel_talep WHERE sube_id=%s", (sid,))
        cur.execute("DELETE FROM siparis_talep WHERE sube_id=%s", (sid,))
    else:
        cur.execute("DELETE FROM stok_yolda")
        cur.execute("DELETE FROM siparis_sevk_eksik")
        cur.execute("DELETE FROM merkez_stok_sevk WHERE siparis_talep_id IS NOT NULL")
        cur.execute("DELETE FROM siparis_ozel_talep")
        cur.execute("DELETE FROM siparis_talep")

    ozet_sonra = siparis_depo_akisi_ozet(cur, sube_id)
    return {
        "success": True,
        "mesaj": "Depo sipariş akışı kalıntıları temizlendi. Katalog ve depo mevcut stok korundu.",
        "once": ozet_once,
        "sonra": ozet_sonra,
    }
