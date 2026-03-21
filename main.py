from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from typing import Optional
from datetime import date, timedelta
import uuid, os, json, pathlib
from database import db, init_db
from motors import karar_motoru, odeme_strateji_motoru, nakit_akis_simulasyon, guncel_kasa

app = FastAPI(title="EVVEL ERP", version="2.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.on_event("startup")
def startup():
    init_db()

def audit(cur, tablo, kayit_id, islem, eski=None, yeni=None):
    cur.execute("""INSERT INTO audit_log (id,tablo,kayit_id,islem,eski_deger,yeni_deger)
        VALUES (%s,%s,%s,%s,%s,%s)""",
        (str(uuid.uuid4()), tablo, kayit_id, islem,
         json.dumps(dict(eski)) if eski else None,
         json.dumps(dict(yeni)) if yeni else None))

def onay_ekle(cur, islem_turu, kaynak_tablo, kaynak_id, aciklama, tutar, tarih):
    cur.execute("""INSERT INTO onay_kuyrugu (id,islem_turu,kaynak_tablo,kaynak_id,aciklama,tutar,tarih)
        VALUES (%s,%s,%s,%s,%s,%s,%s)""",
        (str(uuid.uuid4()), islem_turu, kaynak_tablo, kaynak_id, aciklama, tutar, tarih))

# ── PANEL ──────────────────────────────────────────────────────
@app.get("/api/panel")
def panel():
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
        # Kart analiz - ekstre, taksit, limit doluluk
        from motors import kart_analiz_hesapla
        kart_analiz = kart_analiz_hesapla()
        
        # Toplam gelir/gider
        cur.execute("SELECT COALESCE(SUM(tutar),0) as t FROM kasa_hareketleri WHERE islem_turu='CIRO' AND durum='aktif'")
        toplam_gelir = float(cur.fetchone()['t'])
        cur.execute("SELECT COALESCE(SUM(tutar),0) as t FROM kasa_hareketleri WHERE islem_turu NOT IN ('CIRO','CIRO_IPTAL','ANLIK_GIDER_IPTAL') AND durum='aktif'")
        toplam_gider = float(cur.fetchone()['t'])
        
        return {**karar, "simulasyon": sim, "aylik_ciro": aylik_ciro,
                "bekleyen_onay": bekleyen, "odeme_ozet": odeme_ozet,
                "kart_analiz": kart_analiz, "toplam_gelir": toplam_gelir, "toplam_gider": toplam_gider}
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

# ── ANLIQ GİDER (beklenmeyen giderler) ────────────────────────
class AnlikGider(BaseModel):
    tarih: date
    kategori: str
    tutar: float
    aciklama: Optional[str] = None
    sube: Optional[str] = "MERKEZ"

@app.get("/api/anlik-gider")
def anlik_gider_listele():
    with db() as (conn, cur):
        cur.execute("SELECT * FROM anlik_giderler WHERE durum='aktif' ORDER BY tarih DESC LIMIT 200")
        return [dict(r) for r in cur.fetchall()]

@app.post("/api/anlik-gider")
def anlik_gider_ekle(g: AnlikGider):
    with db() as (conn, cur):
        gid = str(uuid.uuid4())
        cur.execute("""INSERT INTO anlik_giderler (id,tarih,kategori,tutar,aciklama,sube)
            VALUES (%s,%s,%s,%s,%s,%s)""",
            (gid, g.tarih, g.kategori, g.tutar, g.aciklama, g.sube))
        # Direkt kasadan düş
        kasa = guncel_kasa()
        cur.execute("""INSERT INTO kasa_hareketleri (id,tarih,islem_turu,tutar,aciklama,kaynak_tablo,kaynak_id)
            VALUES (%s,%s,'ANLIK_GIDER',%s,%s,'anlik_giderler',%s)""",
            (str(uuid.uuid4()), str(g.tarih), g.tutar, f"Anlık gider: {g.aciklama or g.kategori}", gid))
        audit(cur, 'anlik_giderler', gid, 'INSERT')
    return {"id": gid, "success": True}

@app.delete("/api/anlik-gider/{gid}")
def anlik_gider_sil(gid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM anlik_giderler WHERE id=%s", (gid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)
        cur.execute("UPDATE anlik_giderler SET durum='iptal' WHERE id=%s", (gid,))
        # Ters kayıt
        cur.execute("""INSERT INTO kasa_hareketleri (id,tarih,islem_turu,tutar,aciklama,kaynak_tablo,kaynak_id)
            VALUES (%s,%s,'ANLIK_GIDER_IPTAL',%s,'Gider iptali - ters kayıt','anlik_giderler',%s)""",
            (str(uuid.uuid4()), str(date.today()), float(eski['tutar']), gid))
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
                CASE WHEN islem_turu='HARCAMA' THEN tutar ELSE -tutar END),0) as borc
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
        cur.execute("""INSERT INTO kartlar (id,kart_adi,banka,limit_tutar,kesim_gunu,son_odeme_gunu,faiz_orani)
            VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (kid, k.kart_adi, k.banka, k.limit_tutar, k.kesim_gunu, k.son_odeme_gunu, k.faiz_orani))
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
        cur.execute("""INSERT INTO kart_hareketleri (id,kart_id,tarih,islem_turu,tutar,taksit_sayisi,aciklama)
            VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (hid, h.kart_id, h.tarih, h.islem_turu, h.tutar, h.taksit_sayisi, h.aciklama))
        if h.islem_turu == 'ODEME':
            onay_ekle(cur, 'KART_ODEME', 'kart_hareketleri', hid,
                f"Kart ödemesi: {h.aciklama or ''}", h.tutar, h.tarih)
        audit(cur, 'kart_hareketleri', hid, 'INSERT')
    return {"id": hid, "success": True}

@app.delete("/api/kart-hareketleri/{hid}")
def kart_hareket_iptal(hid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM kart_hareketleri WHERE id=%s", (hid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)
        cur.execute("UPDATE kart_hareketleri SET durum='iptal', iptal_nedeni='Manuel iptal' WHERE id=%s", (hid,))
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
        cur.execute("UPDATE odeme_plani SET durum='odendi', odeme_tarihi=%s WHERE id=%s", (bugun, oid))
        cur.execute("""INSERT INTO kasa_hareketleri (id,tarih,islem_turu,tutar,aciklama,kaynak_tablo,kaynak_id)
            VALUES (%s,%s,'KART_ODEME',%s,'Kart ödemesi onaylandı','odeme_plani',%s)""",
            (str(uuid.uuid4()), bugun, odenen, oid))
        cur.execute("UPDATE onay_kuyrugu SET durum='onaylandi', onay_tarihi=NOW() WHERE kaynak_id=%s", (oid,))
        audit(cur, 'odeme_plani', oid, 'ODEME', eski=plan)
    return {"success": True}

@app.delete("/api/odeme-plani/{oid}")
def odeme_plani_sil(oid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM odeme_plani WHERE id=%s", (oid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)
        cur.execute("UPDATE odeme_plani SET durum='iptal' WHERE id=%s", (oid,))
        cur.execute("UPDATE onay_kuyrugu SET durum='reddedildi' WHERE kaynak_id=%s", (oid,))
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
        tutar = float(onay['tutar'])
        tarih = str(onay['tarih'])
        cur.execute("""INSERT INTO kasa_hareketleri (id,tarih,islem_turu,tutar,aciklama,kaynak_tablo,kaynak_id)
            VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (str(uuid.uuid4()), tarih, onay['islem_turu'], tutar,
             f"Onaylandı: {onay['aciklama']}", onay['kaynak_tablo'], onay['kaynak_id']))
        cur.execute("UPDATE onay_kuyrugu SET durum='onaylandi', onay_tarihi=NOW() WHERE id=%s", (oid,))
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

@app.get("/api/ciro")
def ciro_listele(limit: int = 200):
    with db() as (conn, cur):
        cur.execute("""SELECT c.*, s.ad as sube_adi FROM ciro c
            LEFT JOIN subeler s ON s.id=c.sube_id
            WHERE c.durum='aktif' ORDER BY c.tarih DESC LIMIT %s""", (limit,))
        return [dict(r) for r in cur.fetchall()]

@app.post("/api/ciro")
def ciro_ekle(c: CiroModel):
    with db() as (conn, cur):
        cid = str(uuid.uuid4())
        cur.execute("""INSERT INTO ciro (id,tarih,sube_id,nakit,pos,online,aciklama)
            VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (cid, c.tarih, c.sube_id, c.nakit, c.pos, c.online, c.aciklama))
        toplam = c.nakit + c.pos + c.online
        cur.execute("""INSERT INTO kasa_hareketleri (id,tarih,islem_turu,tutar,aciklama,kaynak_tablo,kaynak_id)
            VALUES (%s,%s,'CIRO',%s,'Ciro girişi','ciro',%s)""",
            (str(uuid.uuid4()), c.tarih, toplam, cid))
        audit(cur, 'ciro', cid, 'INSERT')
    return {"id": cid, "success": True}

@app.delete("/api/ciro/{cid}")
def ciro_sil(cid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM ciro WHERE id=%s", (cid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)
        cur.execute("UPDATE ciro SET durum='iptal' WHERE id=%s", (cid,))
        cur.execute("""INSERT INTO kasa_hareketleri (id,tarih,islem_turu,tutar,aciklama,kaynak_tablo,kaynak_id)
            VALUES (%s,%s,'CIRO_IPTAL',%s,'Ciro iptali - ters kayıt','ciro',%s)""",
            (str(uuid.uuid4()), str(date.today()), float(eski['toplam']), cid))
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
        cur.execute("SELECT * FROM sabit_giderler WHERE id=%s", (gid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)
        cur.execute("UPDATE sabit_giderler SET aktif=FALSE WHERE id=%s", (gid,))
        audit(cur, 'sabit_giderler', gid, 'PASIF', eski=eski)
    return {"success": True}

# ── VADELİ ALIMLAR ─────────────────────────────────────────────
class VadeliAlim(BaseModel):
    aciklama: str
    tutar: float
    vade_tarihi: date
    tedarikci: Optional[str] = None

@app.get("/api/vadeli-alimlar")
def vadeli_listele():
    with db() as (conn, cur):
        cur.execute("""SELECT *, (vade_tarihi - CURRENT_DATE) as gun_kaldi
            FROM vadeli_alimlar WHERE durum='bekliyor' ORDER BY vade_tarihi""")
        return [dict(r) for r in cur.fetchall()]

@app.post("/api/vadeli-alimlar")
def vadeli_ekle(v: VadeliAlim):
    with db() as (conn, cur):
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
        cur.execute("SELECT * FROM vadeli_alimlar WHERE id=%s", (vid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)
        cur.execute("UPDATE vadeli_alimlar SET durum='iptal' WHERE id=%s", (vid,))
        audit(cur, 'vadeli_alimlar', vid, 'IPTAL', eski=eski)
    return {"success": True}

@app.post("/api/vadeli-alimlar/{vid}/ode")
def vadeli_ode(vid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM vadeli_alimlar WHERE id=%s", (vid,))
        v = cur.fetchone()
        if not v: raise HTTPException(404)
        cur.execute("UPDATE vadeli_alimlar SET durum='odendi' WHERE id=%s", (vid,))
        cur.execute("""INSERT INTO kasa_hareketleri (id,tarih,islem_turu,tutar,aciklama,kaynak_tablo,kaynak_id)
            VALUES (%s,%s,'VADELI_ODEME',%s,%s,'vadeli_alimlar',%s)""",
            (str(uuid.uuid4()), str(date.today()), float(v['tutar']), f"Vadeli: {v['aciklama']}", vid))
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

# ── HEALTH ─────────────────────────────────────────────────────
@app.get("/api/health")
def health():
    return {"status": "ok", "version": "EVVEL-ERP-2.0"}

# Frontend
if pathlib.Path("static/index.html").exists():
    app.mount("/", StaticFiles(directory="static", html=True), name="static")

@app.get("/{full_path:path}")
async def spa(full_path: str):
    index = pathlib.Path("static/index.html")
    if index.exists():
        return HTMLResponse(index.read_text())
    return {"error": "Frontend build edilmemiş"}

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

                for row in rows[1:]:
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
                                cur.execute("""INSERT INTO kasa_hareketleri (id,tarih,islem_turu,tutar,aciklama,kaynak_tablo,kaynak_id)
                                    VALUES (%s,%s,'CIRO',%s,'Excel import','ciro',%s)""",
                                    (str(uuid.uuid4()), fix_date(d.get('tarih')), toplam_ciro, cid))
                                eklenen += 1

                        elif sn == 'kartlar':
                            cur.execute("""INSERT INTO kartlar (id,kart_adi,banka,limit_tutar,kesim_gunu,son_odeme_gunu,faiz_orani)
                                VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (kart_adi) DO NOTHING""",
                                (str(uuid.uuid4()), str(d.get('kart_adi','')).upper(),
                                 str(d.get('banka','')), float(d.get('limit_tutar') or 0),
                                 int(d.get('kesim_gunu') or 15), int(d.get('son_odeme_gunu') or 25),
                                 float(d.get('faiz_orani') or 0)))
                            if cur.rowcount > 0: eklenen += 1

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
                            eklendi += 1

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

                if eklenen > 0 or hata > 0:
                    detay[sheet_name] = {'eklenen': eklenen, 'hata': hata}
                    toplam += eklenen

        return {"success": True, "toplam": toplam, "detay": detay}
    except ImportError:
        raise HTTPException(500, "openpyxl kurulu değil")
    except Exception as e:
        raise HTTPException(500, str(e))
