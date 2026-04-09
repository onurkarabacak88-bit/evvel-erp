# -*- coding: utf-8 -*-
"""
Vardiya senaryo motoru — şube erişimi, kaydırma, kapanış/araç yasakları, açılış tavanı.

Yetkinlik sırası tutulmaz; kararlar kısıt + işletme önceliği + eşitlikte rastgele tohum ile ayrılır.
Gerçek atama tablosu bağlanınca buradaki öneriler doğrudan kayda dönüştürülebilir.
"""
from __future__ import annotations

import hashlib
import random
from datetime import date, timedelta
from typing import Any, Dict, List, Optional, Set, Tuple


def _tarih_gun_gruplari(dt: date) -> Set[str]:
    wd = dt.weekday()
    gun_ad = ["pazartesi", "sali", "carsamba", "persembe", "cuma", "cumartesi", "pazar"][wd]
    g = {"hergun", gun_ad}
    if wd >= 5:
        g.add("hafta_sonu")
    else:
        g.add("hafta_ici")
    return g


def _motor_ayar_int(cur, anahtar: str, varsayilan: int) -> int:
    cur.execute(
        "SELECT deger_int FROM vardiya_motor_ayar WHERE anahtar=%s",
        (anahtar,),
    )
    r = cur.fetchone()
    if r and r.get("deger_int") is not None:
        return int(r["deger_int"])
    return varsayilan


def _gun_tipi_oncelik(gt: str) -> int:
    """
    Alternatif kural seçiminde öncelik (küçük daha iyi):
    tek gün (pazartesi..) > hafta_ici/hafta_sonu > hergun
    """
    gt = (gt or "").strip().lower()
    if gt in {"pazartesi", "sali", "carsamba", "persembe", "cuma", "cumartesi", "pazar"}:
        return 0
    if gt in {"hafta_ici", "hafta_sonu"}:
        return 1
    return 2


def _alt_kural_sec(cur, sube_id: str, rol: str, gun_gruplari: Set[str]) -> Optional[Dict[str, Any]]:
    """
    Şube alternatif kuralını seçer. Önce rol için bakar, yoksa 'genel' role düşer.
    Gün tipi için en spesifik eşleşmeyi seçer.
    """
    rol = (rol or "genel").strip().lower()
    for r in (rol, "genel"):
        cur.execute(
            """
            SELECT *
            FROM sube_vardiya_alternatif_kural
            WHERE sube_id=%s AND rol=%s AND gun_tipi = ANY(%s)
            """,
            (sube_id, r, list(gun_gruplari)),
        )
        rows = [dict(x) for x in cur.fetchall()]
        if rows:
            rows.sort(key=lambda x: (_gun_tipi_oncelik(x.get("gun_tipi") or "hergun"), str(x.get("id") or "")))
            return rows[0]
    return None


def _personel_erisim(cur, pid: str) -> Set[str]:
    cur.execute(
        "SELECT sube_id FROM personel_vardiya_sube_erisim WHERE personel_id=%s",
        (pid,),
    )
    return {str(x["sube_id"]) for x in cur.fetchall()}


def _personel_yetki_map(cur, pid: str) -> Tuple[Dict[str, Dict[str, bool]], bool]:
    """(sube_id -> {opening, closing}, permissive) — permissive: hiç satır yoksa tüm şubeler açık."""
    cur.execute(
        "SELECT COUNT(*)::int AS c FROM personel_sube_vardiya_yetki WHERE personel_id=%s",
        (pid,),
    )
    permissive = int(cur.fetchone()["c"] or 0) == 0
    cur.execute(
        "SELECT * FROM personel_sube_vardiya_yetki WHERE personel_id=%s",
        (pid,),
    )
    m = {str(x["sube_id"]): {"opening": bool(x["opening"]), "closing": bool(x["closing"])} for x in cur.fetchall()}
    return m, permissive


def _tur_uygun_personel(p: Dict[str, Any], gereken_tur: str) -> bool:
    gt = (gereken_tur or "farketmez").strip().lower()
    if gt == "farketmez":
        return True
    vt = (p.get("vardiya_tipi") or "").strip().upper()
    ct = (p.get("calisma_turu") or "").strip().lower()
    if gt == "tam":
        return vt == "FULL" or ct == "surekli"
    if gt == "part":
        return vt == "PART" or ct == "part_time"
    return True


def _acilis_slotu_mu(bas_saat: str, sube: Dict[str, Any]) -> bool:
    """Kaba ayrım: ihtiyaç satırının başlangıcı şube açılış saatine yakınsa açılış sayılır."""
    ac = (sube.get("acilis_saati") or "").strip()
    if not ac or not bas_saat:
        return False
    return bas_saat[:5] == ac[:5]


def _kapanis_slotu_mu(bit_saat: str, sube: Dict[str, Any]) -> bool:
    k = (sube.get("kapanis_saati") or "").strip()
    if not k or not bit_saat:
        return False
    return bit_saat[:5] == k[:5]


def _saat_dk(s: Optional[str]) -> Optional[int]:
    """
    'HH:MM' -> dakika. '24:00' desteklenir.
    Boş/None -> None.
    """
    if not s:
        return None
    t = str(s).strip()
    if not t:
        return None
    if t == "24:00":
        return 24 * 60
    try:
        hh, mm = t.split(":")
        h = int(hh)
        m = int(mm)
        if not (0 <= h <= 23 and 0 <= m <= 59):
            return None
        return h * 60 + m
    except Exception:
        return None


def _aralik_icinde(bas: str, bit: str, mus_bas: Optional[str], mus_bit: Optional[str]) -> bool:
    """
    Personel müsaitlik aralığına göre kontrol.
    - mus_bas/mus_bit boş ise tüm gün
    - aksi halde bas-bit tamamen aralığın içinde olmalı
    """
    b0 = _saat_dk(bas)
    b1 = _saat_dk(bit)
    if b0 is None or b1 is None:
        return False
    if b1 < b0:
        return False  # gece sarkan vardiya bu sürümde yok
    mb = _saat_dk(mus_bas)
    mt = _saat_dk(mus_bit)
    if mb is None and mt is None:
        return True
    if mb is None or mt is None:
        return False
    return mb <= b0 and b1 <= mt


def _sure_saat(bas: str, bit: str) -> float:
    b0 = _saat_dk(bas)
    b1 = _saat_dk(bit)
    if b0 is None or b1 is None or b1 < b0:
        return 0.0
    return (b1 - b0) / 60.0


def _safe_float(v: Any) -> Optional[float]:
    try:
        if v is None:
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def _kisitlilik_bonusu(mus_map: Dict[int, Dict[str, Any]], erisim_say: int) -> float:
    """
    Kısıtlı personelin uygun slotunu kaçırmamak için bonus:
    - Aktif gün sayısı azsa bonus artar
    - Tanımlı saat penceresi daraldıkça bonus artar
    - Erişim şubesi azsa bonus artar
    """
    aktif_gun = 0
    pencere_toplam = 0.0
    pencere_say = 0
    for i in range(7):
        gm = mus_map.get(i) or {}
        if gm.get("is_active") is False:
            continue
        aktif_gun += 1
        af = _saat_dk(gm.get("available_from"))
        at = _saat_dk(gm.get("available_to"))
        if af is not None and at is not None and at > af:
            pencere_toplam += (at - af) / 60.0
            pencere_say += 1

    dar_gun_bonusu = max(0.0, (6 - aktif_gun) * 2.5)
    if pencere_say > 0:
        ort_pencere = pencere_toplam / pencere_say
        dar_saat_bonusu = max(0.0, (10.0 - ort_pencere) * 1.2)
    else:
        dar_saat_bonusu = 0.0
    dar_erisim_bonusu = max(0.0, (4 - max(1, erisim_say)) * 2.0)
    return min(18.0, dar_gun_bonusu + dar_saat_bonusu + dar_erisim_bonusu)


def _aday_skoru(
    pr: Dict[str, Any],
    gun_ix: int,
    sid: str,
    sure: float,
    hafta_saat: Dict[str, float],
    calisilan_gunler: Dict[str, Set[int]],
    gun_atama_adet: Dict[str, Dict[int, int]],
    aday_havuzu: int,
    kritik_slot: bool,
    cfg: Dict[str, Any],
    tohum: int,
) -> float:
    """
    Uygun adaylar arasında sıralama skoru.
    Not: İzin/saat/erişim gibi sert kurallar zaten filtrede elenmiş olur.
    """
    pid = pr["pid"]
    p = pr["p"]
    skor = 0.0

    # 1) Doluluk: kişinin kendi kapasitesine göre dengele
    maxh = pr.get("max_hafta_saat")
    used_h = float(hafta_saat.get(pid, 0.0))
    if maxh is not None and float(maxh) > 0:
        doluluk = min(1.5, used_h / float(maxh))
        skor += (1.0 - doluluk) * 40.0
    else:
        # Üst sınır tanımı yoksa hafif denge (aşırı avantaj vermeden)
        skor += max(0.0, 18.0 - used_h * 0.35)

    # 2) Dar müsaitlik bonusu: bugün kaçırılırsa tekrar zor bulunabilir
    gm = pr.get("mus_map", {}).get(gun_ix) or {}
    af = _saat_dk(gm.get("available_from"))
    at = _saat_dk(gm.get("available_to"))
    if af is not None and at is not None and at > af:
        pencere = (at - af) / 60.0
        if pencere <= 6:
            skor += 15.0
        elif pencere <= 8:
            skor += 8.0

    # 3) Erişimi dar personeli öncele (kaçırmama)
    erisim_say = len(pr.get("erisim") or [])
    skor += max(0.0, 10.0 - erisim_say * 1.8)
    skor += float(pr.get("kisitlilik_bonusu") or 0.0)

    # 4) Çok şube kapalı kişiyi aynı gün tek slotta değerlendirme teşviki
    if not pr.get("cok_sube", True):
        skor += 5.0

    # 4b) Aynı gün birden çok slot yazmayı (zorunlu değilse) azalt
    bugun_adet = int(gun_atama_adet.get(pid, {}).get(gun_ix, 0))
    if bugun_adet >= 1:
        skor -= 6.0 * bugun_adet

    # 4c) Üst üste çok gün çalışmış kişide yorgunluk cezası
    worked = calisilan_gunler.get(pid, set())
    ard = 0
    d = gun_ix - 1
    while d >= 0 and d in worked:
        ard += 1
        d -= 1
    if ard >= 3:
        fatigue_pen = (ard - 2) * 4.5
        # Aday havuzu daraldıkça ceza otomatik yumuşar (zorunlu slotlar için güvenlik).
        if aday_havuzu <= 2:
            fatigue_pen *= 0.35
        elif aday_havuzu <= 4:
            fatigue_pen *= 0.6
        elif aday_havuzu <= 6:
            fatigue_pen *= 0.8
        # Açılış/kapanış/kritik slotlarda ceza daha da yumuşatılır.
        if kritik_slot:
            fatigue_pen *= 0.5
        skor -= fatigue_pen

    # 5) Öncelikli şube tercihi (soft): varsa o şubede yazmayı teşvik et
    oncelikli = str(pr.get("oncelikli_sube_id") or "")
    if oncelikli and str(sid) == oncelikli:
        skor += 12.0

    # 6) Mesai cezası: özellikle mesai katmanında bile kontrollü
    if cfg.get("mesai", False):
        skor -= 8.0

    # 7) Kriz katmanında izinli/personel rol ihlali seçimini pahalı yap
    if cfg.get("izin_ihlali", False):
        if pr["izin_hafta"][gun_ix]:
            skor -= 70.0
    if cfg.get("rol_ihlali", False):
        # Rol ihlaline düşen adımı pahalı yap, ama imkansız durumda yine seçilebilir bırak
        skor -= 18.0

    # 8) Kararlı eşitlik kırıcı
    h = int(hashlib.md5(f"{tohum}:{pid}:{sid}:{gun_ix}:{cfg.get('ad','x')}".encode()).hexdigest()[:8], 16)
    skor += (h % 1000) / 100000.0
    return skor


def _hafta_pazartesi(ref: date) -> date:
    return ref - timedelta(days=ref.weekday())


def _personel_gun_musaitlik_map(cur, pid: str) -> Dict[int, Dict[str, Any]]:
    cur.execute("SELECT * FROM personel_gun_musaitlik WHERE personel_id=%s", (pid,))
    return {int(x["hafta_gunu"]): dict(x) for x in cur.fetchall()}


def _personel_hafta_izin_map(cur, pid: str, hafta_baslangic: date) -> Tuple[List[bool], bool]:
    cur.execute(
        "SELECT * FROM personel_hafta_izin WHERE personel_id=%s AND hafta_baslangic=%s",
        (pid, hafta_baslangic),
    )
    iz = cur.fetchone()
    if not iz:
        return [False] * 7, False
    return (
        [
            bool(iz["izin_pzt"]),
            bool(iz["izin_sal"]),
            bool(iz["izin_car"]),
            bool(iz["izin_per"]),
            bool(iz["izin_cum"]),
            bool(iz["izin_cmt"]),
            bool(iz["izin_paz"]),
        ],
        True,
    )


def _otomatik_izin_atamalari(profil: List[Dict[str, Any]], ihtiyaclar: List[Dict[str, Any]]) -> int:
    """
    Personelde haftalık izin kaydı yoksa (manuel girilmemişse) otomatik 1 gün izin atar.
    Kural:
    - Sadece 6+ gün çalışabilecek personele izin yazılır.
    - Günlük izin kotası personel sayısına göre hesaplanır.
      * Hafta içi: ~%15  (20 personelde 3)
      * Cumartesi: ~%10 (20 personelde 2)
    - Talebi düşük günler önceliklidir (operasyonu bozmamak için).
    """
    if not profil:
        return 0
    gun_talep = {i: 0 for i in range(7)}
    for ih in ihtiyaclar:
        gi = int(ih.get("_gun_ix", 0))
        gun_talep[gi] += int(ih.get("minimum_kisi") or 0)
    n = len(profil)
    # ceil(n * oran): tam sayılı, dış bağımlılıksız
    hafta_ici_kota = max(1, (n * 15 + 99) // 100)  # 20 -> 3
    cumartesi_kota = max(1, (n * 10 + 99) // 100)  # 20 -> 2
    pazar_kota = max(1, (n * 8 + 99) // 100)       # 20 -> 2 (düşük öncelik)
    gun_kota = {0: hafta_ici_kota, 1: hafta_ici_kota, 2: hafta_ici_kota, 3: hafta_ici_kota, 4: hafta_ici_kota, 5: cumartesi_kota, 6: pazar_kota}
    gun_kullanim = {i: 0 for i in range(7)}
    atanan = 0

    for pr in profil:
        if pr.get("izin_kaydi_var"):
            continue
        # Haftalık izni olanı tekrar elleme
        if any(bool(x) for x in (pr.get("izin_hafta") or [])):
            continue
        mus_map = pr.get("mus_map") or {}
        # 6 gün ve üzeri çalışabilecek personelde otomatik izin zorunluluğu
        aktif_gun = 0
        for d in range(7):
            gm0 = mus_map.get(d) or {}
            if gm0.get("is_active") is False:
                continue
            aktif_gun += 1
        if aktif_gun < 6:
            continue

        aday = list(range(7))
        # Önce hafta içi (özellikle Pzt-Sal-Çar), sonra cumartesi, en son pazar
        oncelik = [0, 1, 2, 3, 4, 5, 6]
        aday.sort(key=lambda d: (oncelik.index(d), gun_talep.get(d, 0), d))

        sec = None
        for d in aday:
            gm = mus_map.get(d) or {}
            if gm.get("is_active") is False:
                continue
            if gun_kullanim[d] >= int(gun_kota.get(d, 1)):
                continue
            sec = d
            break
        if sec is None:
            continue
        pr["izin_hafta"][sec] = True
        gun_kullanim[sec] += 1
        atanan += 1
    return atanan


def _dinamik_ihtiyac_katsayi(cur, sube_id: str, gun_tarih: date, cache: Dict[str, float]) -> float:
    """
    Şubenin aynı gün tipi + yakın dönem cirosuna göre ihtiyaç katsayısı.
    1.0 = normal, >1 daha yoğun, <1 daha sakin.
    """
    key = f"{sube_id}:{gun_tarih.isoformat()}"
    if key in cache:
        return cache[key]
    wd = gun_tarih.weekday()
    cur.execute(
        """
        SELECT
          COALESCE(AVG(CASE WHEN (EXTRACT(ISODOW FROM tarih)::int - 1) = %s THEN toplam END), 0) AS avg_same_dow,
          COALESCE(AVG(toplam), 0) AS avg_all
        FROM ciro
        WHERE sube_id=%s
          AND tarih >= (%s::date - INTERVAL '56 days')
          AND tarih < %s::date
          AND durum='aktif'
        """,
        (wd, sube_id, gun_tarih, gun_tarih),
    )
    r = cur.fetchone() or {}
    same_dow = float(r.get("avg_same_dow") or 0)
    avg_all = float(r.get("avg_all") or 0)
    if same_dow <= 0 or avg_all <= 0:
        k = 1.0
    else:
        k = same_dow / avg_all
    # Güvenli sınır (aşırı oynamayı engelle)
    k = max(0.75, min(1.35, k))
    cache[key] = k
    return k


def senaryolar_uret(cur, tarih: date) -> Dict[str, Any]:
    """
    Verilen gün için kısıtları okuyup birkaç farklı strateji özetinde senaryo üretir.
    Atama tablosu olmadan — öneri ve açıklama metinleri.
    """
    gun_grubu = _tarih_gun_gruplari(tarih)
    min_dk = _motor_ayar_int(cur, "subeler_arasi_min_dakika", 90)

    cur.execute("SELECT * FROM subeler WHERE aktif=TRUE ORDER BY ad")
    subeler = {str(s["id"]): dict(s) for s in cur.fetchall()}

    cur.execute(
        """SELECT p.* FROM personel p
           WHERE p.aktif=TRUE AND COALESCE(p.include_in_planning, TRUE)
           ORDER BY p.ad_soyad"""
    )
    personeller = [dict(x) for x in cur.fetchall()]

    # Personel profilleri
    profil: List[Dict[str, Any]] = []
    for p in personeller:
        pid = str(p["id"])
        erisim = _personel_erisim(cur, pid)
        if not erisim:
            # Havuz dağıtım: erişim tanımı yoksa tüm aktif şubeler
            erisim = set(subeler.keys())
        yetki, permissive = _personel_yetki_map(cur, pid)
        profil.append(
            {
                "p": p,
                "pid": pid,
                "ad": p.get("ad_soyad") or pid,
                "oncelikli_sube_id": str(p.get("vardiya_oncelikli_sube_id")) if p.get("vardiya_oncelikli_sube_id") else "",
                "erisim": erisim,
                "yetki": yetki,
                "permissive": permissive,
                "kapanis_ok": bool(p.get("vardiya_kapanis_atanabilir", True)),
                "araci_ok": bool(p.get("vardiya_araci_atanabilir", True)),
                "cok_sube": bool(p.get("vardiya_gun_icinde_cok_subeye_gidebilir", True)),
            }
        )

    # Şube başına o güne düşen ihtiyaçlar
    ihtiyac_ozet: List[Dict[str, Any]] = []
    for sid, sube in subeler.items():
        cur.execute(
            """
            SELECT * FROM sube_vardiya_ihtiyac
            WHERE sube_id=%s AND gun_tipi = ANY(%s)
            ORDER BY bas_saat
            """,
            (sid, list(gun_grubu)),
        )
        for row in cur.fetchall():
            r = dict(row)
            r["_sube"] = sube
            r["_sid"] = sid
            ihtiyac_ozet.append(r)

    def adaylar_hesapla(sira_tohum: int, plist: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[str]]:
        """Basit greedy: her ihtiyaç satırı için uygun personel listesi (sıralı)."""
        uyari: List[str] = []
        rng = random.Random(sira_tohum)
        atama_satirlari: List[Dict[str, Any]] = []

        # İhtiyaç sırası: önce kritik, sonra şube adı, sonra saat
        sirali = sorted(
            ihtiyac_ozet,
            key=lambda x: (
                not bool(x.get("kritik")),
                str(x["_sube"].get("ad") or ""),
                str(x.get("bas_saat") or ""),
            ),
        )

        kullanılan_gun: Dict[str, Set[str]] = {}  # pid -> atanmış sube_id (aynı gün)

        for ih in sirali:
            sube = ih["_sube"]
            sid = ih["_sid"]
            bas = str(ih.get("bas_saat") or "")
            bit = str(ih.get("bit_saat") or "")
            gerek = int(ih.get("gereken_kisi") or 1)
            gtur = str(ih.get("gereken_tur") or "farketmez")
            kritik = bool(ih.get("kritik"))

            acilis_mi = _acilis_slotu_mu(bas, sube)
            kapanis_mi = _kapanis_slotu_mu(bit, sube)

            uygun: List[Dict[str, Any]] = []
            for pr in plist:
                p = pr["p"]
                pid = pr["pid"]
                if sid not in pr["erisim"]:
                    continue
                if not _tur_uygun_personel(p, gtur):
                    continue
                if pr["permissive"]:
                    o_ok, c_ok = True, True
                else:
                    y = pr["yetki"].get(sid) or {"opening": False, "closing": False}
                    o_ok, c_ok = y.get("opening"), y.get("closing")
                if acilis_mi and sube.get("acilis_sadece_part"):
                    if p.get("calisma_turu") != "part_time" and (p.get("vardiya_tipi") or "").upper() != "PART":
                        continue
                if kapanis_mi and sube.get("kapanis_sadece_part"):
                    if p.get("calisma_turu") != "part_time" and (p.get("vardiya_tipi") or "").upper() != "PART":
                        continue
                if acilis_mi and not o_ok:
                    continue
                if kapanis_mi and not c_ok:
                    continue
                if kapanis_mi and not pr["kapanis_ok"]:
                    continue
                # Araç / ara dilim: açılış-kapanış değilse ve personel aracı yapamıyorsa eler
                if not pr["araci_ok"] and not acilis_mi and not kapanis_mi:
                    continue

                used = kullanılan_gun.get(pid, set())
                if sid in used:
                    continue
                if len(used) >= 1 and not pr["cok_sube"]:
                    continue

                uygun.append(pr)

            def sort_key(pr: Dict[str, Any]) -> Tuple:
                # Yetkinlik sırası yok: hash ile kararlı ama senaryoya göre farklı sıra
                h = int(
                    hashlib.md5(f"{sira_tohum}:{pr['pid']}:{sid}".encode()).hexdigest()[:8],
                    16,
                )
                return (len(pr["erisim"]), -h if sira_tohum % 2 == 0 else h)

            uygun.sort(key=sort_key)
            rng.shuffle(uygun)

            secilen = uygun[:gerek]
            if len(secilen) < gerek:
                uyari.append(
                    f"{sube.get('ad')}: {bas}-{bit} için {gerek} kişi gerekli, "
                    f"uygun {len(secilen)} aday (kritik={kritik})."
                )

            for pr in secilen:
                kullanılan_gun.setdefault(pr["pid"], set()).add(sid)
                atama_satirlari.append(
                    {
                        "sube_id": sid,
                        "sube_ad": sube.get("ad"),
                        "bas_saat": bas,
                        "bit_saat": bit,
                        "personel_id": pr["pid"],
                        "personel_ad": pr["ad"],
                        "kritik": kritik,
                        "acilis_mi": acilis_mi,
                        "kapanis_mi": kapanis_mi,
                    }
                )

        # Açılış tavanı: senaryo sonunda şube bazında kontrol
        for sid2, sube2 in subeler.items():
            am = sube2.get("acilis_max_kisi")
            try:
                am_i = int(am) if am is not None else None
            except (TypeError, ValueError):
                am_i = None
            if am_i is None:
                continue
            acilis_say = sum(
                1 for a in atama_satirlari if a["sube_id"] == sid2 and a.get("acilis_mi")
            )
            if acilis_say > am_i:
                uyari.append(
                    f"{sube2.get('ad')}: açılış için en fazla {am_i} kişi kuralı; bu senaryoda "
                    f"{acilis_say} açılış ataması önerildi — gevşetme veya personel kaydırma gerekir."
                )

        return atama_satirlari, uyari

    senaryolar: List[Dict[str, Any]] = []
    tohumlar = [
        int(hashlib.md5(f"{tarih}:A".encode()).hexdigest()[:8], 16),
        int(hashlib.md5(f"{tarih}:B".encode()).hexdigest()[:8], 16),
        int(hashlib.md5(f"{tarih}:C".encode()).hexdigest()[:8], 16),
        int(hashlib.md5(f"{tarih}:D".encode()).hexdigest()[:8], 16),
    ]
    basliklar = [
        "Önce kritik ihtiyaçlar, şube adına göre sıra",
        "Aynı kısıtlar — farklı aday kırılımı (eşit adaylar)",
        "Çok şubeye gidebilenleri erken tüket",
        "Dar erişimli personeli sona bırak",
    ]

    ozet_atamalar: List[List[Dict[str, Any]]] = []
    for i, (tohum, baslik) in enumerate(zip(tohumlar, basliklar)):
        plist = list(profil)
        if i == 2:
            plist.sort(key=lambda x: (-len(x["erisim"]), x["ad"]))
        elif i == 3:
            plist.sort(key=lambda x: (len(x["erisim"]), x["ad"]))
        elif i == 1:
            plist.sort(key=lambda x: (x["ad"], x["pid"]))
        satirlar, uyari = adaylar_hesapla(tohum + i * 997, plist)
        ozet_atamalar.append(satirlar)
        ozet_metin = []
        for a in satirlar[:12]:
            rol = []
            if a.get("acilis_mi"):
                rol.append("açılış")
            if a.get("kapanis_mi"):
                rol.append("kapanış")
            rol_s = "/".join(rol) if rol else "aralık"
            ozet_metin.append(
                f"• {a['personel_ad']} → {a['sube_ad']} ({a['bas_saat']}–{a['bit_saat']}, {rol_s})"
            )
        if len(satirlar) > 12:
            ozet_metin.append(f"… ve {len(satirlar) - 12} satır daha")

        senaryolar.append(
            {
                "id": chr(ord("A") + i),
                "baslik": baslik,
                "aciklama": f"Şubeler arası minimum geçiş süresi motor ayarında {min_dk} dakika. "
                "Part-time ve çok şube kapalı personel aynı gün ikinci şubeye yazılmaz.",
                "ozet_satirlari": ozet_metin,
                "atama_sayisi": len(satirlar),
                "uyarilar": uyari,
            }
        )

    # Tekrarlı senaryoları ayıkla (atama kişi-id sırası aynıysa)
    imzalar = []
    benzersiz: List[Dict[str, Any]] = []
    for i, sat in enumerate(ozet_atamalar):
        imza = tuple(
            sorted((a["personel_id"], a["sube_id"], a["bas_saat"], a["bit_saat"]) for a in sat)
        )
        if imza not in imzalar:
            imzalar.append(imza)
            benzersiz.append(senaryolar[i])

    tek_mi = len(benzersiz) <= 1
    mesaj = (
        "Kısıtlar ve mevcut personel ile yalnızca bir sağlıklı kombinasyon öne çıkıyor."
        if tek_mi and len(senaryolar) > 1
        else (
            f"{len(benzersiz)} farklı senaryo üretildi; işletme açısından birini seçebilirsiniz."
            if len(benzersiz) > 1
            else "Üretilen senaryo sayısı sınırlı — personel/şube tanımlarını genişletin."
        )
    )

    return {
        "tarih": str(tarih),
        "subeler_arasi_min_dakika": min_dk,
        "toplam_ihtiyac_satiri": len(ihtiyac_ozet),
        "planlamaya_dahil_personel": len(profil),
        "tek_mantikli_varyasyon_mu": tek_mi,
        "aciklama": mesaj,
        "senaryolar": benzersiz if benzersiz else senaryolar[:1],
        "notlar": [
            "Ahmet gibi başka şubede açılış/kapanış kilidi olan personel, Sıla’nın gidemeyeceği "
            "şubeye atanırsa Sıla tercih edilmelidir — tam atama motoru çakışma grafiği ile seçer.",
            "Alsancak’ta açılış tavanı (acilis_max_kisi) tanımlıysa iki kişi açılış önerilmez.",
        ],
    }


def hafta_senaryolari_uret(
    cur,
    hafta_baslangic: date,
    kriz_modu: bool = False,
    senaryo_adedi: int = 4,
) -> Dict[str, Any]:
    """
    Haftalık (Pzt başlangıç) senaryo üretimi.
    Bu sürüm: haftanın her günü için ihtiyaçları çıkarır ve haftalık kısıtlarla (izin + gün müsaitliği
    + aynı gün şube değişimi 90dk + şube erişimi) greedy atama önerir.
    """
    pzt = _hafta_pazartesi(hafta_baslangic)
    min_dk = _motor_ayar_int(cur, "subeler_arasi_min_dakika", 90)
    mesai_limit_saat = float(_motor_ayar_int(cur, "mesai_ek_limit_saat", 4))

    cur.execute("SELECT * FROM subeler WHERE aktif=TRUE ORDER BY ad")
    subeler = {str(s["id"]): dict(s) for s in cur.fetchall()}

    cur.execute(
        """SELECT p.* FROM personel p
           WHERE p.aktif=TRUE AND COALESCE(p.include_in_planning, TRUE)
           ORDER BY p.ad_soyad"""
    )
    personeller = [dict(x) for x in cur.fetchall()]

    # Personel profili + haftalık kısıtlar
    profil: List[Dict[str, Any]] = []
    for p in personeller:
        pid = str(p["id"])
        erisim = _personel_erisim(cur, pid)
        if not erisim:
            # Erişim tanımı yoksa personeli tek şubeye kilitleme:
            # aktif tüm şubeler havuzundan değerlendir.
            erisim = set(subeler.keys())
        yetki, permissive = _personel_yetki_map(cur, pid)
        mus_map = _personel_gun_musaitlik_map(cur, pid)
        izin_map, izin_kaydi_var = _personel_hafta_izin_map(cur, pid, pzt)
        profil.append(
            {
                "p": p,
                "pid": pid,
                "ad": p.get("ad_soyad") or pid,
                "erisim": erisim,
                "yetki": yetki,
                "permissive": permissive,
                "kapanis_ok": bool(p.get("vardiya_kapanis_atanabilir", True)),
                "araci_ok": bool(p.get("vardiya_araci_atanabilir", True)),
                "cok_sube": bool(p.get("vardiya_gun_icinde_cok_subeye_gidebilir", True)),
                "mus_map": mus_map,
                "izin_hafta": izin_map,
                "izin_kaydi_var": bool(izin_kaydi_var),
                "max_hafta_saat": _safe_float(p.get("vardiya_max_weekly_hours")),
                "kisitlilik_bonusu": _kisitlilik_bonusu(mus_map, len(erisim)),
            }
        )

    # Haftalık ihtiyaçları çıkar (gün gün)
    ihtiyaclar: List[Dict[str, Any]] = []
    dyn_cache: Dict[str, float] = {}
    dyn_artis_max = _motor_ayar_int(cur, "dinamik_ideal_artis_max", 2)
    dyn_azalis_max = _motor_ayar_int(cur, "dinamik_ideal_azalis_max", 2)
    for d in range(7):
        gun = pzt + timedelta(days=d)
        gun_grubu = _tarih_gun_gruplari(gun)
        for sid, sube in subeler.items():
            cur.execute(
                """
                SELECT * FROM sube_vardiya_ihtiyac
                WHERE sube_id=%s AND gun_tipi = ANY(%s)
                ORDER BY bas_saat
                """,
                (sid, list(gun_grubu)),
            )
            for row in cur.fetchall():
                r = dict(row)
                r["_tarih"] = gun
                r["_gun_ix"] = d
                r["_sube"] = sube
                r["_sid"] = sid
                # Dinamik ideal kişi ayarı (minimum sabit kalır)
                base_ideal = int(r.get("gereken_kisi") or 1)
                base_min = int(r.get("minimum_kisi") or 0)
                rol = str(r.get("rol") or "genel").strip().lower()
                katsayi = _dinamik_ihtiyac_katsayi(cur, sid, gun, dyn_cache)
                if rol == "yogunluk":
                    # Yoğunluk satırlarında dinamik etkiyi biraz artır
                    katsayi = 1.0 + (katsayi - 1.0) * 1.2
                hedef = int(round(base_ideal * katsayi))
                hedef = max(base_min, hedef)
                # Ani sıçrama/düşüşleri sınırlama
                if hedef > base_ideal:
                    hedef = min(base_ideal + max(0, dyn_artis_max), hedef)
                else:
                    hedef = max(base_ideal - max(0, dyn_azalis_max), hedef)
                r["_ideal_dyn"] = hedef
                r["_dyn_katsayi"] = round(katsayi, 3)
                ihtiyaclar.append(r)

    # İzin kaydı olmayan personele otomatik 1 gün izin ataması (haftalık plan üretiminde).
    auto_izin_say = _otomatik_izin_atamalari(profil, ihtiyaclar)

    def hafta_greedy(tohum: int, plist: List[Dict[str, Any]], kriz_modu: bool, varyant_ix: int = 0) -> Tuple[List[Dict[str, Any]], List[str]]:
        rng = random.Random(tohum)
        uyarilar: List[str] = []
        atamalar: List[Dict[str, Any]] = []

        # Haftalık takip: pid -> gün -> (son_sube, son_bitis_dk)
        gun_son: Dict[str, Dict[int, Tuple[str, int]]] = {}
        gun_sube_set: Dict[str, Dict[int, Set[str]]] = {}
        hafta_saat: Dict[str, float] = {}
        calisilan_gunler: Dict[str, Set[int]] = {}
        gun_atama_adet: Dict[str, Dict[int, int]] = {}

        # Aynı ihtiyaç grubundaki (gün+şube+rol+tür+minimum/ideal) saat alternatiflerinden
        # her senaryoda sadece birini seç: ilk varyantta en olası saat, sonraki varyantlarda alternatif saat.
        gruplar: Dict[Tuple[Any, ...], List[Dict[str, Any]]] = {}
        for ih in ihtiyaclar:
            k = (
                int(ih.get("_gun_ix") or 0),
                str(ih.get("_sid") or ""),
                str(ih.get("rol") or "genel"),
                str(ih.get("gereken_tur") or "farketmez"),
                int(ih.get("minimum_kisi") or 0),
                int(ih.get("_ideal_dyn") or ih.get("gereken_kisi") or 1),
                bool(ih.get("kritik")),
            )
            gruplar.setdefault(k, []).append(ih)

        secilen_ihtiyaclar: List[Dict[str, Any]] = []
        for key, items in gruplar.items():
            if len(items) <= 1:
                secilen_ihtiyaclar.append(items[0])
                continue
            items_sorted = sorted(items, key=lambda x: str(x.get("bas_saat") or ""))
            skorlu = []
            for ih in items_sorted:
                gi = int(ih.get("_gun_ix") or 0)
                sid_ih = str(ih.get("_sid") or "")
                bas_ih = str(ih.get("bas_saat") or "")
                bit_ih = str(ih.get("bit_saat") or "")
                gtur_ih = str(ih.get("gereken_tur") or "farketmez")
                pot = 0
                for pr in plist:
                    p = pr["p"]
                    if pr["izin_hafta"][gi]:
                        continue
                    if sid_ih not in pr["erisim"]:
                        continue
                    gm = pr["mus_map"].get(gi)
                    if gm and gm.get("is_active") is False:
                        continue
                    if gm and not _aralik_icinde(bas_ih, bit_ih, gm.get("available_from"), gm.get("available_to")):
                        continue
                    if gtur_ih != "farketmez" and not _tur_uygun_personel(p, gtur_ih):
                        continue
                    pot += 1
                skorlu.append((pot, ih))
            skorlu.sort(key=lambda t: (-t[0], str(t[1].get("bas_saat") or "")))
            sec_ix = min(max(0, varyant_ix), len(skorlu) - 1)
            secilen_ihtiyaclar.append(skorlu[sec_ix][1])

        # İhtiyaç sırası: önce kritik, sonra gün, sonra şube adı, sonra saat
        sirali = sorted(
            secilen_ihtiyaclar,
            key=lambda x: (
                not bool(x.get("kritik")),
                int(x["_gun_ix"]),
                str(x["_sube"].get("ad") or ""),
                str(x.get("bas_saat") or ""),
            ),
        )

        for ih in sirali:
            sube = ih["_sube"]
            sid = ih["_sid"]
            gun_ix = int(ih["_gun_ix"])
            bas = str(ih.get("bas_saat") or "")
            bit = str(ih.get("bit_saat") or "")
            ideal = int(ih.get("_ideal_dyn") or ih.get("gereken_kisi") or 1)
            minimum = int(ih.get("minimum_kisi") or 0)
            gtur = str(ih.get("gereken_tur") or "farketmez")
            kritik = bool(ih.get("kritik"))
            tarih = ih["_tarih"]
            rol = str(ih.get("rol") or "genel").strip().lower()

            acilis_mi = _acilis_slotu_mu(bas, sube)
            kapanis_mi = _kapanis_slotu_mu(bit, sube)
            sure = _sure_saat(bas, bit)
            gun_grubu = _tarih_gun_gruplari(tarih)
            alt = _alt_kural_sec(cur, sid, rol, gun_grubu)

            # Esnetme merdiveni:
            # 0=asıl satır, 1=alternatif kural, 2=son çare (farketmez), 3=kriz (izin + rol ihlali)
            adimlar: List[Dict[str, Any]] = []
            adimlar.append(
                {
                    "ad": "standart",
                    "minimum": minimum,
                    "ideal": ideal,
                    "gereken_tur": gtur,
                    "mesai": False,
                    "izinli_tam": True,
                    "izinli_part": True,
                    "izin_ihlali": False,
                    "rol_ihlali": False,
                }
            )
            if alt:
                adimlar.append(
                    {
                        "ad": "alternatif",
                        "minimum": int(alt.get("minimum_kisi") or minimum),
                        "ideal": int(alt.get("ideal_kisi") or ideal),
                        "gereken_tur": "farketmez",
                        "mesai": bool(alt.get("mesai_izinli")),
                        "izinli_tam": bool(alt.get("izinli_tam", True)),
                        "izinli_part": bool(alt.get("izinli_part", True)),
                        "not": alt.get("notlar"),
                        "izin_ihlali": False,
                        "rol_ihlali": False,
                    }
                )
            adimlar.append(
                {
                    "ad": "son_care",
                    "minimum": minimum,
                    "ideal": ideal,
                    "gereken_tur": "farketmez",
                    "mesai": False,
                    "izinli_tam": True,
                    "izinli_part": True,
                    "izin_ihlali": False,
                    "rol_ihlali": False,
                }
            )
            if kriz_modu:
                adimlar.append(
                    {
                        "ad": "kriz",
                        "minimum": minimum,
                        "ideal": ideal,
                        "gereken_tur": "farketmez",
                        "mesai": True,
                        "izinli_tam": True,
                        "izinli_part": True,
                        "izin_ihlali": True,
                        "rol_ihlali": True,
                    }
                )

            def adaylari_filtrele(cfg: Dict[str, Any], neden_say: Optional[Dict[str, int]] = None, izin_aday: Optional[List[str]] = None) -> List[Dict[str, Any]]:
                uygun: List[Dict[str, Any]] = []
                for pr in plist:
                    p = pr["p"]
                    pid = pr["pid"]

                    # Haftalık izin
                    if pr["izin_hafta"][gun_ix] and not cfg.get("izin_ihlali", False):
                        if neden_say is not None:
                            neden_say["izin"] = int(neden_say.get("izin", 0)) + 1
                        if izin_aday is not None:
                            izin_aday.append(pr["ad"])
                        continue

                    # Şube erişimi
                    if sid not in pr["erisim"]:
                        if neden_say is not None:
                            neden_say["sube_erisim_yok"] = int(neden_say.get("sube_erisim_yok", 0)) + 1
                        continue

                    # Gün müsaitliği
                    gm = pr["mus_map"].get(gun_ix)
                    if gm and gm.get("is_active") is False:
                        if neden_say is not None:
                            neden_say["gun_kapali"] = int(neden_say.get("gun_kapali", 0)) + 1
                        continue
                    if gm:
                        af = gm.get("available_from")
                        at = gm.get("available_to")
                        if not _aralik_icinde(bas, bit, af, at):
                            if neden_say is not None:
                                neden_say["saat_uygunsuz"] = int(neden_say.get("saat_uygunsuz", 0)) + 1
                            continue

                    # Personel türü bayrakları
                    vt = (p.get("vardiya_tipi") or "").strip().upper()
                    ct = (p.get("calisma_turu") or "").strip().lower()
                    is_part = (vt == "PART") or (ct == "part_time")
                    is_tam = (vt == "FULL") or (ct == "surekli")

                    # İş kuralı: PART personel şubeler arası kaydırılmaz.
                    # Sadece TAM personel ihtiyaç halinde başka şubeye kaydırılabilir.
                    ana_sube = str(p.get("sube_id") or "")
                    if is_part and ana_sube and str(sid) != ana_sube:
                        if neden_say is not None:
                            neden_say["part_kaydirma_yasak"] = int(neden_say.get("part_kaydirma_yasak", 0)) + 1
                        continue

                    # Tür (standartta satır türü; alternatife düşerse izinli_tam/part ile serbestleşir)
                    if cfg.get("gereken_tur") and cfg["gereken_tur"] != "farketmez":
                        if not _tur_uygun_personel(p, cfg["gereken_tur"]):
                            if neden_say is not None:
                                neden_say["tur_uygunsuz"] = int(neden_say.get("tur_uygunsuz", 0)) + 1
                            continue
                    else:
                        # izinli_tam/part filtresi
                        if is_part and not cfg.get("izinli_part", True):
                            if neden_say is not None:
                                neden_say["part_yasak"] = int(neden_say.get("part_yasak", 0)) + 1
                            continue
                        if is_tam and not cfg.get("izinli_tam", True):
                            if neden_say is not None:
                                neden_say["tam_yasak"] = int(neden_say.get("tam_yasak", 0)) + 1
                            continue

                    # Şube part-only kuralları (sert)
                    if acilis_mi and sube.get("acilis_sadece_part"):
                        if p.get("calisma_turu") != "part_time" and (p.get("vardiya_tipi") or "").upper() != "PART":
                            if neden_say is not None:
                                neden_say["sube_acilis_part_only"] = int(neden_say.get("sube_acilis_part_only", 0)) + 1
                            continue
                    if kapanis_mi and sube.get("kapanis_sadece_part"):
                        if p.get("calisma_turu") != "part_time" and (p.get("vardiya_tipi") or "").upper() != "PART":
                            if neden_say is not None:
                                neden_say["sube_kapanis_part_only"] = int(neden_say.get("sube_kapanis_part_only", 0)) + 1
                            continue

                    # Opening/closing yetkisi
                    if not cfg.get("rol_ihlali", False):
                        if pr["permissive"]:
                            o_ok, c_ok = True, True
                        else:
                            y = pr["yetki"].get(sid) or {"opening": False, "closing": False}
                            o_ok, c_ok = y.get("opening"), y.get("closing")
                        if acilis_mi and not o_ok:
                            if neden_say is not None:
                                neden_say["acilis_yetki_yok"] = int(neden_say.get("acilis_yetki_yok", 0)) + 1
                            continue
                        if kapanis_mi and (not c_ok or not pr["kapanis_ok"]):
                            if neden_say is not None:
                                neden_say["kapanis_yetki_yok"] = int(neden_say.get("kapanis_yetki_yok", 0)) + 1
                            continue

                    # Aynı gün birden fazla şube kuralı
                    used_set = gun_sube_set.get(pid, {}).get(gun_ix, set())
                    if sid not in used_set and len(used_set) >= 1 and not pr["cok_sube"] and not cfg.get("mesai", False):
                        if neden_say is not None:
                            neden_say["aynigun_tek_sube"] = int(neden_say.get("aynigun_tek_sube", 0)) + 1
                        continue

                    # 90dk geçiş
                    b0 = _saat_dk(bas)
                    if b0 is None:
                        continue
                    last = gun_son.get(pid, {}).get(gun_ix)
                    if last:
                        last_sube, last_bit = last
                        if last_sube != sid and last_bit + min_dk > b0:
                            if neden_say is not None:
                                neden_say["gecis_90dk"] = int(neden_say.get("gecis_90dk", 0)) + 1
                            continue

                    # Haftalık saat tavanı (varsa)
                    maxh = pr.get("max_hafta_saat")
                    used_h = float(hafta_saat.get(pid, 0.0))
                    if maxh is not None and (used_h + sure) > float(maxh):
                        # mesai katmanında izin verilebilir
                        if not cfg.get("mesai", False):
                            if neden_say is not None:
                                neden_say["haftalik_limit"] = int(neden_say.get("haftalik_limit", 0)) + 1
                            continue
                        # mesai limiti
                        if (used_h + sure) > float(maxh) + mesai_limit_saat:
                            if neden_say is not None:
                                neden_say["mesai_limit"] = int(neden_say.get("mesai_limit", 0)) + 1
                            continue

                    uygun.append(pr)
                return uygun

            secilen_cfg = None
            secilen_min: List[Dict[str, Any]] = []
            secilen_ideal: List[Dict[str, Any]] = []
            for cfg in adimlar:
                uygun = adaylari_filtrele(cfg)
                aday_havuzu = len(uygun)
                # Uygun adaylar arasında skorla sırala (yüksek skor daha iyi)
                uygun.sort(
                    key=lambda pr: _aday_skoru(
                        pr=pr,
                        gun_ix=gun_ix,
                        sid=sid,
                        sure=sure,
                        hafta_saat=hafta_saat,
                        calisilan_gunler=calisilan_gunler,
                        gun_atama_adet=gun_atama_adet,
                        aday_havuzu=aday_havuzu,
                        kritik_slot=bool(kritik or acilis_mi or kapanis_mi),
                        cfg=cfg,
                        tohum=tohum,
                    ),
                    reverse=True,
                )
                sec_min = uygun[: int(cfg.get("minimum") or 0)]
                if len(sec_min) < int(cfg.get("minimum") or 0):
                    continue
                kalan = max(0, int(cfg.get("ideal") or 0) - len(sec_min))
                sec_ideal = [x for x in uygun if x["pid"] not in {p["pid"] for p in sec_min}][:kalan]
                secilen_cfg = cfg
                secilen_min = sec_min
                secilen_ideal = sec_ideal
                break

            if not secilen_cfg:
                # Hiçbir katmanda minimum bile dolmadı — en azından mevcut aday sayısını raporla
                neden_say: Dict[str, int] = {}
                izin_aday: List[str] = []
                uygun0 = adaylari_filtrele(adimlar[0], neden_say=neden_say, izin_aday=izin_aday)
                # İzin yüzünden mi tıkandı? (kaba teşhis)
                top = sorted(neden_say.items(), key=lambda x: -x[1])[:4]
                neden_txt = ", ".join([f"{k}={v}" for k, v in top]) if top else "neden bulunamadı"
                uyarilar.append(
                    f"{sube.get('ad')}: {tarih} {bas}-{bit} minimum {minimum} kişi; standart uygun={len(uygun0)}. Engeller: {neden_txt}."
                )
                if izin_aday:
                    uyarilar.append(
                        f"{sube.get('ad')}: {tarih} {bas}-{bit} için izinli olduğu için elenen örnek adaylar: {', '.join(izin_aday[:6])}{'…' if len(izin_aday) > 6 else ''}."
                    )
                continue

            if secilen_cfg["ad"] != "standart":
                msg = f"{sube.get('ad')}: {tarih} {bas}-{bit} için esnetme uygulandı ({secilen_cfg['ad']})."
                if secilen_cfg.get("mesai"):
                    msg += " Mesai izinli katman."
                if secilen_cfg.get("izin_ihlali"):
                    msg += " İZİN İHLALİ (kriz)."
                if secilen_cfg.get("rol_ihlali"):
                    msg += " ROL İHLALİ (kriz)."
                if secilen_cfg.get("not"):
                    msg += f" Not: {secilen_cfg['not']}"
                uyarilar.append(msg)

            # 1) minimum atamalar
            for pr in secilen_min:
                pid = pr["pid"]
                b1 = _saat_dk(bit) or 0
                gun_son.setdefault(pid, {})[gun_ix] = (sid, b1)
                gun_sube_set.setdefault(pid, {}).setdefault(gun_ix, set()).add(sid)
                hafta_saat[pid] = float(hafta_saat.get(pid, 0.0)) + sure
                calisilan_gunler.setdefault(pid, set()).add(gun_ix)
                gun_atama_adet.setdefault(pid, {}).setdefault(gun_ix, 0)
                gun_atama_adet[pid][gun_ix] += 1
                atamalar.append(
                    {
                        "tarih": str(tarih),
                        "gun_ix": gun_ix,
                        "sube_id": sid,
                        "sube_ad": sube.get("ad"),
                        "bas_saat": bas,
                        "bit_saat": bit,
                        "personel_id": pid,
                        "personel_ad": pr["ad"],
                        "kritik": kritik,
                        "acilis_mi": acilis_mi,
                        "kapanis_mi": kapanis_mi,
                        "rol": rol,
                        "mesai": bool(secilen_cfg.get("mesai", False))
                        or ((pr.get("max_hafta_saat") is not None) and (hafta_saat[pid] > float(pr["max_hafta_saat"]))),
                        "izin_ihlali": bool(secilen_cfg.get("izin_ihlali", False)),
                        "rol_ihlali": bool(secilen_cfg.get("rol_ihlali", False)),
                    }
                )

            # 2) ideal tamamlamalar
            if secilen_ideal:
                eksik = max(0, int(secilen_cfg.get("ideal") or ideal) - (len(secilen_min) + len(secilen_ideal)))
                if eksik > 0:
                    uyarilar.append(
                        f"{sube.get('ad')}: {tarih} {bas}-{bit} ideal {int(secilen_cfg.get('ideal') or ideal)} kişi; {eksik} kişi eksik kaldı (kritik={kritik})."
                    )
                for pr in secilen_ideal:
                    pid = pr["pid"]
                    b1 = _saat_dk(bit) or 0
                    gun_son.setdefault(pid, {})[gun_ix] = (sid, b1)
                    gun_sube_set.setdefault(pid, {}).setdefault(gun_ix, set()).add(sid)
                    hafta_saat[pid] = float(hafta_saat.get(pid, 0.0)) + sure
                    calisilan_gunler.setdefault(pid, set()).add(gun_ix)
                    gun_atama_adet.setdefault(pid, {}).setdefault(gun_ix, 0)
                    gun_atama_adet[pid][gun_ix] += 1
                    atamalar.append(
                        {
                            "tarih": str(tarih),
                            "gun_ix": gun_ix,
                            "sube_id": sid,
                            "sube_ad": sube.get("ad"),
                            "bas_saat": bas,
                            "bit_saat": bit,
                            "personel_id": pid,
                            "personel_ad": pr["ad"],
                            "kritik": kritik,
                            "acilis_mi": acilis_mi,
                            "kapanis_mi": kapanis_mi,
                            "rol": rol,
                            "mesai": bool(secilen_cfg.get("mesai", False))
                            or ((pr.get("max_hafta_saat") is not None) and (hafta_saat[pid] > float(pr["max_hafta_saat"]))),
                            "izin_ihlali": bool(secilen_cfg.get("izin_ihlali", False)),
                            "rol_ihlali": bool(secilen_cfg.get("rol_ihlali", False)),
                        }
                    )

        # Açılış tavanı: hafta geneli gün bazında kontrol
        for sid2, sube2 in subeler.items():
            am = sube2.get("acilis_max_kisi")
            try:
                am_i = int(am) if am is not None else None
            except (TypeError, ValueError):
                am_i = None
            if am_i is None:
                continue
            for gun_ix in range(7):
                acilis_say = sum(
                    1
                    for a in atamalar
                    if a["sube_id"] == sid2 and a.get("acilis_mi") and int(a["gun_ix"]) == gun_ix
                )
                if acilis_say > am_i:
                    uyarilar.append(
                        f"{sube2.get('ad')}: gün {gun_ix+1} açılış için en fazla {am_i} kişi kuralı; bu senaryoda {acilis_say} öneri var."
                    )

        return atamalar, uyarilar

    # Çoklu senaryo havuzu
    adet = max(2, min(int(senaryo_adedi or 4), 24))
    tohumlar = [
        int(hashlib.md5(f"{pzt}:S{i}".encode()).hexdigest()[:8], 16)
        for i in range(adet)
    ]
    basliklar = [
        "Kritik + dar erişimliler önce",
        "Eşit adaylarda farklı kırılım",
        "Çok şubeye gidebilenleri daha erken kullan",
        "Dar erişimlileri sona bırak (kontrol)",
    ]

    ozet_imza: List[Tuple] = []
    senaryolar: List[Dict[str, Any]] = []
    for i, tohum in enumerate(tohumlar):
        baslik = basliklar[i] if i < len(basliklar) else f"Stokastik varyasyon {i + 1}"
        plist = list(profil)
        if i == 2:
            plist.sort(key=lambda x: (-len(x["erisim"]), x["ad"]))
        elif i == 3:
            plist.sort(key=lambda x: (len(x["erisim"]), x["ad"]))
        elif i >= 4:
            # çeşitlilik için kararlı karışım
            plist.sort(
                key=lambda x: int(
                    hashlib.md5(f"{tohum}:{x['pid']}".encode()).hexdigest()[:8],
                    16,
                )
            )
        atamalar, uyarilar = hafta_greedy(
            tohum + i * 991,
            plist,
            kriz_modu=kriz_modu,
            varyant_ix=i,
        )

        imza = tuple(sorted((a["tarih"], a["sube_id"], a["bas_saat"], a["bit_saat"], a["personel_id"]) for a in atamalar))
        if imza in ozet_imza:
            continue
        ozet_imza.append(imza)

        # Kişi bazında hafta özeti
        kisi_ozet: Dict[str, Dict[str, Any]] = {}
        for a in atamalar:
            pid = a["personel_id"]
            kisi_ozet.setdefault(pid, {"personel_ad": a["personel_ad"], "gunler": {}})
            kisi_ozet[pid]["gunler"].setdefault(a["tarih"], []).append(
                {"sube": a["sube_ad"], "bas": a["bas_saat"], "bit": a["bit_saat"]}
            )

        senaryolar.append(
            {
                "id": chr(ord("A") + len(senaryolar)),
                "baslik": baslik,
                "atama_sayisi": len(atamalar),
                "uyarilar": uyarilar,
                "atamalar": atamalar,
                "kisi_ozet": kisi_ozet,
            }
        )

    tek_mi = len(senaryolar) <= 1
    aciklama = (
        "Kısıtlar nedeniyle haftalık plan tek bir kombinasyona sıkışıyor; alternatif üretmek için erişim/kuralları genişletin."
        if tek_mi
        else (
            f"{len(senaryolar)} farklı haftalık senaryo üretildi. "
            "Kararlar insan benzeri önceliklerle verildi: kısıtlı personeli kaçırmama, "
            "haftalık doluluk dengesi, aynı güne aşırı yük bindirmeme ve ardışık gün yorgunluğunu azaltma."
        )
    )

    return {
        "hafta_baslangic": str(pzt),
        "subeler_arasi_min_dakika": min_dk,
        "kriz_modu": bool(kriz_modu),
        "toplam_ihtiyac_satiri": len(ihtiyaclar),
        "planlamaya_dahil_personel": len(profil),
        "otomatik_izin_atanan_personel": int(auto_izin_say),
        "tek_mantikli_varyasyon_mu": tek_mi,
        "aciklama": aciklama,
        "senaryolar": senaryolar,
        "dinamik_ihtiyac": {
            "aktif": True,
            "kaynak": "ciro son 8 hafta (aynı gün tipi / şube ortalaması)",
            "katsayi_min": 0.75,
            "katsayi_max": 1.35,
        },
    }


def _senaryo_maliyet(s: Dict[str, Any]) -> float:
    """
    Düşük maliyet = daha iyi senaryo.
    """
    atamalar = s.get("atamalar") or []
    uyarilar = s.get("uyarilar") or []
    maliyet = 0.0
    maliyet += len(uyarilar) * 40.0
    for a in atamalar:
        if a.get("izin_ihlali"):
            maliyet += 400.0
        if a.get("rol_ihlali"):
            maliyet += 220.0
        if a.get("mesai"):
            maliyet += 35.0
    return maliyet


def hafta_senaryolari_expert_uret(
    cur,
    hafta_baslangic: date,
    kriz_modu: bool = False,
) -> Dict[str, Any]:
    """
    Uzman planlayıcı:
    - Daha geniş senaryo havuzu üretir
    - Çok hedefli maliyet fonksiyonu ile en iyi senaryoyu seçer
    - İlk 5 alternatifi sunar
    """
    base = hafta_senaryolari_uret(
        cur=cur,
        hafta_baslangic=hafta_baslangic,
        kriz_modu=kriz_modu,
        senaryo_adedi=16,
    )
    sen = base.get("senaryolar") or []
    if not sen:
        return base
    ranked = sorted(sen, key=_senaryo_maliyet)
    best = ranked[0]
    top = ranked[:4]
    return {
        **base,
        "planner": "expert",
        "aciklama": (
            f"Uzman planner {len(sen)} varyasyonu maliyet fonksiyonuyla taradı. "
            f"En iyi senaryo: {best.get('id')}."
        ),
        "en_iyi_senaryo_id": best.get("id"),
        "senaryolar": top,
        "maliyet_ozeti": [
            {"id": s.get("id"), "maliyet": _senaryo_maliyet(s)}
            for s in top
        ],
    }
