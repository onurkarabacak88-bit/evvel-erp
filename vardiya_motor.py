"""
Günlük vardiya: ön seçim (aktif şubeler + personel_config.vardiyaya_dahil), izin,
şube_config + personel_kisit; havuz atama (kart şubesi yalnızca kota sayımı).
Şube veya personel zorla doldurulmaz (ek kapanış kaydırması ve yetim satırı yok).

Şube bazında planla_acilis / planla_kapanis kapalıysa o şubede ilgili tip atanmaz.
Part/yarı zamanlı için part_gunluk_max_saat ve gunluk_mesai_fazlasi_saat günlük üst sınırı
birleştirir. Çapraz şubede tek vardiyayı ikiye bölme (part mesai A’da, kalan B’de) henüz yok;
şema tek satır / tek şube ile kalır.

Mimari notlar (Tulipi / çapraz şube):
- A şubede gündüz + B şubede kapanış → iki ayrı vardiya satırı (iki sube_id, aynı gün).
  İleride tek satırda baslangic_sube / bitis_sube eklenirse şema genişletilir.
- Günlük aynı personel için en fazla MAX_VARDIYA_KAYIT_GUNLUK kayıt (çift kayıt sınırı).
- Şube saatleri: sube_config’teki acilis_/ara_/kapanis_ bas/bit (boşsa VARDIYA_SAATLER varsayılanı).

Pipeline (günlük çalıştırma — `vardiya_motoru_calistir`):
1. Şube verisini al — aktif şubeler + `sube_config`, vardiyaya dahil filtre
2. Personel filtrele — izin / kısıt / günlük durum sonrası havuz (`musait`)
3. **Generate** — mevcut `vardiya` silmeden (koru_manuel dışında) kota eksiklerine göre yalnızca yeni
   `kaynak='motor'` satırı INSERT; o gün zaten kaydı olan personel Faz 1’e alınmaz (çift atama yok)
4. **Fix** — eksik / fazla şubeleri tek tek; şubeler arası kaydırma, ARA indirme, güvenli silme
   (`FIX_*` kuralları); bir dalgada ardışık tetiklenen düzeltme en fazla `VARDIYA_FIX_ZINCIR_MAX_DERINLIK`
5. **Stabilize** — global kontrol tam olana veya ilerleme bitene kadar dalgalar (`VARDIYA_STABILIZE_MAX_TUR`)
6. Optimize et — tur sonunda yerel uyarılar (örn. part günlük min saat altı)
7. Sonucu döndür — log, mesaj, denge meta (`denge_stabil`, `denge_fix_adim`)
"""
from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import date, timedelta
from typing import Any, Dict, List, Optional, Set, Tuple

from vardiya_planlama import girdilerden_need_ve_minler, normalize_vardiya_girdileri

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

# Eski: tam reset + şube sırası döngüsü (artık kullanılmıyor; geriye dönük sabit)
VARDIYA_DENGE_MAX = 12

# Stabilize: bir dalgada ardışık yapılan otomatik düzeltme (kaydırma sonrası yeniden değerlendirme)
VARDIYA_FIX_ZINCIR_MAX_DERINLIK = 3
# Stabilize dış döngüsü (her dalga: en fazla ZINCIR_MAX_DERINLIK ardışık fix)
VARDIYA_STABILIZE_MAX_TUR = 48

# Eski mesajlarda geçen üst sınır ile uyum (artık stabilize tur sayısı)
VARDIYA_FIX_CHAIN_MAX = VARDIYA_STABILIZE_MAX_TUR


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


def _vardiya_db_saat_str(v: Any) -> str:
    """TIME / string → HH:MM:SS (aralık saati için)."""
    if v is None:
        return "00:00:00"
    if hasattr(v, "strftime"):
        return v.strftime("%H:%M:%S")
    return _time_hhmmss(str(v).strip(), "00:00:00")


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


def _gunluk_saat_kisit_birlestir_min(
    weekly_min: Optional[str], daily_en_erken: Optional[str]
) -> Optional[str]:
    """Haftalık min başlangıç + günlük en_erken → daha geç olanı (daha sıkı)."""
    if not daily_en_erken or not str(daily_en_erken).strip():
        return weekly_min if weekly_min and str(weekly_min).strip() else None
    dm = _saat_metni_dakika(daily_en_erken)
    if dm is None:
        return weekly_min if weekly_min and str(weekly_min).strip() else None
    wm = _saat_metni_dakika(weekly_min)
    if wm is None:
        return _dakika_time_str(dm)[:5]
    return _dakika_time_str(max(wm, dm))[:5]


def _gunluk_saat_kisit_birlestir_max(
    weekly_max: Optional[str], daily_en_gec: Optional[str]
) -> Optional[str]:
    """Haftalık max çıkış + günlük en_gec → daha erken olanı (daha sıkı)."""
    if not daily_en_gec or not str(daily_en_gec).strip():
        return weekly_max if weekly_max and str(weekly_max).strip() else None
    dm = _saat_metni_dakika(daily_en_gec)
    if dm is None:
        return weekly_max if weekly_max and str(weekly_max).strip() else None
    wm = _saat_metni_dakika(weekly_max)
    if wm is None:
        return _dakika_time_str(dm)[:5]
    return _dakika_time_str(min(wm, dm))[:5]


def _dakika_time_str(m: int) -> str:
    m = max(0, min(int(m), 24 * 60 - 1))
    return f"{m // 60:02d}:{m % 60:02d}:00"


def _ikili_pencereden_uc_vardiya_slot(
    acilis_uç: str, kapanis_uç: str
) -> Optional[Dict[str, str]]:
    """Mağaza açılış–kapanış uçlarından ACILIS/ARA/KAPANIS aralıkları (eşit üç parça)."""
    a = _saat_metni_dakika(acilis_uç)
    b = _saat_metni_dakika(kapanis_uç)
    if a is None or b is None or b <= a:
        return None
    span = b - a
    s1 = a + span // 3
    s2 = a + (2 * span) // 3
    return {
        "acilis_bas_saat": _dakika_time_str(a),
        "acilis_bit_saat": _dakika_time_str(s1),
        "ara_bas_saat": _dakika_time_str(s1),
        "ara_bit_saat": _dakika_time_str(s2),
        "kapanis_bas_saat": _dakika_time_str(s2),
        "kapanis_bit_saat": _dakika_time_str(b),
    }


def _sube_cfg_gunluk_saatleri(
    cur, sube_id: str, tarih_str: str, cfg_m: Dict[str, Any]
) -> Dict[str, Any]:
    """Şube varsayılan açılış/kapanış (DB: default_*; kontrat alias: acilis_saati/kapanis_saati) + günlük override → üç slot."""
    out = dict(cfg_m)
    ac = out.get("default_acilis_saati") or out.get("acilis_saati")
    kc = out.get("default_kapanis_saati") or out.get("kapanis_saati")
    cur.execute(
        """
        SELECT acilis_saati, kapanis_saati
        FROM sube_saat_gunluk
        WHERE sube_id = %s AND tarih = %s
        """,
        (sube_id, tarih_str),
    )
    ow = cur.fetchone()
    if ow:
        if ow.get("acilis_saati"):
            ac = ow["acilis_saati"]
        if ow.get("kapanis_saati"):
            kc = ow["kapanis_saati"]
    acs = str(ac).strip() if ac else ""
    kcs = str(kc).strip() if kc else ""
    if acs and kcs:
        slot = _ikili_pencereden_uc_vardiya_slot(acs, kcs)
        if slot:
            out.update(slot)
    return out


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


def _sube_yasak_kumesi(k: Dict[str, Any]) -> Set[str]:
    """
    personel_sube_yasak birleşimi (yalnız yasak=TRUE). Kayıt yok = o şube serbest.
    """
    x = k.get("sube_yasak_ids")
    if not x:
        return set()
    if isinstance(x, set):
        return x
    if isinstance(x, (list, tuple)):
        return {str(s).strip() for s in x if s is not None and str(s).strip()}
    return set()


def _kaydirma_cift_kumesi(k: Dict[str, Any]) -> Optional[Set[Tuple[str, str]]]:
    """
    kaynak_id>hedef_id virgülle ayrılmış; yalnızca bu yönlü çiftlerle ana şube dışına kaydırma.
    Boş/None → ek kaydırma yönü kısıtı yok (izinli şube + sube_degistirebilir yeter).
    """
    raw = k.get("kaydirma_izin_ciftleri")
    if raw is None or str(raw).strip() == "":
        return None
    out: Set[Tuple[str, str]] = set()
    for part in str(raw).split(","):
        part = part.strip()
        if ">" not in part:
            continue
        a, b = part.split(">", 1)
        a, b = a.strip(), b.strip()
        if a and b:
            out.add((a, b))
    return out if out else None


def _vardiya_hedef_subede_calisabilir(
    p: Dict[str, Any],
    hedef_sube_id: str,
    ana_sube_id: str,
    kisitlar: Dict[str, Dict[str, Any]],
) -> bool:
    k = _kisit_of(p, kisitlar)
    if hedef_sube_id in _sube_yasak_kumesi(k):
        return False
    izinli = _izinli_sube_kumesi(k)
    if izinli is not None and hedef_sube_id not in izinli:
        return False
    if not k.get("sube_degistirebilir", True):
        return hedef_sube_id == ana_sube_id
    ciftler = _kaydirma_cift_kumesi(k)
    if ciftler:
        if hedef_sube_id == ana_sube_id:
            return True
        return (ana_sube_id, hedef_sube_id) in ciftler
    return True


def _gunluk_kisit_map_yukle(cur) -> Dict[Tuple[str, int], Dict[str, Any]]:
    cur.execute("SELECT * FROM personel_gunluk_kisit")
    m: Dict[Tuple[str, int], Dict[str, Any]] = {}
    for r in cur.fetchall():
        pid = r["personel_id"]
        hg = int(r["hafta_gunu"])
        m[(pid, hg)] = dict(r)
    return m


def _gunluk_durum_map_gun(
    cur, tarih_str: str
) -> Dict[Tuple[str, str], Dict[str, Any]]:
    """personel_gunluk_durum — yalnız bu gün. Kayıt yok = o personel için o gün override yok."""
    cur.execute(
        """
        SELECT personel_id, tarih, calisabilir, tur, en_erken, en_gec
        FROM personel_gunluk_durum
        WHERE tarih = %s::date
        """,
        (tarih_str,),
    )
    m: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for r in cur.fetchall():
        pid = r["personel_id"]
        td = r["tarih"]
        ts = td.isoformat() if hasattr(td, "isoformat") else str(td)[:10]
        m[(pid, ts)] = dict(r)
    return m


def _gunluk_efektif_gun_satir(
    pid: str,
    hafta_gunu: int,
    tarih_str: str,
    gunluk_map: Optional[Dict[Tuple[str, int], Dict[str, Any]]],
    durum_map: Optional[Dict[Tuple[str, str], Dict[str, Any]]],
) -> Optional[Dict[str, Any]]:
    """Haftalık şablon + o güne özel personel_gunluk_durum birleşimi."""
    gk: Optional[Dict[str, Any]] = None
    if gunluk_map is not None:
        row = gunluk_map.get((pid, hafta_gunu))
        if row:
            gk = dict(row)
    if durum_map is not None and tarih_str:
        ovr = durum_map.get((pid, tarih_str))
        if ovr:
            gk = dict(gk) if gk else {}
            if "calisabilir" in ovr:
                cb = bool(ovr.get("calisabilir", True))
                gk["calisabilir"] = cb
                gk["calisamaz"] = not cb
            tur_raw = ovr.get("tur")
            if tur_raw is not None and str(tur_raw).strip() != "":
                tu = str(tur_raw).strip().lower()
                if tu in ("tam", "part"):
                    gk["gunluk_tur"] = tu
            else:
                gk.pop("gunluk_tur", None)
            ee_raw = ovr.get("en_erken")
            eg_raw = ovr.get("en_gec")
            sk = ovr.get("saat_kisiti")
            if isinstance(sk, dict):
                if ee_raw is None:
                    ee_raw = sk.get("en_erken")
                if eg_raw is None:
                    eg_raw = sk.get("en_gec")
            wmin = gk.get("min_baslangic") or gk.get("min_baslangic_saat")
            wmax = gk.get("max_cikis") or gk.get("max_cikis_saat")
            merged_min = _gunluk_saat_kisit_birlestir_min(
                str(wmin).strip() if wmin else None, ee_raw
            )
            merged_max = _gunluk_saat_kisit_birlestir_max(
                str(wmax).strip() if wmax else None, eg_raw
            )
            if merged_min:
                gk["min_baslangic"] = merged_min
            if merged_max:
                gk["max_cikis"] = merged_max
    return gk


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
    durum_map: Optional[Dict[Tuple[str, str], Dict[str, Any]]] = None,
    tarih_str: Optional[str] = None,
) -> bool:
    return any(
        personel_tip_yapabilir(
            p, t, kisitlar, gunluk_map, hafta_gunu, durum_map, tarih_str
        )
        for t in TIPLER
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


def _gunluk_saat_limit_max(k: Dict[str, Any], personel: Dict[str, Any]) -> Optional[float]:
    """Günlük üst sınır + mesai fazlası. None = günlük tavan tanımlı değil."""
    gmx = k.get("gunluk_max_saat")
    try:
        gmax_f = float(gmx) if gmx is not None and str(gmx).strip() != "" else None
    except (TypeError, ValueError):
        gmax_f = None
    profil = _calisma_profili_normalize(k.get("calisma_profili"))
    ct = (personel.get("calisma_turu") or "").strip().lower()
    part_time = ct != "surekli" or profil == "part_time"
    gt = str(k.get("gunluk_tur") or "").strip().lower()
    if gt == "tam":
        part_time = False
    elif gt == "part":
        part_time = True
    pmx = k.get("part_gunluk_max_saat")
    if part_time and pmx is not None and str(pmx).strip() != "":
        try:
            pmax = float(pmx)
            gmax_f = pmax if gmax_f is None else min(gmax_f, pmax)
        except (TypeError, ValueError):
            pass
    faz = k.get("gunluk_mesai_fazlasi_saat")
    try:
        fz = float(faz) if faz is not None and str(faz).strip() != "" else 0.0
    except (TypeError, ValueError):
        fz = 0.0
    fz = max(0.0, fz)
    if gmax_f is None:
        return None
    return gmax_f + fz


def _atama_kisit_saat_limitleri(
    pid: str,
    k: Dict[str, Any],
    yeni_saat: float,
    bugun_atanan: Dict[str, float],
    hafta_onceki: Dict[str, Dict[str, float]],
    personel: Optional[Dict[str, Any]] = None,
) -> bool:
    if personel is not None:
        cap = _gunluk_saat_limit_max(k, personel)
    else:
        cap = None
        gmax = k.get("gunluk_max_saat")
        if gmax is not None and str(gmax).strip() != "":
            try:
                cap = float(gmax)
            except (TypeError, ValueError):
                cap = None
    if cap is not None:
        if bugun_atanan.get(pid, 0.0) + yeni_saat > cap + 1e-6:
            return False
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
    durum_map: Optional[Dict[Tuple[str, str], Dict[str, Any]]] = None,
    tarih_str: Optional[str] = None,
) -> Tuple[List[Tuple[Dict[str, Any], str, str]], int]:
    """tek_kapanis_izinli=False iken çoklu personelde yerelde yeterli kapanış sayısına yaklaş."""
    n = len(personeller)
    yapabilen = sum(
        1
        for p in personeller
        if personel_tip_yapabilir(
            p, "KAPANIS", kisitlar, gunluk_map, hafta_gunu, durum_map, tarih_str
        )
    )
    try:
        mk = int(min_kap) if min_kap is not None else 1
    except (TypeError, ValueError):
        mk = 1
    if mk < 0:
        mk = 0
    hedef = min(mk, n, max(yapabilen, 0)) if mk > 0 else 0
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
            if personel_tip_yapabilir(
                p, "KAPANIS", kisitlar, gm, hg, durum_map, tarih_str
            ):
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
        "planla_acilis": True,
        "planla_kapanis": True,
        "acilis_bas_saat": None,
        "acilis_bit_saat": None,
        "ara_bas_saat": None,
        "ara_bit_saat": None,
        "kapanis_bas_saat": None,
        "kapanis_bit_saat": None,
        "default_acilis_saati": None,
        "default_kapanis_saati": None,
        "vardiya_girdileri": None,
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
        "part_gunluk_min_saat": None,
        "part_gunluk_max_saat": None,
        "gunluk_mesai_fazlasi_saat": None,
        "kaydirma_izin_ciftleri": None,
        "sube_yasak_ids": None,
    }


def _kisitlar_merge_sube_yasaklari(
    cur, kisitlar: Dict[str, Dict[str, Any]]
) -> None:
    """personel_sube_yasak → kisit satırına sube_yasak_ids (set). Kaydı olmayan personelde set yok (= serbest)."""
    cur.execute(
        "SELECT personel_id, sube_id FROM personel_sube_yasak WHERE yasak = TRUE"
    )
    yb: Dict[str, Set[str]] = defaultdict(set)
    for r in cur.fetchall():
        yb[r["personel_id"]].add(r["sube_id"])
    for pid, subs in yb.items():
        if pid not in kisitlar:
            kisitlar[pid] = _default_kisit(pid)
        kisitlar[pid]["sube_yasak_ids"] = set(subs)


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
    if gk.get("gunluk_tur"):
        k["gunluk_tur"] = gk["gunluk_tur"]
    return k


def _gunluk_calisabilir_mi(gk: Dict[str, Any]) -> bool:
    if "calisabilir" in gk and gk.get("calisabilir") is not None:
        return bool(gk.get("calisabilir"))
    return not bool(gk.get("calisamaz"))


def _personel_bugun_calisabilir_havuz(
    pid: str,
    hafta_gunu: int,
    tarih_str: str,
    gunluk_map: Optional[Dict[Tuple[str, int], Dict[str, Any]]],
    durum_map: Optional[Dict[Tuple[str, str], Dict[str, Any]]],
) -> bool:
    gk = _gunluk_efektif_gun_satir(pid, hafta_gunu, tarih_str, gunluk_map, durum_map)
    if gk is None:
        return True
    return _gunluk_calisabilir_mi(gk)


def _personel_efektif_sadece_tip(
    p: Dict[str, Any],
    kisitlar: Dict[str, Dict[str, Any]],
    gunluk_map: Optional[Dict[Tuple[str, int], Dict[str, Any]]],
    hafta_gunu: Optional[int],
    durum_map: Optional[Dict[Tuple[str, str], Dict[str, Any]]] = None,
    tarih_str: Optional[str] = None,
) -> Optional[str]:
    k = _kisit_of(p, kisitlar)
    st = k.get("sadece_tip")
    if st and st in TIPLER:
        return st
    hg = hafta_gunu if hafta_gunu is not None else 0
    gk = _gunluk_efektif_gun_satir(
        p["id"], hg, tarih_str or "", gunluk_map, durum_map
    )
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
    durum_map: Optional[Dict[Tuple[str, str], Dict[str, Any]]] = None,
    tarih_str: Optional[str] = None,
) -> bool:
    """personel_kisit + haftalık şablon + tarih bazlı personel_gunluk_durum."""
    hg = hafta_gunu if hafta_gunu is not None else 0
    gk = _gunluk_efektif_gun_satir(
        p["id"], hg, tarih_str or "", gunluk_map, durum_map
    )
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
    durum_map: Optional[Dict[Tuple[str, str], Dict[str, Any]]] = None,
    tarih_str: Optional[str] = None,
) -> float:
    k_e = _efektif_personel_kisit(p, kisitlar)
    best = -1e18
    for t in TIPLER:
        if personel_tip_yapabilir(
            p, t, kisitlar, gunluk_map, hafta_gunu, durum_map, tarih_str
        ):
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
    durum_map: Optional[Dict[Tuple[str, str], Dict[str, Any]]] = None,
    tarih_str: Optional[str] = None,
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
    if not personel_tip_yapabilir(
        p, "KAPANIS", kisitlar, gm, hg, durum_map, tarih_str
    ):
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
    durum_map: Optional[Dict[Tuple[str, str], Dict[str, Any]]] = None,
    tarih_str: Optional[str] = None,
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
    planla_acilis = bool(cfg.get("planla_acilis", True))
    planla_kapanis = bool(cfg.get("planla_kapanis", True))
    if not planla_kapanis:
        min_kap = 0
    tek_kap_izinli = bool(cfg.get("tek_kapanis_izinli", True))
    tek_acilis_izinli = bool(cfg.get("tek_acilis_izinli", True))
    kapanis_dusurulemez = bool(cfg.get("kapanis_dusurulemez", False))
    girdi_ma = int(cfg.get("girdi_min_acilis") or 0)
    girdi_mara = int(cfg.get("girdi_min_ara") or 0)

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
        st = _personel_efektif_sadece_tip(p, kisitlar, gm, hg, durum_map, tarih_str)
        if st and st in TIPLER:
            if personel_tip_yapabilir(p, st, kisitlar, gunluk_map, hafta_gunu, durum_map, tarih_str):
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
        ned = "Kısıt: sadece_tip"
        eff_tip = tip
        if tip == "ACILIS" and not planla_acilis:
            if personel_tip_yapabilir(p, "ARA", kisitlar, gunluk_map, hafta_gunu, durum_map, tarih_str):
                eff_tip = "ARA"
                ned = "Kısıt: sadece_tip (ACILIS) → ARA; bu şubede açılış planı kapalı"
            elif planla_kapanis and personel_tip_yapabilir(
                p, "KAPANIS", kisitlar, gunluk_map, hafta_gunu, durum_map, tarih_str
            ):
                eff_tip = "KAPANIS"
                ned = "Kısıt: sadece_tip (ACILIS) → KAPANIS; açılış planı kapalı"
            else:
                log.append(
                    {
                        "kural": "KISIT",
                        "personel": p["ad_soyad"],
                        "sube": sube_ad,
                        "detay": "sadece_tip=ACILIS ama şubede açılış kapalı; ARA/KAPANIS uygun değil",
                    }
                )
                continue
        elif tip == "KAPANIS" and not planla_kapanis:
            if personel_tip_yapabilir(p, "ARA", kisitlar, gunluk_map, hafta_gunu, durum_map, tarih_str):
                eff_tip = "ARA"
                ned = "Kısıt: sadece_tip (KAPANIS) → ARA; bu şubede kapanış planı kapalı"
            elif planla_acilis and personel_tip_yapabilir(
                p, "ACILIS", kisitlar, gunluk_map, hafta_gunu, durum_map, tarih_str
            ):
                eff_tip = "ACILIS"
                ned = "Kısıt: sadece_tip (KAPANIS) → ACILIS; kapanış planı kapalı"
            else:
                log.append(
                    {
                        "kural": "KISIT",
                        "personel": p["ad_soyad"],
                        "sube": sube_ad,
                        "detay": "sadece_tip=KAPANIS ama şubede kapanış kapalı",
                    }
                )
                continue
        sonuc.append((p, eff_tip, ned))
        kullanilan.add(p["id"])
        atanan_ids.add(p["id"])
        if eff_tip == "KAPANIS":
            kapanis_sayisi += 1
        if eff_tip == "ACILIS":
            acilis_sayisi += 1

    kalan = [p for p in esnek if p["id"] not in kullanilan]
    nk = len(kalan)
    if nk == 0:
        return sonuc, kapanis_sayisi, acilis_sayisi, atanan_ids

    # 2) Hedef kapanış sayısı (şube personeli içinde)
    kap_yapabilen = [
        p
        for p in kalan
        if personel_tip_yapabilir(
            p, "KAPANIS", kisitlar, gunluk_map, hafta_gunu, durum_map, tarih_str
        )
    ]
    kap_yapabilen.sort(
        key=lambda p: _skor_kapanis_adayi(
            p, kisitlar, tm, ho, ba, stm, gm, hg, durum_map, tarih_str
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
    if not planla_kapanis:
        hedef_kap = 0

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

    # 3) Kalanlara ACILIS önceliği (şubede açılış planı açıksa)
    if planla_acilis:
        hala = [p for p in kalan if p["id"] not in kullanilan]
        acilis_aday = [
            p
            for p in hala
            if personel_tip_yapabilir(
                p, "ACILIS", kisitlar, gunluk_map, hafta_gunu, durum_map, tarih_str
            )
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
        hedef_ac = max(hedef_ac, girdi_ma)
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

    # 4) Geri kalan: ACILIS / ARA / KAPANIS (şube plan bayraklarına göre)
    hala = [p for p in kalan if p["id"] not in kullanilan]

    def _ilk_atanacak_tip_skoru(pp: Dict[str, Any]) -> float:
        k_e = _efektif_personel_kisit(pp, kisitlar)
        skorlar: List[float] = []
        if planla_acilis and personel_tip_yapabilir(
            pp, "ACILIS", kisitlar, gm, hg, durum_map, tarih_str
        ):
            skorlar.append(_atama_skoru_detay(pp, "ACILIS", k_e, tm, ho, ba, stm)[0])
        if personel_tip_yapabilir(pp, "ARA", kisitlar, gm, hg, durum_map, tarih_str):
            skorlar.append(_atama_skoru_detay(pp, "ARA", k_e, tm, ho, ba, stm)[0])
        if planla_kapanis and personel_tip_yapabilir(
            pp, "KAPANIS", kisitlar, gm, hg, durum_map, tarih_str
        ):
            skorlar.append(_atama_skoru_detay(pp, "KAPANIS", k_e, tm, ho, ba, stm)[0])
        return max(skorlar) if skorlar else -1e18

    for p in sorted(
        hala,
        key=lambda x: (-_ilk_atanacak_tip_skoru(x), x.get("ad_soyad") or ""),
    ):
        if planla_acilis and personel_tip_yapabilir(
            p, "ACILIS", kisitlar, gunluk_map, hafta_gunu, durum_map, tarih_str
        ):
            t = "ACILIS"
            ned = "Kalan slot: açılış"
        elif personel_tip_yapabilir(p, "ARA", kisitlar, gunluk_map, hafta_gunu, durum_map, tarih_str):
            t = "ARA"
            ned = "Kalan slot: ara"
        elif planla_kapanis and personel_tip_yapabilir(
            p, "KAPANIS", kisitlar, gunluk_map, hafta_gunu, durum_map, tarih_str
        ):
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
                if personel_tip_yapabilir(p, "ARA", kisitlar, gunluk_map, hafta_gunu, durum_map, tarih_str):
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

    if (
        planla_acilis
        and not tek_acilis_izinli
        and acilis_sayisi < 2
        and nk >= 2
    ):
        log.append(
            {
                "kural": "MIN_ACILIS_UYARI",
                "sube": sube_ad,
                "detay": "Tek açılış yasak hedefi tam karşılanmadı; personel/kısıt kontrol edin",
            }
        )

    ara_n = sum(1 for _, t, _ in sonuc if t == "ARA")
    if girdi_mara > ara_n:
        log.append(
            {
                "kural": "GIRDI_ARA_UYARI",
                "sube": sube_ad,
                "detay": f"Ara vardiya hedefi {girdi_mara}, oluşan {ara_n}",
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


def _vardiya_ham_ozet_icin(cur, tarih_str: str) -> List[Dict[str, Any]]:
    """Şube özet / denge kontrolü için hafif vardiya satır listesi."""
    cur.execute(
        """
        SELECT v.sube_id, v.tip, COALESCE(v.kaynak, 'motor') AS kaynak,
               p.calisma_turu AS personel_calisma_turu,
               COALESCE(s.ad, '—') AS sube_adi
        FROM vardiya v
        JOIN personel p ON p.id = v.personel_id
        LEFT JOIN subeler s ON s.id = v.sube_id
        WHERE v.tarih = %s
        """,
        (tarih_str,),
    )
    return [dict(r) for r in cur.fetchall()]


def _vardiya_sube_ozet_hesapla(cur, tarih_str: str, ham: List[dict]) -> List[dict]:
    """Şube bazlı eksik / fazla / riskli / tam + manuel satır sayısı (renk + denge)."""
    by_sube: Dict[str, List[dict]] = defaultdict(list)
    for r in ham:
        sid = r.get("sube_id") or ""
        if sid:
            by_sube[sid].append(r)
    ozet: List[dict] = []
    for sid in sorted(by_sube.keys(), key=lambda x: (by_sube[x][0].get("sube_adi") or "")):
        lst = by_sube[sid]
        sube_adi = lst[0].get("sube_adi") or "—"
        counts = {"ACILIS": 0, "ARA": 0, "KAPANIS": 0}
        for x in lst:
            t = x.get("tip")
            if t in counts:
                counts[t] += 1
        manuel = sum(1 for x in lst if str(x.get("kaynak") or "motor") == "manuel")

        cur.execute("SELECT * FROM sube_config WHERE sube_id = %s", (sid,))
        row = cur.fetchone()
        cfg = {**_default_sube_cfg(sid), **(dict(row) if row else {})}
        cfg = _sube_cfg_gunluk_saatleri(cur, sid, tarih_str, cfg)
        vg = normalize_vardiya_girdileri(cfg.get("vardiya_girdileri"))
        active_girdi = bool(vg) and any(it.get("aktif") for it in vg)

        eksik = False
        fazla = False
        riskli_farketmez = False
        if active_girdi:
            need, ma, mara, mkap = girdilerden_need_ve_minler(vg)
            eksik = (
                counts["ACILIS"] < ma
                or counts["ARA"] < mara
                or counts["KAPANIS"] < mkap
            )
            fazla = (
                counts["ACILIS"] > ma
                or counts["ARA"] > mara
                or counts["KAPANIS"] > mkap
                or len(lst) > need
            )
            for it in vg:
                if not it.get("aktif"):
                    continue
                ks = int(it.get("kisi_sayisi") or 0)
                pt = str(it.get("personel_turu") or "farketmez").lower()
                if pt == "farketmez" and ks > 0:
                    riskli_farketmez = True
                    break
        else:
            if bool(cfg.get("planla_acilis", True)) and counts["ACILIS"] < 1:
                eksik = True
            if bool(cfg.get("planla_kapanis", True)) and counts["KAPANIS"] < 1:
                eksik = True

        riskli_tam_part = False
        if bool(cfg.get("tam_part_zorunlu")) and lst:
            has_tam = any(
                str(x.get("personel_calisma_turu") or "").strip().lower() == "surekli"
                for x in lst
            )
            has_part = any(
                str(x.get("personel_calisma_turu") or "").strip().lower() != "surekli"
                for x in lst
            )
            if not has_tam or not has_part:
                riskli_tam_part = True

        riskli = riskli_farketmez or riskli_tam_part
        if eksik:
            durum = "eksik"
        elif fazla:
            durum = "fazla"
        elif riskli:
            durum = "riskli"
        else:
            durum = "tam"
        ozet.append(
            {
                "sube_id": sid,
                "sube_adi": sube_adi,
                "durum": durum,
                "manuel_satir": manuel,
            }
        )
    return ozet


def _vardiya_plan_stabilite_kontrol(
    cur, tarih_str: str
) -> Tuple[bool, List[dict], List[str]]:
    """Global şube özeti — `vardiya_motoru_calistir` içinde ADIM 4 (`_adim4_global_kontrol`)."""
    ham = _vardiya_ham_ozet_icin(cur, tarih_str)
    ozet = _vardiya_sube_ozet_hesapla(cur, tarih_str, ham) if ham else []
    neden = [
        f"{o.get('sube_adi') or o['sube_id']}: {o['durum']}"
        for o in ozet
        if o.get("durum") != "tam"
    ]
    return len(neden) == 0, ozet, neden


def _faz1_sube_iterator(subeler: Dict[str, Any], round_seed: int) -> List[str]:
    """Faz 1 şube döngü sırasını döndür; seed ile döndürülmüş/ters sıra (denge denemeleri)."""
    keys = list(subeler.keys())
    if not keys:
        return []
    if round_seed <= 0:
        return keys
    r = round_seed % len(keys)
    out = keys[r:] + keys[:r]
    if round_seed % 2 == 1:
        out = list(reversed(out))
    return out


def _pipeline_adim6_optimize_uyarilar(
    log: List[Dict[str, Any]],
    musait: List[Dict[str, Any]],
    bugun_atanan_saat: Dict[str, float],
    kisitlar: Dict[str, Dict[str, Any]],
) -> None:
    """ADIM 6 — Tur sonrası yerel optimizasyon uyarıları (örn. part günlük min saat)."""
    pid_to_p = {p["id"]: p for p in musait}
    for pid, saat in bugun_atanan_saat.items():
        if saat <= 1e-6:
            continue
        p = pid_to_p.get(pid)
        if not p:
            continue
        k_e = _efektif_personel_kisit(p, kisitlar)
        pmn = k_e.get("part_gunluk_min_saat")
        if pmn is None or str(pmn).strip() == "":
            continue
        try:
            mn = float(pmn)
        except (TypeError, ValueError):
            continue
        profil = _calisma_profili_normalize(k_e.get("calisma_profili"))
        ct = (p.get("calisma_turu") or "").strip().lower()
        part_like = ct != "surekli" or profil == "part_time"
        if not part_like:
            continue
        if saat + 1e-6 < mn:
            log.append(
                {
                    "kural": "PART_GUN_MIN_UYARI",
                    "personel": p.get("ad_soyad"),
                    "detay": (
                        f"Bugün atanan toplam {saat:.2f} saat; "
                        f"yarı zamanlı günlük hedef minimum {mn} saat altında (izin günü / kota kontrol edin)"
                    ),
                }
            )


def _adim4_global_kontrol(
    cur, tarih_str: str
) -> Tuple[bool, List[dict], List[str]]:
    """ADIM 4 — Global kontrol: şube özeti eksik / fazla / riskli; hepsi `tam` mı?"""
    return _vardiya_plan_stabilite_kontrol(cur, tarih_str)


def _adim5_sapma_duzeltme_kaydi(
    neden: List[str], sonraki_tur_no: int, tur_ust: int
) -> Dict[str, Any]:
    """ADIM 5 — Sapma düzeltme: sonraki turda şube sırası değişerek 1→3 yeniden çalıştırılacak."""
    return {
        "kural": "DENGE_TEKRAR",
        "detay": (
            "Sapma düzeltme: yeniden şube sırası ile atama — "
            + "; ".join(neden[:8])
            + (" …" if len(neden) > 8 else "")
            + f" (tur {sonraki_tur_no}/{tur_ust})"
        ),
    }


def _bugun_atanan_saat_yukle(cur, tarih_str: str) -> Dict[str, float]:
    cur.execute(
        """
        SELECT personel_id,
               COALESCE(
                   SUM(
                       GREATEST(
                           0,
                           EXTRACT(EPOCH FROM (bit_saat - bas_saat)) / 3600.0
                       )
                   ),
                   0
               ) AS h
        FROM vardiya
        WHERE tarih = %s
        GROUP BY personel_id
        """,
        (tarih_str,),
    )
    return {r["personel_id"]: float(r["h"] or 0) for r in cur.fetchall()}


def _vardiya_ham_fix_icin(cur, tarih_str: str) -> List[Dict[str, Any]]:
    cur.execute(
        """
        SELECT v.id, v.personel_id, v.sube_id, v.tip, v.bas_saat, v.bit_saat,
               COALESCE(v.kaynak, 'motor') AS kaynak,
               p.calisma_turu, p.ad_soyad,
               COALESCE(s.ad, '—') AS sube_adi
        FROM vardiya v
        JOIN personel p ON p.id = v.personel_id
        LEFT JOIN subeler s ON s.id = v.sube_id
        WHERE v.tarih = %s
        """,
        (tarih_str,),
    )
    return [dict(r) for r in cur.fetchall()]


def _ham_to_ozet(r: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "sube_id": r["sube_id"],
        "tip": r["tip"],
        "kaynak": r.get("kaynak"),
        "personel_calisma_turu": r.get("calisma_turu"),
        "sube_adi": r.get("sube_adi"),
    }


def _ham_by_sube(ham: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    d: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in ham:
        d[r["sube_id"]].append(r)
    return d


def _fix_sube_meta(
    cur, tarih_str: str, sid: str, lst: List[Dict[str, Any]]
) -> Dict[str, Any]:
    counts = {"ACILIS": 0, "ARA": 0, "KAPANIS": 0}
    for x in lst:
        t = x.get("tip")
        if t in counts:
            counts[t] += 1
    cur.execute("SELECT * FROM sube_config WHERE sube_id = %s", (sid,))
    row = cur.fetchone()
    cfg = {**_default_sube_cfg(sid), **(dict(row) if row else {})}
    cfg = _sube_cfg_gunluk_saatleri(cur, sid, tarih_str, cfg)
    vg = normalize_vardiya_girdileri(cfg.get("vardiya_girdileri"))
    active_girdi = bool(vg) and any(it.get("aktif") for it in vg)
    if active_girdi:
        need, ma, mara, mkap = girdilerden_need_ve_minler(vg)
    else:
        need = len(lst)
        ma = mara = mkap = 0
        if bool(cfg.get("planla_acilis", True)):
            ma = max(ma, 1)
        if bool(cfg.get("planla_kapanis", True)):
            mkap = max(mkap, 1)
    return {
        "counts": counts,
        "ma": ma,
        "mara": mara,
        "mkap": mkap,
        "need": need,
        "active_girdi": active_girdi,
        "cfg": cfg,
        "len_lst": len(lst),
    }


def _fix_eksik_tips_ordered(
    cur, tarih_str: str, sid: str, lst: List[Dict[str, Any]]
) -> List[str]:
    """Öncelik: kapanış → açılış → ara (operasyonel kritiklik)."""
    meta = _fix_sube_meta(cur, tarih_str, sid, lst)
    c = meta["counts"]
    out: List[str] = []
    if c["KAPANIS"] < meta["mkap"]:
        out.append("KAPANIS")
    if c["ACILIS"] < meta["ma"]:
        out.append("ACILIS")
    if c["ARA"] < meta["mara"]:
        out.append("ARA")
    return out


def _fix_row_surplus(meta: Dict[str, Any], tip: str) -> int:
    c = meta["counts"]
    if tip == "ACILIS":
        return c["ACILIS"] - meta["ma"]
    if tip == "ARA":
        return c["ARA"] - meta["mara"]
    if tip == "KAPANIS":
        return c["KAPANIS"] - meta["mkap"]
    return 0


def _fix_tip_min_map(meta: Dict[str, Any]) -> Dict[str, int]:
    return {"ACILIS": meta["ma"], "ARA": meta["mara"], "KAPANIS": meta["mkap"]}


def _vardiya_fix_ctx_yukle(cur, tarih: date) -> Optional[Dict[str, Any]]:
    tarih_str = str(tarih)
    hafta_gunu = tarih.weekday()
    cur.execute("SELECT * FROM subeler WHERE aktif = TRUE ORDER BY ad")
    subeler_raw = cur.fetchall()
    cur.execute("SELECT * FROM sube_config")
    sube_cfg: Dict[str, Dict[str, Any]] = {r["sube_id"]: dict(r) for r in cur.fetchall()}
    subeler: Dict[str, Dict[str, Any]] = {}
    for s in subeler_raw:
        sid = s["id"]
        merged = {**_default_sube_cfg(sid), **(sube_cfg.get(sid) or {})}
        if merged.get("vardiyaya_dahil", True) is False:
            continue
        subeler[sid] = dict(s)
    if not subeler:
        return None
    cur.execute("SELECT * FROM personel_kisit")
    kisitlar: Dict[str, Dict[str, Any]] = {
        r["personel_id"]: dict(r) for r in cur.fetchall()
    }
    _kisitlar_merge_sube_yasaklari(cur, kisitlar)
    gunluk_map = _gunluk_kisit_map_yukle(cur)
    durum_map = _gunluk_durum_map_gun(cur, tarih_str)
    tercih_map = _tercih_map_yukle(cur)
    mini_log: List[Dict[str, Any]] = []
    musait, _ = _vardiya_on_secim_havuzu(cur, tarih_str, subeler, mini_log)
    musait = [
        p
        for p in musait
        if _personel_bugun_calisabilir_havuz(
            p["id"], hafta_gunu, tarih_str, gunluk_map, durum_map
        )
    ]
    pid_to_p = {p["id"]: p for p in musait}
    pzt_hafta = _pazartesi_hafta(tarih)
    musait_ids = {p["id"] for p in musait}
    hafta_onceki = _hafta_onceki_istatistik(cur, musait_ids, pzt_hafta, tarih)
    son_tip_map = _son_vardiya_tipi_map(cur, musait_ids, tarih_str)
    ana_sube_map = {p["id"]: _personel_ana_sube_id(p, cur, subeler) for p in musait}
    bugun_atanan: Dict[str, float] = defaultdict(float)
    bugun_atanan.update(_bugun_atanan_saat_yukle(cur, tarih_str))
    sube_saat_map: Dict[str, Dict[str, Tuple[str, str]]] = {}
    for sid in subeler:
        cfg_m = {**_default_sube_cfg(sid), **(sube_cfg.get(sid) or {})}
        cfg_m = _sube_cfg_gunluk_saatleri(cur, sid, tarih_str, cfg_m)
        sube_saat_map[sid] = sube_tip_saatleri(cfg_m)
    return {
        "tarih_str": tarih_str,
        "subeler": subeler,
        "kisitlar": kisitlar,
        "gunluk_map": gunluk_map,
        "durum_map": durum_map,
        "tercih_map": tercih_map,
        "hafta_gunu": hafta_gunu,
        "pid_to_p": pid_to_p,
        "hafta_onceki": hafta_onceki,
        "son_tip_map": son_tip_map,
        "ana_sube_map": ana_sube_map,
        "bugun_atanan": bugun_atanan,
        "sube_saat_map": sube_saat_map,
    }


def _fix_compute_slot(
    ctx: Dict[str, Any], p: Dict[str, Any], sube_id: str, tip: str
) -> Tuple[str, str, float]:
    k_base = _efektif_personel_kisit(p, ctx["kisitlar"])
    smap = ctx["sube_saat_map"].get(sube_id) or sube_tip_saatleri(
        _default_sube_cfg(sube_id)
    )
    bas, bit = smap[tip]
    if tip == "KAPANIS" and k_base.get("kapanis_bit_saat"):
        bit = _time_hhmmss(k_base.get("kapanis_bit_saat"), bit)
    h = _vardiya_aralik_saat(bas, bit)
    return bas, bit, h


def _fix_can_assign(
    ctx: Dict[str, Any],
    p: Dict[str, Any],
    sube_id: str,
    tip: str,
    old_h_subtract: float,
) -> bool:
    pid = p["id"]
    if not personel_tip_yapabilir(
        p,
        tip,
        ctx["kisitlar"],
        ctx["gunluk_map"],
        ctx["hafta_gunu"],
        ctx["durum_map"],
        ctx["tarih_str"],
    ):
        return False
    if not _vardiya_hedef_subede_calisabilir(
        p, sube_id, ctx["ana_sube_map"][pid], ctx["kisitlar"]
    ):
        return False
    bas, bit, h_new = _fix_compute_slot(ctx, p, sube_id, tip)
    k_base = _efektif_personel_kisit(p, ctx["kisitlar"])
    gk_row = _gunluk_efektif_gun_satir(
        pid, ctx["hafta_gunu"], ctx["tarih_str"], ctx["gunluk_map"], ctx["durum_map"]
    )
    k_merged = _birlesik_kisit_gunluk(k_base, gk_row)
    bugun_prev = ctx["bugun_atanan"].get(pid, 0.0) - old_h_subtract
    if bugun_prev < 0:
        bugun_prev = 0.0
    ba: Dict[str, float] = {k: float(v) for k, v in ctx["bugun_atanan"].items()}
    ba[pid] = bugun_prev
    if not _hafta_max_gun_izin(pid, k_base, ba, ctx["hafta_onceki"]):
        return False
    if not _vardiya_saat_sinirlari_uygun(k_merged, bas, bit, tip):
        return False
    if not _atama_kisit_saat_limitleri(
        pid, k_merged, h_new, ba, ctx["hafta_onceki"], p
    ):
        return False
    return True


def _fix_candidate_score(
    ctx: Dict[str, Any], p: Dict[str, Any], need_tip: str, old_h_subtract: float
) -> float:
    k_e = _efektif_personel_kisit(p, ctx["kisitlar"])
    pid = p["id"]
    ba: Dict[str, float] = {k: float(v) for k, v in ctx["bugun_atanan"].items()}
    prev = ba.get(pid, 0.0) - old_h_subtract
    if prev < 0:
        prev = 0.0
    ba[pid] = prev
    s, _ = _atama_skoru_detay(
        p, need_tip, k_e, ctx["tercih_map"], ctx["hafta_onceki"], ba, ctx["son_tip_map"]
    )
    return s


def _fix_apply_update(
    cur,
    ctx: Dict[str, Any],
    r: Dict[str, Any],
    new_sube: str,
    new_tip: str,
    new_bas: str,
    new_bit: str,
    neden: str,
    fix_log: List[Dict[str, Any]],
    kural: str,
) -> bool:
    pid = r["personel_id"]
    old_h = _vardiya_aralik_saat(
        _vardiya_db_saat_str(r["bas_saat"]), _vardiya_db_saat_str(r["bit_saat"])
    )
    new_h = _vardiya_aralik_saat(new_bas, new_bit)
    cur.execute(
        """
        UPDATE vardiya
        SET sube_id = %s, tip = %s, bas_saat = %s::time, bit_saat = %s::time,
            secim_nedeni = %s
        WHERE id = %s AND COALESCE(kaynak, 'motor') = 'motor'
        """,
        (new_sube, new_tip, new_bas, new_bit, neden, r["id"]),
    )
    if not cur.rowcount:
        return False
    ctx["bugun_atanan"][pid] = ctx["bugun_atanan"].get(pid, 0.0) - old_h + new_h
    dst_ad = ctx["subeler"].get(new_sube, {}).get("ad", new_sube)
    fix_log.append(
        {
            "kural": kural,
            "personel": r.get("ad_soyad"),
            "sube": dst_ad,
            "tip": new_tip,
            "detay": neden,
        }
    )
    return True


def _fix_pass_eksik(
    cur, ctx: Dict[str, Any], ham: List[Dict[str, Any]], fix_log: List[Dict[str, Any]]
) -> bool:
    ozet_h = [_ham_to_ozet(x) for x in ham]
    ozet = _vardiya_sube_ozet_hesapla(cur, ctx["tarih_str"], ozet_h)
    eksikler = [o for o in ozet if o["durum"] == "eksik"]
    if not eksikler:
        return False
    eksikler.sort(key=lambda o: (o.get("sube_adi") or "", o["sube_id"]))
    ham_by_sube = _ham_by_sube(ham)
    for o in eksikler:
        sid = o["sube_id"]
        lst = ham_by_sube.get(sid, [])
        for need_tip in _fix_eksik_tips_ordered(cur, ctx["tarih_str"], sid, lst):
            best: Optional[Tuple[float, Dict[str, Any]]] = None
            for r in ham:
                if r["sube_id"] == sid:
                    continue
                if str(r.get("kaynak") or "motor") != "motor":
                    continue
                p = ctx["pid_to_p"].get(r["personel_id"])
                if not p:
                    continue
                old_h = _vardiya_aralik_saat(
                    _vardiya_db_saat_str(r["bas_saat"]),
                    _vardiya_db_saat_str(r["bit_saat"]),
                )
                if not _fix_can_assign(ctx, p, sid, need_tip, old_h):
                    continue
                sc = _fix_candidate_score(ctx, p, need_tip, old_h)
                src_meta = _fix_sube_meta(cur, ctx["tarih_str"], r["sube_id"], ham_by_sube[r["sube_id"]])
                if _fix_row_surplus(src_meta, r["tip"]) <= 0:
                    sc -= 300.0
                if best is None or sc > best[0]:
                    best = (sc, r)
            if best:
                r = best[1]
                p = ctx["pid_to_p"][r["personel_id"]]
                bas, bit, _ = _fix_compute_slot(ctx, p, sid, need_tip)
                src_ad = ctx["subeler"].get(r["sube_id"], {}).get("ad", r["sube_id"])
                dst_ad = o.get("sube_adi") or sid
                neden = f"Eksik giderildi: {src_ad} → {dst_ad} ({need_tip})"
                if _fix_apply_update(
                    cur, ctx, r, sid, need_tip, bas, bit, neden, fix_log, "FIX_EKSIK"
                ):
                    return True
    return False


def _fix_try_move_row_to_eksik(
    cur,
    ctx: Dict[str, Any],
    ham: List[Dict[str, Any]],
    r: Dict[str, Any],
    fix_log: List[Dict[str, Any]],
) -> bool:
    p = ctx["pid_to_p"].get(r["personel_id"])
    if not p:
        return False
    ozet_h = [_ham_to_ozet(x) for x in ham]
    ozet = _vardiya_sube_ozet_hesapla(cur, ctx["tarih_str"], ozet_h)
    eksikler = [o for o in ozet if o["durum"] == "eksik"]
    if not eksikler:
        return False
    eksikler.sort(key=lambda o: (o.get("sube_adi") or "", o["sube_id"]))
    ham_by_sube = _ham_by_sube(ham)
    src_sid = r["sube_id"]
    old_h = _vardiya_aralik_saat(
        _vardiya_db_saat_str(r["bas_saat"]), _vardiya_db_saat_str(r["bit_saat"])
    )
    for eo in eksikler:
        dst = eo["sube_id"]
        if dst == src_sid:
            continue
        lst = ham_by_sube.get(dst, [])
        for need_tip in _fix_eksik_tips_ordered(cur, ctx["tarih_str"], dst, lst):
            if not _fix_can_assign(ctx, p, dst, need_tip, old_h):
                continue
            bas, bit, _ = _fix_compute_slot(ctx, p, dst, need_tip)
            src_ad = ctx["subeler"].get(src_sid, {}).get("ad", src_sid)
            dst_ad = eo.get("sube_adi") or dst
            neden = f"Fazla şubeden kaydırma: {src_ad} → {dst_ad} ({need_tip})"
            if _fix_apply_update(
                cur, ctx, r, dst, need_tip, bas, bit, neden, fix_log, "FIX_FAZLA_KAYDIR"
            ):
                return True
    return False


def _fix_try_demote_ara(
    cur,
    ctx: Dict[str, Any],
    r: Dict[str, Any],
    meta: Dict[str, Any],
    fix_log: List[Dict[str, Any]],
) -> bool:
    if str(r.get("kaynak") or "motor") != "motor" or r["tip"] == "ARA":
        return False
    p = ctx["pid_to_p"].get(r["personel_id"])
    if not p:
        return False
    ot = r["tip"]
    if _fix_row_surplus(meta, ot) <= 0:
        return False
    if not personel_tip_yapabilir(
        p,
        "ARA",
        ctx["kisitlar"],
        ctx["gunluk_map"],
        ctx["hafta_gunu"],
        ctx["durum_map"],
        ctx["tarih_str"],
    ):
        return False
    old_h = _vardiya_aralik_saat(
        _vardiya_db_saat_str(r["bas_saat"]), _vardiya_db_saat_str(r["bit_saat"])
    )
    if not _fix_can_assign(ctx, p, r["sube_id"], "ARA", old_h):
        return False
    c = meta["counts"]
    mins = _fix_tip_min_map(meta)
    if c[ot] - 1 < mins[ot]:
        return False
    if meta["active_girdi"] and c["ARA"] + 1 > meta["mara"]:
        return False
    bas, bit, _ = _fix_compute_slot(ctx, p, r["sube_id"], "ARA")
    sube_ad = ctx["subeler"].get(r["sube_id"], {}).get("ad", r["sube_id"])
    neden = f"Fazla giderildi: {ot} → ARA @ {sube_ad}"
    return _fix_apply_update(
        cur, ctx, r, r["sube_id"], "ARA", bas, bit, neden, fix_log, "FIX_FAZLA_ARA"
    )


def _fix_try_delete_row(
    cur,
    ctx: Dict[str, Any],
    ham: List[Dict[str, Any]],
    r: Dict[str, Any],
    fix_log: List[Dict[str, Any]],
) -> bool:
    if str(r.get("kaynak") or "motor") != "motor":
        return False
    partial = [_ham_to_ozet(x) for x in ham if x["id"] != r["id"]]
    ozet = _vardiya_sube_ozet_hesapla(cur, ctx["tarih_str"], partial)
    sid = r["sube_id"]
    for o in ozet:
        if o["sube_id"] == sid and o["durum"] == "eksik":
            return False
    pid = r["personel_id"]
    old_h = _vardiya_aralik_saat(
        _vardiya_db_saat_str(r["bas_saat"]), _vardiya_db_saat_str(r["bit_saat"])
    )
    cur.execute(
        """
        DELETE FROM vardiya
        WHERE id = %s AND COALESCE(kaynak, 'motor') = 'motor'
        """,
        (r["id"],),
    )
    if not cur.rowcount:
        return False
    ctx["bugun_atanan"][pid] = max(0.0, ctx["bugun_atanan"].get(pid, 0.0) - old_h)
    fix_log.append(
        {
            "kural": "FIX_FAZLA_SIL",
            "personel": r.get("ad_soyad"),
            "sube": ctx["subeler"].get(sid, {}).get("ad", sid),
            "tip": r.get("tip"),
            "detay": f"Fazla giderildi: motor satırı silindi ({r.get('tip')})",
        }
    )
    return True


def _fix_pass_fazla(
    cur, ctx: Dict[str, Any], ham: List[Dict[str, Any]], fix_log: List[Dict[str, Any]]
) -> bool:
    ozet_h = [_ham_to_ozet(x) for x in ham]
    ozet = _vardiya_sube_ozet_hesapla(cur, ctx["tarih_str"], ozet_h)
    fazlalar = [o for o in ozet if o["durum"] == "fazla"]
    if not fazlalar:
        return False
    fazlalar.sort(key=lambda o: (o.get("sube_adi") or "", o["sube_id"]))
    ham_by_sube = _ham_by_sube(ham)
    tip_prio = {"ARA": 0, "ACILIS": 1, "KAPANIS": 2}

    for fo in fazlalar:
        sid = fo["sube_id"]
        lst = ham_by_sube.get(sid, [])
        motor_rows = [r for r in lst if str(r.get("kaynak") or "motor") == "motor"]
        if not motor_rows:
            continue
        meta = _fix_sube_meta(cur, ctx["tarih_str"], sid, lst)
        motor_rows.sort(
            key=lambda rr: (
                _fix_row_surplus(meta, rr["tip"]),
                -tip_prio.get(rr["tip"], 3),
                rr.get("ad_soyad") or "",
            ),
            reverse=True,
        )
        for r in motor_rows:
            if _fix_try_move_row_to_eksik(cur, ctx, ham, r, fix_log):
                return True
            meta = _fix_sube_meta(cur, ctx["tarih_str"], sid, ham_by_sube[sid])
            if _fix_try_demote_ara(cur, ctx, r, meta, fix_log):
                return True
            if _fix_try_delete_row(cur, ctx, ham, r, fix_log):
                return True
    return False


def _vardiya_fix_zincir_dalgasi(
    cur, tarih: date, fix_log: List[Dict[str, Any]]
) -> int:
    """
    Tek stabilize dalgası: en fazla ``VARDIYA_FIX_ZINCIR_MAX_DERINLIK`` ardışık düzeltme.
    Her düzeltmeden sonra bağlam/ham yeniden yüklenir (kaydırma diğer şubeyi bozduysa sırada gider).
    Dönüş: bu dalgada uygulanan düzeltme sayısı.
    """
    tarih_str = str(tarih)
    dalga_adim = 0
    for _ in range(VARDIYA_FIX_ZINCIR_MAX_DERINLIK):
        ctx = _vardiya_fix_ctx_yukle(cur, tarih)
        if ctx is None:
            break
        ham = _vardiya_ham_fix_icin(cur, tarih_str)
        n_before = len(fix_log)
        if _fix_pass_eksik(cur, ctx, ham, fix_log):
            if len(fix_log) > n_before:
                dalga_adim += 1
            continue
        if _fix_pass_fazla(cur, ctx, ham, fix_log):
            if len(fix_log) > n_before:
                dalga_adim += 1
            continue
        break
    return dalga_adim


def _vardiya_stabilize_run(
    cur, tarih: date, fix_log: List[Dict[str, Any]]
) -> Tuple[bool, int, List[str]]:
    """
    Fix + stabilize: global kontrol → dalga (iç zincir) → tekrar değerlendir.
    """
    tarih_str = str(tarih)
    neden_snapshot: List[str] = []
    mutations = 0
    for _ in range(VARDIYA_STABILIZE_MAX_TUR):
        stab, _, neden = _adim4_global_kontrol(cur, tarih_str)
        if stab:
            return True, mutations, neden_snapshot
        neden_snapshot = list(neden)
        wave = _vardiya_fix_zincir_dalgasi(cur, tarih, fix_log)
        mutations += wave
        if wave == 0:
            break
    stab, _, neden = _adim4_global_kontrol(cur, tarih_str)
    if not stab:
        neden_snapshot = list(neden)
    return stab, mutations, neden_snapshot


def _vardiya_motoru_calistir_once(
    cur, tarih: date, *, koru_manuel: bool = False, sube_round_seed: int = 0
) -> Dict[str, Any]:
    """
    Tek pipeline turu (generate): ADIM 1–3 (+6) bu fonksiyonda; stabilize üst `vardiya_motoru_calistir` içinde.

    koru_manuel=False: o güne ait mevcut plan silinmez; kota eksiklerine göre yalnızca yeni motor
    satırları eklenir; o gün zaten vardiyası olan personel Faz 1’e alınmaz.

    koru_manuel=True: sadece motor satırları silinir; manuel korunur ve kota buna göre düşürülür.
    """
    log: List[Dict[str, Any]] = []
    hafta_sonu = tarih.weekday() >= 5
    tarih_str = str(tarih)

    manuel_sube_need_dusur: Dict[str, int] = defaultdict(int)
    bugun_atanan_saat: Dict[str, float] = defaultdict(float)
    gunluk_atanmis_pid: Set[str] = set()

    if koru_manuel:
        cur.execute(
            """
            DELETE FROM vardiya
            WHERE tarih = %s AND COALESCE(kaynak, 'motor') <> 'manuel'
            """,
            (tarih_str,),
        )

    cur.execute(
        """
        SELECT personel_id, sube_id, bas_saat, bit_saat, COALESCE(kaynak, 'motor') AS kaynak
        FROM vardiya WHERE tarih = %s
        """,
        (tarih_str,),
    )
    for row in cur.fetchall():
        pid = str(row["personel_id"])
        sid = str(row["sube_id"])
        kay = str(row.get("kaynak") or "motor")
        bas_s = _vardiya_db_saat_str(row["bas_saat"])
        bit_s = _vardiya_db_saat_str(row["bit_saat"])
        h = _vardiya_aralik_saat(bas_s, bit_s)
        bugun_atanan_saat[pid] += h
        gunluk_atanmis_pid.add(pid)
        if kay == "manuel":
            manuel_sube_need_dusur[sid] += 1

    # ── ADIM 1: Şube verisi ───────────────────────────────────────────────
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
        km = sum(manuel_sube_need_dusur.values())
        return {
            "success": True,
            "tarih": tarih_str,
            "olusturulan": 0,
            "korunan_manuel": km,
            "izinli_sayisi": 0,
            "log": [
                {
                    "kural": "HATA",
                    "detay": "Vardiyaya dahil aktif şube yok (tüm şubeler devre dışı veya pasif).",
                }
            ],
            "mesaj": "Vardiyaya dahil şube tanımlı değil.",
        }

    if koru_manuel:
        log.append(
            {
                "kural": "GENERATE",
                "detay": "Motor satırları temizlendi; manuel korundu. Eksik motor kotası tamamlanacak.",
            }
        )
    else:
        log.append(
            {
                "kural": "GENERATE",
                "detay": "Mevcut plan silinmedi; yalnızca kota eksiklerine motor kaydı eklenecek.",
            }
        )

    cur.execute("SELECT * FROM personel_kisit")
    kisitlar: Dict[str, Dict[str, Any]] = {r["personel_id"]: dict(r) for r in cur.fetchall()}
    _kisitlar_merge_sube_yasaklari(cur, kisitlar)
    gunluk_map = _gunluk_kisit_map_yukle(cur)
    durum_map = _gunluk_durum_map_gun(cur, tarih_str)
    tercih_map = _tercih_map_yukle(cur)
    hafta_gunu = tarih.weekday()

    # ── ADIM 2: Personel filtrele ───────────────────────────────────────────
    musait, izinliler = _vardiya_on_secim_havuzu(cur, tarih_str, subeler, log)
    musait = [
        p
        for p in musait
        if _personel_bugun_calisabilir_havuz(
            p["id"], hafta_gunu, tarih_str, gunluk_map, durum_map
        )
    ]
    if not musait:
        km = sum(manuel_sube_need_dusur.values())
        return {
            "success": True,
            "tarih": tarih_str,
            "olusturulan": 0,
            "korunan_manuel": km,
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
        cfg_m = _sube_cfg_gunluk_saatleri(cur, sid, tarih_str, cfg_m)
        sube_saat_map[sid] = sube_tip_saatleri(cfg_m)

    olusturulan = 0

    # ── ADIM 3: İlk atama (Faz 1 + skorlu tip dağılımı) ─────────────────────

    def vardiya_yaz(
        personel: Dict[str, Any],
        tip: str,
        sube_id: str,
        neden: str,
    ) -> None:
        nonlocal olusturulan
        pid = personel["id"]
        k_base = _efektif_personel_kisit(personel, kisitlar)
        gk_row = _gunluk_efektif_gun_satir(
            pid, hafta_gunu, tarih_str, gunluk_map, durum_map
        )
        k_merged = _birlesik_kisit_gunluk(k_base, gk_row)
        if not personel_tip_yapabilir(personel, tip, kisitlar, gunluk_map, hafta_gunu, durum_map, tarih_str):
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
            pid, k_merged, h_saat, bugun_atanan_saat, hafta_onceki, personel
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
            INSERT INTO vardiya (id, tarih, personel_id, sube_id, tip, bas_saat, bit_saat, kaynak, secim_nedeni)
            VALUES (%s, %s, %s, %s, %s, %s::time, %s::time, 'motor', %s)
            """,
            (vid, tarih_str, pid, sube_id, tip, bas, bit, neden),
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
    musait_faz1_kapandi: Set[str] = set(gunluk_atanmis_pid)
    pid_to_musait = {p["id"]: p for p in musait}

    # ── Faz 1: Şube kotası kadar kişi, havuzdan seçilir ────────────────────
    for sube_id in _faz1_sube_iterator(subeler, sube_round_seed):
        cfg_row = sube_cfg.get(sube_id)
        cfg = {**_default_sube_cfg(sube_id), **(cfg_row or {})}
        cfg = _sube_cfg_gunluk_saatleri(cur, sube_id, tarih_str, cfg)
        girdi_items = normalize_vardiya_girdileri(cfg.get("vardiya_girdileri"))
        need_g, ma, mara, mkap = (0, 0, 0, 0)
        if girdi_items:
            need_g, ma, mara, mkap = girdilerden_need_ve_minler(girdi_items)
        cfg["girdi_min_acilis"] = ma if girdi_items else 0
        cfg["girdi_min_ara"] = mara if girdi_items else 0
        cfg["girdi_min_kapanis"] = mkap if girdi_items else 0

        tam_part_zorunlu = bool(cfg.get("tam_part_zorunlu", False))
        if girdi_items and need_g > 0:
            min_kap_eff = 0 if not bool(cfg.get("planla_kapanis", True)) else mkap
        else:
            min_kap_eff = (
                0
                if not bool(cfg.get("planla_kapanis", True))
                else (
                    int(cfg.get("hafta_sonu_min_kap") or 1)
                    if hafta_sonu
                    else int(cfg.get("min_kapanis") or 1)
                )
            )
        tek_kap_izinli = bool(cfg.get("tek_kapanis_izinli", True))

        sube_ad = subeler.get(sube_id, {}).get("ad") or sube_id
        need = int(need_g) if (girdi_items and need_g > 0) else int(sube_kota.get(sube_id, 0))
        manuel_slot = int(manuel_sube_need_dusur.get(sube_id, 0))
        need = max(need - manuel_slot, 0)

        cur.execute(
            """
            SELECT COUNT(*)::int AS c FROM vardiya
            WHERE tarih = %s AND sube_id = %s AND COALESCE(kaynak, 'motor') = 'motor'
            """,
            (tarih_str, sube_id),
        )
        motor_here = int(cur.fetchone()["c"])
        to_fill = max(0, need - motor_here)

        cur.execute(
            """
            SELECT tip FROM vardiya
            WHERE tarih = %s AND sube_id = %s
            """,
            (tarih_str, sube_id),
        )
        counts_now: Dict[str, int] = {"ACILIS": 0, "ARA": 0, "KAPANIS": 0}
        for rr in cur.fetchall():
            t = rr["tip"]
            if t in counts_now:
                counts_now[t] += 1

        planla_kapanis_b = bool(cfg.get("planla_kapanis", True))
        if girdi_items:
            cfg["girdi_min_acilis"] = max(0, ma - counts_now["ACILIS"])
            cfg["girdi_min_ara"] = max(0, mara - counts_now["ARA"])
            cfg["girdi_min_kapanis"] = max(0, mkap - counts_now["KAPANIS"])
        else:
            if planla_kapanis_b:
                mkap_base = (
                    int(cfg.get("hafta_sonu_min_kap") or 1)
                    if hafta_sonu
                    else int(cfg.get("min_kapanis") or 1)
                )
                mkap_res = max(0, mkap_base - counts_now["KAPANIS"])
                if hafta_sonu:
                    cfg["hafta_sonu_min_kap"] = mkap_res
                else:
                    cfg["min_kapanis"] = mkap_res

        if need <= 0:
            continue

        if to_fill <= 0:
            continue

        adaylar_faz1 = [
            p
            for p in musait
            if p["id"] not in musait_faz1_kapandi
            and _vardiya_hedef_subede_calisabilir(
                p, sube_id, ana_sube_map[p["id"]], kisitlar
            )
            and _personel_en_az_bir_vardiya_tipi(
                p, kisitlar, gunluk_map, hafta_gunu, durum_map, tarih_str
            )
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
                    durum_map,
                    tarih_str,
                ),
                p.get("ad_soyad") or "",
            ),
            reverse=True,
        )
        secilen_yeni = adaylar_faz1[:to_fill]

        mevcut_pers: List[Dict[str, Any]] = []
        if girdi_items and need_g > 0:
            cur.execute(
                """
                SELECT personel_id FROM vardiya
                WHERE tarih = %s AND sube_id = %s AND COALESCE(kaynak, 'motor') = 'motor'
                ORDER BY personel_id
                """,
                (tarih_str, sube_id),
            )
            for rr in cur.fetchall():
                mpid = str(rr["personel_id"])
                if mpid in pid_to_musait:
                    mevcut_pers.append(pid_to_musait[mpid])

        if girdi_items and need_g > 0:
            secilen = mevcut_pers + secilen_yeni
        else:
            secilen = secilen_yeni

        cur.execute(
            """
            SELECT personel_id FROM vardiya
            WHERE tarih = %s AND sube_id = %s AND COALESCE(kaynak, 'motor') = 'motor'
            """,
            (tarih_str, sube_id),
        )
        existing_motor_pid = {str(r["personel_id"]) for r in cur.fetchall()}

        if not secilen_yeni:
            log.append(
                {
                    "kural": "BOS_SUBE",
                    "sube": sube_ad,
                    "detay": (
                        f"Motor kotasına {to_fill} kişi eksik; havuzda uygun yeni aday yok "
                        "(bugün başka kayıtlı vardiya / kısıt)"
                    ),
                }
            )
            continue

        if len(secilen_yeni) < to_fill:
            log.append(
                {
                    "kural": "HAVUZ_UYARI",
                    "sube": sube_ad,
                    "detay": (
                        f"Motor kotası eksik {to_fill}, yalnızca {len(secilen_yeni)} yeni aday seçilebildi"
                    ),
                }
            )

        if girdi_items and need_g > 0:
            if hafta_sonu:
                cfg["hafta_sonu_min_kap"] = mkap
            else:
                cfg["min_kapanis"] = mkap

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
            durum_map,
            tarih_str,
        )
        atamalar, kapanis_sayisi = _atamalar_min_kapanis_yukselt(
            atamalar,
            min_kap_eff,
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
            durum_map,
            tarih_str,
        )

        for p, tip, ned in atamalar:
            if p["id"] not in existing_motor_pid:
                vardiya_yaz(p, tip, sube_id, ned)
                musait_faz1_kapandi.add(p["id"])

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

    # ── ADIM 6: Optimize (yerel uyarılar) ─────────────────────────────────
    _pipeline_adim6_optimize_uyarilar(log, musait, bugun_atanan_saat, kisitlar)

    korunan_manuel = sum(manuel_sube_need_dusur.values())
    if korunan_manuel:
        mesaj = (
            f"{olusturulan} vardiya motorla eklendi; {korunan_manuel} manuel kayıt korundu. "
            f"{len(izinliler)} personel izinli olduğu için dışarıda bırakıldı."
        )
    else:
        mesaj = (
            f"{olusturulan} vardiya oluşturuldu. "
            f"{len(izinliler)} personel izinli olduğu için dışarıda bırakıldı."
        )
    return {
        "success": True,
        "tarih": str(tarih),
        "olusturulan": olusturulan,
        "korunan_manuel": korunan_manuel,
        "izinli_sayisi": len(izinliler),
        "log": log,
        "mesaj": mesaj,
    }


def vardiya_motoru_calistir(
    cur, tarih: date, *, koru_manuel: bool = False
) -> Dict[str, Any]:
    """
    Günlük pipeline: **generate** → **fix** → **stabilize**.

    - ``generate``: `_vardiya_motoru_calistir_once` — mevcut planı silmeden kota eksiklerine INSERT.
    - ``fix`` / ``stabilize``: `_vardiya_stabilize_run` — şube bazlı düzeltme, dalga başına zincir
      derinliği `VARDIYA_FIX_ZINCIR_MAX_DERINLIK`, dış tur `VARDIYA_STABILIZE_MAX_TUR`.
    """
    last = _vardiya_motoru_calistir_once(
        cur, tarih, koru_manuel=koru_manuel, sube_round_seed=0
    )
    if not last.get("success", True):
        return last
    mot_log = list(last.get("log") or [])
    fix_log: List[Dict[str, Any]] = []
    stab, mutations, neden_kalan = _vardiya_stabilize_run(cur, tarih, fix_log)
    last["denge_fix_adim"] = mutations
    last["denge_deneme"] = 1
    last["denge_stabil"] = stab
    last["denge_zincir_derinlik"] = VARDIYA_FIX_ZINCIR_MAX_DERINLIK
    if stab:
        last["log"] = mot_log + fix_log
        if mutations:
            last["log"].append(
                {
                    "kural": "STABILIZE",
                    "detay": (
                        f"Plan dengede ({mutations} düzeltme; "
                        f"dalga başına en fazla {VARDIYA_FIX_ZINCIR_MAX_DERINLIK} ardışık fix)."
                    ),
                }
            )
        else:
            last["log"].append(
                {
                    "kural": "STABILIZE",
                    "detay": (
                        "Kontrol tamam: generate sonrası denge sağlandı veya fix gerektirmedi."
                    ),
                }
            )
        last["mesaj"] = (last.get("mesaj") or "").rstrip() + (
            f" [Stabilize: tam, {mutations} düzeltme]" if mutations else " [Stabilize: tam]"
        )
        return last

    detay_neden = "; ".join(neden_kalan[:10]) + (
        " …" if len(neden_kalan) > 10 else ""
    )
    last["log"] = mot_log + fix_log + [
        {
            "kural": "DENGE_UYARI",
            "detay": (
                f"Stabilize {VARDIYA_STABILIZE_MAX_TUR} tur / "
                f"{VARDIYA_FIX_ZINCIR_MAX_DERINLIK} derinlik sonunda plan hâlâ eksik, fazla veya riskli; "
                "mevcut kayıtlar korunur. "
                + (f"Kalan: {detay_neden} " if detay_neden else "")
                + "Manuel satır / kısıt / girdi hedeflerini gözden geçirin."
            ),
        }
    ]
    last["mesaj"] = (
        (last.get("mesaj") or "").rstrip()
        + f" [Stabilize: uyarı, {mutations} düzeltme]"
    )
    return last


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
        r = vardiya_motoru_calistir(cur, g, koru_manuel=False)
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
