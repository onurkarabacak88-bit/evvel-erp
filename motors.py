import logging
import os
from database import db
from datetime import date, timedelta, datetime

from tr_saat import bugun_tr
from finans_core import (
    kasa_bakiyesi, odeme_yuku, gunluk_ciro_ortalama,
    nakit_akis_sim, kart_borc, tum_kart_borclari,
    kart_ekstre, kart_bu_ay_odenen, kart_faiz_tahmini,
    kart_asgari_orani, son_odeme_tarihi_hesapla, _safe_date,
    zorunlu_gider_tahmini, serbest_nakit, net_akis_30_gun,
    kac_gun_dayanir, kasa_bakiyesi_tarihte,
)

def fmt(n):
    if n is None:
        return "---"
    return f"{int(n):,} ₺".replace(",", ".")


def _kart_esikleri() -> dict:
    """
    Kart doluluk uyarı eşikleri env'den okunur.
    Env değişkenleri:
      EVVEL_KART_ESIK_KRITIK  (varsayılan 0.90 → %90)
      EVVEL_KART_ESIK_UYARI   (varsayılan 0.75 → %75)
    """
    def _float(key, default):
        try:
            v = float((os.environ.get(key) or str(default)).strip())
            return max(0.5, min(v, 1.0))
        except (ValueError, AttributeError):
            return default
    return {
        "kritik": _float("EVVEL_KART_ESIK_KRITIK", 0.90),
        "uyari":  _float("EVVEL_KART_ESIK_UYARI", 0.75),
    }


def _asgari_oran() -> float:
    """
    Kart asgari ödeme oranı env'den okunur.
    Env: EVVEL_KART_ASGARI_ORAN (varsayılan 0.40 → %40)
    """
    try:
        v = float((os.environ.get("EVVEL_KART_ASGARI_ORAN") or "0.40").strip())
        return max(0.10, min(v, 1.0))
    except (ValueError, AttributeError):
        return 0.40


_UYARI_CACHE = {"ts": None, "data": []}
_UYARI_CACHE_TTL_SN = 30
_FINANS_OZET_CACHE = {"ts": None, "data": None}
_FINANS_OZET_CACHE_TTL_SN = 8
_logger = logging.getLogger("evvel-erp")


def uyari_cache_clear() -> None:
    """Uyarı motoru önbelleğini elle temizler (ödeme/ertele sonrası)."""
    _UYARI_CACHE["ts"] = None
    _UYARI_CACHE["data"] = []

# ── KARAR MOTORU ───────────────────────────────────────────────
def karar_motoru():
    bugun = bugun_tr()
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
            _ke = _kart_esikleri()
            if doluluk >= _ke["kritik"]:
                kararlar.append({
                    "kural": 7, "seviye": "KRITIK", "renk": "KIRMIZI",
                    "baslik": f"Kart Limiti Kritik: {k['banka']}",
                    "mesaj": f"{k['kart_adi']} limiti %{doluluk*100:.0f} dolu. Kalan: {fmt(kalan)}",
                    "aksiyon": "Kart ödemesi yapın veya nakit kullanın",
                    "blink": True
                })
            elif doluluk >= _ke["uyari"]:
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
    bugun = bugun_tr()
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
            asgari = float(o['asgari_tutar'] or tam * _asgari_oran())
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
                asgari = float(ek['asgari_tutar'] or tam * _asgari_oran())
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
    bugun = bugun_tr()
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
                AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', CURRENT_DATE)
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
                'tek_cekim': tek_cekim,
                'aylik_taksit': aylik_taksit,
                'devreden_faiz': ekstre_v.get('devreden_faiz', 0),
                'bu_ay_faiz': bu_ay_faiz,
                'asgari_odeme': bu_ekstre * kart_asgari_orani(k),
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
    bugun = bugun_tr()
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

        # 5. KART ASGARİ ÖDEMELERİ — KESİM EKSTRESİ BAZLI
        # ÖNEMLİ KURAL: Bu ay (yıl/ay) içinde son ödeme tarihi olan ekstre =
        # bu ayın kesim tarihinde kapanmış olan ekstredir. Plan = O ekstrenin
        # tutarı + asgarisi. Kesim sonrası harcamalar BU ay değil, BİR SONRAKİ
        # ay planına dahil olur (sıradaki kesim → sıradaki son_odeme).
        cur.execute("SELECT * FROM kartlar WHERE aktif=TRUE")
        for k in cur.fetchall():
            kesim_gunu     = int(k['kesim_gunu'])
            son_odeme_gunu = int(k['son_odeme_gunu'] or 25)

            # Bu ayın kesim tarihi
            bu_ay_kesim = _safe_date(yil, ay, kesim_gunu)
            son_odeme_tarihi = son_odeme_tarihi_hesapla(bu_ay_kesim, son_odeme_gunu)

            # Bu ayın kesimine ait ekstre (önceki kesim → bu kesim arası harcamalar)
            ekstre_v = kart_ekstre(cur, k['id'], kesim_gunu, kesim_tarihi=bu_ay_kesim)
            bu_ekstre = ekstre_v["ekstre_toplam"]
            if bu_ekstre <= 0:
                atlanan.append(f"Kart atlandı (bu ay ekstre yok): {k['kart_adi']}")
                continue

            asgari = round(bu_ekstre * kart_asgari_orani(k), 2)
            odenecek = round(bu_ekstre, 2)

            # Bu kesim için (kesim → son_odeme] arası ÖDEMELER
            # Planı otomatik "ödendi" yapma kararı için.
            cur.execute("""
                SELECT COALESCE(SUM(tutar), 0) AS odenen
                FROM kart_hareketleri
                WHERE kart_id = %s AND durum = 'aktif' AND islem_turu = 'ODEME'
                  AND tarih >  %s::date
                  AND tarih <= %s::date
            """, (k['id'], bu_ay_kesim, son_odeme_tarihi))
            odenen_kesim = float(cur.fetchone()['odenen'])

            # Tam ödendiyse → plan üretme/varsa "odendi" yap
            if odenen_kesim >= odenecek - 0.01:
                cur.execute("""
                    UPDATE odeme_plani
                       SET durum = 'odendi',
                           odenen_tutar = %s,
                           odeme_tarihi = COALESCE(odeme_tarihi, CURRENT_DATE)
                     WHERE kart_id = %s
                       AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', %s::date)
                       AND durum IN ('bekliyor', 'onay_bekliyor')
                """, (odenen_kesim, k['id'], str(son_odeme_tarihi)))
                atlanan.append(f"Kart atlandı (tam ödenmiş): {k['kart_adi']}")
                continue

            # Asgari ödendiyse → BU AY için ek ödeme yok; kalan SONRAKI aya devreder
            # (kart_aktif_donem zaten devreden anapara+faiz olarak yansıtır)
            if odenen_kesim >= asgari * 0.999:
                # Var olan planı "asgari_odendi" işaretle (durum kolonu mevcut değerlere uyumlu)
                cur.execute("""
                    UPDATE odeme_plani
                       SET durum = 'odendi',
                           odenen_tutar = %s,
                           odeme_tarihi = COALESCE(odeme_tarihi, CURRENT_DATE),
                           aciklama = COALESCE(aciklama, '') ||
                                      ' [ASGARİ ÖDENDİ — kalan ' ||
                                      ROUND((%s - %s)::numeric, 2)::text ||
                                      ' TL sonraki aya devretti]'
                     WHERE kart_id = %s
                       AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', %s::date)
                       AND durum IN ('bekliyor', 'onay_bekliyor')
                """, (odenen_kesim, odenecek, odenen_kesim, k['id'], str(son_odeme_tarihi)))
                atlanan.append(f"Kart atlandı (asgari ödenmiş): {k['kart_adi']}")
                continue

            # Asgari/tam ödenmemiş → planı oluştur veya güncelle
            pid = str(_uuid.uuid4())
            cur.execute("""
                INSERT INTO odeme_plani (id, kart_id, tarih, odenecek_tutar, asgari_tutar, aciklama, durum)
                SELECT %s, %s, %s, %s, %s, %s, 'bekliyor'
                WHERE NOT EXISTS (
                    SELECT 1 FROM odeme_plani
                    WHERE kart_id = %s
                    AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', %s::date)
                    AND durum != 'iptal'
                )
            """, (pid, k['id'], son_odeme_tarihi, odenecek, asgari,
                  f"Kart ekstre: {k['kart_adi']} — {k['banka']} (kesim {bu_ay_kesim})",
                  k['id'], str(son_odeme_tarihi)))
            if cur.rowcount > 0:
                uretilen.append(f"Kart: {k['kart_adi']} ekstre {fmt(odenecek)} / asgari {fmt(asgari)} — {son_odeme_tarihi}")
            else:
                # Plan zaten var — güncel ekstre ile güncelle (kesim sonrası eklenmez)
                cur.execute("""
                    UPDATE odeme_plani
                       SET odenecek_tutar = %s, asgari_tutar = %s
                     WHERE kart_id = %s
                       AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', %s::date)
                       AND durum IN ('bekliyor', 'onay_bekliyor')
                """, (odenecek, asgari, k['id'], str(son_odeme_tarihi)))
                if cur.rowcount > 0:
                    uretilen.append(f"Kart güncellendi: {k['kart_adi']} yeni ekstre {fmt(odenecek)} — {son_odeme_tarihi}")

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
    now = datetime.utcnow()
    cts = _UYARI_CACHE.get("ts")
    if cts and (now - cts).total_seconds() < _UYARI_CACHE_TTL_SN:
        return list(_UYARI_CACHE.get("data") or [])

    bugun = bugun_tr()
    uyarilar = []

    with db() as (conn, cur):
        cur.execute("""
            SELECT op.*,
                   k.kart_adi, k.banka
            FROM odeme_plani op
            LEFT JOIN kartlar k ON k.id = op.kart_id
            WHERE op.durum IN ('bekliyor','onay_bekliyor')
            AND op.tarih BETWEEN %s AND %s
            ORDER BY op.tarih ASC
        """, (bugun - timedelta(days=3), bugun + timedelta(days=7)))

        for o in cur.fetchall():
            gun_farki = (o['tarih'] - bugun).days
            tutar = float(o['odenecek_tutar'])
            asgari = float(o['asgari_tutar'] or tutar * _asgari_oran())

            # ── KESİM BAZLI ASGARİ KONTROLÜ (kartlar için) ─────────────
            # Eski planlar `kart_borc()` kullanılarak üretilmiş olabilir;
            # `tutar` ve `asgari` kesim sonrası harcamaları da içerir.
            # Burada: plan tarihinin ait olduğu KESİME ait GERÇEK ekstreyi
            # ve o kesim için ödenen tutarı hesapla → asgari karşılandıysa
            # planı uyarıdan düş, var olan kaydı da "odendi"ye çevir.
            if o.get("kart_id"):
                try:
                    cur.execute("""
                        SELECT kesim_gunu, son_odeme_gunu, asgari_oran, faiz_orani
                        FROM kartlar WHERE id = %s
                    """, (o['kart_id'],))
                    krow = cur.fetchone()
                    if krow:
                        kg = int(krow['kesim_gunu'])
                        sg = int(krow['son_odeme_gunu'])
                        plan_tarih = o['tarih']
                        # Plan tarihi son_odeme; bu ekstrenin kesim tarihi:
                        if plan_tarih.day >= sg:
                            kesim_y, kesim_m = plan_tarih.year, plan_tarih.month
                        else:
                            if plan_tarih.month == 1:
                                kesim_y, kesim_m = plan_tarih.year - 1, 12
                            else:
                                kesim_y, kesim_m = plan_tarih.year, plan_tarih.month - 1
                        from finans_core import _safe_date as _sd, kart_ekstre as _ke
                        kesim_t = _sd(kesim_y, kesim_m, kg)
                        son_odeme_t = o['tarih']

                        # Bu kesime ait GERÇEK ekstre
                        ek = _ke(cur, o['kart_id'], kg, kesim_tarihi=kesim_t)
                        gercek_ekstre = float(ek.get('ekstre_toplam') or 0)
                        gercek_asgari = round(gercek_ekstre * float(krow.get('asgari_oran') or 40) / 100.0, 2)

                        # Bu kesim için (kesim, son_odeme] arası ödemeler
                        cur.execute("""
                            SELECT COALESCE(SUM(tutar), 0) AS odenen
                            FROM kart_hareketleri
                            WHERE kart_id = %s AND durum = 'aktif' AND islem_turu = 'ODEME'
                              AND tarih >  %s::date AND tarih <= %s::date
                        """, (o['kart_id'], kesim_t, son_odeme_t))
                        kesim_odenen = float(cur.fetchone()['odenen'])

                        if gercek_ekstre > 0 and kesim_odenen >= gercek_asgari * 0.999:
                            # Asgari karşılanmış → planı kalıcı temizle, uyarıdan çıkar
                            cur.execute("""
                                UPDATE odeme_plani
                                   SET durum = 'odendi',
                                       odenen_tutar = %s,
                                       odeme_tarihi = COALESCE(odeme_tarihi, CURRENT_DATE),
                                       aciklama = COALESCE(aciklama, '') ||
                                                  ' [AUTO: kesim ' || %s::text ||
                                                  ' asgari ödendi]'
                                 WHERE id = %s
                                   AND durum IN ('bekliyor', 'onay_bekliyor')
                            """, (kesim_odenen, str(kesim_t), o['id']))
                            continue
                except Exception:
                    pass  # Hata olursa eski mantık devam etsin

            # Bu kart için içinde bulunulan ayda yapılan toplam ödeme (kasa + kart hareketleri üzerinden)
            bu_ay_odenen = 0.0
            if o['kart_id']:
                try:
                    bu_ay_odenen = float(kart_bu_ay_odenen(cur, o['kart_id']) or 0)
                except Exception:
                    bu_ay_odenen = 0.0

            asgari_kalan = max(0.0, asgari - bu_ay_odenen)
            # Kredi kartı asgari bu ay TAM kapanmışsa panel uyarı listesinden düş.
            # Asgari'nin altında kısmi ödeme yapılmışsa plan 'bekliyor' kalır ve burada görünmeye devam eder —
            # kullanıcı kalan asgari miktarı (asgari - bu_ay_odenen) görür.
            if o.get("kart_id") and asgari > 0 and bu_ay_odenen >= asgari * 0.999:
                continue

            # Kart asgarisi — son ödeme tarihi geçtiyse paneli kirletme.
            # Bu noktadan sonra borç bir sonraki ekstreye/faize aktarılır,
            # "bu ay'ın asgari hatırlatıcısı" anlamını yitirir.
            if o.get("kart_id") and gun_farki < 0:
                continue

            if gun_farki < 0:
                seviye = "KRITIK"
                renk = "KIRMIZI"
                mesaj = f"⛔ GECİKMİŞ ÖDEME! {abs(gun_farki)} gün önce geçti."
                blink = True
            elif gun_farki == 0:
                if bu_ay_odenen >= asgari:
                    # Üstte continue ile zaten elenir; güvenlik için BILGI dalı
                    seviye = "BILGI"
                    renk = "SARI"
                    mesaj = (
                        f"✅ Bu ay {fmt(bu_ay_odenen)} ödendi. "
                        f"Kalan borç: {fmt(tutar)} — yeni ödeme yapacak mısın?"
                    )
                    blink = False
                elif o.get("kart_id") and bu_ay_odenen > 0:
                    # Asgari'nin altında kısmi ödeme yapılmış — eksik kısmı vurgula
                    seviye = "KRITIK"
                    renk = "KIRMIZI"
                    mesaj = (
                        f"🔴 BUGÜN SON GÜN! Asgari için EKSİK: {fmt(asgari_kalan)} "
                        f"(ödenen {fmt(bu_ay_odenen)} / asgari {fmt(asgari)})"
                    )
                    blink = True
                else:
                    seviye = "KRITIK"
                    renk = "KIRMIZI"
                    mesaj = (
                        "🔴 BUGÜN SON GÜN! Asgari için kalan: "
                        f"{fmt(asgari_kalan)} (bu ay ödenen {fmt(bu_ay_odenen)} / asgari {fmt(asgari)})"
                    )
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
                "asgari_kalan": asgari_kalan,
                "bu_ay_odenen": bu_ay_odenen,
                "gun_farki": gun_farki,
                "seviye": seviye,
                "renk": renk,
                "mesaj": mesaj,
                "blink": blink,
                "kart_id": str(o["kart_id"]) if o.get("kart_id") else None,
                "kart_adi": o['kart_adi'],
                "banka": o['banka'],
                "kaynak_tablo": o.get("kaynak_tablo"),
                "kaynak_id": str(o["kaynak_id"]) if o.get("kaynak_id") else None,
            })

        # Şubeden gelen ve merkez onayı bekleyen anlık giderler de uyarıya dahil.
        cur.execute(
            """
            SELECT id, tarih, kategori, tutar, aciklama, sube, olusturma
            FROM anlik_giderler
            WHERE durum='onay_bekliyor'
              AND tarih BETWEEN %s AND %s
            ORDER BY tarih ASC, olusturma ASC
            """,
            (bugun - timedelta(days=3), bugun + timedelta(days=7)),
        )
        for g in cur.fetchall():
            gun_farki = (g['tarih'] - bugun).days
            if gun_farki < 0:
                seviye = "KRITIK"
                renk = "KIRMIZI"
                mesaj = f"⛔ GECİKMİŞ ŞUBE GİDERİ! {abs(gun_farki)} gün önce girildi, merkez onayı bekliyor."
                blink = True
            elif gun_farki == 0:
                seviye = "KRITIK"
                renk = "KIRMIZI"
                mesaj = "🔴 BUGÜN TARİHLİ ŞUBE GİDERİ merkez onayı bekliyor."
                blink = True
            elif gun_farki <= 2:
                seviye = "UYARI"
                renk = "TURUNCU"
                mesaj = f"🟠 {gun_farki} gün içinde şube gideri var, onay bekliyor."
                blink = False
            else:
                seviye = "BILGI"
                renk = "SARI"
                mesaj = f"🟡 Yaklaşan şube gideri ({gun_farki} gün), onay bekliyor."
                blink = False

            uyarilar.append({
                # anlik_giderler id — ödeme planı değil; odeme_id taşınmaz (panel yanlış API çağırmasın)
                "odeme_id": None,
                "aciklama": f"Şube Anlık Gideri: {g['kategori']} — {(g.get('aciklama') or '').strip() or 'Açıklama yok'}",
                "tarih": str(g['tarih']),
                "tutar": float(g['tutar'] or 0),
                "asgari": float(g['tutar'] or 0),
                "gun_farki": gun_farki,
                "seviye": seviye,
                "renk": renk,
                "mesaj": mesaj,
                "blink": blink,
                "kart_adi": None,
                "banka": None,
                "kaynak_tablo": "anlik_giderler",
                "kaynak_id": str(g['id']),
                "sube": g.get('sube'),
                "durum": "onay_bekliyor",
            })

        # Scheduler durduysa ve odeme_plani üretilmediyse, vadeli alımı doğrudan da uyar.
        cur.execute(
            """
            SELECT v.id, v.aciklama, v.tutar, v.vade_tarihi, v.tedarikci
            FROM vadeli_alimlar v
            WHERE v.durum='bekliyor'
              AND v.vade_tarihi BETWEEN %s AND %s
              AND NOT EXISTS (
                  SELECT 1
                  FROM odeme_plani op
                  WHERE op.kaynak_tablo='vadeli_alimlar'
                    AND op.kaynak_id = v.id
                    AND op.durum IN ('bekliyor','onay_bekliyor')
              )
            ORDER BY v.vade_tarihi ASC
            """,
            (bugun - timedelta(days=3), bugun + timedelta(days=7)),
        )
        for v in cur.fetchall():
            gun_farki = (v['vade_tarihi'] - bugun).days
            if gun_farki < 0:
                seviye = "KRITIK"
                renk = "KIRMIZI"
                mesaj = f"⛔ VADELİ ALIM GECİKMİŞ! {abs(gun_farki)} gün geçti, plan kaydı eksik."
                blink = True
            elif gun_farki == 0:
                seviye = "KRITIK"
                renk = "KIRMIZI"
                mesaj = "🔴 VADELİ ALIM SON GÜNÜ BUGÜN! Plan kaydı eksik."
                blink = True
            elif gun_farki <= 2:
                seviye = "UYARI"
                renk = "TURUNCU"
                mesaj = f"🟠 {gun_farki} gün içinde vadeli alım vadesi var (plan kaydı yok)."
                blink = False
            else:
                seviye = "BILGI"
                renk = "SARI"
                mesaj = f"🟡 Yaklaşan vadeli alım vadesi ({gun_farki} gün), plan kaydı eksik."
                blink = False

            uyarilar.append({
                "odeme_id": None,
                "aciklama": f"Vadeli Alım: {v['aciklama']}",
                "tarih": str(v['vade_tarihi']),
                "tutar": float(v['tutar'] or 0),
                "asgari": float(v['tutar'] or 0),
                "gun_farki": gun_farki,
                "seviye": seviye,
                "renk": renk,
                "mesaj": mesaj,
                "blink": blink,
                "kart_adi": None,
                "banka": v.get('tedarikci'),
                "kaynak_tablo": "vadeli_alimlar",
                "kaynak_id": str(v['id']),
            })

    _UYARI_CACHE["ts"] = now
    _UYARI_CACHE["data"] = list(uyarilar)
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

# ── MASTER FİNANS MOTORU ───────────────────────────────────────
def finans_ozet_motoru():
    """
    Tüm motorları birleştirir, çelişkileri çözer, tek karar üretir.
    Panel bu fonksiyonu çağırır — başka bir şey çağırmaz.
    """
    now = datetime.now()
    cache_ts = _FINANS_OZET_CACHE.get("ts")
    cache_data = _FINANS_OZET_CACHE.get("data")
    if cache_ts and cache_data and (now - cache_ts).total_seconds() < _FINANS_OZET_CACHE_TTL_SN:
        return cache_data

    bugun = bugun_tr()

    # Tüm motorları çalıştır
    karar = karar_motoru()
    strateji = odeme_strateji_motoru()
    uyarilar = uyari_motoru()
    # uyarilar'da görünen odeme_plani satırlarını set olarak hazırla — aşağıdaki
    # bugun_odemeler / yaklasan_odemeler listelerinde DEDUP için kullanılacak.
    # Aynı kira/fatura iki ayrı pencerede birden çok kez görünmesin.
    _uyari_odeme_ids = {u.get('odeme_id') for u in uyarilar if u.get('odeme_id')}
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
            AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', CURRENT_DATE)
        """)
        bu_ay_ciro = float(cur.fetchone()['ciro'])

        # ── BUGÜN VE GECİKMİŞ ÖDEMELER (gerçek veri — kırmızı alan) ──
        cur.execute("""
            SELECT id, aciklama, tarih::TEXT, odenecek_tutar, asgari_tutar,
                   kaynak_tablo, kaynak_id, kart_id
            FROM odeme_plani
            WHERE durum IN ('bekliyor','onay_bekliyor')
            AND tarih <= CURRENT_DATE
            ORDER BY tarih ASC
        """)
        bugun_odemeler = []
        for r in cur.fetchall():
            # Aynı plan zaten uyarilar listesindeyse burada tekrarlama
            if str(r['id']) in _uyari_odeme_ids:
                continue
            asg_f = float(r['asgari_tutar'] or r['odenecek_tutar'] * _asgari_oran())
            kid = r.get('kart_id')
            if kid:
                try:
                    if asg_f > 0 and float(kart_bu_ay_odenen(cur, str(kid))) >= asg_f * 0.999:
                        continue
                except Exception:
                    pass
            row_bo = {
                'odeme_id': str(r['id']),
                'aciklama': r['aciklama'],
                'tarih': r['tarih'],
                'tutar': float(r['odenecek_tutar']),
                'asgari': asg_f,
                'gun_farki': (date.fromisoformat(r['tarih']) - bugun).days,
                'blink': True,
                'seviye': 'KRITIK',
                'kaynak_tablo': r['kaynak_tablo'] or '',
                'kaynak_id': str(r['kaynak_id']) if r['kaynak_id'] else None,
                'kart_id': str(kid) if kid else None,
            }
            if kid:
                try:
                    ob = float(kart_bu_ay_odenen(cur, str(kid)))
                    row_bo['bu_ay_odenen'] = ob
                    row_bo['asgari_kalan'] = max(0.0, asg_f - ob)
                except Exception:
                    row_bo['bu_ay_odenen'] = 0.0
                    row_bo['asgari_kalan'] = asg_f
            bugun_odemeler.append(row_bo)

        # ── YAKLAŞAN ÖDEMELER (yarın+ 30 gün — mavi bant) ──────
        cur.execute("""
            SELECT id, aciklama, tarih::TEXT, odenecek_tutar, asgari_tutar,
                   kaynak_tablo, kaynak_id, kart_id
            FROM odeme_plani
            WHERE durum IN ('bekliyor','onay_bekliyor')
            AND tarih BETWEEN CURRENT_DATE + INTERVAL '1 day'
                          AND CURRENT_DATE + INTERVAL '30 days'
            ORDER BY tarih ASC
        """)
        yaklasan_odemeler = []
        for r in cur.fetchall():
            # Aynı plan zaten uyarilar listesindeyse burada tekrarlama
            if str(r['id']) in _uyari_odeme_ids:
                continue
            asg_f = float(r['asgari_tutar'] or r['odenecek_tutar'] * _asgari_oran())
            kid = r.get('kart_id')
            if kid:
                try:
                    if asg_f > 0 and float(kart_bu_ay_odenen(cur, str(kid))) >= asg_f * 0.999:
                        continue
                except Exception:
                    pass
            yaklasan_odemeler.append({
                'odeme_id': str(r['id']),
                'aciklama': r['aciklama'],
                'tarih': r['tarih'],
                'tutar': float(r['odenecek_tutar']),
                'asgari': asg_f,
                'gun_farki': (date.fromisoformat(r['tarih']) - bugun).days,
                'kaynak_tablo': r['kaynak_tablo'] or '',
                'kaynak_id': str(r['kaynak_id']) if r['kaynak_id'] else None,
                'kart_id': str(kid) if kid else None,
            })

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

        # ── CİRO EKSİK GÜNLER (son 7 gün) ────────────────────────
        son7_bas = bugun - timedelta(days=6)
        cur.execute(
            """
            SELECT tarih::date AS t
            FROM ciro
            WHERE durum='aktif'
              AND tarih BETWEEN %s AND %s
            GROUP BY tarih::date
            """,
            (son7_bas, bugun),
        )
        girilen_tarihler = {r["t"] for r in cur.fetchall()}
        ciro_eksik_gunler = []
        for i in range(7):
            g = son7_bas + timedelta(days=i)
            if g in girilen_tarihler:
                continue
            days_ago = (bugun - g).days
            ciro_eksik_gunler.append(
                {
                    "tarih": str(g),
                    "gun_adi": g.strftime("%A"),
                    "days_ago": days_ago,
                    "kritik": days_ago <= 2,  # son 3 gün
                }
            )

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

        try:
            from analitik_olay import analitik_olay_ekle

            erk = None
            if en_riskli_kart:
                erk = {
                    "banka": en_riskli_kart.get("banka"),
                    "kart_adi": en_riskli_kart.get("kart_adi"),
                    "limit_doluluk": round(float(en_riskli_kart.get("limit_doluluk") or 0), 4),
                }
            analitik_olay_ekle(
                cur,
                "FINANS_OZET_PAKET",
                sube_id=None,
                tutar_yok_bilgi=False,
                hesap_surumu="basarili",
                kaynak="finans_ozet_motoru",
                throttle_sn=120,
                payload={
                    "tarih": str(bugun),
                    "genel_durum": genel_durum,
                    "skor": skor,
                    "kasa": float(kasa),
                    "serbest_nakit": float(serbest),
                    "yuk_7": float(yuk_7),
                    "yuk_15": float(yuk_15),
                    "yuk_30": float(yuk_30),
                    "kritik_sayisi": int(kritik_sayisi),
                    "uyari_sayisi": int(uyari_sayisi),
                    "uyari_kayit": len(uyarilar),
                    "karar_kayit": len(karar.get("kararlar") or []),
                    "oneri_kayit": len(cozulmus_oneriler),
                    "risk_gunu": risk_gunu,
                    "risk_gunu_onerili": risk_gunu_onerili,
                    "kac_gun_dayanir": kac_gun,
                    "en_riskli_kart_ozet": erk,
                    "ciro_eksik_gun": len(ciro_eksik_gunler),
                },
            )
        except Exception:
            _logger.warning("FINANS_OZET analitik olayı atlandı", exc_info=True)

    out = {
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
        'ciro_eksik_gunler': ciro_eksik_gunler,
    }
    _FINANS_OZET_CACHE["ts"] = now
    _FINANS_OZET_CACHE["data"] = out
    return out
