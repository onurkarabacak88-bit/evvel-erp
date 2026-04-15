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
from datetime import date, datetime
from typing import Any, Dict, List, Optional

from tr_saat import dt_coerce_naive_tr, dt_now_tr_naive

STOK_KEYS = (
    "bardak_kucuk",
    "bardak_buyuk",
    "bardak_plastik",
    "su_adet",
    "redbull_adet",
    "soda_adet",
    "cookie_adet",
    "pasta_adet",
    "sut_litre",
    "surup_adet",
    "kahve_paket",
    "karton_bardak",
    "kapak_adet",
    "pecete_paket",
    "diger_sarf",
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
    "sut_litre": "Süt",
    "surup_adet": "Şurup",
    "kahve_paket": "Kahve paket",
    "karton_bardak": "Karton bardak",
    "kapak_adet": "Kapak",
    "pecete_paket": "Peçete",
    "diger_sarf": "Diğer sarf",
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


def _parse_json_from_prefix(raw: str, prefix: str) -> Dict[str, Any]:
    """
    'PREFIX:{...} | not' formatından JSON gövdeyi güvenli çıkarır.
    """
    txt = str(raw or "").strip()
    if not txt.startswith(prefix):
        return {}
    body = txt[len(prefix):]
    if " | " in body:
        body = body.split(" | ", 1)[0]
    body = body.strip()
    if not body:
        return {}
    try:
        j = json.loads(body)
        return j if isinstance(j, dict) else {}
    except Exception:
        return {}


def _stok_key_from_urun_ad(urun_ad: Any) -> Optional[str]:
    n = str(urun_ad or "").strip().lower()
    if not n:
        return None
    if "kucuk bardak" in n or "küçük bardak" in n:
        return "bardak_kucuk"
    if "buyuk bardak" in n or "büyük bardak" in n:
        return "bardak_buyuk"
    if "plastik bardak" in n:
        return "bardak_plastik"
    if "karton bardak" in n:
        return "karton_bardak"
    if n == "su" or " su " in f" {n} ":
        return "su_adet"
    if "redbull" in n:
        return "redbull_adet"
    if "soda" in n:
        return "soda_adet"
    if "cookie" in n:
        return "cookie_adet"
    if "pasta" in n:
        return "pasta_adet"
    if "sut" in n or "süt" in n:
        return "sut_litre"
    if "surup" in n or "şurup" in n:
        return "surup_adet"
    if "kahve" in n:
        return "kahve_paket"
    if "kapak" in n:
        return "kapak_adet"
    if "pecete" in n or "peçete" in n:
        return "pecete_paket"
    return None


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
        j = _parse_json_from_prefix(row.get("aciklama") or "", "URUN_STOK_JSON:")
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
        j = _parse_json_from_prefix(row.get("aciklama") or "", "URUN_AC_JSON:")
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
        j = _parse_json_from_prefix(row.get("aciklama") or "", "URUN_SEVK_JSON:")
        if not isinstance(j, dict):
            continue
        d = j.get("delta") or j
        for k in STOK_KEYS:
            try:
                total[k] += max(0, int(d.get(k) or 0))
            except (TypeError, ValueError):
                pass
    return total


def sum_urun_ac_genel(cur: Any) -> Dict[str, int]:
    """Tüm dönem URUN_AC toplamı (şubelerin depodan kullanıma açtığı adet)."""
    cur.execute(
        """
        SELECT aciklama FROM operasyon_defter
        WHERE etiket='URUN_AC'
        ORDER BY olay_ts ASC
        """
    )
    total = _zero_stok()
    for row in cur.fetchall():
        j = _parse_json_from_prefix(row.get("aciklama") or "", "URUN_AC_JSON:")
        if not isinstance(j, dict):
            continue
        d = j.get("delta") or j
        for k in STOK_KEYS:
            try:
                total[k] += max(0, int(d.get(k) or 0))
            except (TypeError, ValueError):
                pass
    return total


def sum_merkez_stok_sevk(cur: Any) -> Dict[str, int]:
    """
    Merkez→şube sevk tablosundan toplam.
    Fallback: tablo boş ise defterdeki URUN_SEVK kayıtlarını kullanır.
    """
    total = _zero_stok()
    cur.execute("SELECT kalem_kodu, adet FROM merkez_stok_sevk")
    rows = cur.fetchall() or []
    if rows:
        for row in rows:
            key = str((row or {}).get("kalem_kodu") or "").strip()
            if key not in total:
                continue
            try:
                total[key] += max(0, int((row or {}).get("adet") or 0))
            except (TypeError, ValueError):
                continue
        return total

    cur.execute("SELECT aciklama FROM operasyon_defter WHERE etiket='URUN_SEVK'")
    for r in cur.fetchall():
        j = _parse_json_from_prefix(r.get("aciklama") or "", "URUN_SEVK_JSON:")
        d = j.get("delta") if isinstance(j, dict) else None
        if not isinstance(d, dict):
            d = j if isinstance(j, dict) else {}
        for k in STOK_KEYS:
            try:
                total[k] += max(0, int(d.get(k) or 0))
            except (TypeError, ValueError):
                continue
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


def merkez_stok_kart_guncelle(cur: Any) -> List[Dict[str, Any]]:
    """
    Merkez stok kartı (3 katman):
      - siparis_adet: sipariş taleplerindeki kalem toplamı
      - sevk_adet: merkez_stok_sevk (merkez->şube gönderilen)
      - kullanilan_adet: operasyon_defter URUN_AC (şubenin kullandığı)
      - kalan_adet: sevk - kullanılan (şubede kalan/depo)
    """
    siparis = _zero_stok()
    sevk = _zero_stok()
    kullanilan = _zero_stok()

    cur.execute("SELECT kalemler FROM siparis_talep WHERE durum!='iptal'")
    for r in cur.fetchall():
        kal = r.get("kalemler")
        if isinstance(kal, str):
            try:
                kal = json.loads(kal)
            except Exception:
                kal = []
        if not isinstance(kal, list):
            continue
        for it in kal:
            if not isinstance(it, dict):
                continue
            key = _stok_key_from_urun_ad(it.get("urun_ad"))
            if not key:
                continue
            try:
                siparis[key] += max(0, int(it.get("adet") or 0))
            except (TypeError, ValueError):
                continue

    sevk = sum_merkez_stok_sevk(cur)
    kullanilan = sum_urun_ac_genel(cur)

    rows: List[Dict[str, Any]] = []
    for k in STOK_KEYS:
        sev = int(sevk.get(k) or 0)
        kull = max(0, int(kullanilan.get(k) or 0))
        kal = max(0, sev - kull)
        rows.append(
            {
                "kalem_kodu": k,
                "kalem_adi": STOK_LABEL_TR.get(k, k),
                "siparis_adet": int(siparis.get(k) or 0),
                "sevk_adet": sev,
                "kullanilan_adet": kull,
                "kalan_adet": kal,
            }
        )

    for r in rows:
        cur.execute(
            """
            INSERT INTO merkez_stok_kart
                (kalem_kodu, kalem_adi, siparis_adet, sevk_adet, kullanilan_adet, kalan_adet, guncelleme)
            VALUES
                (%s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (kalem_kodu)
            DO UPDATE SET
                kalem_adi=EXCLUDED.kalem_adi,
                siparis_adet=EXCLUDED.siparis_adet,
                sevk_adet=EXCLUDED.sevk_adet,
                kullanilan_adet=EXCLUDED.kullanilan_adet,
                kalan_adet=EXCLUDED.kalan_adet,
                guncelleme=NOW()
            """,
            (
                r["kalem_kodu"],
                r["kalem_adi"],
                r["siparis_adet"],
                r["sevk_adet"],
                r["kullanilan_adet"],
                r["kalan_adet"],
            ),
        )
    return rows


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
        if a > s:
            lab = STOK_LABEL_TR.get(k, k)
            msg = (
                f"{lab}: sevk kaydı yok ama {a} açıldı — depoda olmayan ürün açılmış olabilir"
                if s <= 0
                else f"{lab}: {s} sevk edildi ama {a} açıldı — fazla açılmış olabilir"
            )
            out.append({
                "id": f"virt-sevk-ac-{sube_id}-{k}",
                "tip": "SEVK_AC_UYUMSUZ",
                "seviye": "uyari",
                "mesaj": msg,
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
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND tip='KONTROL'
        ORDER BY sistem_slot_ts ASC NULLS LAST, id ASC
        """,
        (sube_id,),
    )
    rows = cur.fetchall() or []
    sim_n = dt_coerce_naive_tr(simdi) if isinstance(simdi, datetime) else dt_now_tr_naive()
    if sim_n is None:
        return out
    for r in rows:
        if (r.get("durum") or "") != "gecikti":
            continue
        st = r.get("son_teslim_ts")
        if st is None:
            continue
        st_n = dt_coerce_naive_tr(st)
        if st_n is None:
            continue
        try:
            gec_dk = max(0, int((sim_n - st_n).total_seconds() // 60))
        except Exception:
            continue
        if gec_dk <= 0:
            continue
        rid = str(r.get("id") or "")
        out.append(
            {
                "id": f"virt-kontrol-gec-{sube_id}-{rid[:8] or 'x'}",
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
        t = int(teorik.get(k, 0) or 0)
        g = int((gercek or {}).get(k, 0) or 0)
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


def sube_operasyon_ozet_yaz(cur: Any, sube_id: str, kapanis_stok: Dict[str, int]) -> Dict[str, Any]:
    """
    Günlük satış tahmini özetini yazar (UPSERT):
      satış_tahmini = teorik_stok_bugun - kapanis_stok
    """
    teorik = teorik_stok_bugun(cur, sube_id)
    if teorik is None:
        return {"yazildi": False, "sebep": "teorik_yok"}

    gercek = _zero_stok()
    for k in STOK_KEYS:
        try:
            gercek[k] = max(0, int((kapanis_stok or {}).get(k) or 0))
        except (TypeError, ValueError):
            gercek[k] = 0

    satis = {}
    toplam = 0
    for k in STOK_KEYS:
        val = int(teorik.get(k, 0) or 0) - int(gercek.get(k, 0) or 0)
        val = max(0, val)
        satis[k] = val
        toplam += val

    oid = str(uuid.uuid4())
    cur.execute(
        """
        INSERT INTO sube_operasyon_ozet
            (id, sube_id, tarih, satis_tahmin_toplam, satis_tahmin_json, teorik_stok_json, kapanis_stok_json, guncelleme)
        VALUES
            (%s, %s, CURRENT_DATE, %s, %s, %s, %s, NOW())
        ON CONFLICT (sube_id, tarih)
        DO UPDATE SET
            satis_tahmin_toplam = EXCLUDED.satis_tahmin_toplam,
            satis_tahmin_json = EXCLUDED.satis_tahmin_json,
            teorik_stok_json = EXCLUDED.teorik_stok_json,
            kapanis_stok_json = EXCLUDED.kapanis_stok_json,
            guncelleme = NOW()
        """,
        (
            oid,
            sube_id,
            int(toplam),
            json.dumps(satis, ensure_ascii=False, separators=(",", ":")),
            json.dumps(teorik, ensure_ascii=False, separators=(",", ":")),
            json.dumps(gercek, ensure_ascii=False, separators=(",", ":")),
        ),
    )
    return {"yazildi": True, "satis_tahmin_toplam": int(toplam), "satis_tahmin_json": satis}


def build_virtual_merkez_uyarilari(cur: Any, sube_id: str, simdi: Any) -> List[Dict[str, Any]]:
    u1 = acilis_vs_dunku_kapanis_uyarilari(cur, sube_id)
    u2 = kontrol_gecikme_uyarilari(cur, sube_id, simdi)
    u3 = sevk_vs_ac_uyarilari(cur, sube_id)
    return u1 + u2 + u3


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
