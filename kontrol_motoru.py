from __future__ import annotations

import logging
import os
from datetime import datetime, date, timedelta
from typing import Any, Dict, List, Optional

from database import db
from tr_saat import bugun_tr, dt_now_tr_naive
from operasyon_stok_motor import build_virtual_merkez_uyarilari


def _gider_limitleri() -> dict:
    """
    Günlük gider limitleri env'den okunur.
    Varsayılanlar: kritik=1500, uyari=1000, kategori sınırları ayrı.
    Env değişkenleri:
      EVVEL_GIDER_LIMIT_KRITIK   (varsayılan 1500)
      EVVEL_GIDER_LIMIT_UYARI    (varsayılan 1000)
      EVVEL_GIDER_KAT_MARKET     (varsayılan 400)
      EVVEL_GIDER_KAT_YAKIT      (varsayılan 300)
      EVVEL_GIDER_KAT_KARGO      (varsayılan 200)
      EVVEL_GIDER_KAT_YEMEK      (varsayılan 300)
    """
    def _int(key, default):
        try:
            return max(1, int((os.environ.get(key) or str(default)).strip()))
        except (ValueError, AttributeError):
            return default

    return {
        "kritik": _int("EVVEL_GIDER_LIMIT_KRITIK", 1500),
        "uyari":  _int("EVVEL_GIDER_LIMIT_UYARI", 1000),
        "kategori": {
            "Market": _int("EVVEL_GIDER_KAT_MARKET", 400),
            "Yakıt":  _int("EVVEL_GIDER_KAT_YAKIT", 300),
            "Kargo":  _int("EVVEL_GIDER_KAT_KARGO", 200),
            "Yemek":  _int("EVVEL_GIDER_KAT_YEMEK", 300),
        },
    }


# ─── ÇIKTI FORMATI ───────────────────────────────────────────
def _sonuc(
    kontrol,
    seviye,
    mesaj,
    deger=None,
    esik=None,
    sube_id=None,
    personel_id=None,
    meta=None,
):
    return {
        "kontrol": kontrol,
        "seviye": seviye,
        "mesaj": mesaj,
        "deger": deger,
        "esik": esik,
        "sube_id": sube_id,
        "personel_id": personel_id,
        "meta": meta or {},
    }


# ─── YARDIMCI ────────────────────────────────────────────────
def _kasa_event_ref(cur, sube_id: str, tarih_sql: str, tip: str) -> Optional[dict]:
    """Belirtilen tarih ve tip için kasa tutarı + personel bilgisi."""
    cur.execute(
        f"""
        SELECT
            COALESCE(kasa_sayim, teslim) AS tutar,
            personel_id,
            personel_saat
        FROM sube_operasyon_event
        WHERE sube_id = %s
          AND tarih = {tarih_sql}
          AND tip = %s
          AND durum = 'tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST
        LIMIT 1
        """,
        (sube_id, tip),
    )
    r = cur.fetchone()
    if not r or r.get("tutar") is None:
        return None
    return {
        "tutar": float(r["tutar"]),
        "personel_id": r.get("personel_id"),
    }


def _dun_kapanis_kasa_ref(cur, sube_id: str) -> Optional[dict]:
    """Dün kapanış kasa tutarı + o kapanışı yapan personel."""
    return _kasa_event_ref(cur, sube_id, "CURRENT_DATE - INTERVAL '1 day'", "KAPANIS")


def _bugun_acilis_kasa_ref(cur, sube_id: str) -> Optional[dict]:
    """Bugün açılış kasa tutarı + açılışı yapan personel."""
    return _kasa_event_ref(cur, sube_id, "CURRENT_DATE", "ACILIS")


# ─── KONTROL 1: KASA FARK ────────────────────────────────────
def kontrol_kasa_fark(cur, sube_id: str) -> Optional[dict]:
    """
    Dün kapanış kasası vs bugün açılış kasası.
    Fark varsa kim açtı bilgisiyle birlikte döner.
    """
    dun = _dun_kapanis_kasa_ref(cur, sube_id)
    if dun is None:
        return None

    bugun = _bugun_acilis_kasa_ref(cur, sube_id)
    if bugun is None:
        return None

    fark = bugun["tutar"] - dun["tutar"]
    fark_abs = abs(fark)

    if fark_abs <= 50:
        return None

    sev = "kritik" if fark_abs >= 200 else "uyari"
    yon = "fazla" if fark > 0 else "eksik"

    return _sonuc(
        "KASA_FARK",
        sev,
        (
            f"Kasa farkı {fark:+.0f}₺ — dün kapanış {dun['tutar']:,.0f}₺, "
            f"bugün açılış {bugun['tutar']:,.0f}₺ ({yon})"
        ),
        deger=round(fark, 2),
        esik=200,
        sube_id=sube_id,
        personel_id=bugun.get("personel_id"),
        meta={
            "dun_kapanis": dun["tutar"],
            "bugun_acilis": bugun["tutar"],
            "acilis_personel_id": bugun.get("personel_id"),
            "kapanis_personel_id": dun.get("personel_id"),
        },
    )


def kontrol_kasa_fark_trend(cur, sube_id: str, gun: int = 7) -> Optional[dict]:
    """
    Son N günde kasa farkı kaç kez oluştu?
    3+ kez → kronik sorun.
    """
    cur.execute(
        """
        SELECT COUNT(*) AS adet, COALESCE(SUM(ABS(fark_tl)), 0) AS toplam
        FROM sube_operasyon_uyari
        WHERE sube_id = %s
          AND tip = 'ACILIS_KASA_FARK'
          AND tarih >= CURRENT_DATE - (%s * INTERVAL '1 day')
        """,
        (sube_id, gun),
    )
    r = cur.fetchone()
    adet = int((r or {}).get("adet") or 0)
    toplam = float((r or {}).get("toplam") or 0)

    if adet < 3:
        return None

    sev = "kritik" if adet >= 5 else "uyari"
    return _sonuc(
        "KASA_FARK_KRONIK",
        sev,
        f"Son {gun} günde {adet} kez kasa farkı — toplam {toplam:,.0f}₺",
        deger=adet,
        esik=5,
        sube_id=sube_id,
        meta={"gun": gun, "toplam_fark": toplam},
    )


# ─── KONTROL 2: ONAY KUYRUĞUNDAKİ GİDER LİMİT ───────────────
def kontrol_gunluk_gider_limit(cur, sube_id: str) -> List[dict]:
    """
    Bugün onay kuyruğuna düşen + onaylanan anlık giderler
    günlük toplam ve kategori bazlı limit kontrolü.
    """
    sonuclar: List[dict] = []

    cur.execute(
        """
        SELECT kategori, SUM(tutar) AS toplam, COUNT(*) AS adet
        FROM anlik_giderler
        WHERE sube = %s
          AND tarih = CURRENT_DATE
          AND durum IN ('aktif', 'onay_bekliyor')
        GROUP BY kategori
        """,
        (sube_id,),
    )
    kat_map = {r["kategori"]: float(r["toplam"]) for r in cur.fetchall()}
    gunluk_toplam = sum(kat_map.values())
    lim = _gider_limitleri()

    # Günlük toplam kontrolü
    if gunluk_toplam >= lim["kritik"]:
        sonuclar.append(
            _sonuc(
                "GUNLUK_GIDER_ASIMI",
                "kritik",
                f"Günlük gider limiti aşıldı: {gunluk_toplam:,.0f}₺",
                deger=gunluk_toplam,
                esik=lim["kritik"],
                sube_id=sube_id,
            )
        )
    elif gunluk_toplam >= lim["uyari"]:
        sonuclar.append(
            _sonuc(
                "GUNLUK_GIDER_UYARI",
                "uyari",
                f"Günlük gider yüksek: {gunluk_toplam:,.0f}₺ / {lim['kritik']:,.0f}₺",
                deger=gunluk_toplam,
                esik=lim["kritik"],
                sube_id=sube_id,
            )
        )

    # Kategori bazlı
    for kat, cap in lim["kategori"].items():
        deger = kat_map.get(kat, 0)
        if deger >= cap:
            sonuclar.append(
                _sonuc(
                    "KATEGORI_GIDER_ASIMI",
                    "uyari",
                    f"{kat}: {deger:,.0f}₺ / {cap:,.0f}₺ limitini aştı",
                    deger=deger,
                    esik=cap,
                    sube_id=sube_id,
                    meta={"kategori": kat},
                )
            )

    return sonuclar


def kontrol_fissiz_gider(cur, sube_id: str) -> Optional[dict]:
    """Son 30 günde fis_gonderildi=FALSE olan gider sayısı."""
    cur.execute(
        """
        SELECT COUNT(*) AS adet
        FROM anlik_giderler
        WHERE sube = %s
          AND tarih >= CURRENT_DATE - INTERVAL '30 days'
          AND fis_gonderildi = FALSE
          AND durum IN ('aktif', 'onay_bekliyor')
        """,
        (sube_id,),
    )
    adet = int((cur.fetchone() or {}).get("adet") or 0)

    if adet < 3:
        return None

    sev = "kritik" if adet >= 7 else "uyari"
    return _sonuc(
        "FISSIZ_GIDER",
        sev,
        f"Son 30 günde {adet} fişsiz gider",
        deger=adet,
        esik=7,
        sube_id=sube_id,
    )


# ─── KONTROL 3: STOK ─────────────────────────────────────────
def kontrol_stok(cur, sube_id: str) -> List[dict]:
    """
    operasyon_stok_motor'dan sanal uyarıları alır,
    kontrol_motoru formatına dönüştürür.
    """
    virt = build_virtual_merkez_uyarilari(cur, sube_id, dt_now_tr_naive())
    sonuclar: List[dict] = []
    for u in virt:
        tip = u.get("tip", "")
        sev = u.get("seviye", "uyari")
        sonuclar.append(
            _sonuc(
                tip,
                sev,
                u.get("mesaj", ""),
                deger=u.get("fark_tl"),
                sube_id=sube_id,
            )
        )
    return sonuclar


# ─── KONTROL 4: ZAMAN ────────────────────────────────────────
def kontrol_kapanis_gecikme(cur, sube_id: str, kapanis_saati: str) -> Optional[dict]:
    """Kapanış saati geçtiyse event tamamlandı mı?"""
    simdi = dt_now_tr_naive()
    try:
        h, m = map(int, (kapanis_saati or "22:00").split(":"))
        kap_dt = simdi.replace(hour=h, minute=m, second=0, microsecond=0)
    except Exception:
        return None

    gecti_dk = int((simdi - kap_dt).total_seconds() // 60)
    if gecti_dk < 30:
        return None  # Henüz erken

    cur.execute(
        """
        SELECT durum FROM sube_operasyon_event
        WHERE sube_id = %s AND tarih = CURRENT_DATE AND tip = 'KAPANIS'
        ORDER BY olusturma DESC LIMIT 1
        """,
        (sube_id,),
    )
    r = cur.fetchone()
    if r and r.get("durum") == "tamamlandi":
        return None

    sev = "kritik" if gecti_dk >= 60 else "uyari"
    return _sonuc(
        "KAPANIS_GECIKTI",
        sev,
        f"Kapanış {gecti_dk} dk gecikmiş",
        deger=gecti_dk,
        esik=60,
        sube_id=sube_id,
    )


def kontrol_ciro_girildi_mi(cur, sube_id: str) -> Optional[dict]:
    """Kapanış yapıldıysa ciro girilmiş mi?"""
    cur.execute(
        """
        SELECT 1 FROM sube_operasyon_event
        WHERE sube_id = %s AND tarih = CURRENT_DATE
          AND tip = 'KAPANIS' AND durum = 'tamamlandi'
        LIMIT 1
        """,
        (sube_id,),
    )
    if not cur.fetchone():
        return None

    cur.execute(
        """
        SELECT 1 FROM ciro
        WHERE sube_id = %s AND tarih = CURRENT_DATE AND durum = 'aktif'
        LIMIT 1
        """,
        (sube_id,),
    )
    if cur.fetchone():
        return None

    cur.execute(
        """
        SELECT 1 FROM ciro_taslak
        WHERE sube_id = %s AND tarih = CURRENT_DATE
          AND durum IN ('bekliyor', 'onaylandi')
        LIMIT 1
        """,
        (sube_id,),
    )
    if cur.fetchone():
        return None

    return _sonuc(
        "CIRO_EKSIK",
        "kritik",
        "Kapanış yapıldı ama ciro girilmedi",
        sube_id=sube_id,
    )


def kontrol_ciro_taslak_bekliyor(cur, sube_id: str) -> Optional[dict]:
    """Bugün bekleyen ciro taslağı varsa uyarı (kapanış beklemeden)."""
    cur.execute(
        """
        SELECT COUNT(*) AS adet
        FROM ciro_taslak
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='bekliyor'
        """,
        (sube_id,),
    )
    adet = int((cur.fetchone() or {}).get("adet") or 0)
    if adet <= 0:
        return None
    return _sonuc(
        "CIRO_TASLAK_BEKLIYOR",
        "uyari",
        f"Ciro taslağı onay bekliyor ({adet})",
        deger=adet,
        esik=1,
        sube_id=sube_id,
    )


def kontrol_guvenlik_pin(cur, sube_id: str) -> Optional[dict]:
    """PIN kilit/hatali alarmını merkezi motor içinde de üret (ops dashboard ile tutarlı)."""
    try:
        pencere_dk = int((os.environ.get("EVVEL_GUV_ALARM_DK") or "15").strip())
    except Exception:
        pencere_dk = 15
    try:
        pin_kilit_esik = int((os.environ.get("EVVEL_GUV_ALARM_PIN_KILIT") or "2").strip())
    except Exception:
        pin_kilit_esik = 2
    try:
        pin_hatali_esik = int((os.environ.get("EVVEL_GUV_ALARM_PIN_HATALI") or "8").strip())
    except Exception:
        pin_hatali_esik = 8

    cur.execute(
        """
        SELECT
          COUNT(*) FILTER (WHERE tip='PIN_KILIT')::int AS pin_kilit_adet,
          COUNT(*) FILTER (WHERE tip='PIN_HATALI')::int AS pin_hatali_adet
        FROM operasyon_guvenlik_olay
        WHERE sube_id=%s
          AND olay_ts >= NOW() - (%s * INTERVAL '1 minute')
        """,
        (sube_id, max(5, min(240, pencere_dk))),
    )
    r = dict(cur.fetchone() or {})
    kilit_adet = int(r.get("pin_kilit_adet") or 0)
    hatali_adet = int(r.get("pin_hatali_adet") or 0)
    if kilit_adet < pin_kilit_esik and hatali_adet < pin_hatali_esik:
        return None
    seviye = "kritik" if kilit_adet >= pin_kilit_esik else "uyari"
    return _sonuc(
        "GUVENLIK_PIN_ALARM",
        seviye,
        f"PIN alarmı: kilit={kilit_adet}, hatalı={hatali_adet} (son {pencere_dk} dk)",
        deger={"pin_kilit_adet": kilit_adet, "pin_hatali_adet": hatali_adet},
        esik={"pin_kilit_esik": pin_kilit_esik, "pin_hatali_esik": pin_hatali_esik},
        sube_id=sube_id,
    )


def kontrol_vardiya_devri(cur, sube_id: str) -> Optional[dict]:
    """Vardiya devri 2. imza bekliyorsa uyar."""
    cur.execute(
        """
        SELECT durum FROM kapanis_kayit
        WHERE sube_id = %s AND tarih = CURRENT_DATE
        ORDER BY olusturma DESC LIMIT 1
        """,
        (sube_id,),
    )
    r = cur.fetchone()
    if not r:
        return None
    if (r.get("durum") or "") == "acilis_bekliyor":
        return _sonuc(
            "VARDIYA_DEVRI_EKSIK",
            "uyari",
            "Vardiya devri 2. imza bekleniyor",
            sube_id=sube_id,
        )
    return None


# ─── ANA MOTOR ───────────────────────────────────────────────
def sube_kontrol_calistir(cur, sube_id: str, sube: dict, kategori: Optional[str] = None) -> dict:
    """Bir şube için kontrolleri çalıştırır.

    Geri-uyumluluk: Eski çağrılarda kullanılan `kategori` filtresi opsiyoneldir.
    Kategori verilmezse tüm kontroller çalışır.
    """
    return _sube_kontrol_calistir_impl(cur, sube_id, sube, kategori=kategori)


def _sube_kontrol_calistir_impl(cur, sube_id: str, sube: dict, kategori: Optional[str] = None) -> dict:
    """Bir şube için kontrolleri çalıştırır (opsiyonel kategori filtresi ile)."""
    sonuclar: List[dict] = []
    kat = (kategori or "").strip().lower()

    def secili(*anahtarlar: str) -> bool:
        if not kat:
            return True
        return kat in {a.strip().lower() for a in anahtarlar if a}

    # 1. Kasa
    if secili("kasa"):
        r = kontrol_kasa_fark(cur, sube_id)
        if r:
            sonuclar.append(r)

        r = kontrol_kasa_fark_trend(cur, sube_id)
        if r:
            sonuclar.append(r)

    # 2. Gider
    if secili("gider"):
        sonuclar.extend(kontrol_gunluk_gider_limit(cur, sube_id))

        r = kontrol_fissiz_gider(cur, sube_id)
        if r:
            sonuclar.append(r)

    # 3. Stok
    if secili("stok"):
        sonuclar.extend(kontrol_stok(cur, sube_id))

    # 4. Zaman
    if secili("zaman", "ciro", "guvenlik"):
        if secili("zaman"):
            r = kontrol_kapanis_gecikme(cur, sube_id, sube.get("kapanis_saati") or "22:00")
            if r:
                sonuclar.append(r)

        if secili("ciro"):
            r = kontrol_ciro_girildi_mi(cur, sube_id)
            if r:
                sonuclar.append(r)

            r = kontrol_ciro_taslak_bekliyor(cur, sube_id)
            if r:
                sonuclar.append(r)

        if secili("zaman"):
            r = kontrol_vardiya_devri(cur, sube_id)
            if r:
                sonuclar.append(r)

        if secili("guvenlik"):
            r = kontrol_guvenlik_pin(cur, sube_id)
            if r:
                sonuclar.append(r)

    kritik = [s for s in sonuclar if s["seviye"] == "kritik"]
    uyari = [s for s in sonuclar if s["seviye"] == "uyari"]

    return {
        "sube_id": sube_id,
        "sube_adi": sube.get("ad", ""),
        "sonuclar": sonuclar,
        "kritik_adet": len(kritik),
        "uyari_adet": len(uyari),
        "temiz": len(sonuclar) == 0,
    }


def tum_subeler_kontrol(sadece_alarmlar: bool = False, kategori: Optional[str] = None) -> List[dict]:
    """Tüm aktif şubeler için kontrol çalıştırır."""
    with db() as (conn, cur):
        cur.execute("SELECT * FROM subeler WHERE aktif=TRUE ORDER BY ad")
        subeler = [dict(r) for r in cur.fetchall()]
        sonuclar: List[dict] = []
        for sube in subeler:
            ozet = _sube_kontrol_calistir_impl(cur, sube["id"], sube, kategori=kategori)
            if sadece_alarmlar and ozet["temiz"]:
                continue
            sonuclar.append(ozet)
        try:
            from analitik_olay import analitik_olay_ekle

            tk = sum(int(x.get("kritik_adet") or 0) for x in sonuclar)
            tu = sum(int(x.get("uyari_adet") or 0) for x in sonuclar)
            analitik_olay_ekle(
                cur,
                "KONTROL_TUM_SUBELER",
                sube_id=None,
                tutar_yok_bilgi=True,
                hesap_surumu="basarili",
                kaynak="tum_subeler_kontrol",
                throttle_sn=90,
                payload={
                    "sube_sayisi": len(subeler),
                    "satir_sayisi": len(sonuclar),
                    "toplam_kritik": tk,
                    "toplam_uyari": tu,
                    "sadece_alarmlar": bool(sadece_alarmlar),
                    "kategori": (kategori or "").strip(),
                },
            )
        except Exception:
            logging.getLogger("evvel-erp").warning(
                "KONTROL_TUM_SUBELER analitik olayı atlandı", exc_info=True
            )
    return sonuclar



def kontrol_personel_risk_profili(cur: Any, personel_id: str, gun: int = 30) -> Dict[str, Any]:
    """Son N gün sinyallerinden ağırlıklı puan üretir; takip tablosunu günceller."""
    pid = (personel_id or "").strip()
    if not pid:
        return {"success": False, "mesaj": "personel_id boş"}
    gun_sayi = max(7, min(365, int(gun or 30)))
    cur.execute(
        """
        SELECT
            COUNT(*)::int AS adet,
            COALESCE(SUM(agirlik), 0)::int AS puan,
            MAX(tarih) AS son_tarih
        FROM personel_risk_sinyal
        WHERE personel_id=%s
          AND tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
        """,
        (pid, gun_sayi),
    )
    r = dict(cur.fetchone() or {})
    adet = int(r.get("adet") or 0)
    puan = int(r.get("puan") or 0)
    son_tarih = str(r.get("son_tarih")) if r.get("son_tarih") else None

    # Basit eşikler (kolay ayarlanabilir)
    if puan >= 35:
        seviye = "kritik"
    elif puan >= 20:
        seviye = "uyari"
    elif puan >= 10:
        seviye = "izlemede"
    else:
        seviye = None

    if not seviye:
        # Skor düşükse takipten çıkar (opsiyonel: burada silmiyoruz, sadece düşürüyoruz)
        cur.execute(
            """
            UPDATE personel_takip
            SET takip_seviyesi='izlemede', guncelleme=NOW()
            WHERE personel_id=%s
            """,
            (pid,),
        )
        return {"success": True, "personel_id": pid, "puan": puan, "adet": adet, "takip": None}

    cur.execute(
        """
        SELECT sinyal_turu
        FROM personel_risk_sinyal
        WHERE personel_id=%s
          AND tarih >= (CURRENT_DATE - (%s * INTERVAL '1 day'))
        ORDER BY agirlik DESC, tarih DESC, olusturma DESC
        LIMIT 1
        """,
        (pid, gun_sayi),
    )
    top = cur.fetchone()
    tetik = (dict(top).get("sinyal_turu") if top else None) or None

    cur.execute(
        """
        INSERT INTO personel_takip (personel_id, takip_baslangic, takip_seviyesi, tetikleyen_sinyal, guncelleme)
        VALUES (%s, CURRENT_DATE, %s, %s, NOW())
        ON CONFLICT (personel_id) DO UPDATE SET
            takip_seviyesi=EXCLUDED.takip_seviyesi,
            tetikleyen_sinyal=EXCLUDED.tetikleyen_sinyal,
            guncelleme=NOW()
        """,
        (pid, seviye, tetik),
    )
    return {
        "success": True,
        "personel_id": pid,
        "gun_sayi": gun_sayi,
        "sinyal_adet": adet,
        "puan": puan,
        "takip_seviyesi": seviye,
        "tetikleyen_sinyal": tetik,
        "son_sinyal_tarih": son_tarih,
    }


def kontrol_depoda_var_fissiz(cur: Any, sube_id: str, tarih: str) -> List[Dict[str, Any]]:
    """
    O gün fiş gönderilmemiş giderleri tarar; depoda hareket varsa DEPODA_VAR_FIS_YOK sinyali üretir.
    Not: teorik stok yerine (hafif) operasyon_defter stok hareket var mı kontrolü kullanılır.
    """
    sid = (sube_id or "").strip()
    tg = (tarih or "").strip()
    if not sid or not tg:
        return []
    cur.execute(
        """
        SELECT id, personel_id, kategori, tutar, aciklama
        FROM anlik_giderler
        WHERE sube=%s AND tarih=%s::date
          AND COALESCE(fis_gonderildi, FALSE)=FALSE
        """,
        (sid, tg),
    )
    giderler = [dict(r) for r in cur.fetchall()]
    if not giderler:
        return []
    cur.execute(
        """
        SELECT 1
        FROM operasyon_defter
        WHERE sube_id=%s AND tarih=%s::date
          AND etiket IN ('URUN_SEVK','URUN_AC','URUN_STOK_EKLE')
        LIMIT 1
        """,
        (sid, tg),
    )
    depoda_var = cur.fetchone() is not None
    out: List[Dict[str, Any]] = []
    for g in giderler:
        pid = str(g.get("personel_id") or "").strip() or "—"
        if depoda_var:
            sinyal_turu = "DEPODA_VAR_FIS_YOK"
            agirlik = 10
        else:
            sinyal_turu = "FIS_EKSIK_DUSUK_RISK"
            agirlik = 4
        acik = (
            f"Fiş yok — gider={g.get('id')} kategori={g.get('kategori')} tutar={float(g.get('tutar') or 0):.0f} TL"
            + (" (depoda hareket var)" if depoda_var else "")
        )
        cur.execute(
            """
            INSERT INTO personel_risk_sinyal
                (id, personel_id, sube_id, tarih, sinyal_turu, agirlik, aciklama, referans_id)
            VALUES (%s, %s, %s, %s::date, %s, %s, %s, %s)
            """,
            (str(__import__("uuid").uuid4()), pid, sid, tg, sinyal_turu, agirlik, acik[:1800], str(g.get("id") or "")),
        )
        out.append(
            {
                "id": None,
                "personel_id": pid,
                "sube_id": sid,
                "tarih": tg,
                "sinyal_turu": sinyal_turu,
                "agirlik": agirlik,
                "referans_id": str(g.get("id") or ""),
            }
        )
    return out

