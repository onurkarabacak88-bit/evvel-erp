import logging
import time
import traceback
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi import Request
from pydantic import BaseModel
from typing import Optional
from datetime import date, timedelta
import uuid, os, json, pathlib, calendar, threading
from database import db, init_db
from vardiya_motor import vardiya_motoru_calistir


def ay_ekle(d: date, ay: int) -> date:
    """dateutil.relativedelta gerektirmeden tarihe ay ekler. Ay sonu taşmalarını düzeltir."""
    yil = d.year + (d.month - 1 + ay) // 12
    ay_no = (d.month - 1 + ay) % 12 + 1
    gun = min(d.day, calendar.monthrange(yil, ay_no)[1])
    return date(yil, ay_no, gun)
from motors import karar_motoru, odeme_strateji_motoru, nakit_akis_simulasyon, guncel_kasa, kasa_detay, kasa_detay_debug, kart_analiz_hesapla, aylik_odeme_plani_uret, uyari_motoru, finans_ozet_motoru
from finans_core import (
    kart_borc, kasa_bakiyesi, kasa_bakiyesi_tarihte,
    kart_ekstre, kart_bu_ay_odenen, kart_faiz_tahmini,
    faiz_hesapla_ve_yaz, tum_kartlar_faiz_hesapla,
    taksit_detay, gelecek_taksit_yuku, tum_kartlar_taksit_yuku,
    aktif_kesim_gunu,
)

app = FastAPI(title="EVVEL ERP", version="2.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

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
    logger.error(f"HATA: {request.url.path}\n{traceback.format_exc()}")
    return JSONResponse(
        status_code=500,
        content={"detail": "Bir hata oluştu. Railway loglarına bakın."}
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
            simdi = date.today()

            # Bir sonraki gece yarısına kadar bekle
            import datetime as _dt
            yarin = _dt.datetime.combine(simdi + timedelta(days=1), _dt.time.min)
            bekle = (yarin - _dt.datetime.now()).total_seconds()
            _time.sleep(max(bekle, 60))  # en az 60 saniye

            bugun = date.today()
            ay_son_gun = calendar.monthrange(bugun.year, bugun.month)[1]

            # Ay başı — yeni ödeme planı
            if bugun.day == 1:
                try:
                    sonuc = aylik_odeme_plani_uret(bugun.year, bugun.month)
                    logger.info(f"⏰ Scheduler: Aylık plan üretildi — {sonuc.get('toplam', 0)} kayıt")
                except Exception as e:
                    logger.error(f"⏰ Scheduler plan hatası: {e}")

            # Ay sonu — faiz hesapla
            if bugun.day == ay_son_gun:
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

        except Exception as e:
            logger.error(f"⏰ Scheduler genel hata: {e}")
            import time as _t
            _t.sleep(300)  # hata olursa 5 dakika bekle, tekrar dene

@app.on_event("startup")
def startup():
    init_db()
    # Her başlatmada bu ay için plan üret (yoksa üretir, varsa atlar)
    bugun = date.today()
    try:
        sonuc = aylik_odeme_plani_uret(bugun.year, bugun.month)
        if sonuc['toplam'] > 0:
            logger.info(f"✅ Aylık ödeme planı üretildi: {sonuc['toplam']} kayıt")
        else:
            logger.info(f"ℹ️ Bu ay için ödeme planı zaten mevcut")
    except Exception as e:
        logger.error(f"Ödeme planı üretim hatası: {e}")
    # Ay sonu faiz üretimi — ay son günü çalışır (tek entry point: faiz_hesapla_ve_yaz)
    import calendar
    son_gun = calendar.monthrange(bugun.year, bugun.month)[1]
    if bugun.day == son_gun:
        try:
            with db() as (conn, cur):
                sonuclar = tum_kartlar_faiz_hesapla(cur)
            yazilan = sum(1 for k in sonuclar if k.get('durum') == 'yazildi')
            if yazilan > 0:
                logger.info(f"✅ Ekstre faizi üretildi: {yazilan} kart")
        except Exception as e:
            logger.warning(f"Faiz üretim hatası: {e}")

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

    # Scheduler başlat — restart bağımlılığını kaldırır
    _scheduler_thread = threading.Thread(target=_gece_yarisi_scheduler, daemon=True)
    _scheduler_thread.start()
    logger.info("✅ Gece yarısı scheduler başlatıldı")

# Tüm kasa işlem tipleri — bilinmeyen tip default true alır (güvenli)
KASA_ETKISI_MAP = {
    'CIRO': True, 'CIRO_IPTAL': True,
    'DIS_KAYNAK': True, 'DIS_KAYNAK_IPTAL': True,
    'ANLIK_GIDER': True, 'ANLIK_GIDER_IPTAL': True,
    'KART_ODEME': True, 'KART_ODEME_IPTAL': True, 'KART_FAIZ': True,
    'VADELI_ODEME': True, 'VADELI_IPTAL': True,
    'PERSONEL_MAAS': True, 'SABIT_GIDER': True,
    'BORC_TAKSIT': True, 'FATURA_ODEMESI': True,
    'ODEME_PLANI': False, 'ODEME_IPTAL': False,
    'KASA_GIRIS': True, 'KASA_DUZELTME': True, 'POS_KESINTI': True,
    'ONLINE_KESINTI': True, 'KISMI_ODE': True,
    'DEVIR': False,
}

def insert_kasa_hareketi(cur, tarih, islem_turu, tutar, aciklama,
                        kaynak_tablo=None, kaynak_id=None, ref_id=None, ref_type=None):
    """
    Merkezi kasa yazma fonksiyonu.
    - kaynak_id = business ID (gider_id, ciro_id vb.) — değişmez
    - ref_id    = ledger event ID — her yazımda benzersiz
    - kasa_etkisi = KASA_ETKISI_MAP'ten — DEVIR hariç hepsi true
    """
    _event_id = ref_id or str(uuid.uuid4())
    _ref_type = ref_type or (kaynak_tablo.upper() if kaynak_tablo else 'GENEL')
    _kasa_etkisi = KASA_ETKISI_MAP.get(islem_turu, True)

    cur.execute("""
        INSERT INTO kasa_hareketleri
            (id, tarih, islem_turu, tutar, aciklama, kaynak_tablo, kaynak_id, ref_id, ref_type, kasa_etkisi)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """, (str(uuid.uuid4()), str(tarih), islem_turu, tutar, aciklama,
          kaynak_tablo, kaynak_id, _event_id, _ref_type, _kasa_etkisi))

    if cur.rowcount == 0:
        raise Exception(f"KASA YAZILMADI — {islem_turu} / {kaynak_id}")

# Kasa etkisi mapping — her iptal tipi dahil, bilinmeyen tip sistemi durdurur
KASA_IPTAL_MAP = {
    'ANLIK_GIDER_IPTAL':  True,
    'CIRO_IPTAL':         True,
    'DIS_KAYNAK_IPTAL':   True,
    'KART_ODEME_IPTAL':   True,
    'VADELI_IPTAL':       True,
    'ODEME_IPTAL':        True,
}

def iptal_kasa_hareketi(cur, kaynak_id, kaynak_tablo, islem_turu,
                        iptal_turu, aciklama):
    """
    Merkezi kasa iptal fonksiyonu.
    KURAL 1: Olmayan şey iptal edilemez (durum filtresi YOK — kasa_etkisi bazlı)
    KURAL 2: Aynı şey iki kez iptal edilemez
    KURAL 3: Her hareketin karşılığı vardır + kasa_etkisi zorunlu
    """
    # KURAL 1: Sadece AKTİF kayıtları al — iptal edilmişleri tekrar işleme
    cur.execute("""
        SELECT id, tutar FROM kasa_hareketleri
        WHERE kaynak_id=%s AND islem_turu=%s AND kasa_etkisi=true AND durum='aktif'
    """, (kaynak_id, islem_turu))
    mevcutlar = cur.fetchall()
    if not mevcutlar:
        raise Exception(f"İptal edilecek kayıt bulunamadı — {islem_turu} / {kaynak_id}")

    # KURAL 2: Daha önce iptal edilmiş mi?
    cur.execute("""
        SELECT 1 FROM kasa_hareketleri
        WHERE kaynak_id=%s AND islem_turu=%s
        LIMIT 1
    """, (kaynak_id, iptal_turu))
    if cur.fetchone():
        raise Exception(f"Bu kayıt zaten iptal edilmiş — {iptal_turu} / {kaynak_id}")

    # UI için eski kayıtları pasifleştir (kasa hesabını etkilemez)
    for m in mevcutlar:
        cur.execute("UPDATE kasa_hareketleri SET durum='iptal' WHERE id=%s", (m['id'],))

    # Net tutarı hesapla
    net_tutar = sum(float(m['tutar']) for m in mevcutlar)

    # KURAL 3: Ters kayıt yaz — kasa_etkisi zorunlu
    _kasa_etkisi = KASA_IPTAL_MAP.get(iptal_turu, True)
    cur.execute("""
        INSERT INTO kasa_hareketleri
            (id, tarih, islem_turu, tutar, aciklama, kaynak_tablo, kaynak_id, ref_id, ref_type, kasa_etkisi)
        VALUES (%s, CURRENT_DATE, %s, %s, %s, %s, %s, %s, %s, %s)
    """, (str(uuid.uuid4()), iptal_turu, -net_tutar, aciklama,
          kaynak_tablo, kaynak_id, str(uuid.uuid4()), kaynak_tablo.upper(), _kasa_etkisi))

    if cur.rowcount == 0:
        raise Exception(f"İptal kaydı yazılamadı — {iptal_turu} / {kaynak_id}")

def vadeli_alim_kapat(cur, vadeli_id: str, tarih: str):
    """
    Merkezi vadeli alım kapatma fonksiyonu.
    Nereden onaylanırsa onaylansın (onay kuyruğu / vadeli alımlar / ödeme planı)
    bu fonksiyon çağrılır — 3 tabloyu atomik kapatır, çift düşmeyi engeller.
    KURAL: Zaten 'odendi' ise sessizce geçer (idempotent).
    """
    # 1. vadeli_alimlar → odendi
    cur.execute(
        "UPDATE vadeli_alimlar SET durum='odendi' WHERE id=%s AND durum='bekliyor'",
        (vadeli_id,)
    )
    # 2. Tüm bağlı odeme_plani kayıtları → odendi
    cur.execute("""
        UPDATE odeme_plani
        SET durum='odendi', odeme_tarihi=%s
        WHERE kaynak_tablo='vadeli_alimlar' AND kaynak_id=%s
        AND durum IN ('bekliyor','onay_bekliyor')
    """, (tarih, vadeli_id))
    # 3. Tüm bağlı onay_kuyrugu kayıtları → onaylandi
    cur.execute("""
        UPDATE onay_kuyrugu
        SET durum='onaylandi', onay_tarihi=NOW()
        WHERE kaynak_tablo='vadeli_alimlar' AND kaynak_id=%s
        AND durum='bekliyor'
    """, (vadeli_id,))
    # 4. odeme_plani id'si üzerinden açık kalmış onay kayıtlarını da kapat
    cur.execute("""
        UPDATE onay_kuyrugu
        SET durum='onaylandi', onay_tarihi=NOW()
        WHERE kaynak_id IN (
            SELECT id FROM odeme_plani
            WHERE kaynak_tablo='vadeli_alimlar' AND kaynak_id=%s
        )
        AND durum='bekliyor'
    """, (vadeli_id,))


def audit(cur, tablo, kayit_id, islem, eski=None, yeni=None):
    def safe_json(d):
        if not d: return None
        return json.dumps({k: str(v) if not isinstance(v, (str, int, float, bool, type(None))) else v 
                          for k, v in dict(d).items()})
    cur.execute("""INSERT INTO audit_log (id,tablo,kayit_id,islem,eski_deger,yeni_deger)
        VALUES (%s,%s,%s,%s,%s,%s)""",
        (str(uuid.uuid4()), tablo, kayit_id, islem,
         safe_json(eski), safe_json(yeni)))

def onay_ekle(cur, islem_turu, kaynak_tablo, kaynak_id, aciklama, tutar, tarih):
    cur.execute("""INSERT INTO onay_kuyrugu (id,islem_turu,kaynak_tablo,kaynak_id,aciklama,tutar,tarih)
        VALUES (%s,%s,%s,%s,%s,%s,%s)""",
        (str(uuid.uuid4()), islem_turu, kaynak_tablo, kaynak_id, aciklama, tutar, tarih))

# ── PANEL ──────────────────────────────────────────────────────

# ── AY DEVİR (HESAPLANAN — ledger'a yazılmaz) ──────────────────
def devir_hesapla(yil: int = None, ay: int = None):
    """
    Geçen ayın kapanış kasasını hesaplar.
    Ledger'a hiçbir şey yazılmaz — immutable model korunur.
    """
    import calendar
    bugun = date.today()
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

@app.get("/api/panel")
def panel():
    try:
        # Bu ay için referans_ay bazlı kontrol — ertele yapılsa bile aynı ay tekrar üretilmez
        with db() as (conn, cur):
            # Sabit gider planı eksik mi?
            cur.execute("""
                SELECT COUNT(*) as eksik FROM sabit_giderler sg
                WHERE sg.aktif = TRUE AND (sg.tip IS NULL OR sg.tip = 'sabit')
                AND NOT EXISTS (
                    SELECT 1 FROM odeme_plani op
                    WHERE op.kaynak_tablo = 'sabit_giderler'
                    AND op.kaynak_id = sg.id
                    AND op.durum != 'iptal'
                    AND op.referans_ay = DATE_TRUNC('month', CURRENT_DATE)
                )
            """)
            eksik_sabit = cur.fetchone()['eksik']

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
                    AND DATE_TRUNC('month', op.tarih) = DATE_TRUNC('month', CURRENT_DATE)
                )
            """)
            eksik_borc = cur.fetchone()['eksik']

            # Kart asgari ödeme planı eksik mi? (borcu olan aktif kartlar)
            cur.execute("""
                SELECT COUNT(*) as eksik FROM kartlar k
                WHERE k.aktif = TRUE
                AND (
                    SELECT COALESCE(SUM(
                        CASE WHEN kh.islem_turu IN ('HARCAMA','FAIZ') THEN kh.tutar
                             WHEN kh.islem_turu='ODEME' THEN -kh.tutar ELSE 0 END
                    ), 0) FROM kart_hareketleri kh
                    WHERE kh.kart_id = k.id AND kh.durum = 'aktif'
                ) > 0
                AND NOT EXISTS (
                    SELECT 1 FROM odeme_plani op
                    WHERE op.kart_id = k.id
                    AND op.durum != 'iptal'
                    AND DATE_TRUNC('month', op.tarih) = DATE_TRUNC('month', CURRENT_DATE)
                )
            """)
            eksik_kart = cur.fetchone()['eksik']
            # Sürekli personel maaş planı eksik mi?
            cur.execute("""
                SELECT COUNT(*) as eksik FROM personel p
                WHERE p.aktif=TRUE AND p.calisma_turu='surekli'
                AND NOT EXISTS (
                    SELECT 1 FROM odeme_plani op
                    WHERE op.kaynak_tablo='personel'
                    AND op.kaynak_id = p.id::text
                    AND op.durum != 'iptal'
                    AND DATE_TRUNC('month', op.tarih) = DATE_TRUNC('month', CURRENT_DATE)
                )
            """)
            eksik_personel = cur.fetchone()['eksik']
            eksik_plan = eksik_sabit + eksik_borc + eksik_kart + eksik_personel

        if eksik_plan > 0:
            aylik_odeme_plani_uret()

        ozet = finans_ozet_motoru()
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

            # BU AY TOPLAM KASA ÇIKIŞI — tüm negatif hareketlerin toplamı (tek kaynak)
            cur.execute("""
                SELECT COALESCE(SUM(ABS(tutar)), 0) as toplam_cikis
                FROM kasa_hareketleri
                WHERE kasa_etkisi = true AND durum = 'aktif' AND tutar < 0
                AND EXTRACT(YEAR  FROM tarih) = EXTRACT(YEAR  FROM CURRENT_DATE)
                AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
            """)
            ozet['bu_ay_toplam_cikis'] = float(cur.fetchone()['toplam_cikis'])

            # BU AY TOPLAM KASA GİRİŞİ — tüm pozitif hareketlerin toplamı
            cur.execute("""
                SELECT COALESCE(SUM(tutar), 0) as toplam_giris
                FROM kasa_hareketleri
                WHERE kasa_etkisi = true AND durum = 'aktif' AND tutar > 0
                AND EXTRACT(YEAR  FROM tarih) = EXTRACT(YEAR  FROM CURRENT_DATE)
                AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM CURRENT_DATE)
            """)
            ozet['bu_ay_toplam_giris'] = float(cur.fetchone()['toplam_giris'])

            # NET (gelir - gider)
            ozet['bu_ay_net'] = ozet['bu_ay_toplam_giris'] - ozet['bu_ay_toplam_cikis']

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
def dis_kaynak_listele():
    with db() as (conn, cur):
        cur.execute("""SELECT * FROM kasa_hareketleri
            WHERE islem_turu='DIS_KAYNAK' AND durum='aktif'
            ORDER BY tarih DESC LIMIT 200""")
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
    bugun = __import__('datetime').date.today()
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
def anlik_gider_listele():
    with db() as (conn, cur):
        cur.execute("""
            SELECT ag.*, k.kart_adi, k.banka
            FROM anlik_giderler ag
            LEFT JOIN kartlar k ON k.id = ag.kart_id
            WHERE ag.durum='aktif' ORDER BY ag.tarih DESC LIMIT 200
        """)
        return [dict(r) for r in cur.fetchall()]

@app.post("/api/anlik-gider")
def anlik_gider_ekle(g: AnlikGider):
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
            cur.execute("SELECT * FROM kartlar WHERE id=%s AND aktif=TRUE", (g.kart_id,))
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

    # Transaction dışında — kendi bağlantısını açar
    if g.odeme_yontemi == 'kart':
        kart_plan_guncelle()

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
    faiz_orani: float = 0.0
    asgari_oran: float = 40.0  # Bankanın asgari ödeme oranı (%)

@app.get("/api/kartlar")
def kartlar_listele():
    with db() as (conn, cur):
        cur.execute("SELECT * FROM kartlar WHERE aktif=TRUE ORDER BY banka")
        kartlar = [dict(r) for r in cur.fetchall()]
        sonuc = []
        bugun = date.today()
        for k in kartlar:
            # ── CORE HESAPLAR ──────────────────────────────────
            borc     = kart_borc(cur, k['id'])
            ekstre_v = kart_ekstre(cur, k['id'], k['kesim_gunu'])
            bu_ekstre    = ekstre_v["ekstre_toplam"]
            aylik_taksit = ekstre_v["aylik_taksit"]

            # Gelecek ekstre: kesim gününden sonraki tek çekim + devam eden taksitler
            cur.execute("""SELECT COALESCE(SUM(tutar),0) as gelecek
                FROM kart_hareketleri
                WHERE kart_id=%s AND durum='aktif' AND islem_turu='HARCAMA'
                AND taksit_sayisi=1
                AND EXTRACT(DAY FROM tarih) > %s""", (k['id'], k['kesim_gunu']))
            gelecek_tek = float(cur.fetchone()['gelecek'])
            gelecek_ekstre = gelecek_tek + aylik_taksit

            limit = float(k['limit_tutar'])
            son_odeme_gun = k['son_odeme_gunu']
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
                "asgari_odeme": bu_ekstre * 0.2,
                "bu_ekstre": bu_ekstre,
                "gelecek_ekstre": gelecek_ekstre,
                "aylik_taksit": aylik_taksit,
                "gun_kaldi": gun_kaldi,
                "son_odeme_tarihi": str(son_odeme),
                "blink": gun_kaldi <= 0 and yaklasan is not None,
                "yaklasan_odeme": dict(yaklasan) if yaklasan else None
            })
        return sonuc

@app.post("/api/kartlar")
def kart_ekle(k: KartModel):
    with db() as (conn, cur):
        kid = str(uuid.uuid4())
        cur.execute("""INSERT INTO kartlar (id,kart_adi,banka,limit_tutar,kesim_gunu,son_odeme_gunu,faiz_orani,asgari_oran)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
            (kid, k.kart_adi, k.banka, k.limit_tutar, k.kesim_gunu, k.son_odeme_gunu, k.faiz_orani, k.asgari_oran))
        audit(cur, 'kartlar', kid, 'INSERT')
    return {"id": kid, "success": True}

@app.put("/api/kartlar/{kid}")
def kart_guncelle(kid: str, k: KartModel):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM kartlar WHERE id=%s", (kid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)
        cur.execute("""UPDATE kartlar SET kart_adi=%s,banka=%s,limit_tutar=%s,
            kesim_gunu=%s,son_odeme_gunu=%s,faiz_orani=%s WHERE id=%s""",
            (k.kart_adi, k.banka, k.limit_tutar, k.kesim_gunu, k.son_odeme_gunu, k.faiz_orani, kid))
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
        cur.execute("""INSERT INTO kart_hareketleri
            (id,kart_id,tarih,islem_turu,tutar,taksit_sayisi,faiz_tutari,ana_para,aciklama,baslangic_tarihi)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (hid, h.kart_id, h.tarih, h.islem_turu, h.tutar,
             h.taksit_sayisi, faiz, ana, h.aciklama, bas_tarih))
        if h.islem_turu == 'ODEME':
            onay_ekle(cur, 'KART_ODEME', 'kart_hareketleri', hid,
                f"Kart ödemesi: {h.aciklama or ''}", h.tutar, h.tarih)
        audit(cur, 'kart_hareketleri', hid, 'INSERT')
    # HARCAMA veya ODEME → borç değişti → plan güncelle
    if h.islem_turu in ('HARCAMA', 'ODEME', 'FAIZ'):
        kart_plan_guncelle()
    return {"id": hid, "success": True}

@app.delete("/api/kart-hareketleri/{hid}")
def kart_hareket_iptal(hid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM kart_hareketleri WHERE id=%s AND durum='aktif'", (hid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404, "Kayıt bulunamadı veya zaten iptal edilmiş")
        cur.execute("UPDATE kart_hareketleri SET durum='iptal' WHERE id=%s", (hid,))
        # Immutable model: pasifleştir + ters kayıt (kart ödeme varsa)
        iptal_kasa_hareketi(cur, hid, 'kart_hareketleri', 'KART_ODEME', 'KART_ODEME_IPTAL', 'Kart hareketi iptali')
        audit(cur, 'kart_hareketleri', hid, 'IPTAL', eski=eski)
    return {"success": True}

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

@app.get("/api/odeme-plani/{oid}/kaynak")
def odeme_plani_kaynak(oid: str):
    """Panel'in vadeli alım kart önerisi için kaynak_tablo ve kaynak_id döner."""
    with db() as (conn, cur):
        cur.execute("SELECT kaynak_tablo, kaynak_id FROM odeme_plani WHERE id=%s", (oid,))
        row = cur.fetchone()
        if not row: raise HTTPException(404)
        return {"kaynak_tablo": row['kaynak_tablo'], "kaynak_id": row['kaynak_id']}

@app.get("/api/odeme-plani")
def odeme_plani_listele():
    with db() as (conn, cur):
        cur.execute("""SELECT op.*, k.banka, k.kart_adi, k.faiz_orani FROM odeme_plani op
            JOIN kartlar k ON k.id=op.kart_id
            WHERE op.tarih >= CURRENT_DATE - INTERVAL '30 days'
            ORDER BY op.tarih ASC""")
        return [dict(r) for r in cur.fetchall()]

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

@app.post("/api/odeme-plani/{oid}/ode")
def odeme_yap(oid: str, tutar: Optional[float] = None, body: VadeliOdeModel = VadeliOdeModel()):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM odeme_plani WHERE id=%s", (oid,))
        plan = cur.fetchone()
        if not plan: raise HTTPException(404)
        if plan['durum'] == 'odendi': raise HTTPException(400, "Zaten ödendi")

        # KART seçildiyse ve kaynak vadeli_alimlar ise kart akışına yönlendir
        if body.odeme_yontemi == 'kart' and body.kart_id and plan.get('kaynak_tablo') == 'vadeli_alimlar':
            bugun = str(date.today())
            odeme_tutari = tutar or float(plan['odenecek_tutar'])
            # Kart validasyon
            cur.execute("SELECT * FROM kartlar WHERE id=%s AND aktif=TRUE", (body.kart_id,))
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
            # vadeli_alimlar'ı da kapat
            if plan.get('kaynak_id'):
                cur.execute("UPDATE vadeli_alimlar SET durum='odendi' WHERE id=%s", (plan['kaynak_id'],))
            audit(cur, 'odeme_plani', oid, 'ODENDI_KART')
            return {"success": True, "odeme_yontemi": "kart"}

        bugun = str(date.today())
        odenen = tutar or float(plan['odenecek_tutar'])
        cur.execute("UPDATE odeme_plani SET durum='odendi', odeme_tarihi=%s, odenen_tutar=%s WHERE id=%s",
            (bugun, odenen, oid))

        # Ödemeyi parçala: bu karta ait birikmiş faiz var mı?
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

        # Faiz kısmı → "yanan para" olarak ayrı kayıt
        if faiz_kismi > 0:
            insert_kasa_hareketi(cur, bugun, 'KART_FAIZ', -abs(faiz_kismi),
                f"Kart faiz ödemesi: {plan['aciklama']}", 'odeme_plani', oid,
                f"{oid}_faiz", 'KART_FAIZ')
            # Faizi kısmi kapat — ödenen kadar düş, kalan borçta kalsın
            kalan_faiz_kapatilacak = faiz_kismi
            cur.execute("""
                SELECT id, tutar FROM kart_hareketleri
                WHERE kart_id=%s AND islem_turu='FAIZ' AND durum='aktif'
                ORDER BY tarih ASC
            """, (plan['kart_id'],))
            faiz_kayitlari = cur.fetchall()
            for fk in faiz_kayitlari:
                if kalan_faiz_kapatilacak <= 0:
                    break
                fk_tutar = float(fk['tutar'])
                if fk_tutar <= kalan_faiz_kapatilacak:
                    # Tamamen kapat
                    cur.execute("UPDATE kart_hareketleri SET durum='iptal' WHERE id=%s", (fk['id'],))
                    kalan_faiz_kapatilacak -= fk_tutar
                else:
                    # Kısmi kapat → orijinali iptal, fark kaydı ekle
                    cur.execute("UPDATE kart_hareketleri SET durum='iptal' WHERE id=%s", (fk['id'],))
                    kalan_tutar = fk_tutar - kalan_faiz_kapatilacak
                    cur.execute("""INSERT INTO kart_hareketleri
                        (id, kart_id, tarih, islem_turu, tutar, aciklama)
                        VALUES (%s, %s, %s, 'FAIZ', %s, 'Kısmi faiz bakiyesi')
                    """, (str(uuid.uuid4()), plan['kart_id'], bugun, kalan_tutar))
                    kalan_faiz_kapatilacak = 0

        # Anapara kısmı — kaynak_tablo'ya göre doğru islem_turu
        if ana_para_kismi > 0:
            kaynak = plan.get('kaynak_tablo') or ''
            if kaynak == 'sabit_giderler':
                islem_t = 'SABIT_GIDER'
                aciklama_t = plan['aciklama']
            elif kaynak == 'personel':
                islem_t = 'PERSONEL_MAAS'
                aciklama_t = plan['aciklama']
            elif kaynak == 'vadeli_alimlar':
                islem_t = 'VADELI_ODEME'
                aciklama_t = plan['aciklama']
            elif kaynak == 'borc_envanteri':
                islem_t = 'BORC_TAKSIT'
                aciklama_t = plan['aciklama']
            else:
                islem_t = 'KART_ODEME'
                aciklama_t = plan['aciklama']
            insert_kasa_hareketi(cur, bugun, islem_t, -abs(ana_para_kismi),
                aciklama_t, 'odeme_plani', oid, oid, 'ODEME_PLANI')

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

        # Kaynak borc_envanteri ise kalan_vade ve toplam_borc güncelle
        if plan.get('kaynak_tablo') == 'borc_envanteri' and plan.get('kaynak_id'):
            cur.execute("SELECT * FROM borc_envanteri WHERE id=%s", (plan['kaynak_id'],))
            borc = cur.fetchone()
            if borc:
                yeni_kalan = (borc['kalan_vade'] - 1) if borc['kalan_vade'] is not None else None
                yeni_toplam = max(0, float(borc['toplam_borc'] or 0) - ana_para_kismi)
                cur.execute("""
                    UPDATE borc_envanteri
                    SET kalan_vade = %s,
                        toplam_borc = %s
                    WHERE id = %s
                """, (yeni_kalan, yeni_toplam, plan['kaynak_id']))

        # Faiz üretimi: /api/kartlar/faiz-uret endpoint'i veya ay sonu startup ile otomatik

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
def onay_listele():
    with db() as (conn, cur):
        cur.execute("SELECT * FROM onay_kuyrugu WHERE durum='bekliyor' ORDER BY tarih ASC")
        return [dict(r) for r in cur.fetchall()]


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
    for oid in ids:
        try:
            onayla(oid)
            sonuclar.append({"id": oid, "durum": "onaylandi"})
        except HTTPException as e:
            sonuclar.append({"id": oid, "durum": "hata", "mesaj": str(e.detail)})
        except Exception as e:
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
        cur.execute("SELECT * FROM onay_kuyrugu WHERE id=%s", (oid,))
        onay = cur.fetchone()
        if not onay: raise HTTPException(404)
        # Zaten onaylanmış — çift onay engeli
        if onay['durum'] != 'bekliyor':
            raise HTTPException(400, f"Bu işlem zaten '{onay['durum']}' durumunda, tekrar onaylanamaz.")
        tutar = float(onay['tutar'])
        tarih = str(onay['tarih'])
        GIDER_TURLERI = {'KART_ODEME', 'ANLIK_GIDER', 'VADELI_ODEME', 'PERSONEL_MAAS', 'SABIT_GIDER', 'BORC_TAKSIT', 'FATURA_ODEMESI', 'ODEME_PLANI'}
        GELIR_TURLERI = {'CIRO', 'CIRO_DUZELTME', 'DIS_KAYNAK', 'KASA_GIRIS', 'KASA_DUZELTME'}
        islem_turu = onay['islem_turu']
        if islem_turu in GIDER_TURLERI:
            signed_tutar = -abs(tutar)
        elif islem_turu in GELIR_TURLERI:
            signed_tutar = abs(tutar)
        else:
            signed_tutar = tutar
            logger.warning(f"Bilinmeyen işlem türü onaylandı: {islem_turu}, tutar={tutar}")

        # ODEME_PLANI onaylandığında kasa_etkisi True olmalı
        # Plan oluşumu = niyet (False), onay = gerçekleşme (True)
        # islem_turu değişmez — anlam korunur, sadece davranış eklenir
        if islem_turu == 'ODEME_PLANI':
            # Kaynağa göre doğru kasa tipi — raporlar doğru okusun
            cur.execute("SELECT kaynak_tablo FROM odeme_plani WHERE id=%s", (onay['kaynak_id'],))
            plan_row = cur.fetchone()
            kaynak_tablo = plan_row['kaynak_tablo'] if plan_row else None
            if kaynak_tablo == 'sabit_giderler':
                kasa_islem_turu = 'SABIT_GIDER'
            elif kaynak_tablo == 'personel':
                kasa_islem_turu = 'PERSONEL_MAAS'
            elif kaynak_tablo == 'vadeli_alimlar':
                kasa_islem_turu = 'VADELI_ODEME'
            elif kaynak_tablo == 'borc_envanteri':
                kasa_islem_turu = 'BORC_TAKSIT'
            else:
                kasa_islem_turu = 'KART_ODEME'
            cur.execute("""
                INSERT INTO kasa_hareketleri
                    (id, tarih, islem_turu, tutar, aciklama, kaynak_tablo, kaynak_id, ref_id, ref_type, kasa_etkisi)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, TRUE)
            """, (str(uuid.uuid4()), tarih, kasa_islem_turu, signed_tutar,
                  f"Onaylandı: {onay['aciklama']}", onay['kaynak_tablo'], onay['kaynak_id'],
                  oid, 'ONAY'))
            # odeme_plani tablosunu da odendi yap — simülasyondan çıkar
            cur.execute("""
                UPDATE odeme_plani SET durum='odendi', odeme_tarihi=%s
                WHERE id=%s AND durum IN ('bekliyor','onay_bekliyor')
            """, (tarih, onay['kaynak_id']))
            # Kaynak vadeli_alimlar ise onu da odendi yap — vadeli alım sayfasında kaybolur
            if kaynak_tablo == 'vadeli_alimlar':
                cur.execute("""
                    SELECT kaynak_id FROM odeme_plani WHERE id=%s
                """, (onay['kaynak_id'],))
                plan_kaynak = cur.fetchone()
                if plan_kaynak and plan_kaynak['kaynak_id']:
                    cur.execute("""
                        UPDATE vadeli_alimlar SET durum='odendi' WHERE id=%s
                    """, (plan_kaynak['kaynak_id'],))
        elif islem_turu == 'VADELI_ODEME':
            # ÇİFT ÖDEME GUARD: Daha önce toplam tutar kadar kasa kaydı yazılmışsa tekrar yazma
            # Kısmi ödeme sonrası kasa kaydı olabilir — toplam tutarla karşılaştır
            cur.execute("""
                SELECT COALESCE(SUM(ABS(tutar)), 0) as toplam_odenen
                FROM kasa_hareketleri
                WHERE kaynak_id=%s AND islem_turu='VADELI_ODEME' AND kasa_etkisi=true AND durum='aktif'
            """, (onay['kaynak_id'],))
            onceki_odenen = float(cur.fetchone()['toplam_odenen'])
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
        else:
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
        # Onay durumunu güncelle — atomic (kasa yazılmazsa bu da çalışmaz)
        cur.execute("UPDATE onay_kuyrugu SET durum='onaylandi', onay_tarihi=NOW() WHERE id=%s AND durum='bekliyor'", (oid,))
        if cur.rowcount == 0:
            raise HTTPException(409, "Eş zamanlı onay çakışması — işlem zaten onaylandı.")
        audit(cur, 'onay_kuyrugu', oid, 'ONAYLANDI', eski=onay)
    return {"success": True}

class ReddetModel(BaseModel):
    neden: str = 'hata'  # 'hata' veya 'surec_bitti'

@app.post("/api/onay-kuyrugu/{oid}/reddet")
def reddet(oid: str, body: ReddetModel = ReddetModel()):
    with db() as (conn, cur):
        # Mevcut davranış korunuyor — onay kuyruğunu kapat
        cur.execute("UPDATE onay_kuyrugu SET durum='reddedildi', onay_tarihi=NOW() WHERE id=%s", (oid,))

        # YENİ: Bağlı odeme_plani'nı iptal et — simülasyondan çıkar
        cur.execute("SELECT * FROM onay_kuyrugu WHERE id=%s", (oid,))
        onay = cur.fetchone()
        if onay:
            # odeme_plani'nı bul ve iptal et
            cur.execute("""
                UPDATE odeme_plani SET durum='iptal'
                WHERE (id=%s OR kaynak_id=%s)
                AND durum IN ('bekliyor','onay_bekliyor')
            """, (onay['kaynak_id'], onay['kaynak_id']))

            # SÜREÇ BİTTİ: kaynağı da kapat — bir daha plan üretilmez
            if body.neden == 'surec_bitti' and onay.get('kaynak_tablo') and onay.get('kaynak_id'):
                kt = onay['kaynak_tablo']
                kid = onay['kaynak_id']
                if kt == 'sabit_giderler':
                    cur.execute("UPDATE sabit_giderler SET aktif=FALSE WHERE id=%s", (kid,))
                elif kt == 'personel':
                    cur.execute("UPDATE personel SET aktif=FALSE WHERE id=%s", (kid,))
                elif kt == 'borc_envanteri':
                    cur.execute("UPDATE borc_envanteri SET aktif=FALSE WHERE id=%s", (kid,))

    return {"success": True}

# ── CİRO ───────────────────────────────────────────────────────
# Oluşturulma zamanından sonra bu süre içinde güncelleme/silme; sonrası kilit (kasa tutarlılığı).
CIRO_DEGISIKLIK_PENCERE_DAKIKA = 10


def _ciro_degistirilebilir_getir(cur, cid: str):
    """
    Aktif ciro satırını döner; yalnızca olusturma + CIRO_DEGISIKLIK_PENCERE_DAKIKA içindeyse.
    Süre dolmuş veya yok: 404 / 403.
    """
    cur.execute(
        """
        SELECT * FROM ciro WHERE id=%s AND durum='aktif'
          AND olusturma >= NOW() - (%s * INTERVAL '1 minute')
        """,
        (cid, CIRO_DEGISIKLIK_PENCERE_DAKIKA),
    )
    row = cur.fetchone()
    if row:
        return row
    cur.execute("SELECT 1 FROM ciro WHERE id=%s AND durum='aktif'", (cid,))
    if not cur.fetchone():
        raise HTTPException(404, "Ciro kaydı bulunamadı veya iptal edilmiş")
    raise HTTPException(
        403,
        f"Bu ciro kaydı oluşturulduktan sonra {CIRO_DEGISIKLIK_PENCERE_DAKIKA} dakika geçti; güncelleme veya silme yapılamaz. "
        "POS/online kesinti düzeltmesi için Şube Ayarları → kasa düzeltme kullanılabilir.",
    )


class CiroModel(BaseModel):
    tarih: date
    sube_id: str
    nakit: float = 0
    pos: float = 0
    online: float = 0
    aciklama: Optional[str] = None
    force: bool = False

@app.get("/api/ciro")
def ciro_listele(limit: int = 200):
    with db() as (conn, cur):
        cur.execute("""
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
            WHERE c.durum = 'aktif'
            ORDER BY c.tarih DESC
            LIMIT %s
        """, (limit,))
        return [dict(r) for r in cur.fetchall()]

@app.post("/api/ciro")
def ciro_ekle(c: CiroModel):
    nakit = float(c.nakit or 0)
    pos   = float(c.pos or 0)
    online = float(c.online or 0)
    toplam = nakit + pos + online
    with db() as (conn, cur):
        # Şube oranlarını çek
        cur.execute("SELECT COALESCE(pos_oran,0) as pos_oran, COALESCE(online_oran,0) as online_oran FROM subeler WHERE id=%s", (c.sube_id,))
        oran = cur.fetchone()
        pos_oran    = float(oran['pos_oran'])    if oran else 0.0
        online_oran = float(oran['online_oran']) if oran else 0.0

        pos_kesinti    = pos    * pos_oran    / 100.0
        online_kesinti = online * online_oran / 100.0
        net_tutar      = nakit + (pos - pos_kesinti) + (online - online_kesinti)

        # Backend duplicate kontrolü — aynı gün aynı şube yeterli, tutar farketmez
        if not c.force:
            cur.execute("""
                SELECT id, (nakit+pos+online) as toplam FROM ciro WHERE durum='aktif'
                AND tarih = %s
                AND sube_id = %s
            """, (str(c.tarih), c.sube_id))
            benzer = cur.fetchall()
            if benzer:
                mevcut_tutar = float(benzer[0]['toplam'])
                return {"warning": True, "mesaj": f"Bu tarih ve şubede zaten ciro kaydı var ({mevcut_tutar:,.0f} ₺). Yine de kaydetmek istiyorsanız onaylayın."}
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
        eski = _ciro_degistirilebilir_getir(cur, cid)

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
        eski = _ciro_degistirilebilir_getir(cur, cid)

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
        except:
            return None

@app.get("/api/personel")
def personel_listele(aktif: Optional[bool] = None):
    with db() as (conn, cur):
        if aktif is not None:
            cur.execute("""SELECT p.*, s.ad as sube_adi FROM personel p
                LEFT JOIN subeler s ON s.id=p.sube_id WHERE p.aktif=%s ORDER BY p.ad_soyad""", (aktif,))
        else:
            cur.execute("""SELECT p.*, s.ad as sube_adi FROM personel p
                LEFT JOIN subeler s ON s.id=p.sube_id ORDER BY p.ad_soyad""")
        return [dict(r) for r in cur.fetchall()]

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
            (str(date.today()), pid))
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

# ── PERSONEL AYLIK KAYIT ──────────────────────────────────────

class PersonelAylikModel(BaseModel):
    calisma_saati: float = 0
    fazla_mesai_saat: float = 0
    bayram_mesai_saat: float = 0
    eksik_gun: float = 0
    raporlu_gun: float = 0
    rapor_kesinti: bool = False
    manuel_duzeltme: float = 0
    not_aciklama: Optional[str] = None

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
        # Part-time: saatlik ücret direkt
        saatlik = float(p.get('saatlik_ucret') or 0)
        saat    = float(kayit.get('calisma_saati') or 0)
        normal  = saat * saatlik
        fazla_ucret = (fazla_normal * saatlik) + (fazla_bayram * saatlik * 2)
        # Part-time: yemek yok, yol var
        net = normal + fazla_ucret + yol + manuel

    return round(max(0, net), 2)

@app.get("/api/personel-aylik")
def personel_aylik_listele(yil: int = None, ay: int = None):
    """Bu ay için tüm personelin aylik kayıtlarını döner. Kayıt yoksa tahmini tutar ile döner."""
    bugun = date.today()
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
            })
        return {'yil': yil, 'ay': ay, 'personeller': sonuc,
                'toplam_tahmini': sum(r['hesaplanan_net'] for r in sonuc)}

@app.post("/api/personel-aylik/{pid}")
def personel_aylik_kaydet(pid: str, body: PersonelAylikModel, yil: int = None, ay: int = None):
    """Personel aylık kaydını girer/günceller ve maaşı hesaplar."""
    bugun = date.today()
    yil = yil or bugun.year
    ay  = ay  or bugun.month
    with db() as (conn, cur):
        cur.execute("SELECT * FROM personel WHERE id=%s AND aktif=TRUE", (pid,))
        p = cur.fetchone()
        if not p: raise HTTPException(404, "Personel bulunamadı")

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
            AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', CURRENT_DATE)
        """, (net, net, pid))

        audit(cur, 'personel_aylik', kid, 'KAYDET', yeni={'net': net, 'yil': yil, 'ay': ay})
    return {"success": True, "hesaplanan_net": net}

@app.post("/api/personel-aylik/{pid}/onayla")
def personel_aylik_onayla(pid: str, yil: int = None, ay: int = None):
    """Maaş kaydını onaylar — durum 'onaylandi' olur, geri alınamaz."""
    bugun = date.today()
    yil = yil or bugun.year
    ay  = ay  or bugun.month
    with db() as (conn, cur):
        cur.execute("""
            UPDATE personel_aylik SET durum='onaylandi'
            WHERE personel_id=%s AND yil=%s AND ay=%s AND durum='taslak'
        """, (pid, yil, ay))
        if cur.rowcount == 0:
            raise HTTPException(400, "Kayıt bulunamadı veya zaten onaylandı")
    return {"success": True}

@app.delete("/api/personel-aylik/{pid}")
def personel_aylik_sil(pid: str, yil: int = None, ay: int = None):
    """Personelin aylık maaş kaydını siler. Sadece taslak durumdakiler silinebilir."""
    bugun = date.today()
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
                AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', CURRENT_DATE)
            """, (tahmini, tahmini, pid))
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

# ── VARDİYA PLANLAMA (config + motor) ──────────────────────────


class VardiyaOlusturModel(BaseModel):
    tarih: date


class PersonelIzinModel(BaseModel):
    personel_id: str
    baslangic_tarih: date
    bitis_tarih: date
    tip: str = "izin"
    aciklama: Optional[str] = None


def _saat_str(v) -> str:
    """TIME / string → HH:MM"""
    if v is None:
        return ""
    if hasattr(v, "strftime"):
        return v.strftime("%H:%M")
    s = str(v)
    return s[:5] if len(s) >= 5 else s


@app.post("/api/personel-izin")
def personel_izin_ekle(body: PersonelIzinModel):
    with db() as (conn, cur):
        iid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO personel_izin
                (id, personel_id, baslangic_tarih, bitis_tarih, tip, aciklama, durum)
            VALUES (%s, %s, %s, %s, %s, %s, 'bekliyor')
            """,
            (
                iid,
                body.personel_id,
                body.baslangic_tarih,
                body.bitis_tarih,
                body.tip,
                body.aciklama,
            ),
        )
        audit(cur, "personel_izin", iid, "INSERT")
    return {"id": iid, "success": True}


@app.get("/api/personel-izin")
def personel_izin_listele(
    personel_id: Optional[str] = None, durum: Optional[str] = None
):
    with db() as (conn, cur):
        q = """
            SELECT pi.*, p.ad_soyad
            FROM personel_izin pi
            JOIN personel p ON p.id = pi.personel_id
            WHERE 1=1
        """
        params = []
        if personel_id:
            q += " AND pi.personel_id = %s"
            params.append(personel_id)
        if durum:
            q += " AND pi.durum = %s"
            params.append(durum)
        q += " ORDER BY pi.baslangic_tarih DESC"
        cur.execute(q, params)
        return [dict(r) for r in cur.fetchall()]


@app.post("/api/personel-izin/{iid}/onayla")
def personel_izin_onayla(iid: str):
    with db() as (conn, cur):
        cur.execute(
            """
            UPDATE personel_izin SET durum='onaylandi'
            WHERE id=%s AND durum='bekliyor'
            """,
            (iid,),
        )
        if cur.rowcount == 0:
            raise HTTPException(400, "Kayıt bulunamadı veya zaten işlendi")
        audit(cur, "personel_izin", iid, "ONAYLA")
    return {"success": True}


@app.post("/api/personel-izin/{iid}/reddet")
def personel_izin_reddet(iid: str):
    with db() as (conn, cur):
        cur.execute(
            """
            UPDATE personel_izin SET durum='reddedildi'
            WHERE id=%s AND durum='bekliyor'
            """,
            (iid,),
        )
        if cur.rowcount == 0:
            raise HTTPException(400, "Kayıt bulunamadı veya zaten işlendi")
        audit(cur, "personel_izin", iid, "REDDET")
    return {"success": True}


@app.delete("/api/personel-izin/{iid}")
def personel_izin_sil(iid: str):
    with db() as (conn, cur):
        cur.execute(
            "DELETE FROM personel_izin WHERE id=%s AND durum='bekliyor'", (iid,)
        )
        if cur.rowcount == 0:
            raise HTTPException(400, "Onaylanmış izin silinemez")
    return {"success": True}


@app.get("/api/personel-kisit/{pid}")
def personel_kisit_getir(pid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM personel_kisit WHERE personel_id=%s", (pid,))
        row = cur.fetchone()
        if row:
            return dict(row)
        return {
            "personel_id": pid,
            "acilis_yapabilir": True,
            "ara_yapabilir": True,
            "kapanis_yapabilir": True,
            "sadece_tip": None,
            "sube_degistirebilir": True,
            "kapanis_bit_saat": None,
        }


@app.put("/api/personel-kisit/{pid}")
def personel_kisit_guncelle(pid: str, body: dict):
    st = body.get("sadece_tip")
    if st == "":
        st = None
    kb = body.get("kapanis_bit_saat")
    if kb == "":
        kb = None
    with db() as (conn, cur):
        cur.execute(
            """
            INSERT INTO personel_kisit
                (id, personel_id, acilis_yapabilir, ara_yapabilir, kapanis_yapabilir,
                 sadece_tip, sube_degistirebilir, kapanis_bit_saat)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (personel_id) DO UPDATE SET
                acilis_yapabilir    = EXCLUDED.acilis_yapabilir,
                ara_yapabilir       = EXCLUDED.ara_yapabilir,
                kapanis_yapabilir   = EXCLUDED.kapanis_yapabilir,
                sadece_tip          = EXCLUDED.sadece_tip,
                sube_degistirebilir = EXCLUDED.sube_degistirebilir,
                kapanis_bit_saat    = EXCLUDED.kapanis_bit_saat,
                guncelleme          = NOW()
            """,
            (
                str(uuid.uuid4()),
                pid,
                body.get("acilis_yapabilir", True),
                body.get("ara_yapabilir", True),
                body.get("kapanis_yapabilir", True),
                st,
                body.get("sube_degistirebilir", True),
                kb,
            ),
        )
    return {"success": True}


@app.get("/api/sube-config")
def sube_config_listele():
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT sc.*, s.ad as sube_adi
            FROM sube_config sc
            JOIN subeler s ON s.id = sc.sube_id
            ORDER BY s.ad
            """
        )
        return [dict(r) for r in cur.fetchall()]


@app.get("/api/sube-config/{sid}")
def sube_config_getir(sid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM sube_config WHERE sube_id=%s", (sid,))
        row = cur.fetchone()
        if row:
            return dict(row)
        return {
            "sube_id": sid,
            "min_kapanis": 1,
            "tek_kapanis_izinli": True,
            "tek_acilis_izinli": True,
            "kaydirma_acik": True,
            "sadece_tam_kayabilir": False,
            "hafta_sonu_min_kap": 1,
            "tam_part_zorunlu": False,
            "kapanis_dusurulemez": False,
        }


@app.put("/api/sube-config/{sid}")
def sube_config_guncelle(sid: str, body: dict):
    with db() as (conn, cur):
        cur.execute(
            """
            INSERT INTO sube_config
                (id, sube_id, min_kapanis, tek_kapanis_izinli, tek_acilis_izinli,
                 kaydirma_acik, sadece_tam_kayabilir, hafta_sonu_min_kap,
                 tam_part_zorunlu, kapanis_dusurulemez)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (sube_id) DO UPDATE SET
                min_kapanis          = EXCLUDED.min_kapanis,
                tek_kapanis_izinli   = EXCLUDED.tek_kapanis_izinli,
                tek_acilis_izinli    = EXCLUDED.tek_acilis_izinli,
                kaydirma_acik        = EXCLUDED.kaydirma_acik,
                sadece_tam_kayabilir = EXCLUDED.sadece_tam_kayabilir,
                hafta_sonu_min_kap   = EXCLUDED.hafta_sonu_min_kap,
                tam_part_zorunlu     = EXCLUDED.tam_part_zorunlu,
                kapanis_dusurulemez  = EXCLUDED.kapanis_dusurulemez,
                guncelleme           = NOW()
            """,
            (
                str(uuid.uuid4()),
                sid,
                int(body.get("min_kapanis", 1)),
                bool(body.get("tek_kapanis_izinli", True)),
                bool(body.get("tek_acilis_izinli", True)),
                bool(body.get("kaydirma_acik", True)),
                bool(body.get("sadece_tam_kayabilir", False)),
                int(body.get("hafta_sonu_min_kap", 1)),
                bool(body.get("tam_part_zorunlu", False)),
                bool(body.get("kapanis_dusurulemez", False)),
            ),
        )
    return {"success": True}


@app.get("/api/sube-baglanti")
def sube_baglanti_listele():
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT sb.*, s1.ad as kaynak_adi, s2.ad as hedef_adi
            FROM sube_baglanti sb
            JOIN subeler s1 ON s1.id = sb.kaynak_id
            JOIN subeler s2 ON s2.id = sb.hedef_id
            ORDER BY s1.ad, s2.ad
            """
        )
        return [dict(r) for r in cur.fetchall()]


@app.post("/api/sube-baglanti")
def sube_baglanti_ekle(body: dict):
    with db() as (conn, cur):
        bid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO sube_baglanti (id, kaynak_id, hedef_id, aktif)
            VALUES (%s,%s,%s,%s)
            ON CONFLICT (kaynak_id, hedef_id) DO UPDATE SET aktif=EXCLUDED.aktif
            """,
            (bid, body["kaynak_id"], body["hedef_id"], body.get("aktif", True)),
        )
    return {"success": True}


@app.delete("/api/sube-baglanti/{bid}")
def sube_baglanti_sil(bid: str):
    with db() as (conn, cur):
        cur.execute("DELETE FROM sube_baglanti WHERE id=%s", (bid,))
    return {"success": True}


@app.post("/api/vardiya/olustur")
def vardiya_olustur(body: VardiyaOlusturModel):
    """
    Şube / personel config + izin + kaydırma kurallarına göre günlük plan üretir.
    """
    t = body.tarih
    with db() as (conn, cur):
        sonuc = vardiya_motoru_calistir(cur, t)
    return sonuc


@app.get("/api/vardiya")
def vardiya_listele(tarih: Optional[date] = None):
    """Tarihe göre vardiya listesi (personel + şube adı ile)."""
    gun = tarih or date.today()
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT v.id, v.tarih, v.tip, v.bas_saat, v.bit_saat,
                   p.ad_soyad AS personel_adi,
                   COALESCE(s.ad, '—') AS sube_adi
            FROM vardiya v
            JOIN personel p ON p.id = v.personel_id
            LEFT JOIN subeler s ON s.id = v.sube_id
            WHERE v.tarih = %s
            ORDER BY COALESCE(s.ad, ''), p.ad_soyad,
                CASE v.tip
                    WHEN 'ACILIS' THEN 1
                    WHEN 'ARA' THEN 2
                    WHEN 'KAPANIS' THEN 3
                    ELSE 4
                END
            """,
            (str(gun),),
        )
        rows = []
        for r in cur.fetchall():
            bas = _saat_str(r["bas_saat"])
            bit = _saat_str(r["bit_saat"])
            rows.append(
                {
                    "id": str(r["id"]),
                    "tarih": str(r["tarih"]),
                    "personel_adi": r["personel_adi"] or "",
                    "sube_adi": r["sube_adi"] or "—",
                    "tip": r["tip"],
                    "bas_saat": bas,
                    "bit_saat": bit,
                    "saat_araligi": f"{bas}–{bit}",
                }
            )
    return {"tarih": str(gun), "vardiyalar": rows}


_GUNLER_TR = (
    "PAZARTESİ",
    "SALI",
    "ÇARŞAMBA",
    "PERŞEMBE",
    "CUMA",
    "CUMARTESİ",
    "PAZAR",
)
_AYLAR_KISA = (
    "Oca",
    "Şub",
    "Mar",
    "Nis",
    "May",
    "Haz",
    "Tem",
    "Ağu",
    "Eyl",
    "Eki",
    "Kas",
    "Ara",
)


def _pazartesi(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _gun_kisa_tr(d: date) -> str:
    return f"{d.day}-{_AYLAR_KISA[d.month - 1]}"


@app.get("/api/vardiya/haftalik")
def vardiya_haftalik_get(tarih: Optional[date] = None):
    """
    Tulipi tarzı haftalık tablo: Pazartesi–Pazar sütunları, personel satırları.
    `tarih` haftanın herhangi bir günü olabilir; pazartesi normalize edilir.
    """
    d0 = tarih or date.today()
    pzt = _pazartesi(d0)
    gunler = []
    for i in range(7):
        g = pzt + timedelta(days=i)
        gunler.append(
            {
                "tarih": str(g),
                "kisa": _gun_kisa_tr(g),
                "hafta_gunu": _GUNLER_TR[i],
            }
        )
    pazar = pzt + timedelta(days=6)

    with db() as (conn, cur):
        cur.execute(
            "SELECT baslik, not_metni FROM vardiya_hafta_meta WHERE hafta_baslangic=%s",
            (str(pzt),),
        )
        meta = cur.fetchone()
        baslik = (meta and meta.get("baslik")) or "Tulipi Haftalık Vardiya Listesi"
        not_metni = (meta and meta.get("not_metni")) or ""

        cur.execute(
            """
            SELECT h.* FROM vardiya_hafta_hucre h
            WHERE h.hafta_baslangic = %s
            """,
            (str(pzt),),
        )
        hucre_map = {}
        for r in cur.fetchall():
            key = (r["personel_id"], str(r["tarih"]))
            hucre_map[key] = (r["icerik"] or "").strip()

        cur.execute(
            """
            SELECT * FROM vardiya_hafta_satir WHERE hafta_baslangic=%s
            """,
            (str(pzt),),
        )
        satir_x = {(r["personel_id"]): dict(r) for r in cur.fetchall()}

        cur.execute(
            """
            SELECT p.id, p.ad_soyad, p.gorev, p.sube_id, COALESCE(s.ad, '—') AS sube_adi
            FROM personel p
            LEFT JOIN subeler s ON s.id = p.sube_id
            WHERE p.aktif = TRUE
            ORDER BY COALESCE(s.ad, ''), p.ad_soyad
            """
        )
        satirlar = []
        for p in cur.fetchall():
            pid = p["id"]
            hx = satir_x.get(pid) or {}
            hucreler = {}
            for i in range(7):
                g = pzt + timedelta(days=i)
                ts = str(g)
                hucreler[ts] = hucre_map.get((pid, ts), "")
            satirlar.append(
                {
                    "personel_id": pid,
                    "ad_soyad": p["ad_soyad"] or "",
                    "gorev": p["gorev"] or "",
                    "sube_id": p["sube_id"],
                    "sube_adi": p["sube_adi"] or "—",
                    "hucreler": hucreler,
                    "kapanis_sayisi": (hx.get("kapanis_sayisi") or "") or "",
                    "alacak_saat": (hx.get("alacak_saat") or "") or "",
                }
            )

    return {
        "hafta_baslangic": str(pzt),
        "hafta_bitis": str(pazar),
        "baslik": baslik,
        "not_metni": not_metni,
        "gunler": gunler,
        "satirlar": satirlar,
    }


@app.put("/api/vardiya/haftalik")
def vardiya_haftalik_kaydet(body: dict):
    """Haftalık hücreleri ve satır eklerini kaydeder; boş içerik satırı siler."""
    try:
        pzt_s = body.get("hafta_baslangic")
        if not pzt_s:
            raise HTTPException(400, "hafta_baslangic gerekli (Pazartesi YYYY-MM-DD)")
        pzt = date.fromisoformat(str(pzt_s)[:10])
    except ValueError:
        raise HTTPException(400, "Geçersiz hafta_baslangic")
    if pzt.weekday() != 0:
        raise HTTPException(400, "hafta_baslangic Pazartesi olmalı")

    not_metni = body.get("not_metni")
    baslik = body.get("baslik")

    with db() as (conn, cur):
        cur.execute(
            """
            INSERT INTO vardiya_hafta_meta (hafta_baslangic, baslik, not_metni)
            VALUES (%s, %s, %s)
            ON CONFLICT (hafta_baslangic) DO UPDATE SET
                baslik = EXCLUDED.baslik,
                not_metni = EXCLUDED.not_metni,
                guncelleme = NOW()
            """,
            (
                str(pzt),
                baslik or "Tulipi Haftalık Vardiya Listesi",
                not_metni if not_metni is not None else "",
            ),
        )

        for row in body.get("satir_extra") or []:
            pid = row.get("personel_id")
            if not pid:
                continue
            cur.execute("SELECT id FROM personel WHERE id=%s", (pid,))
            if not cur.fetchone():
                continue
            cur.execute(
                """
                INSERT INTO vardiya_hafta_satir
                    (hafta_baslangic, personel_id, kapanis_sayisi, alacak_saat)
                VALUES (%s,%s,%s,%s)
                ON CONFLICT (hafta_baslangic, personel_id) DO UPDATE SET
                    kapanis_sayisi = EXCLUDED.kapanis_sayisi,
                    alacak_saat = EXCLUDED.alacak_saat
                """,
                (
                    str(pzt),
                    pid,
                    row.get("kapanis_sayisi") or None,
                    row.get("alacak_saat") or None,
                ),
            )

        for h in body.get("hucreler") or []:
            pid = h.get("personel_id")
            ts = h.get("tarih")
            if not pid or not ts:
                continue
            try:
                td = date.fromisoformat(str(ts)[:10])
            except ValueError:
                continue
            if td < pzt or td > pzt + timedelta(days=6):
                continue
            cur.execute("SELECT id FROM personel WHERE id=%s", (pid,))
            if not cur.fetchone():
                continue
            icerik = (h.get("icerik") or "").strip()
            if not icerik:
                cur.execute(
                    """
                    DELETE FROM vardiya_hafta_hucre
                    WHERE hafta_baslangic=%s AND personel_id=%s AND tarih=%s
                    """,
                    (str(pzt), pid, str(td)),
                )
                continue
            hid = str(uuid.uuid4())
            cur.execute(
                """
                INSERT INTO vardiya_hafta_hucre
                    (id, hafta_baslangic, tarih, personel_id, icerik)
                VALUES (%s,%s,%s,%s,%s)
                ON CONFLICT (hafta_baslangic, personel_id, tarih) DO UPDATE SET
                    icerik = EXCLUDED.icerik,
                    guncelleme = NOW()
                """,
                (hid, str(pzt), str(td), pid, icerik),
            )

    return {"success": True}


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
        cur.execute("""SELECT sg.*, s.ad as sube_adi FROM sabit_giderler sg
            LEFT JOIN subeler s ON s.id=sg.sube_id ORDER BY sg.kategori, sg.gider_adi""")
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
                f"Sabit gider: {g.gider_adi}", g.tutar, date.today())
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
        audit(cur, 'sabit_giderler', gid, 'PASIF', eski=eski)
    return {"success": True}

@app.get("/api/sabit-giderler/uyarilar")
def sabit_gider_uyarilar():
    """
    Kira/Abonelik uyarıları — iki bağımsız uyarı tipi:
    KIRA_ARTIS   : artış tarihi yaklaşıyor veya geçti → ödeme planı DURDU, tutar güncellenmeli
    SOZLESME_BITIS: sözleşme bitiyor veya bitti → uzatma/yenileme gerekiyor
    """
    bugun = date.today()
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
    """Gerçekleşmiş sabit gider ödemeleri — CFO görünürlük katmanı"""
    with db() as (conn, cur):
        cur.execute("""
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
            ORDER BY op.odeme_tarihi DESC
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
    with db() as (conn, cur):
        # Sabit gideri kontrol et
        cur.execute("SELECT * FROM sabit_giderler WHERE id=%s AND aktif=TRUE", (body.sabit_gider_id,))
        gider = cur.fetchone()
        if not gider:
            raise HTTPException(404, "Gider bulunamadı")
        if gider.get('tip') != 'degisken':
            raise HTTPException(400, "Bu endpoint sadece değişken giderler için kullanılır")

        # Bu ay zaten ödendi mi?
        cur.execute("""
            SELECT 1 FROM kasa_hareketleri
            WHERE kaynak_id=%s AND kaynak_tablo='sabit_giderler'
            AND islem_turu='FATURA_ODEMESI' AND kasa_etkisi=true AND durum='aktif'
            AND EXTRACT(YEAR FROM tarih) = EXTRACT(YEAR FROM %s::date)
            AND EXTRACT(MONTH FROM tarih) = EXTRACT(MONTH FROM %s::date)
        """, (body.sabit_gider_id, str(body.tarih), str(body.tarih)))
        if cur.fetchone():
            raise HTTPException(400, "Bu ay için zaten fatura ödemesi yapılmış")

        aciklama = body.aciklama or f"Fatura: {gider['gider_adi']}"

        if body.odeme_yontemi == 'kart':
            if not body.kart_id:
                raise HTTPException(400, "Kart seçimi zorunlu")
            cur.execute("SELECT * FROM kartlar WHERE id=%s AND aktif=TRUE", (body.kart_id,))
            kart = cur.fetchone()
            if not kart:
                raise HTTPException(404, "Kart bulunamadı")
            # Mevcut kart borcunu hesapla — limit kontrolü
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
            # Kart planını güncelle — ticker anında yansısın
            kart_plan_guncelle()
        else:
            # Kasaya yaz
            fid = str(uuid.uuid4())   # nakit yolunda fid = kasa_hareketleri kaydı
            insert_kasa_hareketi(cur, str(body.tarih), 'FATURA_ODEMESI', -abs(body.tutar),
                aciklama, 'sabit_giderler', body.sabit_gider_id,
                ref_id=fid, ref_type='FATURA_ODEMESI')

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
            AND islem_turu='FATURA_ODEMESI' AND kasa_etkisi=true AND durum='aktif'
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
        return {
            "gider": {"id": str(gider['id']), "gider_adi": gider['gider_adi'],
                      "kategori": gider['kategori'], "tutar": float(gider['tutar'])},
            "ozet": {"toplam_odenen": round(toplam_odenen, 2),
                     "odeme_adedi": len(odenenler)},
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


# ── VADELİ ALIMLAR ─────────────────────────────────────────────
class VadeliAlim(BaseModel):
    aciklama: str
    tutar: float
    vade_tarihi: date
    tedarikci: str          # Zorunlu — kart takibi ve raporlar için
    force: bool = False

@app.get("/api/vadeli-alimlar")
def vadeli_listele():
    with db() as (conn, cur):
        cur.execute("""SELECT *, (vade_tarihi - CURRENT_DATE) as gun_kaldi
            FROM vadeli_alimlar WHERE durum='bekliyor' ORDER BY vade_tarihi""")
        return [dict(r) for r in cur.fetchall()]

@app.post("/api/vadeli-alimlar")
def vadeli_ekle(v: VadeliAlim):
    with db() as (conn, cur):
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
    bugun = date.today()
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

        # KART seçildiyse validasyon
        if body.odeme_yontemi == 'kart':
            if not body.kart_id:
                raise HTTPException(400, "Kart seçimi zorunlu")
            cur.execute("SELECT * FROM kartlar WHERE id=%s AND aktif=TRUE", (body.kart_id,))
            kart = cur.fetchone()
            if not kart: raise HTTPException(404, "Kart bulunamadı")
            borc = kart_borc(cur, body.kart_id)
            kalan_limit = float(kart['limit_tutar']) - borc
            if kalan_limit < float(v['tutar']):
                raise HTTPException(400, f"Kart limiti yetersiz. Kalan: {kalan_limit:,.0f} ₺")

        # ÇİFT ÖDEME GUARD — bağlı aktif odeme_plani varsa zaten ödenmemiş demektir
        # Aktif plan yoksa ve kasa kaydı tam tutarı kapıyorsa engelle
        cur.execute("""
            SELECT id, odenecek_tutar FROM odeme_plani
            WHERE kaynak_tablo='vadeli_alimlar' AND kaynak_id=%s
            AND durum IN ('bekliyor','onay_bekliyor')
            LIMIT 1
        """, (vid,))
        aktif_plan = cur.fetchone()
        if not aktif_plan:
            # Aktif plan yok — önceki kasa kayıtlarına bak
            cur.execute("""
                SELECT COALESCE(SUM(ABS(tutar)), 0) as toplam_odenen
                FROM kasa_hareketleri
                WHERE kaynak_id=%s AND islem_turu='VADELI_ODEME' AND kasa_etkisi=true AND durum='aktif'
            """, (vid,))
            odenen = float(cur.fetchone()['toplam_odenen'])
            if odenen >= float(v['tutar']):
                raise HTTPException(400, "Bu vadeli alım zaten tam olarak kasaya işlenmiş, tekrar ödeme yapılamaz.")

        # Onay kuyruğunda bekleyen VADELI_ODEME varsa kapat
        cur.execute("""
            UPDATE onay_kuyrugu SET durum='reddedildi'
            WHERE kaynak_id=%s AND islem_turu='VADELI_ODEME' AND durum='bekliyor'
        """, (vid,))

        # Aktif plan — guard'da zaten bulundu, tekrar sorgulama
        plan = aktif_plan
        if not plan:
            raise HTTPException(400, "Bu vadeli alım için ödeme planı bulunamadı")

        bugun = str(date.today())
        tutar = float(plan['odenecek_tutar'])  # vadeli_alimlar.tutar değil, planın tutarı

        if body.odeme_yontemi == 'kart':
            # KART: kasaya yazma — kart borcuna HARCAMA ekle
            hid = str(uuid.uuid4())
            cur.execute("""
                INSERT INTO kart_hareketleri
                    (id, kart_id, tarih, islem_turu, tutar, taksit_sayisi, aciklama, kaynak_id, kaynak_tablo)
                VALUES (%s, %s, %s, 'HARCAMA', %s, 1, %s, %s, 'vadeli_alimlar')
            """, (hid, body.kart_id, bugun, tutar, f"Vadeli alım: {v['aciklama']}", vid))
            audit(cur, 'kart_hareketleri', hid, 'VADELI_KART')
            kart_plan_guncelle()
            # Plan + vadeli alım + onay kuyruğu → atomik kapat
            cur.execute("UPDATE odeme_plani SET durum='odendi', odeme_tarihi=%s, odenen_tutar=%s WHERE id=%s",
                (bugun, tutar, plan['id']))
            vadeli_alim_kapat(cur, vid, bugun)
            audit(cur, 'vadeli_alimlar', vid, 'ODENDI_KART')
            return {"success": True, "odeme_yontemi": "kart", "kart_id": body.kart_id}

    # NAKİT: odeme_yap kasaya VADELI_ODEME yazar; vadeli_alim_kapat zaten içinde çağrılıyor
    odeme_yap(plan['id'])
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
            cur.execute("SELECT * FROM kartlar WHERE id=%s AND aktif=TRUE", (body.kart_id,))
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
    # Kampanya: başlangıçtan sonra bu kadar tam ay taksit planı üretilmez (0 = yok)
    odemesiz_ay: int = 0

class SubeGuncelleModel(BaseModel):
    pos_oran: float = 0
    online_oran: float = 0

class KasaDuzeltModel(BaseModel):
    baslangic: date
    bitis: Optional[date] = None

@app.get("/api/borclar")
def borclar_listele():
    with db() as (conn, cur):
        cur.execute("SELECT * FROM borc_envanteri ORDER BY kurum")
        return [dict(r) for r in cur.fetchall()]

@app.post("/api/borclar")
def borc_ekle(b: BorcModel):
    oa = int(b.odemesiz_ay or 0)
    if oa < 0 or oa > 360:
        raise HTTPException(400, "Ödemesiz ay 0–360 arasında olmalı")
    if oa > 0 and not b.baslangic_tarihi:
        raise HTTPException(400, "Ödemesiz dönem için başlangıç tarihi zorunlu")
    with db() as (conn, cur):
        bid = str(uuid.uuid4())
        cur.execute("""INSERT INTO borc_envanteri (id,kurum,borc_turu,toplam_borc,aylik_taksit,kalan_vade,toplam_vade,baslangic_tarihi,odeme_gunu,odemesiz_ay)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (bid, b.kurum, b.borc_turu, b.toplam_borc, b.aylik_taksit, b.kalan_vade, b.toplam_vade, b.baslangic_tarihi, b.odeme_gunu, oa))
        audit(cur, 'borc_envanteri', bid, 'INSERT')
    return {"id": bid, "success": True}

@app.put("/api/borclar/{bid}")
def borc_guncelle(bid: str, b: BorcModel):
    oa = int(b.odemesiz_ay or 0)
    if oa < 0 or oa > 360:
        raise HTTPException(400, "Ödemesiz ay 0–360 arasında olmalı")
    if oa > 0 and not b.baslangic_tarihi:
        raise HTTPException(400, "Ödemesiz dönem için başlangıç tarihi zorunlu")
    with db() as (conn, cur):
        cur.execute("SELECT * FROM borc_envanteri WHERE id=%s", (bid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)
        cur.execute("""UPDATE borc_envanteri SET kurum=%s,borc_turu=%s,toplam_borc=%s,aylik_taksit=%s,
            kalan_vade=%s,toplam_vade=%s,baslangic_tarihi=%s,odeme_gunu=%s,odemesiz_ay=%s WHERE id=%s""",
            (b.kurum, b.borc_turu, b.toplam_borc, b.aylik_taksit, b.kalan_vade, b.toplam_vade, b.baslangic_tarihi, b.odeme_gunu, oa, bid))
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
        gecen_taksit    = toplam_vade - kalan_vade if toplam_vade else len(odenenler)
        ilerleme_pct    = round(gecen_taksit / toplam_vade * 100) if toplam_vade else 0

        odemesiz = int(borc.get('odemesiz_ay') or 0)
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
                "odemesiz_ay":     odemesiz,
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

@app.put("/api/subeler/{sid}")
def sube_guncelle(sid: str, body: SubeGuncelleModel):
    pos_oran = float(body.pos_oran)
    online_oran = float(body.online_oran)
    if not (0 <= pos_oran <= 100) or not (0 <= online_oran <= 100):
        raise HTTPException(400, "Oran 0-100 arasında olmalı")
    with db() as (conn, cur):
        cur.execute("SELECT id FROM subeler WHERE id=%s", (sid,))
        if not cur.fetchone():
            raise HTTPException(404, "Şube bulunamadı")
        cur.execute(
            "UPDATE subeler SET pos_oran=%s, online_oran=%s WHERE id=%s",
            (pos_oran, online_oran, sid)
        )
    return {"success": True}

@app.get("/api/subeler/{sid}/kasa-onizle")
def kasa_onizle(sid: str, baslangic: date, bitis: date = None):
    """
    Seçilen tarih aralığındaki ciro kayıtları için kasa düzeltme önizlemesi.
    Düzeltme yapmaz — sadece etki hesaplar.
    """
    bitis = bitis or date.today()
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
                AND kh.ref_type = 'CIRO'
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
    bitis = body.bitis or date.today()

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
                AND kh.ref_type = 'CIRO'
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
def ledger(limit: int = 200, islem_turu: Optional[str] = None):
    with db() as (conn, cur):
        sql = "SELECT * FROM kasa_hareketleri WHERE durum='aktif'"
        params = []
        if islem_turu:
            sql += " AND islem_turu=%s"
            params.append(islem_turu)
        sql += " ORDER BY tarih DESC, olusturma DESC LIMIT %s"
        params.append(limit)
        cur.execute(sql, params)
        return [dict(r) for r in cur.fetchall()]

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
                            _tv = d.get('toplam_vade')
                            _bs = fix_date(d.get('baslangic_tarihi')) if d.get('baslangic_tarihi') else None
                            _oa = int(d.get('odemesiz_ay') or 0)
                            if _oa > 0 and not _bs:
                                _oa = 0
                            cur.execute("""INSERT INTO borc_envanteri (id,kurum,borc_turu,toplam_borc,aylik_taksit,kalan_vade,toplam_vade,baslangic_tarihi,odeme_gunu,odemesiz_ay)
                                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                                (str(uuid.uuid4()), str(d.get('kurum','')),
                                 str(d.get('borc_turu','Kredi')),
                                 float(d.get('toplam_borc') or 0),
                                 float(d.get('aylik_taksit') or 0),
                                 int(d.get('kalan_vade') or 0),
                                 int(_tv) if _tv is not None and str(_tv).strip() != '' else None,
                                 _bs,
                                 int(d.get('odeme_gunu') or 1),
                                 max(0, min(360, _oa))))
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
        yil = __import__('datetime').date.today().year
        ay  = __import__('datetime').date.today().month

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
        bugun = __import__('datetime').date.today()
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

        # Geciken vadeli alımlar
        cur.execute("""
            SELECT COUNT(*) as adet FROM vadeli_alimlar
            WHERE durum = 'bekliyor' AND vade_tarihi < CURRENT_DATE
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


# ── ÖDEME PLANI MOTOR ENDPOINTLERİ ────────────────────────────

@app.post("/api/kart-plan-guncelle")
def kart_plan_guncelle():
    """Kart borçlarını hesaplayıp mevcut bekleyen planları günceller.
    Anlık gider, fatura, vadeli alım kart ödemesi sonrası çağrılır.
    """
    from datetime import date
    import uuid as _uuid
    import calendar as _cal
    bugun = date.today()
    yil, ay = bugun.year, bugun.month
    guncellenen = []

    with db() as (conn, cur):
        cur.execute("SELECT * FROM kartlar WHERE aktif=TRUE")
        for k in cur.fetchall():
            son_odeme_gun = k['son_odeme_gunu'] or 25
            son_gun = _cal.monthrange(yil, ay)[1]
            son_odeme_gun = min(son_odeme_gun, son_gun)
            odeme_tarihi = date(yil, ay, son_odeme_gun)

            # Güncel borç
            borc = kart_borc(cur, k['id'])
            if borc <= 0:
                continue

            asgari_oran_pct = float(k.get('asgari_oran', 40)) / 100
            asgari = round(borc * asgari_oran_pct, 2)

            # Plan varsa güncelle, yoksa ekle
            cur.execute("""
                UPDATE odeme_plani
                SET odenecek_tutar=%s, asgari_tutar=%s
                WHERE kart_id=%s
                AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', %s::date)
                AND durum IN ('bekliyor','onay_bekliyor')
            """, (borc, asgari, k['id'], str(odeme_tarihi)))

            if cur.rowcount > 0:
                guncellenen.append(f"{k['kart_adi']}: {borc:,.0f}₺")
            else:
                # Plan yok — oluştur
                pid = str(uuid.uuid4())
                cur.execute("""
                    INSERT INTO odeme_plani
                        (id, kart_id, tarih, odenecek_tutar, asgari_tutar, aciklama, durum)
                    VALUES (%s, %s, %s, %s, %s, %s, 'bekliyor')
                """, (pid, k['id'], odeme_tarihi, borc, asgari,
                       f"Kart: {k['kart_adi']} — {k['banka']}"))
                guncellenen.append(f"{k['kart_adi']}: {borc:,.0f}₺ (yeni plan)")

    return {"success": True, "guncellenen": guncellenen}

@app.post("/api/odeme-plani/uret")
def odeme_plani_manuel_uret(yil: Optional[int] = None, ay: Optional[int] = None):
    """Manuel ödeme planı üretimi — butona basınca çalışır."""
    try:
        sonuc = aylik_odeme_plani_uret(yil, ay)
        return sonuc
    except Exception as e:
        raise HTTPException(500, str(e))

@app.get("/api/uyarilar")
def uyarilari_listele():
    """Yaklaşan ödemelerin uyarılarını döner."""
    try:
        return uyari_motoru()
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/api/odeme-plani/{oid}/odendi")
def odeme_odendi(oid: str, manuel_tutar: Optional[float] = None):
    """Geriye dönük uyumluluk — /ode endpoint'ine yönlendirir."""
    return odeme_yap(oid, tutar=manuel_tutar)


@app.post("/api/odeme-plani/{oid}/ertele")
def odeme_ertele(oid: str, yeni_tarih: date = None):
    """Ödemeyi ertele — sadece tarih güncellenir, yeni kayıt açılmaz."""
    with db() as (conn, cur):
        cur.execute("SELECT * FROM odeme_plani WHERE id=%s AND durum='bekliyor'", (oid,))
        o = cur.fetchone()
        if not o: raise HTTPException(404)
        yeni = yeni_tarih or (o['tarih'] + timedelta(days=7))
        # Ödeme planı tarihini güncelle
        cur.execute("UPDATE odeme_plani SET tarih=%s WHERE id=%s", (yeni, oid))
        # Onay kuyruğundaki tarihi de güncelle — yeni kayıt açma
        cur.execute("""
            UPDATE onay_kuyrugu SET tarih=%s
            WHERE durum='bekliyor'
            AND (kaynak_id=%s OR kaynak_id=(SELECT kaynak_id FROM odeme_plani WHERE id=%s LIMIT 1))
        """, (yeni, oid, oid))
        audit(cur, 'odeme_plani', oid, 'ERTELE')
    return {"success": True, "yeni_tarih": str(yeni)}


@app.post("/api/odeme-plani/{oid}/kismi-ode")
def kismi_odeme_yap(oid: str, body: KismiOdeModel):
    """
    Kısmi ödeme — plan bölünür:
    1. Eski plan → odendi (ödenen tutar kadar kasadan düşer)
    2. Yeni plan → kalan tutar, yeni vade tarihi ile simülasyona girer
    Kural: kasa sadece ödenen kadar etkilenir, kalan simülasyonda yaşar.
    """
    with db() as (conn, cur):
        cur.execute("SELECT * FROM odeme_plani WHERE id=%s AND durum IN ('bekliyor','onay_bekliyor')", (oid,))
        plan = cur.fetchone()
        if not plan: raise HTTPException(404, "Plan bulunamadı veya zaten ödendi")

        toplam = float(plan['odenecek_tutar'])
        odenen = body.odenen_tutar
        kalan  = toplam - odenen

        if odenen <= 0:
            raise HTTPException(400, "Ödenen tutar sıfırdan büyük olmalı")
        if odenen >= toplam:
            raise HTTPException(400, "Tam ödeme için normal ödeme ekranını kullanın")
        if kalan <= 0:
            raise HTTPException(400, "Kalan tutar hesaplanamadı")

        bugun = str(date.today())

        # 1. Eski planı odendi yap — sadece ödenen tutar kadar
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
        else:
            islem_t = 'KART_ODEME'

        # vadeli_alimlar için kaynak_id = vadeli_alimlar.id — guard bu id'ye bakıyor
        kasa_kaynak_id = plan['kaynak_id'] if kaynak == 'vadeli_alimlar' and plan.get('kaynak_id') else oid

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
            # NAKİT: kasaya yaz
            insert_kasa_hareketi(cur, bugun, islem_t, -abs(odenen),
                f"Kısmi ödeme: {plan['aciklama']} ({int(odenen):,} / {int(toplam):,} ₺)",
                'odeme_plani', kasa_kaynak_id, oid, 'KISMI_ODE')

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

        # 3. Kalan için yeni plan oluştur
        # referans_ay: yeni vade tarihinin ayı — eski planın ay'ını kopyalama, motor o ayı tekrar üretmesin diye
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

        # Yeni plan için onay kuyruğuna gir — onaylandığında kasa yazılır
        # Kaynak vadeli_alimlar ise VADELI_ODEME tipiyle gir — raporlar ve vadeli alım tablosu doğru güncellensin
        if kaynak == 'vadeli_alimlar' and plan.get('kaynak_id'):
            onay_ekle(cur, 'VADELI_ODEME', 'vadeli_alimlar', plan['kaynak_id'],
                f"Kısmi vadeli kalan: {plan['aciklama']} ({int(kalan):,} ₺)",
                kalan, body.kalan_vade_tarihi)
        else:
            onay_ekle(cur, 'ODEME_PLANI', 'odeme_plani', yeni_id,
                f"Kısmi ödeme kalanı: {plan['aciklama']} ({int(kalan):,} ₺)",
                kalan, body.kalan_vade_tarihi)

        audit(cur, 'odeme_plani', oid, 'KISMI_ODE',
              eski={'tutar': toplam}, yeni={'odenen': odenen, 'kalan': kalan, 'yeni_plan': yeni_id})

    return {"success": True, "odenen": odenen, "kalan": kalan, "yeni_plan_id": yeni_id}

@app.get("/api/kasa-detay")
def kasa_detay_endpoint():
    """Kasa'yı işlem türü bazında gösterir — her türün ne kadar etki yaptığını döker."""
    try:
        return kasa_detay()
    except Exception as e:
        raise HTTPException(500, str(e))

@app.get("/api/kasa-detay-debug")
def kasa_detay_debug_endpoint():
    """Debug: işlem türü + durum kırılımı; iptal satırları dahil."""
    try:
        return kasa_detay_debug()
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
                    "donem":   donem or date.today().strftime('%Y-%m'),
                    "kartlar": sonuclar,
                    "yazilan": sum(1 for s in sonuclar if s.get('durum') == 'yazildi'),
                }
    except Exception as e:
        raise HTTPException(500, str(e))



@app.get("/api/kart-faiz")
def kart_faiz_listele(kart_id: str = None):
    """Kart bazlı faiz geçmişi."""
    with db() as (conn, cur):
        if kart_id:
            cur.execute("""
                SELECT kh.*, k.kart_adi, k.banka
                FROM kart_hareketleri kh
                JOIN kartlar k ON k.id = kh.kart_id
                WHERE kh.islem_turu = 'FAIZ' AND kh.kart_id = %s
                ORDER BY kh.tarih DESC
            """, (kart_id,))
        else:
            cur.execute("""
                SELECT kh.*, k.kart_adi, k.banka
                FROM kart_hareketleri kh
                JOIN kartlar k ON k.id = kh.kart_id
                WHERE kh.islem_turu = 'FAIZ'
                ORDER BY kh.tarih DESC LIMIT 50
            """)
        return [dict(r) for r in cur.fetchall()]

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
            bugun = str(date.today())
            cur.execute("UPDATE odeme_plani SET durum='odendi', odeme_tarihi=%s, odenen_tutar=%s WHERE id=%s", (bugun, odenen, oid))
            # Toplu ödeme parçalama: faiz + anapara
            faiz_t = 0.0
            if plan.get('kart_id'):
                cur.execute("SELECT COALESCE(SUM(tutar),0) as bf FROM kart_hareketleri WHERE kart_id=%s AND islem_turu='FAIZ' AND durum='aktif'", (plan['kart_id'],))
                faiz_t = min(float(cur.fetchone()['bf']), odenen)
            ana_t = odenen - faiz_t
            if faiz_t > 0:
                insert_kasa_hareketi(cur, bugun, 'KART_FAIZ', -abs(faiz_t), f"Toplu faiz: {plan['aciklama']}", 'odeme_plani', oid, f"{oid}_faiz", 'KART_FAIZ')
            if ana_t > 0:
                # Kaynak türüne göre doğru islem_turu — rapor doğruluğu için kritik
                _kaynak = plan.get('kaynak_tablo') or ''
                if _kaynak == 'sabit_giderler':
                    _islem = 'SABIT_GIDER'
                elif _kaynak == 'personel':
                    _islem = 'PERSONEL_MAAS'
                elif _kaynak == 'vadeli_alimlar':
                    _islem = 'VADELI_ODEME'
                elif _kaynak == 'borc_envanteri':
                    _islem = 'BORC_TAKSIT'
                else:
                    _islem = 'KART_ODEME'
                insert_kasa_hareketi(cur, bugun, _islem, -abs(ana_t), f"Toplu ödeme: {plan['aciklama']}", 'odeme_plani', oid, oid, 'ODEME_PLANI')
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
    bugun = date.today()
    yil = yil or bugun.year
    ay  = ay  or bugun.month
    ay_basi = date(yil, ay, 1)
    ay_son  = date(yil, ay, cal.monthrange(yil, ay)[1])

    with db() as (conn, cur):
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

    # İzin verilen tablolar — şubeler ve kartlar asla silinmez
    IZINLI = {
        'ciro':           'ciro',
        'kasa':           'kasa_hareketleri',
        'kart_hareketleri': 'kart_hareketleri',
        'anlik_gider':    'anlik_giderler',
        'vadeli_alim':    'vadeli_alimlar',
        'personel':       'personel',
        'personel_aylik': 'personel_aylik',
        'sabit_gider':    'sabit_giderler',
        'borc':           'borc_envanteri',
        'odeme_plani':    'odeme_plani',
        'onay_kuyrugu':   'onay_kuyrugu',
        'audit_log':      'audit_log',
    }

    istenen = body.get('tablolar', list(IZINLI.keys()))  # boşsa hepsi
    silincekler = [IZINLI[k] for k in istenen if k in IZINLI]

    if not silincekler:
        raise HTTPException(400, "Silinecek tablo seçilmedi")

    with db() as (conn, cur):
        cur.execute(f"TRUNCATE TABLE {', '.join(silincekler)} CASCADE")

    return {"basarili": True, "silinen": silincekler,
            "mesaj": f"{len(silincekler)} tablo temizlendi."}

# Frontend
if pathlib.Path("static/index.html").exists():
    from fastapi.responses import FileResponse
    from fastapi import Request as _Req

    # assets önce mount edilmeli — wildcard route kapmadan
    app.mount("/assets", StaticFiles(directory="static/assets"), name="assets")

    @app.get("/")
    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str = "", request: _Req = None):
        """SPA routing — index.html'i her zaman no-cache ile sun"""
        import pathlib as _pl
        if full_path.startswith("api/") or full_path.startswith("assets/"):
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": "Not found"}, status_code=404)
        index = _pl.Path("static/index.html")
        if index.exists():
            return FileResponse(
                str(index),
                headers={"Cache-Control": "no-cache, no-store, must-revalidate",
                         "Pragma": "no-cache", "Expires": "0"}
            )
        return JSONResponse({"detail": "Frontend not built"}, status_code=404)
