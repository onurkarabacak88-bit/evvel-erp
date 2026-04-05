"""
Günlük vardiya: şube_config + personel_kisit + sube_baglanti + izin.
Atama: skorlamalı (kapanış önceliği, tam zamanlı); kaydırma tüm ev atamaları bittikten sonra.

Mimari notlar (Tulipi / çapraz şube):
- A şubede gündüz + B şubede kapanış → iki ayrı vardiya satırı (iki sube_id, aynı gün).
  İleride tek satırda baslangic_sube / bitis_sube eklenirse şema genişletilir.
- Günlük aynı personel için en fazla MAX_VARDIYA_KAYIT_GUNLUK kayıt (çift kayıt sınırı).
- Saat şablonu VARDIYA_SAATLER; 09:30 bazlı şube/personel şablonu ileride config’ten okunabilir.
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Any, Dict, List, Optional, Set, Tuple

# ACILIS / ARA / KAPANIS — TIME string (PostgreSQL ::time)
VARDIYA_SAATLER = {
    "ACILIS": ("09:00:00", "13:00:00"),
    "ARA": ("13:00:00", "17:00:00"),
    "KAPANIS": ("17:00:00", "21:00:00"),
}

TIPLER = ("ACILIS", "ARA", "KAPANIS")

# Aynı gün aynı personel: örn. ev şubesi + bağlı şubede ek kapanış = en fazla bu kadar satır
MAX_VARDIYA_KAYIT_GUNLUK = 2


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
) -> Tuple[List[Tuple[Dict[str, Any], str, str]], int]:
    """tek_kapanis_izinli=False iken çoklu personelde yerelde yeterli kapanış sayısına yaklaş."""
    n = len(personeller)
    yapabilen = sum(
        1 for p in personeller if personel_tip_yapabilir(p, "KAPANIS", kisitlar)
    )
    hedef = min(max(int(min_kap or 1), 1), n, max(yapabilen, 0))
    liste = list(atamalar)
    cur_k = sum(1 for _, t, _ in liste if t == "KAPANIS")
    if tek_kap_izinli and n == 1:
        return liste, cur_k
    while cur_k < hedef:
        idx = None
        for i, (p, tip, _) in enumerate(liste):
            if tip == "KAPANIS":
                continue
            if personel_tip_yapabilir(p, "KAPANIS", kisitlar):
                idx = i
                break
        if idx is None:
            break
        p, tip_old, ned = liste[idx]
        liste[idx] = (p, "KAPANIS", f"{ned} → min_kapanis hedefi")
        log.append(
            {
                "kural": "MIN_KAP_LOKAL",
                "sube": sube_ad,
                "personel": p["ad_soyad"],
                "detay": "Yerelde ikinci/üçüncü kapanış için tip yükseltildi",
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
        "min_kapanis": 1,
        "tek_kapanis_izinli": True,
        "tek_acilis_izinli": True,
        "kaydirma_acik": True,
        "sadece_tam_kayabilir": False,
        "hafta_sonu_min_kap": 1,
        "tam_part_zorunlu": False,
        "kapanis_dusurulemez": False,
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
    }


def _kisit_of(
    p: Dict[str, Any], kisitlar: Dict[str, Dict[str, Any]]
) -> Dict[str, Any]:
    return kisitlar.get(p["id"]) or _default_kisit(p["id"])


def personel_tip_yapabilir(
    p: Dict[str, Any], tip: str, kisitlar: Dict[str, Dict[str, Any]]
) -> bool:
    """Veritabanı personel_kisit satırına göre (varsayılan: hepsi açık)."""
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


def _skor_kapanis_adayi(
    p: Dict[str, Any], kisitlar: Dict[str, Dict[str, Any]]
) -> Tuple[int, str]:
    """
    Yüksek skor = kapanış slotuna öncelik.
    Tam zamanlı > part, isimle deterministik beraberlik kırılımı.
    """
    k = _kisit_of(p, kisitlar)
    s = 0
    if k.get("kapanis_yapabilir", True):
        s += 100
    if p.get("calisma_turu") == "surekli":
        s += 30
    if k.get("acilis_yapabilir", True):
        s += 5
    if k.get("ara_yapabilir", True):
        s += 3
    return (s, p.get("ad_soyad") or "")


def _skor_kaynak_kapanis(
    p: Dict[str, Any], kisitlar: Dict[str, Dict[str, Any]]
) -> Tuple[int, str]:
    """Kaydırılacak aday sıralaması (kapanış yapabilen, tam zamanlı önce)."""
    return _skor_kapanis_adayi(p, kisitlar)


def _sube_icin_skorlu_ata(
    personeller: List[Dict[str, Any]],
    cfg: Dict[str, Any],
    kisitlar: Dict[str, Dict[str, Any]],
    hafta_sonu: bool,
    sube_ad: str,
    log: List[Dict[str, Any]],
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

    # 1) sadece_tip sabitleri
    sabit: List[Tuple[Dict[str, Any], str]] = []
    esnek: List[Dict[str, Any]] = []
    for p in personeller:
        k = _kisit_of(p, kisitlar)
        st = k.get("sadece_tip")
        if st and st in TIPLER:
            if personel_tip_yapabilir(p, st, kisitlar):
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
        p for p in kalan if personel_tip_yapabilir(p, "KAPANIS", kisitlar)
    ]
    kap_yapabilen.sort(key=lambda p: _skor_kapanis_adayi(p, kisitlar), reverse=True)

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
        p for p in hala if personel_tip_yapabilir(p, "ACILIS", kisitlar)
    ]
    acilis_aday.sort(
        key=lambda p: (
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

    # 4) Geri kalan: ACILIS / ARA sırayla
    hala = [p for p in kalan if p["id"] not in kullanilan]
    for p in sorted(hala, key=lambda x: x.get("ad_soyad") or ""):
        if personel_tip_yapabilir(p, "ACILIS", kisitlar):
            t = "ACILIS"
            ned = "Kalan slot: açılış"
        elif personel_tip_yapabilir(p, "ARA", kisitlar):
            t = "ARA"
            ned = "Kalan slot: ara"
        elif personel_tip_yapabilir(p, "KAPANIS", kisitlar):
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
                if personel_tip_yapabilir(p, "ARA", kisitlar):
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


def vardiya_motoru_calistir(cur, tarih: date) -> Dict[str, Any]:
    """
    cur: psycopg cursor (dict rows).
    sube_config, personel_kisit, sube_baglanti tabloları okunur (yoksa güvenli varsayılan).
    """
    log: List[Dict[str, Any]] = []
    hafta_sonu = tarih.weekday() >= 5

    cur.execute("DELETE FROM vardiya WHERE tarih = %s", (str(tarih),))

    cur.execute("SELECT * FROM subeler WHERE aktif = TRUE ORDER BY ad")
    subeler_raw = cur.fetchall()
    subeler: Dict[str, Dict[str, Any]] = {s["id"]: dict(s) for s in subeler_raw}
    if not subeler:
        return {
            "success": True,
            "tarih": str(tarih),
            "olusturulan": 0,
            "izinli_sayisi": 0,
            "log": [{"kural": "HATA", "detay": "Aktif şube yok"}],
            "mesaj": "Aktif şube tanımlı değil.",
        }

    cur.execute("SELECT * FROM sube_config")
    sube_cfg: Dict[str, Dict[str, Any]] = {r["sube_id"]: dict(r) for r in cur.fetchall()}

    cur.execute("SELECT * FROM sube_baglanti WHERE aktif = TRUE")
    baglanti: Dict[str, List[str]] = {}
    for b in cur.fetchall():
        baglanti.setdefault(b["kaynak_id"], []).append(b["hedef_id"])
        baglanti.setdefault(b["hedef_id"], []).append(b["kaynak_id"])

    cur.execute("SELECT * FROM personel_kisit")
    kisitlar: Dict[str, Dict[str, Any]] = {r["personel_id"]: dict(r) for r in cur.fetchall()}

    cur.execute(
        """
        SELECT personel_id FROM personel_izin
        WHERE durum = 'onaylandi'
          AND baslangic_tarih <= %s AND bitis_tarih >= %s
        """,
        (str(tarih), str(tarih)),
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
        SELECT * FROM personel WHERE aktif = TRUE
        ORDER BY calisma_turu DESC, ad_soyad
        """
    )
    tum_personel = [dict(p) for p in cur.fetchall()]
    if not tum_personel:
        return {
            "success": True,
            "tarih": str(tarih),
            "olusturulan": 0,
            "izinli_sayisi": 0,
            "log": [{"kural": "HATA", "detay": "Aktif personel yok"}],
            "mesaj": "Aktif personel tanımlı değil; vardiya oluşturulmadı.",
        }

    musait = [p for p in tum_personel if p["id"] not in izinliler]

    sube_personel: Dict[str, List[Dict[str, Any]]] = {}
    for p in musait:
        sid = p.get("sube_id") or "sube-merkez"
        cur.execute("SELECT id FROM subeler WHERE id = %s", (sid,))
        if not cur.fetchone():
            sid = "sube-merkez"
            cur.execute("SELECT id FROM subeler WHERE id = %s", (sid,))
            if not cur.fetchone():
                sid = next(iter(subeler.keys()))
        sube_personel.setdefault(sid, []).append(p)

    olusturulan = 0
    tarih_str = str(tarih)

    def vardiya_yaz(
        personel: Dict[str, Any],
        tip: str,
        sube_id: str,
        neden: str,
    ) -> None:
        nonlocal olusturulan
        if _vardiya_sayisi_bugun(cur, tarih_str, personel["id"]) >= MAX_VARDIYA_KAYIT_GUNLUK:
            log.append(
                {
                    "kural": "LIMIT_GUNLUK",
                    "personel": personel["ad_soyad"],
                    "detay": "Günlük kayıt sınırı dolu; ek atama yapılmadı",
                }
            )
            return
        bas, bit = VARDIYA_SAATLER[tip]
        k = _kisit_of(personel, kisitlar)
        if tip == "KAPANIS" and k.get("kapanis_bit_saat"):
            bit = _time_hhmmss(k.get("kapanis_bit_saat"), bit)
            neden = f"{neden} [kapanış bitiş: {bit[:5]}]"
        vid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO vardiya (id, tarih, personel_id, sube_id, tip, bas_saat, bit_saat)
            VALUES (%s, %s, %s, %s, %s, %s::time, %s::time)
            """,
            (vid, tarih_str, personel["id"], sube_id, tip, bas, bit),
        )
        olusturulan += 1
        log.append(
            {
                "kural": "VARDIYA",
                "personel": personel["ad_soyad"],
                "sube": subeler.get(sube_id, {}).get("ad", sube_id),
                "tip": tip,
                "detay": neden,
            }
        )

    # ── Faz 1: Tüm şubelerde yalnızca ev ataması (sıra: şube adı) ─────────
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
        personeller = list(sube_personel.get(sube_id, []))
        if not personeller:
            log.append(
                {
                    "kural": "BOS_SUBE",
                    "sube": sube_ad,
                    "detay": "Müsait personel yok",
                }
            )
            continue

        atamalar, kapanis_sayisi, acilis_sayisi, atanan_ids = _sube_icin_skorlu_ata(
            personeller, cfg, kisitlar, hafta_sonu, sube_ad, log
        )
        atamalar, kapanis_sayisi = _atamalar_min_kapanis_yukselt(
            atamalar,
            min_kap,
            tek_kap_izinli,
            personeller,
            kisitlar,
            sube_ad,
            log,
        )

        for p, tip, ned in atamalar:
            vardiya_yaz(p, tip, sube_id, ned)

        if tam_part_zorunlu:
            tam_var = any(x.get("calisma_turu") == "surekli" for x in personeller)
            part_var = any(x.get("calisma_turu") != "surekli" for x in personeller)
            if tam_var and part_var:
                tam_atanmis = any(
                    p["id"] in atanan_ids and p.get("calisma_turu") == "surekli"
                    for p in personeller
                )
                part_atanmis = any(
                    p["id"] in atanan_ids and p.get("calisma_turu") != "surekli"
                    for p in personeller
                )
                if not (tam_atanmis and part_atanmis):
                    log.append(
                        {
                            "kural": "TAM_PART_UYARI",
                            "sube": sube_ad,
                            "detay": "1 tam + 1 part hedefi bu gün karşılanamadı",
                        }
                    )

    # ── Faz 2: Eksik kapanış → sadece sube_baglanti üzerinden kaydırma ─────
    for sube_id in subeler:
        cfg_row = sube_cfg.get(sube_id)
        cfg = {**_default_sube_cfg(sube_id), **(cfg_row or {})}
        kaydirma_acik = bool(cfg.get("kaydirma_acik", True))
        sadece_tam = bool(cfg.get("sadece_tam_kayabilir", False))
        min_kap = (
            int(cfg.get("hafta_sonu_min_kap") or 1)
            if hafta_sonu
            else int(cfg.get("min_kapanis") or 1)
        )
        sube_ad = subeler.get(sube_id, {}).get("ad") or sube_id

        cur.execute(
            """
            SELECT COUNT(*) AS c FROM vardiya
            WHERE tarih = %s AND sube_id = %s AND tip = 'KAPANIS'
            """,
            (tarih_str, sube_id),
        )
        kapanis_sayisi = int(cur.fetchone()["c"])

        if kapanis_sayisi >= min_kap or not kaydirma_acik:
            continue

        eksik = min_kap - kapanis_sayisi
        bagli = baglanti.get(sube_id, [])
        if not bagli:
            log.append(
                {
                    "kural": "MIN_KAP_BAGLANTI_YOK",
                    "sube": sube_ad,
                    "detay": f"{eksik} eksik kapanış; şube bağlantısı tanımlı değil",
                }
            )
            continue

        log.append(
            {
                "kural": "MIN_KAP",
                "sube": sube_ad,
                "detay": f"{eksik} eksik kapanış (faz 2 kaydırma, bağlantılı şubeler)",
            }
        )
        adaylar: List[Dict[str, Any]] = []
        gordu: Set[str] = set()
        for kaynak_sid in bagli:
            for kp in sube_personel.get(kaynak_sid, []):
                pid = kp["id"]
                if pid in gordu:
                    continue
                gordu.add(pid)
                adaylar.append(kp)
        adaylar.sort(key=lambda p: _skor_kaynak_kapanis(p, kisitlar), reverse=True)

        for kp in adaylar:
            if eksik <= 0:
                break
            if sadece_tam and kp.get("calisma_turu") != "surekli":
                continue
            kk = _kisit_of(kp, kisitlar)
            if not kk.get("sube_degistirebilir", True):
                continue
            if not personel_tip_yapabilir(kp, "KAPANIS", kisitlar):
                continue
            if _vardiya_sayisi_bugun(cur, tarih_str, kp["id"]) >= MAX_VARDIYA_KAYIT_GUNLUK:
                continue
            kaynak_sid = kp.get("sube_id") or "sube-merkez"
            vardiya_yaz(
                kp,
                "KAPANIS",
                sube_id,
                f"Kaydırma (faz 2): {subeler.get(kaynak_sid, {}).get('ad', '?')} → {sube_ad}",
            )
            eksik -= 1

        if eksik > 0:
            log.append(
                {
                    "kural": "MIN_KAP_KARSILANAMADI",
                    "sube": sube_ad,
                    "detay": f"Hâlâ {eksik} kapanış eksik; limit/kısıt veya uygun personel yok",
                }
            )

    # ── Faz 3: Hiç satırı olmayan müsait personel (şube eşlemesi / yetim) ───
    q_orphan = """
        SELECT p.id, p.ad_soyad, p.sube_id FROM personel p
        WHERE p.aktif = TRUE
        AND NOT EXISTS (
            SELECT 1 FROM vardiya v WHERE v.tarih = %s AND v.personel_id = p.id
        )
    """
    if izinliler:
        q_orphan += " AND p.id NOT IN %s"
        cur.execute(q_orphan, (tarih_str, tuple(izinliler)))
    else:
        cur.execute(q_orphan, (tarih_str,))

    for op in cur.fetchall():
        pid = op["id"]
        sid = op.get("sube_id") or "sube-merkez"
        cur.execute("SELECT id FROM subeler WHERE id = %s", (sid,))
        if not cur.fetchone():
            sid = "sube-merkez"
            cur.execute("SELECT id FROM subeler WHERE id = %s", (sid,))
            if not cur.fetchone():
                sid = next(iter(subeler.keys()))
        if sid not in subeler:
            sid = next(iter(subeler.keys()))
        if _vardiya_sayisi_bugun(cur, tarih_str, pid) >= MAX_VARDIYA_KAYIT_GUNLUK:
            continue
        p_stub = {"id": pid, "ad_soyad": op["ad_soyad"]}
        tip_e = (
            "ARA"
            if personel_tip_yapabilir(p_stub, "ARA", kisitlar)
            else (
                "ACILIS"
                if personel_tip_yapabilir(p_stub, "ACILIS", kisitlar)
                else "KAPANIS"
            )
        )
        if not personel_tip_yapabilir(p_stub, tip_e, kisitlar):
            log.append(
                {
                    "kural": "YETIM_UYARI",
                    "personel": op["ad_soyad"],
                    "detay": "Ev ataması yoktu; kısıt nedeniyle otomatik tip seçilemedi",
                }
            )
            continue
        vardiya_yaz(
            p_stub,
            tip_e,
            sid,
            "Yetim tamamlama: ana şubede eksik ev satırı giderildi",
        )

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
