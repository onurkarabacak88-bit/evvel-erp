from database import db
from datetime import date, timedelta
from finans_core import (
    kasa_bakiyesi, odeme_yuku, gunluk_ciro_ortalama,
    nakit_akis_sim, kart_borc, tum_kart_borclari,
    kart_ekstre, kart_bu_ay_odenen, kart_faiz_tahmini,
    zorunlu_gider_tahmini, serbest_nakit, net_akis_30_gun,
    kac_gun_dayanir, kasa_bakiyesi_tarihte,
    kasa_detay_breakdown, kasa_detay_breakdown_debug,
)

def fmt(n):
    if n is None: return "---"
    return f"{int(n):,} ₺".replace(",", ".")


def _borc_taksit_plani_uretilebilir(baslangic, odemesiz_ay, plan_yil: int, plan_ay: int) -> bool:
    """
    baslangic + odemesiz_ay takvim ayı geçmeden bu (plan_yil, plan_ay) için plan üretilmez.
    odemesiz_ay<=0 veya baslangic yok: mevcut davranış (kısıt yok).
    """
    try:
        oa = int(odemesiz_ay or 0)
    except (TypeError, ValueError):
        oa = 0
    if oa <= 0 or baslangic is None:
        return True
    if isinstance(baslangic, str):
        baslangic = date.fromisoformat(str(baslangic)[:10])
    elif hasattr(baslangic, "date") and callable(getattr(baslangic, "date", None)):
        baslangic = baslangic.date()
    y0, m0 = baslangic.year, baslangic.month
    m_first = m0 + oa
    y_first = y0 + (m_first - 1) // 12
    m_first = (m_first - 1) % 12 + 1
    if plan_yil < y_first:
        return False
    if plan_yil == y_first and plan_ay < m_first:
        return False
    return True


# ── KARAR MOTORU ───────────────────────────────────────────────
def karar_motoru():
    bugun = date.today()
    kararlar = []

    with db() as (conn, cur):
        # ── CORE HESAPLAR ──────────────────────────────────────
        kasa     = kasa_bakiyesi(cur)
        yuk      = odeme_yuku(cur, bugun)
        odeme_7  = yuk["t7"]
        odeme_15 = yuk["t15"]
        odeme_30 = yuk["t30"]
        asgari_7 = yuk["asgari7"]

        # KURAL 1: Kritik — 7 gün
        if kasa < odeme_7:
            kararlar.append({
                "kural": 1, "seviye": "KRITIK", "renk": "KIRMIZI",
                "baslik": "Ödeme Riski — 7 Gün",
                "mesaj": f"Kasa ({fmt(kasa)}) 7 günlük ödeme yükünü ({fmt(odeme_7)}) karşılamıyor.",
                "aksiyon": "Acil nakit girişi veya ödeme erteleme gerekli",
                "blink": True
            })
        elif kasa < odeme_15:
            kararlar.append({
                "kural": 1, "seviye": "KRITIK", "renk": "KIRMIZI",
                "baslik": "Ödeme Riski — 15 Gün",
                "mesaj": f"Kasa ({fmt(kasa)}) 15 günlük ödeme yükünü ({fmt(odeme_15)}) karşılamıyor.",
                "aksiyon": "Nakit girişi planlanmalı",
                "blink": True
            })
        elif kasa < odeme_30:
            oran = kasa / odeme_30 if odeme_30 > 0 else 999
            kararlar.append({
                "kural": 2, "seviye": "UYARI", "renk": "SARI",
                "baslik": "30 Gün Nakit Baskısı",
                "mesaj": f"Kasa ({fmt(kasa)}) 30 günlük yükü ({fmt(odeme_30)}) karşılamıyor. Oran: {oran:.1f}x",
                "aksiyon": "Nakit akışını izle",
                "blink": False
            })
        elif asgari_7 > 0:
            oran = kasa / odeme_7 if odeme_7 > 0 else 999
            if oran < 1.5:
                kararlar.append({
                    "kural": 2, "seviye": "UYARI", "renk": "SARI",
                    "baslik": "Nakit Baskısı Var",
                    "mesaj": f"Kasa ({fmt(kasa)}) 7 günlük yükün {oran:.1f}x katı. Dikkatli harcayın.",
                    "aksiyon": "Asgari ödeme yapılabilir ama nakit azalıyor",
                    "blink": False
                })

        # KURAL 3: Bugün son ödeme günü
        cur.execute("""
            SELECT op.*, k.banka, k.kart_adi FROM odeme_plani op
            JOIN kartlar k ON k.id=op.kart_id
            WHERE op.durum IN ('bekliyor','onay_bekliyor') AND op.tarih=%s
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
        # Sadece odeme_plani'na henüz aktarılmamış olanları göster
        cur.execute("""
            SELECT v.* FROM vadeli_alimlar v
            WHERE v.durum='bekliyor'
            AND v.vade_tarihi BETWEEN %s AND %s
            AND NOT EXISTS (
                SELECT 1 FROM odeme_plani op
                WHERE op.kaynak_tablo = 'vadeli_alimlar'
                AND op.kaynak_id = v.id
                AND op.durum IN ('bekliyor','onay_bekliyor')
            )
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

        # KURAL 5: 10 gün nakit simülasyon — core'dan al
        sim_gunler = nakit_akis_sim(cur, gun_sayisi=10)
        for gun in sim_gunler:
            if gun['risk']:
                kararlar.append({
                    "kural": 5, "seviye": "UYARI", "renk": "TURUNCU",
                    "baslik": "Nakit Akışı Bozulacak",
                    "mesaj": f"{gun['tarih']} tarihinde kasa negatife düşecek.",
                    "aksiyon": "Nakit akışını düzenle",
                    "blink": False
                })
                break

        # KURAL 6: Kart limit uyarısı — core borç hesabı
        cur.execute("SELECT * FROM kartlar WHERE aktif=TRUE")
        for k in cur.fetchall():
            limit = float(k['limit_tutar'])
            if limit <= 0:
                continue
            borc   = kart_borc(cur, k['id'])
            kalan  = limit - borc
            doluluk = borc / limit
            if doluluk >= 0.90:
                kararlar.append({
                    "kural": 7, "seviye": "KRITIK", "renk": "KIRMIZI",
                    "baslik": f"Kart Limiti Kritik: {k['banka']}",
                    "mesaj": f"{k['kart_adi']} limiti %{doluluk*100:.0f} dolu. Kalan: {fmt(kalan)}",
                    "aksiyon": "Kart ödemesi yapın veya nakit kullanın",
                    "blink": True
                })
            elif doluluk >= 0.75:
                kararlar.append({
                    "kural": 7, "seviye": "UYARI", "renk": "SARI",
                    "baslik": f"Kart Limiti Dolmak Üzere: {k['banka']}",
                    "mesaj": f"{k['kart_adi']} limiti %{doluluk*100:.0f} dolu. Kalan: {fmt(kalan)}",
                    "aksiyon": "Kart limitini takip edin",
                    "blink": False
                })

        kritik = sum(1 for k in kararlar if k['seviye'] == 'KRITIK')
        uyari = sum(1 for k in kararlar if k['seviye'] == 'UYARI')
        genel = 'KRITIK' if kritik > 0 else 'UYARI' if uyari > 0 else 'SAGLIKLI'

        return {
            "genel_durum": genel,
            "kasa": kasa,
            "odeme_7_gun": odeme_7,
            "odeme_15_gun": odeme_15,
            "odeme_30_gun": odeme_30,
            "asgari_7_gun": asgari_7,
            "kararlar": kararlar,
            "ozet": {"kritik": kritik, "uyari": uyari}
        }

# ── STRATEJİ MOTORU ────────────────────────────────────────────
def odeme_strateji_motoru():
    bugun = date.today()
    oneriler = []

    with db() as (conn, cur):
        # ── CORE HESAPLAR ──────────────────────────────────────
        kasa            = kasa_bakiyesi(cur)
        zorunlu_veri    = zorunlu_gider_tahmini(cur)
        zorunlu         = zorunlu_veri["zorunlu"]
        kullanilabilir  = kasa - zorunlu

        # Bekleyen ödemeler
        cur.execute("""
            SELECT op.*, k.banka, k.kart_adi, k.faiz_orani
            FROM odeme_plani op JOIN kartlar k ON k.id=op.kart_id
            WHERE op.durum IN ('bekliyor','onay_bekliyor') AND op.tarih >= %s
            ORDER BY k.faiz_orani DESC, op.tarih ASC
        """, (bugun,))
        for o in cur.fetchall():
            gun_kaldi = (o['tarih'] - bugun).days
            tam = float(o['odenecek_tutar'])
            asgari = float(o['asgari_tutar'] or tam * 0.4)
            faiz = float(o['faiz_orani'] or 0)

            if gun_kaldi == 0:
                if kullanilabilir < asgari:
                    tavsiye = 0
                    oneri = {"oneri_turu": "KRITIK_NAKIT", "renk": "KIRMIZI",
                        "baslik": f"🔴 {o['banka']} — NAKİT YETERSİZ",
                        "aciklama": f"Kasada asgari ödeme için bile yeterli nakit yok! Asgari: {fmt(asgari)}",
                        "tavsiye_tutar": 0, "blink": True}
                elif kullanilabilir < tam:
                    tavsiye = asgari
                    oneri = {"oneri_turu": "HEMEN_ODE", "renk": "KIRMIZI",
                        "baslik": f"🔴 {o['banka']} — BUGÜN ASGARİ ÖDE",
                        "aciklama": f"Son gün bugün. Tam ödeme için nakit yetersiz. Asgari: {fmt(asgari)}",
                        "tavsiye_tutar": tavsiye, "blink": True}
                else:
                    tavsiye = tam
                    oneri = {"oneri_turu": "HEMEN_ODE", "renk": "KIRMIZI",
                        "baslik": f"🔴 {o['banka']} — BUGÜN TAM ÖDE",
                        "aciklama": f"Son gün bugün. Tam ödeme yapabilirsiniz.",
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
                "banka": o['banka'],
                "tarih": str(o['tarih'])  # Simülasyon geri beslemesi için
            })
            oneriler.append(oneri)

        # ── SMART DAĞITIM: Kalan parayı en pahalı faize at ────────
        # Adım 1: Asgari ödenen kartların ID'lerini bul
        asgari_ids = [o['odeme_id'] for o in oneriler if o['oneri_turu'] == 'ASGARI_ODE']
        if kullanilabilir > 0 and asgari_ids:
            cur.execute("""
                SELECT op.id, op.odenecek_tutar, op.asgari_tutar, k.faiz_orani
                FROM odeme_plani op JOIN kartlar k ON k.id=op.kart_id
                WHERE op.id = ANY(%s)
                ORDER BY k.faiz_orani DESC
            """, (asgari_ids,))
            ekstra_kartlar = cur.fetchall()
            # Adım 2: Kalan kasayı yüksek faizden başlayarak dağıt
            for ek in ekstra_kartlar:
                if kullanilabilir <= 0:
                    break
                tam = float(ek['odenecek_tutar'])
                asgari = float(ek['asgari_tutar'] or tam * 0.4)
                ekstra = min(kullanilabilir, tam - asgari)
                if ekstra > 1:
                    for o in oneriler:
                        if o.get('odeme_id') == str(ek['id']):
                            o['tavsiye_tutar'] = round(o['tavsiye_tutar'] + ekstra, 2)
                            o['oneri_turu'] = 'SMART_DAGITIM'
                            o['renk'] = 'TURUNCU'
                            o['aciklama'] += f" (+{fmt(ekstra)} ekstra, kalan kasadan)"
                            break
                    kullanilabilir -= ekstra

        return {
            "kasa": kasa, "kullanilabilir_nakit": kullanilabilir,
            "zorunlu_giderler": zorunlu, "oneriler": oneriler,
            "toplam_oneri_tutari": sum(o['tavsiye_tutar'] for o in oneriler)
        }

# ── NAKİT AKIŞ SİMÜLASYON ─────────────────────────────────────
def nakit_akis_simulasyon(gun_sayisi=15):
    """finans_core.nakit_akis_sim'in thin wrapper'ı — geriye dönük uyumluluk."""
    with db() as (conn, cur):
        return nakit_akis_sim(cur, gun_sayisi=gun_sayisi)

# ── KART ANALİZ (Panel için) ───────────────────────────────────
def kart_analiz_hesapla():
    bugun = date.today()
    with db() as (conn, cur):
        cur.execute("SELECT * FROM kartlar WHERE aktif=TRUE ORDER BY banka")
        kartlar = cur.fetchall()
        sonuc = []
        for k in kartlar:
            # ── CORE HESAPLAR ──────────────────────────
            borc       = kart_borc(cur, k['id'])
            ekstre_v   = kart_ekstre(cur, k['id'], k['kesim_gunu'])
            bu_ay_odenen = kart_bu_ay_odenen(cur, k['id'])

            bu_ekstre    = ekstre_v["ekstre_toplam"]
            tek_cekim    = ekstre_v["tek_cekim"]
            aylik_taksit = ekstre_v["aylik_taksit"]
            limit        = float(k['limit_tutar'])

            # Bu aya yansıyan faiz (bir önceki dönemden)
            cur.execute("""
                SELECT COALESCE(SUM(tutar),0) as faiz
                FROM kart_hareketleri
                WHERE kart_id=%s AND durum='aktif' AND islem_turu='FAIZ'
                AND EXTRACT(YEAR FROM tarih) = EXTRACT(YEAR FROM CURRENT_DATE)
                AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
            """, (k['id'],))
            bu_ay_faiz = float(cur.fetchone()['faiz'])

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
                SELECT id FROM odeme_plani WHERE kart_id=%s AND durum IN ('bekliyor','onay_bekliyor')
                ORDER BY tarih ASC LIMIT 1
            """, (k['id'],))
            yaklasan = cur.fetchone()

            sonuc.append({
                'kart_adi': k['kart_adi'], 'banka': k['banka'],
                'faiz_orani': float(k['faiz_orani']),
                'limit_tutar': limit, 'guncel_borc': borc,
                'kalan_limit': limit - borc,
                'limit_doluluk': borc/limit if limit > 0 else 0,
                'bu_ekstre': bu_ekstre,
                'aylik_taksit': aylik_taksit,
                'bu_ay_faiz': bu_ay_faiz,
                'asgari_odeme': bu_ekstre * (float(k['asgari_oran']) / 100 if 'asgari_oran' in k else 0.4),
                'gun_kaldi': gun_kaldi,
                'blink': gun_kaldi <= 0 and yaklasan is not None,
            })
        return sonuc


# ── AYLIK ÖDEME PLANI ÜRETİM MOTORU ───────────────────────────
def aylik_odeme_plani_uret(yil=None, ay=None):
    """
    Her ay 1'inde çalışır. O aya ait ödeme planını şunlardan üretir:
    - Sabit giderler (aktif)
    - Personel maaşları (aktif, sürekli)
    - Kredi/borç taksitleri (aktif)
    - Vadeli alımlar (o ay vadeleri gelenler)
    - Kart asgari ödemeleri (kart motoru hesaplar)
    Zaten var olan kayıtları tekrar üretmez (ON CONFLICT DO NOTHING).
    """
    from datetime import date
    import uuid as _uuid
    bugun = date.today()
    if yil is None: yil = bugun.year
    if ay is None: ay = bugun.month

    uretilen = []
    atlanan = []

    with db() as (conn, cur):

        # 1. SABİT GİDERLER
        cur.execute("SELECT * FROM sabit_giderler WHERE aktif=TRUE")
        for g in cur.fetchall():
            odeme_gun = g['odeme_gunu'] or 1
            try:
                odeme_tarihi = date(yil, ay, odeme_gun)
            except ValueError:
                import calendar
                odeme_tarihi = date(yil, ay, calendar.monthrange(yil, ay)[1])

            # Periyot kontrolü
            if g['periyot'] == 'yillik':
                baslangic = g['baslangic_tarihi']
                if not baslangic:
                    # Başlangıç tarihi yoksa yıllık gider üretilemiyor — atla, uyar
                    atlanan.append(f"Sabit gider atlandı (yıllık, başlangıç tarihi yok): {g['gider_adi']}")
                    continue
                if baslangic.month != ay:
                    atlanan.append(f"Sabit gider atlandı (yıllık): {g['gider_adi']}")
                    continue

            # KRİTİK: Artış tarihi geçmişse ödeme planı üretme — güncelleme zorunlu
            if g['kira_artis_tarihi']:
                gun_kalan = (g['kira_artis_tarihi'] - bugun).days
                if gun_kalan < 0:
                    # Geçmiş bekleyen planları da iptal et — gerçeklik ile tutarlılık
                    cur.execute("""
                        UPDATE odeme_plani SET durum='iptal'
                        WHERE kaynak_tablo='sabit_giderler' AND kaynak_id=%s
                        AND durum IN ('bekliyor','onay_bekliyor')
                    """, (g['id'],))
                    iptal_sayisi = cur.rowcount
                    atlanan.append(
                        f"⛔ DURDURULDU (artış tarihi geçmiş): {g['gider_adi']} "
                        f"— {abs(gun_kalan)} gün önce geçti"
                        + (f", {iptal_sayisi} bekleyen plan iptal edildi" if iptal_sayisi > 0 else "")
                    )
                    continue

            # KRİTİK: Sözleşme bitmişse ödeme planı üretme — yenileme zorunlu
            if g['sozlesme_bitis_tarihi']:
                gun_kalan = (g['sozlesme_bitis_tarihi'] - bugun).days
                if gun_kalan < 0:
                    # Geçmiş bekleyen planları da iptal et
                    cur.execute("""
                        UPDATE odeme_plani SET durum='iptal'
                        WHERE kaynak_tablo='sabit_giderler' AND kaynak_id=%s
                        AND durum IN ('bekliyor','onay_bekliyor')
                    """, (g['id'],))
                    iptal_sayisi = cur.rowcount
                    atlanan.append(
                        f"⛔ DURDURULDU (sözleşme dolmuş): {g['gider_adi']} "
                        f"— {abs(gun_kalan)} gün önce bitti"
                        + (f", {iptal_sayisi} bekleyen plan iptal edildi" if iptal_sayisi > 0 else "")
                    )
                    continue

            # DEĞİŞKEN GİDER: odeme_plani üretme, sadece hatırlatma listesine ekle
            if g.get('tip') == 'degisken':
                uretilen.append(
                    f"📌 Hatırlatma: {g['gider_adi']} — {odeme_tarihi} (tutar bekleniyor, kasaya etki yok)"
                )
                continue

            pid = str(_uuid.uuid4())

            # KART TALİMAT KONTROLÜ — kart_id varsa otomatik çek
            if g.get('odeme_yontemi') == 'kart' and g.get('kart_id'):
                # Bu ay için zaten plan var mı?
                cur.execute("""
                    SELECT 1 FROM odeme_plani
                    WHERE kaynak_id = %s
                    AND referans_ay = DATE_TRUNC('month', %s::date)
                    AND durum != 'iptal'
                """, (g['id'], str(odeme_tarihi)))
                if cur.fetchone():
                    atlanan.append(f"Sabit gider zaten planlanmış: {g['gider_adi']}")
                    continue

                # Kart limit kontrolü
                cur.execute("""
                    SELECT k.limit_tutar,
                        COALESCE(SUM(
                            CASE WHEN kh.islem_turu IN ('HARCAMA','FAIZ') THEN kh.tutar
                                 WHEN kh.islem_turu='ODEME' THEN -kh.tutar ELSE 0 END
                        ), 0) as borc
                    FROM kartlar k
                    LEFT JOIN kart_hareketleri kh ON kh.kart_id = k.id AND kh.durum='aktif'
                    WHERE k.id = %s
                    GROUP BY k.limit_tutar
                """, (g['kart_id'],))
                kart_row = cur.fetchone()
                limit = float(kart_row['limit_tutar']) if kart_row else 0
                borc = float(kart_row['borc']) if kart_row else 0
                kalan_limit = limit - borc
                tutar = float(g['tutar'])
                doluluk_pct = (borc / limit * 100) if limit > 0 else 0

                if tutar > kalan_limit:
                    # LİMİT DOLU — çekme, uyarı ver
                    uretilen.append(
                        f"🚨 KART LİMİT YETERSİZ: {g['gider_adi']} çekilemedi "
                        f"(kalan limit: {kalan_limit:,.0f}₺ < {tutar:,.0f}₺) — manuel ödeme gerekli"
                    )
                    # Plan bekliyor'da açılsın, kullanıcı manuel ödesin
                    cur.execute("""
                        INSERT INTO odeme_plani
                            (id, kart_id, tarih, referans_ay, odenecek_tutar, asgari_tutar, aciklama, durum, kaynak_tablo, kaynak_id)
                        VALUES (%s, NULL, %s, DATE_TRUNC('month', %s::date), %s, %s, %s, 'bekliyor', 'sabit_giderler', %s)
                    """, (pid, odeme_tarihi, str(odeme_tarihi), tutar, tutar,
                          f"⚠️ LİMİT YETERSİZ — Manuel Öde: {g['gider_adi']}", g['id']))
                    continue

                # Karta HARCAMA yaz — kaynak_id ile sabit_giderler'e bağla
                hid = str(_uuid.uuid4())
                cur.execute("""
                    INSERT INTO kart_hareketleri
                        (id, kart_id, tarih, islem_turu, tutar, taksit_sayisi, aciklama, kaynak_id, kaynak_tablo)
                    VALUES (%s, %s, %s, 'HARCAMA', %s, 1, %s, %s, 'sabit_giderler')
                """, (hid, g['kart_id'], odeme_tarihi, tutar,
                      f"Otomatik talimat: {g['gider_adi']}", str(g['id'])))

                # Plan odendi olarak aç — kasa etkilenmez
                cur.execute("""
                    INSERT INTO odeme_plani
                        (id, kart_id, tarih, referans_ay, odenecek_tutar, asgari_tutar,
                         odenen_tutar, odeme_tarihi, aciklama, durum, kaynak_tablo, kaynak_id)
                    VALUES (%s, %s, %s, DATE_TRUNC('month', %s::date), %s, %s, %s, %s, %s, 'odendi', 'sabit_giderler', %s)
                """, (pid, g['kart_id'], odeme_tarihi, str(odeme_tarihi),
                      tutar, tutar, tutar, odeme_tarihi,
                      f"Sabit Gider (Kart Talimat): {g['gider_adi']}", g['id']))

                if doluluk_pct >= 80:
                    uretilen.append(
                        f"⚠️ KART KRİTİK: {g['gider_adi']} karta çekildi "
                        f"({tutar:,.0f}₺) ama kart doluluk %{doluluk_pct:.0f}"
                    )
                else:
                    uretilen.append(
                        f"✅ Kart talimat: {g['gider_adi']} → {g['kart_id'][:8]}... "
                        f"({tutar:,.0f}₺) — {odeme_tarihi}"
                    )
                continue

            # NAKİT — mevcut akış
            cur.execute("""
                INSERT INTO odeme_plani (id, kart_id, tarih, referans_ay, odenecek_tutar, asgari_tutar, aciklama, durum, kaynak_tablo, kaynak_id)
                SELECT %s, NULL, %s, DATE_TRUNC('month', %s::date), %s, %s, %s, 'bekliyor', 'sabit_giderler', %s
                WHERE NOT EXISTS (
                    SELECT 1 FROM odeme_plani
                    WHERE kaynak_id = %s
                    AND referans_ay = DATE_TRUNC('month', %s::date)
                    AND durum != 'iptal'
                )
            """, (pid, odeme_tarihi, str(odeme_tarihi), float(g['tutar']), float(g['tutar']),
                  f"Sabit Gider: {g['gider_adi']}", g['id'], g['id'], str(odeme_tarihi)))
            if cur.rowcount > 0:
                uretilen.append(f"Sabit gider: {g['gider_adi']} — {odeme_tarihi}")

        # 2. PERSONEL MAAŞLARI (Sürekli + Part-time)
        cur.execute("SELECT * FROM personel WHERE aktif=TRUE")
        for p in cur.fetchall():
            odeme_gun = p['odeme_gunu'] or 28
            import calendar
            son_gun = calendar.monthrange(yil, ay)[1]
            odeme_gun = min(odeme_gun, son_gun)
            odeme_tarihi = date(yil, ay, odeme_gun)

            # Bu ay personel_aylik kaydı var mı? Varsa gerçek tutarı kullan
            cur.execute("""
                SELECT hesaplanan_net FROM personel_aylik
                WHERE personel_id=%s AND yil=%s AND ay=%s
            """, (p['id'], yil, ay))
            aylik_kayit = cur.fetchone()

            if aylik_kayit:
                toplam_maas = float(aylik_kayit['hesaplanan_net'] or 0)
            elif p['calisma_turu'] == 'surekli':
                # Tahmini: maaş + yan haklar
                toplam_maas = float(p['maas'] or 0) + float(p['yemek_ucreti'] or 0) + float(p['yol_ucreti'] or 0)
            else:
                # Part-time: ay kaydı girilmeden plan üretme
                atlanan.append(f"Part-time atlandı (kayıt bekleniyor): {p['ad_soyad']}")
                continue

            if toplam_maas <= 0:
                continue

            pid = str(_uuid.uuid4())
            cur.execute("""
                INSERT INTO odeme_plani (id, kart_id, tarih, referans_ay, odenecek_tutar, asgari_tutar, aciklama, durum, kaynak_tablo, kaynak_id)
                SELECT %s, NULL, %s, DATE_TRUNC('month', %s::date), %s, %s, %s, 'bekliyor', 'personel', %s
                WHERE NOT EXISTS (
                    SELECT 1 FROM odeme_plani
                    WHERE kaynak_id = %s
                    AND referans_ay = DATE_TRUNC('month', %s::date)
                    AND durum != 'iptal'
                )
            """, (pid, odeme_tarihi, str(odeme_tarihi), toplam_maas, toplam_maas,
                  f"Personel Maaş: {p['ad_soyad']}", p['id'], p['id'], str(odeme_tarihi)))
            if cur.rowcount > 0:
                uretilen.append(f"Maaş: {p['ad_soyad']} — {odeme_tarihi}")

        # 3. KREDİ / BORÇ TAKSİTLERİ
        cur.execute("SELECT * FROM borc_envanteri WHERE aktif=TRUE AND aylik_taksit > 0")
        for b in cur.fetchall():
            odeme_gun = b['odeme_gunu'] or 1
            import calendar
            son_gun = calendar.monthrange(yil, ay)[1]
            odeme_gun = min(odeme_gun, son_gun)
            odeme_tarihi = date(yil, ay, odeme_gun)

            if not _borc_taksit_plani_uretilebilir(
                b.get('baslangic_tarihi'), b.get('odemesiz_ay'), yil, ay
            ):
                oa = int(b.get('odemesiz_ay') or 0)
                atlanan.append(
                    f"Borç ödemesiz dönemde ({oa} ay): {b['kurum']} — taksit planı henüz başlamadı"
                )
                continue

            # Kalan vade kontrolü
            if b['kalan_vade'] is not None and b['kalan_vade'] <= 0:
                atlanan.append(f"Borç atlandı (bitti): {b['kurum']}")
                continue

            pid = str(_uuid.uuid4())
            # Guard: kaynak_id ile eşleşme — aciklama'ya bağımlı değil, aynı isimli borç sorunu yok
            cur.execute("""
                INSERT INTO odeme_plani
                    (id, kart_id, tarih, odenecek_tutar, asgari_tutar, aciklama, durum, kaynak_tablo, kaynak_id)
                SELECT %s, NULL, %s, %s, %s, %s, 'bekliyor', 'borc_envanteri', %s
                WHERE NOT EXISTS (
                    SELECT 1 FROM odeme_plani
                    WHERE kaynak_tablo = 'borc_envanteri'
                    AND kaynak_id = %s
                    AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', %s::date)
                    AND durum != 'iptal'
                )
            """, (pid, odeme_tarihi, float(b['aylik_taksit']), float(b['aylik_taksit']),
                  f"Kredi/Borç: {b['kurum']}", str(b['id']),
                  str(b['id']), str(odeme_tarihi)))
            if cur.rowcount > 0:
                uretilen.append(f"Kredi: {b['kurum']} — {odeme_tarihi}")
                # kalan_vade artık odeme_yap'ta ödeme onaylanınca düşüyor — burada düşürme

        # 4. VADELİ ALIMLAR (o ay vadesi gelenler)
        cur.execute("""
            SELECT * FROM vadeli_alimlar
            WHERE durum = 'bekliyor'
            AND EXTRACT(YEAR FROM vade_tarihi) = %s
            AND EXTRACT(MONTH FROM vade_tarihi) = %s
        """, (yil, ay))
        for v in cur.fetchall():
            pid = str(_uuid.uuid4())
            cur.execute("""
                INSERT INTO odeme_plani (id, kart_id, tarih, referans_ay, odenecek_tutar, asgari_tutar, aciklama, durum, kaynak_tablo, kaynak_id)
                SELECT %s, NULL, %s, DATE_TRUNC('month', %s::date), %s, %s, %s, 'bekliyor', 'vadeli_alimlar', %s
                WHERE NOT EXISTS (
                    SELECT 1 FROM odeme_plani
                    WHERE kaynak_tablo = 'vadeli_alimlar'
                    AND kaynak_id = %s
                    AND durum != 'iptal'
                )
            """, (pid, v['vade_tarihi'], str(v['vade_tarihi']), float(v['tutar']), float(v['tutar']),
                  f"Vadeli Alım: {v['aciklama']}", v['id'], v['id']))
            if cur.rowcount > 0:
                uretilen.append(f"Vadeli: {v['aciklama']} — {v['vade_tarihi']}")

        # 5. KART ASGARİ ÖDEMELERİ
        cur.execute("SELECT * FROM kartlar WHERE aktif=TRUE")
        for k in cur.fetchall():
            son_odeme_gun = k['son_odeme_gunu'] or 25
            import calendar
            son_gun = calendar.monthrange(yil, ay)[1]
            son_odeme_gun = min(son_odeme_gun, son_gun)
            odeme_tarihi = date(yil, ay, son_odeme_gun)

            # Kart borcunu hesapla — core'dan
            borc = kart_borc(cur, k['id'])
            if borc <= 0:
                atlanan.append(f"Kart atlandı (borç yok): {k['kart_adi']}")
                continue

            asgari_oran_pct = float(k['asgari_oran']) / 100 if 'asgari_oran' in k else 0.4
            asgari = round(borc * asgari_oran_pct, 2)

            pid = str(_uuid.uuid4())
            # Plan yoksa ekle, varsa borcu güncelle — harcama sonrası tutar değişebilir
            cur.execute("""
                INSERT INTO odeme_plani (id, kart_id, tarih, odenecek_tutar, asgari_tutar, aciklama, durum)
                SELECT %s, %s, %s, %s, %s, %s, 'bekliyor'
                WHERE NOT EXISTS (
                    SELECT 1 FROM odeme_plani
                    WHERE kart_id = %s
                    AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', %s::date)
                    AND durum != 'iptal'
                )
            """, (pid, k['id'], odeme_tarihi, borc, asgari,
                  f"Kart: {k['kart_adi']} — {k['banka']}",
                  k['id'], str(odeme_tarihi)))
            if cur.rowcount > 0:
                uretilen.append(f"Kart: {k['kart_adi']} asgari {fmt(asgari)} — {odeme_tarihi}")
            else:
                # Plan zaten var — güncel borçla tuta güncelle
                cur.execute("""
                    UPDATE odeme_plani
                    SET odenecek_tutar = %s, asgari_tutar = %s
                    WHERE kart_id = %s
                    AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', %s::date)
                    AND durum IN ('bekliyor', 'onay_bekliyor')
                """, (borc, asgari, k['id'], str(odeme_tarihi)))
                if cur.rowcount > 0:
                    uretilen.append(f"Kart güncellendi: {k['kart_adi']} yeni borç {fmt(borc)} — {odeme_tarihi}")

    return {
        "uretilen": uretilen,
        "atlanan": atlanan,
        "toplam": len(uretilen)
    }


# ── UYARI MOTORU (GENİŞLETİLMİŞ) ──────────────────────────────
def uyari_motoru():
    """
    Yaklaşan ödemeleri tarar, uyarı üretir.
    - 4 gün önce: sarı uyarı
    - 1-2 gün önce: turuncu uyarı
    - Bugün: kırmızı, ödendi mi sorar
    - Geçmiş ve ödenmemiş: kritik
    """
    bugun = date.today()
    uyarilar = []

    with db() as (conn, cur):
        cur.execute("""
            SELECT op.*,
                   k.kart_adi, k.banka
            FROM odeme_plani op
            LEFT JOIN kartlar k ON k.id = op.kart_id
            WHERE op.durum = 'bekliyor'
            AND op.tarih BETWEEN %s AND %s
            ORDER BY op.tarih ASC
        """, (bugun - timedelta(days=3), bugun + timedelta(days=7)))

        for o in cur.fetchall():
            gun_farki = (o['tarih'] - bugun).days
            tutar = float(o['odenecek_tutar'])
            asgari = float(o['asgari_tutar'] or tutar * 0.4)

            if gun_farki < 0:
                seviye = "KRITIK"
                renk = "KIRMIZI"
                mesaj = f"⛔ GECİKMİŞ ÖDEME! {abs(gun_farki)} gün önce geçti."
                blink = True
            elif gun_farki == 0:
                seviye = "KRITIK"
                renk = "KIRMIZI"
                mesaj = f"🔴 BUGÜN SON GÜN! Ödendi mi?"
                blink = True
            elif gun_farki <= 2:
                seviye = "UYARI"
                renk = "TURUNCU"
                mesaj = f"🟠 {gun_farki} gün kaldı. Hazırlık yapın."
                blink = False
            elif gun_farki <= 4:
                seviye = "BILGI"
                renk = "SARI"
                mesaj = f"🟡 {gun_farki} gün sonra ödeme var."
                blink = False
            else:
                continue

            uyarilar.append({
                "odeme_id": str(o['id']),
                "aciklama": o['aciklama'],
                "tarih": str(o['tarih']),
                "tutar": tutar,
                "asgari": asgari,
                "gun_farki": gun_farki,
                "seviye": seviye,
                "renk": renk,
                "mesaj": mesaj,
                "blink": blink,
                "kart_adi": o['kart_adi'],
                "banka": o['banka'],
            })

    return uyarilar

# ── GÜNCEL KASA ────────────────────────────────────────────────
def guncel_kasa():
    """finans_core.kasa_bakiyesi thin wrapper — geriye dönük uyumluluk."""
    with db() as (conn, cur):
        return kasa_bakiyesi(cur)

def kasa_detay():
    """finans_core.kasa_detay_breakdown thin wrapper — geriye dönük uyumluluk."""
    with db() as (conn, cur):
        return kasa_detay_breakdown(cur)

def kasa_detay_debug():
    """finans_core.kasa_detay_breakdown_debug — iptal dahil kırılım."""
    with db() as (conn, cur):
        return kasa_detay_breakdown_debug(cur)

# ── MASTER FİNANS MOTORU ───────────────────────────────────────
def finans_ozet_motoru():
    """
    Tüm motorları birleştirir, çelişkileri çözer, tek karar üretir.
    Panel bu fonksiyonu çağırır — başka bir şey çağırmaz.
    """
    bugun = date.today()

    # Tüm motorları çalıştır
    karar = karar_motoru()
    strateji = odeme_strateji_motoru()
    uyarilar = uyari_motoru()
    sim = nakit_akis_simulasyon(30)
    kart_analiz = kart_analiz_hesapla()

    kasa = karar['kasa']
    kullanilabilir_strateji = strateji.get('kullanilabilir_nakit', kasa)
    zorunlu = strateji['zorunlu_giderler']

    # ── SERBEST NAKİT + YÜK — core'dan tek çağrı ────────────────
    with db() as (conn, cur):
        yuk_veri   = odeme_yuku(cur)
        yuk_7      = yuk_veri["t7"]
        yuk_15     = yuk_veri["t15"]
        yuk_30     = yuk_veri["t30"]
        serbest    = serbest_nakit(cur)
    kullanilabilir = min(serbest, kullanilabilir_strateji)

    # ── ÇELİŞKİ ÇÖZÜMÜ (kullanilabilir tanımlı olduktan sonra) ──
    cozulmus_oneriler = []
    for oneri in strateji['oneriler']:
        tavsiye = oneri['tavsiye_tutar']
        if tavsiye > 0 and tavsiye > kullanilabilir:
            oneri = {**oneri,
                'oneri_turu': 'KRITIK_NAKIT',
                'renk': 'KIRMIZI',
                'baslik': f"⛔ {oneri.get('banka','')} — NAKİT YETERSİZ",
                'aciklama': f"Strateji {tavsiye:,.0f}₺ öneriyor ama kasada yeterli nakit yok.",
                'tavsiye_tutar': 0,
                'blink': True
            }
        else:
            kullanilabilir -= tavsiye
        cozulmus_oneriler.append(oneri)

    # ── NET AKIŞ + BU AYIN CİROSU — core'dan al ────────────────
    with db() as (conn, cur):
        akis    = net_akis_30_gun(cur)
        son_30_gelir = akis["gelir"]
        son_30_gider = akis["gider"]
        net_akis_30  = akis["net"]

        # Bu ayın cirosu (sadece ciro tablosundan — kasa'dan değil)
        cur.execute("""
            SELECT COALESCE(SUM(toplam), 0) as ciro
            FROM ciro
            WHERE durum='aktif'
            AND EXTRACT(YEAR FROM tarih) = EXTRACT(YEAR FROM CURRENT_DATE)
            AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
        """)
        bu_ay_ciro = float(cur.fetchone()['ciro'])

        # ── BUGÜN VE GECİKMİŞ ÖDEMELER (gerçek veri — kırmızı alan) ──
        cur.execute("""
            SELECT id, aciklama, tarih::TEXT, odenecek_tutar, asgari_tutar,
                   kaynak_tablo, kaynak_id
            FROM odeme_plani
            WHERE durum IN ('bekliyor','onay_bekliyor')
            AND tarih <= CURRENT_DATE
            ORDER BY tarih ASC
        """)
        bugun_odemeler = [
            {
                'odeme_id': str(r['id']),
                'aciklama': r['aciklama'],
                'tarih': r['tarih'],
                'tutar': float(r['odenecek_tutar']),
                'asgari': float(r['asgari_tutar'] or r['odenecek_tutar'] * 0.4),
                'gun_farki': (date.fromisoformat(r['tarih']) - bugun).days,
                'blink': True,
                'seviye': 'KRITIK',
                'kaynak_tablo': r['kaynak_tablo'] or '',
                'kaynak_id': str(r['kaynak_id']) if r['kaynak_id'] else None,
            }
            for r in cur.fetchall()
        ]

        # ── YAKLAŞAN ÖDEMELER (yarın+ 30 gün — mavi bant) ──────
        cur.execute("""
            SELECT id, aciklama, tarih::TEXT, odenecek_tutar, asgari_tutar,
                   kaynak_tablo, kaynak_id
            FROM odeme_plani
            WHERE durum IN ('bekliyor','onay_bekliyor')
            AND tarih BETWEEN CURRENT_DATE + INTERVAL '1 day'
                          AND CURRENT_DATE + INTERVAL '30 days'
            ORDER BY tarih ASC
        """)
        yaklasan_odemeler = [
            {
                'odeme_id': str(r['id']),
                'aciklama': r['aciklama'],
                'tarih': r['tarih'],
                'tutar': float(r['odenecek_tutar']),
                'asgari': float(r['asgari_tutar'] or r['odenecek_tutar'] * 0.4),
                'gun_farki': (date.fromisoformat(r['tarih']) - bugun).days,
                'kaynak_tablo': r['kaynak_tablo'] or '',
                'kaynak_id': str(r['kaynak_id']) if r['kaynak_id'] else None,
            }
            for r in cur.fetchall()
        ]

        # ── DEĞİŞKEN GİDER HATIRLATMALARI — kasa etkilenmez, sadece uyarı ──
        cur.execute("""
            SELECT id, gider_adi, kategori, odeme_gunu, tutar
            FROM sabit_giderler
            WHERE aktif = TRUE AND tip = 'degisken'
            AND odeme_gunu <= EXTRACT(DAY FROM CURRENT_DATE) + 3
        """)
        for g in cur.fetchall():
            odeme_gun = int(g['odeme_gunu'] or 1)
            try:
                odeme_tarihi = date(bugun.year, bugun.month, odeme_gun)
            except ValueError:
                import calendar as _cal
                odeme_tarihi = date(bugun.year, bugun.month,
                                    _cal.monthrange(bugun.year, bugun.month)[1])
            gun_farki = (odeme_tarihi - bugun).days
            # Bu ay fatura ödendi mi — kasa_hareketleri FATURA_ODEMESI ile kontrol
            cur.execute("""
                SELECT 1 FROM kasa_hareketleri
                WHERE kaynak_id = %s AND kaynak_tablo = 'sabit_giderler'
                AND islem_turu = 'FATURA_ODEMESI' AND kasa_etkisi = true AND durum = 'aktif'
                AND EXTRACT(YEAR FROM tarih) = %s AND EXTRACT(MONTH FROM tarih) = %s
            """, (str(g['id']), bugun.year, bugun.month))
            if cur.fetchone():
                continue  # Bu ay zaten ödendi
            # Kart ile ödendi mi kontrol et
            cur.execute("""
                SELECT 1 FROM kart_hareketleri
                WHERE kaynak_id = %s AND kaynak_tablo = 'fatura_giderleri'
                AND islem_turu = 'HARCAMA' AND durum = 'aktif'
                AND EXTRACT(YEAR FROM tarih) = %s AND EXTRACT(MONTH FROM tarih) = %s
            """, (str(g['id']), bugun.year, bugun.month))
            if cur.fetchone():
                continue  # Bu ay kart ile ödendi
            bugun_odemeler.append({
                'odeme_id': None,
                'aciklama': g['gider_adi'],
                'tarih': str(odeme_tarihi),
                'tutar': float(g['tutar']) if g['tutar'] else 0,
                'asgari': 0,
                'gun_farki': gun_farki,
                'blink': gun_farki <= 0,
                'seviye': 'KRITIK' if gun_farki <= 0 else 'UYARI',
                'kaynak_tablo': 'sabit_giderler',
                'kaynak_id': str(g['id']),
                'tip': 'degisken',  # Panel'de farklı göster
                'kategori': g['kategori'],
            })

        # ── DEĞİŞKEN GİDER — YAKLAŞAN (4-30 gün) ──
        cur.execute("""
            SELECT id, gider_adi, kategori, odeme_gunu, tutar
            FROM sabit_giderler
            WHERE aktif = TRUE AND tip = 'degisken'
            AND odeme_gunu > EXTRACT(DAY FROM CURRENT_DATE) + 3
            AND odeme_gunu <= EXTRACT(DAY FROM CURRENT_DATE) + 30
        """)
        for g in cur.fetchall():
            odeme_gun = int(g['odeme_gunu'] or 1)
            try:
                odeme_tarihi = date(bugun.year, bugun.month, odeme_gun)
            except ValueError:
                import calendar as _cal
                odeme_tarihi = date(bugun.year, bugun.month,
                                    _cal.monthrange(bugun.year, bugun.month)[1])
            gun_farki = (odeme_tarihi - bugun).days
            if gun_farki <= 0:
                continue
            cur.execute("""
                SELECT 1 FROM kasa_hareketleri
                WHERE kaynak_id = %s AND kaynak_tablo = 'sabit_giderler'
                AND islem_turu = 'FATURA_ODEMESI' AND kasa_etkisi = true AND durum = 'aktif'
                AND EXTRACT(YEAR FROM tarih) = %s AND EXTRACT(MONTH FROM tarih) = %s
            """, (str(g['id']), bugun.year, bugun.month))
            if cur.fetchone():
                continue
            cur.execute("""
                SELECT 1 FROM kart_hareketleri
                WHERE kaynak_id = %s AND kaynak_tablo = 'fatura_giderleri'
                AND islem_turu = 'HARCAMA' AND durum = 'aktif'
                AND EXTRACT(YEAR FROM tarih) = %s AND EXTRACT(MONTH FROM tarih) = %s
            """, (str(g['id']), bugun.year, bugun.month))
            if cur.fetchone():
                continue
            yaklasan_odemeler.append({
                'odeme_id': None,
                'aciklama': g['gider_adi'],
                'tarih': str(odeme_tarihi),
                'tutar': float(g['tutar']) if g['tutar'] else 0,
                'asgari': 0,
                'gun_farki': gun_farki,
                'kaynak_tablo': 'sabit_giderler',
                'kaynak_id': str(g['id']),
                'tip': 'degisken',
                'kategori': g['kategori'],
            })

        # Geriye dönük uyumluluk için
        bu_ay_bekleyen = bugun_odemeler + yaklasan_odemeler

        # ── KAÇ GÜN DAYANIR — core ──────────────────────────────
        kac_gun = kac_gun_dayanir(cur)

        # ── 30 GÜN ÖDEME BASKISI — core (zaten hesaplandı) ──────
        odeme_ozet = {
            "t7":  yuk_7,
            "t15": yuk_15,
            "t30": yuk_30,
        }

        # ── EN RİSKLİ KART ──────────────────────────────────────
        en_riskli_kart = None
        if kart_analiz:
            en_riskli_kart = max(kart_analiz, key=lambda x: x['limit_doluluk'])

        # ── SİMÜLASYON GERİ BESLEMESİ + RİSK GÜNÜ ─────────────
        # Önerilen ödemeler simülasyona yansıtılır
        onerilen_odemeler = {}
        for oneri in cozulmus_oneriler:
            if oneri['tavsiye_tutar'] > 0:
                tarih_str = oneri.get('tarih')
                # Tarihi olmayan öneriler simülasyona dahil edilmez
                # (hepsini bugüne atarak simülasyonu bozmamak için)
                if not tarih_str or tarih_str == str(bugun):
                    continue
                onerilen_odemeler[tarih_str] = onerilen_odemeler.get(tarih_str, 0) + oneri['tavsiye_tutar']

        sim_guncellenmis = []
        for gun in sim:
            ekstra = onerilen_odemeler.get(gun['tarih'], 0)
            yeni_kasa = gun['kasa_tahmini'] - ekstra
            sim_guncellenmis.append({**gun,
                'kasa_tahmini_onerili': yeni_kasa,
                'risk_onerili': yeni_kasa < 0
            })
        sim = sim_guncellenmis

        risk_gunu = None
        risk_gunu_onerili = None
        for gun in sim:
            # Önce orijinal simülasyona bak
            if gun['risk'] and not risk_gunu:
                risk_gunu = gun['tarih']
            # Sonra önerili simülasyona bak (ödemeler yapılırsa ne olur)
            if gun.get('risk_onerili') and not risk_gunu_onerili:
                risk_gunu_onerili = gun['tarih']

        # ── GENEL DURUM (MASTER KARAR) ──────────────────────────
        # Tüm sinyalleri değerlendirerek tek genel durum üret
        kritik_sayisi = len([u for u in uyarilar if u['seviye'] == 'KRITIK'])
        kritik_sayisi += len([o for o in cozulmus_oneriler if o['oneri_turu'] == 'KRITIK_NAKIT'])
        kritik_sayisi += karar['ozet']['kritik']

        uyari_sayisi = len([u for u in uyarilar if u['seviye'] == 'UYARI'])
        uyari_sayisi += karar['ozet']['uyari']

        # Ağırlıklı skor sistemi — 1 küçük uyarı tüm sistemi KRİTİK yapmamalı
        skor = 0
        skor += kritik_sayisi * 30
        skor += uyari_sayisi * 10
        skor += (30 if kasa < 0 else 0)
        skor += (20 if serbest < 0 else 0)
        skor += (15 if risk_gunu else 0)
        if en_riskli_kart and en_riskli_kart.get('limit_doluluk', 0) > 0.85:
            skor += 20
        elif en_riskli_kart and en_riskli_kart.get('limit_doluluk', 0) > 0.65:
            skor += 10

        if skor >= 40:
            genel_durum = 'KRITIK'
        elif skor >= 15:
            genel_durum = 'UYARI'
        else:
            genel_durum = 'SAGLIKLI' 

    return {
        # Temel göstergeler
        'kasa': kasa,
        'serbest_nakit': serbest,
        'yuk_7': yuk_7,
        'yuk_15': yuk_15,
        'yuk_30': yuk_30,
        'zorunlu_giderler': zorunlu,
        'kac_gun_dayanir': kac_gun,

        # Dönem analizi
        'bu_ay_ciro': bu_ay_ciro,
        'bu_ay_bekleyen': bu_ay_bekleyen,
        'bugun_odemeler': bugun_odemeler,
        'yaklasan_odemeler': yaklasan_odemeler,
        'net_akis_30': net_akis_30,
        'son_30_gelir': son_30_gelir,
        'son_30_gider': son_30_gider,

        # Ödeme baskısı
        'odeme_ozet': odeme_ozet,

        # Master karar
        'genel_durum': genel_durum,
        'ozet': {'kritik': kritik_sayisi, 'uyari': uyari_sayisi},

        # Uyarılar (birleştirilmiş)
        'uyarilar': uyarilar,
        'kararlar': karar['kararlar'],

        # Strateji (çelişki çözülmüş)
        'oneriler': cozulmus_oneriler,

        # Kart analiz
        'kart_analiz': kart_analiz,
        'en_riskli_kart': en_riskli_kart,

        # Simülasyon
        'simulasyon': sim,
        'risk_gunu': risk_gunu,
        'risk_gunu_onerili': risk_gunu_onerili,
    }
