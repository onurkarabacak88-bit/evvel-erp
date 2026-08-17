"""
DUYU SAF GÖRÜNÜMLERİ — FAZ 1c + 1e (2026-07-06, Duyu Ağı Master Planı)

İki salt-okur görünüm (çıkarım yok, alarm yok, kimlik yok):
  1c) VERGİ → NAKİT TAKVİMİ: ödenecek KDV + kira stopajı = önümüzdeki beyanname
      dönemlerinin tahmini nakit çıkışı. Patron "bu ay devlete ne çıkacak"ı görür.
  1e) KAPANIŞ-FARK ŞUBE PROFİLİ: şube bazında son N günün açılış/kapanış kasa farkı
      dağılımı — İSİMSİZ (kural #15), sadece sayılar; değerlendirme insanın.

İzole modül: hiçbir tabloya yazmaz. Kaldırmak: main.py'den router'ı çıkar.
"""
from __future__ import annotations

import logging
import re
from datetime import date, timedelta
from typing import Dict

from fastapi import APIRouter, Query

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/duyu", tags=["duyu-gorunumler"])

# Beyanname/ödeme günleri (TR pratik varsayım — yapılandırılabilir; bilgi amaçlı)
_KDV_ODEME_GUNU = 28       # takip eden ayın 28'i
_MUHTASAR_ODEME_GUNU = 28  # muhtasar da takip eden ayın sonuna doğru


# SAHİP-DAHİL MÜDAHALE İZİ (FAZ V, Grok'un özgün vuruşu — 2026-07-06):
# "Sahibin kendisi sistemi bypass ederse bunu görecek duyu yok; sahip kendi sistemini
# kandırabilir." Çözüm kural #15 ile çelişmez (o PERSONELİ korur) — bu ŞEFFAFLIKTIR:
# geçmişe dokunan / kayıt-değiştiren işlemler KİM YAPARSA YAPSIN (patron dahil) iz bırakır
# ve görünür olur. Öz-hesap-verebilirlik: "bir yıl sonra bu farkı neden elden kapattım?"
# sorusunun cevabı kayıtta olsun.
_GERIYE_DONUK_ISLEMLER = (
    "KAPANIS_GERI_AL", "KAPANIS_GERI_AL_TESLIM_SIL", "DUZELTME", "KASA_DUZELTME",
    "MUKERRER", "GECMIS_TEMIZLE", "IPTAL", "TERS_KAYIT", "K1_TELAFI_ODEME",
    "KISMI_ODE_KAPANIS", "GUNCELLEME",
)

# Prod audit_log tablosu koddan ESKİ bir şemayla kurulmuş olabilir (CREATE TABLE IF NOT
# EXISTS yeni kolonu eklemez) — zaman kolonu adını prod'un kendisinden keşfet, cache'le.
_AUDIT_ZAMAN_KOL: str | None = None


def _audit_zaman_kolonu(cur) -> str | None:
    """audit_log'daki ilk timestamp/date kolonunun adını döndürür (yoksa None)."""
    global _AUDIT_ZAMAN_KOL
    if _AUDIT_ZAMAN_KOL:
        return _AUDIT_ZAMAN_KOL
    cur.execute(
        """
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'audit_log'
          AND (data_type LIKE 'timestamp%%' OR data_type = 'date')
        ORDER BY ordinal_position LIMIT 1
        """
    )
    row = cur.fetchone()
    kol = dict(row).get("column_name") if row else None
    if kol and re.fullmatch(r"[a-z_][a-z0-9_]*", kol):
        _AUDIT_ZAMAN_KOL = kol
        return kol
    return None


@router.get("/mudahale-izi")
def mudahale_izi(gun: int = Query(30, ge=7, le=90)):
    """Geçmişe dokunan / kayıt-değiştiren işlemlerin izi (audit_log'dan, salt-okur).
    HÜKÜM YOK: her müdahale meşru olabilir — amaç görünürlük. Kişi kolonu bilerek yok
    (audit_log zaten kim-yaptı tutmuyor; iş TÜRÜ ve YOĞUNLUĞU izlenir)."""
    bas = date.today() - timedelta(days=gun - 1)
    with db() as (_, cur):
        zk = _audit_zaman_kolonu(cur)
        if not zk:
            return {"kesit": {"bas": str(bas), "gun": gun}, "islem_turleri": [],
                    "gunluk_yogunluk": [], "toplam": 0,
                    "not": "audit_log tablosunda zaman kolonu bulunamadı — iz görünümü "
                           "şema uyumu bekliyor (veri silinmedi, sadece okunamıyor)."}
        # zk information_schema'dan gelir + regex'le doğrulanır — interpolasyon güvenli
        cur.execute(
            f"""
            SELECT islem, tablo,
                   COUNT(*)::int AS adet,
                   MIN({zk})::date::text AS ilk,
                   MAX({zk})::date::text AS son
            FROM audit_log
            WHERE {zk} >= %s
              AND (islem = ANY(%s) OR islem LIKE '%%IPTAL%%' OR islem LIKE '%%GERI_AL%%'
                   OR islem LIKE '%%DUZELT%%' OR islem LIKE '%%TERS%%')
            GROUP BY islem, tablo
            ORDER BY adet DESC
            """,
            (str(bas), list(_GERIYE_DONUK_ISLEMLER)),
        )
        turler = [dict(r) for r in (cur.fetchall() or [])]
        cur.execute(
            f"""
            SELECT {zk}::date::text AS gun, COUNT(*)::int AS adet
            FROM audit_log
            WHERE {zk} >= %s
              AND (islem = ANY(%s) OR islem LIKE '%%IPTAL%%' OR islem LIKE '%%GERI_AL%%'
                   OR islem LIKE '%%DUZELT%%' OR islem LIKE '%%TERS%%')
            GROUP BY {zk}::date ORDER BY gun DESC LIMIT 30
            """,
            (str(bas), list(_GERIYE_DONUK_ISLEMLER)),
        )
        gunluk = [dict(r) for r in (cur.fetchall() or [])]
    return {
        "kesit": {"bas": str(bas), "gun": gun},
        "islem_turleri": turler,
        "gunluk_yogunluk": gunluk,
        "toplam": sum(t["adet"] for t in turler),
        "not": "SAHİP DAHİL tüm düzeltme/iptal/geri-alma işlemlerinin izi — hüküm yok, "
               "görünürlük var. Her müdahale meşru olabilir; yoğunlaşma ve zamanlama "
               "örüntüsünü İNSAN okur. (Grok: 'sistemin en kırılgan noktası, üst düzey "
               "insider'ın kendi sistemini bypass etmesidir' — bu ekran o kör noktayı kapatır.)",
    }


def gece_mudahale_olay_yaz() -> None:
    """GECE: dünün geriye-dönük müdahale sayısı > 0 ise omurgaya günlük özet olayı yaz.
    İdempotent (source_ref=gün); hata-yutar."""
    from duyu_omurga import duyu_nabiz_yaz
    try:
        dun = date.today() - timedelta(days=1)
        with db() as (_, cur):
            zk = _audit_zaman_kolonu(cur)
            if not zk:
                # Denetim P2-6: sessiz çıkış duyuyu görünmez susturuyordu — dürüst nabız
                duyu_nabiz_yaz("mudahale_izi", durum="hata", yutulan_hata=1,
                               not_metin="audit_log zaman kolonu yok — şema uyumu bekliyor")
                return
            cur.execute(
                f"""
                SELECT COUNT(*)::int AS n FROM audit_log
                WHERE {zk}::date = %s
                  AND (islem = ANY(%s) OR islem LIKE '%%IPTAL%%' OR islem LIKE '%%GERI_AL%%'
                       OR islem LIKE '%%DUZELT%%' OR islem LIKE '%%TERS%%')
                """,
                (str(dun), list(_GERIYE_DONUK_ISLEMLER)),
            )
            n = int(dict(cur.fetchone() or {}).get("n") or 0)
        if n > 0:
            from duyu_omurga import duyu_olay_yaz
            duyu_olay_yaz(
                "mudahale_izi", "operasyon.kayit.geriye_donuk_mudahale", str(dun),
                entity_scope="genel", occurred_at=str(dun),
                signal_name="Geriye dönük müdahale günü",
                payload={"adet": n},
            )
        duyu_nabiz_yaz("mudahale_izi", taranan=1, uretilen=1 if n > 0 else 0)
    except Exception as e:  # noqa: BLE001
        logger.warning("gece mudahale izi yutuldu: %s", str(e)[:120])
        duyu_nabiz_yaz("mudahale_izi", durum="hata", yutulan_hata=1, not_metin=str(e)[:200])


@router.get("/nakit-ufku")
def nakit_ufku(gun: int = Query(7, ge=3, le=30)):
    """NAKİT UFKU (L5-lite, 2026-07-07): 'bu ödemeleri yapabilecek miyim?' sorusunun
    HESAPLANMIŞ cevabı. 5-YZ reçetesi: deterministik ödeme takvimi + hareketli ortalama
    + 3 senaryo (%80/100/120); HESABI KOD YAPAR, dil modeli yalnız anlatır.
    TAHMİNDİR, taahhüt değil — sınırları 'not' alanında dürüstçe yazar."""
    bugun = date.today()
    bit = bugun + timedelta(days=gun)
    with db() as (_, cur):
        # 1) Önümüzdeki planlı ödemeler (bekleyenler)
        cur.execute(
            """
            SELECT tarih::text AS tarih, COALESCE(aciklama,'') AS aciklama,
                   ROUND((odenecek_tutar - COALESCE(odenen_tutar,0))::numeric,2) AS kalan
            FROM odeme_plani
            WHERE durum IN ('bekliyor','onay_bekliyor')
              AND tarih BETWEEN %s AND %s
              AND (odenecek_tutar - COALESCE(odenen_tutar,0)) > 0
            ORDER BY tarih
            """,
            (str(bugun), str(bit)),
        )
        odemeler = [dict(r) for r in (cur.fetchall() or [])]
        # 2) Son 14 gün günlük ciro ortalaması (aktif)
        cur.execute(
            """
            SELECT COALESCE(SUM(toplam),0) AS t, COUNT(DISTINCT tarih) AS g
            FROM ciro WHERE durum='aktif' AND tarih >= %s AND tarih < %s
            """,
            (str(bugun - timedelta(days=14)), str(bugun)),
        )
        r = dict(cur.fetchone() or {})
        gun_n = max(1, int(r.get("g") or 0))
        ciro_ort = round(float(r.get("t") or 0) / gun_n, 2)
        # 3) Son 14 gün günlük anlık gider ortalaması (rutin çıkışlar)
        cur.execute(
            """
            SELECT COALESCE(SUM(tutar),0) AS t
            FROM anlik_giderler WHERE durum='aktif' AND tarih >= %s AND tarih < %s
            """,
            (str(bugun - timedelta(days=14)), str(bugun)),
        )
        gider_ort = round(float(dict(cur.fetchone() or {}).get("t") or 0) / 14.0, 2)
    # 4) Kasa (kanonik kaynak: panel)
    try:
        from main import panel
        p = panel()
        kasa = float(p.get("kasa") or 0)
    except Exception as e:  # noqa: BLE001
        logger.warning("nakit ufku kasa okunamadi: %s", str(e)[:80])
        kasa = 0.0
    # 5) Gün gün projeksiyon — 3 ciro senaryosu; ödemeler vadesinde düşülür
    senaryolar = {"kotu": 0.8, "orta": 1.0, "iyi": 1.2}
    odeme_gunluk: dict = {}
    for o in odemeler:
        odeme_gunluk[o["tarih"]] = odeme_gunluk.get(o["tarih"], 0.0) + float(o["kalan"])
    projeksiyon = []
    kumul_odeme = 0.0
    # d=0: BUGÜN — ciro katkısı sayılmaz (gün bitmedi), bugünün ödemeleri düşülür
    for d in range(0, gun + 1):
        t = str(bugun + timedelta(days=d))
        kumul_odeme += odeme_gunluk.get(t, 0.0)
        satir = {"tarih": t, "gun_sonra": d,
                 "o_gune_kadar_odeme": round(kumul_odeme, 2)}
        for ad, katsayi in senaryolar.items():
            beklenen = kasa + (ciro_ort * katsayi - gider_ort) * d - kumul_odeme
            satir[f"beklenen_kasa_{ad}"] = round(beklenen, 2)
        projeksiyon.append(satir)
    # 6) Ödeme günü özetleri — "3 gün sonra 150.000 ödemen var, açık/fazla şu"
    odeme_ozet = []
    for o in odemeler:
        gs = (date.fromisoformat(o["tarih"]) - bugun).days
        pr = next((x for x in projeksiyon if x["tarih"] == o["tarih"]), None)
        odeme_ozet.append({
            "tarih": o["tarih"], "gun_sonra": gs, "aciklama": o["aciklama"][:60],
            "tutar": float(o["kalan"]),
            "odeme_sonrasi_beklenen_kasa_orta": (pr or {}).get("beklenen_kasa_orta"),
            "odeme_sonrasi_beklenen_kasa_kotu": (pr or {}).get("beklenen_kasa_kotu"),
            "acik_gorunuyor_orta": bool(((pr or {}).get("beklenen_kasa_orta") or 0) < 0),
        })
    return {
        "bugun": str(bugun), "kasa_simdiki": round(kasa, 2),
        "gunluk_ciro_ort_14g": ciro_ort, "gunluk_gider_ort_14g": gider_ort,
        "odeme_n": len(odemeler), "odeme_toplam": round(sum(odeme_gunluk.values()), 2),
        "odemeler": odeme_ozet, "gun_gun_projeksiyon": projeksiyon,
        "not": "TAHMİNDİR, taahhüt değil: ciro son 14 gün ortalamasıyla (kötü/orta/iyi "
               "= %80/100/120), rutin giderler 14 gün ortalamasıyla varsayıldı. Kart "
               "tahsilat gecikmesi, plansız giderler ve kira gelir/gider zamanlaması "
               "hesapta YOK. Negatif beklenen kasa = 'açık görünüyor' uyarısıdır, "
               "kesinlik değil.",
    }


@router.get("/zam-koridoru")
def zam_koridoru():
    """ZAM KORİDORU (L5-lite, 2026-07-07): 'ürünlere ne kadar zam koymalıyım?'
    sorusunun HESAPLANMIŞ çerçevesi. Marj-koruma formülü: gerekli zam %% ≈
    (maliyet artışı %%) × (o maliyet kaleminin cirodaki payı). HESABI KOD YAPAR,
    dil modeli anlatır; ÜRÜN-BAZLI kesin zam veremez (reçete verisi yok — dürüst sınır),
    işletme-düzeyi koridor + öncelikli hammadde listesi verir. ÖNERİDİR, karar insanın."""
    bugun = date.today()
    with db() as (_, cur):
        # 1) HAMMADDE ENDEKSİ: son 90 günü iki 45-günlük pencereye böl; kalem bazında
        #    ort birim fiyat değişimi; ağırlık = son dönem harcama tutarı
        cur.execute(
            """
            WITH kalemler AS (
                SELECT COALESCE(NULLIF(k.eslesen_stok_kodu,''), LOWER(TRIM(k.ocr_ad))) AS kalem,
                       MIN(k.ocr_ad) AS ad,
                       f.fatura_tarih >= %s AS son_donem,
                       AVG(NULLIF(k.birim_fiyat,0)) AS ort_fiyat,
                       SUM(COALESCE(k.satir_toplam,0)) AS harcama,
                       COUNT(*) AS n
                FROM tedarikci_fatura_kalem k
                JOIN tedarikci_fatura f ON f.id = k.fatura_id
                WHERE f.fatura_tarih >= %s AND k.birim_fiyat > 0
                GROUP BY 1, 3
            )
            SELECT eski.kalem, eski.ad,
                   ROUND(eski.ort_fiyat::numeric, 2) AS eski_fiyat,
                   ROUND(yeni.ort_fiyat::numeric, 2) AS yeni_fiyat,
                   ROUND(((yeni.ort_fiyat - eski.ort_fiyat) / eski.ort_fiyat * 100)::numeric, 1) AS degisim_pct,
                   ROUND(yeni.harcama::numeric, 2) AS son_donem_harcama
            FROM kalemler eski
            JOIN kalemler yeni ON yeni.kalem = eski.kalem
                AND eski.son_donem = FALSE AND yeni.son_donem = TRUE
            WHERE eski.n >= 2 AND yeni.n >= 2 AND eski.ort_fiyat > 0
            """,
            (str(bugun - timedelta(days=45)), str(bugun - timedelta(days=90))),
        )
        kalemler = [dict(r) for r in (cur.fetchall() or [])]
        toplam_harcama = sum(float(k["son_donem_harcama"] or 0) for k in kalemler) or 1.0
        hammadde_endeksi = round(sum(
            float(k["degisim_pct"] or 0) * float(k["son_donem_harcama"] or 0)
            for k in kalemler) / toplam_harcama, 1)
        en_cok_artan = sorted(kalemler, key=lambda k: -float(k["degisim_pct"] or 0))[:8]
        # 2) PERSONEL DEĞİŞİMİ: maaş planları (kaynak_tablo='personel') aylık toplam,
        #    son iki TAM ay karşılaştırması
        cur.execute(
            """
            SELECT DATE_TRUNC('month', referans_ay)::date::text AS ay,
                   ROUND(SUM(odenecek_tutar)::numeric, 2) AS toplam
            FROM odeme_plani
            WHERE kaynak_tablo = 'personel' AND durum <> 'iptal'
              AND referans_ay < DATE_TRUNC('month', CURRENT_DATE)  -- içinde bulunulan ay
                  -- KISMİ olur (planlar ay boyunca yazılır) — karşılaştırmaya sokulmaz
            GROUP BY 1 ORDER BY 1 DESC LIMIT 3
            """
        )
        maas_aylar = [dict(r) for r in (cur.fetchall() or [])]
        personel_degisim = None
        if len(maas_aylar) >= 2 and float(maas_aylar[1]["toplam"] or 0) > 0:
            personel_degisim = round(
                (float(maas_aylar[0]["toplam"]) - float(maas_aylar[1]["toplam"]))
                / float(maas_aylar[1]["toplam"]) * 100, 1)
        # 3) PAYLAR (son 30 gün gerçek verisi): hammadde/ciro ve personel/ciro
        cur.execute("SELECT COALESCE(SUM(toplam),0) AS c FROM ciro "
                    "WHERE durum='aktif' AND tarih >= %s", (str(bugun - timedelta(days=30)),))
        ciro_30 = float(dict(cur.fetchone() or {}).get("c") or 0) or 1.0
        cur.execute("SELECT COALESCE(SUM(toplam_tutar),0) AS t FROM tedarikci_fatura "
                    "WHERE fatura_tarih >= %s", (str(bugun - timedelta(days=30)),))
        hammadde_30 = float(dict(cur.fetchone() or {}).get("t") or 0)
        hammadde_pay = round(hammadde_30 / ciro_30, 3)
        personel_ay = float(maas_aylar[0]["toplam"]) if maas_aylar else 0.0
        personel_pay = round(personel_ay / max(ciro_30, 1.0), 3)
    # 4) KORİDOR — marj-koruma formülü (bileşen artışı × cirodaki payı)
    # VERİ-YETERSİZLİĞİ DÜRÜSTLÜĞÜ: kalem karşılaştırması yoksa koridor HESAPLANAMAZ —
    # '%0 → zam gerekmez' YANLIŞ mesajı yerine 'henüz ölçülemiyor' denir.
    veri_yetersiz = len(kalemler) == 0
    if veri_yetersiz:
        koridor = None
    else:
        alt = round(max(0.0, hammadde_endeksi) * hammadde_pay, 1)
        ust = round(alt + max(0.0, (personel_degisim or 0)) * personel_pay, 1)
        koridor = {"alt": alt, "ust": ust}
    return {
        "veri_yetersiz": veri_yetersiz,
        "veri_yetersiz_nedeni": ("Hammadde endeksi için aynı kalemin İKİ ayrı 45 günlük "
                                 "dönemde en az 2'şer faturası gerekli — fatura geçmişi "
                                 "biriktikçe koridor kendiliğinden hesaplanır. ŞU AN ZAM "
                                 "ORANI SÖYLENEMEZ; 'sıfır baskı' anlamına GELMEZ."
                                 if veri_yetersiz else None),
        "hammadde_endeksi_pct_45g": hammadde_endeksi,
        "hammadde_pay": hammadde_pay,
        "personel_degisim_pct_aylik": personel_degisim,
        "personel_pay": personel_pay,
        "maas_aylik": maas_aylar,
        "en_cok_artan_hammaddeler": [
            {"ad": k["ad"], "eski": float(k["eski_fiyat"]), "yeni": float(k["yeni_fiyat"]),
             "degisim_pct": float(k["degisim_pct"])} for k in en_cok_artan],
        "izlenen_kalem_n": len(kalemler),
        "zam_koridoru_pct": koridor,
        "formul": "gerekli zam %% ≈ maliyet artışı %% × o kalemin cirodaki payı "
                  "(marj-koruma mekanizması); alt=yalnız hammadde, üst=+personel",
        "not": "ÖNERİ ÇERÇEVESİDİR, karar insanın. ÜRÜN-BAZLI kesin zam verilemez — "
               "reçete verisi yok (hangi üründe ne kadar hammadde bilinmiyor; reçete "
               "girilirse ürün bazına iner). Rekabet, müşteri hassasiyeti ve psikolojik "
               "fiyat eşikleri hesapta YOK. En çok artan hammaddeleri yoğun kullanan "
               "ürün grupları doğal önceliktir — eşleştirme insan yorumudur.",
    }


@router.get("/odeme-secenek-kiyasi")
def odeme_secenek_kiyasi(tutar: float | None = None, vade_gun: int = 0):
    # DÜZ varsayılan (Query() DEĞİL): beyin B20 bu fonksiyonu doğrudan çağırır;
    # Query sentineli 'is None' kontrolünü atlatıp float()'ta patlar → blok sessiz düşer.
    """ÖDEME SEÇENEĞİ KIYASI (2026-07-08): 'nakit mi, kart mı, vade mi?' sorusunun
    HESAPLANMIŞ karşılaştırması. HÜKÜM YOK — üç senaryonun sayıları yan yana konur,
    hangi senaryoda kasa eksiye inmiyor gösterilir; KARAR İNSANIN. Faiz maliyeti,
    tedarikçi ilişkisi ve kartın gerçek güncel ekstresi hesapta YAKLAŞIKTIR (not'ta)."""
    bugun = date.today()
    ufuk = nakit_ufku(gun=14)
    kasa = float(ufuk.get("kasa_simdiki") or 0)
    ciro_ort = float(ufuk.get("gunluk_ciro_ort_14g") or 0)
    gider_ort = float(ufuk.get("gunluk_gider_ort_14g") or 0)
    with db() as (_, cur):
        # Hedef ödeme: parametre yoksa önümüzdeki 7 günün EN BÜYÜK bekleyen ödemesi
        hedef = None
        if tutar is None:
            cur.execute(
                """SELECT COALESCE(aciklama,'') AS aciklama, tarih::text AS tarih,
                          ROUND((odenecek_tutar - COALESCE(odenen_tutar,0))::numeric,2) AS kalan
                   FROM odeme_plani
                   WHERE durum IN ('bekliyor','onay_bekliyor')
                     AND tarih BETWEEN %s AND %s
                     AND (odenecek_tutar - COALESCE(odenen_tutar,0)) > 0
                   ORDER BY (odenecek_tutar - COALESCE(odenen_tutar,0)) DESC LIMIT 1""",
                (str(bugun), str(bugun + timedelta(days=7))),
            )
            r = cur.fetchone()
            if r:
                hedef = dict(r)
                tutar = float(hedef["kalan"])
        if tutar is None:
            return {"hata": "Önümüzdeki 7 günde bekleyen ödeme yok; ?tutar= ile sorabilirsin."}
        # Kartlar: müsait limit ≈ limit - bekleyen kart borç planları (YAKLAŞIK)
        cur.execute(
            """SELECT k.kart_adi, k.banka, k.limit_tutar, k.kesim_gunu, k.son_odeme_gunu,
                      k.faiz_orani,
                      COALESCE((SELECT SUM(op.odenecek_tutar - COALESCE(op.odenen_tutar,0))
                                FROM odeme_plani op
                                WHERE op.kart_id = k.id AND op.durum IN ('bekliyor','onay_bekliyor')), 0
                      ) AS bekleyen_borc
               FROM kartlar k WHERE k.aktif = TRUE""",
        )
        kartlar = []
        for r in cur.fetchall() or []:
            d = dict(r)
            musait = round(float(d["limit_tutar"] or 0) - float(d["bekleyen_borc"] or 0), 2)
            # nakit çıkışının öteleneceği tahmini tarih: sonraki kesim + son ödeme günü
            kesim = int(d["kesim_gunu"] or 15)
            ay, yil = (bugun.month, bugun.year)
            if bugun.day >= kesim:  # bu ayın kesimi geçti → sonraki ekstre
                ay, yil = (ay % 12 + 1, yil + (1 if ay == 12 else 0))
            son_ay, son_yil = (ay % 12 + 1, yil + (1 if ay == 12 else 0))
            oteleme = date(son_yil, son_ay, min(28, int(d["son_odeme_gunu"] or 25)))
            kartlar.append({"kart": d["kart_adi"], "banka": d["banka"],
                            "musait_yaklasik": musait, "yeterli": musait >= tutar,
                            "nakit_cikisi_otelenir": str(oteleme),
                            "oteleme_gun": (oteleme - bugun).days,
                            "faiz_orani_pct": float(d["faiz_orani"] or 0)})
    # Projeksiyon yardımcısı: verilen gün ödemesiyle en düşük beklenen kasa (orta senaryo)
    def _projeksiyon(odeme_gunu_ofset: int, odeme_tutari: float):
        min_kasa, eksi_gun, ilk_eksi = None, 0, None
        for d in range(0, 15):
            beklenen = kasa + (ciro_ort - gider_ort) * d - (odeme_tutari if d >= odeme_gunu_ofset else 0)
            if min_kasa is None or beklenen < min_kasa:
                min_kasa = beklenen
            if beklenen < 0:
                eksi_gun += 1
                if ilk_eksi is None:
                    ilk_eksi = str(bugun + timedelta(days=d))
        return {"en_dusuk_beklenen_kasa": round(min_kasa, 2),
                "eksi_gun_sayisi": eksi_gun, "ilk_eksi_gun": ilk_eksi,
                "kasa_eksiye_iniyor": eksi_gun > 0}
    secenekler = {
        "A_nakit_vadesinde": {**_projeksiyon(0, tutar),
                              "aciklama": "Ödeme bugün/vadesinde nakit yapılır"},
        "B_kartla": {**_projeksiyon(0, 0.0),
                     "aciklama": "Nakit çıkışı ekstreye ötelenir; kasa korunur",
                     "uygun_kartlar": [k for k in kartlar if k["yeterli"]],
                     "yetersiz_kartlar": [k for k in kartlar if not k["yeterli"]]},
        "C_vade_3gun": {**_projeksiyon(3, tutar),
                        "aciklama": "Tedarikçiden +3 gün vade istenirse"},
        "C_vade_7gun": {**_projeksiyon(7, tutar),
                        "aciklama": "Tedarikçiden +7 gün vade istenirse"},
    }
    return {
        "hedef_odeme": {"tutar": tutar, **({"aciklama": hedef["aciklama"][:60],
                        "vade": hedef["tarih"]} if hedef else {})},
        "kasa_simdiki": kasa, "gunluk_net_akis_ort": round(ciro_ort - gider_ort, 2),
        "secenekler": secenekler,
        "not": "HESAPLANMIŞ KIYAS — öneri/emir değildir, karar insanın. Kart müsait "
               "limiti bekleyen planlardan YAKLAŞIKTIR (gerçek ekstre farklı olabilir); "
               "kart faiz/taksit maliyeti ve tedarikçi ilişki maliyeti hesapta YOK; "
               "ciro/gider 14 gün ortalaması varsayımdır.",
    }


@router.get("/vergi-takvim")
def vergi_nakit_takvimi():
    """FAZ 1c: vergi kaynaklı nakit çıkış takvimi (tahmini — rozetli, hüküm yok)."""
    bugun = date.today()
    satirlar = []
    with db() as (_, cur):
        # 1) Ödenecek KDV — TEK KAYNAK: ops_maliyet_kdv_pozisyon (ay başından bugüne pencere)
        kdv_blok = None
        try:
            from operasyon_merkez_api import ops_maliyet_kdv_pozisyon
            poz = ops_maliyet_kdv_pozisyon(gun=max(1, bugun.day), sube_id=None)
            kdv_blok = {
                "donem": f"{bugun.year}-{bugun.month:02d} (ay başından bugüne — KISMİ dönem)",
                "hesaplanan_kdv_tl": poz.get("toplam_hesaplanan_tl"),
                "indirilecek_kdv_tl": poz.get("toplam_indirilecek_tl"),
                "odenecek_kdv_tl": poz.get("toplam_odenecek_tl"),
                "son_odeme": str(date(bugun.year + (1 if bugun.month == 12 else 0),
                                      1 if bugun.month == 12 else bugun.month + 1,
                                      _KDV_ODEME_GUNU)),
                "rozet": "TAHMİNİ — dönem henüz kapanmadı; indirilecek KDV kalem-oran bazlı",
            }
        except Exception as e:  # noqa: BLE001
            logger.warning("vergi-takvim kdv blogu atlandi: %s", str(e)[:120])
            kdv_blok = {"hata": "KDV pozisyonu alınamadı"}
        satirlar.append({"tur": "KDV", **kdv_blok})

        # 2) Kira stopajı — sabit_giderler.stopaj_oran (aylık sabit yük; şahıstan kira)
        try:
            cur.execute(
                """
                SELECT COALESCE(SUM(tutar * COALESCE(stopaj_oran,0)), 0) AS stopaj,
                       COUNT(*) FILTER (WHERE COALESCE(stopaj_oran,0) > 0)::int AS adet
                FROM sabit_giderler
                WHERE aktif=TRUE AND LOWER(COALESCE(kategori,''))='kira'
                """
            )
            r = dict(cur.fetchone() or {})
            satirlar.append({
                "tur": "Muhtasar (kira stopajı)",
                "donem": f"{bugun.year}-{bugun.month:02d}",
                "odenecek_tl": round(float(r.get("stopaj") or 0), 2),
                "kira_adedi": int(r.get("adet") or 0),
                "son_odeme": str(date(bugun.year + (1 if bugun.month == 12 else 0),
                                      1 if bugun.month == 12 else bugun.month + 1,
                                      _MUHTASAR_ODEME_GUNU)),
                "rozet": "Aylık sabit (brüt kira × stopaj oranı); şahıstan kiralanan şubeler",
            })
        except Exception as e:  # noqa: BLE001
            logger.warning("vergi-takvim stopaj blogu atlandi: %s", str(e)[:120])
            satirlar.append({"tur": "Muhtasar (kira stopajı)", "hata": "veri alınamadı"})

    return {
        "bugun": str(bugun),
        "takvim": satirlar,
        "not": "Salt-okur farkındalık görünümü — beyanname DEĞİLDİR; yönetim tahmini. "
               "Ödeme günleri pratik varsayım (28'i), muhasebeci takvimi esastır.",
    }


@router.get("/odeme-mutabakat")
def odeme_mutabakat(gun: int = Query(60, ge=14, le=180)):
    """FAZ 1d: ÖDEME MUTABAKAT GÖRÜNÜMÜ — cari (tedarikçi) bazında iki tarafı YAN YANA koyar:
      SOL: e-fatura bakiye zincirindeki DÜŞÜŞLER (dahil[N] > önceki[N+1] → arada bakiye eridi)
      SAĞ: bizim ödeme olaylarımız (supplier_payment_event — kart/nakit, confidence'lı)
    ADAY eşleştirme (yüksek/orta/düşük güven) — birebir DEĞİL. DİL DİSİPLİNİ (GPT düzeltmesi):
    bakiye düşüşü MUHASEBE SİNYALİDİR, ödeme kanıtı DEĞİL (iade/iskonto/mahsup da düşürür).
    Bu ekran 'ödeme eksik' HÜKMÜ vermez — 'düşüş gözlendi, kayıtlarımızda karşılık yok' GÖZLEMİ
    yapar. Cari seviyesi (ad-normalize) çalışır — şube kırılımı bilinçli yok (VKN tuzağı)."""
    from supplier_payment import _norm  # Türkçe-güvenli normalize (tek merkez)

    bas = date.today() - timedelta(days=gun - 1)
    with db() as (_, cur):
        # SOL: bakiye alanlı faturalar → cari bazında kronolojik zincir → düşüşler
        cur.execute(
            """
            SELECT tedarikci_ad, fatura_tarih, onceki_bakiye::float AS onceki, bakiye_dahil::float AS dahil
            FROM tedarikci_fatura
            WHERE onceki_bakiye IS NOT NULL AND bakiye_dahil IS NOT NULL
              AND tedarikci_ad IS NOT NULL AND fatura_tarih IS NOT NULL
              AND fatura_tarih >= %s
            ORDER BY fatura_tarih, olusturma
            """,
            (str(bas),),
        )
        zincir: Dict[str, list] = {}
        for r in (cur.fetchall() or []):
            d = dict(r)
            k = _norm(d["tedarikci_ad"])
            if len(k) >= 3:
                zincir.setdefault(k, []).append(d)

        dusular = []
        for k, fats in zincir.items():
            for a, b in zip(fats, fats[1:]):
                fark = round(float(a["dahil"]) - float(b["onceki"]), 2)
                if fark > 0.005:
                    dusular.append({
                        "tedarikci_ad": b["tedarikci_ad"], "_norm": k,
                        "pencere_bas": str(a["fatura_tarih"]), "pencere_bit": str(b["fatura_tarih"]),
                        "dusus_tutar": fark,
                    })

        # SAĞ: ödeme olayları (pencere payıyla geriden başla)
        # 🔴 P0 İPTAL FİLTRESİ (2026-08-17, Zekâ alanı denetimi): supplier_payment_event
        # tablosunda 'durum' kolonu YOK ve bu sorgu orijinal kaydın durumuna hiç
        # bakmıyordu → İPTAL EDİLMİŞ ödeme, mutabakat ekranında hâlâ ÖDEME sayılıyor.
        # CANLI KANIT: bugün 40 sahte puan kaydı + mükerrer ESHİM/KENTPLAZA iptal
        # edildi; 60 günlük mutabakat listesi (54 kayıt) hâlâ METRO 30 ₺ (puan
        # sızıntısı) ve ESHİM 20.400'ün ikinci kopyasını "ödeme" olarak gösteriyordu.
        # Sonuç: "ödeme var ama bakiye düşüşü görülmedi" alarmı ŞİŞİYOR → gerçek
        # boşluklar sahte alarmların arasında kayboluyor (alarm körlüğü).
        # Çözüm: event'i ÜRETEN kayıt artık aktif değilse event de sayılmaz.
        # Geriye dönük çalışır — mevcut kirli event'ler temizlik gerektirmeden elenir.
        cur.execute(
            """
            SELECT spe.id, spe.tedarikci_ad, spe.tutar::float AS tutar, spe.tarih,
                   spe.kaynak, spe.confidence
            FROM supplier_payment_event spe
            WHERE spe.tarih >= %s
              -- 🔴 GEÇERSİZ DAMGASI (2026-08-17): supplier_payment.py iki durumda
              -- gecersiz=TRUE damgalıyor: (a) v1→v2 sürüm geçişi (:407), (b) ÇİFT
              -- KANAL elemesi (:249) = "aynı para hem kart hem eşlenik anlık gider
              -- satırında". (b) tam olarak bugünkü ATALAY sınıfıdır — kart çekimi
              -- ödemenin FİNANSMANI, ayrı ödeme değil. Kanonik tüketici bu damgayı
              -- okuyor (supplier_payment.py:451) ama bu duyu OKUMUYORDU → elenmiş
              -- satırlar burada hâlâ "ödeme" sayılıyordu.
              AND NOT COALESCE(spe.gecersiz, FALSE)
              AND NOT EXISTS (
                    SELECT 1 FROM kart_hareketleri kh
                     WHERE spe.kaynak_tablo = 'kart_hareketleri'
                       AND kh.id = spe.kaynak_id
                       AND COALESCE(kh.durum,'aktif') <> 'aktif')
              AND NOT EXISTS (
                    SELECT 1 FROM anlik_giderler ag
                     WHERE spe.kaynak_tablo = 'anlik_giderler'
                       AND ag.id = spe.kaynak_id
                       AND COALESCE(ag.durum,'aktif') <> 'aktif')
              AND NOT EXISTS (
                    SELECT 1 FROM vadeli_alimlar va
                     WHERE spe.kaynak_tablo = 'vadeli_alimlar'
                       AND va.id = spe.kaynak_id
                       AND COALESCE(va.durum,'') = 'iptal')
            ORDER BY spe.tarih
            """,
            (str(bas - timedelta(days=7)),),
        )
        _ham_odemeler = []
        for r in (cur.fetchall() or []):
            d = dict(r)
            d["_norm"] = _norm(d.get("tedarikci_ad"))
            d["tarih"] = str(d["tarih"])
            d["_kullanildi"] = False
            _ham_odemeler.append(d)

    # 🔴 P0 KANAL TEKİLLEŞTİRME (2026-08-17, Zekâ alanı denetimi):
    # AYNI ödeme üç ayrı kanaldan (kart · nakit/anlık gider · vadeli alım) ÜÇ AYRI
    # olay üretiyordu ve bu ekran hepsini AYRI ödeme sayıyordu. Canlı kanıt (60 gün):
    #   SÜTAŞ 55.630,66 → vadeli(17 Haz) + kart(17 Haz) + kart(18 Haz)  = 3 kayıt
    #   redbull 21.487,10 → vadeli + kart + kart                        = 3 kayıt
    #   FEZ 80.000/20.000 → nakit + kart (25 Haz) ve yine (3 Tem)       = 4 kayıt
    #   ATALAY 100.000  → kart(0.5) + nakit(0.6) + kart(1.0)            = 3 kayıt
    # Sonuç: "ödeme var ama bakiye düşüşü görülmedi" listesi kendi kopyalarıyla
    # şişiyor, GERÇEK boşluklar arasında kayboluyor (alarm körlüğünün ta kendisi).
    # KURAL: aynı cari + tutar ±%1 (min 1 ₺) + tarih ±1 gün = TEK ödeme; en YÜKSEK
    # güvenli kayıt temsilci olur, elenenlerin sayısı raporda `kanal_kopyasi_elenen`
    # olarak GÖRÜNÜR (sessiz eleme yok — sahip kaç kopya elendiğini bilir).
    # ⚠️ Bu ekran öneri-only'dir; hüküm vermez. Tekilleştirme yalnız GÖRÜNÜMdedir,
    # hiçbir kayıt silinmez/değiştirilmez.
    odemeler, _elenen = [], 0
    for d in sorted(_ham_odemeler,
                    key=lambda x: (-(x.get("confidence") or 0), x["tarih"])):
        ikiz = None
        for s in odemeler:
            if s["_norm"] != d["_norm"]:
                continue
            tol = max(1.0, abs(float(s["tutar"])) * 0.01)
            if abs(float(s["tutar"]) - float(d["tutar"])) > tol:
                continue
            try:
                gun_fark = abs((date.fromisoformat(d["tarih"])
                                - date.fromisoformat(s["tarih"])).days)
            except Exception:
                gun_fark = 99
            if gun_fark <= 1:
                ikiz = s
                break
        if ikiz is not None:
            ikiz.setdefault("_kanallar", [ikiz.get("kaynak")])
            ikiz["_kanallar"].append(d.get("kaynak"))
            _elenen += 1
            continue
        odemeler.append(d)
    odemeler.sort(key=lambda x: x["tarih"])

    # ADAY EŞLEŞTİRME — hüküm değil aday; kör noktalar bilinir (kısmi ödeme, çok-fatura-tek-ödeme)
    def _pencere_icinde(o, du, pay=0):
        return (du["pencere_bas"] <= o["tarih"] <= du["pencere_bit"]) or (
            pay and abs((date.fromisoformat(o["tarih"]) - date.fromisoformat(du["pencere_bit"])).days) <= pay
        ) or (
            pay and abs((date.fromisoformat(o["tarih"]) - date.fromisoformat(du["pencere_bas"])).days) <= pay
        )

    eslesen, dusus_karsiliksiz = [], []
    for du in dusular:
        adaylar = [o for o in odemeler if o["_norm"] == du["_norm"] and not o["_kullanildi"]]
        secilen, guven = None, None
        # 1) tek ödeme, tutar çok yakın + pencere içi → yüksek
        for o in adaylar:
            if abs(o["tutar"] - du["dusus_tutar"]) <= max(5.0, du["dusus_tutar"] * 0.02) and _pencere_icinde(o, du):
                secilen, guven = [o], "yuksek"
                break
        # 2) tek ödeme, tutar ~%10 veya pencere±7 → orta
        if not secilen:
            for o in adaylar:
                if abs(o["tutar"] - du["dusus_tutar"]) <= du["dusus_tutar"] * 0.10 and _pencere_icinde(o, du, pay=7):
                    secilen, guven = [o], "orta"
                    break
        # 3) pencere±7 içi ödemelerin TOPLAMI tutara ≤%2 → orta (kısmi ödemeler)
        if not secilen:
            pi = [o for o in adaylar if _pencere_icinde(o, du, pay=7)]
            if pi and abs(sum(o["tutar"] for o in pi) - du["dusus_tutar"]) <= max(5.0, du["dusus_tutar"] * 0.02):
                secilen, guven = pi, "orta"
        if secilen:
            for o in secilen:
                o["_kullanildi"] = True
            eslesen.append({**{k: v for k, v in du.items() if k != "_norm"},
                            "guven": guven,
                            "odemeler": [{"tutar": o["tutar"], "tarih": o["tarih"],
                                          "kaynak": o["kaynak"], "kayit_guveni": o["confidence"]}
                                         for o in secilen]})
        else:
            dusus_karsiliksiz.append({k: v for k, v in du.items() if k != "_norm"})

    odeme_karsiliksiz = [
        {"tedarikci_ad": o.get("tedarikci_ad"), "tutar": o["tutar"], "tarih": o["tarih"],
         "kaynak": o["kaynak"], "kayit_guveni": o["confidence"]}
        for o in odemeler if not o["_kullanildi"]
    ]

    return {
        "kesit": {"bas": str(bas), "gun": gun},
        "eslesen": eslesen,                      # 🟢 düşüş ↔ ödeme adayı (güvenle)
        "dusus_var_odeme_kaydi_yok": dusus_karsiliksiz,   # 🟡 gözlem — hüküm değil
        "odeme_var_dusus_gorulmedi": odeme_karsiliksiz,   # 🟡 bilgi — fatura zinciri eksik olabilir
        # SESSİZ ELEME YASAK: kaç kayıt kanal kopyası sayılıp birleştirildi, sahip görsün.
        "kanal_kopyasi_elenen": _elenen,
        "ham_odeme_olayi": len(_ham_odemeler),
        "tekil_odeme_olayi": len(odemeler),
        "not": "ADAY eşleştirme — kesin mutabakat DEĞİL. Bakiye düşüşü muhasebe sinyalidir "
               "(iade/iskonto/mahsup da düşürür); 'ödeme eksik' hükmü YOK. kayit_guveni<1 = "
               "ödeme kaydı fuzzy eşleşmiş (aday). Kör noktalar: kısmi ödeme, tek ödeme→çok "
               "fatura, tarih kayması, açılış bakiyesi. Cari (ad) seviyesi — şube kırılımı yok.",
    }


@router.get("/kapanis-fark-profil")
def kapanis_fark_profili(gun: int = Query(30, ge=7, le=90)):
    """FAZ 1e: şube bazında açılış/kapanış kasa farkı profili — İSİMSİZ, yorumsuz.
    Kaynak: sube_operasyon_uyari (tip ACILIS_KASA_FARK / KAPANIS_KASA_FARK; recalc günceller)."""
    bas = date.today() - timedelta(days=gun - 1)
    with db() as (_, cur):
        cur.execute(
            """
            SELECT u.sube_id::text AS sube_id, COALESCE(s.ad, u.sube_id::text) AS sube_ad,
                   u.tip,
                   COUNT(*)::int AS gun_sayisi,
                   ROUND(AVG(ABS(COALESCE(u.fark_tl,0)))::numeric, 2) AS ort_mutlak_fark,
                   ROUND(MAX(ABS(COALESCE(u.fark_tl,0)))::numeric, 2) AS max_mutlak_fark,
                   COUNT(*) FILTER (WHERE ABS(COALESCE(u.fark_tl,0)) > 100)::int AS fark_100_ustu_gun,
                   COUNT(*) FILTER (WHERE COALESCE(u.fark_tl,0) < 0)::int AS eksik_gun,
                   COUNT(*) FILTER (WHERE COALESCE(u.fark_tl,0) > 0)::int AS fazla_gun,
                   ROUND(SUM(COALESCE(u.fark_tl,0))::numeric, 2) AS net_fark_toplam
            FROM sube_operasyon_uyari u
            LEFT JOIN subeler s ON s.id::text = u.sube_id::text
            WHERE u.tip IN ('ACILIS_KASA_FARK','KAPANIS_KASA_FARK')
              AND u.tarih >= %s
            GROUP BY u.sube_id, s.ad, u.tip
            ORDER BY sube_ad, u.tip
            """,
            (str(bas),),
        )
        profiller = [dict(r) for r in (cur.fetchall() or [])]
        for p in profiller:
            for k in ("ort_mutlak_fark", "max_mutlak_fark", "net_fark_toplam"):
                if p.get(k) is not None:
                    p[k] = float(p[k])
    return {
        "kesit": {"bas": str(bas), "gun": gun},
        "profiller": profiller,
        "not": "Şube seviyesi — İSİM YOK (kural #15). Sayılar yorumsuz: eksik/fazla dağılımı, "
               "100₺ üstü gün sayısı, net toplam. 'Hep aynı yönde küçük fark' gibi örüntüleri "
               "İNSAN okur; sistem hüküm vermez. Kaynak kesiti: onaylı fark uyarıları "
               "(recalc her ciro/gider değişiminde tazeler).",
    }


# ── DİLEK-KURULUM TURU (2026-07-08): beynin veri dileklerinden doğan 3 pencere ──
# Ders: beyin bu fonksiyonları DOĞRUDAN çağırır → Query() varsayılanı YASAK (B20 dersi).

@router.get("/gecmis-odeme-dokumu")
def gecmis_odeme_dokumu(ay_sayisi: int = 12):
    """GEÇMİŞ ÖDEME DÖKÜMÜ (dilek: Ocak'tan beri yapılan ödemeler neler?).
    Kaynak = KASA İZİ (tek gerçek): fiilen kasadan çıkan paralar, ay × işlem türü.
    Plan/temenni değil, gerçekleşen. Kişi adı taşıyan açıklamalar personel
    kalemlerinde boşaltılır (kimlik firewall)."""
    n = max(1, min(24, int(ay_sayisi or 12)))
    with db() as (_, cur):
        cur.execute(
            """SELECT to_char(date_trunc('month', tarih), 'YYYY-MM') AS ay,
                      islem_turu, COUNT(*)::int AS adet,
                      ROUND(SUM(ABS(tutar))::numeric, 2) AS toplam
               FROM kasa_hareketleri
               WHERE kasa_etkisi = TRUE AND durum = 'aktif' AND tutar < 0
                 AND islem_turu NOT IN ('CIRO_DUZELTME','CIRO_IPTAL','ACILIS_DEVRI')
                 AND tarih >= date_trunc('month', CURRENT_DATE) - (%s * INTERVAL '1 month')
               GROUP BY 1, 2 ORDER BY 1 DESC, toplam DESC""",
            (n - 1,),
        )
        aylar: Dict[str, dict] = {}
        for r in cur.fetchall() or []:
            a = aylar.setdefault(r["ay"], {"ay": r["ay"], "toplam_cikis": 0.0, "kalemler": []})
            a["toplam_cikis"] = round(a["toplam_cikis"] + float(r["toplam"]), 2)
            a["kalemler"].append({"tur": r["islem_turu"], "toplam": float(r["toplam"]),
                                  "adet": r["adet"]})
        cur.execute(
            """SELECT tarih::text AS tarih, islem_turu,
                      ROUND(ABS(tutar)::numeric, 2) AS tutar,
                      CASE WHEN islem_turu LIKE 'PERSONEL%%' THEN ''
                           ELSE LEFT(COALESCE(aciklama,''), 80) END AS aciklama
               FROM kasa_hareketleri
               WHERE kasa_etkisi = TRUE AND durum = 'aktif' AND tutar < 0
                 AND islem_turu NOT IN ('CIRO_DUZELTME','CIRO_IPTAL','ACILIS_DEVRI')
                 AND tarih >= date_trunc('month', CURRENT_DATE) - (%s * INTERVAL '1 month')
               ORDER BY ABS(tutar) DESC LIMIT 10""",
            (n - 1,),
        )
        buyukler = [dict(r) for r in cur.fetchall() or []]
    return {
        "kesit_ay": n,
        "aylar": sorted(aylar.values(), key=lambda x: x["ay"], reverse=True),
        "en_buyuk_10_odeme": buyukler,
        "not": "Kaynak=kasa izi: FİİLEN kasadan çıkanlar (plan değil). Kartla ödenen ekstre "
               "borçları KART_ODEME satırında görünür; kart harcamasının kendisi kasadan "
               "çıkmaz. Personel kalemlerinde açıklama kimlik nedeniyle boş.",
    }


@router.get("/ciro-onay-izi")
def ciro_onay_izi(gun: int = 30):
    """CİRO ONAY KUYRUĞU İZİ (dilek: onay kuyruğu günlük izleme): kuyruğa günde ne
    girdi, ne onaylandı, ne reddedildi + şu an bekleyenlerin yaşı ve tür kırılımı.
    Salt sayı, hüküm yok. Kuyruğa hiç GİRMEYEN ciro ayrı duyunun işi (not'ta)."""
    g = max(7, min(90, int(gun or 30)))
    with db() as (_, cur):
        cur.execute(
            """SELECT tarih::text AS gun, durum, COUNT(*)::int AS adet,
                      ROUND(SUM(COALESCE(tutar,0))::numeric, 2) AS toplam
               FROM onay_kuyrugu
               WHERE tarih >= CURRENT_DATE - %s
               GROUP BY 1, 2 ORDER BY 1 DESC""",
            (g,),
        )
        gunler: Dict[str, dict] = {}
        for r in cur.fetchall() or []:
            gn = gunler.setdefault(r["gun"], {"gun": r["gun"]})
            gn[r["durum"]] = {"adet": r["adet"], "toplam": float(r["toplam"])}
        cur.execute(
            """SELECT COUNT(*)::int AS adet,
                      ROUND(SUM(COALESCE(tutar,0))::numeric, 2) AS toplam,
                      MIN(tarih)::text AS en_eski_tarih
               FROM onay_kuyrugu WHERE durum = 'bekliyor'"""
        )
        bekleyen = dict(cur.fetchone() or {})
        if bekleyen.get("toplam") is not None:
            bekleyen["toplam"] = float(bekleyen["toplam"])
        cur.execute(
            """SELECT islem_turu, COUNT(*)::int AS adet,
                      ROUND(SUM(COALESCE(tutar,0))::numeric, 2) AS toplam
               FROM onay_kuyrugu WHERE durum = 'bekliyor'
               GROUP BY 1 ORDER BY toplam DESC NULLS LAST"""
        )
        tur_kirilimi = [{"tur": r["islem_turu"], "adet": r["adet"],
                         "toplam": float(r["toplam"] or 0)} for r in cur.fetchall() or []]
    return {
        "kesit_gun": g,
        "gunluk": sorted(gunler.values(), key=lambda x: x["gun"], reverse=True),
        "su_an_bekleyen": bekleyen,
        "bekleyen_tur_kirilimi": tur_kirilimi,
        "not": "Kuyruğa GİREN kayıtların izi. Kuyruğa hiç girmeyen ciro bu tablodan "
               "görünmez — onun bekçisi Eksik Ciro Güvence duyusudur (kapanış mührü "
               "var + Evo satışı yok karşılaştırması).",
    }


@router.get("/sube-gelir-gider")
def sube_gelir_gider():
    """ŞUBE GELİR-GİDER KABA KIYAS (dilek: Alsancak gelir-gider seti).
    Bu ay + geçen ay: şube başına ciro tahsilatı vs şubeye yazılan anlık giderler.
    KABA görünümdür: kira/maaş/merkezi giderler ve KDV ayrıştırması YOK — tam P&L
    Maliyet sayfasındadır. Beynin hızlı şube kıyası için pencere."""
    with db() as (_, cur):
        cur.execute("SELECT id, ad FROM subeler WHERE aktif = TRUE")
        subeler = {str(r["id"]): str(r["ad"]) for r in cur.fetchall() or []}
        sonuc = []
        for ofset, etiket in ((0, "bu_ay"), (1, "gecen_ay")):
            cur.execute(
                """SELECT sube_id::text AS sube_id,
                          ROUND(SUM(COALESCE(toplam,0))::numeric, 2) AS ciro
                   FROM ciro
                   WHERE durum = 'aktif'
                     AND tarih >= date_trunc('month', CURRENT_DATE) - (%s * INTERVAL '1 month')
                     AND tarih <  date_trunc('month', CURRENT_DATE) - ((%s - 1) * INTERVAL '1 month')
                   GROUP BY 1""",
                (ofset, ofset),
            )
            cirolar = {r["sube_id"]: float(r["ciro"]) for r in cur.fetchall() or []}
            # 🏪 2026-08-09: `sube` artık AD DEĞİL KİMLİK tutuyor (kimlik/ad
            # ayrımı normalize edildi, 344 satır çevrildi). Ad doğrudan
            # okunamaz — `subeler` ile çözülür; eşleşmezse ham değer kalır
            # ki satır kaybolmasın (uydurma ad üretilmez).
            cur.execute(
                """SELECT COALESCE(UPPER(s.ad),
                                   NULLIF(TRIM(UPPER(a.sube)),''),
                                   'MERKEZ') AS sube_ad,
                          ROUND(SUM(COALESCE(a.tutar,0))::numeric, 2) AS gider
                   FROM anlik_giderler a
                   LEFT JOIN subeler s
                          ON s.id::text = COALESCE(NULLIF(TRIM(a.sube_id),''),
                                                   NULLIF(TRIM(a.sube),''))
                   WHERE a.durum = 'aktif'
                     AND a.tarih >= date_trunc('month', CURRENT_DATE) - (%s * INTERVAL '1 month')
                     AND a.tarih <  date_trunc('month', CURRENT_DATE) - ((%s - 1) * INTERVAL '1 month')
                   GROUP BY 1""",
                (ofset, ofset),
            )
            giderler = {r["sube_ad"]: float(r["gider"]) for r in cur.fetchall() or []}
            satirlar = []
            for sid, ad in subeler.items():
                ciro = cirolar.get(sid, 0.0)
                gider = giderler.get(ad.strip().upper(), 0.0)
                satirlar.append({"sube": ad, "ciro_tahsilat": ciro,
                                 "anlik_gider": gider,
                                 "kaba_fark": round(ciro - gider, 2)})
            merkez = giderler.get("MERKEZ", 0.0)
            sonuc.append({"donem": etiket, "subeler": satirlar,
                          "merkez_gideri": merkez})
    return {
        "donemler": sonuc,
        "not": "KABA kıyas: ciro=tahsilat (KDV dahil), gider=yalnız şubeye yazılan anlık "
               "giderler. Kira, maaş, hammadde faturaları ve merkezi giderler DAHİL DEĞİL — "
               "kaba_fark bir kâr rakamı DEĞİLDİR. Tam tablo Maliyet sayfasında.",
    }


# ── TAM KAPSAMA TURU (2026-07-08): envanter turundan doğan 7 pencere ──
# Kural: DÜZ varsayılan (Query() yasak — beyin doğrudan çağırır). KİMLİK FIREWALL:
# personel_id/personel_ad kolonları HİÇBİR pencereye girmez; yalnız sayı/toplam.

@router.get("/vardiya-plan-ozet")
def vardiya_plan_ozet(gun: int = 7):
    """VARDİYA PLAN ÖZETİ (kimliksiz): şube×gün atama sayısı + durum kırılımı,
    geriye N gün + ileriye N gün. Kim çalıştı DEĞİL, kaç atama/iptal var."""
    g = max(3, min(30, int(gun or 7)))
    with db() as (_, cur):
        cur.execute(
            """SELECT va.tarih::text AS gun, s.ad AS sube, va.durum,
                      COUNT(*)::int AS atama
               FROM vardiya_atama va
               JOIN vardiya_slot vs ON vs.id = va.slot_id
               JOIN subeler s ON s.id = vs.sube_id
               WHERE va.tarih BETWEEN CURRENT_DATE - %s AND CURRENT_DATE + %s
               GROUP BY 1, 2, 3 ORDER BY 1 DESC, 2""",
            (g, g),
        )
        satirlar = [dict(r) for r in cur.fetchall() or []]
    return {
        "kesit_gun": g,
        "atamalar": satirlar[:120],
        "not": "KİMLİKSİZ plan özeti: şube-gün-durum atama sayıları (geçmiş+gelecek). "
               "Kişi bazlı bilgi bu pencerede YOK — kim atandı vardiya ekranında.",
    }


@router.get("/vardiya-takvimi")
def vardiya_takvimi(gun: int = 3):
    """VARDİYA TAKVİMİ — İSİMLİ (bilinçli istisna, 2026-07-09 sahip talebi:
    'sabah Zafer'de açılış kim?' cevapsız kalıyordu). Kimlik firewall'un amacı
    kişi üzerinden YARGI üretmemek; bu pencere yargı değil, KİM-NEREDE-NE-ZAMAN
    operasyonel planını verir (dün + bugün + ileriye N gün, iptaller hariç).
    Beyin tarafında kural 4-istisnası: isim yalnız TAKVİM aktarımında kullanılır,
    kişi hakkında değerlendirme/kıyas yine yasaktır."""
    g = max(1, min(7, int(gun or 3)))
    with db() as (_, cur):
        cur.execute(
            """SELECT va.tarih::text AS gun, COALESCE(s.ad, 'şube-bilinmiyor') AS sube,
                      COALESCE(vs.tip, 'normal') AS slot_tip, vs.ad AS slot_ad,
                      p.ad_soyad AS personel,
                      va.baslangic_saat::text AS baslangic,
                      va.bitis_saat::text AS bitis, va.durum
               FROM vardiya_atama va
               LEFT JOIN vardiya_slot vs ON vs.id = va.slot_id
               LEFT JOIN subeler s ON s.id = vs.sube_id
               JOIN personel p ON p.id = va.personel_id
               WHERE va.tarih BETWEEN CURRENT_DATE - 1 AND CURRENT_DATE + %s
                 AND va.durum <> 'iptal'
               ORDER BY va.tarih, sube, va.baslangic_saat""",
            (g,),
        )
        satirlar = [dict(r) for r in cur.fetchall() or []]
    # HAZIR açılış/kapanış özeti (kural 15 disiplini: bağı kod kurar, model aktarır):
    # açılış = tip 'acilis' olanlar; yoksa o şube-günün EN ERKEN başlayanı.
    # kapanış = tip 'kapanis' olanlar; yoksa EN GEÇ biteni.
    gruplar: Dict[tuple, list] = {}
    for r in satirlar:
        gruplar.setdefault((r["gun"], r["sube"]), []).append(r)
    ozet = []
    for (gun_s, sube), rows in sorted(gruplar.items()):
        acilis = [r for r in rows if r["slot_tip"] == "acilis"]
        if not acilis:
            en_erken = min(r["baslangic"] for r in rows)
            acilis = [r for r in rows if r["baslangic"] == en_erken]
        kapanis = [r for r in rows if r["slot_tip"] == "kapanis"]
        if not kapanis:
            en_gec = max(r["bitis"] for r in rows)
            kapanis = [r for r in rows if r["bitis"] == en_gec]
        ozet.append({
            "gun": gun_s, "sube": sube,
            "acilis_personeli": [f"{r['personel']} ({r['baslangic'][:5]})" for r in acilis],
            "kapanis_personeli": [f"{r['personel']} ({r['bitis'][:5]})" for r in kapanis],
            "toplam_atama": len(rows),
        })
    with db() as (_, cur):
        cur.execute(
            """SELECT e.tarih::text AS gun, COALESCE(s.ad, e.sube_id) AS sube, e.tip,
                      TO_CHAR(e.cevap_ts, 'HH24:MI') AS saat, e.durum
               FROM sube_operasyon_event e
               LEFT JOIN subeler s ON s.id = e.sube_id
               WHERE e.tip IN ('ACILIS','KAPANIS')
                 AND e.tarih BETWEEN CURRENT_DATE - 1 AND CURRENT_DATE
               ORDER BY e.tarih, sube, e.tip""")
        gerceklesen = [dict(r) for r in cur.fetchall() or []]
    return {
        "gerceklesen_acilis_kapanis": gerceklesen,
        "acilis_kapanis_ozeti": ozet,
        "atamalar": satirlar[:80],
        "not": "İSİMLİ operasyonel TAKVİM penceresi — kim-nerede-ne-zaman planı. "
               "gerceklesen_acilis_kapanis = şube panelinden FİİLEN yapılan açılış/"
               "kapanış olay saatleri (dün+bugün; saat boşsa henüz cevaplanmadı). "
               "Açılış/kapanış alanları HAZIRDIR (tip işaretli slot; yoksa en erken "
               "başlayan / en geç biten). Bu pencere kişi DEĞERLENDİRMESİ için "
               "kullanılamaz; plan aktarımı yargı değildir.",
    }


@router.get("/maas-avans-ozet")
def maas_avans_ozet():
    """MAAŞ + AVANS KİMLİKSİZ ÖZET: dönem başına kişi SAYISI ve TOPLAMLAR.
    Kişi adı/kimliği bu pencereye ASLA girmez (kimlik firewall)."""
    with db() as (_, cur):
        cur.execute(
            """SELECT yil, ay, COUNT(DISTINCT personel_id)::int AS kisi_sayisi,
                      ROUND(SUM(COALESCE(hesaplanan_net,0))::numeric, 2) AS toplam_net,
                      ROUND(SUM(COALESCE(fazla_mesai_saat,0))::numeric, 1) AS toplam_fazla_mesai_saat,
                      ROUND(SUM(COALESCE(eksik_gun,0))::numeric, 1) AS toplam_eksik_gun
               FROM personel_aylik
               GROUP BY yil, ay ORDER BY yil DESC, ay DESC LIMIT 4"""
        )
        donemler = [dict(r) for r in cur.fetchall() or []]
        for d in donemler:
            for k in ("toplam_net", "toplam_fazla_mesai_saat", "toplam_eksik_gun"):
                if d.get(k) is not None:
                    d[k] = float(d[k])
        cur.execute(
            """SELECT durum, COUNT(*)::int AS adet,
                      ROUND(SUM(COALESCE(tutar,0))::numeric, 2) AS toplam
               FROM personel_avans GROUP BY durum ORDER BY toplam DESC"""
        )
        avanslar = [{"durum": r["durum"], "adet": r["adet"],
                     "toplam": float(r["toplam"] or 0)} for r in cur.fetchall() or []]
    return {
        "maas_donemleri": donemler,
        "avans_durumlari": avanslar,
        "not": "KİMLİKSİZ toplam düzey: kişi sayısı + toplam tutarlar. Kişi bazlı maaş "
               "bu pencerede YOK (kimlik firewall) — detay Personel ekranında.",
    }


@router.get("/stok-hareket-ozet")
def stok_hareket_ozet(gun: int = 7):
    """STOK HAREKET ÖZETİ: şube × hareket türü adet+miktar (son N gün) + açık sayım
    görevleri + son elle düzeltmeler. Kalem-kalem detay değil, akışın nabzı."""
    g = max(3, min(30, int(gun or 7)))
    with db() as (_, cur):
        cur.execute(
            """SELECT s.ad AS sube, h.hareket_turu, COUNT(*)::int AS adet,
                      ROUND(SUM(ABS(COALESCE(h.miktar,0)))::numeric, 1) AS toplam_miktar
               FROM sube_depo_stok_hareket h
               JOIN subeler s ON s.id = h.sube_id
               WHERE h.zaman >= NOW() - (%s * INTERVAL '1 day')
               GROUP BY 1, 2 ORDER BY 1, adet DESC""",
            (g,),
        )
        hareketler = [dict(r) for r in cur.fetchall() or []]
        for h in hareketler:
            if h.get("toplam_miktar") is not None:
                h["toplam_miktar"] = float(h["toplam_miktar"])
        # KALEM DETAYI (2026-07-08 gece): 'TEMA'ya bu hafta plastik bardak girişi
        # yapıldı mı?' sorusu tür toplamıyla cevaplanamıyordu — giriş/çıkış türlerinde
        # şube×kalem kırılımı (ilk 40 satır, miktara göre).
        cur.execute(
            """SELECT s.ad AS sube, h.hareket_turu, h.kalem_adi,
                      ROUND(SUM(ABS(COALESCE(h.miktar,0)))::numeric, 1) AS toplam_miktar,
                      COUNT(*)::int AS islem
               FROM sube_depo_stok_hareket h
               JOIN subeler s ON s.id = h.sube_id
               WHERE h.zaman >= NOW() - (%s * INTERVAL '1 day')
                 AND COALESCE(h.kalem_adi,'') <> ''
               GROUP BY 1, 2, 3 ORDER BY toplam_miktar DESC LIMIT 40""",
            (g,),
        )
        kalem_detay = [dict(r) for r in cur.fetchall() or []]
        for kd in kalem_detay:
            if kd.get("toplam_miktar") is not None:
                kd["toplam_miktar"] = float(kd["toplam_miktar"])
        cur.execute(
            """SELECT COUNT(*)::int AS acik_gorev FROM stok_sayim_gorev
               WHERE tamamlama_ts IS NULL"""
        )
        acik = dict(cur.fetchone() or {})
        cur.execute(
            """SELECT COUNT(*)::int AS adet FROM envanter_duzeltme
               WHERE olusturma >= NOW() - INTERVAL '30 days'"""
        )
        duzeltme = dict(cur.fetchone() or {})
    return {
        "kesit_gun": g,
        "hareket_kirilimi": hareketler[:60],
        "kalem_detay": kalem_detay,
        "acik_sayim_gorevi": acik.get("acik_gorev", 0),
        "son_30g_envanter_duzeltme": duzeltme.get("adet", 0),
        "not": "Şube×tür stok akış nabzı + kalem_detay (şube×tür×kalem, miktara göre "
               "ilk 40). 'Şu şubeye şu kalem girişi oldu mu?' sorusu kalem_detay'dan "
               "cevaplanır; yoksa o dönemde o kalemde hareket YOK demektir.",
    }


@router.get("/kart-pozisyon")
def kart_pozisyon():
    """KART EKSTRE & LİMİT POZİSYONU: her kart için limit, son dönem borcu,
    kullanılabilir limit, son ödeme tarihi + bekleyen kart planları toplamı."""
    with db() as (_, cur):
        cur.execute(
            """SELECT k.id, k.kart_adi, k.banka,
                      ROUND(COALESCE(k.limit_tutar,0)::numeric,2) AS limit_tutar,
                      k.kesim_gunu, k.son_odeme_gunu,
                      ROUND(COALESCE(k.faiz_orani,0)::numeric,2) AS faiz_orani
               FROM kartlar k WHERE k.aktif = TRUE ORDER BY k.kart_adi"""
        )
        kartlar = [dict(r) for r in cur.fetchall() or []]
        for kt in kartlar:
            kt["limit_tutar"] = float(kt["limit_tutar"] or 0)
            kt["faiz_orani"] = float(kt["faiz_orani"] or 0)
            cur.execute(
                """SELECT donem, ROUND(COALESCE(donem_borcu,0)::numeric,2) AS donem_borcu,
                          ROUND(COALESCE(kullanilabilir_limit,0)::numeric,2) AS kullanilabilir,
                          son_odeme_tarihi::text AS son_odeme
                   FROM kart_ekstre_donem WHERE kart_id = %s
                   ORDER BY donem DESC LIMIT 1""",
                (kt["id"],),
            )
            e = cur.fetchone()
            kt["son_ekstre"] = ({"donem": e["donem"], "donem_borcu": float(e["donem_borcu"]),
                                 "kullanilabilir_limit": float(e["kullanilabilir"]),
                                 "son_odeme_tarihi": e["son_odeme"]} if e else None)
            cur.execute(
                """SELECT ROUND(SUM(odenecek_tutar - COALESCE(odenen_tutar,0))::numeric,2) AS bekleyen
                   FROM odeme_plani
                   WHERE kart_id = %s AND durum IN ('bekliyor','onay_bekliyor')""",
                (kt["id"],),
            )
            b = cur.fetchone()
            kt["bekleyen_plan_toplami"] = float((b or {}).get("bekleyen") or 0)
            _borc = float((kt.get("son_ekstre") or {}).get("donem_borcu") or 0)
            # 'İLK ÖDEME yapılmamış' HAZIR alanı (sahip sorusu 2026-07-09):
            # bekleyen plan ≈ dönem borcu → henüz hiç ödeme düşmemiş
            kt["plan_odemesi_baslamis"] = bool(_borc > 0.01
                                               and kt["bekleyen_plan_toplami"] < _borc - 0.01)
            del kt["id"]
    # F4 — KANONİK KAYNAK + DÖNGÜ (2026-07-09): 'tek toplam kaynağı' dersi (4d290ec)
    # beyin penceresine de uygulanır — /api/kartlar'ın anlık/taksitli rakamları ve
    # kart-döngü durumu her karta işlenir; dönem borcu artık yalnız REFERANS.
    try:
        from main import kartlar_listele
        _kl = kartlar_listele()
        _kl = _kl if isinstance(_kl, list) else (_kl or {}).get("kartlar") or []
        kanonik = {str(x.get("kart_adi")): x for x in _kl}
    except Exception as e:  # noqa: BLE001
        kanonik = {}
        logger.warning("kart pozisyon kanonik okunamadi: %s", str(e)[:80])
    try:
        dongu_map = {s.get("kart"): s for s in (kart_dongu().get("kartlar") or [])}
    except Exception:  # noqa: BLE001
        dongu_map = {}
    for kt in kartlar:
        kx = kanonik.get(kt.get("kart_adi")) or {}
        kt["anlik_borc"] = kx.get("anlik_borc")
        kt["toplam_borc_taksitli"] = kx.get("toplam_borc_taksitli")
        kt["gelecek_taksit_anapara"] = kx.get("gelecek_taksit_anapara")
        kt["kalan_limit"] = kx.get("kalan_limit")
        dg = dongu_map.get(kt.get("kart_adi")) or {}
        kt["dongu_durum"] = dg.get("durum")
        kt["dongu_mesaj"] = dg.get("mesaj")
    _borclu = [k for k in kartlar if float((k.get("son_ekstre") or {}).get("donem_borcu") or 0) > 0.01]
    toplamlar = {
        "donem_borcu_toplam": round(sum(float((k.get("son_ekstre") or {}).get("donem_borcu") or 0)
                                        for k in kartlar), 2),
        "bekleyen_plan_toplam": round(sum(float(k.get("bekleyen_plan_toplami") or 0)
                                          for k in kartlar), 2),
        "ilk_odemesi_yapilmamis_kart_sayisi": sum(1 for k in _borclu
                                                  if not k.get("plan_odemesi_baslamis")),
        "ilk_odemesi_yapilmamis_borc_toplami": round(sum(
            float((k.get("son_ekstre") or {}).get("donem_borcu") or 0)
            for k in _borclu if not k.get("plan_odemesi_baslamis")), 2),
        "anlik_borc_toplam_KANONIK": round(sum(float(k.get("anlik_borc") or 0)
                                               for k in kartlar), 2),
        "taksitli_toplam_borc_KANONIK": round(sum(float(k.get("toplam_borc_taksitli") or 0)
                                                  for k in kartlar), 2),
        "ekstre_bekleyen_kart": sum(1 for k in kartlar
                                    if k.get("dongu_durum") == "ekstre_bekleniyor"),
        "gecikmis_kart": sum(1 for k in kartlar if k.get("dongu_durum") == "gecikti"),
    }
    # K2-A: aylık ÖDENEN FAİZ trendi (son 4 ay) + sınıflandırma bekleyen
    # 'belirsiz' harcama özeti (30 gün) — P&L'e gider olarak giren gri bölge.
    faiz_trend, belirsiz = [], {}
    try:
        with db() as (_, cur):
            cur.execute(
                """SELECT TO_CHAR(tarih,'YYYY-MM') AS ay,
                          ROUND(SUM(tutar)::numeric,2) AS toplam
                   FROM kart_hareketleri
                   WHERE islem_turu='FAIZ' AND durum='aktif'
                     AND tarih >= (CURRENT_DATE - INTERVAL '4 months')
                   GROUP BY 1 ORDER BY 1 DESC""")
            faiz_trend = [{"ay": r["ay"], "odenen_faiz": float(r["toplam"])}
                          for r in cur.fetchall() or []]
            cur.execute(
                """SELECT COUNT(*)::int AS adet,
                          ROUND(COALESCE(SUM(tutar),0)::numeric,2) AS toplam
                   FROM kart_hareketleri
                   WHERE islem_turu='HARCAMA' AND durum='aktif'
                     AND COALESCE(harcama_tipi,'belirsiz')='belirsiz'
                     AND tarih >= CURRENT_DATE - 30""")
            rb = dict(cur.fetchone() or {})
            belirsiz = {"adet": int(rb.get("adet") or 0),
                        "toplam_30g": float(rb.get("toplam") or 0),
                        "not": "sınıflandırılmamış (işletme mi şahsi mi belli değil) — "
                               "şu an P&L'e GİDER olarak giriyor"}
    except Exception as e:  # noqa: BLE001
        logger.warning("kart faiz/belirsiz ozet: %s", str(e)[:80])
    return {
        "OZET_toplamlar": toplamlar,  # EN BAŞTA: 'kasa yeter mi' sorusunun hazır cevabı
        "aylik_odenen_faiz_trendi": faiz_trend,
        "belirsiz_harcama_30g": belirsiz,
        "kartlar": kartlar,
        "not": "KANONİK borç = anlik_borc (ödeme/kullanımla oynar) ve "
               "toplam_borc_taksitli (taksitler dahil gerçek yük); donem_borcu = son "
               "ekstre REFERANSI (bayat olabilir — dongu_durum söyler: "
               "ekstre_bekleniyor = rakam eski dönemden). Ekstre YAKLAŞIKTIR "
               "(banka canlı verisi değil).",
    }


@router.get("/siparis-sevkiyat-ozet")
def siparis_sevkiyat_ozet(gun: int = 30):
    """SİPARİŞ-SEVKİYAT ZİNCİRİ ÖZETİ: toptancı sipariş durum kırılımı + bekleyen
    şube talepleri + yolda bekleyen kalemler (kabul edilmemiş) yaşıyla."""
    g = max(7, min(90, int(gun or 30)))
    with db() as (_, cur):
        cur.execute(
            """SELECT durum, COUNT(*)::int AS adet FROM toptanci_siparis
               WHERE olusturma >= NOW() - (%s * INTERVAL '1 day')
               GROUP BY durum ORDER BY adet DESC""",
            (g,),
        )
        siparisler = [dict(r) for r in cur.fetchall() or []]
        cur.execute(
            """SELECT COUNT(*)::int AS adet FROM siparis_talep WHERE durum = 'bekliyor'"""
        )
        bekleyen_talep = dict(cur.fetchone() or {}).get("adet", 0)
        cur.execute(
            """SELECT s.ad AS sube, y.kalem_adi, y.sevk_adet,
                      y.sevk_ts::date::text AS sevk_gunu,
                      (CURRENT_DATE - y.sevk_ts::date)::int AS yas_gun
               FROM stok_yolda y JOIN subeler s ON s.id = y.sube_id
               WHERE y.kabul_ts IS NULL AND y.durum NOT IN ('iptal')
               ORDER BY y.sevk_ts ASC LIMIT 15"""
        )
        yolda = [dict(r) for r in cur.fetchall() or []]
    return {
        "kesit_gun": g,
        "siparis_durum_kirilimi": siparisler,
        "bekleyen_sube_talebi": bekleyen_talep,
        "yolda_kabul_bekleyen": yolda,
        "not": "Sevk edilmiş ama kabul edilmemiş kalemler yaşıyla listelenir — uzun "
               "yaş, sevkiyat/kabul zincirinde kopukluk göstergesi olabilir (yorum insanın).",
    }


@router.get("/vadeli-alim-ozet")
def vadeli_alim_ozet():
    """VADELİ ALIM PORTFÖYÜ: durum kırılımı + vadesi 7 gün içinde gelenler +
    vadesi geçmiş bekleyenler."""
    with db() as (_, cur):
        cur.execute(
            """SELECT durum, COUNT(*)::int AS adet,
                      ROUND(SUM(COALESCE(tutar,0))::numeric,2) AS toplam
               FROM vadeli_alimlar GROUP BY durum ORDER BY toplam DESC"""
        )
        durumlar = [{"durum": r["durum"], "adet": r["adet"],
                     "toplam": float(r["toplam"] or 0)} for r in cur.fetchall() or []]
        cur.execute(
            """SELECT aciklama, tedarikci, vade_tarihi::text AS vade,
                      ROUND(COALESCE(tutar,0)::numeric,2) AS tutar,
                      (vade_tarihi - CURRENT_DATE)::int AS kalan_gun
               FROM vadeli_alimlar
               WHERE durum = 'bekliyor' AND vade_tarihi <= CURRENT_DATE + 7
               ORDER BY vade_tarihi ASC LIMIT 12"""
        )
        yaklasan = [dict(r) for r in cur.fetchall() or []]
        for y in yaklasan:
            y["tutar"] = float(y["tutar"] or 0)
    return {
        "durum_kirilimi": durumlar,
        "vadesi_7gun_icinde_veya_gecmis": yaklasan,
        "not": "kalan_gun eksi ise vade GEÇMİŞ demektir. Ödeme kararı insanındır; "
               "seçenek kıyası için Ödeme Seçeneği penceresi (B20) kullanılabilir.",
    }


@router.get("/gunluk-not-ozet")
def gunluk_not_ozet(gun: int = 30):
    """İŞLETME GÜNLÜĞÜ PENCERESİ: sahibin girdiği notlar (kampanya, etkinlik, dış
    etken) son N gün — ciro yorumlarında insan bağlamı."""
    g = max(7, min(90, int(gun or 30)))
    with db() as (_, cur):
        cur.execute(
            """SELECT g.tarih::text AS tarih, COALESCE(s.ad, 'GENEL') AS sube,
                      g.baslik, LEFT(COALESCE(g.aciklama,''), 160) AS aciklama
               FROM isletme_gunlugu g
               LEFT JOIN subeler s ON s.id = g.sube_id
               WHERE g.tarih >= CURRENT_DATE - %s
               ORDER BY g.tarih DESC LIMIT 30""",
            (g,),
        )
        notlar = [dict(r) for r in cur.fetchall() or []]
    return {
        "kesit_gun": g,
        "notlar": notlar,
        "not": "İnsan girdisi günlük notları — sayısal veri değil BAĞLAM. Ciro "
               "değişimi yorumlanırken bu notlar aday açıklamadır, kanıt değildir.",
    }


# ── TAM KAPSAMA TURU 2/2 (2026-07-08): kalan 5 pencere ──
# Kimlik firewall: personel_satislar, ad_soyad, sayim_personel_ad vb. ASLA seçilmez.

@router.get("/evo-satis-kirilimi")
def evo_satis_kirilimi():
    """EVO ÜRÜN SATIŞ KIRILIMI (cache'ten, canlı Evo çağrısı YOK): son kayıtlı günün
    şube×grup×ürün dökümü + son 7 günün grup toplamları. personel_satislar alanı
    kimlik içerdiği için OKUNMAZ (firewall)."""
    with db() as (_, cur):
        cur.execute(
            """SELECT bastar::text AS gun, veri_json FROM evo_rapor_cache
               WHERE anahtar = 'sube-grup-detay' AND bastar = bittar
               ORDER BY bastar DESC LIMIT 7"""
        )
        gunler = [dict(r) for r in cur.fetchall() or []]
    if not gunler:
        return {"not": "Evo satış cache'i boş — gece çekimi henüz koşmamış olabilir.",
                "son_gun": None, "grup_7g": []}
    son = gunler[0]
    son_ozet = []
    for sube_ad, sd in (son["veri_json"].get("subeler") or {}).items():
        son_ozet.append({
            "sube": sube_ad,
            "ciro_toplam": sd.get("ciro_toplam"),
            "fatura_sayisi": sd.get("fatura_sayisi"),
            "nakit": sd.get("nakit"), "kart": sd.get("kart"),
            "gruplar": dict(sorted((sd.get("gruplar") or {}).items(),
                                   key=lambda kv: -(kv[1].get("ciro") or 0))[:6]),
            "cok_satilan_ilk8": [
                {"ad": u.get("ad"), "adet": u.get("adet"), "ciro": u.get("ciro")}
                for u in (sd.get("cok_satilan") or [])[:8]
            ],
        })
    grup_7g: dict = {}
    for g in gunler:
        for _sube, sd in (g["veri_json"].get("subeler") or {}).items():
            for grup, gv in (sd.get("gruplar") or {}).items():
                t = grup_7g.setdefault(grup, {"adet": 0.0, "ciro": 0.0})
                t["adet"] += float(gv.get("adet") or 0)
                t["ciro"] = round(t["ciro"] + float(gv.get("ciro") or 0), 2)
    grup_listesi = [{"grup": k, **v} for k, v in
                    sorted(grup_7g.items(), key=lambda kv: -kv[1]["ciro"])][:12]
    return {
        "son_gun": son["gun"],
        "son_gun_subeler": son_ozet,
        "grup_7g_toplam": grup_listesi,
        "not": "Kaynak=Evo gece çekim cache'i (canlı değil; son çekim gününe kadar). "
               "Kişi bazlı satış bu pencerede YOK (kimlik firewall). ÇAY grubu Evo "
               "eşleştirmesinde görünmeyebilir (bilinen sınır).",
    }


@router.get("/demirbas-ozet")
def demirbas_ozet():
    """DEMİRBAŞ ÖZETİ: şube başına durum kırılımı + 'var' olmayan kalemlerin listesi
    (eksik/arızalı takibi). Güncelleyen kişi adı OKUNMAZ."""
    with db() as (_, cur):
        cur.execute(
            """SELECT s.ad AS sube, d.durum, COUNT(*)::int AS adet
               FROM demirbas_durum d JOIN subeler s ON s.id = d.sube_id
               GROUP BY 1, 2 ORDER BY 1, 2"""
        )
        kirilim = [dict(r) for r in cur.fetchall() or []]
        cur.execute(
            """SELECT s.ad AS sube, k.kategori, k.ad AS kalem, d.durum,
                      LEFT(COALESCE(d.not_aciklama,''), 60) AS not_kisa,
                      d.guncelleme::date::text AS guncelleme
               FROM demirbas_durum d
               JOIN demirbas_kalem k ON k.id = d.kalem_id
               JOIN subeler s ON s.id = d.sube_id
               WHERE d.durum <> 'var'
               ORDER BY d.guncelleme DESC LIMIT 20"""
        )
        sorunlular = [dict(r) for r in cur.fetchall() or []]
    return {
        "durum_kirilimi": kirilim,
        "var_olmayanlar": sorunlular,
        "not": "Demirbaş modülü kuruluş aşamasında — veri azsa liste kısa olur. "
               "Kim güncelledi bilgisi kayıtta var ama bu pencerede gösterilmez.",
    }


@router.get("/is-basvuru-ozet")
def is_basvuru_ozet():
    """İŞ BAŞVURULARI KİMLİKSİZ ÖZET: durum×pozisyon adetleri + son 30 gün akışı.
    Ad-soyad/telefon bu pencereye ASLA girmez (kimlik firewall)."""
    with db() as (_, cur):
        cur.execute(
            """SELECT durum, COALESCE(NULLIF(TRIM(pozisyon),''),'BELİRSİZ') AS pozisyon,
                      COUNT(*)::int AS adet
               FROM is_basvuru GROUP BY 1, 2 ORDER BY adet DESC"""
        )
        kirilim = [dict(r) for r in cur.fetchall() or []]
        cur.execute(
            """SELECT COUNT(*)::int AS adet FROM is_basvuru
               WHERE olusturma_ts >= NOW() - INTERVAL '30 days'"""
        )
        son30 = dict(cur.fetchone() or {}).get("adet", 0)
        # 'bugün başvuru geldi mi' dileği (2026-07-09): gün-gün son 7 gün
        cur.execute(
            """SELECT olusturma_ts::date::text AS gun, COUNT(*)::int AS adet
               FROM is_basvuru WHERE olusturma_ts >= CURRENT_DATE - 7
               GROUP BY 1 ORDER BY 1 DESC"""
        )
        gun_gun = [dict(r) for r in cur.fetchall() or []]
        bugun_adet = next((r["adet"] for r in gun_gun
                           if r["gun"] == str(date.today())), 0)
        # PUAN bantları ('90 üzeri kaç kişi' sorusu): skor motoru saf-Python,
        # tüm başvurulara koşturmak ucuz. KİMLİKSİZ — yalnız adetler.
        bantlar = None
        try:
            from is_basvuru_api import _hesapla_skor
            cur.execute("SELECT * FROM is_basvuru")
            puanlar = []
            for r in cur.fetchall() or []:
                try:
                    puanlar.append(int(_hesapla_skor(dict(r)).get("toplam") or 0))
                except Exception:  # noqa: BLE001
                    continue
            bantlar = {"90_ve_uzeri": sum(1 for p in puanlar if p >= 90),
                       "80_89": sum(1 for p in puanlar if 80 <= p < 90),
                       "70_79": sum(1 for p in puanlar if 70 <= p < 80),
                       "70_alti": sum(1 for p in puanlar if p < 70),
                       "puanlanan_basvuru": len(puanlar)}
        except Exception as e:  # noqa: BLE001
            logger.warning("basvuru puan bandi: %s", str(e)[:80])
    return {
        "durum_pozisyon_kirilimi": kirilim,
        "son_30_gun_yeni_basvuru": son30,
        "bugun_yeni_basvuru": bugun_adet,
        "gun_gun_son7": gun_gun,
        "uygunluk_puan_bantlari": bantlar,
        "not": "KİMLİKSİZ havuz özeti. Aday isim/iletişim bilgisi İş Başvuruları "
               "ekranındadır — beyin kişi değerlendirmesi yapmaz. uygunluk_puan_bantlari "
               "= sistemin 5 boyut × 20 üzerinden otomatik ön-değerlendirmesi (adet).",
    }


@router.get("/personel-risk-ozet")
def personel_risk_ozet(gun: int = 30):
    """PERSONEL RİSK SİNYALLERİ — ŞUBE×TÜR düzeyinde KİMLİKSİZ toplam. Kişi kırılımı
    bu pencerede YOK; 'hangi kayıtta' sorusunun cevabı Personel ekranındadır."""
    g = max(7, min(90, int(gun or 30)))
    with db() as (_, cur):
        cur.execute(
            """SELECT COALESCE(s.ad, 'GENEL') AS sube, r.sinyal_turu,
                      COUNT(*)::int AS adet, SUM(COALESCE(r.agirlik,0))::int AS agirlik_toplam
               FROM personel_risk_sinyal r
               LEFT JOIN subeler s ON s.id = r.sube_id
               WHERE r.tarih >= CURRENT_DATE - %s
               GROUP BY 1, 2 ORDER BY agirlik_toplam DESC""",
            (g,),
        )
        kirilim = [dict(r) for r in cur.fetchall() or []]
    return {
        "kesit_gun": g,
        "sube_tur_kirilimi": kirilim,
        "not": "KİMLİKSİZ toplam: hangi şubede hangi TÜR sinyal birikiyor. Kişi bazlı "
               "değerlendirme motorun işidir (≥2 bağımsız kanıt + insan onayı) — bu "
               "pencere yalnız iklimi gösterir.",
    }


@router.get("/kasa-anomali-ozet")
def kasa_anomali_ozet(gun: int = 30):
    """KASA ANOMALİ ÖZETİ: ciro↔kasa izi eşleşme bozuklukları (v_kasa_anomali) +
    kasa baskını sayım sonuçları (adsız: tarih+beklenen+sayılan+fark)."""
    g = max(7, min(90, int(gun or 30)))
    with db() as (_, cur):
        cur.execute(
            """SELECT durum, COUNT(*)::int AS adet FROM v_kasa_anomali
               WHERE tarih >= CURRENT_DATE - %s AND durum <> 'OK'
               GROUP BY durum""",
            (g,),
        )
        anomaliler = [dict(r) for r in cur.fetchall() or []]
        cur.execute(
            """SELECT tarih::text AS tarih, durum,
                      ROUND(COALESCE(ciro_toplam,0)::numeric,2) AS ciro_toplam
               FROM v_kasa_anomali
               WHERE tarih >= CURRENT_DATE - %s AND durum <> 'OK'
               ORDER BY tarih DESC LIMIT 10""",
            (g,),
        )
        ornekler = [dict(r) for r in cur.fetchall() or []]
        for o in ornekler:
            o["ciro_toplam"] = float(o["ciro_toplam"] or 0)
        cur.execute(
            """SELECT b.baslatma_ts::date::text AS tarih, s.ad AS sube,
                      ROUND(COALESCE(b.beklenen_tutar,0)::numeric,2) AS beklenen,
                      ROUND(COALESCE(b.sayilan_tutar,0)::numeric,2) AS sayilan,
                      ROUND(COALESCE(b.fark,0)::numeric,2) AS fark
               FROM kasa_baskini b LEFT JOIN subeler s ON s.id = b.sube_id
               ORDER BY b.baslatma_ts DESC LIMIT 8"""
        )
        baskinlar = [dict(r) for r in cur.fetchall() or []]
        for b in baskinlar:
            for k in ("beklenen", "sayilan", "fark"):
                b[k] = float(b[k] or 0)
    return {
        "kesit_gun": g,
        "anomali_kirilimi": anomaliler,
        "anomali_ornekleri": ornekler,
        "kasa_baskini_sonuclari": baskinlar,
        "not": "Anomali = ciro kaydının kasa izinde karşılığı yok/iptal. AÇIKLAMA "
               "değil GÖZLEMDİR — beraat yasağı: hiçbir açıklama alarmı kapatmaz; "
               "kim sorusunun kaydı ilgili ekranda.",
    }


# ── TUTARSIZLIK ÖZETİ (2026-07-08 gece): "şurada şu, burada bu — aynı olmalıydı" ──
# Kullanıcı isteği: beyin veri tutarsızlıklarını TEK dilde söyleyebilsin
# ("12 bardak satılması lazımdı ama 14 görünüyor"). Yeni veri ÜRETMEZ — mevcut
# çapraz kontrolleri (kasa anomali, bar deviri, satış↔sayım, makine↔satış)
# tek pencerede 'kaynak A / kaynak B / fark' kalıbına çevirir. Hüküm yok.

@router.get("/tutarsizlik-ozeti")
def tutarsizlik_ozeti(gun: int = 7, taze: int = 0):
    g = max(3, min(14, int(gun or 7)))
    if not taze and g == 7:
        _c = _agir_oku("tutarsizlik_ozeti")
        if _c is not None:
            return _c  # GÖREV #56: gündüz cache (gece ön-hesap)
    bugun = date.today()
    satirlar: List[dict] = []

    # 1) CİRO ↔ KASA İZİ (aynı işlem iki deftere de yazılmalı)
    try:
        with db() as (_, cur):
            cur.execute(
                """SELECT tarih::text AS tarih, durum,
                          ROUND(COALESCE(ciro_toplam,0)::numeric,2) AS tutar
                   FROM v_kasa_anomali
                   WHERE tarih >= CURRENT_DATE - %s AND durum <> 'OK'
                   ORDER BY tarih DESC LIMIT 10""", (g,))
            for r in [dict(x) for x in cur.fetchall() or []]:
                satirlar.append({
                    "konu": "ciro kaydı ↔ kasa izi", "tarih": r["tarih"],
                    "kaynak_a": "ciro defteri", "deger_a": float(r["tutar"]),
                    "kaynak_b": "kasa izi", "deger_b": r["durum"],
                    "beklenti": "her ciro kaydının kasa izinde karşılığı OLMALI",
                })
    except Exception as e:  # noqa: BLE001
        logger.warning("tutarsizlik kasa-anomali: %s", str(e)[:80])

    # 2) DÜN KAPANIŞ ↔ BUGÜN AÇILIŞ (bar deviri — köprü ürün-aç düşülmüş)
    try:
        from operasyon_merkez_api import ops_bar_ozet
        aylar = {str(bugun - timedelta(days=i))[:7] for i in range(g + 1)}
        for ay in sorted(aylar):
            rows = ops_bar_ozet(sube_id=None, year_month=ay, gun=None,
                                limit=365, kapanis_fallback=True,
                                evo_yenile=False).get("satirlar") or []
            for r in rows:
                t = str(r.get("tarih") or "")
                if not t or t < str(bugun - timedelta(days=g)):
                    continue
                for kalem, f in (r.get("devir_farklari") or {}).items():
                    satirlar.append({
                        "konu": f"devir ({kalem})", "tarih": t,
                        "sube": r.get("sube_adi"),
                        "kaynak_a": "dün kapanış + gece ürün-aç",
                        "deger_a": f.get("beklenen"),
                        "kaynak_b": "bugün açılış sayımı",
                        "deger_b": f.get("bugun_acilis"),
                        "fark": f.get("fark"),
                        "beklenti": "açılış = dün kapanış + köprü ürün-aç OLMALI",
                    })
    except Exception as e:  # noqa: BLE001
        logger.warning("tutarsizlik devir: %s", str(e)[:80])

    # 3) SATIŞ ↔ SAYIM (reçete kıyası: '12 satılması lazım, 14 görünüyor' tam bu)
    try:
        from recete_api import recete_kontrol
        rk = recete_kontrol(gun=g)
        for k in (rk.get("kiyas") or []):
            if k.get("fark") is None or k.get("fark_yuzde") is None:
                continue
            if abs(k["fark_yuzde"]) < 15:  # küçük dalgalanma gürültüsü ele
                continue
            satirlar.append({
                "konu": f"satış ↔ tüketim ({k['malzeme']})", "tarih": k["gun"],
                "kaynak_a": "satış × reçete (beklenen)",
                "deger_a": k["beklenen_miktar"],
                "kaynak_b": "sayım/ürün-aç (gerçek)",
                "deger_b": k.get("gercek_miktar"),
                "fark": k["fark"], "fark_yuzde": k["fark_yuzde"],
                "beklenti": "satılan kadar tüketim OLMALI (± fire payı)",
            })
    except Exception as e:  # noqa: BLE001
        logger.warning("tutarsizlik recete: %s", str(e)[:80])

    # 4) TOPTANCI KABUL ↔ STOK GİRİŞİ (R10 beklenti ihlalleri — omurgadan)
    # "Kabul onaylandı ama depo stoğu artmadı" = giriş tarafının tutarsızlığı.
    try:
        with db() as (_, cur):
            cur.execute(
                """SELECT occurred_at::text AS tarih, entity_id, payload_json
                   FROM duyu_olay
                   WHERE duyu = 'yavru_beklenti'
                     AND olay_tipi = 'yavru.beklenti.cocuk_gelmedi'
                     AND payload_json->>'kural_id' = 'R10_kabul_stok'
                     AND observed_at >= NOW() - (%s * INTERVAL '1 day')
                   ORDER BY observed_at DESC LIMIT 10""", (g,))
            for r in [dict(x) for x in cur.fetchall() or []]:
                p = r.get("payload_json") or {}
                satirlar.append({
                    "konu": "toptancı kabul ↔ stok girişi",
                    "tarih": (r.get("tarih") or "")[:10],
                    "kaynak_a": "sevkiyat kabulü (onaylandı)",
                    "deger_a": p.get("kabul_adet") or "kabul kaydı var",
                    "kaynak_b": "depo stok girişi",
                    "deger_b": "GİRİŞ YOK",
                    "beklenti": "kabul edilen mal depo stoğuna GİRMELİ (R10 zinciri)",
                })
    except Exception as e:  # noqa: BLE001
        logger.warning("tutarsizlik kabul-stok: %s", str(e)[:80])

    # 5) DEPOLAR ARASI SEVK: ÇIKAN ↔ GİREN (aynı sevkiyat no + kalem üzerinden)
    # Bir depodan çıkan miktar hedef şubeye AYNEN girmeli; net≠0 = yolda ya da kayıp.
    try:
        with db() as (_, cur):
            cur.execute(
                """SELECT h.kaynak_id, h.kalem_adi, MAX(h.zaman)::date::text AS tarih,
                          ROUND(SUM(CASE WHEN h.miktar < 0 THEN -h.miktar ELSE 0 END)::numeric,1) AS cikan,
                          ROUND(SUM(CASE WHEN h.miktar > 0 THEN h.miktar ELSE 0 END)::numeric,1) AS giren,
                          ROUND(SUM(COALESCE(h.miktar,0))::numeric,1) AS net,
                          STRING_AGG(DISTINCT CASE WHEN h.miktar < 0
                                     THEN COALESCE(s.ad, h.sube_id) END, '+') AS veren,
                          STRING_AGG(DISTINCT CASE WHEN h.miktar > 0
                                     THEN COALESCE(s.ad, h.sube_id) END, '+') AS alan
                   FROM sube_depo_stok_hareket h
                   LEFT JOIN subeler s ON s.id = h.sube_id
                   WHERE h.kaynak_tip = 'sevkiyat'
                     AND h.hareket_turu IN ('SEVK_CIKIS','SEVK_GIRIS','SEVK_UZLASMA')
                     AND h.zaman >= NOW() - (%s * INTERVAL '1 day')
                   GROUP BY h.kaynak_id, h.kalem_adi
                   HAVING ABS(SUM(COALESCE(h.miktar,0))) > 0.01
                   ORDER BY MAX(h.zaman) DESC LIMIT 12""", (g,))
            for r in [dict(x) for x in cur.fetchall() or []]:
                # 2026-07-09 sahip dersi: tarih/sube olmadan cevap muallak kaliyordu —
                # veren/alan sube ve sevkiyat gunu HAZIR alan olarak pencereye girer
                satirlar.append({
                    "konu": f"depolar arası sevk ({r['kalem_adi']})",
                    "tarih": r["tarih"], "sevk_gunu": r["tarih"],
                    "veren_depo": r.get("veren") or "çıkış kaydı YOK (veren ayak kayıtsız)",
                    "alan_sube": r.get("alan") or "giriş kaydı YOK (henüz kabul edilmedi / yolda)",
                    "kaynak_a": "depodan çıkan", "deger_a": float(r["cikan"]),
                    "kaynak_b": "şubeye giren", "deger_b": float(r["giren"]),
                    "fark": float(r["net"]),
                    "beklenti": "çıkan = giren OLMALI (fark: mal yolda olabilir — "
                                "kabul bekliyorsa B28 yolda listesinde görünür)",
                })
    except Exception as e:  # noqa: BLE001
        logger.warning("tutarsizlik sevk: %s", str(e)[:80])

    # 6) MAKİNE ↔ SATIŞ (değirmen sayacı)
    try:
        from recete_api import degirmen_kiyas
        dk = degirmen_kiyas(gun=g)
        for k in (dk.get("gun_kiyasi") or []):
            if k.get("fark_yuzde") is None or abs(k["fark_yuzde"]) < 15:
                continue
            satirlar.append({
                "konu": "değirmen ↔ satış (espresso)", "tarih": k["tarih"],
                "kaynak_a": "makine sayacı", "deger_a": k["makine_gram"],
                "kaynak_b": "satış × reçete", "deger_b": k.get("beklenen_gram"),
                "fark": k.get("fark_gram"), "fark_yuzde": k["fark_yuzde"],
                "beklenti": "makine çektiği kadar satış OLMALI (± çöp-shot payı)",
            })
    except Exception as e:  # noqa: BLE001
        logger.warning("tutarsizlik degirmen: %s", str(e)[:80])

    satirlar.sort(key=lambda x: x.get("tarih") or "", reverse=True)
    return {
        "kesit_gun": g,
        "toplam": len(satirlar),
        "tutarsizliklar": satirlar[:60],
        "not": "İKİ KAYNAK AYNI ŞEYİ FARKLI SÖYLÜYOR listesi (6 kontrol: ciro-kasa izi, "
               "devir, satış-tüketim, kabul-stok girişi, depolar-arası sevk, makine-satış) — hüküm yok, "
               "beraat da yok: hiçbir açıklama satırı listeden düşürmez, yorum insanındır. "
               "Boş liste 'her şey tutarlı' demektir. Eşik: satış/makine kıyasında "
               "±%15 altı gürültü sayılıp gösterilmez (ham hali ilgili pencerelerde).",
    }


# ── STOK DENGE DENKLEMİ (2026-07-08 gece, sahip tarifi): kalem başına tam hesap ──
# "300 vardı, 500 geldi, 700 satıldı, kapanışta 31 kalmış — olması gereken neydi?"
# İKİ KATMAN: DEPO (başlangıç + giren − çıkan = olması gereken ↔ mevcut) ve
# BAR (açılış + bara verilen − kapanış = kullanılan ↔ satılan; ops_bar_ozet'te).
# ARTI: hareket ZİNCİRİ sürekliliği — her hareket önceki→sonraki yazar; kopukluk
# (bir hareketin 'önceki'si ≠ önceki hareketin 'sonraki'si) = kayıtsız el değmiş.

@router.get("/stok-denge")
def stok_denge(gun: int = 7, sube: str = "", kalem: str = "", taze: int = 0):
    """Kalem×şube denge tablosu (öneri-only, hüküm yok). fark = mevcut − olması
    gereken: pozitif = kayıtsız giriş/sayım fazlası, negatif = kayıtsız çıkış.
    zincir_kopugu > 0 = hareket defterinde süreklilik kırılması (elle müdahale izi)."""
    g = max(3, min(30, int(gun or 7)))
    if not taze and g == 7 and not (sube or "").strip() and not (kalem or "").strip():
        _c = _agir_oku("stok_denge")
        if _c is not None:
            return _c  # GÖREV #56: yalnız filtresiz varsayılan kesit cache'lenir
    with db() as (_, cur):
        params: list = [g]
        sube_f = kalem_f = ""
        if sube.strip():
            sube_f = " AND UPPER(s.ad) LIKE UPPER(%s) "
            params.append(f"%{sube.strip()}%")
        if kalem.strip():
            kalem_f = " AND UPPER(h.kalem_adi) LIKE UPPER(%s) "
            params.append(f"%{kalem.strip()}%")
        cur.execute(f"""
            SELECT h.sube_id, s.ad AS sube, h.kalem_kodu, MAX(h.kalem_adi) AS kalem_adi,
                   COUNT(*)::int AS hareket_sayisi,
                   ROUND(SUM(COALESCE(h.miktar,0))::numeric,1) AS kayitli_net,
                   ROUND(SUM(CASE WHEN h.hareket_turu IN ('TESLIM_GIRIS','SEVK_GIRIS')
                                  THEN COALESCE(h.miktar,0) ELSE 0 END)::numeric,1) AS giren,
                   ROUND(SUM(CASE WHEN h.hareket_turu = 'SEVK_CIKIS'
                                  THEN ABS(COALESCE(h.miktar,0)) ELSE 0 END)::numeric,1) AS sevk_cikan,
                   ROUND(SUM(CASE WHEN h.hareket_turu = 'FIRE'
                                  THEN ABS(COALESCE(h.miktar,0)) ELSE 0 END)::numeric,1) AS fire,
                   ROUND(SUM(CASE WHEN h.hareket_turu = 'URUN_AC'
                                  THEN ABS(COALESCE(h.miktar,0)) ELSE 0 END)::numeric,1) AS bara_verilen,
                   ROUND(SUM(CASE WHEN h.hareket_turu NOT IN
                                  ('TESLIM_GIRIS','SEVK_GIRIS','SEVK_CIKIS','FIRE')
                                  AND COALESCE(h.miktar,0) < 0
                                  THEN ABS(h.miktar) ELSE 0 END)::numeric,1) AS diger_cikan
            FROM sube_depo_stok_hareket h
            JOIN subeler s ON s.id = h.sube_id
            WHERE h.zaman >= NOW() - (%s * INTERVAL '1 day')
              AND COALESCE(h.kalem_adi,'') <> ''
              {sube_f} {kalem_f}
            GROUP BY h.sube_id, s.ad, h.kalem_kodu
            ORDER BY ABS(SUM(COALESCE(h.miktar,0))) DESC LIMIT 60""", params)
        gruplar = [dict(r) for r in cur.fetchall() or []]

        sonuc = []
        for grp in gruplar:
            sid, kod = grp["sube_id"], grp["kalem_kodu"]
            # pencere içi hareketler kronolojik: başlangıç = ilk hareketin 'önceki'si;
            # zincir kopukluğu = ardışık kayıtta önceki ≠ bir önceki kaydın sonraki'si
            cur.execute(
                """SELECT miktar, onceki_miktar, sonraki_miktar
                   FROM sube_depo_stok_hareket
                   WHERE sube_id=%s AND kalem_kodu=%s
                     AND zaman >= NOW() - (%s * INTERVAL '1 day')
                   ORDER BY zaman ASC, created_at ASC""",
                (sid, kod, g))
            hs = [dict(r) for r in cur.fetchall() or []]
            baslangic = None
            zincir_kopugu = 0
            son_sonraki = None
            for hrow in hs:
                om, sm = hrow.get("onceki_miktar"), hrow.get("sonraki_miktar")
                if baslangic is None and om is not None:
                    baslangic = float(om)
                if son_sonraki is not None and om is not None:
                    if abs(float(om) - son_sonraki) > 0.01:
                        zincir_kopugu += 1
                if sm is not None:
                    son_sonraki = float(sm)
            cur.execute(
                """SELECT COALESCE(SUM(mevcut_adet),0) AS mevcut FROM sube_depo_stok
                   WHERE sube_id=%s AND kalem_kodu=%s""", (sid, kod))
            mevcut = float(dict(cur.fetchone() or {}).get("mevcut") or 0)
            satir = {
                "sube": grp["sube"], "kalem": grp["kalem_adi"], "kalem_kodu": kod,
                "baslangic": baslangic,
                "giren": float(grp["giren"] or 0),
                "sevk_cikan": float(grp["sevk_cikan"] or 0),
                "fire": float(grp["fire"] or 0),
                "bara_verilen": float(grp.get("bara_verilen") or 0),
                "diger_cikan": float(grp["diger_cikan"] or 0),
                "kayitli_net": float(grp["kayitli_net"] or 0),
                "depo_mevcut": mevcut,
                "zincir_kopugu": zincir_kopugu,
                "hareket_sayisi": grp["hareket_sayisi"],
            }
            if baslangic is not None:
                beklenen = round(baslangic + satir["kayitli_net"], 1)
                satir["olmasi_gereken"] = beklenen
                satir["fark"] = round(mevcut - beklenen, 1)
            else:
                satir["olmasi_gereken"] = None
                satir["fark"] = None
                satir["eksik"] = "baslangic_bilinmiyor"
            sonuc.append(satir)
    return {
        "kesit_gun": g,
        "denge": sonuc,
        "not": "DEPO DENKLEMİ: başlangıç + kayıtlı hareketler = olması gereken ↔ "
               "sistem mevcudu. fark≠0 = KAYITSIZ değişim (pozitif: kayıtsız "
               "giriş/sayım düzeltmesi; negatif: kayıtsız çıkış). zincir_kopugu = "
               "hareket defterinde süreklilik kırılması (arada kayıtsız el değmiş). "
               "Bar tarafı (açılış+verilen−kapanış=kullanılan↔satılan) ayrı denklem: "
               "recete/kontrol ve bar özeti. Toplam eldeki = depo mevcut + bar "
               "kapanış sayımı. GÖZLEMDİR — yorum insanın.",
    }


# ── ÇAPRAZ HİPOTEZ MOTORU (2026-07-09, sahip onayı: 'bunu da yap') ──
# İki ucun defterini OTOMATİK eşleştirir ve tek cümlelik hipotez üretir:
#  1. DEPO kayıtsız çıkışı (zincir kopuğundan YÖNLÜ ölçülür: kopukta
#     |önceki − bir önceki kaydın sonrakisi| = kayıtsız değişim miktarı)
#  2. BAR açığı (dedektör v3: satış var / kullanım az farkı)
#  → aynı şube-gün-kalemde örtüşüyorlarsa: 'muhtemel kayıtsız ürün-aç'
#  3. SEVK net≠0 → stok_yolda'da kabul bekleyen VARSA: 'yolda' (kesin);
#     yoksa: 'sevk çıkışı karşılıksız' adayı.
# HÜKÜM YOK — hipotez + güven + tanıklar; karar insanın.

@router.get("/stok-capraz-hipotez")
def stok_capraz_hipotez(gun: int = 7, taze: int = 0):
    g = max(3, min(14, int(gun or 7)))
    if not taze and g == 7:
        _c = _agir_oku("stok_capraz_hipotez")
        if _c is not None:
            return _c  # GÖREV #56: gündüz cache (gece ön-hesap)
    bugun = date.today()
    hipotezler: List[dict] = []

    # 1) depo kayıtsız değişimleri (şube-gün-kalem, yönlü)
    depo_kayitsiz: Dict[tuple, float] = {}
    with db() as (_, cur):
        cur.execute(
            """SELECT h.sube_id, s.ad AS sube, h.kalem_kodu,
                      h.zaman::date::text AS gun,
                      h.onceki_miktar, h.sonraki_miktar
               FROM sube_depo_stok_hareket h JOIN subeler s ON s.id = h.sube_id
               WHERE h.zaman >= NOW() - (%s * INTERVAL '1 day')
               ORDER BY h.sube_id, h.kalem_kodu, h.zaman ASC, h.created_at ASC""",
            (g,))
        son: Dict[tuple, float] = {}
        sube_ad: Dict[str, str] = {}
        for r in (dict(x) for x in cur.fetchall() or []):
            key = (r["sube_id"], r["kalem_kodu"])
            sube_ad[r["sube_id"]] = r["sube"]
            om, sm = r.get("onceki_miktar"), r.get("sonraki_miktar")
            if key in son and om is not None:
                sapma = float(om) - son[key]  # negatif = kayıtsız ÇIKIŞ
                if abs(sapma) > 0.01:
                    k2 = (r["sube_id"], r["gun"], r["kalem_kodu"])
                    depo_kayitsiz[k2] = depo_kayitsiz.get(k2, 0.0) + sapma
            if sm is not None:
                son[key] = float(sm)

    # 2) bar açıkları (dedektör v3)
    try:
        from recete_api import unutulan_urun_ac
        bar_bulgular = unutulan_urun_ac(gun=g).get("bulgular") or []
    except Exception as e:  # noqa: BLE001
        logger.warning("capraz hipotez dedektor okumasi: %s", str(e)[:80])
        bar_bulgular = []

    # sube adı → id köprüsü
    ad_to_id = {v.strip().upper(): k for k, v in sube_ad.items()}
    eslesen_depo: set = set()
    for b in bar_bulgular:
        if b.get("yon") != "satis_var_kullanim_az":
            # ters yön: bar fazla kullanmış — depo tanığı aranmaz, kendi hipotezi
            hipotezler.append({
                "tip": "kasasiz_satis_adayi", "guven": "orta",
                "sube": b.get("sube"), "tarih": b.get("tarih"),
                "kalem": b.get("kalem"),
                "hipotez": (f"{b.get('kalem')} barda {b.get('fark')} adet satış "
                            "kaydından FAZLA kullanılmış — kasasız satış / "
                            "bildirilmemiş fire-ikram adayı (kapsam şerhi geçerli)"),
                "taniklar": {"beklenen_satis": b.get("beklenen_bardak"),
                             "kullanim": b.get("hesaplanan_kullanim"),
                             "kapanis_sayim": b.get("kapanis_sayim")},
            })
            continue
        sid = ad_to_id.get(str(b.get("sube") or "").strip().upper())
        key = (sid, b.get("tarih"), b.get("kalem"))
        depo_cikis = -(depo_kayitsiz.get(key) or 0.0)  # pozitifleştir
        bar_acik = float(b.get("fark") or 0)
        if sid and depo_cikis > 0 and bar_acik > 0:
            oran = min(depo_cikis, bar_acik) / max(depo_cikis, bar_acik)
            if depo_cikis >= 1 and (abs(depo_cikis - bar_acik) <= 5 or oran >= 0.7):
                eslesen_depo.add(key)
                hipotezler.append({
                    "tip": "kayitsiz_urun_ac", "guven": "yuksek",
                    "sube": b.get("sube"), "tarih": b.get("tarih"),
                    "kalem": b.get("kalem"),
                    "hipotez": (f"depo kayıtsız −{depo_cikis:.0f} ↔ bar açığı "
                                f"+{bar_acik:.0f} ÖRTÜŞÜYOR → muhtemel kayıtsız "
                                "ürün-aç (mal bara gitmiş ve satılmış; kayıt eksik)"),
                    "taniklar": {"depo_kayitsiz_cikis": round(depo_cikis, 1),
                                 "bar_acik": bar_acik,
                                 "urun_ac_kaydi": b.get("urun_ac_kaydi")},
                })
                continue
        hipotezler.append({
            "tip": "bar_acigi_depo_izsiz", "guven": "dusuk",
            "sube": b.get("sube"), "tarih": b.get("tarih"),
            "kalem": b.get("kalem"),
            "hipotez": (f"bar açığı +{bar_acik:.0f} var ama aynı gün depo kayıtsız "
                        "izi yok → sayım hatası / satış gün-kayması / eşleşme "
                        "kapsam boşluğu adayları"),
            "taniklar": {"bar_acik": bar_acik,
                         "kapanis_sayim": b.get("kapanis_sayim")},
        })

    # ŞUBE-ÇAPRAZ TESLİM EŞLEŞTİRME (GÖREV #54, 2026-07-09): bar karşılığı olmayan
    # kayıtsız çıkış, ±1 gün içinde BAŞKA şubede aynı kalemin girişiyle örtüşüyorsa
    # → 'muhtemelen aynı teslimat, veren ayağı kayıtsız' (TEMA −500 ↔ ZAFER +500
    # deseni). 77238d6 sonrası yeni sevkler çift-ayaklı doğar; bu kural esasen
    # GEÇMİŞTEKİ tek-ayaklı kayıtları okunur kılar.
    girisler: Dict[tuple, float] = {}
    with db() as (_, cur):
        cur.execute(
            """SELECT h.sube_id, h.kalem_kodu, h.zaman::date::text AS gun,
                      ROUND(SUM(h.miktar)::numeric,1) AS giren
               FROM sube_depo_stok_hareket h
               WHERE h.miktar > 0
                 AND h.hareket_turu IN ('TESLIM_GIRIS','SEVK_GIRIS')
                 AND h.zaman >= NOW() - (%s * INTERVAL '1 day')
               GROUP BY h.sube_id, h.kalem_kodu, h.zaman::date""", (g,))
        for r in (dict(x) for x in cur.fetchall() or []):
            girisler[(r["sube_id"], r["gun"], r["kalem_kodu"])] = float(r["giren"])

    def _gun_komsu(g1: str, g2: str) -> bool:
        try:
            return abs((date.fromisoformat(g1) - date.fromisoformat(g2)).days) <= 1
        except Exception:  # noqa: BLE001
            return g1 == g2

    def _miktar_ortusur(a: float, b: float) -> bool:
        return (min(a, b) / max(a, b) >= 0.7) or (abs(a - b) <= 5)

    for (sid, gun_s, kod), sapma in depo_kayitsiz.items():
        if sapma >= -0.01 or (sid, gun_s, kod) in eslesen_depo:
            continue
        cikis = -sapma
        aday = None
        # önce KAYITLI girişler (teslim/sevk girişi başka şubede)
        for (sid2, gun2, kod2), giren in girisler.items():
            if sid2 == sid or kod2 != kod or giren <= 0.01:
                continue
            if _gun_komsu(gun_s, gun2) and _miktar_ortusur(cikis, giren):
                aday = {"sube": sube_ad.get(sid2, sid2), "gun": gun2,
                        "miktar": giren, "kayit": "kayıtlı giriş"}
                break
        # sonra KAYITSIZ girişler (karşı şubede zincir kopuğu POZİTİF)
        if aday is None:
            for (sid2, gun2, kod2), sap2 in depo_kayitsiz.items():
                if sid2 == sid or kod2 != kod or sap2 <= 0.01:
                    continue
                if _gun_komsu(gun_s, gun2) and _miktar_ortusur(cikis, sap2):
                    aday = {"sube": sube_ad.get(sid2, sid2), "gun": gun2,
                            "miktar": sap2, "kayit": "kayıtsız giriş"}
                    break
        if aday:
            hipotezler.append({
                "tip": "sube_capraz_teslim_adayi", "guven": "orta",
                "sube": sube_ad.get(sid, sid), "tarih": gun_s, "kalem": kod,
                "hipotez": (f"depodan kayıtsız −{cikis:.0f} çıkmış; {aday['gun']} günü "
                            f"{aday['sube']} şubesine aynı kalemden {aday['miktar']:.0f} "
                            f"girmiş ({aday['kayit']}) → muhtemelen AYNI teslimat, "
                            "veren ayağı kayıtsız (şubeler-arası sevk adayı — "
                            "toptancı teslim çakışması da olabilir, hüküm değil)"),
                "taniklar": {"kayitsiz_cikis": round(cikis, 1),
                             "karsi_sube": aday["sube"], "karsi_giris": aday["miktar"],
                             "karsi_gun": aday["gun"],
                             "karsi_kayit_turu": aday["kayit"]},
            })
            continue
        hipotezler.append({
            "tip": "depo_kayitsiz_cikis_karsiliksiz", "guven": "orta",
            "sube": sube_ad.get(sid, sid), "tarih": gun_s, "kalem": kod,
            "hipotez": (f"depodan kayıtsız −{cikis:.0f} çıkmış, bar tarafında ve "
                        "diğer şubelerin girişlerinde karşılığı görünmüyor → "
                        "bildirilmemiş fire / kayıp / kayıtsız sevk adayları"),
            "taniklar": {"depo_kayitsiz_cikis": round(cikis, 1)},
        })

    # 3) sevk net≠0 → yolda mı, kayıp mı?
    with db() as (_, cur):
        cur.execute(
            """SELECT kaynak_id, kalem_adi, MAX(zaman)::date::text AS tarih,
                      ROUND(SUM(COALESCE(miktar,0))::numeric,1) AS net
               FROM sube_depo_stok_hareket
               WHERE kaynak_tip = 'sevkiyat'
                 AND hareket_turu IN ('SEVK_CIKIS','SEVK_GIRIS','SEVK_UZLASMA')
                 AND zaman >= NOW() - (%s * INTERVAL '1 day')
               GROUP BY kaynak_id, kalem_adi
               HAVING SUM(COALESCE(miktar,0)) < -0.01
               ORDER BY MAX(zaman) DESC LIMIT 15""", (g,))
        for r in (dict(x) for x in cur.fetchall() or []):
            cur.execute(
                """SELECT COALESCE(SUM(sevk_adet),0) AS bekleyen
                   FROM stok_yolda
                   WHERE kabul_ts IS NULL AND durum NOT IN ('iptal')
                     AND UPPER(kalem_adi) = UPPER(%s)""", (r["kalem_adi"],))
            bekleyen = float(dict(cur.fetchone() or {}).get("bekleyen") or 0)
            eksik = -float(r["net"])
            if bekleyen >= eksik - 0.01:
                hipotezler.append({
                    "tip": "sevk_yolda", "guven": "yuksek",
                    "tarih": r["tarih"], "kalem": r["kalem_adi"],
                    "hipotez": (f"sevkte çıkan−giren farkı {eksik:.0f} — kabul "
                                f"bekleyen {bekleyen:.0f} adet yolda listesinde VAR "
                                "→ mal YOLDA, kabul bekliyor (kayıp değil)"),
                    "taniklar": {"sevk_net": float(r["net"]),
                                 "yolda_bekleyen": bekleyen},
                })
            else:
                hipotezler.append({
                    "tip": "sevk_karsiliksiz", "guven": "orta",
                    "tarih": r["tarih"], "kalem": r["kalem_adi"],
                    "hipotez": (f"sevkte {eksik:.0f} adet çıkmış; yolda listesinde "
                                f"yalnız {bekleyen:.0f} bekliyor → aradaki fark "
                                "kayıt/kayıp adayı"),
                    "taniklar": {"sevk_net": float(r["net"]),
                                 "yolda_bekleyen": bekleyen},
                })

    sira = {"yuksek": 0, "orta": 1, "dusuk": 2}
    hipotezler.sort(key=lambda x: (sira.get(x["guven"], 3), x.get("tarih") or ""))
    return {
        "kesit_gun": g,
        "hipotezler": hipotezler[:40],
        "not": "OTOMATİK HİPOTEZ — hüküm değil: iki ucun defteri örtüşünce güven "
               "yükselir (kayitsiz_urun_ac=iki tanık; sevk_yolda=yolda listesi "
               "teyitli; sube_capraz_teslim_adayi=karşı şubede ±1 gün miktar "
               "örtüşmesi). Hiçbir hipotez kaydı kapatmaz/aklamaz; karar insanın. "
               "Ürün-aç kancası (2026-07-09) sonrası kayitsiz_urun_ac hipotezleri "
               "doğal olarak azalmalı — azalmıyorsa kanca dışı bir akış var demektir.",
    }


# ── KART AYI DÖNGÜSÜ (F5, 2026-07-09 — sahip: 'çalışma noktası prof kurgu') ──
# Her kart ayın neresinde: kesim bekleniyor → EKSTRE BEKLENİYOR → yüklendi →
# ödeme bekliyor → ödendi / GECİKTİ. Salt-okur türetilmiş durum; tablo yok.

@router.get("/kart-dongu")
def kart_dongu():
    from finans_core import kesim_tarihi_hesapla, son_odeme_tarihi_hesapla
    bugun = date.today()
    satirlar = []
    with db() as (_, cur):
        cur.execute("""SELECT id, kart_adi, kesim_gunu, COALESCE(son_odeme_gunu,25) AS sog
                       FROM kartlar WHERE aktif=TRUE ORDER BY kart_adi""")
        kartlar = [dict(r) for r in cur.fetchall() or []]
        for k in kartlar:
            try:
                bu_ay = kesim_tarihi_hesapla(bugun.year, bugun.month, int(k["kesim_gunu"]))
                if bugun >= bu_ay:
                    son_kesim = bu_ay
                else:
                    oy, om = (bugun.year - 1, 12) if bugun.month == 1 else (bugun.year, bugun.month - 1)
                    son_kesim = kesim_tarihi_hesapla(oy, om, int(k["kesim_gunu"]))
                son_odeme = son_odeme_tarihi_hesapla(son_kesim, int(k["sog"]))
                cur.execute("""SELECT COALESCE(donem_borcu,0)::float AS borc,
                                      COALESCE(asgari_tutar,0)::float AS asgari,
                                      son_odeme_tarihi
                               FROM kart_ekstre_donem
                               WHERE kart_id=%s AND donem=DATE_TRUNC('month',%s::date) LIMIT 1""",
                            (k["id"], str(son_kesim)))
                snap = dict(cur.fetchone() or {})
                # SNAPSHOT'taki GERÇEK son ödeme tarihi hesaplananı ezer
                # (Axess vakası: hesap 20 dedi, ekstre 16 diyor — banka haklı)
                if snap.get("son_odeme_tarihi"):
                    son_odeme = snap["son_odeme_tarihi"]
                s = {"kart": k["kart_adi"], "kesim": str(son_kesim), "son_odeme": str(son_odeme)}
                if not snap:
                    s["durum"] = "ekstre_bekleniyor"
                    s["gun"] = (bugun - son_kesim).days
                    s["mesaj"] = (f"kesim {son_kesim} — ekstre {s['gun']} gündür yüklenmedi")
                else:
                    # DEFTER = TEK GERÇEK (2026-07-10 v2, Axess vakası): plan damgasına
                    # DEĞİL kart defterine bakılır — bu dönemin penceresinde
                    # (kesim → son ödeme] fiilen yapılan ÖDEME toplamı belirleyicidir.
                    # (Plan 'odendi' damgası işaretleme GÜNÜNÜ taşıyabiliyor; eski
                    # dönemin ödemesi yeni döneme sızıyordu.)
                    borc = float(snap.get("borc") or 0)
                    asgari = float(snap.get("asgari") or 0) or borc
                    cur.execute("""SELECT COALESCE(SUM(tutar),0)::float AS o
                                   FROM kart_hareketleri
                                   WHERE kart_id=%s AND durum='aktif' AND islem_turu='ODEME'
                                     AND tarih > %s::date AND tarih <= %s::date""",
                                (k["id"], str(son_kesim), str(son_odeme)))
                    odenen = float(dict(cur.fetchone() or {}).get("o") or 0)
                    # Sahip düzeltmesi (2026-07-14, Fethi Garanti vakası): asgari/tam
                    # ödendi VE son ödeme tarihi GEÇTİYSE dönem KAPANMIŞTIR — kart
                    # 'ödendi'de oturmaz, yeni döngüye geçer: devreden kalan yeni
                    # borcun çekirdeği olur, durum 'ekstre_bekleniyor' olur.
                    donem_kapandi = bugun > son_odeme
                    if bugun < bu_ay:
                        siradaki_kesim = bu_ay
                    else:
                        sy, sm = (bugun.year + 1, 1) if bugun.month == 12 else (bugun.year, bugun.month + 1)
                        siradaki_kesim = kesim_tarihi_hesapla(sy, sm, int(k["kesim_gunu"]))
                    if borc > 0 and odenen >= borc - 0.01:
                        if donem_kapandi:
                            s["durum"] = "ekstre_bekleniyor"
                            s["mesaj"] = (f"dönem kapandı — TAM ödendi ({odenen}); "
                                          f"yeni ekstre {siradaki_kesim} kesiminde bekleniyor")
                        else:
                            s["durum"] = "odendi"
                            s["mesaj"] = f"bu dönem TAM ödendi ({odenen})"
                    elif asgari > 0 and odenen >= asgari * 0.999:
                        s["devreden_kalan"] = round(borc - odenen, 2)
                        if donem_kapandi:
                            s["durum"] = "ekstre_bekleniyor"
                            s["mesaj"] = (f"dönem kapandı — asgari ödendi ({odenen}); "
                                          f"kalan {s['devreden_kalan']} YENİ borca "
                                          f"devretti, yeni ekstre {siradaki_kesim} "
                                          "kesiminde bekleniyor")
                        else:
                            s["durum"] = "odendi"
                            s["mesaj"] = (f"asgari ödendi ({odenen}) — kalan "
                                          f"{s['devreden_kalan']} sonraki döneme devreder")
                    elif bugun <= son_odeme:
                        s["durum"] = "odeme_bekliyor"
                        s["gun"] = (son_odeme - bugun).days
                        s["mesaj"] = (f"son ödemeye {s['gun']} gün (borç {borc}, asgari {asgari}"
                                      + (f"; şu ana dek {odenen} ödendi" if odenen > 0 else "") + ")")
                    else:
                        s["durum"] = "gecikti"
                        s["gun"] = (bugun - son_odeme).days
                        s["mesaj"] = (f"son ödeme {s['gun']} gün GEÇTİ (borç {borc}"
                                      + (f"; yalnız {odenen} ödendi" if odenen > 0 else ", ödeme izi yok") + ")")
                # sıradaki kesim bilgisi (bilgilendirici)
                if bugun < bu_ay:
                    s["siradaki_kesime_gun"] = (bu_ay - bugun).days
                satirlar.append(s)
            except Exception as e:  # noqa: BLE001
                logger.warning("kart dongu %s: %s", k.get("kart_adi"), str(e)[:60])
    sayilar = {}
    for s in satirlar:
        sayilar[s["durum"]] = sayilar.get(s["durum"], 0) + 1
    return {"bugun": str(bugun), "kartlar": satirlar, "ozet": sayilar,
            "not": "Türetilmiş döngü durumu — kesim/son ödeme kart tanımından, "
                   "ekstre snapshot + plan durumundan. Hüküm yok; hatırlatma amaçlı."}


@router.get("/kart-gelecek-ekstre")
def kart_gelecek_ekstre(taze: int = 0):
    """K2-B (2026-07-10) — GELECEK EKSTRE TAHMİNİ: banka kesmeden önce kart başına
    'sıradaki kesimde ~X borç oluşuyor, asgari ~Y' (bilinen harcama + taksit payı +
    devreden anapara/faiz senaryosu; senaryo=asgari ödenir). Motor: finans_core.
    kart_ekstre_forecast (bugüne dek hiçbir pencereye bağlı değildi). Kasa kıyası
    KOD hesabıdır (kural 15). Gece ön-hesap cache'i; taze=1 canlı zorlar."""
    if not taze:
        _c = _agir_oku("kart_gelecek_ekstre")
        if _c is not None:
            return _c
    from finans_core import kart_ekstre_forecast
    satirlar = []
    with db() as (_, cur):
        cur.execute("SELECT id, kart_adi FROM kartlar WHERE aktif=TRUE ORDER BY kart_adi")
        kartlar = [dict(r) for r in cur.fetchall() or []]
        for k in kartlar:
            try:
                fc = kart_ekstre_forecast(cur, k["id"], ay_sayisi=2,
                                          asgari_senaryosu="odenir") or []
                acik = next((x for x in fc if x.get("durum") in ("acik", "gelecek")), None)
                if not acik:
                    continue
                satirlar.append({
                    "kart": k["kart_adi"],
                    "donem": acik.get("ay"),
                    "kesim_tarihi": str(acik.get("kesim_tarihi") or ""),
                    "son_odeme_tarihi": str(acik.get("son_odeme_tarihi") or ""),
                    "su_ana_kadar_harcama": float(acik.get("tek_cekim_bilinen") or 0),
                    "taksit_payi": float(acik.get("taksit_payi") or 0),
                    "devreden_anapara": float(acik.get("devreden_anapara") or 0),
                    "devreden_faiz": float(acik.get("devreden_faiz") or 0),
                    "tahmini_ekstre": float(acik.get("ekstre_toplam") or 0),
                    "tahmini_asgari": float(acik.get("asgari_tahmini") or 0),
                })
            except Exception as e:  # noqa: BLE001
                logger.warning("gelecek ekstre %s: %s", k.get("kart_adi"), str(e)[:60])
    t_ekstre = round(sum(s["tahmini_ekstre"] for s in satirlar), 2)
    t_asgari = round(sum(s["tahmini_asgari"] for s in satirlar), 2)
    kasa_kiyas = None
    try:
        kasa = (nakit_ufku(gun=7) or {}).get("kasa_simdiki")
        if kasa is not None:
            kasa_kiyas = {"kasa": kasa,
                          "tum_ekstreler_fark": round(float(kasa) - t_ekstre, 2),
                          "asgariler_fark": round(float(kasa) - t_asgari, 2)}
    except Exception:  # noqa: BLE001
        pass
    sonuc = {
        "kartlar": satirlar,
        "toplam": {"tahmini_ekstre": t_ekstre, "tahmini_asgari": t_asgari},
        "kasa_kiyas": kasa_kiyas,
        "not": "TAHMİN — banka ekstresi değil: bilinen harcamalar + taksit sözleşmeleri "
               "+ 'asgari ödenir' faiz senaryosu (KKDF+BSMV dahil). Yeni harcama "
               "yapıldıkça tahmin büyür; gerçek ekstre yüklenince yerini ona bırakır.",
    }
    return sonuc


@router.get("/kart-anomali")
def kart_harcama_anomali(gun: int = 7):
    """K2-E — KART HARCAMA ANOMALİSİ (öneri-only): son N günde
    (a) YENİ SATICI: son 90 günde hiç görülmemiş satıcıdan ≥2.000 TL harcama,
    (b) BÜYÜK TUTAR: kartın 90 günlük harcama p95'inin 1.5 katını aşan (≥5.000).
    Şahsi hariç. Hüküm yok — dikkat listesi."""
    gn = max(3, min(30, int(gun or 7)))
    adaylar = []
    try:
        from main import _satici_anahtar
    except Exception:  # noqa: BLE001
        def _satici_anahtar(x):  # type: ignore
            return (str(x or "").strip().split() or [""])[0].lower()
    with db() as (_, cur):
        cur.execute(
            """SELECT h.tarih::text AS tarih, k.kart_adi,
                      ROUND(h.tutar::numeric,2) AS tutar,
                      LEFT(COALESCE(h.aciklama,''),60) AS aciklama, h.kart_id
               FROM kart_hareketleri h JOIN kartlar k ON k.id = h.kart_id
               WHERE h.islem_turu='HARCAMA' AND h.durum='aktif'
                 AND COALESCE(h.harcama_tipi,'belirsiz') <> 'sahsi'
                 AND h.tarih >= CURRENT_DATE - %s
               ORDER BY h.tutar DESC LIMIT 200""", (gn,))
        yeniler = [dict(r) for r in cur.fetchall() or []]
        cur.execute(
            """SELECT COALESCE(aciklama,'') AS a FROM kart_hareketleri
               WHERE islem_turu='HARCAMA' AND durum='aktif'
                 AND tarih >= CURRENT_DATE - 90 AND tarih < CURRENT_DATE - %s""", (gn,))
        eski_saticilar = {_satici_anahtar(dict(r)["a"]) for r in cur.fetchall() or []}
        eski_saticilar.discard("")
        cur.execute(
            """SELECT kart_id,
                      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY tutar) AS p95
               FROM kart_hareketleri
               WHERE islem_turu='HARCAMA' AND durum='aktif'
                 AND tarih >= CURRENT_DATE - 90
               GROUP BY kart_id""")
        p95 = {dict(r)["kart_id"]: float(dict(r)["p95"] or 0) for r in cur.fetchall() or []}
    for h in yeniler:
        tut = float(h["tutar"])
        sat = _satici_anahtar(h["aciklama"])
        nedenler = []
        if sat and sat not in eski_saticilar and tut >= 2000:
            nedenler.append("yeni satıcı")
        esik = max(5000.0, (p95.get(h["kart_id"]) or 0) * 1.5)
        if tut >= esik and esik > 0:
            nedenler.append(f"büyük tutar (90g p95×1.5={esik:,.0f} üstü)")
        if nedenler:
            adaylar.append({"tarih": h["tarih"], "kart": h["kart_adi"],
                            "tutar": tut, "aciklama": h["aciklama"],
                            "neden": " + ".join(nedenler)})
    return {"kesit_gun": gn, "aday_sayisi": len(adaylar), "adaylar": adaylar[:20],
            "not": "ADAY dikkat listesi — hüküm yok. Yeni satıcı meşru olabilir; "
                   "büyük tutar planlı alım olabilir. Karar sahibinin."}


@router.get("/kart-abonelik")
def kart_abonelik_yuku():
    """K2-E — ABONELİK YÜKÜ: son 4 ayda ≥3 farklı ayda görülen, tutar sapması
    ≤%15 olan satıcılar = tekrarlayan yük adayı; aylık toplam abonelik maliyeti."""
    try:
        from main import _satici_anahtar
    except Exception:  # noqa: BLE001
        def _satici_anahtar(x):  # type: ignore
            return (str(x or "").strip().split() or [""])[0].lower()
    with db() as (_, cur):
        cur.execute(
            """SELECT COALESCE(aciklama,'') AS a, TO_CHAR(tarih,'YYYY-MM') AS ay,
                      tutar::float AS tutar
               FROM kart_hareketleri
               WHERE islem_turu='HARCAMA' AND durum='aktif'
                 AND tarih >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months'"""
        )
        gruplar: dict = {}
        for r in [dict(x) for x in cur.fetchall() or []]:
            sat = _satici_anahtar(r["a"])
            if not sat:
                continue
            gruplar.setdefault(sat, []).append(r)
    abonelikler = []
    for sat, rows in gruplar.items():
        aylar = {r["ay"] for r in rows}
        if len(aylar) < 3:
            continue
        tutarlar = [r["tutar"] for r in rows]
        ort = sum(tutarlar) / len(tutarlar)
        if ort <= 0:
            continue
        sapma = max(abs(t - ort) for t in tutarlar) / ort
        if sapma <= 0.15:
            abonelikler.append({"satici": sat, "ay_sayisi": len(aylar),
                                "ortalama_aylik": round(ort, 2),
                                "ornek_aciklama": rows[0]["a"][:50]})
    abonelikler.sort(key=lambda x: -x["ortalama_aylik"])
    return {"abonelik_adaylari": abonelikler[:20],
            "aylik_toplam_yuk": round(sum(a["ortalama_aylik"] for a in abonelikler), 2),
            "not": "Son 4 ayda ≥3 ayda tekrarlayan, tutarı ~sabit (≤%15 sapma) satıcılar. "
                   "İptal edilebilir abonelik mi, sabit yükümlülük mü — karar sahibinin."}


def _kart_asgari_tuzagi() -> list:
    """K2-C — ASGARİ TUZAĞI adayları: son 3 ekstre döneminde borç erimiyor
    (her dönem >= öncekinin %95'i) VE bankanın yazdığı dönem ödemesi asgari
    civarında (<= asgari × 1.5) → 'hep asgari, borç dönüyor' gözlemi.
    Kaynak: kart_ekstre_donem (banka gerçeği). Hüküm yok — aday."""
    adaylar = []
    try:
        with db() as (_, cur):
            cur.execute(
                """SELECT k.kart_adi, d.donem::text AS donem,
                          COALESCE(d.donem_borcu,0)::float AS borc,
                          COALESCE(d.asgari_tutar,0)::float AS asgari,
                          COALESCE(d.donem_odeme,0)::float AS odeme
                   FROM kart_ekstre_donem d JOIN kartlar k ON k.id = d.kart_id
                   WHERE k.aktif = TRUE
                   ORDER BY k.kart_adi, d.donem DESC""")
            gruplar = {}
            for r in [dict(x) for x in cur.fetchall() or []]:
                gruplar.setdefault(r["kart_adi"], []).append(r)
        for ad, ds in gruplar.items():
            son3 = ds[:3]
            if len(son3) < 3:
                continue
            borc_erimiyor = all(son3[i]["borc"] >= son3[i + 1]["borc"] * 0.95
                                for i in range(2))
            asgari_civari = all(0 < d["odeme"] <= max(d["asgari"], 1) * 1.5
                                for d in son3 if d["asgari"] > 0)
            odeme_var = all(d["odeme"] > 0 for d in son3)
            if borc_erimiyor and asgari_civari and odeme_var:
                adaylar.append({"kart": ad, "son_borc": son3[0]["borc"],
                                "donemler": [d["donem"][:7] for d in son3],
                                "gozlem": "3 dönemdir asgari civarı ödeme, borç erimiyor"})
    except Exception as e:  # noqa: BLE001
        logger.warning("asgari tuzagi: %s", str(e)[:80])
    return adaylar


def gece_kart_dongu_izleme() -> dict:
    """Gece: ekstre bekleyen / geciken kartlar + LİMİT doluluk uyarıları (K2-A)
    omurgaya olay olarak düşer (hatırlatma + beyin + WhatsApp görür). Hata-yutar."""
    ozet = {"dongu_olay": 0, "limit_olay": 0, "olaylar": []}
    try:
        d = kart_dongu()
        from duyu_omurga import duyu_olay_yaz
        for s in d.get("kartlar") or []:
            if s.get("durum") in ("ekstre_bekleniyor", "gecikti"):
                duyu_olay_yaz(
                    "kart_dongu", f"finans.kart.{s['durum']}",
                    f"{s['kart']}:{s.get('kesim')}",
                    entity_scope="kart", entity_id=s["kart"],
                    signal_name=("Ekstre bekleniyor" if s["durum"] == "ekstre_bekleniyor"
                                 else "Kart ödemesi gecikti"),
                    payload=s,
                )
                ozet["dongu_olay"] += 1
                ozet["olaylar"].append(f"{s['durum']}: {s['kart']}")
        # K2-A — LİMİT DOLULUK OLAYI (%75 uyarı / %90 kritik), KANONİK kaynaktan
        # (anlik_borc + gelecek taksit) / limit. Ay-anahtarlı source_ref → aynı ay
        # tek kayıt (omurga idempotent), her gece spam üretmez.
        try:
            from main import kartlar_listele
            _kl = kartlar_listele()
            _kl = _kl if isinstance(_kl, list) else (_kl or {}).get("kartlar") or []
            for k in _kl:
                lt = float(k.get("limit_tutar") or 0)
                borc = (float(k.get("anlik_borc") or 0)
                        + float(k.get("gelecek_taksit_anapara") or 0))
                if lt <= 0:
                    continue
                dol = borc / lt
                if dol >= 0.75:
                    seviye = "kritik" if dol >= 0.90 else "uyari"
                    duyu_olay_yaz(
                        "kart_dongu", "finans.kart.limit_uyarisi",
                        f"{k.get('kart_adi')}:{date.today().strftime('%Y-%m')}:{seviye}",
                        entity_scope="kart", entity_id=str(k.get("kart_adi")),
                        signal_name=("Limit KRİTİK (%90+)" if seviye == "kritik"
                                     else "Limit uyarısı (%75+)"),
                        payload={"kart": k.get("kart_adi"), "limit": lt,
                                 "borc_taksitli": round(borc, 2),
                                 "doluluk_yuzde": round(dol * 100, 1)},
                    )
                    ozet["limit_olay"] += 1
                    ozet["olaylar"].append(
                        f"limit %{dol*100:.0f}: {k.get('kart_adi')}")
        except Exception as e:  # noqa: BLE001
            logger.warning("limit olaylari: %s", str(e)[:80])
        # K2-C — asgari tuzağı adayları (ay-anahtarlı, idempotent)
        try:
            for a in _kart_asgari_tuzagi():
                duyu_olay_yaz(
                    "kart_dongu", "finans.kart.asgari_tuzagi",
                    f"{a['kart']}:{date.today().strftime('%Y-%m')}",
                    entity_scope="kart", entity_id=a["kart"],
                    signal_name="Asgari döngüsü adayı (borç erimiyor)",
                    payload=a)
                ozet["olaylar"].append(f"asgari_tuzagi: {a['kart']}")
                ozet["limit_olay"] += 0  # sayaçlar ayrı kalsın
        except Exception as e:  # noqa: BLE001
            logger.warning("asgari tuzagi olay: %s", str(e)[:80])
        # K2-E — harcama anomalisi adayları (gün+tutar anahtarlı, idempotent)
        try:
            an = kart_harcama_anomali(gun=3)
            for a in (an.get("adaylar") or [])[:6]:
                duyu_olay_yaz(
                    "kart_dongu", "finans.kart.anomali_harcama",
                    f"{a['kart']}:{a['tarih']}:{a['tutar']}",
                    entity_scope="kart", entity_id=a["kart"],
                    signal_name="Kart harcama anomalisi (aday)",
                    payload=a)
                ozet["olaylar"].append(f"anomali: {a['kart']} {a['tutar']}")
        except Exception as e:  # noqa: BLE001
            logger.warning("anomali olay: %s", str(e)[:80])
    except Exception as e:  # noqa: BLE001
        logger.warning("gece kart dongu: %s", str(e)[:100])
    return ozet


@router.post("/kart-dongu-izle")
def kart_dongu_izle_uc():
    """Elle tetik (test): gece kart izleme turunu koşar, yazılan olayları döner."""
    return gece_kart_dongu_izleme()


# ── AĞIR UÇ ÖN-HESAP (GÖREV #56, 2026-07-09 — pool zehirlenmesi P1) ──
# Paralel ağır denetim çağrıları (tutarsızlık+denge+hipotez+reçete+değirmen)
# bağlantı havuzunu tüketip /api/panel'i 500'e düşürmüştü. ÇÖZÜM: gece SIRALI
# ön-hesap → gündüz cache'ten servis. taze=1 parametresi canlı hesabı zorlar.
# Cache YAZIMI yalnız ön-hesapta yapılır (gündüz cache-miss canlı hesaplar ama
# yazmaz — yarış ve çift-yazım yok).

def _agir_ensure(cur) -> None:
    cur.execute("""
        CREATE TABLE IF NOT EXISTS duyu_agir_onhesap (
            uc TEXT NOT NULL,
            gun DATE NOT NULL DEFAULT CURRENT_DATE,
            veri JSONB NOT NULL,
            olusturma TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (uc, gun)
        );
    """)


def _agir_oku(uc: str, max_saat: int = 26):
    """Son ön-hesap sonucu (26 saatten eskiyse None → canlı hesaba düşülür)."""
    try:
        with db() as (_, cur):
            _agir_ensure(cur)
            cur.execute(
                """SELECT veri, olusturma::text AS z FROM duyu_agir_onhesap
                   WHERE uc = %s AND olusturma > NOW() - (%s * INTERVAL '1 hour')
                   ORDER BY olusturma DESC LIMIT 1""", (uc, max_saat))
            r = cur.fetchone()
        if not r:
            return None
        rr = dict(r)
        v = rr["veri"]
        if isinstance(v, dict):
            v["_onhesap"] = {"hesap_zamani": rr["z"],
                             "not": "gece ön-hesap sonucu (pool koruması) — "
                                    "canlı hesap için taze=1"}
        return v
    except Exception as e:  # noqa: BLE001
        logger.warning("agir onhesap okuma %s: %s", uc, str(e)[:80])
        return None


def _agir_yaz(uc: str, veri) -> None:
    try:
        import json as _json
        with db() as (conn, cur):
            _agir_ensure(cur)
            cur.execute(
                """INSERT INTO duyu_agir_onhesap (uc, gun, veri)
                   VALUES (%s, CURRENT_DATE, %s::jsonb)
                   ON CONFLICT (uc, gun) DO UPDATE
                   SET veri = EXCLUDED.veri, olusturma = NOW()""",
                (uc, _json.dumps(veri, ensure_ascii=False, default=str)))
            conn.commit()
    except Exception as e:  # noqa: BLE001
        logger.warning("agir onhesap yazma %s: %s", uc, str(e)[:80])


def gece_agir_onhesap() -> dict:
    """Ağır uçları SIRALI hesaplar ve cache'e yazar (gece zinciri + elle tetik).
    Bir uç çökse diğerleri yaşar; sıralılık pool dostudur."""
    isler = [
        ("tutarsizlik_ozeti", lambda: tutarsizlik_ozeti(gun=7, taze=1)),
        ("stok_denge", lambda: stok_denge(gun=7, taze=1)),
        ("stok_capraz_hipotez", lambda: stok_capraz_hipotez(gun=7, taze=1)),
        ("kart_gelecek_ekstre", lambda: kart_gelecek_ekstre(taze=1)),
    ]
    try:
        from recete_api import recete_kontrol as _rk, degirmen_kiyas as _dk
        isler.append(("recete_kontrol", lambda: _rk(gun=7, taze=1)))
        isler.append(("degirmen_kiyas", lambda: _dk(gun=7, taze=1)))
    except Exception as e:  # noqa: BLE001
        logger.warning("agir onhesap recete iceri alinamadi: %s", str(e)[:80])
    tamam, hatalar = [], []
    for ad, fn in isler:
        try:
            _agir_yaz(ad, fn())
            tamam.append(ad)
        except Exception as e:  # noqa: BLE001
            hatalar.append(f"{ad}: {str(e)[:60]}")
            logger.warning("agir onhesap %s: %s", ad, str(e)[:100])
    return {"ok": not hatalar, "hesaplanan": tamam, "hatalar": hatalar}


@router.post("/agir-onhesap")
def agir_onhesap_uc():
    """Elle tetikleme (ilk doldurma / test). Normalde gece zinciri koşar."""
    return gece_agir_onhesap()


# ── BAĞ DEFTERİ (2026-07-09, sahip talimatı: 'her konuda bağ kurarak konuşmayı
# öğret — konuya özel değil'). GENEL İLKE: bağları LLM değil KOD kurar; her alanın
# hazır ilişki cümleleri gece derlenir, beyin HER soruda bu defteri görür ve
# AKTARIR (hesaplamaz). Yeni alan eklemek = _BAG_KAYNAKLARI'na bir üretici eklemek.

def _bag_ensure(cur) -> None:
    cur.execute("""
        CREATE TABLE IF NOT EXISTS bag_defteri (
            gun DATE PRIMARY KEY,
            veri JSONB NOT NULL,
            olusturma TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)


def _bag_stok_hipotez() -> List[dict]:
    """Stok↔satış↔sevk bağları (hipotez motoru — cümleler zaten hazır)."""
    r = stok_capraz_hipotez(gun=7)
    return [{"alanlar": ["stok", "satis", "sevk"], "tarih": h.get("tarih"),
             "guven": h.get("guven"),
             "cumle": f"{h.get('sube') or ''} {h.get('kalem') or ''}: {h['hipotez']}".strip()}
            for h in (r.get("hipotezler") or [])[:12]]


def _bag_tutarsizlik() -> List[dict]:
    """İki-kaynak uyuşmazlık bağları (6 çapraz kontrol)."""
    r = tutarsizlik_ozeti(gun=7)
    out = []
    for t in (r.get("tutarsizliklar") or [])[:12]:
        out.append({"alanlar": ["tutarsizlik"], "tarih": t.get("tarih"),
                    "guven": "gozlem",
                    "cumle": (f"{t.get('sube') or ''} {t['konu']}: "
                              f"{t['kaynak_a']}={t.get('deger_a')} ↔ "
                              f"{t['kaynak_b']}={t.get('deger_b')}"
                              + (f" (fark {t.get('fark')})" if t.get('fark') is not None else "")
                              + f" — {t['beklenti']}").strip()})
    return out


def _bag_recete() -> List[dict]:
    """Satış↔tüketim bağları (reçete kıyası haftalık malzeme toplamları)."""
    from recete_api import recete_kontrol
    r = recete_kontrol(gun=7)
    toplam: Dict[str, dict] = {}
    for k in (r.get("kiyas") or []):
        if k.get("fark") is None:
            continue
        o = toplam.setdefault(k["malzeme"], {"b": 0.0, "g": 0.0, "birim": k["birim"]})
        o["b"] += k["beklenen_miktar"]
        o["g"] += k.get("gercek_miktar") or 0
    out = []
    for m, o in toplam.items():
        if not o["b"]:
            continue
        fy = round((o["g"] - o["b"]) / o["b"] * 100, 1)
        out.append({"alanlar": ["satis", "tuketim"], "tarih": None, "guven": "hesap",
                    "cumle": (f"{m} (7 gün): satıştan beklenen {round(o['b'],1)} {o['birim']}, "
                              f"gerçek tüketim {round(o['g'],1)} {o['birim']} — fark %{fy} "
                              "(± fire/israf payı; hazır hesap)")})
    return out


def _bag_degirmen() -> List[dict]:
    """Makine↔satış bağı (değirmen sayacı)."""
    from recete_api import degirmen_kiyas
    r = degirmen_kiyas(gun=7)
    out = []
    for k in (r.get("gun_kiyasi") or [])[:7]:
        if k.get("fark_yuzde") is None:
            continue
        out.append({"alanlar": ["makine", "satis"], "tarih": k["tarih"], "guven": "hesap",
                    "cumle": (f"değirmen {k['tarih']}: makine {k['makine_gram']} g çekti, "
                              f"satış beklentisi {k.get('beklenen_gram')} g — fark "
                              f"{k.get('fark_gram')} g (%{k['fark_yuzde']}; çöp-shot payı içerir)")})
    return out


def _bag_finans() -> List[dict]:
    """Kasa↔ödeme bağı (nakit ufku — tek cümle)."""
    r = nakit_ufku(gun=7)
    proj = r.get("gun_gun_projeksiyon") or []
    eksi = [p for p in proj if (p.get("beklenen_kasa_orta") or 0) < 0]
    kasa = r.get("kasa_simdiki")
    if eksi:
        ilk = eksi[0]
        return [{"alanlar": ["kasa", "odeme"], "tarih": ilk.get("tarih"), "guven": "hesap",
                 "cumle": (f"kasa {kasa} iken ödeme takvimiyle {ilk.get('tarih')} günü "
                           f"beklenen kasa {ilk.get('beklenen_kasa_orta')} (EKSİ) — kasa↔ödeme "
                           "bağı gergin (hazır projeksiyon)")}]
    return [{"alanlar": ["kasa", "odeme"], "tarih": None, "guven": "hesap",
             "cumle": f"kasa {kasa}; 7 günlük ödeme takviminde eksiye düşüş görünmüyor (hazır projeksiyon)"}]


def _bag_sinaps() -> List[dict]:
    """Duyu-birlikteliği bağları (aynı şube-günde çoklu sinyal)."""
    from duyu_sinaps import sinapsler
    r = sinapsler(gun=7)
    out = []
    for tip in ("kompozit", "zincir", "kase"):
        for o in (r.get(tip) or [])[:4]:
            ad = o.get("signal_name") or o.get("olay_tipi") or tip
            out.append({"alanlar": ["duyu", "birliktelik"], "tarih": str(o.get("occurred_at") or "")[:10],
                        "guven": "gozlem",
                        "cumle": f"sinaps ({tip}): {ad} — {str(o.get('entity_id') or '')[:40]}"})
    return out


def _bag_odeme() -> List[dict]:
    """Tedarikçi borç↔ödeme bağı (mutabakat aday eşleştirmeleri — cümleler hazır)."""
    r = odeme_mutabakat(gun=45)
    out = []
    for e in (r.get("eslesen") or [])[:5]:
        out.append({"alanlar": ["borc", "odeme"], "tarih": e.get("pencere_bit"),
                    "guven": e.get("guven"),
                    "cumle": (f"{e.get('tedarikci_ad')}: bakiye {e.get('dusus_tutar')} düşmüş, "
                              f"kayıtlarımızda {len(e.get('odemeler') or [])} ödeme karşılığı VAR "
                              f"(aday eşleşme, güven {e.get('guven')})")})
    for d in (r.get("dusus_var_odeme_kaydi_yok") or [])[:5]:
        out.append({"alanlar": ["borc", "odeme"], "tarih": d.get("pencere_bit"), "guven": "gozlem",
                    "cumle": (f"{d.get('tedarikci_ad')}: bakiye {d.get('dusus_tutar')} düşmüş ama "
                              "kayıtlarımızda ödeme karşılığı GÖRÜNMÜYOR (iade/iskonto/mahsup da "
                              "düşürür — hüküm değil, gözlem)")})
    for o in (r.get("odeme_var_dusus_gorulmedi") or [])[:3]:
        out.append({"alanlar": ["borc", "odeme"], "tarih": o.get("tarih"), "guven": "gozlem",
                    "cumle": (f"{o.get('tedarikci_ad')}: {o.get('tutar')} ödeme kaydımız var ama "
                              "fatura zincirinde bakiye düşüşü görülmedi (zincir eksik olabilir)")})
    return out


def _bag_maas_avans() -> List[dict]:
    """Maaş↔avans bağı (KİMLİKSİZ toplamlar — kişi adı asla girmez)."""
    r = maas_avans_ozet()
    out = []
    donemler = r.get("maas_donemleri") or []
    if donemler:
        d = donemler[0]
        out.append({"alanlar": ["maas", "avans"], "tarih": None, "guven": "hesap",
                    "cumle": (f"maaş dönemi {d.get('yil')}-{d.get('ay')}: {d.get('kisi_sayisi')} kişi, "
                              f"toplam net {d.get('toplam_net')} — avans mahsupları bu dönemin "
                              "planından otomatik düşer (hazır bağ)")})
    for a in (r.get("avans_durumlari") or [])[:4]:
        out.append({"alanlar": ["maas", "avans"], "tarih": None, "guven": "hesap",
                    "cumle": (f"avans durumu '{a.get('durum')}': {a.get('adet')} kayıt, "
                              f"toplam {a.get('toplam')} — maaş↔avans mahsup zinciri")})
    return out


def _bag_kart() -> List[dict]:
    """Kart ekstre↔ödeme planı bağı (yaklaşık — banka canlı verisi değil)."""
    r = kart_pozisyon()
    out = []
    try:
        dongu = kart_dongu()
        ft = r.get("aylik_odenen_faiz_trendi") or []
        if len(ft) >= 2 and (ft[0].get("odenen_faiz") or 0) > 0:
            yon = ("ARTIYOR" if ft[0]["odenen_faiz"] > ft[1]["odenen_faiz"]
                   else "azalıyor")
            out.append({"alanlar": ["kart", "faiz"], "tarih": None, "guven": "hesap",
                        "cumle": (f"kartlara ödenen faiz: {ft[0]['ay']} ayında "
                                  f"{ft[0]['odenen_faiz']}, önceki ay {ft[1]['odenen_faiz']} "
                                  f"— faiz maliyeti {yon} (hazır trend)")})
        bl = r.get("belirsiz_harcama_30g") or {}
        if (bl.get("adet") or 0) > 0:
            out.append({"alanlar": ["kart", "gider"], "tarih": None, "guven": "gozlem",
                        "cumle": (f"kartlarda sınıflandırılmamış (belirsiz) {bl['adet']} "
                                  f"harcama var, 30 günlük toplamı {bl['toplam_30g']} — "
                                  "işletme/şahsi ayrımı yapılana dek P&L'e gider "
                                  "olarak giriyor (sınıflandırma ödevi)")})
        try:
            ge = kart_gelecek_ekstre()
            gt = (ge.get("toplam") or {})
            kk = ge.get("kasa_kiyas") or {}
            if gt.get("tahmini_ekstre"):
                cum2 = (f"sıradaki kesimlerde TAHMİNİ toplam ekstre {gt['tahmini_ekstre']} "
                        f"(asgariler toplamı {gt['tahmini_asgari']})")
                if kk.get("kasa") is not None:
                    cum2 += (f"; kasa {kk['kasa']} → asgarilere göre fark "
                             f"{kk['asgariler_fark']} (hazır hesap — tahmin, ekstre değil)")
                out.append({"alanlar": ["kart", "gelecek", "kasa"], "tarih": None,
                            "guven": "hesap", "cumle": cum2})
        except Exception as e:  # noqa: BLE001
            logger.warning("bag gelecek ekstre: %s", str(e)[:60])
        try:
            tz = _kart_asgari_tuzagi()
            if tz:
                out.append({"alanlar": ["kart", "faiz"], "tarih": None, "guven": "gozlem",
                            "cumle": (f"{len(tz)} kart asgari döngüsünde görünüyor "
                                      f"({', '.join(a['kart'][:18] for a in tz[:3])}) — "
                                      "3 dönemdir asgari civarı ödeme, borç erimiyor; "
                                      "faiz yükü büyüyor (aday gözlem)")})
        except Exception:  # noqa: BLE001
            pass
        try:
            an = kart_harcama_anomali(gun=7)
            if an.get("aday_sayisi"):
                ilk = (an.get("adaylar") or [{}])[0]
                out.append({"alanlar": ["kart", "anomali"], "tarih": ilk.get("tarih"),
                            "guven": "dusuk",
                            "cumle": (f"son 7 günde {an['aday_sayisi']} dikkat çeken kart "
                                      f"harcaması var (örn. {ilk.get('kart','')[:18]} "
                                      f"{ilk.get('tutar')} — {ilk.get('neden','')}) — aday "
                                      "liste, hüküm değil")})
            ab = kart_abonelik_yuku()
            if ab.get("aylik_toplam_yuk"):
                out.append({"alanlar": ["kart", "abonelik"], "tarih": None, "guven": "hesap",
                            "cumle": (f"kartlarda tekrarlayan (abonelik benzeri) aylık yük "
                                      f"~{ab['aylik_toplam_yuk']} "
                                      f"({len(ab.get('abonelik_adaylari') or [])} kalem) — "
                                      "iptal edilebilirler gözden geçirilebilir")})
        except Exception as e:  # noqa: BLE001
            logger.warning("bag anomali/abonelik: %s", str(e)[:60])
        devirli = [s for s in (dongu.get("kartlar") or []) if s.get("devreden_kalan")]
        if devirli:
            t_devir = round(sum(float(s["devreden_kalan"]) for s in devirli), 2)
            out.append({"alanlar": ["kart", "devir", "faiz"], "tarih": None, "guven": "hesap",
                        "cumle": (f"{len(devirli)} kart bu dönem yalnız ASGARİ ödedi; "
                                  f"sonraki döneme devreden toplam {t_devir} — bu tutara "
                                  "faiz işleyecek (hazır hesap, kart döngüsünden)")})
        gec = [s for s in (dongu.get("kartlar") or []) if s.get("durum") == "gecikti"]
        if gec:
            en_uzun = max(int(s.get("gun") or 0) for s in gec)
            out.append({"alanlar": ["kart", "gecikme"], "tarih": None, "guven": "gozlem",
                        "cumle": (f"{len(gec)} kartın son ödeme tarihi GEÇTİ (en uzunu "
                                  f"{en_uzun} gün) — gecikme faizi işliyor olabilir; "
                                  "kartlar döngü şeridinde işaretli")})
        bekleyen = [s for s in (dongu.get("kartlar") or [])
                    if s.get("durum") == "ekstre_bekleniyor"]
        if bekleyen:
            en_eski = max(int(s.get("gun") or 0) for s in bekleyen)
            out.append({"alanlar": ["kart", "ekstre"], "tarih": None, "guven": "gozlem",
                        "cumle": (f"{len(bekleyen)} kartın kesimi geçti ama ekstresi "
                                  f"YÜKLENMEDİ (en eskisi {en_eski} gün) — bu kartların "
                                  "borç/plan rakamları bayat dönemden kalmadır")})
    except Exception as e:  # noqa: BLE001
        logger.warning("bag kart dongu: %s", str(e)[:60])
    t = r.get("OZET_toplamlar") or r.get("toplamlar") or {}
    if t:
        cum = (f"tüm kartların dönem borcu toplamı {t.get('donem_borcu_toplam')}; "
               f"bunun {t.get('ilk_odemesi_yapilmamis_borc_toplami')} kadarı "
               f"İLK ÖDEMESİ YAPILMAMIŞ {t.get('ilk_odemesi_yapilmamis_kart_sayisi')} karta ait")
        try:
            kasa = (nakit_ufku(gun=7) or {}).get("kasa_simdiki")
            borc = t.get("ilk_odemesi_yapilmamis_borc_toplami")
            if kasa is not None and borc is not None:
                fark = round(float(kasa) - float(borc), 2)
                durum = ("kasa bu borcun TAMAMINI karşılamaz"
                         if fark < 0 else "kasa bu borcu karşılar")
                cum += (f"; kasa {kasa} → fark {fark} ({durum} — hazır hesap; "
                        "kartlar tek seferde ödenmez, plan/öteleme seçenekleri ayrı pencerede)")
        except Exception as e:  # noqa: BLE001
            logger.warning("bag kart kasa kiyasi: %s", str(e)[:60])
        out.append({"alanlar": ["kart", "kasa"], "tarih": None, "guven": "hesap",
                    "cumle": cum})
    for kt in (r.get("kartlar") or [])[:6]:
        e = kt.get("son_ekstre") or {}
        if not e:
            continue
        out.append({"alanlar": ["kart", "odeme_plani"], "tarih": e.get("son_odeme_tarihi"),
                    "guven": "hesap",
                    "cumle": (f"kart {kt.get('kart_adi')}: dönem borcu {e.get('donem_borcu')}, "
                              f"bekleyen plan toplamı {kt.get('bekleyen_plan_toplami')}, "
                              f"son ödeme {e.get('son_odeme_tarihi')} — ekstre↔plan bağı (yaklaşık)")})
    return out


def _bag_belge() -> List[dict]:
    """Belge kapsama bağı: işletme kart harcaması ↔ fatura arşivi (KDV/kanıt riski)."""
    out = []
    try:
        from fatura_api import belge_merkezi_ozet
        r = belge_merkezi_ozet()
        k = r.get("kapsama") or {}
        if (k.get("isletme_kart_harcamasi") or 0) > 0:
            out.append({"alanlar": ["fatura", "kart", "kdv"], "tarih": None,
                        "guven": "hesap",
                        "cumle": (f"bu ay işletme kart harcaması {k['isletme_kart_harcamasi']}; "
                                  f"bunun {k['faturali_eslesen']} kadarının faturası arşivde "
                                  f"eşleşti (kapsama %{k.get('oran_yuzde')}); faturasız "
                                  f"{k['faturasiz']} — belge istenmezse KDV indirimi ve "
                                  "gider kanıtı riski (hazır hesap)")})
    except Exception as e:  # noqa: BLE001
        logger.warning("bag belge: %s", str(e)[:60])
    return out


def _bag_fatura_istek() -> List[dict]:
    """BM-4 bağı: ödenmiş-ama-faturasız büyük ödemeler (Fatura İstek Motoru).
    Sayıları KOD hazırlar; KDV riski kaba tahmindir ('≈' ile sunulur)."""
    out = []
    try:
        from fatura_istek_api import fatura_istek_ozet
        o = fatura_istek_ozet()
        if (o.get("acik_adet") or 0) > 0:
            out.append({"alanlar": ["fatura", "odeme", "kdv"], "tarih": None,
                        "guven": "hesap",
                        "cumle": (f"{o['esik']:,.0f} TL üzeri ödemelerden "
                                  f"{o['acik_adet']} tanesinin faturası henüz yok "
                                  f"(toplam {o['acik_toplam']}; KDV indirimi riski "
                                  f"≈ {o['kdv_riski']}; en büyüğü {o['en_buyuk']}) — "
                                  "Belge Merkezi'nden tek tık Fatura İste "
                                  "(hazır hesap, hüküm değil)")})
    except Exception as e:  # noqa: BLE001
        logger.warning("bag fatura_istek: %s", str(e)[:60])
    return out


def _bag_cari() -> List[dict]:
    """BM-5 bağı: tedarikçi beyan bakiyeleri + yaklaşan vadeler (KOD hazırlar).
    Beyan = tedarikçinin fatura üstü bakiyesi — bizim hesap değil ('≈')."""
    out = []
    try:
        from fatura_api import cari_ozet
        o = cari_ozet()
        buyukler = [t for t in (o.get("tedarikciler") or [])
                    if (t.get("beyan_bakiye") or 0) > 0][:3]
        if buyukler:
            parcalar = ", ".join(
                f"{t['tedarikci']} ≈ {t['beyan_bakiye']} (beyan {t['beyan_tarihi']})"
                for t in buyukler)
            out.append({"alanlar": ["cari", "fatura", "odeme"], "tarih": None,
                        "guven": "gozlem",
                        "cumle": (f"tedarikçi fatura üstü BEYAN bakiyeleri: {parcalar} — "
                                  "tedarikçinin kendi beyanıdır, mutabakat hükmü değil "
                                  "(hazır kayıt)")})
        if (o.get("toplam_bekleyen_vade") or 0) > 0:
            out.append({"alanlar": ["cari", "vade", "odeme"], "tarih": None,
                        "guven": "hesap",
                        "cumle": (f"bekleyen vadeli alım toplamı "
                                  f"{o['toplam_bekleyen_vade']} — tedarikçi cari "
                                  "özetinde vade kırılımı hazır (hazır hesap)")})
        # ÖDEME İZİ YOK → CARİ BÜYÜYOR (sahip talebi 2026-07-13): fatura gelmiş
        # ama 180 günde hiç ödeme izi eşleşmemiş tedarikçiler — açık birikiyor
        buyuyen = [t for t in (o.get("tedarikciler") or [])
                   if (t.get("hesaplanan_acik") or 0) > 0
                   and not t.get("odeme_izi_var")
                   and (t.get("fatura_adet_6ay") or 0) > 0][:3]
        for t in buyuyen:
            out.append({"alanlar": ["cari", "odeme", "fatura"], "tarih": None,
                        "guven": "hesap",
                        "cumle": (f"{t['tedarikci']}: 180 günde "
                                  f"{t['fatura_adet_6ay']} fatura "
                                  f"(toplam {t['fatura_toplam_6ay']}) var ama "
                                  "hiç ödeme izi eşleşmedi — hesaplanan cari açık "
                                  f"{t['hesaplanan_acik']} ve BÜYÜYOR (iz yoksa "
                                  "borç kalır; kısmi/farklı-adla ödeme izi "
                                  "eşleşmemiş de olabilir — hüküm insanın)")})
    except Exception as e:  # noqa: BLE001
        logger.warning("bag cari: %s", str(e)[:60])
    return out


def _bag_fiyat_bandi() -> List[dict]:
    """BM-6 bağı: fatura kalemlerinden fiyat bandı sapmaları (KOD hesaplar).
    Yalnız aynı-birim kıyası; fiyat kaydını DEĞİŞTİRMEZ (öneri-only)."""
    out = []
    try:
        from fatura_api import fiyat_bandi_ozet
        o = fiyat_bandi_ozet()
        for b in (o.get("band_disi") or [])[:4]:
            yon = "üstünde" if (b.get("sapma_yuzde") or 0) > 0 else "altında"
            kart_ek = ""
            if b.get("kart_sapma_yuzde") is not None:
                kart_ek = (f"; maliyet kartından sapma %{b['kart_sapma_yuzde']} "
                           f"(kart {b['kart_fiyat']})")
            out.append({"alanlar": ["fiyat", "fatura", "maliyet"],
                        "tarih": b.get("son_tarih"), "guven": "hesap",
                        "cumle": (f"{b['ad']} ({b['birim']}): son alım {b['son_fiyat']} — "
                                  f"180 günlük bandın (medyan {b['medyan']}) "
                                  f"%{abs(b['sapma_yuzde'])} {yon}{kart_ek} — "
                                  "fiyat bandı adayı (hazır hesap, fiyat kaydı "
                                  "değiştirilmedi)")})
    except Exception as e:  # noqa: BLE001
        logger.warning("bag fiyat_bandi: %s", str(e)[:60])
    return out


def _bag_personel_puan() -> List[dict]:
    """Personel puan bağı — OLAY diliyle (kişilik yargısı üretmez; olay-gerçeği
    istisnası). Sayıları KOD hazırlar."""
    out = []
    try:
        from personel_puan_api import puan_ozet
        o = puan_ozet()
        ilk = (o.get("ilk8") or [])
        if ilk:
            lider = ilk[0]
            out.append({"alanlar": ["personel", "puan"], "tarih": None,
                        "guven": "hesap",
                        "cumle": (f"{o['ay']} puan defteri: {o['toplam_kisi']} kişide "
                                  f"kayıt var; vardiya-oranlı lig başında {lider['ad']} "
                                  f"(net {lider['net']}, {lider['vardiya']} vardiya"
                                  + (f", {lider['temiz_hafta']} temiz hafta" if lider.get('temiz_hafta') else "")
                                  + ") — olay sayımıdır, hüküm insanın (hazır hesap)")})
    except Exception as e:  # noqa: BLE001
        logger.warning("bag personel_puan: %s", str(e)[:60])
    return out


def _bag_mutabakat_zinciri() -> List[dict]:
    """BM-2 bağı: sipariş→teslim→belge→fatura→ödeme zincirinin eksik halkaları
    (belge-seviyesi; sayıları KOD hazırlar, hüküm insanın)."""
    out = []
    try:
        from fatura_api import mutabakat_zinciri
        o = mutabakat_zinciri()
        s = o.get("sayac") or {}
        eksik_toplam = sum(v for k, v in s.items() if k != "tam")
        if eksik_toplam > 0:
            out.append({"alanlar": ["siparis", "fatura", "odeme"], "tarih": None,
                        "guven": "hesap",
                        "cumle": (f"son 60 günün {o.get('siparis_adet')} toptancı "
                                  f"siparişinde zincir: {s.get('tam', 0)} TAM; eksikler — "
                                  f"teslim yok {s.get('teslim_yok', 0)}, belge açık "
                                  f"{s.get('belge_acik', 0)}, fatura yok "
                                  f"{s.get('fatura_yok', 0)}, ödeme izi yok "
                                  f"{s.get('odeme_izi_yok', 0)} (belge-seviyesi hazır "
                                  "hesap; ödeme izi aday eşleşmesidir)")})
    except Exception as e:  # noqa: BLE001
        logger.warning("bag mutabakat: %s", str(e)[:60])
    return out


def _bag_ciro_kasa() -> List[dict]:
    """Ciro↔kasa farkı bağı (dilek e59f57ec/10044dff: 'bu cirolarda kasa açığı
    var mı?') — şube-gün cirosu ile AYNI GÜNÜN kasa fark uyarısı yan yana."""
    with db() as (_, cur):
        cur.execute(
            """SELECT s.ad AS sube, c.tarih::text AS gun,
                      ROUND(SUM(c.toplam)::numeric, 2) AS ciro
               FROM ciro c JOIN subeler s ON s.id = c.sube_id
               WHERE c.durum = 'aktif' AND c.tarih >= CURRENT_DATE - 7
               GROUP BY s.ad, c.tarih""")
        cirolar = {(r["sube"], r["gun"]): float(r["ciro"]) for r in cur.fetchall() or []}
        cur.execute(
            """SELECT COALESCE(s.ad, u.sube_id::text) AS sube, u.tarih::text AS gun,
                      u.tip, ROUND(COALESCE(u.fark_tl,0)::numeric, 2) AS fark
               FROM sube_operasyon_uyari u
               LEFT JOIN subeler s ON s.id::text = u.sube_id::text
               WHERE u.tip IN ('ACILIS_KASA_FARK','KAPANIS_KASA_FARK')
                 AND u.tarih >= CURRENT_DATE - 7""")
        farklar = [dict(r) for r in cur.fetchall() or []]
    out = []
    for f in farklar[:10]:
        ciro = cirolar.get((f["sube"], f["gun"]))
        tip_ad = "açılış" if f["tip"] == "ACILIS_KASA_FARK" else "kapanış"
        yon = "eksik" if float(f["fark"]) < 0 else "fazla"
        out.append({"alanlar": ["ciro", "kasa"], "tarih": f["gun"], "guven": "gozlem",
                    "cumle": (f"{f['sube']} {f['gun']}: kayıtlı ciro "
                              f"{ciro if ciro is not None else 'kaydı görünmüyor'}; aynı günün "
                              f"{tip_ad} kasa farkı {f['fark']} ({yon}) — ciro↔kasa bağı "
                              "(hazır kayıt, hüküm değil)")})
    if not farklar:
        out.append({"alanlar": ["ciro", "kasa"], "tarih": None, "guven": "gozlem",
                    "cumle": "son 7 günde kayıtlı kasa farkı uyarısı yok — "
                             "cirolarda kasa açığı kaydına rastlanmadı (hazır kayıt)"})
    return out


def _bag_evo_ciro() -> List[dict]:
    """Evo↔kayıtlı ciro bağı (dilek 131e65a0: 'Zafer cirosu ile Evo verisi
    arasında fark var mı?') — Evo gece-çekim cache'i ile ciro tablosu şube-gün
    kıyası; farkı KOD hesaplar. TEMA↔GAZZE ad köprüsü bilinçli (aynı şube)."""
    def _kat(s):
        return (s or "").strip().upper().replace("İ", "I").replace("Ş", "S")             .replace("Ğ", "G").replace("Ü", "U").replace("Ö", "O").replace("Ç", "C")
    with db() as (_, cur):
        cur.execute(
            """SELECT bastar::text AS gun, veri_json FROM evo_rapor_cache
               WHERE anahtar = 'sube-grup-detay' AND bastar = bittar
               ORDER BY bastar DESC LIMIT 5""")
        evo_gunler = [dict(r) for r in cur.fetchall() or []]
        cur.execute(
            """SELECT s.ad AS sube, c.tarih::text AS gun,
                      ROUND(SUM(c.toplam)::numeric, 2) AS ciro
               FROM ciro c JOIN subeler s ON s.id = c.sube_id
               WHERE c.durum = 'aktif' AND c.tarih >= CURRENT_DATE - 8
               GROUP BY s.ad, c.tarih""")
        kayitli = {(_kat(r["sube"]), r["gun"]): float(r["ciro"])
                   for r in cur.fetchall() or []}
    takma = {"GAZZE": "TEMA", "TEMA": "GAZZE"}
    out = []
    for eg in evo_gunler:
        for sube_ad, sd in (eg["veri_json"].get("subeler") or {}).items():
            evo_c = sd.get("ciro_toplam")
            if evo_c is None:
                continue
            # Evo adlari 'Zafer Subesi' bicimli — sonek atilir (canli test dersi)
            k = _kat(sube_ad).replace("SUBESI", "").strip()
            kc = kayitli.get((k, eg["gun"]))
            if kc is None and k in takma:
                kc = kayitli.get((takma[k], eg["gun"]))
            if kc is None:
                out.append({"alanlar": ["evo", "ciro"], "tarih": eg["gun"], "guven": "gozlem",
                            "cumle": (f"{sube_ad} {eg['gun']}: Evo satış toplamı {evo_c} ama "
                                      "sistemde o günün kayıtlı cirosu görünmüyor — Evo↔ciro "
                                      "bağı (kayıt gecikmesi de olabilir)")})
                continue
            fark = round(float(evo_c) - kc, 2)
            out.append({"alanlar": ["evo", "ciro"], "tarih": eg["gun"], "guven": "hesap",
                        "cumle": (f"{sube_ad} {eg['gun']}: Evo satış toplamı {evo_c}, "
                                  f"kayıtlı ciro {kc} — fark {fark} (hazır hesap; "
                                  "küçük fark yuvarlama/iade kaynaklı olabilir)")})
    return out[:12]


# ── YENİ DUYULARIN BAĞLARI (2026-07-29, sahip: "hepsini sırayla kur" turu) ────
# 6 yeni duyu bağ defterine örülür: cümleleri KOD kurar, beyin AKTARIR.
# Her üretici tembel import kullanır (döngüsel import olmasın) ve yalnız
# SİNYAL varken konuşur — temiz günde sessizlik de bilgidir.

def _bag_sevkiyat_hiz():
    from operasyon_merkez_api import ops_siparis_sevkiyat_hiz
    from datetime import date as _d
    d = ops_siparis_sevkiyat_hiz(gun=30)
    out = []
    bugun = _d.today().isoformat()
    if d.get("ort_saat") is not None and int(d.get("teslim_adet") or 0) >= 3:
        out.append({"alanlar": ["sevkiyat", "hiz"], "tarih": bugun, "guven": "hesap",
                    "cumle": (f"Sevkiyat hızı (30g): talepten teslime ort {d['ort_saat']} sa "
                              f"(medyan {d.get('medyan_saat')}, {d['teslim_adet']} teslim; "
                              f"depo hazırlık {d.get('hazirlik_ort_saat')} sa · yol {d.get('yol_ort_saat')} sa)")})
        depolar = d.get("depolar") or []
        if len(depolar) >= 2 and depolar[-1].get("ort_saat"):
            en_yavas, en_hizli = depolar[0], depolar[-1]
            if float(en_yavas["ort_saat"]) >= 1.8 * float(en_hizli["ort_saat"]):
                out.append({"alanlar": ["sevkiyat", "hiz"], "tarih": bugun, "guven": "hesap",
                            "cumle": (f"Depo hız farkı: {en_yavas['depo_adi']} ort {en_yavas['ort_saat']} sa, "
                                      f"{en_hizli['depo_adi']} {en_hizli['ort_saat']} sa — yavaş depoda "
                                      "hazırlık düzeni incelenmeye aday (gözlem, hüküm değil)")})
    return out[:3]


def _bag_para_yolda():
    from operasyon_merkez_api import ops_para_yolda
    from datetime import date as _d
    d = ops_para_yolda(gun=14)
    out = []
    bugun = _d.today().isoformat()
    for b in (d.get("bekleyenler") or [])[:3]:
        if b.get("gecikmis"):
            tutar = f" (~{int(b['beklenen_tutar']):,} ₺)".replace(",", ".") if b.get("beklenen_tutar") else ""
            out.append({"alanlar": ["kasa", "teslim"], "tarih": b.get("tarih") or bugun, "guven": "hesap",
                        "cumle": (f"{b.get('sube')} {b.get('tarih')} kapanışının gün sonu teslimi "
                                  f"{int(b.get('gecen_saat') or 0)} saattir kayıtsız{tutar} — para yolda")})
    if d.get("ort_teslim_saat") is not None and float(d["ort_teslim_saat"]) > 24:
        out.append({"alanlar": ["kasa", "teslim"], "tarih": bugun, "guven": "hesap",
                    "cumle": (f"Kapanış→teslim ortalaması {d['ort_teslim_saat']} saate çıktı "
                              f"(14g, {d.get('eslesen_adet')} eşleşme) — teslim ritmi yavaşlıyor")})
    return out[:3]


def _bag_vade_disiplini():
    from operasyon_merkez_api import ops_vade_disiplini
    from datetime import date as _d
    d = ops_vade_disiplini(gun=90)
    out = []
    bugun = _d.today().isoformat()
    if d.get("gec_orani_yuzde") is not None and float(d["gec_orani_yuzde"]) >= 10:
        ornek = (d.get("en_gecler") or [{}])[0]
        ek = f" — en geç: {ornek.get('aciklama')} (+{ornek.get('gecikme_gun')} gün)" if ornek.get("aciklama") else ""
        out.append({"alanlar": ["odeme", "vade"], "tarih": bugun, "guven": "hesap",
                    "cumle": (f"Vade disiplini (90g): ödenen planların %{d['gec_orani_yuzde']}'i "
                              f"3+ gün geç ödendi (ort sapma {d.get('ort_gecikme_gun')} gün){ek}")})
    return out[:2]


def _bag_bulgu_dongusu():
    from operasyon_merkez_api import ops_bulgu_izi_ozet
    from datetime import date as _d
    d = ops_bulgu_izi_ozet(gun=30)
    out = []
    bugun = _d.today().isoformat()
    oran = d.get("yanlis_alarm_orani_yuzde")
    if oran is not None and float(oran) >= 30 and int(d.get("yanlis_alarm") or 0) >= 2:
        out.append({"alanlar": ["denetim", "isabet"], "tarih": bugun, "guven": "hesap",
                    "cumle": (f"Motor bulgularının %{oran}'i yanlış alarm işaretlendi (30g, "
                              f"{d.get('yanlis_alarm')} adet) — eşikler gözden geçirilmeye aday")})
    if int(d.get("cozulen") or 0) >= 3 and d.get("ort_cozum_saat") is not None:
        out.append({"alanlar": ["denetim", "isabet"], "tarih": bugun, "guven": "hesap",
                    "cumle": (f"30 günde {d['cozulen']} bulgu çözüldü işaretlendi "
                              f"(ort ≈{d['ort_cozum_saat']} sa — gece doğum varsayımıyla)")})
    return out[:2]


_BAG_KAYNAKLARI = [
    ("stok_hipotez", _bag_stok_hipotez),
    ("tutarsizlik", _bag_tutarsizlik),
    ("recete", _bag_recete),
    ("degirmen", _bag_degirmen),
    ("finans", _bag_finans),
    ("sinaps", _bag_sinaps),
    ("odeme", _bag_odeme),
    ("maas_avans", _bag_maas_avans),
    ("kart", _bag_kart),
    ("belge", _bag_belge),
    ("fatura_istek", _bag_fatura_istek),
    ("cari", _bag_cari),
    ("fiyat_bandi", _bag_fiyat_bandi),
    ("mutabakat_zinciri", _bag_mutabakat_zinciri),
    ("personel_puan", _bag_personel_puan),
    ("ciro_kasa", _bag_ciro_kasa),
    ("evo_ciro", _bag_evo_ciro),
    # Yeni duyular (2026-07-29) — tavan kontrolü: 21 kaynak × küçük katkı,
    # beyin aktarım dilimi [:80] (35-kesme dersi sonrası genişletilmişti).
    ("sevkiyat_hiz", _bag_sevkiyat_hiz),
    ("para_yolda", _bag_para_yolda),
    ("vade_disiplini", _bag_vade_disiplini),
    ("bulgu_dongusu", _bag_bulgu_dongusu),
]


def bag_defteri_hesapla() -> dict:
    """Tüm alanların hazır bağ cümlelerini derler ve GÜNLÜK cache'e yazar.
    GECE koşar (pool dostu — gündüz beyin cache'ten okur). Kaynaklardan biri
    çökse diğerleri yaşar."""
    baglar: List[dict] = []
    hatalar: List[str] = []
    for ad, fn in _BAG_KAYNAKLARI:
        try:
            baglar.extend(fn() or [])
        except Exception as e:  # noqa: BLE001
            hatalar.append(f"{ad}: {str(e)[:60]}")
            logger.warning("bag defteri kaynak %s: %s", ad, str(e)[:100])
    veri = {"baglar": baglar[:80], "kaynak_hatalari": hatalar,
            "not": "HAZIR BAĞ CÜMLELERİ — kod kurdu, beyin AKTARIR (kendi hesabını "
                   "yapmaz). Hüküm yok; her cümle gözlem/hazır hesaptır."}
    import json as _json
    with db() as (conn, cur):
        _bag_ensure(cur)
        cur.execute(
            """INSERT INTO bag_defteri (gun, veri) VALUES (CURRENT_DATE, %s::jsonb)
               ON CONFLICT (gun) DO UPDATE SET veri=EXCLUDED.veri, olusturma=NOW()""",
            (_json.dumps(veri, ensure_ascii=False, default=str),))
        conn.commit()
    return {"ok": True, "bag_sayisi": len(baglar), "hatalar": hatalar}


@router.post("/bag-defteri-hesapla")
def bag_defteri_hesapla_uc():
    """Elle tetikleme (ilk doldurma / test). Normalde gece zinciri koşar."""
    return bag_defteri_hesapla()


@router.get("/bag-defteri")
def bag_defteri_oku():
    """Beynin her soruda gördüğü bağ defteri — CACHE'ten (hızlı, pool dostu).
    Cache boşsa dürüstçe söyler; canlı hesaba KAÇMAZ (pool koruması)."""
    with db() as (_, cur):
        _bag_ensure(cur)
        cur.execute("""SELECT gun::text AS gun, veri, olusturma::text AS olusturma
                       FROM bag_defteri ORDER BY gun DESC LIMIT 1""")
        r = cur.fetchone()
    if not r:
        return {"baglar": [], "not": "Bağ defteri henüz hesaplanmadı (gece zinciri "
                                     "veya elle tetik bekleniyor)."}
    rr = dict(r)
    veri = rr["veri"] if isinstance(rr["veri"], dict) else {}
    veri["defter_gunu"] = rr["gun"]
    veri["hesap_zamani"] = rr["olusturma"]
    return veri
