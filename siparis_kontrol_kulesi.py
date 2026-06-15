"""
Sipariş Kontrol Kulesi — merkez operasyon görünürlüğü (pipeline + ürün geçmişi).
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

from sevkiyat_helpers import SD_ST, sevkiyat_durumu_coz

# Pipeline aşamaları (UI sütun / filtre anahtarları)
ASAMA_BEKLIYOR = "bekliyor"
ASAMA_DEPODA = "depoda"
ASAMA_YOLDA = "yolda"
ASAMA_UYUMSUZLUK = "uyumsuzluk"
ASAMA_TAMAMLANDI = "tamamlandi"
ASAMA_IPTAL = "iptal"
ASAMA_GONDERILMEDI = "gonderilmedi"

ASAMA_LABEL = {
    ASAMA_BEKLIYOR: "Merkez kuyruğu",
    ASAMA_DEPODA: "Depoda hazırlanıyor",
    ASAMA_YOLDA: "Yolda / kabul bekliyor",
    ASAMA_UYUMSUZLUK: "Kabul uyumsuzluğu",
    ASAMA_TAMAMLANDI: "Tamamlandı",
    ASAMA_IPTAL: "İptal",
    ASAMA_GONDERILMEDI: "Gönderilmedi",
}

ACIK_ASAMALAR = (
    ASAMA_BEKLIYOR,
    ASAMA_DEPODA,
    ASAMA_YOLDA,
    ASAMA_UYUMSUZLUK,
)


def _kabul_durum_ozet(yolda: List[Dict[str, Any]]) -> Optional[str]:
    if not yolda:
        return None
    durumlar = [str(y.get("durum") or "").lower() for y in yolda]
    if any(d == "kabul_uyusmazlik" for d in durumlar):
        return "kabul_uyusmazlik"
    if all(d in ("kabul_edildi", "uzlasildi") for d in durumlar):
        return "kabul_tam"
    if any(d == "kabul_edildi" for d in durumlar):
        return "kabul_kismi"
    if any(d == "yolda" for d in durumlar):
        return "yolda"
    return None


def siparis_asama_hesapla(
    durum: Optional[str],
    sevkiyat_durumu: Optional[str],
    kabul_durum: Optional[str],
) -> str:
    d = (durum or "").strip().lower()
    sd = sevkiyat_durumu_coz(sevkiyat_durumu)

    if d == "iptal":
        return ASAMA_IPTAL
    if d == "gonderilmedi":
        return ASAMA_GONDERILMEDI
    if kabul_durum == "kabul_uyusmazlik":
        return ASAMA_UYUMSUZLUK
    if d == "teslim_edildi" or kabul_durum == "kabul_tam":
        return ASAMA_TAMAMLANDI
    if d == "bekliyor":
        return ASAMA_BEKLIYOR
    if sd == "toptanciya_yonlendirildi":
        return ASAMA_TAMAMLANDI
    if d == "gonderildi":
        return ASAMA_YOLDA
    if d == "hazirlaniyor":
        if sd == "gonderildi":
            return ASAMA_YOLDA
        return ASAMA_DEPODA
    if kabul_durum in ("yolda", "kabul_kismi"):
        return ASAMA_YOLDA
    return ASAMA_DEPODA if d else ASAMA_BEKLIYOR


def _asama_metni(asama: str, sevkiyat_durumu: Optional[str]) -> str:
    if asama == ASAMA_BEKLIYOR:
        return "Merkezde sırada — depo yönlendirmesi bekleniyor"
    if asama == ASAMA_DEPODA:
        sd = sevkiyat_durumu_coz(sevkiyat_durumu)
        if sd == "kismi_hazirlandi":
            return "Depoda kısmi hazırlandı"
        if sd in ("depoda_hazirlaniyor", "hazirlaniyor"):
            return "Depoda hazırlanıyor"
        return "Depo / sevkiyat işleniyor"
    if asama == ASAMA_YOLDA:
        return "Depodan çıktı — talep şubesinde kabul bekleniyor"
    if asama == ASAMA_UYUMSUZLUK:
        return "Kabul uyumsuzluğu — merkez müdahalesi gerekli"
    if asama == ASAMA_TAMAMLANDI:
        if sevkiyat_durumu_coz(sevkiyat_durumu) == "toptanciya_yonlendirildi":
            return "Toptancıya yönlendirildi"
        return "Teslim alındı (tamamlandı)"
    if asama == ASAMA_IPTAL:
        return "İptal edildi"
    if asama == ASAMA_GONDERILMEDI:
        return "Gönderilmedi olarak işaretlendi"
    return ASAMA_LABEL.get(asama, asama)


def _json_list(raw: Any) -> List[Any]:
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str):
        try:
            v = json.loads(raw)
            return v if isinstance(v, list) else []
        except Exception:
            return []
    return []


def _yolda_satirlari(cur: Any, talep_id: str) -> List[Dict[str, Any]]:
    cur.execute(
        """
        SELECT kalem_kodu, kalem_adi, sevk_adet, kabul_adet, kabul_ts, durum, sevk_ts
        FROM stok_yolda WHERE siparis_talep_id=%s
        ORDER BY kalem_adi NULLS LAST, kalem_kodu
        """,
        (talep_id,),
    )
    out = []
    for y in cur.fetchall() or []:
        out.append({
            "kalem_kodu": y.get("kalem_kodu"),
            "kalem_adi": y.get("kalem_adi"),
            "sevk_adet": int(y.get("sevk_adet") or 0),
            "kabul_adet": int(y.get("kabul_adet") or 0),
            "durum": y.get("durum"),
            "kabul_ts": str(y.get("kabul_ts") or ""),
            "sevk_ts": str(y.get("sevk_ts") or ""),
        })
    return out


def _yolda_toplu(cur: Any, talep_ids: List[str]) -> Dict[str, List[Dict[str, Any]]]:
    """N+1 yerine: tüm talep id'lerinin stok_yolda satırlarını TEK sorguda çekip
    talep_id → satır listesi haritası döner. _yolda_satirlari ile birebir aynı
    satır şekli (sadece toplu)."""
    out: Dict[str, List[Dict[str, Any]]] = {}
    ids = [t for t in {str(x) for x in talep_ids if x}]
    if not ids:
        return out
    cur.execute(
        """
        SELECT siparis_talep_id, kalem_kodu, kalem_adi, sevk_adet, kabul_adet, kabul_ts, durum, sevk_ts
        FROM stok_yolda WHERE siparis_talep_id = ANY(%s)
        ORDER BY kalem_adi NULLS LAST, kalem_kodu
        """,
        (ids,),
    )
    for y in cur.fetchall() or []:
        tid = str(y.get("siparis_talep_id") or "")
        out.setdefault(tid, []).append({
            "kalem_kodu": y.get("kalem_kodu"),
            "kalem_adi": y.get("kalem_adi"),
            "sevk_adet": int(y.get("sevk_adet") or 0),
            "kabul_adet": int(y.get("kabul_adet") or 0),
            "durum": y.get("durum"),
            "kabul_ts": str(y.get("kabul_ts") or ""),
            "sevk_ts": str(y.get("sevk_ts") or ""),
        })
    return out


def _satir_zenginlestir(cur: Any, row: Dict[str, Any],
                        yolda: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    tid = str(row.get("id") or "")
    kalemler = _json_list(row.get("kalemler"))
    kalem_durumlari = _json_list(row.get("kalem_durumlari"))
    if yolda is None:
        yolda = _yolda_satirlari(cur, tid)
    kabul_durum = _kabul_durum_ozet(yolda)
    sd = sevkiyat_durumu_coz(row.get("sevkiyat_durumu"), row.get("sevkiyat_durum"))
    asama = siparis_asama_hesapla(row.get("durum"), sd, kabul_durum)

    kalem_sayisi = sum(
        max(0, int((it or {}).get("adet") or 0))
        for it in kalemler
        if isinstance(it, dict)
    )

    return {
        "id": tid,
        "sube_id": row.get("sube_id"),
        "sube_adi": row.get("sube_adi"),
        "tarih": str(row.get("tarih") or ""),
        "olusturma": str(row.get("olusturma") or ""),
        "durum": row.get("durum"),
        "sevkiyat_durumu": sd,
        "asama": asama,
        "asama_metni": _asama_metni(asama, sd),
        "hedef_depo_sube_id": row.get("hedef_depo_sube_id"),
        "hedef_depo_sube_adi": row.get("hedef_depo_sube_adi"),
        "personel_ad": row.get("personel_ad"),
        "not_aciklama": row.get("not_aciklama"),
        "operasyon_yonlendirme_talimati": row.get("operasyon_yonlendirme_talimati"),
        "tahsis_ts": str(row.get("tahsis_ts") or ""),
        "tahsis_yapan_ad": row.get("tahsis_yapan_ad"),
        "tahsis_durum": row.get("tahsis_durum"),
        "sevkiyat_ts": str(row.get("sevkiyat_ts") or ""),
        "sevkiyat_personel_ad": row.get("sevkiyat_personel_ad"),
        "kabul_durum": kabul_durum,
        "kalemler": kalemler,
        "kalem_durumlari": kalem_durumlari,
        "yolda": yolda,
        "kalem_sayisi": kalem_sayisi,
        "son_olay": row.get("son_olay"),
        "son_olay_ts": str(row.get("son_olay_ts") or ""),
    }


def siparis_kontrol_kulesi_yukle(
    cur: Any,
    *,
    gun: int = 30,
    asama: Optional[str] = None,
    sube_arama: Optional[str] = None,
    depo_sube_id: Optional[str] = None,
    talep_arama: Optional[str] = None,
    sadece_acik: bool = True,
    limit: int = 500,
) -> Dict[str, Any]:
    gun_i = max(1, min(365, int(gun or 30)))
    lim = max(1, min(1000, int(limit or 500)))

    kosullar = ["st.tarih >= CURRENT_DATE - (%s * INTERVAL '1 day')"]
    params: List[Any] = [gun_i]

    if sube_arama:
        like = f"%{sube_arama.strip()}%"
        kosullar.append("(LOWER(s.ad) LIKE LOWER(%s) OR st.sube_id = %s)")
        params.extend([like, sube_arama.strip()])

    if depo_sube_id:
        kosullar.append("COALESCE(st.hedef_depo_sube_id, st.sevkiyat_sube_id) = %s")
        params.append(depo_sube_id.strip())

    if talep_arama:
        t = talep_arama.strip()
        kosullar.append("(st.id::text ILIKE %s OR st.id::text = %s)")
        params.extend([f"%{t}%", t])

    if sadece_acik:
        kosullar.append("st.durum NOT IN ('teslim_edildi', 'iptal', 'gonderilmedi')")

    where = " AND ".join(kosullar)

    # Özet: dönem içi tüm eşleşen kayıtlar
    cur.execute(
        f"""
        SELECT st.id, st.durum, st.sevkiyat_durumu, st.sevkiyat_durum
        FROM siparis_talep st
        JOIN subeler s ON s.id = st.sube_id
        WHERE {where}
        """,
        tuple(params),
    )
    ozet_rows = [dict(r) for r in (cur.fetchall() or [])]
    ozet_yolda = _yolda_toplu(cur, [r.get("id") for r in ozet_rows])
    ozet: Dict[str, int] = {k: 0 for k in ASAMA_LABEL}
    for r in ozet_rows:
        yolda = ozet_yolda.get(str(r.get("id") or ""), [])
        kd = _kabul_durum_ozet(yolda)
        sd = sevkiyat_durumu_coz(r.get("sevkiyat_durumu"), r.get("sevkiyat_durum"))
        a = siparis_asama_hesapla(r.get("durum"), sd, kd)
        ozet[a] = ozet.get(a, 0) + 1

    cur.execute(
        f"""
        SELECT
            st.id, st.sube_id, s.ad AS sube_adi,
            st.tarih, st.durum, st.olusturma,
            st.personel_id, st.personel_ad,
            st.not_aciklama, st.kalemler, st.kalem_durumlari,
            st.tahsis_durum, st.tahsis_ts, st.tahsis_yapan_ad,
            st.sevkiyat_ts, st.sevkiyat_personel_ad,
            st.sevkiyat_durumu, st.sevkiyat_durum,
            COALESCE(st.hedef_depo_sube_id, st.sevkiyat_sube_id) AS hedef_depo_sube_id,
            dep.ad AS hedef_depo_sube_adi,
            NULLIF(TRIM(st.operasyon_yonlendirme_talimati), '') AS operasyon_yonlendirme_talimati,
            (SELECT etiket FROM operasyon_defter
             WHERE ref_event_id=st.id ORDER BY olay_ts DESC LIMIT 1) AS son_olay,
            (SELECT olay_ts FROM operasyon_defter
             WHERE ref_event_id=st.id ORDER BY olay_ts DESC LIMIT 1) AS son_olay_ts
        FROM siparis_talep st
        JOIN subeler s ON s.id = st.sube_id
        LEFT JOIN subeler dep ON dep.id = COALESCE(st.hedef_depo_sube_id, st.sevkiyat_sube_id)
        WHERE {where}
        ORDER BY
            CASE st.durum
                WHEN 'bekliyor' THEN 0
                WHEN 'hazirlaniyor' THEN 1
                WHEN 'gonderildi' THEN 2
                ELSE 3
            END,
            st.olusturma DESC NULLS LAST
        LIMIT %s
        """,
        tuple(params + [lim]),
    )

    detay_rows = [dict(r) for r in (cur.fetchall() or [])]
    detay_yolda = _yolda_toplu(cur, [r.get("id") for r in detay_rows])
    satirlar: List[Dict[str, Any]] = []
    for r in detay_rows:
        z = _satir_zenginlestir(cur, r, yolda=detay_yolda.get(str(r.get("id") or ""), []))
        if asama and z["asama"] != asama:
            continue
        satirlar.append(z)

    acik_toplam = sum(ozet.get(a, 0) for a in ACIK_ASAMALAR)

    return {
        "gun": gun_i,
        "asama_filtre": asama,
        "sadece_acik": sadece_acik,
        "toplam": len(satirlar),
        "acik_toplam": acik_toplam,
        "ozet": ozet,
        "satirlar": satirlar,
    }


def siparis_urun_gecmis(
    cur: Any,
    *,
    urun_arama: str,
    gun: int = 90,
    sube_id: Optional[str] = None,
    limit: int = 80,
) -> Dict[str, Any]:
    q = (urun_arama or "").strip()
    if len(q) < 2:
        return {"urun_arama": q, "satirlar": [], "toplam": 0, "gun": gun}

    gun_i = max(1, min(730, int(gun or 90)))
    lim = max(1, min(300, int(limit or 80)))
    like = f"%{q.lower()}%"

    kosul = """
        st.tarih >= CURRENT_DATE - (%s * INTERVAL '1 day')
        AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(st.kalemler, '[]'::jsonb)) elem
            WHERE LOWER(COALESCE(elem->>'urun_ad', elem->>'kalem_adi', '')) LIKE %s
               OR LOWER(COALESCE(elem->>'kalem_kodu', elem->>'urun_id', '')) LIKE %s
               OR elem->>'urun_id' = %s
        )
    """
    params: List[Any] = [gun_i, like, like, q]

    if sube_id:
        kosul += " AND st.sube_id = %s"
        params.append(sube_id.strip())

    cur.execute(
        f"""
        SELECT
            st.id, st.sube_id, s.ad AS sube_adi,
            st.tarih, st.durum, st.olusturma, st.kalemler,
            st.sevkiyat_durumu, st.sevkiyat_durum,
            COALESCE(st.hedef_depo_sube_id, st.sevkiyat_sube_id) AS hedef_depo_sube_id,
            dep.ad AS hedef_depo_sube_adi
        FROM siparis_talep st
        JOIN subeler s ON s.id = st.sube_id
        LEFT JOIN subeler dep ON dep.id = COALESCE(st.hedef_depo_sube_id, st.sevkiyat_sube_id)
        WHERE {kosul}
        ORDER BY st.tarih DESC, st.olusturma DESC
        LIMIT %s
        """,
        tuple(params + [lim]),
    )

    gecmis_rows = [dict(r) for r in (cur.fetchall() or [])]
    gecmis_yolda = _yolda_toplu(cur, [r.get("id") for r in gecmis_rows])
    satirlar = []
    for row in gecmis_rows:
        kalemler = _json_list(row.get("kalemler"))
        eslesen = []
        for it in kalemler:
            if not isinstance(it, dict):
                continue
            ad = str(it.get("urun_ad") or it.get("kalem_adi") or "").lower()
            kod = str(it.get("kalem_kodu") or it.get("urun_id") or "").lower()
            if q.lower() in ad or q.lower() in kod or str(it.get("urun_id") or "") == q:
                eslesen.append({
                    "urun_ad": it.get("urun_ad") or it.get("kalem_adi"),
                    "kalem_kodu": it.get("kalem_kodu") or it.get("urun_id"),
                    "adet": int(it.get("adet") or 0),
                })
        if not eslesen:
            continue
        yolda = gecmis_yolda.get(str(row.get("id") or ""), [])
        kabul_durum = _kabul_durum_ozet(yolda)
        sd = sevkiyat_durumu_coz(row.get("sevkiyat_durumu"), row.get("sevkiyat_durum"))
        asama = siparis_asama_hesapla(row.get("durum"), sd, kabul_durum)
        satirlar.append({
            "talep_id": row.get("id"),
            "sube_id": row.get("sube_id"),
            "sube_adi": row.get("sube_adi"),
            "tarih": str(row.get("tarih") or ""),
            "olusturma": str(row.get("olusturma") or ""),
            "durum": row.get("durum"),
            "asama": asama,
            "asama_metni": _asama_metni(asama, sd),
            "hedef_depo_sube_adi": row.get("hedef_depo_sube_adi"),
            "eslesen_kalemler": eslesen,
        })

    return {
        "urun_arama": q,
        "gun": gun_i,
        "toplam": len(satirlar),
        "satirlar": satirlar,
    }
