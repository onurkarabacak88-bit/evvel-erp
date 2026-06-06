import logging
import time
import traceback
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi import Request
from pydantic import BaseModel, Field
from typing import Optional, List, Any, Dict
from datetime import date, datetime, timedelta
import uuid, os, json, pathlib, calendar, threading, hashlib
from collections import defaultdict
from database import db, init_db, ensure_stok_yolda_columns, ensure_dusum_modu, ensure_operasyon_event_durum_latent, ensure_rapor_kapanis, ensure_kart_kategori_columns, ensure_kart_ekstre_donem, ensure_kart_satici_kural, ensure_kart_devir_islem_turu
from operasyon_stok_motor import eksik_kullanim_kontrol, tum_subeler_skor_guncelle
from tr_saat import bugun_tr, dt_now_tr_naive
from kasa_service import (
    audit,
    insert_kasa_hareketi,
    iptal_kasa_hareketi,
    kart_plan_guncelle_tx,
    onay_ekle,
    vadeli_alim_kapat,
    vadeli_kasadan_odenen_toplam,
)
from sube_panel import router as sube_panel_router
from ciro_taslak_api import router as ciro_taslak_router
from sube_operasyon import router as sube_operasyon_router
from sube_kapanis_dual import router as sube_kapanis_dual_router
from operasyon_merkez_api import router as operasyon_merkez_router
from sube_personel_api import router as sube_personel_router
from banka_yatirim_api import router as banka_yatirim_router
from kasa_teslim_api import router as kasa_teslim_router
from tedarikci_api import router as tedarikci_router
from odeme_plani_motor_api import router as odeme_plani_motor_router
from odeme_plani_api import router as odeme_plani_read_router
from evo_sync import router as evo_sync_router
from kart_analiz import router as kart_analiz_router
import vardiya_v2 as _vv2
from vardiya_v2 import _ad_soyad_split as _vardiya_personel_ad_split


def ay_ekle(d: date, ay: int) -> date:
    """dateutil.relativedelta gerektirmeden tarihe ay ekler. Ay sonu taşmalarını düzeltir."""
    yil = d.year + (d.month - 1 + ay) // 12
    ay_no = (d.month - 1 + ay) % 12 + 1
    gun = min(d.day, calendar.monthrange(yil, ay_no)[1])
    return date(yil, ay_no, gun)
from motors import (
    karar_motoru,
    odeme_strateji_motoru,
    nakit_akis_simulasyon,
    guncel_kasa,
    kasa_detay,
    kart_analiz_hesapla,
    aylik_odeme_plani_uret, kart_kesim_plan_tetikle,
    uyari_motoru,
    finans_ozet_motoru,
    uyari_cache_clear,
)
from finans_core import (
    kart_borc, kasa_bakiyesi, kasa_bakiyesi_tarihte,
    kart_ekstre, kart_bu_ay_odenen, kart_faiz_tahmini,
    kart_asgari_orani,
    faiz_hesapla_ve_yaz, tum_kartlar_faiz_hesapla,
    taksit_detay, gelecek_taksit_yuku, tum_kartlar_taksit_yuku,
    kart_ekstre_forecast, tum_kartlar_ekstre_forecast, kart_aktif_donem,
    aktif_kesim_gunu, nakit_akis_sim, nakit_akis_tahmin_dogruluk,
)

app = FastAPI(title="EVVEL ERP", version="2.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(sube_panel_router)
app.include_router(ciro_taslak_router)
app.include_router(sube_operasyon_router)
app.include_router(sube_kapanis_dual_router)
app.include_router(operasyon_merkez_router)
app.include_router(sube_personel_router)
app.include_router(banka_yatirim_router)
app.include_router(kasa_teslim_router)
app.include_router(tedarikci_router)
app.include_router(odeme_plani_motor_router)
app.include_router(odeme_plani_read_router)
app.include_router(evo_sync_router)
app.include_router(kart_analiz_router)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)s | %(message)s',
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger("evvel-erp")

@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.time()
    response = await call_next(request)
    ms = round((time.time() - start) * 1000)
    logger.info(f"{request.method} {request.url.path} → {response.status_code} ({ms}ms)")
    return response


@app.exception_handler(Exception)
async def hata_yakala(request: Request, exc: Exception):
    tb = traceback.format_exc()
    logger.error(f"HATA: {request.url.path}\n{tb}")
    # Hata ayıklama için tarayıcıya da özet ver (üretimde güvenli: sadece mesaj + ilk trace satırı)
    return JSONResponse(
        status_code=500,
        content={
            "detail": f"{type(exc).__name__}: {str(exc)}",
            "path": str(request.url.path),
            "trace": tb.splitlines()[-6:] if tb else [],
        }
    )


# ── GECE YARISI SCHEDULER ──────────────────────────────────────
def _gece_yarisi_scheduler():
    """
    Her gece yarısı çalışır. Restart bağımlılığını kaldırır.
    - Ay başı: aylık ödeme planı üret
    - Ay sonu: faiz hesapla
    - Her gece: kasa anomali kontrolü
    """
    import time as _time

    logger.info("🕐 Scheduler thread aktif")

    while True:
        try:
            # Bir sonraki İstanbul gece yarısına kadar bekle
            bugu = bugun_tr()
            yarin = datetime.combine(bugu + timedelta(days=1), datetime.min.time())
            bekle = (yarin - dt_now_tr_naive()).total_seconds()
            _time.sleep(max(bekle, 60))  # en az 60 saniye

            bugun = bugun_tr()
            ay_son_gun = calendar.monthrange(bugun.year, bugun.month)[1]

            # Ay başı — sabit gider, maaş, taksit vs. (kart asgarisi HARİÇ;
            # kart asgarisi her kartın kendi kesim gününde tetiklenir)
            if bugun.day == 1:
                try:
                    sonuc = aylik_odeme_plani_uret(bugun.year, bugun.month)
                    logger.info(f"⏰ Scheduler: Aylık plan üretildi — {sonuc.get('toplam', 0)} kayıt")
                except Exception as e:
                    logger.error(f"⏰ Scheduler plan hatası: {e}")

            # KART BAZLI KESİM TETİKLEYİCİ — her gece tüm kartları yokla,
            # bugün kesim olan varsa o kart için ekstre planı üret/güncelle.
            # Hafta sonu/tatil kayması motorun içindedir.
            try:
                ks = kart_kesim_plan_tetikle()
                if ks.get("tetiklenen"):
                    logger.info(f"⏰ Scheduler: Kart kesim tetiklendi — {len(ks['tetiklenen'])} kart")
            except Exception as e:
                logger.error(f"⏰ Scheduler kart kesim hatası: {e}")

            # FAİZ — her gece tüm kartlar yoklanır.
            # faiz_hesapla_ve_yaz her kart için kendi kesim/son_odeme döngüsünü
            # değerlendirir. Son ödeme tarihi geçen ve faizi henüz yazılmamış
            # kartlara faiz işler. Diğerleri 'henuz_kapanmis_kesim_yok' /
            # 'zaten_yazilmis' / 'tam_odendi' döner ve atlanır.
            try:
                with db() as (conn, cur):
                    sonuclar = tum_kartlar_faiz_hesapla(cur)
                yazilan = sum(1 for k in sonuclar if k.get('durum') == 'yazildi')
                if yazilan > 0:
                    logger.info(f"⏰ Scheduler: Faiz üretildi — {yazilan} kart")
            except Exception as e:
                logger.error(f"⏰ Scheduler faiz hatası: {e}")

            # Her gece — kasa anomali kontrolü
            try:
                with db() as (conn, cur):
                    cur.execute("SELECT COUNT(*) as sorunlu FROM v_kasa_anomali WHERE durum != 'OK'")
                    sorunlu = cur.fetchone()['sorunlu']
                    if sorunlu > 0:
                        logger.warning(f"⏰ Scheduler: {sorunlu} kasa anomali tespit edildi")
            except Exception as e:
                logger.warning(f"⏰ Scheduler anomali kontrol hatası: {e}")

            try:
                with db() as (conn, cur):
                    eksik_kullanim_kontrol(cur)
                    sk = tum_subeler_skor_guncelle(cur)
                    conn.commit()
                if sk:
                    logger.info(f"⏰ Scheduler: eksik kullanım + şube skor güncellendi ({len(sk)} şube)")
            except Exception as e:
                logger.warning(f"⏰ Scheduler stok davranış / skor hatası: {e}")

            # Pazartesi — geçen haftanın kalem bazlı fire raporu
            if bugun.weekday() == 0:  # 0 = Pazartesi
                try:
                    from operasyon_stok_motor import haftalik_fire_hesapla
                    gecen_hf_basi = bugun - timedelta(days=7)
                    with db() as (conn, cur):
                        cur.execute("SELECT id FROM subeler WHERE aktif=TRUE")
                        sube_ids = [r["id"] for r in cur.fetchall()]
                    yazilan = 0
                    for sid in sube_ids:
                        try:
                            with db() as (conn, cur):
                                r = haftalik_fire_hesapla(cur, sid, gecen_hf_basi)
                                conn.commit()
                            if r.get("yazildi"):
                                yazilan += 1
                        except Exception as _e:
                            logger.warning(f"⏰ Fire haftalık {sid}: {_e}")
                    logger.info(f"⏰ Scheduler: Haftalık fire hesaplandı — {yazilan}/{len(sube_ids)} şube")
                except Exception as e:
                    logger.warning(f"⏰ Scheduler haftalık fire hatası: {e}")

            # ── RAPOR CACHE — gecelik özet batch (defensive) ──
            try:
                from rapor_cache import (
                    gunluk_ozet_topla_tum_subeler, aylik_food_cost_hesapla,
                    batch_log_basla, batch_log_bitir,
                )
                import time as _tm
                _t0 = _tm.time()
                dun = bugun - timedelta(days=1)
                bid = None
                with db() as (conn, cur):
                    bid = batch_log_basla(cur, 'gunluk_ozet',
                                          {'tarih': str(dun), 'sebep': 'gece_scheduler'})
                    conn.commit()
                with db() as (conn, cur):
                    sayac_dun = gunluk_ozet_topla_tum_subeler(cur, dun)
                    sayac_bugun = gunluk_ozet_topla_tum_subeler(cur, bugun)
                    conn.commit()
                # Aylık food cost — bu ay + ay başında geçen ay
                ym_bu = bugun.strftime("%Y-%m")
                with db() as (conn, cur):
                    aylik_food_cost_hesapla(cur, ym_bu)
                    if bugun.day <= 3:
                        ym_oncesi = (bugun.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
                        aylik_food_cost_hesapla(cur, ym_oncesi)
                    conn.commit()
                with db() as (conn, cur):
                    batch_log_bitir(cur, bid,
                                    islenen=sayac_dun + sayac_bugun,
                                    sure_ms=int((_tm.time() - _t0) * 1000),
                                    detay={'dun': sayac_dun, 'bugun': sayac_bugun, 'ym': ym_bu})
                    conn.commit()
                logger.info(f"⏰ Rapor cache: dün={sayac_dun} bugün={sayac_bugun} aylık={ym_bu}")
            except Exception as e:
                logger.warning(f"⏰ Scheduler rapor cache hatası: {e}")

            # ── OPERASYON EVENT — bugünün açılış/kapanış satırları ──
            # Gece yarısı (00:00–02:00) is_gunu_tr() hâlâ ÖNCEKİ iş gününü döndürür
            # (kapanış 02:00'a kadar düne sayılır). Bu yüzden bugünün satırlarını
            # 02:30'da oluştururuz — o saatte is_gunu_tr() = bugün. Dashboard (ensure=False)
            # bu satırları hazır bulur. Idempotent; restart olursa startup telafi eder.
            try:
                hedef = datetime.combine(bugun_tr(), datetime.min.time()) + timedelta(hours=2, minutes=30)
                _bekle2 = (hedef - dt_now_tr_naive()).total_seconds()
                if _bekle2 > 0:
                    _time.sleep(_bekle2)
                from sube_operasyon import ensure_events_tum_subeler
                with db() as (conn, cur):
                    _ne = ensure_events_tum_subeler(cur)
                    conn.commit()
                logger.info(f"⏰ Scheduler: operasyon event satırları oluşturuldu — {_ne} şube")
            except Exception as e:
                logger.warning(f"⏰ Scheduler operasyon event hatası: {e}")

        except Exception as e:
            logger.error(f"⏰ Scheduler genel hata: {e}")
            import time as _t
            _t.sleep(300)  # hata olursa 5 dakika bekle, tekrar dene

@app.on_event("startup")
def startup():
    init_db()
    try:
        with db() as (conn, cur):
            ensure_stok_yolda_columns(cur)
    except Exception as e:
        logger.warning("stok_yolda kolon migrasyonu (startup): %s", e)
    try:
        with db() as (conn, cur):
            ensure_dusum_modu(cur)
    except Exception as e:
        logger.warning("dusum_modu migrasyonu (startup): %s", e)
    try:
        with db() as (conn, cur):
            ensure_kart_kategori_columns(cur)
    except Exception as e:
        logger.warning("kart kategori (harcama_tipi/sahip) migrasyonu (startup): %s", e)
    try:
        with db() as (conn, cur):
            ensure_kart_ekstre_donem(cur)
    except Exception as e:
        logger.warning("kart_ekstre_donem migrasyonu (startup): %s", e)
    try:
        with db() as (conn, cur):
            ensure_kart_satici_kural(cur)
    except Exception as e:
        logger.warning("kart_satici_kural migrasyonu (startup): %s", e)
    try:
        with db() as (conn, cur):
            ensure_kart_devir_islem_turu(cur)
    except Exception as e:
        logger.warning("kart_devir_islem_turu migrasyonu (startup): %s", e)
    try:
        with db() as (conn, cur):
            ensure_operasyon_event_durum_latent(cur)
    except Exception as e:
        logger.warning("operasyon_event durum=latent migrasyonu (startup): %s", e)
    try:
        with db() as (conn, cur):
            ensure_rapor_kapanis(cur)
    except Exception as e:
        logger.warning("rapor_kapanis migrasyonu (startup): %s", e)
    # Her başlatmada bu ay için plan üret (yoksa üretir, varsa atlar)
    bugun = bugun_tr()
    try:
        sonuc = aylik_odeme_plani_uret(bugun.year, bugun.month)
        if sonuc['toplam'] > 0:
            logger.info(f"✅ Aylık ödeme planı üretildi: {sonuc['toplam']} kayıt")
        else:
            logger.info(f"ℹ️ Bu ay için ödeme planı zaten mevcut")
    except Exception as e:
        logger.error(f"Ödeme planı üretim hatası: {e}")
    # FAİZ — startup'ta da bir kez yokla. faiz_hesapla_ve_yaz her kart için
    # kendi kesim/son_odeme döngüsünü değerlendirir, son ödeme tarihi geçen
    # ve faizi henüz yazılmamış kartlara faiz işler. Ayrı "ay sonu" veya
    # "kaçırılan telafi" bloklarına gerek yok — guard hem ileriye hem geriye
    # bakar (downtime sonrası restart de telafi olur).
    try:
        with db() as (conn, cur):
            sonuclar = tum_kartlar_faiz_hesapla(cur)
        yazilan = sum(1 for k in sonuclar if k.get('durum') == 'yazildi')
        if yazilan > 0:
            logger.info(f"✅ Faiz yoklaması: {yazilan} kart için faiz yazıldı")
    except Exception as e:
        logger.warning(f"Faiz yoklama hatası: {e}")

    # Kasa tutarlılık kontrolü — hata vermez, sadece uyarı loglar
    try:
        with db() as (conn, cur):
            cur.execute("SELECT COUNT(*) as sorunlu FROM v_kasa_anomali WHERE durum != 'OK'")
            sorunlu = cur.fetchone()['sorunlu']
            if sorunlu > 0:
                logger.warning(f"⚠️ KASA ANOMALİ: {sorunlu} ciro kaydının kasa karşılığı eksik. /api/kasa-kontrol ile kontrol et.")
            else:
                logger.info("✅ Kasa tutarlılık kontrolü: Tüm ciro kayıtları kasa'ya yansımış.")
    except Exception as e:
        logger.warning(f"Kasa kontrol yapılamadı: {e}")

    # Operasyon event satırları (bugünün ACILIS/KAPANIS) — startup'ta garantile.
    # Böylece dashboard salt-okuma (ensure=False) ile çalışsa bile satırlar hazır olur.
    # is_gunu_tr() startup anında doğru iş gününü döndürür.
    try:
        from sube_operasyon import ensure_events_tum_subeler
        with db() as (conn, cur):
            _n = ensure_events_tum_subeler(cur)
            conn.commit()
        logger.info(f"✅ Operasyon event satırları garanti edildi: {_n} şube")
    except Exception as e:
        logger.warning(f"Operasyon event ensure (startup) hatası: {e}")

    # Jenerik 'Kapak' (kapak_adet) merkez katalogdan kaldırıldı — ayrıştırılmış kapaklar
    # (8oz/14oz/plastik) kalır. Mevcut satırı temizle (idempotent; seed artık eklemiyor).
    try:
        with db() as (conn, cur):
            cur.execute("DELETE FROM merkez_stok_kart WHERE kalem_kodu='kapak_adet'")
            cur.execute("DELETE FROM sube_depo_stok WHERE kalem_kodu='kapak_adet'")
            conn.commit()
    except Exception as e:
        logger.warning(f"kapak_adet katalog temizliği (startup): {e}")

    # Scheduler başlat — restart bağımlılığını kaldırır
    _scheduler_thread = threading.Thread(target=_gece_yarisi_scheduler, daemon=True)
    _scheduler_thread.start()
    logger.info("✅ Gece yarısı scheduler başlatıldı")

def guncelle_borc_envanteri_odeme_plani_sonrasi(cur, plan: dict, ana_para_kismi: float):
    """Kaynak borc_envanteri ise kalan_vade ve toplam_borc güncelle (panel /ode ve onay kuyruğu ortak)."""
    if plan.get('kaynak_tablo') != 'borc_envanteri' or not plan.get('kaynak_id'):
        return
    cur.execute("SELECT * FROM borc_envanteri WHERE id=%s", (plan['kaynak_id'],))
    borc = cur.fetchone()
    if not borc:
        return
    yeni_kalan = (borc['kalan_vade'] - 1) if borc['kalan_vade'] is not None else None
    yeni_toplam = max(0, float(borc['toplam_borc'] or 0) - ana_para_kismi)
    cur.execute("""
        UPDATE borc_envanteri
        SET kalan_vade = %s,
            toplam_borc = %s
        WHERE id = %s
    """, (yeni_kalan, yeni_toplam, plan['kaynak_id']))


def kasa_ve_faiz_odeme_plani_tam_odeme(
    cur, plan: dict, plan_id: str, odenen: float, tarih: str,
    anapara_aciklama: Optional[str] = None,
) -> float:
    """
    Tam ödeme planı nakit: faiz düşümü + doğru kasa türü (SABIT_GIDER, BORC_TAKSIT, …).
    /ode, onay ODEME_PLANI ve /toplu-odeme aynı fonksiyonu kullanır — tutarsız/çift kasa riski azalır.
    anapara_aciklama: kasa satırı açıklaması (None ise plan.aciklama).
    Dönüş: borç envanteri için anapara kısmı.
    """
    odenen = float(odenen)
    faiz_kismi = 0.0
    if plan.get('kart_id'):
        cur.execute("""
            SELECT COALESCE(SUM(tutar), 0) as bekleyen_faiz
            FROM kart_hareketleri
            WHERE kart_id=%s AND islem_turu='FAIZ' AND durum='aktif'
        """, (plan['kart_id'],))
        bekleyen_faiz = float(cur.fetchone()['bekleyen_faiz'])
        faiz_kismi = min(bekleyen_faiz, odenen)

    ana_para_kismi = odenen - faiz_kismi

    if faiz_kismi > 0:
        insert_kasa_hareketi(cur, tarih, 'KART_FAIZ', -abs(faiz_kismi),
            f"Kart faiz ödemesi: {plan['aciklama']}", 'odeme_plani', plan_id,
            f"{plan_id}_faiz", 'KART_FAIZ')
        kalan_faiz_kapatilacak = faiz_kismi
        # FOR UPDATE: eş zamanlı iki ödeme isteğinde aynı faiz satırlarının
        # çakışmasını önler — satırlar bu transaction bitene kadar kilitlenir.
        cur.execute("""
            SELECT id, tutar FROM kart_hareketleri
            WHERE kart_id=%s AND islem_turu='FAIZ' AND durum='aktif'
            ORDER BY tarih ASC
            FOR UPDATE
        """, (plan['kart_id'],))
        faiz_kayitlari = cur.fetchall()
        for fk in faiz_kayitlari:
            if kalan_faiz_kapatilacak <= 0:
                break
            fk_tutar = float(fk['tutar'])
            if fk_tutar <= kalan_faiz_kapatilacak:
                cur.execute("UPDATE kart_hareketleri SET durum='iptal' WHERE id=%s", (fk['id'],))
                kalan_faiz_kapatilacak -= fk_tutar
            else:
                cur.execute("UPDATE kart_hareketleri SET durum='iptal' WHERE id=%s", (fk['id'],))
                kalan_tutar = fk_tutar - kalan_faiz_kapatilacak
                cur.execute("""INSERT INTO kart_hareketleri
                    (id, kart_id, tarih, islem_turu, tutar, aciklama)
                    VALUES (%s, %s, %s, 'FAIZ', %s, 'Kısmi faiz bakiyesi')
                """, (str(uuid.uuid4()), plan['kart_id'], tarih, kalan_tutar))
                kalan_faiz_kapatilacak = 0

    if ana_para_kismi > 0:
        aciklama_ana = anapara_aciklama if anapara_aciklama is not None else plan['aciklama']
        kaynak = plan.get('kaynak_tablo') or ''
        if kaynak == 'sabit_giderler':
            islem_t = 'SABIT_GIDER'
            aciklama_t = aciklama_ana
            insert_kasa_hareketi(cur, tarih, islem_t, -abs(ana_para_kismi),
                aciklama_t, 'odeme_plani', plan_id, plan_id, 'ODEME_PLANI')
        elif kaynak == 'personel':
            islem_t = 'PERSONEL_MAAS'
            aciklama_t = aciklama_ana
            insert_kasa_hareketi(cur, tarih, islem_t, -abs(ana_para_kismi),
                aciklama_t, 'odeme_plani', plan_id, plan_id, 'ODEME_PLANI')
        elif kaynak == 'vadeli_alimlar':
            islem_t = 'VADELI_ODEME'
            aciklama_t = aciklama_ana
            vk = plan.get('kaynak_id')
            kasa_kt = 'vadeli_alimlar' if vk else 'odeme_plani'
            kasa_kid = vk or plan_id
            insert_kasa_hareketi(
                cur, tarih, islem_t, -abs(ana_para_kismi), aciklama_t,
                kasa_kt, kasa_kid, plan_id, 'ODEME_PLANI',
            )
        elif kaynak == 'borc_envanteri':
            islem_t = 'BORC_TAKSIT'
            aciklama_t = aciklama_ana
            insert_kasa_hareketi(cur, tarih, islem_t, -abs(ana_para_kismi),
                aciklama_t, 'odeme_plani', plan_id, plan_id, 'ODEME_PLANI')
        else:
            islem_t = 'KART_ODEME'
            aciklama_t = aciklama_ana
            insert_kasa_hareketi(cur, tarih, islem_t, -abs(ana_para_kismi),
                aciklama_t, 'odeme_plani', plan_id, plan_id, 'ODEME_PLANI')

    # kart_borc() ODEME türündeki kart_hareketleri kaydına bakarak borcu düşürür.
    # Nakit ödeme kasaya gider ama kart borcu bu kayıt olmadan hiç azalmaz.
    # Her kart_id'li plan ödemesinde ODEME kaydı oluşturulmalı.
    if plan.get('kart_id') and odenen > 0:
        cur.execute("""
            INSERT INTO kart_hareketleri
                (id, kart_id, tarih, islem_turu, tutar, aciklama, kaynak_id, kaynak_tablo)
            VALUES (%s, %s, %s, 'ODEME', %s, %s, %s, 'odeme_plani')
            ON CONFLICT DO NOTHING
        """, (
            f"odm_{plan_id}",
            plan['kart_id'],
            tarih,
            abs(odenen),
            f"Ödeme planı: {plan.get('aciklama', '')}",
            plan_id,
        ))

    return ana_para_kismi


# ── PANEL ──────────────────────────────────────────────────────

# ── AY DEVİR (HESAPLANAN — ledger'a yazılmaz) ──────────────────
def devir_hesapla(yil: int = None, ay: int = None):
    """
    Geçen ayın kapanış kasasını hesaplar.
    Ledger'a hiçbir şey yazılmaz — immutable model korunur.
    """
    import calendar
    bugun = bugun_tr()
    yil = yil or bugun.year
    ay  = ay  or bugun.month

    if ay == 1:
        gecen_yil, gecen_ay = yil - 1, 12
    else:
        gecen_yil, gecen_ay = yil, ay - 1

    gecen_ay_son = date(gecen_yil, gecen_ay,
                        calendar.monthrange(gecen_yil, gecen_ay)[1])

    with db() as (conn, cur):
        devir = kasa_bakiyesi_tarihte(cur, gecen_ay_son)

    return {
        "devir_tutar": devir,
        "gecen_ay": f"{gecen_yil}-{gecen_ay:02d}",
        "hesaplandi": True
    }

@app.get("/api/devir")
def devir_goster(yil: int = None, ay: int = None):
    try:
        return devir_hesapla(yil, ay)
    except Exception as e:
        raise HTTPException(500, str(e))


def odeme_plani_kontrol(referans_tarih: Optional[date] = None) -> dict:
    """
    Ay plan üretimi için lazy + idempotent koruma.
    Panel çağrısında tetiklenir; eksik plan varsa üretmeyi dener.
    """
    bugun = referans_tarih or bugun_tr()
    eksik_sabit = eksik_borc = eksik_kart = eksik_personel = 0
    lock_ok = False

    with db() as (conn, cur):
        cur.execute(
            "SELECT pg_try_advisory_xact_lock(hashtext(%s)) AS ok",
            (f"odeme-plan-kontrol:{bugun.year}-{bugun.month}",),
        )
        lock_ok = bool((cur.fetchone() or {}).get("ok"))

        # Sabit gider planı eksik mi?
        cur.execute("""
            SELECT COUNT(*) as eksik FROM sabit_giderler sg
            WHERE sg.aktif = TRUE AND (sg.tip IS NULL OR sg.tip = 'sabit')
            AND NOT EXISTS (
                SELECT 1 FROM odeme_plani op
                WHERE op.kaynak_tablo = 'sabit_giderler'
                AND op.kaynak_id = sg.id
                AND op.durum != 'iptal'
                AND op.referans_ay = DATE_TRUNC('month', %s::date)
            )
        """, (bugun,))
        eksik_sabit = int(cur.fetchone()['eksik'])

        # Borç taksit planı eksik mi?
        cur.execute("""
            SELECT COUNT(*) as eksik FROM borc_envanteri b
            WHERE b.aktif = TRUE AND b.aylik_taksit > 0
            AND (b.kalan_vade IS NULL OR b.kalan_vade > 0)
            AND NOT EXISTS (
                SELECT 1 FROM odeme_plani op
                WHERE op.kaynak_tablo = 'borc_envanteri'
                AND op.kaynak_id = b.id::text
                AND op.durum != 'iptal'
                AND DATE_TRUNC('month', op.tarih) = DATE_TRUNC('month', %s::date)
            )
        """, (bugun,))
        eksik_borc = int(cur.fetchone()['eksik'])

        # Kart asgari ödeme planı eksik mi? (borcu olan aktif kartlar)
        cur.execute("""
            SELECT COUNT(*) as eksik FROM kartlar k
            WHERE k.aktif = TRUE
            AND (
                SELECT COALESCE(SUM(
                    CASE WHEN kh.islem_turu IN ('HARCAMA','FAIZ','DEVIR') THEN kh.tutar
                         WHEN kh.islem_turu='ODEME' THEN -kh.tutar ELSE 0 END
                ), 0) FROM kart_hareketleri kh
                WHERE kh.kart_id = k.id AND kh.durum = 'aktif'
            ) > 0
            AND NOT EXISTS (
                SELECT 1 FROM odeme_plani op
                WHERE op.kart_id = k.id
                AND op.durum != 'iptal'
                AND DATE_TRUNC('month', op.tarih) = DATE_TRUNC('month', %s::date)
            )
        """, (bugun,))
        eksik_kart = int(cur.fetchone()['eksik'])

        # Sürekli personel maaş planı eksik mi?
        cur.execute("""
            SELECT COUNT(*) as eksik FROM personel p
            WHERE p.aktif=TRUE AND p.calisma_turu='surekli'
            AND NOT EXISTS (
                SELECT 1 FROM odeme_plani op
                WHERE op.kaynak_tablo='personel'
                AND op.kaynak_id = p.id::text
                AND op.durum != 'iptal'
                AND DATE_TRUNC('month', op.tarih) = DATE_TRUNC('month', %s::date)
            )
        """, (bugun,))
        eksik_personel = int(cur.fetchone()['eksik'])

    eksik_plan = eksik_sabit + eksik_borc + eksik_kart + eksik_personel
    uretim_denedi = False
    uretilen_adet = 0
    if eksik_plan > 0 and lock_ok:
        uretim_denedi = True
        try:
            sonuc = aylik_odeme_plani_uret(bugun.year, bugun.month)
            uretilen_adet = int(sonuc.get("toplam") or 0)
        except Exception as e:
            logger.warning(f"Lazy odeme_plani_kontrol üretim hatası: {e}")

    return {
        "eksik_toplam": eksik_plan,
        "eksik": {
            "sabit": eksik_sabit,
            "borc": eksik_borc,
            "kart": eksik_kart,
            "personel": eksik_personel,
        },
        "kilit_alindi": lock_ok,
        "uretim_denedi": uretim_denedi,
        "uretilen_adet": uretilen_adet,
    }


def bu_ay_plan_var(referans_tarih: Optional[date] = None) -> bool:
    bugun = referans_tarih or bugun_tr()
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT 1
            FROM odeme_plani
            WHERE referans_ay = DATE_TRUNC('month', %s::date)
              AND durum != 'iptal'
            LIMIT 1
            """,
            (bugun,),
        )
        return bool(cur.fetchone())


def aylik_plan_lazy_init(referans_tarih: Optional[date] = None) -> dict:
    """
    Scheduler çalışmasa bile panel ilk açılışında bu ay planlarını üretir.
    İdempotent tasarım: aynı ayda tekrar çağrılar güvenlidir.
    """
    bugun = referans_tarih or bugun_tr()
    if bu_ay_plan_var(bugun):
        return {"uretildi": False, "neden": "plan_mevcut"}

    lock_ok = False
    with db() as (conn, cur):
        cur.execute(
            "SELECT pg_try_advisory_xact_lock(hashtext(%s)) AS ok",
            (f"aylik-plan-lazy-init:{bugun.year}-{bugun.month}",),
        )
        lock_ok = bool((cur.fetchone() or {}).get("ok"))

    if not lock_ok:
        return {"uretildi": False, "neden": "kilit_alinamadi"}

    if bu_ay_plan_var(bugun):
        return {"uretildi": False, "neden": "plan_mevcut"}

    try:
        sonuc = aylik_odeme_plani_uret(bugun.year, bugun.month)
        return {
            "uretildi": True,
            "neden": "uretim",
            "adet": int((sonuc or {}).get("toplam") or 0),
        }
    except Exception as e:
        logger.warning(f"Lazy aylik plan init hatası: {e}")
        return {"uretildi": False, "neden": "hata", "hata": str(e)}


@app.get("/api/panel")
def panel():
    try:
        lazy_plan = aylik_plan_lazy_init()
        plan_kontrol = odeme_plani_kontrol()
        plan_kontrol["lazy_init"] = lazy_plan

        ozet = finans_ozet_motoru()
        ozet['plan_kontrol'] = plan_kontrol
        # Devir: hesaplanır, ledger'a yazılmaz
        devir_bilgi = devir_hesapla()
        ozet['bu_ay_devir'] = devir_bilgi['devir_tutar']
        ozet['gecen_ay_adi'] = devir_bilgi['gecen_ay']

        # Bu ay gelir breakdown — nakit/pos/online/dış kaynak ayrı
        with db() as (conn, cur):
            cur.execute("""
                SELECT
                    COALESCE(SUM(CASE WHEN islem_turu='DIS_KAYNAK' THEN tutar ELSE 0 END), 0) as dis_kaynak,
                    COALESCE(SUM(CASE WHEN islem_turu='CIRO' THEN tutar ELSE 0 END), 0) as sadece_ciro
                FROM kasa_hareketleri
                WHERE durum='aktif'
                AND EXTRACT(YEAR FROM tarih) = EXTRACT(YEAR FROM CURRENT_DATE)
                AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
            """)
            row = cur.fetchone()
            ozet['bu_ay_dis_kaynak'] = float(row['dis_kaynak'])
            ozet['bu_ay_sadece_ciro'] = float(row['sadece_ciro'])

            # Bu ay toplam anlık gider
            cur.execute("""
                SELECT COALESCE(SUM(ABS(tutar)), 0) as anlik_gider
                FROM kasa_hareketleri
                WHERE durum='aktif'
                AND islem_turu = 'ANLIK_GIDER'
                AND EXTRACT(YEAR FROM tarih) = EXTRACT(YEAR FROM CURRENT_DATE)
                AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
            """)
            ozet['bu_ay_anlik_gider'] = float(cur.fetchone()['anlik_gider'])

            # Bu ay bankaya yatırılan (takip tablosu)
            cur.execute(
                """
                SELECT COALESCE(SUM(tutar), 0) AS toplam,
                       COUNT(*)::int AS adet
                FROM banka_yatirimlari
                WHERE EXTRACT(YEAR FROM tarih) = EXTRACT(YEAR FROM CURRENT_DATE)
                  AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
                """
            )
            _by = cur.fetchone()
            ozet["bu_ay_banka_yatirim"] = float(_by["toplam"] or 0)
            ozet["bu_ay_banka_yatirim_adet"] = int(_by["adet"] or 0)

            # Nakit / POS / Online breakdown (bu ay ciro)
            cur.execute("""
                SELECT
                    COALESCE(SUM(nakit), 0) as nakit,
                    COALESCE(SUM(pos), 0) as pos,
                    COALESCE(SUM(online), 0) as online
                FROM ciro
                WHERE durum='aktif'
                AND EXTRACT(YEAR FROM tarih) = EXTRACT(YEAR FROM CURRENT_DATE)
                AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
            """)
            breakdown = cur.fetchone()
            ozet['bu_ay_nakit'] = float(breakdown['nakit'])
            ozet['bu_ay_pos'] = float(breakdown['pos'])
            ozet['bu_ay_online'] = float(breakdown['online'])

            # Finansman maliyeti — ciro tablosundan hesapla (bilgi amaçlı, kasayı etkilemez)
            cur.execute("""
                SELECT
                    COALESCE(SUM(c.pos * s.pos_oran / 100.0), 0) as pos_kesinti,
                    COALESCE(SUM(c.online * s.online_oran / 100.0), 0) as online_kesinti
                FROM ciro c
                JOIN subeler s ON s.id = c.sube_id
                WHERE c.durum='aktif'
                AND EXTRACT(YEAR FROM c.tarih) = EXTRACT(YEAR FROM CURRENT_DATE)
                AND EXTRACT(MONTH FROM c.tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
            """)
            kesinti_row = cur.fetchone()
            ozet['bu_ay_pos_kesinti']    = float(kesinti_row['pos_kesinti'])
            ozet['bu_ay_online_kesinti'] = float(kesinti_row['online_kesinti'])

            # Kart faizi — FAİZ tipi hareketlerden gerçek veri
            cur.execute("""
                SELECT COALESCE(SUM(tutar), 0) as kart_faizi
                FROM kart_hareketleri
                WHERE islem_turu = 'FAIZ'
                AND EXTRACT(YEAR FROM tarih) = EXTRACT(YEAR FROM CURRENT_DATE)
                AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
            """)
            ozet['bu_ay_kart_faizi'] = float(cur.fetchone()['kart_faizi'])
            ozet['bu_ay_finansman_maliyeti'] = ozet['bu_ay_pos_kesinti'] + ozet['bu_ay_online_kesinti'] + ozet['bu_ay_kart_faizi']

        # Plan son üretim tarihi
        with db() as (conn, cur):
            cur.execute("""
                SELECT MAX(olusturma) as son_uretim
                FROM odeme_plani
                WHERE EXTRACT(YEAR FROM tarih) = EXTRACT(YEAR FROM CURRENT_DATE)
                AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
            """)
            row = cur.fetchone()
            ozet['plan_son_uretim'] = str(row['son_uretim'])[:16] if row['son_uretim'] else None

        # ── NAKİT / KART KIRILIMLARI ───────────────────────────
        # Her gider türünde bu ay nakit mi kart mı ödendiği
        with db() as (conn, cur):
            # ANLIK GİDER — kasa_hareketleri=nakit, kart_hareketleri=kart
            cur.execute("""
                SELECT
                    COALESCE(SUM(CASE WHEN ag.odeme_yontemi='nakit' THEN ag.tutar ELSE 0 END), 0) as nakit,
                    COALESCE(SUM(CASE WHEN ag.odeme_yontemi='kart'  THEN ag.tutar ELSE 0 END), 0) as kart
                FROM anlik_giderler ag
                WHERE ag.durum='aktif'
                AND EXTRACT(YEAR FROM ag.tarih) = EXTRACT(YEAR FROM CURRENT_DATE)
                AND EXTRACT(MONTH FROM ag.tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
            """)
            ag = cur.fetchone()
            ozet['anlik_nakit'] = float(ag['nakit'])
            ozet['anlik_kart']  = float(ag['kart'])

            # SABİT GİDER nakit — kasa_hareketleri SABIT_GIDER
            cur.execute("""
                SELECT COALESCE(SUM(ABS(tutar)), 0) as nakit
                FROM kasa_hareketleri
                WHERE islem_turu = 'SABIT_GIDER' AND kasa_etkisi = true AND durum = 'aktif'
                AND EXTRACT(YEAR FROM tarih) = EXTRACT(YEAR FROM CURRENT_DATE)
                AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
            """)
            ozet['sabit_nakit'] = float(cur.fetchone()['nakit'])

            # SABİT GİDER kart — kart_hareketleri kaynak_tablo=sabit_giderler
            cur.execute("""
                SELECT COALESCE(SUM(tutar), 0) as kart
                FROM kart_hareketleri
                WHERE islem_turu = 'HARCAMA' AND durum = 'aktif'
                AND kaynak_tablo = 'sabit_giderler'
                AND EXTRACT(YEAR FROM tarih) = EXTRACT(YEAR FROM CURRENT_DATE)
                AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
            """)
            ozet['sabit_kart'] = float(cur.fetchone()['kart'])

            # FATURA GİDERİ nakit — kasa_hareketleri FATURA_ODEMESI
            cur.execute("""
                SELECT COALESCE(SUM(ABS(tutar)), 0) as nakit
                FROM kasa_hareketleri
                WHERE islem_turu = 'FATURA_ODEMESI' AND kasa_etkisi = true AND durum = 'aktif'
                AND EXTRACT(YEAR FROM tarih) = EXTRACT(YEAR FROM CURRENT_DATE)
                AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
            """)
            ozet['fatura_nakit'] = float(cur.fetchone()['nakit'])

            # FATURA GİDERİ kart — kart_hareketleri kaynak_tablo=fatura_giderleri
            cur.execute("""
                SELECT COALESCE(SUM(tutar), 0) as kart
                FROM kart_hareketleri
                WHERE islem_turu = 'HARCAMA' AND durum = 'aktif'
                AND kaynak_tablo = 'fatura_giderleri'
                AND EXTRACT(YEAR FROM tarih) = EXTRACT(YEAR FROM CURRENT_DATE)
                AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
            """)
            ozet['fatura_kart'] = float(cur.fetchone()['kart'])

            # VADELİ ALIM — kasa_hareketleri VADELI_ODEME=nakit, kart_hareketleri HARCAMA+aciklama=kart
            cur.execute("""
                SELECT COALESCE(SUM(ABS(tutar)), 0) as nakit
                FROM kasa_hareketleri
                WHERE islem_turu = 'VADELI_ODEME' AND kasa_etkisi=true AND durum='aktif'
                AND EXTRACT(YEAR FROM tarih) = EXTRACT(YEAR FROM CURRENT_DATE)
                AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
            """)
            ozet['vadeli_nakit'] = float(cur.fetchone()['nakit'])

            cur.execute("""
                SELECT COALESCE(SUM(kh.tutar), 0) as kart
                FROM kart_hareketleri kh
                WHERE kh.islem_turu = 'HARCAMA'
                AND kh.kaynak_tablo = 'vadeli_alimlar'
                AND kh.durum = 'aktif'
                AND EXTRACT(YEAR FROM kh.tarih) = EXTRACT(YEAR FROM CURRENT_DATE)
                AND EXTRACT(MONTH FROM kh.tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
            """)
            ozet['vadeli_kart'] = float(cur.fetchone()['kart'])

            # PERSONEL MAAŞ — tahmini vs gerçekleşen
            cur.execute("""
                SELECT
                    COALESCE(SUM(p.maas + p.yemek_ucreti + p.yol_ucreti), 0) as tahmini
                FROM personel p WHERE p.aktif=TRUE AND p.calisma_turu='surekli'
            """)
            ozet['personel_tahmini'] = float(cur.fetchone()['tahmini'])

            cur.execute("""
                SELECT COALESCE(SUM(pa.hesaplanan_net), 0) as gercek
                FROM personel_aylik pa
                WHERE pa.yil = EXTRACT(YEAR FROM CURRENT_DATE)
                AND pa.ay  = EXTRACT(MONTH FROM CURRENT_DATE)
            """)
            ozet['personel_gercek'] = float(cur.fetchone()['gercek'])

            cur.execute("""
                SELECT COUNT(*) as bekleyen
                FROM personel p
                WHERE p.aktif=TRUE
                AND NOT EXISTS (
                    SELECT 1 FROM personel_aylik pa
                    WHERE pa.personel_id = p.id
                    AND pa.yil = EXTRACT(YEAR FROM CURRENT_DATE)
                    AND pa.ay  = EXTRACT(MONTH FROM CURRENT_DATE)
                )
            """)
            ozet['personel_kayit_bekleyen'] = int(cur.fetchone()['bekleyen'])

            # BORÇ TAKSİTLERİ — bu ay ödenen
            cur.execute("""
                SELECT COALESCE(SUM(ABS(tutar)), 0) as borc_odenen
                FROM kasa_hareketleri
                WHERE islem_turu = 'BORC_TAKSIT' AND kasa_etkisi = true AND durum = 'aktif'
                AND EXTRACT(YEAR FROM tarih) = EXTRACT(YEAR FROM CURRENT_DATE)
                AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
            """)
            ozet['borc_taksit_odenen'] = float(cur.fetchone()['borc_odenen'])

            # Bekleyen borç taksitleri
            cur.execute("""
                SELECT COALESCE(SUM(odenecek_tutar), 0) as bekleyen,
                       COUNT(*) as adet
                FROM odeme_plani
                WHERE kaynak_tablo = 'borc_envanteri'
                AND durum IN ('bekliyor','onay_bekliyor')
            """)
            row = cur.fetchone()
            ozet['borc_taksit_bekleyen'] = float(row['bekleyen'])
            ozet['borc_taksit_bekleyen_adet'] = int(row['adet'])

            # GENEL TOPLAM
            ozet['genel_nakit_toplam'] = ozet['anlik_nakit'] + ozet['sabit_nakit'] + ozet['vadeli_nakit']
            ozet['genel_kart_toplam']  = ozet['anlik_kart']  + ozet['sabit_kart']  + ozet['vadeli_kart']

            # BU AY TOPLAM KASA ÇIKIŞI — ciro düzeltme/iptal ledger kayıtları hariç gerçek giderler
            # CIRO_DUZELTME: ciro güncellenince oluşan ters kayıt (teknik, gerçek gider değil)
            # CIRO_IPTAL: ciro iptal edilince oluşan ters kayıt (teknik, gerçek gider değil)
            cur.execute("""
                SELECT COALESCE(SUM(ABS(tutar)), 0) as toplam_cikis
                FROM kasa_hareketleri
                WHERE kasa_etkisi = true AND durum = 'aktif' AND tutar < 0
                AND islem_turu NOT IN ('CIRO_DUZELTME', 'CIRO_IPTAL', 'ACILIS_DEVRI')
                AND EXTRACT(YEAR  FROM tarih) = EXTRACT(YEAR  FROM CURRENT_DATE)
                AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
            """)
            ozet['bu_ay_nakit_cikis'] = float(cur.fetchone()['toplam_cikis'])

            # BU AY TOPLAM KASA GİRİŞİ — tüm pozitif hareketlerin toplamı
            # (Güncellenmiş ciro için yeni CIRO kaydı islem_turu='CIRO' olarak gelir, doğru sayılır)
            cur.execute("""
                SELECT COALESCE(SUM(tutar), 0) as toplam_giris
                FROM kasa_hareketleri
                WHERE kasa_etkisi = true AND durum = 'aktif' AND tutar > 0
                AND islem_turu NOT IN ('CIRO_DUZELTME', 'CIRO_IPTAL', 'ACILIS_DEVRI')
                AND EXTRACT(YEAR  FROM tarih) = EXTRACT(YEAR  FROM CURRENT_DATE)
                AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
            """)
            ozet['bu_ay_nakit_giris'] = float(cur.fetchone()['toplam_giris'])

            # NET (nakit giriş - nakit çıkış)
            ozet['bu_ay_net'] = ozet['bu_ay_nakit_giris'] - ozet['bu_ay_nakit_cikis']

        return ozet
    except Exception as e:
        import traceback
        logger.error(f"Panel hatası: {e}\n{traceback.format_exc()}")
        raise HTTPException(500, str(e))

@app.get("/api/panel/detay")
def panel_detay():
    """Eski panel endpoint'i — geriye dönük uyumluluk için."""
    try:
        karar = karar_motoru()
        sim = nakit_akis_simulasyon(15)
        with db() as (conn, cur):
            cur.execute("""
                SELECT TO_CHAR(tarih,'YYYY-MM') as ay, SUM(toplam) as ciro
                FROM ciro WHERE tarih >= CURRENT_DATE - INTERVAL '6 months'
                GROUP BY TO_CHAR(tarih,'YYYY-MM') ORDER BY ay DESC LIMIT 6
            """)
            aylik_ciro = [dict(r) for r in cur.fetchall()]
            cur.execute("SELECT COUNT(*) as sayi, COALESCE(SUM(tutar),0) as toplam FROM onay_kuyrugu WHERE durum='bekliyor'")
            bekleyen = dict(cur.fetchone())
            cur.execute("""
                SELECT COALESCE(SUM(CASE WHEN tarih<=CURRENT_DATE+7 THEN odenecek_tutar ELSE 0 END),0) as t7,
                    COALESCE(SUM(CASE WHEN tarih<=CURRENT_DATE+15 THEN odenecek_tutar ELSE 0 END),0) as t15,
                    COALESCE(SUM(CASE WHEN tarih<=CURRENT_DATE+30 THEN odenecek_tutar ELSE 0 END),0) as t30
                FROM odeme_plani WHERE durum='bekliyor' AND tarih BETWEEN CURRENT_DATE AND CURRENT_DATE+30
            """)
            odeme_ozet = dict(cur.fetchone())
            cur.execute("""
SELECT
    COALESCE(SUM(CASE WHEN islem_turu IN ('CIRO','DIS_KAYNAK','KASA_GIRIS','KASA_DUZELTME') AND tutar > 0 THEN tutar ELSE 0 END), 0) as gelir,
    COALESCE(SUM(CASE WHEN islem_turu IN ('ANLIK_GIDER','KART_ODEME','VADELI_ODEME','PERSONEL_MAAS','SABIT_GIDER','BORC_TAKSIT','FATURA_ODEMESI') THEN ABS(tutar) ELSE 0 END), 0) as gider
FROM kasa_hareketleri
WHERE durum='aktif'
""")
            row = cur.fetchone() or {"gelir": 0, "gider": 0}
            toplam_gelir = float(row.get('gelir', 0) or 0)
            toplam_gider = float(row.get('gider', 0) or 0)

            # Aksiyonlar
            aksiyonlar = []
            kasa_val = karar.get("kasa", 0)
            if kasa_val <= 0:
                aksiyonlar.append({"tip":"kritik","mesaj":"Kasa boş. Önce ciro gir.","aksiyon":"ciro"})
            if odeme_ozet.get("t7", 0) > 0:
                aksiyonlar.append({"tip":"uyari","mesaj":"7 gün içinde ödeme var","aksiyon":"odeme"})

        # Kart analiz — with db() dışında ayrı bağlantıyla
        kart_analiz = kart_analiz_hesapla()

        return {**karar, "simulasyon": sim, "aylik_ciro": aylik_ciro,
                "bekleyen_onay": bekleyen, "odeme_ozet": odeme_ozet,
                "kart_analiz": kart_analiz, "toplam_gelir": toplam_gelir,
                "toplam_gider": toplam_gider, "aksiyonlar": aksiyonlar}
    except Exception as e:
        raise HTTPException(500, str(e))



@app.get("/api/strateji")
def strateji():
    try: return odeme_strateji_motoru()
    except Exception as e: raise HTTPException(500, str(e))

@app.get("/api/simulasyon")
def simulasyon(gun: int = 15):
    try: return nakit_akis_simulasyon(gun)
    except Exception as e: raise HTTPException(500, str(e))


@app.get("/api/nakit-akis-projeksiyon")
def nakit_akis_projeksiyon(gun: int = 30):
    """
    Gelişmiş nakit akış projeksiyonu — /api/simulasyon'un üst kümesi.

    Farklar:
    - Gecikmiş ödemeler (tarih < bugün, hâlâ bekliyor) gün 0'a dahil edilir.
    - Her güne risk_seviye: 'NORMAL' / 'DIKKAT' / 'KRITIK' eklendi.
    - Özet blok: başlangıç kasası, en düşük nokta, risk gün sayısı,
      toplam tahmini gelir/gider, backtest tahmin doğruluğu.
    - /api/simulasyon ile aynı finans_core çekirdeğini kullanır; tüm
      mevcut çağrıcılar değişmez.

    gun: 7–90 gün arası (varsayılan 30).
    """
    gun = max(7, min(90, int(gun)))
    try:
        with db() as (conn, cur):
            baslangic_kasa = kasa_bakiyesi(cur)
            gunler = nakit_akis_sim(cur, gun_sayisi=gun)
            # Backtest doğruluğu aynı cursor ile çekilir — ekstra bağlantı yok.
            dogruluk = nakit_akis_tahmin_dogruluk(cur, gun_sayisi=30)

        # ── Özet istatistikler ──────────────────────────────────
        kasa_degerler = [g['kasa_tahmini'] for g in gunler]
        risk_gunler   = [g for g in gunler if g['risk']]
        dikkat_gunler = [g for g in gunler if g.get('risk_seviye') == 'DIKKAT']
        en_dusuk_kasa = min(kasa_degerler) if kasa_degerler else baslangic_kasa
        en_dusuk_gun  = next(
            (g for g in gunler if g['kasa_tahmini'] == en_dusuk_kasa), None
        )
        gecikmus = gunler[0].get('gecikmus_odeme', 0.0) if gunler else 0.0

        ozet = {
            "gun_sayisi":              gun,
            "baslangic_kasa":          round(baslangic_kasa, 2),
            "tahmini_gun_sonu_kasa":   gunler[-1]['kasa_tahmini'] if gunler else round(baslangic_kasa, 2),
            "en_dusuk_kasa":           round(en_dusuk_kasa, 2),
            "en_dusuk_tarih":          en_dusuk_gun['tarih'] if en_dusuk_gun else None,
            "risk_gun_sayisi":         len(risk_gunler),
            "dikkat_gun_sayisi":       len(dikkat_gunler),
            "ilk_risk_gunu":           risk_gunler[0]['tarih'] if risk_gunler else None,
            "toplam_tahmini_gelir":    round(sum(g['beklenen_gelir'] for g in gunler), 2),
            "toplam_planlanan_gider":  round(sum(g['beklenen_gider'] for g in gunler), 2),
            # Gecikmiş ödeme varsa gün 0'a yüklendiği miktar — kullanıcı bilgilensin.
            "gecikmus_odeme_yuklendi": round(gecikmus, 2),
            # Backtest doğruluğu — yeterli ciro geçmişi yoksa None döner.
            "tahmin_dogruluk_pct":     dogruluk.get('dogruluk_pct'),
            "tahmin_dogruluk_mesaj":   dogruluk.get('mesaj'),
            "tahmin_dogruluk_durum":   dogruluk.get('durum'),
        }

        return {
            "ozet":   ozet,
            "gunler": gunler,
        }
    except Exception as e:
        raise HTTPException(500, str(e))


# ── KASA ───────────────────────────────────────────────────────
@app.get("/api/kasa")
def kasa_durumu():
    with db() as (conn, cur):
        kasa = guncel_kasa()
        cur.execute("""SELECT * FROM kasa_hareketleri WHERE durum='aktif'
            ORDER BY tarih DESC, olusturma DESC LIMIT 100""")
        return {"guncel_bakiye": kasa, "hareketler": [dict(r) for r in cur.fetchall()]}

# ── DIŞ KAYNAK GELİRİ (aile, kredi, ortak, vb.) ───────────────
class DisKaynakGelir(BaseModel):
    tarih: date
    kategori: str
    tutar: float
    aciklama: Optional[str] = None
    force: bool = False

@app.get("/api/dis-kaynak")
def dis_kaynak_listele(ay: str = None):
    import re as _re_ay
    ay_v = (ay or "").strip()
    ay_cond, ay_params = "", []
    if ay_v and ay_v.lower() != "hepsi" and _re_ay.match(r"^\d{4}-\d{2}$", ay_v):
        ay_cond = " AND to_char(tarih, 'YYYY-MM') = %s"
        ay_params = [ay_v]
    with db() as (conn, cur):
        cur.execute(f"""SELECT * FROM kasa_hareketleri
            WHERE islem_turu='DIS_KAYNAK' AND durum='aktif'{ay_cond}
            ORDER BY tarih DESC LIMIT 200""", ay_params)
        return [dict(r) for r in cur.fetchall()]

@app.post("/api/dis-kaynak")
def dis_kaynak_ekle(g: DisKaynakGelir):
    with db() as (conn, cur):
        if not g.force:
            cur.execute("""
                SELECT id FROM kasa_hareketleri WHERE islem_turu='DIS_KAYNAK' AND durum='aktif'
                AND tarih BETWEEN %s::date - INTERVAL '7 days' AND %s::date + INTERVAL '7 days'
                AND ABS(tutar - %s) < 1 AND aciklama LIKE %s
            """, (str(g.tarih), str(g.tarih), g.tutar, f"{g.kategori}%"))
            benzer = cur.fetchall()
            if benzer:
                return {"warning": True, "mesaj": f"Son 7 günde benzer kayıt var ({len(benzer)} adet). Yine de kaydetmek için force=true gönderin."}
        gid = str(uuid.uuid4())
        insert_kasa_hareketi(cur, g.tarih, 'DIS_KAYNAK', abs(g.tutar),
            f"{g.kategori}: {g.aciklama or ''}", 'dis_kaynak', gid)
        audit(cur, 'kasa_hareketleri', gid, 'DIS_KAYNAK')
    return {"id": gid, "success": True}

@app.delete("/api/dis-kaynak/{gid}")
def dis_kaynak_sil(gid: str):
    with db() as (conn, cur):
        # gid = kasa_hareketleri.id (frontend listeden alıyor)
        cur.execute("SELECT * FROM kasa_hareketleri WHERE id=%s AND islem_turu='DIS_KAYNAK'", (gid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404, "Kayıt bulunamadı")
        # kaynak_id ile iptal et
        kaynak_id = eski['kaynak_id'] or gid
        iptal_kasa_hareketi(cur, kaynak_id, 'dis_kaynak', 'DIS_KAYNAK', 'DIS_KAYNAK_IPTAL', 'Dış kaynak iptali')
        audit(cur, 'kasa_hareketleri', gid, 'IPTAL', eski=eski)
    return {"success": True}

# ── ANLIQ GİDER (beklenmeyen giderler) ────────────────────────
class AnlikGider(BaseModel):
    tarih: date
    kategori: str
    tutar: float
    aciklama: Optional[str] = None
    sube: Optional[str] = "MERKEZ"
    odeme_yontemi: str = 'nakit'   # 'nakit' veya 'kart'
    kart_id: Optional[str] = None
    kaynak_id: Optional[str] = None       # Değişken gider kaynağı (sabit_giderler.id)
    kaynak_tablo: Optional[str] = None    # 'sabit_giderler'
    force: bool = False

@app.get("/api/anlik-gider-kart-oneri")
def anlik_gider_kart_oneri(tutar: float = 0):
    """
    Anlık gider için kart önerisi — vadeli alımla aynı skorlama.
    Kesim günü uzaklığı, limit boşluğu, faiz oranına göre sıralar.
    """
    bugun = bugun_tr()
    with db() as (conn, cur):
        cur.execute("SELECT * FROM kartlar WHERE aktif=TRUE ORDER BY banka")
        kartlar = cur.fetchall()
        sonuc = []
        for k in kartlar:
            borc = kart_borc(cur, k['id'])
            limit = float(k['limit_tutar'])
            kalan_limit = limit - borc

            if tutar > 0 and kalan_limit < tutar:
                sonuc.append({
                    'kart_id': str(k['id']), 'kart_adi': k['kart_adi'], 'banka': k['banka'],
                    'kalan_limit': kalan_limit, 'limit_doluluk': borc/limit if limit>0 else 0,
                    'faiz_orani': float(k['faiz_orani']),
                    'kesim_gunu': k['kesim_gunu'], 'son_odeme_gunu': k['son_odeme_gunu'],
                    'uygun': False, 'uygun_degil_neden': 'Limit yetersiz', 'skor': 0, 'oneri': False,
                })
                continue

            import calendar as _cal
            kesim_gun = k['kesim_gunu']
            bugun_gun = bugun.day
            if kesim_gun >= bugun_gun:
                kesim_uzakligi = kesim_gun - bugun_gun
            else:
                ay_sonu = _cal.monthrange(bugun.year, bugun.month)[1]
                kesim_uzakligi = (ay_sonu - bugun_gun) + kesim_gun

            son_odeme_gun = k['son_odeme_gunu']
            if son_odeme_gun >= bugun_gun:
                son_odeme_uzakligi = son_odeme_gun - bugun_gun
            else:
                ay_sonu = _cal.monthrange(bugun.year, bugun.month)[1]
                son_odeme_uzakligi = (ay_sonu - bugun_gun) + son_odeme_gun

            if son_odeme_uzakligi <= 3:
                sonuc.append({
                    'kart_id': str(k['id']), 'kart_adi': k['kart_adi'], 'banka': k['banka'],
                    'kalan_limit': kalan_limit, 'limit_doluluk': borc/limit if limit>0 else 0,
                    'faiz_orani': float(k['faiz_orani']),
                    'kesim_gunu': kesim_gun, 'kesim_uzakligi': kesim_uzakligi,
                    'son_odeme_gunu': son_odeme_gun, 'son_odeme_uzakligi': son_odeme_uzakligi,
                    'uygun': False, 'uygun_degil_neden': f'Son ödeme {son_odeme_uzakligi} gün sonra — bu kart zaten ödenecek',
                    'skor': 0, 'oneri': False,
                })
                continue

            limit_boslugu_pct = kalan_limit / limit if limit > 0 else 0
            faiz = float(k['faiz_orani'])
            skor = (kesim_uzakligi/30.0)*0.5 + limit_boslugu_pct*0.3 - min(faiz/5.0,1.0)*0.2

            sonuc.append({
                'kart_id': str(k['id']), 'kart_adi': k['kart_adi'], 'banka': k['banka'],
                'kalan_limit': kalan_limit, 'limit_doluluk': borc/limit if limit>0 else 0,
                'faiz_orani': faiz,
                'kesim_gunu': kesim_gun, 'kesim_uzakligi': kesim_uzakligi,
                'son_odeme_gunu': son_odeme_gun, 'son_odeme_uzakligi': son_odeme_uzakligi,
                'uygun': True, 'uygun_degil_neden': None, 'skor': round(skor,4), 'oneri': False,
            })

        uygunlar = [k for k in sonuc if k['uygun']]
        if uygunlar:
            en_iyi = max(uygunlar, key=lambda x: x['skor'])
            for k in sonuc:
                if k['kart_id'] == en_iyi['kart_id']:
                    k['oneri'] = True

        sonuc.sort(key=lambda x: (-int(x['oneri']), -x['skor']))
        return sonuc

@app.get("/api/anlik-gider")
def anlik_gider_listele(durum: str = "aktif", include_pending: bool = False, include_summary: bool = False, ay: str = None):
    # Geriye uyum: eski include_pending=true => hepsi
    d = (durum or "aktif").strip().lower()
    if include_pending and d == "aktif":
        d = "hepsi"
    if d not in ("aktif", "onay_bekliyor", "hepsi"):
        raise HTTPException(400, "durum: aktif | onay_bekliyor | hepsi")

    # AY FİLTRESİ (YYYY-MM): verilirse o aya ait kayıtlar; 'hepsi'/boş => tüm aylar (geriye uyum)
    import re as _re_ay
    ay_v = (ay or "").strip()
    ay_cond = ""
    ay_params: list = []
    if ay_v and ay_v.lower() != "hepsi" and _re_ay.match(r"^\d{4}-\d{2}$", ay_v):
        ay_cond = " AND to_char(ag.tarih, 'YYYY-MM') = %s"
        ay_params = [ay_v]

    if d == "hepsi":
        durum_cond = "ag.durum IN ('aktif','onay_bekliyor')"
        limit = 300
    elif d == "onay_bekliyor":
        durum_cond = "ag.durum='onay_bekliyor'"
        limit = 300
    else:
        durum_cond = "ag.durum='aktif'"
        limit = 200

    with db() as (conn, cur):
        cur.execute(f"""
            SELECT ag.*, k.kart_adi, k.banka
            FROM anlik_giderler ag
            LEFT JOIN kartlar k ON k.id = ag.kart_id
            WHERE {durum_cond}{ay_cond}
            ORDER BY ag.tarih DESC, ag.olusturma DESC
            LIMIT {limit}
        """, ay_params)
        satirlar = [dict(r) for r in cur.fetchall()]

        if include_summary:
            cur.execute(
                """
                SELECT
                    COALESCE(COUNT(*), 0)::int AS adet,
                    COALESCE(SUM(tutar), 0) AS toplam
                FROM anlik_giderler
                WHERE durum='onay_bekliyor'
                  AND COALESCE(TRIM(UPPER(sube)), '') NOT IN ('', 'MERKEZ')
                """
            )
            rw = cur.fetchone() or {}
            return {
                "satirlar": satirlar,
                "ozet": {
                    "sube_bekleyen": {
                        "adet": int(rw.get("adet") or 0),
                        "toplam": float(rw.get("toplam") or 0),
                    }
                },
            }
        return satirlar

@app.post("/api/anlik-gider")
def anlik_gider_ekle(g: AnlikGider):
    sv = (g.sube or "").strip()
    if sv and sv.upper() != "MERKEZ":
        raise HTTPException(
            400,
            "Şube anlık gideri CFO ekranından doğrudan yazılamaz. "
            "Şube personel panelinden girin; kayıt onay kuyruğuna düşer, onay sonrası kasaya işlenir.",
        )
    with db() as (conn, cur):
        if not g.force:
            cur.execute("""
                SELECT id FROM anlik_giderler WHERE durum='aktif'
                AND tarih BETWEEN %s::date - INTERVAL '7 days' AND %s::date + INTERVAL '7 days'
                AND ABS(tutar - %s) < 1 AND kategori = %s
            """, (str(g.tarih), str(g.tarih), g.tutar, g.kategori))
            benzer = cur.fetchall()
            if benzer:
                return {"warning": True, "mesaj": f"Son 7 günde benzer kayıt var ({len(benzer)} adet). Yine de kaydetmek için force=true gönderin."}

        # KART ile ödeme — kart validasyon
        if g.odeme_yontemi == 'kart':
            if not g.kart_id:
                raise HTTPException(400, "Kart seçimi zorunlu")
            cur.execute("SELECT * FROM kartlar WHERE id=%s AND aktif=TRUE FOR UPDATE", (g.kart_id,))
            kart = cur.fetchone()
            if not kart: raise HTTPException(404, "Kart bulunamadı")
            borc = kart_borc(cur, g.kart_id)
            kalan_limit = float(kart['limit_tutar']) - borc
            if kalan_limit < g.tutar:
                raise HTTPException(400, f"Kart limiti yetersiz. Kalan: {kalan_limit:,.0f} ₺")

        gid = str(uuid.uuid4())
        cur.execute("""INSERT INTO anlik_giderler
            (id,tarih,kategori,tutar,aciklama,sube,odeme_yontemi,kart_id,kaynak_id,kaynak_tablo)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (gid, g.tarih, g.kategori, g.tutar, g.aciklama, g.sube,
             g.odeme_yontemi, g.kart_id, g.kaynak_id, g.kaynak_tablo))

        if g.odeme_yontemi == 'kart':
            # Karta HARCAMA yaz — kasaya yazma
            hid = str(uuid.uuid4())
            cur.execute("""
                INSERT INTO kart_hareketleri
                    (id, kart_id, tarih, islem_turu, tutar, taksit_sayisi, aciklama)
                VALUES (%s, %s, %s, 'HARCAMA', %s, 1, %s)
            """, (hid, g.kart_id, g.tarih, g.tutar,
                  f"Anlık gider: {g.aciklama or g.kategori}"))
        else:
            # NAKİT — kasaya yaz
            insert_kasa_hareketi(cur, g.tarih, 'ANLIK_GIDER', -abs(g.tutar),
                f"Anlık gider: {g.aciklama or g.kategori}", 'anlik_giderler', gid)

        audit(cur, 'anlik_giderler', gid, 'INSERT')
        if g.odeme_yontemi == 'kart':
            kart_plan_guncelle_tx(cur)

    return {"id": gid, "success": True}

@app.delete("/api/anlik-gider/{gid}")
def anlik_gider_sil(gid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM anlik_giderler WHERE id=%s AND durum='aktif'", (gid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404, "Kayıt bulunamadı veya zaten iptal edilmiş")
        cur.execute("UPDATE anlik_giderler SET durum='iptal' WHERE id=%s", (gid,))
        if eski.get('odeme_yontemi') == 'kart' and eski.get('kart_id'):
            # Kart harcamasını iptal et
            cur.execute("""
                UPDATE kart_hareketleri SET durum='iptal'
                WHERE kart_id=%s AND islem_turu='HARCAMA'
                AND aciklama LIKE %s AND durum='aktif'
                AND tarih=%s
            """, (eski['kart_id'], f"%{eski.get('aciklama') or eski['kategori']}%", eski['tarih']))
        else:
            # NAKİT — ters kasa kaydı
            iptal_kasa_hareketi(cur, gid, 'anlik_giderler', 'ANLIK_GIDER', 'ANLIK_GIDER_IPTAL', 'Anlık gider iptali')
        audit(cur, 'anlik_giderler', gid, 'IPTAL', eski=eski)
    return {"success": True}

# ── KARTLAR ────────────────────────────────────────────────────
class KartModel(BaseModel):
    kart_adi: str
    banka: str
    limit_tutar: float
    kesim_gunu: int
    son_odeme_gunu: int
    faiz_orani: float = 0.0          # Akdi (yıllık) faiz oranı %
    asgari_oran: float = 40.0        # Bankanın asgari ödeme oranı (%)
    gecikme_faiz_orani: float = 0.0  # Asgari altı ödemede uygulanan yıllık % (0 → akdi×1.3 fallback)
    son_dort_hane: Optional[str] = None  # PDF ekstre eşleştirme için son 4 hane
    sahip: Optional[str] = None      # Kart sahibi (İşletme / Annem / ...) — sorumluluk ayrımı
    ortak_limit_grup: Optional[str] = None  # Aynı krediyi paylaşan kartlar (aynı etiket = ortak limit)

@app.get("/api/kartlar")
def kartlar_listele():
    with db() as (conn, cur):
        cur.execute("SELECT * FROM kartlar WHERE aktif=TRUE ORDER BY banka")
        kartlar = [dict(r) for r in cur.fetchall()]
        sonuc = []
        bugun = bugun_tr()
        for k in kartlar:
            # ── CORE HESAPLAR ──────────────────────────────────
            borc     = kart_borc(cur, k['id'])
            ekstre_v = kart_ekstre(cur, k['id'], k['kesim_gunu'])
            aylik_taksit = ekstre_v["aylik_taksit"]

            # AKTİF DÖNEM hesabı — kart_aktif_donem önceki kapanmış dönemin
            # GERÇEK ödeme verisinden devreden anapara + faizi (KKDF/BSMV dahil)
            # hesaplar; aktif/önündeki ekstre buradan beslenir.
            try:
                aktif = kart_aktif_donem(cur, k['id'])
            except Exception:
                aktif = None
            if aktif:
                bu_ekstre        = float(aktif.get("ekstre_toplam") or 0)
                asgari_odeme     = float(aktif.get("asgari_tahmini") or 0)
                devreden_ana     = float(aktif.get("devreden_anapara") or 0)
                devreden_fz      = float(aktif.get("devreden_faiz") or 0)
                aktif_donem_ay   = aktif.get("ay")
                aktif_kesim      = aktif.get("kesim_tarihi")
                aktif_son_odeme  = aktif.get("son_odeme_tarihi")
                onceki_ekstre    = float(aktif.get("onceki_ekstre") or 0)
                onceki_asgari    = float(aktif.get("onceki_asgari") or 0)
                onceki_odenen    = float(aktif.get("onceki_odenen") or 0)
                onceki_durum     = aktif.get("onceki_durum") or "yok"
            else:
                bu_ekstre        = ekstre_v["ekstre_toplam"]
                asgari_odeme     = bu_ekstre * kart_asgari_orani(k)
                devreden_ana     = 0.0
                devreden_fz      = ekstre_v.get("devreden_faiz", 0)
                aktif_donem_ay = aktif_kesim = aktif_son_odeme = None
                onceki_ekstre = onceki_asgari = onceki_odenen = 0.0
                onceki_durum  = "yok"

            # Gelecek ekstre = bir sonraki kesim için tek çekim + taksit payı.
            # Aktif dönem zaten "şu an açık" olan ekstre; "gelecek" demek
            # aktif dönemden BİR SONRAKİ kesim demek. Aralık:
            # (aktif_kesim, aktif_kesim + 1 ay] içine düşen tek çekim harcamalar.
            if aktif_kesim:
                cur.execute("""
                    SELECT COALESCE(SUM(tutar),0) AS gelecek
                    FROM kart_hareketleri
                    WHERE kart_id = %s AND durum = 'aktif' AND islem_turu = 'HARCAMA'
                      AND taksit_sayisi = 1
                      AND tarih >  %s::date
                      AND tarih <= %s::date + INTERVAL '1 month'
                """, (k['id'], aktif_kesim, aktif_kesim))
                gelecek_tek = float(cur.fetchone()['gelecek'])
            else:
                gelecek_tek = 0.0
            gelecek_ekstre = gelecek_tek + aylik_taksit

            limit = float(k['limit_tutar'])
            son_odeme_gun = k['son_odeme_gunu']
            # AKTİF dönemin son ödeme tarihi varsa onu kullan (kart_aktif_donem'den);
            # yoksa eski mantık (bu ayın son ödeme günü, geçmişse bir sonraki ay).
            if aktif_son_odeme:
                try:
                    son_odeme = datetime.strptime(aktif_son_odeme, "%Y-%m-%d").date()
                except Exception:
                    son_odeme = date(bugun.year, bugun.month, son_odeme_gun)
            else:
                son_odeme = date(bugun.year, bugun.month, son_odeme_gun)
                if son_odeme < bugun:
                    if bugun.month == 12:
                        son_odeme = date(bugun.year+1, 1, son_odeme_gun)
                    else:
                        son_odeme = date(bugun.year, bugun.month+1, son_odeme_gun)
            gun_kaldi = (son_odeme - bugun).days

            cur.execute("""SELECT * FROM odeme_plani WHERE kart_id=%s AND durum='bekliyor'
                ORDER BY tarih ASC LIMIT 1""", (k['id'],))
            yaklasan = cur.fetchone()

            sonuc.append({**k,
                "guncel_borc": borc,
                "kalan_limit": limit - borc,
                "limit_doluluk": borc/limit if limit > 0 else 0,
                "asgari_odeme": asgari_odeme,
                "bu_ekstre": bu_ekstre,
                "devreden_anapara": devreden_ana,
                "devreden_faiz": devreden_fz,
                "tek_cekim": ekstre_v.get("tek_cekim", 0),
                "gelecek_ekstre": gelecek_ekstre,
                "aylik_taksit": aylik_taksit,
                "gun_kaldi": gun_kaldi,
                "son_odeme_tarihi": str(son_odeme),
                "aktif_donem":      aktif_donem_ay,
                "aktif_kesim":      aktif_kesim,
                "aktif_son_odeme":  aktif_son_odeme,
                "onceki_ekstre":    onceki_ekstre,
                "onceki_asgari":    onceki_asgari,
                "onceki_odenen":    onceki_odenen,
                "onceki_durum":     onceki_durum,
                "blink": gun_kaldi <= 0 and yaklasan is not None,
                "yaklasan_odeme": dict(yaklasan) if yaklasan else None
            })
        # ── ORTAK LİMİT HAVUZU: aynı grubu paylaşan kartlarda kalan limiti TEK
        #    havuzdan hesapla (çift sayma). grup_limit = gruptaki en büyük limit.
        gruplar = {}
        for s in sonuc:
            g = (s.get("ortak_limit_grup") or "").strip()
            if g:
                gruplar.setdefault(g, []).append(s)
        for g, uyeler in gruplar.items():
            if len(uyeler) < 2:
                continue
            grup_limit = max(float(u.get("limit_tutar") or 0) for u in uyeler)
            grup_borc = sum(float(u.get("guncel_borc") or 0) for u in uyeler)
            grup_kalan = grup_limit - grup_borc
            for u in uyeler:
                u["ortak_grup_limit"] = round(grup_limit, 2)
                u["ortak_grup_borc"] = round(grup_borc, 2)
                u["ortak_grup_uye"] = len(uyeler)
                u["kalan_limit"] = round(grup_kalan, 2)  # paylaşılan → çift sayma yok
                u["limit_doluluk"] = (grup_borc / grup_limit) if grup_limit > 0 else 0
        return sonuc

def _kart_validate(k: KartModel):
    """Kart ekle/güncelle ortak doğrulaması — bozuk değerleri reddet."""
    if not (k.kart_adi or "").strip():
        raise HTTPException(400, "Kart adı zorunlu")
    if not (k.banka or "").strip():
        raise HTTPException(400, "Banka zorunlu")
    if float(k.limit_tutar or 0) < 0:
        raise HTTPException(400, "Limit negatif olamaz")
    if not (1 <= int(k.kesim_gunu or 0) <= 31):
        raise HTTPException(400, "Kesim günü 1–31 arası olmalı")
    if not (1 <= int(k.son_odeme_gunu or 0) <= 31):
        raise HTTPException(400, "Son ödeme günü 1–31 arası olmalı")
    if not (0 <= float(k.faiz_orani or 0) <= 500):
        raise HTTPException(400, "Faiz oranı 0–500 arası olmalı (yıllık %)")
    if not (0 <= float(k.gecikme_faiz_orani or 0) <= 500):
        raise HTTPException(400, "Gecikme faiz oranı 0–500 arası olmalı")
    if not (10 <= float(k.asgari_oran or 0) <= 100):
        raise HTTPException(400, "Asgari oran 10–100 arası olmalı (%)")


@app.post("/api/kartlar")
def kart_ekle(k: KartModel):
    _kart_validate(k)
    with db() as (conn, cur):
        # ÇİFT KART KORUMASI: aynı son 4 haneli AKTİF kart varsa yenisini AÇMA — mevcuti döndür.
        # (son_dort_hane eşleştirme anahtarı; çiftlenirse mutabakat bozulur. "Kartı Ekle"ye
        #  iki kez basmak / iki ekstreyi arka arkaya atmak güvenli → idempotent.)
        if k.son_dort_hane:
            _s4 = k.son_dort_hane.strip()[-4:]
            cur.execute("SELECT id::text, kart_adi FROM kartlar WHERE son_dort_hane=%s AND aktif=TRUE LIMIT 1", (_s4,))
            _ex = cur.fetchone()
            if _ex:
                _ex = dict(_ex)
                return {"id": _ex["id"], "success": True, "mevcut": True,
                        "mesaj": f"Bu son 4 hane (…{_s4}) zaten kayıtlı: {_ex['kart_adi']} — eşleştirildi, yeni kart açılmadı."}
        kid = str(uuid.uuid4())
        cur.execute("""INSERT INTO kartlar (id,kart_adi,banka,limit_tutar,kesim_gunu,son_odeme_gunu,faiz_orani,asgari_oran,gecikme_faiz_orani,son_dort_hane,sahip,ortak_limit_grup)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (kid, k.kart_adi, k.banka, k.limit_tutar, k.kesim_gunu, k.son_odeme_gunu,
             k.faiz_orani, k.asgari_oran, k.gecikme_faiz_orani,
             k.son_dort_hane.strip()[-4:] if k.son_dort_hane else None,
             (k.sahip or 'İşletme').strip() or 'İşletme',
             (k.ortak_limit_grup or '').strip() or None))
        audit(cur, 'kartlar', kid, 'INSERT')
    return {"id": kid, "success": True}

@app.put("/api/kartlar/{kid}")
def kart_guncelle(kid: str, k: KartModel):
    _kart_validate(k)
    with db() as (conn, cur):
        cur.execute("SELECT * FROM kartlar WHERE id=%s", (kid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)
        cur.execute("""UPDATE kartlar SET kart_adi=%s,banka=%s,limit_tutar=%s,
            kesim_gunu=%s,son_odeme_gunu=%s,faiz_orani=%s,asgari_oran=%s,gecikme_faiz_orani=%s,
            son_dort_hane=%s,sahip=%s,ortak_limit_grup=%s
            WHERE id=%s""",
            (k.kart_adi, k.banka, k.limit_tutar, k.kesim_gunu, k.son_odeme_gunu,
             k.faiz_orani, k.asgari_oran, k.gecikme_faiz_orani,
             k.son_dort_hane.strip()[-4:] if k.son_dort_hane else None,
             (k.sahip or 'İşletme').strip() or 'İşletme',
             (k.ortak_limit_grup or '').strip() or None, kid))
        audit(cur, 'kartlar', kid, 'UPDATE', eski=eski)
    return {"success": True}

@app.delete("/api/kartlar/{kid}")
def kart_sil(kid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM kartlar WHERE id=%s", (kid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)
        cur.execute("UPDATE kartlar SET aktif=FALSE WHERE id=%s", (kid,))
        audit(cur, 'kartlar', kid, 'PASIF', eski=eski)
    return {"success": True}

class KartKaliciSilBody(BaseModel):
    onay_pin: Optional[str] = None


@app.post("/api/kartlar/{kid}/kalici-sil")
def kart_kalici_sil(kid: str, body: KartKaliciSilBody):
    """Kartı KALICI siler (kayıtlardan tamamen kaldırır). Yalnızca AKTİF işlemi
    olmayan kartlar (test/yanlış eklenen) silinebilir; işlemi olan kart silinemez →
    'Pasife Al' kullanılır (defter bütünlüğü). İşletme onayı (Merve Karabacak PIN) şart."""
    from operasyon_merkez_api import _isletme_onay_dogrula
    with db() as (conn, cur):
        cur.execute("SELECT id, kart_adi FROM kartlar WHERE id=%s", (kid,))
        k = cur.fetchone()
        if not k:
            raise HTTPException(404, "Kart bulunamadı")
        kart_adi = dict(k)["kart_adi"]
        onayci = _isletme_onay_dogrula(cur, body.onay_pin)  # PIN hatalı → 403
        cur.execute(
            "SELECT COUNT(*) AS n FROM kart_hareketleri WHERE kart_id=%s AND durum='aktif'", (kid,)
        )
        if int(dict(cur.fetchone())["n"]) > 0:
            raise HTTPException(
                409,
                "Bu kartın aktif hareketleri var → kalıcı silinemez. Önce hareketleri "
                "temizleyin ya da 'Pasife Al' kullanın (defter korunur).",
            )
        # İşlemsiz kart → bağlı (iptal) kayıtları + snapshot + plan temizle, sonra kartı sil
        cur.execute("DELETE FROM kart_hareketleri WHERE kart_id=%s", (kid,))
        cur.execute("DELETE FROM kart_ekstre_donem WHERE kart_id=%s", (kid,))
        # onay_kuyrugu odeme_plani'na bağlı olabilir → önce o kartın planlarına ait
        # bekleyen onay kayıtlarını temizle, sonra TÜM odeme_plani (her durum) sil (FK).
        cur.execute(
            "UPDATE onay_kuyrugu SET durum='reddedildi' "
            "WHERE durum='bekliyor' AND kaynak_id IN (SELECT id FROM odeme_plani WHERE kart_id=%s)",
            (kid,),
        )
        cur.execute("DELETE FROM odeme_plani WHERE kart_id=%s", (kid,))
        cur.execute("DELETE FROM kartlar WHERE id=%s", (kid,))
        audit(cur, "kartlar", kid, "KALICI_SIL", yeni={"kart_adi": kart_adi, "onayci": onayci.get("ad_soyad")})
    return {"success": True, "kart_adi": kart_adi}


@app.get("/api/kartlar/{kid}/taksitler")
def kart_taksitler(kid: str):
    """
    Kartın aktif taksitli harcamaları — kalan/geçen taksit dahil.
    """
    with db() as (conn, cur):
        cur.execute("SELECT * FROM kartlar WHERE id=%s AND aktif=TRUE", (kid,))
        if not cur.fetchone(): raise HTTPException(404, "Kart bulunamadı")
        return {
            "taksitler":      taksit_detay(cur, kid),
            "gelecek_yukler": gelecek_taksit_yuku(cur, kid, ay_sayisi=3),
        }

@app.get("/api/kartlar/taksit-yuku")
def tum_taksit_yuku():
    """Tüm aktif kartların önümüzdeki 3 aylık taksit yükü."""
    with db() as (conn, cur):
        return tum_kartlar_taksit_yuku(cur, ay_sayisi=3)

@app.get("/api/kartlar/{kid}/ekstre-forecast")
def kart_ekstre_forecast_endpoint(kid: str, aylar: int = 6, senaryo: str = "odenir"):
    """
    Kartın gelecek N ay ekstre tahmini — banka kesmeden önce.
    senaryo: 'tam' | 'odenir' | 'odenmez' (zincirleme faiz varsayımı)
    """
    aylar = max(1, min(12, int(aylar or 6)))
    if senaryo not in ("tam", "odenir", "odenmez"):
        senaryo = "odenir"
    with db() as (conn, cur):
        cur.execute("SELECT 1 FROM kartlar WHERE id=%s AND aktif=TRUE", (kid,))
        if not cur.fetchone():
            raise HTTPException(404, "Kart bulunamadı")
        return {
            "aylar": aylar,
            "senaryo": senaryo,
            "donemler": kart_ekstre_forecast(cur, kid, aylar, senaryo),
        }

@app.get("/api/kartlar/ekstre-forecast")
def tum_kartlar_ekstre_forecast_endpoint(aylar: int = 6, senaryo: str = "odenir"):
    """Tüm aktif kartların gelecek N ay ekstre forecast'i."""
    aylar = max(1, min(12, int(aylar or 6)))
    if senaryo not in ("tam", "odenir", "odenmez"):
        senaryo = "odenir"
    with db() as (conn, cur):
        return {
            "aylar": aylar,
            "senaryo": senaryo,
            "kartlar": tum_kartlar_ekstre_forecast(cur, aylar, senaryo),
        }

@app.put("/api/kartlar/{kid}/kesim-tarihi")
def kart_kesim_tarihi_guncelle(kid: str, body: dict):
    """
    Kartın son kesim tarihini ve toleransını güncelle.
    body: { son_kesim_tarihi: 'YYYY-MM-DD', kesim_tolerans: int }
    """
    with db() as (conn, cur):
        cur.execute("SELECT * FROM kartlar WHERE id=%s AND aktif=TRUE", (kid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404, "Kart bulunamadı")
        son_kesim   = body.get('son_kesim_tarihi')
        tolerans    = body.get('kesim_tolerans', 0)
        cur.execute("""
            UPDATE kartlar
            SET son_kesim_tarihi = %s, kesim_tolerans = %s
            WHERE id = %s
        """, (son_kesim, tolerans, kid))
        audit(cur, 'kartlar', kid, 'KESIM_GUNCELLE', eski=eski)
    return {"success": True, "son_kesim_tarihi": son_kesim, "kesim_tolerans": tolerans}


class KartHareket(BaseModel):
    kart_id: str
    tarih: date
    islem_turu: str
    tutar: float
    taksit_sayisi: int = 1
    faiz_tutari: float = 0
    ana_para: float = 0
    aciklama: Optional[str] = None
    baslangic_tarihi: Optional[date] = None  # taksitli alımlar için
    harcama_tipi: Optional[str] = None       # 'isletme' | 'sahsi' | 'belirsiz'

@app.get("/api/kart-hareketleri")
def kart_hareketleri(kart_id: Optional[str] = None, limit: int = 200):
    with db() as (conn, cur):
        if kart_id:
            cur.execute("""SELECT kh.*, k.banka, k.kart_adi FROM kart_hareketleri kh
                JOIN kartlar k ON k.id=kh.kart_id
                WHERE kh.kart_id=%s AND kh.durum='aktif' ORDER BY kh.tarih DESC LIMIT %s""", (kart_id, limit))
        else:
            cur.execute("""SELECT kh.*, k.banka, k.kart_adi FROM kart_hareketleri kh
                JOIN kartlar k ON k.id=kh.kart_id
                WHERE kh.durum='aktif' ORDER BY kh.tarih DESC LIMIT %s""", (limit,))
        return [dict(r) for r in cur.fetchall()]

@app.post("/api/kart-hareketleri")
def kart_hareket_ekle(h: KartHareket):
    with db() as (conn, cur):
        hid = str(uuid.uuid4())
        faiz = abs(h.faiz_tutari) if h.faiz_tutari else 0
        ana  = abs(h.ana_para)   if h.ana_para   else 0
        # Taksitli alımda baslangic_tarihi = hareket tarihi (girilmemişse)
        bas_tarih = h.baslangic_tarihi or (h.tarih if h.taksit_sayisi > 1 else None)
        _htip = (h.harcama_tipi or '').strip().lower()
        if _htip not in ('isletme', 'sahsi', 'belirsiz'):
            _htip = 'belirsiz' if h.islem_turu == 'HARCAMA' else 'isletme'
        cur.execute("""INSERT INTO kart_hareketleri
            (id,kart_id,tarih,islem_turu,tutar,taksit_sayisi,faiz_tutari,ana_para,aciklama,baslangic_tarihi,harcama_tipi)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (hid, h.kart_id, h.tarih, h.islem_turu, h.tutar,
             h.taksit_sayisi, faiz, ana, h.aciklama, bas_tarih, _htip))
        if h.islem_turu == 'ODEME':
            insert_kasa_hareketi(cur, str(h.tarih), 'KART_ODEME', -abs(h.tutar),
                h.aciklama or 'Kart ödemesi',
                'kart_hareketleri', hid, hid, 'KART_ODEME')
        audit(cur, 'kart_hareketleri', hid, 'INSERT')
        if h.islem_turu in ('HARCAMA', 'ODEME', 'FAIZ'):
            kart_plan_guncelle_tx(cur)
    if h.islem_turu == 'ODEME':
        uyari_cache_clear()
    return {"id": hid, "success": True}

@app.delete("/api/kart-hareketleri/{hid}")
def kart_hareket_iptal(hid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM kart_hareketleri WHERE id=%s AND durum='aktif'", (hid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404, "Kayıt bulunamadı veya zaten iptal edilmiş")
        cur.execute("UPDATE kart_hareketleri SET durum='iptal' WHERE id=%s", (hid,))
        if eski['islem_turu'] == 'ODEME':
            iptal_kasa_hareketi(cur, hid, 'kart_hareketleri', 'KART_ODEME', 'KART_ODEME_IPTAL', 'Kart ödemesi iptali')
        audit(cur, 'kart_hareketleri', hid, 'IPTAL', eski=eski)
    return {"success": True}


@app.post("/api/kart-hareketleri/{hid}/harcama-tipi")
def kart_hareket_tip_belirle(hid: str, tip: str):
    """Bir kart harcamasını şahsi / işletme / belirsiz olarak sınıflandırır (Faz K-A)."""
    t = (tip or '').strip().lower()
    if t not in ('isletme', 'sahsi', 'belirsiz'):
        raise HTTPException(400, "tip: isletme | sahsi | belirsiz")
    with db() as (conn, cur):
        cur.execute("UPDATE kart_hareketleri SET harcama_tipi=%s WHERE id=%s AND durum='aktif' RETURNING aciklama", (t, hid))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Hareket bulunamadı")
        # SATICI HAFIZASI: bu satıcıyı öğren → sonraki aynı satıcı otomatik önerilsin
        ogrenildi = None
        if t in ("isletme", "sahsi"):
            anahtar = _satici_anahtar(dict(row).get("aciklama"))
            if anahtar:
                cur.execute(
                    """INSERT INTO kart_satici_kural (anahtar, harcama_tipi, adet)
                       VALUES (%s, %s, 1)
                       ON CONFLICT (anahtar) DO UPDATE SET
                         harcama_tipi=EXCLUDED.harcama_tipi,
                         adet=kart_satici_kural.adet+1, guncelleme=NOW()""",
                    (anahtar, t),
                )
                ogrenildi = anahtar
        audit(cur, 'kart_hareketleri', hid, 'HARCAMA_TIPI', yeni={'tip': t})
    return {"success": True, "harcama_tipi": t, "ogrenilen_satici": ogrenildi}


@app.get("/api/kartlar/harcama-ozet")
def kart_harcama_ozet():
    """Şahsi/işletme/belirsiz kırılımı — kart başına ve toplam (sadece HARCAMA, aktif).
    'İşletmenin gerçek kart yükü' ile şahsi karışıklığı ayırır."""
    with db() as (conn, cur):
        cur.execute("""
            SELECT k.id::text AS kart_id, k.kart_adi, COALESCE(k.sahip,'İşletme') AS sahip,
                   kh.harcama_tipi,
                   COALESCE(SUM(kh.tutar),0)::float AS toplam,
                   COUNT(*)::int AS adet
            FROM kart_hareketleri kh
            JOIN kartlar k ON k.id = kh.kart_id
            WHERE kh.durum='aktif' AND kh.islem_turu='HARCAMA' AND k.aktif=TRUE
            GROUP BY k.id, k.kart_adi, k.sahip, kh.harcama_tipi
            ORDER BY k.kart_adi
        """)
        kartlar = {}
        gen = {'isletme': 0.0, 'sahsi': 0.0, 'belirsiz': 0.0}
        for r in (cur.fetchall() or []):
            r = dict(r)
            kid = r['kart_id']
            tip = r['harcama_tipi'] if r['harcama_tipi'] in gen else 'belirsiz'
            k = kartlar.setdefault(kid, {
                'kart_id': kid, 'kart_adi': r['kart_adi'], 'sahip': r['sahip'],
                'isletme': 0.0, 'sahsi': 0.0, 'belirsiz': 0.0, 'adet': 0,
            })
            k[tip] += float(r['toplam']); k['adet'] += int(r['adet'])
            gen[tip] += float(r['toplam'])
        return {
            "genel": {**gen, "toplam": round(sum(gen.values()), 2)},
            "kartlar": sorted(kartlar.values(), key=lambda x: -(x['isletme'] + x['sahsi'] + x['belirsiz'])),
        }


@app.get("/api/kartlar/ekstre-ping")
def kart_ekstre_ping():
    """Teşhis: pdfplumber yüklü mü + yeni kod canlı mı (deploy doğrulama)."""
    try:
        import pdfplumber
        return {"ok": True, "pdfplumber": getattr(pdfplumber, "__version__", "?"), "marker": "e0-sync-v2"}
    except Exception as e:
        return {"ok": False, "hata": str(e), "marker": "e0-sync-v2"}


@app.get("/api/kartlar/borc-kocu")
def kart_borc_kocu(strateji: str = "cig", nakit: float = 0):
    """Borç ödeme koçu: hangi kartı önce kapat (çığ=en yüksek faiz / kartopu=en küçük
    borç), aylık faiz kaybı, eldeki nakitle bu ayki dağıtım önerisi.
    Standart borç-yönetimi çerçeveleri — kişiye özel mali tavsiye değildir."""
    nakit = max(0.0, float(nakit or 0))  # negatif nakit anlamsız → 0'a kırp
    from finans_core import son_odeme_tarihi_hesapla, kesim_tarihi_hesapla
    bugun = bugun_tr()
    with db() as (conn, cur):
        cur.execute("SELECT id::text, kart_adi, banka, COALESCE(sahip,'İşletme') AS sahip, "
                    "limit_tutar, faiz_orani, asgari_oran, kesim_gunu, son_odeme_gunu "
                    "FROM kartlar WHERE aktif=TRUE")
        kl = [dict(r) for r in (cur.fetchall() or [])]
        cur.execute("SELECT DISTINCT ON (kart_id) kart_id::text AS kid, asgari_tutar, "
                    "son_odeme_tarihi::text AS sot FROM kart_ekstre_donem ORDER BY kart_id, donem DESC")
        snap = {r["kid"]: dict(r) for r in (cur.fetchall() or [])}
        kartlar = []
        for k in kl:
            borc = float(kart_borc(cur, k["id"]) or 0)
            if borc <= 0.5:
                continue
            faiz_y = float(k.get("faiz_orani") or 0)
            aylik_faiz = round(borc * (faiz_y / 100 / 12), 2)
            s = snap.get(k["id"], {})
            asgari = float(s.get("asgari_tutar") or 0) or round(borc * float(k.get("asgari_oran") or 40) / 100, 2)
            so = s.get("sot")
            if not so:
                try:
                    kt = kesim_tarihi_hesapla(bugun.year, bugun.month, int(k.get("kesim_gunu") or 1))
                    so = str(son_odeme_tarihi_hesapla(kt, int(k.get("son_odeme_gunu") or 10)))
                except Exception:
                    so = None
            kartlar.append({
                "kart_id": k["id"], "kart_adi": k["kart_adi"], "sahip": k["sahip"],
                "borc": round(borc, 2), "faiz_yillik": faiz_y, "aylik_faiz": aylik_faiz,
                "asgari": round(asgari, 2), "son_odeme": so, "faiz_belirsiz": faiz_y <= 0,
                "onerilen_odeme": 0.0,
            })
        if strateji == "kartopu":
            kartlar.sort(key=lambda x: x["borc"])
        else:
            strateji = "cig"
            kartlar.sort(key=lambda x: (-x["faiz_yillik"], -x["borc"]))
        toplam_borc = round(sum(x["borc"] for x in kartlar), 2)
        toplam_aylik_faiz = round(sum(x["aylik_faiz"] for x in kartlar), 2)
        toplam_asgari = round(sum(x["asgari"] for x in kartlar), 2)
        kalan = float(nakit or 0)
        if kalan > 0:
            for x in kartlar:  # önce tüm asgariler (öncelik sırasıyla)
                pay = min(x["asgari"], x["borc"], kalan)
                x["onerilen_odeme"] = round(pay, 2); kalan = round(kalan - pay, 2)
                if kalan <= 0:
                    break
            for x in kartlar:  # kalanı önceliğe (çığ/kartopu sırası)
                if kalan <= 0:
                    break
                ek = min(kalan, round(x["borc"] - x["onerilen_odeme"], 2))
                if ek > 0:
                    x["onerilen_odeme"] = round(x["onerilen_odeme"] + ek, 2); kalan = round(kalan - ek, 2)
        return {
            "strateji": strateji, "nakit": float(nakit or 0),
            "toplam_borc": toplam_borc, "toplam_aylik_faiz": toplam_aylik_faiz,
            "toplam_asgari": toplam_asgari,
            "asgari_karsilaniyor": (float(nakit or 0) >= toplam_asgari) if nakit else None,
            "artan_nakit": round(kalan, 2) if nakit else 0,
            "oncelik": kartlar[0] if kartlar else None,
            "kartlar": kartlar,
        }


@app.get("/api/kartlar/borc-projeksiyon")
def kart_borc_projeksiyon(aylik: float, strateji: str = "cig"):
    """Borç kurtuluş projeksiyonu: aylık X ödersen kaç ayda biter + toplam faiz;
    sadece asgari ödersen ne kadar faiz/ay kaybedersin. Gerçek faiz simülasyonu
    (çığ/kartopu). Standart çerçeve — kişiye özel mali tavsiye değildir."""
    aylik = max(0.0, float(aylik or 0))  # negatif aylık anlamsız → 0'a kırp
    from datetime import date as _d
    bugun = bugun_tr()
    with db() as (conn, cur):
        cur.execute("SELECT id::text, faiz_orani, asgari_oran FROM kartlar WHERE aktif=TRUE")
        kl = [dict(r) for r in (cur.fetchall() or [])]
        kartlar = []
        for k in kl:
            b = float(kart_borc(cur, k["id"]) or 0)
            if b <= 0.5:
                continue
            cur.execute("SELECT asgari_tutar FROM kart_ekstre_donem WHERE kart_id=%s ORDER BY donem DESC LIMIT 1", (k["id"],))
            sr = cur.fetchone()
            asg = float((dict(sr).get("asgari_tutar") if sr else 0) or 0) or round(b * float(k.get("asgari_oran") or 40) / 100, 2)
            kartlar.append({"borc": b, "oran": float(k.get("faiz_orani") or 0) / 100 / 12, "asgari": asg})

    toplam_borc = round(sum(c["borc"] for c in kartlar), 2)
    toplam_asgari = round(sum(c["asgari"] for c in kartlar), 2)

    def simule(butce):
        cs = [dict(c) for c in kartlar]
        cs.sort(key=(lambda x: x["borc"]) if strateji == "kartopu" else (lambda x: -x["oran"]))
        ay = 0; tfaiz = 0.0; onceki = sum(c["borc"] for c in cs)
        while sum(c["borc"] for c in cs) > 1 and ay < 360:
            ay += 1
            for c in cs:
                f = c["borc"] * c["oran"]; c["borc"] += f; tfaiz += f
            kalan = butce
            for c in cs:
                if kalan <= 0:
                    break
                p = min(c["asgari"], c["borc"], kalan); c["borc"] = round(c["borc"] - p, 2); kalan = round(kalan - p, 2)
            for c in cs:
                if kalan <= 0:
                    break
                e = min(kalan, c["borc"]); c["borc"] = round(c["borc"] - e, 2); kalan = round(kalan - e, 2)
            simdi = sum(c["borc"] for c in cs)
            if simdi >= onceki - 0.01:  # bütçe faizi karşılamıyor → borç azalmıyor
                return {"ay": None, "toplam_faiz": round(tfaiz, 2), "bitmedi": True}
            onceki = simdi
        return {"ay": ay, "toplam_faiz": round(tfaiz, 2), "bitmedi": sum(c["borc"] for c in cs) > 1}

    def bitis(ay):
        if not ay:
            return None
        m = bugun.month - 1 + ay
        return str(_d(bugun.year + m // 12, m % 12 + 1, 1))

    verilen = simule(float(aylik or 0))
    asgari_only = simule(toplam_asgari)
    tasarruf = None
    erken_ay = None
    if verilen.get("ay") and asgari_only.get("ay"):
        tasarruf = round(asgari_only["toplam_faiz"] - verilen["toplam_faiz"], 2)
        erken_ay = asgari_only["ay"] - verilen["ay"]
    return {
        "aylik": float(aylik or 0), "strateji": "kartopu" if strateji == "kartopu" else "cig",
        "toplam_borc": toplam_borc, "toplam_asgari": toplam_asgari,
        "verilen": {**verilen, "bitis_tarihi": bitis(verilen.get("ay"))},
        "asgari_only": {**asgari_only, "bitis_tarihi": bitis(asgari_only.get("ay"))},
        "tasarruf_faiz": tasarruf, "erken_ay": erken_ay,
    }


@app.get("/api/kartlar/analiz")
def kart_analiz_ozet():
    """Faz: saf ANALİZ görünümü — içe aktarılmış veriden (kart_hareketleri +
    kart_ekstre_donem). Yükleme yok; tek yükleme noktası Ekstre Yükle."""
    with db() as (conn, cur):
        cur.execute("""
            SELECT donem::text AS donem,
                   COALESCE(SUM(donem_borcu),0)::float AS borc,
                   COALESCE(SUM(donem_faizi),0)::float AS faiz
            FROM kart_ekstre_donem GROUP BY donem ORDER BY donem
        """)
        aylik = [dict(r) for r in (cur.fetchall() or [])]
        cur.execute("""
            SELECT COALESCE(NULLIF(kategori,''),'Diğer') AS kategori,
                   COALESCE(SUM(tutar),0)::float AS tutar, COUNT(*)::int AS adet
            FROM kart_hareketleri
            WHERE durum='aktif' AND islem_turu='HARCAMA' AND kategori IS NOT NULL
            GROUP BY COALESCE(NULLIF(kategori,''),'Diğer') ORDER BY tutar DESC
        """)
        kategori = [dict(r) for r in (cur.fetchall() or [])]
        cur.execute("""
            SELECT k.kart_adi, COALESCE(SUM(kh.tutar),0)::float AS harcama
            FROM kart_hareketleri kh JOIN kartlar k ON k.id=kh.kart_id
            WHERE kh.durum='aktif' AND kh.islem_turu='HARCAMA' AND k.aktif=TRUE
            GROUP BY k.kart_adi HAVING SUM(kh.tutar) > 0 ORDER BY harcama DESC
        """)
        kart_bazli = [dict(r) for r in (cur.fetchall() or [])]
        return {"aylik": aylik, "kategori": kategori, "kart_bazli": kart_bazli,
                "veri_var": bool(aylik or kategori or kart_bazli)}


@app.get("/api/kartlar/ekstre-arsiv")
def kart_ekstre_arsiv():
    """Faz: kart × ay ekstre ARŞİVİ — her kart için tüm aylık ekstre snapshot'ları
    (kart_ekstre_donem). Her (kart, donem) ayrı satır; aylar birikir. Salt görünürlük."""
    with db() as (conn, cur):
        cur.execute("""
            SELECT ked.kart_id::text AS kart_id,
                   k.kart_adi, k.banka, COALESCE(k.sahip,'İşletme') AS sahip,
                   k.son_dort_hane,
                   ked.donem::text            AS donem,
                   ked.kesim_tarihi::text     AS kesim_tarihi,
                   ked.son_odeme_tarihi::text AS son_odeme_tarihi,
                   COALESCE(ked.donem_borcu,0)::float   AS donem_borcu,
                   COALESCE(ked.asgari_tutar,0)::float  AS asgari_tutar,
                   COALESCE(ked.onceki_borc,0)::float   AS onceki_borc,
                   COALESCE(ked.donem_harcama,0)::float AS donem_harcama,
                   COALESCE(ked.donem_odeme,0)::float   AS donem_odeme,
                   COALESCE(ked.donem_faizi,0)::float   AS donem_faizi,
                   COALESCE(ked.kalan_taksit,0)::float  AS kalan_taksit,
                   ked.kaynak
            FROM kart_ekstre_donem ked
            JOIN kartlar k ON k.id = ked.kart_id
            ORDER BY k.kart_adi, ked.donem DESC
        """)
        rows = [dict(r) for r in (cur.fetchall() or [])]
        kartlar = {}
        for r in rows:
            kid = r["kart_id"]
            grup = kartlar.get(kid)
            if grup is None:
                grup = {
                    "kart_id": kid, "kart_adi": r["kart_adi"], "banka": r["banka"],
                    "sahip": r["sahip"], "son_dort_hane": r["son_dort_hane"],
                    "donemler": [], "donem_adet": 0,
                    "toplam_faiz": 0.0, "son_donem": None,
                }
                kartlar[kid] = grup
            grup["donemler"].append({
                "donem": r["donem"], "kesim_tarihi": r["kesim_tarihi"],
                "son_odeme_tarihi": r["son_odeme_tarihi"],
                "donem_borcu": r["donem_borcu"], "asgari_tutar": r["asgari_tutar"],
                "onceki_borc": r["onceki_borc"], "donem_harcama": r["donem_harcama"],
                "donem_odeme": r["donem_odeme"], "donem_faizi": r["donem_faizi"],
                "kalan_taksit": r["kalan_taksit"], "kaynak": r["kaynak"],
            })
            grup["donem_adet"] += 1
            grup["toplam_faiz"] = round(grup["toplam_faiz"] + r["donem_faizi"], 2)
            if grup["son_donem"] is None:  # donemler DESC sıralı → ilk gelen en yeni
                grup["son_donem"] = r["donem"]
        kart_list = sorted(kartlar.values(), key=lambda g: g["kart_adi"] or "")
        return {"kartlar": kart_list, "kart_adet": len(kart_list),
                "veri_var": bool(kart_list)}


@app.get("/api/kartlar/borc-faiz-ozet")
def kart_borc_faiz_ozet():
    """Faz KX: kart başına ve toplam — güncel borç + ekstrelerden toplam ödenen banka
    faizi + bu dönem ekstresi yüklendi mi (aylık mekanizma takibi)."""
    from datetime import date as _date
    bugun = bugun_tr()
    with db() as (conn, cur):
        cur.execute("SELECT id::text, kart_adi, banka, COALESCE(sahip,'İşletme') AS sahip, "
                    "limit_tutar, kesim_gunu, son_odeme_gunu, son_dort_hane FROM kartlar WHERE aktif=TRUE ORDER BY kart_adi")
        kartlar = [dict(r) for r in (cur.fetchall() or [])]
        # ekstre snapshot toplamları (faiz) + son dönem
        cur.execute("""
            SELECT kart_id::text,
                   COALESCE(SUM(donem_faizi),0)::float AS toplam_faiz,
                   MAX(donem)::text AS son_donem,
                   COUNT(*)::int AS donem_adet
            FROM kart_ekstre_donem GROUP BY kart_id
        """)
        snap = {r["kart_id"]: dict(r) for r in (cur.fetchall() or [])}
        bu_ay = str(_date(bugun.year, bugun.month, 1))
        satirlar, toplam_borc, toplam_faiz, eksik = [], 0.0, 0.0, []
        for k in kartlar:
            b = float(kart_borc(cur, k["id"]) or 0)
            s = snap.get(k["id"], {})
            tf = float(s.get("toplam_faiz") or 0)
            son_donem = s.get("son_donem")
            bu_ay_var = bool(son_donem and son_donem[:7] == bu_ay[:7])
            toplam_borc += b; toplam_faiz += tf
            if not bu_ay_var:
                eksik.append(k["kart_adi"])
            satirlar.append({
                "kart_id": k["id"], "kart_adi": k["kart_adi"], "banka": k["banka"],
                "sahip": k["sahip"], "limit": float(k["limit_tutar"] or 0),
                "guncel_borc": round(b, 2), "toplam_odenen_faiz": round(tf, 2),
                "son_ekstre_donem": son_donem, "ekstre_adet": int(s.get("donem_adet") or 0),
                "bu_ay_ekstre_var": bu_ay_var,
            })
        satirlar.sort(key=lambda x: -x["guncel_borc"])
        return {
            "toplam_borc": round(toplam_borc, 2),
            "toplam_odenen_faiz": round(toplam_faiz, 2),
            "kart_adet": len(kartlar),
            "bu_ay_eksik_ekstre": eksik,
            "kartlar": satirlar,
        }


def _satici_anahtar(aciklama: Optional[str]) -> Optional[str]:
    """Açıklamadan satıcı anahtarı (ilk anlamlı kelime) — hafıza eşleşmesi için.
    'METRO METRO GROSMARKET KOKONYA TR' → 'METRO'."""
    import re as _re
    s = (aciklama or "").upper().strip()
    s = _re.sub(r"[^A-ZÇĞİÖŞÜ0-9 ]", " ", s)
    for tok in s.split():
        if len(tok) >= 3 and not tok.isdigit():
            return tok
    return None


def _ekstre_txn_map(t: dict) -> dict:
    """kart_analiz işlem dict → birleşik ekstre işlem formatı (tip/tutar/tarih/kategori)."""
    odeme = bool(t.get("odeme_mi"))
    kat = (t.get("kategori") or "")
    acik = (t.get("aciklama") or "")
    faiz = ("faiz" in kat.lower()) or ("faiz" in acik.lower()) or ("DÖNEM FAİZİ" in acik.upper())
    tip = "ODEME" if odeme else ("FAIZ" if faiz else "HARCAMA")
    tks = t.get("taksit")
    tsay = None
    if tks and "/" in str(tks):
        try:
            tsay = int(str(tks).split("/")[1])
        except (ValueError, IndexError):
            tsay = None
    return {
        "tarih": t.get("tarih"),
        "tutar": abs(float(t.get("tutar") or 0)),
        "tip": tip,
        "aciklama": acik,
        "kategori": kat or None,
        "taksit": tks,
        "taksit_anapara": t.get("taksit_anapara"),
        "taksit_sayisi": tsay,
    }


@app.post("/api/kartlar/ekstre-yukle")
def kart_ekstre_yukle(dosya: UploadFile = File(...)):
    """Faz E0: Banka kredi kartı ekstresi (PDF) yükle → ayrıştır → mutabakat ÖNİZLEME.
    DB'ye HİÇBİR ŞEY yazmaz — sadece okuyup gösterir. Worldcard + Enpara desteklenir.
    Sync def: FastAPI threadpool'da çalışır, pdfplumber event-loop'u bloklamaz."""
    import io
    try:
        import pdfplumber
    except Exception:
        raise HTTPException(500, "pdfplumber yüklü değil (sunucu).")
    raw = dosya.file.read()
    if not raw:
        raise HTTPException(400, "Dosya boş veya yüklenemedi.")

    # ── AXESS/AKBANK: gömülü-font EBCDIC PDF → özel parser (OCR'a gerek yok).
    #    Diğer bankalardan ÖNCE dene; pdfplumber bunu çöp olarak okur.
    try:
        from ekstre_parser import is_axess, parse_axess
        if is_axess(raw):
            sonuc = parse_axess(raw)
            return _ekstre_eslesme_mutabakat(sonuc)
    except HTTPException:
        raise
    except Exception:
        pass  # fitz yok / parse hatası → normal akışa düş

    metin = ""
    try:
        with pdfplumber.open(io.BytesIO(raw)) as pdf:
            for pg in pdf.pages:
                metin += (pg.extract_text() or "") + "\n"
    except Exception as e:
        raise HTTPException(400, f"PDF okunamadı: {e}")
    if len(metin.strip()) < 40:
        raise HTTPException(400, "PDF'den metin çıkmadı — taranmış/görüntü ekstre olabilir (Axess gibi → OCR gerekir).")

    # BİRLEŞİK PARSER: başlık (borç/asgari/faiz/son4) = ekstre_parser;
    # işlemler = kart_analiz (4 banka + kategori) — tek transaction motoru.
    from ekstre_parser import parse_ekstre
    sonuc = parse_ekstre(metin)
    # ekstre_parser TAKSİT çıkarır (kart_analiz çıkarmaz) → taksit bilgisini sakla
    _taksit_lk = {}
    for _e in sonuc.get("islemler", []):
        if _e.get("taksit") and _e.get("tip") == "HARCAMA":
            _taksit_lk[(_e.get("tarih"), round(float(_e.get("tutar") or 0), 2))] = (
                _e.get("taksit"), _e.get("taksit_anapara"))
    try:
        import kart_analiz
        txns = kart_analiz.parse_pdf(raw)
    except Exception:
        txns = None
    if txns:
        sonuc["islemler"] = [_ekstre_txn_map(t) for t in txns]
        # kart_analiz (kategori) + ekstre_parser (taksit) BİRLEŞTİR
        for _isl in sonuc["islemler"]:
            if _isl.get("tip") == "HARCAMA":
                _info = _taksit_lk.get((_isl.get("tarih"), round(float(_isl.get("tutar") or 0), 2)))
                if _info:
                    _isl["taksit"] = _info[0]
                    _isl["taksit_anapara"] = _info[1]
                    try:
                        _isl["taksit_sayisi"] = int(str(_info[0]).split("/")[1])
                    except (ValueError, IndexError):
                        pass
        if not sonuc.get("banka_format") or sonuc.get("banka_format") == "bilinmiyor":
            sonuc["banka_format"] = (txns[0].get("banka") if txns else None) or sonuc.get("banka_format")
        # Kart sahibi header'dan gelmediyse kart_analiz'den al + temizle (Garanti vb.)
        if not (sonuc.get("kart_sahibi") or "").strip():
            import re as _re
            for _t in txns:
                _s = (_t.get("kart_sahibi") or "").strip()
                if not _s:
                    continue
                _s = _s.split("\n")[0].strip()
                _s = _re.sub(r"(?i)\s*(müşteri|musteri|kart)\s*limiti.*$", "", _s).strip()
                if _s:
                    sonuc["kart_sahibi"] = _s.title()
                    break
        sonuc.pop("hata", None)  # işlem bulunduysa parse başarısız sayma
    if sonuc.get("hata") and not txns:
        raise HTTPException(422, sonuc["hata"])

    # GARANTİ/BONUS: özet kutusundaki TARİHSİZ faiz/ücret satırları (DÖNEM FAİZİ vb.)
    # kart_analiz tarihli satır beklediği için kaçıyor → FAIZ işlemi olarak enjekte et.
    # (kart_analiz override'ından SONRA çağrılır ki işlemler silinmesin.)
    if sonuc.get("banka_format") == "garanti":
        try:
            from ekstre_parser import garanti_faiz_enjekte
            garanti_faiz_enjekte(sonuc, metin)
        except Exception:
            pass  # faiz enjeksiyonu başarısız olsa da ekstre okuması devam etsin
    # ZİRAAT/Bankkart: faiz satırları tarihli (kart_analiz FAIZ olarak yakalar) → burada
    # sadece dönem faizi özetini + yıllık oranları tamamla.
    elif sonuc.get("banka_format") == "ziraat":
        try:
            from ekstre_parser import ziraat_faiz_finalize
            ziraat_faiz_finalize(sonuc, metin)
        except Exception:
            pass

    return _ekstre_eslesme_mutabakat(sonuc)


def _ekstre_eslesme_mutabakat(sonuc):
    """Ekstre sonucu → kart eşleştir (son 4 hane) + mutabakat + faiz/snapshot/CFO yaz.
    Hem normal (Worldcard/Enpara) hem Axess akışının ortak son adımı."""
    sonuc["eslesen_kart"] = None
    sonuc["mutabakat"] = None
    son4 = sonuc.get("son_dort")
    with db() as (conn, cur):
        # SATICI HAFIZASI: her işleme öneri tipi (hepsi 'belirsiz' başlar, hafıza öğrendikçe önerir)
        try:
            cur.execute("SELECT anahtar, harcama_tipi FROM kart_satici_kural")
            _kurallar = {r["anahtar"]: r["harcama_tipi"] for r in (cur.fetchall() or [])}
        except Exception:
            _kurallar = {}
        for _isl in sonuc.get("islemler", []):
            if _isl.get("tip") == "HARCAMA":
                _ak = _satici_anahtar(_isl.get("aciklama"))
                _isl["oneri_tipi"] = _kurallar.get(_ak) if _ak else None
        kart = None
        if son4:
            cur.execute(
                "SELECT id::text, kart_adi, banka, COALESCE(sahip,'İşletme') AS sahip, son_dort_hane "
                "FROM kartlar WHERE son_dort_hane=%s AND aktif=TRUE LIMIT 1",
                (son4,),
            )
            kart = cur.fetchone()
        if kart:
            kart = dict(kart)
            # ── ÇİFT YÜKLEME KORUMASI: bu kart için bu ayın ekstresi zaten var mı?
            #    (işlemler zaten idempotent yazılır; bu sadece kullanıcıyı net uyarır)
            kt_chk = sonuc.get("kesim_tarihi")
            if kt_chk:
                try:
                    cur.execute(
                        "SELECT donem_borcu, kaynak FROM kart_ekstre_donem "
                        "WHERE kart_id=%s AND donem=DATE_TRUNC('month', %s::date)",
                        (kart["id"], kt_chk),
                    )
                    _prev = cur.fetchone()
                    if _prev:
                        _prev = dict(_prev)
                        sonuc["donem_zaten_yuklendi"] = {
                            "donem": kt_chk[:7],
                            "onceki_borc": float(_prev.get("donem_borcu") or 0),
                            "kaynak": _prev.get("kaynak"),
                        }
                except Exception:
                    pass
            sistem_borc = kart_borc(cur, kart["id"])
            ekstre_borc = sonuc.get("donem_borcu") or 0
            sonuc["eslesen_kart"] = {
                "id": kart["id"], "kart_adi": kart["kart_adi"],
                "banka": kart["banka"], "sahip": kart["sahip"],
            }
            sonuc["mutabakat"] = {
                "sistem_borc": round(sistem_borc, 2),
                "ekstre_borc": round(ekstre_borc, 2),
                "fark": round(ekstre_borc - sistem_borc, 2),
                "tutar_uyumlu": abs(ekstre_borc - sistem_borc) < 1.0,
            }
            # İşlem-bazlı mutabakat: her ekstre satırını sistemdeki harekete eşle
            cur.execute(
                "SELECT tarih::text AS t, ROUND(tutar::numeric,2)::float AS tu, islem_turu, "
                "taksit_sayisi, baslangic_tarihi::text AS bas "
                "FROM kart_hareketleri WHERE kart_id=%s AND durum='aktif'",
                (kart["id"],),
            )
            mevcut = {}          # tek çekim / ödeme / faiz: (tarih, tutar, tip)
            mevcut_taksit = {}   # taksit: (baslangic, toplam, taksit_sayisi)
            for r in (cur.fetchall() or []):
                r = dict(r)
                if int(r.get("taksit_sayisi") or 1) > 1:
                    tk = (r.get("bas") or r["t"], round(float(r["tu"]), 2), int(r["taksit_sayisi"]))
                    mevcut_taksit[tk] = mevcut_taksit.get(tk, 0) + 1
                else:
                    key = (r["t"], round(float(r["tu"]), 2), r["islem_turu"])
                    mevcut[key] = mevcut.get(key, 0) + 1
            yeni_adet = 0
            for isl in sonuc.get("islemler", []):
                tsay = isl.get("taksit_sayisi")
                if tsay and tsay > 1 and isl.get("tip") == "HARCAMA":
                    # Taksitli: toplam (taksit_anapara) + başlangıç (tarih) + taksit sayısı ile eşle
                    total = round(float(isl.get("taksit_anapara") or 0), 2)
                    tk = (isl.get("tarih"), total, int(tsay))
                    if total <= 0:
                        isl["durum"] = "taksit"  # toplam bilinmiyor → elle
                    elif mevcut_taksit.get(tk, 0) > 0:
                        mevcut_taksit[tk] -= 1
                        isl["durum"] = "eslesti"
                    else:
                        isl["durum"] = "yeni"
                        yeni_adet += 1
                else:
                    tutar_r = round(float(isl.get("tutar") or 0), 2)
                    tip_i = isl.get("tip")
                    key = (isl.get("tarih"), tutar_r, tip_i)
                    if mevcut.get(key, 0) > 0:
                        mevcut[key] -= 1
                        isl["durum"] = "eslesti"
                    else:
                        # BULANIK EŞLEŞME (banka mutabakatı std): aynı tutar+tip, tarih ±3 gün.
                        # Banka işlem tarihi ile elle giriş tarihi farklı olabilir; açıklama umursanmaz.
                        _eslesti = False
                        try:
                            _it = date.fromisoformat(str(isl.get("tarih"))[:10])
                        except Exception:
                            _it = None
                        if _it:
                            for _k in list(mevcut.keys()):
                                if mevcut[_k] <= 0 or _k[1] != tutar_r or _k[2] != tip_i:
                                    continue
                                try:
                                    _kd = date.fromisoformat(str(_k[0])[:10])
                                except Exception:
                                    continue
                                if abs((_it - _kd).days) <= 3:
                                    mevcut[_k] -= 1
                                    isl["durum"] = "eslesti"
                                    isl["fuzzy_eslesme"] = True
                                    _eslesti = True
                                    break
                        if not _eslesti:
                            isl["durum"] = "yeni"
                            yeni_adet += 1
            sonuc["mutabakat"]["yeni_islem_adet"] = yeni_adet

            # Faiz oranlarını ekstreden GÜNCELLE (her ay otomatik — elle girmeye gerek yok)
            akdi = sonuc.get("akdi_faiz_yillik")
            gec = sonuc.get("gecikme_faiz_yillik")
            if akdi is not None and akdi > 0:
                cur.execute(
                    "UPDATE kartlar SET faiz_orani=%s, "
                    "gecikme_faiz_orani=COALESCE(%s, gecikme_faiz_orani) WHERE id=%s",
                    (akdi, gec, kart["id"]),
                )
                sonuc["faiz_guncellendi"] = {"faiz_orani": akdi, "gecikme_faiz_orani": gec}

            # Aylık ekstre SNAPSHOT'ı kaydet (kesim ayına göre; idempotent upsert)
            kt = sonuc.get("kesim_tarihi")
            if kt:
                try:
                    cur.execute(
                        """
                        INSERT INTO kart_ekstre_donem
                            (kart_id, donem, kesim_tarihi, son_odeme_tarihi, donem_borcu,
                             asgari_tutar, onceki_borc, donem_harcama, donem_odeme, donem_faizi, kalan_taksit)
                        VALUES (%s, DATE_TRUNC('month', %s::date), %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (kart_id, donem) DO UPDATE SET
                            kesim_tarihi=EXCLUDED.kesim_tarihi, son_odeme_tarihi=EXCLUDED.son_odeme_tarihi,
                            donem_borcu=EXCLUDED.donem_borcu, asgari_tutar=EXCLUDED.asgari_tutar,
                            onceki_borc=EXCLUDED.onceki_borc, donem_harcama=EXCLUDED.donem_harcama,
                            donem_odeme=EXCLUDED.donem_odeme, donem_faizi=EXCLUDED.donem_faizi,
                            kalan_taksit=EXCLUDED.kalan_taksit
                        """,
                        (kart["id"], kt, kt, sonuc.get("son_odeme_tarihi"),
                         sonuc.get("donem_borcu"), sonuc.get("asgari_tutar"), sonuc.get("onceki_borc"),
                         sonuc.get("donem_harcama"), sonuc.get("donem_odeme"),
                         sonuc.get("donem_faizi") or 0, sonuc.get("kalan_taksit")),
                    )
                    sonuc["donem_kaydedildi"] = True
                except Exception:
                    sonuc["donem_kaydedildi"] = False

            # A) ASGARİ/SON ÖDEME → CFO ödeme planı (gerçek banka değeriyle; çift olmaz, update-in-place)
            sot = sonuc.get("son_odeme_tarihi")
            asg = sonuc.get("asgari_tutar")
            brc = sonuc.get("donem_borcu")
            # Sistem başlangıcı 2026-06-01: Haziran ÖNCESİ son ödemeli ekstreden plan üretilmez
            # (eski ekstre tekrar yüklense bile hayalet 'vadesi geçmiş' oluşmasın).
            if sot and (asg or brc) and str(sot)[:10] >= '2026-06-01':
                acik = f"Kart ekstresi: {kart['kart_adi']} — asgari {asg}"
                cur.execute(
                    """UPDATE odeme_plani SET tarih=%s::date, odenecek_tutar=%s, asgari_tutar=%s,
                        aciklama=%s, referans_ay=DATE_TRUNC('month', %s::date)
                       WHERE kart_id=%s AND durum IN ('bekliyor','onay_bekliyor')
                         AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', %s::date)""",
                    (sot, (brc or asg), asg, acik, sot, kart["id"], sot),
                )
                if cur.rowcount == 0:
                    cur.execute(
                        """INSERT INTO odeme_plani
                            (id, kart_id, tarih, referans_ay, odenecek_tutar, asgari_tutar, aciklama, durum)
                           VALUES (%s, %s, %s::date, DATE_TRUNC('month', %s::date), %s, %s, %s, 'bekliyor')""",
                        (str(uuid.uuid4()), kart["id"], sot, sot, (brc or asg), asg, acik),
                    )
                sonuc["cfo_odeme_plani"] = {"son_odeme": sot, "asgari": asg, "borc": brc}
        elif son4:
            sonuc["eslestrme_notu"] = f"Son 4 hane '{son4}' ile eşleşen kart yok — kart tanımına son 4 haneyi girin."
    return sonuc


class ManuelEkstreBody(BaseModel):
    donem: str                              # kesim tarihi YYYY-MM-DD
    son_odeme: Optional[str] = None
    donem_borcu: float
    asgari_tutar: Optional[float] = None
    faiz_orani: Optional[float] = None
    gecikme_faiz_orani: Optional[float] = None


@app.post("/api/kartlar/{kid}/manuel-ekstre")
def kart_manuel_ekstre(kid: str, body: ManuelEkstreBody):
    """PDF okunamayan kartlar (Axess gibi) için ekstre özetini ELLE gir → aynı
    pipeline: snapshot + CFO ödeme planı + faiz + kart borcunu doğru değere çek.
    Borç düzeltmesi tek değiştirilebilir kayıtla yapılır (man_<id>); kasaya dokunmaz."""
    kesim = (body.donem or "")[:10]
    sot = (body.son_odeme or kesim)[:10]
    borc = float(body.donem_borcu or 0)
    asg = float(body.asgari_tutar or 0)
    with db() as (conn, cur):
        cur.execute("SELECT kart_adi FROM kartlar WHERE id=%s AND aktif=TRUE", (kid,))
        kr = cur.fetchone()
        if not kr:
            raise HTTPException(404, "Kart bulunamadı")
        kart_adi = dict(kr)["kart_adi"]
        # 1) Borcu hedef değere çek — tek değiştirilebilir DEVİR kaydı.
        #    DEVIR = açılış/devreden borç: gider sayılmaz, kasaya dokunmaz, borca eklenir.
        manid = "devir_" + kid
        cur.execute("DELETE FROM kart_hareketleri WHERE id IN (%s, %s)", (manid, "man_" + kid))
        diger = float(kart_borc(cur, kid) or 0)
        adj = round(borc - diger, 2)
        if abs(adj) > 0.01:
            cur.execute(
                """INSERT INTO kart_hareketleri
                   (id, kart_id, tarih, islem_turu, tutar, taksit_sayisi, aciklama, kaynak_tablo, kaynak_id)
                   VALUES (%s,%s,%s::date,'DEVIR',%s,1,%s,'devir',%s)""",
                (manid, kid, sot, adj,
                 "Açılış / devreden borç (ekstre bakiyesi)", manid),
            )
        # 2) snapshot
        cur.execute(
            """INSERT INTO kart_ekstre_donem
                (kart_id, donem, kesim_tarihi, son_odeme_tarihi, donem_borcu, asgari_tutar, kaynak)
               VALUES (%s, DATE_TRUNC('month',%s::date), %s::date, %s::date, %s, %s, 'manuel')
               ON CONFLICT (kart_id, donem) DO UPDATE SET
                 kesim_tarihi=EXCLUDED.kesim_tarihi, son_odeme_tarihi=EXCLUDED.son_odeme_tarihi,
                 donem_borcu=EXCLUDED.donem_borcu, asgari_tutar=EXCLUDED.asgari_tutar, kaynak='manuel'""",
            (kid, kesim, kesim, sot, borc, asg),
        )
        # 3) CFO ödeme planı — sistem başlangıcı 2026-06-01: Haziran öncesi son ödemeli
        #    ekstreden plan üretilmez (eski ekstre tekrar girilse de hayalet vadesi geçmiş olmasın)
        if (asg or borc) and str(sot)[:10] >= '2026-06-01':
            acik = f"Kart ekstresi (manuel): {kart_adi} — asgari {asg}"
            cur.execute(
                """UPDATE odeme_plani SET tarih=%s::date, odenecek_tutar=%s, asgari_tutar=%s,
                    aciklama=%s, referans_ay=DATE_TRUNC('month',%s::date)
                   WHERE kart_id=%s AND durum IN ('bekliyor','onay_bekliyor')
                     AND DATE_TRUNC('month',tarih)=DATE_TRUNC('month',%s::date)""",
                (sot, (borc or asg), asg, acik, sot, kid, sot),
            )
            if cur.rowcount == 0:
                cur.execute(
                    """INSERT INTO odeme_plani (id,kart_id,tarih,referans_ay,odenecek_tutar,asgari_tutar,aciklama,durum)
                       VALUES (%s,%s,%s::date,DATE_TRUNC('month',%s::date),%s,%s,%s,'bekliyor')""",
                    (str(uuid.uuid4()), kid, sot, sot, (borc or asg), asg, acik),
                )
        # 4) faiz oranı
        if body.faiz_orani is not None and body.faiz_orani > 0:
            cur.execute("UPDATE kartlar SET faiz_orani=%s, gecikme_faiz_orani=COALESCE(%s,gecikme_faiz_orani) WHERE id=%s",
                        (body.faiz_orani, body.gecikme_faiz_orani, kid))
        yeni_borc = kart_borc(cur, kid)
    return {"success": True, "yeni_borc": round(yeni_borc, 2)}


class KartLedgerSifirlaBody(BaseModel):
    onay_pin: Optional[str] = None     # İşletme onayı (Merve Karabacak PIN)
    hepsi: bool = False                # True → tüm kartlar; False → tek kart


@app.post("/api/kartlar/{kid}/ledger-sifirla")
def kart_ledger_sifirla(kid: str, body: KartLedgerSifirlaBody):
    """Bozuk/karışık kart hareketlerini temizler (durum='iptal') → kart borcu sıfırlanır.
    Açılış devri kurmadan ÖNCE çalıştırılır. İşletme onayı (Merve Karabacak PIN) şart.
    Bağlı kasa hareketleri (KART_ODEME/KART_FAIZ) da iptal edilir. Auditli.
    kid='__hepsi__' veya hepsi=True → tüm aktif kartlar."""
    from operasyon_merkez_api import _isletme_onay_dogrula
    with db() as (conn, cur):
        onayci = _isletme_onay_dogrula(cur, body.onay_pin)  # PIN hatalı → 403
        tum = body.hepsi or kid == "__hepsi__"
        if tum:
            cur.execute("SELECT id::text FROM kartlar WHERE aktif=TRUE")
            kart_ids = [dict(r)["id"] for r in (cur.fetchall() or [])]
        else:
            cur.execute("SELECT id::text FROM kartlar WHERE id=%s AND aktif=TRUE", (kid,))
            r = cur.fetchone()
            if not r:
                raise HTTPException(404, "Kart bulunamadı")
            kart_ids = [dict(r)["id"]]
        toplam_iptal = 0
        for k in kart_ids:
            # bağlı kasa hareketlerini iptal et (varsa)
            cur.execute(
                """UPDATE kasa_hareketleri SET durum='iptal'
                   WHERE kaynak_tablo='kart_hareketleri' AND durum='aktif'
                     AND kaynak_id IN (SELECT id FROM kart_hareketleri WHERE kart_id=%s AND durum='aktif')""",
                (k,),
            )
            cur.execute(
                "UPDATE kart_hareketleri SET durum='iptal' WHERE kart_id=%s AND durum='aktif'", (k,),
            )
            toplam_iptal += cur.rowcount
            audit(cur, "kart_hareketleri", k, "LEDGER_SIFIRLA",
                  yeni={"onayci": onayci.get("ad_soyad"), "iptal_adet": cur.rowcount})
    return {"success": True, "kart_sayisi": len(kart_ids), "iptal_edilen_hareket": toplam_iptal}


class KasaAcilisBody(BaseModel):
    tutar: float
    onay_pin: Optional[str] = None
    tarih: Optional[str] = None        # default 2026-06-01


@app.post("/api/kasa/acilis-devri")
def kasa_acilis_devri(body: KasaAcilisBody):
    """Sistemin AÇILIŞ kasasını (devir) belirler — kasayı tek kayıtla gerçek tutara çeker.
    Önceki açılış kaydını siler, yenisini yazar. İşletme onayı (Merve Karabacak PIN) şart.
    NOT: Diğer kasa hareketlerine dokunmaz; sadece açılış/devir kalemini kurar. Auditli."""
    from operasyon_merkez_api import _isletme_onay_dogrula
    from finans_core import kasa_bakiyesi
    tarih = (body.tarih or "2026-06-01")[:10]
    hedef = float(body.tutar)
    with db() as (conn, cur):
        onayci = _isletme_onay_dogrula(cur, body.onay_pin)  # PIN hatalı → 403
        # Önceki açılış kaydını sil, kalan kasayı hesapla, FARK kadar düzeltme yaz →
        # kasa tam HEDEF tutara çekilir (mevcut hareketler ne olursa olsun, üstüne EKLEMEZ).
        cur.execute("DELETE FROM kasa_hareketleri WHERE islem_turu='ACILIS_DEVRI'")
        mevcut = kasa_bakiyesi(cur)
        duzeltme = round(hedef - mevcut, 2)
        insert_kasa_hareketi(
            cur, tarih, "ACILIS_DEVRI", duzeltme,
            f"Sistem açılış kasası (1 Haziran) — {hedef:,.0f}₺'ye çekildi",
            "sistem", "acilis_devri",
            idempotency_key=f"acilis_devri_{tarih}_{uuid.uuid4().hex[:10]}",
        )
        audit(cur, "kasa_hareketleri", "acilis_devri", "KASA_ACILIS",
              yeni={"hedef": hedef, "onceki": round(mevcut, 2), "duzeltme": duzeltme,
                    "tarih": tarih, "onayci": onayci.get("ad_soyad")})
        yeni_bakiye = kasa_bakiyesi(cur)
    return {"success": True, "kasa_bakiye": round(yeni_bakiye, 2), "duzeltme": duzeltme}


class TopluDevirBody(BaseModel):
    onay_pin: Optional[str] = None


@app.post("/api/kartlar/toplu-devir")
def kartlar_toplu_devir(body: TopluDevirBody):
    """Her kartın en son ekstre snapshot'ındaki (kart_ekstre_donem) dönem borcunu
    AÇILIŞ DEVRİ (islem_turu='DEVIR') olarak kurar → kart borçları Haziran'a temiz taşınır.
    Gider sayılmaz, kasaya dokunmaz. İşletme onayı şart. Auditli. Tekrar çalıştırılabilir."""
    from operasyon_merkez_api import _isletme_onay_dogrula
    with db() as (conn, cur):
        onayci = _isletme_onay_dogrula(cur, body.onay_pin)
        cur.execute("SELECT id::text, kart_adi FROM kartlar WHERE aktif=TRUE")
        kartlar = [dict(r) for r in (cur.fetchall() or [])]
        sonuc = []
        for k in kartlar:
            kid = k["id"]
            cur.execute(
                """SELECT donem_borcu, kesim_tarihi::text AS kt
                   FROM kart_ekstre_donem WHERE kart_id=%s ORDER BY donem DESC LIMIT 1""",
                (kid,),
            )
            r = cur.fetchone()
            if not r:
                continue
            r = dict(r)
            if r.get("donem_borcu") is None:
                continue
            borc = float(r["donem_borcu"])
            manid = "devir_" + kid
            cur.execute("DELETE FROM kart_hareketleri WHERE id IN (%s, %s)", (manid, "man_" + kid))
            diger = float(kart_borc(cur, kid) or 0)
            adj = round(borc - diger, 2)
            if abs(adj) > 0.01:
                cur.execute(
                    """INSERT INTO kart_hareketleri
                       (id, kart_id, tarih, islem_turu, tutar, taksit_sayisi, aciklama, kaynak_tablo, kaynak_id)
                       VALUES (%s,%s,%s::date,'DEVIR',%s,1,%s,'devir',%s)""",
                    (manid, kid, (r.get("kt") or "2026-05-31"), adj,
                     "Açılış / devreden borç (son ekstre bakiyesi)", manid),
                )
            sonuc.append({"kart": k["kart_adi"], "devir_borc": round(kart_borc(cur, kid), 2)})
        # Haziran ödeme planlarını (CFO hatırlatıcıları) üret — kart son ödeme günü + borç
        plan_sonuc = []
        try:
            from kasa_service import kart_plan_guncelle_tx
            plan_sonuc = kart_plan_guncelle_tx(cur)
        except Exception:
            pass
        audit(cur, "kart_hareketleri", "toplu", "TOPLU_DEVIR",
              yeni={"adet": len(sonuc), "plan": len(plan_sonuc), "onayci": onayci.get("ad_soyad")})
    return {"success": True, "kart_sayisi": len(sonuc), "kartlar": sonuc, "odeme_plani_uretildi": len(plan_sonuc)}


class EkstreImportIslem(BaseModel):
    tarih: Optional[str] = None
    tutar: float
    tip: str = "HARCAMA"      # HARCAMA | ODEME | FAIZ
    aciklama: Optional[str] = None
    harcama_tipi: Optional[str] = None  # isletme | sahsi | belirsiz
    kategori: Optional[str] = None      # ekstre kategorisi (Market, Akaryakıt...)
    taksit_sayisi: Optional[int] = None # taksitli alımda toplam taksit (Y)
    taksit_anapara: Optional[float] = None  # taksitli alımın TOPLAM tutarı


class EkstreImportBody(BaseModel):
    kart_id: str
    islemler: List[EkstreImportIslem]


@app.post("/api/kartlar/ekstre-import")
def kart_ekstre_import(body: EkstreImportBody):
    """Faz E1: Ekstreden seçilen EKSİK işlemleri kart_hareketleri'ne yazar.
    İdempotent (deterministik id → çift import yok). Kasaya DOKUNMAZ (sadece kart
    borcu); taksit satırları kabul edilmez (v1). HARCAMA/ODEME/FAIZ."""
    import hashlib
    with db() as (conn, cur):
        cur.execute("SELECT id FROM kartlar WHERE id=%s AND aktif=TRUE", (body.kart_id,))
        if not cur.fetchone():
            raise HTTPException(404, "Kart bulunamadı")
        yazilan, atlanan = 0, 0
        faiz_donemleri: set = set()  # ekstreden faiz gelen YYYY-MM dönemleri (motor tahmini iptali için)
        for isl in body.islemler:
            tip = (isl.tip or "HARCAMA").upper()
            if tip not in ("HARCAMA", "ODEME", "FAIZ"):
                atlanan += 1; continue
            # TAKSİTLİ alım: tutar=TOPLAM (taksit_anapara), taksit_sayisi=Y, baslangic=tarih
            tsay = int(isl.taksit_sayisi or 1)
            is_taksit = tip == "HARCAMA" and tsay > 1 and float(isl.taksit_anapara or 0) > 0
            if is_taksit:
                tutar = round(abs(float(isl.taksit_anapara)), 2)
            else:
                tsay = 1
                tutar = abs(float(isl.tutar or 0))
            if tutar <= 0:
                atlanan += 1; continue
            # Faiz dönemini SADECE tutar>0 geçerli satır için işaretle (motor tahmini iptali);
            # sıfır tutarlı satır atlanırsa o dönem yanlışlıkla iptal tetiklenmesin.
            if tip == "FAIZ":
                _ft = (isl.tarih or str(bugun_tr()))[:7]
                if len(_ft) == 7:
                    faiz_donemleri.add(_ft)
            tarih = (isl.tarih or str(bugun_tr()))[:10]
            htip = (isl.harcama_tipi or "").strip().lower()
            if htip not in ("isletme", "sahsi", "belirsiz"):
                if tip == "HARCAMA":
                    htip = None
                    _ak = _satici_anahtar(isl.aciklama)
                    if _ak:
                        cur.execute("SELECT harcama_tipi FROM kart_satici_kural WHERE anahtar=%s", (_ak,))
                        _r = cur.fetchone()
                        if _r:
                            htip = dict(_r)["harcama_tipi"]
                    htip = htip or "belirsiz"
                else:
                    htip = "isletme"
            anahtar = f"{body.kart_id}|{tarih}|{tutar:.2f}|{tip}|{tsay}|{(isl.aciklama or '')[:40]}"
            hid = "eks_" + hashlib.md5(anahtar.encode("utf-8")).hexdigest()[:24]
            cur.execute(
                """INSERT INTO kart_hareketleri
                   (id, kart_id, tarih, islem_turu, tutar, taksit_sayisi, baslangic_tarihi, aciklama,
                    harcama_tipi, kategori, kaynak_tablo, kaynak_id)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'ekstre_import',%s)
                   ON CONFLICT (id) DO NOTHING""",
                (hid, body.kart_id, tarih, tip, tutar, tsay,
                 (tarih if is_taksit else None),
                 (isl.aciklama or "Ekstre içe aktarım")[:200], htip,
                 (isl.kategori or None), hid),
            )
            if cur.rowcount > 0:
                yazilan += 1
            else:
                atlanan += 1  # zaten var (idempotent)

        # ── OTOMATİK: ekstreden GERÇEK banka faizi geldiyse, o dönem için motorun
        #    TAHMİNİ faizini iptal et (çift faiz olmasın). Motor faizi açıklamasında
        #    "kesim faizi" işaretini taşır; ekstre faizi (DÖNEM FAİZİ/Kredi faizi/KKDF…)
        #    taşımaz → yalnızca tahmin iptal olur, banka gerçeği kalır. İdempotent.
        motor_faizi_iptal = 0
        for _donem in faiz_donemleri:
            cur.execute(
                """
                UPDATE kart_hareketleri
                SET durum='iptal',
                    aciklama = aciklama || ' [ekstre gerçeği geldi — motor tahmini iptal]'
                WHERE kart_id=%s AND islem_turu='FAIZ' AND durum='aktif'
                  AND aciklama LIKE '%% kesim faizi %%'
                  AND to_char(tarih, 'YYYY-MM') = %s
                """,
                (body.kart_id, _donem),
            )
            motor_faizi_iptal += cur.rowcount or 0

        if yazilan or motor_faizi_iptal:
            try:
                from motors import kart_plan_guncelle_tx
                kart_plan_guncelle_tx(cur)
            except Exception:
                pass
        yeni_borc = kart_borc(cur, body.kart_id)
    return {
        "yazilan": yazilan,
        "atlanan_veya_mevcut": atlanan,
        "motor_tahmini_faiz_iptal": motor_faizi_iptal,
        "yeni_sistem_borc": round(yeni_borc, 2),
    }


# ── ÖDEME PLANI ────────────────────────────────────────────────
class OdemePlani(BaseModel):
    kart_id: str
    tarih: date
    odenecek_tutar: float
    asgari_tutar: Optional[float] = None
    aciklama: Optional[str] = None

class KismiOdeModel(BaseModel):
    odenen_tutar: float
    kalan_vade_tarihi: date
    odeme_yontemi: str = 'nakit'  # 'nakit' veya 'kart'
    kart_id: Optional[str] = None

@app.post("/api/odeme-plani")
def odeme_plani_ekle(o: OdemePlani):
    with db() as (conn, cur):
        oid = str(uuid.uuid4())
        asgari = o.asgari_tutar or o.odenecek_tutar * 0.4
        cur.execute("""INSERT INTO odeme_plani (id,kart_id,tarih,odenecek_tutar,asgari_tutar,aciklama)
            VALUES (%s,%s,%s,%s,%s,%s)""",
            (oid, o.kart_id, o.tarih, o.odenecek_tutar, asgari, o.aciklama))
        onay_ekle(cur, 'ODEME_PLANI', 'odeme_plani', oid,
            f"Ödeme planı", o.odenecek_tutar, o.tarih)
        audit(cur, 'odeme_plani', oid, 'INSERT')
    return {"id": oid, "success": True}

class VadeliOdeModel(BaseModel):
    odeme_yontemi: str = 'nakit'  # 'nakit' veya 'kart'
    kart_id: Optional[str] = None


def _personel_maas_odeme_guard(cur, plan: dict) -> None:
    """FAZ 0 #3: Personel maaş planı ödenmeden önce o ayın kaydı 'onaylandi' olmalı.
    Taslak/tahmini ödeme = fazla mesai dahil edilmeden eksik ödeme riski. Sadece
    kaynak_tablo='personel' planlarına uygulanır; kira/borç/kart etkilenmez."""
    if (plan.get('kaynak_tablo') or '') != 'personel':
        return
    kid = plan.get('kaynak_id')
    ref = plan.get('referans_ay')
    if not kid or not ref:
        return  # eski/bağlanamayan kayıt — engelleme
    cur.execute(
        "SELECT durum FROM personel_aylik WHERE personel_id=%s AND yil=%s AND ay=%s",
        (kid, ref.year, ref.month),
    )
    r = cur.fetchone()
    durum = (r or {}).get('durum')
    if durum == 'onaylandi':
        return
    cur.execute("SELECT ad_soyad FROM personel WHERE id=%s", (kid,))
    ad = (cur.fetchone() or {}).get('ad_soyad') or 'Personel'
    if not r:
        raise HTTPException(
            400,
            f"{ad}: bu ayın maaş kaydı henüz girilmedi. Ödeme öncesi 'Vardiyadan Aktar' "
            f"+ 'Onayla' yapın (fazla mesai dahil edilip tutar kilitlensin).",
        )
    raise HTTPException(
        400,
        f"{ad}: maaş kaydı '{durum}' durumda. Ödemeden önce 'Onayla' gerekli "
        f"(tutarı kilitler, fazla mesai dahil olur).",
    )


@app.post("/api/odeme-plani/{oid}/ode")
def odeme_yap(oid: str, tutar: Optional[float] = None, body: VadeliOdeModel = VadeliOdeModel()):
    with db() as (conn, cur):
        # FOR UPDATE: eş zamanlı iki ödeme isteğinin aynı planı çift işlemesini önler
        cur.execute("SELECT * FROM odeme_plani WHERE id=%s FOR UPDATE", (oid,))
        plan = cur.fetchone()
        if not plan: raise HTTPException(404)
        if plan['durum'] == 'odendi': raise HTTPException(400, "Zaten ödendi")

        # FAZ 0 #3: personel maaşı onaysız ödenemez
        _personel_maas_odeme_guard(cur, dict(plan))

        # ÇİFT ÖDEME KAPISI (ters yön): sabit gider planı ödenmeden önce, o ay manuel
        # /fatura-ode ile (nakit veya kart) zaten ödendiyse engelle.
        if plan.get('kaynak_tablo') == 'sabit_giderler' and plan.get('kaynak_id'):
            cur.execute(
                """
                SELECT 1 FROM kasa_hareketleri
                WHERE kaynak_tablo='sabit_giderler' AND kaynak_id=%s
                  AND islem_turu IN ('SABIT_GIDER','FATURA_ODEMESI')
                  AND kasa_etkisi=true AND durum='aktif'
                  AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', %s::date)
                UNION ALL
                SELECT 1 FROM kart_hareketleri
                WHERE kaynak_tablo='fatura_giderleri' AND kaynak_id=%s
                  AND islem_turu='HARCAMA' AND durum='aktif'
                  AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', %s::date)
                LIMIT 1
                """,
                (plan['kaynak_id'], plan.get('referans_ay'), plan['kaynak_id'], plan.get('referans_ay')),
            )
            if cur.fetchone():
                raise HTTPException(400, "Bu gider bu ay zaten manuel ödenmiş — plan tekrar ödenemez")

        # KART seçildiyse ve kaynak vadeli_alimlar ise kart akışına yönlendir
        if body.odeme_yontemi == 'kart' and body.kart_id and plan.get('kaynak_tablo') == 'vadeli_alimlar':
            bugun = str(bugun_tr())
            odeme_tutari = tutar or float(plan['odenecek_tutar'])
            # Kart validasyon — FOR UPDATE: eş zamanlı limit aşımını önler
            cur.execute("SELECT * FROM kartlar WHERE id=%s AND aktif=TRUE FOR UPDATE", (body.kart_id,))
            kart = cur.fetchone()
            if not kart: raise HTTPException(404, "Kart bulunamadı")
            borc = kart_borc(cur, body.kart_id)
            kalan_limit = float(kart['limit_tutar']) - borc
            if kalan_limit < odeme_tutari:
                raise HTTPException(400, f"Kart limiti yetersiz. Kalan: {kalan_limit:,.0f} ₺")
            # Kart harcaması ekle — kasaya yazma
            hid = str(uuid.uuid4())
            cur.execute("""
                INSERT INTO kart_hareketleri
                    (id, kart_id, tarih, islem_turu, tutar, taksit_sayisi, aciklama, kaynak_id, kaynak_tablo)
                VALUES (%s, %s, %s, 'HARCAMA', %s, 1, %s, %s, 'vadeli_alimlar')
            """, (hid, body.kart_id, bugun, odeme_tutari, f"Vadeli alım: {plan['aciklama']}",
                   plan.get('kaynak_id')))
            audit(cur, 'kart_hareketleri', hid, 'VADELI_KART')
            # Plan kapat
            cur.execute("UPDATE odeme_plani SET durum='odendi', odeme_tarihi=%s, odenen_tutar=%s WHERE id=%s",
                (bugun, odeme_tutari, oid))
            cur.execute("""UPDATE onay_kuyrugu SET durum='onaylandi', onay_tarihi=NOW()
                WHERE kaynak_id=%s AND durum NOT IN ('onaylandi','reddedildi')""", (oid,))
            if plan.get('kaynak_id'):
                vadeli_alim_kapat(cur, plan['kaynak_id'], bugun)
            audit(cur, 'odeme_plani', oid, 'ODENDI_KART')
            # Uyarı önbelleğini temizle — panelde uyarı hemen kalksın
            uyari_cache_clear()
            return {"success": True, "odeme_yontemi": "kart"}

        bugun = str(bugun_tr())
        odenen = tutar or float(plan['odenecek_tutar'])
        cur.execute("UPDATE odeme_plani SET durum='odendi', odeme_tarihi=%s, odenen_tutar=%s WHERE id=%s",
            (bugun, odenen, oid))

        ana_para_kismi = kasa_ve_faiz_odeme_plani_tam_odeme(cur, dict(plan), oid, odenen, bugun)

        # Onay kuyruğunu kapat — tüm açık durumlar hedeflenir
        cur.execute("""UPDATE onay_kuyrugu SET durum='onaylandi', onay_tarihi=NOW()
            WHERE durum NOT IN ('onaylandi','reddedildi')
            AND (
                kaynak_id = %s
                OR kaynak_id = (SELECT kaynak_id FROM odeme_plani WHERE id=%s LIMIT 1)
            )""", (oid, oid))
        audit(cur, 'odeme_plani', oid, 'ODEME', eski=plan)

        # Kaynak vadeli_alimlar ise tüm bağlı kayıtları atomik kapat — çift düşme engeli
        if plan.get('kaynak_tablo') == 'vadeli_alimlar' and plan.get('kaynak_id'):
            vadeli_alim_kapat(cur, plan['kaynak_id'], bugun)

        guncelle_borc_envanteri_odeme_plani_sonrasi(cur, plan, ana_para_kismi)

        # Faiz üretimi: /api/kartlar/faiz-uret endpoint'i veya ay sonu startup ile otomatik

        # Uyarı önbelleğini temizle — panelde uyarı hemen kalksın
        uyari_cache_clear()

    return {"success": True}

@app.delete("/api/odeme-plani/{oid}")
def odeme_plani_sil(oid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM odeme_plani WHERE id=%s", (oid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)
        cur.execute("UPDATE odeme_plani SET durum='iptal' WHERE id=%s", (oid,))
        cur.execute("UPDATE onay_kuyrugu SET durum='reddedildi' WHERE kaynak_id=%s", (oid,))
        # Eğer ödeme zaten "odendi" durumundaysa kasa geri alınmalı
        if eski['durum'] == 'odendi':
            # İptal türü ödeme türüyle eşleşmeli (ledger tutarlılığı)
            islem = 'KART_ODEME' if eski.get('kart_id') else 'ODEME'
            iptal_turu = 'KART_ODEME_IPTAL' if eski.get('kart_id') else 'ODEME_IPTAL'
            iptal_kasa_hareketi(cur, oid, 'odeme_plani', islem, iptal_turu,
                f"Ödeme iptali: {eski['aciklama']}")
        audit(cur, 'odeme_plani', oid, 'IPTAL', eski=eski)
    return {"success": True}

# ── ONAY KUYRUGU ───────────────────────────────────────────────
@app.get("/api/onay-kuyrugu")
def onay_listele(durum: str = "bekliyor", limit: int = 300):
    d = (durum or "bekliyor").strip().lower()
    lim = max(1, min(int(limit or 300), 1000))
    with db() as (conn, cur):
        if d == "bekliyor":
            cur.execute(
                """
                SELECT *
                FROM onay_kuyrugu
                WHERE durum='bekliyor'
                ORDER BY tarih ASC, olusturma ASC
                LIMIT %s
                """,
                (lim,),
            )
        elif d == "gecmis":
            cur.execute(
                """
                SELECT *
                FROM onay_kuyrugu
                WHERE durum IN ('onaylandi','reddedildi')
                ORDER BY COALESCE(onay_tarihi, olusturma) DESC
                LIMIT %s
                """,
                (lim,),
            )
        elif d == "hepsi":
            cur.execute(
                """
                SELECT *
                FROM onay_kuyrugu
                ORDER BY
                    CASE WHEN durum='bekliyor' THEN 0 ELSE 1 END,
                    COALESCE(onay_tarihi, olusturma) DESC
                LIMIT %s
                """,
                (lim,),
            )
        else:
            raise HTTPException(400, "durum: bekliyor | gecmis | hepsi")
        return [dict(r) for r in cur.fetchall()]


def _onayla_tx(cur, oid: str):
    cur.execute("SELECT * FROM onay_kuyrugu WHERE id=%s FOR UPDATE", (oid,))
    onay = cur.fetchone()
    if not onay:
        raise HTTPException(404)
    # Zaten onaylanmış — çift onay engeli
    if onay['durum'] != 'bekliyor':
        raise HTTPException(400, f"Bu işlem zaten '{onay['durum']}' durumunda, tekrar onaylanamaz.")
    tutar = float(onay['tutar'])
    tarih = str(onay['tarih'])
    GIDER_TURLERI = {'KART_ODEME', 'ANLIK_GIDER', 'VADELI_ODEME', 'PERSONEL_MAAS', 'SABIT_GIDER', 'BORC_TAKSIT', 'FATURA_ODEMESI', 'ODEME_PLANI'}
    GELIR_TURLERI = {'CIRO', 'CIRO_DUZELTME', 'DIS_KAYNAK', 'KASA_GIRIS', 'KASA_DUZELTME'}
    islem_turu = onay['islem_turu']
    KASA_FARK_TURLERI = {'KAPANIS_KASA_FARK', 'ACILIS_KASA_FARK'}
    if islem_turu in GIDER_TURLERI:
        signed_tutar = -abs(tutar)
    elif islem_turu in GELIR_TURLERI:
        signed_tutar = abs(tutar)
    elif islem_turu in KASA_FARK_TURLERI:
        signed_tutar = tutar  # işaret korunur; kasaya yazılmayacak
    else:
        signed_tutar = tutar
        logger.warning(f"Bilinmeyen işlem türü onaylandı: {islem_turu}, tutar={tutar}")

    # ODEME_PLANI onaylandığında kasa_etkisi True olmalı
    # Plan oluşumu = niyet (False), onay = gerçekleşme (True)
    # islem_turu değişmez — anlam korunur, sadece davranış eklenir
    if islem_turu == 'ODEME_PLANI':
        # Önce planı kapat; kasa yalnız plan gerçekten kapatıldıysa (/ode ile aynı — çift kasa önlemi)
        cur.execute("SELECT * FROM odeme_plani WHERE id=%s", (onay['kaynak_id'],))
        plan_row = cur.fetchone()
        if not plan_row:
            raise HTTPException(404, "Ödeme planı bulunamadı")
        plan_dict = dict(plan_row)
        kaynak_tablo = plan_dict.get('kaynak_tablo')
        odenen_onay = float(onay['tutar'])
        cur.execute("""
            UPDATE odeme_plani SET durum='odendi', odeme_tarihi=%s, odenen_tutar=%s
            WHERE id=%s AND durum IN ('bekliyor','onay_bekliyor')
        """, (tarih, odenen_onay, onay['kaynak_id']))
        plan_odendi = cur.rowcount > 0
        if plan_odendi:
            ana_onay = kasa_ve_faiz_odeme_plani_tam_odeme(
                cur, plan_dict, onay['kaynak_id'], odenen_onay, tarih,
                anapara_aciklama=f"Onaylandı: {onay['aciklama']}",
            )
            if kaynak_tablo == 'vadeli_alimlar' and plan_dict.get('kaynak_id'):
                vadeli_alim_kapat(cur, plan_dict['kaynak_id'], tarih)
            guncelle_borc_envanteri_odeme_plani_sonrasi(cur, plan_dict, ana_onay)
    elif islem_turu == 'VADELI_ODEME':
        # Eşzamanlı iki onayın aynı vadeli kaydı çift düşmesini engelle.
        cur.execute("SELECT id FROM vadeli_alimlar WHERE id=%s FOR UPDATE", (onay['kaynak_id'],))
        if not cur.fetchone():
            raise HTTPException(404, "Vadeli alım kaydı bulunamadı")
        # ÇİFT ÖDEME GUARD: Kısmi ödeme + tam ödeme farklı kaynak_id ile tutulabildi — tek yerden topla
        onceki_odenen = vadeli_kasadan_odenen_toplam(cur, onay['kaynak_id'])
        if onceki_odenen >= abs(signed_tutar):
            logger.warning(f"VADELI_ODEME çift ödeme engellendi — kaynak_id={onay['kaynak_id']}")
            # Kasa zaten yazılmış, sadece onay kuyruğunu kapat ve tabloları güncelle
        else:
            # Kalan tutar kadar kasaya yaz
            insert_kasa_hareketi(cur, tarih, islem_turu, signed_tutar,
                f"Onaylandı: {onay['aciklama']}", onay['kaynak_tablo'], onay['kaynak_id'],
                ref_id=oid, ref_type='ONAY')
        # Tüm bağlı kayıtları atomik kapat — çift düşme engeli
        vadeli_alim_kapat(cur, onay['kaynak_id'], tarih)
    elif (
        islem_turu == "ANLIK_GIDER"
        and (onay.get("kaynak_tablo") or "") == "anlik_giderler"
        and onay.get("kaynak_id")
    ):
        kid = str(onay["kaynak_id"])
        cur.execute(
            "SELECT id, durum FROM anlik_giderler WHERE id=%s FOR UPDATE",
            (kid,),
        )
        ag = cur.fetchone()
        if not ag:
            raise HTTPException(404, "Anlık gider kaydı bulunamadı")
        st = ag["durum"]
        if st == "onay_bekliyor":
            cur.execute(
                "UPDATE anlik_giderler SET durum='aktif' WHERE id=%s",
                (kid,),
            )
        elif st != "aktif":
            raise HTTPException(
                400,
                f"Anlık gider bu durumda onaylanamaz: {st}",
            )
        cur.execute(
            """
            SELECT COALESCE(COUNT(*), 0)::int AS n
            FROM kasa_hareketleri
            WHERE kaynak_id=%s AND islem_turu='ANLIK_GIDER'
              AND durum='aktif' AND kasa_etkisi=true
            """,
            (kid,),
        )
        n = int((cur.fetchone() or {}).get("n") or 0)
        if n == 0:
            insert_kasa_hareketi(
                cur,
                tarih,
                islem_turu,
                signed_tutar,
                f"Onaylandı: {onay['aciklama']}",
                "anlik_giderler",
                kid,
                ref_id=oid,
                ref_type="ONAY",
            )

        # ── RAPOR CACHE HOOK ── anlık gider onaylanınca özet güncellensin
        try:
            cur.execute("SELECT sube, tarih FROM anlik_giderler WHERE id=%s", (kid,))
            _ag = cur.fetchone()
            if _ag and _ag.get("sube"):
                from rapor_cache import gunluk_ozet_yenile
                gunluk_ozet_yenile(cur, str(_ag["sube"]), _ag.get("tarih"), kaynak='event_gider')
        except Exception:
            pass
    elif islem_turu in KASA_FARK_TURLERI:
        # Kasa farkı onayı = "Merkez gördü ve kabul etti" — kasa bakiyesini ETKİLEMEZ.
        # Gerçek fiziksel açık varsa Operasyon Merkezi → Kasa Uyumsuzluğu → "Gerçek Açık" akışı kullanılır.
        pass
    elif islem_turu in ("CIRO", "CIRO_DUZELTME"):
        # Ciro kaynak kaydı varsa satırı kilitleyerek eşzamanlı onay/yazım çakışmasını azalt.
        if (onay.get("kaynak_tablo") or "") == "ciro" and onay.get("kaynak_id"):
            cur.execute("SELECT id FROM ciro WHERE id=%s FOR UPDATE", (onay["kaynak_id"],))
        insert_kasa_hareketi(cur, tarih, islem_turu, signed_tutar,
            f"Onaylandı: {onay['aciklama']}", onay['kaynak_tablo'], onay['kaynak_id'],
            ref_id=oid, ref_type='ONAY')
    else:
        # Maaş/sabit/borç taksit onayında çift ödeme riskini kapat:
        # aynı kaynak için aynı ayda aktif kasa kaydı varsa tekrar yazma.
        if islem_turu in ("SABIT_GIDER", "BORC_TAKSIT", "PERSONEL_MAAS") and onay.get("kaynak_id"):
            kaynak_tablo = (onay.get("kaynak_tablo") or "").strip().lower()
            kid = str(onay["kaynak_id"])
            if kaynak_tablo == "personel":
                cur.execute("SELECT id FROM personel WHERE id=%s FOR UPDATE", (kid,))
            elif kaynak_tablo == "sabit_giderler":
                cur.execute("SELECT id FROM sabit_giderler WHERE id=%s FOR UPDATE", (kid,))
            elif kaynak_tablo == "borc_envanteri":
                cur.execute("SELECT id FROM borc_envanteri WHERE id=%s FOR UPDATE", (kid,))

            cur.execute(
                """
                SELECT COALESCE(COUNT(*), 0)::int AS n
                FROM kasa_hareketleri
                WHERE kaynak_id=%s
                  AND islem_turu=%s
                  AND durum='aktif'
                  AND kasa_etkisi=true
                  AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', %s::date)
                """,
                (kid, islem_turu, tarih),
            )
            onceki = int((cur.fetchone() or {}).get("n") or 0)
            if onceki > 0:
                raise HTTPException(409, f"{islem_turu} için bu ay ödeme zaten işlenmiş.")

        insert_kasa_hareketi(cur, tarih, islem_turu, signed_tutar,
            f"Onaylandı: {onay['aciklama']}", onay['kaynak_tablo'], onay['kaynak_id'],
            ref_id=oid, ref_type='ONAY')
        # SABIT_GIDER / BORC_TAKSIT: bağlı odeme_plani'nı odendi yap — yuk_7'den çıksın
        if islem_turu in ('SABIT_GIDER', 'BORC_TAKSIT', 'PERSONEL_MAAS'):
            cur.execute("""
                UPDATE odeme_plani SET durum='odendi', odeme_tarihi=%s
                WHERE kaynak_tablo=%s AND kaynak_id=%s
                AND durum IN ('bekliyor','onay_bekliyor')
                AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', %s::date)
            """, (tarih, onay['kaynak_tablo'], onay['kaynak_id'], tarih))
    # Onay durumunu güncelle — vadeli_alim_kapat bazı kayıtları önceden onaylanmış yapabilir
    cur.execute("UPDATE onay_kuyrugu SET durum='onaylandi', onay_tarihi=NOW() WHERE id=%s AND durum='bekliyor'", (oid,))
    if cur.rowcount == 0:
        cur.execute("SELECT durum FROM onay_kuyrugu WHERE id=%s", (oid,))
        st = cur.fetchone()
        if not st or st['durum'] != 'onaylandi':
            raise HTTPException(409, "Eş zamanlı onay çakışması — işlem zaten onaylandı.")
    audit(cur, 'onay_kuyrugu', oid, 'ONAYLANDI', eski=onay)
    return {"success": True}


@app.post("/api/onay-kuyrugu/toplu-onayla")
def toplu_onayla(body: dict):
    """
    Seçili onayları tek seferde onayla.
    body: { ids: [id1, id2, ...] }
    Her onay kendi transaction'ında işlenir — biri başarısız olursa diğerleri etkilenmez.
    """
    ids = body.get('ids', [])
    if not ids:
        raise HTTPException(400, "Onay listesi boş")

    sonuclar = []
    with db() as (conn, cur):
        for i, oid in enumerate(ids):
            sp = f"sp_toplu_onay_{i}"
            cur.execute(f"SAVEPOINT {sp}")
            try:
                _onayla_tx(cur, oid)
                cur.execute(f"RELEASE SAVEPOINT {sp}")
                sonuclar.append({"id": oid, "durum": "onaylandi"})
            except HTTPException as e:
                cur.execute(f"ROLLBACK TO SAVEPOINT {sp}")
                cur.execute(f"RELEASE SAVEPOINT {sp}")
                sonuclar.append({"id": oid, "durum": "hata", "mesaj": str(e.detail)})
            except Exception as e:
                cur.execute(f"ROLLBACK TO SAVEPOINT {sp}")
                cur.execute(f"RELEASE SAVEPOINT {sp}")
                sonuclar.append({"id": oid, "durum": "hata", "mesaj": str(e)})

    onaylanan = sum(1 for s in sonuclar if s["durum"] == "onaylandi")
    return {
        "toplam": len(ids),
        "onaylanan": onaylanan,
        "hata": len(ids) - onaylanan,
        "sonuclar": sonuclar,
    }

@app.post("/api/onay-kuyrugu/{oid}/onayla")
def onayla(oid: str):
    with db() as (conn, cur):
        return _onayla_tx(cur, oid)

class ReddetModel(BaseModel):
    neden: str = 'hata'  # 'hata' veya 'surec_bitti'

@app.post("/api/onay-kuyrugu/{oid}/reddet")
def reddet(oid: str, body: ReddetModel = ReddetModel()):
    with db() as (conn, cur):
        cur.execute("UPDATE onay_kuyrugu SET durum='reddedildi', onay_tarihi=NOW() WHERE id=%s", (oid,))

        cur.execute("SELECT * FROM onay_kuyrugu WHERE id=%s", (oid,))
        onay = cur.fetchone()
        if onay:
            kt  = onay.get("kaynak_tablo") or ""
            kid = onay.get("kaynak_id") or ""

            if kt == "anlik_giderler" and kid and onay.get("islem_turu") == "ANLIK_GIDER":
                cur.execute(
                    "UPDATE anlik_giderler SET durum='reddedildi' WHERE id=%s AND durum='onay_bekliyor'",
                    (kid,),
                )
            cur.execute("""
                UPDATE odeme_plani SET durum='iptal'
                WHERE (id=%s OR kaynak_id=%s) AND durum IN ('bekliyor','onay_bekliyor')
            """, (kid, kid))

            if body.neden == 'surec_bitti' and kt and kid:
                if kt == 'sabit_giderler':
                    cur.execute("UPDATE sabit_giderler SET aktif=FALSE WHERE id=%s", (kid,))
                elif kt == 'personel':
                    cur.execute("UPDATE personel SET aktif=FALSE WHERE id=%s", (kid,))
                elif kt == 'borc_envanteri':
                    cur.execute("UPDATE borc_envanteri SET aktif=FALSE WHERE id=%s", (kid,))

            # ── Şube bildirimi ─────────────────────────────────
            # Kaynak tablodan sube_id'yi bul
            _sube_id = None
            _sube_lookup = {
                "anlik_giderler":  "SELECT sube     AS sid FROM anlik_giderler WHERE id=%s",
                "siparis_talep":   "SELECT sube_id  AS sid FROM siparis_talep  WHERE id=%s",
                "ciro":            "SELECT sube_id  AS sid FROM ciro            WHERE id=%s",
                "anlik_gider":     "SELECT sube     AS sid FROM anlik_giderler WHERE id=%s",
                "odeme_plani":     "SELECT sube_id  AS sid FROM odeme_plani    WHERE id=%s",
            }
            _q = _sube_lookup.get(kt)
            if _q and kid:
                try:
                    cur.execute(_q, (kid,))
                    _r = cur.fetchone()
                    _sube_id = str(_r["sid"]) if _r and _r.get("sid") else None
                except Exception:
                    pass

            if _sube_id:
                _aciklama = (onay.get("aciklama") or "").strip()
                _tutar    = onay.get("tutar")
                _neden    = (body.neden or "").strip() if body.neden else ""
                _mesaj_parcalari = [f"❌ Onay reddedildi: {_aciklama}" if _aciklama else "❌ Onay talebiniz reddedildi."]
                if _tutar:
                    _mesaj_parcalari.append(f"Tutar: {float(_tutar):,.2f} ₺")
                if _neden:
                    _mesaj_parcalari.append(f"Neden: {_neden}")
                _mesaj = " — ".join(_mesaj_parcalari)
                try:
                    cur.execute(
                        """
                        INSERT INTO sube_merkez_mesaj
                            (id, sube_id, mesaj, oncelik, ttl_saat)
                        VALUES (%s, %s, %s, 'yuksek', 48)
                        """,
                        (str(uuid.uuid4()), _sube_id, _mesaj),
                    )
                except Exception:
                    pass

    return {"success": True}

# ── CİRO ───────────────────────────────────────────────────────
class CiroModel(BaseModel):
    tarih: date
    sube_id: str
    nakit: float = 0
    pos: float = 0
    online: float = 0
    aciklama: Optional[str] = None
    force: bool = False

@app.get("/api/ciro")
def ciro_listele(limit: int = 200, ay: str = None):
    import re as _re_ay
    ay_v = (ay or "").strip()
    ay_cond, ay_params = "", []
    if ay_v and ay_v.lower() != "hepsi" and _re_ay.match(r"^\d{4}-\d{2}$", ay_v):
        ay_cond = " AND to_char(c.tarih, 'YYYY-MM') = %s"
        ay_params = [ay_v]
    with db() as (conn, cur):
        cur.execute(f"""
            SELECT
                c.*,
                s.ad as sube_adi,
                COALESCE(s.pos_oran, 0) as pos_oran,
                COALESCE(s.online_oran, 0) as online_oran,
                ROUND(c.pos    * COALESCE(s.pos_oran,    0) / 100.0, 2) as pos_kesinti,
                ROUND(c.online * COALESCE(s.online_oran, 0) / 100.0, 2) as online_kesinti,
                ROUND(c.pos    * COALESCE(s.pos_oran,    0) / 100.0 +
                      c.online * COALESCE(s.online_oran, 0) / 100.0, 2) as toplam_yanan
            FROM ciro c
            LEFT JOIN subeler s ON s.id = c.sube_id
            WHERE c.durum = 'aktif'{ay_cond}
            ORDER BY c.tarih DESC
            LIMIT %s
        """, ay_params + [limit])
        return [dict(r) for r in cur.fetchall()]

@app.post("/api/ciro")
def ciro_ekle(c: CiroModel):
    nakit = float(c.nakit or 0)
    pos   = float(c.pos or 0)
    online = float(c.online or 0)
    toplam = nakit + pos + online
    with db() as (conn, cur):
        # Aynı şube+tarih için ciro yazımlarını transaction bazında seri hale getir.
        lock_key = f"ciro:{c.sube_id}:{c.tarih}"
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (lock_key,))
        # Sert koruma: aynı şube+tarih için aktif ciro birden fazla olamaz.
        cur.execute(
            """
            SELECT id, (nakit+pos+online) AS toplam
            FROM ciro
            WHERE durum='aktif' AND tarih=%s AND sube_id=%s
            FOR UPDATE
            """,
            (str(c.tarih), c.sube_id),
        )
        mevcut = cur.fetchone()
        if mevcut:
            mevcut_tutar = float(mevcut.get("toplam") or 0)
            raise HTTPException(
                409,
                f"Bu şube için {c.tarih} tarihinde aktif ciro zaten var ({mevcut_tutar:,.0f} ₺).",
            )

        # Şube oranlarını çek
        cur.execute("SELECT COALESCE(pos_oran,0) as pos_oran, COALESCE(online_oran,0) as online_oran FROM subeler WHERE id=%s", (c.sube_id,))
        oran = cur.fetchone()
        pos_oran    = float(oran['pos_oran'])    if oran else 0.0
        online_oran = float(oran['online_oran']) if oran else 0.0

        pos_kesinti    = pos    * pos_oran    / 100.0
        online_kesinti = online * online_oran / 100.0
        net_tutar      = nakit + (pos - pos_kesinti) + (online - online_kesinti)

        # force sadece UX uyarılarını bypass eder; sert duplicate engeli yukarıda uygulanır.
        cid = str(uuid.uuid4())
        # Teknik duplicate koruması: son 5 saniye içinde birebir aynı istek geldi mi?
        if not c.force:
            cur.execute("""
                SELECT id FROM ciro WHERE durum='aktif'
                AND tarih=%s AND sube_id=%s
                AND nakit=%s AND pos=%s AND online=%s
                AND olusturma >= NOW() - INTERVAL '5 seconds'
            """, (c.tarih, c.sube_id, c.nakit, c.pos, c.online))
            if cur.fetchone():
                return {"id": None, "success": False, "duplicate": True,
                        "mesaj": "Aynı istek son 5 saniye içinde zaten gönderildi."}

        # Ciro tablosuna yaz
        cur.execute("""INSERT INTO ciro (id,tarih,sube_id,nakit,pos,online,aciklama)
            VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (cid, c.tarih, c.sube_id, c.nakit, c.pos, c.online, c.aciklama))

        # Kasaya NET tutar yaz (komisyon zaten düşülmüş)
        # POS/Online kesinti ayrıca yazılmıyor — net tutar içinde zaten yok
        # Panel komisyon tutarını ciro tablosundan hesaplıyor (bilgi amaçlı)
        insert_kasa_hareketi(cur, c.tarih, 'CIRO', net_tutar,
            f'Ciro girişi (net) — pos:%{pos_oran} online:%{online_oran}',
            'ciro', cid, ref_id=cid, ref_type='CIRO')

        audit(cur, 'ciro', cid, 'INSERT')
    return {"id": cid, "success": True, "net_tutar": net_tutar,
            "pos_kesinti": pos_kesinti, "online_kesinti": online_kesinti}


@app.put("/api/ciro/{cid}")
def ciro_guncelle(cid: str, c: CiroModel):
    """
    Ciro güncelleme — ledger immutable mantığı korunur:
    1. Eski kasa hareketi ters kayıtla iptal edilir
    2. Yeni tutarla yeni kasa hareketi yazılır
    3. Ciro tablosu güncellenir
    Audit trail eksiksiz kalır.
    """
    nakit  = float(c.nakit  or 0)
    pos    = float(c.pos    or 0)
    online = float(c.online or 0)

    with db() as (conn, cur):
        cur.execute("SELECT * FROM ciro WHERE id=%s AND durum='aktif'", (cid,))
        eski = cur.fetchone()
        if not eski:
            raise HTTPException(404, "Ciro kaydı bulunamadı veya iptal edilmiş")

        # Şube oranlarını çek — güncel oranla hesapla
        sube_id = c.sube_id or eski['sube_id']
        cur.execute("SELECT COALESCE(pos_oran,0) as pos_oran, COALESCE(online_oran,0) as online_oran FROM subeler WHERE id=%s", (sube_id,))
        oran = cur.fetchone()
        pos_oran    = float(oran['pos_oran'])    if oran else 0.0
        online_oran = float(oran['online_oran']) if oran else 0.0

        pos_kesinti    = pos    * pos_oran    / 100.0
        online_kesinti = online * online_oran / 100.0
        net_tutar      = nakit + (pos - pos_kesinti) + (online - online_kesinti)

        # 1. Eski kasa hareketini iptal et (ters kayıt)
        iptal_kasa_hareketi(cur, cid, 'ciro', 'CIRO', 'CIRO_DUZELTME',
                            f'Ciro düzeltme — eski tutar iptal')

        # 2. Ciro tablosunu güncelle
        cur.execute("""
            UPDATE ciro SET nakit=%s, pos=%s, online=%s, aciklama=%s, sube_id=%s
            WHERE id=%s
        """, (nakit, pos, online, c.aciklama, sube_id, cid))

        # 3. Yeni net tutarla kasa hareketi yaz
        insert_kasa_hareketi(cur, eski['tarih'], 'CIRO', net_tutar,
            f'Ciro düzeltme (net) — pos:%{pos_oran} online:%{online_oran}',
            'ciro', cid, ref_id=cid, ref_type='CIRO_GUNCELLEME')

        audit(cur, 'ciro', cid, 'GUNCELLEME', eski=eski)

    return {"success": True, "net_tutar": net_tutar,
            "pos_kesinti": pos_kesinti, "online_kesinti": online_kesinti}

@app.delete("/api/ciro/{cid}")
def ciro_sil(cid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM ciro WHERE id=%s AND durum='aktif'", (cid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404, "Kayıt bulunamadı veya zaten iptal edilmiş")

        # Ciroyu iptal et
        cur.execute("UPDATE ciro SET durum='iptal' WHERE id=%s", (cid,))

        # Ledger: tüm silmelerle aynı model — tek merkez
        iptal_kasa_hareketi(cur, cid, 'ciro', 'CIRO', 'CIRO_IPTAL', 'Ciro iptali')

        audit(cur, 'ciro', cid, 'IPTAL', eski=eski)
    return {"success": True}

# ── PERSONEL ───────────────────────────────────────────────────
class PersonelModel(BaseModel):
    ad_soyad: str
    gorev: Optional[str] = None
    calisma_turu: str = 'surekli'
    maas: float = 0
    saatlik_ucret: float = 0
    yemek_ucreti: float = 0
    yol_ucreti: float = 0
    odeme_gunu: int = 28
    baslangic_tarihi: Optional[str] = None  # string olarak alıp None/boş kontrolü yapılır
    sube_id: Optional[str] = None
    notlar: Optional[str] = None

    def baslangic_date(self):
        if not self.baslangic_tarihi or self.baslangic_tarihi.strip() == '':
            return None
        try:
            from datetime import date as _date
            return _date.fromisoformat(self.baslangic_tarihi)
        except ValueError:
            return None

def _personel_api_row(r: dict) -> dict:
    d = dict(r)
    d["panel_pin_tanimli"] = bool((d.get("panel_pin_hash") or "").strip())
    d.pop("panel_pin_salt", None)
    d.pop("panel_pin_hash", None)
    if "panel_yonetici" in d and d["panel_yonetici"] is not None:
        d["panel_yonetici"] = bool(d["panel_yonetici"])
    return d


@app.get("/api/personel")
def personel_listele(aktif: Optional[bool] = None):
    with db() as (conn, cur):
        if aktif is not None:
            cur.execute(
                """
                SELECT p.*, s.ad as sube_adi,
                       opv.odeme_durumu, opv.odeme_tarihi, opv.odenecek_tutar, opv.odenen_tutar
                FROM personel p
                LEFT JOIN subeler s ON s.id = p.sube_id
                LEFT JOIN LATERAL (
                    SELECT
                        op.durum AS odeme_durumu,
                        op.tarih AS odeme_tarihi,
                        op.odenecek_tutar,
                        op.odenen_tutar
                    FROM odeme_plani op
                    WHERE op.kaynak_tablo='personel'
                      AND op.kaynak_id = p.id
                      AND op.durum != 'iptal'
                      AND DATE_TRUNC('month', op.tarih) = DATE_TRUNC('month', CURRENT_DATE)
                    ORDER BY
                        CASE WHEN op.durum='odendi' THEN 0 WHEN op.durum='onay_bekliyor' THEN 1 ELSE 2 END,
                        op.olusturma DESC
                    LIMIT 1
                ) opv ON TRUE
                WHERE p.aktif=%s
                ORDER BY p.ad_soyad
                """,
                (aktif,),
            )
        else:
            cur.execute(
                """
                SELECT p.*, s.ad as sube_adi,
                       opv.odeme_durumu, opv.odeme_tarihi, opv.odenecek_tutar, opv.odenen_tutar
                FROM personel p
                LEFT JOIN subeler s ON s.id = p.sube_id
                LEFT JOIN LATERAL (
                    SELECT
                        op.durum AS odeme_durumu,
                        op.tarih AS odeme_tarihi,
                        op.odenecek_tutar,
                        op.odenen_tutar
                    FROM odeme_plani op
                    WHERE op.kaynak_tablo='personel'
                      AND op.kaynak_id = p.id
                      AND op.durum != 'iptal'
                      AND DATE_TRUNC('month', op.tarih) = DATE_TRUNC('month', CURRENT_DATE)
                    ORDER BY
                        CASE WHEN op.durum='odendi' THEN 0 WHEN op.durum='onay_bekliyor' THEN 1 ELSE 2 END,
                        op.olusturma DESC
                    LIMIT 1
                ) opv ON TRUE
                ORDER BY p.ad_soyad
                """
            )
        return [_personel_api_row(dict(r)) for r in cur.fetchall()]

@app.post("/api/personel")
def personel_ekle(p: PersonelModel):
    with db() as (conn, cur):
        pid = str(uuid.uuid4())
        cur.execute("""INSERT INTO personel
            (id,ad_soyad,gorev,calisma_turu,maas,saatlik_ucret,yemek_ucreti,yol_ucreti,odeme_gunu,baslangic_tarihi,sube_id,notlar)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (pid, p.ad_soyad, p.gorev, p.calisma_turu, p.maas, p.saatlik_ucret,
             p.yemek_ucreti, p.yol_ucreti, p.odeme_gunu, p.baslangic_date(), p.sube_id, p.notlar))
        audit(cur, 'personel', pid, 'INSERT')
    return {"id": pid, "success": True}

@app.put("/api/personel/{pid}")
def personel_guncelle(pid: str, p: PersonelModel):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM personel WHERE id=%s", (pid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)
        cur.execute("""UPDATE personel SET ad_soyad=%s,gorev=%s,calisma_turu=%s,maas=%s,
            saatlik_ucret=%s,yemek_ucreti=%s,yol_ucreti=%s,odeme_gunu=%s,
            baslangic_tarihi=%s,sube_id=%s,notlar=%s WHERE id=%s""",
            (p.ad_soyad, p.gorev, p.calisma_turu, p.maas, p.saatlik_ucret,
             p.yemek_ucreti, p.yol_ucreti, p.odeme_gunu, p.baslangic_date(),
             p.sube_id, p.notlar, pid))
        audit(cur, 'personel', pid, 'UPDATE', eski=eski)
    return {"success": True}

@app.post("/api/personel/{pid}/cikis")
def personel_cikis(pid: str, neden: str = ""):
    with db() as (conn, cur):
        cur.execute("UPDATE personel SET aktif=FALSE, cikis_tarihi=%s WHERE id=%s",
            (str(bugun_tr()), pid))
        # Bekleyen maaş planlarını iptal et — simülasyondan çıksın
        cur.execute("""
            UPDATE odeme_plani SET durum='iptal'
            WHERE kaynak_tablo='personel' AND kaynak_id=%s
            AND durum IN ('bekliyor','onay_bekliyor')
        """, (pid,))
        cur.execute("""
            UPDATE onay_kuyrugu SET durum='reddedildi'
            WHERE kaynak_tablo='personel' AND kaynak_id=%s
            AND durum='bekliyor'
        """, (pid,))
        audit(cur, 'personel', pid, 'CIKIS')
    return {"success": True}

@app.delete("/api/personel/{pid}")
def personel_sil(pid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM personel WHERE id=%s", (pid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)
        cur.execute("DELETE FROM personel WHERE id=%s", (pid,))
        audit(cur, 'personel', pid, 'DELETE', eski=eski)
    return {"success": True}



class PersonelAylikModel(BaseModel):
    calisma_saati: float = 0
    fazla_mesai_saat: float = 0
    bayram_mesai_saat: float = 0
    eksik_gun: float = 0
    raporlu_gun: float = 0
    rapor_kesinti: bool = False
    manuel_duzeltme: float = 0
    not_aciklama: Optional[str] = None

def _maas_kayit_kilit_guard(cur, pid: str, yil: int, ay: int) -> None:
    """FAZ 0 #5: Onaylı (kilitli) veya ödenmiş maaş kaydı sessizce taslağa
    döndürülemez. Düzeltme için kullanıcı önce '🔓 Kilidi Aç' demeli."""
    cur.execute(
        "SELECT durum FROM personel_aylik WHERE personel_id=%s AND yil=%s AND ay=%s",
        (pid, yil, ay),
    )
    r = cur.fetchone()
    if r and (r.get("durum") == "onaylandi"):
        raise HTTPException(
            400,
            "Maaş kaydı onaylı (kilitli). Değiştirmek için önce '🔓 Kilidi Aç' yapın.",
        )
    cur.execute(
        """
        SELECT 1 FROM odeme_plani
        WHERE kaynak_tablo='personel' AND kaynak_id=%s AND durum='odendi'
          AND referans_ay = MAKE_DATE(%s, %s, 1)
        LIMIT 1
        """,
        (pid, yil, ay),
    )
    if cur.fetchone():
        raise HTTPException(
            400,
            "Bu ayın maaşı ödenmiş — kayıt değiştirilemez. Düzeltme için ek ödeme / "
            "gelecek aydan mahsup gerekir (geçmiş kayıt değişmez).",
        )


def maas_hesapla(p: dict, kayit: dict) -> float:
    """
    Personelin aylık net maaşını hesaplar.

    SÜREKLİ:
      - Günlük standart: 9.5 saat, haftada 1 izin → aylık 26 gün × 9.5 = 247 saat
      - Saatlik ücret = maaş / 247
      - Fazla mesai: 9.5 saat üstü çalışma, ×1 (maaş zaten 9.5h sistemi içeriyor)
      - Bayram mesaisi: ×2
      - Eksik gün kesintisi: saatlik × 9.5 × eksik_gün

    PART-TIME:
      - Saatlik ücret belirlenir
      - Normal saat × saatlik
      - Fazla mesai × saatlik × 1  (aynı mantık)
      - Bayram mesaisi × saatlik × 2
      - Yemek yok, yol var
    """
    GUNLUK_SAAT   = 9.5
    AYLIK_GUN     = 26        # haftada 1 izin → 30 - 4 ≈ 26
    AYLIK_SAAT    = GUNLUK_SAAT * AYLIK_GUN   # 247

    yol    = float(p.get('yol_ucreti') or 0)
    manuel = float(kayit.get('manuel_duzeltme') or 0)
    eksik  = float(kayit.get('eksik_gun') or 0)
    raporlu = float(kayit.get('raporlu_gun') or 0)
    fazla_normal = float(kayit.get('fazla_mesai_saat') or 0)
    fazla_bayram = float(kayit.get('bayram_mesai_saat') or 0)
    rapor_kesinti = kayit.get('rapor_kesinti', False)

    if p.get('calisma_turu') == 'surekli':
        maas    = float(p.get('maas') or 0)
        yemek   = float(p.get('yemek_ucreti') or 0)
        saatlik = maas / AYLIK_SAAT if AYLIK_SAAT > 0 else 0

        kesinti_gun = eksik + (raporlu if rapor_kesinti else 0)
        kesinti     = saatlik * GUNLUK_SAAT * kesinti_gun  # tam gün kesintisi

        fazla_ucret = (fazla_normal * saatlik) + (fazla_bayram * saatlik * 2)
        net = maas - kesinti + fazla_ucret + yemek + yol + manuel
    else:
        # PART-TIME: ay boyunca çalıştığı TOPLAM saat × saatlik ücret.
        # Fazla mesai kavramı YOK — tüm saatler zaten saat başı ödeniyor (limit/ek mesai
        # sadece sürekli/maaşlı için anlamlı). Yemek yok, yol + manuel düzeltme eklenir.
        saatlik = float(p.get('saatlik_ucret') or 0)
        saat    = float(kayit.get('calisma_saati') or 0)
        net = (saat * saatlik) + yol + manuel

    return round(max(0, net), 2)

@app.get("/api/personel-aylik")
def personel_aylik_listele(yil: int = None, ay: int = None):
    """Bu ay için tüm personelin aylik kayıtlarını döner. Kayıt yoksa tahmini tutar ile döner."""
    bugun = bugun_tr()
    yil = yil or bugun.year
    ay  = ay  or bugun.month
    with db() as (conn, cur):
        cur.execute("SELECT * FROM personel WHERE aktif=TRUE ORDER BY ad_soyad")
        personeller = cur.fetchall()
        sonuc = []
        for p in personeller:
            cur.execute("""
                SELECT * FROM personel_aylik
                WHERE personel_id=%s AND yil=%s AND ay=%s
            """, (p['id'], yil, ay))
            kayit = cur.fetchone()
            cur.execute(
                """
                SELECT
                    op.id::text AS odeme_id,
                    op.durum AS odeme_durumu,
                    op.tarih AS odeme_tarihi,
                    op.odenecek_tutar,
                    op.odenen_tutar
                FROM odeme_plani op
                WHERE op.kaynak_tablo='personel'
                  AND op.kaynak_id=%s
                  AND op.durum != 'iptal'
                  AND op.referans_ay = MAKE_DATE(%s, %s, 1)
                ORDER BY
                    CASE WHEN op.durum='odendi' THEN 0 WHEN op.durum='onay_bekliyor' THEN 1 ELSE 2 END,
                    op.olusturma DESC
                LIMIT 1
                """,
                (p['id'], yil, ay),
            )
            plan = cur.fetchone() or {}
            if kayit:
                net = float(kayit['hesaplanan_net'] or 0)
                durum = kayit['durum']
            else:
                # Tahmini hesap
                if p['calisma_turu'] == 'surekli':
                    net = float(p['maas'] or 0) + float(p['yemek_ucreti'] or 0) + float(p['yol_ucreti'] or 0)
                else:
                    net = 0  # Part-time saat girilmeden tahmin yapılamaz
                durum = 'tahmini'
                kayit = {}

            vk = _vv2.personel_ay_vardiya_maas_kaynagi(cur, p['id'], yil, ay)

            sonuc.append({
                'personel_id': p['id'],
                'ad_soyad': p['ad_soyad'],
                'gorev': p['gorev'],
                'calisma_turu': p['calisma_turu'],
                'maas': float(p['maas'] or 0),
                'saatlik_ucret': float(p['saatlik_ucret'] or 0),
                'yemek_ucreti': float(p['yemek_ucreti'] or 0),
                'yol_ucreti': float(p['yol_ucreti'] or 0),
                'sube_id': p['sube_id'],
                'kayit_id': kayit.get('id'),
                'calisma_saati': float(kayit.get('calisma_saati') or 0),
                'fazla_mesai_saat': float(kayit.get('fazla_mesai_saat') or 0),
                'bayram_mesai_saat': float(kayit.get('bayram_mesai_saat') or 0),
                'eksik_gun': float(kayit.get('eksik_gun') or 0),
                'raporlu_gun': float(kayit.get('raporlu_gun') or 0),
                'rapor_kesinti': kayit.get('rapor_kesinti', False),
                'manuel_duzeltme': float(kayit.get('manuel_duzeltme') or 0),
                'not_aciklama': kayit.get('not_aciklama'),
                'hesaplanan_net': net,
                'durum': durum,
                'odeme_id': plan.get('odeme_id'),
                'odeme_durumu': plan.get('odeme_durumu'),
                'odeme_tarihi': plan.get('odeme_tarihi'),
                'odenecek_tutar': float(plan.get('odenecek_tutar') or 0),
                'odenen_tutar': float(plan.get('odenen_tutar') or 0),
                'vardiya_ay_toplam_saat': vk.get('toplam_ay_saat', 0),
                'vardiya_ek_mesai_saat': vk.get('ek_mesai_haftalik_toplam', 0),
                'vardiya_haftalik_limit': vk.get('haftalik_limit', 0),
            })
        return {'yil': yil, 'ay': ay, 'personeller': sonuc,
                'toplam_tahmini': sum(r['hesaplanan_net'] for r in sonuc)}

@app.post("/api/personel-aylik/{pid}")
def personel_aylik_kaydet(pid: str, body: PersonelAylikModel, yil: int = None, ay: int = None):
    """Personel aylık kaydını girer/günceller ve maaşı hesaplar."""
    bugun = bugun_tr()
    yil = yil or bugun.year
    ay  = ay  or bugun.month
    with db() as (conn, cur):
        cur.execute("SELECT * FROM personel WHERE id=%s AND aktif=TRUE", (pid,))
        p = cur.fetchone()
        if not p: raise HTTPException(404, "Personel bulunamadı")
        _maas_kayit_kilit_guard(cur, pid, yil, ay)

        kayit_dict = body.dict()
        net = maas_hesapla(dict(p), kayit_dict)

        kid = str(uuid.uuid4())
        cur.execute("""
            INSERT INTO personel_aylik
                (id, personel_id, yil, ay, calisma_saati, fazla_mesai_saat, bayram_mesai_saat,
                 eksik_gun, raporlu_gun, rapor_kesinti, manuel_duzeltme,
                 not_aciklama, hesaplanan_net, durum)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'taslak')
            ON CONFLICT (personel_id, yil, ay) DO UPDATE SET
                calisma_saati=%s, fazla_mesai_saat=%s, bayram_mesai_saat=%s,
                eksik_gun=%s, raporlu_gun=%s, rapor_kesinti=%s, manuel_duzeltme=%s,
                not_aciklama=%s, hesaplanan_net=%s, durum='taslak'
        """, (kid, pid, yil, ay,
                body.calisma_saati, body.fazla_mesai_saat, body.bayram_mesai_saat,
                body.eksik_gun, body.raporlu_gun, body.rapor_kesinti,
                body.manuel_duzeltme, body.not_aciklama, net,
                body.calisma_saati, body.fazla_mesai_saat, body.bayram_mesai_saat,
                body.eksik_gun, body.raporlu_gun, body.rapor_kesinti,
                body.manuel_duzeltme, body.not_aciklama, net))

        # Bağlı ödeme planını gerçek tutarla güncelle
        cur.execute("""
            UPDATE odeme_plani SET odenecek_tutar=%s, asgari_tutar=%s
            WHERE kaynak_tablo='personel' AND kaynak_id=%s
            AND durum IN ('bekliyor','onay_bekliyor')
            AND referans_ay = MAKE_DATE(%s, %s, 1)
        """, (net, net, pid, yil, ay))

        audit(cur, 'personel_aylik', kid, 'KAYDET', yeni={'net': net, 'yil': yil, 'ay': ay})
    return {"success": True, "hesaplanan_net": net}


@app.post("/api/personel-aylik/{pid}/vardiya-aktar")
def personel_aylik_vardiya_aktar(pid: str, yil: int = None, ay: int = None):
    """
    Vardiya atamalarından (planlı/onaylı) aylık maaş satırına aktarır ve neti yeniden hesaplar.

    - **Sürekli (TAM):** ``fazla_mesai_saat`` ← haftalık limit üstü toplam ek mesai (57h vb.).
    - **Part-time:** ``calisma_saati`` ← ay içi toplam atanmış saat.
    Bayram, eksik gün, manuel düzeltme vb. mevcut kayıttan korunur.
    """
    bugun = bugun_tr()
    yil = yil or bugun.year
    ay = ay or bugun.month
    with db() as (conn, cur):
        cur.execute("SELECT * FROM personel WHERE id=%s AND aktif=TRUE", (pid,))
        p = cur.fetchone()
        if not p:
            raise HTTPException(404, "Personel bulunamadı")
        _maas_kayit_kilit_guard(cur, pid, yil, ay)

        vk = _vv2.personel_ay_vardiya_maas_kaynagi(cur, pid, yil, ay)
        cur.execute(
            "SELECT * FROM personel_aylik WHERE personel_id=%s AND yil=%s AND ay=%s",
            (pid, yil, ay),
        )
        row = cur.fetchone()
        calisma = float((row or {}).get("calisma_saati") or 0)
        fazla = float((row or {}).get("fazla_mesai_saat") or 0)
        bayram = float((row or {}).get("bayram_mesai_saat") or 0)
        eksik = float((row or {}).get("eksik_gun") or 0)
        raporlu = float((row or {}).get("raporlu_gun") or 0)
        rapor_k = bool((row or {}).get("rapor_kesinti") or False)
        manuel = float((row or {}).get("manuel_duzeltme") or 0)
        not_a = (row or {}).get("not_aciklama")

        ct = (p.get("calisma_turu") or "surekli")
        if ct == "surekli":
            # Sürekli: maaş sabit; vardiyadan yalnızca LİMİT ÜSTÜ ek mesai alınır.
            fazla = float(vk["ek_mesai_haftalik_toplam"])
        else:
            # Part-time: ay boyunca çalışılan TOPLAM saat. Fazla/bayram yok (çift sayım olmasın).
            calisma = float(vk["toplam_ay_saat"])
            fazla = 0.0
            bayram = 0.0

        kayit_dict = {
            "calisma_saati": calisma,
            "fazla_mesai_saat": fazla,
            "bayram_mesai_saat": bayram,
            "eksik_gun": eksik,
            "raporlu_gun": raporlu,
            "rapor_kesinti": rapor_k,
            "manuel_duzeltme": manuel,
            "not_aciklama": not_a,
        }
        net = maas_hesapla(dict(p), kayit_dict)

        kid = str(uuid.uuid4())
        cur.execute("""
            INSERT INTO personel_aylik
                (id, personel_id, yil, ay, calisma_saati, fazla_mesai_saat, bayram_mesai_saat,
                 eksik_gun, raporlu_gun, rapor_kesinti, manuel_duzeltme,
                 not_aciklama, hesaplanan_net, durum)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'taslak')
            ON CONFLICT (personel_id, yil, ay) DO UPDATE SET
                calisma_saati=%s, fazla_mesai_saat=%s, bayram_mesai_saat=%s,
                eksik_gun=%s, raporlu_gun=%s, rapor_kesinti=%s, manuel_duzeltme=%s,
                not_aciklama=%s, hesaplanan_net=%s, durum='taslak'
        """, (kid, pid, yil, ay,
                calisma, fazla, bayram,
                eksik, raporlu, rapor_k,
                manuel, not_a, net,
                calisma, fazla, bayram,
                eksik, raporlu, rapor_k,
                manuel, not_a, net))

        cur.execute("""
            UPDATE odeme_plani SET odenecek_tutar=%s, asgari_tutar=%s
            WHERE kaynak_tablo='personel' AND kaynak_id=%s
            AND durum IN ('bekliyor','onay_bekliyor')
            AND referans_ay = MAKE_DATE(%s, %s, 1)
        """, (net, net, pid, yil, ay))

        audit(cur, 'personel_aylik', kid, 'VARDIYA_AKTAR', yeni={'net': net, 'yil': yil, 'ay': ay})
    return {"success": True, "hesaplanan_net": net, "vardiya": vk}


@app.post("/api/personel-aylik/{pid}/onayla")
def personel_aylik_onayla(pid: str, yil: int = None, ay: int = None):
    """Maaş hesabını kilitler; ödeme yapmaz, kasa hareketi oluşturmaz."""
    bugun = bugun_tr()
    yil = yil or bugun.year
    ay  = ay  or bugun.month
    with db() as (conn, cur):
        cur.execute("""
            UPDATE personel_aylik SET durum='onaylandi'
            WHERE personel_id=%s AND yil=%s AND ay=%s AND durum='taslak'
        """, (pid, yil, ay))
        if cur.rowcount == 0:
            raise HTTPException(400, "Kayıt bulunamadı veya zaten onaylandı")
        cur.execute(
            """
            SELECT durum
            FROM odeme_plani
            WHERE kaynak_tablo='personel'
              AND kaynak_id=%s
              AND durum != 'iptal'
              AND referans_ay = MAKE_DATE(%s, %s, 1)
            ORDER BY
              CASE WHEN durum='odendi' THEN 0 WHEN durum='onay_bekliyor' THEN 1 ELSE 2 END,
              olusturma DESC
            LIMIT 1
            """,
            (pid, yil, ay),
        )
        plan = cur.fetchone()
    return {
        "success": True,
        "mesaj": "Maaş hesabı onaylandı. Ödeme paneldeki ödeme planından yapılır.",
        "kasa_etkisi": False,
        "odeme_durumu": (plan or {}).get("odeme_durumu"),
    }

@app.post("/api/personel-aylik/{pid}/kilit-ac")
def personel_aylik_kilit_ac(pid: str, yil: int = None, ay: int = None):
    """Onaylanmış (kilitli) maaş kaydını düzeltme için taslağa döndürür — son dakika
    fazla mesai/raporlu gibi durumlar için. ÖDENMİŞSE açılmaz (geçmiş değişmez;
    o durumda ek ödeme/mahsup gerekir)."""
    bugun = bugun_tr()
    yil = yil or bugun.year
    ay  = ay  or bugun.month
    with db() as (conn, cur):
        # Ödenmiş mi? Ödendiyse kilit açılmaz.
        cur.execute(
            """
            SELECT 1 FROM odeme_plani
            WHERE kaynak_tablo='personel' AND kaynak_id=%s AND durum='odendi'
              AND referans_ay = MAKE_DATE(%s, %s, 1)
            LIMIT 1
            """,
            (pid, yil, ay),
        )
        if cur.fetchone():
            raise HTTPException(
                400,
                "Bu ayın maaşı ödenmiş — kilit açılamaz. Düzeltme için ek ödeme / "
                "gelecek aydan mahsup gerekir (geçmiş kayıt değişmez).",
            )
        cur.execute(
            "UPDATE personel_aylik SET durum='taslak' WHERE personel_id=%s AND yil=%s AND ay=%s AND durum='onaylandi'",
            (pid, yil, ay),
        )
        if cur.rowcount == 0:
            raise HTTPException(400, "Onaylı kayıt bulunamadı (zaten taslak olabilir).")
        audit(cur, 'personel_aylik', pid, 'KILIT_AC', yeni={'yil': yil, 'ay': ay})
    return {"success": True, "mesaj": "Kilit açıldı — düzeltip tekrar onaylayın."}


@app.delete("/api/personel-aylik/{pid}")
def personel_aylik_sil(pid: str, yil: int = None, ay: int = None):
    """Personelin aylık maaş kaydını siler. Sadece taslak durumdakiler silinebilir."""
    bugun = bugun_tr()
    yil = yil or bugun.year
    ay  = ay  or bugun.month
    with db() as (conn, cur):
        cur.execute("SELECT * FROM personel_aylik WHERE personel_id=%s AND yil=%s AND ay=%s",
            (pid, yil, ay))
        kayit = cur.fetchone()
        if not kayit:
            raise HTTPException(404, "Kayıt bulunamadı")
        if kayit['durum'] == 'onaylandi':
            raise HTTPException(400, "Onaylanmış kayıt silinemez")
        cur.execute("DELETE FROM personel_aylik WHERE personel_id=%s AND yil=%s AND ay=%s",
            (pid, yil, ay))
        # Ödeme planını tahmini tutara geri döndür
        cur.execute("SELECT * FROM personel WHERE id=%s", (pid,))
        p = cur.fetchone()
        if p and p['calisma_turu'] == 'surekli':
            tahmini = float(p['maas'] or 0) + float(p['yemek_ucreti'] or 0) + float(p['yol_ucreti'] or 0)
            cur.execute("""
                UPDATE odeme_plani SET odenecek_tutar=%s, asgari_tutar=%s
                WHERE kaynak_tablo='personel' AND kaynak_id=%s
                AND durum IN ('bekliyor','onay_bekliyor')
                AND referans_ay = MAKE_DATE(%s, %s, 1)
            """, (tahmini, tahmini, pid, yil, ay))
        audit(cur, 'personel_aylik', str(kayit['id']), 'DELETE')
    return {"success": True}

@app.get("/api/personel-aylik/{pid}/gecmis")
def personel_aylik_gecmis(pid: str):
    """Personelin son 12 aylık maaş geçmişini döner."""
    with db() as (conn, cur):
        cur.execute("""
            SELECT yil, ay, hesaplanan_net, durum, calisma_saati,
                   fazla_mesai_saat, bayram_mesai_saat, eksik_gun, manuel_duzeltme
            FROM personel_aylik WHERE personel_id=%s
            ORDER BY yil DESC, ay DESC LIMIT 12
        """, (pid,))
        return [dict(r) for r in cur.fetchall()]

# ── SABİT GİDERLER ─────────────────────────────────────────────
class SabitGider(BaseModel):
    gider_adi: str
    kategori: str
    tutar: float = 0        # degisken tipte 0 olabilir
    tip: str = 'sabit'      # 'sabit' = tutar belli | 'degisken' = tutar sonradan belli
    periyot: str = 'aylik'
    odeme_gunu: int = 1
    baslangic_tarihi: Optional[date] = None
    sube_id: Optional[str] = None
    gecerlilik_tarihi: Optional[date] = None
    sozlesme_sure_ay: Optional[int] = None
    kira_artis_periyot: Optional[str] = None
    kira_artis_tarihi: Optional[date] = None
    sozlesme_bitis_tarihi: Optional[date] = None
    odeme_yontemi: str = 'nakit'   # 'nakit' veya 'kart'
    kart_id: Optional[str] = None  # Kart talimatı için

KIRA_ARTIS_PERIYOT_MAP = {"6ay": 6, "1yil": 12, "2yil": 24, "5yil": 60}

@app.get("/api/sabit-giderler")
def sabit_giderler_listele():
    with db() as (conn, cur):
        cur.execute("""
            SELECT sg.*, s.ad as sube_adi,
              -- Bu ay ödendi mi? Nakit kasa / kart talimatı / ödenmiş plan — herhangi biri.
              (
                EXISTS (
                  SELECT 1 FROM kasa_hareketleri kh
                  WHERE kh.kaynak_tablo='sabit_giderler' AND kh.kaynak_id=sg.id
                    AND kh.islem_turu='SABIT_GIDER' AND kh.kasa_etkisi=true AND kh.durum='aktif'
                    AND DATE_TRUNC('month', kh.tarih) = DATE_TRUNC('month', CURRENT_DATE)
                )
                OR EXISTS (
                  SELECT 1 FROM kart_hareketleri kt
                  WHERE kt.kaynak_tablo='fatura_giderleri' AND kt.kaynak_id=sg.id
                    AND kt.islem_turu='HARCAMA' AND kt.durum='aktif'
                    AND DATE_TRUNC('month', kt.tarih) = DATE_TRUNC('month', CURRENT_DATE)
                )
                OR EXISTS (
                  SELECT 1 FROM odeme_plani op
                  WHERE op.kaynak_tablo='sabit_giderler' AND op.kaynak_id=sg.id
                    AND op.durum='odendi'
                    AND op.referans_ay = DATE_TRUNC('month', CURRENT_DATE)
                )
              ) AS bu_ay_odendi
            FROM sabit_giderler sg
            LEFT JOIN subeler s ON s.id=sg.sube_id
            ORDER BY sg.kategori, sg.gider_adi""")
        return [dict(r) for r in cur.fetchall()]

@app.post("/api/sabit-giderler")
def sabit_gider_ekle(g: SabitGider):
    with db() as (conn, cur):
        gid = str(uuid.uuid4())
        # Kira artış tarihi: periyot seçildiyse başlangıçtan hesapla
        kira_artis_tarihi = g.kira_artis_tarihi  # manuel girilmişse koru
        if g.baslangic_tarihi and g.kira_artis_periyot and g.kira_artis_periyot in KIRA_ARTIS_PERIYOT_MAP:
            kira_artis_tarihi = ay_ekle(g.baslangic_tarihi, KIRA_ARTIS_PERIYOT_MAP[g.kira_artis_periyot])
        # Sözleşme bitiş tarihi hesapla
        sozlesme_bitis = None
        if g.baslangic_tarihi and g.sozlesme_sure_ay:
            sozlesme_bitis = ay_ekle(g.baslangic_tarihi, g.sozlesme_sure_ay)
        cur.execute("""INSERT INTO sabit_giderler
            (id,gider_adi,kategori,tutar,tip,periyot,odeme_gunu,baslangic_tarihi,sube_id,
             sozlesme_sure_ay,kira_artis_periyot,kira_artis_tarihi,sozlesme_bitis_tarihi,
             odeme_yontemi,kart_id)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (gid, g.gider_adi, g.kategori, g.tutar, g.tip, g.periyot, g.odeme_gunu,
             g.baslangic_tarihi, g.sube_id or None,
             g.sozlesme_sure_ay, g.kira_artis_periyot, kira_artis_tarihi, sozlesme_bitis,
             g.odeme_yontemi, g.kart_id or None))
        # Degisken gider: onay kuyruğuna girme — motor da plan üretmez, sadece hatırlatır
        # Kart talimatı: motor otomatik işler, onay kuyruğuna girme
        if g.tip == 'sabit' and g.odeme_yontemi != 'kart':
            onay_ekle(cur, 'SABIT_GIDER', 'sabit_giderler', gid,
                f"Sabit gider: {g.gider_adi}", g.tutar, bugun_tr())
        audit(cur, 'sabit_giderler', gid, 'INSERT')
    return {"id": gid, "success": True}

@app.put("/api/sabit-giderler/{gid}")
def sabit_gider_guncelle(gid: str, g: SabitGider):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM sabit_giderler WHERE id=%s", (gid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)

        # Eksik alanları eski kayıttan tamamla — None kontrolü: 0 ve False korunmalı
        def _pick(yeni, eski_val, default=None):
            """Yeni değer None ise eskiyi al. 0 ve False geçerli değerlerdir."""
            return yeni if yeni is not None else (eski_val if eski_val is not None else default)

        gider_adi     = g.gider_adi   or eski['gider_adi']
        kategori      = g.kategori    or eski['kategori']
        periyot       = g.periyot     or eski['periyot'] or 'aylik'
        odeme_gunu    = _pick(g.odeme_gunu, eski['odeme_gunu'], 1)
        sube_id       = g.sube_id     or eski['sube_id']
        odeme_yontemi = g.odeme_yontemi or eski.get('odeme_yontemi') or 'nakit'
        kart_id       = g.kart_id     or eski.get('kart_id')

        # Eğer gecerlilik_tarihi belirtilmişse: eski kaydı kapat, yeni kayıt aç
        if g.gecerlilik_tarihi:
            # Eski kaydı kapat
            cur.execute("UPDATE sabit_giderler SET aktif=FALSE WHERE id=%s", (gid,))
            audit(cur, 'sabit_giderler', gid, 'KAPATILDI', eski=eski)
            # Eski sabit gidere ait bu ayki bekleyen ödeme planlarını iptal et
            cur.execute("""
                UPDATE odeme_plani SET durum='iptal'
                WHERE kaynak_tablo='sabit_giderler'
                AND kaynak_id=%s
                AND durum IN ('bekliyor','onay_bekliyor')
                AND EXTRACT(YEAR FROM tarih) = EXTRACT(YEAR FROM %s::date)
                AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM %s::date)
            """, (gid, str(g.gecerlilik_tarihi), str(g.gecerlilik_tarihi)))
            # Onay kuyruğundaki eski kaydı da iptal et
            cur.execute("""
                UPDATE onay_kuyrugu SET durum='reddedildi'
                WHERE kaynak_id=%s AND durum='bekliyor'
            """, (gid,))
            # Yeni kayıt aç — gecerlilik_tarihi'nden itibaren
            yeni_id = str(uuid.uuid4())
            kira_artis_tarihi_g = g.kira_artis_tarihi
            if g.gecerlilik_tarihi and g.kira_artis_periyot and g.kira_artis_periyot in KIRA_ARTIS_PERIYOT_MAP:
                kira_artis_tarihi_g = ay_ekle(g.gecerlilik_tarihi, KIRA_ARTIS_PERIYOT_MAP[g.kira_artis_periyot])
            sozlesme_bitis = None
            if g.gecerlilik_tarihi and g.sozlesme_sure_ay:
                sozlesme_bitis = ay_ekle(g.gecerlilik_tarihi, g.sozlesme_sure_ay)
            tip = g.tip or eski.get('tip') or 'sabit'
            cur.execute("""INSERT INTO sabit_giderler
                (id,gider_adi,kategori,tutar,tip,periyot,odeme_gunu,baslangic_tarihi,sube_id,
                 sozlesme_sure_ay,kira_artis_periyot,kira_artis_tarihi,sozlesme_bitis_tarihi,
                 odeme_yontemi,kart_id)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (yeni_id, gider_adi, kategori, g.tutar, tip, periyot,
                 odeme_gunu, g.gecerlilik_tarihi, sube_id,
                 g.sozlesme_sure_ay, g.kira_artis_periyot, kira_artis_tarihi_g, sozlesme_bitis,
                 odeme_yontemi, kart_id or None))
            # KRİTİK 3: degisken gider onay kuyruğuna girmesin
            if tip == 'sabit' and odeme_yontemi != 'kart':
                onay_ekle(cur, 'SABIT_GIDER', 'sabit_giderler', yeni_id,
                    f"Sabit gider güncellendi: {gider_adi}", g.tutar, g.gecerlilik_tarihi)
            audit(cur, 'sabit_giderler', yeni_id, 'INSERT_GUNCELLEME')
            return {"success": True, "yeni_id": yeni_id}
        else:
            # Tarih belirtilmemişse — sadece bu kaydı güncelle
            tip_guncelle = g.tip or eski.get('tip') or 'sabit'
            cur.execute("""UPDATE sabit_giderler SET gider_adi=%s,kategori=%s,tutar=%s,
                tip=%s,periyot=%s,odeme_gunu=%s,baslangic_tarihi=%s,sube_id=%s,
                odeme_yontemi=%s,kart_id=%s WHERE id=%s""",
                (gider_adi, kategori, g.tutar, tip_guncelle, periyot, odeme_gunu,
                 g.baslangic_tarihi, sube_id, odeme_yontemi, kart_id or None, gid))
            audit(cur, 'sabit_giderler', gid, 'UPDATE', eski=eski)
        return {"success": True}

@app.delete("/api/sabit-giderler/{gid}")
def sabit_gider_sil(gid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM sabit_giderler WHERE id=%s AND aktif=TRUE", (gid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404, "Kayıt bulunamadı veya zaten pasif")
        cur.execute("UPDATE sabit_giderler SET aktif=FALSE WHERE id=%s", (gid,))
        # Bekleyen ödeme planlarını iptal et — yetim plan kasayı/borç projeksiyonunu şişirmesin
        cur.execute(
            """
            UPDATE odeme_plani SET durum='iptal'
            WHERE kaynak_tablo='sabit_giderler' AND kaynak_id=%s
              AND durum IN ('bekliyor','onay_bekliyor')
            """,
            (gid,),
        )
        iptal_plan = cur.rowcount or 0
        # İlişkili bekleyen onay kuyruğu kayıtlarını da iptal et
        try:
            cur.execute(
                """
                UPDATE onay_kuyrugu SET durum='iptal'
                WHERE kaynak_tablo='odeme_plani' AND durum='bekliyor'
                  AND kaynak_id IN (
                    SELECT id FROM odeme_plani
                    WHERE kaynak_tablo='sabit_giderler' AND kaynak_id=%s
                  )
                """,
                (gid,),
            )
        except Exception:
            pass
        audit(cur, 'sabit_giderler', gid, 'PASIF', eski=eski)
    return {"success": True, "iptal_edilen_plan": iptal_plan}

@app.get("/api/sabit-giderler/uyarilar")
def sabit_gider_uyarilar():
    """
    Kira/Abonelik uyarıları — iki bağımsız uyarı tipi:
    KIRA_ARTIS   : artış tarihi yaklaşıyor veya geçti → ödeme planı DURDU, tutar güncellenmeli
    SOZLESME_BITIS: sözleşme bitiyor veya bitti → uzatma/yenileme gerekiyor
    """
    bugun = bugun_tr()
    with db() as (conn, cur):
        cur.execute("""
            SELECT id, gider_adi, kategori, tutar, kira_artis_tarihi,
                   sozlesme_bitis_tarihi, kira_artis_periyot
            FROM sabit_giderler
            WHERE aktif = TRUE
            AND kategori IN ('Kira', 'Abonelik')
            AND (kira_artis_tarihi IS NOT NULL OR sozlesme_bitis_tarihi IS NOT NULL)
        """)
        kayitlar = cur.fetchall()

    uyarilar = []
    for r in kayitlar:

        # ── KIRA ARTIS ─────────────────────────────────────────────
        if r['kira_artis_tarihi']:
            gun_kalan = (r['kira_artis_tarihi'] - bugun).days

            if gun_kalan < 0:
                # Artış tarihi geçti — ödeme planı durdurulmuş, KRİTİK
                uyarilar.append({
                    'id': r['id'],
                    'tip': 'KIRA_ARTIS',
                    'seviye': 'KRITIK',
                    'durduruldu': True,        # plan üretimi durdu — sayaç için
                    'renk': 'red',
                    'gider_adi': r['gider_adi'],
                    'mesaj': (
                        f"⛔ {r['gider_adi']} — kira artış tarihi {abs(gun_kalan)} gün önce geçti! "
                        f"Yeni tutar girilene kadar ödeme planı üretilmiyor."
                    ),
                    'alt_mesaj': 'Mevcut tutar: ' + '{:,.0f} ₺'.format(float(r['tutar'])) + ' · Yeni tutarı ve artış tarihini güncelleyin',
                    'aksiyon': 'TUTAR_GUNCELLE',
                    'gun_kalan': gun_kalan,
                    'tarih': str(r['kira_artis_tarihi']),
                    'tutar': float(r['tutar'])
                })
            elif gun_kalan <= 15:
                # Artış yaklaşıyor — UYARI, plan henüz durmuş değil
                uyarilar.append({
                    'id': r['id'],
                    'tip': 'KIRA_ARTIS',
                    'seviye': 'UYARI',
                    'durduruldu': False,
                    'renk': 'yellow',
                    'gider_adi': r['gider_adi'],
                    'mesaj': f"⚠️ {r['gider_adi']} — kira artış tarihi {gun_kalan} gün sonra.",
                    'alt_mesaj': 'Mevcut tutar: ' + '{:,.0f} ₺'.format(float(r['tutar'])) + ' · Şimdiden yeni tutarı hazırlayın',
                    'aksiyon': 'TUTAR_GUNCELLE',
                    'gun_kalan': gun_kalan,
                    'tarih': str(r['kira_artis_tarihi']),
                    'tutar': float(r['tutar'])
                })

        # ── SÖZLEŞME BİTİŞ ─────────────────────────────────────────
        if r['sozlesme_bitis_tarihi']:
            gun_kalan = (r['sozlesme_bitis_tarihi'] - bugun).days

            if gun_kalan < 0:
                # Sözleşme süresi doldu — KRİTİK, ödeme planı durdurulmuş
                uyarilar.append({
                    'id': r['id'],
                    'tip': 'SOZLESME_BITIS',
                    'seviye': 'KRITIK',
                    'durduruldu': True,        # plan üretimi durdu — sayaç için
                    'renk': 'red',
                    'gider_adi': r['gider_adi'],
                    'mesaj': (
                        f"⛔ {r['gider_adi']} — sözleşme süresi {abs(gun_kalan)} gün önce doldu! "
                        f"Yenilenene kadar ödeme planı üretilmiyor."
                    ),
                    'alt_mesaj': 'Sözleşmeyi yenileyin: yeni süre ve başlangıç tarihini girin',
                    'aksiyon': 'SOZLESME_UZAT',
                    'gun_kalan': gun_kalan,
                    'tarih': str(r['sozlesme_bitis_tarihi']),
                    'tutar': float(r['tutar'])
                })
            elif gun_kalan <= 30:
                # Sözleşme yaklaşıyor — UYARI, plan henüz durmuş değil
                uyarilar.append({
                    'id': r['id'],
                    'tip': 'SOZLESME_BITIS',
                    'seviye': 'UYARI',
                    'durduruldu': False,
                    'renk': 'yellow',
                    'gider_adi': r['gider_adi'],
                    'mesaj': f"📋 {r['gider_adi']} — sözleşme {gun_kalan} gün sonra bitiyor.",
                    'alt_mesaj': 'Yenileme için hazırlık yapın',
                    'aksiyon': 'SOZLESME_UZAT',
                    'gun_kalan': gun_kalan,
                    'tarih': str(r['sozlesme_bitis_tarihi']),
                    'tutar': float(r['tutar'])
                })

    # Kritikler önce, sonra uyarılar; kendi içinde gün_kalan'a göre sırala
    uyarilar.sort(key=lambda x: (0 if x['seviye'] == 'KRITIK' else 1, x['gun_kalan']))
    return {"uyarilar": uyarilar, "adet": len(uyarilar)}

@app.get("/api/sabit-giderler/odenenler")
def sabit_gider_odenenler():
    """Gerçekleşmiş sabit gider ödemeleri — CFO görünürlük katmanı.
    İki yol birleştirilir: (a) ödeme planından ödenenler (odeme_plani),
    (b) manuel /fatura-ode ile ödenenler (kasa SABIT_GIDER, kaynak_tablo=sabit_giderler).
    Plan-nakit kasa kaydı kaynak_tablo='odeme_plani' taşıdığından çakışmaz; ayrıca aynı
    gider+ay için plan ödemesi varsa manuel satır NOT EXISTS ile elenir (çift sayım yok)."""
    with db() as (conn, cur):
        cur.execute("""
            SELECT * FROM (
                SELECT
                    op.id,
                    op.aciklama,
                    op.odenen_tutar,
                    op.odenecek_tutar,
                    op.odeme_tarihi,
                    op.tarih as plan_tarihi,
                    op.kaynak_id,
                    COALESCE(sg.gider_adi, op.aciklama) as gider_adi,
                    COALESCE(sg.kategori, '') as kategori
                FROM odeme_plani op
                LEFT JOIN sabit_giderler sg ON sg.id = op.kaynak_id
                WHERE op.durum = 'odendi'
                AND op.kaynak_tablo = 'sabit_giderler'

                UNION ALL

                SELECT
                    kh.id,
                    kh.aciklama,
                    ABS(kh.tutar) as odenen_tutar,
                    ABS(kh.tutar) as odenecek_tutar,
                    kh.tarih as odeme_tarihi,
                    kh.tarih as plan_tarihi,
                    kh.kaynak_id,
                    COALESCE(sg.gider_adi, kh.aciklama) as gider_adi,
                    COALESCE(sg.kategori, '') as kategori
                FROM kasa_hareketleri kh
                LEFT JOIN sabit_giderler sg ON sg.id = kh.kaynak_id
                WHERE kh.islem_turu = 'SABIT_GIDER'
                AND kh.kasa_etkisi = true AND kh.durum = 'aktif'
                AND kh.kaynak_tablo = 'sabit_giderler'
                AND NOT EXISTS (
                    SELECT 1 FROM odeme_plani op2
                    WHERE op2.kaynak_tablo='sabit_giderler' AND op2.kaynak_id=kh.kaynak_id
                      AND op2.durum='odendi'
                      AND op2.referans_ay = DATE_TRUNC('month', kh.tarih)
                )
            ) t
            ORDER BY t.odeme_tarihi DESC
            LIMIT 50
        """)
        return [dict(r) for r in cur.fetchall()]

@app.get("/api/sabit-giderler/odemeler")
def sabit_gider_odemeler(ay: str = None):
    """Ödenmiş + bekleyen + gecikmiş sabit giderler — CFO dashboard.
    Nakit: kasa_hareketleri SABIT_GIDER
    Kart: kart_hareketleri kaynak_tablo=sabit_giderler (kart talimatı)
    """
    with db() as (conn, cur):
        # Nakit ödenenler — kasa_hareketleri
        cur.execute("""
            SELECT
                kh.tarih,
                ABS(kh.tutar) as tutar,
                kh.aciklama,
                COALESCE(sg.gider_adi, kh.aciklama) as gider_adi,
                COALESCE(sg.kategori, '') as kategori,
                'odendi' as durum,
                'nakit' as odeme_yontemi,
                NULL as banka,
                NULL as kart_adi,
                kh.olusturma
            FROM kasa_hareketleri kh
            LEFT JOIN sabit_giderler sg ON sg.id = kh.kaynak_id
            WHERE kh.islem_turu = 'SABIT_GIDER'
            AND kh.kasa_etkisi = true AND kh.durum = 'aktif'
            ORDER BY kh.tarih DESC
            LIMIT 200
        """)
        nakit_odenenler = [dict(r) for r in cur.fetchall()]

        # Kart ödenenler — kart_hareketleri (kart talimatı ile)
        cur.execute("""
            SELECT
                kh.tarih,
                kh.tutar,
                kh.aciklama,
                COALESCE(sg.gider_adi, kh.aciklama) as gider_adi,
                COALESCE(sg.kategori, '') as kategori,
                'odendi' as durum,
                'kart' as odeme_yontemi,
                k.banka,
                k.kart_adi,
                kh.olusturma
            FROM kart_hareketleri kh
            JOIN kartlar k ON k.id = kh.kart_id
            LEFT JOIN sabit_giderler sg ON sg.id = kh.kaynak_id
            WHERE kh.islem_turu = 'HARCAMA' AND kh.durum = 'aktif'
            AND kh.kaynak_tablo = 'sabit_giderler'
            ORDER BY kh.tarih DESC
            LIMIT 200
        """)
        kart_odenenler = [dict(r) for r in cur.fetchall()]

        odenenler = nakit_odenenler + kart_odenenler
        odenenler.sort(key=lambda x: str(x['tarih']), reverse=True)

        # Bekleyen + gecikmiş — odeme_plani üzerinden (nakit: bekliyor, kart: motor zaten işledi)
        cur.execute("""
            SELECT
                op.tarih,
                op.odenecek_tutar as tutar,
                op.aciklama,
                COALESCE(sg.gider_adi, op.aciklama) as gider_adi,
                COALESCE(sg.kategori, '') as kategori,
                CASE
                    WHEN op.tarih < CURRENT_DATE THEN 'gecikti'
                    ELSE 'bekliyor'
                END as durum,
                op.olusturma
            FROM odeme_plani op
            LEFT JOIN sabit_giderler sg ON sg.id = op.kaynak_id
            WHERE op.kaynak_tablo = 'sabit_giderler'
            AND op.durum IN ('bekliyor', 'onay_bekliyor')
            AND op.tarih >= DATE '2026-06-01'   -- sistem başlangıcı: Haziran öncesi gösterilmez
            ORDER BY op.tarih ASC
        """)
        bekleyenler = [dict(r) for r in cur.fetchall()]

        # Özet
        nakit_odenen = sum(float(r['tutar']) for r in nakit_odenenler)
        kart_odenen  = sum(float(r['tutar']) for r in kart_odenenler)
        toplam_odenen = nakit_odenen + kart_odenen
        toplam_bekleyen = sum(float(r['tutar']) for r in bekleyenler)
        geciken = [r for r in bekleyenler if r['durum'] == 'gecikti']

        return {
            "odenenler": odenenler,
            "bekleyenler": bekleyenler,
            "ozet": {
                "toplam_odenen": toplam_odenen,
                "nakit_odenen": nakit_odenen,
                "kart_odenen": kart_odenen,
                "toplam_bekleyen": toplam_bekleyen,
                "geciken_adet": len(geciken),
                "geciken_tutar": sum(float(r['tutar']) for r in geciken),
                "odenenler": odenenler
            }
        }

@app.post("/api/odeme-plani/gecmis-temizle")
def odeme_plani_gecmis_temizle(baslangic: str = "2026-06-01", uygula: bool = False):
    """Sistem başlangıç tarihinden ÖNCEKİ bekleyen/onay_bekleyen ödeme planlarını
    borç listesinden çıkarır (durum='iptal' — SİLİNMEZ, geri alınabilir).

    - uygula=False (varsayılan): yalnızca önizleme — neyin iptal edileceğini listeler.
    - uygula=True: iptal işlemini uygular.
    Haziran (ve sonrası) ödemelere dokunmaz. 'odendi' kayıtlar korunur.
    """
    from datetime import date as _date
    try:
        kesim = _date.fromisoformat(baslangic)
    except Exception:
        raise HTTPException(400, "baslangic tarihi geçersiz (YYYY-MM-DD bekleniyor)")

    with db() as (conn, cur):
        cur.execute(
            """
            SELECT id::text, tarih, odenecek_tutar, durum, kaynak_tablo, aciklama
            FROM odeme_plani
            WHERE durum IN ('bekliyor','onay_bekliyor') AND tarih < %s
            ORDER BY tarih ASC
            """,
            (kesim,),
        )
        adaylar = [dict(r) for r in (cur.fetchall() or [])]
        toplam = sum(float(r["odenecek_tutar"] or 0) for r in adaylar)
        liste = [
            {
                "tarih": str(r["tarih"])[:10],
                "tutar": float(r["odenecek_tutar"] or 0),
                "durum": r["durum"],
                "kaynak": r["kaynak_tablo"],
                "aciklama": str(r["aciklama"] or "")[:60],
            }
            for r in adaylar
        ]

        if not uygula:
            return {
                "onizleme": True,
                "baslangic": str(kesim),
                "iptal_edilecek_adet": len(adaylar),
                "iptal_edilecek_tutar": round(toplam, 2),
                "kayitlar": liste,
                "not": "uygula=true ile iptal edilir. Hiçbiri silinmez, durum='iptal' olur.",
            }

        cur.execute(
            """
            UPDATE odeme_plani
            SET durum='iptal',
                aciklama = COALESCE(aciklama,'') || ' · iptal: sistem başlangıcı ' || %s
            WHERE durum IN ('bekliyor','onay_bekliyor') AND tarih < %s
            """,
            (str(kesim), kesim),
        )
        iptal_adet = cur.rowcount
        return {
            "onizleme": False,
            "baslangic": str(kesim),
            "iptal_edilen_adet": iptal_adet,
            "iptal_edilen_tutar": round(toplam, 2),
            "kayitlar": liste,
        }


@app.post("/api/sabit-giderler/odenmis-plan-esitle")
def sabit_gider_odenmis_plan_esitle(uygula: bool = False):
    """Geri-doldurma: kasada ÖDENMİŞ (SABIT_GIDER) kaydı olduğu hâlde bağlı ödeme planı
    hâlâ 'bekliyor'/'onay_bekliyor' kalmış sabit giderleri 'odendi' yapar.
    Bunlar 'ödenmiş giderler'de görünüp panelde aynı anda 'vadesi geçmiş borç' görünen
    çift-gösterim kayıtlarıdır. Önizleme (uygula=False) → liste; uygula=True → düzeltir.
    İlişkili bekleyen onay kuyruğu da kapatılır."""
    with db() as (conn, cur):
        cur.execute("""
            SELECT op.id::text, op.tarih, op.odenecek_tutar, op.durum, op.kaynak_id::text,
                   COALESCE(sg.gider_adi, op.aciklama) AS gider_adi
            FROM odeme_plani op
            LEFT JOIN sabit_giderler sg ON sg.id = op.kaynak_id
            WHERE op.kaynak_tablo='sabit_giderler'
              AND op.durum IN ('bekliyor','onay_bekliyor')
              AND EXISTS (
                  SELECT 1 FROM kasa_hareketleri kh
                  WHERE kh.kaynak_tablo='sabit_giderler' AND kh.kaynak_id=op.kaynak_id
                    AND kh.islem_turu='SABIT_GIDER' AND kh.kasa_etkisi=true AND kh.durum='aktif'
                    AND DATE_TRUNC('month', kh.tarih) = DATE_TRUNC('month', op.tarih)
              )
            ORDER BY op.tarih ASC
        """)
        adaylar = [dict(r) for r in (cur.fetchall() or [])]
        liste = [{"tarih": str(r["tarih"])[:10], "tutar": float(r["odenecek_tutar"] or 0),
                  "durum": r["durum"], "gider_adi": r["gider_adi"]} for r in adaylar]
        if not uygula:
            return {"onizleme": True, "esitlenecek_adet": len(adaylar), "kayitlar": liste,
                    "not": "uygula=true ile bu planlar 'odendi' yapılır."}
        esit = 0
        if adaylar:
            cur.execute("""
                UPDATE odeme_plani op SET durum='odendi',
                    odeme_tarihi=COALESCE(op.odeme_tarihi, CURRENT_DATE)
                WHERE op.kaynak_tablo='sabit_giderler'
                  AND op.durum IN ('bekliyor','onay_bekliyor')
                  AND EXISTS (
                      SELECT 1 FROM kasa_hareketleri kh
                      WHERE kh.kaynak_tablo='sabit_giderler' AND kh.kaynak_id=op.kaynak_id
                        AND kh.islem_turu='SABIT_GIDER' AND kh.kasa_etkisi=true AND kh.durum='aktif'
                        AND DATE_TRUNC('month', kh.tarih) = DATE_TRUNC('month', op.tarih)
                  )
            """)
            esit = cur.rowcount
            # İlişkili bekleyen onayları da kapat
            cur.execute("""
                UPDATE onay_kuyrugu ok SET durum='onaylandi', onay_tarihi=NOW()
                WHERE ok.kaynak_tablo='sabit_giderler' AND ok.durum='bekliyor'
                AND EXISTS (
                    SELECT 1 FROM kasa_hareketleri kh
                    WHERE kh.kaynak_tablo='sabit_giderler' AND kh.kaynak_id=ok.kaynak_id
                      AND kh.islem_turu='SABIT_GIDER' AND kh.kasa_etkisi=true AND kh.durum='aktif'
                      AND DATE_TRUNC('month', kh.tarih) = DATE_TRUNC('month', ok.tarih)
                )
            """)
        return {"onizleme": False, "esitlenen_adet": esit, "kayitlar": liste}


@app.post("/api/odeme-plani/odenmis-plan-esitle")
def odeme_plani_odenmis_esitle(uygula: bool = False):
    """Geri-doldurma (TÜM kaynaklar): kasada ÖDENMİŞ kasa hareketi olduğu hâlde bağlı
    ödeme planı hâlâ 'bekliyor'/'onay_bekliyor' kalmış kayıtları 'odendi' yapar.
    /api/sabit-giderler/odenmis-plan-esitle'nin genel hâli — borc_envanteri, vadeli_alimlar,
    personel ve sabit_giderler için de çalışır.

    Sebep: ödeme yolları planı 'odendi' yaparken DATE_TRUNC('month', plan.tarih)=ödeme ayı
    filtresi kullanır; ödeme planın vade ayından farklı bir ayda yapıldıysa UPDATE 0 satır
    eşler → para kasadan çıkar ama plan 'bekliyor' kalır, panelde gecikmiş borç görünür.

    Kasa kaydı iki şekilde bağlanmış olabilir:
      (a) kaynak_tablo='odeme_plani' AND kaynak_id=plan.id (borç/kart anapara)
      (b) kaynak_tablo=plan.kaynak_tablo AND kaynak_id=plan.kaynak_id (sabit/vadeli/personel)
    Sadece kart_id'siz (nakit/kaynak bağlı) planlar — kart planlarının kendi guard'ı vardır.
    Önizleme (uygula=False) → liste; uygula=True → düzeltir + ilişkili onay kuyruğunu kapatır."""
    _esit_kosul = """
        op.kart_id IS NULL
        AND op.kaynak_id IS NOT NULL
        AND op.durum IN ('bekliyor','onay_bekliyor')
        AND EXISTS (
            SELECT 1 FROM kasa_hareketleri kh
            WHERE kh.kasa_etkisi = TRUE AND kh.durum = 'aktif'
              AND DATE_TRUNC('month', kh.tarih) = DATE_TRUNC('month', op.tarih)
              AND (
                    (kh.kaynak_tablo = 'odeme_plani' AND kh.kaynak_id = op.id)
                 OR (kh.kaynak_tablo = op.kaynak_tablo AND kh.kaynak_id = op.kaynak_id)
              )
        )
    """
    with db() as (conn, cur):
        cur.execute(f"""
            SELECT op.id::text, op.tarih, op.odenecek_tutar, op.durum,
                   op.kaynak_tablo, op.kaynak_id::text, op.aciklama
            FROM odeme_plani op
            WHERE {_esit_kosul}
            ORDER BY op.tarih ASC
        """)
        adaylar = [dict(r) for r in (cur.fetchall() or [])]
        liste = [{"tarih": str(r["tarih"])[:10], "tutar": float(r["odenecek_tutar"] or 0),
                  "durum": r["durum"], "kaynak_tablo": r["kaynak_tablo"],
                  "aciklama": r["aciklama"]} for r in adaylar]
        if not uygula:
            return {"onizleme": True, "esitlenecek_adet": len(adaylar), "kayitlar": liste,
                    "not": "uygula=true ile bu planlar 'odendi' yapılır."}
        esit = 0
        if adaylar:
            cur.execute(f"""
                UPDATE odeme_plani op SET durum='odendi',
                    odeme_tarihi=COALESCE(op.odeme_tarihi, CURRENT_DATE)
                WHERE {_esit_kosul}
            """)
            esit = cur.rowcount
            # İlişkili bekleyen onayları da kapat (plan id veya kaynak id ile bağlı)
            cur.execute("""
                UPDATE onay_kuyrugu ok SET durum='onaylandi', onay_tarihi=NOW()
                WHERE ok.durum='bekliyor'
                AND EXISTS (
                    SELECT 1 FROM odeme_plani op
                    WHERE op.durum='odendi'
                      AND (ok.kaynak_id = op.id::text OR
                           (ok.kaynak_tablo = op.kaynak_tablo AND ok.kaynak_id = op.kaynak_id::text))
                )
            """)
        return {"onizleme": False, "esitlenen_adet": esit, "kayitlar": liste}


@app.get("/api/odeme-plani/mukerrer-tara")
def odeme_plani_mukerrer_tara():
    """Tanı (read-only): aktif mükerrer ödeme planı grupları + mükerrer-engel index'i kurulu mu.
    Aynı (kaynak_tablo, kaynak_id, referans_ay) için >1 aktif (iptal değil) plan = çift ödeme riski."""
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT kaynak_tablo, kaynak_id, referans_ay::text AS referans_ay,
                   COUNT(*) AS adet,
                   ARRAY_AGG(id::text) AS plan_idler,
                   ARRAY_AGG(durum) AS durumlar,
                   ARRAY_AGG(aciklama) AS aciklamalar
            FROM odeme_plani
            WHERE durum <> 'iptal' AND kaynak_id IS NOT NULL AND referans_ay IS NOT NULL
            GROUP BY kaynak_tablo, kaynak_id, referans_ay
            HAVING COUNT(*) > 1
            ORDER BY adet DESC
            """
        )
        gruplar = [dict(r) for r in (cur.fetchall() or [])]
        cur.execute(
            "SELECT 1 FROM pg_indexes WHERE indexname = 'uq_odeme_plani_kaynak_ay_aktif'"
        )
        index_var = cur.fetchone() is not None
    return {
        "mukerrer_grup_adet": len(gruplar),
        "mukerrer_engel_index_kurulu": index_var,
        "gruplar": gruplar,
    }


@app.post("/api/odeme-plani/mukerrer-temizle")
def odeme_plani_mukerrer_temizle(uygula: bool = False):
    """Aktif mükerrer ödeme planlarını teke indirir (en eski kalır, fazlalar 'iptal').
    Ödenmiş kopyaların PARA ayağı da geri alınır (geri alınabilir, hiçbir şey silinmez):
      - kasa_hareketleri: kaynak_id=plan_id (idempotency) ile iptal (nakit ödenmişse).
      - kart_hareketleri: kart talimatı (kaynak_tablo=sabit_giderler) için eşleşen fazla HARCAMA iptal.
    uygula=False → önizleme. Mükerrer kalmazsa UNIQUE index kurulur."""
    rapor = {"onizleme": (not uygula), "gruplar": [], "iptal_plan": [],
             "iptal_kart_hareketi": [], "iptal_kasa": [], "index_kuruldu": False}
    with db() as (conn, cur):
        cur.execute("""
            SELECT kaynak_tablo, kaynak_id, referans_ay
            FROM odeme_plani
            WHERE durum <> 'iptal' AND kaynak_id IS NOT NULL AND referans_ay IS NOT NULL
            GROUP BY kaynak_tablo, kaynak_id, referans_ay
            HAVING COUNT(*) > 1
        """)
        gruplar = [dict(r) for r in (cur.fetchall() or [])]
        for g in gruplar:
            cur.execute("""
                SELECT id::text, durum, odenecek_tutar, kart_id, aciklama
                FROM odeme_plani
                WHERE durum <> 'iptal'
                  AND kaynak_tablo IS NOT DISTINCT FROM %s
                  AND kaynak_id = %s AND referans_ay = %s
                ORDER BY olusturma ASC, id ASC
            """, (g["kaynak_tablo"], g["kaynak_id"], g["referans_ay"]))
            rows = [dict(r) for r in (cur.fetchall() or [])]
            tutulan, fazlalar = rows[0], rows[1:]
            rapor["gruplar"].append({
                "kaynak_tablo": g["kaynak_tablo"], "referans_ay": str(g["referans_ay"]),
                "toplam": len(rows), "tutulan_plan": tutulan["id"],
                "iptal_edilecek": [f["id"] for f in fazlalar],
                "aciklama": str(tutulan.get("aciklama") or "")[:50],
            })
            if not uygula:
                continue
            for f in fazlalar:
                cur.execute("""UPDATE odeme_plani SET durum='iptal',
                    aciklama = COALESCE(aciklama,'') || ' · iptal: mukerrer temizlik'
                    WHERE id=%s""", (f["id"],))
                rapor["iptal_plan"].append({"id": f["id"],
                    "tutar": float(f["odenecek_tutar"] or 0), "onceki_durum": f["durum"]})
                if f["durum"] == "odendi":
                    cur.execute("""UPDATE kasa_hareketleri SET durum='iptal'
                        WHERE kaynak_id=%s AND durum='aktif' RETURNING id::text, tutar""", (f["id"],))
                    for kr in (cur.fetchall() or []):
                        rapor["iptal_kasa"].append({"id": kr["id"], "tutar": float(kr["tutar"])})
                    if g["kaynak_tablo"] == "sabit_giderler":
                        cur.execute("""
                            UPDATE kart_hareketleri SET durum='iptal'
                            WHERE id = (
                                SELECT id FROM kart_hareketleri
                                WHERE kaynak_tablo='sabit_giderler' AND kaynak_id=%s
                                  AND islem_turu='HARCAMA' AND durum='aktif'
                                  AND ABS(tutar - %s) < 0.01
                                ORDER BY tarih DESC, id DESC LIMIT 1
                            )
                            RETURNING id::text, tutar
                        """, (g["kaynak_id"], float(f["odenecek_tutar"] or 0)))
                        for kr in (cur.fetchall() or []):
                            rapor["iptal_kart_hareketi"].append({"id": kr["id"], "tutar": float(kr["tutar"])})
        if uygula:
            cur.execute("""
                SELECT COUNT(*) AS n FROM (
                  SELECT 1 FROM odeme_plani
                  WHERE durum <> 'iptal' AND kaynak_id IS NOT NULL AND referans_ay IS NOT NULL
                  GROUP BY kaynak_tablo, kaynak_id, referans_ay HAVING COUNT(*)>1
                ) d
            """)
            if int(cur.fetchone()["n"]) == 0:
                cur.execute("""
                    CREATE UNIQUE INDEX IF NOT EXISTS uq_odeme_plani_kaynak_ay_aktif
                    ON odeme_plani (kaynak_tablo, kaynak_id, referans_ay)
                    WHERE durum <> 'iptal' AND kaynak_id IS NOT NULL AND referans_ay IS NOT NULL
                """)
                rapor["index_kuruldu"] = True
    return rapor


@app.post("/api/odeme-plani/personel-arrears-tarih-duzelt")
def personel_arrears_tarih_duzelt(uygula: bool = False):
    """Mevcut bekleyen PERSONEL maaş planlarının ödeme tarihini arrears (geçmiş ay)
    modeline çeker: tarih = çalışma ayı (referans_ay) + 1 ay'ın 1'i. Ödenmişlere
    dokunmaz. İdempotent (zaten ileri tarihliyse atlar). uygula=False önizleme."""
    with db() as (conn, cur):
        where = """
            WHERE kaynak_tablo='personel' AND durum IN ('bekliyor','onay_bekliyor')
              AND referans_ay IS NOT NULL
              AND tarih < (referans_ay + INTERVAL '1 month')::date
        """
        cur.execute(
            "SELECT id::text, referans_ay::text AS calisma_ay, tarih::text AS eski_tarih, "
            "((referans_ay + INTERVAL '1 month')::date)::text AS yeni_tarih, aciklama "
            "FROM odeme_plani " + where + " ORDER BY referans_ay"
        )
        adaylar = [dict(r) for r in (cur.fetchall() or [])]
        if uygula:
            cur.execute(
                "UPDATE odeme_plani SET tarih = (referans_ay + INTERVAL '1 month')::date " + where
            )
        return {"onizleme": (not uygula), "adet": len(adaylar), "kayitlar": adaylar}


# ── FATURA ÖDEMESİ ────────────────────────────────────────────

class FaturaOdemeModel(BaseModel):
    sabit_gider_id: str       # Hangi değişken gider ödeniyor
    tutar: float              # Fatura tutarı
    tarih: date               # Ödeme tarihi
    odeme_yontemi: str = 'nakit'
    kart_id: Optional[str] = None
    aciklama: Optional[str] = None

@app.post("/api/fatura-ode")
def fatura_ode(body: FaturaOdemeModel):
    """
    Değişken sabit gider (elektrik, su vb.) fatura ödemesi.
    Kasaya FATURA_ODEMESI olarak yazılır, kaynak sabit_giderler tablosuna bağlanır.
    """
    try:
        _tutar_chk = float(body.tutar)
    except (TypeError, ValueError):
        raise HTTPException(400, "Geçerli bir tutar girin")
    if _tutar_chk <= 0:
        raise HTTPException(400, "Tutar 0'dan büyük olmalı")
    with db() as (conn, cur):
        # Sabit gideri kontrol et
        cur.execute("SELECT * FROM sabit_giderler WHERE id=%s AND aktif=TRUE", (body.sabit_gider_id,))
        gider = cur.fetchone()
        if not gider:
            raise HTTPException(404, "Gider bulunamadı")
        _tip = (gider.get('tip') or 'sabit')
        if _tip not in ('degisken', 'sabit'):
            raise HTTPException(400, "Geçersiz gider tipi")
        # Değişken (elektrik/su) → FATURA_ODEMESI · Sabit (kira vb.) → SABIT_GIDER
        _kasa_turu = 'FATURA_ODEMESI' if _tip == 'degisken' else 'SABIT_GIDER'

        # Bu ay zaten ödendi mi? (a) manuel kasa ödemesi (b) ödeme planından ödenmiş.
        # ÇİFT ÖDEME KAPISI: plan yolu kasaya kaynak_id=plan_id yazar; bu yüzden manuel
        # dedup'ı plan ödemesini de görmeli — yoksa aynı kira iki yoldan ödenip kasadan
        # iki kez düşer.
        cur.execute("""
            SELECT 1 FROM kasa_hareketleri
            WHERE kaynak_id=%s AND kaynak_tablo='sabit_giderler'
            AND islem_turu=%s AND kasa_etkisi=true AND durum='aktif'
            AND EXTRACT(YEAR FROM tarih) = EXTRACT(YEAR FROM %s::date)
            AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM %s::date)
        """, (body.sabit_gider_id, _kasa_turu, str(body.tarih), str(body.tarih)))
        if cur.fetchone():
            raise HTTPException(400, "Bu ay için zaten ödeme yapılmış")
        # Bu giderin bu ayki ödeme planı zaten ödenmiş mi? (kart veya nakit — her yöntem)
        cur.execute("""
            SELECT 1 FROM odeme_plani
            WHERE kaynak_tablo='sabit_giderler' AND kaynak_id=%s
              AND durum='odendi'
              AND referans_ay = DATE_TRUNC('month', %s::date)
        """, (body.sabit_gider_id, str(body.tarih)))
        if cur.fetchone():
            raise HTTPException(400, "Bu ay için ödeme planından zaten ödendi — tekrar ödeme yapılamaz")

        aciklama = body.aciklama or f"Fatura: {gider['gider_adi']}"

        if body.odeme_yontemi == 'kart':
            if not body.kart_id:
                raise HTTPException(400, "Kart seçimi zorunlu")
            cur.execute("SELECT * FROM kartlar WHERE id=%s AND aktif=TRUE FOR UPDATE", (body.kart_id,))
            kart = cur.fetchone()
            if not kart:
                raise HTTPException(404, "Kart bulunamadı")
            # Mevcut kart borcunu hesapla — limit kontrolü, FOR UPDATE: eş zamanlı limit aşımını önler
            borc = kart_borc(cur, body.kart_id)
            kalan_limit = float(kart['limit_tutar']) - borc
            if kalan_limit < body.tutar:
                raise HTTPException(400, f"Kart limiti yetersiz. Kalan: {kalan_limit:,.0f} ₺")
            # Karta HARCAMA yaz — kaynak_tablo fatura_giderleri
            fid = str(uuid.uuid4())   # kart yolunda fid = kart_hareketleri kaydı
            cur.execute("""
                INSERT INTO kart_hareketleri
                    (id, kart_id, tarih, islem_turu, tutar, taksit_sayisi, aciklama, kaynak_id, kaynak_tablo)
                VALUES (%s, %s, %s, 'HARCAMA', %s, 1, %s, %s, 'fatura_giderleri')
            """, (fid, body.kart_id, str(body.tarih), body.tutar, aciklama, body.sabit_gider_id))
            audit(cur, 'kart_hareketleri', fid, 'FATURA_KART')
            kart_plan_guncelle_tx(cur)
        else:
            # Kasaya yaz
            fid = str(uuid.uuid4())   # nakit yolunda fid = kasa_hareketleri kaydı
            insert_kasa_hareketi(cur, str(body.tarih), _kasa_turu, -abs(body.tutar),
                aciklama, 'sabit_giderler', body.sabit_gider_id,
                ref_id=fid, ref_type=_kasa_turu)

        # Bağlı ödeme planını ÖDENDİ yap — yoksa kasa kaydı oluşsa da plan 'bekliyor'
        # kalıp CFO panelde "vadesi geçmiş borç" + ödenmedi olarak görünür (çift gösterim).
        cur.execute("""
            UPDATE odeme_plani SET durum='odendi', odeme_tarihi=%s
            WHERE kaynak_tablo='sabit_giderler' AND kaynak_id=%s
            AND durum IN ('bekliyor','onay_bekliyor')
            AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', %s::date)
        """, (str(body.tarih), body.sabit_gider_id, str(body.tarih)))
        # Aynı gider+ay için bekleyen onay kuyruğu kaydını kapat — onay merkezden düşsün.
        cur.execute("""
            UPDATE onay_kuyrugu SET durum='onaylandi', onay_tarihi=NOW()
            WHERE kaynak_tablo='sabit_giderler' AND kaynak_id=%s AND durum='bekliyor'
            AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', %s::date)
        """, (body.sabit_gider_id, str(body.tarih)))

        audit(cur, 'sabit_giderler', body.sabit_gider_id, 'FATURA_ODENDI',
              yeni={'tutar': body.tutar, 'tarih': str(body.tarih)})
    return {"success": True, "id": fid}

@app.get("/api/fatura-gecmis/{gider_id}")
def fatura_gecmis(gider_id: str):
    """Bir değişken giderin geçmiş fatura ödemelerini döner."""
    with db() as (conn, cur):
        cur.execute("""
            SELECT tarih, ABS(tutar) as tutar, aciklama, 'nakit' as yontem
            FROM kasa_hareketleri
            WHERE kaynak_id=%s AND kaynak_tablo='sabit_giderler'
            AND islem_turu IN ('FATURA_ODEMESI','SABIT_GIDER') AND kasa_etkisi=true AND durum='aktif'
            ORDER BY tarih DESC LIMIT 12
        """, (gider_id,))
        nakit = [dict(r) for r in cur.fetchall()]

        cur.execute("""
            SELECT kh.tarih, kh.tutar, kh.aciklama, 'kart' as yontem, k.banka, k.kart_adi
            FROM kart_hareketleri kh
            JOIN kartlar k ON k.id = kh.kart_id
            WHERE kh.kaynak_id=%s AND kh.kaynak_tablo='fatura_giderleri'
            AND kh.islem_turu='HARCAMA' AND kh.durum='aktif'
            ORDER BY kh.tarih DESC LIMIT 12
        """, (gider_id,))
        kart = [dict(r) for r in cur.fetchall()]

        gecmis = nakit + kart
        gecmis.sort(key=lambda x: str(x['tarih']), reverse=True)
        return gecmis

@app.get("/api/sabit-giderler/{gid}/gecmis")
def sabit_gider_gecmis(gid: str):
    """Sabit giderin ödeme geçmişi — kasa_hareketleri + odeme_plani."""
    with db() as (conn, cur):
        cur.execute("SELECT * FROM sabit_giderler WHERE id=%s", (gid,))
        gider = cur.fetchone()
        if not gider: raise HTTPException(404, "Gider bulunamadı")

        # Ödenen — kasa_hareketleri
        cur.execute("""
            SELECT tarih, ABS(tutar) as tutar, aciklama, islem_turu
            FROM kasa_hareketleri
            WHERE kaynak_id = %s AND kaynak_tablo = 'sabit_giderler'
            AND kasa_etkisi = true AND durum = 'aktif' AND tutar < 0
            ORDER BY tarih DESC
        """, (gid,))
        odenenler = [{"tarih": str(r['tarih']), "tutar": float(r['tutar']),
                      "aciklama": r['aciklama'] or '', "durum": "odendi"} for r in cur.fetchall()]

        # Bekleyen — odeme_plani
        cur.execute("""
            SELECT tarih, odenecek_tutar, durum, aciklama
            FROM odeme_plani
            WHERE kaynak_id = %s AND kaynak_tablo = 'sabit_giderler'
            AND durum IN ('bekliyor','onay_bekliyor')
            ORDER BY tarih ASC
        """, (gid,))
        bekleyenler = [{"tarih": str(r['tarih']), "tutar": float(r['odenecek_tutar']),
                        "aciklama": r['aciklama'] or '', "durum": r['durum']} for r in cur.fetchall()]

        toplam_odenen = sum(r['tutar'] for r in odenenler)
        son_tutar = odenenler[0]['tutar'] if odenenler else None
        return {
            "gider": {"id": str(gider['id']), "gider_adi": gider['gider_adi'],
                      "kategori": gider['kategori'], "tutar": float(gider['tutar'])},
            "ozet": {"toplam_odenen": round(toplam_odenen, 2),
                     "odeme_adedi": len(odenenler)},
            # son_tutar: son ödeme tutarı — fatura modalı otomatik öneri için
            "son_tutar": round(son_tutar, 2) if son_tutar is not None else None,
            "son_tarih": odenenler[0]['tarih'] if odenenler else None,
            "odenenler": odenenler,
            "bekleyenler": bekleyenler,
        }

@app.get("/api/anlik-gider/gecmis")
def anlik_gider_gecmis(kategori: str = None, limit: int = 100):
    """Anlık gider geçmişi — isteğe bağlı kategori filtresi."""
    with db() as (conn, cur):
        if kategori:
            cur.execute("""
                SELECT tarih, ABS(tutar) as tutar, aciklama, kategori, odeme_yontemi
                FROM kasa_hareketleri
                WHERE islem_turu = 'ANLIK_GIDER' AND durum = 'aktif' AND tutar < 0
                AND aciklama ILIKE %s
                ORDER BY tarih DESC LIMIT %s
            """, (f"%{kategori}%", limit))
        else:
            cur.execute("""
                SELECT tarih, ABS(tutar) as tutar, aciklama, islem_turu as kategori, odeme_yontemi
                FROM kasa_hareketleri
                WHERE islem_turu = 'ANLIK_GIDER' AND durum = 'aktif' AND tutar < 0
                ORDER BY tarih DESC LIMIT %s
            """, (limit,))
        satirlar = [{"tarih": str(r['tarih']), "tutar": float(r['tutar']),
                     "aciklama": r['aciklama'] or '', 
                     "odeme_yontemi": r.get('odeme_yontemi', 'nakit')} for r in cur.fetchall()]

        # Kategori özeti
        cur.execute("""
            SELECT
                SPLIT_PART(aciklama, ' - ', 1) as kat,
                COUNT(*) as adet,
                SUM(ABS(tutar)) as toplam
            FROM kasa_hareketleri
            WHERE islem_turu = 'ANLIK_GIDER' AND durum = 'aktif' AND tutar < 0
            GROUP BY kat ORDER BY toplam DESC LIMIT 10
        """)
        kategoriler = [{"kategori": r['kat'] or 'Diğer',
                        "adet": int(r['adet']), "toplam": float(r['toplam'])} for r in cur.fetchall()]

        return {"satirlar": satirlar, "kategoriler": kategoriler,
                "toplam": sum(r['tutar'] for r in satirlar)}


@app.get("/api/bilgi-teslim-kayitlari")
def bilgi_teslim_kayitlari(sube_id: Optional[str] = None, gun: int = 30, limit: int = 300):
    """
    Şubelerden merkeze iletilen bilgi/not kayıtları.
    """
    gun_sayi = max(1, min(365, int(gun)))
    lim = max(1, min(1000, int(limit)))
    with db() as (conn, cur):
        qp: List[Any] = [gun_sayi]
        q = """
            SELECT n.id, n.sube_id, s.ad AS sube_adi, n.metin,
                   n.personel_id, n.personel_ad, n.olusturma
            FROM sube_merkez_not n
            LEFT JOIN subeler s ON s.id = n.sube_id
            WHERE n.olusturma >= (NOW() - (%s * INTERVAL '1 day'))
        """
        if sube_id:
            q += " AND n.sube_id=%s"
            qp.append(sube_id)
        q += " ORDER BY n.olusturma DESC LIMIT %s"
        qp.append(lim)
        cur.execute(q, qp)
        satirlar = []
        for r in cur.fetchall():
            d = dict(r)
            if d.get("olusturma"):
                d["olusturma"] = str(d["olusturma"])
            satirlar.append(d)
        return {"gun_sayi": gun_sayi, "sube_id": sube_id, "limit": lim, "satirlar": satirlar}


# ── VADELİ ALIMLAR ─────────────────────────────────────────────
class VadeliAlim(BaseModel):
    aciklama: str
    tutar: float
    vade_tarihi: date
    tedarikci: str          # Zorunlu — kart takibi ve raporlar için
    force: bool = False
    # TEDARIKCI_ACIK_BAKIYE (çoklu açık borç): ayri=yeni satır, ilave=seçilen/hedefe ekle.
    # Tek açık borçta birleştirme artık varsayılan — ayri ile ayrı satır zorlanır.
    tedarikci_karari: Optional[str] = None
    # API/çoklu açık borçta ilave hedefi; tek satırda tedarikci_karari=ilave yeter
    birlestir_vadeli_id: Optional[str] = None


def _vadeli_tedarikci_norm(s: str) -> str:
    return (s or "").strip().lower()


def _vadeli_bekleyen_ayni_tedarikci(cur, tedarikci: str):
    t = _vadeli_tedarikci_norm(tedarikci)
    if not t:
        return []
    cur.execute(
        """
        SELECT id, aciklama, tutar, vade_tarihi, tedarikci
        FROM vadeli_alimlar
        WHERE durum = 'bekliyor'
          AND LOWER(TRIM(COALESCE(tedarikci, ''))) = %s
        ORDER BY vade_tarihi
        """,
        (t,),
    )
    return cur.fetchall()


def _vadeli_borcla_birlestir(cur, hedef_id: str, v: VadeliAlim) -> dict:
    cur.execute(
        "SELECT * FROM vadeli_alimlar WHERE id=%s FOR UPDATE",
        (hedef_id,),
    )
    eski = cur.fetchone()
    if not eski:
        raise HTTPException(404, "Birleştirilecek vadeli kaydı bulunamadı")
    if eski["durum"] != "bekliyor":
        raise HTTPException(
            400,
            "Sadece bekleyen vadeli borcuna eklenebilir — ödenmiş veya iptal satıra eklenemez.",
        )
    if _vadeli_tedarikci_norm(eski.get("tedarikci")) != _vadeli_tedarikci_norm(v.tedarikci):
        raise HTTPException(400, "Tedarikçi eşleşmiyor — birleştirme yapılamaz.")
    ek = float(v.tutar)
    if ek <= 0:
        raise HTTPException(400, "Eklenecek tutar sıfırdan büyük olmalı")
    yeni_toplam = float(eski["tutar"]) + ek
    a_eski = (eski.get("aciklama") or "").strip()
    a_yeni = (v.aciklama or "").strip()
    yeni_aciklama = (
        f"{a_eski} + {a_yeni}" if a_eski and a_yeni else (a_yeni or a_eski or "Vadeli alım")
    )
    ted = (v.tedarikci or "").strip() or (eski.get("tedarikci") or "")
    cur.execute(
        """UPDATE vadeli_alimlar SET tutar=%s, vade_tarihi=%s, aciklama=%s, tedarikci=%s WHERE id=%s""",
        (yeni_toplam, v.vade_tarihi, yeni_aciklama, ted, hedef_id),
    )
    cur.execute(
        """
        SELECT id FROM odeme_plani
        WHERE kaynak_tablo='vadeli_alimlar' AND kaynak_id=%s
        AND durum IN ('bekliyor','onay_bekliyor')
        LIMIT 1
        """,
        (hedef_id,),
    )
    prow = cur.fetchone()
    if prow:
        pid = prow["id"]
        cur.execute(
            """
            UPDATE odeme_plani SET
                tarih=%s,
                referans_ay=DATE_TRUNC('month', %s::date),
                odenecek_tutar=%s,
                asgari_tutar=%s,
                aciklama=%s
            WHERE id=%s
            """,
            (
                v.vade_tarihi,
                str(v.vade_tarihi),
                yeni_toplam,
                yeni_toplam,
                f"Vadeli Alım: {yeni_aciklama}",
                pid,
            ),
        )
    else:
        pid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO odeme_plani
                (id, kart_id, tarih, referans_ay, odenecek_tutar, asgari_tutar, aciklama, durum, kaynak_tablo, kaynak_id)
            VALUES (%s, NULL, %s, DATE_TRUNC('month', %s::date), %s, %s, %s, 'bekliyor', 'vadeli_alimlar', %s)
            """,
            (
                pid,
                v.vade_tarihi,
                str(v.vade_tarihi),
                yeni_toplam,
                yeni_toplam,
                f"Vadeli Alım: {yeni_aciklama}",
                hedef_id,
            ),
        )
    cur.execute(
        """
        UPDATE onay_kuyrugu SET tutar=%s, tarih=%s
        WHERE durum='bekliyor' AND islem_turu='VADELI_ODEME'
        AND kaynak_tablo='vadeli_alimlar' AND kaynak_id=%s
        """,
        (yeni_toplam, v.vade_tarihi, hedef_id),
    )
    cur.execute(
        """
        UPDATE onay_kuyrugu SET tutar=%s, tarih=%s
        WHERE durum='bekliyor' AND islem_turu='ODEME_PLANI'
        AND kaynak_tablo='odeme_plani'
        AND kaynak_id IN (
            SELECT id FROM odeme_plani
            WHERE kaynak_tablo='vadeli_alimlar' AND kaynak_id=%s
            AND durum IN ('bekliyor','onay_bekliyor')
        )
        """,
        (yeni_toplam, v.vade_tarihi, hedef_id),
    )
    audit(
        cur,
        "vadeli_alimlar",
        hedef_id,
        "BORC_EKLE",
        eski=dict(eski),
        yeni={
            "tutar": yeni_toplam,
            "vade_tarihi": str(v.vade_tarihi),
            "aciklama": yeni_aciklama,
        },
    )
    return {
        "id": hedef_id,
        "success": True,
        "birlestirildi": True,
        "onceki_tutar": float(eski["tutar"]),
        "eklenen": ek,
        "yeni_toplam": yeni_toplam,
    }


@app.get("/api/vadeli-alimlar")
def vadeli_listele(durum: str = "bekliyor", gun: int = 30):
    d = (durum or "bekliyor").strip().lower()
    g = max(1, min(int(gun or 30), 365))
    with db() as (conn, cur):
        if d == "bekliyor":
            cur.execute(
                """
                SELECT *, (vade_tarihi - CURRENT_DATE) as gun_kaldi
                FROM vadeli_alimlar
                WHERE durum='bekliyor'
                ORDER BY vade_tarihi
                """
            )
        elif d == "odendi":
            cur.execute(
                """
                SELECT *, (vade_tarihi - CURRENT_DATE) as gun_kaldi
                FROM vadeli_alimlar
                WHERE durum='odendi'
                  AND odeme_tarihi >= CURRENT_DATE - (%s || ' days')::interval
                ORDER BY odeme_tarihi DESC NULLS LAST, vade_tarihi DESC
                """,
                (g,),
            )
        elif d == "hepsi":
            cur.execute(
                """
                SELECT *, (vade_tarihi - CURRENT_DATE) as gun_kaldi
                FROM vadeli_alimlar
                ORDER BY
                    CASE WHEN durum='bekliyor' THEN 0 WHEN durum='odendi' THEN 1 ELSE 2 END,
                    COALESCE(odeme_tarihi, vade_tarihi) DESC
                """
            )
        else:
            raise HTTPException(400, "durum: bekliyor | odendi | hepsi")
        return [dict(r) for r in cur.fetchall()]


@app.get("/api/vadeli-alimlar/gecmis")
def vadeli_gecmis(limit: int = 120):
    lim = max(1, min(int(limit or 120), 500))
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT *
            FROM (
                SELECT
                    kh.tarih,
                    ABS(kh.tutar) AS tutar,
                    'nakit'::text AS odeme_yontemi,
                    kh.aciklama,
                    va.id AS vadeli_id,
                    va.aciklama AS vadeli_aciklama,
                    va.tedarikci
                FROM kasa_hareketleri kh
                LEFT JOIN vadeli_alimlar va ON va.id = kh.kaynak_id
                WHERE kh.kaynak_tablo='vadeli_alimlar'
                  AND kh.islem_turu='VADELI_ODEME'
                  AND kh.kasa_etkisi=TRUE
                  AND kh.durum='aktif'

                UNION ALL

                SELECT
                    kht.tarih,
                    kht.tutar,
                    'kart'::text AS odeme_yontemi,
                    kht.aciklama,
                    va.id AS vadeli_id,
                    va.aciklama AS vadeli_aciklama,
                    va.tedarikci
                FROM kart_hareketleri kht
                LEFT JOIN vadeli_alimlar va ON va.id = kht.kaynak_id
                WHERE kht.kaynak_tablo='vadeli_alimlar'
                  AND kht.islem_turu='HARCAMA'
                  AND kht.durum='aktif'
            ) q
            ORDER BY q.tarih DESC
            LIMIT %s
            """,
            (lim,),
        )
        satirlar = [dict(r) for r in cur.fetchall()]
        toplam = sum(float(r.get("tutar") or 0) for r in satirlar)
        return {"satirlar": satirlar, "ozet": {"adet": len(satirlar), "toplam": toplam}}

@app.post("/api/vadeli-alimlar")
def vadeli_ekle(v: VadeliAlim):
    try:
        if float(v.tutar) <= 0:
            raise HTTPException(400, "Tutar 0'dan büyük olmalı")
    except (TypeError, ValueError):
        raise HTTPException(400, "Geçerli bir tutar girin")
    if not (v.tedarikci or "").strip():
        raise HTTPException(400, "Tedarikçi zorunlu")
    with db() as (conn, cur):
        birlestir = (v.birlestir_vadeli_id or "").strip()
        karar = (v.tedarikci_karari or "").strip().lower()

        if birlestir:
            return _vadeli_borcla_birlestir(cur, birlestir, v)

        acik = _vadeli_bekleyen_ayni_tedarikci(cur, v.tedarikci)
        if acik and not v.force:
            if karar == "ayri":
                pass
            elif karar == "ilave":
                if len(acik) == 1:
                    return _vadeli_borcla_birlestir(cur, acik[0]["id"], v)
                raise HTTPException(
                    400,
                    "Bu tedarikçide birden fazla açık borç var — birlestir_vadeli_id ile hedef satırı gönderin.",
                )
            elif len(acik) == 1:
                # Aynı toptancı/tedarikçide tek bekleyen borç: tutarı üstüne topla (onay sormadan).
                return _vadeli_borcla_birlestir(cur, acik[0]["id"], v)
            else:
                return {
                    "warning": True,
                    "kod": "TEDARIKCI_ACIK_BAKIYE",
                    "mesaj": (
                        "Bu tedarikçi için birden fazla bekleyen vadeli borç var. "
                        "Hangi satıra ekleneceğini seçin veya ayrı satır olarak kaydedin."
                    ),
                    "mevcut_borc": [dict(r) for r in acik],
                }

        if not v.force:
            cur.execute("""
                SELECT id FROM vadeli_alimlar WHERE durum='bekliyor'
                AND vade_tarihi BETWEEN %s::date - INTERVAL '7 days' AND %s::date + INTERVAL '7 days'
                AND ABS(tutar - %s) < 1
            """, (str(v.vade_tarihi), str(v.vade_tarihi), v.tutar))
            benzer = cur.fetchall()
            if benzer:
                return {"warning": True, "mesaj": f"Son 7 günde benzer kayıt var ({len(benzer)} adet). Yine de kaydetmek için force=true gönderin."}
        vid = str(uuid.uuid4())
        cur.execute("""INSERT INTO vadeli_alimlar (id,aciklama,tutar,vade_tarihi,tedarikci)
            VALUES (%s,%s,%s,%s,%s)""",
            (vid, v.aciklama, v.tutar, v.vade_tarihi, v.tedarikci))
        # odeme_plani'na kaynak bağlı plan ekle — simülasyon ve karar motoru görsün
        pid = str(uuid.uuid4())
        cur.execute("""
            INSERT INTO odeme_plani
                (id, kart_id, tarih, referans_ay, odenecek_tutar, asgari_tutar, aciklama, durum, kaynak_tablo, kaynak_id)
            SELECT %s, NULL, %s, DATE_TRUNC('month', %s::date), %s, %s, %s, 'bekliyor', 'vadeli_alimlar', %s
            WHERE NOT EXISTS (
                SELECT 1 FROM odeme_plani
                WHERE kaynak_tablo = 'vadeli_alimlar'
                AND kaynak_id = %s
                AND durum != 'iptal'
            )
        """, (pid, v.vade_tarihi, str(v.vade_tarihi), float(v.tutar), float(v.tutar),
              f"Vadeli Alım: {v.aciklama}", vid, vid))
        audit(cur, 'vadeli_alimlar', vid, 'INSERT')
    return {"id": vid, "success": True}

@app.put("/api/vadeli-alimlar/{vid}")
def vadeli_guncelle(vid: str, v: VadeliAlim):
    try:
        if float(v.tutar) <= 0:
            raise HTTPException(400, "Tutar 0'dan büyük olmalı")
    except (TypeError, ValueError):
        raise HTTPException(400, "Geçerli bir tutar girin")
    with db() as (conn, cur):
        cur.execute("SELECT * FROM vadeli_alimlar WHERE id=%s", (vid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)
        cur.execute("""UPDATE vadeli_alimlar SET aciklama=%s,tutar=%s,vade_tarihi=%s,tedarikci=%s WHERE id=%s""",
            (v.aciklama, v.tutar, v.vade_tarihi, v.tedarikci, vid))
        # Bağlı odeme_plani'nı da güncelle
        cur.execute("""
            UPDATE odeme_plani SET
                tarih=%s,
                referans_ay=DATE_TRUNC('month', %s::date),
                odenecek_tutar=%s,
                asgari_tutar=%s,
                aciklama=%s
            WHERE kaynak_tablo='vadeli_alimlar' AND kaynak_id=%s
            AND durum IN ('bekliyor','onay_bekliyor')
        """, (v.vade_tarihi, str(v.vade_tarihi), float(v.tutar), float(v.tutar),
              f"Vadeli Alım: {v.aciklama}", vid))
        # Bekleyen onay tutarı planla aynı kalsın (düzenleme sonrası eski tutarla çift/eksik kasa olmasın)
        cur.execute("""
            UPDATE onay_kuyrugu SET tutar=%s, tarih=%s
            WHERE durum='bekliyor' AND islem_turu='VADELI_ODEME'
            AND kaynak_tablo='vadeli_alimlar' AND kaynak_id=%s
        """, (float(v.tutar), v.vade_tarihi, vid))
        cur.execute("""
            UPDATE onay_kuyrugu SET tutar=%s, tarih=%s
            WHERE durum='bekliyor' AND islem_turu='ODEME_PLANI'
            AND kaynak_tablo='odeme_plani'
            AND kaynak_id IN (
                SELECT id FROM odeme_plani
                WHERE kaynak_tablo='vadeli_alimlar' AND kaynak_id=%s
                AND durum IN ('bekliyor','onay_bekliyor')
            )
        """, (float(v.tutar), v.vade_tarihi, vid))
        audit(cur, 'vadeli_alimlar', vid, 'UPDATE', eski=eski)
    return {"success": True}

@app.delete("/api/vadeli-alimlar/{vid}")
def vadeli_sil(vid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM vadeli_alimlar WHERE id=%s AND durum='bekliyor'", (vid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404, "Kayıt bulunamadı veya zaten ödenmiş/iptal edilmiş")
        cur.execute("UPDATE vadeli_alimlar SET durum='iptal' WHERE id=%s", (vid,))
        # Bağlı odeme_plani'nı iptal et — simülasyondan çıkar
        cur.execute("""
            UPDATE odeme_plani SET durum='iptal'
            WHERE kaynak_tablo='vadeli_alimlar' AND kaynak_id=%s
            AND durum IN ('bekliyor','onay_bekliyor')
        """, (vid,))
        # Guard: kasa hareketi varsa ters kayıt yaz, yoksa sadece durum değiştir
        cur.execute("""
            SELECT id FROM kasa_hareketleri
            WHERE kaynak_id=%s AND islem_turu='VADELI_ODEME' AND durum='aktif'
        """, (vid,))
        if cur.fetchone():
            iptal_kasa_hareketi(cur, vid, 'vadeli_alimlar', 'VADELI_ODEME', 'VADELI_IPTAL', 'Vadeli alım iptali')
        audit(cur, 'vadeli_alimlar', vid, 'IPTAL', eski=eski)
    return {"success": True}

@app.get("/api/vadeli-alimlar/{vid}/kart-oneri")
def vadeli_kart_oneri(vid: str):
    """
    Vadeli alım ödemesi için kart önerisi.
    Her aktif kartı skorlar: kesim günü uzaklığı, limit boşluğu, faiz oranı.
    En yüksek skor = en iyi kart.
    """
    bugun = bugun_tr()
    with db() as (conn, cur):
        cur.execute("SELECT * FROM vadeli_alimlar WHERE id=%s", (vid,))
        v = cur.fetchone()
        if not v: raise HTTPException(404)
        odeme_tutari = float(v['tutar'])

        cur.execute("SELECT * FROM kartlar WHERE aktif=TRUE ORDER BY banka")
        kartlar = cur.fetchall()

        sonuc = []
        for k in kartlar:
            # Güncel borç
            borc = kart_borc(cur, k['id'])
            limit = float(k['limit_tutar'])
            kalan_limit = limit - borc

            # Limit yetmiyorsa listeye alma
            if kalan_limit < odeme_tutari:
                sonuc.append({
                    'kart_id': str(k['id']),
                    'kart_adi': k['kart_adi'],
                    'banka': k['banka'],
                    'kalan_limit': kalan_limit,
                    'limit_doluluk': borc / limit if limit > 0 else 0,
                    'faiz_orani': float(k['faiz_orani']),
                    'kesim_gunu': k['kesim_gunu'],
                    'son_odeme_gunu': k['son_odeme_gunu'],
                    'uygun': False,
                    'uygun_degil_neden': 'Limit yetersiz',
                    'skor': 0,
                    'oneri': False,
                })
                continue

            # Kesim günü kaç gün kaldı
            kesim_gun = k['kesim_gunu']
            bugun_gun = bugun.day
            if kesim_gun >= bugun_gun:
                kesim_uzakligi = kesim_gun - bugun_gun
            else:
                import calendar
                ay_sonu = calendar.monthrange(bugun.year, bugun.month)[1]
                kesim_uzakligi = (ay_sonu - bugun_gun) + kesim_gun

            # Son ödeme günü 3 günden azsa önerme
            son_odeme_gun = k['son_odeme_gunu']
            if son_odeme_gun >= bugun_gun:
                son_odeme_uzakligi = son_odeme_gun - bugun_gun
            else:
                import calendar
                ay_sonu = calendar.monthrange(bugun.year, bugun.month)[1]
                son_odeme_uzakligi = (ay_sonu - bugun_gun) + son_odeme_gun

            if son_odeme_uzakligi <= 3:
                sonuc.append({
                    'kart_id': str(k['id']),
                    'kart_adi': k['kart_adi'],
                    'banka': k['banka'],
                    'kalan_limit': kalan_limit,
                    'limit_doluluk': borc / limit if limit > 0 else 0,
                    'faiz_orani': float(k['faiz_orani']),
                    'kesim_gunu': kesim_gun,
                    'kesim_uzakligi': kesim_uzakligi,
                    'son_odeme_gunu': son_odeme_gun,
                    'son_odeme_uzakligi': son_odeme_uzakligi,
                    'uygun': False,
                    'uygun_degil_neden': f'Son ödeme {son_odeme_uzakligi} gün sonra — bu kart zaten ödenecek',
                    'skor': 0,
                    'oneri': False,
                })
                continue

            # SKOR: kesim uzaklığı (0.5) + limit boşluğu (0.3) - faiz (0.2)
            limit_boslugu_pct = kalan_limit / limit if limit > 0 else 0
            faiz = float(k['faiz_orani'])
            faiz_normalize = min(faiz / 5.0, 1.0)  # 5 baz puan max normalize
            skor = (
                (kesim_uzakligi / 30.0) * 0.5 +
                limit_boslugu_pct * 0.3 -
                faiz_normalize * 0.2
            )

            sonuc.append({
                'kart_id': str(k['id']),
                'kart_adi': k['kart_adi'],
                'banka': k['banka'],
                'kalan_limit': kalan_limit,
                'limit_doluluk': borc / limit if limit > 0 else 0,
                'faiz_orani': faiz,
                'kesim_gunu': kesim_gun,
                'kesim_uzakligi': kesim_uzakligi,
                'son_odeme_gunu': son_odeme_gun,
                'son_odeme_uzakligi': son_odeme_uzakligi,
                'uygun': True,
                'uygun_degil_neden': None,
                'skor': round(skor, 4),
                'oneri': False,
            })

        # En yüksek skorlu uygun kartı öner
        uygunlar = [k for k in sonuc if k['uygun']]
        if uygunlar:
            en_iyi = max(uygunlar, key=lambda x: x['skor'])
            for k in sonuc:
                if k['kart_id'] == en_iyi['kart_id']:
                    k['oneri'] = True

        # Sıralama: önerilen önce, sonra skora göre
        sonuc.sort(key=lambda x: (-int(x['oneri']), -x['skor']))

        return {
            'vadeli_alim': {'id': str(v['id']), 'aciklama': v['aciklama'], 'tutar': odeme_tutari},
            'kartlar': sonuc,
            'oneri_var': any(k['oneri'] for k in sonuc)
        }


@app.post("/api/vadeli-alimlar/{vid}/ode")
def vadeli_ode(vid: str, body: VadeliOdeModel = VadeliOdeModel()):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM vadeli_alimlar WHERE id=%s AND durum='bekliyor'", (vid,))
        v = cur.fetchone()
        if not v: raise HTTPException(404)

        # ÇİFT ÖDEME GUARD — bağlı aktif odeme_plani varsa zaten ödenmemiş demektir.
        # Önce planı bul ki ödenecek GERÇEK tutarı (plan) belirleyelim; kart limiti de
        # bu tutara göre kontrol edilsin (vadeli_alimlar.tutar ile ayrışırsa yanlış kontrol olmasın).
        cur.execute("""
            SELECT id, odenecek_tutar FROM odeme_plani
            WHERE kaynak_tablo='vadeli_alimlar' AND kaynak_id=%s
            AND durum IN ('bekliyor','onay_bekliyor')
            LIMIT 1
        """, (vid,))
        aktif_plan = cur.fetchone()
        if not aktif_plan:
            odenen = vadeli_kasadan_odenen_toplam(cur, vid)
            if odenen >= float(v['tutar']):
                raise HTTPException(400, "Bu vadeli alım zaten tam olarak kasaya işlenmiş, tekrar ödeme yapılamaz.")
        plan = aktif_plan
        if not plan:
            raise HTTPException(400, "Bu vadeli alım için ödeme planı bulunamadı")

        bugun = str(bugun_tr())
        tutar = float(plan['odenecek_tutar'])  # vadeli_alimlar.tutar değil, planın tutarı

        # KART seçildiyse validasyon + limit kontrolü (PLAN tutarı üzerinden)
        if body.odeme_yontemi == 'kart':
            if not body.kart_id:
                raise HTTPException(400, "Kart seçimi zorunlu")
            cur.execute("SELECT * FROM kartlar WHERE id=%s AND aktif=TRUE FOR UPDATE", (body.kart_id,))
            kart = cur.fetchone()
            if not kart: raise HTTPException(404, "Kart bulunamadı")
            borc = kart_borc(cur, body.kart_id)
            kalan_limit = float(kart['limit_tutar']) - borc
            if kalan_limit < tutar:
                raise HTTPException(400, f"Kart limiti yetersiz. Kalan: {kalan_limit:,.0f} ₺")

        # Onay kuyruğunda bekleyen VADELI_ODEME varsa kapat
        cur.execute("""
            UPDATE onay_kuyrugu SET durum='reddedildi'
            WHERE kaynak_id=%s AND islem_turu='VADELI_ODEME' AND durum='bekliyor'
        """, (vid,))

        if body.odeme_yontemi == 'kart':
            # KART: kart borcuna HARCAMA ekle — kasaya yazma yok
            hid = str(uuid.uuid4())
            cur.execute("""
                INSERT INTO kart_hareketleri
                    (id, kart_id, tarih, islem_turu, tutar, taksit_sayisi, aciklama, kaynak_id, kaynak_tablo)
                VALUES (%s, %s, %s, 'HARCAMA', %s, 1, %s, %s, 'vadeli_alimlar')
            """, (hid, body.kart_id, bugun, tutar, f"Vadeli alım: {v['aciklama']}", vid))
            audit(cur, 'kart_hareketleri', hid, 'VADELI_KART')
            kart_plan_guncelle_tx(cur)
            cur.execute("UPDATE odeme_plani SET durum='odendi', odeme_tarihi=%s, odenen_tutar=%s WHERE id=%s",
                (bugun, tutar, plan['id']))
            vadeli_alim_kapat(cur, vid, bugun)
            audit(cur, 'vadeli_alimlar', vid, 'ODENDI_KART')
            uyari_cache_clear()
            return {"success": True, "odeme_yontemi": "kart", "kart_id": body.kart_id}

        # NAKİT: doğrudan kasaya yaz — onay kuyruğuna girmez
        insert_kasa_hareketi(
            cur, bugun, 'VADELI_ODEME', -abs(tutar),
            f"Vadeli alım ödemesi: {v['aciklama']}",
            'vadeli_alimlar', vid,
            str(uuid.uuid4()), 'VADELI_ALIMLAR'
        )
        cur.execute("UPDATE odeme_plani SET durum='odendi', odeme_tarihi=%s, odenen_tutar=%s WHERE id=%s",
            (bugun, tutar, plan['id']))
        cur.execute("""
            UPDATE onay_kuyrugu SET durum='onaylandi', onay_tarihi=NOW()
            WHERE durum NOT IN ('onaylandi','reddedildi')
            AND (kaynak_id=%s OR kaynak_id=%s)
        """, (plan['id'], vid))
        vadeli_alim_kapat(cur, vid, bugun)
        audit(cur, 'vadeli_alimlar', vid, 'ODENDI_NAKIT')
        uyari_cache_clear()
    return {"success": True, "odeme_yontemi": "nakit"}

@app.post("/api/vadeli-alimlar/{vid}/kismi-ode")
def vadeli_kismi_ode(vid: str, body: KismiOdeModel):
    """
    Vadeli alım kısmi ödeme.
    Nakit: ödenen kısım kasadan düşer, kalan yeni plan olarak bekler.
    Kart: ödenen kısım kart harcamasına eklenir (kasaya yazılmaz), kalan yeni plan bekler.
    """
    with db() as (conn, cur):
        cur.execute("SELECT * FROM vadeli_alimlar WHERE id=%s AND durum='bekliyor'", (vid,))
        v = cur.fetchone()
        if not v: raise HTTPException(404, "Vadeli alım bulunamadı veya zaten ödendi")

        # KART seçildiyse validasyon
        if body.odeme_yontemi == 'kart':
            if not body.kart_id:
                raise HTTPException(400, "Kart seçimi zorunlu")
            cur.execute("SELECT * FROM kartlar WHERE id=%s AND aktif=TRUE FOR UPDATE", (body.kart_id,))
            kart = cur.fetchone()
            if not kart: raise HTTPException(404, "Kart bulunamadı")
            borc = kart_borc(cur, body.kart_id)
            kalan_limit = float(kart['limit_tutar']) - borc
            if kalan_limit < body.odenen_tutar:
                raise HTTPException(400, f"Kart limiti yetersiz. Kalan: {kalan_limit:,.0f} ₺")

        # Bağlı aktif odeme_plani'nı bul — yoksa zaten ödenmiş demektir
        cur.execute("""
            SELECT id, odenecek_tutar FROM odeme_plani
            WHERE kaynak_tablo='vadeli_alimlar' AND kaynak_id=%s
            AND durum IN ('bekliyor','onay_bekliyor')
            LIMIT 1
        """, (vid,))
        plan = cur.fetchone()
        if not plan:
            raise HTTPException(400, "Bu vadeli alım için aktif ödeme planı bulunamadı — zaten ödenmiş olabilir.")

    # kismi_odeme_yap — nakit/kart bilgisini body üzerinden taşır
    return kismi_odeme_yap(plan['id'], body)

# ── BORÇLAR ────────────────────────────────────────────────────
class BorcModel(BaseModel):
    kurum: str
    borc_turu: str = 'Kredi'
    toplam_borc: Optional[float] = None
    aylik_taksit: float
    kalan_vade: Optional[int] = None
    toplam_vade: Optional[int] = None
    baslangic_tarihi: Optional[date] = None
    odeme_gunu: int = 1

class SubeGuncelleModel(BaseModel):
    pos_oran: float = 0
    online_oran: float = 0
    acilis_saati: Optional[str] = None
    kapanis_saati: Optional[str] = None
    yogun_saat_baslangic: Optional[str] = None
    yogun_saat_bitis: Optional[str] = None
    ortusme_gerekli: bool = False
    vardiya_yazilsin: bool = True
    acilis_sadece_part: bool = False
    kapanis_sadece_part: bool = False
    min_personel: int = 1
    yogun_saat_ek_personel: int = 0
    # Aynı gün açılış slotuna yazılabilecek üst kişi sayısı (örn. Alsancak = 1); boş = sınır yok
    acilis_max_kisi: Optional[int] = None
    sube_tipi: Optional[str] = None


class KasaDuzeltModel(BaseModel):
    baslangic: date
    bitis: Optional[date] = None

@app.get("/api/borclar")
def borclar_listele():
    """
    Borç listesi + her kayıt için bu ay ödenip ödenmediği (bu_ay_odendi) ve
    son ödeme tarihi (son_odeme) bilgisi. Frontend bunlara göre "Öde / Ödendi"
    butonunu yönetir.
    """
    with db() as (conn, cur):
        cur.execute("SELECT * FROM borc_envanteri ORDER BY kurum")
        borclar = [dict(r) for r in cur.fetchall()]
        if not borclar:
            return []
        ids = [b['id'] for b in borclar]
        cur.execute(
            """
            SELECT kaynak_id,
                   MAX(tarih) AS son_odeme,
                   BOOL_OR(
                       EXTRACT(YEAR FROM tarih) = EXTRACT(YEAR FROM CURRENT_DATE)
                       AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
                   ) AS bu_ay_odendi
            FROM kasa_hareketleri
            WHERE kaynak_tablo='borc_envanteri'
              AND kaynak_id = ANY(%s)
              AND kasa_etkisi = TRUE
              AND tutar < 0
              AND durum='aktif'
            GROUP BY kaynak_id
            """,
            (ids,),
        )
        odeme_map = {str(r['kaynak_id']): r for r in cur.fetchall()}
        for b in borclar:
            rec = odeme_map.get(str(b['id'])) or {}
            b['bu_ay_odendi'] = bool(rec.get('bu_ay_odendi') or False)
            b['son_odeme']    = str(rec['son_odeme']) if rec.get('son_odeme') else None
        return borclar


class BorcOdemeBody(BaseModel):
    tutar: Optional[float] = None
    tarih: Optional[str] = None
    aciklama: Optional[str] = None


@app.post("/api/borclar/{bid}/ode")
def borc_ode(bid: str, body: BorcOdemeBody):
    """
    Manuel taksit ödemesi (nakit kasa düşümü):
    - Kasadan düşülür (islem_turu=BORC_TAKSIT, tutar negatif).
    - borc_envanteri: kalan_vade -= 1, toplam_borc -= ödenen (0'a kırpılır).
    - Aynı ay tekrar ödeme engellenir (idempotency + bu_ay_odendi kontrolü).
    - Frontend butonu "✓ Bu Ay Ödendi" olur.
    """
    with db() as (conn, cur):
        cur.execute("SELECT * FROM borc_envanteri WHERE id=%s FOR UPDATE", (bid,))
        borc = cur.fetchone()
        if not borc:
            raise HTTPException(404, "Borç bulunamadı")
        if not borc['aktif']:
            raise HTTPException(400, "Pasif borç için ödeme yapılamaz")
        kalan_vade = int(borc['kalan_vade'] or 0)
        if borc['kalan_vade'] is not None and kalan_vade <= 0:
            raise HTTPException(400, "Bu borç için kalan taksit yok")

        tutar = float(body.tutar) if body.tutar else float(borc['aylik_taksit'] or 0)
        if tutar <= 0:
            raise HTTPException(400, "Geçerli tutar girin")

        tarih = (body.tarih or date.today().isoformat())[:10]

        # ÇİFT ÖDEME KAPISI: bu ay manuel VEYA plan/onay yolundan ödenmiş mi?
        # Plan ödemesi kasaya kaynak_tablo='odeme_plani' (kaynak_id=plan_id) yazar; manuel
        # ise kaynak_tablo='borc_envanteri'. İkisini birlikte kontrol et — yoksa aynı taksit
        # iki yoldan ödenip kasadan iki kez düşer, kalan vade fazladan azalır.
        cur.execute(
            """
            SELECT 1 FROM kasa_hareketleri kh
            WHERE kh.islem_turu='BORC_TAKSIT' AND kh.kasa_etkisi=TRUE AND kh.durum='aktif'
              AND EXTRACT(YEAR FROM kh.tarih)  = EXTRACT(YEAR FROM %s::date)
              AND EXTRACT(MONTH FROM kh.tarih) = EXTRACT(MONTH FROM %s::date)
              AND (
                    (kh.kaynak_tablo='borc_envanteri' AND kh.kaynak_id=%s)
                 OR (kh.kaynak_tablo='odeme_plani' AND kh.kaynak_id IN (
                        SELECT id FROM odeme_plani
                        WHERE kaynak_tablo='borc_envanteri' AND kaynak_id=%s))
              )
            LIMIT 1
            """,
            (tarih, tarih, bid, bid),
        )
        if cur.fetchone():
            raise HTTPException(409, "Bu ay için zaten ödeme kaydı var (manuel veya plandan)")

        aciklama = (body.aciklama or f"{borc['kurum']} — {borc['borc_turu']} taksiti").strip()
        ref_id = str(uuid.uuid4())
        idem = f"borc-ode:{bid}:{tarih[:7]}"  # ay bazlı idempotent
        insert_kasa_hareketi(
            cur, tarih, 'BORC_TAKSIT', -abs(tutar), aciklama,
            'borc_envanteri', bid, ref_id, 'BORC_TAKSIT', idempotency_key=idem,
        )

        # Borç kaydını güncelle
        yeni_kalan = (kalan_vade - 1) if borc['kalan_vade'] is not None else None
        yeni_toplam = max(0.0, float(borc['toplam_borc'] or 0) - tutar)
        # Vade ile kapan; vade tanımsızsa (NULL) toplam borç sıfırlanınca kapan.
        kapansin = (yeni_kalan is not None and yeni_kalan <= 0) or (yeni_kalan is None and yeni_toplam <= 0)
        cur.execute(
            """
            UPDATE borc_envanteri
            SET kalan_vade=%s,
                toplam_borc=%s,
                aktif = CASE WHEN %s THEN FALSE ELSE aktif END
            WHERE id=%s
            """,
            (yeni_kalan, yeni_toplam, kapansin, bid),
        )
        audit(cur, 'borc_envanteri', bid, 'ODEME', eski=dict(borc))

        # Bu ay için bekleyen bir odeme_plani varsa kapat (çift ödemeyi önler)
        cur.execute(
            """
            UPDATE odeme_plani
            SET durum='odendi', odenen_tutar=%s, odeme_tarihi=%s
            WHERE kaynak_tablo='borc_envanteri' AND kaynak_id=%s
              AND durum IN ('bekliyor','onay_bekliyor')
              AND EXTRACT(YEAR FROM tarih)  = EXTRACT(YEAR FROM %s::date)
              AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM %s::date)
            """,
            (tutar, tarih, bid, tarih, tarih),
        )

        return {
            "success": True,
            "odenen":     tutar,
            "tarih":      tarih,
            "kalan_vade": yeni_kalan,
            "toplam_borc": yeni_toplam,
            "kapandi":    kapansin,
        }

def _borc_validate(b: BorcModel):
    """Borç ekle/güncelle ortak doğrulaması — negatif/tutarsız değerleri reddet."""
    if not (b.kurum or "").strip():
        raise HTTPException(400, "Kurum/alacaklı adı zorunlu")
    if b.aylik_taksit is None or float(b.aylik_taksit) <= 0:
        raise HTTPException(400, "Aylık taksit 0'dan büyük olmalı")
    if b.toplam_borc is not None and float(b.toplam_borc) < 0:
        raise HTTPException(400, "Toplam borç negatif olamaz")
    if not (1 <= int(b.odeme_gunu or 0) <= 31):
        raise HTTPException(400, "Ödeme günü 1–31 arası olmalı")
    if b.kalan_vade is not None and int(b.kalan_vade) < 0:
        raise HTTPException(400, "Kalan vade negatif olamaz")
    if b.toplam_vade is not None and int(b.toplam_vade) < 0:
        raise HTTPException(400, "Toplam vade negatif olamaz")
    if (b.kalan_vade is not None and b.toplam_vade is not None
            and int(b.kalan_vade) > int(b.toplam_vade)):
        raise HTTPException(400, "Kalan vade, toplam vadeden büyük olamaz")


@app.post("/api/borclar")
def borc_ekle(b: BorcModel):
    _borc_validate(b)
    with db() as (conn, cur):
        bid = str(uuid.uuid4())
        cur.execute("""INSERT INTO borc_envanteri (id,kurum,borc_turu,toplam_borc,aylik_taksit,kalan_vade,toplam_vade,baslangic_tarihi,odeme_gunu)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (bid, b.kurum, b.borc_turu, b.toplam_borc, b.aylik_taksit, b.kalan_vade, b.toplam_vade, b.baslangic_tarihi, b.odeme_gunu))
        audit(cur, 'borc_envanteri', bid, 'INSERT')
    return {"id": bid, "success": True}

@app.put("/api/borclar/{bid}")
def borc_guncelle(bid: str, b: BorcModel):
    _borc_validate(b)
    with db() as (conn, cur):
        cur.execute("SELECT * FROM borc_envanteri WHERE id=%s", (bid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)
        cur.execute("""UPDATE borc_envanteri SET kurum=%s,borc_turu=%s,toplam_borc=%s,aylik_taksit=%s,
            kalan_vade=%s,toplam_vade=%s,baslangic_tarihi=%s,odeme_gunu=%s WHERE id=%s""",
            (b.kurum, b.borc_turu, b.toplam_borc, b.aylik_taksit, b.kalan_vade, b.toplam_vade, b.baslangic_tarihi, b.odeme_gunu, bid))

        # Bekleyen ödeme planı senkronu — eski tutar/yetim plan kalmasın
        if b.kalan_vade is not None and int(b.kalan_vade) <= 0:
            # Borç bitti → bu giderin bekleyen planlarını + onaylarını iptal et
            cur.execute(
                """UPDATE odeme_plani SET durum='iptal'
                   WHERE kaynak_tablo='borc_envanteri' AND kaynak_id=%s
                     AND durum IN ('bekliyor','onay_bekliyor')""",
                (bid,),
            )
            cur.execute(
                """UPDATE onay_kuyrugu SET durum='reddedildi', onay_tarihi=NOW()
                   WHERE kaynak_tablo='odeme_plani' AND durum='bekliyor'
                     AND kaynak_id IN (SELECT id FROM odeme_plani
                                       WHERE kaynak_tablo='borc_envanteri' AND kaynak_id=%s)""",
                (bid,),
            )
        else:
            # Aktif borç → bekleyen planların tutarını yeni aylık taksite çek (eski tutarla ödenmesin)
            cur.execute(
                """UPDATE odeme_plani
                   SET odenecek_tutar=%s, asgari_tutar=%s
                   WHERE kaynak_tablo='borc_envanteri' AND kaynak_id=%s
                     AND durum IN ('bekliyor','onay_bekliyor')""",
                (b.aylik_taksit, b.aylik_taksit, bid),
            )
        audit(cur, 'borc_envanteri', bid, 'UPDATE', eski=eski)
    return {"success": True}


@app.get("/api/borclar/{bid}/gecmis")
def borc_gecmis(bid: str):
    """
    Bir borcun tüm ödeme geçmişi:
    - Ödenen taksitler (kasa_hareketleri)
    - Bekleyen / gelecek ödemeler (odeme_plani)
    - Özet: toplam ödenen, kalan, ilerleme
    """
    with db() as (conn, cur):
        cur.execute("SELECT * FROM borc_envanteri WHERE id=%s", (bid,))
        borc = cur.fetchone()
        if not borc: raise HTTPException(404, "Borç bulunamadı")

        # Ödenen taksitler — kasa_hareketleri
        cur.execute("""
            SELECT tarih, tutar, aciklama, islem_turu, durum
            FROM kasa_hareketleri
            WHERE kaynak_tablo = 'borc_envanteri'
            AND kaynak_id = %s AND kasa_etkisi = true
            AND tutar < 0
            ORDER BY tarih DESC
        """, (bid,))
        odenenler = [{
            "tarih":    str(r['tarih']),
            "tutar":    abs(float(r['tutar'])),
            "aciklama": r['aciklama'] or '',
            "durum":    "odendi",
        } for r in cur.fetchall()]

        # Bekleyen ödemeler — odeme_plani
        cur.execute("""
            SELECT id, tarih, odenecek_tutar, asgari_tutar, durum, aciklama
            FROM odeme_plani
            WHERE kaynak_tablo = 'borc_envanteri'
            AND kaynak_id = %s
            AND durum IN ('bekliyor', 'onay_bekliyor')
            ORDER BY tarih ASC
        """, (bid,))
        bekleyenler = [{
            "tarih":   str(r['tarih']),
            "tutar":   float(r['odenecek_tutar']),
            "aciklama": r['aciklama'] or '',
            "durum":   r['durum'],
            "plan_id": str(r['id']),
        } for r in cur.fetchall()]

        # Özet hesapla
        toplam_odenen   = sum(r['tutar'] for r in odenenler)
        toplam_beklenen = sum(r['tutar'] for r in bekleyenler)
        toplam_borc     = float(borc['toplam_borc'] or 0)
        aylik_taksit    = float(borc['aylik_taksit'] or 0)
        kalan_vade      = int(borc['kalan_vade'] or 0)
        toplam_vade     = int(borc['toplam_vade'] or 0)
        gecen_taksit    = max(0, toplam_vade - kalan_vade) if toplam_vade else len(odenenler)
        ilerleme_pct    = min(100, max(0, round(gecen_taksit / toplam_vade * 100))) if toplam_vade else 0

        return {
            "borc": {
                "id":              str(borc['id']),
                "kurum":           borc['kurum'],
                "borc_turu":       borc['borc_turu'],
                "toplam_borc":     toplam_borc,
                "aylik_taksit":    aylik_taksit,
                "kalan_vade":      kalan_vade,
                "toplam_vade":     toplam_vade,
                "baslangic":       str(borc['baslangic_tarihi']) if borc['baslangic_tarihi'] else None,
                "aktif":           borc['aktif'],
            },
            "ozet": {
                "toplam_odenen":   round(toplam_odenen, 2),
                "toplam_beklenen": round(toplam_beklenen, 2),
                "kalan_borc":      round(max(0, toplam_borc - toplam_odenen), 2),
                "gecen_taksit":    gecen_taksit,
                "kalan_taksit":    kalan_vade,
                "ilerleme_pct":    ilerleme_pct,
            },
            "odenenler":   odenenler,
            "bekleyenler": bekleyenler,
        }

@app.delete("/api/borclar/{bid}")
def borc_sil(bid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM borc_envanteri WHERE id=%s", (bid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)
        cur.execute("UPDATE borc_envanteri SET aktif=FALSE WHERE id=%s", (bid,))
        # Bağlı bekleyen planları iptal et — panelde görünmesin
        cur.execute("""
            UPDATE odeme_plani SET durum='iptal'
            WHERE kaynak_tablo='borc_envanteri' AND kaynak_id=%s
            AND durum IN ('bekliyor','onay_bekliyor')
        """, (bid,))
        cur.execute("""
            UPDATE onay_kuyrugu SET durum='reddedildi'
            WHERE kaynak_tablo='borc_envanteri' AND kaynak_id=%s
            AND durum='bekliyor'
        """, (bid,))
        audit(cur, 'borc_envanteri', bid, 'PASIF', eski=eski)
    return {"success": True}

# ── ŞUBELER ────────────────────────────────────────────────────
@app.get("/api/subeler")
def subeler():
    with db() as (conn, cur):
        cur.execute("SELECT * FROM subeler ORDER BY ad")
        return [dict(r) for r in cur.fetchall()]


def _sube_katalog_stok_garantile(cur, sube_id: str) -> int:
    """Verilen şube için tüm aktif siparis_urun kayıtlarına karşılık sube_depo_stok satırı ekler.
    Fiziksel havuz ürünleri (su_adet, bardak vb.) atlanır — onlar text-kodlu satırlarla izlenir.
    Mevcut satırları değiştirmez (ON CONFLICT DO NOTHING). Eklenen satır sayısını döner."""
    _HAVUZ = (
        'bardak_kucuk', 'bardak_buyuk', 'bardak_plastik', 'su_adet',
        'redbull_adet', 'soda_adet', 'cookie_adet', 'pasta_adet',
        'sut_litre', 'surup_adet', 'kahve_paket', 'karton_bardak',
        'kapak_adet', 'pecete_paket', 'diger_sarf',
    )
    cur.execute("""
        INSERT INTO sube_depo_stok (id, sube_id, kalem_kodu, kalem_adi, mevcut_adet)
        SELECT gen_random_uuid()::text, %s, su.id::text, su.ad, 0
        FROM siparis_urun su
        WHERE su.aktif = TRUE
          AND (su.depo_stok_kalem_kodu IS NULL
               OR su.depo_stok_kalem_kodu NOT IN %s)
        ON CONFLICT (sube_id, kalem_kodu) DO NOTHING
    """, (sube_id, _HAVUZ))
    return cur.rowcount


@app.post("/api/subeler")
def sube_olustur(body: dict):
    """Yeni şube oluştur. Zorunlu: id (text), ad (text). İsteğe bağlı: adres."""
    sid = (body.get("id") or "").strip()
    ad  = (body.get("ad") or "").strip()
    adres = (body.get("adres") or "").strip() or None
    if not sid or not ad:
        raise HTTPException(400, "id ve ad zorunludur")
    import re
    if not re.match(r'^[a-z0-9_-]+$', sid):
        raise HTTPException(400, "id yalnızca küçük harf, rakam, _ veya - içerebilir")
    with db() as (conn, cur):
        cur.execute("SELECT id FROM subeler WHERE id=%s", (sid,))
        if cur.fetchone():
            raise HTTPException(409, f"'{sid}' id'li şube zaten mevcut")
        cur.execute(
            "INSERT INTO subeler (id, ad, adres) VALUES (%s, %s, %s)",
            (sid, ad, adres),
        )
        # 1-to-1: yeni şube için tüm aktif katalog ürünlerinin stok satırını garantile
        eklenen = _sube_katalog_stok_garantile(cur, sid)
    return {"success": True, "sube_id": sid, "stok_satirlari_eklendi": eklenen}


@app.put("/api/subeler/{sid}")
def sube_guncelle(sid: str, body: SubeGuncelleModel):
    pos_oran = float(body.pos_oran)
    online_oran = float(body.online_oran)
    if not (0 <= pos_oran <= 100) or not (0 <= online_oran <= 100):
        raise HTTPException(400, "Oran 0-100 arasında olmalı")
    if body.min_personel < 1:
        raise HTTPException(400, "Minimum personel en az 1 olmalı")
    if body.yogun_saat_ek_personel < 0:
        raise HTTPException(400, "Yoğun saat ek personel 0 veya daha büyük olmalı")
    sube_tipi = (body.sube_tipi or "").strip().lower() or None
    if sube_tipi in ("sevkiyat",):
        sube_tipi = "depo"
    elif sube_tipi in ("merkez",):
        sube_tipi = "karma"
    if sube_tipi is not None and sube_tipi not in ("normal", "depo", "karma"):
        raise HTTPException(400, "sube_tipi: normal | depo | karma")
    with db() as (conn, cur):
        cur.execute("SELECT id FROM subeler WHERE id=%s", (sid,))
        if not cur.fetchone():
            raise HTTPException(404, "Şube bulunamadı")
        cur.execute(
            """
            UPDATE subeler
            SET pos_oran=%s,
                online_oran=%s,
                acilis_saati=%s,
                kapanis_saati=%s,
                yogun_saat_baslangic=%s,
                yogun_saat_bitis=%s,
                ortusme_gerekli=%s,
                vardiya_yazilsin=%s,
                acilis_sadece_part=%s,
                kapanis_sadece_part=%s,
                min_personel=%s,
                yogun_saat_ek_personel=%s,
                acilis_max_kisi=%s,
                sube_tipi=COALESCE(%s, sube_tipi)
            WHERE id=%s
            """,
            (
                pos_oran,
                online_oran,
                body.acilis_saati,
                body.kapanis_saati,
                body.yogun_saat_baslangic,
                body.yogun_saat_bitis,
                bool(body.ortusme_gerekli),
                bool(body.vardiya_yazilsin),
                bool(body.acilis_sadece_part),
                bool(body.kapanis_sadece_part),
                int(body.min_personel),
                int(body.yogun_saat_ek_personel),
                body.acilis_max_kisi,
                sube_tipi,
                sid,
            ),
        )
    # Vardiya planı açık şubelerde: mesai saatleri kaydedilince AUTO slotları güncelle
    # (Pzt–Paz tüm günler — gün matrisi `aktif_gunler` ile aynı hizada kalır)
    if bool(body.vardiya_yazilsin):
        try:
            with db() as (conn, cur):
                sonuc = _vv2.slotlari_sube_saatlerinden_uret(
                    cur,
                    sid,
                    mod="yenile",
                    acilis_dakika=60,
                    kapanis_dakika=60,
                    normal_slot_dakika=120,
                    hafta_ici=False,
                    aktif_gunler=None,
                )
            if not sonuc.get("basarili"):
                logging.warning(
                    "Şube %s güncellendi; AUTO slot yenilenemedi: %s",
                    sid,
                    sonuc.get("mesaj"),
                )
        except Exception:
            logging.exception("Şube %s güncellendi; AUTO slot yenileme hatası", sid)
    return {"success": True}

@app.get("/api/subeler/{sid}/kasa-onizle")
def kasa_onizle(sid: str, baslangic: date, bitis: date = None):
    """
    Seçilen tarih aralığındaki ciro kayıtları için kasa düzeltme önizlemesi.
    Düzeltme yapmaz — sadece etki hesaplar.
    """
    bitis = bitis or bugun_tr()
    with db() as (conn, cur):
        cur.execute("SELECT * FROM subeler WHERE id=%s", (sid,))
        sube = cur.fetchone()
        if not sube:
            raise HTTPException(404, "Şube bulunamadı")
        pos_oran = float(sube['pos_oran'] or 0)
        online_oran = float(sube['online_oran'] or 0)

        cur.execute("""
            SELECT c.id, c.tarih, c.nakit, c.pos, c.online, c.toplam,
                   kh.tutar as kasa_tutar, kh.id as kasa_id
            FROM ciro c
            JOIN kasa_hareketleri kh ON kh.ref_id = c.id
                AND kh.ref_type IN ('CIRO', 'CIRO_GUNCELLEME')
                AND kh.islem_turu = 'CIRO'
                AND kh.durum = 'aktif'
            WHERE c.sube_id = %s AND c.durum = 'aktif'
            AND c.tarih BETWEEN %s AND %s
            ORDER BY c.tarih
        """, (sid, baslangic, bitis))
        kayitlar = cur.fetchall()

        satirlar = []
        toplam_fark = 0
        for k in kayitlar:
            dogru_tutar = float(k['nakit']) + float(k['pos']) * (1 - pos_oran/100) + float(k['online']) * (1 - online_oran/100)
            mevcut_tutar = float(k['kasa_tutar'])
            fark = dogru_tutar - mevcut_tutar
            if abs(fark) > 0.01:
                satirlar.append({
                    "ciro_id": k['id'],
                    "tarih": str(k['tarih']),
                    "nakit": float(k['nakit']),
                    "pos": float(k['pos']),
                    "online": float(k['online']),
                    "mevcut_kasa": mevcut_tutar,
                    "dogru_kasa": dogru_tutar,
                    "fark": fark
                })
                toplam_fark += fark

        return {
            "sube_adi": sube['ad'],
            "pos_oran": pos_oran,
            "online_oran": online_oran,
            "baslangic": str(baslangic),
            "bitis": str(bitis),
            "etkilenen_kayit": len(satirlar),
            "toplam_fark": toplam_fark,
            "satirlar": satirlar
        }

@app.post("/api/subeler/{sid}/kasa-duzelt")
def kasa_duzelt(sid: str, body: KasaDuzeltModel):
    """
    Onaylanan tarih aralığındaki kasa kayıtlarını düzeltir.
    Her kayıt için: eski kasa kaydı iptal edilir + doğru tutarla yeni kayıt yazılır.
    """
    baslangic = body.baslangic
    bitis = body.bitis or bugun_tr()

    with db() as (conn, cur):
        cur.execute("SELECT * FROM subeler WHERE id=%s", (sid,))
        sube = cur.fetchone()
        if not sube:
            raise HTTPException(404, "Şube bulunamadı")
        pos_oran = float(sube['pos_oran'] or 0)
        online_oran = float(sube['online_oran'] or 0)

        cur.execute("""
            SELECT c.id as ciro_id, c.tarih, c.nakit, c.pos, c.online,
                   kh.id as kasa_id, kh.tutar as kasa_tutar
            FROM ciro c
            JOIN kasa_hareketleri kh ON kh.ref_id = c.id
                AND kh.ref_type IN ('CIRO', 'CIRO_GUNCELLEME')
                AND kh.islem_turu = 'CIRO'
                AND kh.durum = 'aktif'
            WHERE c.sube_id = %s AND c.durum = 'aktif'
            AND c.tarih BETWEEN %s AND %s
        """, (sid, baslangic, bitis))
        kayitlar = cur.fetchall()

        duzeltilen = 0
        toplam_fark = 0

        for k in kayitlar:
            pos_tutari = float(k['pos'])
            online_tutari = float(k['online'])
            dogru_tutar = float(k['nakit']) + pos_tutari * (1 - pos_oran/100) + online_tutari * (1 - online_oran/100)
            mevcut_tutar = float(k['kasa_tutar'])
            fark = dogru_tutar - mevcut_tutar

            if abs(fark) < 0.01:
                continue

            # 1) Eski POS_KESINTI / ONLINE_KESINTI kayıtlarını iptal et
            cur.execute("""
                UPDATE kasa_hareketleri SET durum='iptal'
                WHERE ref_id = %s AND islem_turu = 'POS_KESINTI' AND durum='aktif'
            """, (k['ciro_id'],))

            # 3) Eski CIRO kaydını direkt güncelle (unique constraint aşmak için)
            cur.execute("""
                UPDATE kasa_hareketleri
                SET tutar = %s,
                    aciklama = %s,
                    durum = 'aktif'
                WHERE id = %s
            """, (
                dogru_tutar,
                f'POS/Online kesinti düzeltmesi (pos:%{pos_oran}, online:%{online_oran})',
                k['kasa_id']
            ))

            # 4) Yeni POS_KESINTI kaydı yaz — paneldeki finansman maliyeti buradan hesaplanır
            pos_kesinti = pos_tutari * pos_oran / 100
            online_kesinti = online_tutari * online_oran / 100
            if pos_kesinti > 0.01:
                cur.execute("""
                    INSERT INTO kasa_hareketleri
                        (id, tarih, islem_turu, tutar, aciklama, kaynak_tablo, kaynak_id, ref_id, ref_type)
                    VALUES (%s, %s, 'POS_KESINTI', %s, %s, 'ciro', %s, %s, 'POS_KESINTI')
                """, (
                    str(uuid.uuid4()), k['tarih'], -pos_kesinti,
                    f'POS komisyon kesintisi (%{pos_oran})',
                    k['ciro_id'] + '_pos', k['ciro_id'] + '_pos'
                ))
            if online_kesinti > 0.01:
                cur.execute("""
                    INSERT INTO kasa_hareketleri
                        (id, tarih, islem_turu, tutar, aciklama, kaynak_tablo, kaynak_id, ref_id, ref_type)
                    VALUES (%s, %s, 'ONLINE_KESINTI', %s, %s, 'ciro', %s, %s, 'ONLINE_KESINTI')
                """, (
                    str(uuid.uuid4()), k['tarih'], -online_kesinti,
                    f'Online komisyon kesintisi (%{online_oran})',
                    k['ciro_id'] + '_online', k['ciro_id'] + '_online'
                ))

            audit(cur, 'kasa_hareketleri', k['kasa_id'], 'DUZELTME',
                  eski={'tutar': mevcut_tutar}, yeni={'tutar': dogru_tutar})

            duzeltilen += 1
            toplam_fark += fark

    return {"success": True, "duzeltilen": duzeltilen, "toplam_fark": toplam_fark}

# ── İŞLEM DEFTERİ (LEDGER) ─────────────────────────────────────
@app.get("/api/ledger")
def ledger(limit: int = 200, islem_turu: Optional[str] = None, ay: str = None):
    import re as _re_ay
    ay_v = (ay or "").strip()
    ay_aktif = bool(ay_v and ay_v.lower() != "hepsi" and _re_ay.match(r"^\d{4}-\d{2}$", ay_v))
    with db() as (conn, cur):
        sql = "SELECT * FROM kasa_hareketleri WHERE durum='aktif'"
        params: list = []
        if islem_turu:
            sql += " AND islem_turu=%s"
            params.append(islem_turu)
        if ay_aktif:
            sql += " AND to_char(tarih, 'YYYY-MM') = %s"
            params.append(ay_v)
        sql += " ORDER BY tarih DESC, olusturma DESC LIMIT %s"
        params.append(limit)
        cur.execute(sql, params)
        rows = [dict(r) for r in cur.fetchall()]

        # Ay verildiyse {rows, ozet} döner (kartlar aylık olsun); yoksa geriye uyum: düz dizi.
        if not ay_aktif:
            return rows
        cur.execute(
            """
            SELECT
                COALESCE(SUM(CASE WHEN tutar > 0 THEN tutar ELSE 0 END), 0)        AS toplam_gelir,
                COALESCE(SUM(CASE WHEN tutar < 0 THEN -tutar ELSE 0 END), 0)       AS toplam_gider,
                COALESCE(SUM(CASE WHEN islem_turu LIKE '%%IPTAL%%' THEN ABS(tutar) ELSE 0 END), 0) AS toplam_iptal
            FROM kasa_hareketleri
            WHERE durum='aktif' AND to_char(tarih, 'YYYY-MM') = %s
            """,
            (ay_v,),
        )
        oz = dict(cur.fetchone() or {})
        return {
            "rows": rows,
            "ozet": {
                "toplam_gelir": float(oz.get("toplam_gelir") or 0),
                "toplam_gider": float(oz.get("toplam_gider") or 0),
                "toplam_iptal": float(oz.get("toplam_iptal") or 0),
            },
        }

# ── EXCEL IMPORT ───────────────────────────────────────────────
from fastapi import UploadFile, File
import io

@app.post("/api/excel-import")
async def excel_import(dosya: UploadFile = File(...)):
    try:
        import openpyxl
        content = await dosya.read()
        wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True)
        
        detay = {}
        toplam = 0

        with db() as (conn, cur):
            for sheet_name in wb.sheetnames:
                ws = wb[sheet_name]
                rows = list(ws.iter_rows(values_only=True))
                if len(rows) < 2: continue
                
                headers = [str(h).strip().lower() if h else '' for h in rows[0]]
                eklenen = 0
                hata = 0
                atlanan = []
                satir_no = 1  # header=0, veri=1'den başlar

                for row in rows[1:]:
                    satir_no += 1
                    if all(v is None for v in row): continue
                    d = {headers[i]: row[i] for i in range(len(headers)) if i < len(row)}
                    
                    try:
                        # Tarih düzelt
                        def fix_date(v):
                            if v is None: return None
                            if hasattr(v, 'strftime'): return v.strftime('%Y-%m-%d')
                            return str(v)[:10]

                        sn = sheet_name.lower().strip()

                        if sn == 'ciro':
                            sube_id = 'sube-merkez'
                            cur.execute("SELECT id, COALESCE(pos_oran,0) as pos_oran, COALESCE(online_oran,0) as online_oran FROM subeler WHERE LOWER(ad)=LOWER(%s)", (str(d.get('sube','MERKEZ')),))
                            sube_row = cur.fetchone()
                            if sube_row:
                                sube_id     = sube_row['id']
                                pos_oran_x  = float(sube_row['pos_oran'])
                                online_oran_x = float(sube_row['online_oran'])
                            else:
                                cur.execute("SELECT COALESCE(pos_oran,0) as pos_oran, COALESCE(online_oran,0) as online_oran FROM subeler WHERE id='sube-merkez'")
                                merkez = cur.fetchone()
                                pos_oran_x    = float(merkez['pos_oran'])    if merkez else 0.0
                                online_oran_x = float(merkez['online_oran']) if merkez else 0.0
                            cid   = str(uuid.uuid4())
                            nakit = float(d.get('nakit')  or 0)
                            pos   = float(d.get('pos')    or 0)
                            online= float(d.get('online') or 0)
                            # Normal ciro girişiyle aynı prensip: komisyon düşülüp net kasaya
                            pos_kesinti_x    = pos    * pos_oran_x    / 100.0
                            online_kesinti_x = online * online_oran_x / 100.0
                            net_tutar_x = nakit + (pos - pos_kesinti_x) + (online - online_kesinti_x)
                            cur.execute("""INSERT INTO ciro (id,tarih,sube_id,nakit,pos,online,aciklama)
                                VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                                (cid, fix_date(d.get('tarih')), sube_id, nakit, pos, online, str(d.get('aciklama') or '')))
                            if cur.rowcount > 0:
                                insert_kasa_hareketi(cur, fix_date(d.get('tarih')), 'CIRO',
                                    net_tutar_x,
                                    f'Excel import (net) — pos:%{pos_oran_x} online:%{online_oran_x}',
                                    'ciro', cid, ref_id=cid, ref_type='CIRO')
                                eklenen += 1
                            else:
                                atlanan.append({"satir": satir_no, "sebep": "duplicate", "veri": f"{d.get('tarih')} / {d.get('sube','')}"})

                        elif sn == 'kartlar':
                            cur.execute("""INSERT INTO kartlar (id,kart_adi,banka,limit_tutar,kesim_gunu,son_odeme_gunu,faiz_orani)
                                VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (kart_adi) DO NOTHING""",
                                (str(uuid.uuid4()), str(d.get('kart_adi','')).upper(),
                                 str(d.get('banka','')), float(d.get('limit_tutar') or 0),
                                 int(d.get('kesim_gunu') or 15), int(d.get('son_odeme_gunu') or 25),
                                 float(d.get('faiz_orani') or 0)))
                            if cur.rowcount > 0:
                                eklenen += 1
                            else:
                                atlanan.append({"satir": satir_no, "sebep": "duplicate", "veri": str(d.get('kart_adi',''))})

                        elif sn == 'kart_hareketleri':
                            kart_adi = str(d.get('kart_adi','')).upper()
                            cur.execute("SELECT id FROM kartlar WHERE UPPER(kart_adi)=%s", (kart_adi,))
                            k = cur.fetchone()
                            if not k: continue
                            islem = str(d.get('islem_turu','HARCAMA')).upper()
                            hid = str(uuid.uuid4())
                            cur.execute("""INSERT INTO kart_hareketleri (id,kart_id,tarih,islem_turu,tutar,taksit_sayisi,aciklama)
                                VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                                (hid, k['id'], fix_date(d.get('tarih')),
                                 islem, float(d.get('tutar') or 0),
                                 int(d.get('taksit_sayisi') or 1), str(d.get('aciklama') or '')))
                            # HARCAMA kasayı etkilemez
                            # ODEME -> onay kuyruğuna girer (kasadan düşmesi onay gerektirir)
                            if islem == 'ODEME':
                                cur.execute("""INSERT INTO onay_kuyrugu (id,islem_turu,kaynak_tablo,kaynak_id,aciklama,tutar,tarih)
                                    VALUES (%s,'KART_ODEME','kart_hareketleri',%s,'Excel import kart ödemesi',%s,%s)""",
                                    (str(uuid.uuid4()), hid, float(d.get('tutar') or 0), fix_date(d.get('tarih'))))
                            eklenen += 1

                        elif sn == 'borclar':
                            cur.execute("""INSERT INTO borc_envanteri (id,kurum,borc_turu,toplam_borc,aylik_taksit,kalan_vade,odeme_gunu)
                                VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                                (str(uuid.uuid4()), str(d.get('kurum','')),
                                 str(d.get('borc_turu','Kredi')),
                                 float(d.get('toplam_borc') or 0),
                                 float(d.get('aylik_taksit') or 0),
                                 int(d.get('kalan_vade') or 0),
                                 int(d.get('odeme_gunu') or 1)))
                            eklenen += 1

                        elif sn == 'personel':
                            sube_id = None
                            cur.execute("SELECT id FROM subeler WHERE LOWER(ad)=LOWER(%s)", (str(d.get('sube','MERKEZ')),))
                            r = cur.fetchone()
                            if r: sube_id = r['id']
                            cur.execute("""INSERT INTO personel (id,ad_soyad,gorev,calisma_turu,maas,yemek_ucreti,yol_ucreti,odeme_gunu,sube_id)
                                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                                (str(uuid.uuid4()), str(d.get('ad_soyad','')),
                                 str(d.get('gorev') or ''),
                                 str(d.get('calisma_turu','surekli')),
                                 float(d.get('maas') or 0),
                                 float(d.get('yemek_ucreti') or 0),
                                 float(d.get('yol_ucreti') or 0),
                                 int(d.get('odeme_gunu') or 28), sube_id))
                            eklenen += 1

                        elif sn == 'sabit_giderler':
                            sube_id = None
                            cur.execute("SELECT id FROM subeler WHERE LOWER(ad)=LOWER(%s)", (str(d.get('sube','MERKEZ')),))
                            r = cur.fetchone()
                            if r: sube_id = r['id']
                            cur.execute("""INSERT INTO sabit_giderler (id,gider_adi,kategori,tutar,tip,periyot,odeme_gunu,sube_id,odeme_yontemi)
                                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'nakit')""",
                                (str(uuid.uuid4()), str(d.get('gider_adi','')),
                                 str(d.get('kategori','Diğer')),
                                 float(d.get('tutar') or 0),
                                 str(d.get('tip','sabit')),
                                 str(d.get('periyot','aylik')),
                                 int(d.get('odeme_gunu') or 1), sube_id))
                            eklenen += 1

                        elif sn == 'vadeli_alimlar':
                            cur.execute("""INSERT INTO vadeli_alimlar (id,aciklama,tutar,vade_tarihi,tedarikci)
                                VALUES (%s,%s,%s,%s,%s)""",
                                (str(uuid.uuid4()), str(d.get('aciklama','')),
                                 float(d.get('tutar') or 0),
                                 fix_date(d.get('vade_tarihi')),
                                 str(d.get('tedarikci') or '')))
                            eklenen += 1

                    except Exception as ex:
                        hata += 1
                        atlanan.append({"satir": satir_no, "sebep": str(ex)[:100], "veri": str(list(d.values())[:3])})

                if eklenen > 0 or hata > 0 or atlanan:
                    detay[sheet_name] = {'eklenen': eklenen, 'hata': hata, 'atlanan': atlanan}
                    toplam += eklenen

        return {"success": True, "toplam": toplam, "detay": detay}
    except ImportError:
        raise HTTPException(500, "openpyxl kurulu değil")
    except Exception as e:
        raise HTTPException(500, str(e))


# ── ÇIFT KAYIT KONTROL ENDPOINTLERİ ───────────────────────────

@app.get("/api/ciro/kontrol")
def ciro_kontrol(tarih: str, tutar: float, sube_id: str = None):
    with db() as (conn, cur):
        cur.execute("""
            SELECT id, tarih, nakit+pos+online as toplam, sube_id FROM ciro
            WHERE durum='aktif'
            AND tarih = %s
            AND ABS((nakit+pos+online) - %s) < 1
            AND (%s IS NULL OR sube_id = %s)
        """, (tarih, tutar, sube_id, sube_id))
        benzer = [dict(r) for r in cur.fetchall()]
        return {"benzer": benzer, "var": len(benzer) > 0}

@app.get("/api/anlik-gider/kontrol")
def anlik_gider_kontrol(tarih: str, tutar: float, kategori: str = None):
    with db() as (conn, cur):
        cur.execute("""
            SELECT id, tarih, tutar, kategori FROM anlik_giderler
            WHERE durum='aktif'
            AND tarih BETWEEN %s::date - INTERVAL '7 days' AND %s::date + INTERVAL '7 days'
            AND ABS(tutar - %s) < 1
            AND (%s IS NULL OR kategori = %s)
        """, (tarih, tarih, tutar, kategori, kategori))
        benzer = [dict(r) for r in cur.fetchall()]
        return {"benzer": benzer, "var": len(benzer) > 0}

@app.get("/api/dis-kaynak/kontrol")
def dis_kaynak_kontrol(tarih: str, tutar: float, kategori: str = None):
    with db() as (conn, cur):
        cur.execute("""
            SELECT id, tarih, tutar, aciklama FROM kasa_hareketleri
            WHERE islem_turu='DIS_KAYNAK' AND durum='aktif'
            AND tarih BETWEEN %s::date - INTERVAL '7 days' AND %s::date + INTERVAL '7 days'
            AND ABS(tutar - %s) < 1
            AND (%s IS NULL OR aciklama LIKE %s)
        """, (tarih, tarih, tutar, kategori, f"{kategori}%"))
        benzer = [dict(r) for r in cur.fetchall()]
        return {"benzer": benzer, "var": len(benzer) > 0}

@app.get("/api/vadeli-panel-detay")
def vadeli_panel_detay():
    """
    Panel Vadeli Borç kartına tıklanınca açılan detay.
    SADECE kaynak_id ile çalışır — aciklama eşleşmesi yok, risk yok.
    """
    with db() as (conn, cur):
        yil = bugun_tr().year
        ay = bugun_tr().month

        # Bu ay ödeme yapılan vadeli alımlar — SADECE kaynak_id ile
        cur.execute("""
            SELECT DISTINCT
                va.id, va.aciklama, va.tutar, va.vade_tarihi,
                va.tedarikci, va.durum,
                (va.vade_tarihi - CURRENT_DATE) as gun_kaldi
            FROM vadeli_alimlar va
            WHERE (
                EXISTS (
                    SELECT 1 FROM kasa_hareketleri kh
                    WHERE kh.kaynak_id = va.id::text
                    AND kh.islem_turu = 'VADELI_ODEME'
                    AND kh.kasa_etkisi = true AND kh.durum = 'aktif'
                    AND EXTRACT(YEAR FROM kh.tarih) = %s
                    AND EXTRACT(MONTH FROM kh.tarih) = %s
                )
                OR EXISTS (
                    SELECT 1 FROM kart_hareketleri kh
                    WHERE kh.kaynak_id = va.id::text
                    AND kh.kaynak_tablo = 'vadeli_alimlar'
                    AND kh.islem_turu = 'HARCAMA' AND kh.durum = 'aktif'
                    AND EXTRACT(YEAR FROM kh.tarih) = %s
                    AND EXTRACT(MONTH FROM kh.tarih) = %s
                )
            )
            ORDER BY va.vade_tarihi DESC
        """, (yil, ay, yil, ay))
        vadeli_liste = cur.fetchall()

        sonuc = []
        for v in vadeli_liste:
            vid = str(v['id'])

            # Nakit ödemeler — kaynak_id ile
            cur.execute("""
                SELECT ABS(kh.tutar) as tutar, kh.tarih,
                    'nakit' as yontem, kh.aciklama,
                    NULL as banka, NULL as kart_adi
                FROM kasa_hareketleri kh
                WHERE kh.kaynak_id = %s
                AND kh.islem_turu = 'VADELI_ODEME'
                AND kh.kasa_etkisi = true AND kh.durum = 'aktif'
                AND EXTRACT(YEAR FROM kh.tarih) = %s
                AND EXTRACT(MONTH FROM kh.tarih) = %s
                ORDER BY kh.tarih DESC
            """, (vid, yil, ay))
            odemeler = [dict(r) for r in cur.fetchall()]

            # Kart ödemeleri — SADECE kaynak_id ile
            cur.execute("""
                SELECT kh.tutar, kh.tarih, 'kart' as yontem,
                    kh.aciklama, k.banka, k.kart_adi
                FROM kart_hareketleri kh
                JOIN kartlar k ON k.id = kh.kart_id
                WHERE kh.kaynak_id = %s
                AND kh.kaynak_tablo = 'vadeli_alimlar'
                AND kh.islem_turu = 'HARCAMA' AND kh.durum = 'aktif'
                AND EXTRACT(YEAR FROM kh.tarih) = %s
                AND EXTRACT(MONTH FROM kh.tarih) = %s
                ORDER BY kh.tarih DESC
            """, (vid, yil, ay))
            odemeler += [dict(r) for r in cur.fetchall()]

            nakit_toplam = sum(float(o['tutar']) for o in odemeler if o['yontem'] == 'nakit')
            kart_toplam  = sum(float(o['tutar']) for o in odemeler if o['yontem'] == 'kart')

            sonuc.append({
                'id': vid,
                'aciklama': v['aciklama'],
                'tutar': float(v['tutar']),
                'vade_tarihi': str(v['vade_tarihi']),
                'tedarikci': v['tedarikci'],
                'durum': v['durum'],
                'gun_kaldi': int(v['gun_kaldi']) if v['gun_kaldi'] is not None else None,
                'nakit_odenen': nakit_toplam,
                'kart_odenen': kart_toplam,
                'toplam_odenen': nakit_toplam + kart_toplam,
                'odemeler': odemeler,
            })

        return sonuc

@app.get("/api/vadeli-odeme-detay")
def vadeli_odeme_detay(kaynak: str = 'kart'):
    """
    Panel kart kırılımı detay — 💳 Kart tıklanınca açılır.
    kaynak='kart' → bu ay kartla yapılan vadeli ödemeleri listeler.
    kaynak='nakit' → bu ay nakitle yapılan vadeli ödemeleri listeler.
    """
    with db() as (conn, cur):
        bugun = bugun_tr()
        yil, ay = bugun.year, bugun.month

        if kaynak == 'kart':
            cur.execute("""
                SELECT
                    kh.tarih,
                    kh.tutar,
                    kh.aciklama,
                    k.banka,
                    k.kart_adi
                FROM kart_hareketleri kh
                JOIN kartlar k ON k.id = kh.kart_id
                WHERE kh.islem_turu = 'HARCAMA'
                AND kh.durum = 'aktif'
                AND kh.kaynak_tablo = 'vadeli_alimlar'
                AND EXTRACT(YEAR FROM kh.tarih) = %s
                AND EXTRACT(MONTH FROM kh.tarih) = %s
                ORDER BY kh.tarih DESC
            """, (yil, ay))
        else:
            cur.execute("""
                SELECT
                    kh.tarih,
                    ABS(kh.tutar) as tutar,
                    kh.aciklama,
                    NULL as banka,
                    NULL as kart_adi
                FROM kasa_hareketleri kh
                WHERE kh.islem_turu = 'VADELI_ODEME'
                AND kh.kasa_etkisi = true
                AND kh.durum = 'aktif'
                AND EXTRACT(YEAR FROM kh.tarih) = %s
                AND EXTRACT(MONTH FROM kh.tarih) = %s
                ORDER BY kh.tarih DESC
            """, (yil, ay))

        return [dict(r) for r in cur.fetchall()]

@app.get("/api/vadeli-alimlar/ozet")
def vadeli_ozet():
    """Vadeli alımlar özet — Panel kartı için. Nakit + kart dahil."""
    with db() as (conn, cur):
        # Bu ay nakit ödenen (kasa_hareketleri)
        cur.execute("""
            SELECT COALESCE(SUM(ABS(kh.tutar)), 0) as nakit
            FROM kasa_hareketleri kh
            WHERE kh.islem_turu = 'VADELI_ODEME'
            AND kh.kasa_etkisi = true AND kh.durum = 'aktif'
            AND EXTRACT(YEAR FROM kh.tarih) = EXTRACT(YEAR FROM CURRENT_DATE)
            AND EXTRACT(MONTH FROM kh.tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
        """)
        nakit_odenen = float(cur.fetchone()['nakit'])

        # Bu ay kartla ödenen (kart_hareketleri — tam ve kısmi)
        cur.execute("""
            SELECT COALESCE(SUM(kh.tutar), 0) as kart
            FROM kart_hareketleri kh
            WHERE kh.islem_turu = 'HARCAMA' AND kh.durum = 'aktif'
            AND kh.kaynak_tablo = 'vadeli_alimlar'
            AND EXTRACT(YEAR FROM kh.tarih) = EXTRACT(YEAR FROM CURRENT_DATE)
            AND EXTRACT(MONTH FROM kh.tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
        """)
        kart_odenen = float(cur.fetchone()['kart'])

        toplam_odenen = nakit_odenen + kart_odenen

        # Bekleyen vadeli alımlar
        cur.execute("""
            SELECT COALESCE(SUM(tutar), 0) as toplam_bekleyen, COUNT(*) as adet
            FROM vadeli_alimlar WHERE durum = 'bekliyor'
        """)
        row = cur.fetchone()
        toplam_bekleyen = float(row['toplam_bekleyen'])
        bekleyen_adet = int(row['adet'])

        # Geciken vadeli alımlar (sistem başlangıcı: Haziran öncesi sayılmaz)
        cur.execute("""
            SELECT COUNT(*) as adet FROM vadeli_alimlar
            WHERE durum = 'bekliyor' AND vade_tarihi < CURRENT_DATE
              AND vade_tarihi >= DATE '2026-06-01'
        """)
        geciken_adet = int(cur.fetchone()['adet'])

        return {
            "toplam_odenen": toplam_odenen,
            "toplam_bekleyen": toplam_bekleyen,
            "bekleyen_adet": bekleyen_adet,
            "geciken_adet": geciken_adet
        }

@app.get("/api/vadeli-alimlar/kontrol")
def vadeli_kontrol(vade_tarihi: str, tutar: float):
    with db() as (conn, cur):
        cur.execute("""
            SELECT id, aciklama, tutar, vade_tarihi FROM vadeli_alimlar
            WHERE durum='bekliyor'
            AND vade_tarihi BETWEEN %s::date - INTERVAL '7 days' AND %s::date + INTERVAL '7 days'
            AND ABS(tutar - %s) < 1
        """, (vade_tarihi, vade_tarihi, tutar))
        benzer = [dict(r) for r in cur.fetchall()]
        return {"benzer": benzer, "var": len(benzer) > 0}


@app.post("/api/odeme-plani/{oid}/odendi")
def odeme_odendi(oid: str, manuel_tutar: Optional[float] = None):
    """Geriye dönük uyumluluk — /ode endpoint'ine yönlendirir."""
    return odeme_yap(oid, tutar=manuel_tutar)


@app.post("/api/odeme-plani/{oid}/ertele")
def odeme_ertele(oid: str, yeni_tarih: Optional[date] = None):
    """Ödemeyi ertele — sadece tarih güncellenir, yeni kayıt açılmaz."""
    with db() as (conn, cur):
        cur.execute(
            "SELECT * FROM odeme_plani WHERE id=%s AND durum IN ('bekliyor','onay_bekliyor')",
            (oid,),
        )
        o = cur.fetchone()
        if not o: raise HTTPException(404)
        mevcut = o["tarih"]
        yeni = yeni_tarih or (mevcut + timedelta(days=4))

        # Aynı gün / geçmişe erteleme engeli
        diffGun = (yeni - mevcut).days
        if diffGun <= 0:
            raise HTTPException(400, "Aynı güne veya geçmişe erteleme yapılamaz")

        # 1 haftaya kadar erteleme: sistem otomatik olarak +4 gün yapar
        if diffGun <= 7:
            yeni = mevcut + timedelta(days=4)
        # Ödeme planı tarihini güncelle
        cur.execute("UPDATE odeme_plani SET tarih=%s WHERE id=%s", (yeni, oid))
        # Onay kuyruğundaki tarihi de güncelle — yeni kayıt açma
        cur.execute("""
            UPDATE onay_kuyrugu SET tarih=%s
            WHERE durum='bekliyor'
            AND (kaynak_id=%s OR kaynak_id=(SELECT kaynak_id FROM odeme_plani WHERE id=%s LIMIT 1))
        """, (yeni, oid, oid))
        audit(cur, 'odeme_plani', oid, 'ERTELE')
        # Uyarı önbelleğini temizle — erteleme sonrası uyarı gizlensin
        uyari_cache_clear()
    return {"success": True, "yeni_tarih": str(yeni)}


@app.post("/api/odeme-plani/{oid}/kismi-ode")
def kismi_odeme_yap(oid: str, body: KismiOdeModel):
    """
    Kısmi ödeme — plan bölünür:
    1. Ödenen kısım: nakitte kasadan (VADELI_ODEME), kartta kart harcamasına yazılır.
    2. vadeli_alimlar.tutar = kalan borç; yeni vade ile tek satırda devam eder.
    3. Kalan için yeni odeme_plani + gerekirse VADELI_ODEME onayı.
    Sonradan yeni mal için ayrı satır yerine POST /vadeli-alimlar + birlestir_vadeli_id ile toplam borç artırılabilir.
    """
    with db() as (conn, cur):
        # FOR UPDATE: eş zamanlı çift kısmi ödeme isteğini engeller
        cur.execute("SELECT * FROM odeme_plani WHERE id=%s AND durum IN ('bekliyor','onay_bekliyor') FOR UPDATE", (oid,))
        plan = cur.fetchone()
        if not plan: raise HTTPException(404, "Plan bulunamadı veya zaten ödendi")

        # FAZ 0 #3: personel maaşı onaysız (kısmi de olsa) ödenemez
        _personel_maas_odeme_guard(cur, dict(plan))

        toplam = float(plan['odenecek_tutar'])
        odenen = body.odenen_tutar
        kalan  = toplam - odenen

        if odenen <= 0:
            raise HTTPException(400, "Ödenen tutar sıfırdan büyük olmalı")
        if odenen >= toplam:
            raise HTTPException(400, "Tam ödeme için normal ödeme ekranını kullanın")
        if kalan <= 0:
            raise HTTPException(400, "Kalan tutar hesaplanamadı")

        bugun = str(bugun_tr())

        # Kart kesim ödemesi (kaynak_tablo boş + kart_id dolu) ise plan kapanmaz —
        # kullanıcı asgari tutara ulaşana kadar panel hatırlatıcısı devam eder.
        is_kart_plan = (not plan.get('kaynak_tablo')) and plan.get('kart_id')

        if is_kart_plan:
            # Birikimli ödenen: eski odenen_tutar + bu ödeme
            mevcut_odenen = float(plan.get('odenen_tutar') or 0)
            yeni_total_odenen = mevcut_odenen + odenen
            asgari = float(plan.get('asgari_tutar') or 0)
            # Asgari karşılandıysa plan kapanır; değilse bekliyor kalır (uyarı devam eder).
            asgari_tamam = (asgari > 0 and yeni_total_odenen >= asgari * 0.999)
            if asgari_tamam:
                cur.execute(
                    "UPDATE odeme_plani SET durum='odendi', odeme_tarihi=%s, odenen_tutar=%s WHERE id=%s",
                    (bugun, yeni_total_odenen, oid)
                )
            else:
                cur.execute(
                    "UPDATE odeme_plani SET odenen_tutar=%s WHERE id=%s",
                    (yeni_total_odenen, oid)
                )
        else:
            # Diğer kaynaklar (sabit_gider, personel, vadeli, borc_envanteri) — eski davranış:
            # Eski planı odendi yap, kalan için ayrı plan oluşturulur.
            cur.execute("UPDATE odeme_plani SET durum='odendi', odeme_tarihi=%s, odenen_tutar=%s WHERE id=%s",
                (bugun, odenen, oid))

        # Eski plana ait TUM acik onaylari kapat
        # Hem plan_id hem de kaynağın id'si (sabit_gider, personel vb.) ile ara
        _kaynak_id = plan.get('kaynak_id') or oid
        cur.execute("""
            UPDATE onay_kuyrugu SET durum='onaylandi', onay_tarihi=NOW()
            WHERE durum NOT IN ('onaylandi','reddedildi')
            AND (kaynak_id=%s OR kaynak_id=%s)
        """, (oid, _kaynak_id))

        # 2. Kasaya sadece ödenen kadar yaz (nakit) VEYA kart harcamasına ekle (kart)
        kaynak = plan.get('kaynak_tablo') or ''
        if kaynak == 'sabit_giderler':
            islem_t = 'SABIT_GIDER'
        elif kaynak == 'personel':
            islem_t = 'PERSONEL_MAAS'
        elif kaynak == 'vadeli_alimlar':
            islem_t = 'VADELI_ODEME'
        elif kaynak == 'borc_envanteri':
            islem_t = 'BORC_TAKSIT'
        else:
            islem_t = 'KART_ODEME'

        if kaynak == 'vadeli_alimlar' and getattr(body, 'odeme_yontemi', 'nakit') == 'kart' and getattr(body, 'kart_id', None):
            # KART: kasaya yazma — kart harcamasına ekle
            hid = str(uuid.uuid4())
            cur.execute("""
                INSERT INTO kart_hareketleri
                    (id, kart_id, tarih, islem_turu, tutar, taksit_sayisi, aciklama, kaynak_id, kaynak_tablo)
                VALUES (%s, %s, %s, 'HARCAMA', %s, 1, %s, %s, 'vadeli_alimlar')
            """, (hid, body.kart_id, bugun, odenen,
                  f"Kısmi vadeli alım: {plan['aciklama']} ({int(odenen):,} / {int(toplam):,} ₺)",
                  plan.get('kaynak_id')))
            audit(cur, 'kart_hareketleri', hid, 'VADELI_KART_KISMI')
        else:
            # NAKİT: kasaya yaz — vadeli için kaynak vadeli_alimlar (tam ödeme / onay guard ile aynı anahtar)
            kasa_kt = (
                "vadeli_alimlar"
                if kaynak == "vadeli_alimlar" and plan.get("kaynak_id")
                else "odeme_plani"
            )
            kasa_kid = (
                plan["kaynak_id"]
                if kasa_kt == "vadeli_alimlar"
                else oid
            )
            insert_kasa_hareketi(
                cur,
                bugun,
                islem_t,
                -abs(odenen),
                f"Kısmi ödeme: {plan['aciklama']} ({int(odenen):,} / {int(toplam):,} ₺)",
                kasa_kt,
                kasa_kid,
                oid,
                "KISMI_ODE",
            )

        # Kaynak vadeli_alimlar ise tutarı ve vadeyi güncelle (kapatma — kalan borç devam ediyor)
        if kaynak == 'vadeli_alimlar' and plan.get('kaynak_id'):
            cur.execute("""
                UPDATE vadeli_alimlar SET tutar=%s, vade_tarihi=%s WHERE id=%s
            """, (kalan, body.kalan_vade_tarihi, plan['kaynak_id']))
            # Eski onay kuyruğundaki bekleyen VADELI_ODEME kayıtlarını kapat — yenisi açılacak
            cur.execute("""
                UPDATE onay_kuyrugu SET durum='reddedildi', onay_tarihi=NOW()
                WHERE kaynak_tablo='vadeli_alimlar' AND kaynak_id=%s
                AND islem_turu='VADELI_ODEME' AND durum='bekliyor'
            """, (plan['kaynak_id'],))

        # Kaynak borc_envanteri ise: toplam_borc'u ÖDENEN kadar düş. Kısmi ödeme TAM taksit
        # sayılmaz → kalan_vade düşürülmez (kalan için aşağıda yeni plan açılıyor). Önceden bu
        # güncelleme hiç yapılmıyordu → kasadan para çıkıp borç hep yüksek görünüyordu.
        if kaynak == 'borc_envanteri' and plan.get('kaynak_id') and odenen > 0:
            cur.execute(
                """
                UPDATE borc_envanteri
                SET toplam_borc = GREATEST(0, COALESCE(toplam_borc, 0) - %s)
                WHERE id=%s
                """,
                (odenen, plan['kaynak_id']),
            )

        # 3. Kalan için yeni plan oluştur
        # referans_ay: yeni vade tarihinin ayı — eski planın ay'ını kopyalama, motor o ayı tekrar üretmesin diye
        # NOT: Kart kesim ödemesinde yeni plan oluşturulmaz — mevcut plan aynı ayın asgarisi için
        # panelde 'bekliyor' olarak kalır (asgari-ödenen farkı uyarı olarak görünür).
        yeni_id = None
        if not is_kart_plan:
            yeni_referans_ay = str(body.kalan_vade_tarihi)  # DATE_TRUNC('month') DB'de yapılır
            yeni_id = str(uuid.uuid4())
            cur.execute("""
                INSERT INTO odeme_plani
                    (id, kart_id, tarih, referans_ay, odenecek_tutar, asgari_tutar, aciklama, durum, kaynak_tablo, kaynak_id)
                VALUES (%s, %s, %s, DATE_TRUNC('month', %s::date), %s, %s, %s, 'bekliyor', %s, %s)
            """, (
                yeni_id,
                plan.get('kart_id'),
                str(body.kalan_vade_tarihi),
                str(body.kalan_vade_tarihi),
                kalan, kalan,
                f"{plan['aciklama']} (kalan)",
                plan.get('kaynak_tablo'),
                plan.get('kaynak_id')
            ))

        # Nakit kısmi ödeme kart_id'li planda ise kart borcunu düşür
        if plan.get('kart_id') and odenen > 0 and not (
            kaynak == 'vadeli_alimlar'
            and getattr(body, 'odeme_yontemi', 'nakit') == 'kart'
        ):
            cur.execute("""
                INSERT INTO kart_hareketleri
                    (id, kart_id, tarih, islem_turu, tutar, aciklama, kaynak_id, kaynak_tablo)
                VALUES (%s, %s, %s, 'ODEME', %s, %s, %s, 'odeme_plani')
                ON CONFLICT DO NOTHING
            """, (
                f"kodm_{oid}",
                plan['kart_id'],
                bugun,
                abs(odenen),
                f"Kısmi ödeme: {plan.get('aciklama', '')}",
                oid,
            ))

        # Vadeli alımlar kalanı odeme_plani'nda 'bekliyor' olarak bırakılır — onay kuyruğuna girmez.
        # Kart kesim ödemesinde zaten yeni plan oluşmadığı için onay da yok.
        # Diğer kaynak türleri (sabit_giderler, personel vb.) onay akışını kullanmaya devam eder.
        if yeni_id and kaynak != 'vadeli_alimlar':
            onay_ekle(cur, 'ODEME_PLANI', 'odeme_plani', yeni_id,
                f"Kısmi ödeme kalanı: {plan['aciklama']} ({int(kalan):,} ₺)",
                kalan, body.kalan_vade_tarihi)

        audit(cur, 'odeme_plani', oid, 'KISMI_ODE',
              eski={'tutar': toplam}, yeni={'odenen': odenen, 'kalan': kalan, 'yeni_plan': yeni_id})

        # Uyarı önbelleğini temizle — kısmi ödeme sonrası uyarı güncellensin
        uyari_cache_clear()

    return {"success": True, "odenen": odenen, "kalan": kalan, "yeni_plan_id": yeni_id}

@app.get("/api/kasa-detay")
def kasa_detay_endpoint():
    """Kasa'yı işlem türü bazında gösterir — her türün ne kadar etki yaptığını döker."""
    try:
        return kasa_detay()
    except Exception as e:
        raise HTTPException(500, str(e))

# ── FAİZ SİSTEMİ (TEK ENTRY POINT) ────────────────────────────
# Doküman: faiz otomatik çalışır, manuel giriş yoktur.
# Tüm faiz hesabı finans_core.faiz_hesapla_ve_yaz üzerinden geçer.
# Eski 5 endpoint → 1 endpoint.

@app.get("/api/kart-faiz")
def kart_faiz_listele(kart_id: str = None):
    """Kart bazlı faiz geçmişi."""
    with db() as (conn, cur):
        if kart_id:
            cur.execute("""
                SELECT kh.*, k.kart_adi, k.banka
                FROM kart_hareketleri kh
                JOIN kartlar k ON k.id = kh.kart_id
                WHERE kh.kart_id = %s AND kh.islem_turu = 'FAIZ'
                AND kh.durum = 'aktif'
                ORDER BY kh.tarih DESC
            """, (kart_id,))
        else:
            cur.execute("""
                SELECT kh.*, k.kart_adi, k.banka
                FROM kart_hareketleri kh
                JOIN kartlar k ON k.id = kh.kart_id
                WHERE kh.islem_turu = 'FAIZ' AND kh.durum = 'aktif'
                ORDER BY kh.tarih DESC
            """)
        return [dict(r) for r in cur.fetchall()]

@app.post("/api/kartlar/faiz-uret")
def faiz_uret(body: dict = {}):
    """
    Faiz hesapla ve yaz — tek entry point.
    body: { kart_id: str (opsiyonel), donem: 'YYYY-MM' (opsiyonel) }
    kart_id verilmezse tüm aktif kartlar işlenir.
    donem verilmezse bu ay işlenir.
    """
    kart_id = body.get('kart_id')
    donem   = body.get('donem')
    try:
        with db() as (conn, cur):
            if kart_id:
                sonuc = faiz_hesapla_ve_yaz(cur, kart_id, donem)
                audit(cur, 'kart_hareketleri',
                      sonuc.get('id', kart_id), 'FAIZ_OTOMATIK')
                return sonuc
            else:
                sonuclar = tum_kartlar_faiz_hesapla(cur, donem)
                for s in sonuclar:
                    if s.get('id'):
                        audit(cur, 'kart_hareketleri', s['id'], 'FAIZ_OTOMATIK')
                return {
                    "donem":   donem or bugun_tr().strftime('%Y-%m'),
                    "kartlar": sonuclar,
                    "yazilan": sum(1 for s in sonuclar if s.get('durum') == 'yazildi'),
                }
    except Exception as e:
        raise HTTPException(500, str(e))

# ── HAFTALIK FIRE RAPORU ──────────────────────────────────────
@app.get("/api/fire-haftalik")
def fire_haftalik_rapor(
    sube_id: Optional[str] = None,
    hafta_sayisi: int = 4,
    yeniden_hesapla: bool = False,
):
    """
    Kalem bazlı haftalık fire raporu.
    yeniden_hesapla=true → geçen haftayı tekrar hesaplar (test/düzeltme).
    """
    from operasyon_stok_motor import haftalik_fire_hesapla as _hfh
    from datetime import date as _date, timedelta as _td

    hafta_sayisi = max(1, min(int(hafta_sayisi), 12))
    with db() as (conn, cur):
        if yeniden_hesapla and sube_id:
            gecen_hf = _date.today() - _td(days=_date.today().weekday() + 7)
            r = _hfh(cur, sube_id, gecen_hf)
            conn.commit()

        q = """
            SELECT f.*, s.ad AS sube_adi
            FROM sube_fire_haftalik f
            JOIN subeler s ON s.id = f.sube_id
            WHERE f.hafta_baslangic >= CURRENT_DATE - (%s * INTERVAL '7 days')
        """
        params: list = [hafta_sayisi]
        if sube_id:
            q += " AND f.sube_id = %s"
            params.append(sube_id)
        q += " ORDER BY f.sube_id, f.hafta_baslangic DESC"
        cur.execute(q, tuple(params))
        rows = []
        for r in cur.fetchall():
            d = dict(r)
            if isinstance(d.get("kalemler"), str):
                import json as _j
                try:
                    d["kalemler"] = _j.loads(d["kalemler"])
                except Exception:
                    pass
            rows.append(d)
    return {"raporlar": rows, "toplam": len(rows)}


# ── KASA TUTARLILIK KONTROLÜ ──────────────────────────────────
@app.get("/api/kasa-kontrol")
def kasa_kontrol():
    """Ciro kayıtlarında kasa anomalisi var mı? Varsa listeler."""
    with db() as (conn, cur):
        cur.execute("""
            SELECT * FROM v_kasa_anomali
            WHERE durum != 'OK'
            LIMIT 50
        """)
        anomaliler = [dict(r) for r in cur.fetchall()]
        cur.execute("SELECT COUNT(*) as toplam FROM v_kasa_anomali")
        toplam = cur.fetchone()['toplam']
        cur.execute("SELECT COUNT(*) as sorunlu FROM v_kasa_anomali WHERE durum != 'OK'")
        sorunlu = cur.fetchone()['sorunlu']
        return {
            "toplam_ciro": toplam,
            "sorunlu": sorunlu,
            "saglikli": toplam - sorunlu,
            "anomaliler": anomaliler
        }

# ── TOPLU ÖDEME (tek transaction) ──────────────────────────────
@app.post("/api/toplu-odeme")
def toplu_odeme(payload: dict):
    """
    Birden fazla ödemeyi tek transaction'da uygular.
    Biri başarısız olursa hepsi rollback.
    payload: { odemeler: [{odeme_id, tutar}] }
    """
    odemeler = payload.get('odemeler', [])
    if not odemeler:
        raise HTTPException(400, "Ödeme listesi boş")
    
    with db() as (conn, cur):
        # Backend kasa kontrolü — core'dan
        kasa = kasa_bakiyesi(cur)
        toplam = sum(float(i.get('tutar', 0)) for i in odemeler if i.get('tutar'))
        if toplam > 0 and kasa - toplam < -1:
            raise HTTPException(400, f"Kasa yetersiz. Kasa: {kasa:,.0f}₺ · Toplam ödeme: {toplam:,.0f}₺")

        basarili = []
        for item in odemeler:
            oid = item.get('odeme_id')
            tutar = item.get('tutar')
            if not oid:
                continue
            cur.execute("SELECT * FROM odeme_plani WHERE id=%s", (oid,))
            plan = cur.fetchone()
            if not plan:
                raise HTTPException(404, f"Ödeme bulunamadı: {oid}")
            if plan['durum'] == 'odendi':
                continue  # Zaten ödendi, atla
            odenen = tutar or float(plan['odenecek_tutar'])
            bugun = str(bugun_tr())
            cur.execute("UPDATE odeme_plani SET durum='odendi', odeme_tarihi=%s, odenen_tutar=%s WHERE id=%s", (bugun, odenen, oid))
            plan_d = dict(plan)
            ana_t = kasa_ve_faiz_odeme_plani_tam_odeme(
                cur, plan_d, oid, odenen, bugun,
                anapara_aciklama=f"Toplu ödeme: {plan['aciklama']}",
            )
            if plan.get('kaynak_tablo') == 'vadeli_alimlar' and plan.get('kaynak_id'):
                vadeli_alim_kapat(cur, plan['kaynak_id'], bugun)
            guncelle_borc_envanteri_odeme_plani_sonrasi(cur, plan_d, ana_t)
            # Onay kuyruğunu kapat — tüm açık durumlar hedeflenir
            cur.execute("""UPDATE onay_kuyrugu SET durum='onaylandi', onay_tarihi=NOW()
                WHERE durum NOT IN ('onaylandi','reddedildi')
                AND (
                    kaynak_id = %s
                    OR kaynak_id = (SELECT kaynak_id FROM odeme_plani WHERE id=%s LIMIT 1)
                )""", (oid, oid))
            audit(cur, 'odeme_plani', oid, 'TOPLU_ODEME', eski=plan)
            basarili.append(oid)
        # Hepsi başarılıysa commit (with db() otomatik commit eder)
    return {"success": True, "uygulanan": len(basarili), "odemeler": basarili}

# ── AY SONU RAPOR (Excel) ──────────────────────────────────────
@app.get("/api/rapor/aylik")
def aylik_rapor(yil: int = None, ay: int = None):
    import calendar as cal
    bugun = bugun_tr()
    yil = yil or bugun.year
    ay  = ay  or bugun.month
    ay_basi = date(yil, ay, 1)
    ay_son  = date(yil, ay, cal.monthrange(yil, ay)[1])

    donem_key = f"{yil}-{ay:02d}"

    with db() as (conn, cur):
        # Mühürlü dönem mi? → değişmez snapshot'ı döndür (NRF dönem kapanışı)
        try:
            cur.execute("SELECT ozet_json, muhurleyen_ad, muhur_ts FROM rapor_kapanis WHERE donem=%s", (donem_key,))
            _seal = cur.fetchone()
        except Exception:
            _seal = None
        if _seal:
            sd = dict(_seal)
            snap = sd.get("ozet_json")
            if isinstance(snap, str):
                snap = json.loads(snap)
            if isinstance(snap, dict):
                snap["muhur"] = {
                    "muhurlu": True,
                    "muhurleyen_ad": sd.get("muhurleyen_ad"),
                    "muhur_ts": str(sd.get("muhur_ts") or ""),
                }
                return snap

        # 0. Ay başı kasa
        cur.execute("SELECT COALESCE(SUM(tutar),0) as v FROM kasa_hareketleri WHERE kasa_etkisi=true AND durum='aktif' AND tarih < %s", (ay_basi,))
        baslangic_kasa = float(cur.fetchone()['v'])

        # 1. Özet
        cur.execute("""
            SELECT
                COALESCE(SUM(CASE WHEN islem_turu='CIRO'          THEN tutar  ELSE 0 END),0) as ciro_toplam,
                COALESCE(SUM(CASE WHEN islem_turu='DIS_KAYNAK'    THEN tutar  ELSE 0 END),0) as dis_kaynak_toplam,
                COALESCE(SUM(CASE WHEN islem_turu='DEVIR'         THEN tutar  ELSE 0 END),0) as devir_toplam,
                COALESCE(SUM(CASE WHEN islem_turu IN ('KART_ODEME','KART_FAIZ') THEN ABS(tutar) ELSE 0 END),0) as kart_toplam,
                COALESCE(SUM(CASE WHEN islem_turu='KART_FAIZ'     THEN ABS(tutar) ELSE 0 END),0) as kart_faiz_toplam,
                COALESCE(SUM(CASE WHEN islem_turu='ANLIK_GIDER'   THEN ABS(tutar) ELSE 0 END),0) as anlik_toplam,
                COALESCE(SUM(CASE WHEN islem_turu='VADELI_ODEME'  THEN ABS(tutar) ELSE 0 END),0) as vadeli_toplam,
                COALESCE(SUM(CASE WHEN islem_turu='PERSONEL_MAAS' THEN ABS(tutar) ELSE 0 END),0) as maas_toplam,
                COALESCE(SUM(CASE WHEN islem_turu='SABIT_GIDER'   THEN ABS(tutar) ELSE 0 END),0) as sabit_toplam,
                COALESCE(SUM(CASE WHEN islem_turu='BORC_TAKSIT'   THEN ABS(tutar) ELSE 0 END),0) as borc_taksit_toplam,
                COALESCE(SUM(CASE WHEN islem_turu='FATURA_ODEMESI' THEN ABS(tutar) ELSE 0 END),0) as fatura_toplam,
                COALESCE(SUM(CASE WHEN islem_turu='POS_KESINTI'   THEN ABS(tutar) ELSE 0 END),0) as pos_kesinti_toplam,
                COALESCE(SUM(CASE WHEN tutar > 0 AND islem_turu != 'DEVIR' THEN tutar ELSE 0 END),0) as toplam_gelir,
                COALESCE(SUM(CASE WHEN tutar < 0 THEN ABS(tutar) ELSE 0 END),0) as toplam_gider,
                COALESCE(SUM(tutar),0) as net_kasa_degisim
            FROM kasa_hareketleri
            WHERE durum='aktif' AND kasa_etkisi=true AND tarih BETWEEN %s AND %s
        """, (ay_basi, ay_son))
        ozet = dict(cur.fetchone())
        ozet['baslangic_kasa'] = baslangic_kasa
        ozet['bitis_kasa']     = baslangic_kasa + float(ozet['net_kasa_degisim'])
        ozet['net_kar_zarar']  = float(ozet['toplam_gelir']) - float(ozet['toplam_gider'])

        # 1b. Ciro breakdown
        cur.execute("""
            SELECT COALESCE(SUM(nakit),0) as nakit, COALESCE(SUM(pos),0) as pos,
                   COALESCE(SUM(online),0) as online, COUNT(*) as islem_sayisi
            FROM ciro WHERE durum='aktif' AND tarih BETWEEN %s AND %s
        """, (ay_basi, ay_son))
        cbd = dict(cur.fetchone())
        ozet['ciro_nakit']  = float(cbd['nakit'])
        ozet['ciro_pos']    = float(cbd['pos'])
        ozet['ciro_online'] = float(cbd['online'])
        ozet['ciro_islem']  = int(cbd['islem_sayisi'])

        # 2. Şube bazlı ciro
        cur.execute("""
            SELECT COALESCE(s.ad,'Tanımsız') as sube,
                   COALESCE(SUM(c.toplam),0) as ciro, COALESCE(SUM(c.nakit),0) as nakit,
                   COALESCE(SUM(c.pos),0) as pos, COALESCE(SUM(c.online),0) as online,
                   COUNT(*) as islem_sayisi
            FROM ciro c LEFT JOIN subeler s ON s.id=c.sube_id
            WHERE c.durum='aktif' AND c.tarih BETWEEN %s AND %s
            GROUP BY s.ad ORDER BY ciro DESC
        """, (ay_basi, ay_son))
        sube_ciro = [dict(r) for r in cur.fetchall()]

        # 3. Sabit gider detay
        cur.execute("""
            SELECT COALESCE(sg.gider_adi, kh.aciklama) as gider_adi,
                   COALESCE(sg.kategori,'') as kategori,
                   ABS(kh.tutar) as odenen, kh.tarih::text as odeme_tarihi
            FROM kasa_hareketleri kh
            LEFT JOIN sabit_giderler sg ON sg.id=kh.kaynak_id
            WHERE kh.islem_turu='SABIT_GIDER' AND kh.durum='aktif' AND kh.kasa_etkisi=true
            AND kh.tarih BETWEEN %s AND %s ORDER BY kh.tarih
        """, (ay_basi, ay_son))
        sabit_detay = [dict(r) for r in cur.fetchall()]

        # 4. Personel detay
        cur.execute("""
            SELECT COALESCE(p.ad_soyad, kh.aciklama) as ad_soyad,
                   COALESCE(p.gorev,'') as gorev,
                   ABS(kh.tutar) as odenen, kh.tarih::text as odeme_tarihi
            FROM kasa_hareketleri kh
            LEFT JOIN personel p ON p.id=kh.kaynak_id
            WHERE kh.islem_turu='PERSONEL_MAAS' AND kh.durum='aktif' AND kh.kasa_etkisi=true
            AND kh.tarih BETWEEN %s AND %s ORDER BY kh.tarih
        """, (ay_basi, ay_son))
        personel_detay = [dict(r) for r in cur.fetchall()]

        # 5. Anlık gider kategori
        cur.execute("""
            SELECT kategori, COUNT(*) as adet, COALESCE(SUM(tutar),0) as toplam
            FROM anlik_giderler WHERE durum='aktif' AND tarih BETWEEN %s AND %s
            GROUP BY kategori ORDER BY toplam DESC
        """, (ay_basi, ay_son))
        anlik_kategoriler = [dict(r) for r in cur.fetchall()]

        # 6. Kart detay — odeme_plani üzerinden
        cur.execute("""
            SELECT k.kart_adi, k.banka,
                   COALESCE(SUM(op.odenen_tutar),0) as anapara,
                   0 as faiz, COUNT(*) as adet
            FROM odeme_plani op JOIN kartlar k ON k.id=op.kart_id
            WHERE op.durum='odendi' AND op.kart_id IS NOT NULL
            AND op.odeme_tarihi BETWEEN %s AND %s
            GROUP BY k.kart_adi, k.banka ORDER BY anapara DESC
        """, (ay_basi, ay_son))
        kart_detay = [dict(r) for r in cur.fetchall()]

        # 7. Günlük kümülatif
        cur.execute("""
            SELECT tarih::text,
                   COALESCE(SUM(CASE WHEN tutar>0 THEN tutar ELSE 0 END),0) as giris,
                   COALESCE(SUM(CASE WHEN tutar<0 THEN ABS(tutar) ELSE 0 END),0) as cikis,
                   SUM(tutar) as net
            FROM kasa_hareketleri
            WHERE durum='aktif' AND kasa_etkisi=true AND tarih BETWEEN %s AND %s
            GROUP BY tarih ORDER BY tarih
        """, (ay_basi, ay_son))
        gunluk = [dict(r) for r in cur.fetchall()]
        kumulatif = baslangic_kasa
        for g in gunluk:
            kumulatif += float(g['net'])
            g['kasa'] = round(kumulatif, 2)

        # 8. Önceki ay karşılaştırma
        if ay == 1: onceki_yil, onceki_ay = yil-1, 12
        else: onceki_yil, onceki_ay = yil, ay-1
        ob = date(onceki_yil, onceki_ay, 1)
        os_ = date(onceki_yil, onceki_ay, cal.monthrange(onceki_yil, onceki_ay)[1])
        cur.execute("""
            SELECT COALESCE(SUM(CASE WHEN islem_turu='CIRO' THEN tutar ELSE 0 END),0) as ciro,
                   COALESCE(SUM(CASE WHEN tutar>0 AND islem_turu!='DEVIR' THEN tutar ELSE 0 END),0) as gelir,
                   COALESCE(SUM(CASE WHEN tutar<0 THEN ABS(tutar) ELSE 0 END),0) as gider
            FROM kasa_hareketleri WHERE durum='aktif' AND kasa_etkisi=true AND tarih BETWEEN %s AND %s
        """, (ob, os_))
        onceki = dict(cur.fetchone())

        en_karli = max(sube_ciro, key=lambda x: x['ciro']) if sube_ciro else None

        # ───────────────────────────────────────────────────────────────
        # FAZ 1 KARNE — KPI'lar + 12 aylık trend + şube karnesi + yön. özeti
        # ───────────────────────────────────────────────────────────────
        aylar_kisa = ['', 'Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara']

        def _tl(v):
            try:
                return f"{float(v):,.0f} ₺".replace(',', '.')
            except Exception:
                return "0 ₺"

        ciro_t = float(ozet.get('ciro_toplam') or 0)
        gelir_t = float(ozet.get('toplam_gelir') or 0)
        gider_t = float(ozet.get('toplam_gider') or 0)
        net_t = float(ozet.get('net_kar_zarar') or 0)
        pos_ciro = float(ozet.get('ciro_pos') or 0)
        pos_kesinti = float(ozet.get('pos_kesinti_toplam') or 0)
        # Devam eden ayda geçen güne kadar; geçmiş ayda tam ay gün sayısı (adil run-rate)
        ay_suruyor = (bugun.year == yil and bugun.month == ay)
        gecen_gun = bugun.day if ay_suruyor else ay_son.day
        onc_gun = os_.day  # önceki ayın gün sayısı
        gun_say = gecen_gun
        gunluk_gider = (gider_t / gun_say) if gun_say else 0.0
        kpi = {
            "net_kar_marji": round(net_t / gelir_t * 100, 1) if gelir_t else None,
            "gider_ciro_orani": round(gider_t / ciro_t * 100, 1) if ciro_t else None,
            "pos_yanan_orani": round(pos_kesinti / pos_ciro * 100, 2) if pos_ciro else None,
            "pos_kesinti_toplam": round(pos_kesinti, 2),
            "gunluk_ortalama_gider": round(gunluk_gider, 2),
            "runway_gun": int(float(ozet.get('bitis_kasa') or 0) / gunluk_gider) if gunluk_gider > 0 else None,
            "bitis_kasa": float(ozet.get('bitis_kasa') or 0),
        }

        # 12 aylık trend
        ty12, tm12 = yil, ay - 11
        while tm12 <= 0:
            tm12 += 12
            ty12 -= 1
        trend_basi = date(ty12, tm12, 1)
        cur.execute("""
            SELECT to_char(date_trunc('month', tarih),'YYYY-MM') AS ay,
                   COALESCE(SUM(CASE WHEN islem_turu='CIRO' THEN tutar ELSE 0 END),0) AS ciro,
                   COALESCE(SUM(CASE WHEN tutar>0 AND islem_turu!='DEVIR' THEN tutar ELSE 0 END),0) AS gelir,
                   COALESCE(SUM(CASE WHEN tutar<0 THEN ABS(tutar) ELSE 0 END),0) AS gider
            FROM kasa_hareketleri
            WHERE durum='aktif' AND kasa_etkisi=true AND tarih BETWEEN %s AND %s
            GROUP BY 1 ORDER BY 1
        """, (trend_basi, ay_son))
        _tr_map = {r['ay']: dict(r) for r in cur.fetchall()}
        trend12 = []
        _cy, _cm = ty12, tm12
        for _ in range(12):
            key = f"{_cy}-{_cm:02d}"
            row = _tr_map.get(key)
            ge = float(row['gelir']) if row else 0.0
            gi = float(row['gider']) if row else 0.0
            trend12.append({
                "ay": key,
                "ay_kisa": aylar_kisa[_cm],
                "ciro": float(row['ciro']) if row else 0.0,
                "gelir": ge, "gider": gi, "net": ge - gi,
            })
            _cm += 1
            if _cm > 12:
                _cm = 1
                _cy += 1

        # Önceki ay şube ciro (büyüme için)
        cur.execute("""
            SELECT COALESCE(s.ad,'Tanımsız') AS sube, COALESCE(SUM(c.toplam),0) AS ciro
            FROM ciro c LEFT JOIN subeler s ON s.id=c.sube_id
            WHERE c.durum='aktif' AND c.tarih BETWEEN %s AND %s GROUP BY s.ad
        """, (ob, os_))
        _onc_sube = {r['sube']: float(r['ciro']) for r in cur.fetchall()}

        # Şube risk sinyalleri (denetim uyarıları aylık roll-up)
        _risk_sube = {}
        try:
            cur.execute("""
                SELECT COALESCE(s.ad,'Tanımsız') AS sube, COUNT(*) AS c
                FROM sube_operasyon_uyari u LEFT JOIN subeler s ON s.id=u.sube_id
                WHERE u.tarih BETWEEN %s AND %s
                  AND u.tip IN ('ACILIS_KASA_FARK','FIRE_TESPITI')
                GROUP BY s.ad
            """, (ay_basi, ay_son))
            _risk_sube = {r['sube']: int(r['c']) for r in cur.fetchall()}
        except Exception:
            _risk_sube = {}

        def _harf(skor):
            if skor >= 85:
                return "A"
            if skor >= 70:
                return "B"
            if skor >= 55:
                return "C"
            return "D"

        sube_karne = []
        for s in sube_ciro:
            ad = s['sube']
            ci = float(s.get('ciro') or 0)
            onc_ci = _onc_sube.get(ad, 0.0)
            # Adil kıyas: günlük ortalama (run-rate) — yarım ay tam ayı haksız ezmesin
            bu_gunluk = (ci / gecen_gun) if gecen_gun else 0.0
            onc_gunluk = (onc_ci / onc_gun) if onc_gun else 0.0
            buyume = round((bu_gunluk - onc_gunluk) / onc_gunluk * 100, 1) if onc_gunluk > 0 else None
            risk = int(_risk_sube.get(ad, 0))
            pay = round(ci / ciro_t * 100, 1) if ciro_t else 0.0
            skor = 80.0
            if buyume is not None:
                skor += max(-15.0, min(15.0, buyume))
            # Risk: ham sayı değil, gün başına sıklık (her gün kasa farkı = ağır ceza)
            risk_siklik = (risk / gecen_gun) if gecen_gun else 0.0
            skor -= min(30.0, risk_siklik * 40.0)
            sube_karne.append({
                "sube": ad, "ciro": ci, "pay_yuzde": pay, "buyume_yuzde": buyume,
                "risk_sinyali": risk, "islem_sayisi": s.get('islem_sayisi') or 0,
                "harf": _harf(skor), "skor": round(skor),
            })
        sube_karne.sort(key=lambda x: x['ciro'], reverse=True)

        # ── FAZ 2-A: DENETİM & RİSK ÖZETİ (aylık roll-up) ──
        denetim_ozeti = {
            "kasa": {"acik_tl": 0.0, "fazla_tl": 0.0, "acik_gun": 0, "olay": 0},
            "kasa_sube": [],
            "fire": {"toplam_bildirim": 0, "toplam_adet": 0, "sebepler": []},
            "uyumsuzluk": {"acik_adet": 0, "bekleyen_fark": 0},
        }
        # 1) Kasa disiplini (fark_tl: negatif=açık, pozitif=fazla)
        try:
            cur.execute("""
                SELECT COALESCE(s.ad,'Tanımsız') AS sube,
                       COUNT(*) AS olay,
                       COALESCE(SUM(CASE WHEN u.fark_tl < 0 THEN ABS(u.fark_tl) ELSE 0 END),0) AS acik_tl,
                       COALESCE(SUM(CASE WHEN u.fark_tl > 0 THEN u.fark_tl ELSE 0 END),0) AS fazla_tl,
                       COUNT(DISTINCT u.tarih) FILTER (WHERE u.fark_tl < 0) AS acik_gun
                FROM sube_operasyon_uyari u LEFT JOIN subeler s ON s.id=u.sube_id
                WHERE u.tarih BETWEEN %s AND %s
                  AND u.fark_tl IS NOT NULL AND u.fark_tl <> 0
                GROUP BY s.ad ORDER BY acik_tl DESC
            """, (ay_basi, ay_son))
            for r in cur.fetchall():
                rd = dict(r)
                denetim_ozeti["kasa_sube"].append({
                    "sube": rd["sube"],
                    "acik_tl": float(rd["acik_tl"]), "fazla_tl": float(rd["fazla_tl"]),
                    "acik_gun": int(rd["acik_gun"]), "olay": int(rd["olay"]),
                })
            denetim_ozeti["kasa"]["acik_tl"] = round(sum(x["acik_tl"] for x in denetim_ozeti["kasa_sube"]), 2)
            denetim_ozeti["kasa"]["fazla_tl"] = round(sum(x["fazla_tl"] for x in denetim_ozeti["kasa_sube"]), 2)
            denetim_ozeti["kasa"]["acik_gun"] = sum(x["acik_gun"] for x in denetim_ozeti["kasa_sube"])
            denetim_ozeti["kasa"]["olay"] = sum(x["olay"] for x in denetim_ozeti["kasa_sube"])
        except Exception:
            pass
        # 2) Fire / zayi (sebep dağılımı)
        try:
            cur.execute("""
                SELECT sebep_label, COUNT(*) AS adet, COALESCE(SUM(toplam_adet),0) AS urun_adet
                FROM sube_fire_bildirim
                WHERE tarih BETWEEN %s AND %s
                GROUP BY sebep_label ORDER BY adet DESC
            """, (ay_basi, ay_son))
            sebepler = [dict(r) for r in cur.fetchall()]
            denetim_ozeti["fire"]["sebepler"] = [
                {"sebep": s["sebep_label"], "adet": int(s["adet"]), "urun_adet": int(s["urun_adet"])}
                for s in sebepler
            ]
            denetim_ozeti["fire"]["toplam_bildirim"] = sum(s["adet"] for s in denetim_ozeti["fire"]["sebepler"])
            denetim_ozeti["fire"]["toplam_adet"] = sum(s["urun_adet"] for s in denetim_ozeti["fire"]["sebepler"])
        except Exception:
            pass
        # 3) Çözülmemiş sevkiyat uyumsuzluğu (şu an açık — dönemden bağımsız risk)
        try:
            cur.execute("""
                SELECT COUNT(*) AS adet,
                       COALESCE(SUM(GREATEST(0, COALESCE(sevk_adet,0)-COALESCE(kabul_adet,0))),0) AS bekleyen_fark
                FROM stok_yolda WHERE durum='kabul_uyusmazlik'
            """)
            ur = dict(cur.fetchone() or {})
            denetim_ozeti["uyumsuzluk"]["acik_adet"] = int(ur.get("adet") or 0)
            denetim_ozeti["uyumsuzluk"]["bekleyen_fark"] = int(ur.get("bekleyen_fark") or 0)
        except Exception:
            pass

        # ── FAZ 2-B: NAKİT AKIŞ & PROJEKSİYON ──
        projeksiyon = {
            "mevcut_kasa": float(ozet.get('bitis_kasa') or 0),
            "gunluk_gelir": 0.0, "gunluk_gider": 0.0, "net_gunluk": 0.0,
            "aylik_sabit_gider": 0.0, "aylik_maas": 0.0,
            "bekleyen_taksit_90": 0.0,
            "ufuklar": [], "runway_gun": None,
        }
        try:
            # 90 günlük run-rate (gelir/gider)
            cur.execute("""
                SELECT COALESCE(SUM(CASE WHEN tutar>0 AND islem_turu!='DEVIR' THEN tutar ELSE 0 END),0) AS gelir,
                       COALESCE(SUM(CASE WHEN tutar<0 THEN ABS(tutar) ELSE 0 END),0) AS gider
                FROM kasa_hareketleri
                WHERE durum='aktif' AND kasa_etkisi=true AND tarih >= CURRENT_DATE - INTERVAL '90 days'
            """)
            rr = dict(cur.fetchone() or {})
            g_gelir = float(rr.get("gelir") or 0) / 90.0
            g_gider_runrate = float(rr.get("gider") or 0) / 90.0

            # Bilinen sabit yükler
            try:
                cur.execute("SELECT COALESCE(SUM(tutar),0) AS v FROM sabit_giderler WHERE aktif=TRUE")
                projeksiyon["aylik_sabit_gider"] = float(dict(cur.fetchone() or {}).get("v") or 0)
            except Exception:
                pass
            try:
                cur.execute("SELECT COALESCE(SUM(maas),0) AS v FROM personel WHERE aktif=TRUE")
                projeksiyon["aylik_maas"] = float(dict(cur.fetchone() or {}).get("v") or 0)
            except Exception:
                pass

            # Günlük gider TABANI: bilinen sabit yükler kasaya tam işlenmemiş olabilir.
            # Run-rate ile (sabit+maaş)/30'un büyüğünü al — ne eksik say, ne çift say.
            sabit_gunluk = (projeksiyon["aylik_sabit_gider"] + projeksiyon["aylik_maas"]) / 30.0
            g_gider = max(g_gider_runrate, sabit_gunluk)
            projeksiyon["gunluk_gelir"] = round(g_gelir, 2)
            projeksiyon["gunluk_gider"] = round(g_gider, 2)
            projeksiyon["gunluk_gider_runrate"] = round(g_gider_runrate, 2)
            projeksiyon["gunluk_gider_sabit_taban"] = round(sabit_gunluk, 2)
            projeksiyon["net_gunluk"] = round(g_gelir - g_gider, 2)

            # Bekleyen taksitler — ufuk bazlı (kesin tarihli yük)
            tk = {30: 0.0, 60: 0.0, 90: 0.0}
            try:
                cur.execute("""
                    SELECT
                      COALESCE(SUM(CASE WHEN odeme_tarihi <= CURRENT_DATE + INTERVAL '30 days' THEN odenecek_tutar ELSE 0 END),0) AS t30,
                      COALESCE(SUM(CASE WHEN odeme_tarihi <= CURRENT_DATE + INTERVAL '60 days' THEN odenecek_tutar ELSE 0 END),0) AS t60,
                      COALESCE(SUM(CASE WHEN odeme_tarihi <= CURRENT_DATE + INTERVAL '90 days' THEN odenecek_tutar ELSE 0 END),0) AS t90
                    FROM odeme_plani
                    WHERE durum='bekliyor' AND odeme_tarihi >= CURRENT_DATE
                      AND odeme_tarihi <= CURRENT_DATE + INTERVAL '90 days'
                """)
                trow = dict(cur.fetchone() or {})
                tk = {30: float(trow.get("t30") or 0), 60: float(trow.get("t60") or 0), 90: float(trow.get("t90") or 0)}
            except Exception:
                pass
            projeksiyon["bekleyen_taksit_90"] = tk[90]

            mevcut = projeksiyon["mevcut_kasa"]
            net_g = projeksiyon["net_gunluk"]
            for n in (30, 60, 90):
                projeksiyon["ufuklar"].append({
                    "gun": n,
                    "beklenen_gelir": round(g_gelir * n, 2),
                    "beklenen_gider": round(g_gider * n, 2),
                    "bekleyen_taksit": round(tk[n], 2),
                    "projekte_kasa": round(mevcut + net_g * n, 2),
                })
            if net_g < 0:
                projeksiyon["runway_gun"] = int(mevcut / abs(net_g)) if abs(net_g) > 0 else None
        except Exception:
            pass

        # Yönetici özeti — otomatik cümleler
        yonetici_ozeti = []
        onc_ciro = float(onceki.get('ciro') or 0)
        if onc_ciro > 0 and gecen_gun and onc_gun:
            cd = ((ciro_t / gecen_gun) - (onc_ciro / onc_gun)) / (onc_ciro / onc_gun) * 100
            _kiyas_not = " (günlük ortalama, ay sürüyor)" if ay_suruyor else ""
            yonetici_ozeti.append({
                "tip": "iyi" if cd >= 0 else "uyari",
                "metin": f"Ciro geçen aya göre %{abs(cd):.1f} {'yüksek' if cd >= 0 else 'düşük'} hızda ({_tl(ciro_t)}){_kiyas_not}.",
            })
        else:
            yonetici_ozeti.append({"tip": "notr", "metin": f"Bu ay ciro: {_tl(ciro_t)}."})
        yonetici_ozeti.append({
            "tip": "iyi" if net_t >= 0 else "uyari",
            "metin": f"Net {'kâr' if net_t >= 0 else 'zarar'}: {_tl(abs(net_t))} (gelir {_tl(gelir_t)} − gider {_tl(gider_t)}).",
        })
        if en_karli:
            yonetici_ozeti.append({
                "tip": "iyi",
                "metin": f"En güçlü şube: {en_karli['sube']} ({_tl(float(en_karli['ciro']))}).",
            })
        if _risk_sube:
            _en_risk = max(_risk_sube.items(), key=lambda kv: kv[1])
            if _en_risk[1] > 0:
                yonetici_ozeti.append({
                    "tip": "uyari",
                    "metin": f"Dikkat: {_en_risk[0]} şubesinde {_en_risk[1]} denetim sinyali (kasa farkı / anomali / fire).",
                })
        if kpi["runway_gun"] is not None:
            yonetici_ozeti.append({
                "tip": "iyi" if kpi["runway_gun"] >= 30 else "uyari",
                "metin": f"Ay sonu kasa {_tl(kpi['bitis_kasa'])} — mevcut gider hızıyla ~{kpi['runway_gun']} gün dayanır.",
            })
        if kpi["pos_yanan_orani"]:
            yonetici_ozeti.append({
                "tip": "notr",
                "metin": f"POS kesintisi cironun %{kpi['pos_yanan_orani']:.2f}'i ({_tl(pos_kesinti)}).",
            })
        _kasa_acik = denetim_ozeti["kasa"]["acik_tl"]
        if _kasa_acik > 0:
            yonetici_ozeti.append({
                "tip": "uyari",
                "metin": f"Kasa açığı: {denetim_ozeti['kasa']['acik_gun']} şube-gün, toplam {_tl(_kasa_acik)} eksik kaydedildi.",
            })
        if denetim_ozeti["uyumsuzluk"]["acik_adet"] > 0:
            yonetici_ozeti.append({
                "tip": "uyari",
                "metin": f"{denetim_ozeti['uyumsuzluk']['acik_adet']} çözülmemiş sevkiyat uyumsuzluğu var (toplam {denetim_ozeti['uyumsuzluk']['bekleyen_fark']} adet fark).",
            })
        if projeksiyon["net_gunluk"] < 0 and projeksiyon["runway_gun"] is not None:
            yonetici_ozeti.append({
                "tip": "uyari",
                "metin": f"Nakit erime uyarısı: günlük net −{_tl(abs(projeksiyon['net_gunluk']))}, mevcut kasa ~{projeksiyon['runway_gun']} gün sonra tükenir.",
            })
        elif projeksiyon["net_gunluk"] > 0:
            _p90 = next((u for u in projeksiyon["ufuklar"] if u["gun"] == 90), None)
            if _p90:
                yonetici_ozeti.append({
                    "tip": "iyi",
                    "metin": f"Nakit trendi pozitif: günlük net +{_tl(projeksiyon['net_gunluk'])}, 90 gün projeksiyon ~{_tl(_p90['projekte_kasa'])}.",
                })

    aylar = ['','Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık']
    return {
        "donem": f"{yil}-{ay:02d}",
        "donem_label": f"{aylar[ay]} {yil}",
        "ozet": ozet,
        "sube_ciro": sube_ciro,
        "sabit_detay": sabit_detay,
        "personel_detay": personel_detay,
        "anlik_kategoriler": anlik_kategoriler,
        "kart_detay": kart_detay,
        "gunluk": gunluk,
        "onceki_ay": onceki,
        "en_karli_sube": en_karli,
        "kpi": kpi,
        "trend12": trend12,
        "sube_karne": sube_karne,
        "yonetici_ozeti": yonetici_ozeti,
        "denetim_ozeti": denetim_ozeti,
        "projeksiyon": projeksiyon,
        "muhur": {"muhurlu": False},
    }


class RaporMuhurleBody(BaseModel):
    yil: int
    ay: int
    muhurleyen_ad: Optional[str] = None


@app.post("/api/rapor/aylik/muhurle")
def aylik_rapor_muhurle(body: RaporMuhurleBody):
    """Aylık raporu mühürle — değişmez snapshot al (NRF dönem kapanışı).
    Mühürlü dönem bir daha değişmez; GET artık snapshot'ı döndürür."""
    yil, ay = int(body.yil), int(body.ay)
    donem_key = f"{yil}-{ay:02d}"
    with db() as (conn, cur):
        ensure_rapor_kapanis(cur)
        cur.execute("SELECT 1 FROM rapor_kapanis WHERE donem=%s", (donem_key,))
        if cur.fetchone():
            raise HTTPException(409, "Bu dönem zaten mühürlenmiş.")

    # Canlı raporu hesapla (mühür yokken live döner) ve dondur
    snap = aylik_rapor(yil, ay)
    snap.pop("muhur", None)
    payload = json.dumps(snap, ensure_ascii=False, sort_keys=True, default=str)
    h = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
    ad = (body.muhurleyen_ad or "CFO").strip() or "CFO"

    with db() as (conn, cur):
        ensure_rapor_kapanis(cur)
        cur.execute("""
            INSERT INTO rapor_kapanis (donem, ozet_json, muhurleyen_ad, hash)
            VALUES (%s, %s::jsonb, %s, %s)
            ON CONFLICT (donem) DO NOTHING
        """, (donem_key, payload, ad, h))
    return {"success": True, "donem": donem_key, "hash": h, "muhurleyen_ad": ad}

@app.get("/api/banka-mutabakat")
def banka_mutabakat(yil: int = None, ay: int = None):
    """Üçlü nakit mutabakatı (kasa→teslim→banka): dönem boyunca şubelerden TESLİM
    alınan nakit (ara teslim + kapanış teslimi) vs BANKAYA yatan; ayrıca kümülatif
    'elde/yolda nakit' (henüz bankaya gitmemiş havuz). Gösterge amaçlı."""
    import calendar as cal
    bugun = bugun_tr()
    yil = yil or bugun.year
    ay = ay or bugun.month
    ay_basi = date(yil, ay, 1)
    ay_son = date(yil, ay, cal.monthrange(yil, ay)[1])
    with db() as (conn, cur):
        cur.execute("SELECT COALESCE(SUM(tutar),0) AS v FROM kasa_teslim WHERE tarih BETWEEN %s AND %s", (ay_basi, ay_son))
        teslim_ara = float(cur.fetchone()["v"])
        cur.execute("""SELECT COALESCE(SUM(teslim),0) AS v FROM sube_operasyon_event
                       WHERE tip='KAPANIS' AND durum='tamamlandi' AND tarih BETWEEN %s AND %s""", (ay_basi, ay_son))
        teslim_kap = float(cur.fetchone()["v"])
        donem_teslim = round(teslim_ara + teslim_kap, 2)
        cur.execute("SELECT COALESCE(SUM(tutar),0) AS v, COUNT(*) AS c FROM banka_yatirimlari WHERE tarih BETWEEN %s AND %s", (ay_basi, ay_son))
        _y = dict(cur.fetchone())
        donem_yatan = float(_y["v"]); yatan_adet = int(_y["c"])
        # Kümülatif elde nakit (tüm zaman teslim − tüm zaman yatan)
        cur.execute("SELECT COALESCE(SUM(tutar),0) AS v FROM kasa_teslim WHERE tarih <= %s", (ay_son,))
        kum_ara = float(cur.fetchone()["v"])
        cur.execute("""SELECT COALESCE(SUM(teslim),0) AS v FROM sube_operasyon_event
                       WHERE tip='KAPANIS' AND durum='tamamlandi' AND tarih <= %s""", (ay_son,))
        kum_kap = float(cur.fetchone()["v"])
        cur.execute("SELECT COALESCE(SUM(tutar),0) AS v FROM banka_yatirimlari WHERE tarih <= %s", (ay_son,))
        kum_yatan = float(cur.fetchone()["v"])
        elde_nakit = round((kum_ara + kum_kap) - kum_yatan, 2)
        # Şube bazlı dönem teslim
        cur.execute("""
            SELECT COALESCE(s.ad,'?') AS sube,
              COALESCE((SELECT SUM(kt.tutar) FROM kasa_teslim kt WHERE kt.sube_id=s.id AND kt.tarih BETWEEN %s AND %s),0)
            + COALESCE((SELECT SUM(e.teslim) FROM sube_operasyon_event e WHERE e.sube_id=s.id AND e.tip='KAPANIS' AND e.durum='tamamlandi' AND e.tarih BETWEEN %s AND %s),0) AS teslim
            FROM subeler s ORDER BY teslim DESC
        """, (ay_basi, ay_son, ay_basi, ay_son))
        sube_teslim = [{"sube": r["sube"], "teslim": float(r["teslim"] or 0)} for r in cur.fetchall() if float(r["teslim"] or 0) > 0]
    return {
        "donem": f"{yil}-{ay:02d}",
        "donem_teslim": donem_teslim,
        "teslim_ara": round(teslim_ara, 2),
        "teslim_kapanis": round(teslim_kap, 2),
        "donem_yatan": round(donem_yatan, 2),
        "yatan_adet": yatan_adet,
        "donem_fark": round(donem_teslim - donem_yatan, 2),
        "elde_nakit": elde_nakit,
        "sube_teslim": sube_teslim,
    }


@app.get("/api/rapor/aylik/excel")
def aylik_rapor_excel(yil: int = None, ay: int = None):
    """
    Aylık raporu Excel olarak indir.
    aylik_rapor() verisini openpyxl ile XLSX'e çevirir.
    """
    import io
    import calendar as cal
    try:
        import openpyxl
        from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
        from openpyxl.utils import get_column_letter
        from fastapi.responses import StreamingResponse
    except ImportError:
        raise HTTPException(500, "openpyxl kurulu değil")

    # Aynı rapor verisini çek
    rapor = aylik_rapor(yil, ay)
    o     = rapor["ozet"]
    aylar = ['','Ocak','Şubat','Mart','Nisan','Mayıs','Haziran',
             'Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık']

    wb = openpyxl.Workbook()

    # ── RENK & STİL TANIMLAR ──────────────────────────────────
    def stil(ws, cell, deger, bold=False, renk=None, bg=None, sayi=False, hizala='left'):
        c = ws[cell] if isinstance(cell, str) else cell
        c.value = deger
        if bold:       c.font = Font(bold=True, size=11)
        if renk:       c.font = Font(bold=bold, color=renk, size=11)
        if bg:         c.fill = PatternFill("solid", fgColor=bg)
        if sayi:       c.number_format = '#,##0'
        c.alignment = Alignment(horizontal=hizala, vertical='center')
        return c

    BASLIK_BG   = "1E2A3A"
    BASLIK_FG   = "FFFFFF"
    ALT_BASLIK  = "2D4A6A"
    SARI_BG     = "FFF3CD"
    YESIL_BG    = "D4EDDA"
    KIRMIZI_BG  = "F8D7DA"
    GRI_BG      = "F8F9FA"
    KENAR       = Side(style='thin', color='CCCCCC')

    def border(c):
        c.border = Border(
            left=KENAR, right=KENAR, top=KENAR, bottom=KENAR
        )
        return c

    def baslik_satiri(ws, row, text, col_start=1, col_end=6, bg=BASLIK_BG):
        c = ws.cell(row=row, column=col_start, value=text)
        c.font = Font(bold=True, color=BASLIK_FG, size=12)
        c.fill = PatternFill("solid", fgColor=bg)
        c.alignment = Alignment(horizontal='left', vertical='center')
        ws.merge_cells(start_row=row, start_column=col_start,
                       end_row=row, end_column=col_end)
        ws.row_dimensions[row].height = 24
        return c

    # ════════════════════════════════════════════════════════════
    # SAYFA 1: ÖZET
    # ════════════════════════════════════════════════════════════
    ws1 = wb.active
    ws1.title = "Özet"
    ws1.column_dimensions['A'].width = 32
    ws1.column_dimensions['B'].width = 20
    ws1.column_dimensions['C'].width = 20

    # Başlık
    baslik_satiri(ws1, 1, f"EVVEL ERP — AYLIK FİNANSAL RAPOR", 1, 3)
    baslik_satiri(ws1, 2, f"{rapor['donem_label']} · {rapor['donem']}", 1, 3, ALT_BASLIK)
    ws1.row_dimensions[2].height = 20

    r = 4
    baslik_satiri(ws1, r, "KASA ÖZETİ", 1, 3, "2C3E50"); r += 1

    for label, key, bg in [
        ("Ay Başı Kasa",    "baslangic_kasa", GRI_BG),
        ("Toplam Gelir",    "toplam_gelir",   YESIL_BG),
        ("Toplam Gider",    "toplam_gider",   KIRMIZI_BG),
        ("Net Kar / Zarar", "net_kar_zarar",  YESIL_BG if float(o.get("net_kar_zarar",0)) >= 0 else KIRMIZI_BG),
        ("Ay Sonu Kasa",    "bitis_kasa",     SARI_BG),
    ]:
        val = float(o.get(key, 0) or 0)
        c1 = ws1.cell(row=r, column=1, value=label)
        c1.fill = PatternFill("solid", fgColor=bg)
        c1.font = Font(bold=True, size=11)
        c1.alignment = Alignment(horizontal='left', vertical='center')
        c2 = ws1.cell(row=r, column=2, value=val)
        c2.number_format = '#,##0'
        c2.fill = PatternFill("solid", fgColor=bg)
        c2.font = Font(bold=True, size=11)
        c2.alignment = Alignment(horizontal='right', vertical='center')
        border(c1); border(c2)
        r += 1

    r += 1
    baslik_satiri(ws1, r, "GELİR DAĞILIMI", 1, 3, "27AE60"); r += 1
    for label, key in [
        ("Nakit Ciro",       "ciro_nakit"),
        ("POS Ciro",         "ciro_pos"),
        ("Online Ciro",      "ciro_online"),
        ("Dış Kaynak",       "dis_kaynak_toplam"),
    ]:
        val = float(o.get(key, 0) or 0)
        if val == 0: continue
        c1 = ws1.cell(row=r, column=1, value=label)
        c1.alignment = Alignment(horizontal='left')
        c2 = ws1.cell(row=r, column=2, value=val)
        c2.number_format = '#,##0'
        c2.alignment = Alignment(horizontal='right')
        toplam = float(o.get("toplam_gelir", 1) or 1)
        c3 = ws1.cell(row=r, column=3, value=f"%{round(val/toplam*100)}")
        c3.alignment = Alignment(horizontal='right')
        border(c1); border(c2); border(c3)
        r += 1

    r += 1
    baslik_satiri(ws1, r, "GİDER DAĞILIMI", 1, 3, "E74C3C"); r += 1
    for label, key in [
        ("Kart Ödemeleri",    "kart_toplam"),
        ("Anlık Giderler",    "anlik_toplam"),
        ("Personel Maaşları", "maas_toplam"),
        ("Sabit Giderler",    "sabit_toplam"),
        ("Vadeli Ödemeler",   "vadeli_toplam"),
        ("Borç Taksitleri",   "borc_taksit_toplam"),
        ("Fatura Giderleri",  "fatura_toplam"),
        ("Kart Faizi",        "kart_faiz_toplam"),
        ("POS Komisyon",      "pos_kesinti_toplam"),
    ]:
        val = float(o.get(key, 0) or 0)
        if val == 0: continue
        c1 = ws1.cell(row=r, column=1, value=label)
        c1.alignment = Alignment(horizontal='left')
        c2 = ws1.cell(row=r, column=2, value=val)
        c2.number_format = '#,##0'
        c2.alignment = Alignment(horizontal='right')
        toplam_g = float(o.get("toplam_gider", 1) or 1)
        c3 = ws1.cell(row=r, column=3, value=f"%{round(val/toplam_g*100)}")
        c3.alignment = Alignment(horizontal='right')
        border(c1); border(c2); border(c3)
        r += 1

    # ════════════════════════════════════════════════════════════
    # SAYFA 2: GÜNLÜK KASA
    # ════════════════════════════════════════════════════════════
    ws2 = wb.create_sheet("Günlük Kasa")
    ws2.column_dimensions['A'].width = 14
    ws2.column_dimensions['B'].width = 16
    ws2.column_dimensions['C'].width = 16
    ws2.column_dimensions['D'].width = 16
    ws2.column_dimensions['E'].width = 16

    baslik_satiri(ws2, 1, f"GÜNLÜK KASA SEYRİ — {rapor['donem_label']}", 1, 5)
    r = 2
    headers = ["Tarih", "Giriş", "Çıkış", "Net", "Kümülatif Kasa"]
    for col, h in enumerate(headers, 1):
        c = ws2.cell(row=r, column=col, value=h)
        c.font = Font(bold=True, color=BASLIK_FG, size=10)
        c.fill = PatternFill("solid", fgColor=ALT_BASLIK)
        c.alignment = Alignment(horizontal='center', vertical='center')
        border(c)
    r += 1

    for g in (rapor.get("gunluk") or []):
        giris = float(g.get("giris", 0) or 0)
        cikis = float(g.get("cikis", 0) or 0)
        net   = float(g.get("net", 0) or 0)
        kasa  = float(g.get("kasa", 0) or 0)
        tarih = str(g.get("tarih",""))
        bg = KIRMIZI_BG if kasa < 0 else ("FFFFFF" if r % 2 == 0 else GRI_BG)
        for col, val in enumerate([tarih, giris, cikis, net, kasa], 1):
            c = ws2.cell(row=r, column=col, value=val)
            c.fill = PatternFill("solid", fgColor=bg)
            if col > 1: c.number_format = '#,##0'
            c.alignment = Alignment(horizontal='right' if col>1 else 'left', vertical='center')
            border(c)
        r += 1

    # ════════════════════════════════════════════════════════════
    # SAYFA 3: ŞUBE CİRO
    # ════════════════════════════════════════════════════════════
    if rapor.get("sube_ciro"):
        ws3 = wb.create_sheet("Şube Ciro")
        for col, w in zip('ABCDEF', [20,16,14,14,14,10]):
            ws3.column_dimensions[col].width = w
        baslik_satiri(ws3, 1, f"ŞUBE BAZLI CİRO — {rapor['donem_label']}", 1, 6)
        r = 2
        for col, h in enumerate(["Şube","Toplam Ciro","Nakit","POS","Online","İşlem"], 1):
            c = ws3.cell(row=r, column=col, value=h)
            c.font = Font(bold=True, color=BASLIK_FG, size=10)
            c.fill = PatternFill("solid", fgColor=ALT_BASLIK)
            c.alignment = Alignment(horizontal='center', vertical='center')
            border(c)
        r += 1
        for s in rapor["sube_ciro"]:
            for col, val in enumerate([
                s.get("sube",""), float(s.get("ciro",0) or 0),
                float(s.get("nakit",0) or 0), float(s.get("pos",0) or 0),
                float(s.get("online",0) or 0), int(s.get("islem_sayisi",0) or 0)
            ], 1):
                c = ws3.cell(row=r, column=col, value=val)
                if col > 1: c.number_format = '#,##0'
                c.alignment = Alignment(horizontal='right' if col>1 else 'left')
                border(c)
            r += 1

    # ════════════════════════════════════════════════════════════
    # SAYFA 4: GİDER DETAYLARI
    # ════════════════════════════════════════════════════════════
    ws4 = wb.create_sheet("Gider Detayları")
    ws4.column_dimensions['A'].width = 10
    ws4.column_dimensions['B'].width = 30
    ws4.column_dimensions['C'].width = 16
    ws4.column_dimensions['D'].width = 14
    ws4.column_dimensions['E'].width = 16

    r = 1
    # Sabit giderler
    if rapor.get("sabit_detay"):
        baslik_satiri(ws4, r, "SABİT GİDERLER", 1, 5, "2980B9"); r += 1
        for col, h in enumerate(["Tarih","Gider Adı","Kategori","Ödenen"], 1):
            c = ws4.cell(row=r, column=col, value=h)
            c.font = Font(bold=True, color=BASLIK_FG, size=10)
            c.fill = PatternFill("solid", fgColor=ALT_BASLIK)
            border(c)
        r += 1
        toplam_sabit = 0
        for g in rapor["sabit_detay"]:
            odenen = float(g.get("odenen", 0) or 0)
            toplam_sabit += odenen
            for col, val in enumerate([
                str(g.get("odeme_tarihi",""))[:10],
                g.get("gider_adi",""), g.get("kategori",""), odenen
            ], 1):
                c = ws4.cell(row=r, column=col, value=val)
                if col == 4: c.number_format = '#,##0'
                border(c)
            r += 1
        c = ws4.cell(row=r, column=3, value="TOPLAM")
        c.font = Font(bold=True)
        c2 = ws4.cell(row=r, column=4, value=toplam_sabit)
        c2.number_format = '#,##0'; c2.font = Font(bold=True)
        r += 2

    # Personel giderleri
    if rapor.get("personel_detay"):
        baslik_satiri(ws4, r, "PERSONEL MAAŞLARI", 1, 5, "8E44AD"); r += 1
        for col, h in enumerate(["Tarih","Ad Soyad","Görev","Ödenen"], 1):
            c = ws4.cell(row=r, column=col, value=h)
            c.font = Font(bold=True, color=BASLIK_FG, size=10)
            c.fill = PatternFill("solid", fgColor=ALT_BASLIK)
            border(c)
        r += 1
        toplam_maas = 0
        for p in rapor["personel_detay"]:
            odenen = float(p.get("odenen", 0) or 0)
            toplam_maas += odenen
            for col, val in enumerate([
                str(p.get("odeme_tarihi",""))[:10],
                p.get("ad_soyad",""), p.get("gorev",""), odenen
            ], 1):
                c = ws4.cell(row=r, column=col, value=val)
                if col == 4: c.number_format = '#,##0'
                border(c)
            r += 1
        c = ws4.cell(row=r, column=3, value="TOPLAM")
        c.font = Font(bold=True)
        c2 = ws4.cell(row=r, column=4, value=toplam_maas)
        c2.number_format = '#,##0'; c2.font = Font(bold=True)
        r += 2

    # Anlık gider kategorileri
    if rapor.get("anlik_kategoriler"):
        baslik_satiri(ws4, r, "ANLIK GİDER KATEGORİLERİ", 1, 5, "D35400"); r += 1
        for col, h in enumerate(["Kategori","İşlem Adedi","Toplam"], 1):
            c = ws4.cell(row=r, column=col, value=h)
            c.font = Font(bold=True, color=BASLIK_FG, size=10)
            c.fill = PatternFill("solid", fgColor=ALT_BASLIK)
            border(c)
        r += 1
        for g in rapor["anlik_kategoriler"]:
            for col, val in enumerate([
                g.get("kategori",""), int(g.get("adet",0) or 0),
                float(g.get("toplam",0) or 0)
            ], 1):
                c = ws4.cell(row=r, column=col, value=val)
                if col == 3: c.number_format = '#,##0'
                border(c)
            r += 1
        r += 1

    # Kart ödemeleri
    if rapor.get("kart_detay"):
        baslik_satiri(ws4, r, "KART ÖDEMELERİ", 1, 5, "C0392B"); r += 1
        for col, h in enumerate(["Kart","Banka","Ödeme Adedi","Anapara"], 1):
            c = ws4.cell(row=r, column=col, value=h)
            c.font = Font(bold=True, color=BASLIK_FG, size=10)
            c.fill = PatternFill("solid", fgColor=ALT_BASLIK)
            border(c)
        r += 1
        for k in rapor["kart_detay"]:
            for col, val in enumerate([
                k.get("kart_adi",""), k.get("banka",""),
                int(k.get("adet",0) or 0), float(k.get("anapara",0) or 0)
            ], 1):
                c = ws4.cell(row=r, column=col, value=val)
                if col == 4: c.number_format = '#,##0'
                border(c)
            r += 1

    # Excel'i belleğe yaz
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    dosya_adi = f"evvel-rapor-{rapor['donem']}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={dosya_adi}"}
    )


def health():
    return {
        "status": "ok",
        "version": "EVVEL-ERP-2.0",
        "build": "v2.4",
        "build_date": "2026-03-27",
        "features": [
            "odeme_tipi_duzeltme",
            "kira_artis_periyot",
            "sozlesme_stop",
            "inline_edit_modal",
            "durdurulmus_sabit_zorunlu",
            "plan_iptal_on_stop",
        ]
    }


@app.post("/api/sistem-sifirla")
def sistem_sifirla(body: dict = {}):
    """Seçili tabloları siler. body: {onay: 'EVET_SIL', tablolar: [...]}"""
    if body.get('onay') != 'EVET_SIL':
        raise HTTPException(400, "Onay gerekli")

    # İzin verilen tablolar — şubeler, kartlar, master katalog (merkez_stok_kart,
    # siparis_kategori, siparis_urun, tedarikciler) ve vardiya kural tabloları asla silinmez.
    IZINLI = {
        # ── Finans / Muhasebe ─────────────────────────────────────────
        'ciro':                 'ciro',
        'ciro_taslak':          'ciro_taslak',
        'kasa':                 'kasa_hareketleri',
        'kart_hareketleri':     'kart_hareketleri',
        'banka_yatirimlari':    'banka_yatirimlari',
        'anlik_gider':          'anlik_giderler',
        'vadeli_alim':          'vadeli_alimlar',
        'sabit_gider':          'sabit_giderler',
        'borc':                 'borc_envanteri',
        'odeme_plani':          'odeme_plani',
        'onay_kuyrugu':         'onay_kuyrugu',
        'x_rapor_kayit':        'x_rapor_kayit',
        # ── Personel (aylık + ataması; personel tanımı ayrı) ──────────
        'personel':             'personel',
        'personel_aylik':       'personel_aylik',
        'personel_risk_sinyal': 'personel_risk_sinyal',
        'personel_takip':       'personel_takip',
        # ── Şube operasyon (test verileri için) ───────────────────────
        'sube_acilis':          'sube_acilis',
        'sube_operasyon_event': 'sube_operasyon_event',
        'sube_operasyon_uyari': 'sube_operasyon_uyari',
        'sube_operasyon_ozet':  'sube_operasyon_ozet',
        'sube_fire_haftalik':   'sube_fire_haftalik',
        'operasyon_defter':     'operasyon_defter',
        'sube_kasa_gun_acma':   'sube_kasa_gun_acma',
        'kapanis_kayit':        'kapanis_kayit',
        'sube_depo_stok':       'sube_depo_stok',
        'stok_yolda':           'stok_yolda',
        'sube_skor':            'sube_skor',
        'sube_merkez_mesaj':    'sube_merkez_mesaj',
        'sube_merkez_not':      'sube_merkez_not',
        'panel_pin_guvenlik':   'panel_pin_guvenlik',
        'operasyon_guvenlik_olay':       'operasyon_guvenlik_olay',
        'operasyon_guvenlik_alarm_durum':'operasyon_guvenlik_alarm_durum',
        'motor_analitik_olay':  'motor_analitik_olay',
        'kasa_teslim':          'kasa_teslim',
        # ── Sipariş akışı ─────────────────────────────────────────────
        'siparis_talep':        'siparis_talep',
        'siparis_ozel_talep':   'siparis_ozel_talep',
        'siparis_sevk_eksik':   'siparis_sevk_eksik',
        'merkez_stok_sevk':     'merkez_stok_sevk',
        # ── Denetim ──────────────────────────────────────────────────
        'audit_log':            'audit_log',
    }

    istenen = body.get('tablolar', list(IZINLI.keys()))  # boşsa hepsi
    silincekler = [IZINLI[k] for k in istenen if k in IZINLI]

    if not silincekler:
        raise HTTPException(400, "Silinecek tablo seçilmedi")

    with db() as (conn, cur):
        cur.execute(f"TRUNCATE TABLE {', '.join(silincekler)} CASCADE")

    return {"basarili": True, "silinen": silincekler,
            "mesaj": f"{len(silincekler)} tablo temizlendi."}

# Şube personel paneli HTML (SPA catch-all'dan önce).
# Üretim imajında dosya yalnızca static/'tedir (Dockerfile cp). Geliştiricide düzenlenen
# kaynak genelde kökteki sube_panel.html olduğundan — varsa kök önceliklidir; böylece
# /sube-panel yanlışlıkla React SPA catch-all'a düşmez ve eski static kopyası ezmez.
_kok_panel = pathlib.Path("sube_panel.html")
_static_panel = pathlib.Path("static/sube_panel.html")
_sube_panel_path = _kok_panel if _kok_panel.is_file() else _static_panel
if _sube_panel_path.exists():
    from fastapi.responses import FileResponse as _FileResponseSube

    _sube_headers = {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
    }

    @app.get("/sube-panel")
    @app.get("/sube-panel/{sube_id:path}")
    async def serve_sube_panel_html(sube_id: str = ""):
        _ = sube_id
        return _FileResponseSube(
            str(_sube_panel_path),
            media_type="text/html",
            headers=_sube_headers,
        )

    @app.get("/sube")
    @app.get("/sube/{sube_id:path}")
    async def serve_sube_personel_html(sube_id: str = ""):
        _ = sube_id
        return _FileResponseSube(
            str(_sube_panel_path),
            media_type="text/html",
            headers=_sube_headers,
        )

# ══════════════════════════════════════════════════════════════
# VARDİYA v2 — SLOT BAZLI YENİ SİSTEM
# ══════════════════════════════════════════════════════════════
class _V2SlotIn(BaseModel):
    sube_id: str
    ad: str
    tip: str = "normal"
    baslangic_saat: str   # "HH:MM"
    bitis_saat: str
    gece_vardiyasi: bool = False
    min_personel: int = 1
    ideal_personel: int = 1
    aktif_gunler: List[int] = Field(default_factory=lambda: [1,2,3,4,5,6,7])
    aktif: bool = True
    sira: int = 0


class _V2SlotUretIn(BaseModel):
    """Şube açılış/kapanış/yoğun saatlerinden AUTO: slot üretimi."""
    sube_id: str
    mod: str = "yenile"  # yenile | ekle
    acilis_dakika: int = 60
    kapanis_dakika: int = 60
    normal_slot_dakika: int = 120
    hafta_ici: bool = False
    aktif_gunler: Optional[List[int]] = None


class _V2KisitIn(BaseModel):
    max_gunluk_saat: float = 9.5
    max_haftalik_saat: float = 57.0
    izinli_subeler: List[str] = Field(default_factory=list)
    yasak_subeler: List[str] = Field(default_factory=list)
    calisilabilir_saat_min: Optional[str] = None
    calisilabilir_saat_max: Optional[str] = None
    min_gecis_dk: int = 30
    # YENİ: hibrit preset + ders saatleri + yemek molası
    vardiya_preset_json: Dict[str, Any] = Field(default_factory=dict)
    gun_saat_kisitlari_json: Dict[str, Any] = Field(default_factory=dict)
    yemek_sube_id: Optional[str] = None

class _V2AtamaIn(BaseModel):
    personel_id: str
    slot_id: str
    tarih: str            # "YYYY-MM-DD"
    baslangic_saat: Optional[str] = None
    bitis_saat: Optional[str] = None
    override: bool = False
    aciklama: Optional[str] = None
    # True: saatler boşsa preset/mesai/kısa dilim (otomatik doldur / motor / sürükle önizleme)
    otomatik_saat_cozumu: bool = False
    # True: kayıt `onayli` — taşınamaz kilidi için UI (otomatik planlar varsayılan `planli`)
    kesinlestir: bool = False


class _MotorHaftaIn(BaseModel):
    """Haftalık otomatik plan motoru (`vardiya_plan_motor`)."""
    pazartesi: str              # ISO gün — haftanın herhangi bir günü olabilir (Pzt’ye normalize edilir)
    max_rounds: int = 120
    tasima_izni: bool = True    # Başka slottan taşımayı dene (min kontenjan korunur)
    dry_run: bool = False       # True ise işlem sonunda rollback (önizleme)


class _V2SubeGunHedefIn(BaseModel):
    """Şube × gün hedef kişi; `hedef_personel` null/omit → hedef kaldırılır."""
    sube_id: str
    tarih: str
    hedef_personel: Optional[int] = None


class _V2PersonelGunNiyetIn(BaseModel):
    personel_id: str
    tarih: str
    kasitli_bos: bool


class _V2GunKilitIn(BaseModel):
    tarih: str
    kilitli: bool = True
    aciklama: Optional[str] = None


class _V2IzinIn(BaseModel):
    personel_id: str
    baslangic_tarih: str
    bitis_tarih: str
    tip: str = "mazeret"
    aciklama: Optional[str] = None
    # Aynı ISO haftasında ikinci kayıt: 409 sonrası kullanıcı onayı ile True
    force: bool = False


def _t(s: Optional[str]):
    if not s:
        return None
    h, m = str(s).split(":")[:2]
    from datetime import time as _time
    return _time(int(h), int(m))


# ── SLOT CRUD ──
@app.get("/api/vardiya/v2/slot")
def v2_slot_liste(sube_id: Optional[str] = None, aktif_mi: Optional[bool] = None):
    with db() as (conn, cur):
        sql = "SELECT * FROM vardiya_slot WHERE 1=1"
        params: List = []
        if sube_id:
            sql += " AND sube_id = %s"; params.append(sube_id)
        if aktif_mi is not None:
            sql += " AND aktif = %s"; params.append(aktif_mi)
        sql += " ORDER BY sube_id, sira, baslangic_saat"
        cur.execute(sql, tuple(params))
        return {"slotlar": [dict(r) for r in cur.fetchall()]}

@app.post("/api/vardiya/v2/slot")
def v2_slot_ekle(s: _V2SlotIn):
    sid = str(uuid.uuid4())
    with db() as (conn, cur):
        cur.execute("""
            INSERT INTO vardiya_slot
                (id, sube_id, ad, tip, baslangic_saat, bitis_saat, gece_vardiyasi,
                 min_personel, ideal_personel, aktif_gunler, aktif, sira)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (sid, s.sube_id, s.ad, s.tip, _t(s.baslangic_saat), _t(s.bitis_saat),
              s.gece_vardiyasi, s.min_personel, s.ideal_personel,
              s.aktif_gunler, s.aktif, s.sira))
    return {"id": sid}

@app.put("/api/vardiya/v2/slot/{sid}")
def v2_slot_guncelle(sid: str, s: _V2SlotIn):
    with db() as (conn, cur):
        cur.execute("""
            UPDATE vardiya_slot SET
                sube_id=%s, ad=%s, tip=%s, baslangic_saat=%s, bitis_saat=%s,
                gece_vardiyasi=%s, min_personel=%s, ideal_personel=%s,
                aktif_gunler=%s, aktif=%s, sira=%s
            WHERE id=%s
        """, (s.sube_id, s.ad, s.tip, _t(s.baslangic_saat), _t(s.bitis_saat),
              s.gece_vardiyasi, s.min_personel, s.ideal_personel,
              s.aktif_gunler, s.aktif, s.sira, sid))
        if cur.rowcount == 0:
            raise HTTPException(404, "Slot bulunamadı")
    return {"basarili": True}

@app.delete("/api/vardiya/v2/slot/{sid}")
def v2_slot_sil(sid: str):
    with db() as (conn, cur):
        cur.execute("DELETE FROM vardiya_slot WHERE id = %s", (sid,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Slot bulunamadı")
    return {"basarili": True}


@app.post("/api/vardiya/v2/slot/uret")
def v2_slot_sube_saatlerinden_uret(body: _V2SlotUretIn):
    """Aşama 2 slot motoru: `subeler.acilis_saati` / `kapanis_saati` / yoğun aralığı → `AUTO:` slotlar."""
    with db() as (conn, cur):
        sonuc = _vv2.slotlari_sube_saatlerinden_uret(
            cur,
            body.sube_id,
            mod=body.mod,
            acilis_dakika=body.acilis_dakika,
            kapanis_dakika=body.kapanis_dakika,
            normal_slot_dakika=body.normal_slot_dakika,
            aktif_gunler=body.aktif_gunler,
            hafta_ici=body.hafta_ici,
        )
    if not sonuc.get("basarili"):
        raise HTTPException(409, sonuc)
    return sonuc


# ── PERSONEL KISIT ──
@app.get("/api/vardiya/v2/kisit/{pid}")
def v2_kisit_getir(pid: str):
    with db() as (conn, cur):
        return _vv2.personel_kisit_getir(cur, pid)

@app.put("/api/vardiya/v2/kisit/{pid}")
def v2_kisit_kaydet(pid: str, k: _V2KisitIn):
    """
    Eski PostgreSQL kurulumlarında `personel_kisit` tablosunda ayrı NOT NULL `id`
    kolonu olabiliyor; INSERT `id` vermezse NotNullViolation oluşur. Kolon varsa
    UUID üretilir.
    """
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'personel_kisit'
              AND column_name = 'id'
            """
        )
        has_id_col = cur.fetchone() is not None
        tmin = _t(k.calisilabilir_saat_min)
        tmax = _t(k.calisilabilir_saat_max)
        if has_id_col:
            kid = str(uuid.uuid4())
            cur.execute(
                """
                INSERT INTO personel_kisit
                    (id, personel_id, max_gunluk_saat, max_haftalik_saat,
                     izinli_subeler, yasak_subeler,
                     calisilabilir_saat_min, calisilabilir_saat_max, min_gecis_dk)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (personel_id) DO UPDATE SET
                    max_gunluk_saat = EXCLUDED.max_gunluk_saat,
                    max_haftalik_saat = EXCLUDED.max_haftalik_saat,
                    izinli_subeler = EXCLUDED.izinli_subeler,
                    yasak_subeler = EXCLUDED.yasak_subeler,
                    calisilabilir_saat_min = EXCLUDED.calisilabilir_saat_min,
                    calisilabilir_saat_max = EXCLUDED.calisilabilir_saat_max,
                    min_gecis_dk = EXCLUDED.min_gecis_dk,
                    guncelleme = NOW()
                """,
                (
                    kid,
                    pid,
                    k.max_gunluk_saat,
                    k.max_haftalik_saat,
                    k.izinli_subeler,
                    k.yasak_subeler,
                    tmin,
                    tmax,
                    k.min_gecis_dk,
                ),
            )
        else:
            cur.execute(
                """
                INSERT INTO personel_kisit
                    (personel_id, max_gunluk_saat, max_haftalik_saat,
                     izinli_subeler, yasak_subeler,
                     calisilabilir_saat_min, calisilabilir_saat_max, min_gecis_dk)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (personel_id) DO UPDATE SET
                    max_gunluk_saat = EXCLUDED.max_gunluk_saat,
                    max_haftalik_saat = EXCLUDED.max_haftalik_saat,
                    izinli_subeler = EXCLUDED.izinli_subeler,
                    yasak_subeler = EXCLUDED.yasak_subeler,
                    calisilabilir_saat_min = EXCLUDED.calisilabilir_saat_min,
                    calisilabilir_saat_max = EXCLUDED.calisilabilir_saat_max,
                    min_gecis_dk = EXCLUDED.min_gecis_dk,
                    guncelleme = NOW()
                """,
                (
                    pid,
                    k.max_gunluk_saat,
                    k.max_haftalik_saat,
                    k.izinli_subeler,
                    k.yasak_subeler,
                    tmin,
                    tmax,
                    k.min_gecis_dk,
                ),
            )
        # YENİ alanlar (preset, ders saatleri, yemek molası) — UPDATE ayrı.
        # Eski/yeni schema fark etmez; kolonlar yoksa migration zaten ekleyecek.
        import json as _json
        try:
            cur.execute(
                """
                UPDATE personel_kisit
                SET vardiya_preset_json = %s::jsonb,
                    gun_saat_kisitlari_json = %s::jsonb,
                    yemek_sube_id = %s,
                    guncelleme = NOW()
                WHERE personel_id = %s
                """,
                (
                    _json.dumps(k.vardiya_preset_json or {}),
                    _json.dumps(k.gun_saat_kisitlari_json or {}),
                    k.yemek_sube_id,
                    pid,
                ),
            )
        except Exception:
            # Eski schema'da kolon yoksa sessiz geç (migration sonrasında çalışacak)
            pass
    return {"basarili": True}


# ── ATAMA ──
@app.get("/api/vardiya/v2/gun")
def v2_gun_planini_getir(tarih: str, sube_id: Optional[str] = None):
    from datetime import datetime as _dt
    t = _dt.strptime(tarih, "%Y-%m-%d").date()
    with db() as (conn, cur):
        return _vv2.gun_planini_getir(cur, t, sube_id)


@app.put("/api/vardiya/v2/sube-gun-hedef")
def v2_sube_gun_hedef_kaydet(body: _V2SubeGunHedefIn):
    """Şube için seçilen güne hedef kişi sayısı (vardiya_sube_gun_hedef)."""
    from datetime import datetime as _dt
    t = _dt.strptime(body.tarih[:10], "%Y-%m-%d").date()
    with db() as (conn, cur):
        _vv2.sube_gun_hedef_kaydet(cur, body.sube_id, t, body.hedef_personel)
    return {"basarili": True}


@app.get("/api/vardiya/v2/hafta-personel-tablo")
def v2_hafta_personel_tablo(pazartesi: str):
    """Seçilen haftanın Pazartesi tarihi (veya hafta içi herhangi bir gün — sunucu Pazartesi’ye normalize eder)."""
    from datetime import datetime as _dt
    t = _dt.strptime(pazartesi[:10], "%Y-%m-%d").date()
    with db() as (conn, cur):
        return _vv2.hafta_personel_tablosu(cur, t)


@app.get("/api/vardiya/v2/hafta-sube-tablo")
def v2_hafta_sube_tablo(pazartesi: str):
    """Şube × hafta görünümü — her şube için 7 gün, her günde çalışan personel listesi."""
    from datetime import datetime as _dt
    t = _dt.strptime(pazartesi[:10], "%Y-%m-%d").date()
    with db() as (conn, cur):
        return _vv2.sube_haftalik_gorunum(cur, t)


@app.post("/api/vardiya/v2/motor/hafta-doldur")
def v2_motor_hafta_doldur(body: _MotorHaftaIn):
    """Haftalık plan motoru — eksik slotları önceliklendirir; doğrudan veya taşıma ile doldurur."""
    import vardiya_plan_motor as _vpm
    from datetime import datetime as _dt
    pzt = _dt.strptime(body.pazartesi[:10], "%Y-%m-%d").date()
    mr = max(15, min(int(body.max_rounds or 120), 400))
    with db() as (conn, cur):
        out = _vpm.hafta_otomatik_planla(
            cur,
            pazartesi_gun=pzt,
            max_rounds=mr,
            tasima_izni=bool(body.tasima_izni),
            kullanici_id=None,
            aciklama_etiketi="[Otomatik plan motoru]",
        )
        if getattr(body, "dry_run", False):
            conn.rollback()
            out["dry_run"] = True
            base = out.get("mesaj") or ""
            out["mesaj"] = base + " (dry-run — veritabanı geri alındı)"
    return out


@app.post("/api/vardiya/v2/atama/check")
def v2_atama_check(a: _V2AtamaIn):
    """Atama yapılmadan önce uyarıları döner — UI bunu çağırıp gösterir.

    Şube çerçevesi taşması (`slot_band_disinda`) uyarıdır; kritik blok listesinde yer almaz.
    Esas zamanlar istek gövdesindeki / önerilen atama başlangıç–bitişidir (`vardiya_v2` docstring).
    """
    from datetime import datetime as _dt
    t = _dt.strptime(a.tarih, "%Y-%m-%d").date()
    with db() as (conn, cur):
        uyarilar = _vv2.atama_uyarilari(
            cur, a.personel_id, a.slot_id, t,
            _t(a.baslangic_saat), _t(a.bitis_saat),
            otomatik_saat_cozumu=bool(a.otomatik_saat_cozumu),
        )
        gd = _vv2.personel_gun_durumu(cur, a.personel_id, t)
    has_cakisma = any(u.get("tip") == "cakisma" for u in uyarilar)
    # Override yalnızca çakışma dışı kritikler için; çakışma fiziksel blok (override edilemez).
    override_gerekir = any(
        u.get("seviye") == "kritik" and u.get("tip") != "cakisma" for u in uyarilar
    )
    return {
        "uyarilar": uyarilar,
        "kritik_var": any(u["seviye"] == "kritik" for u in uyarilar),
        "cakisma_var": has_cakisma,
        "override_gerekir": override_gerekir,
        "personel_gun": {
            "durum": gd.get("durum"),
            "kalan_saat": gd.get("kalan_saat"),
            "toplam_saat": gd.get("toplam_saat"),
            "max_gunluk_saat": gd.get("max_gunluk_saat", 9.0),
            "atama_sayisi": gd.get("atama_sayisi", 0),
        },
    }

@app.post("/api/vardiya/v2/atama")
def v2_atama_olustur(a: _V2AtamaIn):
    from datetime import datetime as _dt
    t = _dt.strptime(a.tarih, "%Y-%m-%d").date()
    with db() as (conn, cur):
        sonuc = _vv2.atama_olustur(
            cur, a.personel_id, a.slot_id, t,
            _t(a.baslangic_saat), _t(a.bitis_saat),
            override=a.override,
            aciklama=a.aciklama,
            otomatik_saat_cozumu=bool(a.otomatik_saat_cozumu),
            durum="onayli" if bool(a.kesinlestir) else "planli",
        )
        if not sonuc.get('basarili'):
            raise HTTPException(409, sonuc)
        return sonuc


@app.post("/api/vardiya/v2/assign")
def v2_assign(a: _V2AtamaIn):
    """Önce atama/check, sonra atama — spec’te sık geçen /assign ismi için POST alias (gövde /atama ile aynı)."""
    return v2_atama_olustur(a)


class _V2AtamaSerbestIn(BaseModel):
    """Serbest-saat atama: slot seçmeden, şube + özel saatle. Gün penceresi atamaya göre şekillenir."""
    personel_id: str
    sube_id: str
    tarih: str            # "YYYY-MM-DD"
    baslangic_saat: str   # "08:30"
    bitis_saat: str       # "01:30" → ertesi gün (gece otomatik)
    override: bool = False
    aciklama: Optional[str] = None
    kesinlestir: bool = False


@app.post("/api/vardiya/v2/serbest-slot-hazirla")
def v2_serbest_slot_hazirla():
    """Her aktif şubeye 'Serbest' satırı (slot) oluşturur/garantiler — kullanıcı slot
    kurmadan grid'de her şubede hazır bir satıra sürükleyip atayabilsin. İdempotent."""
    with db() as (conn, cur):
        cur.execute("SELECT id FROM subeler WHERE aktif=TRUE")
        sids = [dict(r)["id"] for r in (cur.fetchall() or [])]
        for sid in sids:
            _vv2.serbest_slot_getir_olustur(cur, sid)
    return {"success": True, "hazirlanan_sube": len(sids)}


@app.get("/api/vardiya/v2/iscilik-ozet")
def v2_iscilik_ozet(tarih: str):
    """Gün bazında işçilik maliyeti + ciro tahminine göre işçilik % (şube + toplam)."""
    from datetime import datetime as _dt
    t = _dt.strptime(tarih, "%Y-%m-%d").date()
    with db() as (conn, cur):
        return _vv2.iscilik_ozet(cur, t)


@app.post("/api/vardiya/v2/atama-serbest")
def v2_atama_serbest(a: _V2AtamaSerbestIn):
    """Slot kurma derdi olmadan serbest saatle atama. Şubenin 'Serbest' slot'unu
    otomatik kullanır/oluşturur; bitiş < başlangıç ise gece vardiyası otomatik."""
    from datetime import datetime as _dt
    t = _dt.strptime(a.tarih, "%Y-%m-%d").date()
    with db() as (conn, cur):
        slot_id = _vv2.serbest_slot_getir_olustur(cur, a.sube_id)
        sonuc = _vv2.atama_olustur(
            cur, a.personel_id, slot_id, t,
            _t(a.baslangic_saat), _t(a.bitis_saat),
            override=a.override,
            aciklama=a.aciklama,
            durum="onayli" if bool(a.kesinlestir) else "planli",
        )
        if not sonuc.get('basarili'):
            raise HTTPException(409, sonuc)
        return sonuc


@app.delete("/api/vardiya/v2/atama/{aid}")
def v2_atama_iptal(aid: str):
    with db() as (conn, cur):
        sonuc = _vv2.atama_iptal(cur, aid)
        if not sonuc.get('basarili'):
            raise HTTPException(404, sonuc.get('mesaj', 'Bulunamadı'))
        return sonuc


@app.post("/api/vardiya/v2/gun-temizle")
def v2_gun_temizle(tarih: str, sube_id: Optional[str] = None):
    """Bir günün tüm atamalarını iptal eder (opsiyonel: tek şube)."""
    from datetime import datetime as _dt
    t = _dt.strptime(tarih, "%Y-%m-%d").date()
    with db() as (conn, cur):
        return _vv2.gun_temizle(cur, t, sube_id)


@app.get("/api/vardiya/v2/hafta-personel-tablo")
def v2_hafta_personel_tablo(pazartesi: str):
    """Tulipi PDF formatında personel × 7 gün haftalık görünüm."""
    from datetime import datetime as _dt
    p = _dt.strptime(pazartesi, "%Y-%m-%d").date()
    # Pazartesi'ye normalize et
    p = p - timedelta(days=p.weekday())
    with db() as (conn, cur):
        return _vv2.personel_haftalik_gorunum(cur, p)


@app.post("/api/vardiya/v2/gun-kopyala")
def v2_gun_kopyala(kaynak: str, hedef: str,
                    sube_id: Optional[str] = None,
                    temizle: bool = True):
    """Kaynak günün atamalarını hedef güne kopyalar."""
    from datetime import datetime as _dt
    k = _dt.strptime(kaynak, "%Y-%m-%d").date()
    h = _dt.strptime(hedef, "%Y-%m-%d").date()
    with db() as (conn, cur):
        return _vv2.gun_kopyala(cur, k, h, sube_id, temizle)


@app.put("/api/vardiya/v2/personel-gun")
def v2_personel_gun_niyet(body: _V2PersonelGunNiyetIn):
    from datetime import datetime as _dt
    t = _dt.strptime(body.tarih, "%Y-%m-%d").date()
    with db() as (conn, cur):
        _vv2.personel_gun_niyet_kaydet(cur, body.personel_id, t, body.kasitli_bos)
        _vv2.personel_gun_durumu(cur, body.personel_id, t)
    return {"basarili": True}


@app.get("/api/vardiya/v2/gun-kilit")
def v2_gun_kilit_getir(tarih: str):
    from datetime import datetime as _dt
    t = _dt.strptime(tarih, "%Y-%m-%d").date()
    with db() as (conn, cur):
        return {"tarih": tarih, "kilitli": _vv2.gun_kilit_mi(cur, t)}


@app.put("/api/vardiya/v2/gun-kilit")
def v2_gun_kilit_kaydet(k: _V2GunKilitIn):
    from datetime import datetime as _dt
    t = _dt.strptime(k.tarih, "%Y-%m-%d").date()
    with db() as (conn, cur):
        _vv2.gun_kilit_kaydet(cur, t, k.kilitli, k.aciklama or "")
    return {"basarili": True}


# ── İZİN ──
@app.get("/api/vardiya/v2/izin")
def v2_izin_liste(personel_id: Optional[str] = None,
                  baslangic: Optional[str] = None,
                  bitis: Optional[str] = None):
    with db() as (conn, cur):
        sql = (
            "SELECT i.*, TRIM(COALESCE(p.ad_soyad, '')) AS _personel_full "
            "FROM personel_izin i JOIN personel p ON p.id=i.personel_id WHERE 1=1"
        )
        params: List = []
        if personel_id:
            sql += " AND i.personel_id = %s"; params.append(personel_id)
        if baslangic:
            sql += " AND i.bitis_tarih >= %s"; params.append(baslangic)
        if bitis:
            sql += " AND i.baslangic_tarih <= %s"; params.append(bitis)
        sql += " ORDER BY i.baslangic_tarih DESC"
        cur.execute(sql, tuple(params))
        izinler = []
        for r in cur.fetchall():
            d = dict(r)
            a, s = _vardiya_personel_ad_split(d.pop("_personel_full", None))
            d["personel_ad"] = a or "(isimsiz)"
            d["personel_soyad"] = s
            izinler.append(d)
        return {"izinler": izinler}


@app.get("/api/vardiya/v2/izin-hafta-ozet")
def v2_izin_hafta_ozet(pazartesi: str):
    """
    Seçilen tarihin ait olduğu ISO haftasında (Pzt–Paz) izin kaydı olmayan aktif personel listesi.
    `pazartesi` herhangi bir gün olabilir; haftanın Pazartesi’sine normalize edilir.
    """
    from datetime import datetime as _dt
    raw = _dt.strptime(pazartesi[:10], "%Y-%m-%d").date()
    mon = raw - timedelta(days=raw.weekday())
    with db() as (conn, cur):
        return _vv2.izin_hafta_ozet(cur, mon)


@app.post("/api/vardiya/v2/izin")
def v2_izin_ekle(i: _V2IzinIn):
    from datetime import datetime as _dt
    iid = str(uuid.uuid4())
    d1 = _dt.strptime(i.baslangic_tarih[:10], "%Y-%m-%d").date()
    d2 = _dt.strptime(i.bitis_tarih[:10], "%Y-%m-%d").date()
    if d2 < d1:
        raise HTTPException(400, "Bitiş tarihi başlangıçtan önce olamaz.")
    with db() as (conn, cur):
        if not bool(i.force):
            cak = _vv2.personel_izin_baska_ayni_iso_haftada(cur, i.personel_id, d1, d2)
            if cak:
                parcalar = []
                for x in cak[:4]:
                    parcalar.append(
                        f"{x.get('baslangic_tarih')} → {x.get('bitis_tarih')} ({x.get('tip') or '?'})"
                    )
                ozet = " | ".join(parcalar)
                if len(cak) > 4:
                    ozet += f" (+{len(cak) - 4} kayıt daha)"
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Bu personel için aynı takvim haftasında (Pzt–Paz) zaten izin kaydı var. "
                        "Bu hafta içinde tekrar izin tanımlıyorsunuz; yasal planlamada çift kayıt oluşmaması için "
                        "önce mevcut kaydı düzenleyin veya silin. Mevcut: "
                        + ozet
                        + " Yine de eklemek için gövdede «force»: true gönderin."
                    ),
                )
        cur.execute("""
            INSERT INTO personel_izin
                (id, personel_id, baslangic_tarih, bitis_tarih, tip, aciklama)
            VALUES (%s,%s,%s,%s,%s,%s)
        """, (iid, i.personel_id, i.baslangic_tarih, i.bitis_tarih,
              i.tip, i.aciklama))
        _vv2.personel_gun_state_yenile_tarih_araligi(cur, i.personel_id, d1, d2)
    return {"id": iid}

@app.delete("/api/vardiya/v2/izin/{iid}")
def v2_izin_sil(iid: str):
    with db() as (conn, cur):
        cur.execute(
            "SELECT personel_id, baslangic_tarih, bitis_tarih FROM personel_izin WHERE id = %s",
            (iid,),
        )
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "İzin bulunamadı")
        pid = r["personel_id"]
        d1 = r["baslangic_tarih"]
        d2 = r["bitis_tarih"]
        cur.execute("DELETE FROM personel_izin WHERE id = %s", (iid,))
        if cur.rowcount == 0:
            raise HTTPException(404, "İzin bulunamadı")
        _vv2.personel_gun_state_yenile_tarih_araligi(cur, pid, d1, d2)
    return {"basarili": True}


# ── RAPORLAR (Aşama 7) ──
@app.get("/api/vardiya/v2/rapor/fazla-mesai")
def v2_rapor_fazla_mesai(
    baslangic: str,
    bitis: str,
    limit: int = 500,
):
    from datetime import datetime as _dt
    d1 = _dt.strptime(baslangic[:10], "%Y-%m-%d").date()
    d2 = _dt.strptime(bitis[:10], "%Y-%m-%d").date()
    with db() as (conn, cur):
        return _vv2.rapor_fazla_mesai(cur, d1, d2, limit=limit)


@app.get("/api/vardiya/v2/rapor/izinli-calisti")
def v2_rapor_izinli_calisti(
    baslangic: str,
    bitis: str,
    limit: int = 500,
):
    from datetime import datetime as _dt
    d1 = _dt.strptime(baslangic[:10], "%Y-%m-%d").date()
    d2 = _dt.strptime(bitis[:10], "%Y-%m-%d").date()
    with db() as (conn, cur):
        return _vv2.rapor_izinli_calisti(cur, d1, d2, limit=limit)


# ── PRESET (TAM/PART/ARACI/AÇILIŞ/KAPANIŞ) ──
class _V2PresetIn(BaseModel):
    kod: str
    ad: str
    bas_saat: str
    bit_saat: str
    gece_vardiyasi: bool = False
    renk: Optional[str] = None
    sira: int = 0
    aktif: bool = True


@app.get("/api/vardiya/v2/preset")
def v2_preset_listele():
    with db() as (conn, cur):
        return {"presetler": _vv2.vardiya_preset_listele(cur)}


@app.get("/api/vardiya/v2/preset-admin")
def v2_preset_admin_liste():
    """Tüm preset satırları (pasif dahil) — sistem yönetimi ekranı."""
    with db() as (conn, cur):
        return {"presetler": _vv2.vardiya_preset_listele_hepsi(cur)}


@app.post("/api/vardiya/v2/preset")
def v2_preset_kaydet(p: _V2PresetIn):
    with db() as (conn, cur):
        cur.execute("""
            INSERT INTO vardiya_preset (kod, ad, bas_saat, bit_saat, gece_vardiyasi, renk, sira, aktif)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (kod) DO UPDATE SET
                ad = EXCLUDED.ad,
                bas_saat = EXCLUDED.bas_saat,
                bit_saat = EXCLUDED.bit_saat,
                gece_vardiyasi = EXCLUDED.gece_vardiyasi,
                renk = EXCLUDED.renk,
                sira = EXCLUDED.sira,
                aktif = EXCLUDED.aktif
        """, (p.kod, p.ad, _t(p.bas_saat), _t(p.bit_saat), p.gece_vardiyasi,
              p.renk, p.sira, p.aktif))
    return {"basarili": True}


@app.delete("/api/vardiya/v2/preset/{kod}")
def v2_preset_sil(kod: str):
    with db() as (conn, cur):
        cur.execute("UPDATE vardiya_preset SET aktif = FALSE WHERE kod = %s", (kod,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Preset bulunamadı")
    return {"basarili": True}


@app.get("/api/vardiya/v2/personel-onerilen-saat")
def v2_personel_onerilen_saat(
    personel_id: str,
    tarih: str,
    slot_id: Optional[str] = None,
):
    """
    Personelin verilen tarih için önerilen vardiya saatini döner.
    Öncelik: personel gün preset (vardiya_preset_json) → yoksa slot + günlük limit ile mesai bandı
    (tam/part ayrımı yok; uzun slotlarda tam gün varsayılmaz).
    `slot_id` verilmezse yalnızca JSON preset dönebilir.
    """
    from datetime import datetime as _dt
    t = _dt.strptime(tarih, "%Y-%m-%d").date()
    with db() as (conn, cur):
        preset = _vv2.personel_gun_preset(cur, personel_id, t)
        kaynak = "personel_json" if preset else None
        if not preset and slot_id:
            preset = _vv2.slot_mesai_onerilen_saat(cur, personel_id, t, slot_id)
            if preset:
                kaynak = "mesai_slot"
        return {"preset": preset, "tarih": tarih, "kaynak": kaynak}


@app.get("/api/vardiya/v2/personel-kisit-serbest-saat")
def v2_personel_kisit_serbest_saat(
    personel_id: str,
    tarih: str,
    slot_id: Optional[str] = None,
):
    """
    Personelin o gün ders/kısıt saatlerinin dışındaki ilk uygun zaman dilimini döner.
    slot_id verilirse yalnızca o slot'un saat çerçevesi içinde arar.
    Dönüş: {bas_saat, bit_saat, kisit_var, yasaklar[], mesaj}
    """
    from datetime import datetime as _dt
    t = _dt.strptime(tarih, "%Y-%m-%d").date()
    with db() as (conn, cur):
        cur.execute(
            "SELECT gun_saat_kisitlari_json FROM personel_kisit WHERE personel_id = %s",
            (personel_id,),
        )
        row = cur.fetchone()
        gsk = (row["gun_saat_kisitlari_json"] if row else {}) or {}
        if isinstance(gsk, str):
            import json as _json
            try:
                gsk = _json.loads(gsk)
            except Exception:
                gsk = {}

        gun_kisa = _vv2.GUN_KISALTMA[t.weekday()]
        yasak_listesi = gsk.get(gun_kisa) or []

        arama_bas_t = _vv2._parse_saat_metni("08:00")
        arama_bit_t = _vv2._parse_saat_metni("22:00")
        if slot_id:
            cur.execute(
                "SELECT baslangic_saat, bitis_saat FROM vardiya_slot WHERE id = %s",
                (slot_id,),
            )
            sr = cur.fetchone()
            if sr and sr["baslangic_saat"] and sr["bitis_saat"]:
                arama_bas_t = sr["baslangic_saat"]
                arama_bit_t = sr["bitis_saat"]

        def _to_min(tt):
            return tt.hour * 60 + tt.minute

        def _to_str(m):
            return f"{m // 60:02d}:{m % 60:02d}"

        yasaklar = []
        for ys in yasak_listesi:
            yb = _vv2._parse_saat_metni(ys.get("yasak_bas"))
            yt = _vv2._parse_saat_metni(ys.get("yasak_bit"))
            if yb and yt:
                yasaklar.append({"bas": yb, "bit": yt, "neden": ys.get("neden", "Kısıt")})
        yasaklar.sort(key=lambda x: x["bas"])
        yasak_out = [{"neden": y["neden"], "bas": str(y["bas"]), "bit": str(y["bit"])} for y in yasaklar]

        if not yasaklar:
            return {
                "bas_saat": str(arama_bas_t),
                "bit_saat": str(arama_bit_t),
                "kisit_var": False,
                "yasaklar": [],
                "mesaj": "Bu gün için kısıt tanımlı değil.",
            }

        r_bas = _to_min(arama_bas_t)
        r_bit = _to_min(arama_bit_t)
        current = r_bas

        for ys in yasaklar:
            yb = _to_min(ys["bas"])
            yt = _to_min(ys["bit"])
            if yt <= current:
                continue
            if yb > current:
                free_end = min(yb, r_bit)
                if free_end > current:
                    return {
                        "bas_saat": _to_str(current),
                        "bit_saat": _to_str(free_end),
                        "kisit_var": True,
                        "yasaklar": yasak_out,
                        "mesaj": f"Kısıt başlamadan önceki serbest dilim önerildi ({_to_str(current)}–{_to_str(free_end)}).",
                    }
            current = max(current, yt)

        if current < r_bit:
            return {
                "bas_saat": _to_str(current),
                "bit_saat": _to_str(r_bit),
                "kisit_var": True,
                "yasaklar": yasak_out,
                "mesaj": f"Kısıtlar bittikten sonraki serbest dilim önerildi ({_to_str(current)}–{_to_str(r_bit)}).",
            }

        return {
            "bas_saat": None,
            "bit_saat": None,
            "kisit_var": True,
            "yasaklar": yasak_out,
            "mesaj": "Bu gün tüm saatler kısıtlı — uygun boş dilim bulunamadı.",
        }


# ── OVERRIDE LOG ──
@app.get("/api/vardiya/v2/override-log")
def v2_override_log_liste(limit: int = 100, personel_id: Optional[str] = None):
    with db() as (conn, cur):
        sql = (
            "SELECT o.*, TRIM(COALESCE(p.ad_soyad, '')) AS _personel_full "
            "FROM vardiya_override_log o LEFT JOIN personel p ON p.id=o.personel_id "
            "WHERE 1=1"
        )
        params: List = []
        if personel_id:
            sql += " AND o.personel_id = %s"; params.append(personel_id)
        sql += " ORDER BY o.ts DESC LIMIT %s"
        params.append(min(max(int(limit), 1), 1000))
        cur.execute(sql, tuple(params))
        kayitlar = []
        for r in cur.fetchall():
            d = dict(r)
            a, s = _vardiya_personel_ad_split(d.pop("_personel_full", None))
            d["personel_ad"] = a or "(isimsiz)"
            d["personel_soyad"] = s
            kayitlar.append(d)
        return {"kayitlar": kayitlar}


# Frontend
if pathlib.Path("static/index.html").exists():
    from fastapi.responses import FileResponse
    from fastapi import Request as _Req

    # assets önce mount edilmeli — wildcard route kapmadan
    app.mount("/assets", StaticFiles(directory="static/assets"), name="assets")

    _idx_path = pathlib.Path("static/index.html")
    _spa_headers = {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
    }

    @app.get("/admin")
    @app.get("/admin/{admin_path:path}")
    async def serve_admin_spa(admin_path: str = ""):
        _ = admin_path
        if _idx_path.exists():
            return FileResponse(str(_idx_path), headers=_spa_headers)
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": "Frontend not built"}, status_code=404)

    @app.get("/")
    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str = "", request: _Req = None):
        """SPA routing — index.html'i her zaman no-cache ile sun"""
        import pathlib as _pl
        if full_path.startswith("api/") or full_path.startswith("assets/"):
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": "Not found"}, status_code=404)
        if _idx_path.exists():
            return FileResponse(str(_idx_path), headers=_spa_headers)
        return JSONResponse({"detail": "Frontend not built"}, status_code=404)
