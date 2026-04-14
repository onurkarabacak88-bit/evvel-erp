"""
Operasyon stok / bardak tutarlılık motoru (davranış denetimi).

- Açılış sayımları ve kapanış sayımları event meta (JSON) içinde tutulur.
- URUN_STOK_EKLE satırları operasyon_defter'da JSON gövde ile append-only yazılır.
- PIN düz metin deftere yazılmaz; satır HMAC'ı doğrulanmış personel işleminden sonra üretilir
  (operasyon_defter modülündeki model — blueprint'teki hash(pin+data) yerine sunucu imzası + zincir).
"""
from __future__ import annotations

import json
import uuid
from datetime import date
from typing import Any, Dict, List, Optional

STOK_KEYS = (
    "bardak_kucuk",
    "bardak_buyuk",
    "bardak_plastik",
    "su_adet",
    "redbull_adet",
    "soda_adet",
    "cookie_adet",
    "pasta_adet",
)

STOK_LABEL_TR = {
    "bardak_kucuk": "Küçük bardak",
    "bardak_buyuk": "Büyük bardak",
    "bardak_plastik": "Plastik bardak",
    "su_adet": "Su",
    "redbull_adet": "Redbull",
    "soda_adet": "Soda",
    "cookie_adet": "Cookie",
    "pasta_adet": "Pasta",
}


def _zero_stok() -> Dict[str, int]:
    return {k: 0 for k in STOK_KEYS}


def _parse_meta(meta_raw: Any) -> dict:
    if meta_raw is None:
        return {}
    if isinstance(meta_raw, dict):
        return meta_raw
    s = str(meta_raw).strip()
    if not s:
        return {}
    try:
        return json.loads(s)
    except Exception:
        return {}


def stok_from_event_meta(meta_raw: Any, key: str = "acilis_stok_sayim") -> Dict[str, int]:
    m = _parse_meta(meta_raw)
    block = m.get(key) or m.get("stok_sayim")
    if not isinstance(block, dict):
        return _zero_stok()
    out = _zero_stok()
    for k in STOK_KEYS:
        try:
            out[k] = max(0, int(block.get(k) or 0))
        except (TypeError, ValueError):
            out[k] = 0
    return out


def bugun_acilis_stok(cur: Any, sube_id: str) -> Optional[Dict[str, int]]:
    cur.execute(
        """
        SELECT meta FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND tip='ACILIS' AND durum='tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST
        LIMIT 1
        """,
        (sube_id,),
    )
    r = cur.fetchone()
    if not r:
        return None
    m = _parse_meta(r.get("meta"))
    if "acilis_stok_sayim" not in m and "stok_sayim" not in m:
        return None
    return stok_from_event_meta(r.get("meta"), "acilis_stok_sayim")


def dun_kapanis_stok(cur: Any, sube_id: str) -> Optional[Dict[str, int]]:
    cur.execute(
        """
        SELECT meta FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih = (CURRENT_DATE - INTERVAL '1 day')
          AND tip='KAPANIS' AND durum='tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST
        LIMIT 1
        """,
        (sube_id,),
    )
    r = cur.fetchone()
    if not r:
        return None
    m = _parse_meta(r.get("meta"))
    if "kapanis_stok_sayim" not in m:
        return None
    return stok_from_event_meta(r.get("meta"), "kapanis_stok_sayim")


def sum_urun_stok_ekle_bugun(cur: Any, sube_id: str) -> Dict[str, int]:
    cur.execute(
        """
        SELECT aciklama FROM operasyon_defter
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND etiket='URUN_STOK_EKLE'
        ORDER BY olay_ts ASC
        """,
        (sube_id,),
    )
    total = _zero_stok()
    for row in cur.fetchall():
        raw = (row.get("aciklama") or "").strip()
        if not raw.startswith("URUN_STOK_JSON:"):
            continue
        try:
            j = json.loads(raw[len("URUN_STOK_JSON:"):])
        except Exception:
            continue
        if not isinstance(j, dict):
            continue
        d = j.get("delta") or j
        for k in STOK_KEYS:
            try:
                total[k] += max(0, int(d.get(k) or 0))
            except (TypeError, ValueError):
                pass
    return total


def sum_urun_ac_bugun(cur: Any, sube_id: str) -> Dict[str, int]:
    """Bugün URUN_AC etiketiyle deftere yazılan (depodan aktif kullanıma açılan) toplamlar."""
    cur.execute(
        """
        SELECT aciklama FROM operasyon_defter
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND etiket='URUN_AC'
        ORDER BY olay_ts ASC
        """,
        (sube_id,),
    )
    total = _zero_stok()
    for row in cur.fetchall():
        raw = (row.get("aciklama") or "").strip()
        if not raw.startswith("URUN_AC_JSON:"):
            continue
        try:
            j = json.loads(raw[len("URUN_AC_JSON:"):])
        except Exception:
            continue
        if not isinstance(j, dict):
            continue
        d = j.get("delta") or j
        for k in STOK_KEYS:
            try:
                total[k] += max(0, int(d.get(k) or 0))
            except (TypeError, ValueError):
                pass
    return total


def sum_urun_sevk_bugun(cur: Any, sube_id: str) -> Dict[str, int]:
    """Bugün URUN_SEVK etiketiyle teslim alınan (potansiyel depo stok) toplamlar."""
    cur.execute(
        """
        SELECT aciklama FROM operasyon_defter
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND etiket='URUN_SEVK'
        ORDER BY olay_ts ASC
        """,
        (sube_id,),
    )
    total = _zero_stok()
    for row in cur.fetchall():
        raw = (row.get("aciklama") or "").strip()
        if not raw.startswith("URUN_SEVK_JSON:"):
            continue
        try:
            j = json.loads(raw[len("URUN_SEVK_JSON:"):])
        except Exception:
            continue
        if not isinstance(j, dict):
            continue
        d = j.get("delta") or j
        for k in STOK_KEYS:
            try:
                total[k] += max(0, int(d.get(k) or 0))
            except (TypeError, ValueError):
                pass
    return total


def teorik_stok_bugun(cur: Any, sube_id: str) -> Optional[Dict[str, int]]:
    """
    Beklenen aktif stok:
      açılış + URUN_STOK_EKLE (eski tip) + URUN_AC (depodan açılan)
    SEVK (depo teslim) dahil değil — SEVK potansiyel, AC gerçek kullanım.
    """
    ac = bugun_acilis_stok(cur, sube_id)
    if ac is None:
        return None
    ek = sum_urun_stok_ekle_bugun(cur, sube_id)
    urun_ac = sum_urun_ac_bugun(cur, sube_id)
    return {k: ac[k] + ek[k] + urun_ac[k] for k in STOK_KEYS}


def sevk_vs_ac_uyarilari(cur: Any, sube_id: str) -> List[Dict[str, Any]]:
    """
    SEVK edilip AC edilmeyen kalemleri tespit eder.
    Eğer sevk > ac ise ürün depoda bekliyor (uyarı değil, bilgi).
    Eğer ac > sevk ise depoda olmayan açılmış (şüpheli).
    """
    sevk = sum_urun_sevk_bugun(cur, sube_id)
    ac = sum_urun_ac_bugun(cur, sube_id)
    out: List[Dict[str, Any]] = []
    for k in STOK_KEYS:
        s, a = sevk[k], ac[k]
        if a > s and s > 0:
            lab = STOK_LABEL_TR.get(k, k)
            out.append({
                "id": f"virt-sevk-ac-{sube_id}-{k}",
                "tip": "SEVK_AC_UYUMSUZ",
                "seviye": "uyari",
                "mesaj": f"{lab}: {s} sevk edildi ama {a} açıldı — fazla açılmış olabilir",
                "fark_tl": float(a - s),
                "okundu": False, "olusturma": None, "kaynak": "stok_motor",
                "beklenen_tl": None, "gercek_tl": None,
            })
    return out




def acilis_vs_dunku_kapanis_uyarilari(cur: Any, sube_id: str) -> List[Dict[str, Any]]:
    """Sanal uyarı satırları (DB'ye yazılmaz) — dün kapanış stok ile bugün açılış stok."""
    out: List[Dict[str, Any]] = []
    dk = dun_kapanis_stok(cur, sube_id)
    ac = bugun_acilis_stok(cur, sube_id)
    if dk is None or ac is None:
        return out
    for k in STOK_KEYS:
        a, b = ac[k], dk[k]
        if a != b:
            lab = STOK_LABEL_TR.get(k, k)
            diff = a - b
            sev = "kritik" if abs(diff) >= 20 else "uyari"
            out.append(
                {
                    "id": f"virt-stok-acilis-{sube_id}-{k}",
                    "tip": "STOK_ACILIS_DUNKU_KAPANIS",
                    "seviye": sev,
                    "beklenen_tl": None,
                    "gercek_tl": None,
                    "fark_tl": float(diff),
                    "mesaj": (
                        f"{lab}: dün kapanış {b}, bugün açılış {a} "
                        f"(Δ {diff:+d}) — devir / sayım uyumsuzluğu"
                    ),
                    "okundu": False,
                    "olusturma": None,
                    "kaynak": "stok_motor",
                }
            )
    return out


def kontrol_gecikme_uyarilari(cur: Any, sube_id: str, simdi: Any) -> List[Dict[str, Any]]:
    """KONTROL: son_teslim_ts aşıldıysa 30 dk cevap penceresi ihlali."""
    out: List[Dict[str, Any]] = []
    cur.execute(
        """
        SELECT id, son_teslim_ts, durum, sistem_slot_ts
        FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND tip='KONTROL' AND sira_no=1
        LIMIT 1
        """,
        (sube_id,),
    )
    r = cur.fetchone()
    if not r or r.get("durum") != "gecikti":
        return out
    st = r.get("son_teslim_ts")
    if st is None or simdi is None:
        return out
    try:
        gec_dk = max(0, int((simdi - st).total_seconds() // 60))
    except Exception:
        return out
    if gec_dk <= 0:
        return out
    out.append(
        {
            "id": f"virt-kontrol-gec-{sube_id}",
            "tip": "KONTROL_CEVAP_GECIKME",
            "seviye": "kritik" if gec_dk >= 45 else "uyari",
            "beklenen_tl": None,
            "gercek_tl": None,
            "fark_tl": float(gec_dk),
            "mesaj": (
                f"KONTROL: cevap penceresi {gec_dk} dk aşıldı "
                f"(slot sonrası 30 dk içinde kasa sayımı beklenir)"
            ),
            "okundu": False,
            "olusturma": None,
            "kaynak": "stok_motor",
        }
    )
    return out


def teorik_vs_gercek_uyarilari(
    teorik: Dict[str, int], gercek: Dict[str, int], sube_id: str
) -> List[Dict[str, Any]]:
    """Kapanışta girilen stok ile (açılış + eklemeler) teorik stok farkı."""
    out: List[Dict[str, Any]] = []
    for k in STOK_KEYS:
        t, g = teorik[k], gercek[k]
        if t == g:
            continue
        diff = g - t
        lab = STOK_LABEL_TR.get(k, k)
        sev = "kritik" if abs(diff) >= 15 else "uyari"
        if diff < 0:
            msg = (
                f"{lab}: beklenen (açılış+ekleme) {t}, kapanışta {g} (Δ {diff}) — "
                f"eksik rapor veya deftere yazılmayan stok girişi şüphesi"
            )
        else:
            msg = (
                f"{lab}: beklenen {t}, kapanışta {g} (Δ {diff:+d}) — "
                f"fazla rapor veya sayım tutarsızlığı"
            )
        out.append(
            {
                "id": f"virt-stok-kap-{sube_id}-{k}",
                "tip": "STOK_KAPANIS_TEORIK",
                "seviye": sev,
                "beklenen_tl": None,
                "gercek_tl": None,
                "fark_tl": float(diff),
                "mesaj": msg,
                "okundu": False,
                "olusturma": None,
                "kaynak": "stok_motor",
            }
        )
    return out


def kapanis_stok_uyarilari_yaz(cur: Any, sube_id: str, kapanis_stok: Dict[str, int]) -> None:
    """Kapanış tamamlandığında kalıcı uyarı (bir kez / gün)."""
    teorik = teorik_stok_bugun(cur, sube_id)
    if teorik is None:
        return
    virt = teorik_vs_gercek_uyarilari(teorik, kapanis_stok, sube_id)
    if not virt:
        return
    cur.execute(
        """
        SELECT 1 FROM sube_operasyon_uyari
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND tip='STOK_KAPANIS_OZET'
        LIMIT 1
        """,
        (sube_id,),
    )
    if cur.fetchone():
        return
    ozet = "; ".join(v["mesaj"] for v in virt[:6])
    if len(virt) > 6:
        ozet += f" … (+{len(virt) - 6} kalem)"
    uid = str(uuid.uuid4())
    cur.execute(
        """
        INSERT INTO sube_operasyon_uyari
            (id, sube_id, tarih, tip, seviye, beklenen_tl, gercek_tl, fark_tl, mesaj)
        VALUES (%s, %s, CURRENT_DATE, 'STOK_KAPANIS_OZET', 'uyari', NULL, NULL, NULL, %s)
        """,
        (uid, sube_id, ozet[:1900]),
    )


def build_virtual_merkez_uyarilari(cur: Any, sube_id: str, simdi: Any) -> List[Dict[str, Any]]:
    u1 = acilis_vs_dunku_kapanis_uyarilari(cur, sube_id)
    u2 = kontrol_gecikme_uyarilari(cur, sube_id, simdi)
    return u1 + u2


def normalize_delta_body(body: Dict[str, Any]) -> Dict[str, int]:
    d = _zero_stok()
    for k in STOK_KEYS:
        v = body.get(k)
        if v is None:
            continue
        try:
            d[k] = max(0, int(v))
        except (TypeError, ValueError):
            raise ValueError(f"Geçersiz sayı: {k}")
    if sum(d.values()) <= 0:
        raise ValueError("En az bir stok kaleminde pozitif adet girin")
    return d
