# -*- coding: utf-8 -*-
"""
Haftalık otomatik plan motoru — «insan planlamacı» benzeri sezgisel yerleştirme.

- Ayrı dosya: UI veya endpoint bu modülü çağırır; iş kuralı burada toplanır.
- Hafta boyunca (Pzt–Paz) eksik slotları önceliklendirir; ana şube, kalan günlük saat,
  haftalık yük dengelemesi ve gün içi çoklu şube cezası ile aday sıralar.
- Doğrudan atama: önce coz_varsayilan_atama_saatleri, sonra sunucunun boş saat çözümü.
- Taşıma (tasima_izni): Bir kişinin o gün «verilebilir» başka bir atamasını iptal edip
  eksik slota yazmayı SAVEPOINT ile dener (başarısızsa geri alır).

Tüm kritik kurallar vardiya_v2.atama_uyarilari / atama_olustur ile kalır (override=false).
"""
from __future__ import annotations

import uuid as _uuid
from datetime import date, timedelta, time
from typing import Any, Dict, List, Optional, Tuple

from vardiya_v2 import (
    atama_iptal,
    atama_olustur,
    atama_uyarilari,
    coz_varsayilan_atama_saatleri,
    gun_kilit_mi,
    gun_planini_getir,
)


def pazartesi_normalize(d: date) -> date:
    wd = d.weekday()
    return d - timedelta(days=wd)


def hafta_gunleri(pzt: date) -> List[date]:
    return [pzt + timedelta(days=i) for i in range(7)]


def _uygun_mu(cur, pid: str, slot_id: str, tarih: date,
              bas: Optional[time], bit: Optional[time]) -> Tuple[bool, str]:
    uy = atama_uyarilari(
        cur, pid, slot_id, tarih,
        baslangic_saat=bas, bitis_saat=bit,
        otomatik_saat_cozumu=(bas is None and bit is None),
    )
    for u in uy:
        if u.get("tip") == "cakisma":
            return False, "çakışma"
        if u.get("seviye") == "kritik":
            return False, str(u.get("tip") or "kritik")
    return True, ""


def _eksik_agenda_olustur(cur, hafta: List[date]) -> List[Dict[str, Any]]:
    """Tüm haftadan eksik > 0 slotları tek liste; sıralama önceliği en üstte."""
    satirlar: List[Dict[str, Any]] = []
    for tarih in hafta:
        if gun_kilit_mi(cur, tarih):
            continue
        plan = gun_planini_getir(cur, tarih)
        for sub in plan.get("subeler") or []:
            sid = str(sub.get("sube_id") or "")
            sad = str(sub.get("sube_ad") or sid)
            for sv in sub.get("slotlar") or []:
                eksik = int(sv.get("eksik") or 0)
                if eksik <= 0:
                    continue
                sl = sv.get("slot") or {}
                tip = (sl.get("tip") or "normal").strip().lower()
                ideal_eksik = int(sv.get("ideal_eksik") or 0)
                tip_p = 0
                if tip == "kapanis":
                    tip_p = 90
                elif tip == "acilis":
                    tip_p = 70
                elif tip == "yogun":
                    tip_p = 50
                oncelik = eksik * 1000 + ideal_eksik * 40 + tip_p
                sid_slot = _sv_slot_id(sv)
                if not sid_slot:
                    continue
                satirlar.append({
                    "tarih": tarih,
                    "tarih_iso": str(tarih),
                    "sube_id": sid,
                    "sube_ad": sad,
                    "sv": sv,
                    "slot_id": sid_slot,
                    "oncelik": oncelik,
                    "slot_tip": tip,
                    "eksik": eksik,
                })
    satirlar.sort(key=lambda x: -x["oncelik"])
    return satirlar


def _personel_skor(person: Dict[str, Any], hedef_sube_id: str) -> float:
    """Yüksek = daha uygun aday."""
    gd = person.get("gun_durumu") or {}
    if gd.get("durum") == "IZINLI":
        return -1e9
    kal = float(gd.get("kalan_saat") or 0)
    if kal <= 0.05:
        return -1e9

    ts = str(hedef_sube_id or "")
    home = str(person.get("sube_id") or "")
    s = 0.0
    # Ana şube — Zafer'deki kişiyi Zafer'e yazmak doğal
    if home and ts and home == ts:
        s += 5200.0
    # Haftalık yükü düşük olsun (herkesi adil kullan)
    haf = float(person.get("haftalik_saat") or 0)
    s -= haf * 14.0
    # Bugün boş zaman esnekliği
    s += kal * 160.0

    atamalar = gd.get("atamalar") or []
    bugun_subeler = set()
    for am in atamalar:
        sb = str(am.get("sube_id") or "")
        if sb:
            bugun_subeler.add(sb)
    if ts and ts in bugun_subeler:
        s += 380.0  # aynı şubede zaten mesai — uzatmak kolay
    for sb in bugun_subeler:
        if sb != ts:
            s -= 340.0  # başka şubede mesai — taşımak / ikinci görev maliyeti

    return s


def _sv_slot_id(sv: Dict[str, Any]) -> str:
    sl = sv.get("slot") or {}
    return str(sl.get("id") or "")


def _tasima_verilebilir_mi(donor_sv: Dict[str, Any], donor_atama_id: str) -> bool:
    """İptal sonrası donor slotta min_personel altına düşülür mü?"""
    sl = donor_sv.get("slot") or {}
    min_p = int(sl.get("min_personel") or 0)
    atamalar = list(donor_sv.get("atamalar") or [])
    mevcut = len(atamalar)
    bu_atama = next((a for a in atamalar if str(a.get("id")) == str(donor_atama_id)), None)
    if not bu_atama:
        return False
    return (mevcut - 1) >= min_p


def _donor_sv_bul(plan: Dict[str, Any], slot_id: str) -> Optional[Dict[str, Any]]:
    for sub in plan.get("subeler") or []:
        for sv in sub.get("slotlar") or []:
            if _sv_slot_id(sv) == str(slot_id):
                return sv
    return None


def _direkt_yerlestir(
    cur,
    pid: str,
    slot_id: str,
    tarih: date,
    kullanici_id: Optional[str],
    etiket: str,
) -> Tuple[bool, str]:
    denemeler: List[Tuple[Optional[time], Optional[time]]] = []
    cz = coz_varsayilan_atama_saatleri(cur, pid, tarih, slot_id)
    if cz:
        denemeler.append((cz[0], cz[1]))
    denemeler.append((None, None))

    gordum: set = set()
    for bas, bit in denemeler:
        key = (bas, bit)
        if key in gordum:
            continue
        gordum.add(key)
        ok, _neden = _uygun_mu(cur, pid, slot_id, tarih, bas, bit)
        if not ok:
            continue
        r = atama_olustur(
            cur, pid, slot_id, tarih,
            baslangic_saat=bas, bitis_saat=bit,
            override=False,
            kullanici_id=kullanici_id,
            aciklama=etiket,
            otomatik_saat_cozumu=(bas is None and bit is None),
        )
        if r.get("basarili"):
            return True, "direkt"
    return False, ""


def _tasima_dene(
    cur,
    pid: str,
    hedef_slot_id: str,
    tarih: date,
    plan: Dict[str, Any],
    kullanici_id: Optional[str],
    etiket: str,
) -> Tuple[bool, str]:
    gd = None
    for p in plan.get("personel_havuzu") or []:
        if str(p.get("id")) == str(pid):
            gd = p.get("gun_durumu") or {}
            break
    if not gd:
        return False, ""

    atamalar = gd.get("atamalar") or []
    for am in atamalar:
        aid = str(am.get("id") or "")
        eski_sid = str(am.get("slot_id") or "")
        if not aid or eski_sid == str(hedef_slot_id):
            continue

        donor_sv = _donor_sv_bul(plan, eski_sid)
        if not donor_sv:
            continue
        if not _tasima_verilebilir_mi(donor_sv, aid):
            continue

        sp = f"motor_{_uuid.uuid4().hex[:12]}"
        cur.execute(f"SAVEPOINT {sp}")
        try:
            ipt = atama_iptal(cur, aid, kullanici_id=kullanici_id)
            if not ipt.get("basarili"):
                cur.execute(f"ROLLBACK TO SAVEPOINT {sp}")
                continue

            cz = coz_varsayilan_atama_saatleri(cur, pid, tarih, hedef_slot_id)
            bas = cz[0] if cz else None
            bit = cz[1] if cz else None
            ok, _ = _uygun_mu(cur, pid, hedef_slot_id, tarih, bas, bit)
            if not ok:
                cur.execute(f"ROLLBACK TO SAVEPOINT {sp}")
                continue
            r = atama_olustur(
                cur, pid, hedef_slot_id, tarih,
                baslangic_saat=bas, bitis_saat=bit,
                override=False,
                kullanici_id=kullanici_id,
                aciklama=etiket + " [taşıma]",
                otomatik_saat_cozumu=(bas is None or bit is None),
            )
            if r.get("basarili"):
                cur.execute(f"RELEASE SAVEPOINT {sp}")
                eslot = (donor_sv.get("slot") or {}).get("ad") or eski_sid
                return True, str(eslot)
            cur.execute(f"ROLLBACK TO SAVEPOINT {sp}")
        except Exception:
            try:
                cur.execute(f"ROLLBACK TO SAVEPOINT {sp}")
            except Exception:
                pass
            raise

    return False, ""


def hafta_otomatik_planla(
    cur,
    *,
    pazartesi_gun: date,
    max_rounds: int = 120,
    tasima_izni: bool = True,
    kullanici_id: Optional[str] = None,
    aciklama_etiketi: str = "[Otomatik plan motoru]",
) -> Dict[str, Any]:
    """
    Bir haftalık döngüde eksik slotları doldurur (her turda en fazla bir atama).

    Dönüş:
      atama_sayisi, tur_sayisi, log (insan okuyabilir satırlar), son_hata (varsa)
    """
    pzt = pazartesi_normalize(pazartesi_gun)
    hafta = hafta_gunleri(pzt)
    log: List[str] = []
    atama_sayisi = 0
    son_tur = 0

    aciklama = (aciklama_etiketi or "").strip() or "[Otomatik plan motoru]"

    for tur in range(1, max_rounds + 1):
        son_tur = tur
        agenda = _eksik_agenda_olustur(cur, hafta)
        if not agenda:
            log.append(f"Tur {tur}: Eksik slot kalmadı — plan tamam.")
            break

        turda_ilerleme = False

        for satir in agenda:
            tarih = satir["tarih"]
            hedef_slot_id = satir["slot_id"]
            sube_ad = satir["sube_ad"]
            slot_ad = (satir["sv"].get("slot") or {}).get("ad") or hedef_slot_id
            eksik = satir["eksik"]

            plan = gun_planini_getir(cur, tarih)
            hedef_sv = _donor_sv_bul(plan, hedef_slot_id)
            if not hedef_sv or int(hedef_sv.get("eksik") or 0) <= 0:
                continue

            havuz = list(plan.get("personel_havuzu") or [])
            havuz.sort(
                key=lambda p: _personel_skor(p, satir["sube_id"]),
                reverse=True,
            )

            yerlesti = False
            for person in havuz:
                pid = str(person.get("id") or "")
                if not pid:
                    continue
                sk = _personel_skor(person, satir["sube_id"])
                if sk < -1e8:
                    continue

                ok, mod = _direkt_yerlestir(
                    cur, pid, hedef_slot_id, tarih, kullanici_id, aciklama,
                )
                if ok:
                    ad = f"{person.get('ad') or ''} {person.get('soyad') or ''}".strip() or pid
                    log.append(
                        f"Tur {tur}: {tarih} · {sube_ad} · «{slot_ad}» (eksik {eksik}) → "
                        f"{ad} doğrudan yerleştirildi ({mod})."
                    )
                    atama_sayisi += 1
                    yerlesti = True
                    turda_ilerleme = True
                    break

                if tasima_izni:
                    plan2 = gun_planini_getir(cur, tarih)
                    t_ok, donor_ad = _tasima_dene(
                        cur, pid, hedef_slot_id, tarih, plan2,
                        kullanici_id, aciklama,
                    )
                    if t_ok:
                        ad = f"{person.get('ad') or ''} {person.get('soyad') or ''}".strip() or pid
                        log.append(
                            f"Tur {tur}: {tarih} · {sube_ad} · «{slot_ad}» → {ad} taşındı "
                            f"(kaynak slot: «{donor_ad}»); eksik kapatıldı."
                        )
                        atama_sayisi += 1
                        yerlesti = True
                        turda_ilerleme = True
                        break

            if yerlesti:
                break

        if not turda_ilerleme:
            log.append(
                f"Tur {tur}: Öncelik listedeki hiçbir eksik kapatılamadı — motor durdu "
                f"(kurallar / kapasite / uygun taşıma yok)."
            )
            break

    return {
        "basarili": True,
        "pazartesi": str(pzt),
        "atama_sayisi": atama_sayisi,
        "tur_sayisi": son_tur,
        "log": log,
        "mesaj": f"Motor tamam: {atama_sayisi} atama ({son_tur} tur).",
    }
