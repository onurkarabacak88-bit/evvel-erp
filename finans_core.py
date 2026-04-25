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

from tr_saat import bugun_tr


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

def _safe_date(y: int, m: int, d: int) -> date:
    """Ay sonunu aşan günleri o ayın son gününe kırpar (örn. Şubat 30 → 28/29)."""
    import calendar as _cal
    son = _cal.monthrange(y, m)[1]
    return date(y, m, min(int(d), son))


def son_odeme_tarihi_hesapla(kesim_tarihi: date, son_odeme_gunu: int) -> date:
    """
    Verilen kesim tarihine ait son ödeme tarihini hesaplar.
    son_odeme_gunu kesim_gunu'ndan büyük/eşitse → aynı ay; değilse → bir sonraki ay.
    """
    if son_odeme_gunu >= kesim_tarihi.day:
        return _safe_date(kesim_tarihi.year, kesim_tarihi.month, son_odeme_gunu)
    if kesim_tarihi.month == 12:
        return _safe_date(kesim_tarihi.year + 1, 1, son_odeme_gunu)
    return _safe_date(kesim_tarihi.year, kesim_tarihi.month + 1, son_odeme_gunu)


def son_kapanan_kesim(kesim_gunu: int, son_odeme_gunu: int, as_of: date):
    """
    as_of tarihi itibarıyla son ödeme tarihi GEÇMİŞ olan en son kesim tarihini döndürür.
    Henüz hiçbir kesim kapanmamışsa None.
    """
    bu_ay_kesim = _safe_date(as_of.year, as_of.month, kesim_gunu)
    bu_ay_son_odeme = son_odeme_tarihi_hesapla(bu_ay_kesim, son_odeme_gunu)
    if bu_ay_son_odeme < as_of:
        return bu_ay_kesim
    if as_of.month == 1:
        onceki = _safe_date(as_of.year - 1, 12, kesim_gunu)
    else:
        onceki = _safe_date(as_of.year, as_of.month - 1, kesim_gunu)
    onceki_son_odeme = son_odeme_tarihi_hesapla(onceki, son_odeme_gunu)
    if onceki_son_odeme < as_of:
        return onceki
    return None


def kart_ekstre(cur, kart_id: str, kesim_gunu: int, kesim_tarihi: date = None) -> dict:
    """
    Kartın bir kesim dönemine ait ekstresi: tek çekim + taksit payı + devreden faiz.
    Bu hesap sistemde tek tanımlıdır — panel, kart analiz, faiz motoru hepsi bunu kullanır.

    İki kullanım modu:
      1) kesim_tarihi=None → CURRENT_DATE'in ayına göre ANCHORLA (panel/analiz için):
         dönem = (önceki ayın kesim günü, bu ayın kesim günü]
      2) kesim_tarihi=<date> → o KESİM TARİHİNE göre anchorla (faiz motoru için):
         dönem = (kesim_tarihi - 1 ay, kesim_tarihi]
         Mod 2 sayesinde her kart kendi gerçek kesim gününde faizlenir,
         tüm kartların ay-son-gün'de top atışıyla faizlenmesi engellenir.

    devreden_faiz: önceki dönemden bu döneme yazılmış FAIZ kayıtları
    ekstreye dahildir → bileşik faiz zinciri.
    """
    if kesim_tarihi is None:
        # Mod 1 — CURRENT_DATE bazlı (geriye uyumlu, panel için)
        cur.execute("""
            SELECT COALESCE(SUM(tutar), 0) AS tek_cekim
            FROM kart_hareketleri
            WHERE kart_id = %s AND durum = 'aktif'
            AND islem_turu = 'HARCAMA' AND taksit_sayisi = 1
            AND tarih > (DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
                         + (%s - 1) * INTERVAL '1 day')
            AND tarih <= (DATE_TRUNC('month', CURRENT_DATE)
                          + (%s - 1) * INTERVAL '1 day')
        """, (kart_id, kesim_gunu, kesim_gunu))
        tek_cekim = float(cur.fetchone()['tek_cekim'])

        cur.execute("""
            SELECT COALESCE(SUM(tutar::float / NULLIF(taksit_sayisi, 0)), 0) AS aylik_taksit
            FROM kart_hareketleri
            WHERE kart_id = %s AND durum = 'aktif'
            AND islem_turu = 'HARCAMA' AND taksit_sayisi > 1
        """, (kart_id,))
        aylik_taksit = float(cur.fetchone()['aylik_taksit'])

        cur.execute("""
            SELECT COALESCE(SUM(tutar), 0) AS devreden_faiz
            FROM kart_hareketleri
            WHERE kart_id = %s AND durum = 'aktif'
            AND islem_turu = 'FAIZ'
            AND tarih > (DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
                         + (%s - 1) * INTERVAL '1 day')
            AND tarih <= (DATE_TRUNC('month', CURRENT_DATE)
                          + (%s - 1) * INTERVAL '1 day')
        """, (kart_id, kesim_gunu, kesim_gunu))
        devreden_faiz = float(cur.fetchone()['devreden_faiz'])
    else:
        # Mod 2 — explicit kesim_tarihi bazlı (faiz motoru için)
        cur.execute("""
            SELECT COALESCE(SUM(tutar), 0) AS tek_cekim
            FROM kart_hareketleri
            WHERE kart_id = %s AND durum = 'aktif'
            AND islem_turu = 'HARCAMA' AND taksit_sayisi = 1
            AND tarih >  (%s::date - INTERVAL '1 month')
            AND tarih <= %s::date
        """, (kart_id, kesim_tarihi, kesim_tarihi))
        tek_cekim = float(cur.fetchone()['tek_cekim'])

        # Taksitli — kesim_tarihi'nden ÖNCE açılmış olanların aylık payı
        cur.execute("""
            SELECT COALESCE(SUM(tutar::float / NULLIF(taksit_sayisi, 0)), 0) AS aylik_taksit
            FROM kart_hareketleri
            WHERE kart_id = %s AND durum = 'aktif'
            AND islem_turu = 'HARCAMA' AND taksit_sayisi > 1
            AND tarih <= %s::date
        """, (kart_id, kesim_tarihi))
        aylik_taksit = float(cur.fetchone()['aylik_taksit'])

        cur.execute("""
            SELECT COALESCE(SUM(tutar), 0) AS devreden_faiz
            FROM kart_hareketleri
            WHERE kart_id = %s AND durum = 'aktif'
            AND islem_turu = 'FAIZ'
            AND tarih >  (%s::date - INTERVAL '1 month')
            AND tarih <= %s::date
        """, (kart_id, kesim_tarihi, kesim_tarihi))
        devreden_faiz = float(cur.fetchone()['devreden_faiz'])

    ekstre = tek_cekim + aylik_taksit + devreden_faiz
    return {
        "tek_cekim": tek_cekim,
        "aylik_taksit": aylik_taksit,
        "devreden_faiz": devreden_faiz,
        "ekstre_toplam": ekstre,
    }


def kart_bu_ay_odenen(cur, kart_id: str) -> float:
    """
    Bu takvim ayında karta yansıyan toplam ödeme (kart_hareketleri ODEME, aktif).
    Panel asgari / borç ile aynı kaynak: plan dışı manuel ödemeler de dahil.
    """
    cur.execute("""
        SELECT COALESCE(SUM(tutar), 0) AS odenen
        FROM kart_hareketleri
        WHERE kart_id = %s
          AND islem_turu = 'ODEME'
          AND durum = 'aktif'
          AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', CURRENT_DATE)
    """, (kart_id,))
    return float(cur.fetchone()['odenen'])


def kart_asgari_orani(kart) -> float:
    """
    Kartın asgari ödeme oranını döner (0–1 arası decimal: 0.40 = %40).
    TEK KAYNAK — tüm modüller bu fonksiyonu kullanmalı.
    Sırasıyla bakar:
      1) kart['asgari_oran'] (DB kolonu, NUMERIC %, örn. 40 → 0.40)
      2) Kolon yok/None ise 0.40 (Türkiye TCMB minimum %40 mevzuatı)
    Geçerli aralık: [0.20, 1.00] (banka uygulamaları arasında makul).
    """
    if kart is None:
        return 0.40
    try:
        if hasattr(kart, 'get'):
            v = kart.get('asgari_oran')
        else:
            v = kart['asgari_oran'] if 'asgari_oran' in kart else None
    except Exception:
        v = None
    if v is None:
        return 0.40
    try:
        oran = float(v) / 100.0
    except (ValueError, TypeError):
        return 0.40
    return max(0.20, min(oran, 1.00))


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
        bugun = bugun_tr()

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

    # Çift sayımı önlemek için: planlananlar + sadece planda olmayan zorunlu kalemler.
    # Böylece kısmi plan üretiminde de eksik kalan yük yakalanır.
    cur.execute("""
        SELECT COALESCE(SUM(g.tutar), 0) AS t
        FROM sabit_giderler g
        WHERE g.aktif = TRUE
          AND (g.tip IS NULL OR g.tip = 'sabit')
          AND NOT EXISTS (
              SELECT 1
              FROM odeme_plani op
              WHERE op.kaynak_tablo = 'sabit_giderler'
                AND op.kaynak_id = g.id
                AND op.durum IN ('bekliyor','onay_bekliyor')
                AND op.tarih BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
          )
    """)
    sabit_eksik = float(cur.fetchone()['t'] or 0)

    cur.execute("""
        SELECT COALESCE(SUM(b.aylik_taksit), 0) AS t
        FROM borc_envanteri b
        WHERE b.aktif = TRUE
          AND b.aylik_taksit > 0
          AND (b.kalan_vade IS NULL OR b.kalan_vade > 0)
          AND NOT EXISTS (
              SELECT 1
              FROM odeme_plani op
              WHERE op.kaynak_tablo = 'borc_envanteri'
                AND op.kaynak_id = b.id
                AND op.durum IN ('bekliyor','onay_bekliyor')
                AND op.tarih BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
          )
    """)
    borc_eksik = float(cur.fetchone()['t'] or 0)

    cur.execute("""
        SELECT COALESCE(SUM(p.maas + p.yemek_ucreti + p.yol_ucreti), 0) AS t
        FROM personel p
        WHERE p.aktif = TRUE
          AND p.calisma_turu = 'surekli'
          AND NOT EXISTS (
              SELECT 1
              FROM odeme_plani op
              WHERE op.kaynak_tablo = 'personel'
                AND op.kaynak_id = p.id
                AND op.durum IN ('bekliyor','onay_bekliyor')
                AND op.tarih BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
          )
    """)
    personel_eksik = float(cur.fetchone()['t'] or 0)

    fallback_eksik = sabit_eksik + borc_eksik + personel_eksik
    zorunlu = bekleyen_30 + fallback_eksik

    return {
        "zorunlu": zorunlu,
        "bekleyen_plan": bekleyen_30,
        "fallback": fallback,
        "fallback_eksik": fallback_eksik,
        "sabit": sabit,
        "borc": borc,
        "personel": personel,
        "sabit_eksik": sabit_eksik,
        "borc_eksik": borc_eksik,
        "personel_eksik": personel_eksik,
        "hesap_modeli": "bekleyen_plan + fallback_eksik",
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
    # generate_series ile boş (0 ciro) günleri de hesaba kat.
    # Bekleyen taslakları da dahil et; aynı şube+tarihte aktif ciro varsa taslak sayılmaz.
    cur.execute("""
        WITH gunler AS (
            SELECT dd::date AS tarih
            FROM generate_series(CURRENT_DATE - INTERVAL '29 days', CURRENT_DATE, INTERVAL '1 day') AS dd
        ),
        ciro_aktif AS (
            SELECT tarih::date AS tarih, COALESCE(SUM(toplam), 0) AS gunluk
            FROM ciro
            WHERE tarih >= CURRENT_DATE - INTERVAL '29 days'
              AND durum = 'aktif'
            GROUP BY tarih::date
        ),
        ciro_taslak_bekleyen AS (
            SELECT ct.tarih::date AS tarih,
                   COALESCE(SUM(COALESCE(ct.nakit,0) + COALESCE(ct.pos,0) + COALESCE(ct.online,0)), 0) AS gunluk
            FROM ciro_taslak ct
            WHERE ct.durum = 'bekliyor'
              AND ct.tarih >= CURRENT_DATE - INTERVAL '29 days'
              AND NOT EXISTS (
                  SELECT 1
                  FROM ciro c
                  WHERE c.sube_id = ct.sube_id
                    AND c.tarih = ct.tarih
                    AND c.durum = 'aktif'
              )
            GROUP BY ct.tarih::date
        ),
        ciro_gunluk AS (
            SELECT g.tarih,
                   (COALESCE(ca.gunluk, 0) + COALESCE(ctb.gunluk, 0)) AS gunluk
            FROM gunler g
            LEFT JOIN ciro_aktif ca ON ca.tarih = g.tarih
            LEFT JOIN ciro_taslak_bekleyen ctb ON ctb.tarih = g.tarih
        ),
        dow_avg AS (
            SELECT EXTRACT(ISODOW FROM tarih)::int AS dow,
                   COALESCE(AVG(gunluk), 0) AS ort
            FROM ciro_gunluk
            GROUP BY EXTRACT(ISODOW FROM tarih)::int
        )
        SELECT
            COALESCE(AVG(CASE WHEN g.tarih >= CURRENT_DATE - INTERVAL '6 days'
                              THEN COALESCE(cg.gunluk, 0) END), 0) AS haftalik,
            COALESCE(AVG(COALESCE(cg.gunluk, 0)), 0) AS aylik,
            COALESCE(
                (SELECT jsonb_object_agg(dow::text, ort) FROM dow_avg),
                '{}'::jsonb
            ) AS dow_ort
        FROM gunler g
        LEFT JOIN ciro_gunluk cg ON cg.tarih = g.tarih
    """)
    r = cur.fetchone()
    haftalik = float(r['haftalik'] or 0)
    aylik    = float(r['aylik']    or 0)
    dow_ort_raw = r.get('dow_ort') or {}
    if isinstance(dow_ort_raw, str):
        import json as _json
        try:
            dow_ort_raw = _json.loads(dow_ort_raw)
        except Exception:
            dow_ort_raw = {}
    if not isinstance(dow_ort_raw, dict):
        dow_ort_raw = {}

    # Ağırlıklı tahmin
    agirlikli = (haftalik * 0.7 + aylik * 0.3) if haftalik > 0 else aylik
    base = max(agirlikli, 1.0)
    gunluk_katsayi = {}
    for dow in range(1, 8):
        val = float(dow_ort_raw.get(str(dow), agirlikli) or 0)
        k = val / base if base > 0 else 1.0
        # Aşırı uçları kırp: simülasyonun stabil kalması için.
        gunluk_katsayi[str(dow)] = round(max(0.0, min(1.5, k)), 3)

    return {
        "haftalik": haftalik,
        "aylik":    aylik,
        "tahmin":   agirlikli,
        "gunluk_katsayi": gunluk_katsayi,
        "taslak_dahil": True,
    }


# ══════════════════════════════════════════════════════════════
# NAKİT AKIŞ SİMÜLASYONU
# ══════════════════════════════════════════════════════════════

def nakit_akis_sim(cur, gun_sayisi: int = 15) -> list:
    """
    gun_sayisi günlük kasa projeksiyonu.
    Mevcut kasa + günlük ciro tahmini - planlanan ödemeler.

    Değişiklikler (geriye uyumlu):
    - Gecikmiş ödemeler (tarih < bugün, hâlâ bekliyor/onay_bekliyor) gün 0'a
      eklenir. kasa_bakiyesi fiziksel parayı doğru gösterir; ancak ödenmemiş
      yükümlülükleri görmezden gelirse projeksiyon yanıltıcı olur.
    - Her güne 'risk_seviye' alanı eklendi: 'NORMAL' / 'DIKKAT' / 'KRITIK'.
      Mevcut 'risk' bool alanı değişmedi — tüm çağrıcılar uyumlu kalır.
    """
    bugun = bugun_tr()
    baslangic_kasa = kasa_bakiyesi(cur)
    ciro_veri = gunluk_ciro_ortalama(cur)
    gunluk_ciro = ciro_veri["tahmin"]
    katsayi_map = ciro_veri.get("gunluk_katsayi") or {}

    # Planlanan ödemeleri tarihe göre map'e al (bugün dahil ileri tarihler)
    cur.execute("""
        SELECT tarih::TEXT, SUM(odenecek_tutar) AS toplam
        FROM odeme_plani
        WHERE durum IN ('bekliyor', 'onay_bekliyor')
        AND tarih BETWEEN %s AND %s
        GROUP BY tarih
    """, (bugun, bugun + timedelta(days=gun_sayisi)))
    odeme_map = {r['tarih']: float(r['toplam']) for r in cur.fetchall()}

    # Gecikmiş ödemeler — vadesi geçmiş ama ödenmemiş yükümlülükleri gün 0'a yükle.
    # Bu para fiziksel kasada dursa da bugün ödenmesi gereken bir borçtur;
    # projeksiyon bunu görmezden gelirse kasanın gerçekte ne kadar baskı altında
    # olduğu anlaşılamaz.
    cur.execute("""
        SELECT COALESCE(SUM(odenecek_tutar), 0) AS toplam
        FROM odeme_plani
        WHERE durum IN ('bekliyor', 'onay_bekliyor')
        AND tarih < %s
    """, (bugun,))
    gecikmus_toplam = float(cur.fetchone()['toplam'] or 0)
    if gecikmus_toplam > 0:
        bugun_str = str(bugun)
        odeme_map[bugun_str] = odeme_map.get(bugun_str, 0.0) + gecikmus_toplam

    gunler = []
    kasa = baslangic_kasa
    for i in range(gun_sayisi):
        t = bugun + timedelta(days=i)
        t_str = str(t)
        odeme = odeme_map.get(t_str, 0.0)
        dow = str(t.isoweekday())
        gelir_katsayi = float(katsayi_map.get(dow, 1.0) or 1.0)
        beklenen_gelir = round(gunluk_ciro * gelir_katsayi, 2)
        kasa = kasa + beklenen_gelir - odeme
        kasa_r = round(kasa, 2)
        # Risk seviyesi: negatife düştüyse KRİTİK;
        # başlangıç kasasının %20'sine inerse DİKKAT; aksi hâlde NORMAL.
        if kasa_r < 0:
            risk_seviye = 'KRITIK'
        elif baslangic_kasa > 0 and kasa_r < baslangic_kasa * 0.20:
            risk_seviye = 'DIKKAT'
        else:
            risk_seviye = 'NORMAL'
        gun_veri: dict = {
            "tarih":          t_str,
            "beklenen_gelir": beklenen_gelir,
            "gelir_katsayi":  gelir_katsayi,
            "beklenen_gider": round(odeme, 2),
            "kasa_tahmini":   kasa_r,
            "risk":           kasa_r < 0,       # geriye uyumlu bool — değişmedi
            "risk_seviye":    risk_seviye,       # yeni alan — tüm çağrıcılar {**gun} ile yayar
        }
        # İlk gün gecikmiş ödeme yükü varsa ayrıca işaretle (panel / debug için).
        if i == 0 and gecikmus_toplam > 0:
            gun_veri["gecikmus_odeme"] = round(gecikmus_toplam, 2)
        gunler.append(gun_veri)

    return gunler


def nakit_akis_tahmin_dogruluk(cur, gun_sayisi: int = 30, min_ornek: int = 5, sube_id: str | None = None) -> dict:
    """
    CFO simülasyonunun ciro tahmin formülüyle (haftalık %70 + aylık %30, DOW katsayısı)
    geçmiş günlerde backtest doğruluğu üretir.
    """
    gun_sayisi = max(7, min(120, int(gun_sayisi or 30)))
    min_ornek = max(3, min(30, int(min_ornek or 5)))
    bugun = bugun_tr()
    baslangic = bugun - timedelta(days=gun_sayisi + 45)

    qp = [baslangic, bugun]
    q = """
        SELECT tarih::date AS tarih, COALESCE(SUM(toplam), 0)::numeric AS ciro
        FROM ciro
        WHERE durum='aktif'
          AND tarih BETWEEN %s AND %s
    """
    sid = (sube_id or "").strip() or None
    if sid:
        q += " AND sube_id=%s"
        qp.append(sid)
    q += " GROUP BY tarih::date ORDER BY tarih::date"
    cur.execute(q, tuple(qp))
    ciro_map = {r["tarih"]: float(r["ciro"] or 0.0) for r in cur.fetchall()}

    satirlar = []
    ilk_hedef = bugun - timedelta(days=gun_sayisi - 1)
    for i in range(gun_sayisi):
        hedef = ilk_hedef + timedelta(days=i)
        onceki_30 = [hedef - timedelta(days=d) for d in range(30, 0, -1)]
        onceki_7 = onceki_30[-7:]

        aylik_vals = [float(ciro_map.get(g, 0.0)) for g in onceki_30]
        haftalik_vals = aylik_vals[-7:]
        aylik_ort = sum(aylik_vals) / 30.0
        haftalik_ort = sum(haftalik_vals) / 7.0

        agirlikli = (haftalik_ort * 0.7 + aylik_ort * 0.3) if haftalik_ort > 0 else aylik_ort
        base = max(float(agirlikli), 1.0)

        dow_hedef = hedef.isoweekday()
        dow_vals = [float(ciro_map.get(g, 0.0)) for g in onceki_30 if g.isoweekday() == dow_hedef]
        dow_ort = (sum(dow_vals) / float(len(dow_vals))) if dow_vals else agirlikli
        katsayi = max(0.0, min(1.5, (dow_ort / base) if base > 0 else 1.0))

        tahmin = round(float(agirlikli) * float(katsayi), 2)
        gercek = float(ciro_map.get(hedef, 0.0))
        if gercek <= 0:
            continue
        ape = abs(tahmin - gercek) / gercek
        satirlar.append(
            {
                "tarih": str(hedef),
                "tahmin": tahmin,
                "gercek": round(gercek, 2),
                "ape": round(ape, 6),
            }
        )

    if len(satirlar) < min_ornek:
        return {
            "durum": "yetersiz_veri",
            "mesaj": "Nakit akış doğruluğu için yeterli günlük ciro geçmişi yok.",
            "dogruluk_pct": None,
            "model": "finans_core.nakit_akis_sim_backtest",
            "ornek_gun": len(satirlar),
            "satirlar": satirlar,
        }

    mape = sum(float(x["ape"]) for x in satirlar) / float(len(satirlar))
    dogruluk = max(0.0, min(100.0, (1.0 - mape) * 100.0))
    return {
        "durum": "tamam",
        "mesaj": f"Son {len(satirlar)} gün CFO backtest doğruluğu %{round(dogruluk, 2)}",
        "dogruluk_pct": round(dogruluk, 4),
        "model": "finans_core.nakit_akis_sim_backtest",
        "ornek_gun": len(satirlar),
        "satirlar": satirlar[-30:],
    }


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
    bugun = bugun_tr()
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
        bas = r['bas_tarih']
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
    bugun = bugun_tr()
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
            bas = date.fromisoformat(t['tarih'])
            gecen_o_aya = (hedef_yil - bas.year) * 12 + (hedef_ay - bas.month)
            if 0 <= gecen_o_aya < t['taksit_sayisi']:
                hedef_etki += t['aylik_taksit']

        aylar.append({
            "ay":       f"{hedef_yil}-{hedef_ay:02d}",
            "taksit_yuku": round(hedef_etki, 2),
        })
    return aylar


def kart_ekstre_forecast(cur, kart_id: str, ay_sayisi: int = 6, asgari_senaryosu: str = "odenir") -> list:
    """
    Kartın gelecek N kesim dönemi için EKSTRE TAHMİNİ — banka kesmeden önce.
    "Banka ekstresi gelmeden ekstreyi hesaplayabileyim" ihtiyacı için.

    Her dönem için:
      - ay (YYYY-MM)
      - kesim_tarihi, son_odeme_tarihi
      - tek_cekim_bilinen: o döneme ait, bugüne kadar yapılmış tek çekim harcamalar
        (gelecek dönemler için doğal olarak 0 — henüz çekilmedi)
      - taksit_payi: o ayda hâlâ aktif olan taksit kalemlerinin toplam payı
      - devreden_faiz: önceki dönem ekstresinden bu döneme aktarılan faiz
        (asgari_senaryosu'na göre tahmin)
      - ekstre_toplam = tek_cekim_bilinen + taksit_payi + devreden_faiz
      - asgari_tahmini = ekstre × kart.asgari_oran
      - kapali (bool): son_odeme tarihi geçti mi (mevcut/geçmiş dönem)
      - durum: 'gecmis' | 'acik' | 'gelecek'

    asgari_senaryosu: zincirleme faiz tahmini için varsayım
      'tam'      → her dönem tam ödeme → devreden_faiz = 0
      'odenir'   → asgari ödenir, kalan akdi faizle döner (gerçekçi default)
      'odenmez'  → hiç ödenmez, tüm ekstre gecikme faizine döner (worst case)

    NOT: Gelecek aylar için tek çekim 0 — bilinemez. Sadece bilinen taksit
    sözleşmeleri ve bilinen geçmiş harcamalar projekte edilir. Müşteri bu
    döneme yeni harcama eklerse forecast tekrar çağrılınca güncellenir.
    """
    bugun = bugun_tr()

    cur.execute("""
        SELECT id, kart_adi, kesim_gunu, son_odeme_gunu, faiz_orani,
               asgari_oran, gecikme_faiz_orani
        FROM kartlar
        WHERE id = %s AND aktif = TRUE
    """, (kart_id,))
    kart = cur.fetchone()
    if not kart:
        return []

    kesim_gunu     = int(kart['kesim_gunu'])
    son_odeme_gunu = int(kart['son_odeme_gunu'])
    akdi_yillik    = float(kart['faiz_orani'] or 0)
    asgari_oran    = kart_asgari_orani(kart)
    gecikme_yillik = float(kart.get('gecikme_faiz_orani') or 0)
    if gecikme_yillik <= 0:
        gecikme_yillik = akdi_yillik * 1.3  # TCMB ortalama fark

    aylik_akdi    = akdi_yillik    / 100.0 / 12.0
    aylik_gecikme = gecikme_yillik / 100.0 / 12.0

    # İlk dönemi belirle: bugünün KAPANMAMIŞ (henüz son_odeme geçmemiş) en yakın kesimi.
    # Yani tipik olarak ya "bu ayın kesimi" (kesim_gunu >= bugun.day) ya da "geçen ayın kesimi
    # ama son_odeme henüz geçmemiş" durumudur.
    # Basitleştirme: bu ayın kesimini ilk dönem yap; kapalıysa bir sonrakinden başla.
    bu_ay_kesim = _safe_date(bugun.year, bugun.month, kesim_gunu)
    bu_ay_son_odeme = son_odeme_tarihi_hesapla(bu_ay_kesim, son_odeme_gunu)
    if bu_ay_son_odeme < bugun:
        # Bu ayın kesimi tamamen kapanmış → bir sonraki aydan başla
        if bugun.month == 12:
            ilk_y, ilk_m = bugun.year + 1, 1
        else:
            ilk_y, ilk_m = bugun.year, bugun.month + 1
    else:
        ilk_y, ilk_m = bugun.year, bugun.month

    sonuclar = []
    devreden_faiz = 0.0  # zincirleme — bir önceki dönemden bu döneme aktarım

    for i in range(ay_sayisi):
        m = ilk_m + i
        y = ilk_y + (m - 1) // 12
        m = ((m - 1) % 12) + 1
        bu_kesim   = _safe_date(y, m, kesim_gunu)
        son_odeme  = son_odeme_tarihi_hesapla(bu_kesim, son_odeme_gunu)
        # Önceki kesim — dönem başlangıcı
        if m == 1:
            onceki_kesim = _safe_date(y - 1, 12, kesim_gunu)
        else:
            onceki_kesim = _safe_date(y, m - 1, kesim_gunu)

        # Tek çekim — bu dönem penceresinde, BUGÜNE kadar gerçekleşmiş olanlar
        cur.execute("""
            SELECT COALESCE(SUM(tutar), 0) AS t
            FROM kart_hareketleri
            WHERE kart_id = %s AND durum = 'aktif'
              AND islem_turu = 'HARCAMA' AND taksit_sayisi = 1
              AND tarih >  %s::date
              AND tarih <= LEAST(%s::date, CURRENT_DATE)
        """, (kart_id, onceki_kesim, bu_kesim))
        tek_cekim_bilinen = float(cur.fetchone()['t'])

        # Taksit payı — bu ayda aktif olan taksit kalemleri
        # Sadece bu_kesim tarihine kadar açılmış olanlar (gelecekte açılacak taksit bilinmez)
        cur.execute("""
            SELECT COALESCE(baslangic_tarihi, tarih) AS bas, tutar, taksit_sayisi
            FROM kart_hareketleri
            WHERE kart_id = %s AND durum = 'aktif'
              AND islem_turu = 'HARCAMA' AND taksit_sayisi > 1
              AND COALESCE(baslangic_tarihi, tarih) <= LEAST(%s::date, CURRENT_DATE)
        """, (kart_id, bu_kesim))
        taksit_payi = 0.0
        for r in cur.fetchall():
            bas = r['bas']
            ts  = int(r['taksit_sayisi'])
            aylik = float(r['tutar']) / ts if ts > 0 else 0.0
            gecen = (bu_kesim.year - bas.year) * 12 + (bu_kesim.month - bas.month)
            if 0 <= gecen < ts:
                taksit_payi += aylik

        ekstre = tek_cekim_bilinen + taksit_payi + devreden_faiz
        asgari = ekstre * asgari_oran

        # Sonraki dönem için zincirleme faiz hesabı (asgari_senaryosu'na göre)
        if asgari_senaryosu == "tam" or ekstre <= 0:
            sonraki_devreden = 0.0
        elif asgari_senaryosu == "odenmez":
            # Hiç ödenmez varsayımı — tüm ekstre gecikme faizine döner
            sonraki_devreden = round(ekstre * aylik_gecikme, 2)
        else:
            # 'odenir' (default) — asgari ödenir, kalan akdi faizle döner
            kalan = max(0.0, ekstre - asgari)
            sonraki_devreden = round(kalan * aylik_akdi, 2)

        if son_odeme < bugun:
            durum = "gecmis"
        elif onceki_kesim < bugun <= son_odeme:
            durum = "acik"
        else:
            durum = "gelecek"

        sonuclar.append({
            "ay":               f"{y:04d}-{m:02d}",
            "kesim_tarihi":     str(bu_kesim),
            "son_odeme_tarihi": str(son_odeme),
            "tek_cekim_bilinen": round(tek_cekim_bilinen, 2),
            "taksit_payi":      round(taksit_payi, 2),
            "devreden_faiz":    round(devreden_faiz, 2),
            "ekstre_toplam":    round(ekstre, 2),
            "asgari_tahmini":   round(asgari, 2),
            "kapali":           son_odeme < bugun,
            "durum":            durum,
        })

        devreden_faiz = sonraki_devreden

    return sonuclar


def tum_kartlar_ekstre_forecast(cur, ay_sayisi: int = 6, asgari_senaryosu: str = "odenir") -> dict:
    """
    Tüm aktif kartlar için kart_ekstre_forecast — panel/analiz için tek seferlik çağrı.
    {kart_id: [forecast_donem, ...]}
    """
    cur.execute("SELECT id FROM kartlar WHERE aktif = TRUE")
    ids = [r['id'] for r in cur.fetchall()]
    return {
        str(kid): kart_ekstre_forecast(cur, kid, ay_sayisi, asgari_senaryosu)
        for kid in ids
    }


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
    Öncelik: son_kesim_tarihi → varsayılan + tolerans + hafta sonu kaydırması.
    Hafta sonuna denk gelen kesim günleri otomatik olarak sonraki iş gününe taşınır.
    """
    import calendar as _cal
    bugun = bugun_tr()

    # Önce son_kesim_tarihi (manuel girilen gerçek tarih)
    son_kesim = kart.get('son_kesim_tarihi')
    if son_kesim:
        if isinstance(son_kesim, str):
            son_kesim = date.fromisoformat(son_kesim)
        if son_kesim.year == bugun.year and son_kesim.month == bugun.month:
            return son_kesim.day

    # Varsayılan + tolerans
    varsayilan = int(kart.get('kesim_gunu', 15))
    tolerans   = int(kart.get('kesim_tolerans', 0))
    gunu = varsayilan + tolerans

    # Hafta sonu kaydırması: Cmt(5) veya Paz(6) → sonraki Pzt
    try:
        son_gun = _cal.monthrange(bugun.year, bugun.month)[1]
        kesim = date(bugun.year, bugun.month, min(gunu, son_gun))
        while kesim.weekday() >= 5:
            kesim += timedelta(days=1)
        return kesim.day
    except Exception:
        return gunu


# ══════════════════════════════════════════════════════════════
# OTOMATİK FAİZ HESABI (TEK KAYNAK)
# ══════════════════════════════════════════════════════════════

def faiz_hesapla_ve_yaz(cur, kart_id: str, donem: str = None) -> dict:
    """
    Tek kart için otomatik faiz hesabı ve yazımı — KART KENDİ KESİM/SON_ÖDEME
    döngüsüne göre faizlenir (ay-son-gün'de top atışı yok).

    Akış (donem=None, otomatik mod):
    1. Kartın kesim_gunu/son_odeme_gunu'na göre EN SON KAPANAN kesim'i bul
       (son ödeme tarihi bugünden ÖNCE olan en yeni kesim).
    2. O kesime ait ekstre = HARCAMA(kesim-1ay, kesim] + taksit_payı + devreden_faiz
    3. O kesim ile son_ödeme arasında yapılan ÖDEME'leri topla
    4. kalan = ekstre - ödenen → faiz = kalan × aylık_oran
    5. Aynı kesim için ikinci kez yazma (duplicate guard: kesim_tarihi (kesim, kesim+32g] penceresi)

    Manuel mod (donem='YYYY-MM' veriliyse): O ay içinde düşen kesim baz alınır.
    """
    import uuid as _uuid
    bugun = bugun_tr()

    # FOR UPDATE: eş zamanlı iki faiz çağrısında aynı kart için çift yazımı önler.
    cur.execute("SELECT * FROM kartlar WHERE id = %s AND aktif = TRUE FOR UPDATE", (kart_id,))
    kart = cur.fetchone()
    if not kart:
        return {"hata": "Kart bulunamadı", "kart_id": kart_id}

    kesim_gunu     = int(kart['kesim_gunu'])
    son_odeme_gunu = int(kart['son_odeme_gunu'])

    # Hangi kesim'e faiz işleyeceğiz?
    if donem:
        # Manuel mod — o ayın kesim tarihini al, son_odeme geçmiş olmalı
        try:
            yyyy, mm = donem.split('-')
            ref_ay = _safe_date(int(yyyy), int(mm), kesim_gunu)
        except Exception:
            return {"hata": f"Geçersiz dönem: {donem}", "kart_id": kart_id}
        son_odeme_tarihi = son_odeme_tarihi_hesapla(ref_ay, son_odeme_gunu)
        if son_odeme_tarihi >= bugun:
            return {
                "kart":  kart['kart_adi'], "donem": donem,
                "durum": "henuz_son_odeme_gecmedi",
                "son_odeme_tarihi": str(son_odeme_tarihi), "faiz": 0,
            }
        kesim_tarihi = ref_ay
    else:
        # Otomatik mod — son kapanan kesimi bul
        kesim_tarihi = son_kapanan_kesim(kesim_gunu, son_odeme_gunu, bugun)
        if kesim_tarihi is None:
            return {
                "kart":  kart['kart_adi'],
                "durum": "henuz_kapanmis_kesim_yok",
                "faiz":  0,
            }
        son_odeme_tarihi = son_odeme_tarihi_hesapla(kesim_tarihi, son_odeme_gunu)

    donem_str = kesim_tarihi.strftime('%Y-%m')

    # Duplicate kontrolü — bu kesim için faiz zaten yazıldı mı?
    # Pencere: (kesim_tarihi, kesim_tarihi + 32 gün] — bir sonraki kesimden önce
    cur.execute("""
        SELECT id FROM kart_hareketleri
        WHERE kart_id = %s AND islem_turu = 'FAIZ' AND durum = 'aktif'
        AND tarih >  %s::date
        AND tarih <= %s::date + INTERVAL '32 days'
    """, (kart_id, kesim_tarihi, kesim_tarihi))
    if cur.fetchone():
        return {
            "kart":  kart['kart_adi'], "donem": donem_str,
            "kesim_tarihi": str(kesim_tarihi),
            "durum": "zaten_yazilmis", "faiz": 0,
        }

    # Ekstre hesapla — explicit kesim_tarihi ile (Mod 2)
    ekstre_v  = kart_ekstre(cur, kart_id, kesim_gunu, kesim_tarihi=kesim_tarihi)
    bu_ekstre = ekstre_v["ekstre_toplam"]

    if bu_ekstre <= 0:
        return {
            "kart":  kart['kart_adi'], "donem": donem_str,
            "kesim_tarihi": str(kesim_tarihi),
            "durum": "ekstre_yok", "faiz": 0,
        }

    # Bu kesim ile son_odeme arasında yapılan ödemeler
    cur.execute("""
        SELECT COALESCE(SUM(tutar), 0) AS odenen
        FROM kart_hareketleri
        WHERE kart_id = %s AND islem_turu = 'ODEME' AND durum = 'aktif'
        AND tarih >  %s::date
        AND tarih <= %s::date
    """, (kart_id, kesim_tarihi, son_odeme_tarihi))
    odenen = float(cur.fetchone()['odenen'])

    kalan = max(0.0, bu_ekstre - odenen)
    if kalan <= 0:
        return {
            "kart":  kart['kart_adi'], "donem": donem_str,
            "kesim_tarihi": str(kesim_tarihi),
            "durum": "tam_odendi",
            "bu_ekstre": bu_ekstre, "odenen": odenen, "faiz": 0,
        }

    # ── AKDİ vs GECİKME FAİZİ AYRIMI ──────────────────────────
    # Asgari tutar = ekstre × asgari_oran (kartın kendi oranı, tek kaynak: kart_asgari_orani)
    # Asgari ödendiyse: kalan üzerine AKDİ faizi
    # Asgari ödenmediyse: kalan üzerine GECİKME faizi (akdi'den yüksek)
    asgari = bu_ekstre * kart_asgari_orani(kart)
    asgari_odendi = odenen >= asgari * 0.999  # epsilon: küçük yuvarlama farklarını tolere et

    akdi_oran    = float(kart['faiz_orani'])
    if asgari_odendi:
        oran      = akdi_oran
        faiz_turu = "akdi"
    else:
        gecikme_oran = float(kart.get('gecikme_faiz_orani') or 0)
        if gecikme_oran <= 0:
            # Kart için gecikme oranı tanımlanmamış → akdi × 1.3 fallback
            # (TCMB ortalama akdi/gecikme farkı ~1.3 katı)
            gecikme_oran = akdi_oran * 1.3
        oran      = gecikme_oran
        faiz_turu = "gecikme"

    faiz_tutari = kart_faiz_tahmini(oran, kalan)
    if faiz_tutari < 0.01:
        return {
            "kart":  kart['kart_adi'], "donem": donem_str,
            "kesim_tarihi": str(kesim_tarihi),
            "durum": "faiz_cok_kucuk", "faiz": 0,
        }

    # Yaz — kasaya dokunma. Tarih = bugün (faizin yazıldığı an).
    fid = str(_uuid.uuid4())
    aciklama = (
        f"{donem_str} kesim faizi [{faiz_turu.upper()}] "
        f"(kesim:{kesim_tarihi}, son_odeme:{son_odeme_tarihi}, "
        f"ekstre:{bu_ekstre:.2f}, ödenen:{odenen:.2f}, "
        f"asgari:{asgari:.2f}, kalan:{kalan:.2f}, oran:%{oran:.2f})"
    )
    cur.execute("""
        INSERT INTO kart_hareketleri
            (id, kart_id, tarih, islem_turu, tutar, faiz_tutari, aciklama)
        VALUES (%s, %s, %s, 'FAIZ', %s, %s, %s)
    """, (fid, kart_id, str(bugun), faiz_tutari, faiz_tutari, aciklama))

    return {
        "id":               fid,
        "kart":             kart['kart_adi'],
        "donem":            donem_str,
        "kesim_tarihi":     str(kesim_tarihi),
        "son_odeme_tarihi": str(son_odeme_tarihi),
        "durum":            "yazildi",
        "bu_ekstre":        bu_ekstre,
        "odenen":           odenen,
        "asgari":           asgari,
        "asgari_odendi":    asgari_odendi,
        "kalan":            kalan,
        "faiz_turu":        faiz_turu,
        "faiz_orani":       oran,
        "akdi_orani":       akdi_oran,
        "faiz":             faiz_tutari,
    }


def tum_kartlar_faiz_hesapla(cur, donem: str = None, lookback_months: int = 3) -> list:
    """
    Tüm aktif kartlar için faiz_hesapla_ve_yaz çağırır.
    Tek entry point — başka faiz fonksiyonu yoktur.

    donem verilmediyse (otomatik mod): son `lookback_months` ayı tarar,
    her ay için her kartı dener. Kapanmış (son_odeme geçmiş) ve faizi yazılmamış
    döngüler için faiz işler. Duplicate guard zaten yazılmış olanları
    "zaten_yazilmis" döner, son_odeme henüz geçmemişler "henuz_son_odeme_gecmedi"
    döner — safe to re-run.

    NEDEN lookback>=2: kesim_gunu > son_odeme_gunu olan kartlarda son_odeme
    sonraki aya düşer (örn. kesim 25 / son_odeme 10). Bu durumda bu ayın
    kesimi henüz kapanmamış olur, geçen ayın kesiminin faizi şimdi yazılır.
    Yani 1 aylık tarama matematiksel olarak yetersiz.

    NEDEN lookback=3 (4 değil): +1 ay = 30 günlük downtime telafisi sağlar
    (Railway/sunucu kesintisi için yeterli). Her gece scheduler tekrar
    çalıştığı için birikme/yığılma olmaz, fazla geri tarama gereksiz iş.

    donem verilmişse (manuel mod): sadece o ay tek seferlik işlenir.
    """
    cur.execute("SELECT id FROM kartlar WHERE aktif = TRUE")
    kartlar = [r['id'] for r in cur.fetchall()]

    if donem:
        return [faiz_hesapla_ve_yaz(cur, kid, donem) for kid in kartlar]

    # Otomatik telafi modu — bugünden geriye lookback_months ayı listele
    bugun = bugun_tr()
    aylar = []  # YYYY-MM, en eski → en yeni (eskiyi önce işlersek bileşik faiz zinciri doğru kurulur)
    for i in range(lookback_months - 1, -1, -1):
        y, m = bugun.year, bugun.month - i
        while m <= 0:
            m += 12
            y -= 1
        aylar.append(f"{y:04d}-{m:02d}")

    sonuclar = []
    for d in aylar:
        for kid in kartlar:
            sonuclar.append(faiz_hesapla_ve_yaz(cur, kid, d))
    return sonuclar


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
