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
import uuid, os, json, pathlib
from database import db, init_db
from motors import karar_motoru, odeme_strateji_motoru, nakit_akis_simulasyon, guncel_kasa, kasa_detay, kart_analiz_hesapla, aylik_odeme_plani_uret, uyari_motoru, finans_ozet_motoru

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

@app.on_event("startup")
def startup():
    init_db()
    # Her ay 1'inde otomatik ödeme planı üret
    bugun = date.today()
    if bugun.day == 1:
        try:
            sonuc = aylik_odeme_plani_uret(bugun.year, bugun.month)
            logger.info(f"Aylık ödeme planı üretildi: {sonuc['toplam']} kayıt")
        except Exception as e:
            logger.error(f"Ödeme planı üretim hatası: {e}")
    # Ay sonu faiz üretimi — ay son günü çalışır
    import calendar
    son_gun = calendar.monthrange(bugun.year, bugun.month)[1]
    if bugun.day == son_gun:
        try:
            sonuc = ekstre_bazli_faiz_uret()
            yazilan = sum(1 for k in sonuc['kartlar'] if k['durum'] == 'yazildi')
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

# Merkezi kasa etkisi mapping — bilinmeyen tip sistemi durdurur
KASA_ETKISI_MAP = {
    'CIRO':               True,
    'DIS_KAYNAK':         True,
    'ANLIK_GIDER':        True,
    'ANLIK_GIDER_IPTAL':  True,
    'KART_ODEME':         True,
    'KART_ODEME_IPTAL':   True,
    'KART_FAIZ':          True,
    'VADELI_ODEME':       True,
    'VADELI_IPTAL':       True,
    'PERSONEL_MAAS':      True,
    'SABIT_GIDER':        True,
    'ODEME_PLANI':        True,
    'ODEME_IPTAL':        True,
    'KASA_GIRIS':         True,
    'KASA_DUZELTME':      True,
    'POS_KESINTI':        True,
    'DIS_KAYNAK_IPTAL':   True,
    'DEVIR':              False,
}

def insert_kasa_hareketi(cur, tarih, islem_turu, tutar, aciklama,
                        kaynak_tablo=None, kaynak_id=None, ref_id=None, ref_type=None):
    """
    Merkezi kasa yazma fonksiyonu.

    TASARIM:
    - kaynak_id   = business ID (gider_id, ciro_id vb.) — değişmez
    - ref_id      = ledger event ID — her yazımda benzersiz
    - kasa_etkisi = KASA_ETKISI_MAP'ten alınır, bilinmeyen tip exception fırlatır

    Aynı kaynak silinip tekrar girilince yeni event ID üretilir,
    çakışma olmaz, ledger doğru akar.
    """
    if islem_turu not in KASA_ETKISI_MAP:
        raise Exception(f"Bilinmeyen islem_turu — sisteme eklemeden kullanılamaz: {islem_turu}")

    _event_id = ref_id or str(uuid.uuid4())
    _ref_type = ref_type or (kaynak_tablo.upper() if kaynak_tablo else 'GENEL')
    _kasa_etkisi = KASA_ETKISI_MAP[islem_turu]

    cur.execute("""
        INSERT INTO kasa_hareketleri
            (id, tarih, islem_turu, tutar, aciklama, kaynak_tablo, kaynak_id, ref_id, ref_type, kasa_etkisi)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """, (str(uuid.uuid4()), str(tarih), islem_turu, tutar, aciklama,
          kaynak_tablo, kaynak_id, _event_id, _ref_type, _kasa_etkisi))

    if cur.rowcount == 0:
        raise Exception(f"KASA YAZILMADI — {islem_turu} / {kaynak_id}")

def iptal_kasa_hareketi(cur, kaynak_id, kaynak_tablo, islem_turu,
                        iptal_turu, aciklama):
    """
    Merkezi kasa iptal fonksiyonu — GPT + Cloud kuralları:
    KURAL 1: Olmayan şey iptal edilemez
    KURAL 2: Aynı şey iki kez iptal edilemez
    KURAL 3: Her hareketin karşılığı vardır
    """
    # KURAL 1: Aktif kayıt var mı? — önce kontrol, sonra çek
    cur.execute("""
        SELECT 1 FROM kasa_hareketleri
        WHERE kaynak_id=%s AND islem_turu=%s AND durum='aktif'
        LIMIT 1
    """, (kaynak_id, islem_turu))
    if not cur.fetchone():
        raise Exception(f"İptal edilecek aktif kayıt bulunamadı — {islem_turu} / {kaynak_id}")

    cur.execute("""
        SELECT id, tutar FROM kasa_hareketleri
        WHERE kaynak_id=%s AND islem_turu=%s AND durum='aktif'
    """, (kaynak_id, islem_turu))
    mevcutlar = cur.fetchall()

    # KURAL 2: Bu kayıt daha önce iptal edilmiş mi?
    # durum filtresi YOK — iptal kaydı herhangi bir durumda varsa yeter
    cur.execute("""
        SELECT 1 FROM kasa_hareketleri
        WHERE kaynak_id=%s AND islem_turu=%s
        LIMIT 1
    """, (kaynak_id, iptal_turu))
    if cur.fetchone():
        raise Exception(f"Bu kayıt zaten iptal edilmiş — {iptal_turu} / {kaynak_id}")

    # Tümünü pasifleştir
    for m in mevcutlar:
        cur.execute("UPDATE kasa_hareketleri SET durum='iptal' WHERE id=%s", (m['id'],))

    # Net tutarı hesapla
    net_tutar = sum(float(m['tutar']) for m in mevcutlar)

    # KURAL 3: Ters kayıt yaz
    cur.execute("""
        INSERT INTO kasa_hareketleri
            (id, tarih, islem_turu, tutar, aciklama, kaynak_tablo, kaynak_id, ref_id, ref_type)
        VALUES (%s, CURRENT_DATE, %s, %s, %s, %s, %s, %s, %s)
    """, (str(uuid.uuid4()), iptal_turu, -net_tutar, aciklama,
          kaynak_tablo, kaynak_id, str(uuid.uuid4()), kaynak_tablo.upper()))

    if cur.rowcount == 0:
        raise Exception(f"İptal kaydı yazılamadı — {iptal_turu} / {kaynak_id}")

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
@app.get("/api/panel")
def panel():
    try:
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
        return ozet
    except Exception as e:
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
    COALESCE(SUM(CASE WHEN islem_turu IN ('ANLIK_GIDER','KART_ODEME','VADELI_ODEME','PERSONEL_MAAS','SABIT_GIDER') THEN ABS(tutar) ELSE 0 END), 0) as gider
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
        cur.execute("SELECT * FROM kasa_hareketleri WHERE id=%s AND islem_turu='DIS_KAYNAK' AND durum='aktif'", (gid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404, "Kayıt bulunamadı veya zaten iptal edilmiş")
        # Immutable model: pasifleştir + ters kayıt
        iptal_kasa_hareketi(cur, gid, 'dis_kaynak', 'DIS_KAYNAK', 'DIS_KAYNAK_IPTAL', 'Dış kaynak iptali')
        audit(cur, 'kasa_hareketleri', gid, 'IPTAL', eski=eski)
    return {"success": True}

# ── ANLIQ GİDER (beklenmeyen giderler) ────────────────────────
class AnlikGider(BaseModel):
    tarih: date
    kategori: str
    tutar: float
    aciklama: Optional[str] = None
    sube: Optional[str] = "MERKEZ"
    force: bool = False

@app.get("/api/anlik-gider")
def anlik_gider_listele():
    with db() as (conn, cur):
        cur.execute("SELECT * FROM anlik_giderler WHERE durum='aktif' ORDER BY tarih DESC LIMIT 200")
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
        gid = str(uuid.uuid4())
        cur.execute("""INSERT INTO anlik_giderler (id,tarih,kategori,tutar,aciklama,sube)
            VALUES (%s,%s,%s,%s,%s,%s)""",
            (gid, g.tarih, g.kategori, g.tutar, g.aciklama, g.sube))
        insert_kasa_hareketi(cur, g.tarih, 'ANLIK_GIDER', -abs(g.tutar),
            f"Anlık gider: {g.aciklama or g.kategori}", 'anlik_giderler', gid)
        audit(cur, 'anlik_giderler', gid, 'INSERT')
    return {"id": gid, "success": True}

@app.delete("/api/anlik-gider/{gid}")
def anlik_gider_sil(gid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM anlik_giderler WHERE id=%s AND durum='aktif'", (gid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404, "Kayıt bulunamadı veya zaten iptal edilmiş")
        # Gideri pasifleştir
        cur.execute("UPDATE anlik_giderler SET durum='iptal' WHERE id=%s", (gid,))
        # Immutable model: pasifleştir + ters kayıt
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
            # Güncel borç (tüm hareketler)
            cur.execute("""SELECT COALESCE(SUM(
                CASE WHEN islem_turu IN ('HARCAMA','FAIZ') THEN tutar WHEN islem_turu='ODEME' THEN -tutar ELSE 0 END),0) as borc
                FROM kart_hareketleri WHERE kart_id=%s AND durum='aktif'""", (k['id'],))
            borc = float(cur.fetchone()['borc'])

            # Bu ekstre = kesim gününe kadar tek çekim harcamalar + tüm taksitli harcamaların aylık taksiti
            # BANKA MANTIĞI: Taksitli alışveriş her ay dönem borcuna girer
            cur.execute("""SELECT COALESCE(SUM(tutar),0) as ekstre
                FROM kart_hareketleri
                WHERE kart_id=%s AND durum='aktif' AND islem_turu='HARCAMA'
                AND taksit_sayisi=1
                AND EXTRACT(DAY FROM tarih) <= %s""", (k['id'], k['kesim_gunu']))
            tek_cekim_ekstre = float(cur.fetchone()['ekstre'])

            # Taksitli harcamaların aylık taksit tutarı (banka mantığı: her ay dönem borcuna eklenir)
            cur.execute("""SELECT COALESCE(SUM(tutar::float / NULLIF(taksit_sayisi,0)),0) as aylik_taksit
                FROM kart_hareketleri
                WHERE kart_id=%s AND durum='aktif' AND islem_turu='HARCAMA' AND taksit_sayisi > 1""", (k['id'],))
            aylik_taksit = float(cur.fetchone()['aylik_taksit'])

            # Bu dönem ekstre = tek çekim + aylık taksit (banka gibi)
            bu_ekstre = tek_cekim_ekstre + aylik_taksit

            # Gelecek ekstre (kesim gününden sonraki tek çekim harcamalar + taksitler devam eder)
            cur.execute("""SELECT COALESCE(SUM(tutar),0) as gelecek
                FROM kart_hareketleri
                WHERE kart_id=%s AND durum='aktif' AND islem_turu='HARCAMA'
                AND taksit_sayisi=1
                AND EXTRACT(DAY FROM tarih) > %s""", (k['id'], k['kesim_gunu']))
            gelecek_tek = float(cur.fetchone()['gelecek'])
            gelecek_ekstre = gelecek_tek + aylik_taksit  # taksitler gelecek aya da girer

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

# ── KART HAREKETLERİ ───────────────────────────────────────────
class KartHareket(BaseModel):
    kart_id: str
    tarih: date
    islem_turu: str
    tutar: float
    taksit_sayisi: int = 1
    faiz_tutari: float = 0
    ana_para: float = 0
    aciklama: Optional[str] = None

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
        ana = abs(h.ana_para) if h.ana_para else 0
        cur.execute("""INSERT INTO kart_hareketleri
            (id,kart_id,tarih,islem_turu,tutar,taksit_sayisi,faiz_tutari,ana_para,aciklama)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (hid, h.kart_id, h.tarih, h.islem_turu, h.tutar, h.taksit_sayisi, faiz, ana, h.aciklama))
        if h.islem_turu == 'ODEME':
            onay_ekle(cur, 'KART_ODEME', 'kart_hareketleri', hid,
                f"Kart ödemesi: {h.aciklama or ''}", h.tutar, h.tarih)
        audit(cur, 'kart_hareketleri', hid, 'INSERT')
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

@app.post("/api/odeme-plani/{oid}/ode")
def odeme_yap(oid: str, tutar: Optional[float] = None):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM odeme_plani WHERE id=%s", (oid,))
        plan = cur.fetchone()
        if not plan: raise HTTPException(404)
        if plan['durum'] == 'odendi': raise HTTPException(400, "Zaten ödendi")
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

        # Anapara kısmı
        if ana_para_kismi > 0:
            insert_kasa_hareketi(cur, bugun, 'KART_ODEME', -abs(ana_para_kismi),
                f"Kart anapara: {plan['aciklama']}", 'odeme_plani', oid, oid, 'ODEME_PLANI')

        cur.execute("UPDATE onay_kuyrugu SET durum='onaylandi', onay_tarihi=NOW() WHERE kaynak_id=%s", (oid,))
        audit(cur, 'odeme_plani', oid, 'ODEME', eski=plan)

        # Faiz üretimi: ekstre_bazli_faiz_uret() ay sonunda veya manuel tetiklenir

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
        GIDER_TURLERI = {'KART_ODEME', 'ANLIK_GIDER', 'VADELI_ODEME', 'PERSONEL_MAAS', 'SABIT_GIDER', 'ODEME_PLANI'}
        GELIR_TURLERI = {'CIRO', 'CIRO_DUZELTME', 'DIS_KAYNAK', 'KASA_GIRIS', 'KASA_DUZELTME'}
        islem_turu = onay['islem_turu']
        if islem_turu in GIDER_TURLERI:
            signed_tutar = -abs(tutar)
        elif islem_turu in GELIR_TURLERI:
            signed_tutar = abs(tutar)
        else:
            signed_tutar = tutar
            logger.warning(f"Bilinmeyen işlem türü onaylandı: {islem_turu}, tutar={tutar}")
        # Merkezi fonksiyon — backend tek sorumlu, constraint yok
        insert_kasa_hareketi(cur, tarih, islem_turu, signed_tutar,
            f"Onaylandı: {onay['aciklama']}", onay['kaynak_tablo'], onay['kaynak_id'],
            ref_id=oid, ref_type='ONAY')
        # Onay durumunu güncelle — atomic (kasa yazılmazsa bu da çalışmaz)
        cur.execute("UPDATE onay_kuyrugu SET durum='onaylandi', onay_tarihi=NOW() WHERE id=%s AND durum='bekliyor'", (oid,))
        if cur.rowcount == 0:
            raise HTTPException(409, "Eş zamanlı onay çakışması — işlem zaten onaylandı.")
        audit(cur, 'onay_kuyrugu', oid, 'ONAYLANDI', eski=onay)
    return {"success": True}

@app.post("/api/onay-kuyrugu/{oid}/reddet")
def reddet(oid: str):
    with db() as (conn, cur):
        cur.execute("UPDATE onay_kuyrugu SET durum='reddedildi', onay_tarihi=NOW() WHERE id=%s", (oid,))
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
def ciro_listele(limit: int = 200):
    with db() as (conn, cur):
        cur.execute("""SELECT c.*, s.ad as sube_adi FROM ciro c
            LEFT JOIN subeler s ON s.id=c.sube_id
            WHERE c.durum='aktif' ORDER BY c.tarih DESC LIMIT %s""", (limit,))
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

@app.delete("/api/ciro/{cid}")
def ciro_sil(cid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM ciro WHERE id=%s AND durum='aktif'", (cid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404, "Kayıt bulunamadı veya zaten iptal edilmiş")

        # Ciroyu iptal et
        cur.execute("UPDATE ciro SET durum='iptal' WHERE id=%s", (cid,))

        # Tüm aktif kasa kayıtlarını pasifleştir (CIRO + kesintiler dahil)
        cur.execute("""UPDATE kasa_hareketleri SET durum='iptal'
            WHERE ref_id=%s AND ref_type='CIRO' AND durum='aktif'""", (cid,))

        # NOT: POS/ONLINE_KESINTI artık kasa_hareketleri'ne yazılmıyor
        # Panel bu değerleri ciro tablosundan hesaplıyor

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
    baslangic_tarihi: Optional[date] = None
    sube_id: Optional[str] = None
    notlar: Optional[str] = None

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
             p.yemek_ucreti, p.yol_ucreti, p.odeme_gunu, p.baslangic_tarihi, p.sube_id, p.notlar))
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
             p.yemek_ucreti, p.yol_ucreti, p.odeme_gunu, p.baslangic_tarihi,
             p.sube_id, p.notlar, pid))
        audit(cur, 'personel', pid, 'UPDATE', eski=eski)
    return {"success": True}

@app.post("/api/personel/{pid}/cikis")
def personel_cikis(pid: str, neden: str = ""):
    with db() as (conn, cur):
        cur.execute("UPDATE personel SET aktif=FALSE, cikis_tarihi=%s WHERE id=%s",
            (str(date.today()), pid))
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

# ── SABİT GİDERLER ─────────────────────────────────────────────
class SabitGider(BaseModel):
    gider_adi: str
    kategori: str
    tutar: float
    periyot: str = 'aylik'
    odeme_gunu: int = 1
    baslangic_tarihi: Optional[date] = None
    sube_id: Optional[str] = None

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
        cur.execute("""INSERT INTO sabit_giderler (id,gider_adi,kategori,tutar,periyot,odeme_gunu,baslangic_tarihi,sube_id)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
            (gid, g.gider_adi, g.kategori, g.tutar, g.periyot, g.odeme_gunu, g.baslangic_tarihi, g.sube_id))
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
        cur.execute("""UPDATE sabit_giderler SET gider_adi=%s,kategori=%s,tutar=%s,
            periyot=%s,odeme_gunu=%s,baslangic_tarihi=%s,sube_id=%s WHERE id=%s""",
            (g.gider_adi, g.kategori, g.tutar, g.periyot, g.odeme_gunu, g.baslangic_tarihi, g.sube_id, gid))
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

# ── VADELİ ALIMLAR ─────────────────────────────────────────────
class VadeliAlim(BaseModel):
    aciklama: str
    tutar: float
    vade_tarihi: date
    tedarikci: Optional[str] = None
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
        audit(cur, 'vadeli_alimlar', vid, 'UPDATE', eski=eski)
    return {"success": True}

@app.delete("/api/vadeli-alimlar/{vid}")
def vadeli_sil(vid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM vadeli_alimlar WHERE id=%s AND durum='bekliyor'", (vid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404, "Kayıt bulunamadı veya zaten ödenmiş/iptal edilmiş")
        cur.execute("UPDATE vadeli_alimlar SET durum='iptal' WHERE id=%s", (vid,))
        # Immutable model: pasifleştir + ters kayıt
        iptal_kasa_hareketi(cur, vid, 'vadeli_alimlar', 'VADELI_ODEME', 'VADELI_IPTAL', 'Vadeli alım iptali')
        audit(cur, 'vadeli_alimlar', vid, 'IPTAL', eski=eski)
    return {"success": True}

@app.post("/api/vadeli-alimlar/{vid}/ode")
def vadeli_ode(vid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM vadeli_alimlar WHERE id=%s", (vid,))
        v = cur.fetchone()
        if not v: raise HTTPException(404)
        cur.execute("UPDATE vadeli_alimlar SET durum='odendi' WHERE id=%s", (vid,))
        # Vadeli ödeme kasadan çıkar → negatif
        insert_kasa_hareketi(cur, date.today(), 'VADELI_ODEME', -abs(float(v['tutar'])),
            f"Vadeli: {v['aciklama']}", 'vadeli_alimlar', vid)
        audit(cur, 'vadeli_alimlar', vid, 'ODEME', eski=v)
    return {"success": True}

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
    with db() as (conn, cur):
        bid = str(uuid.uuid4())
        cur.execute("""INSERT INTO borc_envanteri (id,kurum,borc_turu,toplam_borc,aylik_taksit,kalan_vade,toplam_vade,baslangic_tarihi,odeme_gunu)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (bid, b.kurum, b.borc_turu, b.toplam_borc, b.aylik_taksit, b.kalan_vade, b.toplam_vade, b.baslangic_tarihi, b.odeme_gunu))
        audit(cur, 'borc_envanteri', bid, 'INSERT')
    return {"id": bid, "success": True}

@app.put("/api/borclar/{bid}")
def borc_guncelle(bid: str, b: BorcModel):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM borc_envanteri WHERE id=%s", (bid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)
        cur.execute("""UPDATE borc_envanteri SET kurum=%s,borc_turu=%s,toplam_borc=%s,aylik_taksit=%s,
            kalan_vade=%s,toplam_vade=%s,baslangic_tarihi=%s,odeme_gunu=%s WHERE id=%s""",
            (b.kurum, b.borc_turu, b.toplam_borc, b.aylik_taksit, b.kalan_vade, b.toplam_vade, b.baslangic_tarihi, b.odeme_gunu, bid))
        audit(cur, 'borc_envanteri', bid, 'UPDATE', eski=eski)
    return {"success": True}

@app.delete("/api/borclar/{bid}")
def borc_sil(bid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM borc_envanteri WHERE id=%s", (bid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)
        cur.execute("UPDATE borc_envanteri SET aktif=FALSE WHERE id=%s", (bid,))
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
                            cur.execute("SELECT id FROM subeler WHERE LOWER(ad)=LOWER(%s)", (str(d.get('sube','MERKEZ')),))
                            r = cur.fetchone()
                            if r: sube_id = r['id']
                            cid = str(uuid.uuid4())
                            nakit = float(d.get('nakit') or 0)
                            pos = float(d.get('pos') or 0)
                            online = float(d.get('online') or 0)
                            cur.execute("""INSERT INTO ciro (id,tarih,sube_id,nakit,pos,online,aciklama)
                                VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                                (cid, fix_date(d.get('tarih')), sube_id, nakit, pos, online, str(d.get('aciklama') or '')))
                            if cur.rowcount > 0:
                                toplam_ciro = nakit + pos + online
                                # Merkezi fonksiyon — manuel ciro ile aynı model
                                insert_kasa_hareketi(cur, fix_date(d.get('tarih')), 'CIRO',
                                    abs(toplam_ciro), 'Excel import - ciro', 'ciro', cid,
                                    ref_id=cid, ref_type='CIRO')
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
                            cur.execute("""INSERT INTO sabit_giderler (id,gider_adi,kategori,tutar,periyot,odeme_gunu,sube_id)
                                VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                                (str(uuid.uuid4()), str(d.get('gider_adi','')),
                                 str(d.get('kategori','Diğer')),
                                 float(d.get('tutar') or 0),
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
    """Ödemeyi ertele — yeni tarih verilmezse 7 gün sonraya atar."""
    with db() as (conn, cur):
        cur.execute("SELECT * FROM odeme_plani WHERE id=%s AND durum='bekliyor'", (oid,))
        o = cur.fetchone()
        if not o: raise HTTPException(404)
        yeni = yeni_tarih or (o['tarih'] + timedelta(days=7))
        cur.execute("UPDATE odeme_plani SET tarih=%s WHERE id=%s", (yeni, oid))
        audit(cur, 'odeme_plani', oid, 'ERTELE')
    return {"success": True, "yeni_tarih": str(yeni)}

@app.get("/api/kasa-detay")
def kasa_detay_endpoint():
    """Kasa'yı işlem türü bazında gösterir — her türün ne kadar etki yaptığını döker."""
    try:
        return kasa_detay()
    except Exception as e:
        raise HTTPException(500, str(e))

# ── EKSTRE FAİZİ ───────────────────────────────────────────────
class EkstreFaiz(BaseModel):
    kart_id: str
    tutar: float
    donem: str  # '2024-03' formatında
    aciklama: Optional[str] = None

@app.post("/api/kart-faiz")
def ekstre_faiz_ekle(f: EkstreFaiz):
    """
    Ekstre geldiğinde faizi borca kayıt et.
    Bu nakit çıkışı değil — borca eklenen maliyet kaydı.
    """
    with db() as (conn, cur):
        cur.execute("SELECT * FROM kartlar WHERE id=%s", (f.kart_id,))
        kart = cur.fetchone()
        if not kart: raise HTTPException(404, "Kart bulunamadı")
        fid = str(uuid.uuid4())
        # Kart hareketlerine FAİZ tipi olarak kayıt
        cur.execute("""
            INSERT INTO kart_hareketleri
                (id, kart_id, tarih, islem_turu, tutar, taksit_sayisi, aciklama)
            VALUES (%s, %s, CURRENT_DATE, 'FAIZ', %s, 1, %s)
        """, (fid, f.kart_id, abs(f.tutar), f.aciklama or f"{f.donem} ekstre faizi"))
        audit(cur, 'kart_hareketleri', fid, 'FAIZ_EKLENDI')
    return {"id": fid, "success": True}

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

# ── EKSTREBAZlı FAİZ MOTORU ────────────────────────────────────
def ekstre_bazli_faiz_uret(kart_id: str = None):
    """
    Her kart için:
    1. Bu dönem ekstre = bu_ekstre
    2. Ödenen = ödeme planından odenen_tutar
    3. Kalan = ekstre - ödenen
    4. Kalan > 0 ise → faiz kaydı yaz
    
    Ay sonunda veya manuel tetiklenebilir.
    Aynı dönem için 2 kez faiz yazılmaz (unique kontrol).
    """
    from datetime import date
    bugun = date.today()
    donem = bugun.strftime('%Y-%m')
    
    with db() as (conn, cur):
        sorgu = "SELECT * FROM kartlar WHERE aktif=TRUE"
        params = ()
        if kart_id:
            sorgu += " AND id=%s"
            params = (kart_id,)
        cur.execute(sorgu, params)
        kartlar = cur.fetchall()
        
        sonuclar = []
        for k in kartlar:
            kid = k['id']
            faiz_orani = float(k['faiz_orani']) / 100.0 / 12.0
            
            # Bu dönem ekstre (kesim gününe kadar tek çekim + taksitler)
            cur.execute("""
                SELECT COALESCE(SUM(tutar),0) as tek FROM kart_hareketleri
                WHERE kart_id=%s AND durum='aktif' AND islem_turu='HARCAMA'
                AND taksit_sayisi=1
                AND EXTRACT(YEAR FROM tarih) = %s
                AND EXTRACT(MONTH FROM tarih) = %s
            """, (kid, bugun.year, bugun.month))
            tek_cekim = float(cur.fetchone()['tek'])
            
            cur.execute("""
                SELECT COALESCE(SUM(tutar::float/NULLIF(taksit_sayisi,0)),0) as t
                FROM kart_hareketleri
                WHERE kart_id=%s AND durum='aktif' AND islem_turu='HARCAMA' AND taksit_sayisi>1
            """, (kid,))
            taksit = float(cur.fetchone()['t'])
            bu_ekstre = tek_cekim + taksit
            
            if bu_ekstre <= 0:
                continue
            
            # Bu dönem ödenen (odeme_plani üzerinden)
            cur.execute("""
                SELECT COALESCE(SUM(odenen_tutar),0) as odenen
                FROM odeme_plani
                WHERE kart_id=%s AND durum='odendi'
                AND EXTRACT(YEAR FROM odeme_tarihi) = %s
                AND EXTRACT(MONTH FROM odeme_tarihi) = %s
            """, (kid, bugun.year, bugun.month))
            odenen = float(cur.fetchone()['odenen'])
            
            # Kalan ekstre borcu (revolving balance)
            kalan = max(0.0, bu_ekstre - odenen)
            
            if kalan <= 0:
                sonuclar.append({'kart': k['kart_adi'], 'durum': 'tam_odendi', 'faiz': 0})
                continue
            
            # Bu dönem için faiz zaten yazılmış mı?
            cur.execute("""
                SELECT id FROM kart_hareketleri
                WHERE kart_id=%s AND islem_turu='FAIZ'
                AND aciklama LIKE %s AND durum='aktif'
            """, (kid, f"%%{donem}%%"))
            if cur.fetchone():
                sonuclar.append({'kart': k['kart_adi'], 'durum': 'zaten_yazilmis', 'faiz': 0})
                continue
            
            # Faiz hesapla ve yaz
            faiz_tutari = round(kalan * faiz_orani, 2)
            if faiz_tutari < 0.01:
                continue
            
            hid = str(uuid.uuid4())
            cur.execute("""
                INSERT INTO kart_hareketleri
                (id, kart_id, tarih, islem_turu, tutar, faiz_tutari, aciklama)
                VALUES (%s, %s, %s, 'FAIZ', %s, %s, %s)
            """, (hid, kid, bugun, faiz_tutari, faiz_tutari,
                  f"{donem} ekstre faizi (kalan:{kalan:.2f})"))
            
            # Kasaya da yaz (bu ay yanan para)
            insert_kasa_hareketi(cur, bugun, 'KART_FAIZ', -faiz_tutari,
                f"{k['kart_adi']} {donem} faizi", 'kart_hareketleri', hid,
                hid, 'KART_FAIZ')
            
            sonuclar.append({
                'kart': k['kart_adi'],
                'ekstre': bu_ekstre,
                'odenen': odenen,
                'kalan': kalan,
                'faiz': faiz_tutari,
                'durum': 'yazildi'
            })
        
        return {'donem': donem, 'kartlar': sonuclar}

@app.post("/api/kartlar/faiz-uret")
def faiz_uret(kart_id: str = None):
    """Ekstre bazlı faiz hesapla ve kart_hareketleri'ne yaz."""
    try:
        return ekstre_bazli_faiz_uret(kart_id)
    except Exception as e:
        raise HTTPException(500, str(e))

# ── AY DEVIR (HESAPLANAN — ledger'a yazılmaz) ──────────────────
def devir_hesapla(yil: int = None, ay: int = None):
    """
    Geçen ayın kapanış kasasını SQL ile hesaplar.
    Ledger'a hiçbir şey yazılmaz — immutable model korunur.
    """
    import calendar
    bugun = date.today()
    yil = yil or bugun.year
    ay = ay or bugun.month

    if ay == 1:
        gecen_yil, gecen_ay = yil - 1, 12
    else:
        gecen_yil, gecen_ay = yil, ay - 1

    gecen_ay_son = date(gecen_yil, gecen_ay,
                        calendar.monthrange(gecen_yil, gecen_ay)[1])

    with db() as (conn, cur):
        cur.execute("""
            SELECT COALESCE(SUM(tutar), 0) as devir
            FROM kasa_hareketleri
            WHERE durum='aktif' AND tarih <= %s
        """, (gecen_ay_son,))
        devir = float(cur.fetchone()['devir'])

    return {
        "devir_tutar": devir,
        "gecen_ay": f"{gecen_yil}-{gecen_ay:02d}",
        "hesaplandi": True
    }

@app.get("/api/devir")
def devir_goster(yil: int = None, ay: int = None):
    """Geçen ay kapanış kasasını hesapla (ledger'a yazmaz)."""
    try:
        return devir_hesapla(yil, ay)
    except Exception as e:
        raise HTTPException(500, str(e))

# ── KART FAİZ HESAPLAMA MOTORU ─────────────────────────────────
@app.post("/api/kartlar/{kid}/faiz-hesapla")
def kart_faiz_hesapla(kid: str, body: dict = {}):
    """
    Ay sonu faiz hesaplaması.
    Doğru taban: bu_ekstre - odenen_tutar = ödenmeyen bakiye
    Faiz bu bakiye üzerinden uygulanır.
    body: { ay: 'YYYY-MM' }  (boş bırakılırsa geçen ay)
    """
    import calendar
    bugun = date.today()
    hedef_ay_str = body.get('ay')

    if hedef_ay_str:
        yil, ay = map(int, hedef_ay_str.split('-'))
    else:
        # Geçen ay
        if bugun.month == 1:
            yil, ay = bugun.year - 1, 12
        else:
            yil, ay = bugun.year, bugun.month - 1

    ay_son = date(yil, ay, calendar.monthrange(yil, ay)[1])

    with db() as (conn, cur):
        cur.execute("SELECT * FROM kartlar WHERE id=%s AND aktif=TRUE", (kid,))
        k = cur.fetchone()
        if not k:
            raise HTTPException(404, "Kart bulunamadı")

        # Bu dönemin ekstresini hesapla (tek çekim + taksit)
        cur.execute("""
            SELECT COALESCE(SUM(tutar), 0) as tek_cekim
            FROM kart_hareketleri
            WHERE kart_id=%s AND durum='aktif'
            AND islem_turu='HARCAMA' AND taksit_sayisi=1
            AND EXTRACT(YEAR FROM tarih)=%s AND EXTRACT(MONTH FROM tarih)=%s
            AND EXTRACT(DAY FROM tarih) <= %s
        """, (kid, yil, ay, k['kesim_gunu']))
        tek_cekim = float(cur.fetchone()['tek_cekim'])

        cur.execute("""
            SELECT COALESCE(SUM(tutar::float / NULLIF(taksit_sayisi,0)), 0) as taksit
            FROM kart_hareketleri
            WHERE kart_id=%s AND durum='aktif'
            AND islem_turu='HARCAMA' AND taksit_sayisi > 1
        """, (kid,))
        aylik_taksit = float(cur.fetchone()['taksit'])

        bu_ekstre = tek_cekim + aylik_taksit

        # Bu dönemde yapılan ödeme
        cur.execute("""
            SELECT COALESCE(SUM(odenen_tutar), 0) as odenen
            FROM odeme_plani
            WHERE kart_id=%s AND durum='odendi'
            AND EXTRACT(YEAR FROM odeme_tarihi)=%s
            AND EXTRACT(MONTH FROM odeme_tarihi)=%s
        """, (kid, yil, ay))
        odenen = float(cur.fetchone()['odenen'])

        # Faiz tabanı: ödenmeyen ekstre bakiyesi
        faiz_tabani = max(0.0, bu_ekstre - odenen)
        faiz_orani = float(k['faiz_orani'])
        faiz_tutari = round(faiz_tabani * faiz_orani / 100, 2)

        if faiz_tutari <= 0:
            return {
                "kart": k['kart_adi'],
                "bu_ekstre": bu_ekstre,
                "odenen": odenen,
                "faiz_tabani": faiz_tabani,
                "faiz_tutari": 0,
                "mesaj": "Ekstre tam ödendi, faiz yok"
            }

        # Zaten bu ay için faiz kaydı var mı?
        donem = f"{yil}-{ay:02d}"
        cur.execute("""
            SELECT id FROM kart_hareketleri
            WHERE kart_id=%s AND islem_turu='FAIZ'
            AND aciklama LIKE %s AND durum='aktif'
        """, (kid, f"%%{donem}%%"))
        if cur.fetchone():
            return {
                "kart": k['kart_adi'],
                "faiz_tutari": faiz_tutari,
                "mesaj": f"Bu dönem ({donem}) faizi zaten girilmiş"
            }

        # Faiz kaydı yaz
        faiz_id = str(uuid.uuid4())
        cur.execute("""
            INSERT INTO kart_hareketleri
                (id, kart_id, tarih, islem_turu, tutar, faiz_tutari, ana_para, aciklama)
            VALUES (%s, %s, %s, 'FAIZ', %s, %s, 0, %s)
        """, (faiz_id, kid, str(bugun), faiz_tutari, faiz_tutari,
              f"{donem} dönem faizi ({k['kart_adi']})"))

        audit(cur, 'kart_hareketleri', faiz_id, 'FAIZ_HESAPLA')

    return {
        "kart": k['kart_adi'],
        "donem": donem,
        "bu_ekstre": bu_ekstre,
        "odenen": odenen,
        "faiz_tabani": faiz_tabani,
        "faiz_orani": faiz_orani,
        "faiz_tutari": faiz_tutari,
        "mesaj": f"Faiz hesaplandı ve kart hareketlerine eklendi"
    }

@app.post("/api/kartlar/toplu-faiz-hesapla")
def toplu_faiz_hesapla(body: dict = {}):
    """Tüm aktif kartlar için faiz hesapla."""
    with db() as (conn, cur):
        cur.execute("SELECT id FROM kartlar WHERE aktif=TRUE")
        kartlar = [r['id'] for r in cur.fetchall()]

    sonuclar = []
    for kid in kartlar:
        try:
            r = kart_faiz_hesapla(kid, body)
            sonuclar.append(r)
        except Exception as e:
            sonuclar.append({"kart_id": kid, "hata": str(e)})

    return {"sonuclar": sonuclar, "toplam": len(sonuclar)}

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
                insert_kasa_hareketi(cur, bugun, 'KART_ODEME', -abs(ana_t), f"Toplu anapara: {plan['aciklama']}", 'odeme_plani', oid, oid, 'ODEME_PLANI')
            cur.execute("UPDATE onay_kuyrugu SET durum='onaylandi', onay_tarihi=NOW() WHERE kaynak_id=%s", (oid,))
            audit(cur, 'odeme_plani', oid, 'TOPLU_ODEME', eski=plan)
            basarili.append(oid)
        # Hepsi başarılıysa commit (with db() otomatik commit eder)
    return {"success": True, "uygulanan": len(basarili), "odemeler": basarili}

# ── AY SONU RAPOR (Excel) ──────────────────────────────────────
@app.get("/api/rapor/aylik")
def aylik_rapor(yil: int = None, ay: int = None):
    """
    Aylık finansal rapor verisi — Excel için hazırlanmış.
    yil/ay boş bırakılırsa bu ay.
    """
    from datetime import date
    bugun = date.today()
    yil = yil or bugun.year
    ay = ay or bugun.month

    with db() as (conn, cur):
        # 0. Başlangıç kasası (ay başı devir)
        import calendar
        ay_basi = date(yil, ay, 1)
        ay_son = date(yil, ay, calendar.monthrange(yil, ay)[1])
        cur.execute("""
            SELECT COALESCE(SUM(tutar), 0) as baslangic
            FROM kasa_hareketleri WHERE durum='aktif' AND kasa_etkisi = true AND tarih < %s
        """, (ay_basi,))
        baslangic_kasa = float(cur.fetchone()['baslangic'])

        # 1a. Ciro nakit/pos/online breakdown
        cur.execute("""
            SELECT
                COALESCE(SUM(nakit), 0) as nakit,
                COALESCE(SUM(pos), 0) as pos,
                COALESCE(SUM(online), 0) as online
            FROM ciro WHERE durum='aktif'
            AND EXTRACT(YEAR FROM tarih) = %s
            AND EXTRACT(MONTH FROM tarih) = %s
        """, (yil, ay))
        ciro_breakdown = dict(cur.fetchone())

        # 1. Özet
        cur.execute("""
            SELECT
                COALESCE(SUM(CASE WHEN islem_turu='CIRO' THEN tutar ELSE 0 END), 0) as sadece_ciro,
                COALESCE(SUM(CASE WHEN islem_turu='DIS_KAYNAK' THEN tutar ELSE 0 END), 0) as dis_kaynak,
                COALESCE(SUM(CASE WHEN tutar > 0 THEN tutar ELSE 0 END), 0) as toplam_gelir,
                COALESCE(SUM(CASE WHEN tutar < 0 THEN ABS(tutar) ELSE 0 END), 0) as toplam_gider,
                COALESCE(SUM(CASE WHEN islem_turu='CIRO' THEN tutar ELSE 0 END), 0) as ciro_toplam,
                COALESCE(SUM(CASE WHEN islem_turu='DIS_KAYNAK' THEN tutar ELSE 0 END), 0) as dis_kaynak_toplam,
                COALESCE(SUM(CASE WHEN islem_turu='DEVIR' THEN tutar ELSE 0 END), 0) as devir_toplam,
                COALESCE(SUM(CASE WHEN islem_turu='KART_ODEME' THEN ABS(tutar) ELSE 0 END), 0) as kart_odeme_toplam,
                COALESCE(SUM(CASE WHEN islem_turu='ANLIK_GIDER' THEN ABS(tutar) ELSE 0 END), 0) as anlik_gider_toplam,
                COALESCE(SUM(CASE WHEN islem_turu='VADELI_ODEME' THEN ABS(tutar) ELSE 0 END), 0) as vadeli_toplam,
                COALESCE(SUM(CASE WHEN islem_turu='PERSONEL_MAAS' THEN ABS(tutar) ELSE 0 END), 0) as maas_toplam,
                COALESCE(SUM(CASE WHEN islem_turu='SABIT_GIDER' THEN ABS(tutar) ELSE 0 END), 0) as sabit_toplam,
                COALESCE(SUM(tutar), 0) as net_kasa
            FROM kasa_hareketleri
            WHERE durum='aktif'
            AND EXTRACT(YEAR FROM tarih) = %s
            AND EXTRACT(MONTH FROM tarih) = %s
        """, (yil, ay))
        ozet = dict(cur.fetchone())

        # 2. Şube bazlı ciro
        cur.execute("""
            SELECT s.ad as sube, COALESCE(SUM(c.toplam), 0) as ciro,
                   COALESCE(SUM(c.nakit), 0) as nakit,
                   COALESCE(SUM(c.pos), 0) as pos,
                   COALESCE(SUM(c.online), 0) as online,
                   COUNT(*) as islem_sayisi
            FROM ciro c
            LEFT JOIN subeler s ON s.id = c.sube_id
            WHERE c.durum='aktif'
            AND EXTRACT(YEAR FROM c.tarih) = %s
            AND EXTRACT(MONTH FROM c.tarih) = %s
            GROUP BY s.ad ORDER BY ciro DESC
        """, (yil, ay))
        sube_ciro = [dict(r) for r in cur.fetchall()]

        # 3. Günlük kasa hareketi
        cur.execute("""
            SELECT tarih, islem_turu,
                   COALESCE(SUM(CASE WHEN tutar > 0 THEN tutar ELSE 0 END), 0) as giris,
                   COALESCE(SUM(CASE WHEN tutar < 0 THEN ABS(tutar) ELSE 0 END), 0) as cikis,
                   SUM(tutar) as net
            FROM kasa_hareketleri
            WHERE durum='aktif'
            AND EXTRACT(YEAR FROM tarih) = %s
            AND EXTRACT(MONTH FROM tarih) = %s
            AND kasa_etkisi = true
            GROUP BY tarih, islem_turu
            ORDER BY tarih, islem_turu
        """, (yil, ay))
        gunluk = [dict(r) for r in cur.fetchall()]

        # 4. Kategori bazlı giderler
        cur.execute("""
            SELECT ag.kategori,
                   COUNT(*) as adet,
                   COALESCE(SUM(ag.tutar), 0) as toplam
            FROM anlik_giderler ag
            WHERE ag.durum='aktif'
            AND EXTRACT(YEAR FROM ag.tarih) = %s
            AND EXTRACT(MONTH FROM ag.tarih) = %s
            GROUP BY ag.kategori ORDER BY toplam DESC
        """, (yil, ay))
        gider_kategori = [dict(r) for r in cur.fetchall()]

        # 5. Kart ödemeleri
        cur.execute("""
            SELECT k.kart_adi, k.banka,
                   COALESCE(SUM(op.odenen_tutar), 0) as odenen,
                   COUNT(*) as adet
            FROM odeme_plani op
            JOIN kartlar k ON k.id = op.kart_id
            WHERE op.durum='odendi'
            AND EXTRACT(YEAR FROM op.odeme_tarihi) = %s
            AND EXTRACT(MONTH FROM op.odeme_tarihi) = %s
            GROUP BY k.kart_adi, k.banka ORDER BY odenen DESC
        """, (yil, ay))
        kart_odemeler = [dict(r) for r in cur.fetchall()]

        # 6. En karlı / zararlı şube
        en_karli = max(sube_ciro, key=lambda x: x['ciro']) if sube_ciro else None
        en_az = min(sube_ciro, key=lambda x: x['ciro']) if sube_ciro else None

        ozet['baslangic_kasa'] = baslangic_kasa
        ozet['bitis_kasa'] = baslangic_kasa + float(ozet.get('net_kasa', 0))

        ozet['ciro_nakit'] = float(ciro_breakdown['nakit'])
        ozet['ciro_pos'] = float(ciro_breakdown['pos'])
        ozet['ciro_online'] = float(ciro_breakdown['online'])

        return {
            "donem": f"{yil}-{ay:02d}",
            "ozet": ozet,
            "sube_ciro": sube_ciro,
            "gunluk_hareketler": gunluk,
            "gider_kategoriler": gider_kategori,
            "kart_odemeler": kart_odemeler,
            "en_karli_sube": en_karli,
            "en_az_sube": en_az,
        }

@app.get("/api/rapor/aylik/excel")
def aylik_rapor_excel(yil: int = None, ay: int = None):
    """Aylık raporu Excel dosyası olarak indir."""
    import io
    from datetime import date
    try:
        import openpyxl
        from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    except ImportError:
        raise HTTPException(500, "openpyxl kurulu değil")

    bugun = date.today()
    yil = yil or bugun.year
    ay = ay or bugun.month
    veri = aylik_rapor(yil, ay)

    wb = openpyxl.Workbook()

    # Yardımcı stiller
    BASLIK = Font(bold=True, size=12, color="FFFFFF")
    BASLIK_FILL = PatternFill("solid", fgColor="1a2744")
    ALBASLIK = Font(bold=True, size=10)
    ALBASLIK_FILL = PatternFill("solid", fgColor="2d4a8a")
    ALBASLIK_FONT = Font(bold=True, color="FFFFFF")
    PARA = '#,##0.00 ₺'
    YUMUSAK = PatternFill("solid", fgColor="f0f4ff")

    def baslik_satiri(ws, row, cols, text, fill=None):
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=cols)
        c = ws.cell(row=row, column=1, value=text)
        c.font = BASLIK
        c.fill = fill or BASLIK_FILL
        c.alignment = Alignment(horizontal='center')

    def sutun_baslik(ws, row, headers):
        for i, h in enumerate(headers, 1):
            c = ws.cell(row=row, column=i, value=h)
            c.font = ALBASLIK_FONT
            c.fill = ALBASLIK_FILL
            c.alignment = Alignment(horizontal='center')

    # ── SAYFA 1: ÖZET ──
    ws1 = wb.active
    ws1.title = "Özet"
    ws1.column_dimensions['A'].width = 30
    ws1.column_dimensions['B'].width = 20

    baslik_satiri(ws1, 1, 2, f"EVVEL ERP — {veri['donem']} AY SONU RAPORU")
    ozet = veri['ozet']
    satirlar = [
        ("", ""),
        ("GELİRLER", ""),
        ("Ciro Toplamı", ozet['ciro_toplam']),
        ("  └ Nakit", ozet.get('ciro_nakit', 0)),
        ("  └ POS", ozet.get('ciro_pos', 0)),
        ("  └ Online", ozet.get('ciro_online', 0)),
        ("Dış Kaynak", ozet['dis_kaynak_toplam']),
        ("Devir (Önceki Aydan)", ozet['devir_toplam']),
        ("TOPLAM GELİR", ozet['toplam_gelir']),
        ("", ""),
        ("GİDERLER", ""),
        ("Kart Ödemeleri", ozet['kart_odeme_toplam']),
        ("Anlık Giderler", ozet['anlik_gider_toplam']),
        ("Vadeli Ödemeler", ozet['vadeli_toplam']),
        ("Personel Maaşları", ozet['maas_toplam']),
        ("Sabit Giderler", ozet['sabit_toplam']),
        ("TOPLAM GİDER", ozet['toplam_gider']),
        ("", ""),
        ("NET KAR / ZARAR", ozet['toplam_gelir'] - ozet['toplam_gider']),
        ("AY SONU KASA", ozet['net_kasa']),
    ]
    for r, (k, v) in enumerate(satirlar, 3):
        c1 = ws1.cell(row=r, column=1, value=k)
        c2 = ws1.cell(row=r, column=2, value=v if isinstance(v, (int, float)) else v)
        if k in ("TOPLAM GELİR", "TOPLAM GİDER", "NET KAR / ZARAR", "AY SONU KASA"):
            c1.font = Font(bold=True)
            c2.font = Font(bold=True)
            c2.fill = PatternFill("solid", fgColor="e8f5e9" if k != "TOPLAM GİDER" else "ffebee")
        if isinstance(v, (int, float)):
            c2.number_format = PARA
        if k in ("GELİRLER", "GİDERLER"):
            c1.font = Font(bold=True, size=11)
            c1.fill = YUMUSAK

    # ── SAYFA 2: ŞUBE CİRO ──
    ws2 = wb.create_sheet("Şube Ciro")
    ws2.column_dimensions['A'].width = 25
    for col in ['B','C','D','E','F']: ws2.column_dimensions[col].width = 18
    baslik_satiri(ws2, 1, 6, "ŞUBE BAZLI CİRO RAPORU")
    sutun_baslik(ws2, 2, ["Şube", "Toplam Ciro", "Nakit", "POS", "Online", "İşlem Sayısı"])
    for r, s in enumerate(veri['sube_ciro'], 3):
        ws2.cell(row=r, column=1, value=s['sube'])
        for ci, k in enumerate(['ciro','nakit','pos','online'], 2):
            c = ws2.cell(row=r, column=ci, value=float(s[k]))
            c.number_format = PARA
        ws2.cell(row=r, column=6, value=s['islem_sayisi'])
        if r % 2 == 0:
            for ci in range(1, 7): ws2.cell(row=r, column=ci).fill = YUMUSAK

    # ── SAYFA 3: GİDER KATEGORİLER ──
    ws3 = wb.create_sheet("Gider Analizi")
    ws3.column_dimensions['A'].width = 25
    ws3.column_dimensions['B'].width = 18
    ws3.column_dimensions['C'].width = 12
    baslik_satiri(ws3, 1, 3, "GİDER KATEGORİ ANALİZİ")
    sutun_baslik(ws3, 2, ["Kategori", "Toplam", "Adet"])
    for r, g in enumerate(veri['gider_kategoriler'], 3):
        ws3.cell(row=r, column=1, value=g['kategori'])
        c = ws3.cell(row=r, column=2, value=float(g['toplam']))
        c.number_format = PARA
        ws3.cell(row=r, column=3, value=g['adet'])

    # ── SAYFA 4: KART ÖDEMELERİ ──
    ws4 = wb.create_sheet("Kart Ödemeleri")
    ws4.column_dimensions['A'].width = 25
    ws4.column_dimensions['B'].width = 20
    ws4.column_dimensions['C'].width = 18
    ws4.column_dimensions['D'].width = 12
    baslik_satiri(ws4, 1, 4, "KART ÖDEMELERİ")
    sutun_baslik(ws4, 2, ["Kart", "Banka", "Ödenen", "Adet"])
    for r, k in enumerate(veri['kart_odemeler'], 3):
        ws4.cell(row=r, column=1, value=k['kart_adi'])
        ws4.cell(row=r, column=2, value=k['banka'])
        c = ws4.cell(row=r, column=3, value=float(k['odenen']))
        c.number_format = PARA
        ws4.cell(row=r, column=4, value=k['adet'])

    # ── SAYFA 5: GÜNLÜK HAREKETLER ──
    ws5 = wb.create_sheet("Günlük Hareketler")
    ws5.column_dimensions['A'].width = 14
    ws5.column_dimensions['B'].width = 22
    ws5.column_dimensions['C'].width = 18
    ws5.column_dimensions['D'].width = 18
    ws5.column_dimensions['E'].width = 18
    baslik_satiri(ws5, 1, 5, "GÜNLÜK KASA HAREKETLERİ")
    sutun_baslik(ws5, 2, ["Tarih", "İşlem Türü", "Giriş", "Çıkış", "Net"])
    for r, g in enumerate(veri['gunluk_hareketler'], 3):
        ws5.cell(row=r, column=1, value=str(g['tarih']))
        ws5.cell(row=r, column=2, value=g['islem_turu'])
        for ci, k in enumerate(['giris','cikis','net'], 3):
            c = ws5.cell(row=r, column=ci, value=float(g[k]))
            c.number_format = PARA
            if k == 'net':
                c.font = Font(color="00aa44" if float(g[k]) >= 0 else "cc0000")

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    from fastapi.responses import StreamingResponse
    donem = f"{yil}-{ay:02d}"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="evvel-rapor-{donem}.xlsx"'}
    )

# ── HEALTH ─────────────────────────────────────────────────────
@app.get("/api/health")
def health():
    return {"status": "ok", "version": "EVVEL-ERP-2.0"}

# Frontend
if pathlib.Path("static/index.html").exists():
    app.mount("/", StaticFiles(directory="static", html=True), name="static")
