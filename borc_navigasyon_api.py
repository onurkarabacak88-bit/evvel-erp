"""
BORÇ NAVİGASYON MOTORU — İZOLE + SALT-OKUR karar destek motoru.

AMAÇ (kullanıcı + GPT tasarımı 2026-06-24): "borcu ölçen" değil "borcu YÖNETEN"
sistem. Çekirdek = ABEK (Aylık Borç Emme Kapasitesi) = işletmenin o ay ürettiği,
borca ayırabileceği gerçek serbest nakit. Motorun tüm kararları bunun etrafında.

ÇIKTI = 30 saniyelik patron ekranı (5 KPI) + arka plan metrikleri:
  1. Borç Baskı Endeksi (0-100)   2. Tahmini Açık/Fazla   3. Runway (kaç ay)
  4. Gelecek ay Zorunlu Yük        5. Hedef Ciro (borç büyümesin)

İZOLASYON (mutlak — çalışan hiçbir akış bozulmaz, veri zarar görmez):
  - Kendi tablosu YOK; HİÇBİR ŞEY yazmaz. Tamamen salt-okur/hesap.
  - Mevcut motorlardan OKUR (lazy import, döngüsel import yok):
      main.kart_gelecek_ay_yuk → zorunlu yük + serbest nakit + kart asgari + kredi
      main.kartlar_listele       → kart toplam borç
      operasyon_merkez_api.ops_maliyet_gun_gun → operasyonel net kâr (ABEK tabanı)
      borc_envanteri (db)        → kredi kalan anapara
  - Tüm uçlar hata-yutar; ana akışı ASLA bozmaz. main.py'ye try/except ile takılır.

KRİTİK GERÇEK (2026-06-24): 4 şubeden 2'si KAPALI (Köyceğiz, Alsancak). Aktif
gelir SADECE Zafer + Gazze/Tema. Kapalı şubelerin KREDİLERİ duruyor (saf yük).
ABEK operasyonel veriden gelir; kapalı şubelerin son-dönem cirosu ~0 olduğu için
son 30/90 gün run-rate'i doğal olarak aktif şubeleri yansıtır (geçmiş blended
ciro tekrar etmez varsayımı).

ÇİFT SAYIM / FELSEFE: Operasyonel P&L finansman/faizi DIŞLAR; bu motor bir BORÇ
KAPATMA motoru olduğu için finansmanı/faizi BİLEREK karşı tarafa (zorunlu yük)
koyar ve ABEK (operasyonel nakit) ile karşılaştırır. ABEK borç ÖNCESİ nakittir.
"""
from __future__ import annotations

import logging
from datetime import date
from typing import Any, Dict, List, Optional

from fastapi import APIRouter

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/borc-nav", tags=["borc-navigasyon"])


def _f(x) -> float:
    try:
        return float(x or 0)
    except Exception:
        return 0.0


def _skor_0_100(oran: float, tam_skor_orani: float) -> float:
    """oran=0 → 0 puan (iyi), oran>=tam_skor_orani → 100 puan (kötü). Doğrusal."""
    if tam_skor_orani <= 0:
        return 0.0
    return max(0.0, min(100.0, (oran / tam_skor_orani) * 100.0))


def _op_donem(gun: int) -> Dict[str, float]:
    """gun-gun operasyonel P&L'i çağırıp dönem toplamlarını çıkarır (aktif şubeler
    doğal olarak baskın; kapalı şubelerin son dönem cirosu ~0). HATA-YUTAR."""
    try:
        from operasyon_merkez_api import ops_maliyet_gun_gun
        # NOT: Query default'larını ezmek için TÜM parametreler explicit verilir.
        g = ops_maliyet_gun_gun(gun=gun, sube_id=None, bas=None, bit=None)
        rows = g.get("satirlar") or []
        ciro = sum(_f(r.get("ciro_tl")) for r in rows)
        net_kar = sum(_f(r.get("net_kar_tl")) for r in rows)
        faaliyet = sum(_f(r.get("faaliyet_kari_tl")) for r in rows)
        cogs = sum(_f(r.get("toplam")) for r in rows)
        return {"gun": gun, "ciro": ciro, "net_kar": net_kar,
                "faaliyet_kari": faaliyet, "cogs": cogs}
    except Exception as e:
        logger.warning("borc_nav _op_donem(%s) hata: %s", gun, e)
        return {"gun": gun, "ciro": 0.0, "net_kar": 0.0, "faaliyet_kari": 0.0, "cogs": 0.0}


@router.get("/ozet")
def borc_nav_ozet():
    """Borç Navigasyon Motoru tam özet — 5 KPI + ABEK + senaryolar + endeks.
    Tamamen salt-okur; hata olursa kısmi/0 döner, ana akış etkilenmez."""
    bugun = date.today()
    notlar: List[str] = []

    # ── 1) Zorunlu yük + serbest nakit + kart asgari/kredi (mevcut motordan) ──
    zorunlu = serbest = kart_asgari = kredi_taksit = ort_odeme = 0.0
    try:
        from main import kart_gelecek_ay_yuk
        yuk = kart_gelecek_ay_yuk() or {}
        zorunlu = _f(yuk.get("zorunlu_yuk"))
        serbest = _f(yuk.get("serbest_nakit"))
        kart_asgari = _f(yuk.get("kart_tahmini_asgari"))
        kredi_taksit = _f(yuk.get("kredi_taksiti"))
        ort_odeme = _f(yuk.get("ortalama_aylik_odeme"))
    except Exception as e:
        logger.warning("borc_nav zorunlu yük hata: %s", e)
        notlar.append("Zorunlu yük okunamadı (kart motoru).")

    # ── 2) Toplam borç (kart toplam + kredi kalan anapara) ──
    kart_toplam = 0.0
    try:
        from main import kartlar_listele
        kl = kartlar_listele()
        kartlar = kl if isinstance(kl, list) else (kl.get("kartlar") or [])
        for k in kartlar:
            v = k.get("toplam_borc_taksitli")
            if v is None:
                v = _f(k.get("anlik_borc")) + _f(k.get("gelecek_taksit_anapara"))
            kart_toplam += _f(v)
    except Exception as e:
        logger.warning("borc_nav kart toplam hata: %s", e)

    kredi_kalan = 0.0
    try:
        with db() as (conn, cur):
            cur.execute(
                """SELECT COALESCE(SUM(aylik_taksit * COALESCE(kalan_vade, 0)), 0)::float AS t
                   FROM borc_envanteri
                   WHERE aktif = TRUE AND (kalan_vade IS NULL OR kalan_vade > 0)"""
            )
            kredi_kalan = _f((cur.fetchone() or {}).get("t"))
    except Exception as e:
        logger.warning("borc_nav kredi kalan hata: %s", e)
    toplam_borc = kart_toplam + kredi_kalan

    # ── 3) ABEK — operasyonel aylık serbest nakit (aktif şube run-rate) ──
    # Ağırlıklı tahmin: %70 son ay (son 30 gün) + %30 son 3 ay (son 90 gün/3).
    son_ay = _op_donem(30)
    son3 = _op_donem(90)
    abek_son_ay = son_ay["net_kar"]                       # son 30 gün net kâr ≈ aylık
    abek_son3_ort = son3["net_kar"] / 90.0 * 30.0         # son 90 gün → aylık ort
    abek = 0.7 * abek_son_ay + 0.3 * abek_son3_ort
    ciro_ay = 0.7 * son_ay["ciro"] + 0.3 * (son3["ciro"] / 90.0 * 30.0)
    marj = (abek / ciro_ay) if ciro_ay > 0 else 0.0       # NAKİT marj (ABEK/ciro)

    if ciro_ay <= 0:
        notlar.append("Operasyonel ciro 0 görünüyor — ABEK güvenilmez.")
    if abek <= 0:
        notlar.append("ABEK negatif/sıfır: işletme borç ÖNCESİ bile nakit üretmiyor — "
                      "önce maliyet/gelir yapısı düzelmeli, ciro artışı tek başına yetmez.")

    # ── 4) Açıklar ──
    aylik_acik = zorunlu - abek                 # her ay biriken yapısal açık
    bugun_acik = zorunlu - serbest              # bugünkü nakitle 30 günü karşılama
    aysonu_acik = zorunlu - (serbest + abek)    # ay sonunda beklenen açık

    # ── 5) Runway (kaç ay dayanır) ──
    if aylik_acik <= 0:
        runway_ay: Optional[float] = None       # ABEK borcu karşılıyor → sınırsız
        runway_renk = "yesil"
        runway_durum = "Sürdürülebilir (ABEK zorunlu yükü karşılıyor)"
    else:
        runway_ay = serbest / aylik_acik if aylik_acik > 0 else 0.0
        if runway_ay > 12:
            runway_renk, runway_durum = "yesil", "Güvenli"
        elif runway_ay > 6:
            runway_renk, runway_durum = "sari", "İzle"
        elif runway_ay > 3:
            runway_renk, runway_durum = "turuncu", "Riskli"
        else:
            runway_renk, runway_durum = "kirmizi", "Kritik — kısa vadede nakit sıkışıklığı"

    # ── 6) Hedef ciro — 3 senaryo (NAKİT marj pozitifse) ──
    hedef = {"marj_pozitif": marj > 0, "borc_sabit": None, "yil_25_azal": None, "ay24_bitir": None}
    if marj > 0:
        hedef["borc_sabit"] = round(zorunlu / marj, 2)
        ekstra_b = toplam_borc * 0.25 / 12.0
        hedef["yil_25_azal"] = round((zorunlu + ekstra_b) / marj, 2)
        ekstra_c = toplam_borc / 24.0
        hedef["ay24_bitir"] = round((zorunlu + ekstra_c) / marj, 2)
    else:
        notlar.append("Hedef ciro hesaplanamadı: nakit marj ≤ 0 → ciro arttıkça zarar artar.")

    # ── 7) Borç Baskı Endeksi (0-100) ──
    yillik_abek = abek * 12.0
    if abek <= 0:
        s1 = 100.0  # borç asla kapanmaz
    else:
        s1 = _skor_0_100(toplam_borc / yillik_abek, 5.0)         # toplam borç / yıllık ABEK (5x = 100)
    if abek <= 0:
        s2 = 100.0
    else:
        s2 = _skor_0_100(zorunlu / abek, 2.0)                    # zorunlu / ABEK (2x = 100)
    s3 = _skor_0_100((kart_toplam / ciro_ay) if ciro_ay > 0 else 5.0, 3.0)  # kart borcu / aylık ciro
    s4 = max(0.0, 100.0 * (1.0 - (serbest / zorunlu))) if zorunlu > 0 else 0.0  # nakit tamponu (az→kötü)
    # S5 trend: son ay ABEK, 3-ay ortalamasından kötüyse ceza
    if abek_son3_ort != 0:
        trend = (abek_son_ay - abek_son3_ort) / abs(abek_son3_ort)
    else:
        trend = 0.0
    s5 = max(0.0, min(100.0, 50.0 - trend * 100.0))              # iyileşiyorsa <50, kötüleşiyorsa >50
    bbe = 0.35 * s1 + 0.30 * s2 + 0.15 * s3 + 0.10 * s4 + 0.10 * s5
    bbe = round(max(0.0, min(100.0, bbe)), 1)
    if bbe < 20:
        bbe_durum, bbe_renk = "Güvenli", "yesil"
    elif bbe < 40:
        bbe_durum, bbe_renk = "Dikkat", "sari"
    elif bbe < 60:
        bbe_durum, bbe_renk = "Riskli", "turuncu"
    elif bbe < 80:
        bbe_durum, bbe_renk = "Kritik", "kirmizi"
    else:
        bbe_durum, bbe_renk = "Acil Müdahale", "kirmizi"

    # ── 8) Sürdürülemezlik kriteri (ABEK < zorunlu yük) ──
    surdurulemez = abek < zorunlu
    if surdurulemez:
        notlar.append("SÜRDÜRÜLEMEZ: ABEK < Zorunlu Yük → borç çevriliyor ama "
                      "kapanmıyor (finansal sarmal). Yapısal müdahale gerekir.")

    return {
        "guncel_ay": f"{bugun.year}-{bugun.month:02d}",
        "uretildi": bugun.isoformat(),
        # ── 5 KPI (30 saniyelik patron ekranı; sıra önemli) ──
        "kpi": {
            "borc_baski_endeksi": {"skor": bbe, "durum": bbe_durum, "renk": bbe_renk},
            "tahmini_acik": {
                "bugun": round(bugun_acik, 2),
                "ay_sonu": round(aysonu_acik, 2),
                "aylik_yapisal": round(aylik_acik, 2),
            },
            "runway_ay": (round(runway_ay, 1) if runway_ay is not None else None),
            "runway_renk": runway_renk,
            "runway_durum": runway_durum,
            "zorunlu_yuk": round(zorunlu, 2),
            "hedef_ciro_borc_sabit": hedef["borc_sabit"],
        },
        # ── ABEK ve marj ──
        "abek": {
            "deger": round(abek, 2),
            "son_ay": round(abek_son_ay, 2),
            "son3_ort": round(abek_son3_ort, 2),
            "ciro_ay": round(ciro_ay, 2),
            "nakit_marj_pct": round(marj * 100, 1),
        },
        # ── Borç tablosu ──
        "borc": {
            "toplam": round(toplam_borc, 2),
            "kart_toplam": round(kart_toplam, 2),
            "kredi_kalan": round(kredi_kalan, 2),
            "zorunlu_yuk": round(zorunlu, 2),
            "kart_asgari": round(kart_asgari, 2),
            "kredi_taksiti": round(kredi_taksit, 2),
        },
        # ── Nakit ──
        "nakit": {
            "serbest": round(serbest, 2),
            "ortalama_aylik_odeme": round(ort_odeme, 2),
        },
        # ── Hedef ciro senaryoları ──
        "hedef_ciro": hedef,
        # ── BBE bileşenleri (şeffaflık) ──
        "bbe_bilesenler": [
            {"ad": "Toplam borç / yıllık ABEK", "skor": round(s1, 1), "agirlik": 0.35},
            {"ad": "Zorunlu yük / ABEK", "skor": round(s2, 1), "agirlik": 0.30},
            {"ad": "Kart borcu / aylık ciro", "skor": round(s3, 1), "agirlik": 0.15},
            {"ad": "Nakit tamponu (düşük→kötü)", "skor": round(s4, 1), "agirlik": 0.10},
            {"ad": "Son 90 gün trend", "skor": round(s5, 1), "agirlik": 0.10},
        ],
        "surdurulemez": surdurulemez,
        "notlar": notlar,
    }
