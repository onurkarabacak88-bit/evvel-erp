"""
Günlük vardiya: ön seçim (aktif şubeler + personel_config.vardiyaya_dahil), izin,
şube_config + personel_kisit; havuz atama (kart şubesi yalnızca kota sayımı).
Şube veya personel zorla doldurulmaz (ek kapanış kaydırması ve yetim satırı yok).

Mimari notlar (Tulipi / çapraz şube):
- A şubede gündüz + B şubede kapanış → iki ayrı vardiya satırı (iki sube_id, aynı gün).
  İleride tek satırda baslangic_sube / bitis_sube eklenirse şema genişletilir.
- Günlük aynı personel için en fazla MAX_VARDIYA_KAYIT_GUNLUK kayıt (çift kayıt sınırı).
- Şube saatleri: sube_config’teki acilis_/ara_/kapanis_ bas/bit (boşsa VARDIYA_SAATLER varsayılanı).
"""
from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import date, timedelta
from typing import Any, Dict, List, Optional, Set, Tuple

# ACILIS / ARA / KAPANIS — TIME string (PostgreSQL ::time)
VARDIYA_SAATLER = {
    "ACILIS": ("09:00:00", "13:00:00"),
    "ARA": ("13:00:00", "17:00:00"),
    "KAPANIS": ("17:00:00", "21:00:00"),
}

TIPLER = ("ACILIS", "ARA", "KAPANIS")

_TIP_PREFIX = {"ACILIS": "acilis", "ARA": "ara", "KAPANIS": "kapanis"}

# Aynı gün aynı personel: örn. ev şubesi + bağlı şubede ek kapanış = en fazla bu kadar satır
MAX_VARDIYA_KAYIT_GUNLUK = 2


def _cfg_saat_degeri(raw: Any, fallback: str) -> str:
    """DB TEXT / TIME / None → HH:MM:SS (PostgreSQL ::time uyumlu)."""
    if raw is None:
        return fallback
    if hasattr(raw, "strftime"):
        return raw.strftime("%H:%M:%S")
    s = str(raw).strip()
    if not s:
        return fallback
    return _time_hhmmss(s, fallback)


def sube_tip_saatleri(cfg: Dict[str, Any]) -> Dict[str, Tuple[str, str]]:
    """Şube config satırına göre ACILIS/ARA/KAPANIS başlangıç-bitiş."""
    out: Dict[str, Tuple[str, str]] = {}
    for tip, (fbas, fbit) in VARDIYA_SAATLER.items():
        pr = _TIP_PREFIX[tip]
        bas = _cfg_saat_degeri(cfg.get(f"{pr}_bas_saat"), fbas)
        bit = _cfg_saat_degeri(cfg.get(f"{pr}_bit_saat"), fbit)
        out[tip] = (bas, bit)
    return out


def _personel_ana_sube_id(
    p: Dict[str, Any], cur, subeler: Dict[str, Dict[str, Any]]
) -> str:
    """Personel kartındaki şube (maaş/HR); yalnızca Faz 1’de şube başına kişi kotası sayımı için."""
    sid = p.get("sube_id") or "sube-merkez"
    cur.execute("SELECT id FROM subeler WHERE id = %s", (sid,))
    if not cur.fetchone():
        sid = "sube-merkez"
        cur.execute("SELECT id FROM subeler WHERE id = %s", (sid,))
        if not cur.fetchone():
            sid = next(iter(subeler.keys()))
    if sid not in subeler:
        sid = next(iter(subeler.keys()))
    return sid


def _pazartesi_hafta(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _saat_metni_dakika(s: Optional[str]) -> Optional[int]:
    """HH:MM veya HH:MM:SS → gün içi dakika; geçersizse None."""
    if not s or not str(s).strip():
        return None
    t = _time_hhmmss(str(s).strip(), "00:00:00")
    parts = t.split(":")
    try:
        h, m = int(parts[0]), int(parts[1])
        return h * 60 + m
    except (ValueError, IndexError):
        return None


def _vardiya_aralik_saat(bas: str, bit: str) -> float:
    """Aynı gün bas–bit arası saat (negatifse 0)."""
    a = _saat_metni_dakika(bas)
    b = _saat_metni_dakika(bit)
    if a is None or b is None:
        return 0.0
    if b < a:
        return 0.0
    return (b - a) / 60.0


def _izinli_sube_kumesi(k: Dict[str, Any]) -> Optional[Set[str]]:
    """CSV sube_id; boş/None → tüm şubeler serbest (None döner)."""
    raw = k.get("izinli_sube_ids")
    if raw is None or str(raw).strip() == "":
        return None
    out = {x.strip() for x in str(raw).split(",") if x.strip()}
    return out or None


def _vardiya_hedef_subede_calisabilir(
    p: Dict[str, Any],
    hedef_sube_id: str,
    ana_sube_id: str,
    kisitlar: Dict[str, Dict[str, Any]],
) -> bool:
    k = _kisit_of(p, kisitlar)
    izinli = _izinli_sube_kumesi(k)
    if izinli is not None and hedef_sube_id not in izinli:
        return False
    if not k.get("sube_degistirebilir", True):
        return hedef_sube_id == ana_sube_id
    return True


def _gunluk_kisit_map_yukle(cur) -> Dict[Tuple[str, int], Dict[str, Any]]:
    cur.execute("SELECT * FROM personel_gunluk_kisit")
    m: Dict[Tuple[str, int], Dict[str, Any]] = {}
    for r in cur.fetchall():
        pid = r["personel_id"]
        hg = int(r["hafta_gunu"])
        m[(pid, hg)] = dict(r)
    return m


def _tercih_map_yukle(cur) -> Dict[str, List[Tuple[str, int]]]:
    cur.execute(
        "SELECT personel_id, tercih_tip, oncelik FROM personel_tercih ORDER BY personel_id, oncelik, tercih_tip"
    )
    m: Dict[str, List[Tuple[str, int]]] = defaultdict(list)
    for r in cur.fetchall():
        m[r["personel_id"]].append((r["tercih_tip"], int(r["oncelik"] or 1)))
    return dict(m)


def _personel_en_az_bir_vardiya_tipi(
    p: Dict[str, Any],
    kisitlar: Dict[str, Dict[str, Any]],
    gunluk_map: Dict[Tuple[str, int], Dict[str, Any]],
    hafta_gunu: int,
) -> bool:
    return any(
        personel_tip_yapabilir(p, t, kisitlar, gunluk_map, hafta_gunu) for t in TIPLER
    )


def _hafta_onceki_istatistik(
    cur, personel_ids: Set[str], pzt: date, bugun: date
) -> Dict[str, Dict[str, float]]:
    """Bu hafta bugünden önceki vardiya: farklı gün sayısı + toplam saat."""
    out: Dict[str, Dict[str, float]] = {}
    if not personel_ids:
        return out
    cur.execute(
        """
        SELECT personel_id,
               COUNT(DISTINCT tarih)::float AS gun_sayisi,
               COALESCE(
                   SUM(
                       GREATEST(
                           0,
                           EXTRACT(EPOCH FROM (bit_saat - bas_saat)) / 3600.0
                       )
                   ),
                   0
               ) AS saat_toplam
        FROM vardiya
        WHERE tarih >= %s AND tarih < %s AND personel_id IN %s
        GROUP BY personel_id
        """,
        (str(pzt), str(bugun), tuple(personel_ids)),
    )
    for r in cur.fetchall():
        out[r["personel_id"]] = {
            "gun_sayisi": float(r["gun_sayisi"] or 0),
            "saat_toplam": float(r["saat_toplam"] or 0),
        }
    for pid in personel_ids:
        out.setdefault(pid, {"gun_sayisi": 0.0, "saat_toplam": 0.0})
    return out


def _vardiya_saat_sinirlari_uygun(
    k: Dict[str, Any], bas: str, bit: str, tip: str
) -> bool:
    """min_baslangic_saat / max_cikis_saat (tüm tipler) + kapanış bit için mevcut kapanis_bit_saat üst sınırı."""
    bas_m = _saat_metni_dakika(bas)
    bit_m = _saat_metni_dakika(bit)
    if bas_m is None or bit_m is None:
        return False
    mn = _saat_metni_dakika(k.get("min_baslangic_saat"))
    if mn is not None and bas_m < mn:
        return False
    mx = _saat_metni_dakika(k.get("max_cikis_saat"))
    if mx is not None and bit_m > mx:
        return False
    if tip == "KAPANIS" and k.get("kapanis_bit_saat"):
        kb = _saat_metni_dakika(k.get("kapanis_bit_saat"))
        if kb is not None and bit_m > kb:
            return False
    return True


def _atama_kisit_saat_limitleri(
    pid: str,
    k: Dict[str, Any],
    yeni_saat: float,
    bugun_atanan: Dict[str, float],
    hafta_onceki: Dict[str, Dict[str, float]],
) -> bool:
    gmax = k.get("gunluk_max_saat")
    if gmax is not None:
        try:
            gmx = float(gmax)
            if bugun_atanan.get(pid, 0.0) + yeni_saat > gmx + 1e-6:
                return False
        except (TypeError, ValueError):
            pass
    hmax = k.get("haftalik_max_saat")
    if hmax is not None:
        try:
            hmx = float(hmax)
            prev = hafta_onceki.get(pid, {"saat_toplam": 0.0})
            if (
                float(prev.get("saat_toplam", 0))
                + bugun_atanan.get(pid, 0.0)
                + yeni_saat
                > hmx + 1e-6
            ):
                return False
        except (TypeError, ValueError):
            pass
    return True


def _hafta_max_gun_izin(
    pid: str,
    k: Dict[str, Any],
    bugun_atanan: Dict[str, float],
    hafta_onceki: Dict[str, Dict[str, float]],
) -> bool:
    """Haftada en fazla N farklı gün; bugün ilk atamada önceki gün sayısı < N olmalı."""
    hgun = k.get("hafta_max_gun")
    if hgun is None:
        return True
    try:
        hg = int(hgun)
    except (TypeError, ValueError):
        return True
    prev = int(hafta_onceki.get(pid, {}).get("gun_sayisi", 0))
    ilk_atama_bugun = bugun_atanan.get(pid, 0) <= 1e-9
    if not ilk_atama_bugun:
        return True
    return prev < hg


def _vardiya_sayisi_bugun(cur, tarih_str: str, pid: str) -> int:
    cur.execute(
        "SELECT COUNT(*) AS c FROM vardiya WHERE tarih = %s AND personel_id = %s",
        (tarih_str, pid),
    )
    row = cur.fetchone()
    return int(row["c"]) if row else 0


def _atamalar_min_kapanis_yukselt(
    atamalar: List[Tuple[Dict[str, Any], str, str]],
    min_kap: int,
    tek_kap_izinli: bool,
    personeller: List[Dict[str, Any]],
    kisitlar: Dict[str, Dict[str, Any]],
    sube_ad: str,
    log: List[Dict[str, Any]],
    gunluk_map: Optional[Dict[Tuple[str, int], Dict[str, Any]]] = None,
    hafta_gunu: Optional[int] = None,
    tercih_map: Optional[Dict[str, List[Tuple[str, int]]]] = None,
    hafta_onceki: Optional[Dict[str, Dict[str, float]]] = None,
    bugun_atanan: Optional[Dict[str, float]] = None,
    son_tip_map: Optional[Dict[str, Optional[str]]] = None,
) -> Tuple[List[Tuple[Dict[str, Any], str, str]], int]:
    """tek_kapanis_izinli=False iken çoklu personelde yerelde yeterli kapanış sayısına yaklaş."""
    n = len(personeller)
    yapabilen = sum(
        1
        for p in personeller
        if personel_tip_yapabilir(p, "KAPANIS", kisitlar, gunluk_map, hafta_gunu)
    )
    hedef = min(max(int(min_kap or 1), 1), n, max(yapabilen, 0))
    liste = list(atamalar)
    cur_k = sum(1 for _, t, _ in liste if t == "KAPANIS")
    if tek_kap_izinli and n == 1:
        return liste, cur_k
    tm = tercih_map or {}
    ho = hafta_onceki or {}
    ba = bugun_atanan or {}
    stm = son_tip_map or {}
    hg = hafta_gunu if hafta_gunu is not None else 0
    gm = gunluk_map or {}
    while cur_k < hedef:
        adaylar: List[Tuple[int, float, Dict[str, Any], str, str]] = []
        for i, (p, tip, ned) in enumerate(liste):
            if tip == "KAPANIS":
                continue
            if personel_tip_yapabilir(p, "KAPANIS", kisitlar, gm, hg):
                k_e = _efektif_personel_kisit(p, kisitlar)
                sc = _atama_skoru_detay(p, "KAPANIS", k_e, tm, ho, ba, stm)[0]
                adaylar.append((i, sc, p, tip, ned))
        if not adaylar:
            break
        idx, _, p, tip_old, ned = max(adaylar, key=lambda x: (x[1], x[2].get("ad_soyad") or ""))
        liste[idx] = (p, "KAPANIS", f"{ned} → min_kapanis hedefi")
        log.append(
            {
                "kural": "MIN_KAP_LOKAL",
                "sube": sube_ad,
                "personel": p["ad_soyad"],
                "detay": "Yerelde ikinci/üçüncü kapanış için tip yükseltildi (skor)",
            }
        )
        cur_k += 1
    return liste, cur_k


def _time_hhmmss(s: Optional[str], fallback: str) -> str:
    if not s or not str(s).strip():
        return fallback
    t = str(s).strip()
    if len(t) == 5 and t[2] == ":":
        return t + ":00"
    if len(t) >= 8:
        return t[:8] if len(t) > 8 else t
    return fallback


def _default_sube_cfg(sube_id: str) -> Dict[str, Any]:
    return {
        "sube_id": sube_id,
        "vardiyaya_dahil": True,
        "min_kapanis": 1,
        "tek_kapanis_izinli": True,
        "tek_acilis_izinli": True,
        "kaydirma_acik": True,
        "sadece_tam_kayabilir": False,
        "hafta_sonu_min_kap": 1,
        "tam_part_zorunlu": False,
        "kapanis_dusurulemez": False,
        "acilis_bas_saat": None,
        "acilis_bit_saat": None,
        "ara_bas_saat": None,
        "ara_bit_saat": None,
        "kapanis_bas_saat": None,
        "kapanis_bit_saat": None,
    }


def _default_kisit(pid: str) -> Dict[str, Any]:
    return {
        "personel_id": pid,
        "acilis_yapabilir": True,
        "ara_yapabilir": True,
        "kapanis_yapabilir": True,
        "sadece_tip": None,
        "sube_degistirebilir": True,
        "kapanis_bit_saat": None,
        "calisan_rol": None,
        "hafta_max_gun": None,
        "gunluk_max_saat": None,
        "haftalik_max_saat": None,
        "min_baslangic_saat": None,
        "max_cikis_saat": None,
        "izinli_sube_ids": None,
        "calisma_profili": None,
    }


def _kisit_of(
    p: Dict[str, Any], kisitlar: Dict[str, Dict[str, Any]]
) -> Dict[str, Any]:
    return kisitlar.get(p["id"]) or _default_kisit(p["id"])


def _calisma_profili_normalize(v: Any) -> str:
    if v is None or v == "":
        return ""
    s = str(v).strip().lower().replace("-", "_")
    if s in ("öğrenci", "ogrenci"):
        return "ogrenci"
    if s in ("part_time", "parttime", "yarı_zamanlı", "yari_zamanli"):
        return "part_time"
    if s in ("full_time", "fulltime", "tam_zamanlı", "tam_zamanli", "surekli"):
        return "full_time"
    return s


def _efektif_personel_kisit(
    p: Dict[str, Any], kisitlar: Dict[str, Dict[str, Any]]
) -> Dict[str, Any]:
    """DB satırı + calisma_profili varsayılan kotları (yalnızca boş alanlara)."""
    k = dict(_kisit_of(p, kisitlar))
    profil = _calisma_profili_normalize(k.get("calisma_profili"))
    if profil == "ogrenci":
        if k.get("haftalik_max_saat") is None:
            k["haftalik_max_saat"] = 30
        if k.get("hafta_max_gun") is None:
            k["hafta_max_gun"] = 4
    elif profil == "part_time":
        if k.get("haftalik_max_saat") is None:
            k["haftalik_max_saat"] = 45
    return k


def _birlesik_kisit_gunluk(
    k_base: Dict[str, Any], gk: Optional[Dict[str, Any]]
) -> Dict[str, Any]:
    """Günlük satır: min/max saat ve günlük max_saat ile genel kısıt birleşimi."""
    k = dict(k_base)
    if not gk:
        return k
    gmn = gk.get("min_baslangic") or gk.get("min_baslangic_saat")
    if gmn and str(gmn).strip():
        k["min_baslangic_saat"] = str(gmn).strip()
    gmx = gk.get("max_cikis") or gk.get("max_cikis_saat")
    if gmx and str(gmx).strip():
        k["max_cikis_saat"] = str(gmx).strip()
    gms = gk.get("max_saat")
    if gms is not None and str(gms).strip() != "":
        try:
            gv = float(gms)
            og = k.get("gunluk_max_saat")
            if og is not None:
                try:
                    k["gunluk_max_saat"] = min(float(og), gv)
                except (TypeError, ValueError):
                    k["gunluk_max_saat"] = gv
            else:
                k["gunluk_max_saat"] = gv
        except (TypeError, ValueError):
            pass
    return k


def _gunluk_calisabilir_mi(gk: Dict[str, Any]) -> bool:
    if "calisabilir" in gk and gk.get("calisabilir") is not None:
        return bool(gk.get("calisabilir"))
    return not bool(gk.get("calisamaz"))


def _personel_efektif_sadece_tip(
    p: Dict[str, Any],
    kisitlar: Dict[str, Dict[str, Any]],
    gunluk_map: Optional[Dict[Tuple[str, int], Dict[str, Any]]],
    hafta_gunu: Optional[int],
) -> Optional[str]:
    k = _kisit_of(p, kisitlar)
    st = k.get("sadece_tip")
    if st and st in TIPLER:
        return st
    if gunluk_map is not None and hafta_gunu is not None:
        gk = gunluk_map.get((p["id"], hafta_gunu))
        if gk:
            gst = gk.get("sadece_tip")
            if gst and str(gst).strip():
                u = str(gst).strip().upper()
                if u in TIPLER:
                    return u
    return None


def personel_tip_yapabilir(
    p: Dict[str, Any],
    tip: str,
    kisitlar: Dict[str, Dict[str, Any]],
    gunluk_map: Optional[Dict[Tuple[str, int], Dict[str, Any]]] = None,
    hafta_gunu: Optional[int] = None,
) -> bool:
    """personel_kisit + personel_gunluk_kisit (hafta_gunu: 0=Pt … 6=Pz)."""
    if gunluk_map is not None and hafta_gunu is not None:
        gk = gunluk_map.get((p["id"], hafta_gunu))
        if gk:
            if not _gunluk_calisabilir_mi(gk):
                return False
            gst = gk.get("sadece_tip")
            if gst and str(gst).strip():
                if str(gst).strip().upper() != tip:
                    return False
            elif not (gst and str(gst).strip()):
                it = gk.get("izinli_tipler")
                if it and str(it).strip():
                    allowed = {x.strip().upper() for x in str(it).split(",") if x.strip()}
                    if tip not in allowed:
                        return False
    k = _kisit_of(p, kisitlar)
    st = k.get("sadece_tip")
    if st and st != tip:
        return False
    m = {
        "ACILIS": k.get("acilis_yapabilir", True),
        "ARA": k.get("ara_yapabilir", True),
        "KAPANIS": k.get("kapanis_yapabilir", True),
    }
    return bool(m.get(tip, True))


def _tercih_skoru(
    pid: str, tip: str, tercih_map: Dict[str, List[Tuple[str, int]]]
) -> int:
    lst = tercih_map.get(pid) or []
    for i, (t, _) in enumerate(lst):
        if t == tip:
            return max(0, 24 - i * 8)
    return 0


def _tercih_eslesir(
    pid: str, tip: str, tercih_map: Dict[str, List[Tuple[str, int]]]
) -> bool:
    return any(t == tip for t, _ in (tercih_map.get(pid) or []))


def _son_vardiya_tipi_map(
    cur, personel_ids: Set[str], before_tarih: str
) -> Dict[str, Optional[str]]:
    """Her personel için before_tarih öncesi son vardiya tipi (KAPANIS cezası için)."""
    out: Dict[str, Optional[str]] = {pid: None for pid in personel_ids}
    if not personel_ids:
        return out
    cur.execute(
        """
        SELECT DISTINCT ON (personel_id) personel_id, tip
        FROM vardiya
        WHERE personel_id IN %s AND tarih < %s
        ORDER BY personel_id, tarih DESC, bit_saat DESC NULLS LAST
        """,
        (tuple(personel_ids), before_tarih),
    )
    for r in cur.fetchall():
        out[r["personel_id"]] = r["tip"]
    return out


def _atama_skoru_detay(
    p: Dict[str, Any],
    tip: str,
    k_efektif: Dict[str, Any],
    tercih_map: Dict[str, List[Tuple[str, int]]],
    hafta_onceki: Dict[str, Dict[str, float]],
    bugun_atanan: Dict[str, float],
    son_tip_map: Dict[str, Optional[str]],
) -> Tuple[float, str]:
    """
    En uygun atama sıralaması: tercih (+10), kota altında kalan saat payı,
    son vardiya kapanış ise -5, öğrenci+kapanış +3.
    """
    pid = p["id"]
    mevcut = float(hafta_onceki.get(pid, {}).get("saat_toplam", 0)) + float(
        bugun_atanan.get(pid, 0)
    )
    hmax = k_efektif.get("haftalik_max_saat")
    try:
        hedef = float(hmax) if hmax is not None else 80.0
    except (TypeError, ValueError):
        hedef = 80.0
    score = 0.0
    if _tercih_eslesir(pid, tip, tercih_map):
        score += 10.0
    score += max(0.0, hedef - mevcut)
    if son_tip_map.get(pid) == "KAPANIS":
        score -= 5.0
    profil = _calisma_profili_normalize(k_efektif.get("calisma_profili"))
    if profil == "ogrenci" and tip == "KAPANIS":
        score += 3.0
    return score, p.get("ad_soyad") or ""


def _faz1_aday_skoru(
    p: Dict[str, Any],
    kisitlar: Dict[str, Dict[str, Any]],
    gunluk_map: Dict[Tuple[str, int], Dict[str, Any]],
    hafta_gunu: int,
    tercih_map: Dict[str, List[Tuple[str, int]]],
    hafta_onceki: Dict[str, Dict[str, float]],
    bugun_atanan: Dict[str, float],
    son_tip_map: Dict[str, Optional[str]],
) -> float:
    k_e = _efektif_personel_kisit(p, kisitlar)
    best = -1e18
    for t in TIPLER:
        if personel_tip_yapabilir(p, t, kisitlar, gunluk_map, hafta_gunu):
            s, _ = _atama_skoru_detay(
                p, t, k_e, tercih_map, hafta_onceki, bugun_atanan, son_tip_map
            )
            best = max(best, s)
    return best


def _skor_kapanis_adayi(
    p: Dict[str, Any],
    kisitlar: Dict[str, Dict[str, Any]],
    tercih_map: Optional[Dict[str, List[Tuple[str, int]]]] = None,
    hafta_onceki: Optional[Dict[str, Dict[str, float]]] = None,
    bugun_atanan: Optional[Dict[str, float]] = None,
    son_tip_map: Optional[Dict[str, Optional[str]]] = None,
    gunluk_map: Optional[Dict[Tuple[str, int], Dict[str, Any]]] = None,
    hafta_gunu: Optional[int] = None,
) -> Tuple[float, str]:
    """Geriye dönük imza; yeni skor formülü (KAPANIS için)."""
    tm = tercih_map or {}
    ho = hafta_onceki or {}
    ba = bugun_atanan or {}
    stm = son_tip_map or {}
    k_e = _efektif_personel_kisit(p, kisitlar)
    if not k_e.get("kapanis_yapabilir", True):
        return (-1e18, p.get("ad_soyad") or "")
    hg = hafta_gunu if hafta_gunu is not None else 0
    gm = gunluk_map or {}
    if not personel_tip_yapabilir(p, "KAPANIS", kisitlar, gm, hg):
        return (-1e18, p.get("ad_soyad") or "")
    return _atama_skoru_detay(p, "KAPANIS", k_e, tm, ho, ba, stm)


def _sube_icin_skorlu_ata(
    personeller: List[Dict[str, Any]],
    cfg: Dict[str, Any],
    kisitlar: Dict[str, Dict[str, Any]],
    hafta_sonu: bool,
    sube_ad: str,
    log: List[Dict[str, Any]],
    gunluk_map: Optional[Dict[Tuple[str, int], Dict[str, Any]]] = None,
    hafta_gunu: Optional[int] = None,
    tercih_map: Optional[Dict[str, List[Tuple[str, int]]]] = None,
    hafta_onceki: Optional[Dict[str, Dict[str, float]]] = None,
    bugun_atanan: Optional[Dict[str, float]] = None,
    son_tip_map: Optional[Dict[str, Optional[str]]] = None,
) -> Tuple[List[Tuple[Dict[str, Any], str, str]], int, int, Set[str]]:
    """
    Her personele tam bir tip atar.
    Dönüş: [(personel, tip, neden), ...], kapanis_sayisi, acilis_sayisi, atanan_ids
    """
    min_kap = (
        int(cfg.get("hafta_sonu_min_kap") or 1)
        if hafta_sonu
        else int(cfg.get("min_kapanis") or 1)
    )
    tek_kap_izinli = bool(cfg.get("tek_kapanis_izinli", True))
    tek_acilis_izinli = bool(cfg.get("tek_acilis_izinli", True))
    kapanis_dusurulemez = bool(cfg.get("kapanis_dusurulemez", False))

    n = len(personeller)
    atanan_ids: Set[str] = set()
    sonuc: List[Tuple[Dict[str, Any], str, str]] = []

    if n == 0:
        return sonuc, 0, 0, atanan_ids

    tm = tercih_map or {}
    ho = hafta_onceki or {}
    ba = bugun_atanan or {}
    stm = son_tip_map or {}
    hg = hafta_gunu if hafta_gunu is not None else 0
    gm = gunluk_map or {}

    # 1) sadece_tip sabitleri (genel veya günlük satır)
    sabit: List[Tuple[Dict[str, Any], str]] = []
    esnek: List[Dict[str, Any]] = []
    for p in personeller:
        st = _personel_efektif_sadece_tip(p, kisitlar, gm, hg)
        if st and st in TIPLER:
            if personel_tip_yapabilir(p, st, kisitlar, gunluk_map, hafta_gunu):
                sabit.append((p, st))
            else:
                log.append(
                    {
                        "kural": "KISIT",
                        "personel": p["ad_soyad"],
                        "sube": sube_ad,
                        "detay": f"sadece_tip={st} uyumsuz",
                    }
                )
        else:
            esnek.append(p)

    kullanilan: Set[str] = set()
    kapanis_sayisi = 0
    acilis_sayisi = 0

    for p, tip in sabit:
        sonuc.append((p, tip, "Kısıt: sadece_tip"))
        kullanilan.add(p["id"])
        atanan_ids.add(p["id"])
        if tip == "KAPANIS":
            kapanis_sayisi += 1
        if tip == "ACILIS":
            acilis_sayisi += 1

    kalan = [p for p in esnek if p["id"] not in kullanilan]
    nk = len(kalan)
    if nk == 0:
        return sonuc, kapanis_sayisi, acilis_sayisi, atanan_ids

    # 2) Hedef kapanış sayısı (şube personeli içinde)
    kap_yapabilen = [
        p
        for p in kalan
        if personel_tip_yapabilir(p, "KAPANIS", kisitlar, gunluk_map, hafta_gunu)
    ]
    kap_yapabilen.sort(
        key=lambda p: _skor_kapanis_adayi(
            p, kisitlar, tm, ho, ba, stm, gm, hg
        ),
        reverse=True,
    )

    hedef_kap = min(min_kap, nk, len(kap_yapabilen))
    if nk == 1 and not tek_kap_izinli and not kapanis_dusurulemez:
        hedef_kap = 0
    elif nk == 1 and not tek_kap_izinli and kapanis_dusurulemez:
        hedef_kap = 1 if len(kap_yapabilen) >= 1 else 0
    elif nk == 1 and tek_kap_izinli:
        hedef_kap = 1 if len(kap_yapabilen) >= 1 else 0

    kap_atanan: Set[str] = set()
    for p in kap_yapabilen:
        if len(kap_atanan) >= hedef_kap:
            break
        sonuc.append(
            (p, "KAPANIS", "Skor: min_kapanis / hafta sonu kuralı (öncelikli aday)"),
        )
        kap_atanan.add(p["id"])
        kullanilan.add(p["id"])
        atanan_ids.add(p["id"])
        kapanis_sayisi += 1

    # 3) Kalanlara ACILIS önceliği (tek açılış uyarısı için mümkün olduğunca çok açılış)
    hala = [p for p in kalan if p["id"] not in kullanilan]
    acilis_aday = [
        p
        for p in hala
        if personel_tip_yapabilir(p, "ACILIS", kisitlar, gunluk_map, hafta_gunu)
    ]
    acilis_aday.sort(
        key=lambda p: (
            _atama_skoru_detay(
                p,
                "ACILIS",
                _efektif_personel_kisit(p, kisitlar),
                tm,
                ho,
                ba,
                stm,
            )[0],
            1 if p.get("calisma_turu") == "surekli" else 0,
            p.get("ad_soyad") or "",
        ),
        reverse=True,
    )

    # En az 2 açılış hedefi: tek_acilis_izinli False ise iki kişiye ACILIS dene
    hedef_ac = 2 if (not tek_acilis_izinli and len(hala) >= 2) else 0
    ac_atanan = 0
    for p in acilis_aday:
        if hedef_ac <= 0 or ac_atanan >= hedef_ac:
            break
        if p["id"] in kullanilan:
            continue
        sonuc.append((p, "ACILIS", "Skor: min açılış çeşitliliği"))
        kullanilan.add(p["id"])
        atanan_ids.add(p["id"])
        acilis_sayisi += 1
        ac_atanan += 1

    # 4) Geri kalan: ACILIS / ARA sırayla (sıra: atanacak ilk tipe göre skor)
    hala = [p for p in kalan if p["id"] not in kullanilan]

    def _ilk_atanacak_tip_skoru(pp: Dict[str, Any]) -> float:
        k_e = _efektif_personel_kisit(pp, kisitlar)
        if personel_tip_yapabilir(pp, "ACILIS", kisitlar, gm, hg):
            return _atama_skoru_detay(pp, "ACILIS", k_e, tm, ho, ba, stm)[0]
        if personel_tip_yapabilir(pp, "ARA", kisitlar, gm, hg):
            return _atama_skoru_detay(pp, "ARA", k_e, tm, ho, ba, stm)[0]
        if personel_tip_yapabilir(pp, "KAPANIS", kisitlar, gm, hg):
            return _atama_skoru_detay(pp, "KAPANIS", k_e, tm, ho, ba, stm)[0]
        return -1e18

    for p in sorted(
        hala,
        key=lambda x: (-_ilk_atanacak_tip_skoru(x), x.get("ad_soyad") or ""),
    ):
        if personel_tip_yapabilir(p, "ACILIS", kisitlar, gunluk_map, hafta_gunu):
            t = "ACILIS"
            ned = "Kalan slot: açılış"
        elif personel_tip_yapabilir(p, "ARA", kisitlar, gunluk_map, hafta_gunu):
            t = "ARA"
            ned = "Kalan slot: ara"
        elif personel_tip_yapabilir(p, "KAPANIS", kisitlar, gunluk_map, hafta_gunu):
            t = "KAPANIS"
            ned = "Kalan slot: kapanış"
            kapanis_sayisi += 1
        else:
            log.append(
                {
                    "kural": "KISIT",
                    "personel": p["ad_soyad"],
                    "sube": sube_ad,
                    "detay": "Hiçbir tip atanamadı",
                }
            )
            continue
        if t == "ACILIS":
            acilis_sayisi += 1
        sonuc.append((p, t, ned))
        atanan_ids.add(p["id"])

    # 5) tek kişi + tek kapanış yasak (ve düşürülebilir)
    if nk == 1 and not tek_kap_izinli and not kapanis_dusurulemez:
        p = kalan[0]
        for i, (pp, tip, ned) in enumerate(sonuc):
            if pp["id"] == p["id"] and tip == "KAPANIS":
                if personel_tip_yapabilir(p, "ARA", kisitlar, gunluk_map, hafta_gunu):
                    sonuc[i] = (p, "ARA", "Tek kapanış yasak → ARA")
                    kapanis_sayisi = max(0, kapanis_sayisi - 1)
                    log.append(
                        {
                            "kural": "TEK_KAP_YASAK",
                            "personel": p["ad_soyad"],
                            "sube": sube_ad,
                            "detay": "Tek personel; kapanış yerine ARA",
                        }
                    )
                break

    if not tek_acilis_izinli and acilis_sayisi < 2 and nk >= 2:
        log.append(
            {
                "kural": "MIN_ACILIS_UYARI",
                "sube": sube_ad,
                "detay": "Tek açılış yasak hedefi tam karşılanmadı; personel/kısıt kontrol edin",
            }
        )

    return sonuc, kapanis_sayisi, acilis_sayisi, atanan_ids


def _vardiya_on_secim_havuzu(
    cur,
    tarih_str: str,
    subeler: Dict[str, Dict[str, Any]],
    log: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], Set[str]]:
    """
    Aktif şubeler zaten `subeler` sözlüğünde.
    Personel: aktif + vardiyaya_dahil (satır yoksa veya TRUE → dahil).
    İzinliler çıkarılmış liste döner; izinliler kümesi ayrıca döner (log için).
    """
    cur.execute(
        """
        SELECT personel_id FROM personel_izin
        WHERE durum = 'onaylandi'
          AND baslangic_tarih <= %s AND bitis_tarih >= %s
        """,
        (tarih_str, tarih_str),
    )
    izinliler: Set[str] = {r["personel_id"] for r in cur.fetchall()}
    if izinliler:
        log.append(
            {
                "kural": "IZIN",
                "detay": f"{len(izinliler)} personel izinli, vardiyadan çıkarıldı",
            }
        )

    cur.execute(
        """
        SELECT p.* FROM personel p
        LEFT JOIN personel_config pc ON pc.personel_id = p.id
        WHERE p.aktif = TRUE
          AND COALESCE(pc.vardiyaya_dahil, TRUE) = TRUE
        ORDER BY p.calisma_turu DESC, p.ad_soyad
        """
    )
    tum = [dict(p) for p in cur.fetchall()]
    musait = [p for p in tum if p["id"] not in izinliler]

    log.append(
        {
            "kural": "ON_SECIM",
            "detay": (
                f"Aktif şube: {len(subeler)} · vardiyaya dahil aktif personel: {len(tum)} · "
                f"izin sonrası havuz: {len(musait)}"
            ),
        }
    )
    return musait, izinliler


def vardiya_motoru_calistir(cur, tarih: date) -> Dict[str, Any]:
    """
    cur: psycopg cursor (dict rows).
    Yalnızca aktif şubeler ve personel_config.vardiyaya_dahil personelle çalışır.
    sube_config ve personel_kisit okunur (yoksa güvenli varsayılan).
    """
    log: List[Dict[str, Any]] = []
    hafta_sonu = tarih.weekday() >= 5
    tarih_str = str(tarih)

    cur.execute("DELETE FROM vardiya WHERE tarih = %s", (tarih_str,))

    cur.execute("SELECT * FROM subeler WHERE aktif = TRUE ORDER BY ad")
    subeler_raw = cur.fetchall()

    cur.execute("SELECT * FROM sube_config")
    sube_cfg: Dict[str, Dict[str, Any]] = {r["sube_id"]: dict(r) for r in cur.fetchall()}

    # Otomatik planda olmayan şubeler (aktif kalır; motor bu şubeyi atlar)
    subeler: Dict[str, Dict[str, Any]] = {}
    for s in subeler_raw:
        sid = s["id"]
        merged = {**_default_sube_cfg(sid), **(sube_cfg.get(sid) or {})}
        if merged.get("vardiyaya_dahil", True) is False:
            continue
        subeler[sid] = dict(s)

    if not subeler:
        return {
            "success": True,
            "tarih": tarih_str,
            "olusturulan": 0,
            "izinli_sayisi": 0,
            "log": [
                {
                    "kural": "HATA",
                    "detay": "Vardiyaya dahil aktif şube yok (tüm şubeler devre dışı veya pasif).",
                }
            ],
            "mesaj": "Vardiyaya dahil şube tanımlı değil.",
        }

    cur.execute("SELECT * FROM personel_kisit")
    kisitlar: Dict[str, Dict[str, Any]] = {r["personel_id"]: dict(r) for r in cur.fetchall()}
    gunluk_map = _gunluk_kisit_map_yukle(cur)
    tercih_map = _tercih_map_yukle(cur)
    hafta_gunu = tarih.weekday()

    musait, izinliler = _vardiya_on_secim_havuzu(cur, tarih_str, subeler, log)
    if not musait:
        return {
            "success": True,
            "tarih": tarih_str,
            "olusturulan": 0,
            "izinli_sayisi": len(izinliler),
            "log": log
            + [
                {
                    "kural": "HATA",
                    "detay": "Vardiya havuzu boş (vardiyaya dahil personel yok veya tümü izinli).",
                }
            ],
            "mesaj": "Ön seçim sonrası vardiya havuzunda personel yok; vardiya oluşturulmadı.",
        }

    pzt_hafta = _pazartesi_hafta(tarih)
    musait_id_set = {p["id"] for p in musait}
    hafta_onceki = _hafta_onceki_istatistik(cur, musait_id_set, pzt_hafta, tarih)
    son_tip_map = _son_vardiya_tipi_map(cur, musait_id_set, tarih_str)
    bugun_atanan_saat: Dict[str, float] = defaultdict(float)

    # Ana şube (personel.sube_id): yalnızca şube başına Faz 1’de kaç kişi seçileceği kotası.
    # Kim hangi şubede çalışır: havuzdan skor/kısıt; kart şubesi atamada ayrıcalık veya sınır değildir.
    ana_sube_map: Dict[str, str] = {
        p["id"]: _personel_ana_sube_id(p, cur, subeler) for p in musait
    }
    sube_kota: Dict[str, int] = {sid: 0 for sid in subeler}
    for p in musait:
        aid = ana_sube_map[p["id"]]
        if aid in sube_kota:
            sube_kota[aid] += 1
        else:
            sube_kota[next(iter(subeler.keys()))] += 1

    sube_saat_map: Dict[str, Dict[str, Tuple[str, str]]] = {}
    for sid in subeler:
        cfg_m = {**_default_sube_cfg(sid), **(sube_cfg.get(sid) or {})}
        sube_saat_map[sid] = sube_tip_saatleri(cfg_m)

    olusturulan = 0

    def vardiya_yaz(
        personel: Dict[str, Any],
        tip: str,
        sube_id: str,
        neden: str,
    ) -> None:
        nonlocal olusturulan
        pid = personel["id"]
        k_base = _efektif_personel_kisit(personel, kisitlar)
        gk_row = gunluk_map.get((pid, hafta_gunu))
        k_merged = _birlesik_kisit_gunluk(k_base, gk_row)
        if not personel_tip_yapabilir(personel, tip, kisitlar, gunluk_map, hafta_gunu):
            log.append(
                {
                    "kural": "KISIT_MOTORU",
                    "personel": personel["ad_soyad"],
                    "detay": f"{tip} bu gün/kısıt ile uygun değil",
                }
            )
            return
        if not _hafta_max_gun_izin(pid, k_base, bugun_atanan_saat, hafta_onceki):
            log.append(
                {
                    "kural": "KISIT_MOTORU",
                    "personel": personel["ad_soyad"],
                    "detay": "hafta_max_gun: bu hafta çalışılabilecek gün kotası doldu",
                }
            )
            return
        if _vardiya_sayisi_bugun(cur, tarih_str, pid) >= MAX_VARDIYA_KAYIT_GUNLUK:
            log.append(
                {
                    "kural": "LIMIT_GUNLUK",
                    "personel": personel["ad_soyad"],
                    "detay": "Günlük kayıt sınırı dolu; ek atama yapılmadı",
                }
            )
            return
        smap = sube_saat_map.get(sube_id) or sube_tip_saatleri(_default_sube_cfg(sube_id))
        bas, bit = smap[tip]
        if tip == "KAPANIS" and k_base.get("kapanis_bit_saat"):
            bit = _time_hhmmss(k_base.get("kapanis_bit_saat"), bit)
            neden = f"{neden} [kapanış bitiş: {bit[:5]}]"
        if not _vardiya_saat_sinirlari_uygun(k_merged, bas, bit, tip):
            log.append(
                {
                    "kural": "KISIT_MOTORU",
                    "personel": personel["ad_soyad"],
                    "detay": "min_baslangic_saat / max_cikis_saat / kapanis_bit_saat uyumsuz",
                }
            )
            return
        h_saat = _vardiya_aralik_saat(bas, bit)
        if not _atama_kisit_saat_limitleri(
            pid, k_merged, h_saat, bugun_atanan_saat, hafta_onceki
        ):
            log.append(
                {
                    "kural": "KISIT_MOTORU",
                    "personel": personel["ad_soyad"],
                    "detay": "gunluk_max_saat veya haftalik_max_saat aşımı",
                }
            )
            return
        vid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO vardiya (id, tarih, personel_id, sube_id, tip, bas_saat, bit_saat)
            VALUES (%s, %s, %s, %s, %s, %s::time, %s::time)
            """,
            (vid, tarih_str, pid, sube_id, tip, bas, bit),
        )
        olusturulan += 1
        bugun_atanan_saat[pid] += h_saat
        log.append(
            {
                "kural": "VARDIYA",
                "personel": personel["ad_soyad"],
                "sube": subeler.get(sube_id, {}).get("ad", sube_id),
                "tip": tip,
                "detay": neden,
            }
        )

    log.append(
        {
            "kural": "HAVUZ",
            "detay": "Faz 1: havuz + personel_kisit / gunluk_kisit / saat-kota / şube listesi motoru.",
        }
    )
    musait_faz1_kapandi: Set[str] = set()

    # ── Faz 1: Şube kotası kadar kişi, havuzdan seçilir ────────────────────
    for sube_id in subeler:
        cfg_row = sube_cfg.get(sube_id)
        cfg = {**_default_sube_cfg(sube_id), **(cfg_row or {})}
        tam_part_zorunlu = bool(cfg.get("tam_part_zorunlu", False))
        min_kap = (
            int(cfg.get("hafta_sonu_min_kap") or 1)
            if hafta_sonu
            else int(cfg.get("min_kapanis") or 1)
        )
        tek_kap_izinli = bool(cfg.get("tek_kapanis_izinli", True))

        sube_ad = subeler.get(sube_id, {}).get("ad") or sube_id
        need = int(sube_kota.get(sube_id, 0))

        adaylar_faz1 = [
            p
            for p in musait
            if p["id"] not in musait_faz1_kapandi
            and _vardiya_hedef_subede_calisabilir(
                p, sube_id, ana_sube_map[p["id"]], kisitlar
            )
            and _personel_en_az_bir_vardiya_tipi(p, kisitlar, gunluk_map, hafta_gunu)
        ]
        adaylar_faz1.sort(
            key=lambda p: (
                _faz1_aday_skoru(
                    p,
                    kisitlar,
                    gunluk_map,
                    hafta_gunu,
                    tercih_map,
                    hafta_onceki,
                    bugun_atanan_saat,
                    son_tip_map,
                ),
                p.get("ad_soyad") or "",
            ),
            reverse=True,
        )
        secilen = adaylar_faz1[: max(need, 0)]

        if need <= 0:
            continue

        if not secilen:
            log.append(
                {
                    "kural": "BOS_SUBE",
                    "sube": sube_ad,
                    "detay": f"Kota {need} kişi; havuz/kısıt ile uygun aday yok",
                }
            )
            continue

        if len(secilen) < need:
            log.append(
                {
                    "kural": "HAVUZ_UYARI",
                    "sube": sube_ad,
                    "detay": f"Kota {need}, yalnızca {len(secilen)} aday seçilebildi",
                }
            )

        atamalar, kapanis_sayisi, acilis_sayisi, atanan_ids = _sube_icin_skorlu_ata(
            secilen,
            cfg,
            kisitlar,
            hafta_sonu,
            sube_ad,
            log,
            gunluk_map,
            hafta_gunu,
            tercih_map,
            hafta_onceki,
            bugun_atanan_saat,
            son_tip_map,
        )
        atamalar, kapanis_sayisi = _atamalar_min_kapanis_yukselt(
            atamalar,
            min_kap,
            tek_kap_izinli,
            secilen,
            kisitlar,
            sube_ad,
            log,
            gunluk_map,
            hafta_gunu,
            tercih_map,
            hafta_onceki,
            bugun_atanan_saat,
            son_tip_map,
        )

        for p, tip, ned in atamalar:
            vardiya_yaz(p, tip, sube_id, ned)

        musait_faz1_kapandi.update(atanan_ids)

        if tam_part_zorunlu:
            tam_var = any(x.get("calisma_turu") == "surekli" for x in secilen)
            part_var = any(x.get("calisma_turu") != "surekli" for x in secilen)
            if tam_var and part_var:
                tam_atanmis = any(
                    p["id"] in atanan_ids and p.get("calisma_turu") == "surekli"
                    for p in secilen
                )
                part_atanmis = any(
                    p["id"] in atanan_ids and p.get("calisma_turu") != "surekli"
                    for p in secilen
                )
                if not (tam_atanmis and part_atanmis):
                    log.append(
                        {
                            "kural": "TAM_PART_UYARI",
                            "sube": sube_ad,
                            "detay": "1 tam + 1 part hedefi bu gün karşılanamadı",
                        }
                    )

    # Eksik kapanış için ek kaydırma ve “yetim” satırı yok: şube/personel zorla doldurulmaz.

    mesaj = (
        f"{olusturulan} vardiya oluşturuldu. "
        f"{len(izinliler)} personel izinli olduğu için dışarıda bırakıldı."
    )
    return {
        "success": True,
        "tarih": str(tarih),
        "olusturulan": olusturulan,
        "izinli_sayisi": len(izinliler),
        "log": log,
        "mesaj": mesaj,
    }


def vardiya_motoru_hafta_calistir(cur, referans_tarih: date) -> Dict[str, Any]:
    """
    Pazartesi–pazar 7 gün için sırayla günlük motoru çalıştırır.
    Haftalık kota / önceki gün istatistikleri her gün için doğru kümülatif kalır.
    """
    pzt = _pazartesi_hafta(referans_tarih)
    gunler: List[Dict[str, Any]] = []
    toplam = 0
    for i in range(7):
        g = pzt + timedelta(days=i)
        r = vardiya_motoru_calistir(cur, g)
        n = int(r.get("olusturulan") or 0)
        toplam += n
        gunler.append(
            {
                "tarih": r.get("tarih") or str(g),
                "olusturulan": n,
                "izinli_sayisi": r.get("izinli_sayisi", 0),
                "mesaj": r.get("mesaj", ""),
                "log_ozet": len(r.get("log") or []),
            }
        )
    return {
        "success": True,
        "hafta_baslangic": str(pzt),
        "hafta_bitis": str(pzt + timedelta(days=6)),
        "toplam_olusturulan": toplam,
        "gunler": gunler,
        "mesaj": f"Haftalık plan: {toplam} vardiya kaydı (7 gün).",
    }
