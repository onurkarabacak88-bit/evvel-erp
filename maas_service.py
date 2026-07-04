# -*- coding: utf-8 -*-
"""
MAAŞ SERVİSİ — personel maaşının TEK MERKEZİ.

Daha önce main.py + motors.py arasında kopyalanan dört bilgi burada tek yerde yaşar:
  1. HESAP     : kanonik hesap (Vardiya Takip kurgusu) + manuel katman + yedek formül
  2. PLAN      : ödeme planı yazımı — hem aylık üretici (motors) hem ekran senkronu
                 AYNI fonksiyonu çağırır → çift plan / konvansiyon kayması imkânsızlaşır
  3. DÖNEM     : "referans_ay = ÖDEME AYI = çalışma ayı + 1" (arrears) kuralı tek fonksiyonda
  4. SABİTLER  : 285 saat/ay, 30 gün, TR ay adları

Kanonik hesap kararı (kullanıcı, 2026-07-04, b585911): bordronun otomatik kalemleri
Vardiya Takip'in hesabından gelir; maas_hesapla yalnızca yedek yoldur (takip çökerse).

Tüm fonksiyonlar çağıranın transaction'ındaki cursor ile çalışır (kendi bağlantı açmaz);
tek istisna vardiya_takip_hesap — gorev_api.vardiya_takip kendi bağlantısını açar (salt-okur).
"""

import calendar
import logging
import uuid
from datetime import date
from typing import Any, Dict, Optional

import vardiya_v2 as _vv2

logger = logging.getLogger("maas_service")

# ── SABİTLER (tek kaynak) ──────────────────────────────────────
GUNLUK_SAAT = 9.5
AYLIK_GUN = 30                      # İş Kanunu standardı: izin günleri dahil 30 gün
AYLIK_SAAT = GUNLUK_SAAT * AYLIK_GUN  # 285

TR_AYLAR = ["", "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
            "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"]


# ── DÖNEM KURALLARI ────────────────────────────────────────────

def maas_odeme_tarihi(yil: int, ay: int) -> date:
    """ARREARS kuralı: (yil, ay) = ÇALIŞMA dönemi → ödeme, takip eden ayın 1'i.
    referans_ay konvansiyonu da bu tarihten türetilir (referans_ay = ödeme ayı)."""
    odeme_yil = yil + 1 if ay == 12 else yil
    odeme_ay = 1 if ay == 12 else ay + 1
    return date(odeme_yil, odeme_ay, 1)


def plan_aciklama(p: dict, yil: int, ay: int) -> str:
    """CFO panel / Yaklaşan Ödemeler'de hangi ayın maaşı olduğu okunsun diye dönem etiketi."""
    return f"Personel Maaş: {p.get('ad_soyad') or ''} — {TR_AYLAR[ay]} {yil} dönemi"


def personel_donem_orani(p: dict, yil: int, ay: int) -> Optional[float]:
    """Dönem içi çalışma oranı (0..1). Ay ortasında işe giren/ayrılan sürekli personel
    tam 30 gün değil, çalıştığı takvim günü oranında hakediş alır (kural 2026-07-03:
    'Dönem hakedişi aktiflikten bağımsızdır' — 10 günlük alacak silinmez, 20 günlük
    çalışana 30 gün yazılmaz). Dönemle hiç kesişmiyorsa None döner."""
    sgun = calendar.monthrange(yil, ay)[1]
    d1, d2 = date(yil, ay, 1), date(yil, ay, sgun)
    b, c = p.get('baslangic_tarihi'), p.get('cikis_tarihi')
    eff1 = max(d1, b) if b else d1
    eff2 = min(d2, c) if c else d2
    if eff1 > eff2:
        return None
    gun = (eff2 - eff1).days + 1
    return 1.0 if gun >= sgun else gun / sgun


# ── HESAP MOTORLARI ────────────────────────────────────────────

def vardiya_takip_hesap(pid, yil: int, ay: int) -> Optional[dict]:
    """TEK GERÇEK KAYNAK (kullanıcı kararı 2026-07-04): bordronun otomatik kalemleri
    Vardiya Takip'in hesabından gelir — iki ekran her zaman aynı rakamı söyler.
    Kurgu (takip ekseni): taban=(maaş/30)×geçen gün (başlangıç/çıkış kırpılmış),
    fazla mesai=GÜNLÜK bazlı (9.5 saat üstü planlanan)×saatlik, yemek=hak edilen
    fiilî gün×(aylık yemek/30), yol=(yol/30)×geçen gün; part-time=planlanan saat×saatlik.
    (gorev_api.vardiya_takip kendi bağlantısını açar; salt-okur, güvenli.)"""
    try:
        from gorev_api import vardiya_takip as _vt
        res = _vt(yil, ay, personel_id=str(pid))
        rows = (res or {}).get("personeller") or []
        return rows[0] if rows else None
    except Exception as e:
        logger.warning("vardiya takip hesap hatasi (%s %s-%s): %s", pid, yil, ay, e)
        return None


def kanonik_net(p: dict, vt: dict, kayit: dict) -> float:
    """Bordro neti = Vardiya Takip net_hakedişi (otomatik kalemler) + MANUEL katman:
    bayram mesaisi ×2 (takipte yok) − eksik gün/rapor kesintisi (günlük ücret) + manuel düzeltme."""
    if (p.get("calisma_turu") or "surekli") == "surekli":
        maas = float(p.get("maas") or 0)
        saatlik = maas / AYLIK_SAAT
        gunluk = maas / AYLIK_GUN
    else:
        saatlik = float(p.get("saatlik_ucret") or 0)
        gunluk = saatlik * GUNLUK_SAAT
    net = float(vt.get("net_hakediş") or 0)
    net += float(kayit.get("bayram_mesai_saat") or 0) * saatlik * 2
    kesinti_gun = float(kayit.get("eksik_gun") or 0) + (
        float(kayit.get("raporlu_gun") or 0) if kayit.get("rapor_kesinti") else 0)
    net -= gunluk * kesinti_gun
    net += float(kayit.get("manuel_duzeltme") or 0)
    return round(max(0.0, net), 2)


def maas_hesapla(p: dict, kayit: dict, yil: int = None, ay: int = None) -> float:
    """YEDEK YOL (kanonik hesap alınamazsa sistem durmasın diye). Kanonik = Vardiya Takip.

    SÜREKLİ:
      - Günlük standart: 9.5 saat, aylık 30 gün (izin günleri dahil, İş Kanunu standardı)
      - Saatlik ücret = maaş / 285; fazla mesai ×1, bayram ×2
      - Eksik gün kesintisi: (maaş / 30) × eksik_gün
      - DÖNEM PRO-RATA: yil/ay verildiyse maaş+yemek+yol tabanı çalışılan gün oranında
        (mesai ve eksik-gün birim ücretleri TAM maaştan)
    PART-TIME:
      - Ay boyunca TOPLAM saat × saatlik ücret; fazla mesai kavramı YOK; yemek yok, yol var.
    """
    yol = float(p.get('yol_ucreti') or 0)
    manuel = float(kayit.get('manuel_duzeltme') or 0)
    eksik = float(kayit.get('eksik_gun') or 0)
    raporlu = float(kayit.get('raporlu_gun') or 0)
    fazla_normal = float(kayit.get('fazla_mesai_saat') or 0)
    fazla_bayram = float(kayit.get('bayram_mesai_saat') or 0)
    rapor_kesinti = kayit.get('rapor_kesinti', False)

    if p.get('calisma_turu') == 'surekli':
        maas = float(p.get('maas') or 0)
        yemek = float(p.get('yemek_ucreti') or 0)
        saatlik = maas / AYLIK_SAAT if AYLIK_SAAT > 0 else 0
        gunluk = maas / AYLIK_GUN if AYLIK_GUN > 0 else 0

        oran = 1.0
        if yil and ay:
            _o = personel_donem_orani(p, yil, ay)
            if _o is None:
                return 0.0  # dönemle kesişmiyor (dönemden önce ayrıldı / sonra başlayacak)
            oran = _o

        kesinti_gun = eksik + (raporlu if rapor_kesinti else 0)
        kesinti = gunluk * kesinti_gun  # günlük ücret × eksik gün (İş Kanunu)

        fazla_ucret = (fazla_normal * saatlik) + (fazla_bayram * saatlik * 2)
        net = (maas * oran) - kesinti + fazla_ucret + (yemek * oran) + (yol * oran) + manuel
    else:
        saatlik = float(p.get('saatlik_ucret') or 0)
        saat = float(kayit.get('calisma_saati') or 0)
        net = (saat * saatlik) + yol + manuel

    return round(max(0, net), 2)


def vardiya_kayit_dict(cur, p: dict, yil: int, ay: int, mevcut: Optional[dict] = None) -> dict:
    """Yedek yolun veri kaynağı: vardiya_v2'den saat/ek mesai çekip kayıt sözlüğü kurar."""
    mevcut = dict(mevcut or {})
    vk = _vv2.personel_ay_vardiya_maas_kaynagi(cur, p["id"], yil, ay)
    calisma = float(mevcut.get("calisma_saati") or 0)
    fazla = float(mevcut.get("fazla_mesai_saat") or 0)

    if (p.get("calisma_turu") or "surekli") == "surekli":
        fazla = float(vk.get("ek_mesai_haftalik_toplam") or 0)
    else:
        calisma = float(vk.get("toplam_ay_saat") or 0)

    return {
        "calisma_saati": calisma,
        "fazla_mesai_saat": fazla,
        "bayram_mesai_saat": float(mevcut.get("bayram_mesai_saat") or 0),
        "eksik_gun": float(mevcut.get("eksik_gun") or 0),
        "raporlu_gun": float(mevcut.get("raporlu_gun") or 0),
        "rapor_kesinti": bool(mevcut.get("rapor_kesinti") or False),
        "manuel_duzeltme": float(mevcut.get("manuel_duzeltme") or 0),
        "not_aciklama": mevcut.get("not_aciklama"),
        "_vardiya": vk,
    }


# ── TEK PLAN YAZICI ────────────────────────────────────────────

def odeme_plani_esitle(cur, p: dict, yil: int, ay: int, net: float,
                       guncelle: bool = True) -> Optional[Dict[str, Any]]:
    """Personelin (yil, ay) ÇALIŞMA dönemi maaş ödeme planını tek noktadan yazar.

    - guncelle=True  (ekran senkronu): bekleyen plan varsa tutar/tarih/açıklama GÜNCELLENİR,
      yoksa oluşturulur.
    - guncelle=False (aylık üretici / motors): plan varsa DOKUNULMAZ (kanonik senkron
      rakamı ezilmesin), yoksa oluşturulur.

    referans_ay/tarih/açıklama HEP buradan üretilir → iki yazıcının konvansiyon
    kayması (çift plan üretimi) yapısal olarak kapanır.
    Dönüş: {"id": plan_id, "yeni": bool} veya None (net<=0 ya da plan zaten var/insert edilmedi).
    """
    if net <= 0:
        return None

    odeme_tarihi = maas_odeme_tarihi(yil, ay)
    aciklama = plan_aciklama(p, yil, ay)

    if guncelle:
        cur.execute(
            """
            UPDATE odeme_plani
            SET tarih=%s, referans_ay=DATE_TRUNC('month', %s::date),
                odenecek_tutar=%s, asgari_tutar=%s, aciklama=%s
            WHERE kaynak_tablo='personel' AND kaynak_id=%s
              AND durum IN ('bekliyor','onay_bekliyor')
              AND referans_ay = DATE_TRUNC('month', %s::date)
            RETURNING id
            """,
            (odeme_tarihi, str(odeme_tarihi), net, net, aciklama, p["id"], str(odeme_tarihi)),
        )
        row = cur.fetchone()
        if row:
            return {"id": row["id"], "yeni": False}

    pid = str(uuid.uuid4())
    cur.execute(
        """
        INSERT INTO odeme_plani
            (id, kart_id, tarih, referans_ay, odenecek_tutar, asgari_tutar,
             aciklama, durum, kaynak_tablo, kaynak_id)
        SELECT %s, NULL, %s, DATE_TRUNC('month', %s::date), %s, %s,
               %s, 'bekliyor', 'personel', %s
        WHERE NOT EXISTS (
            SELECT 1 FROM odeme_plani
            WHERE kaynak_tablo='personel' AND kaynak_id=%s
              AND durum != 'iptal'
              AND referans_ay = DATE_TRUNC('month', %s::date)
        )
        RETURNING id
        """,
        (
            pid,
            odeme_tarihi,
            str(odeme_tarihi),
            net,
            net,
            aciklama,
            p["id"],
            p["id"],
            str(odeme_tarihi),
        ),
    )
    row = cur.fetchone()
    if row:
        return {"id": row["id"], "yeni": True}
    return None


# ── SENKRON (kayıt + plan birlikte) ────────────────────────────

def aylik_vardiya_senkronize(cur, p: dict, yil: int, ay: int) -> dict:
    """Personelin (yil, ay) dönemini vardiyadan hesaplayıp personel_aylik kaydını ve
    ödeme planını eşitler. Onaylı kayıt EZİLMEZ (sadece planı tazeler)."""
    cur.execute(
        "SELECT * FROM personel_aylik WHERE personel_id=%s AND yil=%s AND ay=%s",
        (p["id"], yil, ay),
    )
    mevcut = cur.fetchone()
    if mevcut and mevcut.get("durum") == "onaylandi":
        net = float(mevcut.get("hesaplanan_net") or 0)
        odeme_plani_esitle(cur, p, yil, ay, net)
        return {"atlandi": True, "neden": "onaylandi", "hesaplanan_net": net}
    # Dönemle hiç kesişmeyen personele (dönemden önce ayrıldı / sonra başlayacak) kayıt açma
    if personel_donem_orani(p, yil, ay) is None:
        return {"atlandi": True, "neden": "donem_disi", "hesaplanan_net": 0}

    # KANONİK HESAP = Vardiya Takip kurgusu (kullanıcı kararı 2026-07-04); manuel alanlar korunur
    vt = vardiya_takip_hesap(p["id"], yil, ay)
    mev = dict(mevcut or {})
    if vt is not None:
        kayit = {
            "calisma_saati": float(vt.get("toplam_planlanan_saat") or 0),
            "fazla_mesai_saat": float(vt.get("toplam_fazla_mesai_saat") or 0),
            "bayram_mesai_saat": float(mev.get("bayram_mesai_saat") or 0),
            "eksik_gun": float(mev.get("eksik_gun") or 0),
            "raporlu_gun": float(mev.get("raporlu_gun") or 0),
            "rapor_kesinti": bool(mev.get("rapor_kesinti") or False),
            "manuel_duzeltme": float(mev.get("manuel_duzeltme") or 0),
            "not_aciklama": mev.get("not_aciklama"),
        }
        net = kanonik_net(dict(p), vt, kayit)
        vk = {"kaynak": "vardiya_takip",
              "toplam_planlanan_saat": kayit["calisma_saati"],
              "fazla_mesai_saat": kayit["fazla_mesai_saat"]}
    else:
        # savunma: takip hesabı alınamazsa eski yerel formüle düş (sistem durmaz)
        kayit = vardiya_kayit_dict(cur, p, yil, ay, mevcut)
        vk = kayit.pop("_vardiya", {})
        net = maas_hesapla(dict(p), kayit, yil, ay)
    kid = str(uuid.uuid4())
    cur.execute(
        """
        INSERT INTO personel_aylik
            (id, personel_id, yil, ay, calisma_saati, fazla_mesai_saat, bayram_mesai_saat,
             eksik_gun, raporlu_gun, rapor_kesinti, manuel_duzeltme,
             not_aciklama, hesaplanan_net, durum)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'taslak')
        ON CONFLICT (personel_id, yil, ay) DO UPDATE SET
            calisma_saati=%s, fazla_mesai_saat=%s, bayram_mesai_saat=%s,
            eksik_gun=%s, raporlu_gun=%s, rapor_kesinti=%s, manuel_duzeltme=%s,
            not_aciklama=%s, hesaplanan_net=%s, durum='taslak'
        """,
        (
            kid,
            p["id"],
            yil,
            ay,
            kayit["calisma_saati"],
            kayit["fazla_mesai_saat"],
            kayit["bayram_mesai_saat"],
            kayit["eksik_gun"],
            kayit["raporlu_gun"],
            kayit["rapor_kesinti"],
            kayit["manuel_duzeltme"],
            kayit["not_aciklama"],
            net,
            kayit["calisma_saati"],
            kayit["fazla_mesai_saat"],
            kayit["bayram_mesai_saat"],
            kayit["eksik_gun"],
            kayit["raporlu_gun"],
            kayit["rapor_kesinti"],
            kayit["manuel_duzeltme"],
            kayit["not_aciklama"],
            net,
        ),
    )
    plan = odeme_plani_esitle(cur, p, yil, ay, net)
    return {"atlandi": False, "hesaplanan_net": net, "vardiya": vk,
            "plan_id": (plan or {}).get("id")}
