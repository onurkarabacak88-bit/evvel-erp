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
from typing import Any, Dict, List, Optional, Set, Tuple

from tr_saat import bugun_tr, dt_coerce_naive_tr, dt_now_tr_naive

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


def acilis_stok_tarih(cur: Any, sube_id: str, gun: date) -> Optional[Dict[str, int]]:
    """Belirli gün için açılış (ACILIS) stok sayımı."""
    cur.execute(
        """
        SELECT meta FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=%s AND tip='ACILIS' AND durum='tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST
        LIMIT 1
        """,
        (sube_id, gun),
    )
    r = cur.fetchone()
    if not r:
        return None
    m = _parse_meta(r.get("meta"))
    if "acilis_stok_sayim" not in m and "stok_sayim" not in m:
        return None
    return stok_from_event_meta(r.get("meta"), "acilis_stok_sayim")


def bugun_acilis_stok(cur: Any, sube_id: str) -> Optional[Dict[str, int]]:
    return acilis_stok_tarih(cur, sube_id, bugun_tr())


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


def sum_urun_stok_ekle_tarih(cur: Any, sube_id: str, gun: date) -> Dict[str, int]:
    cur.execute(
        """
        SELECT aciklama FROM operasyon_defter
        WHERE sube_id=%s AND tarih=%s AND etiket='URUN_STOK_EKLE'
        ORDER BY olay_ts ASC
        """,
        (sube_id, gun),
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

def sum_urun_stok_ekle_bugun(cur: Any, sube_id: str) -> Dict[str, int]:
    return sum_urun_stok_ekle_tarih(cur, sube_id, bugun_tr())


def sum_urun_ac_tarih(cur: Any, sube_id: str, gun: date) -> Dict[str, int]:
    """URUN_AC etiketiyle deftere yazılan (o gün, depodan açılan) toplamlar."""
    cur.execute(
        """
        SELECT aciklama FROM operasyon_defter
        WHERE sube_id=%s AND tarih=%s AND etiket='URUN_AC'
        ORDER BY olay_ts ASC
        """,
        (sube_id, gun),
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

def sum_urun_ac_bugun(cur: Any, sube_id: str) -> Dict[str, int]:
    return sum_urun_ac_tarih(cur, sube_id, bugun_tr())


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
    cur.execute(
        """
        SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema='public' AND table_name='merkez_stok_sevk'
        ) AS var
        """
    )
    var_mi = bool((cur.fetchone() or {}).get("var"))
    rows = []
    if var_mi:
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


def teorik_stok_tarih(cur: Any, sube_id: str, gun: date) -> Optional[Dict[str, int]]:
    """
    Belirli gün için teorik (beklenen) stok: açılış + URUN_STOK_EKLE + URUN_AC.
    Geçerli açılış yoksa None (merkez kartı / uyarı: veri yok).
    """
    ac = acilis_stok_tarih(cur, sube_id, gun)
    if ac is None:
        return None
    ek = sum_urun_stok_ekle_tarih(cur, sube_id, gun)
    urun_ac = sum_urun_ac_tarih(cur, sube_id, gun)
    return {k: ac[k] + ek[k] + urun_ac[k] for k in STOK_KEYS}


def satis_ozet_stok_bilesen(
    cur: Any, sube_id: str, gun: date
) -> Tuple[Dict[str, int], Dict[str, int], Dict[str, int]]:
    """
    (teorik, acilis, eklenen) — eklenen = URUN_STOK_EKLE + URUN_AC (gün içi hareket).
    Tek açılış okuması; satış-özet API ile aynı cebir.
    """
    ac_o = acilis_stok_tarih(cur, sube_id, gun)
    ac = ac_o if ac_o is not None else _zero_stok()
    ek = sum_urun_stok_ekle_tarih(cur, sube_id, gun)
    ur = sum_urun_ac_tarih(cur, sube_id, gun)
    eklenen = {k: ek[k] + ur[k] for k in STOK_KEYS}
    teo = {k: ac[k] + eklenen[k] for k in STOK_KEYS}
    return teo, ac, eklenen


def teorik_stok_tarih_sayim(cur: Any, sube_id: str, gun: date) -> Dict[str, int]:
    """Açılış yokken sıfır kabul eder; sadece toplam teorik vektörü."""
    teo, _, _ = satis_ozet_stok_bilesen(cur, sube_id, gun)
    return teo


def teorik_stok_bugun(cur: Any, sube_id: str) -> Optional[Dict[str, int]]:
    """
    Beklenen aktif stok (bugün):
      açılış + URUN_STOK_EKLE (eski tip) + URUN_AC (depodan açılan)
    SEVK (depo teslim) dahil değil — SEVK potansiyel, AC gerçek kullanım.
    """
    return teorik_stok_tarih(cur, sube_id, bugun_tr())


def merkez_stok_kart_guncelle(cur: Any) -> List[Dict[str, Any]]:
    """
    Merkez stok kartı (3 katman):
      - siparis_adet: sipariş taleplerindeki kalem toplamı
      - sevk_adet: merkez_stok_sevk (merkez->şube gönderilen)
      - kullanilan_adet: operasyon_defter URUN_AC (şubenin kullandığı)
      - kalan_adet: sevk - kullanılan (şubede kalan/depo)

    STOK_KEYS kalemlerine ek olarak siparis_katalog ürünleri de dahil edilir
    (siparis_talep.kalemler'de görünen ancak STOK_KEYS'e map edilemeyen ürünler).
    """
    siparis = _zero_stok()
    # Katalog ürünleri için: {norm_key: {ad, adet}}
    katalog_siparis: Dict[str, Dict[str, Any]] = {}

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
            urun_ad = str(it.get("urun_ad") or "").strip()
            if not urun_ad:
                continue
            key = _stok_key_from_urun_ad(urun_ad)
            if key:
                try:
                    siparis[key] += max(0, int(it.get("adet") or 0))
                except (TypeError, ValueError):
                    pass
            else:
                # Katalog ürünü — STOK_KEYS dışı, sadece siparis_adet takibi
                norm = urun_ad.lower().replace(" ", "_").replace("ş", "s").replace(
                    "ı", "i").replace("ğ", "g").replace("ü", "u").replace(
                    "ö", "o").replace("ç", "c")
                # Alfanümerik + _ karakterleri koru
                norm = "".join(c if c.isalnum() or c == "_" else "_" for c in norm)
                norm = f"katalog__{norm}"
                if norm not in katalog_siparis:
                    katalog_siparis[norm] = {"ad": urun_ad, "adet": 0}
                try:
                    katalog_siparis[norm]["adet"] += max(0, int(it.get("adet") or 0))
                except (TypeError, ValueError):
                    pass

    # Aktif katalog ürünlerini de ekle (hiç sipariş edilmemiş olsa bile göster)
    # Ayrıca siparis_talep'teki urun_ad eşleşmelerini katalog ID'siyle düzelt
    try:
        cur.execute(
            """
            SELECT k.kod AS kat_kod, u.norm_ad, u.ad
            FROM siparis_urun u
            JOIN siparis_kategori k ON k.id = u.kategori_id
            WHERE u.aktif = TRUE
            ORDER BY k.kod, u.sira, u.ad
            """
        )
        for ru in cur.fetchall():
            kat_kod = str(ru.get("kat_kod") or "").strip()
            norm_ad = str(ru.get("norm_ad") or "").strip()
            ad = str(ru.get("ad") or "").strip()
            if not norm_ad or not ad or not kat_kod:
                continue
            # Kategori kodu + norm_ad ile unique key
            norm_key = f"katalog__{kat_kod}__{norm_ad}"
            if norm_key not in katalog_siparis:
                # urun_ad bazlı eşleşmeyi katalog key'iyle güncelle
                # (siparis_talep'ten oluşturulan basit norm ile üst üste gelebilir)
                katalog_siparis[norm_key] = {"ad": ad, "adet": 0}
                # Basit norm anahtarı varsa adetini aktar ve sil
                simple_key = "katalog__" + "".join(
                    c if c.isalnum() or c == "_" else "_"
                    for c in ad.lower().replace(" ", "_").replace("ş", "s").replace(
                        "ı", "i").replace("ğ", "g").replace("ü", "u").replace(
                        "ö", "o").replace("ç", "c")
                )
                if simple_key in katalog_siparis and simple_key != norm_key:
                    katalog_siparis[norm_key]["adet"] += katalog_siparis.pop(simple_key)["adet"]
    except Exception:
        pass

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

    for norm_key, info in katalog_siparis.items():
        rows.append(
            {
                "kalem_kodu": norm_key,
                "kalem_adi": info["ad"],
                "siparis_adet": int(info["adet"]),
                "sevk_adet": 0,
                "kullanilan_adet": 0,
                "kalan_adet": 0,
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
    Tespit edilen uyarılar sube_operasyon_uyari tablosuna upsert edilir (audit trail).
    """
    from datetime import date as _date
    bugun = _date.today().isoformat()
    sevk = sum_urun_sevk_bugun(cur, sube_id)
    ac = sum_urun_ac_bugun(cur, sube_id)
    out: List[Dict[str, Any]] = []
    for k in STOK_KEYS:
        s, a = sevk[k], ac[k]
        uid = f"sevk-ac-{sube_id}-{bugun}-{k}"
        if a > s:
            lab = STOK_LABEL_TR.get(k, k)
            msg = (
                f"{lab}: sevk kaydı yok ama {a} açıldı — depoda olmayan ürün açılmış olabilir"
                if s <= 0
                else f"{lab}: {s} sevk edildi ama {a} açıldı — fazla açılmış olabilir"
            )
            fark = float(a - s)
            try:
                cur.execute(
                    """
                    INSERT INTO sube_operasyon_uyari (id, sube_id, tarih, tip, seviye, fark_tl, mesaj)
                    VALUES (%s, %s, CURRENT_DATE, 'URUN_AC_UYUMSUZLUK', 'kritik', %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                        mesaj   = EXCLUDED.mesaj,
                        fark_tl = EXCLUDED.fark_tl,
                        okundu  = FALSE
                    """,
                    (uid, sube_id, fark, msg),
                )
            except Exception:
                pass  # DB yazımı başarısız olsa da sanal liste dönmeye devam eder
            out.append({
                "id": uid,
                "tip": "URUN_AC_UYUMSUZLUK",
                "seviye": "kritik",
                "mesaj": msg,
                "fark_tl": fark,
                "okundu": False, "olusturma": None, "kaynak": "stok_motor",
                "beklenen_tl": None, "gercek_tl": None,
            })
        else:
            # Uyumsuzluk giderildi — günün kaydını temizle
            try:
                cur.execute(
                    "DELETE FROM sube_operasyon_uyari WHERE id=%s",
                    (uid,),
                )
            except Exception:
                pass
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


def haftalik_fire_hesapla(cur: Any, sube_id: str, hafta_baslangic: "date") -> Dict[str, Any]:
    """
    Kalem bazlı haftalık fire oranı hesapla → sube_fire_haftalik'e UPSERT.

    Cebir (her kalem k için):
      teorik_tuketim[k] = acilis[k] + hafta_ici_stok_ekle[k] - kapanis[k]
      urun_ac[k]        = hafta içi URUN_AC toplamı
      fire[k]           = teorik_tuketim[k] - urun_ac[k]   (+ → kayıp, - → fazla açma)
      fire_oran[k]      = fire[k] / max(1, teorik_tuketim[k]) * 100

    Hafta kapanışı: Pazar günü (veya bulunan son kapanış günü).
    Uyarı eşiği: toplam fire_oran ≥ %10 ve en az bir kalem ≥ %15 → FIRE_HAFTALIK yazar.
    """
    from datetime import timedelta as _td
    gunler = [hafta_baslangic + _td(days=i) for i in range(7)]
    hafta_sonu = gunler[-1]

    acilis = acilis_stok_tarih(cur, sube_id, hafta_baslangic)
    if acilis is None:
        return {"yazildi": False, "sebep": "acilis_yok"}

    # En son kapanış stokunu bul (Pazar'dan Pazartesi'ye geriye)
    kapanis = None
    hafta_kapanis_gun = hafta_baslangic
    for gun in reversed(gunler):
        cur.execute(
            """
            SELECT meta FROM sube_operasyon_event
            WHERE sube_id=%s AND tarih=%s AND tip='KAPANIS' AND durum='tamamlandi'
            ORDER BY cevap_ts DESC LIMIT 1
            """,
            (sube_id, gun),
        )
        r = cur.fetchone()
        if r:
            kap = stok_from_event_meta(r.get("meta"), "kapanis_stok_sayim")
            if kap is not None:
                kapanis = kap
                hafta_kapanis_gun = gun
                break

    if kapanis is None:
        return {"yazildi": False, "sebep": "kapanis_yok"}

    # Hafta içi toplamlar (Pazartesi'den hafta_kapanis_gun dahil)
    toplam_ekle = _zero_stok()
    toplam_ac = _zero_stok()
    for gun in gunler:
        ekle_gun = sum_urun_stok_ekle_tarih(cur, sube_id, gun)
        ac_gun = sum_urun_ac_tarih(cur, sube_id, gun)
        for k in STOK_KEYS:
            toplam_ekle[k] += ekle_gun[k]
            toplam_ac[k] += ac_gun[k]
        if gun >= hafta_kapanis_gun:
            break

    # Kalem bazlı fire
    fire_kalemler: Dict[str, Any] = {}
    for k in STOK_KEYS:
        teorik = acilis[k] + toplam_ekle[k] - kapanis[k]
        ac = toplam_ac[k]
        fire = teorik - ac
        oran = round(fire / max(1, teorik) * 100, 1) if teorik > 0 else 0.0
        fire_kalemler[k] = {
            "acilis": acilis[k],
            "kapanis": kapanis[k],
            "girisler": toplam_ekle[k],
            "teorik_tuketim": teorik,
            "urun_ac": ac,
            "fire": fire,
            "fire_oran": oran,
            "label": STOK_LABEL_TR.get(k, k),
        }

    toplam_teorik = sum(v["teorik_tuketim"] for v in fire_kalemler.values())
    toplam_fire = sum(v["fire"] for v in fire_kalemler.values())
    toplam_oran = round(toplam_fire / max(1, toplam_teorik) * 100, 2) if toplam_teorik > 0 else 0.0

    cur.execute(
        """
        INSERT INTO sube_fire_haftalik
            (id, sube_id, hafta_baslangic, hafta_bitis, kalemler,
             toplam_fire, toplam_teorik, fire_oran, guncelleme)
        VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s, %s, NOW())
        ON CONFLICT (sube_id, hafta_baslangic) DO UPDATE SET
            kalemler      = EXCLUDED.kalemler,
            toplam_fire   = EXCLUDED.toplam_fire,
            toplam_teorik = EXCLUDED.toplam_teorik,
            fire_oran     = EXCLUDED.fire_oran,
            guncelleme    = NOW()
        """,
        (
            str(uuid.uuid4()), sube_id, hafta_baslangic, hafta_sonu,
            json.dumps(fire_kalemler, ensure_ascii=False),
            toplam_fire, toplam_teorik, toplam_oran,
        ),
    )

    # Yüksek fire varsa FIRE_HAFTALIK uyarısı
    yuksek = [k for k, v in fire_kalemler.items() if v["teorik_tuketim"] > 0 and v["fire_oran"] >= 15]
    if yuksek and toplam_oran >= 10:
        cur.execute(
            "SELECT 1 FROM sube_operasyon_uyari WHERE sube_id=%s AND tip='FIRE_HAFTALIK' AND tarih=%s LIMIT 1",
            (sube_id, hafta_sonu),
        )
        if not cur.fetchone():
            detay = "; ".join(
                f"{fire_kalemler[k]['label']} %{fire_kalemler[k]['fire_oran']:.0f}"
                for k in yuksek[:4]
            )
            seviye = "kritik" if toplam_oran >= 20 else "uyari"
            cur.execute(
                """
                INSERT INTO sube_operasyon_uyari
                    (id, sube_id, tarih, tip, seviye, fark_tl, mesaj)
                VALUES (%s, %s, %s, 'FIRE_HAFTALIK', %s, %s, %s)
                """,
                (
                    str(uuid.uuid4()), sube_id, hafta_sonu, seviye,
                    float(toplam_fire),
                    f"Haftalık fire %%{toplam_oran:.0f}: {detay}",
                ),
            )

    return {
        "yazildi": True,
        "hafta_baslangic": str(hafta_baslangic),
        "hafta_bitis": str(hafta_sonu),
        "fire_oran": toplam_oran,
        "toplam_fire": toplam_fire,
        "toplam_teorik": toplam_teorik,
        "kalemler": fire_kalemler,
    }


def fire_tespiti_kontrol_yaz(cur: Any, sube_id: str) -> None:
    """
    Kapanış sonrası POS/ciro × stok tüketimi çapraz cebiri.
    Mantık: tarihsel (ciro / tüketim_birimi) oranı hesapla; bugün bu oran
    %30+ düşükse → ürün tüketilmiş ama satış yansımamış (fire şüphesi).
    Kaynak: ciro.toplam + sube_operasyon_ozet.satis_tahmini_toplam
    Eşik: ≥%30 düşük → uyari; ≥%50 düşük → kritik
    Veri: en az 5 günlük geçmiş (ciro + özet) çifti gerekli.
    """
    cur.execute(
        "SELECT 1 FROM sube_operasyon_uyari WHERE sube_id=%s AND tip='FIRE_TESPITI' AND tarih=CURRENT_DATE LIMIT 1",
        (sube_id,),
    )
    if cur.fetchone():
        return

    # Bugünkü ciro
    cur.execute(
        "SELECT COALESCE(SUM(toplam), 0) AS bugun FROM ciro WHERE sube_id=%s AND durum='aktif' AND tarih=CURRENT_DATE",
        (sube_id,),
    )
    rb = cur.fetchone()
    bugun_ciro = float(rb.get("bugun") or 0) if rb else 0.0
    if bugun_ciro <= 0:
        return

    # Bugünkü tüketim tahmini (kapanışta sube_operasyon_ozet_yaz tarafından yazıldı)
    cur.execute(
        "SELECT COALESCE(satis_tahmini_toplam, 0) AS tuketim FROM sube_operasyon_ozet WHERE sube_id=%s AND tarih=CURRENT_DATE",
        (sube_id,),
    )
    ro = cur.fetchone()
    bugun_tuketim = int(ro.get("tuketim") or 0) if ro else 0
    if bugun_tuketim <= 0:
        # Fallback: URUN_AC toplamı (live)
        ac_dict = sum_urun_ac_bugun(cur, sube_id)
        bugun_tuketim = sum(ac_dict.values())
    if bugun_tuketim <= 0:
        return

    # Geçmiş 14 gün: (ciro, tuketim) çiftleri — her ikisi de > 0 olan günler
    cur.execute(
        """
        SELECT c.tarih,
               COALESCE(SUM(c.toplam), 0)          AS ciro_toplam,
               COALESCE(o.satis_tahmini_toplam, 0) AS tuketim_toplam
        FROM ciro c
        JOIN sube_operasyon_ozet o ON o.sube_id = c.sube_id AND o.tarih = c.tarih
        WHERE c.sube_id = %s
          AND c.durum   = 'aktif'
          AND c.tarih  >= CURRENT_DATE - INTERVAL '14 days'
          AND c.tarih   < CURRENT_DATE
          AND o.satis_tahmini_toplam > 0
        GROUP BY c.tarih, o.satis_tahmini_toplam
        HAVING COALESCE(SUM(c.toplam), 0) > 0
        """,
        (sube_id,),
    )
    rows = cur.fetchall()
    if len(rows) < 5:
        return  # yetersiz geçmiş veri

    oranlar = [
        float(r["ciro_toplam"]) / float(r["tuketim_toplam"])
        for r in rows
        if float(r.get("tuketim_toplam") or 0) > 0
    ]
    if len(oranlar) < 5:
        return

    ort_oran = sum(oranlar) / len(oranlar)  # TL / birim
    if ort_oran <= 0:
        return

    bugun_oran = bugun_ciro / bugun_tuketim
    sapma = (bugun_oran - ort_oran) / ort_oran  # negatif → ciro düşük

    if sapma >= -0.30:
        return  # normal aralık

    beklenen_ciro = round(ort_oran * bugun_tuketim, 2)
    fark = round(bugun_ciro - beklenen_ciro, 2)  # negatif (kayıp)
    seviye = "kritik" if sapma <= -0.50 else "uyari"
    mesaj = (
        f"Olası fire: {bugun_tuketim} birim tüketildi, "
        f"beklenen ciro ~{beklenen_ciro:,.0f}₺ iken gerçek {bugun_ciro:,.0f}₺ "
        f"(%{abs(sapma) * 100:.0f} düşük — açıklanamayan kayıp ~{abs(fark):,.0f}₺)"
    )
    cur.execute(
        """
        INSERT INTO sube_operasyon_uyari
            (id, sube_id, tarih, tip, seviye, fark_tl, beklenen_tl, gercek_tl, mesaj)
        VALUES (%s, %s, CURRENT_DATE, 'FIRE_TESPITI', %s, %s, %s, %s, %s)
        """,
        (str(uuid.uuid4()), sube_id, seviye, fark, beklenen_ciro, bugun_ciro, mesaj),
    )


_PATTERN_IZLE: frozenset = frozenset({
    "STOK_ALARM",
    "URUN_AC_UYUMSUZLUK",
    "FIRE_TESPITI",
    "ACILIS_KASA_FARK",
    "ACILIS_STOK_FARK",
    "SATIS_ANOMALI",
    "SIPARIS_RED",
})

_PATTERN_ETIKET: Dict[str, str] = {
    "STOK_ALARM":         "Depo stok alarmı",
    "URUN_AC_UYUMSUZLUK": "Karşılıksız ürün açma",
    "FIRE_TESPITI":       "Satış/tüketim firesi",
    "ACILIS_KASA_FARK":   "Açılış kasa farkı",
    "ACILIS_STOK_FARK":   "Açılış stok farkı",
    "SATIS_ANOMALI":      "Satış anomalisi",
    "SIPARIS_RED":        "Sipariş red bildirimi",
}


def pattern_uyari_kontrol_yaz(cur: Any, sube_id: str) -> None:
    """
    Son 7 günde (bugün hariç) aynı uyarı tipinden ≥3 farklı gün tespit varsa
    PATTERN_UYARI yazar. Kapanışta çağrılır; günde bir kez, tip başına bir kayıt.
    Eşik: ≥3 gün → uyari; ≥5 gün → kritik.
    """
    # Bugün bu kaynak tipler için zaten PATTERN_UYARI yazılmış mı?
    cur.execute(
        "SELECT mesaj FROM sube_operasyon_uyari WHERE sube_id=%s AND tarih=CURRENT_DATE AND tip='PATTERN_UYARI'",
        (sube_id,),
    )
    yazili_mesajlar = [str(r.get("mesaj") or "") for r in cur.fetchall()]

    cur.execute(
        """
        SELECT tip, COUNT(DISTINCT tarih) AS gun_sayisi
        FROM sube_operasyon_uyari
        WHERE sube_id = %s
          AND tarih >= CURRENT_DATE - INTERVAL '7 days'
          AND tarih  < CURRENT_DATE
          AND tip    = ANY(%s)
        GROUP BY tip
        HAVING COUNT(DISTINCT tarih) >= 3
        ORDER BY COUNT(DISTINCT tarih) DESC
        """,
        (sube_id, list(_PATTERN_IZLE)),
    )
    for r in cur.fetchall():
        kaynak_tip = str(r.get("tip") or "")
        gun = int(r.get("gun_sayisi") or 0)
        if any(kaynak_tip in m for m in yazili_mesajlar):
            continue
        etiket = _PATTERN_ETIKET.get(kaynak_tip, kaynak_tip)
        seviye = "kritik" if gun >= 5 else "uyari"
        mesaj = (
            f"Tekrarlayan uyarı [{kaynak_tip}]: {etiket} "
            f"son 7 günde {gun} farklı günde tespit edildi — kök neden araştırılmalı."
        )
        cur.execute(
            """
            INSERT INTO sube_operasyon_uyari
                (id, sube_id, tarih, tip, seviye, mesaj)
            VALUES (%s, %s, CURRENT_DATE, 'PATTERN_UYARI', %s, %s)
            """,
            (str(uuid.uuid4()), sube_id, seviye, mesaj),
        )


def satis_anomali_kontrol_yaz(cur: Any, sube_id: str) -> None:
    """
    Kapanış sonrası: bugünkü ciro son 14 günün ortalamasından ±%30 sapıyorsa
    SATIS_ANOMALI uyarısı yazar (günde bir kez, aynı gün varsa atlar).
    En az 5 günlük geçmiş veri yoksa hesap yapılmaz.
    """
    # Zaten bugün yazılmış mı?
    cur.execute(
        "SELECT 1 FROM sube_operasyon_uyari WHERE sube_id=%s AND tip='SATIS_ANOMALI' AND tarih=CURRENT_DATE LIMIT 1",
        (sube_id,),
    )
    if cur.fetchone():
        return

    # Geçmiş 14 gün ortalaması (bugün hariç, sıfır olmayan günler)
    cur.execute(
        """
        SELECT COALESCE(AVG(toplam), 0) AS ortalama, COUNT(*) AS gun_sayisi
        FROM ciro
        WHERE sube_id = %s
          AND durum = 'aktif'
          AND tarih >= CURRENT_DATE - INTERVAL '14 days'
          AND tarih < CURRENT_DATE
          AND toplam > 0
        """,
        (sube_id,),
    )
    r = cur.fetchone()
    if not r or int(r.get("gun_sayisi") or 0) < 5:
        return  # yetersiz geçmiş veri

    ortalama = float(r.get("ortalama") or 0)
    if ortalama <= 0:
        return

    # Bugünkü ciro
    cur.execute(
        "SELECT COALESCE(SUM(toplam), 0) AS bugun FROM ciro WHERE sube_id=%s AND durum='aktif' AND tarih=CURRENT_DATE",
        (sube_id,),
    )
    rb = cur.fetchone()
    bugun_ciro = float(rb.get("bugun") or 0) if rb else 0.0
    if bugun_ciro <= 0:
        return

    sapma_oran = (bugun_ciro - ortalama) / ortalama
    if abs(sapma_oran) < 0.30:
        return

    yon = "yüksek" if sapma_oran > 0 else "düşük"
    seviye = "kritik" if abs(sapma_oran) >= 0.50 else "uyari"
    mesaj = (
        f"Satış anomalisi: bugün {bugun_ciro:,.0f}₺, "
        f"14 günlük ort. {ortalama:,.0f}₺ — "
        f"%{abs(sapma_oran)*100:.0f} {yon} ({yon.upper()})"
    )
    cur.execute(
        """
        INSERT INTO sube_operasyon_uyari
            (id, sube_id, tarih, tip, seviye, fark_tl, beklenen_tl, gercek_tl, mesaj)
        VALUES (%s, %s, CURRENT_DATE, 'SATIS_ANOMALI', %s, %s, %s, %s, %s)
        """,
        (
            str(uuid.uuid4()), sube_id, seviye,
            round(bugun_ciro - ortalama, 2),
            round(ortalama, 2),
            round(bugun_ciro, 2),
            mesaj,
        ),
    )


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

    # database.py / operasyon_merkez_api ile aynı kolonlar: satis_tahmini_*
    cur.execute(
        """
        INSERT INTO sube_operasyon_ozet
            (sube_id, tarih, satis_tahmini_toplam, satis_tahmini_kalemler, guncelleme)
        VALUES
            (%s, CURRENT_DATE, %s, %s::jsonb, NOW())
        ON CONFLICT (sube_id, tarih)
        DO UPDATE SET
            satis_tahmini_toplam = EXCLUDED.satis_tahmini_toplam,
            satis_tahmini_kalemler = EXCLUDED.satis_tahmini_kalemler,
            guncelleme = NOW()
        """,
        (
            sube_id,
            int(toplam),
            json.dumps(satis, ensure_ascii=False, separators=(",", ":")),
        ),
    )
    return {
        "yazildi": True,
        "satis_tahmini_toplam": int(toplam),
        "satis_tahmini_kalemler": satis,
    }


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


# ══════════════════════════════════════════════════════════════════
# STOK DİSİPLİN MOTORU
# Amaç: stok saymak değil, davranış + sipariş akışını kontrol etmek.
#
# AKIŞ: SIPARIS_OLUSTU → TAHSIS_TAM/KISMI/YOK → SEVK_CIKTI → KABUL_TAM/EKSIK → KULLANIM
# 3 STOK GERÇEĞİ: merkez_stok_kart | stok_yolda | sube_depo_stok
#
# Tablo eşlemeleri (duplike tablo YOK):
#   olay logu      → operasyon_defter   (etiket = olay adı)
#   davranış uyarı → sube_operasyon_uyari (tip='DAVRANIS', yeni: kural/puan kolonları)
#   tahsis kararı  → siparis_talep.kalem_durumlari JSONB + tahsis_* kolonları
#   merkez stok    → merkez_stok_kart   (yeni: mevcut_adet/rezerve_adet/min_stok)
#   yoldaki stok   → stok_yolda         (yeni tablo — gerçekten yeni kavram)
#   şube depo      → sube_depo_stok     (yeni tablo — gerçekten yeni kavram)
#   aylık skor     → sube_skor          (yeni tablo — gerçekten yeni kavram)
# ══════════════════════════════════════════════════════════════════

OLAY_SIPARIS_OLUSTU  = "SIPARIS_OLUSTU"
OLAY_TAHSIS_TAM      = "TAHSIS_TAM"
OLAY_TAHSIS_KISMI    = "TAHSIS_KISMI"
OLAY_TAHSIS_YOK      = "TAHSIS_YOK"
OLAY_SEVK_CIKTI      = "SEVK_CIKTI"
OLAY_KABUL_TAM       = "KABUL_TAM"
OLAY_KABUL_EKSIK     = "KABUL_EKSIK"
OLAY_KULLANIM        = "KULLANIM"

KURAL_GEREKSIZ_SIPARIS = "GEREKSIZ_SIPARIS"
KURAL_EKSIK_KULLANIM   = "EKSIK_KULLANIM"
KURAL_FAZLA_FREKANS    = "FAZLA_FREKANS"
KURAL_KABUL_FARKI      = "KABUL_FARKI"

KURAL_PUAN = {
    KURAL_GEREKSIZ_SIPARIS: 3,
    KURAL_EKSIK_KULLANIM:   2,
    KURAL_FAZLA_FREKANS:    2,
    KURAL_KABUL_FARKI:      3,
}

SKOR_SINIR_DIKKAT    = 4
SKOR_SINIR_PROBLEMLI = 7
STOK_ALARM_KRITIK    = "KRITIK"
STOK_ALARM_KRIZ      = "KRIZ"
STOK_ALARM_DUSUK     = "DUSUK"
FREKANS_GUN          = 14
FREKANS_ESIK         = 3

KURAL_MESAJ = {
    KURAL_GEREKSIZ_SIPARIS: "Depoda stok varken sipariş verildi",
    KURAL_EKSIK_KULLANIM:   "Stok var gözüküyor ama yeni sipariş geliyor — kullanım girilmiyor",
    KURAL_FAZLA_FREKANS:    "Aynı ürün çok sık sipariş ediliyor",
    KURAL_KABUL_FARKI:      "Gönderilen ile teslim alınan adet uyuşmuyor; anlaşmazlıkta operasyona bilgi verin (gerekirse kısa video)",
}


# ── Yardımcı: olay logu (operasyon_defter kullanır) ──────────────

def _disiplin_olay_yaz(cur: Any, siparis_talep_id: Optional[str],
                        sube_id: Optional[str], olay: str,
                        yapan_id: Optional[str] = None,
                        yapan_ad: Optional[str] = None,
                        detay: Optional[dict] = None) -> str:
    """Sipariş akış olayını operasyon_defter'a yazar (etiket = olay adı)."""
    oid = str(uuid.uuid4())
    aciklama = json.dumps(detay or {}, ensure_ascii=False) if detay else ""
    # operasyon_defter.sube_id NOT NULL — siparis_talep'ten al
    hedef_sube = sube_id
    if not hedef_sube and siparis_talep_id:
        cur.execute("SELECT sube_id FROM siparis_talep WHERE id=%s", (siparis_talep_id,))
        r = cur.fetchone()
        if r:
            hedef_sube = r.get("sube_id") or r[0]
    if not hedef_sube:
        return oid  # sube_id olmadan deftere yazılamaz
    cur.execute(
        """
        INSERT INTO operasyon_defter
            (id, sube_id, etiket, aciklama, ref_event_id, personel_id, personel_ad)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (oid, hedef_sube, olay, aciklama, siparis_talep_id, yapan_id, yapan_ad),
    )
    return oid


# ── Yardımcı: davranış uyarısı (sube_operasyon_uyari kullanır) ───

def _davranis_uyari_yaz(cur: Any, sube_id: str, kural: str,
                         siparis_talep_id: Optional[str] = None,
                         kalem_kodu: Optional[str] = None,
                         detay: Optional[dict] = None) -> None:
    """Davranış ihlalini sube_operasyon_uyari tablosuna yazar (tip='DAVRANIS')."""
    puan   = KURAL_PUAN.get(kural, 1)
    mesaj  = KURAL_MESAJ.get(kural, kural)
    if detay:
        mesaj += " — " + json.dumps(detay, ensure_ascii=False)[:400]
    seviye = "kritik" if puan >= 3 else "uyari"
    cur.execute(
        """
        INSERT INTO sube_operasyon_uyari
            (id, sube_id, tip, seviye, mesaj, kural, puan, siparis_talep_id, kalem_kodu, detay)
        VALUES (%s, %s, 'DAVRANIS', %s, %s, %s, %s, %s, %s, %s)
        """,
        (str(uuid.uuid4()), sube_id, seviye, mesaj[:1900],
         kural, puan, siparis_talep_id, kalem_kodu,
         json.dumps(detay or {}, ensure_ascii=False) if detay else None),
    )


# ── Aşama 1: Sipariş oluştu ───────────────────────────────────────

def siparis_olustu_kaydet(cur: Any, siparis_talep_id: str, sube_id: str,
                           kalemler: List[Dict[str, Any]],
                           yapan_id: Optional[str] = None,
                           yapan_ad: Optional[str] = None) -> None:
    _disiplin_olay_yaz(cur, siparis_talep_id, sube_id, OLAY_SIPARIS_OLUSTU,
                        yapan_id, yapan_ad, {"kalemler": kalemler})
    _kontrol_gereksiz_siparis(cur, sube_id, siparis_talep_id, kalemler)
    _kontrol_fazla_frekans(cur, sube_id, siparis_talep_id, kalemler)


def _kontrol_gereksiz_siparis(cur: Any, sube_id: str, siparis_talep_id: str,
                                kalemler: List[Dict[str, Any]]) -> None:
    for k in kalemler:
        kalem_kodu = str(k.get("kalem_kodu") or k.get("urun_ad") or "").strip()
        talep_adet = max(0, int(k.get("adet") or 0))
        if not kalem_kodu or talep_adet <= 0:
            continue
        cur.execute(
            "SELECT mevcut_adet, min_stok FROM sube_depo_stok WHERE sube_id=%s AND kalem_kodu=%s",
            (sube_id, kalem_kodu),
        )
        r = cur.fetchone()
        if not r:
            continue
        mevcut = int(r.get("mevcut_adet") or 0)
        min_s  = int(r.get("min_stok") or 0)
        if mevcut >= max(1, min_s * 2):
            _davranis_uyari_yaz(cur, sube_id, KURAL_GEREKSIZ_SIPARIS,
                                siparis_talep_id, kalem_kodu,
                                {"mevcut": mevcut, "min_stok": min_s, "talep": talep_adet})


def _kontrol_fazla_frekans(cur: Any, sube_id: str, siparis_talep_id: str,
                             kalemler: List[Dict[str, Any]]) -> None:
    for k in kalemler:
        kalem_kodu = str(k.get("kalem_kodu") or k.get("urun_ad") or "").strip()
        if not kalem_kodu:
            continue
        # kalem_durumlari JSONB içinde kalem_kodu geçen sipariş sayısını say
        cur.execute(
            """
            SELECT COUNT(*) FROM siparis_talep
            WHERE sube_id = %s
              AND tarih >= CURRENT_DATE - (%s * INTERVAL '1 day')
              AND durum != 'iptal'
              AND kalem_durumlari @> %s::jsonb
            """,
            (sube_id, FREKANS_GUN,
             json.dumps([{"kalem_kodu": kalem_kodu}])),
        )
        sayi = int((cur.fetchone() or {}).get("count") or 0)
        if sayi >= FREKANS_ESIK:
            _davranis_uyari_yaz(cur, sube_id, KURAL_FAZLA_FREKANS,
                                siparis_talep_id, kalem_kodu,
                                {"son_gun": FREKANS_GUN, "siparis_sayisi": sayi})

# ── Çift sipariş (teslim öncesi ikinci talep) bilgi / uyarı ────────

def siparis_kalem_item_key(k: Dict[str, Any]) -> Optional[str]:
    uid = str(k.get("urun_id") or "").strip()
    if uid:
        return f"id:{uid}"
    ad = str(k.get("urun_ad") or "").strip().lower()
    if ad:
        return f"ad:{ad}"
    kk = str(k.get("kalem_kodu") or "").strip().lower()
    if kk:
        return f"kk:{kk}"
    return None


def siparis_kalem_gosterim_etiketi(k: Dict[str, Any]) -> str:
    ad = str(k.get("urun_ad") or k.get("kalem_adi") or "").strip()
    if ad:
        return ad[:120]
    kk = str(k.get("kalem_kodu") or "").strip()
    if kk:
        return kk[:120]
    return "Ürün"


def siparis_kalem_anahtar_map(kalemler: List[Any]) -> Dict[str, str]:
    """Anahtar → ekranda gösterilecek kısa ürün adı."""
    m: Dict[str, str] = {}
    for k in kalemler or []:
        if not isinstance(k, dict):
            continue
        ak = siparis_kalem_item_key(k)
        if ak and ak not in m:
            m[ak] = siparis_kalem_gosterim_etiketi(k)
    return m


def siparis_onceki_acik_pred_row(
    cur: Any,
    sube_id: str,
    bu_id: str,
    bu_olusturma: Any,
) -> Optional[Dict[str, Any]]:
    """Bu talepten zaman sırasıyla önce gelen, hâlâ teslim edilmemiş en yakın sipariş."""
    cur.execute(
        """
        SELECT id, kalemler, olusturma
        FROM siparis_talep
        WHERE sube_id=%s
          AND durum NOT IN ('teslim_edildi','iptal')
          AND id <> %s
          AND ROW(
                COALESCE(olusturma, TIMESTAMPTZ '-infinity'),
                id::text
              )
              < ROW(
                COALESCE(%s::timestamptz, TIMESTAMPTZ '-infinity'),
                %s::text
              )
        ORDER BY olusturma DESC NULLS LAST, id DESC
        LIMIT 1
        """,
        (sube_id, bu_id, bu_olusturma, bu_id),
    )
    r = cur.fetchone()
    return dict(r) if r else None


def siparis_acik_en_son_talep(cur: Any, sube_id: str) -> Optional[Dict[str, Any]]:
    """Şubede teslim bekleyen en yeni sipariş (yeni talep gönderilmeden önceki kontrol için)."""
    cur.execute(
        """
        SELECT id, kalemler, olusturma, durum
        FROM siparis_talep
        WHERE sube_id=%s AND durum NOT IN ('teslim_edildi','iptal')
        ORDER BY olusturma DESC NULLS LAST, id DESC
        LIMIT 1
        """,
        (sube_id,),
    )
    r = cur.fetchone()
    return dict(r) if r else None


def siparis_kalemler_ortak_etiketler_liste(
    kalemler_yeni: List[Any],
    kalemler_onceki: List[Any],
) -> List[str]:
    m_y = siparis_kalem_anahtar_map(kalemler_yeni)
    m_o = siparis_kalem_anahtar_map(kalemler_onceki)
    ortak_keys: Set[str] = set(m_y.keys()) & set(m_o.keys())
    etik = [m_y[k] for k in sorted(ortak_keys)]
    return etik


def siparis_cift_gonderim_bilgi_notu(
    cur: Any,
    *,
    talep_id: str,
    sube_id: str,
    kalemler: List[Any],
    olusturma: Any,
) -> Optional[str]:
    """
    Kayıtlı talep için: daha önce gönderilmiş ve teslimi bekleyen sipariş varsa bilgi metni.
    Operasyon merkezi kartlarında kullanılır.
    """
    pred = siparis_onceki_acik_pred_row(cur, sube_id, talep_id, olusturma)
    if not pred:
        return None
    pk = pred.get("kalemler") or []
    if isinstance(pk, str):
        try:
            pk = json.loads(pk)
        except Exception:
            pk = []
    if not isinstance(pk, list):
        pk = []
    etik = siparis_kalemler_ortak_etiketler_liste(kalemler, pk)
    pid_k = str(pred.get("id") or "")[:8]
    if etik:
        oz = ", ".join(etik[:12])
        if len(etik) > 12:
            oz += "…"
        return (
            f"Teslimi tamamlanmamış önceki sipariş var (önceki talep …{pid_k}). "
            f"Ortak ürünler: {oz}. İki talebi karşılaştırın."
        )
    return (
        f"Teslimi tamamlanmamış önceki sipariş var (önceki talep …{pid_k}). "
        "Ürün örtüşmesi görünmüyor; yine de iki talebi gözden geçirin."
    )


def sube_yeni_siparis_oncesi_cift_kontrol(
    cur: Any,
    sube_id: str,
    kalemler_yeni: List[Dict[str, Any]],
) -> Tuple[int, Optional[str], Optional[str], List[str]]:
    """
    INSERT öncesi: açık sipariş sayısı, en son açık talep id, uyarı özeti, ortak ürün etiketleri.
    """
    cur.execute(
        """
        SELECT COUNT(*) AS c FROM siparis_talep
        WHERE sube_id=%s AND durum NOT IN ('teslim_edildi','iptal')
        """,
        (sube_id,),
    )
    acik = int((cur.fetchone() or {}).get("c") or 0)
    if acik <= 0:
        return 0, None, None, []
    son = siparis_acik_en_son_talep(cur, sube_id)
    if not son:
        return acik, None, None, []
    oid = str(son.get("id") or "")
    pk = son.get("kalemler") or []
    if isinstance(pk, str):
        try:
            pk = json.loads(pk)
        except Exception:
            pk = []
    if not isinstance(pk, list):
        pk = []
    ortak = siparis_kalemler_ortak_etiketler_liste(kalemler_yeni, pk)
    oz = ", ".join(ortak[:10])
    if len(ortak) > 10:
        oz += "…"
    if ortak:
        uyari = (
            f"Daha önce verdiğiniz siparişlerin teslimi tamamlanmadı ({acik} açık talep). "
            f"Önceki siparişle ortak ürünler: {oz}. Tekrar göndermek istediğinize emin misiniz?"
        )
    else:
        uyari = (
            f"Daha önce verdiğiniz siparişlerin teslimi tamamlanmadı ({acik} açık talep). "
            "Ürün örtüşmesi görünmüyor; yine de devam etmek istediğinize emin misiniz?"
        )
    return acik, oid, uyari, ortak


# ── Sipariş kalemleri + merkez/şube stok (tek kaynak) ───────────────

def merkez_stok_kart_haritasi(cur: Any) -> Dict[str, Dict[str, Any]]:
    """kalem_kodu → {kalem_adi, mevcut_adet, rezerve_adet, min_stok}"""
    cur.execute(
        """
        SELECT kalem_kodu, kalem_adi,
               COALESCE(mevcut_adet, 0) AS mevcut_adet,
               COALESCE(rezerve_adet, 0) AS rezerve_adet,
               COALESCE(min_stok, 0) AS min_stok
        FROM merkez_stok_kart
        """
    )
    out: Dict[str, Dict[str, Any]] = {}
    for r in cur.fetchall() or []:
        kk = str(r.get("kalem_kodu") or "").strip()
        if not kk:
            continue
        out[kk] = {
            "kalem_adi": (r.get("kalem_adi") or kk or "").strip(),
            "mevcut_adet": int(r.get("mevcut_adet") or 0),
            "rezerve_adet": int(r.get("rezerve_adet") or 0),
            "min_stok": int(r.get("min_stok") or 0),
        }
    return out


def enrich_siparis_kalemleri_stok_inplace(
    cur: Any,
    sube_id: str,
    kalemler: List[Any],
    *,
    merkez_map: Optional[Dict[str, Dict[str, Any]]] = None,
    hedef_depo_sube_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Sipariş kalemlerine merkez / talep şubesi deposu / (varsa) sevkiyat hedef deposu stoklarını yazar.

    - Talep şubesi (sube_id): şube deposu — gereksiz talep (şubede zaten var) için.
    - Merkez stok kartı (merkez_map): hedef depo atanmamış klasik akışta çıkış referansı.
    - hedef_depo_sube_id dolu ise (operasyon hangi şubeye sevk ettiyse: Tema, Zafer, …),
      gönderim yeterliliği «merkez depo» mantığıyla o şubenin ``sube_depo_stok`` kayıtlarından
      hesaplanır; bu şube bu sipariş için fiziksel çıkış deposudur.

    Dönüş: stok_alarm_var, barem_risk_var, gereksiz_var, merkez_kayit_eksik_var,
    stok_hesap_kaynagi, hedef_depo_sube_id
    """
    if merkez_map is None:
        merkez_map = merkez_stok_kart_haritasi(cur)
    kodlar: List[str] = []
    for it in kalemler or []:
        if not isinstance(it, dict):
            continue
        kc = str(it.get("kalem_kodu") or it.get("urun_ad") or "").strip()
        if kc:
            kodlar.append(kc)
    sube_depo: Dict[str, int] = {}
    sid = (sube_id or "").strip()
    if sid and kodlar:
        cur.execute(
            """
            SELECT kalem_kodu, COALESCE(mevcut_adet, 0) AS mevcut_adet
            FROM sube_depo_stok
            WHERE sube_id = %s AND kalem_kodu = ANY(%s)
            """,
            (sid, kodlar),
        )
        for r in cur.fetchall() or []:
            kk = str(r.get("kalem_kodu") or "").strip()
            if kk:
                sube_depo[kk] = int(r.get("mevcut_adet") or 0)

    hid = (hedef_depo_sube_id or "").strip()
    hedef_depo_map: Dict[str, Dict[str, int]] = {}
    if hid and kodlar:
        cur.execute(
            """
            SELECT kalem_kodu,
                   COALESCE(mevcut_adet, 0) AS mevcut_adet,
                   COALESCE(rezerve_adet, 0) AS rezerve_adet,
                   COALESCE(min_stok, 0) AS min_stok
            FROM sube_depo_stok
            WHERE sube_id = %s AND kalem_kodu = ANY(%s)
            """,
            (hid, kodlar),
        )
        for r in cur.fetchall() or []:
            kk = str(r.get("kalem_kodu") or "").strip()
            if kk:
                hedef_depo_map[kk] = {
                    "mevcut": int(r.get("mevcut_adet") or 0),
                    "rezerve": int(r.get("rezerve_adet") or 0),
                    "min": int(r.get("min_stok") or 0),
                }

    stok_alarm = barem_risk = gereksiz = merkez_eksik = False
    for it in kalemler or []:
        if not isinstance(it, dict):
            continue
        kalem_kodu = str(it.get("kalem_kodu") or it.get("urun_ad") or "").strip()
        istenen = max(0, int(it.get("adet") or 0))
        mk = merkez_map.get(kalem_kodu) if kalem_kodu else None
        if mk:
            merkez_mevcut = int(mk.get("mevcut_adet") or 0)
            merkez_rezerve = int(mk.get("rezerve_adet") or 0)
            merkez_min = int(mk.get("min_stok") or 0)
        else:
            merkez_mevcut = -1
            merkez_rezerve = 0
            merkez_min = 0
            if kalem_kodu and istenen > 0:
                merkez_eksik = True
        sube_dep = int(sube_depo.get(kalem_kodu, 0)) if kalem_kodu else 0

        dep_row = hedef_depo_map.get(kalem_kodu) if hid else None
        if hid:
            kaynak_mevcut = int(dep_row["mevcut"]) if dep_row else 0
            kaynak_min = int(dep_row["min"]) if dep_row else 0
            kaynak_rezerve = int(dep_row.get("rezerve") or 0) if dep_row else 0
            hedef_dep_m = kaynak_mevcut
            hedef_min = kaynak_min
            hedef_rezerve = kaynak_rezerve
        else:
            kaynak_mevcut = merkez_mevcut if mk else -1
            kaynak_min = merkez_min if mk else 0
            kaynak_rezerve = merkez_rezerve if mk else 0
            hedef_dep_m = None
            hedef_min = None
            hedef_rezerve = None

        kullanilabilir = (kaynak_mevcut - max(0, kaynak_rezerve)) if kaynak_mevcut >= 0 else None
        kalan = (kullanilabilir - istenen) if kullanilabilir is not None else None
        alarm_merkez = kalan is not None and kalan <= 0
        merkez_barem_risk = (
            kalan is not None
            and kaynak_mevcut >= 0
            and kaynak_min > 0
            and kalan < kaynak_min
        )
        # Şubede “zaten yeter” uyarısı: talep kadarı yetiyorsa (>=) değil; en az 1 fazla olmalı (>).
        # Örn. 1 sipariş, depoda 1 adet → uyarı yok; depoda 2+ → anlamlı fazlalık.
        sube_zaten_var = istenen > 0 and sube_dep > istenen
        if alarm_merkez:
            stok_alarm = True
        if merkez_barem_risk:
            barem_risk = True
        if sube_zaten_var:
            gereksiz = True
        it["merkez_mevcut"] = merkez_mevcut
        it["merkez_rezerve"] = merkez_rezerve
        it["merkez_min_stok"] = merkez_min if mk else 0
        it["kaynak_kullanilabilir"] = kullanilabilir
        it["kalan_gonderince"] = kalan
        it["alarm_merkez"] = alarm_merkez
        it["merkez_barem_risk"] = merkez_barem_risk
        it["sube_depo_mevcut"] = sube_dep
        it["sube_zaten_var"] = sube_zaten_var
        it["merkez_kayit_yok"] = mk is None and bool(kalem_kodu)
        it["gonderim_kaynagi"] = "hedef_depo" if hid else "merkez_kart"
        if hid:
            it["hedef_depo_mevcut"] = hedef_dep_m
            it["hedef_depo_rezerve"] = hedef_rezerve
            it["hedef_depo_min_stok"] = hedef_min
        else:
            it["hedef_depo_mevcut"] = None
            it["hedef_depo_rezerve"] = None
            it["hedef_depo_min_stok"] = None

    return {
        "stok_alarm_var": stok_alarm,
        "barem_risk_var": barem_risk,
        "gereksiz_var": gereksiz,
        "merkez_kayit_eksik_var": merkez_eksik,
        "stok_hesap_kaynagi": "hedef_depo" if hid else "merkez_kart",
        "hedef_depo_sube_id": hid or None,
    }


# ── Aşama 2: Merkez tahsis ────────────────────────────────────────

def _siparis_satir_eslestirme_anahtari(r: Dict[str, Any]) -> str:
    return str(r.get("urun_id") or r.get("kalem_kodu") or "").strip()


def _looks_like_sevkiyat_kalem_satirlari(rows: Any) -> bool:
    """Depo sevkiyat satırlarında istenen_adet / urun_id beklenir (tahsis ile karışmasın)."""
    if not isinstance(rows, list) or not rows:
        return False
    for r in rows[:8]:
        if isinstance(r, dict) and ("istenen_adet" in r or "gonderilen_adet" in r or "urun_id" in r):
            return True
    return False


def _sevkiyat_kalem_sablon_kalemlerden(kalemler: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    kl = kalemler or []
    if isinstance(kl, str):
        try:
            kl = json.loads(kl)
        except Exception:
            kl = []
    if not isinstance(kl, list):
        return []
    for k in kl:
        if not isinstance(k, dict):
            continue
        istenen = max(0, int(k.get("adet") or k.get("istenen_adet") or 0))
        uid = (k.get("urun_id") or "").strip() or None
        uad = (k.get("urun_ad") or k.get("ad") or "").strip() or None
        kk = uid or ""
        row: Dict[str, Any] = {
            "urun_id": uid,
            "urun_ad": uad,
            "istenen_adet": istenen,
            "gonderilen_adet": 0,
            "durum": "bekliyor",
            "not": None,
        }
        if kk:
            row["kalem_kodu"] = kk
        out.append(row)
    return out


def merge_tahsis_into_kalem_durumlari(
    *,
    kalemler_raw: Any,
    existing_kd_raw: Any,
    tahsis_listesi: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Sevkiyat / depo hazırlık satırları ile uyumlu tek JSON üretir.
    Tahsis alanları: talep_adet, tahsis_adet, tahsis_durum (TAHSIS_*).
    Sevkiyat satırının ``durum`` alanı bekliyor|var|yok|kismi olarak kalır.
    """
    kd_raw = existing_kd_raw
    if isinstance(kd_raw, str):
        try:
            kd_raw = json.loads(kd_raw)
        except Exception:
            kd_raw = []
    existing: List[Dict[str, Any]] = kd_raw if isinstance(kd_raw, list) else []

    rows: List[Dict[str, Any]]
    if _looks_like_sevkiyat_kalem_satirlari(existing):
        rows = []
        for r in existing:
            if not isinstance(r, dict):
                continue
            row = dict(r)
            ds_raw = str(row.get("durum") or "").strip().upper()
            # Eski bug: tahsis TAHSIS_* yanlışlıkla durum yazılmışsa düzelt
            if ds_raw.startswith("TAHSIS"):
                row.setdefault("tahsis_durum", str(row.get("durum")))
                row["durum"] = "bekliyor"
            rows.append(row)
        if not rows:
            rows = _sevkiyat_kalem_sablon_kalemlerden(kalemler_raw)
    else:
        rows = _sevkiyat_kalem_sablon_kalemlerden(kalemler_raw)

    tahsis_by_kk: Dict[str, Dict[str, Any]] = {}
    for t in tahsis_listesi or []:
        kk = str((t or {}).get("kalem_kodu") or "").strip()
        if kk:
            tahsis_by_kk[kk] = dict(t)

    matched_keys: Set[str] = set()
    for row in rows:
        rk = _siparis_satir_eslestirme_anahtari(row)
        candidates = []
        if rk:
            candidates.append(rk)
        kk2 = str(row.get("kalem_kodu") or "").strip()
        if kk2 and kk2 not in candidates:
            candidates.append(kk2)

        applied = False
        for cand in candidates:
            if cand and cand in tahsis_by_kk:
                t = tahsis_by_kk[cand]
                talep_adet = max(0, int(t.get("talep_adet") or 0))
                tahsis_adet = max(0, int(t.get("tahsis_adet") or 0))
                if tahsis_adet == 0 or talep_adet == 0:
                    tahsis_durum = "TAHSIS_YOK"
                elif tahsis_adet >= talep_adet:
                    tahsis_durum = "TAHSIS_TAM"
                else:
                    tahsis_durum = "TAHSIS_KISMI"
                row["talep_adet"] = talep_adet
                row["tahsis_adet"] = tahsis_adet
                row["tahsis_durum"] = tahsis_durum
                matched_keys.add(cand)
                applied = True
                break

    # Tahsis listesinde olan ama satırda çıkmayan kodlar (ör. sadece stok kart kodu)
    for kk, t in tahsis_by_kk.items():
        if kk in matched_keys:
            continue
        talep_adet = max(0, int(t.get("talep_adet") or 0))
        tahsis_adet = max(0, int(t.get("tahsis_adet") or 0))
        kalem_adi = str(t.get("kalem_adi") or kk).strip()
        if tahsis_adet == 0 or talep_adet == 0:
            tahsis_durum = "TAHSIS_YOK"
        elif tahsis_adet >= talep_adet:
            tahsis_durum = "TAHSIS_TAM"
        else:
            tahsis_durum = "TAHSIS_KISMI"
        synth: Dict[str, Any] = {
            "urun_id": kk if len(kk) > 12 else None,
            "urun_ad": kalem_adi,
            "kalem_kodu": kk,
            "istenen_adet": talep_adet,
            "gonderilen_adet": 0,
            "durum": "bekliyor",
            "not": None,
            "talep_adet": talep_adet,
            "tahsis_adet": tahsis_adet,
            "tahsis_durum": tahsis_durum,
        }
        rows.append(synth)

    return rows


def merkez_tahsis_yap(cur: Any, siparis_talep_id: str,
                       tahsis_listesi: List[Dict[str, Any]],
                       yapan_id: Optional[str] = None,
                       yapan_ad: Optional[str] = None) -> Dict[str, Any]:
    """
    Tahsis kararını siparis_talep.kalem_durumlari JSONB'ye yazar.
    Sevkiyat satırları silinmez; tahsis alanları satır içinde güncellenir.
    merkez_stok_kart / sube_depo_stok rezerve_adet güncellenir.
    """
    cur.execute(
        """
        SELECT sube_id,
               COALESCE(hedef_depo_sube_id, sevkiyat_sube_id) AS hedef_depo_sube_id,
               tahsis_kaynak_depo_sube_id,
               kalemler,
               kalem_durumlari
        FROM siparis_talep
        WHERE id=%s
        FOR UPDATE
        """,
        (siparis_talep_id,),
    )
    row = cur.fetchone()
    if not row:
        raise ValueError(f"siparis_talep bulunamadı: {siparis_talep_id}")
    rd = dict(row)
    sube_id = rd.get("sube_id") or row[0]
    yeni_kaynak_depo = str(rd.get("hedef_depo_sube_id") or "").strip() or None
    eski_kaynak_depo = str(rd.get("tahsis_kaynak_depo_sube_id") or "").strip() or None

    # Önceki tahsislerden rezerv delta hesaplamak için (tekrar çağrılırsa çift saymasın)
    onceki_map: Dict[str, int] = {}
    km_raw = rd.get("kalem_durumlari")
    if isinstance(km_raw, str):
        try:
            km_raw = json.loads(km_raw)
        except Exception:
            km_raw = []
    if isinstance(km_raw, list):
        for it in km_raw:
            if not isinstance(it, dict):
                continue
            kid = str(it.get("kalem_kodu") or it.get("urun_id") or "").strip()
            if not kid:
                continue
            onceki_map[kid] = max(0, int(it.get("tahsis_adet") or 0))
    if not isinstance(km_raw, list):
        km_raw = []

    def _depo_rezerve_arttir(sube_id_local: str, kalem_kodu: str, kalem_adi: str, adet: int) -> None:
        if adet == 0:
            return
        if adet > 0:
            cur.execute(
                """
                INSERT INTO sube_depo_stok (sube_id, kalem_kodu, kalem_adi, mevcut_adet, rezerve_adet, min_stok)
                VALUES (%s, %s, %s, 0, %s, 0)
                ON CONFLICT (sube_id, kalem_kodu) DO UPDATE
                SET rezerve_adet = COALESCE(sube_depo_stok.rezerve_adet, 0) + EXCLUDED.rezerve_adet,
                    kalem_adi    = COALESCE(NULLIF(EXCLUDED.kalem_adi, ''), sube_depo_stok.kalem_adi),
                    guncelleme   = NOW()
                """,
                (sube_id_local, kalem_kodu, kalem_adi, adet),
            )
        else:
            cur.execute(
                """
                UPDATE sube_depo_stok
                SET rezerve_adet = GREATEST(0, COALESCE(rezerve_adet, 0) - %s),
                    guncelleme  = NOW()
                WHERE sube_id=%s AND kalem_kodu=%s
                """,
                (abs(adet), sube_id_local, kalem_kodu),
            )

    def _merkez_rezerve_arttir(kalem_kodu: str, adet: int) -> None:
        if adet == 0:
            return
        if adet > 0:
            cur.execute(
                """
                UPDATE merkez_stok_kart
                SET rezerve_adet = COALESCE(rezerve_adet, 0) + %s,
                    guncelleme   = NOW()
                WHERE kalem_kodu = %s
                """,
                (adet, kalem_kodu),
            )
        else:
            cur.execute(
                """
                UPDATE merkez_stok_kart
                SET rezerve_adet = GREATEST(0, COALESCE(rezerve_adet, 0) - %s),
                    guncelleme   = NOW()
                WHERE kalem_kodu = %s
                """,
                (abs(adet), kalem_kodu),
            )

    toplam_talep = toplam_tahsis = 0
    kalem_durumlari: List[Dict[str, Any]] = []

    # Eğer tahsis kaynağı değiştiyse, eski rezervleri yeni kaynağa taşı
    if eski_kaynak_depo != yeni_kaynak_depo and onceki_map:
        for kk, old_adet in onceki_map.items():
            if old_adet <= 0:
                continue
            # Eski kaynaktan düş
            if eski_kaynak_depo:
                _depo_rezerve_arttir(eski_kaynak_depo, kk, kk, -old_adet)
            else:
                _merkez_rezerve_arttir(kk, -old_adet)
            # Yeni kaynağa ekle
            if yeni_kaynak_depo:
                _depo_rezerve_arttir(yeni_kaynak_depo, kk, kk, old_adet)
            else:
                _merkez_rezerve_arttir(kk, old_adet)

    kalem_durumlari = merge_tahsis_into_kalem_durumlari(
        kalemler_raw=rd.get("kalemler"),
        existing_kd_raw=km_raw,
        tahsis_listesi=tahsis_listesi,
    )

    for item in tahsis_listesi:
        kalem_kodu = str(item.get("kalem_kodu") or "").strip()
        kalem_adi = str(item.get("kalem_adi") or kalem_kodu).strip()
        talep_adet = max(0, int(item.get("talep_adet") or 0))
        tahsis_adet = max(0, int(item.get("tahsis_adet") or 0))
        if not kalem_kodu:
            continue
        onceki = int(onceki_map.get(kalem_kodu, 0) or 0)
        delta = tahsis_adet - max(0, onceki)
        if delta != 0:
            if yeni_kaynak_depo:
                _depo_rezerve_arttir(yeni_kaynak_depo, kalem_kodu, kalem_adi, delta)
            else:
                _merkez_rezerve_arttir(kalem_kodu, delta)
        toplam_talep += talep_adet
        toplam_tahsis += tahsis_adet

    if toplam_tahsis >= toplam_talep and toplam_talep > 0:
        genel_durum = OLAY_TAHSIS_TAM
    elif toplam_tahsis > 0:
        genel_durum = OLAY_TAHSIS_KISMI
    else:
        genel_durum = OLAY_TAHSIS_YOK

    # siparis_talep güncelle: kalem_durumlari + tahsis meta
    yeni_durum = "onaylandi" if genel_durum != OLAY_TAHSIS_YOK else "bekliyor"
    cur.execute(
        """
        UPDATE siparis_talep
        SET durum           = %s,
            kalem_durumlari = %s::jsonb,
            tahsis_yapan_id = %s,
            tahsis_yapan_ad = %s,
            tahsis_ts       = NOW(),
            tahsis_durum    = %s,
            tahsis_kaynak_depo_sube_id = %s
        WHERE id = %s
        """,
        (yeni_durum,
         json.dumps(kalem_durumlari, ensure_ascii=False),
         yapan_id, yapan_ad, genel_durum,
         yeni_kaynak_depo,
         siparis_talep_id),
    )
    _disiplin_olay_yaz(cur, siparis_talep_id, sube_id, genel_durum, yapan_id, yapan_ad,
                        {"toplam_talep": toplam_talep, "toplam_tahsis": toplam_tahsis})
    return {"durum": genel_durum, "kalem_durumlari": kalem_durumlari,
            "toplam_talep": toplam_talep, "toplam_tahsis": toplam_tahsis}


# ── Aşama 3: Sevk çıktı ──────────────────────────────────────────

def sevk_cikti_kaydet(cur: Any, siparis_talep_id: str,
                       sevk_kalemleri: List[Dict[str, Any]],
                       yapan_id: Optional[str] = None,
                       yapan_ad: Optional[str] = None) -> List[str]:
    """Hedef depo şubesinden çıkış: şube deposu düşer; atanmazsa merkez_stok_kart düşer.
    stok_yolda oluşur (alıcı şube), siparis_talep 'gonderildi' olur."""
    cur.execute(
        """
        SELECT sube_id,
               COALESCE(hedef_depo_sube_id, sevkiyat_sube_id) AS kaynak_depo_sube_id
        FROM siparis_talep WHERE id=%s
        """,
        (siparis_talep_id,),
    )
    row = cur.fetchone()
    if not row:
        raise ValueError(f"siparis_talep bulunamadı: {siparis_talep_id}")
    rd = dict(row)
    sube_id = str(rd.get("sube_id") or "")
    kaynak_depo = str(rd.get("kaynak_depo_sube_id") or "").strip() or None

    yolda_ids = []
    for item in sevk_kalemleri:
        kalem_kodu = str(item.get("kalem_kodu") or item.get("urun_id") or "").strip()
        kalem_adi = str(item.get("kalem_adi") or item.get("urun_ad") or kalem_kodu).strip()
        sevk_adet = max(0, int(item.get("sevk_adet") or item.get("adet") or 0))
        if not kalem_kodu or sevk_adet <= 0:
            continue
        if kaynak_depo:
            cur.execute(
                """
                UPDATE sube_depo_stok
                SET mevcut_adet = GREATEST(0, COALESCE(mevcut_adet, 0) - %s),
                    rezerve_adet = GREATEST(0, COALESCE(rezerve_adet, 0) - %s),
                    guncelleme  = NOW()
                WHERE sube_id = %s AND kalem_kodu = %s
                """,
                (sevk_adet, sevk_adet, kaynak_depo, kalem_kodu),
            )
        else:
            cur.execute(
                """
                UPDATE merkez_stok_kart
                SET mevcut_adet  = GREATEST(0, COALESCE(mevcut_adet, 0) - %s),
                    rezerve_adet = GREATEST(0, COALESCE(rezerve_adet, 0) - %s),
                    guncelleme   = NOW()
                WHERE kalem_kodu = %s
                """,
                (sevk_adet, sevk_adet, kalem_kodu),
            )
        # stok_yolda kaydı
        yid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO stok_yolda
                (id, siparis_talep_id, sube_id, kalem_kodu, kalem_adi, sevk_adet, durum)
            VALUES (%s, %s, %s, %s, %s, %s, 'yolda')
            """,
            (yid, siparis_talep_id, sube_id, kalem_kodu, kalem_adi, sevk_adet),
        )
        yolda_ids.append(yid)

    cur.execute(
        "UPDATE siparis_talep SET durum='gonderildi' WHERE id=%s",
        (siparis_talep_id,),
    )
    _disiplin_olay_yaz(cur, siparis_talep_id, sube_id, OLAY_SEVK_CIKTI,
                        yapan_id, yapan_ad, {"sevk_kalemleri": sevk_kalemleri})
    return yolda_ids


# ── Aşama 4: Şube kabul ──────────────────────────────────────────

def sube_kabul_kaydet(cur: Any, siparis_talep_id: str, sube_id: str,
                       kabul_kalemleri: List[Dict[str, Any]],
                       yapan_id: Optional[str] = None,
                       yapan_ad: Optional[str] = None) -> Dict[str, Any]:
    """Şube depo stoğu artar. Eksik teslimatta KABUL_FARKI uyarısı üretilir."""
    # İdempotency: sipariş zaten teslim edilmişse stok tekrar artırılmaz.
    cur.execute(
        "SELECT durum FROM siparis_talep WHERE id=%s FOR UPDATE",
        (siparis_talep_id,),
    )
    mevcut = cur.fetchone()
    if mevcut and (mevcut.get("durum") or mevcut[0]) in ("teslim_edildi", "uyumsuz_kabul"):
        return {"success": True, "idempotent": True, "mesaj": "Kabul zaten işlendi"}

    tam_mi = True
    uyumsuz_satirlar: List[Dict[str, Any]] = []
    for item in kabul_kalemleri:
        kalem_kodu = str(item.get("kalem_kodu") or item.get("urun_id") or "").strip()
        kalem_adi = str(item.get("kalem_adi") or item.get("urun_ad") or kalem_kodu).strip()
        kabul_adet = max(0, int(item.get("kabul_adet") or item.get("adet") or 0))
        if not kalem_kodu:
            continue
        # Yoldaki kaydı kapat
        cur.execute(
            """
            SELECT id, sevk_adet FROM stok_yolda
            WHERE siparis_talep_id=%s AND sube_id=%s AND kalem_kodu=%s AND durum='yolda'
            ORDER BY sevk_ts DESC LIMIT 1
            """,
            (siparis_talep_id, sube_id, kalem_kodu),
        )
        yolda_row = cur.fetchone()
        sevk_adet = 0
        if yolda_row:
            sevk_adet = int((yolda_row.get("sevk_adet") or yolda_row[1]) or 0)
            yolda_id  = yolda_row.get("id") or yolda_row[0]
            yolda_durum = "kabul_edildi" if sevk_adet == kabul_adet else "kabul_uyusmazlik"
            cur.execute(
                "UPDATE stok_yolda SET durum=%s, kabul_ts=NOW(), kabul_adet=%s WHERE id=%s",
                (yolda_durum, kabul_adet, yolda_id),
            )
        # Şube deposu artar — SADECE BURAYA GELİNCE
        if kabul_adet > 0:
            cur.execute(
                """
                INSERT INTO sube_depo_stok
                    (id, sube_id, kalem_kodu, kalem_adi, mevcut_adet)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (sube_id, kalem_kodu) DO UPDATE
                SET mevcut_adet = sube_depo_stok.mevcut_adet + EXCLUDED.mevcut_adet,
                    guncelleme  = NOW()
                """,
                (str(uuid.uuid4()), sube_id, kalem_kodu, kalem_adi, kabul_adet),
            )
            # Stok geldi → bugün bu kalem için açık stok/bitti uyarılarını kapat
            try:
                cur.execute(
                    """
                    UPDATE sube_operasyon_uyari
                    SET okundu = TRUE
                    WHERE sube_id = %s
                      AND tarih  = CURRENT_DATE
                      AND tip    IN ('STOK_ALARM', 'STOK_BITTI', 'URUN_AC_UYUMSUZLUK')
                      AND mesaj  ILIKE %s
                      AND okundu = FALSE
                    """,
                    (sube_id, f"%{kalem_kodu}%"),
                )
            except Exception:
                pass
        # Kabul farkı kontrolü
        if sevk_adet != kabul_adet:
            tam_mi = False
            fark = sevk_adet - kabul_adet
            uyumsuz_satirlar.append(
                {
                    "kalem_kodu": kalem_kodu,
                    "kalem_adi": kalem_adi,
                    "sevk_adet": sevk_adet,
                    "kabul_adet": kabul_adet,
                    "fark_adet": fark,
                }
            )
            _davranis_uyari_yaz(cur, sube_id, KURAL_KABUL_FARKI,
                                siparis_talep_id, kalem_kodu,
                                {"sevk": sevk_adet, "kabul": kabul_adet,
                                 "fark": fark})

    genel_olay = OLAY_KABUL_TAM if tam_mi else OLAY_KABUL_EKSIK
    sevk_durum = "teslim_edildi" if tam_mi else "uyumsuz_kabul"
    cur.execute(
        """
        UPDATE siparis_talep
        SET durum='teslim_edildi',
            sevkiyat_durumu=%s,
            sevkiyat_durum=%s
        WHERE id=%s
        """,
        (sevk_durum, sevk_durum, siparis_talep_id),
    )
    if uyumsuz_satirlar:
        _disiplin_olay_yaz(
            cur,
            siparis_talep_id,
            sube_id,
            "SEVKIYAT_UYUSMAZLIK",
            yapan_id,
            yapan_ad,
            {"satirlar": uyumsuz_satirlar},
        )
    _disiplin_olay_yaz(cur, siparis_talep_id, sube_id, genel_olay,
                        yapan_id, yapan_ad, {"tam_mi": tam_mi})
    return {"durum": genel_olay, "tam_mi": tam_mi, "uyumsuz_satirlar": uyumsuz_satirlar}


# ── Aşama 5: Kullanım ────────────────────────────────────────────

def gunluk_acilis_stok_sayim_map(cur: Any, sube_id: str) -> Dict[str, int]:
    """Bugün tamamlanmış ACILIS olayındaki depo sayımı (STOK_KEYS). Satır yoksa sıfır."""
    cur.execute(
        """
        SELECT meta
        FROM sube_operasyon_event
        WHERE sube_id=%s
          AND tarih=CURRENT_DATE
          AND tip='ACILIS'
          AND durum='tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST, id DESC
        LIMIT 1
        """,
        (sube_id,),
    )
    row = cur.fetchone()
    meta_raw = None
    if row:
        meta_raw = dict(row).get("meta")
    meta: Dict[str, Any] = {}
    if isinstance(meta_raw, dict):
        meta = meta_raw
    elif meta_raw is not None:
        s = str(meta_raw).strip()
        if s:
            try:
                j = json.loads(s)
                meta = j if isinstance(j, dict) else {}
            except Exception:
                meta = {}
    ac_blk = meta.get("acilis_stok_sayim")
    if not isinstance(ac_blk, dict):
        ac_blk = meta.get("stok_sayim")
    if not isinstance(ac_blk, dict):
        ac_blk = {}
    return {k: max(0, int(ac_blk.get(k) or 0)) for k in STOK_KEYS}


def sube_depo_stok_depo_cikis_dus(
    cur: Any,
    sube_id: str,
    kalem_kodu: str,
    kalem_adi: Optional[str],
    adet: int,
) -> bool:
    """
    Depodan bara / aktif kullanım (ürün aç, kullanım API): fiziksel depo stoğu azalır.

    - Önce mevcut satırda düşüm.
    - Satır yoksa (hiç senkronize edilmemişse) günlük açılış sayımıyla bir satır oluşturulur,
      ardından düşüm uygulanır (STOK_KEYS için). Katalog kalemlerinde açılışta olmayan
      kodlar için başlangıç 0 kabul edilir.
    - rezerve_adet, düşüm sonrası mevcudun üzerine çıkamaz.
    """
    kk = (kalem_kodu or "").strip()
    if not kk:
        return False
    ad = max(0, int(adet))
    if ad <= 0:
        return False
    lab = (STOK_LABEL_TR.get(kk) or (kalem_adi or "") or kk).strip() or kk

    # CHECK constraint: mevcut_adet >= 0 — yetersiz stokta 0'a kırpılır (eksik miktar
    # URUN_AC_UYUMSUZLUK uyarısı olarak sube_panel.py tarafında loglanır).
    cur.execute(
        """
        UPDATE sube_depo_stok
        SET mevcut_adet = GREATEST(0, COALESCE(mevcut_adet, 0) - %s),
            rezerve_adet = GREATEST(0, LEAST(
                COALESCE(rezerve_adet, 0),
                GREATEST(0, COALESCE(mevcut_adet, 0) - %s)
            )),
            guncelleme = NOW()
        WHERE sube_id = %s AND kalem_kodu = %s
        """,
        (ad, ad, sube_id, kk),
    )
    if cur.rowcount:
        return True

    baslangic = 0
    if kk in STOK_KEYS:
        mp = gunluk_acilis_stok_sayim_map(cur, sube_id)
        baslangic = int(mp.get(kk) or 0)

    cur.execute(
        """
        INSERT INTO sube_depo_stok (sube_id, kalem_kodu, kalem_adi, mevcut_adet, rezerve_adet, min_stok)
        VALUES (%s, %s, %s, %s, 0, 0)
        ON CONFLICT (sube_id, kalem_kodu) DO NOTHING
        """,
        (sube_id, kk, lab, baslangic),
    )
    # CHECK constraint: mevcut_adet >= 0 — yetersiz stokta 0'a kırpılır (eksik miktar
    # URUN_AC_UYUMSUZLUK uyarısı olarak sube_panel.py tarafında loglanır).
    cur.execute(
        """
        UPDATE sube_depo_stok
        SET mevcut_adet = GREATEST(0, COALESCE(mevcut_adet, 0) - %s),
            rezerve_adet = GREATEST(0, LEAST(
                COALESCE(rezerve_adet, 0),
                GREATEST(0, COALESCE(mevcut_adet, 0) - %s)
            )),
            guncelleme = NOW()
        WHERE sube_id = %s AND kalem_kodu = %s
        """,
        (ad, ad, sube_id, kk),
    )
    return cur.rowcount > 0


def sube_depo_stok_depo_giris_ekle(
    cur: Any,
    sube_id: str,
    kalem_kodu: str,
    kalem_adi: Optional[str],
    adet: int,
) -> None:
    """
    Şube paneli «ürün stok ekle» (URUN_STOK_EKLE): fiziksel depo stoğu artar.

    Defter kaydı append-only kalır; bu fonksiyon ``sube_depo_stok`` ile senkron tutar.
    """
    kk = (kalem_kodu or "").strip()
    if not kk:
        return
    ad = max(0, int(adet))
    if ad <= 0:
        return
    lab = (STOK_LABEL_TR.get(kk) or (kalem_adi or "") or kk).strip() or kk
    cur.execute(
        """
        INSERT INTO sube_depo_stok
            (id, sube_id, kalem_kodu, kalem_adi, mevcut_adet, rezerve_adet, min_stok)
        VALUES (%s, %s, %s, %s, %s, 0, 0)
        ON CONFLICT (sube_id, kalem_kodu) DO UPDATE
        SET mevcut_adet = COALESCE(sube_depo_stok.mevcut_adet, 0) + EXCLUDED.mevcut_adet,
            kalem_adi = COALESCE(NULLIF(EXCLUDED.kalem_adi, ''), sube_depo_stok.kalem_adi),
            guncelleme = NOW()
        """,
        (str(uuid.uuid4()), sube_id, kk, lab, ad),
    )
    # Stok min_stok'u geçtiyse o kalem için bugünkü STOK_ALARM uyarısını sil
    cur.execute(
        """
        DELETE FROM sube_operasyon_uyari
        WHERE sube_id = %s
          AND tip = 'STOK_ALARM'
          AND tarih = CURRENT_DATE
          AND mesaj LIKE %s
          AND EXISTS (
              SELECT 1 FROM sube_depo_stok
              WHERE sube_id = %s AND kalem_kodu = %s
                AND COALESCE(mevcut_adet, 0) > GREATEST(1, COALESCE(min_stok, 0))
          )
        """,
        (sube_id, f"%{kk}%", sube_id, kk),
    )


def kullanim_kaydet(cur: Any, sube_id: str,
                    kullanim_kalemleri: List[Dict[str, Any]],
                    yapan_id: Optional[str] = None,
                    yapan_ad: Optional[str] = None) -> None:
    """Personel depodan bara açtı — şube depo stoğu azalır."""
    for item in kullanim_kalemleri:
        kalem_kodu = str(item.get("kalem_kodu") or "").strip()
        miktar     = max(0, int(item.get("adet") or item.get("miktar") or 0))
        if not kalem_kodu or miktar <= 0:
            continue
        sube_depo_stok_depo_cikis_dus(
            cur, sube_id, kalem_kodu, str(item.get("kalem_adi") or "").strip() or None, miktar,
        )
    _disiplin_olay_yaz(cur, None, sube_id, OLAY_KULLANIM,
                        yapan_id, yapan_ad, {"kullanim": kullanim_kalemleri})


# ── Stok Alarmı ──────────────────────────────────────────────────

def stok_alarm_kontrol(cur: Any) -> List[Dict[str, Any]]:
    """Merkez (merkez_stok_kart) ve şube (sube_depo_stok) alarmları."""
    alarmlar: List[Dict[str, Any]] = []
    # Merkez — mevcut_adet kolonu (yeni)
    cur.execute("""
        SELECT kalem_kodu, kalem_adi,
               COALESCE(mevcut_adet, 0)  AS mevcut_adet,
               COALESCE(rezerve_adet, 0) AS rezerve_adet,
               COALESCE(min_stok, 0)     AS min_stok
        FROM merkez_stok_kart
        WHERE COALESCE(mevcut_adet, 0) <= COALESCE(min_stok, 0)
           OR COALESCE(mevcut_adet, 0) <= 1
        ORDER BY mevcut_adet ASC, kalem_adi
    """)
    for r in cur.fetchall():
        m = int(r.get("mevcut_adet") or 0)
        seviye = STOK_ALARM_KRIZ if m == 0 else (STOK_ALARM_KRITIK if m == 1 else STOK_ALARM_DUSUK)
        alarmlar.append({"kaynak": "merkez", "sube_id": None,
                          "kalem_kodu": r.get("kalem_kodu"), "kalem_adi": r.get("kalem_adi"),
                          "mevcut": m, "rezerve": int(r.get("rezerve_adet") or 0),
                          "min_stok": int(r.get("min_stok") or 0), "seviye": seviye})
    # Şube
    cur.execute("""
        SELECT s.sube_id, sub.ad AS sube_adi,
               s.kalem_kodu, s.kalem_adi, s.mevcut_adet, s.min_stok
        FROM sube_depo_stok s
        JOIN subeler sub ON sub.id = s.sube_id
        WHERE s.mevcut_adet <= s.min_stok OR s.mevcut_adet <= 1
        ORDER BY s.mevcut_adet ASC, sub.ad, s.kalem_adi
    """)
    for r in cur.fetchall():
        m = int(r.get("mevcut_adet") or 0)
        seviye = STOK_ALARM_KRIZ if m == 0 else (STOK_ALARM_KRITIK if m == 1 else STOK_ALARM_DUSUK)
        alarmlar.append({"kaynak": "sube", "sube_id": r.get("sube_id"),
                          "sube_adi": r.get("sube_adi"),
                          "kalem_kodu": r.get("kalem_kodu"), "kalem_adi": r.get("kalem_adi"),
                          "mevcut": m, "rezerve": 0,
                          "min_stok": int(r.get("min_stok") or 0), "seviye": seviye})
    return alarmlar


# ── Eksik Kullanım Kontrolü (toplu, günlük) ───────────────────────

def eksik_kullanim_kontrol(cur: Any) -> None:
    """Şubede stok var ama son 7 günde sipariş geliyorsa kullanım girilmiyor uyarısı."""
    cur.execute("""
        SELECT id AS talep_id, sube_id, kalem_durumlari
        FROM siparis_talep
        WHERE tarih >= CURRENT_DATE - INTERVAL '7 days'
          AND durum != 'iptal'
          AND kalem_durumlari IS NOT NULL
          AND kalem_durumlari != '[]'::jsonb
    """)
    for row in cur.fetchall() or []:
        sube_id  = row.get("sube_id")
        talep_id = row.get("talep_id")
        kalemler = row.get("kalem_durumlari") or []
        if isinstance(kalemler, str):
            try:
                kalemler = json.loads(kalemler)
            except Exception:
                kalemler = []
        for k in kalemler:
            kalem_kodu = str(k.get("kalem_kodu") or k.get("urun_id") or "").strip()
            if not kalem_kodu:
                continue
            cur.execute(
                "SELECT mevcut_adet, min_stok FROM sube_depo_stok WHERE sube_id=%s AND kalem_kodu=%s",
                (sube_id, kalem_kodu),
            )
            depo = cur.fetchone()
            if not depo:
                continue
            mevcut = int(depo.get("mevcut_adet") or 0)
            min_s  = int(depo.get("min_stok") or 0)
            if mevcut > min_s:
                cur.execute(
                    """
                    SELECT 1 FROM sube_operasyon_uyari
                    WHERE sube_id=%s AND kalem_kodu=%s AND kural=%s AND tarih=CURRENT_DATE
                    LIMIT 1
                    """,
                    (sube_id, kalem_kodu, KURAL_EKSIK_KULLANIM),
                )
                if not cur.fetchone():
                    _davranis_uyari_yaz(cur, sube_id, KURAL_EKSIK_KULLANIM,
                                        talep_id, kalem_kodu,
                                        {"mevcut": mevcut, "min_stok": min_s})


# ── Skor Hesaplama ────────────────────────────────────────────────

def sube_skor_hesapla(cur: Any, sube_id: str,
                       yil: Optional[int] = None, ay: Optional[int] = None) -> Dict[str, Any]:
    """sube_operasyon_uyari'dan DAVRANIS tipli puanları toplayıp sube_skor'a yazar."""
    from datetime import date as _date
    bugun = _date.today()
    yil = yil or bugun.year
    ay  = ay  or bugun.month
    cur.execute(
        """
        SELECT kural, SUM(puan) AS toplam, COUNT(*) AS adet
        FROM sube_operasyon_uyari
        WHERE sube_id=%s AND tip='DAVRANIS'
          AND EXTRACT(YEAR FROM olusturma)=%s
          AND EXTRACT(MONTH FROM olusturma)=%s
        GROUP BY kural
        """,
        (sube_id, yil, ay),
    )
    detay: Dict[str, Any] = {}
    toplam_puan = 0
    for r in cur.fetchall() or []:
        kural = r.get("kural")
        puan  = int(r.get("toplam") or 0)
        detay[kural] = {"puan": puan, "ihlal_sayisi": int(r.get("adet") or 0)}
        toplam_puan += puan
    durum = ("normal" if toplam_puan < SKOR_SINIR_DIKKAT
             else "dikkat" if toplam_puan < SKOR_SINIR_PROBLEMLI
             else "problemli")
    cur.execute(
        """
        INSERT INTO sube_skor (id, sube_id, yil, ay, toplam_puan, durum, detay)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (sube_id, yil, ay) DO UPDATE
        SET toplam_puan=EXCLUDED.toplam_puan, durum=EXCLUDED.durum,
            detay=EXCLUDED.detay, guncelleme=NOW()
        """,
        (str(uuid.uuid4()), sube_id, yil, ay, toplam_puan, durum,
         json.dumps(detay, ensure_ascii=False)),
    )
    return {"sube_id": sube_id, "yil": yil, "ay": ay,
            "toplam_puan": toplam_puan, "durum": durum, "detay": detay}


def tum_subeler_skor_guncelle(cur: Any) -> List[Dict[str, Any]]:
    cur.execute("SELECT id FROM subeler WHERE aktif=TRUE")
    sonuclar = []
    for r in cur.fetchall():
        try:
            sonuclar.append(sube_skor_hesapla(cur, r.get("id") or r[0]))
        except Exception:
            pass
    return sonuclar


# ── Sipariş Akış Özeti ────────────────────────────────────────────

def siparis_akis_ozet(cur: Any, limit: int = 50) -> List[Dict[str, Any]]:
    """Son N siparişin uçtan uca durumu. Olay logu operasyon_defter'dan okunur."""
    cur.execute(
        """
        SELECT st.id, st.sube_id, s.ad AS sube_adi,
               st.tarih, st.durum, st.kalemler, st.kalem_durumlari,
               st.tahsis_durum, st.olusturma,
               (SELECT etiket FROM operasyon_defter
                WHERE ref_event_id=st.id ORDER BY olay_ts DESC LIMIT 1) AS son_olay,
               (SELECT olay_ts FROM operasyon_defter
                WHERE ref_event_id=st.id ORDER BY olay_ts DESC LIMIT 1) AS son_olay_ts
        FROM siparis_talep st
        JOIN subeler s ON s.id=st.sube_id
        WHERE st.durum != 'iptal'
        ORDER BY st.olusturma DESC
        LIMIT %s
        """,
        (limit,),
    )
    rows = cur.fetchall() or []
    sonuc = []
    for r in rows:
        kalemler = r.get("kalemler") or []
        if isinstance(kalemler, str):
            try:
                kalemler = json.loads(kalemler)
            except Exception:
                kalemler = []
        kalem_durumlari = r.get("kalem_durumlari") or []
        if isinstance(kalem_durumlari, str):
            try:
                kalem_durumlari = json.loads(kalem_durumlari)
            except Exception:
                kalem_durumlari = []
        cur.execute(
            "SELECT kalem_kodu, sevk_adet, kabul_adet, durum FROM stok_yolda WHERE siparis_talep_id=%s",
            (r.get("id"),),
        )
        yolda = [dict(y) for y in cur.fetchall()]
        sonuc.append({
            "id": r.get("id"), "sube_id": r.get("sube_id"),
            "sube_adi": r.get("sube_adi"), "tarih": str(r.get("tarih") or ""),
            "durum": r.get("durum"), "tahsis_durum": r.get("tahsis_durum"),
            "son_olay": r.get("son_olay"),
            "son_olay_ts": str(r.get("son_olay_ts") or ""),
            "kalem_sayisi": len(kalemler),
            "tahsis": kalem_durumlari,
            "yolda": yolda,
        })
    return sonuc

