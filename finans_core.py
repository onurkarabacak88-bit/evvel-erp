"""
finans_core.py — EVVEL ERP Hesap Merkezi
==========================================
KURAL: Finansal hesaplar SADECE buradadir.
SQL veri getirir, bu modul hesap yapar.
Diger modüller bu fonksiyonlari cagirır, kendi SQL hesabi YAZMAZ.

Kapsam:
  - Kasa bakiyesi
  - Kart borcu
  - Kart ekstresi
  - Ödeme yukü (7/15/30 gun)
  - Zorunlu gider tahmini
  - Gunluk ciro ortalamasi
  - Nakit akis simulasyonu
  - Kart limit dolulugu
  - Faiz tahmini
"""

from datetime import date, timedelta


# ══════════════════════════════════════════════════════════════
# KASA
# ══════════════════════════════════════════════════════════════

def kasa_bakiyesi(cur) -> float:
    """
    Anlık kasa bakiyesi.
    Tek gerçek kaynak: kasa_hareketleri WHERE kasa_etkisi=true.
    DEVIR dahil değil (kasa_etkisi=false).
    """
    cur.execute("""
        SELECT COALESCE(SUM(tutar), 0) AS bakiye
        FROM kasa_hareketleri
        WHERE kasa_etkisi = true AND durum = 'aktif'
    """)
    return float(cur.fetchone()['bakiye'])


def kasa_bakiyesi_tarihte(cur, tarih: date) -> float:
    """
    Belirtilen tarihe kadar (dahil) kasa bakiyesi — devir hesabı için.
    """
    cur.execute("""
        SELECT COALESCE(SUM(tutar), 0) AS bakiye
        FROM kasa_hareketleri
        WHERE kasa_etkisi = true AND durum = 'aktif'
        AND tarih <= %s
    """, (tarih,))
    return float(cur.fetchone()['bakiye'])


def kasa_detay_breakdown(cur) -> dict:
    """
    Kasa'yı işlem türü bazında döker — audit ve debug için.
    """
    cur.execute("""
        SELECT islem_turu,
               COUNT(*) AS adet,
               SUM(tutar) AS toplam,
               SUM(CASE WHEN tutar > 0 THEN tutar ELSE 0 END) AS giris,
               SUM(CASE WHEN tutar < 0 THEN ABS(tutar) ELSE 0 END) AS cikis
        FROM kasa_hareketleri
        WHERE kasa_etkisi = true
        GROUP BY islem_turu
        ORDER BY toplam DESC
    """)
    satirlar = [dict(r) for r in cur.fetchall()]
    net = sum(float(r['toplam']) for r in satirlar)
    return {"net_kasa": net, "detay": satirlar}


# ══════════════════════════════════════════════════════════════
# KART BORCU
# ══════════════════════════════════════════════════════════════

def kart_borc(cur, kart_id: str) -> float:
    """
    Tek bir kartın guncel borcu.
    HARCAMA + FAIZ borcu artırır, ODEME düşürür.
    Bu formül sistemin tek kart borç kaynağıdır.
    """
    cur.execute("""
        SELECT COALESCE(SUM(
            CASE
                WHEN islem_turu IN ('HARCAMA', 'FAIZ') THEN tutar
                WHEN islem_turu = 'ODEME'              THEN -tutar
                ELSE 0
            END
        ), 0) AS borc
        FROM kart_hareketleri
        WHERE kart_id = %s AND durum = 'aktif'
    """, (kart_id,))
    return float(cur.fetchone()['borc'])


def tum_kart_borclari(cur) -> dict:
    """
    Tüm aktif kartların {kart_id: borc} map'i.
    Tek sorgu — N+1 problemi yok.
    """
    cur.execute("""
        SELECT kart_id,
               COALESCE(SUM(
                   CASE
                       WHEN islem_turu IN ('HARCAMA', 'FAIZ') THEN tutar
                       WHEN islem_turu = 'ODEME'              THEN -tutar
                       ELSE 0
                   END
               ), 0) AS borc
        FROM kart_hareketleri
        WHERE durum = 'aktif'
        GROUP BY kart_id
    """)
    return {str(r['kart_id']): float(r['borc']) for r in cur.fetchall()}


def kart_limit_doluluk(cur, kart_id: str, limit_tutar: float) -> dict:
    """
    Kartın limit doluluk oranı ve kalan limiti.
    """
    borc = kart_borc(cur, kart_id)
    kalan = limit_tutar - borc
    oran = borc / limit_tutar if limit_tutar > 0 else 0.0
    return {
        "borc": borc,
        "kalan_limit": kalan,
        "doluluk_orani": oran,
        "doluluk_pct": round(oran * 100, 1),
    }


# ══════════════════════════════════════════════════════════════
# KART EKSTRESİ
# ══════════════════════════════════════════════════════════════

def kart_ekstre(cur, kart_id: str, kesim_gunu: int) -> dict:
    """
    Kartın bu dönem ekstresi: tek çekim + taksit payı.
    Bu hesap sistemde tek tanımlıdır — panel, kart analiz, faiz motoru
    hepsi bunu kullanır.
    """
    # Tek çekim: bu ay, kesim gününe kadar
    cur.execute("""
        SELECT COALESCE(SUM(tutar), 0) AS tek_cekim
        FROM kart_hareketleri
        WHERE kart_id = %s AND durum = 'aktif'
        AND islem_turu = 'HARCAMA' AND taksit_sayisi = 1
        AND EXTRACT(YEAR  FROM tarih) = EXTRACT(YEAR  FROM CURRENT_DATE)
        AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
        AND EXTRACT(DAY   FROM tarih) <= %s
    """, (kart_id, kesim_gunu))
    tek_cekim = float(cur.fetchone()['tek_cekim'])

    # Taksitli harcamalar: tüm zamanlardan aylık taksit payı
    cur.execute("""
        SELECT COALESCE(SUM(tutar::float / NULLIF(taksit_sayisi, 0)), 0) AS aylik_taksit
        FROM kart_hareketleri
        WHERE kart_id = %s AND durum = 'aktif'
        AND islem_turu = 'HARCAMA' AND taksit_sayisi > 1
    """, (kart_id,))
    aylik_taksit = float(cur.fetchone()['aylik_taksit'])

    ekstre = tek_cekim + aylik_taksit
    return {
        "tek_cekim": tek_cekim,
        "aylik_taksit": aylik_taksit,
        "ekstre_toplam": ekstre,
    }


def kart_bu_ay_odenen(cur, kart_id: str) -> float:
    """
    Bu ay odeme_plani üzerinden ödenen tutar — faiz tabanı için.
    """
    cur.execute("""
        SELECT COALESCE(SUM(odenen_tutar), 0) AS odenen
        FROM odeme_plani
        WHERE kart_id = %s AND durum = 'odendi'
        AND EXTRACT(YEAR  FROM odeme_tarihi) = EXTRACT(YEAR  FROM CURRENT_DATE)
        AND EXTRACT(MONTH FROM odeme_tarihi) = EXTRACT(MONTH FROM CURRENT_DATE)
    """, (kart_id,))
    return float(cur.fetchone()['odenen'])


def kart_faiz_tahmini(faiz_orani_yillik: float, kalan_ekstre: float) -> float:
    """
    Ödenmeyen ekstre bakiyesi üzerinden aylık faiz tahmini.
    faiz_orani_yillik: kartın yıllık faiz oranı (örn. 4.5 → %4.5)
    """
    if kalan_ekstre <= 0 or faiz_orani_yillik <= 0:
        return 0.0
    aylik_oran = faiz_orani_yillik / 100.0 / 12.0
    return round(kalan_ekstre * aylik_oran, 2)


# ══════════════════════════════════════════════════════════════
# ÖDEME YÜKÜ
# ══════════════════════════════════════════════════════════════

def odeme_yuku(cur, bugun: date = None) -> dict:
    """
    7 / 15 / 30 günlük ödeme yükü ve asgari ödeme toplamları.
    Karar motoru, strateji motoru ve panel bu fonksiyonu kullanır.
    """
    if bugun is None:
        bugun = date.today()

    cur.execute("""
        SELECT
            COALESCE(SUM(CASE WHEN tarih <= %s + INTERVAL '7 days'
                              THEN odenecek_tutar ELSE 0 END), 0) AS t7,
            COALESCE(SUM(CASE WHEN tarih <= %s + INTERVAL '15 days'
                              THEN odenecek_tutar ELSE 0 END), 0) AS t15,
            COALESCE(SUM(CASE WHEN tarih <= %s + INTERVAL '30 days'
                              THEN odenecek_tutar ELSE 0 END), 0) AS t30,
            COALESCE(SUM(CASE WHEN tarih <= %s + INTERVAL '7 days'
                              THEN asgari_tutar  ELSE 0 END), 0) AS asgari7
        FROM odeme_plani
        WHERE durum IN ('bekliyor', 'onay_bekliyor')
        AND tarih BETWEEN %s AND %s + INTERVAL '30 days'
    """, (bugun, bugun, bugun, bugun, bugun, bugun))

    r = cur.fetchone()
    return {
        "t7":     float(r['t7']),
        "t15":    float(r['t15']),
        "t30":    float(r['t30']),
        "asgari7": float(r['asgari7']),
    }


# ══════════════════════════════════════════════════════════════
# ZORUNLU GİDER TAHMİNİ
# ══════════════════════════════════════════════════════════════

def zorunlu_gider_tahmini(cur) -> dict:
    """
    Önümüzdeki 30 günün zorunlu gider yükü.
    Strateji motoru bu fonksiyonu kullanır.
    """
    # Bekleyen ödeme planı toplamı (en güvenilir veri)
    cur.execute("""
        SELECT COALESCE(SUM(odenecek_tutar), 0) AS bekleyen
        FROM odeme_plani
        WHERE durum IN ('bekliyor', 'onay_bekliyor')
        AND tarih BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
    """)
    bekleyen_30 = float(cur.fetchone()['bekleyen'])

    # Fallback: sabit gider + borç + maaş toplamı (plan henüz üretilmemişse)
    cur.execute("""
        SELECT COALESCE(SUM(tutar), 0) AS t
        FROM sabit_giderler
        WHERE aktif = TRUE AND (tip IS NULL OR tip = 'sabit')
    """)
    sabit = float(cur.fetchone()['t'])

    cur.execute("""
        SELECT COALESCE(SUM(aylik_taksit), 0) AS t
        FROM borc_envanteri WHERE aktif = TRUE
    """)
    borc = float(cur.fetchone()['t'])

    cur.execute("""
        SELECT COALESCE(SUM(maas + yemek_ucreti + yol_ucreti), 0) AS t
        FROM personel
        WHERE aktif = TRUE AND calisma_turu = 'surekli'
    """)
    personel = float(cur.fetchone()['t'])

    fallback = sabit + borc + personel
    # Plan varsa onu kullan, yoksa fallback
    zorunlu = bekleyen_30 if bekleyen_30 > 0 else fallback

    return {
        "zorunlu": zorunlu,
        "bekleyen_plan": bekleyen_30,
        "fallback": fallback,
        "sabit": sabit,
        "borc": borc,
        "personel": personel,
    }


# ══════════════════════════════════════════════════════════════
# CİRO ANALİTİK
# ══════════════════════════════════════════════════════════════

def gunluk_ciro_ortalama(cur) -> dict:
    """
    Son 7 ve 30 günün günlük ciro ortalaması.
    Simülasyon motoru bu fonksiyonu kullanır.
    Ağırlıklı tahmin: haftalık %70, aylık %30.
    """
    cur.execute("""
        SELECT
            COALESCE(AVG(CASE WHEN tarih >= CURRENT_DATE - INTERVAL '7 days'
                              THEN gunluk END), 0) AS haftalik,
            COALESCE(AVG(CASE WHEN tarih >= CURRENT_DATE - INTERVAL '30 days'
                              THEN gunluk END), 0) AS aylik
        FROM (
            SELECT tarih, SUM(toplam) AS gunluk
            FROM ciro
            WHERE tarih >= CURRENT_DATE - INTERVAL '30 days'
            AND durum = 'aktif'
            GROUP BY tarih
        ) t
    """)
    r = cur.fetchone()
    haftalik = float(r['haftalik'] or 0)
    aylik    = float(r['aylik']    or 0)

    # Ağırlıklı tahmin
    agirlikli = (haftalik * 0.7 + aylik * 0.3) if haftalik > 0 else aylik

    return {
        "haftalik": haftalik,
        "aylik":    aylik,
        "tahmin":   agirlikli,
    }


# ══════════════════════════════════════════════════════════════
# NAKİT AKIŞ SİMÜLASYONU
# ══════════════════════════════════════════════════════════════

def nakit_akis_sim(cur, gun_sayisi: int = 15) -> list:
    """
    gun_sayisi günlük kasa projeksiyonu.
    Mevcut kasa + günlük ciro tahmini - planlanan ödemeler.
    """
    bugun = date.today()
    baslangic_kasa = kasa_bakiyesi(cur)
    ciro_veri = gunluk_ciro_ortalama(cur)
    gunluk_ciro = ciro_veri["tahmin"]

    # Planlanan ödemeleri tarihe göre map'e al
    cur.execute("""
        SELECT tarih::TEXT, SUM(odenecek_tutar) AS toplam
        FROM odeme_plani
        WHERE durum IN ('bekliyor', 'onay_bekliyor')
        AND tarih BETWEEN %s AND %s
        GROUP BY tarih
    """, (bugun, bugun + timedelta(days=gun_sayisi)))
    odeme_map = {r['tarih']: float(r['toplam']) for r in cur.fetchall()}

    gunler = []
    kasa = baslangic_kasa
    for i in range(gun_sayisi):
        t = bugun + timedelta(days=i)
        t_str = str(t)
        odeme = odeme_map.get(t_str, 0)
        kasa = kasa + gunluk_ciro - odeme
        gunler.append({
            "tarih":          t_str,
            "beklenen_gelir": gunluk_ciro,
            "beklenen_gider": odeme,
            "kasa_tahmini":   round(kasa, 2),
            "risk":           kasa < 0,
        })

    return gunler


# ══════════════════════════════════════════════════════════════
# KAÇ GÜN DAYANIR
# ══════════════════════════════════════════════════════════════

def kac_gun_dayanir(cur) -> int:
    """
    Mevcut kasanın kaç gün dayanacağı tahmini.
    Son 30 günün günlük ortalama ÇIKIŞ hareketlerine bakılır.
    Gelecek ödemeler (odeme_plani) de eklenerek gerçekçi tahmin yapılır.
    """
    kasa = kasa_bakiyesi(cur)

    # Son 30 günün günlük ortalama nakit çıkışı
    cur.execute("""
        SELECT COALESCE(AVG(gunluk), 0) AS ort
        FROM (
            SELECT tarih, SUM(ABS(tutar)) AS gunluk
            FROM kasa_hareketleri
            WHERE kasa_etkisi = true AND tutar < 0
            AND tarih >= CURRENT_DATE - INTERVAL '30 days'
            GROUP BY tarih
        ) t
    """)
    gunluk_gecmis = float(cur.fetchone()['ort'] or 0)

    # Önümüzdeki 30 günün günlük ortalama ödeme yükü
    yuk = odeme_yuku(cur)
    gunluk_gelecek = yuk["t30"] / 30.0 if yuk["t30"] > 0 else 0

    # İkisinin ortalaması
    gunluk_ort = max(gunluk_gecmis, gunluk_gelecek, 1)

    gun = int(kasa / gunluk_ort) if gunluk_ort > 0 else 999
    return min(gun, 999)


# ══════════════════════════════════════════════════════════════
# SERBEST NAKİT
# ══════════════════════════════════════════════════════════════

def serbest_nakit(cur) -> float:
    """
    Kasa - 7 günlük ödeme yükü = gerçek hareket alanı.
    """
    kasa = kasa_bakiyesi(cur)
    yuk  = odeme_yuku(cur)
    return kasa - yuk["t7"]


# ══════════════════════════════════════════════════════════════
# NET 30 GÜN AKIŞ
# ══════════════════════════════════════════════════════════════

def net_akis_30_gun(cur) -> dict:
    """
    Son 30 günün gelir / gider / net akışı.
    """
    cur.execute("""
        SELECT
            COALESCE(SUM(CASE WHEN tutar > 0 THEN tutar ELSE 0 END), 0) AS gelir,
            COALESCE(SUM(CASE WHEN tutar < 0 THEN ABS(tutar) ELSE 0 END), 0) AS gider
        FROM kasa_hareketleri
        WHERE kasa_etkisi = true AND durum = 'aktif'
        AND tarih >= CURRENT_DATE - INTERVAL '30 days'
    """)
    r = cur.fetchone()
    gelir = float(r['gelir'])
    gider = float(r['gider'])
    return {
        "gelir": gelir,
        "gider": gider,
        "net":   gelir - gider,
    }
