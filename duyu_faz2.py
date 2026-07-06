"""
FAZ 2 DUYULARI — KAYIT DİSİPLİNİ ÜÇLÜSÜ (2026-07-06, 5-YZ birleşik karar sırası)

Üç yeni duyu, hepsi Sv0 (kaydet-gösterme): ham veriyi HEP topla, alarm/çıkarım SONRA.
  1) MANUEL AÇIKLAMA YOĞUNLUĞU — serbest-metin açıklamalı kayıt oranı tablo bazında.
     Açıklama yazmak meşrudur; YOĞUNLAŞMASI "süreç kayıt kalıbına sığmıyor" işaretidir.
  2) KAPANIŞ-SONRASI / GERİYE-TARİHLİ KAYIT — NRF klasiği (void-after-close ailesi):
     şube günü kapandıktan SONRA o güne yazılan ciro + iş tarihi geçmiş günde kalan
     kayıtlar (backdate). Her biri meşru olabilir; örüntüyü insan okur.
  3) ÖDEME-TİPİ KARMASI — şube-gün nakit/pos/online karması ham kayıt. Karma kayması
     (under-ringing'in en ucuz gölge sinyali) L4'te öğrenilecek; şimdilik SADECE toplanır.

Sözleşme (feedback_duyu_izole_toplayici_kurali): izole modül · append-only ham
(duyu_olay omurgası, idempotent source_ref) · hata-yutar gece yazıcı · salt-okur uç.
Kimlik YOK: entity_scope=sube/genel; personel alanı şemada zaten yok (kural #15).
occurred_at = iş günü, observed_at = yazım anı (zaman-kesiti sözleşmesi).
Kaldırmak: main.py'den router + gece çağrısını çıkar; omurga verisi yerinde kalır.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

from fastapi import APIRouter, Query

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/duyu", tags=["duyu-faz2"])

# Açıklama alanı taranan tablolar: (tablo, tarih_kolonu) — hepsi 'aciklama' + 'olusturma'
# taşır. DİKKAT: anlik_giderler şube kolonu 'sube' (sube_id DEĞİL — bilinen tuzak).
_ACIKLAMA_TABLOLARI = (
    ("kasa_hareketleri", "tarih"),
    ("ciro", "tarih"),
    ("anlik_giderler", "tarih"),
)


# ── 1) MANUEL AÇIKLAMA YOĞUNLUĞU ─────────────────────────────────────────────
def _aciklama_yogunlugu_hesapla(cur, gun_bas: date, gun_bit: date) -> list:
    """[{tablo, gun, toplam, aciklamali, oran}] — gün×tablo kesiti, salt-okur."""
    satirlar = []
    for tablo, tarih_kol in _ACIKLAMA_TABLOLARI:
        cur.execute(
            f"""
            SELECT {tarih_kol}::text AS gun,
                   COUNT(*)::int AS toplam,
                   COUNT(*) FILTER (WHERE NULLIF(TRIM(aciklama), '') IS NOT NULL)::int AS aciklamali
            FROM {tablo}
            WHERE {tarih_kol} BETWEEN %s AND %s
            GROUP BY {tarih_kol} ORDER BY {tarih_kol}
            """,
            (str(gun_bas), str(gun_bit)),
        )
        for r in cur.fetchall() or []:
            d = dict(r)
            top, acik = int(d["toplam"] or 0), int(d["aciklamali"] or 0)
            satirlar.append({
                "tablo": tablo, "gun": d["gun"], "toplam": top, "aciklamali": acik,
                "oran": round(acik / top, 3) if top else 0.0,
            })
    return satirlar


def gece_aciklama_yogunlugu() -> None:
    """GECE: dünün tablo-bazlı açıklama yoğunluğunu omurgaya yaz. İdempotent, hata-yutar."""
    from duyu_omurga import duyu_nabiz_yaz, duyu_olay_yaz
    try:
        dun = date.today() - timedelta(days=1)
        with db() as (_, cur):
            satirlar = _aciklama_yogunlugu_hesapla(cur, dun, dun)
        uretilen = 0
        for s in satirlar:
            if s["toplam"] == 0:
                continue
            duyu_olay_yaz(
                "aciklama_yogunlugu", "operasyon.kayit.manuel_aciklama_kesiti",
                f"{s['tablo']}_{s['gun']}",
                entity_scope="genel", occurred_at=s["gun"],
                signal_name="Günlük manuel açıklama kesiti",
                payload={"tablo": s["tablo"], "toplam": s["toplam"],
                         "aciklamali": s["aciklamali"], "oran": s["oran"]},
            )
            uretilen += 1
        duyu_nabiz_yaz("aciklama_yogunlugu", taranan=len(satirlar), uretilen=uretilen)
    except Exception as e:  # noqa: BLE001
        logger.warning("gece aciklama yogunlugu yutuldu: %s", str(e)[:120])
        duyu_nabiz_yaz("aciklama_yogunlugu", durum="hata", yutulan_hata=1,
                       not_metin=str(e)[:200])


# ── 2) KAPANIŞ-SONRASI + GERİYE-TARİHLİ KAYIT ────────────────────────────────
def _kapanis_sonrasi_hesapla(cur, gun: date) -> list:
    """Şube günü KAPANIŞ tamamlandıktan sonra o güne yazılan ciro kayıtları.
    cevap_ts yoksa (kapanış cevaplanmamış) o şube-gün ölçülemez — 'veri_yok' dürüstlüğü."""
    cur.execute(
        """
        -- Denetim P3-11: aynı şube-günde birden çok KAPANIS olabilir (sira_no) —
        -- şube başına SON kapanış esas alınır, yoksa satırlar aynı source_ref'te çakışıp
        -- ilki hariç sessizce yutulurdu
        WITH son_kapanis AS (
            SELECT sube_id, MAX(cevap_ts) AS cevap_ts
            FROM sube_operasyon_event
            WHERE tarih = %s AND tip = 'KAPANIS' AND cevap_ts IS NOT NULL
            GROUP BY sube_id
        )
        SELECT s.ad AS sube_ad, e.sube_id,
               e.cevap_ts::text AS kapanis_ts,
               COUNT(c.id) FILTER (WHERE c.olusturma > e.cevap_ts)::int AS sonrasi_n,
               COALESCE(SUM(c.toplam) FILTER (WHERE c.olusturma > e.cevap_ts), 0) AS sonrasi_tutar,
               ROUND((EXTRACT(EPOCH FROM MAX(c.olusturma - e.cevap_ts)
                     FILTER (WHERE c.olusturma > e.cevap_ts)) / 60.0)::numeric, 1) AS max_gecikme_dk
        FROM son_kapanis e
        JOIN subeler s ON s.id = e.sube_id
        LEFT JOIN ciro c ON c.sube_id = e.sube_id AND c.tarih = %s AND c.durum = 'aktif'
        GROUP BY s.ad, e.sube_id, e.cevap_ts
        """,
        (str(gun), str(gun)),
    )
    return [dict(r) for r in (cur.fetchall() or [])]


def _geriye_tarihli_hesapla(cur, yazim_gunu: date) -> list:
    """Dün OLUŞTURULAN ama iş tarihi daha eski güne ait kayıtlar (backdate).
    Meşru olabilir (unutulan fiş sonradan girilir) — sayı ve gecikme toplanır, hüküm yok."""
    satirlar = []
    for tablo, tarih_kol in _ACIKLAMA_TABLOLARI:
        cur.execute(
            f"""
            SELECT COUNT(*)::int AS n,
                   MAX((olusturma::date - {tarih_kol}))::int AS max_gecikme_gun
            FROM {tablo}
            WHERE olusturma::date = %s AND {tarih_kol} < %s
            """,
            (str(yazim_gunu), str(yazim_gunu)),
        )
        d = dict(cur.fetchone() or {})
        if int(d.get("n") or 0) > 0:
            satirlar.append({"tablo": tablo, "n": int(d["n"]),
                             "max_gecikme_gun": int(d.get("max_gecikme_gun") or 0)})
    return satirlar


def gece_kapanis_sonrasi_kayit() -> None:
    """GECE: dünün kapanış-sonrası ciro kayıtları + geriye-tarihli yazımlar → omurga."""
    from duyu_omurga import duyu_nabiz_yaz, duyu_olay_yaz
    try:
        dun = date.today() - timedelta(days=1)
        with db() as (_, cur):
            kapanis = _kapanis_sonrasi_hesapla(cur, dun)
            backdate = _geriye_tarihli_hesapla(cur, dun)
        uretilen = 0
        for k in kapanis:
            if int(k.get("sonrasi_n") or 0) == 0:
                continue
            duyu_olay_yaz(
                "kapanis_sonrasi", "operasyon.kayit.kapanis_sonrasi_ciro",
                f"{k['sube_id']}_{dun}",
                entity_scope="sube", entity_id=str(k["sube_id"]), occurred_at=str(dun),
                signal_name="Kapanış sonrası ciro kaydı",
                payload={"sube_ad": k.get("sube_ad"), "adet": int(k["sonrasi_n"]),
                         "tutar": float(k.get("sonrasi_tutar") or 0),
                         "kapanis_ts": k.get("kapanis_ts"),
                         # Gecikme dağılımı L4 hammaddesi: kapanıştan dakikalar sonra
                         # girilen rutin ciro ile saatler sonra gelen kayıt ayrışabilsin
                         "max_gecikme_dk": float(k["max_gecikme_dk"]) if k.get("max_gecikme_dk") is not None else None},
            )
            uretilen += 1
        for b in backdate:
            duyu_olay_yaz(
                "kapanis_sonrasi", "operasyon.kayit.geriye_tarihli_yazim",
                f"{b['tablo']}_{dun}",
                entity_scope="genel", occurred_at=str(dun),
                signal_name="Geriye tarihli kayıt günü",
                payload=b,
            )
            uretilen += 1
        duyu_nabiz_yaz("kapanis_sonrasi", taranan=len(kapanis) + len(backdate),
                       uretilen=uretilen)
    except Exception as e:  # noqa: BLE001
        logger.warning("gece kapanis-sonrasi yutuldu: %s", str(e)[:120])
        duyu_nabiz_yaz("kapanis_sonrasi", durum="hata", yutulan_hata=1,
                       not_metin=str(e)[:200])


# ── 3) ÖDEME-TİPİ KARMASI ────────────────────────────────────────────────────
def _odeme_karmasi_hesapla(cur, gun_bas: date, gun_bit: date) -> list:
    cur.execute(
        """
        SELECT s.ad AS sube_ad, c.sube_id, c.tarih::text AS gun,
               SUM(c.nakit) AS nakit, SUM(c.pos) AS pos, SUM(c.online) AS online,
               SUM(c.toplam) AS toplam
        FROM ciro c JOIN subeler s ON s.id = c.sube_id
        WHERE c.tarih BETWEEN %s AND %s AND c.durum = 'aktif'
        GROUP BY s.ad, c.sube_id, c.tarih
        ORDER BY c.tarih, s.ad
        """,
        (str(gun_bas), str(gun_bit)),
    )
    out = []
    for r in cur.fetchall() or []:
        d = dict(r)
        top = float(d.get("toplam") or 0)
        out.append({
            "sube_ad": d["sube_ad"], "sube_id": d["sube_id"], "gun": d["gun"],
            "nakit": float(d.get("nakit") or 0), "pos": float(d.get("pos") or 0),
            "online": float(d.get("online") or 0), "toplam": top,
            "nakit_oran": round(float(d.get("nakit") or 0) / top, 3) if top else None,
        })
    return out


def gece_odeme_karmasi() -> None:
    """GECE: dünün şube-gün ödeme karması → omurga (ham kayıt; kayma analizi L4'te)."""
    from duyu_omurga import duyu_nabiz_yaz, duyu_olay_yaz
    try:
        dun = date.today() - timedelta(days=1)
        with db() as (_, cur):
            satirlar = _odeme_karmasi_hesapla(cur, dun, dun)
        for s in satirlar:
            duyu_olay_yaz(
                "odeme_karmasi", "finans.ciro.odeme_karmasi_kesiti",
                f"{s['sube_id']}_{s['gun']}",
                entity_scope="sube", entity_id=str(s["sube_id"]), occurred_at=s["gun"],
                signal_name="Günlük ödeme-tipi karması",
                payload={k: s[k] for k in ("sube_ad", "nakit", "pos", "online",
                                           "toplam", "nakit_oran")},
            )
        duyu_nabiz_yaz("odeme_karmasi", taranan=len(satirlar), uretilen=len(satirlar))
    except Exception as e:  # noqa: BLE001
        logger.warning("gece odeme karmasi yutuldu: %s", str(e)[:120])
        duyu_nabiz_yaz("odeme_karmasi", durum="hata", yutulan_hata=1,
                       not_metin=str(e)[:200])


# ── 4) ADET-TUTAR / ZIMNİ FİYAT (under-ringing doğrudan gölgesi) ─────────────
# Evo şube×ürün×gün adet+ciro'dan ZIMNİ birim fiyat türetilir (ciro/adet). Aynı ürünün
# zımni fiyatı menü fiyatının altına kayıyorsa "ucuz tuşlama" (under-ringing) GÖLGESİ
# düşer — hüküm değil: kampanya/ikram/iskonto da aynı gölgeyi yapar, ayrımı insan/L4 yapar.
# Menü karşılaştırması tv_menu'den (f8/f14/fice — Evo grubu kolonu seçer) ADAY düzeyinde.
_GRUP_FIYAT_KOLONU = {"8 oz": "f8", "14 oz": "f14", "ice": "fice"}
_TR_FOLD = str.maketrans("çğıöşüÇĞİÖŞÜI", "cgiosucgiosui")


def _katla(t: str) -> str:
    return (t or "").translate(_TR_FOLD).lower().strip()


def _menu_fiyat_haritasi(cur) -> dict:
    """{katlanmış tv_menu adı: {f8, f14, fice}} — salt-okur, hata durumunda boş."""
    try:
        cur.execute("SELECT ad, f8, f14, fice FROM tv_menu WHERE aktif = TRUE")
        return {_katla(str(dict(r)["ad"])): dict(r) for r in (cur.fetchall() or [])}
    except Exception:  # noqa: BLE001
        return {}


def _menu_eslestir(menu: dict, urun_ad: str, grup: str):
    """Evo ürün adı → tv_menu fiyatı (ADAY: isim katlamalı içerme, tek eşleşme şartı).
    Evo adı boy/soğukluk taşır ('Americano Ice'), menü adı çıplaktır ('Americano')."""
    kol = _GRUP_FIYAT_KOLONU.get(_katla(grup))
    if not kol:
        return None  # Su/Pasta gibi gruplar: menüde tek fiyat kolonu yok — karşılaştırma yapılmaz
    u = _katla(urun_ad)
    adaylar = [(ad, kayit) for ad, kayit in menu.items() if ad and (ad in u or u in ad)]
    if len(adaylar) != 1:
        return None  # 0 veya çok eşleşme = güvenilmez, aday bile değil
    fiyat = adaylar[0][1].get(kol)
    return float(fiyat) if fiyat is not None else None


def _zimni_fiyat_hesapla(gun: date) -> list:
    """[{sube_id, sube_ad, urunler:[...], sapma_adaylari:[...]}] — Evo cok_satilan'dan.
    Evo erişilemezse boş liste (cache fallback evo_sync içinde)."""
    from evo_sync import EVO_KDV_CARPAN, evvel_sube_evo_id_eslestir, hs_rapor_sube_bazli_cached
    evo = hs_rapor_sube_bazli_cached(gun, gun)
    evo_subeler = evo.get("subeler") or {}
    if not evo_subeler:
        return []
    with db() as (_, cur):
        cur.execute("SELECT id, ad FROM subeler WHERE aktif = TRUE")
        yerel = [dict(r) for r in (cur.fetchall() or [])]
        menu = _menu_fiyat_haritasi(cur)
    # Evo şube id → yerel şube (T5 tek merkez eşleştirici)
    evo_id_yerel = {}
    for sb in yerel:
        eid = evvel_sube_evo_id_eslestir(str(sb["ad"]))
        if eid is not None:
            evo_id_yerel[str(eid)] = sb
    out = []
    for _evo_ad, sd in evo_subeler.items():
        yer = evo_id_yerel.get(str(sd.get("evo_sube_id") or ""))
        if not yer:
            continue
        urunler, sapmalar = [], []
        for u in (sd.get("cok_satilan") or [])[:40]:
            try:
                adet = float(u.get("adet") or 0)
                ciro = float(u.get("ciro") or 0)
            except (TypeError, ValueError):
                continue
            if adet <= 0:
                continue
            zimni = round(ciro / adet, 2)                      # KDV hariç ham
            liste_tahmin = round(zimni * EVO_KDV_CARPAN, 2)    # menüyle aynı dil (KDV dahil)
            kayit = {"ad": u.get("ad"), "grup": u.get("grup"), "adet": adet,
                     "ciro": ciro, "zimni": zimni, "liste_tahmin": liste_tahmin}
            menu_f = _menu_eslestir(menu, str(u.get("ad") or ""), str(u.get("grup") or ""))
            if menu_f:
                kayit["menu_fiyat"] = menu_f
                oran = round((liste_tahmin - menu_f) / menu_f, 3)
                kayit["sapma_oran"] = oran
                if abs(oran) > 0.10:  # aday eşiği: %10 üstü sapmaları AYRICA listele (gizleme yok)
                    sapmalar.append({"ad": u.get("ad"), "grup": u.get("grup"),
                                     "liste_tahmin": liste_tahmin, "menu_fiyat": menu_f,
                                     "sapma_oran": oran, "adet": adet})
            urunler.append(kayit)
        out.append({"sube_id": yer["id"], "sube_ad": yer["ad"], "gun": str(gun),
                    "urun_n": len(urunler), "urunler": urunler,
                    "menu_eslesen_n": sum(1 for x in urunler if "menu_fiyat" in x),
                    "sapma_adaylari": sapmalar,
                    "canli": bool(evo.get("canli"))})
    return out


def gece_adet_tutar() -> None:
    """GECE: dünün şube×ürün zımni fiyat kesiti → omurga. İdempotent, hata-yutar."""
    from duyu_omurga import duyu_nabiz_yaz, duyu_olay_yaz
    try:
        dun = date.today() - timedelta(days=1)
        kesitler = _zimni_fiyat_hesapla(dun)
        for k in kesitler:
            duyu_olay_yaz(
                "adet_tutar", "finans.satis.zimni_fiyat_kesiti",
                f"{k['sube_id']}_{k['gun']}",
                entity_scope="sube", entity_id=str(k["sube_id"]), occurred_at=k["gun"],
                signal_name="Günlük zımni birim fiyat kesiti",
                # Menü sapması ADAY dilindedir: kampanya/ikram/yeni fiyat da aynı izi bırakır
                confidence=1.0,
                payload={kk: k[kk] for kk in ("sube_ad", "urun_n", "urunler",
                                              "menu_eslesen_n", "sapma_adaylari", "canli")},
            )
        duyu_nabiz_yaz("adet_tutar", taranan=len(kesitler), uretilen=len(kesitler))
    except Exception as e:  # noqa: BLE001
        logger.warning("gece adet-tutar yutuldu: %s", str(e)[:120])
        duyu_nabiz_yaz("adet_tutar", durum="hata", yutulan_hata=1, not_metin=str(e)[:200])


# ── 5) İADE / FİRE KESİTİ (iade↔stok duyusunun YERLİ yarısı) ─────────────────
# Evo void/refund satırı API'de YOK (bilinçli-bekleme: Evo iade ucu açılırsa tamamlanır).
# Yerli kayıt VAR: sube_fire_bildirim (fire + müşteri iadesi). Kimlik OKUNMAZ.
def _iade_fire_hesapla(cur, gun_bas: date, gun_bit: date) -> list:
    cur.execute(
        """
        SELECT s.ad AS sube_ad, f.sube_id, f.tarih::text AS gun,
               COUNT(*)::int AS bildirim_n,
               COALESCE(SUM(f.toplam_adet), 0)::int AS toplam_adet,
               COUNT(*) FILTER (WHERE f.iade_zaman IS NOT NULL)::int AS iade_n
        FROM sube_fire_bildirim f JOIN subeler s ON s.id = f.sube_id
        WHERE f.tarih BETWEEN %s AND %s
        GROUP BY s.ad, f.sube_id, f.tarih
        ORDER BY f.tarih, s.ad
        """,
        (str(gun_bas), str(gun_bit)),
    )
    return [dict(r) for r in (cur.fetchall() or [])]


def gece_iade_fire() -> None:
    """GECE: dünün şube fire/iade bildirimleri kesiti → omurga."""
    from duyu_omurga import duyu_nabiz_yaz, duyu_olay_yaz
    try:
        dun = date.today() - timedelta(days=1)
        with db() as (_, cur):
            satirlar = _iade_fire_hesapla(cur, dun, dun)
        for s in satirlar:
            duyu_olay_yaz(
                "iade_fire", "stok.fire.bildirim_kesiti",
                f"{s['sube_id']}_{s['gun']}",
                entity_scope="sube", entity_id=str(s["sube_id"]), occurred_at=s["gun"],
                signal_name="Günlük fire/iade bildirim kesiti",
                payload={k: s[k] for k in ("sube_ad", "bildirim_n", "toplam_adet", "iade_n")},
            )
        duyu_nabiz_yaz("iade_fire", taranan=len(satirlar), uretilen=len(satirlar))
    except Exception as e:  # noqa: BLE001
        logger.warning("gece iade-fire yutuldu: %s", str(e)[:120])
        duyu_nabiz_yaz("iade_fire", durum="hata", yutulan_hata=1, not_metin=str(e)[:200])


def gece_faz2_calistir() -> None:
    """Tek giriş noktası — beş duyu sırayla, her biri kendi hatasını yutar."""
    gece_aciklama_yogunlugu()
    gece_kapanis_sonrasi_kayit()
    gece_odeme_karmasi()
    gece_adet_tutar()
    gece_iade_fire()


# ── SALT-OKUR UÇ ─────────────────────────────────────────────────────────────
@router.get("/kayit-disiplini")
def kayit_disiplini(gun: int = Query(14, ge=3, le=60)):
    """Üç duyunun canlı kesiti tek ekranda (omurgadan değil kaynaktan — anlık).
    HÜKÜM YOK: açıklama yazmak, geç girmek, karma değişmesi — hepsi meşru olabilir."""
    bas = date.today() - timedelta(days=gun - 1)
    bugun = date.today()
    with db() as (_, cur):
        aciklama = _aciklama_yogunlugu_hesapla(cur, bas, bugun)
        karma = _odeme_karmasi_hesapla(cur, bas, bugun)
        dun = bugun - timedelta(days=1)
        kapanis_dun = _kapanis_sonrasi_hesapla(cur, dun)
        backdate_dun = _geriye_tarihli_hesapla(cur, bugun)  # bugün yazılan geçmiş-tarihliler
    return {
        "kesit": {"bas": str(bas), "gun": gun},
        "aciklama_yogunlugu": aciklama,
        "odeme_karmasi": karma,
        "kapanis_sonrasi_dun": kapanis_dun,
        "geriye_tarihli_bugun": backdate_dun,
        "not": "Sv0 ham veri — alarm değil. Açıklama yoğunlaşması 'süreç kalıba sığmıyor' "
               "işareti, kapanış-sonrası kayıt ve karma kayması sadece bakılacak yer önerir; "
               "değerlendirme insanındır.",
    }


@router.get("/satis-butunluk")
def satis_butunluk(gun: int = Query(14, ge=3, le=30)):
    """Adet-tutar (zımni fiyat vs menü, DÜN — Evo kaynaklı) + iade/fire kesiti (N gün).
    ADAY dili: sapma = kampanya/ikram/yeni fiyat da olabilir; Evo void/refund satırı
    API'de yok — iade'nin Evo yarısı bilinçli-bekleme'de."""
    dun = date.today() - timedelta(days=1)
    bas = date.today() - timedelta(days=gun - 1)
    try:
        zimni = _zimni_fiyat_hesapla(dun)
    except Exception as e:  # noqa: BLE001
        zimni = []
        logger.warning("satis-butunluk zimni hesap atlandi: %s", str(e)[:120])
    with db() as (_, cur):
        iade = _iade_fire_hesapla(cur, bas, date.today())
    return {
        "kesit": {"zimni_gun": str(dun), "iade_bas": str(bas)},
        "zimni_fiyat": [{k: v for k, v in s.items() if k != "urunler"} | {
            "urun_ornek": (s.get("urunler") or [])[:8]} for s in zimni],
        "iade_fire": iade,
        "not": "Zımni fiyat = ciro/adet (KDV'li tahminle menüye kıyas, ADAY). Sapma "
               "hüküm değildir: kampanya, ikram, fiyat güncellemesi de aynı izi bırakır. "
               "İade/fire yerli bildirimlerden; Evo void/refund ucu yok (bilinçli bekleme).",
    }
