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
