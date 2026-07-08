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
        cur.execute(
            """
            SELECT id, tedarikci_ad, tutar::float AS tutar, tarih, kaynak, confidence
            FROM supplier_payment_event
            WHERE tarih >= %s
            ORDER BY tarih
            """,
            (str(bas - timedelta(days=7)),),
        )
        odemeler = []
        for r in (cur.fetchall() or []):
            d = dict(r)
            d["_norm"] = _norm(d.get("tedarikci_ad"))
            d["tarih"] = str(d["tarih"])
            d["_kullanildi"] = False
            odemeler.append(d)

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
            # anlik_giderler.sube METİN şube adıdır (sube_id DEĞİL — bilinen tuzak)
            cur.execute(
                """SELECT COALESCE(NULLIF(TRIM(UPPER(sube)),''),'MERKEZ') AS sube_ad,
                          ROUND(SUM(COALESCE(tutar,0))::numeric, 2) AS gider
                   FROM anlik_giderler
                   WHERE durum = 'aktif'
                     AND tarih >= date_trunc('month', CURRENT_DATE) - (%s * INTERVAL '1 month')
                     AND tarih <  date_trunc('month', CURRENT_DATE) - ((%s - 1) * INTERVAL '1 month')
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
            del kt["id"]
    return {
        "kartlar": kartlar,
        "not": "Kart başına limit + son ekstre pozisyonu + bekleyen ödeme planları. "
               "Ekstre YAKLAŞIKTIR (banka canlı verisi değil, sistem kayıtları).",
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
    return {
        "durum_pozisyon_kirilimi": kirilim,
        "son_30_gun_yeni_basvuru": son30,
        "not": "KİMLİKSİZ havuz özeti. Aday isim/iletişim bilgisi İş Başvuruları "
               "ekranındadır — beyin kişi değerlendirmesi yapmaz.",
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
def tutarsizlik_ozeti(gun: int = 7):
    g = max(3, min(14, int(gun or 7)))
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

    # 5) MAKİNE ↔ SATIŞ (değirmen sayacı)
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
        "not": "İKİ KAYNAK AYNI ŞEYİ FARKLI SÖYLÜYOR listesi (5 kontrol: ciro-kasa izi, 
               "devir, satış-tüketim, kabul-stok girişi, makine-satış) — hüküm yok, "
               "beraat da yok: hiçbir açıklama satırı listeden düşürmez, yorum insanındır. "
               "Boş liste 'her şey tutarlı' demektir. Eşik: satış/makine kıyasında "
               "±%15 altı gürültü sayılıp gösterilmez (ham hali ilgili pencerelerde).",
    }
