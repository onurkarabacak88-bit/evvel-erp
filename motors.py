from database import db
from datetime import date, timedelta

def fmt(n):
    if n is None: return "---"
    return f"{int(n):,} ₺".replace(",", ".")

# ── KARAR MOTORU ───────────────────────────────────────────────
def karar_motoru():
    bugun = date.today()
    kararlar = []

    with db() as (conn, cur):
        # Kasa - iç içe bağlantı açmadan hesapla
        cur.execute("""
            SELECT COALESCE(SUM(
                tutar
            ), 0) as kasa FROM kasa_hareketleri WHERE durum='aktif'
        """)
        kasa = float(cur.fetchone()['kasa'])

        # 7 günlük ödemeler
        cur.execute("""
            SELECT COALESCE(SUM(odenecek_tutar),0) as t7,
                   COALESCE(SUM(asgari_tutar),0) as asgari
            FROM odeme_plani WHERE durum='bekliyor'
            AND tarih BETWEEN %s AND %s
        """, (bugun, bugun + timedelta(days=7)))
        row = cur.fetchone()
        odeme_7 = float(row['t7'])
        asgari_7 = float(row['asgari'])

        # KURAL 1: Ödeme riski
        if kasa < odeme_7:
            kararlar.append({
                "kural": 1, "seviye": "KRITIK", "renk": "KIRMIZI",
                "baslik": "Ödeme Riski",
                "mesaj": f"Kasa ({fmt(kasa)}) 7 günlük ödeme yükünü ({fmt(odeme_7)}) karşılamıyor.",
                "aksiyon": "Acil nakit girişi veya ödeme erteleme gerekli",
                "blink": True
            })
        elif kasa >= asgari_7 and asgari_7 > 0:
            kararlar.append({
                "kural": 2, "seviye": "UYARI", "renk": "SARI",
                "baslik": "Asgari Ödeme Yapılabilir",
                "mesaj": f"Kasa asgari ödemeyi ({fmt(asgari_7)}) karşılıyor.",
                "aksiyon": "Asgari ödeme yapılabilir",
                "blink": False
            })

        # KURAL 3: Bugün son ödeme günü
        cur.execute("""
            SELECT op.*, k.banka, k.kart_adi FROM odeme_plani op
            JOIN kartlar k ON k.id=op.kart_id
            WHERE op.durum='bekliyor' AND op.tarih=%s
        """, (bugun,))
        for o in cur.fetchall():
            kararlar.append({
                "kural": 4, "seviye": "KRITIK", "renk": "KIRMIZI",
                "baslik": f"SON GÜN: {o['banka']}",
                "mesaj": f"{o['kart_adi']} için son ödeme tarihi BUGÜN! Tutar: {fmt(o['odenecek_tutar'])}",
                "aksiyon": "Ödemeyi hemen yap",
                "blink": True,
                "kart_id": str(o['kart_id']),
                "odeme_id": str(o['id'])
            })

        # KURAL 4: Vadeli alım hatırlatma
        cur.execute("""
            SELECT * FROM vadeli_alimlar WHERE durum='bekliyor'
            AND vade_tarihi BETWEEN %s AND %s
        """, (bugun, bugun + timedelta(days=7)))
        for v in cur.fetchall():
            gun_kaldi = (v['vade_tarihi'] - bugun).days
            kararlar.append({
                "kural": 6, "seviye": "UYARI", "renk": "TURUNCU",
                "baslik": f"Vadeli Alım: {v['aciklama']}",
                "mesaj": f"{gun_kaldi} gün sonra {fmt(v['tutar'])} ödeme vadesi geliyor.",
                "aksiyon": "Nakit planını güncelle",
                "blink": False
            })

        # KURAL 5: 10 gün nakit simülasyon
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
        sim_kasa = kasa
        for gun in cur.fetchall():
            sim_kasa += gunluk_ciro - float(gun['toplam'])
            if sim_kasa < 0:
                kararlar.append({
                    "kural": 5, "seviye": "UYARI", "renk": "TURUNCU",
                    "baslik": "Nakit Akışı Bozulacak",
                    "mesaj": f"{gun['tarih']} tarihinde kasa negatife düşecek.",
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

# ── STRATEJİ MOTORU ────────────────────────────────────────────
def odeme_strateji_motoru():
    bugun = date.today()
    oneriler = []

    with db() as (conn, cur):
        # Kasa
        cur.execute("""
            SELECT COALESCE(SUM(
                tutar
            ), 0) as kasa FROM kasa_hareketleri WHERE durum='aktif'
        """)
        kasa = float(cur.fetchone()['kasa'])

        # Zorunlu giderler
        cur.execute("SELECT COALESCE(SUM(tutar),0) as t FROM sabit_giderler WHERE aktif=TRUE")
        sabit = float(cur.fetchone()['t'])
        cur.execute("SELECT COALESCE(SUM(aylik_taksit),0) as t FROM borc_envanteri WHERE aktif=TRUE")
        borc = float(cur.fetchone()['t'])
        cur.execute("SELECT COALESCE(SUM(maas+yemek_ucreti+yol_ucreti),0) as t FROM personel WHERE aktif=TRUE AND calisma_turu='surekli'")
        personel = float(cur.fetchone()['t'])
        zorunlu = sabit + borc + personel
        kullanilabilir = kasa - zorunlu

        # Bekleyen ödemeler
        cur.execute("""
            SELECT op.*, k.banka, k.kart_adi, k.faiz_orani
            FROM odeme_plani op JOIN kartlar k ON k.id=op.kart_id
            WHERE op.durum='bekliyor' AND op.tarih >= %s
            ORDER BY k.faiz_orani DESC, op.tarih ASC
        """, (bugun,))
        for o in cur.fetchall():
            gun_kaldi = (o['tarih'] - bugun).days
            tam = float(o['odenecek_tutar'])
            asgari = float(o['asgari_tutar'] or tam * 0.4)
            faiz = float(o['faiz_orani'] or 0)

            if gun_kaldi == 0:
                tavsiye = asgari if kullanilabilir < tam else tam
                oneri = {"oneri_turu": "HEMEN_ODE", "renk": "KIRMIZI",
                    "baslik": f"🔴 {o['banka']} — BUGÜN ÖDE",
                    "aciklama": f"Son gün bugün. Asgari: {fmt(asgari)}",
                    "tavsiye_tutar": tavsiye, "blink": True}
                kullanilabilir -= tavsiye
            elif kullanilabilir >= tam and faiz > 2:
                oneri = {"oneri_turu": "TAM_ODE", "renk": "TURUNCU",
                    "baslik": f"🟠 {o['banka']} — TAM ÖDE",
                    "aciklama": f"Faiz %{faiz}. Ertelersen {fmt((tam-asgari)*(faiz/100))} faiz ödersin.",
                    "tavsiye_tutar": tam, "blink": False}
                kullanilabilir -= tam
            elif kullanilabilir >= asgari:
                oneri = {"oneri_turu": "ASGARI_ODE", "renk": "SARI",
                    "baslik": f"🟡 {o['banka']} — ASGARİ ÖDE",
                    "aciklama": f"Kasada tam ödeme için yer yok. Asgari: {fmt(asgari)}",
                    "tavsiye_tutar": asgari, "blink": False}
                kullanilabilir -= asgari
            else:
                oneri = {"oneri_turu": "ERTELE", "renk": "GRI",
                    "baslik": f"⏳ {o['banka']} — ERTELE",
                    "aciklama": f"Kasada yeterli nakit yok. Son gün: {o['tarih']}",
                    "tavsiye_tutar": 0, "blink": False}

            oneri.update({
                "kart_id": str(o['kart_id']),
                "odeme_id": str(o['id']),
                "kart_adi": o['kart_adi'],
                "banka": o['banka']
            })
            oneriler.append(oneri)

        return {
            "kasa": kasa, "kullanilabilir_nakit": kullanilabilir,
            "zorunlu_giderler": zorunlu, "oneriler": oneriler,
            "toplam_oneri_tutari": sum(o['tavsiye_tutar'] for o in oneriler)
        }

# ── NAKİT AKIŞ SİMÜLASYON ─────────────────────────────────────
def nakit_akis_simulasyon(gun_sayisi=15):
    bugun = date.today()
    with db() as (conn, cur):
        cur.execute("""
            SELECT COALESCE(SUM(
                tutar
            ), 0) as kasa FROM kasa_hareketleri WHERE durum='aktif'
        """)
        kasa = float(cur.fetchone()['kasa'])

        cur.execute("""
            SELECT COALESCE(AVG(gunluk),0) as ort FROM (
                SELECT tarih, SUM(toplam) as gunluk FROM ciro
                WHERE tarih >= CURRENT_DATE - INTERVAL '30 days'
                GROUP BY tarih
            ) t
        """)
        gunluk_ciro = float(cur.fetchone()['ort'])

        cur.execute("""
            SELECT tarih::TEXT, SUM(odenecek_tutar) as toplam
            FROM odeme_plani WHERE durum='bekliyor'
            AND tarih BETWEEN %s AND %s GROUP BY tarih
        """, (bugun, bugun + timedelta(days=gun_sayisi)))
        odeme_map = {r['tarih']: float(r['toplam']) for r in cur.fetchall()}

        gunler = []
        for i in range(gun_sayisi):
            tarih = str(bugun + timedelta(days=i))
            odeme = odeme_map.get(tarih, 0)
            kasa = kasa + gunluk_ciro - odeme
            gunler.append({
                "tarih": tarih,
                "beklenen_gelir": gunluk_ciro,
                "beklenen_gider": odeme,
                "kasa_tahmini": kasa,
                "risk": kasa < 0
            })
        return gunler

# ── KART ANALİZ (Panel için) ───────────────────────────────────
def kart_analiz_hesapla():
    bugun = date.today()
    with db() as (conn, cur):
        cur.execute("SELECT * FROM kartlar WHERE aktif=TRUE ORDER BY banka")
        kartlar = cur.fetchall()
        sonuc = []
        for k in kartlar:
            # Güncel borç
            cur.execute("""
                SELECT COALESCE(SUM(
                    CASE WHEN islem_turu='HARCAMA' THEN tutar ELSE -tutar END
                ),0) as borc FROM kart_hareketleri WHERE kart_id=%s AND durum='aktif'
            """, (k['id'],))
            borc = float(cur.fetchone()['borc'])

            # Ekstre - banka mantığı: tek çekim + aylık taksit
            cur.execute("""
                SELECT COALESCE(SUM(tutar),0) as e FROM kart_hareketleri
                WHERE kart_id=%s AND durum='aktif' AND islem_turu='HARCAMA'
                AND taksit_sayisi=1 AND EXTRACT(DAY FROM tarih)<=%s
            """, (k['id'], k['kesim_gunu']))
            tek_cekim = float(cur.fetchone()['e'])

            cur.execute("""
                SELECT COALESCE(SUM(tutar::float/NULLIF(taksit_sayisi,0)),0) as t
                FROM kart_hareketleri
                WHERE kart_id=%s AND durum='aktif' AND islem_turu='HARCAMA' AND taksit_sayisi>1
            """, (k['id'],))
            aylik_taksit = float(cur.fetchone()['t'])

            bu_ekstre = tek_cekim + aylik_taksit
            limit = float(k['limit_tutar'])

            # Son ödeme tarihi
            son_odeme_gun = k['son_odeme_gunu']
            son_odeme = date(bugun.year, bugun.month, son_odeme_gun)
            if son_odeme < bugun:
                if bugun.month == 12:
                    son_odeme = date(bugun.year+1, 1, son_odeme_gun)
                else:
                    son_odeme = date(bugun.year, bugun.month+1, son_odeme_gun)
            gun_kaldi = (son_odeme - bugun).days

            cur.execute("""
                SELECT id FROM odeme_plani WHERE kart_id=%s AND durum='bekliyor'
                ORDER BY tarih ASC LIMIT 1
            """, (k['id'],))
            yaklasan = cur.fetchone()

            sonuc.append({
                'kart_adi': k['kart_adi'], 'banka': k['banka'],
                'limit_tutar': limit, 'guncel_borc': borc,
                'kalan_limit': limit - borc,
                'limit_doluluk': borc/limit if limit > 0 else 0,
                'bu_ekstre': bu_ekstre,
                'aylik_taksit': aylik_taksit,
                'asgari_odeme': bu_ekstre * 0.4,
                'gun_kaldi': gun_kaldi,
                'blink': gun_kaldi <= 0 and yaklasan is not None,
            })
        return sonuc

# ── GÜNCEL KASA ────────────────────────────────────────────────
def guncel_kasa():
    with db() as (conn, cur):
        cur.execute("""
            SELECT COALESCE(SUM(
                tutar
            ), 0) as kasa FROM kasa_hareketleri WHERE durum='aktif'
        """)
        return float(cur.fetchone()['kasa'])
