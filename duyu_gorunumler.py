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
from datetime import date, timedelta

from fastapi import APIRouter, Query

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/duyu", tags=["duyu-gorunumler"])

# Beyanname/ödeme günleri (TR pratik varsayım — yapılandırılabilir; bilgi amaçlı)
_KDV_ODEME_GUNU = 28       # takip eden ayın 28'i
_MUHTASAR_ODEME_GUNU = 28  # muhtasar da takip eden ayın sonuna doğru


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
