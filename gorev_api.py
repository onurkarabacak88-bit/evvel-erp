from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional
from datetime import date
import io, os
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
        sube_ad = row["ad"]

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
