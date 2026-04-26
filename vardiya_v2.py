"""
VARDİYA v2 — SLOT BAZLI VARDIYA SİSTEMİ
========================================
Tasarım kuralları (kullanıcı onaylı):

1. Vardiya = SLOT (saat dilimi). Sabit "sabah/akşam" değil.
2. Şube açılış saati = günün başlangıcı (gece vardiyası 22-06 destekli).
3. Personel HAVUZ — herhangi bir slota sürüklenebilir.
4. Tüm kontroller gün bazlı; `vardiya_gun_kilit` ile o gün kilitlenebilir
   (override ile atılabilir). Diğer günler bağımsız.
5. Override sistemi: kritik uyarılar varsayılan blok; override ile
   atama + vardiya_override_log.

Bu modül SAFE helper'lar sağlar — endpoint'ler main.py'da.
"""
from __future__ import annotations
from typing import Optional, List, Dict, Any, Tuple
from datetime import date, time, datetime, timedelta
import uuid as _uuid

from database import db
from tr_saat import bugun_tr


# ═══════════════════════════════════════════════════════════════════
# YARDIMCI — SAAT/SÜRE HESAPLARI
# ═══════════════════════════════════════════════════════════════════

def _saat_dakika(t: time) -> int:
    return t.hour * 60 + t.minute


def slot_sure_saat(baslangic: time, bitis: time, gece: bool = False) -> float:
    """Bir slot'un toplam saat süresi (gece vardiyası destekli)."""
    bas = _saat_dakika(baslangic)
    bit = _saat_dakika(bitis)
    if gece or bit <= bas:
        bit += 24 * 60
    return round((bit - bas) / 60.0, 2)


def araliklar_cakisir(
    a_bas: time, a_bit: time, a_gece: bool,
    b_bas: time, b_bit: time, b_gece: bool,
) -> bool:
    """İki vardiya aralığı çakışıyor mu? Gece destekli."""
    a1 = _saat_dakika(a_bas)
    a2 = _saat_dakika(a_bit) + (24 * 60 if a_gece or a_bit <= a_bas else 0)
    b1 = _saat_dakika(b_bas)
    b2 = _saat_dakika(b_bit) + (24 * 60 if b_gece or b_bit <= b_bas else 0)
    return not (a2 <= b1 or b2 <= a1)


def gecis_dakika(
    a_bit: time, a_gece: bool,
    b_bas: time, b_gece: bool,
) -> int:
    """A bittikten sonra B başlayana kadar geçen dakika (negatif = çakışma)."""
    a_son = _saat_dakika(a_bit) + (24 * 60 if a_gece else 0)
    b_baslangic = _saat_dakika(b_bas) + (24 * 60 if b_gece else 0)
    return b_baslangic - a_son


# ═══════════════════════════════════════════════════════════════════
# SLOT MOTORU — şube açılış/kapanış/yoğun saatlerinden AUTO: slotlar
# ═══════════════════════════════════════════════════════════════════

AUTO_SLOT_PREFIX = "AUTO:"


def _parse_saat_metni(s: Optional[Any]) -> Optional[time]:
    """'09:00', '9:30', '22:15' vb. → time veya None."""
    if s is None:
        return None
    t = str(s).strip()
    if not t:
        return None
    t = t.replace(".", ":")
    parts = t.split(":")
    try:
        h = int(parts[0])
        m = int(parts[1]) if len(parts) > 1 else 0
        return time(h % 24, max(0, min(m, 59)))
    except (ValueError, IndexError):
        return None


def _dk_from_time(t: time) -> int:
    return t.hour * 60 + t.minute


def _time_from_dk(dk: int) -> time:
    dk = int(dk) % (24 * 60)
    return time(dk // 60, dk % 60)


def _normal_parcalari(m0: int, m1: int, chunk_dk: int) -> List[Tuple[int, int]]:
    """[m0, m1) aralığını chunk_dk parçalarına böler; son kırığı bir öncekiyle birleştirir."""
    if m1 <= m0 or chunk_dk < 15:
        return []
    parca: List[Tuple[int, int]] = []
    cur = m0
    while cur < m1:
        nxt = min(cur + chunk_dk, m1)
        if nxt - cur >= 15:
            parca.append((cur, nxt))
        cur = nxt
    if len(parca) >= 2 and (parca[-1][1] - parca[-1][0]) < 35:
        a, _ = parca[-2]
        _, b = parca[-1]
        parca = parca[:-2] + [(a, b)]
    return parca


def _auto_slot_sil(cur, sube_id: str) -> Tuple[bool, List[str], int]:
    """
    AUTO: ile başlayan, aktif ataması olmayan slotları siler.
    Dönüş: (tamam_mi, atamali_slot_idleri, silinen_adet)
    """
    cur.execute(
        """
        SELECT DISTINCT s.id
        FROM vardiya_slot s
        JOIN vardiya_atama a ON a.slot_id = s.id AND a.durum <> 'iptal'
        WHERE s.sube_id = %s AND s.ad LIKE %s
        """,
        (sube_id, AUTO_SLOT_PREFIX + "%"),
    )
    blok = [r["id"] for r in cur.fetchall()]
    if blok:
        return False, blok, 0
    cur.execute(
        "DELETE FROM vardiya_slot WHERE sube_id = %s AND ad LIKE %s",
        (sube_id, AUTO_SLOT_PREFIX + "%"),
    )
    return True, [], cur.rowcount


def slotlari_sube_saatlerinden_uret(
    cur,
    sube_id: str,
    *,
    mod: str = "yenile",
    acilis_dakika: int = 60,
    kapanis_dakika: int = 60,
    normal_slot_dakika: int = 120,
    aktif_gunler: Optional[List[int]] = None,
    hafta_ici: bool = True,
) -> Dict[str, Any]:
    """
    Şube `subeler` satırındaki açılış/kapanış/yoğun metin alanlarına göre
    `vardiya_slot` kayıtları üretir. Slot adları `AUTO:` ile başlar (yenilemede silinir).

    mod:
      - yenile: atamasız AUTO slotları sil, yeniden üret
      - ekle: şubede hiç AUTO slot yoksa üret; varsa hata
    """
    uyarilar: List[str] = []
    if mod not in ("yenile", "ekle"):
        return {"basarili": False, "mesaj": "mod 'yenile' veya 'ekle' olmalı", "slotlar": []}

    cur.execute(
        """
        SELECT id, ad, acilis_saati, kapanis_saati, yogun_saat_baslangic, yogun_saat_bitis,
               COALESCE(min_personel, 1) AS min_personel,
               COALESCE(yogun_saat_ek_personel, 0) AS yogun_ek
        FROM subeler WHERE id = %s
        """,
        (sube_id,),
    )
    sube = cur.fetchone()
    if not sube:
        return {"basarili": False, "mesaj": "Şube bulunamadı", "slotlar": []}
    sube = dict(sube)

    gunler = aktif_gunler if aktif_gunler is not None else (
        [1, 2, 3, 4, 5] if hafta_ici else [1, 2, 3, 4, 5, 6, 7]
    )

    cur.execute(
        "SELECT 1 FROM vardiya_slot WHERE sube_id = %s AND ad LIKE %s LIMIT 1",
        (sube_id, AUTO_SLOT_PREFIX + "%"),
    )
    auto_var = cur.fetchone() is not None

    if mod == "ekle" and auto_var:
        return {
            "basarili": False,
            "mesaj": "Bu şubede zaten AUTO slot var. Önce 'yenile' kullanın.",
            "slotlar": [],
        }

    if mod == "yenile":
        ok, blok, silinen = _auto_slot_sil(cur, sube_id)
        if not ok:
            return {
                "basarili": False,
                "mesaj": "Bazı AUTO slotlarda aktif atama var; silinemedi.",
                "korunan_slot_idler": blok,
                "slotlar": [],
            }
        if silinen:
            uyarilar.append(f"{silinen} eski AUTO slot silindi.")

    acilis_t = _parse_saat_metni(sube.get("acilis_saati")) or time(9, 0)
    kapanis_t = _parse_saat_metni(sube.get("kapanis_saati")) or time(22, 0)
    open_m = _dk_from_time(acilis_t)
    close_m = _dk_from_time(kapanis_t)

    if close_m <= open_m:
        return {
            "basarili": False,
            "mesaj": (
                "Gece şubesi (kapanış ≤ açılış) bu sürümde desteklenmiyor; "
                "aynı gün içi açılış < kapanış olmalı."
            ),
            "slotlar": [],
        }

    toplam_dk = close_m - open_m
    min_p = int(sube["min_personel"] or 1)
    yog_ek = int(sube["yogun_ek"] or 0)
    ideal_yogun = max(min_p, min_p + yog_ek)

    plan: List[Dict[str, Any]] = []

    if toplam_dk < 120:
        plan.append({
            "ad": f"{AUTO_SLOT_PREFIX}tam_gun",
            "tip": "normal",
            "bas": open_m,
            "bit": close_m,
            "gece": False,
            "min_p": min_p,
            "ideal_p": min_p,
        })
    else:
        acilis_dk = max(15, min(acilis_dakika, toplam_dk - 30))
        kap_dk = max(15, min(kapanis_dakika, toplam_dk - 30))
        a_end = min(open_m + acilis_dk, close_m)
        k_start = max(open_m, close_m - kap_dk)
        if a_end > k_start:
            a_end = k_start
        if a_end > open_m:
            plan.append({
                "ad": f"{AUTO_SLOT_PREFIX}acilis",
                "tip": "acilis",
                "bas": open_m,
                "bit": a_end,
                "gece": False,
                "min_p": min_p,
                "ideal_p": min_p,
            })

        yo_bas = _parse_saat_metni(sube.get("yogun_saat_baslangic"))
        yo_bit = _parse_saat_metni(sube.get("yogun_saat_bitis"))
        yo1: Optional[int] = None
        yo2: Optional[int] = None
        if yo_bas and yo_bit:
            yo1m = _dk_from_time(yo_bas)
            yo2m = _dk_from_time(yo_bit)
            if yo2m > yo1m:
                c1 = max(a_end, yo1m)
                c2 = min(k_start, yo2m)
                if c2 > c1:
                    yo1, yo2 = c1, c2
                else:
                    uyarilar.append(
                        "Yoğun saat aralığı açılış–kapanış çerçevesiyle kesişmedi; yoğun slot atlandı."
                    )

        if yo1 is not None and yo2 is not None:
            for seg0, seg1 in _normal_parcalari(a_end, yo1, normal_slot_dakika):
                plan.append({
                    "ad": f"{AUTO_SLOT_PREFIX}normal-{_time_from_dk(seg0).strftime('%H%M')}",
                    "tip": "normal",
                    "bas": seg0,
                    "bit": seg1,
                    "gece": False,
                    "min_p": min_p,
                    "ideal_p": min_p,
                })
            plan.append({
                "ad": f"{AUTO_SLOT_PREFIX}yogun",
                "tip": "yogun",
                "bas": yo1,
                "bit": yo2,
                "gece": False,
                "min_p": min_p,
                "ideal_p": ideal_yogun,
            })
            for seg0, seg1 in _normal_parcalari(yo2, k_start, normal_slot_dakika):
                plan.append({
                    "ad": f"{AUTO_SLOT_PREFIX}normal-{_time_from_dk(seg0).strftime('%H%M')}",
                    "tip": "normal",
                    "bas": seg0,
                    "bit": seg1,
                    "gece": False,
                    "min_p": min_p,
                    "ideal_p": min_p,
                })
        else:
            for seg0, seg1 in _normal_parcalari(a_end, k_start, normal_slot_dakika):
                plan.append({
                    "ad": f"{AUTO_SLOT_PREFIX}normal-{_time_from_dk(seg0).strftime('%H%M')}",
                    "tip": "normal",
                    "bas": seg0,
                    "bit": seg1,
                    "gece": False,
                    "min_p": min_p,
                    "ideal_p": min_p,
                })

        if k_start < close_m:
            plan.append({
                "ad": f"{AUTO_SLOT_PREFIX}kapanis",
                "tip": "kapanis",
                "bas": k_start,
                "bit": close_m,
                "gece": False,
                "min_p": min_p,
                "ideal_p": min_p,
            })

    # Aynı isim çakışmasını önle (tekrar üretimde)
    used_names = set()
    yeni_idler: List[str] = []
    for i, row in enumerate(plan):
        ad = row["ad"]
        if ad in used_names:
            ad = f"{ad}-{i}"
        used_names.add(ad)
        sid = str(_uuid.uuid4())
        yeni_idler.append(sid)
        cur.execute(
            """
            INSERT INTO vardiya_slot
                (id, sube_id, ad, tip, baslangic_saat, bitis_saat, gece_vardiyasi,
                 min_personel, ideal_personel, aktif_gunler, aktif, sira)
            VALUES (%s,%s,%s,%s,%s,%s,FALSE,%s,%s,%s,TRUE,%s)
            """,
            (
                sid,
                sube_id,
                ad,
                row["tip"],
                _time_from_dk(row["bas"]),
                _time_from_dk(row["bit"]),
                row["min_p"],
                row["ideal_p"],
                gunler,
                i,
            ),
        )

    return {
        "basarili": True,
        "mesaj": f"{len(plan)} slot üretildi.",
        "slot_idler": yeni_idler,
        "uyarilar": uyarilar,
        "sube_ad": sube.get("ad"),
    }


# ═══════════════════════════════════════════════════════════════════
# PERSONEL KISIT OKUMA
# ═══════════════════════════════════════════════════════════════════

def gun_kilit_mi(cur, tarih: date) -> bool:
    """Bu takvim günü için plan kilidi var mı (satır yok = açık)."""
    cur.execute(
        "SELECT kilitli FROM vardiya_gun_kilit WHERE tarih = %s::date",
        (tarih,),
    )
    r = cur.fetchone()
    if not r:
        return False
    return bool(r["kilitli"])


def personel_gun_kasitli_bos(cur, personel_id: str, tarih: date) -> bool:
    cur.execute(
        """
        SELECT kasitli_bos FROM personel_vardiya_gun_niyet
        WHERE personel_id = %s AND tarih = %s::date
        """,
        (personel_id, tarih),
    )
    r = cur.fetchone()
    if not r:
        return False
    return bool(r["kasitli_bos"])


def personel_gun_niyet_kaydet(
    cur, personel_id: str, tarih: date, kasitli_bos: bool
) -> None:
    """True: bilinçli boş (BOS). False: satırı sil → varsayılan PLANLANMADI."""
    if kasitli_bos:
        cur.execute(
            """
            INSERT INTO personel_vardiya_gun_niyet (personel_id, tarih, kasitli_bos)
            VALUES (%s, %s::date, TRUE)
            ON CONFLICT (personel_id, tarih) DO UPDATE SET kasitli_bos = TRUE
            """,
            (personel_id, tarih),
        )
    else:
        cur.execute(
            """
            DELETE FROM personel_vardiya_gun_niyet
            WHERE personel_id = %s AND tarih = %s::date
            """,
            (personel_id, tarih),
        )


def gun_kilit_kaydet(cur, tarih: date, kilitli: bool, aciklama: str = "") -> None:
    if kilitli:
        cur.execute(
            """
            INSERT INTO vardiya_gun_kilit (tarih, kilitli, aciklama)
            VALUES (%s::date, TRUE, %s)
            ON CONFLICT (tarih) DO UPDATE SET kilitli = TRUE, aciklama = EXCLUDED.aciklama, ts = NOW()
            """,
            (tarih, aciklama or None),
        )
    else:
        cur.execute("DELETE FROM vardiya_gun_kilit WHERE tarih = %s::date", (tarih,))


def personel_kisit_getir(cur, personel_id: str) -> Dict[str, Any]:
    """
    Personelin kısıtlarını döner. Kayıt yoksa default değerlerle döner
    (ilk kullanımda upsert tetiklemez — okurken transparan).
    """
    cur.execute(
        "SELECT * FROM personel_kisit WHERE personel_id = %s",
        (personel_id,)
    )
    r = cur.fetchone()
    if r:
        return dict(r)
    return {
        "personel_id": personel_id,
        "max_gunluk_saat": 9.0,
        "max_haftalik_saat": 45.0,
        "izinli_subeler": [],
        "yasak_subeler": [],
        "calisilabilir_saat_min": None,
        "calisilabilir_saat_max": None,
        "min_gecis_dk": 30,
    }


# ═══════════════════════════════════════════════════════════════════
# PERSONEL GÜN DURUMU (computed)
# ═══════════════════════════════════════════════════════════════════

def personel_gun_durumu(cur, personel_id: str, tarih: date) -> Dict[str, Any]:
    """
    Bir personelin verilen tarihteki durumunu hesaplar ve `personel_gun_state` satırını yazar.
    Dönen yapı:
      {
        "durum": "CALISIYOR" | "BOS" | "IZINLI" | "PLANLANMADI",
        "kasitli_bos": bool,
        "atama_sayisi": int,
        "toplam_saat": float,
        "max_gunluk_saat": float,
        "kalan_saat": float,
        "haftalik_saat_snapshot": float,
        "fazla_gunluk_saat": float,
        "izin": dict | None,
        "atamalar": [ ... ],
        "override_var": bool,  # bu gün için vardiya_override_log kaydı var
      }
    """
    # İzin var mı?
    cur.execute("""
        SELECT * FROM personel_izin
        WHERE personel_id = %s
          AND baslangic_tarih <= %s::date
          AND bitis_tarih    >= %s::date
        ORDER BY baslangic_tarih DESC
        LIMIT 1
    """, (personel_id, tarih, tarih))
    izin = cur.fetchone()

    # Atamalar
    cur.execute("""
        SELECT a.*, s.sube_id, s.ad AS slot_ad, s.tip AS slot_tip
        FROM vardiya_atama a
        JOIN vardiya_slot s ON s.id = a.slot_id
        WHERE a.personel_id = %s
          AND a.tarih = %s::date
          AND a.durum != 'iptal'
        ORDER BY a.baslangic_saat
    """, (personel_id, tarih))
    atamalar = [dict(r) for r in cur.fetchall()]
    toplam = sum(
        slot_sure_saat(a['baslangic_saat'], a['bitis_saat'], bool(a.get('gece_vardiyasi')))
        for a in atamalar
    )

    kisit = personel_kisit_getir(cur, personel_id)
    max_gun = float(kisit['max_gunluk_saat'])
    kasitli_bos = personel_gun_kasitli_bos(cur, personel_id, tarih)

    if izin:
        durum = "IZINLI"
    elif atamalar:
        durum = "CALISIYOR"
    elif kasitli_bos:
        durum = "BOS"
    else:
        durum = "PLANLANMADI"

    kalan = round(max(0.0, max_gun - toplam), 2)
    toplam_r = round(toplam, 2)
    haftalik = personel_haftalik_saat(cur, personel_id, tarih)
    fazla_g = round(max(0.0, toplam_r - max_gun), 2)

    cur.execute(
        """
        INSERT INTO personel_gun_state (
            personel_id, tarih, durum, kasitli_bos, atama_sayisi,
            toplam_saat, kalan_saat, max_gunluk_saat, haftalik_saat,
            fazla_gunluk_saat, guncelleme
        ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())
        ON CONFLICT (personel_id, tarih) DO UPDATE SET
            durum = EXCLUDED.durum,
            kasitli_bos = EXCLUDED.kasitli_bos,
            atama_sayisi = EXCLUDED.atama_sayisi,
            toplam_saat = EXCLUDED.toplam_saat,
            kalan_saat = EXCLUDED.kalan_saat,
            max_gunluk_saat = EXCLUDED.max_gunluk_saat,
            haftalik_saat = EXCLUDED.haftalik_saat,
            fazla_gunluk_saat = EXCLUDED.fazla_gunluk_saat,
            guncelleme = NOW()
        """,
        (
            personel_id,
            tarih,
            durum,
            kasitli_bos,
            len(atamalar),
            toplam_r,
            kalan,
            max_gun,
            round(haftalik, 2),
            fazla_g,
        ),
    )

    cur.execute(
        """
        SELECT EXISTS (
            SELECT 1 FROM vardiya_override_log o
            WHERE o.personel_id = %s
              AND (
                (o.tarih IS NOT NULL AND o.tarih = %s::date)
                OR EXISTS (
                    SELECT 1 FROM vardiya_atama a
                    WHERE a.id = o.atama_id
                      AND a.personel_id = %s
                      AND a.tarih = %s::date
                      AND a.durum != 'iptal'
                )
              )
        ) AS ov
        """,
        (personel_id, tarih, personel_id, tarih),
    )
    override_var = bool((cur.fetchone() or {}).get("ov"))

    return {
        "durum":            durum,
        "kasitli_bos":      kasitli_bos,
        "atama_sayisi":     len(atamalar),
        "toplam_saat":      toplam_r,
        "max_gunluk_saat":  max_gun,
        "kalan_saat":       kalan,
        "haftalik_saat_snapshot": round(haftalik, 2),
        "fazla_gunluk_saat": fazla_g,
        "izin":             dict(izin) if izin else None,
        "atamalar":         atamalar,
        "override_var":     override_var,
    }


def personel_haftalik_saat(cur, personel_id: str, tarih: date) -> float:
    """Verilen tarihin ait olduğu haftada (Pzt–Paz) toplam atanmış saat."""
    pzt = tarih - timedelta(days=tarih.weekday())
    paz = pzt + timedelta(days=6)
    cur.execute("""
        SELECT COALESCE(SUM(EXTRACT(EPOCH FROM
            CASE
                WHEN gece_vardiyasi OR bitis_saat <= baslangic_saat
                  THEN ((bitis_saat::time + INTERVAL '24 hours') - baslangic_saat::time)
                ELSE (bitis_saat::time - baslangic_saat::time)
            END
        )) / 3600.0, 0) AS saat
        FROM vardiya_atama
        WHERE personel_id = %s
          AND tarih BETWEEN %s AND %s
          AND durum != 'iptal'
    """, (personel_id, pzt, paz))
    r = cur.fetchone()
    return float(r['saat'] if r else 0.0)


def personel_gun_state_yenile_tarih_araligi(
    cur, personel_id: str, bas: date, bit: date, max_gun: int = 400
) -> None:
    """İzin ekle/sil sonrası aralıktaki her gün için `personel_gun_state` senkronu."""
    if bit < bas:
        return
    d = bas
    n = 0
    while d <= bit and n < max_gun:
        personel_gun_durumu(cur, personel_id, d)
        d += timedelta(days=1)
        n += 1


# ═══════════════════════════════════════════════════════════════════
# UYARI MOTORU — atama YAPILMADAN ÖNCE check'i
# ═══════════════════════════════════════════════════════════════════

def atama_uyarilari(
    cur,
    personel_id: str,
    slot_id: str,
    tarih: date,
    baslangic_saat: Optional[time] = None,
    bitis_saat: Optional[time] = None,
) -> List[Dict[str, Any]]:
    """
    Bir atama yapılmadan ÖNCE çalıştırılır. Tüm potansiyel ihlalleri
    döner. UI bu listeyi kullanıcıya sunar; kullanıcı override ederse
    atama oluşturulur ve vardiya_override_log'a kayıt yazılır.

    Dönen yapı: [
      {
        "tip": 'saat_asimi' | 'sube_uyumsuz' | 'cakisma' | 'gecis_yetersiz'
              | 'izinli_atandi' | 'saat_disinda' | 'min_personel_eksik' | 'kapanis_eksik'
              | 'gun_kilitli',
        "seviye": 'uyari' | 'kritik',
        "mesaj": str,
        "detay": dict,
      }, ...
    ]
    """
    uyarilar: List[Dict[str, Any]] = []

    if gun_kilit_mi(cur, tarih):
        uyarilar.append({
            "tip": "gun_kilitli",
            "seviye": "kritik",
            "mesaj": "Bu gün plana kilitli. Yeni atama için onay (override) gerekir.",
            "detay": {"tarih": str(tarih)},
        })

    # Slot'u oku
    cur.execute("""
        SELECT s.*, su.ad AS sube_ad
        FROM vardiya_slot s
        LEFT JOIN subeler su ON su.id = s.sube_id
        WHERE s.id = %s
    """, (slot_id,))
    slot = cur.fetchone()
    if not slot:
        return [{"tip": "sube_uyumsuz", "seviye": "kritik", "mesaj": "Slot bulunamadı", "detay": {}}]
    slot = dict(slot)

    bas = baslangic_saat or slot['baslangic_saat']
    bit = bitis_saat or slot['bitis_saat']
    gece = bool(slot.get('gece_vardiyasi'))
    yeni_sure = slot_sure_saat(bas, bit, gece)

    # Personel kısıtları
    kisit = personel_kisit_getir(cur, personel_id)

    # 1) İZİNLİ MI?
    cur.execute("""
        SELECT * FROM personel_izin
        WHERE personel_id = %s
          AND baslangic_tarih <= %s::date AND bitis_tarih >= %s::date
        LIMIT 1
    """, (personel_id, tarih, tarih))
    izin = cur.fetchone()
    if izin:
        uyarilar.append({
            "tip": "izinli_atandi",
            "seviye": "kritik",
            "mesaj": f"Personel {izin['baslangic_tarih']}–{izin['bitis_tarih']} arası izinli ({izin['tip']})",
            "detay": {"izin": dict(izin)},
        })

    # 2) ŞUBE UYUMU
    izinli_sub = list(kisit.get('izinli_subeler') or [])
    yasak_sub  = list(kisit.get('yasak_subeler') or [])
    if slot['sube_id'] in yasak_sub:
        uyarilar.append({
            "tip": "sube_uyumsuz", "seviye": "kritik",
            "mesaj": f"Personel '{slot.get('sube_ad') or slot['sube_id']}' şubesinde YASAKLI.",
            "detay": {"sube_id": slot['sube_id']},
        })
    elif izinli_sub and slot['sube_id'] not in izinli_sub:
        uyarilar.append({
            "tip": "sube_uyumsuz", "seviye": "uyari",
            "mesaj": f"Personelin yetkili şubeleri arasında '{slot.get('sube_ad') or slot['sube_id']}' yok.",
            "detay": {"sube_id": slot['sube_id'], "izinli_subeler": izinli_sub},
        })

    # 3) ÇALIŞABİLİR SAAT ARALIĞI
    smin = kisit.get('calisilabilir_saat_min')
    smax = kisit.get('calisilabilir_saat_max')
    if smin and bas < smin:
        uyarilar.append({
            "tip": "saat_disinda", "seviye": "uyari",
            "mesaj": f"Personel {smin} öncesi çalışmıyor. Slot başlangıcı {bas}.",
            "detay": {"saat_min": str(smin), "slot_bas": str(bas)},
        })
    if smax and bit > smax and not gece:
        uyarilar.append({
            "tip": "saat_disinda", "seviye": "uyari",
            "mesaj": f"Personel {smax} sonrası çalışmıyor. Slot bitişi {bit}.",
            "detay": {"saat_max": str(smax), "slot_bit": str(bit)},
        })

    # 4) GÜNLÜK SAAT KONTROLÜ
    gun_d = personel_gun_durumu(cur, personel_id, tarih)
    yeni_toplam = gun_d['toplam_saat'] + yeni_sure
    if yeni_toplam > float(kisit['max_gunluk_saat']):
        uyarilar.append({
            "tip": "saat_asimi", "seviye": "kritik",
            "mesaj": (f"Günlük saat aşımı: mevcut {gun_d['toplam_saat']:.1f}h + "
                      f"yeni {yeni_sure:.1f}h = {yeni_toplam:.1f}h "
                      f"(limit {kisit['max_gunluk_saat']:.1f}h)"),
            "detay": {"mevcut": gun_d['toplam_saat'], "yeni": yeni_sure,
                      "limit": float(kisit['max_gunluk_saat'])},
        })

    # 5) HAFTALIK SAAT KONTROLÜ
    haf = personel_haftalik_saat(cur, personel_id, tarih)
    yeni_haf = haf + yeni_sure
    if yeni_haf > float(kisit['max_haftalik_saat']):
        uyarilar.append({
            "tip": "saat_asimi", "seviye": "uyari",
            "mesaj": (f"Haftalık saat aşımı: mevcut {haf:.1f}h + yeni {yeni_sure:.1f}h "
                      f"= {yeni_haf:.1f}h (limit {kisit['max_haftalik_saat']:.1f}h)"),
            "detay": {"mevcut_haftalik": haf, "yeni": yeni_sure,
                      "limit": float(kisit['max_haftalik_saat'])},
        })

    # 6) ÇAKIŞMA / ŞUBE A→B GEÇİŞ SÜRESİ — bugünkü diğer atamalarla
    #    Ardışık iki atama farklı şubedeyse aradaki boş dakika < min_gecis_dk → gecis_yetersiz (uyarı).
    #    Eşik personel_kisit.min_gecis_dk; kayıt yoksa varsayılan 30 dk. 0 = kontrol kapalı.
    min_gecis = int(kisit.get('min_gecis_dk') or 0)
    for a in gun_d['atamalar']:
        a_bas = a['baslangic_saat']; a_bit = a['bitis_saat']; a_gece = bool(a.get('gece_vardiyasi'))
        # ÇAKIŞMA
        if araliklar_cakisir(a_bas, a_bit, a_gece, bas, bit, gece):
            uyarilar.append({
                "tip": "cakisma", "seviye": "kritik",
                "mesaj": (f"Aynı saatte başka atama var: {a.get('slot_ad')} "
                          f"({a_bas}–{a_bit})"),
                "detay": {"diger_atama_id": a['id']},
            })
        else:
            # GEÇİŞ SÜRESİ — sadece farklı şube ise
            if a['sube_id'] != slot['sube_id']:
                # Önce hangisi bitiyor, ona göre boşluk hesapla
                a1 = _saat_dakika(a_bas) + (24 * 60 if a_gece else 0)
                a2 = _saat_dakika(a_bit) + (24 * 60 if a_gece or a_bit <= a_bas else 0)
                b1 = _saat_dakika(bas) + (24 * 60 if gece else 0)
                b2 = _saat_dakika(bit) + (24 * 60 if gece or bit <= bas else 0)
                if a2 <= b1:
                    bos = b1 - a2
                elif b2 <= a1:
                    bos = a1 - b2
                else:
                    bos = 0
                if 0 < bos < min_gecis:
                    uyarilar.append({
                        "tip": "gecis_yetersiz", "seviye": "uyari",
                        "mesaj": (f"Şube değişimi için geçiş süresi kısa: {bos}dk "
                                  f"(min {min_gecis}dk)"),
                        "detay": {"bos_dk": bos, "min_gecis_dk": min_gecis},
                    })

    return uyarilar


# ═══════════════════════════════════════════════════════════════════
# OVERRIDE LOG
# ═══════════════════════════════════════════════════════════════════

def override_log_yaz(
    cur,
    kullanici_id: Optional[str],
    ihlal_tipi: str,
    personel_id: Optional[str],
    atama_id: Optional[str],
    tarih: Optional[date],
    payload: Dict[str, Any],
    aciklama: str = "",
) -> str:
    """vardiya_override_log'a kayıt yazar, id döner.

    aciklama: kullanıcının serbest gerekçe metni (boş olabilir).
    Otomatik uyarı metni payload_json içinde (ör. sistem_mesaji) taşınır.
    """
    import json as _json
    oid = str(_uuid.uuid4())
    cur.execute("""
        INSERT INTO vardiya_override_log
            (id, kullanici_id, ihlal_tipi, personel_id, atama_id, tarih,
             payload_json, aciklama)
        VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s)
    """, (oid, kullanici_id, ihlal_tipi, personel_id, atama_id, tarih,
          _json.dumps(payload, default=str), aciklama))
    return oid


# ═══════════════════════════════════════════════════════════════════
# ATAMA OLUŞTUR / İPTAL
# ═══════════════════════════════════════════════════════════════════

def atama_olustur(
    cur,
    personel_id: str,
    slot_id: str,
    tarih: date,
    baslangic_saat: Optional[time] = None,
    bitis_saat: Optional[time] = None,
    override: bool = False,
    override_uyarilar: Optional[List[Dict[str, Any]]] = None,
    kullanici_id: Optional[str] = None,
    aciklama: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Atama oluşturur. Önce uyarıları hesaplar:
      - Kritik uyarı varsa ve override=False → atama yapılmaz, uyarılar döner
      - override=True ise her ihlal için override_log'a kayıt + atama yapılır
    """
    uyarilar = atama_uyarilari(cur, personel_id, slot_id, tarih,
                               baslangic_saat, bitis_saat)
    kritik_var = any(u['seviye'] == 'kritik' for u in uyarilar)
    if kritik_var and not override:
        return {"basarili": False, "atama_id": None, "uyarilar": uyarilar,
                "mesaj": "Kritik uyarı(lar) override gerektirir."}

    # Slot'tan saat varsayılanı al
    cur.execute("SELECT * FROM vardiya_slot WHERE id = %s", (slot_id,))
    slot = cur.fetchone()
    if not slot:
        return {"basarili": False, "atama_id": None, "uyarilar": [],
                "mesaj": "Slot bulunamadı."}
    slot = dict(slot)
    bas = baslangic_saat or slot['baslangic_saat']
    bit = bitis_saat or slot['bitis_saat']
    gece = bool(slot.get('gece_vardiyasi'))

    aid = str(_uuid.uuid4())
    cur.execute("""
        INSERT INTO vardiya_atama
            (id, tarih, slot_id, personel_id, baslangic_saat, bitis_saat,
             gece_vardiyasi, durum, aciklama, kullanici_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s, 'planli', %s, %s)
    """, (aid, tarih, slot_id, personel_id, bas, bit, gece,
          aciklama, kullanici_id))

    # Bu güne atama geldi → "bilinçli boş" niyeti anlamsız; satırı temizle
    cur.execute(
        "DELETE FROM personel_vardiya_gun_niyet WHERE personel_id = %s AND tarih = %s::date",
        (personel_id, tarih),
    )

    # Override log — her ihlal için ayrı kayıt
    # aciklama sütunu: kullanıcı gerekçesi (API body aciklama). Sistem uyarısı → payload_json.sistem_mesaji
    override_ids: List[str] = []
    if override and uyarilar:
        kullanici_gerekce = (aciklama or "").strip()
        for u in uyarilar:
            det = dict(u.get("detay") or {})
            det["sistem_mesaji"] = (u.get("mesaj") or "").strip()
            oid = override_log_yaz(
                cur, kullanici_id, u["tip"], personel_id, aid, tarih,
                det,
                kullanici_gerekce,
            )
            override_ids.append(oid)
        if override_ids:
            cur.execute(
                "UPDATE vardiya_atama SET override_id = %s WHERE id = %s",
                (override_ids[0], aid)
            )

    personel_gun_durumu(cur, personel_id, tarih)

    return {
        "basarili":   True,
        "atama_id":   aid,
        "uyarilar":   uyarilar,
        "override_kayitlari": override_ids,
        "mesaj":      "Atama oluşturuldu" + (f" ({len(override_ids)} override)" if override_ids else ""),
    }


def atama_iptal(cur, atama_id: str, kullanici_id: Optional[str] = None) -> Dict[str, Any]:
    cur.execute(
        """
        SELECT personel_id, tarih FROM vardiya_atama
        WHERE id = %s AND durum <> 'iptal'
        """,
        (atama_id,),
    )
    row = cur.fetchone()
    if not row:
        return {"basarili": False, "mesaj": "Atama bulunamadı veya zaten iptal."}
    pid = row["personel_id"]
    tar = row["tarih"]
    cur.execute(
        "UPDATE vardiya_atama SET durum = 'iptal' WHERE id = %s AND durum <> 'iptal'",
        (atama_id,),
    )
    if cur.rowcount == 0:
        return {"basarili": False, "mesaj": "Atama bulunamadı veya zaten iptal."}
    personel_gun_durumu(cur, pid, tar)
    return {"basarili": True, "mesaj": "Atama iptal edildi."}


# ═══════════════════════════════════════════════════════════════════
# GÜN BAZLI TOPLU İŞLEMLER — temizle / kopyala
# ═══════════════════════════════════════════════════════════════════

def gun_temizle(cur, tarih: date, sube_id: Optional[str] = None,
                kullanici_id: Optional[str] = None) -> Dict[str, Any]:
    """O güne ait tüm atamaları (opsiyonel: tek şube) iptal eder."""
    if sube_id:
        cur.execute("""
            UPDATE vardiya_atama SET durum = 'iptal'
            WHERE tarih = %s::date AND durum != 'iptal'
              AND slot_id IN (SELECT id FROM vardiya_slot WHERE sube_id = %s)
        """, (tarih, sube_id))
    else:
        cur.execute("""
            UPDATE vardiya_atama SET durum = 'iptal'
            WHERE tarih = %s::date AND durum != 'iptal'
        """, (tarih,))
    return {"basarili": True, "iptal_edilen": cur.rowcount}


def gun_kopyala(cur, kaynak_tarih: date, hedef_tarih: date,
                sube_id: Optional[str] = None,
                temizle: bool = True,
                kullanici_id: Optional[str] = None) -> Dict[str, Any]:
    """
    Kaynak gündeki atamaları hedef güne kopyalar. temizle=True ise
    hedef gün önce temizlenir. Validation BURADA çalıştırılmaz —
    "kopyala = aynı plan, kullanıcı bilinçli".
    """
    if temizle:
        gun_temizle(cur, hedef_tarih, sube_id, kullanici_id)

    if sube_id:
        cur.execute("""
            SELECT a.* FROM vardiya_atama a
            JOIN vardiya_slot s ON s.id = a.slot_id
            WHERE a.tarih = %s::date AND a.durum != 'iptal' AND s.sube_id = %s
        """, (kaynak_tarih, sube_id))
    else:
        cur.execute("""
            SELECT * FROM vardiya_atama
            WHERE tarih = %s::date AND durum != 'iptal'
        """, (kaynak_tarih,))
    kaynak = [dict(r) for r in cur.fetchall()]

    olusan = 0
    for a in kaynak:
        cur.execute("""
            SELECT 1 FROM vardiya_slot WHERE id = %s AND aktif = TRUE
              AND %s = ANY(aktif_gunler)
        """, (a['slot_id'], hedef_tarih.weekday() + 1))
        if not cur.fetchone():
            continue
        nid = str(_uuid.uuid4())
        cur.execute("""
            INSERT INTO vardiya_atama
                (id, tarih, slot_id, personel_id, baslangic_saat, bitis_saat,
                 gece_vardiyasi, durum, aciklama, kullanici_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, 'planli', %s, %s)
        """, (nid, hedef_tarih, a['slot_id'], a['personel_id'],
              a['baslangic_saat'], a['bitis_saat'],
              a.get('gece_vardiyasi', False),
              f"[KOPYA from {kaynak_tarih}] " + (a.get('aciklama') or ''),
              kullanici_id))
        olusan += 1
    return {"basarili": True, "kopyalanan": olusan,
            "kaynak": str(kaynak_tarih), "hedef": str(hedef_tarih)}


# ═══════════════════════════════════════════════════════════════════
# GÜN GÖRÜNÜMÜ — Tek bir tarih için tüm şube/slot/atama özeti
# ═══════════════════════════════════════════════════════════════════

def gun_planini_getir(cur, tarih: date, sube_id: Optional[str] = None) -> Dict[str, Any]:
    """
    UI için gün bazlı tam görünüm:
      {
        "tarih": "YYYY-MM-DD",
        "haftanin_gunu": 1..7,
        "subeler": [
          {
            "sube_id", "sube_ad",
            "slotlar": [
              {
                "slot": {...},
                "atamalar": [{"personel_id", "personel_ad", ...}],
                "min_personel", "atanan_personel",
                "eksik": int   # min_personel - atanan
              }
            ]
          }
        ],
        "personel_havuzu": [
          {
            "personel_id", "ad", "soyad", "sube_id" (asıl),
            "gun_durumu": {...},     # personel_gun_durumu çıktısı
            "haftalik_saat": float,
          }
        ],
        "uyarilar_ozet": {tip: count}
      }
    """
    haftanin_gunu = tarih.weekday() + 1  # 1=Pzt..7=Paz

    # Şubeler
    if sube_id:
        cur.execute("SELECT id, ad FROM subeler WHERE id = %s", (sube_id,))
    else:
        cur.execute("SELECT id, ad FROM subeler WHERE aktif = TRUE ORDER BY ad")
    subeler = [dict(r) for r in cur.fetchall()]

    # Slotlar (bu güne aktif olanlar)
    cur.execute("""
        SELECT * FROM vardiya_slot
         WHERE aktif = TRUE
           AND %s = ANY(aktif_gunler)
         ORDER BY sube_id, sira, baslangic_saat
    """, (haftanin_gunu,))
    tum_slotlar = [dict(r) for r in cur.fetchall()]

    # Atamalar (bu tarih)
    cur.execute("""
        SELECT a.*, p.ad_soyad AS personel_ad, '' AS personel_soyad
        FROM vardiya_atama a
        JOIN personel p ON p.id = a.personel_id
        WHERE a.tarih = %s::date AND a.durum != 'iptal'
        ORDER BY a.baslangic_saat
    """, (tarih,))
    tum_atamalar = [dict(r) for r in cur.fetchall()]
    atama_by_slot: Dict[str, List[Dict[str, Any]]] = {}
    for a in tum_atamalar:
        atama_by_slot.setdefault(a['slot_id'], []).append(a)

    sube_blocks: List[Dict[str, Any]] = []
    for s in subeler:
        s_slotlar = [sl for sl in tum_slotlar if sl['sube_id'] == s['id']]
        slot_views = []
        for sl in s_slotlar:
            atamalar = atama_by_slot.get(sl['id'], [])
            slot_views.append({
                "slot": sl,
                "atamalar": atamalar,
                "atanan_personel": len(atamalar),
                "min_personel": int(sl['min_personel']),
                "ideal_personel": int(sl['ideal_personel']),
                "eksik": max(0, int(sl['min_personel']) - len(atamalar)),
                "ideal_eksik": max(0, int(sl['ideal_personel']) - len(atamalar)),
            })
        sube_blocks.append({
            "sube_id": s['id'],
            "sube_ad": s['ad'],
            "slotlar": slot_views,
        })

    # Personel havuzu
    cur.execute("""
        SELECT id, ad_soyad AS ad, '' AS soyad, sube_id, calisma_turu
        FROM personel WHERE aktif = TRUE
        ORDER BY ad_soyad
    """)
    personeller = []
    for p in cur.fetchall():
        p = dict(p)
        gd = personel_gun_durumu(cur, p['id'], tarih)
        haf = personel_haftalik_saat(cur, p['id'], tarih)
        personeller.append({
            **p,
            "gun_durumu": gd,
            "haftalik_saat": round(haf, 2),
        })

    return {
        "tarih":           str(tarih),
        "haftanin_gunu":   haftanin_gunu,
        "subeler":         sube_blocks,
        "personel_havuzu": personeller,
        "gun_kilitli":     gun_kilit_mi(cur, tarih),
    }


# ═══════════════════════════════════════════════════════════════════
# RAPORLAMA (Aşama 7)
# ═══════════════════════════════════════════════════════════════════

def rapor_fazla_mesai(
    cur, baslangic: date, bitis: date, limit: int = 500
) -> Dict[str, Any]:
    """
    Günlük limit üstü (`personel_gun_state.fazla_gunluk_saat > 0`)
    ve `saat_asimi` override log kayıtları.
    """
    lim = min(max(int(limit), 1), 2000)
    cur.execute(
        """
        SELECT s.tarih, s.personel_id, s.toplam_saat, s.max_gunluk_saat,
               s.fazla_gunluk_saat, s.haftalik_saat, s.durum,
               p.ad_soyad AS personel_ad, '' AS personel_soyad
        FROM personel_gun_state s
        JOIN personel p ON p.id = s.personel_id
        WHERE s.tarih BETWEEN %s AND %s
          AND s.fazla_gunluk_saat > 0
        ORDER BY s.tarih DESC, s.fazla_gunluk_saat DESC
        LIMIT %s
        """,
        (baslangic, bitis, lim),
    )
    gunluk = [dict(r) for r in cur.fetchall()]
    cur.execute(
        """
        SELECT o.id, o.ts, o.personel_id, o.atama_id, o.tarih, o.payload_json,
               o.aciklama, p.ad_soyad AS personel_ad, '' AS personel_soyad
        FROM vardiya_override_log o
        JOIN personel p ON p.id = o.personel_id
        WHERE o.ihlal_tipi = 'saat_asimi'
          AND o.tarih IS NOT NULL
          AND o.tarih BETWEEN %s AND %s
        ORDER BY o.ts DESC
        LIMIT %s
        """,
        (baslangic, bitis, lim),
    )
    override_saat = [dict(r) for r in cur.fetchall()]
    return {
        "baslangic": str(baslangic),
        "bitis": str(bitis),
        "gunluk_limit_ustu": gunluk,
        "override_saat_asimi": override_saat,
    }


def rapor_izinli_calisti(
    cur, baslangic: date, bitis: date, limit: int = 500
) -> Dict[str, Any]:
    """İzinli iken atama (override) logları."""
    lim = min(max(int(limit), 1), 2000)
    cur.execute(
        """
        SELECT o.id, o.ts, o.personel_id, o.atama_id, o.tarih, o.payload_json,
               o.aciklama, p.ad_soyad AS personel_ad, '' AS personel_soyad
        FROM vardiya_override_log o
        JOIN personel p ON p.id = o.personel_id
        WHERE o.ihlal_tipi = 'izinli_atandi'
          AND o.tarih IS NOT NULL
          AND o.tarih BETWEEN %s AND %s
        ORDER BY o.ts DESC
        LIMIT %s
        """,
        (baslangic, bitis, lim),
    )
    return {
        "baslangic": str(baslangic),
        "bitis": str(bitis),
        "kayitlar": [dict(r) for r in cur.fetchall()],
    }
