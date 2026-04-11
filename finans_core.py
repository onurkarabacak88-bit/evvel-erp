"""
finans_core.py — EVVEL ERP Hesap Merkezi
==========================================
KURAL: Finansal hesaplar SADECE buradadir.
SQL veri getirir, bu modul hesap yapar.
Diger modüller bu fonksiyonlari cagirır, kendi SQL hesabi YAZMAZ.

Kapsam:
  - Kasa bakiyesi
  - Kart borcu (devreden toplam / revolving)
  - Dönem borcu + bankacılık tarzı asgari ödeme (tek kaynak: kart_bankacilik_ozet)
  - Kart ekstresi
  - Ödeme yukü (7/15/30 gun)
  - Zorunlu gider tahmini
  - Gunluk ciro ortalamasi
  - Nakit akis simulasyonu
  - Kart limit dolulugu
  - Faiz tahmini
"""

import calendar
from datetime import date, datetime, timedelta


def _kesim_tarihi(yil: int, ay: int, kesim_gunu: int) -> date:
    """Ay sonunu aşan kesim günlerini ayın son gününe çeker."""
    son = calendar.monthrange(yil, ay)[1]
    return date(yil, ay, min(int(kesim_gunu), son))


def kart_ekstre_donem_tarihleri(bugun: date, kesim_gunu: int) -> tuple[date, date]:
    """
    Açık ekstre dönemi [donem_bas, donem_bit] (her iki uç dahil).
    donem_bit = bugünü kapsayan ilk gelecek kesim günü.
    donem_bas = bir önceki kesim + 1 gün.
    Kesim sonrası yapılan tek çekimler bir sonraki kapanışa birikir.
    """
    kg = int(kesim_gunu)

    def sonraki_kesim(b: date) -> date:
        t = _kesim_tarihi(b.year, b.month, kg)
        if b <= t:
            return t
        if b.month == 12:
            return _kesim_tarihi(b.year + 1, 1, kg)
        return _kesim_tarihi(b.year, b.month + 1, kg)

    bitis = sonraki_kesim(bugun)
    if bitis.month == 1:
        onceki_kesim = _kesim_tarihi(bitis.year - 1, 12, kg)
    else:
        onceki_kesim = _kesim_tarihi(bitis.year, bitis.month - 1, kg)
    baslangic = onceki_kesim + timedelta(days=1)
    return baslangic, bitis


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
        WHERE kasa_etkisi = true AND durum = 'aktif'
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
    Banka ekstresine yakın “açık dönem” harcaması.

    - Tek çekim: önceki kesim +1 ile sonraki kesim (dahil) arasındaki HARCAMA.
      Kesimden sonra yapılanlar bir sonraki kapanışa yazılır (takvim ayından bağımsız).
    - Taksit: aktif taksitli harcamaların aylık payı (her dönemde ekstrede yer alır).

    Ek alanlar: dönem tarihleri, sonraki kapanışa biriken tek çekim (ekstre gelmeden önizleme),
    kapanışa kalan gün.
    """
    bugun = date.today()
    donem_bas, donem_bit = kart_ekstre_donem_tarihleri(bugun, kesim_gunu)

    cur.execute("""
        SELECT COALESCE(SUM(tutar), 0) AS tek_cekim
        FROM kart_hareketleri
        WHERE kart_id = %s AND durum = 'aktif'
        AND islem_turu = 'HARCAMA' AND taksit_sayisi = 1
        AND tarih >= %s AND tarih <= %s
    """, (kart_id, donem_bas, donem_bit))
    tek_cekim = float(cur.fetchone()['tek_cekim'])

    # Bir sonraki ekstre dönemi: mevcut kapanıştan sonraki günden itibaren (ekstre gelmeden önizleme)
    sonraki_donem_bas = donem_bit + timedelta(days=1)
    sonraki_donem_bit = kart_ekstre_donem_tarihleri(sonraki_donem_bas, kesim_gunu)[1]
    sonraki_donem_simdiye_kadar_tek = 0.0
    if bugun >= sonraki_donem_bas:
        son = min(bugun, sonraki_donem_bit)
        cur.execute("""
            SELECT COALESCE(SUM(tutar), 0) AS t
            FROM kart_hareketleri
            WHERE kart_id = %s AND durum = 'aktif'
            AND islem_turu = 'HARCAMA' AND taksit_sayisi = 1
            AND tarih >= %s AND tarih <= %s
        """, (kart_id, sonraki_donem_bas, son))
        sonraki_donem_simdiye_kadar_tek = float(cur.fetchone()['t'])

    # Taksitli harcamalar: tüm zamanlardan aylık taksit payı
    cur.execute("""
        SELECT COALESCE(SUM(tutar::float / NULLIF(taksit_sayisi, 0)), 0) AS aylik_taksit
        FROM kart_hareketleri
        WHERE kart_id = %s AND durum = 'aktif'
        AND islem_turu = 'HARCAMA' AND taksit_sayisi > 1
    """, (kart_id,))
    aylik_taksit = float(cur.fetchone()['aylik_taksit'])

    ekstre = tek_cekim + aylik_taksit
    kalan_gun = (donem_bit - bugun).days
    tahmini_sonraki_kapanis_simdi = round(sonraki_donem_simdiye_kadar_tek + aylik_taksit, 2)

    return {
        "tek_cekim": tek_cekim,
        "aylik_taksit": aylik_taksit,
        "ekstre_toplam": ekstre,
        "donem_bas": str(donem_bas),
        "donem_bit": str(donem_bit),
        "sonraki_donem_bas": str(sonraki_donem_bas),
        "sonraki_donem_bit": str(sonraki_donem_bit),
        "sonraki_donem_simdiye_kadar_tek": sonraki_donem_simdiye_kadar_tek,
        "tahmini_sonraki_kapanis_ekstre_simdi": tahmini_sonraki_kapanis_simdi,
        "kapanisa_kalan_gun": kalan_gun,
    }


def kart_bu_ay_odenen(cur, kart_id: str) -> float:
    """
    Bu takvim ayında odeme_plani üzerinden ödenen tutar (rapor / geriye dönük).
    Faiz motoru için `kart_donem_odenen` kullanılır.
    """
    cur.execute("""
        SELECT COALESCE(SUM(odenen_tutar), 0) AS odenen
        FROM odeme_plani
        WHERE kart_id = %s AND durum = 'odendi'
        AND EXTRACT(YEAR  FROM COALESCE(odeme_tarihi, tarih)) = EXTRACT(YEAR  FROM CURRENT_DATE)
        AND EXTRACT(MONTH FROM COALESCE(odeme_tarihi, tarih)) = EXTRACT(MONTH FROM CURRENT_DATE)
    """, (kart_id,))
    return float(cur.fetchone()['odenen'])


def kart_donem_odenen(cur, kart_id: str, donem_bas: date, donem_bit: date) -> float:
    """
    Açık ekstre dönemi [donem_bas, donem_bit] içinde gerçekleşen kart ödemeleri
    (odeme_plani, odendi). Tarih: odeme_tarihi yoksa plan tarihi.
    """
    cur.execute("""
        SELECT COALESCE(SUM(odenen_tutar), 0) AS odenen
        FROM odeme_plani
        WHERE kart_id = %s AND durum = 'odendi'
        AND COALESCE(odeme_tarihi, tarih) >= %s
        AND COALESCE(odeme_tarihi, tarih) <= %s
    """, (kart_id, donem_bas, donem_bit))
    return float(cur.fetchone()['odenen'])


def kart_odeme_uyari_metrikleri(
    cur, kart_id: str, son_odeme_gunu: int, bugun: date = None
) -> dict:
    """
    Panel / analiz: gun_kaldi ve blink.
    Bekleyen odeme_plani varsa tarih o satırdan alınır; blink yalnızca vade
    bugün veya geçmişse (kart son ödeme günü ile plan tarihi çakışmayınca erken SON GÜN önlenir).
    Plan yoksa blink kapalı; gun_kaldi bilgi amaçlı son ödeme gününe göre.
    """
    if bugun is None:
        bugun = date.today()
    cur.execute("""
        SELECT tarih FROM odeme_plani
        WHERE kart_id = %s AND durum IN ('bekliyor', 'onay_bekliyor')
        ORDER BY tarih ASC LIMIT 1
    """, (kart_id,))
    row = cur.fetchone()
    if row:
        pt = row["tarih"]
        if isinstance(pt, datetime):
            pt = pt.date()
        elif isinstance(pt, str):
            pt = date.fromisoformat(pt[:10])
        gk = (pt - bugun).days
        return {
            "gun_kaldi": gk,
            "blink": pt <= bugun,
            "son_odeme_tarihi": str(pt),
        }
    kg = int(son_odeme_gunu or 25)
    last = calendar.monthrange(bugun.year, bugun.month)[1]
    d = min(kg, last)
    son_odeme = date(bugun.year, bugun.month, d)
    if son_odeme < bugun:
        y, m = bugun.year, bugun.month + 1
        if m > 12:
            y, m = y + 1, 1
        last2 = calendar.monthrange(y, m)[1]
        son_odeme = date(y, m, min(kg, last2))
    gk2 = (son_odeme - bugun).days
    return {
        "gun_kaldi": gk2,
        "blink": False,
        "son_odeme_tarihi": str(son_odeme),
    }


def kart_faiz_tahmini(faiz_orani_yillik: float, kalan_ekstre: float) -> float:
    """
    Ödenmemiş ekstre bakiyesi üzerinden dönem faiz tahmini.

    Model: nominal yıllık oranın 12’ye bölünmesi (basit aylık oran × kalan).
    Gerçek kart sözleşmelerinde bileşik faiz, gecikme, vergi ve banka
    tarifesi farklı olabilir; bu ERP için sadeleştirilmiş yaklaşımdır.

    faiz_orani_yillik: örn. 42 → %42 yıllık nominal
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
    7 / 15 / 30 günlük nakit baskısı ve asgari ödeme toplamları.
    Kart planı satırlarında t7/t15/t30 için asgari tutar kullanılır (yoksa %40 kabı);
    maaş / borç / sabit gider satırlarında tam odenecek_tutar sayılır.
    """
    if bugun is None:
        bugun = date.today()

    # Kart satırlarında baskı = asgari (yoksa kabaca %40); diğer ödemelerde tam tutar
    cur.execute("""
        SELECT
            COALESCE(SUM(CASE WHEN tarih <= %s + INTERVAL '7 days'
                THEN (CASE WHEN kart_id IS NOT NULL
                      THEN COALESCE(asgari_tutar, odenecek_tutar * 0.4)
                      ELSE odenecek_tutar END) ELSE 0 END), 0) AS t7,
            COALESCE(SUM(CASE WHEN tarih <= %s + INTERVAL '15 days'
                THEN (CASE WHEN kart_id IS NOT NULL
                      THEN COALESCE(asgari_tutar, odenecek_tutar * 0.4)
                      ELSE odenecek_tutar END) ELSE 0 END), 0) AS t15,
            COALESCE(SUM(CASE WHEN tarih <= %s + INTERVAL '30 days'
                THEN (CASE WHEN kart_id IS NOT NULL
                      THEN COALESCE(asgari_tutar, odenecek_tutar * 0.4)
                      ELSE odenecek_tutar END) ELSE 0 END), 0) AS t30,
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
        bas = r["bas_tarih"]
        if isinstance(bas, datetime):
            bas = bas.date()
        elif isinstance(bas, str):
            bas = date.fromisoformat(bas[:10])
        taksit_sayisi = int(r["taksit_sayisi"])
        aylik_taksit = float(r["tutar"]) / taksit_sayisi

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
            "bas_tarih":      str(bas),
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
            bas = date.fromisoformat(str(t["bas_tarih"])[:10])
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
    """
    import calendar as _cal
    bugun = date.today()

    # Önce son_kesim_tarihi
    son_kesim = kart.get('son_kesim_tarihi')
    if son_kesim:
        if isinstance(son_kesim, str):
            son_kesim = date.fromisoformat(son_kesim)
        # son_kesim bu ay içindeyse onu kullan
        if son_kesim.year == bugun.year and son_kesim.month == bugun.month:
            return son_kesim.day

    # Varsayılan kesim günü + tolerans
    varsayilan = int(kart.get('kesim_gunu', 15))
    tolerans   = int(kart.get('kesim_tolerans', 0))
    return varsayilan + tolerans


# ══════════════════════════════════════════════════════════════
# BANKACILIK TARZI DÖNEM BORCU VE ASGARİ (TEK KAYNAK)
# ══════════════════════════════════════════════════════════════
# BDDK / banka tarifesi birebir değildir; asgari tabanı dönem borcu,
# tavan toplam borç, oran kart.asgari_oran ile uyumludur.

ASGARI_ODEME_MIN_TL = 0.0  # İstenirse ileride kart veya global taban yapılabilir


def kart_bu_ay_aktif_faiz_toplam(cur, kart_id: str) -> float:
    """Bu takvim ayında kayıtlı aktif FAIZ satırlarının toplamı (dönem faturası bileşeni)."""
    cur.execute("""
        SELECT COALESCE(SUM(tutar), 0) AS t
        FROM kart_hareketleri
        WHERE kart_id = %s AND durum = 'aktif' AND islem_turu = 'FAIZ'
        AND EXTRACT(YEAR FROM tarih) = EXTRACT(YEAR FROM CURRENT_DATE)
        AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
    """, (kart_id,))
    return float(cur.fetchone()['t'])


def kart_donem_borcu_bankacilik(cur, kart_id: str, kart_row: dict) -> dict:
    """
    Dönem borcu: kesime göre hesaplanan harcama ekstresi + bu ay yansıyan faiz.
    Asgari ödeme tabanında kullanılır (ekstre borcundan bağımsız devreden bakiye
    ile karışmaması için önce dönem tutarı, yoksa toplam borç kullanılır).
    """
    kr = dict(kart_row) if kart_row is not None else {}
    kesim = aktif_kesim_gunu(kr)
    ek = kart_ekstre(cur, kart_id, kesim)
    harcama_ek = float(ek["ekstre_toplam"])
    faiz_ay = kart_bu_ay_aktif_faiz_toplam(cur, kart_id)
    donem = round(harcama_ek + faiz_ay, 2)
    return {
        "kesim_gunu_kullanilan": kesim,
        "ekstre_harcama_donemi": harcama_ek,
        "tek_cekim": float(ek["tek_cekim"]),
        "aylik_taksit_payi": float(ek["aylik_taksit"]),
        "faiz_bu_ay_kayitli": faiz_ay,
        "donem_borcu": donem,
        "ekstre_donem_bas": ek.get("donem_bas"),
        "ekstre_donem_bit": ek.get("donem_bit"),
        "kapanisa_kalan_gun": ek.get("kapanisa_kalan_gun"),
        "sonraki_donem_bas": ek.get("sonraki_donem_bas"),
        "sonraki_donem_bit": ek.get("sonraki_donem_bit"),
        "sonraki_donem_simdiye_kadar_tek": ek.get("sonraki_donem_simdiye_kadar_tek", 0),
        "tahmini_sonraki_kapanis_ekstre_simdi": ek.get("tahmini_sonraki_kapanis_ekstre_simdi", 0),
    }


def kart_asgari_odeme_bankacilik(cur, kart_id: str, kart_row: dict) -> float:
    """
    Asgari ödeme: max(min_TL, min(toplam_borc, taban × asgari_oran)).
    - taban = dönem_borcu (>0) ise dönem; aksi halde toplam borç (devreden dönem).
    - asgari_oran: kart tanımı (varsayılan %40), banka tarifesine göre düzenlenir.
    """
    borc = kart_borc(cur, kart_id)
    if borc <= 0:
        return 0.0
    kr = dict(kart_row) if kart_row is not None else {}
    db = kart_donem_borcu_bankacilik(cur, kart_id, kr)
    donem = db["donem_borcu"]
    oran_pct = float(kr.get("asgari_oran") or 40)
    if oran_pct <= 0:
        oran_pct = 40.0
    r = oran_pct / 100.0
    taban = donem if donem > 1e-6 else borc
    ham = taban * r
    asgari = max(ASGARI_ODEME_MIN_TL, min(borc, round(ham, 2)))
    return asgari


def kart_bankacilik_ozet(cur, kart_id: str, kart_row: dict) -> dict:
    """
    Kart listesi, ödeme planı ve analiz için tek çıktı.
    """
    borc = kart_borc(cur, kart_id)
    kr = dict(kart_row) if kart_row is not None else {}
    db = kart_donem_borcu_bankacilik(cur, kart_id, kr)
    asgari = kart_asgari_odeme_bankacilik(cur, kart_id, kr) if borc > 0 else 0.0
    oran_pct = float(kr.get("asgari_oran") or 40)
    if oran_pct <= 0:
        oran_pct = 40.0
    taban = db["donem_borcu"] if db["donem_borcu"] > 1e-6 else borc
    return {
        **db,
        "toplam_borc": borc,
        "asgari_oran_yuzde": oran_pct,
        "asgari_taban_tutar": round(taban, 2),
        "asgari_odeme": asgari,
    }


# ══════════════════════════════════════════════════════════════
# OTOMATİK FAİZ HESABI (TEK KAYNAK)
# ══════════════════════════════════════════════════════════════

def faiz_hesapla_ve_yaz(cur, kart_id: str, donem: str = None) -> dict:
    """
    Tek kart için otomatik faiz hesabı ve yazımı.
    donem: 'YYYY-MM' formatında (cevapta/etikette). None ise bu ay.

    Akış:
    1. Ekstre hesapla (aktif kesim gününe göre)
    2. Ödenen bul — aynı ekstre dönemi [donem_bas, donem_bit] içindeki ödemeler
    3. Kalan = ekstre - ödenen
    4. Kalan > 0 ise → faiz = kalan × aylık_oran
    5. Kart_hareketleri'ne FAIZ tipiyle yaz
    6. Kasaya dokunma
    7. Aynı ekstre dönemi için 2 kez yazma (duplicate engel)
    """
    bugun = date.today()
    if donem is None:
        donem = bugun.strftime('%Y-%m')

    cur.execute("SELECT * FROM kartlar WHERE id = %s AND aktif = TRUE", (kart_id,))
    kart = cur.fetchone()
    if not kart:
        return {"hata": "Kart bulunamadı", "kart_id": kart_id}

    kesim = aktif_kesim_gunu(dict(kart))
    ekstre_v = kart_ekstre(cur, kart_id, kesim)
    donem_bas_d = date.fromisoformat(ekstre_v["donem_bas"])
    donem_bit_d = date.fromisoformat(ekstre_v["donem_bit"])
    legacy_month = ekstre_v["donem_bit"][:7]
    periyot_tag = f"[ekstre:{ekstre_v['donem_bas']}|{ekstre_v['donem_bit']}]"

    # Duplicate — aynı ekstre penceresi veya eski ay etiketi
    cur.execute("""
        SELECT id FROM kart_hareketleri
        WHERE kart_id = %s AND islem_turu = 'FAIZ' AND durum = 'aktif'
        AND (aciklama LIKE %s OR aciklama LIKE %s)
    """, (kart_id, f"%{periyot_tag}%", f"%{legacy_month} dönem faizi%"))
    if cur.fetchone():
        return {
            "kart":   kart['kart_adi'],
            "donem":  donem,
            "durum":  "zaten_yazilmis",
            "faiz":   0,
        }

    bu_ekstre = ekstre_v["ekstre_toplam"]

    if bu_ekstre <= 0:
        return {
            "kart":   kart['kart_adi'],
            "donem":  donem,
            "durum":  "ekstre_yok",
            "faiz":   0,
        }

    odenen = kart_donem_odenen(cur, kart_id, donem_bas_d, donem_bit_d)

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
          f"{periyot_tag} {legacy_month} dönem faizi (kalan:{kalan:.2f})"))

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
