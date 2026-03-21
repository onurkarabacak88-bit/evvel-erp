from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional
from datetime import date, timedelta
import uuid, os, json
from database import db, init_db
from motors import karar_motoru, odeme_strateji_motoru, nakit_akis_simulasyon, guncel_kasa

app = FastAPI(title="EVVEL ERP", version="2.0")

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.on_event("startup")
def startup():
    init_db()

# ── YARDIMCI ───────────────────────────────────────────────────
def audit(cur, tablo, kayit_id, islem, eski=None, yeni=None):
    cur.execute("""INSERT INTO audit_log (id,tablo,kayit_id,islem,eski_deger,yeni_deger)
        VALUES (%s,%s,%s,%s,%s,%s)""",
        (str(uuid.uuid4()), tablo, kayit_id, islem,
         json.dumps(dict(eski)) if eski else None,
         json.dumps(dict(yeni)) if yeni else None))

def onay_kuyruğuna_ekle(cur, islem_turu, kaynak_tablo, kaynak_id, aciklama, tutar, tarih):
    cur.execute("""INSERT INTO onay_kuyrugu (id,islem_turu,kaynak_tablo,kaynak_id,aciklama,tutar,tarih)
        VALUES (%s,%s,%s,%s,%s,%s,%s)""",
        (str(uuid.uuid4()), islem_turu, kaynak_tablo, kaynak_id, aciklama, tutar, tarih))

# ── PANEL & MOTORLAR ───────────────────────────────────────────
@app.get("/api/panel")
def panel():
    try:
        karar = karar_motoru()
        sim = nakit_akis_simulasyon(15)
        with db() as (conn, cur):
            cur.execute("""
                SELECT TO_CHAR(tarih,'YYYY-MM') as ay,
                    SUM(toplam) as ciro
                FROM ciro WHERE tarih >= CURRENT_DATE - INTERVAL '6 months'
                GROUP BY TO_CHAR(tarih,'YYYY-MM') ORDER BY ay DESC LIMIT 6
            """)
            aylik_ciro = [dict(r) for r in cur.fetchall()]

            cur.execute("""
                SELECT COUNT(*) as sayi, COALESCE(SUM(tutar),0) as toplam
                FROM onay_kuyrugu WHERE durum='bekliyor'
            """)
            bekleyen = dict(cur.fetchone())

            cur.execute("""
                SELECT COALESCE(SUM(odenecek_tutar),0) as t7,
                    COALESCE(SUM(CASE WHEN tarih<=CURRENT_DATE+15 THEN odenecek_tutar ELSE 0 END),0) as t15,
                    COALESCE(SUM(CASE WHEN tarih<=CURRENT_DATE+30 THEN odenecek_tutar ELSE 0 END),0) as t30
                FROM odeme_plani WHERE durum='bekliyor'
                AND tarih BETWEEN CURRENT_DATE AND CURRENT_DATE+30
            """)
            odeme_ozet = dict(cur.fetchone())

        return {**karar, "simulasyon": sim, "aylik_ciro": aylik_ciro,
                "bekleyen_onay": bekleyen, "odeme_ozet": odeme_ozet}
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
        cur.execute("SELECT * FROM kartlar ORDER BY banka")
        kartlar = [dict(r) for r in cur.fetchall()]
        sonuc = []
        for k in kartlar:
            cur.execute("""
                SELECT COALESCE(SUM(
                    CASE WHEN islem_turu='HARCAMA' THEN tutar ELSE -tutar END
                ),0) as borc
                FROM kart_hareketleri WHERE kart_id=%s AND durum='aktif'
            """, (k['id'],))
            borc = float(cur.fetchone()['borc'])
            limit = float(k['limit_tutar'])
            bugun = date.today()
            son_odeme_gun = k['son_odeme_gunu']
            son_odeme = date(bugun.year, bugun.month, son_odeme_gun)
            if son_odeme < bugun:
                if bugun.month == 12:
                    son_odeme = date(bugun.year+1, 1, son_odeme_gun)
                else:
                    son_odeme = date(bugun.year, bugun.month+1, son_odeme_gun)
            gun_kaldi = (son_odeme - bugun).days

            cur.execute("""
                SELECT * FROM odeme_plani WHERE kart_id=%s AND durum='bekliyor'
                ORDER BY tarih ASC LIMIT 1
            """, (k['id'],))
            yaklasan = cur.fetchone()

            sonuc.append({
                **k,
                "guncel_borc": borc,
                "kalan_limit": limit - borc,
                "limit_doluluk": borc/limit if limit > 0 else 0,
                "asgari_odeme": borc * 0.2,
                "gun_kaldi": gun_kaldi,
                "son_odeme_tarihi": str(son_odeme),
                "blink": gun_kaldi <= 0 and (yaklasan is not None),
                "yaklasan_odeme": dict(yaklasan) if yaklasan else None
            })
        return sonuc

@app.post("/api/kartlar")
def kart_ekle(kart: KartModel):
    with db() as (conn, cur):
        kid = str(uuid.uuid4())
        cur.execute("""INSERT INTO kartlar (id,kart_adi,banka,limit_tutar,kesim_gunu,son_odeme_gunu,faiz_orani)
            VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (kid, kart.kart_adi, kart.banka, kart.limit_tutar, kart.kesim_gunu, kart.son_odeme_gunu, kart.faiz_orani))
        audit(cur, 'kartlar', kid, 'INSERT', yeni=kart.dict())
    return {"id": kid, "success": True}

@app.put("/api/kartlar/{kid}")
def kart_guncelle(kid: str, kart: KartModel):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM kartlar WHERE id=%s", (kid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404, "Kart bulunamadı")
        cur.execute("""UPDATE kartlar SET kart_adi=%s,banka=%s,limit_tutar=%s,
            kesim_gunu=%s,son_odeme_gunu=%s,faiz_orani=%s WHERE id=%s""",
            (kart.kart_adi, kart.banka, kart.limit_tutar, kart.kesim_gunu, kart.son_odeme_gunu, kart.faiz_orani, kid))
        audit(cur, 'kartlar', kid, 'UPDATE', eski=eski, yeni=kart.dict())
    return {"success": True}

@app.delete("/api/kartlar/{kid}")
def kart_sil(kid: str, neden: str = "Kullanıcı sildi"):
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
    islem_turu: str  # HARCAMA veya ODEME
    tutar: float
    taksit_sayisi: int = 1
    aciklama: Optional[str] = None

@app.get("/api/kart-hareketleri")
def kart_hareketleri(kart_id: Optional[str] = None, limit: int = 100):
    with db() as (conn, cur):
        if kart_id:
            cur.execute("""SELECT kh.*, k.banka, k.kart_adi FROM kart_hareketleri kh
                JOIN kartlar k ON k.id=kh.kart_id
                WHERE kh.kart_id=%s AND kh.durum='aktif'
                ORDER BY kh.tarih DESC LIMIT %s""", (kart_id, limit))
        else:
            cur.execute("""SELECT kh.*, k.banka, k.kart_adi FROM kart_hareketleri kh
                JOIN kartlar k ON k.id=kh.kart_id
                WHERE kh.durum='aktif'
                ORDER BY kh.tarih DESC LIMIT %s""", (limit,))
        return [dict(r) for r in cur.fetchall()]

@app.post("/api/kart-hareketleri")
def kart_hareket_ekle(h: KartHareket):
    # ❗ HARCAMA: kasa ETKİLENMEZ
    # ❗ ODEME: onay kuyruğuna gider → onaylandığında kasadan düşer
    with db() as (conn, cur):
        hid = str(uuid.uuid4())
        cur.execute("""INSERT INTO kart_hareketleri (id,kart_id,tarih,islem_turu,tutar,taksit_sayisi,aciklama)
            VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (hid, h.kart_id, h.tarih, h.islem_turu, h.tutar, h.taksit_sayisi, h.aciklama))

        if h.islem_turu == 'ODEME':
            # Onay kuyruğuna ekle
            onay_kuyruğuna_ekle(cur, 'KART_ODEME', 'kart_hareketleri', hid,
                f"Kart ödemesi: {h.aciklama or ''}", h.tutar, h.tarih)

        audit(cur, 'kart_hareketleri', hid, 'INSERT', yeni=h.dict())
    return {"id": hid, "success": True}

@app.delete("/api/kart-hareketleri/{hid}")
def kart_hareket_iptal(hid: str, neden: str = "Manuel iptal"):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM kart_hareketleri WHERE id=%s", (hid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)
        cur.execute("UPDATE kart_hareketleri SET durum='iptal', iptal_nedeni=%s WHERE id=%s", (neden, hid))
        # Ters kayıt: kart ledger'ını düzelt
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
        cur.execute("""
            SELECT op.*, k.banka, k.kart_adi, k.faiz_orani FROM odeme_plani op
            JOIN kartlar k ON k.id=op.kart_id
            WHERE op.tarih >= CURRENT_DATE - INTERVAL '7 days'
            ORDER BY op.tarih ASC
        """)
        return [dict(r) for r in cur.fetchall()]

@app.post("/api/odeme-plani")
def odeme_plani_ekle(o: OdemePlani):
    with db() as (conn, cur):
        oid = str(uuid.uuid4())
        asgari = o.asgari_tutar or o.odenecek_tutar * 0.2
        cur.execute("""INSERT INTO odeme_plani (id,kart_id,tarih,odenecek_tutar,asgari_tutar,aciklama)
            VALUES (%s,%s,%s,%s,%s,%s)""",
            (oid, o.kart_id, o.tarih, o.odenecek_tutar, asgari, o.aciklama))
        onay_kuyruğuna_ekle(cur, 'ODEME_PLANI', 'odeme_plani', oid,
            f"Ödeme planı: {o.aciklama or ''}", o.odenecek_tutar, o.tarih)
        audit(cur, 'odeme_plani', oid, 'INSERT', yeni=o.dict())
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

        # 1. Planı güncelle
        cur.execute("UPDATE odeme_plani SET durum='odendi', odeme_tarihi=%s WHERE id=%s", (bugun, oid))

        # 2. Kasadan düş
        kasa = guncel_kasa()
        cur.execute("""INSERT INTO kasa_hareketleri (id,tarih,islem_turu,tutar,aciklama,kaynak_tablo,kaynak_id)
            VALUES (%s,%s,'KART_ODEME',%s,%s,'odeme_plani',%s)""",
            (str(uuid.uuid4()), bugun, odenen, f"Kart ödemesi onaylandı", oid))

        # 3. Onay kuyruğunu güncelle
        cur.execute("UPDATE onay_kuyrugu SET durum='onaylandi', onay_tarihi=NOW() WHERE kaynak_id=%s", (oid,))

        audit(cur, 'odeme_plani', oid, 'ODEME', eski=plan)
    return {"success": True, "odenen": odenen}

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
        cur.execute("""SELECT * FROM onay_kuyrugu WHERE durum='bekliyor' ORDER BY tarih ASC""")
        return [dict(r) for r in cur.fetchall()]

@app.post("/api/onay-kuyrugu/{oid}/onayla")
def onayla(oid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM onay_kuyrugu WHERE id=%s", (oid,))
        onay = cur.fetchone()
        if not onay: raise HTTPException(404)

        tutar = float(onay['tutar'])
        tarih = str(onay['tarih'])

        # Kasadan düş
        cur.execute("""INSERT INTO kasa_hareketleri (id,tarih,islem_turu,tutar,aciklama,kaynak_tablo,kaynak_id)
            VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (str(uuid.uuid4()), tarih, onay['islem_turu'], tutar,
             f"Onaylandı: {onay['aciklama']}", onay['kaynak_tablo'], onay['kaynak_id']))

        cur.execute("UPDATE onay_kuyrugu SET durum='onaylandi', onay_tarihi=NOW() WHERE id=%s", (oid,))
        audit(cur, 'onay_kuyrugu', oid, 'ONAYLANDI', eski=onay)
    return {"success": True}

@app.post("/api/onay-kuyrugu/{oid}/reddet")
def reddet(oid: str, neden: str = "Reddedildi"):
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
def ciro_listele(limit: int = 100):
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
            VALUES (%s,%s,'CIRO',%s,%s,'ciro',%s)""",
            (str(uuid.uuid4()), c.tarih, toplam, f"Ciro girişi", cid))
        audit(cur, 'ciro', cid, 'INSERT', yeni=c.dict())
    return {"id": cid, "success": True}

@app.delete("/api/ciro/{cid}")
def ciro_sil(cid: str):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM ciro WHERE id=%s", (cid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)
        cur.execute("UPDATE ciro SET durum='iptal' WHERE id=%s", (cid,))
        # Ters kayıt
        cur.execute("""INSERT INTO kasa_hareketleri (id,tarih,islem_turu,tutar,aciklama,kaynak_tablo,kaynak_id)
            VALUES (%s,%s,'CIRO_IPTAL',%s,'Ciro iptali','ciro',%s)""",
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
                LEFT JOIN subeler s ON s.id=p.sube_id
                WHERE p.aktif=%s ORDER BY p.ad_soyad""", (aktif,))
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
        audit(cur, 'personel', pid, 'INSERT', yeni=p.dict())
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
        audit(cur, 'personel', pid, 'UPDATE', eski=eski, yeni=p.dict())
    return {"success": True}

@app.post("/api/personel/{pid}/cikis")
def personel_cikis(pid: str, neden: str = ""):
    with db() as (conn, cur):
        cur.execute("UPDATE personel SET aktif=FALSE, cikis_tarihi=%s, notlar=COALESCE(notlar,'')||%s WHERE id=%s",
            (str(date.today()), f" | ÇIKIŞ: {neden}", pid))
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
            LEFT JOIN subeler s ON s.id=sg.sube_id
            ORDER BY sg.kategori, sg.gider_adi""")
        return [dict(r) for r in cur.fetchall()]

@app.post("/api/sabit-giderler")
def sabit_gider_ekle(g: SabitGider):
    with db() as (conn, cur):
        gid = str(uuid.uuid4())
        cur.execute("""INSERT INTO sabit_giderler (id,gider_adi,kategori,tutar,periyot,odeme_gunu,baslangic_tarihi,sube_id)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
            (gid, g.gider_adi, g.kategori, g.tutar, g.periyot, g.odeme_gunu, g.baslangic_tarihi, g.sube_id))
        # Onay kuyruğuna ekle
        onay_kuyruğuna_ekle(cur, 'SABIT_GIDER', 'sabit_giderler', gid,
            f"Sabit gider: {g.gider_adi}", g.tutar, date.today())
        audit(cur, 'sabit_giderler', gid, 'INSERT', yeni=g.dict())
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
        audit(cur, 'sabit_giderler', gid, 'UPDATE', eski=eski, yeni=g.dict())
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
        audit(cur, 'vadeli_alimlar', vid, 'INSERT', yeni=v.dict())
    return {"id": vid, "success": True}

@app.put("/api/vadeli-alimlar/{vid}")
def vadeli_guncelle(vid: str, v: VadeliAlim):
    with db() as (conn, cur):
        cur.execute("SELECT * FROM vadeli_alimlar WHERE id=%s", (vid,))
        eski = cur.fetchone()
        if not eski: raise HTTPException(404)
        cur.execute("""UPDATE vadeli_alimlar SET aciklama=%s,tutar=%s,vade_tarihi=%s,tedarikci=%s WHERE id=%s""",
            (v.aciklama, v.tutar, v.vade_tarihi, v.tedarikci, vid))
        audit(cur, 'vadeli_alimlar', vid, 'UPDATE', eski=eski, yeni=v.dict())
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
            (str(uuid.uuid4()), str(date.today()), float(v['tutar']), f"Vadeli ödeme: {v['aciklama']}", vid))
        audit(cur, 'vadeli_alimlar', vid, 'ODEME', eski=v)
    return {"success": True}

# ── BORÇ ENVANTERİ ─────────────────────────────────────────────
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
        audit(cur, 'borc_envanteri', bid, 'INSERT', yeni=b.dict())
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
        audit(cur, 'borc_envanteri', bid, 'UPDATE', eski=eski, yeni=b.dict())
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

# ── KASA ───────────────────────────────────────────────────────
@app.get("/api/kasa")
def kasa_durumu():
    with db() as (conn, cur):
        kasa = guncel_kasa()
        cur.execute("""SELECT * FROM kasa_hareketleri WHERE durum='aktif'
            ORDER BY tarih DESC, olusturma DESC LIMIT 50""")
        hareketler = [dict(r) for r in cur.fetchall()]
        return {"guncel_bakiye": kasa, "hareketler": hareketler}

# ── HEALTH ─────────────────────────────────────────────────────
@app.get("/api/health")
def health():
    return {"status": "ok", "version": "EVVEL-ERP-2.0"}

# Frontend dosyalarını sun
if os.path.exists("static"):
    app.mount("/", StaticFiles(directory="static", html=True), name="static")

# SPA fallback — tüm bilinmeyen route'ları index.html'e yönlendir
from fastapi.responses import HTMLResponse
import pathlib

@app.get("/{full_path:path}")
async def spa_fallback(full_path: str):
    index = pathlib.Path("static/index.html")
    if index.exists():
        return HTMLResponse(index.read_text())
    return {"error": "Frontend henüz build edilmemiş"}
