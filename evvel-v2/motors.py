from database import db
from datetime import date, timedelta

# ─────────────────────────────────────────
# EVVEL ERP — KARAR + STRATEJİ MOTORU
# ─────────────────────────────────────────

def guncel_kasa():
    with db() as (conn, cur):
        cur.execute("""
            SELECT COALESCE(SUM(
                CASE WHEN islem_turu IN ('CIRO','KASA_GIRIS') THEN tutar
                     ELSE -tutar END
            ), 0) as kasa
            FROM kasa_hareketleri WHERE durum='aktif'
        """)
        return float(cur.fetchone()['kasa'])

def karar_motoru():
    bugun = date.today()
    kararlar = []

    with db() as (conn, cur):
        kasa = guncel_kasa()

        # 7 günlük bekleyen ödemeler
        cur.execute("""
            SELECT COALESCE(SUM(odenecek_tutar),0) as toplam
            FROM odeme_plani
            WHERE durum='bekliyor'
            AND tarih BETWEEN %s AND %s
        """, (bugun, bugun + timedelta(days=7)))
        odeme_7 = float(cur.fetchone()['toplam'])

        # Asgari ödemeler toplamı
        cur.execute("""
            SELECT COALESCE(SUM(asgari_tutar),0) as toplam
            FROM odeme_plani
            WHERE durum='bekliyor'
            AND tarih BETWEEN %s AND %s
        """, (bugun, bugun + timedelta(days=7)))
        asgari_7 = float(cur.fetchone()['toplam'])

        # KURAL 1: Ödeme riski
        if kasa < odeme_7:
            kararlar.append({
                "kural": 1, "seviye": "KRITIK", "renk": "KIRMIZI",
                "baslik": "Ödeme Riski",
                "mesaj": f"Kasa ({fmt(kasa)}) 7 günlük ödeme yükünü ({fmt(odeme_7)}) karşılamıyor.",
                "aksiyon": "Acil nakit girişi veya ödeme erteleme gerekli",
                "blink": True
            })

        # KURAL 2: Asgari ödeme yapılabilir
        elif kasa >= asgari_7 and asgari_7 > 0:
            kararlar.append({
                "kural": 2, "seviye": "UYARI", "renk": "SARI",
                "baslik": "Asgari Ödeme Yapılabilir",
                "mesaj": f"Kasa asgari ödemeyi ({fmt(asgari_7)}) karşılıyor. Tam ödeme için yeterli değil.",
                "aksiyon": "Asgari ödeme yapılabilir",
                "blink": False
            })

        # KURAL 3: Bugün son ödeme günü olan kartlar
        cur.execute("""
            SELECT op.*, k.banka, k.kart_adi FROM odeme_plani op
            JOIN kartlar k ON k.id=op.kart_id
            WHERE op.durum='bekliyor' AND op.tarih=%s
        """, (bugun,))
        bugun_odemeler = cur.fetchall()
        for o in bugun_odemeler:
            kararlar.append({
                "kural": 4, "seviye": "KRITIK", "renk": "KIRMIZI",
                "baslik": f"SON GÜN: {o['banka']}",
                "mesaj": f"{o['kart_adi']} için son ödeme tarihi BUGÜN! Tutar: {fmt(o['odenecek_tutar'])}",
                "aksiyon": "Ödemeyi hemen yap",
                "blink": True,
                "kart_id": o['kart_id'],
                "odeme_id": o['id']
            })

        # KURAL 4: Vadeli alım hatırlatma (7 gün)
        cur.execute("""
            SELECT * FROM vadeli_alimlar
            WHERE durum='bekliyor'
            AND vade_tarihi BETWEEN %s AND %s
        """, (bugun, bugun + timedelta(days=7)))
        vadeli = cur.fetchall()
        for v in vadeli:
            gun_kaldi = (v['vade_tarihi'] - bugun).days
            kararlar.append({
                "kural": 6, "seviye": "UYARI", "renk": "TURUNCU",
                "baslik": f"Vadeli Alım: {v['aciklama']}",
                "mesaj": f"{gun_kaldi} gün sonra {fmt(v['tutar'])} ödeme vadesi geliyor.",
                "aksiyon": "Nakit planını güncelle",
                "blink": False
            })

        # KURAL 5: 10 gün simülasyon — kasa negatife düşecek mi?
        cur.execute("""
            SELECT COALESCE(AVG(gunluk),0) as ort FROM (
                SELECT tarih, SUM(toplam) as gunluk FROM ciro
                WHERE tarih >= CURRENT_DATE - INTERVAL '30 days'
                GROUP BY tarih
            ) t
        """)
        gunluk_ciro = float(cur.fetchone()['ort'])

        cur.execute("""
            SELECT tarih, SUM(odenecek_tutar) as toplam
            FROM odeme_plani WHERE durum='bekliyor'
            AND tarih BETWEEN %s AND %s
            GROUP BY tarih ORDER BY tarih
        """, (bugun, bugun + timedelta(days=10)))
        gelecek_odemeler = cur.fetchall()

        sim_kasa = kasa
        for gun in gelecek_odemeler:
            sim_kasa += gunluk_ciro
            sim_kasa -= float(gun['toplam'])
            if sim_kasa < 0:
                kararlar.append({
                    "kural": 5, "seviye": "UYARI", "renk": "TURUNCU",
                    "baslik": "Nakit Akışı Bozulacak",
                    "mesaj": f"{gun['tarih']} tarihinde kasa negatife düşecek. {fmt(gun['toplam'])} ödeme var.",
                    "aksiyon": "Nakit akışını düzenle",
                    "blink": False
                })
                break

        kritik = sum(1 for k in kararlar if k['seviye'] == 'KRITIK')
        uyari = sum(1 for k in kararlar if k['seviye'] == 'UYARI')
        genel = 'KRITIK' if kritik > 0 else 'UYARI' if uyari > 0 else 'SAGLIKLI'

        return {
            "genel_durum": genel,
            "kasa": kasa,
            "odeme_7_gun": odeme_7,
            "asgari_7_gun": asgari_7,
            "kararlar": kararlar,
            "ozet": {"kritik": kritik, "uyari": uyari}
        }

def odeme_strateji_motoru():
    """
    19. Modül: Ödeme Strateji Motoru
    Faiz oranı + nakit + vade bazlı öneri üretir
    """
    bugun = date.today()
    oneriler = []

    with db() as (conn, cur):
        kasa = guncel_kasa()

        # 30 günlük zorunlu giderler (maaş, kira, borç taksiti)
        cur.execute("""
            SELECT COALESCE(SUM(tutar),0) as toplam FROM sabit_giderler
            WHERE aktif=TRUE
        """)
        sabit_aylik = float(cur.fetchone()['toplam'])

        cur.execute("""
            SELECT COALESCE(SUM(aylik_taksit),0) as toplam
            FROM borc_envanteri WHERE aktif=TRUE
        """)
        borc_aylik = float(cur.fetchone()['toplam'])

        cur.execute("""
            SELECT COALESCE(SUM(maas + yemek_ucreti + yol_ucreti),0) as toplam
            FROM personel WHERE aktif=TRUE AND calisma_turu='surekli'
        """)
        personel_aylik = float(cur.fetchone()['toplam'])

        zorunlu_giderler = sabit_aylik + borc_aylik + personel_aylik
        kullanilabilir_nakit = kasa - zorunlu_giderler

        # Bekleyen kart ödemeleri — faiz oranına göre sırala
        cur.execute("""
            SELECT op.*, k.banka, k.kart_adi, k.faiz_orani, k.son_odeme_gunu
            FROM odeme_plani op
            JOIN kartlar k ON k.id=op.kart_id
            WHERE op.durum='bekliyor'
            AND op.tarih >= %s
            ORDER BY k.faiz_orani DESC, op.tarih ASC
        """, (bugun,))
        bekleyen_odemeler = cur.fetchall()

        for o in bekleyen_odemeler:
            gun_kaldi = (o['tarih'] - bugun).days
            tam_odeme = float(o['odenecek_tutar'])
            asgari = float(o['asgari_tutar'] or tam_odeme * 0.2)
            faiz = float(o['faiz_orani'] or 0)
            aylik_faiz_maliyet = (tam_odeme - asgari) * (faiz / 100)

            if gun_kaldi == 0:
                # Son gün — mutlaka öde
                oneri = {
                    "kart_id": o['kart_id'],
                    "odeme_id": str(o['id']),
                    "kart_adi": o['kart_adi'],
                    "banka": o['banka'],
                    "oneri_turu": "HEMEN_ODE",
                    "renk": "KIRMIZI",
                    "baslik": f"🔴 {o['banka']} — BUGÜN ÖDE",
                    "aciklama": f"Son gün bugün. Asgari: {fmt(asgari)}",
                    "tavsiye_tutar": asgari if kullanilabilir_nakit < tam_odeme else tam_odeme,
                    "blink": True
                }
                kullanilabilir_nakit -= oneri['tavsiye_tutar']

            elif kullanilabilir_nakit >= tam_odeme and faiz > 2:
                # Yüksek faizli kart — tam öde
                faiz_tasarrufu = aylik_faiz_maliyet
                oneri = {
                    "kart_id": o['kart_id'],
                    "odeme_id": str(o['id']),
                    "kart_adi": o['kart_adi'],
                    "banka": o['banka'],
                    "oneri_turu": "TAM_ODE",
                    "renk": "TURUNCU",
                    "baslik": f"🟠 {o['banka']} — TAM ÖDE (Faiz Riski)",
                    "aciklama": f"Faiz oranı %{faiz}. Ertelersen {fmt(faiz_tasarrufu)} faiz ödersin.",
                    "tavsiye_tutar": tam_odeme,
                    "blink": False
                }
                kullanilabilir_nakit -= tam_odeme

            elif kullanilabilir_nakit >= asgari:
                # Asgari ödeme yap
                oneri = {
                    "kart_id": o['kart_id'],
                    "odeme_id": str(o['id']),
                    "kart_adi": o['kart_adi'],
                    "banka": o['banka'],
                    "oneri_turu": "ASGARI_ODE",
                    "renk": "SARI",
                    "baslik": f"🟡 {o['banka']} — ASGARİ ÖDE",
                    "aciklama": f"Kasada tam ödeme için yer yok. Asgari: {fmt(asgari)}",
                    "tavsiye_tutar": asgari,
                    "blink": False
                }
                kullanilabilir_nakit -= asgari

            else:
                # Ertele
                oneri = {
                    "kart_id": o['kart_id'],
                    "odeme_id": str(o['id']),
                    "kart_adi": o['kart_adi'],
                    "banka": o['banka'],
                    "oneri_turu": "ERTELE",
                    "renk": "GRI",
                    "baslik": f"⏳ {o['banka']} — {gun_kaldi} GÜN ERTELE",
                    "aciklama": f"Kasada yeterli nakit yok. Son gün: {o['tarih']}",
                    "tavsiye_tutar": 0,
                    "blink": False
                }

            oneriler.append(oneri)

        return {
            "kasa": kasa,
            "kullanilabilir_nakit": kullanilabilir_nakit,
            "zorunlu_giderler": zorunlu_giderler,
            "oneriler": oneriler,
            "toplam_oneri_tutari": sum(o['tavsiye_tutar'] for o in oneriler)
        }

def nakit_akis_simulasyon(gun_sayisi=15):
    bugun = date.today()
    with db() as (conn, cur):
        kasa = guncel_kasa()

        cur.execute("""
            SELECT COALESCE(AVG(gunluk),0) as ort FROM (
                SELECT tarih, SUM(toplam) as gunluk FROM ciro
                WHERE tarih >= CURRENT_DATE - INTERVAL '30 days'
                GROUP BY tarih
            ) t
        """)
        gunluk_ciro = float(cur.fetchone()['ort'])

        cur.execute("""
            SELECT tarih, SUM(odenecek_tutar) as toplam
            FROM odeme_plani WHERE durum='bekliyor'
            AND tarih BETWEEN %s AND %s
            GROUP BY tarih
        """, (bugun, bugun + timedelta(days=gun_sayisi)))
        odeme_map = {str(r['tarih']): float(r['toplam']) for r in cur.fetchall()}

        gunler = []
        for i in range(gun_sayisi):
            tarih = bugun + timedelta(days=i)
            tarih_str = str(tarih)
            odeme = odeme_map.get(tarih_str, 0)
            kasa = kasa + gunluk_ciro - odeme
            gunler.append({
                "tarih": tarih_str,
                "beklenen_gelir": gunluk_ciro,
                "beklenen_gider": odeme,
                "kasa_tahmini": kasa,
                "risk": kasa < 0
            })
        return gunler

def fmt(n):
    if n is None: return "---"
    return f"{int(n):,} ₺".replace(",", ".")
