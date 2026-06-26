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
        # ABEK = net kâr (NAKİT). Tercih: net_kar_net_tl = ŞUBE-BAZLI vergi (şahıs/şirket
        # karması, ~%28.5) + KDV ayrıştırılmış (KDV işletmenin parası değil, pass-through).
        # Yoksa düz %25'li net_kar_tl'ye düşer (geriye uyumlu).
        net_kar = sum(
            _f(r.get("net_kar_net_tl") if r.get("net_kar_net_tl") is not None else r.get("net_kar_tl"))
            for r in rows
        )
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
            # FİNANSAL BORÇ = kalan ANAPARA (toplam_borc). Belgesiz/0 kredide
            # taksit×kalan_vade fallback. (Eski hata: hep taksit×vade → gelecek faizi
            # de borç sayıp ~3.6M şişiriyordu; gerçek kalan anapara ~6.75M.)
            cur.execute(
                """SELECT COALESCE(SUM(
                       COALESCE(NULLIF(toplam_borc,0), aylik_taksit * COALESCE(kalan_vade,0))
                   ), 0)::float AS t
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


def _maliyet_yapisi() -> Dict[str, float]:
    """Son 30 gün operasyonel maliyet yapısı (ölçek planı için oran/sabit ayrımı).
    HATA-YUTAR."""
    try:
        from operasyon_merkez_api import ops_maliyet_gun_gun
        g = ops_maliyet_gun_gun(gun=30, sube_id=None, bas=None, bit=None)
        rows = g.get("satirlar") or []
    except Exception:
        rows = []
    def S(k):
        return sum(_f(r.get(k)) for r in rows)
    ciro = S("ciro_tl") or 1.0
    return {
        "ciro": ciro,
        "cogs_oran": S("toplam") / ciro,                                   # tam değişken
        "kom_oran": (S("pos_komisyon_tl") + S("platform_komisyon_tl")) / ciro,  # tam değişken
        "kira": S("kira_maliyet_tl"),                                      # basamaklı sabit
        "fatura": S("fatura_maliyet_tl") + S("abonelik_maliyet_tl"),       # basamaklı sabit
        "personel": S("personel_maliyet_tl") + S("sgk_isveren_tl"),        # alt-doğrusal
        "vergi_oran": 0.285,                                               # şube-bazlı blended efektif
        "sube_sayisi": 2,                                                  # aktif şube (Zafer+Gazze)
    }


@router.get("/olcek-plani")
def olcek_plani(alpha: float = 0.78, kapasite_carpan: float = 1.4,
                yeni_sube_kapasite: float = 500000.0, yeni_sube_kira: float = 65000.0,
                yeni_sube_personel: float = 130000.0, yeni_sube_sabit: float = 40000.0,
                personel_sayisi: int = 6):
    """ÖLÇEK PLANLAMA + KAPASİTE GERÇEKLİK MOTORU (iki GPT + filtre sentezi).
    "Hedef ciro" tek sayı değil: her borç hedefi için GEREKLİ ölçek (ciro+şube+
    personel+ABEK). Maliyet ölçek-davranışına göre: COGS/komisyon tam değişken,
    kira/sabit BASAMAKLI (şube sayısına bağlı), personel ALT-DOĞRUSAL (×(C/C0)^α),
    vergi sonuç-bağımlı, KDV pass-through (ABEK'te dışlı). İteratif çözüm.
    KAPASİTE GERÇEKLİK: mevcut şubeler MAX kapasitede ABEK < zorunlu yük ise →
    'operasyonel büyüme tek başına yetmez, yapılandırma şart'. Salt-okur."""
    import math
    alpha = max(0.5, min(1.0, float(alpha)))
    ms = _maliyet_yapisi()
    C0 = ms["ciro"]
    kisi_maliyet = (ms["personel"] / personel_sayisi) if personel_sayisi > 0 else 35000.0

    # Borç eşikleri
    zorunlu = toplam_borc = 0.0
    try:
        oz = borc_nav_ozet()
        zorunlu = _f(oz.get("borc", {}).get("zorunlu_yuk"))
        toplam_borc = _f(oz.get("borc", {}).get("toplam"))
    except Exception:
        pass

    def abek_at(C):
        existing_cap = C0 * kapasite_carpan
        # INTENSİF (mevcut şubeler, kapasiteye kadar) vs EXTENSİF (yeni şube gereken kısım).
        # Personel: intensif kısımda ALT-DOĞRUSAL (α, verimlilik); yeni şubeler kendi
        # personelini LİNEER getirir (çift sayım yok — α sadece intensif ciroya uygulanır).
        intensive = min(C, existing_cap)
        extensive = max(0.0, C - existing_cap)
        extra = int(math.ceil(extensive / yeni_sube_kapasite)) if (extensive > 0 and yeni_sube_kapasite > 0) else 0
        kira = ms["kira"] + extra * yeni_sube_kira
        fatura = ms["fatura"] + extra * yeni_sube_sabit
        personel = ms["personel"] * ((intensive / C0) ** alpha if C0 > 0 else 1) + extra * yeni_sube_personel
        cogs = ms["cogs_oran"] * C
        kom = ms["kom_oran"] * C
        net_satis = C / 1.10                       # KDV hariç
        favok = net_satis - cogs - kom - kira - fatura - personel
        vergi = max(0.0, favok) * ms["vergi_oran"]
        abek = favok - vergi
        return abek, ms["sube_sayisi"] + extra, personel

    def cozum(required):
        if required <= 0:
            return None
        C = C0
        for _ in range(4000):                       # 25K adım, ~100M tavana kadar
            abek, subeler, personel = abek_at(C)
            if abek >= required:
                return {
                    "hedef_ciro": round(C, 2),
                    "carpan_mevcut": round(C / C0, 2) if C0 > 0 else None,
                    "sube_sayisi": subeler,
                    "yeni_sube": subeler - ms["sube_sayisi"],
                    "personel_maliyet": round(personel, 2),
                    "personel_sayisi": int(round(personel / kisi_maliyet)) if kisi_maliyet > 0 else None,
                    "uretilen_abek": round(abek, 2),
                    "ciro_sube_basi": round(C / subeler, 2) if subeler else None,
                }
            C += 25000
        return None                                  # 100M'de bile ulaşılamaz

    senaryolar = {
        "borc_sabit": cozum(zorunlu),
        "yil_25_azal": cozum(zorunlu + toplam_borc * 0.25 / 12.0),
        "ay24_bitir": cozum(zorunlu + toplam_borc / 24.0),
    }

    # ── KAPASİTE GERÇEKLİK ──
    existing_cap = C0 * kapasite_carpan
    abek_max_mevcut, _, _ = abek_at(existing_cap)     # 2 şube TAM kapasite
    yapilandirma_sart = abek_max_mevcut < zorunlu
    return {
        "uretildi": date.today().isoformat(),
        "parametreler": {
            "alpha_personel": alpha, "kapasite_carpan": kapasite_carpan,
            "mevcut_ciro": round(C0, 2), "mevcut_sube": ms["sube_sayisi"],
            "kisi_basi_maliyet": round(kisi_maliyet, 2), "personel_sayisi_mevcut": personel_sayisi,
            "yeni_sube_kapasite": yeni_sube_kapasite, "yeni_sube_kira": yeni_sube_kira,
            "yeni_sube_personel": yeni_sube_personel, "vergi_oran": ms["vergi_oran"],
        },
        "zorunlu_yuk": round(zorunlu, 2),
        "toplam_borc": round(toplam_borc, 2),
        "senaryolar": senaryolar,
        "kapasite_gerceklik": {
            "mevcut_sube_max_ciro": round(existing_cap, 2),
            "mevcut_sube_max_abek": round(abek_max_mevcut, 2),
            "zorunlu_yuk": round(zorunlu, 2),
            "yapilandirma_sart": yapilandirma_sart,
            "mesaj": (
                "2 aktif şube TAM kapasitede bile üretilen ABEK zorunlu borç yükünü "
                "KARŞILAMIYOR → operasyonel büyüme tek başına yetmez. Borç yapılandırma "
                "(vade uzatma / faiz indirimi / refinansman / sermaye girişi) ŞART."
                if yapilandirma_sart else
                "Mevcut şubeler tam kapasiteye çıkarsa zorunlu yük karşılanabilir."
            ),
        },
        "not": "Yeni şube açma SERMAYE gerektirir; bu işletme 2 şube kapatmış ve nakit "
               "tamponu düşük → 'yeni şube' senaryoları TEORİK, kısa vadede finanse edilemez.",
    }


@router.get("/takvim")
def borc_takvim(ay: int = 36):
    """BORÇ TAKVİMİ — GPT mimarisi: tek 'toplam borç' yerine ay-ay zaman serisi.
    Her kredinin amortismanı RAM'de türetilir (PDF saklanmaz): faiz=bakiye×r,
    anapara=taksit−faiz, bakiye−=anapara. Krediler bitince taksit düşer; ödemesiz
    kredi (Alsancak-2, Eki'26) o ay devreye girer. Tüm üst göstergeler bundan türer.
    Çıktı: her ay {kredi taksiti, kart min, zorunlu yük, ABEK, açık, kalan anapara}
    + Peak Debt Service (en zor ay) + Finansal Borç vs Toplam Gelecek Ödeme.
    Salt-okur, hata-yutar. NOT: kart tarafı yaklaşık (asgari sabit); kredi tarafı kesin."""
    ay = max(1, min(60, int(ay or 36)))
    bugun = date.today()

    def add_months(y, m, k):
        idx = (y * 12 + (m - 1)) + k
        return idx // 12, idx % 12 + 1

    # ── Krediler ──
    loans: List[Dict[str, Any]] = []
    try:
        with db() as (conn, cur):
            cur.execute(
                """SELECT kurum, COALESCE(toplam_borc,0)::float AS anapara,
                          COALESCE(aylik_taksit,0)::float AS taksit,
                          COALESCE(kalan_vade,0)::int AS kvade,
                          faiz_orani, COALESCE(odemesiz_ay,0)::int AS odemesiz,
                          ilk_taksit_tarihi::text AS ilk_taksit
                   FROM borc_envanteri
                   WHERE aktif = TRUE AND (kalan_vade IS NULL OR kalan_vade > 0)"""
            )
            loans = [dict(r) for r in (cur.fetchall() or [])]
    except Exception as e:
        logger.warning("takvim kredi okuma hata: %s", e)

    # ── Kart + ABEK ──
    kart_asgari = kart_borc = abek = 0.0
    try:
        from main import kart_gelecek_ay_yuk, kartlar_listele
        yuk = kart_gelecek_ay_yuk() or {}
        kart_asgari = _f(yuk.get("kart_tahmini_asgari"))
        kl = kartlar_listele()
        for k in (kl if isinstance(kl, list) else kl.get("kartlar", [])):
            kart_borc += _f(k.get("anlik_borc") if k.get("anlik_borc") is not None else k.get("guncel_borc"))
    except Exception as e:
        logger.warning("takvim kart hata: %s", e)
    try:
        abek = _f(borc_nav_ozet().get("abek", {}).get("deger"))
    except Exception:
        abek = 0.0

    # Kredi başına amortisman durumu
    st = []
    for L in loans:
        st.append({
            "name": L["kurum"], "r": _f(L["faiz_orani"]) / 100.0, "bal": _f(L["anapara"]),
            "taksit": _f(L["taksit"]), "kvade": int(L["kvade"] or 0), "paid": 0,
            "it": (str(L["ilk_taksit"])[:7] if L.get("ilk_taksit") else None),
        })

    grid: List[Dict[str, Any]] = []
    biten: List[Dict[str, str]] = []
    for k in range(1, ay + 1):  # k=1 → gelecek ay
        cy, cm = add_months(bugun.year, bugun.month, k)
        ym = f"{cy:04d}-{cm:02d}"
        kredi_t = 0.0
        bal_sum = 0.0
        for s in st:
            grace = bool(s["it"] and s["it"] > ym)
            paying = (not grace) and (s["paid"] < s["kvade"]) and (s["bal"] > 0.5)
            if paying:
                faiz = s["bal"] * s["r"]
                anapara = s["taksit"] - faiz
                if anapara > s["bal"]:
                    anapara = s["bal"]
                pay = min(s["taksit"], s["bal"] + faiz)
                s["bal"] -= anapara
                s["paid"] += 1
                kredi_t += pay
                if s["paid"] == s["kvade"] or s["bal"] <= 0.5:
                    if not any(b["kredi"] == s["name"] for b in biten):
                        biten.append({"kredi": s["name"], "ay": ym})
            bal_sum += max(0.0, s["bal"])
        zorunlu = kredi_t + kart_asgari
        grid.append({
            "ay": ym,
            "kredi_taksit": round(kredi_t, 2),
            "kart_min": round(kart_asgari, 2),
            "zorunlu_yuk": round(zorunlu, 2),
            "abek": round(abek, 2),
            "acik": round(zorunlu - abek, 2),
            "kredi_kalan_anapara": round(bal_sum, 2),
        })

    peak = max(grid, key=lambda x: x["zorunlu_yuk"]) if grid else None
    finansal_borc = sum(_f(L["anapara"]) or (_f(L["taksit"]) * int(L["kvade"] or 0)) for L in loans) + kart_borc
    toplam_gelecek = sum(_f(L["taksit"]) * int(L["kvade"] or 0) for L in loans) + kart_borc
    return {
        "uretildi": bugun.isoformat(),
        "abek_aylik": round(abek, 2),
        "finansal_borc": round(finansal_borc, 2),       # bugün gerçekte ne borçluyum (kalan anapara + kart)
        "toplam_gelecek_odeme": round(toplam_gelecek, 2),  # hiçbir şey değişmezse toplam çıkacak (faiz dahil)
        "peak": peak,                                   # en zor ay (max zorunlu yük)
        "kredi_biten_takvim": biten,                    # her kredi hangi ay bitiyor
        "takvim": grid,
        "not": "Kredi tarafı kesin (amortisman). Kart tarafı yaklaşık (asgari sabit). "
               "Ödemesiz kredi ilk taksit tarihinde devreye girer; zorunlu yük o ay artar.",
    }


@router.get("/projeksiyon")
def borc_projeksiyon(ay: int = 12):
    """GELECEK PROJEKSİYONU — toplam borç ay-ay nasıl gidiyor (sarmal mı?).
    Makro model (agregat, şeffaf): toplam_borç[n+1] = toplam_borç[n] × (1+efektif
    aylık faiz) − ABEK. Mantık: işletmenin GERÇEK nakit girişi ABEK kadardır;
    krediler ödenip kartlardan borçlanıldığı için NET değişim = faiz − ABEK.
    ABEK < aylık faiz ise borç her ay büyür = finansal sarmal.
    Karşılaştırma: 'borç sabit' için gereken aylık ödeme (= faiz) de döner.
    Salt-okur, hata-yutar."""
    ay = max(1, min(36, int(ay or 12)))
    try:
        oz = borc_nav_ozet()
    except Exception as e:
        logger.warning("projeksiyon ozet hata: %s", e)
        return {"hata": "özet okunamadı", "seri": []}

    toplam = _f(oz.get("borc", {}).get("toplam"))
    kart = _f(oz.get("borc", {}).get("kart_toplam"))
    kredi = _f(oz.get("borc", {}).get("kredi_kalan"))
    abek = _f(oz.get("abek", {}).get("deger"))

    # Efektif aylık faiz: kart ~%3.5/ay (≈%51 yıllık), kredi ~%2.8/ay varsayım (amortizan).
    KART_AY_FAIZ = 0.035
    KREDI_AY_FAIZ = 0.028
    ef = ((kart * KART_AY_FAIZ + kredi * KREDI_AY_FAIZ) / toplam) if toplam > 0 else 0.0
    aylik_faiz_tl = toplam * ef

    seri: List[Dict[str, Any]] = []
    B = toplam
    for m in range(1, ay + 1):
        faiz = B * ef
        B2 = B + faiz - abek
        if B2 < 0:
            B2 = 0.0
        seri.append({
            "ay": m,
            "toplam_borc": round(B2, 2),
            "faiz": round(faiz, 2),
            "abek_odeme": round(abek, 2),
            "net_degisim": round(B2 - B, 2),
        })
        B = B2

    son = seri[-1]["toplam_borc"] if seri else toplam
    artis_pct = round((son / toplam - 1) * 100, 1) if toplam > 0 else 0.0
    borc_sabit_odeme = round(aylik_faiz_tl, 2)     # borç büyümesin diye GEREKEN aylık ödeme
    spiral = abek < aylik_faiz_tl                  # ABEK faizi bile karşılamıyorsa sarmal
    # Borcun ikiye katlanma süresi (sarmaldaysa)
    ikiye_katlanma_ay = None
    if spiral and (aylik_faiz_tl - abek) > 0:
        kk = toplam
        for m in range(1, 600):
            kk = kk * (1 + ef) - abek
            if kk >= 2 * toplam:
                ikiye_katlanma_ay = m
                break

    return {
        "uretildi": date.today().isoformat(),
        "varsayim": {
            "efektif_aylik_faiz_pct": round(ef * 100, 2),
            "kart_aylik_faiz_pct": KART_AY_FAIZ * 100,
            "kredi_aylik_faiz_pct": KREDI_AY_FAIZ * 100,
            "abek_aylik": round(abek, 2),
            "baslangic_borc": round(toplam, 2),
        },
        "seri": seri,
        "ay_sonu_borc": round(son, 2),
        "artis_pct": artis_pct,
        "aylik_faiz_tl": round(aylik_faiz_tl, 2),
        "borc_sabit_icin_gereken_aylik_odeme": borc_sabit_odeme,
        "abek_aciligi_faize_karsi": round(aylik_faiz_tl - abek, 2),  # +: faizi bile karşılamıyor
        "spiral": spiral,
        "ikiye_katlanma_ay": ikiye_katlanma_ay,
        "not": "Makro model: borç × (1+efektif faiz) − ABEK. Krediler kolektif; "
               "ABEK = işletmenin gerçek aylık nakit üretimi. ABEK < aylık faiz → sarmal.",
    }


@router.get("/sube-katki")
def sube_katki(gun: int = 30):
    """ŞUBE KATKI MOTORU — her şubenin ORTAK HAVUZA operasyonel nakit katkısı.
    Borç KOLEKTİF (hepsi büyümek için çekilmiş, ortak havuzdan ödeniyor) → krediler
    şubeye paylaştırılmaz. Şube katkısı = operasyonel net (ciro − COGS − personel −
    KİRA − ... ; finansman HARİÇ). Aktif şube havuzu BESLER (+), kapalı şube kira
    yüküyle havuzu BOŞALTIR (−). Kapalı dönemler DAHİL (kullanıcı kuralı 2026-06-24).
    Salt-okur, hata-yutar."""
    from datetime import date as _date, timedelta as _td
    bugun = _date.today()
    son7 = (bugun - _td(days=7)).isoformat()
    subeler: List[Dict[str, Any]] = []
    try:
        with db() as (conn, cur):
            cur.execute("SELECT id::text AS id, ad FROM subeler WHERE aktif = TRUE ORDER BY ad")
            subeler = [dict(r) for r in (cur.fetchall() or [])]
    except Exception as e:
        logger.warning("sube_katki şube listesi hata: %s", e)

    out: List[Dict[str, Any]] = []
    try:
        from operasyon_merkez_api import ops_maliyet_gun_gun
    except Exception as e:
        logger.warning("sube_katki gun-gun import hata: %s", e)
        ops_maliyet_gun_gun = None

    for sb in subeler:
        sid = sb["id"]
        ciro = net = cogs = kira = 0.0
        ciro_son7 = 0.0
        son_ciro_gun: Optional[str] = None
        if ops_maliyet_gun_gun is not None:
            try:
                g = ops_maliyet_gun_gun(gun=gun, sube_id=sid, bas=None, bit=None)
                rows = g.get("satirlar") or []
                for r in rows:
                    c = _f(r.get("ciro_tl"))
                    ciro += c
                    net += _f(r.get("net_kar_tl"))
                    cogs += _f(r.get("toplam"))
                    kira += _f(r.get("kira_maliyet_tl"))
                    t = str(r.get("tarih") or "")[:10]
                    if c > 0:
                        if son_ciro_gun is None or t > son_ciro_gun:
                            son_ciro_gun = t
                        if t >= son7:
                            ciro_son7 += c
            except Exception as e:
                logger.warning("sube_katki gun-gun(%s) hata: %s", sid, e)
        # KAPALI tespiti: son cirodan bu yana ≥4 gün (işleyen kafe her gün ciro yapar).
        gun_since: Optional[int] = None
        if son_ciro_gun:
            try:
                gun_since = (bugun - _date.fromisoformat(son_ciro_gun)).days
            except Exception:
                gun_since = None
        kapali = (gun_since is None) or (gun_since >= 4)
        ay_carpan = 30.0 / gun if gun > 0 else 1.0
        net_aylik = round(net * ay_carpan, 2)
        kira_aylik = round(kira * ay_carpan, 2)
        # İLERİYE DÖNÜK katkı: kapalı şube gelir üretmez ama kira devam → saf drenaj (−kira).
        # Aktif şube ise gerçek operasyonel run-rate. (Kapalı dönem yükü dahil edilir.)
        ileri_aylik = (-kira_aylik) if kapali else net_aylik
        out.append({
            "sube_id": sid,
            "sube_adi": sb.get("ad"),
            "durum": "kapali" if kapali else "aktif",
            "son_ciro_gun": son_ciro_gun,
            "gun_since_ciro": gun_since,
            "ciro_donem": round(ciro, 2),
            "kira_aylik": kira_aylik,
            "operasyonel_net_aylik": net_aylik,         # son 30 gün gerçek (kapalıda açık günler dahil olabilir)
            "ileri_aylik_katki": ileri_aylik,           # ileriye dönük ortak havuz etkisi
        })
    out.sort(key=lambda x: -x["ileri_aylik_katki"])
    besleyen = sum(x["ileri_aylik_katki"] for x in out if x["ileri_aylik_katki"] > 0)
    bosaltan = sum(x["ileri_aylik_katki"] for x in out if x["ileri_aylik_katki"] < 0)
    return {
        "gun": gun,
        "uretildi": bugun.isoformat(),
        "subeler": out,
        "havuz_besleyen_aylik": round(besleyen, 2),
        "havuz_bosaltan_aylik": round(bosaltan, 2),
        "net_havuz_aylik": round(besleyen + bosaltan, 2),
        "not": "Krediler KOLEKTİF (büyümek için, ortak havuzdan ödenir) — şubeye "
               "paylaştırılmaz. Katkı = operasyonel nakit (kira dahil, finansman hariç). "
               "Kapalı şube ileriye dönük = −kira (gelir yok, kira sürüyor → saf drenaj).",
    }
