"""
finans_core.py — EVVEL ERP Hesap Merkezi
==========================================
Bu modül: okuma ağırlıklı finansal ÖZET ve TAHMİN hesapları (kasa, kart, plan, simülasyon).
Kalıcı kayıt (INSERT/UPDATE) yalnızca faiz_hesapla_ve_yaz içindedir; iş akışı ve kasa
hareketlerinin üretimi main.py vb. katmanda kalır — bilinçli ayrım.

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

from datetime import date, datetime, timedelta


def _row_tarih_to_date(v) -> date:
    """PostgreSQL date/datetime veya ISO string → date (taksit / ekstre yardımcısı)."""
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    if isinstance(v, str):
        s = v.strip().split("T", 1)[0][:10]
        return date.fromisoformat(s)
    if hasattr(v, "year") and hasattr(v, "month") and hasattr(v, "day"):
        return date(int(v.year), int(v.month), int(v.day))
    raise TypeError(f"tarih tipi desteklenmiyor: {type(v)!r}")


def _clamp_gun_ay_icinde(yil: int, ay: int, gun: int) -> int:
    """Kesim günü 1..ayın son günü (ekstre sorgusu ile uyum)."""
    import calendar as _cal
    son = _cal.monthrange(yil, ay)[1]
    return max(1, min(int(gun), son))


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
    Kasa'yı işlem türü bazında döker — kasa_bakiyesi ile aynı filtre (aktif).
    """
    cur.execute("""
        SELECT islem_turu,
               COUNT(*) AS adet,
               SUM(tutar) AS toplam,
               SUM(CASE WHEN tutar > 0 THEN tutar ELSE 0 END) AS giris,
               SUM(CASE WHEN tutar < 0 THEN ABS(tutar) ELSE 0 END) AS cikis
        FROM kasa_hareketleri
        WHERE kasa_etkisi = true AND durum = 'aktif'
        GROUP BY islem_turu
        ORDER BY toplam DESC
    """)
    satirlar = [dict(r) for r in cur.fetchall()]
    net = sum(float(r['toplam']) for r in satirlar)
    return {"net_kasa": net, "detay": satirlar}


def kasa_detay_breakdown_debug(cur) -> dict:
    """
    Debug: kasa_etkisi=true için islem_turu + durum kırılımı (iptal satırları dahil).
    net_kasa_aktif, kasa_bakiyesi ile uyumlu; net_kasa_tum tüm durumların cebri toplamı.
    """
    cur.execute("""
        SELECT islem_turu, durum,
               COUNT(*) AS adet,
               SUM(tutar) AS toplam,
               SUM(CASE WHEN tutar > 0 THEN tutar ELSE 0 END) AS giris,
               SUM(CASE WHEN tutar < 0 THEN ABS(tutar) ELSE 0 END) AS cikis
        FROM kasa_hareketleri
        WHERE kasa_etkisi = true
        GROUP BY islem_turu, durum
        ORDER BY islem_turu, durum
    """)
    satirlar = [dict(r) for r in cur.fetchall()]
    net_aktif = sum(
        float(r['toplam']) for r in satirlar
        if (r.get('durum') or '').strip() == 'aktif'
    )
    net_tum = sum(float(r['toplam']) for r in satirlar)
    return {
        "net_kasa_aktif": net_aktif,
        "net_kasa_tum": net_tum,
        "detay": satirlar,
    }


# ══════════════════════════════════════════════════════════════
# KART BORCU
# ══════════════════════════════════════════════════════════════

def kart_borc(cur, kart_id: str) -> float:
    """
    Tek bir kartın guncel borcu.
    HARCAMA + FAIZ borcu artırır, ODEME düşürür.
    Bu formül sistemin tek kart borç kaynağıdır.
    Not: Aktif satırlarda başka islem_turu varsa burada 0 sayılır; yeni kart hareket türü
    eklenecekse bilinçli olarak CASE'e dahil edilmelidir (iş kuralı değişikliği).
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

    # Plan > 0 ise sadece plan kullanılır (çift sayımı önlemek için); plan yok/0 ise fallback.
    # Bu ayrım kasıtlı — erteleme/kısmi ödeme/kart nakit ayrımı plan üzerinden yürür.

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
# TAKSİT SİSTEMİ
# ══════════════════════════════════════════════════════════════

def taksit_detay(cur, kart_id: str) -> list:
    """
    Kartın tüm aktif taksitli harcamaları için:
    - geçen_taksit: bugüne kadar kaç taksit geçti
    - kalan_taksit: kaç taksit kaldı
    - aylik_taksit: her ay düşen tutar
    - kalan_tutar: toplam kalan borç
    - bitis_tarihi: son taksit tarihi
    """
    bugun = date.today()
    cur.execute("""
        SELECT id, tarih, COALESCE(baslangic_tarihi, tarih) AS bas_tarih,
               tutar, taksit_sayisi, aciklama
        FROM kart_hareketleri
        WHERE kart_id = %s AND durum = 'aktif'
        AND islem_turu = 'HARCAMA' AND taksit_sayisi > 1
        ORDER BY tarih DESC
    """, (kart_id,))
    satirlar = cur.fetchall()
    sonuc = []
    for r in satirlar:
        try:
            bas = _row_tarih_to_date(r['bas_tarih'])
        except (TypeError, ValueError):
            try:
                bas = _row_tarih_to_date(r['tarih'])
            except (TypeError, ValueError):
                continue
        taksit_sayisi = int(r['taksit_sayisi'])
        aylik_taksit = float(r['tutar']) / taksit_sayisi

        # Kaç ay geçti?
        gecen_ay = (bugun.year - bas.year) * 12 + (bugun.month - bas.month)
        gecen_taksit = min(gecen_ay + 1, taksit_sayisi)  # en az 1 taksit geçmiştir
        kalan_taksit = max(0, taksit_sayisi - gecen_taksit)

        # Bitiş tarihi
        bitis_ay = bas.month + taksit_sayisi - 1
        bitis_yil = bas.year + (bitis_ay - 1) // 12
        bitis_ay  = ((bitis_ay - 1) % 12) + 1
        try:
            import calendar as _cal
            son_gun = _cal.monthrange(bitis_yil, bitis_ay)[1]
            bitis_tarihi = date(bitis_yil, bitis_ay, min(bas.day, son_gun))
        except Exception:
            bitis_tarihi = None

        sonuc.append({
            "id":             str(r['id']),
            "aciklama":       r['aciklama'] or '',
            "tarih":          str(r['tarih']),
            "toplam_tutar":   float(r['tutar']),
            "taksit_sayisi":  taksit_sayisi,
            "aylik_taksit":   round(aylik_taksit, 2),
            "gecen_taksit":   gecen_taksit,
            "kalan_taksit":   kalan_taksit,
            "kalan_tutar":    round(aylik_taksit * kalan_taksit, 2),
            "bitis_tarihi":   str(bitis_tarihi) if bitis_tarihi else None,
            "aktif":          kalan_taksit > 0,
        })
    return sonuc


def gelecek_taksit_yuku(cur, kart_id: str, ay_sayisi: int = 3) -> list:
    """
    Önümüzdeki N ay için kart taksit yükü dağılımı.
    Her ay için o aya düşen toplam taksit tutarını döner.
    Karar motoru ve simülasyon bunu kullanır.
    """
    bugun = date.today()
    detaylar = taksit_detay(cur, kart_id)

    aylar = []
    for i in range(ay_sayisi):
        hedef_ay   = bugun.month + i
        hedef_yil  = bugun.year + (hedef_ay - 1) // 12
        hedef_ay   = ((hedef_ay - 1) % 12) + 1
        hedef_etki = 0.0

        for t in detaylar:
            if t['kalan_taksit'] <= 0:
                continue
            try:
                bas = _row_tarih_to_date(t['tarih'])
            except (TypeError, ValueError):
                continue
            gecen_o_aya = (hedef_yil - bas.year) * 12 + (hedef_ay - bas.month)
            if 0 <= gecen_o_aya < t['taksit_sayisi']:
                hedef_etki += t['aylik_taksit']

        aylar.append({
            "ay":       f"{hedef_yil}-{hedef_ay:02d}",
            "taksit_yuku": round(hedef_etki, 2),
        })
    return aylar


def tum_kartlar_taksit_yuku(cur, ay_sayisi: int = 3) -> dict:
    """
    Tüm aktif kartların gelecek N ay taksit yükü.
    {kart_id: [{"ay": "2026-05", "taksit_yuku": 1500}, ...]}
    """
    cur.execute("SELECT id FROM kartlar WHERE aktif = TRUE")
    kartlar = [r['id'] for r in cur.fetchall()]
    return {
        str(kid): gelecek_taksit_yuku(cur, kid, ay_sayisi)
        for kid in kartlar
    }


# ══════════════════════════════════════════════════════════════
# KESİM TARİHİ MODELİ
# ══════════════════════════════════════════════════════════════

def aktif_kesim_gunu(kart: dict) -> int:
    """
    Kartın aktif kesim gününü döner.
    Önce son_kesim_tarihi'ne bakar, yoksa varsayılan + tolerans.
    Gün, içinde bulunulan ayın son gününe sıkıştırılır (şubat / 31+31 gibi taşmalar).
    """
    bugun = date.today()

    # Önce son_kesim_tarihi
    son_kesim = kart.get('son_kesim_tarihi')
    if son_kesim:
        if isinstance(son_kesim, str):
            son_kesim = date.fromisoformat(son_kesim.split("T", 1)[0][:10])
        elif isinstance(son_kesim, datetime):
            son_kesim = son_kesim.date()
        # son_kesim bu ay içindeyse onu kullan
        if son_kesim.year == bugun.year and son_kesim.month == bugun.month:
            return _clamp_gun_ay_icinde(bugun.year, bugun.month, son_kesim.day)

    # Varsayılan kesim günü + tolerans
    varsayilan = int(kart.get('kesim_gunu', 15))
    tolerans   = int(kart.get('kesim_tolerans', 0))
    ham = varsayilan + tolerans
    return _clamp_gun_ay_icinde(bugun.year, bugun.month, ham)


# ══════════════════════════════════════════════════════════════
# OTOMATİK FAİZ HESABI (TEK KAYNAK)
# ══════════════════════════════════════════════════════════════

def faiz_hesapla_ve_yaz(cur, kart_id: str, donem: str = None) -> dict:
    """
    Tek kart için otomatik faiz hesabı ve yazımı.
    donem: 'YYYY-MM' formatında. None ise bu ay.

    Akış:
    1. Ekstre hesapla (aktif kesim gününe göre)
    2. Ödenen bul (odeme_plani üzerinden)
    3. Kalan = ekstre - ödenen
    4. Kalan > 0 ise → faiz = kalan × aylık_oran
    5. Kart_hareketleri'ne FAIZ tipiyle yaz
    6. Kasaya dokunma
    7. Aynı dönem için 2 kez yazma (duplicate engel)
    """
    bugun = date.today()
    if donem is None:
        donem = bugun.strftime('%Y-%m')

    cur.execute("SELECT * FROM kartlar WHERE id = %s AND aktif = TRUE", (kart_id,))
    kart = cur.fetchone()
    if not kart:
        return {"hata": "Kart bulunamadı", "kart_id": kart_id}

    # Duplicate kontrolü — yazılan aciklama formatı ile uyumlu önek (rastgele %donem% eşleşmesi önlenir)
    _faiz_aciklama_on = f"{donem} dönem%"
    cur.execute("""
        SELECT id FROM kart_hareketleri
        WHERE kart_id = %s AND islem_turu = 'FAIZ'
        AND aciklama LIKE %s AND durum = 'aktif'
    """, (kart_id, _faiz_aciklama_on + "%"))
    if cur.fetchone():
        return {
            "kart":   kart['kart_adi'],
            "donem":  donem,
            "durum":  "zaten_yazilmis",
            "faiz":   0,
        }

    # Ekstre hesapla — aktif kesim gününe göre
    kesim = aktif_kesim_gunu(dict(kart))
    ekstre_v  = kart_ekstre(cur, kart_id, kesim)
    bu_ekstre = ekstre_v["ekstre_toplam"]

    if bu_ekstre <= 0:
        return {
            "kart":   kart['kart_adi'],
            "donem":  donem,
            "durum":  "ekstre_yok",
            "faiz":   0,
        }

    # Bu dönem ödenen
    odenen = kart_bu_ay_odenen(cur, kart_id)

    # Faiz tabanı
    kalan = max(0.0, bu_ekstre - odenen)
    if kalan <= 0:
        return {
            "kart":       kart['kart_adi'],
            "donem":      donem,
            "durum":      "tam_odendi",
            "bu_ekstre":  bu_ekstre,
            "odenen":     odenen,
            "faiz":       0,
        }

    # Faiz hesapla
    faiz_orani = float(kart['faiz_orani'])
    faiz_tutari = kart_faiz_tahmini(faiz_orani, kalan)

    if faiz_tutari < 0.01:
        return {
            "kart":   kart['kart_adi'],
            "donem":  donem,
            "durum":  "faiz_cok_kucuk",
            "faiz":   0,
        }

    # Yaz — kasaya dokunma
    import uuid as _uuid
    fid = str(_uuid.uuid4())
    cur.execute("""
        INSERT INTO kart_hareketleri
            (id, kart_id, tarih, islem_turu, tutar, faiz_tutari, aciklama)
        VALUES (%s, %s, %s, 'FAIZ', %s, %s, %s)
    """, (fid, kart_id, str(bugun), faiz_tutari, faiz_tutari,
          f"{donem} dönem faizi (kalan:{kalan:.2f})"))

    return {
        "id":         fid,
        "kart":       kart['kart_adi'],
        "donem":      donem,
        "durum":      "yazildi",
        "bu_ekstre":  bu_ekstre,
        "odenen":     odenen,
        "kalan":      kalan,
        "faiz_orani": faiz_orani,
        "faiz":       faiz_tutari,
    }


def tum_kartlar_faiz_hesapla(cur, donem: str = None) -> list:
    """
    Tüm aktif kartlar için faiz_hesapla_ve_yaz çağırır.
    Tek entry point — başka faiz fonksiyonu yoktur.
    """
    cur.execute("SELECT id FROM kartlar WHERE aktif = TRUE")
    kartlar = [r['id'] for r in cur.fetchall()]
    return [faiz_hesapla_ve_yaz(cur, kid, donem) for kid in kartlar]


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
            WHERE kasa_etkisi = true AND durum = 'aktif' AND tutar < 0
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
