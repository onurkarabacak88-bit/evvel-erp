from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional
from datetime import date
import io, os, math
from database import db

router = APIRouter()

SABLON_SEED = [
    # (vardiya_tip, sira, alan, gorev, siklik)
    ('sabahci', 1, 'Bar', 'Espresso makinesi açılır ve çalışmaya hazır hale getirilir.', 'Açılış'),
    ('sabahci', 2, 'Kasa', 'Kasa sayımı yapılır.', 'Açılış'),
    ('sabahci', 3, 'Üst Kat / Lavabo', 'Üst kat lavabolar detaylıca kontrol edilir ve temizlenir.', 'Sabah'),
    ('sabahci', 4, 'Üst Kat / Müşteri Alanı', 'Üst kat müşteri alanı süpürülür ve paspaslanır.', 'Sabah'),
    ('sabahci', 5, 'Bulaşık', 'Geceden kalan bulaşık varsa yıkanır.', 'Sabah'),
    ('sabahci', 6, 'Bar / Stok', 'Bar içi stok kontrol edilir.', 'Sabah'),
    ('sabahci', 7, 'Bar / Dolap', 'Dolaplar eksik ürünlere göre doldurulur.', 'Sabah'),
    ('sabahci', 8, 'Pasta / Tatlı Dolabı', 'Pasta veya tatlı varsa SKT kontrolü yapılır.', 'Sabah'),
    ('sabahci', 9, 'Çöp', 'Çıkıştan önce alt kat ve üst kat çöpleri kontrol edilir.', 'Çıkış Öncesi'),
    ('sabahci', 10, 'Lavabo / Çöp', 'Lavabolar dahil tüm dolu çöpler atılır.', 'Çıkış Öncesi'),
    ('sabahci', 11, 'Kasa', 'Kasa devri yapılır.', 'Çıkış'),
    ('sabahci', 12, 'Vardiya', 'Görevler tamamlandıktan sonra çıkış yapılır.', 'Çıkış'),
    ('ara_vardiya', 1, 'Depo', 'Depo stok durumu kontrol edilir.', 'Ara Vardiya'),
    ('ara_vardiya', 2, 'Depo / Sipariş', 'Eksik veya azalan ürünler belirlenir.', 'Ara Vardiya'),
    ('ara_vardiya', 3, 'Depo / Sipariş', '1 haftalık sipariş listesi hazırlanır veya sipariş geçilir.', 'Ara Vardiya'),
    ('ara_vardiya', 4, 'Tuvalet', 'Tuvaletler kontrol edilir.', 'Ara Vardiya'),
    ('ara_vardiya', 5, 'Tuvalet / Hijyen', 'Tuvaletlerde peçete, kağıt, sabun ve genel temizlik durumu kontrol edilir.', 'Ara Vardiya'),
    ('ara_vardiya', 6, 'Çöp', 'Çöpler kontrol edilir.', 'Çıkış Öncesi'),
    ('ara_vardiya', 7, 'Çöp', 'Çöpler doluysa atılır ve çıkış yapılır.', 'Çıkış'),
    ('kapanis', 1, 'Bar', 'Bar içerisi genel olarak temizlenir.', 'Kapanış'),
    ('kapanis', 2, 'Alt Kat', 'Aşağı kat detaylıca süpürülür ve paspaslanır.', 'Kapanış'),
    ('kapanis', 3, 'Personel Lavabosu', 'Personel lavabosu detaylıca süpürülür, paspaslanır ve temizlenir.', 'Kapanış'),
    ('kapanis', 4, 'Kasa', 'Kasada teslim edilecek ücret varsa teslim edilir.', 'Kapanış'),
    ('kapanis', 5, 'Bulaşık', 'Bulaşıklar yıkanır.', 'Kapanış'),
    ('kapanis', 6, 'Bulaşık', 'Yıkanan bulaşıklar kurulanır ve yerlerine yerleştirilir.', 'Kapanış'),
    ('kapanis', 7, 'Bar', 'Son bar temizliği yapılır.', 'Kapanış'),
    ('kapanis', 8, 'Espresso Makinesi', 'Espresso makinesi detaylıca temizlenir.', 'Kapanış'),
    ('kapanis', 9, 'Eksik Ürün Bildirimi', 'Sabaha eksik olan ürünler çıkmadan önce gruba yazılır.', 'Kapanış'),
    ('kapanis', 10, 'Kasa', 'Kasa kapanışı yapılır.', 'Kapanış'),
    ('kapanis', 11, 'Çöp', 'Çöpler kontrol edilir.', 'Çıkış Öncesi'),
    ('kapanis', 12, 'Çöp', 'Çöpler doluysa atılır ve çıkış yapılır.', 'Çıkış'),
]


def _seed_sablonlar(cur):
    cur.execute("SELECT COUNT(*) as n FROM gorev_sablonu")
    if cur.fetchone()['n'] > 0:
        return
    for s in SABLON_SEED:
        cur.execute("""
            INSERT INTO gorev_sablonu (vardiya_tip, sira, alan, gorev, siklik)
            VALUES (%s, %s, %s, %s, %s)
        """, s)


@router.get("/api/gorev/sablonlar")
def gorev_sablonlar_listesi():
    with db() as (conn, cur):
        cur.execute("SELECT * FROM gorev_sablonu WHERE aktif=TRUE ORDER BY vardiya_tip, sira")
        return [dict(r) for r in cur.fetchall()]


@router.get("/api/gorev/vardiya")
def gorev_vardiya_getir(tarih: str, sube_id: str, vardiya_tip: str):
    """Bir şube + vardiya için görev listesi ve tamamlanma durumu."""
    from datetime import date as _date
    t = _date.fromisoformat(tarih)
    with db() as (conn, cur):
        # Şablon yoksa seed et
        _seed_sablonlar(cur)
        conn.commit()
        cur.execute("""
            SELECT gs.id, gs.sira, gs.alan, gs.gorev, gs.siklik,
                   COALESCE(gt.tamamlandi, FALSE) AS tamamlandi,
                   gt.tamamlanma_ts, gt.personel_id
            FROM gorev_sablonu gs
            LEFT JOIN gorev_tamamlama gt
                ON gt.sablonid = gs.id AND gt.tarih = %s AND gt.sube_id = %s
            WHERE gs.vardiya_tip = %s AND gs.aktif = TRUE
            ORDER BY gs.sira
        """, (t, sube_id, vardiya_tip))
        gorevler = [dict(r) for r in cur.fetchall()]
        tamamlanan = sum(1 for g in gorevler if g['tamamlandi'])
        return {
            "gorevler": gorevler,
            "toplam": len(gorevler),
            "tamamlanan": tamamlanan,
            "eksik": len(gorevler) - tamamlanan,
        }


@router.get("/api/gorev/personel-vardiya")
def gorev_personel_vardiya(tarih: str, sube_id: str, vardiya_tip: str, personel_id: str):
    """
    Belirli bir personelin o vardiyaki görevleri.
    Vardiya planında kaç kişi atanmışsa görevler eşit bölüştürülür.
    """
    from datetime import date as _date
    t = _date.fromisoformat(tarih)
    haftanin_gunu = t.weekday() + 1

    with db() as (conn, cur):
        # O vardiyada bu şubede atanan personeller (vardiya planından)
        VT_SLOT_MAP = {
            'sabahci': ['acilis', 'normal'],
            'ara_vardiya': ['yogun'],
            'kapanis': ['kapanis'],
        }
        slot_tipler = VT_SLOT_MAP.get(vardiya_tip, ['normal'])
        tip_placeholder = ','.join(['%s'] * len(slot_tipler))
        cur.execute(f"""
            SELECT DISTINCT va.personel_id::text,
                   COALESCE(NULLIF(TRIM(p.ad_soyad),''), va.personel_id::text) AS ad
            FROM vardiya_atama va
            JOIN vardiya_slot vs ON vs.id = va.slot_id
            JOIN personel p ON p.id = va.personel_id
            WHERE va.tarih = %s
              AND vs.sube_id = %s
              AND va.durum IN ('planli','onayli')
              AND vs.tip IN ({tip_placeholder})
              AND vs.aktif = TRUE
              AND %s = ANY(vs.aktif_gunler)
            ORDER BY va.personel_id
        """, (t, sube_id, *slot_tipler, haftanin_gunu))
        vardiya_personel = [dict(r) for r in (cur.fetchall() or [])]

        # Tüm görevleri al
        cur.execute("""
            SELECT gs.id, gs.sira, gs.alan, gs.gorev, gs.siklik,
                   COALESCE(gt.tamamlandi, FALSE) AS tamamlandi,
                   gt.tamamlanma_ts, gt.personel_id AS tamamlayan_id
            FROM gorev_sablonu gs
            LEFT JOIN gorev_tamamlama gt
                ON gt.sablonid = gs.id AND gt.tarih = %s AND gt.sube_id = %s
            WHERE gs.vardiya_tip = %s AND gs.aktif = TRUE
            ORDER BY gs.sira
        """, (t, sube_id, vardiya_tip))
        tum_gorevler = [dict(r) for r in (cur.fetchall() or [])]

    # Görev bölüşümü
    kisi_sayisi = len(vardiya_personel)
    if kisi_sayisi <= 1:
        # Tek kişi ya da plan yok — hepsini göster
        benim_gorevler = tum_gorevler
    else:
        # Personeli sırala, indeksini bul → görevleri böl
        pid_listesi = [p['personel_id'] for p in vardiya_personel]
        if personel_id in pid_listesi:
            idx = pid_listesi.index(personel_id)
        else:
            idx = 0
            kisi_sayisi = 1
        # Round-robin dağıtım: görev sırası % kişi sayısı == personel indexi
        benim_gorevler = [g for i, g in enumerate(tum_gorevler) if i % kisi_sayisi == idx]

    tamamlanan = sum(1 for g in benim_gorevler if g['tamamlandi'])
    return {
        "gorevler": benim_gorevler,
        "toplam": len(benim_gorevler),
        "tamamlanan": tamamlanan,
        "eksik": len(benim_gorevler) - tamamlanan,
        "vardiya_personel": vardiya_personel,
        "kisi_sayisi": kisi_sayisi,
    }


class GorevTamamlaBody(BaseModel):
    tarih: str
    sube_id: str
    sablon_id: str
    tamamlandi: bool
    personel_id: Optional[str] = None


@router.post("/api/gorev/tamamla")
def gorev_tamamla(body: GorevTamamlaBody):
    from datetime import date as _date, datetime as _dt
    t = _date.fromisoformat(body.tarih)
    with db() as (conn, cur):
        cur.execute("""
            INSERT INTO gorev_tamamlama (tarih, sube_id, sablonid, tamamlandi, personel_id, tamamlanma_ts)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (tarih, sube_id, sablonid)
            DO UPDATE SET tamamlandi = EXCLUDED.tamamlandi,
                          personel_id = EXCLUDED.personel_id,
                          tamamlanma_ts = CASE WHEN EXCLUDED.tamamlandi THEN NOW() ELSE NULL END
        """, (t, body.sube_id, body.sablon_id, body.tamamlandi, body.personel_id,
              _dt.utcnow() if body.tamamlandi else None))
        conn.commit()
    return {"basarili": True}


@router.get("/api/gorev/sube-personel/{sube_id}")
def gorev_sube_personel(sube_id: str):
    """Tüm aktif personel — şube personeli önce, diğerleri sonra."""
    with db() as (conn, cur):
        cur.execute("""
            SELECT p.id::text, p.ad_soyad,
                   (p.panel_pin_hash IS NOT NULL AND p.panel_pin_salt IS NOT NULL) AS pin_tanimli,
                   (p.sube_id = %s) AS bu_sube,
                   COALESCE(s.ad, '—') AS sube_adi
            FROM personel p
            LEFT JOIN subeler s ON s.id = p.sube_id
            WHERE p.aktif = TRUE
            ORDER BY bu_sube DESC, pin_tanimli DESC, p.ad_soyad
        """, (sube_id,))
        return [dict(r) for r in cur.fetchall()]




@router.get("/api/gorev/ozet")
def gorev_ozet(tarih: str):
    """Tüm şubeler için o günün görev tamamlanma özeti."""
    from datetime import date as _date
    t = _date.fromisoformat(tarih)
    with db() as (conn, cur):
        cur.execute("""
            SELECT s.id AS sube_id, s.ad AS sube_adi,
                   gs.vardiya_tip,
                   COUNT(gs.id) AS toplam,
                   COUNT(gt.id) FILTER (WHERE gt.tamamlandi = TRUE) AS tamamlanan
            FROM subeler s
            CROSS JOIN (SELECT DISTINCT vardiya_tip FROM gorev_sablonu WHERE aktif=TRUE) vt
            JOIN gorev_sablonu gs ON gs.vardiya_tip = vt.vardiya_tip AND gs.aktif = TRUE
            LEFT JOIN gorev_tamamlama gt ON gt.sablonid = gs.id AND gt.tarih = %s AND gt.sube_id = s.id
            WHERE s.aktif = TRUE
            GROUP BY s.id, s.ad, gs.vardiya_tip
            ORDER BY s.ad, gs.vardiya_tip
        """, (t,))
        return [dict(r) for r in cur.fetchall()]


# ── Personel giriş + görev dağılımı ──────────────────────────────────────────


def _haversine_m(lat1, lng1, lat2, lng2) -> float:
    """İki koordinat arasındaki mesafeyi metre cinsinden döner (Haversine)."""
    R = 6_371_000
    p = math.pi / 180
    a = (math.sin((lat2 - lat1) * p / 2) ** 2
         + math.cos(lat1 * p) * math.cos(lat2 * p)
         * math.sin((lng2 - lng1) * p / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(a))


class GorevPinGirisBody(BaseModel):
    sube_id: str
    personel_id: str
    pin: str
    lat: Optional[float] = None
    lng: Optional[float] = None


@router.post("/api/gorev/pin-giris")
def gorev_pin_giris(body: GorevPinGirisBody):
    """Personel PIN doğrulaması. Konum varsa şube yakınlığı kontrol edilir. Yoklama kaydedilir."""
    from personel_panel_auth import dogrula_personel_panel_pin
    from tr_saat import is_gunu_tr, dt_now_tr

    with db() as (conn, cur):
        # Şube koordinatlarını al
        cur.execute("SELECT lat, lng, konum_radius_m FROM subeler WHERE id = %s", (body.sube_id,))
        sube = cur.fetchone()

        # Konum doğrulama: şubede koordinat tanımlıysa ve kullanıcı konum gönderdiyse kontrol et
        konum_mesafe_m = None
        konum_onaylandi = False
        if sube and sube["lat"] and sube["lng"]:
            if body.lat is None or body.lng is None:
                raise HTTPException(
                    status_code=403,
                    detail="konum_gerekli|Bu şubeye giriş için konum izni gereklidir."
                )
            konum_mesafe_m = _haversine_m(body.lat, body.lng, sube["lat"], sube["lng"])
            radius = sube["konum_radius_m"] or 150
            if konum_mesafe_m > radius:
                raise HTTPException(
                    status_code=403,
                    detail=f"sube_disinda|Şubeye çok uzaksın ({int(konum_mesafe_m)} m). Giriş yalnızca şube içinden yapılabilir."
                )
            konum_onaylandi = True

        personel = dogrula_personel_panel_pin(cur, body.personel_id, body.pin)

        saat = dt_now_tr().hour
        if saat < 12:
            vardiya_tip = "sabahci"
        elif saat < 18:
            vardiya_tip = "ara_vardiya"
        else:
            vardiya_tip = "kapanis"

        tarih = str(is_gunu_tr())

        # Personelin asıl şubesi
        asil_sube_id = personel.get("sube_id") or body.sube_id
        vardiya_disi = str(asil_sube_id) != str(body.sube_id)

        # Vardiya planında bu personel var mı?
        from datetime import date as _date
        bugun = _date.fromisoformat(tarih)
        haftanin_gunu = bugun.weekday() + 1
        cur.execute("""
            SELECT 1 FROM vardiya_atama va
            JOIN vardiya_slot vs ON vs.id = va.slot_id
            WHERE va.personel_id = %s AND va.tarih = %s
              AND vs.sube_id = %s AND va.durum IN ('planli','onayli')
              AND vs.aktif = TRUE AND %s = ANY(vs.aktif_gunler)
            LIMIT 1
        """, (body.personel_id, bugun, body.sube_id, haftanin_gunu))
        vardiya_planinda = cur.fetchone() is not None
        if not vardiya_planinda:
            vardiya_disi = True

        # Yoklama kaydı
        cur.execute("""
            INSERT INTO gorev_yoklama
                (tarih, sube_id, personel_id, vardiya_tip, konum_mesafe_m, konum_onaylandi, vardiya_disi, asil_sube_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (tarih, sube_id, personel_id, vardiya_tip) DO NOTHING
        """, (tarih, body.sube_id, body.personel_id, vardiya_tip, konum_mesafe_m, konum_onaylandi, vardiya_disi, asil_sube_id))
        conn.commit()

        return {
            "personel_id": personel["id"],
            "ad_soyad": personel["ad_soyad"],
            "sube_id": body.sube_id,
            "tarih": tarih,
            "vardiya_tip": vardiya_tip,
            "konum_onaylandi": konum_onaylandi,
            "konum_mesafe_m": round(konum_mesafe_m) if konum_mesafe_m else None,
            "vardiya_disi": vardiya_disi,
        }


@router.get("/api/gorev/personel-gorevleri")
def gorev_personel_gorevleri(
    tarih: str, sube_id: str, vardiya_tip: str, personel_id: str
):
    """
    Vardiya planına göre personele düşen görevler.
    Vardiyada kaç kişi varsa görevler eşit bölüştürülür.
    """
    from datetime import date as _date
    t = _date.fromisoformat(tarih)

    with db() as (conn, cur):
        # O vardiyada planlanan tüm personeller
        haftanin_gunu = t.weekday() + 1
        cur.execute("""
            SELECT va.personel_id, COALESCE(NULLIF(TRIM(p.ad_soyad),''), va.personel_id) AS ad
            FROM vardiya_atama va
            JOIN vardiya_slot vs ON vs.id = va.slot_id
            JOIN personel p ON p.id = va.personel_id
            WHERE va.tarih = %s
              AND vs.sube_id = %s
              AND va.durum IN ('planli','onayli')
              AND vs.aktif = TRUE
              AND %s = ANY(vs.aktif_gunler)
              AND (
                  (vs.tip = 'acilis' AND %s = 'sabahci') OR
                  (vs.tip = 'normal' AND %s IN ('sabahci','ara_vardiya')) OR
                  (vs.tip = 'kapanis' AND %s = 'kapanis') OR
                  (vs.tip IN ('acilis','normal','kapanis'))
              )
            ORDER BY va.personel_id
        """, (t, sube_id, haftanin_gunu, vardiya_tip, vardiya_tip, vardiya_tip))
        vardiya_personel = [dict(r) for r in cur.fetchall()]

        # Tüm görevleri al
        cur.execute("""
            SELECT gs.id, gs.sira, gs.alan, gs.gorev, gs.siklik,
                   COALESCE(gt.tamamlandi, FALSE) AS tamamlandi,
                   gt.tamamlanma_ts, gt.personel_id AS tamamlayan_id
            FROM gorev_sablonu gs
            LEFT JOIN gorev_tamamlama gt
                ON gt.sablonid = gs.id AND gt.tarih = %s AND gt.sube_id = %s
            WHERE gs.vardiya_tip = %s AND gs.aktif = TRUE
            ORDER BY gs.sira
        """, (t, sube_id, vardiya_tip))
        tum_gorevler = [dict(r) for r in cur.fetchall()]

        # Görev bölüştürme: varsa vardiya kişi sayısına göre, yoksa hepsini ver
        personel_listesi = [p["personel_id"] for p in vardiya_personel]
        kisi_sayisi = len(personel_listesi)

        if kisi_sayisi > 1 and personel_id in personel_listesi:
            idx = personel_listesi.index(personel_id)
            kisi_gorevler = [g for i, g in enumerate(tum_gorevler) if i % kisi_sayisi == idx]
        else:
            kisi_gorevler = tum_gorevler

        tamamlanan = sum(1 for g in kisi_gorevler if g["tamamlandi"])
        return {
            "gorevler": kisi_gorevler,
            "toplam": len(kisi_gorevler),
            "tamamlanan": tamamlanan,
            "eksik": len(kisi_gorevler) - tamamlanan,
            "vardiya_personel": vardiya_personel,
            "vardiya_tip": vardiya_tip,
            "tarih": tarih,
        }


# ── QR Kod endpoint'leri ──────────────────────────────────────────────────────

BASE_URL = os.getenv("APP_URL", "https://evvel-erp-production.up.railway.app")

@router.get("/api/gorev/qr/{sube_id}")
def gorev_qr_uret(sube_id: str):
    """Şube için QR kod PNG üretir. Tarayıcıda direkt görüntülenir/indirilir."""
    try:
        import qrcode
        from qrcode.image.pure import PyPNGImage
    except ImportError:
        raise HTTPException(status_code=500, detail="qrcode kütüphanesi yüklü değil")

    with db() as (conn, cur):
        cur.execute("SELECT ad FROM subeler WHERE id = %s AND aktif = TRUE", (sube_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Şube bulunamadı")
        # latin-1 uyumlu dosya adı (Türkçe karakter sorunu)
        import unicodedata
        sube_ad_raw = row["ad"]
        sube_ad = unicodedata.normalize('NFKD', sube_ad_raw).encode('ascii', 'ignore').decode('ascii') or sube_id

    url = f"{BASE_URL}/gorev-giris/{sube_id}"

    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=4,
    )
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type="image/png",
        headers={"Content-Disposition": f'inline; filename="{sube_ad}_qr.png"'},
    )


class SubeKonumBody(BaseModel):
    lat: float
    lng: float
    konum_radius_m: Optional[int] = 150


@router.put("/api/gorev/sube-konum/{sube_id}")
def sube_konum_guncelle(sube_id: str, body: SubeKonumBody):
    """Şube GPS koordinatı ve radius ayarla (CFO / admin)."""
    with db() as (conn, cur):
        cur.execute("""
            UPDATE subeler SET lat=%s, lng=%s, konum_radius_m=%s WHERE id=%s
        """, (body.lat, body.lng, body.konum_radius_m, sube_id))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Şube bulunamadı")
        conn.commit()
    return {"basarili": True}


@router.get("/api/gorev/yoklama")
def gorev_yoklama_listesi(tarih: str, sube_id: Optional[str] = None, sadece_vardiya_disi: bool = False):
    """Günlük yoklama listesi — CFO özet dashboard için."""
    from datetime import date as _date
    t = _date.fromisoformat(tarih)
    with db() as (conn, cur):
        filtre = "AND gy.vardiya_disi = TRUE" if sadece_vardiya_disi else ""
        if sube_id:
            cur.execute(f"""
                SELECT gy.*, p.ad_soyad, s.ad AS sube_adi,
                       ps.ad AS asil_sube_adi
                FROM gorev_yoklama gy
                JOIN personel p ON p.id::text = gy.personel_id
                JOIN subeler s ON s.id = gy.sube_id
                LEFT JOIN subeler ps ON ps.id = gy.asil_sube_id
                WHERE gy.tarih = %s AND gy.sube_id = %s {filtre}
                ORDER BY gy.giris_ts
            """, (t, sube_id))
        else:
            cur.execute(f"""
                SELECT gy.*, p.ad_soyad, s.ad AS sube_adi,
                       ps.ad AS asil_sube_adi
                FROM gorev_yoklama gy
                JOIN personel p ON p.id::text = gy.personel_id
                JOIN subeler s ON s.id = gy.sube_id
                LEFT JOIN subeler ps ON ps.id = gy.asil_sube_id
                WHERE gy.tarih = %s {filtre}
                ORDER BY s.ad, gy.giris_ts
            """, (t,))
        return [dict(r) for r in cur.fetchall()]


@router.delete("/api/gorev/yoklama/{sube_id}")
def gorev_yoklama_sil(sube_id: str, tarih: Optional[str] = None):
    """Şube yoklama kaydını sil (test/sıfırlama). tarih verilmezse bugün."""
    from tr_saat import is_gunu_tr
    t = tarih or str(is_gunu_tr())
    with db() as (conn, cur):
        cur.execute("DELETE FROM gorev_yoklama WHERE sube_id=%s AND tarih=%s", (sube_id, t))
        silinen = cur.rowcount
        conn.commit()
    return {"silinen": silinen, "sube_id": sube_id, "tarih": t}


@router.get("/api/gorev/qr-liste")
def gorev_qr_liste():
    """Tüm aktif şubelerin QR bilgilerini döner (ID, ad, URL)."""
    with db() as (conn, cur):
        cur.execute("SELECT id, ad FROM subeler WHERE aktif = TRUE ORDER BY ad")
        subeler = [dict(r) for r in cur.fetchall()]
    return [
        {
            "sube_id": s["id"],
            "sube_ad": s["ad"],
            "qr_url": f"{BASE_URL}/api/gorev/qr/{s['id']}",
            "giris_url": f"{BASE_URL}/gorev-giris/{s['id']}",
        }
        for s in subeler
    ]
