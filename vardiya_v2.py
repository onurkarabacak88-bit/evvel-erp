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
from typing import Optional, List, Dict, Any, Tuple, Set
from datetime import date, time, datetime, timedelta
import uuid as _uuid

from database import db
from tr_saat import bugun_tr


def _ad_soyad_split(full: Optional[str]) -> Tuple[str, str]:
    """personel.ad_soyad → UI `ad` / `soyad` (avatar ve sıralama için)."""
    t = (full or "").strip()
    if not t:
        return "", ""
    parts = t.split(None, 1)
    a = (parts[0] or "").strip()
    s = (parts[1] or "").strip() if len(parts) > 1 else ""
    return a, s


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
    hafta_ici: bool = False,
) -> Dict[str, Any]:
    """
    Şube `subeler` satırındaki açılış/kapanış/yoğun metin alanlarına göre
    `vardiya_slot` kayıtları üretir. Slot adları `AUTO:` ile başlar (yenilemede silinir).

    mod:
      - yenile: atamasız AUTO slotları sil, yeniden üret
      - ekle: şubede hiç AUTO slot yoksa üret; varsa hata

    `aktif_gunler` verilmezse: `hafta_ici=True` → Pzt–Cum (1–5), aksi halde tüm hafta (1–7).
    Gün matrisi yalnızca o güne düşen slotları gösterir (`gun_planini_getir` + `aktif_gunler`).
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


def _max_gunluk_saat_varsayilan(calisma_turu: Optional[str]) -> float:
    """Sürekli ≈ 9,5 saat (9:30); part-time ≈ 5,5 saat (5:30)."""
    c = (calisma_turu or "surekli").strip().lower().replace("-", "_")
    if c in ("part_time", "part"):
        return 5.5
    return 9.5


def _personel_kisit_varsayilan(personel_id: str, *, max_gunluk_saat: float = 9.5) -> Dict[str, Any]:
    """Şema/kayıt eksik olsa bile tüm beklenen anahtarlar (KeyError önleme)."""
    return {
        "personel_id": personel_id,
        "max_gunluk_saat": float(max_gunluk_saat),
        "max_haftalik_saat": 45.0,
        "izinli_subeler": [],
        "yasak_subeler": [],
        "calisilabilir_saat_min": None,
        "calisilabilir_saat_max": None,
        "min_gecis_dk": 30,
        "vardiya_preset_json": {},
        "gun_saat_kisitlari_json": {},
        "yemek_sube_id": None,
    }


GUN_KISALTMA = ['pzt', 'sal', 'car', 'per', 'cum', 'cmt', 'paz']


def vardiya_preset_listele(cur) -> List[Dict[str, Any]]:
    """Sistem genel preset'leri (TAM/PART/ARACI/AÇILIŞ/KAPANIŞ)."""
    cur.execute("""
        SELECT * FROM vardiya_preset WHERE aktif = TRUE ORDER BY sira, kod
    """)
    return [dict(r) for r in cur.fetchall()]


def vardiya_preset_listele_hepsi(cur) -> List[Dict[str, Any]]:
    """Yönetim ekranı: pasif preset'ler dahil."""
    cur.execute("""
        SELECT * FROM vardiya_preset ORDER BY aktif DESC, sira, kod
    """)
    return [dict(r) for r in cur.fetchall()]


def vardiya_preset_kod_to_saat(cur, kod: str) -> Optional[Dict[str, Any]]:
    """Preset kodundan saat aralığını döner."""
    if not kod:
        return None
    cur.execute("""
        SELECT * FROM vardiya_preset WHERE kod = %s AND aktif = TRUE
    """, (kod,))
    r = cur.fetchone()
    return dict(r) if r else None


def personel_gun_preset(cur, personel_id: str, tarih: date) -> Optional[Dict[str, Any]]:
    """
    Personelin verilen tarih için "önerilen vardiya preset"ini döner.
    Mantık (öncelik sırası):
      1) JSON'da gün-spesifik kayıt varsa (örn "car" → "TAM")
      2) JSON'da hafta_ici / hafta_sonu varsa
      3) Yoksa None (kullanıcı manuel girer)
    """
    cur.execute("""
        SELECT vardiya_preset_json FROM personel_kisit WHERE personel_id = %s
    """, (personel_id,))
    r = cur.fetchone()
    pj = (r['vardiya_preset_json'] if r else {}) or {}
    if isinstance(pj, str):
        import json as _json
        try:
            pj = _json.loads(pj)
        except Exception:
            pj = {}

    gun_kisa = GUN_KISALTMA[tarih.weekday()]
    haftasonu = tarih.weekday() >= 5

    kod = pj.get(gun_kisa) or pj.get('hafta_sonu' if haftasonu else 'hafta_ici') or pj.get('default')
    if not kod:
        return None
    return vardiya_preset_kod_to_saat(cur, kod)


# Part-time: sabah (açılış) / akşam (kapanış) / ara — gün ortası ayrımı (09–14:30 / 14:30–24 ile uyumlu)
PART_GUN_ORTASI_DK = 14 * 60 + 30  # 14:30


def _vardiya_row_saat(val: Any) -> Optional[time]:
    if val is None:
        return None
    if isinstance(val, time):
        return val
    if isinstance(val, datetime):
        return val.time()
    return _parse_saat_metni(str(val))


def _sube_gun_penceresi_dk(acilis_raw: Any, kapanis_raw: Any) -> Tuple[int, int]:
    """Şube aynı gün dakika penceresi; `24:00` kapanış → 1440 (üst sınırda kırpılır)."""
    ac = _vardiya_row_saat(acilis_raw) or time(8, 0)
    open_dk = _dk_from_time(ac)
    ks = str(kapanis_raw or "").strip().upper().replace(".", ":")
    if ks.startswith("24:"):
        close_dk = 24 * 60
    else:
        kp = _vardiya_row_saat(kapanis_raw) or time(23, 59)
        close_dk = _dk_from_time(kp)
        if close_dk == 0 and kp == time(0, 0):
            close_dk = 24 * 60
    return open_dk, close_dk


def _dk_den_time(dk: int) -> time:
    dk = max(0, min(int(dk), 24 * 60 - 1))
    return time(dk // 60, dk % 60)


def part_time_slot_onerilen_saat(
    cur,
    personel_id: str,
    tarih: date,
    slot_id: str,
) -> Optional[Dict[str, Any]]:
    """
    `calisma_turu` part-time iken ve personelde gün preset'i yokken:
      - `acilis` slot → şube açılışı–14:30 ile slotun kesişimi (sabah part)
      - `kapanis` slot → 14:30–şube kapanışı ile slotun kesişimi (akşam part)
      - diğer (normal / yoğun) → slot süresi şube mesai içinde kırpılır (ara / aracı)
    Gece vardiyası slotlarında öneri verilmez (manuel saat).
    """
    _ = tarih  # API imzası / ileride gün bazlı kural için rezerv
    cur.execute("SELECT calisma_turu FROM personel WHERE id = %s", (personel_id,))
    rp = cur.fetchone()
    cal = (rp.get("calisma_turu") if rp else None) or "surekli"
    cal = str(cal).strip().lower().replace("-", "_")
    if cal not in ("part_time", "part"):
        return None

    cur.execute(
        """
        SELECT s.*, su.acilis_saati, su.kapanis_saati
        FROM vardiya_slot s
        JOIN subeler su ON su.id = s.sube_id
        WHERE s.id = %s
        """,
        (slot_id,),
    )
    row = cur.fetchone()
    if not row:
        return None
    slot = dict(row)
    if bool(slot.get("gece_vardiyasi")):
        return None

    sb = _vardiya_row_saat(slot.get("baslangic_saat"))
    se = _vardiya_row_saat(slot.get("bitis_saat"))
    if sb is None or se is None:
        return None

    s0 = _dk_from_time(sb)
    s1 = _dk_from_time(se)
    if s1 <= s0:
        return None

    open_dk, close_dk = _sube_gun_penceresi_dk(slot.get("acilis_saati"), slot.get("kapanis_saati"))
    tip = (slot.get("tip") or "normal").strip().lower()
    mid = PART_GUN_ORTASI_DK

    if tip == "acilis":
        lo = max(s0, open_dk)
        hi = min(s1, mid)
    elif tip == "kapanis":
        lo = max(s0, mid)
        hi = min(s1, close_dk)
    else:
        lo = max(s0, open_dk)
        hi = min(s1, close_dk)

    if hi <= lo:
        lo, hi = s0, s1

    hi_clamped = min(hi, 24 * 60 - 1)
    if hi_clamped <= lo:
        lo, hi_clamped = s0, min(s1, 24 * 60 - 1)

    return {
        "kod": "_PART_ORY",
        "ad": "Part-Time (slot önerisi)",
        "bas_saat": _dk_den_time(lo),
        "bit_saat": _dk_den_time(hi_clamped),
        "gece_vardiyasi": False,
        "renk": "#22c55e",
        "sira": 0,
        "aktif": True,
    }


def coz_varsayilan_atama_saatleri(
    cur,
    personel_id: str,
    tarih: date,
    slot_id: str,
) -> Optional[Tuple[time, time]]:
    """Önce personel gün preset (vardiya_preset_json); yoksa part-time slot önerisi."""
    pr = personel_gun_preset(cur, personel_id, tarih)
    if pr:
        return (pr["bas_saat"], pr["bit_saat"])
    pt = part_time_slot_onerilen_saat(cur, personel_id, tarih, slot_id)
    if pt:
        return (pt["bas_saat"], pt["bit_saat"])
    return None


def personel_kisit_getir(cur, personel_id: str) -> Dict[str, Any]:
    """
    Personelin kısıtlarını döner. Kayıt yoksa default değerlerle döner
    (ilk kullanımda upsert tetiklemez — okurken transparan).
    Eski DB satırında eksik kolon varsa varsayılanlarla tamamlanır.
    """
    cur.execute("SELECT calisma_turu FROM personel WHERE id = %s", (personel_id,))
    pr_ct = cur.fetchone()
    _cal = pr_ct.get("calisma_turu") if pr_ct else None
    _max_def = _max_gunluk_saat_varsayilan(_cal)
    cur.execute(
        "SELECT * FROM personel_kisit WHERE personel_id = %s",
        (personel_id,)
    )
    r = cur.fetchone()
    base = _personel_kisit_varsayilan(personel_id, max_gunluk_saat=_max_def)
    if not r:
        return base
    row = dict(r)
    for k, v in base.items():
        if k == "personel_id":
            continue
        if k not in row or row[k] is None:
            row[k] = v
    row["personel_id"] = personel_id
    try:
        row["max_gunluk_saat"] = float(row.get("max_gunluk_saat") or base["max_gunluk_saat"])
    except (TypeError, ValueError):
        row["max_gunluk_saat"] = base["max_gunluk_saat"]
    try:
        row["max_haftalik_saat"] = float(row.get("max_haftalik_saat") or base["max_haftalik_saat"])
    except (TypeError, ValueError):
        row["max_haftalik_saat"] = base["max_haftalik_saat"]
    if row.get("min_gecis_dk") is None:
        row["min_gecis_dk"] = base["min_gecis_dk"]
    else:
        try:
            row["min_gecis_dk"] = int(row["min_gecis_dk"])
        except (TypeError, ValueError):
            row["min_gecis_dk"] = base["min_gecis_dk"]
    iz = row.get("izinli_subeler")
    row["izinli_subeler"] = list(iz) if iz is not None else []
    yz = row.get("yasak_subeler")
    row["yasak_subeler"] = list(yz) if yz is not None else []
    return row


def _tarih_olustur(v: Any) -> date:
    """psycopg2 date / datetime / str → date."""
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    if v is None:
        raise ValueError("tarih None")
    return datetime.strptime(str(v)[:10], "%Y-%m-%d").date()


def _iso_hafta_numaralari_araliktan(a: date, b: date) -> Set[Tuple[int, int]]:
    """[a,b] kapanık aralığındaki her günün (ISO yıl, ISO hafta) anahtarları."""
    s: Set[Tuple[int, int]] = set()
    d = a
    while d <= b:
        y, w, _ = d.isocalendar()
        s.add((y, w))
        d += timedelta(days=1)
    return s


def personel_izin_baska_ayni_iso_haftada(
    cur,
    personel_id: str,
    d_bas: date,
    d_bit: date,
    exclude_izin_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Aynı ISO takvim haftasında (yıl+hafta) kesişen başka izin var mı.
    Çakışmayan ama aynı haftaya düşen ikinci kayıt da yakalanır (çift kayıt uyarısı).
    """
    yeni = _iso_hafta_numaralari_araliktan(d_bas, d_bit)
    cur.execute(
        """
        SELECT id, baslangic_tarih, bitis_tarih, tip
        FROM personel_izin
        WHERE personel_id = %s
        """,
        (personel_id,),
    )
    out: List[Dict[str, Any]] = []
    for r in cur.fetchall():
        rid = str(r["id"])
        if exclude_izin_id and rid == str(exclude_izin_id):
            continue
        o_bas = _tarih_olustur(r["baslangic_tarih"])
        o_bit = _tarih_olustur(r["bitis_tarih"])
        eski = _iso_hafta_numaralari_araliktan(o_bas, o_bit)
        if yeni & eski:
            out.append(dict(r))
    return out


def izin_hafta_ozet(cur, hafta_pazartesi: date) -> Dict[str, Any]:
    """
    Verilen Pazartesi ile başlayan haftada kendi adına izin kaydı olmayan aktif personel.
    Yasal izin planlaması için hatırlatma listesi (kayıt yok = dikkat).
    """
    paz = hafta_pazartesi
    paz_s = str(paz)
    paz_son = paz + timedelta(days=6)
    paz_son_s = str(paz_son)
    cur.execute(
        """
        SELECT DISTINCT personel_id::text AS personel_id
        FROM personel_izin
        WHERE baslangic_tarih <= %s::date AND bitis_tarih >= %s::date
        """,
        (paz_son_s, paz_s),
    )
    izinli = {str(r["personel_id"]) for r in cur.fetchall()}
    cur.execute(
        """
        SELECT id::text AS id, TRIM(COALESCE(ad_soyad, '')) AS ad_soyad
        FROM personel
        WHERE aktif = TRUE
        ORDER BY COALESCE(NULLIF(TRIM(ad_soyad), ''), id::text)
        """,
    )
    izin_gormeyen: List[Dict[str, str]] = []
    for r in cur.fetchall():
        pid = str(r["id"])
        if pid not in izinli:
            name = (r.get("ad_soyad") or "").strip() or pid
            izin_gormeyen.append({"personel_id": pid, "ad_soyad": name})
    return {
        "hafta_pazartesi": paz_s,
        "hafta_pazar": paz_son_s,
        "izin_gormeyen_personel": izin_gormeyen,
        "izin_gormeyen_sayisi": len(izin_gormeyen),
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


def _kisit_calisma_saati_uyari_mesaji(
    smin: Optional[time],
    smax: Optional[time],
    bas: time,
    bit: time,
    gece: bool,
) -> Optional[str]:
    """
    `calisilabilir_saat_min` / `calisilabilir_saat_max` ile slot uyumu.
    min > max (örn. 23:59 – 08:00) → GECE penceresi: izinli [min, 24:00) ∪ [00:00, max];
    gündüz dilimi (max, min) ile kesişen slotlar uyarı üretir.
    """
    if not smin and not smax:
        return None

    b0 = _saat_dakika(bas)
    b1 = _saat_dakika(bit)
    if gece or bit <= bas:
        b1 += 24 * 60

    if smin and smax and _saat_dakika(smin) > _saat_dakika(smax):
        hi_m = _saat_dakika(smax)
        lo_m = _saat_dakika(smin)

        def _gece_penceresi_disinda(sb0: int, sb1: int) -> bool:
            return sb0 < lo_m and sb1 > hi_m

        if _gece_penceresi_disinda(b0, min(b1, 24 * 60)):
            return (
                f"Slot, çalışılabilir gece penceresi ({smin}–{smax}, ertesi sabah) dışındaki "
                f"gündüz dilimine denk geliyor ({bas}–{bit})."
            )
        if b1 > 24 * 60:
            sb0 = 0
            sb1 = b1 - 24 * 60
            if _gece_penceresi_disinda(sb0, sb1):
                return (
                    f"Slot, çalışılabilir gece penceresi ({smin}–{smax}) dışına taşıyor ({bas}–{bit})."
                )
        return None

    if smin and b0 < _saat_dakika(smin):
        return f"Personel {smin} öncesi atanmıyor. Slot başlangıcı {bas}."
    if smax:
        if gece:
            if b1 > 24 * 60 + _saat_dakika(smax):
                return f"Personel en geç ertesi sabah {smax} sonrasına uzanmıyor. Slot {bas}–{bit}."
        else:
            if _saat_dakika(bit) > _saat_dakika(smax):
                return f"Personel {smax} sonrası çalışmıyor. Slot bitişi {bit}."
    return None


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

    # Saat verilmemişse: gün preset → part-time slot önerisi → slot saati
    if baslangic_saat is None and bitis_saat is None:
        coz = coz_varsayilan_atama_saatleri(cur, personel_id, tarih, slot_id)
        if coz:
            baslangic_saat, bitis_saat = coz
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

    # 3) ÇALIŞABİLİR SAAT ARALIĞI (gün penceresi veya min>max gece penceresi, örn. 23:59–08:00)
    smin = kisit.get('calisilabilir_saat_min')
    smax = kisit.get('calisilabilir_saat_max')
    if isinstance(smin, str):
        smin = _parse_saat_metni(smin)
    if isinstance(smax, str):
        smax = _parse_saat_metni(smax)
    saat_uyari = _kisit_calisma_saati_uyari_mesaji(smin, smax, bas, bit, gece)
    if saat_uyari:
        uyarilar.append({
            "tip": "saat_disinda",
            "seviye": "uyari",
            "mesaj": saat_uyari,
            "detay": {
                "saat_min": str(smin) if smin else None,
                "saat_max": str(smax) if smax else None,
                "slot_bas": str(bas),
                "slot_bit": str(bit),
            },
        })

    # 3b) GÜN-BAZLI SAAT KISITLARI (öğrenci ders saatleri vs)
    # Personel için bu güne ait yasak saat aralıkları varsa ve atama bunlarla
    # çakışıyorsa "kritik" uyarı (override edilebilir).
    cur.execute(
        "SELECT gun_saat_kisitlari_json FROM personel_kisit WHERE personel_id = %s",
        (personel_id,)
    )
    _gskr = cur.fetchone()
    gsk = (_gskr['gun_saat_kisitlari_json'] if _gskr else {}) or {}
    if isinstance(gsk, str):
        try:
            import json as _json
            gsk = _json.loads(gsk)
        except Exception:
            gsk = {}
    gun_kisa = GUN_KISALTMA[tarih.weekday()]
    yasak_listesi = gsk.get(gun_kisa) or []
    if yasak_listesi:
        for ys in yasak_listesi:
            yb = _parse_saat_metni(ys.get('yasak_bas'))
            yt = _parse_saat_metni(ys.get('yasak_bit'))
            if not yb or not yt:
                continue
            if araliklar_cakisir(yb, yt, False, bas, bit, gece):
                uyarilar.append({
                    "tip": "saat_disinda",
                    "seviye": "kritik",
                    "mesaj": (f"Bu personelin {ys.get('neden') or 'kısıtlı saat'} "
                              f"({yb.strftime('%H:%M')}–{yt.strftime('%H:%M')}) "
                              f"ile atama saati çakışıyor. Emin misin?"),
                    "detay": {"yasak_bas": str(yb), "yasak_bit": str(yt),
                              "neden": ys.get('neden')},
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

    # FIZIK KURALI: Çakışma override edilemez (aynı anda iki yerde olunamaz).
    cakisma_var = any(u['tip'] == 'cakisma' for u in uyarilar)
    if cakisma_var:
        return {"basarili": False, "atama_id": None, "uyarilar": uyarilar,
                "mesaj": "Aynı anda iki yerde olunamaz — bu kural override edilemez."}

    # Diğer kritikler (şube uyumsuz, saat aşımı, izinli, ders saati vs)
    # override ile geçer.
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
    # Saat öncelik sırası:
    #   1) Caller'ın verdiği saat (drop popup'tan)
    #   2) Gün preset → part-time slot önerisi
    #   3) Slot varsayılanı
    if baslangic_saat is None and bitis_saat is None:
        coz = coz_varsayilan_atama_saatleri(cur, personel_id, tarih, slot_id)
        if coz:
            baslangic_saat, bitis_saat = coz
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
        SELECT a.*, TRIM(COALESCE(p.ad_soyad, '')) AS _personel_full
        FROM vardiya_atama a
        JOIN personel p ON p.id = a.personel_id
        WHERE a.tarih = %s::date AND a.durum != 'iptal'
        ORDER BY a.baslangic_saat
    """, (tarih,))
    tum_atamalar = []
    for r in cur.fetchall():
        d = dict(r)
        ad, soy = _ad_soyad_split(d.pop("_personel_full", None))
        d["personel_ad"] = ad or "(isimsiz)"
        d["personel_soyad"] = soy
        tum_atamalar.append(d)
    atama_by_slot: Dict[str, List[Dict[str, Any]]] = {}
    for a in tum_atamalar:
        atama_by_slot.setdefault(a['slot_id'], []).append(a)

    # Yemek molası şubesi — havuz + atama satırlarında gösterim için (tek sorgu)
    cur.execute("SELECT id FROM personel WHERE aktif = TRUE")
    _havuz_ids = [str(r["id"]) for r in cur.fetchall()]
    _atama_ids = [str(a["personel_id"]) for a in tum_atamalar]
    _y_pid = list(set(_havuz_ids) | set(_atama_ids))
    yemek_by_pid: Dict[str, Dict[str, Any]] = {}
    if _y_pid:
        cur.execute(
            """
            SELECT pk.personel_id::text AS personel_id,
                   pk.yemek_sube_id::text AS yemek_sube_id,
                   s.ad AS yemek_sube_ad
            FROM personel_kisit pk
            LEFT JOIN subeler s ON s.id = pk.yemek_sube_id
            WHERE pk.personel_id = ANY(%s)
            """,
            (_y_pid,),
        )
        for row in cur.fetchall():
            yemek_by_pid[str(row["personel_id"])] = dict(row)
    for a in tum_atamalar:
        ym = yemek_by_pid.get(str(a["personel_id"]))
        a["yemek_sube_ad"] = ym.get("yemek_sube_ad") if ym else None

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
        SELECT id, ad_soyad, sube_id, calisma_turu, COALESCE(gorev, '') AS gorev
        FROM personel WHERE aktif = TRUE
        ORDER BY COALESCE(NULLIF(TRIM(ad_soyad), ''), id)
    """)
    personeller = []
    for p in cur.fetchall():
        p = dict(p)
        ad, soy = _ad_soyad_split(p.get("ad_soyad"))
        p["ad"] = ad or "(isimsiz)"
        p["soyad"] = soy
        p.pop("ad_soyad", None)
        gd = personel_gun_durumu(cur, p['id'], tarih)
        haf = personel_haftalik_saat(cur, p['id'], tarih)
        ym = yemek_by_pid.get(str(p["id"]))
        personeller.append({
            **p,
            "gun_durumu": gd,
            "haftalik_saat": round(haf, 2),
            "yemek_sube_id": ym.get("yemek_sube_id") if ym else None,
            "yemek_sube_ad": ym.get("yemek_sube_ad") if ym else None,
        })

    return {
        "tarih":           str(tarih),
        "haftanin_gunu":   haftanin_gunu,
        "subeler":         sube_blocks,
        "personel_havuzu": personeller,
        "gun_kilitli":     gun_kilit_mi(cur, tarih),
    }


def _pazartesi_normalize(d: date) -> date:
    """Verilen tarihin ait olduğu ISO haftasının Pazartesi günü."""
    wd = d.weekday()  # 0=Pzt
    return d - timedelta(days=wd)


def hafta_personel_tablosu(cur, herhangi_bir_gun: date) -> Dict[str, Any]:
    """
    Personel × 7 gün özet tablosu (PDF/Excel).
    Sol: şube · görev · ad | Orta: Pzt–Paz hücreleri | Sağ: kapanış sayısı · notlar
    """
    pzt = _pazartesi_normalize(herhangi_bir_gun)
    gunler_dt = [pzt + timedelta(days=i) for i in range(7)]
    gunler_iso = [str(x) for x in gunler_dt]
    d0, d6 = gunler_dt[0], gunler_dt[6]

    cur.execute(
        """
        SELECT p.id, TRIM(COALESCE(p.ad_soyad, '')) AS ad_soyad,
               COALESCE(NULLIF(TRIM(p.gorev), ''), '—') AS gorev,
               COALESCE(NULLIF(TRIM(p.notlar), ''), '') AS notlar,
               p.sube_id, COALESCE(s.ad, '—') AS sube_ad
        FROM personel p
        LEFT JOIN subeler s ON s.id = p.sube_id
        WHERE p.aktif = TRUE
        ORDER BY COALESCE(NULLIF(TRIM(p.ad_soyad), ''), p.id)
        """,
    )
    plist = [dict(r) for r in cur.fetchall()]

    cur.execute(
        """
        SELECT personel_id, baslangic_tarih::text AS b0, bitis_tarih::text AS e0, tip
        FROM personel_izin
        WHERE baslangic_tarih <= %s::date AND bitis_tarih >= %s::date
        """,
        (d6, d0),
    )
    izinler = [dict(r) for r in cur.fetchall()]

    def _izinli_mi(pid: str, gun: date) -> bool:
        for iz in izinler:
            if str(iz["personel_id"]) != str(pid):
                continue
            b = date.fromisoformat(str(iz["b0"])[:10])
            e = date.fromisoformat(str(iz["e0"])[:10])
            if b <= gun <= e:
                return True
        return False

    cur.execute(
        """
        SELECT a.personel_id::text AS personel_id, a.tarih::text AS tarih,
               to_char(a.baslangic_saat, 'HH24:MI') AS bas,
               to_char(a.bitis_saat, 'HH24:MI') AS bit,
               COALESCE(su.ad, '') AS sube_ad,
               COALESCE(sl.tip, 'normal') AS slot_tip
        FROM vardiya_atama a
        JOIN vardiya_slot sl ON sl.id = a.slot_id
        JOIN subeler su ON su.id = sl.sube_id
        WHERE a.tarih >= %s::date AND a.tarih <= %s::date AND a.durum <> 'iptal'
        ORDER BY a.personel_id, a.tarih, a.baslangic_saat
        """,
        (d0, d6),
    )
    raw_at = [dict(r) for r in cur.fetchall()]

    by_pe_gun: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
    kapanis_n: Dict[str, int] = {}
    for row in raw_at:
        pid = str(row["personel_id"])
        tiso = str(row["tarih"])[:10]
        by_pe_gun.setdefault((pid, tiso), []).append(row)
        if (row.get("slot_tip") or "").lower() == "kapanis":
            kapanis_n[pid] = kapanis_n.get(pid, 0) + 1

    satirlar: List[Dict[str, Any]] = []
    for pr in plist:
        pid = str(pr["id"])
        ad, soy = _ad_soyad_split(pr.get("ad_soyad"))
        gun_hucre: Dict[str, Any] = {}
        for gd in gunler_dt:
            giso = str(gd)
            if _izinli_mi(pid, gd):
                gun_hucre[giso] = {"metin": "İZİNLİ", "tip": "izinli"}
                continue
            rows = by_pe_gun.get((pid, giso), [])
            if not rows:
                gun_hucre[giso] = {"metin": "—", "tip": "bos"}
                continue
            lines: List[str] = []
            for rw in rows:
                bas = rw.get("bas") or ""
                bit = rw.get("bit") or ""
                sub = (rw.get("sube_ad") or "").strip()
                line = f"{bas}-{bit}"
                if sub:
                    line = f"{line}\n{sub}"
                lines.append(line)
            gun_hucre[giso] = {"metin": "\n".join(lines), "tip": "vardiya"}
        satirlar.append({
            "personel_id": pid,
            "sube_ad": pr.get("sube_ad") or "—",
            "gorev": pr.get("gorev") or "—",
            "ad": ad or "(isimsiz)",
            "soyad": soy,
            "gunler": gun_hucre,
            "kapanis_sayisi": int(kapanis_n.get(pid, 0)),
            "notlar": pr.get("notlar") or "",
        })

    return {
        "pazartesi": str(pzt),
        "gunler": gunler_iso,
        "satirlar": satirlar,
    }


# ═══════════════════════════════════════════════════════════════════
# RAPORLAMA (Aşama 7)
# ═══════════════════════════════════════════════════════════════════

def personel_haftalik_gorunum(cur, pazartesi: date) -> Dict[str, Any]:
    """
    Tulipi PDF formatında personel × hafta görünümü.
    Her personel için 7 günün her biri için 1 hücre:
      - "saat" → kendi asıl şubesinde çalışıyor (örn "09:00-18:30")
      - "sube" → başka şubeye gönderildi (örn "ZAFER")
      - "izinli" → izin
      - "yok" → planlanmamış
    Ayrıca: kapanış sayısı (kapanış slotu sayısı), notlar.
    """
    paz = pazartesi + timedelta(days=6)
    gunler = [pazartesi + timedelta(days=i) for i in range(7)]

    # Tüm aktif personel
    cur.execute("""
        SELECT p.id, p.ad_soyad, p.gorev, p.sube_id,
               s.ad AS asil_sube_ad
        FROM personel p
        LEFT JOIN subeler s ON s.id = p.sube_id
        WHERE p.aktif = TRUE
        ORDER BY s.ad NULLS LAST, p.gorev, p.ad_soyad
    """)
    personeller = [dict(r) for r in cur.fetchall()]

    # Tüm haftalık atamalar (bir kerede)
    cur.execute("""
        SELECT a.tarih, a.personel_id, a.baslangic_saat, a.bitis_saat, a.gece_vardiyasi,
               sl.tip AS slot_tip, sl.sube_id AS slot_sube_id, su.ad AS slot_sube_ad
        FROM vardiya_atama a
        JOIN vardiya_slot sl ON sl.id = a.slot_id
        LEFT JOIN subeler su ON su.id = sl.sube_id
        WHERE a.tarih BETWEEN %s::date AND %s::date AND a.durum != 'iptal'
        ORDER BY a.tarih, a.baslangic_saat
    """, (pazartesi, paz))
    atamalar = [dict(r) for r in cur.fetchall()]

    # Tüm haftalık izinler
    cur.execute("""
        SELECT personel_id, baslangic_tarih, bitis_tarih, tip
        FROM personel_izin
        WHERE bitis_tarih >= %s::date AND baslangic_tarih <= %s::date
    """, (pazartesi, paz))
    izinler = [dict(r) for r in cur.fetchall()]

    def hucre(personel: Dict[str, Any], tarih: date) -> Dict[str, Any]:
        # 1) İzin
        for iz in izinler:
            if iz['personel_id'] == personel['id'] \
               and iz['baslangic_tarih'] <= tarih <= iz['bitis_tarih']:
                return {"tip": "izinli", "metin": "İZİNLİ", "renk": "#ef4444"}

        # 2) O güne ait atamalar
        gun_atamalar = [a for a in atamalar if a['personel_id'] == personel['id'] and a['tarih'] == tarih]
        if not gun_atamalar:
            return {"tip": "yok", "metin": "", "renk": ""}

        # Birden fazlaysa hepsini "/" ile birleştir
        parcalar = []
        baska_sube_var = False
        for a in gun_atamalar:
            asil_sid = personel.get('sube_id')
            slot_sid = a.get('slot_sube_id')
            if asil_sid and slot_sid and asil_sid != slot_sid:
                parcalar.append((a.get('slot_sube_ad') or '?').upper())
                baska_sube_var = True
            else:
                bs = a['baslangic_saat'].strftime('%H:%M') if a['baslangic_saat'] else '?'
                bt = a['bitis_saat'].strftime('%H:%M') if a['bitis_saat'] else '?'
                parcalar.append(f"{bs}-{bt}")
        return {
            "tip": "sube" if baska_sube_var else "saat",
            "metin": " / ".join(parcalar),
            "renk": "#a855f7" if baska_sube_var else "",
        }

    def _ad_soyad_split(ts: str) -> Tuple[str, str]:
        ts = (ts or '').strip()
        if not ts:
            return ('', '')
        prc = ts.split(maxsplit=1)
        if len(prc) == 1:
            return (prc[0], '')
        return (prc[0], prc[1])

    satirlar = []
    for p in personeller:
        gun_hucreleri = []
        kapanis_sayisi = 0
        for g in gunler:
            h = hucre(p, g)
            gun_hucreleri.append({**h, "tarih": str(g)})
            # Kapanış sayma — kendi şubesinde kapanış slotu varsa
            for a in atamalar:
                if a['personel_id'] == p['id'] and a['tarih'] == g and a.get('slot_tip') == 'kapanis':
                    kapanis_sayisi += 1
                    break
        ad, soyad = _ad_soyad_split(p.get('ad_soyad'))
        satirlar.append({
            "personel_id":    p['id'],
            "ad_soyad":       p['ad_soyad'],
            "ad":             ad,
            "soyad":          soyad,
            "gorev":          p.get('gorev') or 'BARİSTA',
            "asil_sube_ad":   p.get('asil_sube_ad') or '—',
            "sube_ad":        p.get('asil_sube_ad') or '—',
            "asil_sube_id":   p.get('sube_id'),
            "gunler":         gun_hucreleri,
            "kapanis_sayisi": kapanis_sayisi,
            "notlar":         "",
        })

    return {
        "pazartesi": str(pazartesi),
        "pazar":     str(paz),
        "gunler":    [str(g) for g in gunler],
        "satirlar":  satirlar,
    }


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
               TRIM(COALESCE(p.ad_soyad, '')) AS _personel_full
        FROM personel_gun_state s
        JOIN personel p ON p.id = s.personel_id
        WHERE s.tarih BETWEEN %s AND %s
          AND s.fazla_gunluk_saat > 0
        ORDER BY s.tarih DESC, s.fazla_gunluk_saat DESC
        LIMIT %s
        """,
        (baslangic, bitis, lim),
    )
    gunluk = []
    for r in cur.fetchall():
        d = dict(r)
        a, ss = _ad_soyad_split(d.pop("_personel_full", None))
        d["personel_ad"] = a or "(isimsiz)"
        d["personel_soyad"] = ss
        gunluk.append(d)
    cur.execute(
        """
        SELECT o.id, o.ts, o.personel_id, o.atama_id, o.tarih, o.payload_json,
               o.aciklama, TRIM(COALESCE(p.ad_soyad, '')) AS _personel_full
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
    override_saat = []
    for r in cur.fetchall():
        d = dict(r)
        a, ss = _ad_soyad_split(d.pop("_personel_full", None))
        d["personel_ad"] = a or "(isimsiz)"
        d["personel_soyad"] = ss
        override_saat.append(d)
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
               o.aciklama, TRIM(COALESCE(p.ad_soyad, '')) AS _personel_full
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
    kayitlar = []
    for r in cur.fetchall():
        d = dict(r)
        a, ss = _ad_soyad_split(d.pop("_personel_full", None))
        d["personel_ad"] = a or "(isimsiz)"
        d["personel_soyad"] = ss
        kayitlar.append(d)
    return {
        "baslangic": str(baslangic),
        "bitis": str(bitis),
        "kayitlar": kayitlar,
    }
