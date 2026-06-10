from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional
from datetime import date
import io, os, math
from database import db

router = APIRouter()

# Sistem başlangıç tarihi - bu tarihten önceki veriler hesaba katılmaz
# Başlangıç günü (10 Haziran): o gün çalışan herkes tam+doğru çalışmış sayılır
# (gecikme=0, fazla mesai=0, yemek=tam, haftalık izin=var)
from datetime import date as _SYSTEM_DATE
SISTEM_BASLANGIC = _SYSTEM_DATE(2025, 6, 1)

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
        # Tek kişi ya da plan yok - hepsini göster
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
    """Tüm aktif personel - şube personeli önce, diğerleri sonra."""
    with db() as (conn, cur):
        cur.execute("""
            SELECT p.id::text, p.ad_soyad,
                   (p.panel_pin_hash IS NOT NULL AND p.panel_pin_salt IS NOT NULL) AS pin_tanimli,
                   (p.sube_id = %s) AS bu_sube,
                   COALESCE(s.ad, '-') AS sube_adi
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

        # Yönetici mi kontrol et - yöneticiler konum kısıtından muaf
        cur.execute("SELECT panel_yonetici FROM personel WHERE id::text = %s", (body.personel_id,))
        p_row = cur.fetchone()
        yonetici = bool(p_row and p_row["panel_yonetici"])

        # Konum doğrulama: şubede koordinat tanımlıysa VE yönetici değilse kontrol et
        konum_mesafe_m = None
        konum_onaylandi = False
        if sube and sube["lat"] and sube["lng"] and not yonetici:
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
        elif yonetici:
            konum_onaylandi = True  # yönetici her zaman onaylı

        personel = dogrula_personel_panel_pin(cur, body.personel_id, body.pin)

        tarih = str(is_gunu_tr())
        from datetime import date as _d2
        bugun = _d2.fromisoformat(tarih)

        # ── Vardiya planından kişinin slotunu al ──────────────────────────────
        SLOT_TIP_MAP = {
            'acilis': 'sabahci', 'normal': 'sabahci',
            'yogun': 'ara_vardiya', 'kapanis': 'kapanis',
        }
        cur.execute("""
            SELECT vs.tip, va.baslangic_saat,
                   EXTRACT(EPOCH FROM (
                       CASE WHEN va.bitis_saat <= va.baslangic_saat
                            THEN (va.bitis_saat::time + INTERVAL '24h') - va.baslangic_saat::time
                            ELSE va.bitis_saat::time - va.baslangic_saat::time END
                   ))/3600.0 AS planlanan_saat
            FROM vardiya_atama va
            JOIN vardiya_slot vs ON vs.id = va.slot_id
            WHERE va.personel_id = %s AND va.tarih = %s
              AND vs.sube_id = %s AND va.durum IN ('planli','onayli')
              AND vs.aktif = TRUE
            ORDER BY va.baslangic_saat LIMIT 1
        """, (body.personel_id, bugun, body.sube_id))
        slot_row = cur.fetchone()
        planlanan_saat = float(slot_row["planlanan_saat"] or 0) if slot_row else 0.0

        # ── Dükkan bugün ne zaman açıldı? ────────────────────────────────────
        cur.execute("""
            SELECT acilis_saati FROM sube_acilis
            WHERE sube_id=%s AND tarih=%s AND durum='acildi'
            LIMIT 1
        """, (body.sube_id, tarih))
        acilis_row = cur.fetchone()
        sube_acildi = acilis_row is not None

        # Açılıştan bu yana kaç dakika geçti? (acilis_saati = 'HH:MM' text)
        gecen_dk = 0
        if sube_acildi and acilis_row.get("acilis_saati"):
            try:
                simdi_tr = dt_now_tr()
                saat_str = acilis_row["acilis_saati"]  # örn: '09:15'
                h, m = int(saat_str[:2]), int(saat_str[3:5])
                acilis_dk = h * 60 + m
                simdi_dk = simdi_tr.hour * 60 + simdi_tr.minute
                gecen_dk = simdi_dk - acilis_dk
            except Exception:
                gecen_dk = 0

        # ── Vardiya tipini belirle ─────────────────────────────────────────────
        #
        # Plan VAR (sabahçı): dükkan açılmamış VEYA açılış üzerinden ≤60 dk geçmiş → sabahçı
        #                     açılış üzerinden >60 dk geçmiş → ara vardiya (açılışa yetişemedi)
        # Plan VAR (diğer): planı olduğu gibi kullan
        # Plan YOK: dükkan kapalı→sabahçı | gece≥19→kapanış | gündüz→ara vardiya

        if slot_row:
            plan_tip = SLOT_TIP_MAP.get(slot_row["tip"], "sabahci")
            if plan_tip == "sabahci" and sube_acildi and gecen_dk > 60:
                # Açılıştan 1 saatten fazla sonra geldi → ara vardiya
                vardiya_tip = "ara_vardiya"
            else:
                vardiya_tip = plan_tip
            vardiya_tanimli = True
        else:
            saat = dt_now_tr().hour
            if not sube_acildi:
                vardiya_tip = "sabahci"
            elif saat >= 19:
                vardiya_tip = "kapanis"
            else:
                vardiya_tip = "ara_vardiya"
            planlanan_saat = 0.0
            vardiya_tanimli = False

        calisma_turu = personel.get("calisma_turu") or "surekli"

        # Personelin asıl şubesi + vardiya dışı kontrolü
        asil_sube_id = personel.get("sube_id") or body.sube_id
        vardiya_disi = str(asil_sube_id) != str(body.sube_id)

        # Aynı kişinin aynı şubede aynı gün zaten kaydı var mı? (vardiya_tip farklı olsa bile)
        cur.execute("""
            SELECT id, vardiya_tip, giris_ts FROM gorev_yoklama
            WHERE sube_id = %s AND personel_id = %s AND tarih = %s
            LIMIT 1
        """, (body.sube_id, body.personel_id, tarih))
        mevcut_yoklama = cur.fetchone()
        if mevcut_yoklama:
            # Zaten giriş yapılmış — mevcut kaydı döndür, yeni kayıt açma
            mevcut_vardiya_tip = mevcut_yoklama["vardiya_tip"]
            return {
                "personel_id": personel["id"],
                "ad_soyad": personel["ad_soyad"],
                "sube_id": body.sube_id,
                "tarih": tarih,
                "vardiya_tip": mevcut_vardiya_tip,
                "konum_onaylandi": konum_onaylandi,
                "konum_mesafe_m": round(konum_mesafe_m) if konum_mesafe_m else None,
                "vardiya_disi": vardiya_disi,
                "calisma_turu": calisma_turu,
                "planlanan_saat": round(planlanan_saat, 2),
                "yemek_mola_hakki": (calisma_turu == "surekli") or (planlanan_saat >= 9.5),
                "vardiya_tanimli": vardiya_tanimli,
                "zaten_giris_yapildi": True,
            }

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
            "calisma_turu": calisma_turu,
            "planlanan_saat": round(planlanan_saat, 2),
            "yemek_mola_hakki": (calisma_turu == "surekli") or (planlanan_saat >= 9.5),
            "vardiya_tanimli": vardiya_tanimli,
            # vardiya_tanimli=False ise frontend seçim ekranı gösterir
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
    """Günlük yoklama listesi - CFO özet dashboard için."""
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


YEMEK_KONUM_RADIUS = 150  # metre - şube büyüklüğü 100m + 50m GPS toleransı


class YemekMolasiBody(BaseModel):
    sube_id: str
    personel_id: str
    lat: Optional[float] = None
    lng: Optional[float] = None


def _konum_kontrol(cur, sube_id: str, lat, lng, hata_prefix: str):
    """Şubede koordinat tanımlıysa konum kontrolü yap. Uzaktaysa HTTPException fırlat."""
    cur.execute("SELECT lat, lng FROM subeler WHERE id=%s", (sube_id,))
    sube = cur.fetchone()
    if not (sube and sube["lat"] and sube["lng"]):
        return  # koordinat tanımlı değil, serbest
    if lat is None or lng is None:
        raise HTTPException(403, f"konum_gerekli|{hata_prefix} için konum izni gereklidir.")
    mesafe = _haversine_m(lat, lng, sube["lat"], sube["lng"])
    if mesafe > YEMEK_KONUM_RADIUS:
        raise HTTPException(403,
            f"sube_disinda|{hata_prefix} şube dışından yapılamaz "
            f"(şubeye uzaklık: {int(mesafe)} m, limit: {YEMEK_KONUM_RADIUS} m).")


@router.post("/api/gorev/yemek-baslat")
def yemek_baslat(body: YemekMolasiBody):
    """Personel yemeğe gidiyor - konum kontrolü + mola başlangıcını kaydet."""
    from tr_saat import is_gunu_tr
    tarih = str(is_gunu_tr())
    with db() as (conn, cur):
        # Konum kontrolü - şubeden uzaksa başlatma
        _konum_kontrol(cur, body.sube_id, body.lat, body.lng, "Yemek molası başlatma")
        # Yoklama kaydı var mı
        cur.execute("SELECT 1 FROM gorev_yoklama WHERE sube_id=%s AND personel_id=%s AND tarih=%s",
                    (body.sube_id, body.personel_id, tarih))
        if not cur.fetchone():
            raise HTTPException(403, "Önce QR ile giriş yapılmalı.")
        cur.execute("SELECT id, bitis_ts FROM yemek_molasi WHERE sube_id=%s AND personel_id=%s AND tarih=%s",
                    (body.sube_id, body.personel_id, tarih))
        mevcut = cur.fetchone()
        if mevcut and mevcut["bitis_ts"] is None:
            raise HTTPException(400, "Zaten açık bir yemek molası var.")
        if mevcut:
            raise HTTPException(400, "Bu gün için yemek molası zaten kaydedildi.")
        cur.execute("""
            INSERT INTO yemek_molasi (tarih, sube_id, personel_id, baslangic_ts)
            VALUES (%s, %s, %s, NOW())
        """, (tarih, body.sube_id, body.personel_id))
        conn.commit()
    return {"basarili": True, "durum": "mola_basladi"}


@router.post("/api/gorev/yemek-bitis")
def yemek_bitis(body: YemekMolasiBody):
    """Personel yemekten döndü - konum kontrolü + mola bitiş + ücret hakkı hesapla."""
    from tr_saat import is_gunu_tr, dt_now_tr
    tarih = str(is_gunu_tr())
    with db() as (conn, cur):
        # Konum kontrolü - şubede değilse kapatma
        _konum_kontrol(cur, body.sube_id, body.lat, body.lng, "Yemek molası kapatma")
        cur.execute("""
            SELECT ym.id, ym.baslangic_ts, s.yemek_mola_limit_dk
            FROM yemek_molasi ym
            JOIN subeler s ON s.id = ym.sube_id
            WHERE ym.sube_id=%s AND ym.personel_id=%s AND ym.tarih=%s AND ym.bitis_ts IS NULL
        """, (body.sube_id, body.personel_id, tarih))
        row = cur.fetchone()
        if not row:
            raise HTTPException(400, "Açık yemek molası bulunamadı. Önce 'Yemeğe Git' yapın.")
        limit_dk = int(row["yemek_mola_limit_dk"] or 60)
        simdi = dt_now_tr()
        sure_dk = (simdi.replace(tzinfo=None) - row["baslangic_ts"].replace(tzinfo=None)).total_seconds() / 60
        ucret_hakki = sure_dk <= limit_dk
        cur.execute("""
            UPDATE yemek_molasi SET bitis_ts=NOW(), sure_dk=%s, ucret_hakki=%s WHERE id=%s
        """, (round(sure_dk, 1), ucret_hakki, row["id"]))
        conn.commit()
    return {
        "basarili": True,
        "sure_dk": round(sure_dk, 1),
        "limit_dk": limit_dk,
        "ucret_hakki": ucret_hakki,
        "mesaj": f"{'✅ Yemek ücreti hakkı kazanıldı' if ucret_hakki else f'❌ Mola süresi ({int(sure_dk)} dk) limitini aştı - yemek ücreti bu gün ödenmez'}",
    }


@router.get("/api/gorev/yemek-durum")
def yemek_durum(sube_id: str, personel_id: str):
    """Personelin bugünkü yemek molası durumu."""
    from tr_saat import is_gunu_tr
    tarih = str(is_gunu_tr())
    with db() as (conn, cur):
        cur.execute("""
            SELECT ym.*, s.yemek_mola_limit_dk
            FROM yemek_molasi ym
            JOIN subeler s ON s.id = ym.sube_id
            WHERE ym.sube_id=%s AND ym.personel_id=%s AND ym.tarih=%s
        """, (sube_id, personel_id, tarih))
        row = cur.fetchone()
        if not row:
            return {"durum": "yok", "ucret_hakki": None}
        d = dict(row)
        if d["bitis_ts"] is None:
            return {"durum": "devam", "baslangic_ts": str(d["baslangic_ts"]), "ucret_hakki": None}
        return {
            "durum": "bitti",
            "sure_dk": float(d["sure_dk"] or 0),
            "limit_dk": int(d["yemek_mola_limit_dk"] or 60),
            "ucret_hakki": d["ucret_hakki"],
        }


class MesaiCikisBody(BaseModel):
    sube_id: str
    personel_id: str
    cikis_tip: Optional[str] = "manuel"  # kasa_devri | kapalis | manuel
    lat: Optional[float] = None
    lng: Optional[float] = None


@router.post("/api/gorev/mesai-cikis")
def mesai_cikis(body: MesaiCikisBody):
    """Personel mesai çıkışı - kasa devri veya kapanışta QR onayıyla."""
    from tr_saat import is_gunu_tr, dt_now_tr
    tarih = str(is_gunu_tr())
    with db() as (conn, cur):
        # Konum kontrolü (koordinat tanımlıysa)
        _konum_kontrol(cur, body.sube_id, body.lat, body.lng, "Mesai çıkışı")
        # Bugün bu şubede aktif yoklama var mı?
        cur.execute("""
            SELECT id, giris_ts, cikis_ts, vardiya_tip
            FROM gorev_yoklama
            WHERE sube_id=%s AND personel_id=%s AND tarih=%s
            ORDER BY giris_ts DESC LIMIT 1
        """, (body.sube_id, body.personel_id, tarih))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Bugün bu şube için giriş kaydı bulunamadı.")
        if row["cikis_ts"]:
            raise HTTPException(400, "Mesai çıkışı zaten yapılmış.")
        cikis_ts = dt_now_tr()
        cur.execute("""
            UPDATE gorev_yoklama
            SET cikis_ts=%s, cikis_tip=%s
            WHERE id=%s
        """, (cikis_ts, body.cikis_tip, row["id"]))
        conn.commit()
        # Çalışılan süreyi hesapla
        giris = row["giris_ts"].replace(tzinfo=None) if row["giris_ts"] else None
        cikis_naive = cikis_ts.replace(tzinfo=None)
        sure_dk = round((cikis_naive - giris).total_seconds() / 60) if giris else None
    return {
        "basarili": True,
        "cikis_ts": str(cikis_ts),
        "cikis_tip": body.cikis_tip,
        "sure_dk": sure_dk,
        "vardiya_tip": row["vardiya_tip"],
        "mesaj": f"✅ Mesai çıkışı kaydedildi - çalışma süresi: {sure_dk//60}s {sure_dk%60}dk" if sure_dk else "✅ Mesai çıkışı kaydedildi.",
    }


# ── KASA DEVİR ONAYI ─────────────────────────────────────────────────────────

def _kasa_devir_onay_migrate(cur):
    """form_data ve form_kaydedildi durumu için migration."""
    cur.execute("""
        ALTER TABLE kasa_devir_onay
        ADD COLUMN IF NOT EXISTS form_data JSONB DEFAULT '{}'::jsonb
    """)
    cur.execute("""
        ALTER TABLE kasa_devir_onay
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    """)
    cur.execute("""
        ALTER TABLE kasa_devir_onay
        ADD COLUMN IF NOT EXISTS devralan_id TEXT
    """)

class DevirBaslatBody(BaseModel):
    sube_id: str
    devreden_id: str
    devralan_id: Optional[str] = None
    not_aciklama: Optional[str] = None


class DevirFormKaydetBody(BaseModel):
    sube_id: str
    devreden_id: str
    form_data: dict = {}

@router.post("/api/gorev/devir-form-kaydet")
def devir_form_kaydet(body: DevirFormKaydetBody):
    """Panel form verisini kaydeder (durum=form_kaydedildi). Sabahçı telefondan onaylayacak."""
    from tr_saat import is_gunu_tr
    import json as _json
    import uuid as _uuid
    tarih = str(is_gunu_tr())
    with db() as (conn, cur):
        try:
            _kasa_devir_onay_migrate(cur)
        except Exception:
            pass
        # Bugün bu şube için zaten form_kaydedildi veya bekliyor varsa güncelle
        cur.execute("""
            SELECT id FROM kasa_devir_onay
            WHERE sube_id=%s AND tarih=%s AND durum IN ('form_kaydedildi','bekliyor')
            ORDER BY created_at DESC LIMIT 1
        """, (body.sube_id, tarih))
        mevcut = cur.fetchone()
        if mevcut:
            cur.execute("""
                UPDATE kasa_devir_onay
                SET devreden_id=%s, form_data=%s::jsonb, durum='form_kaydedildi'
                WHERE id=%s
            """, (body.devreden_id, _json.dumps(body.form_data), mevcut["id"]))
            conn.commit()
            return {"devir_id": mevcut["id"], "yeni": False, "mesaj": "Form güncellendi."}
        devir_id = str(_uuid.uuid4())
        cur.execute("""
            INSERT INTO kasa_devir_onay (id, sube_id, tarih, devreden_id, form_data, durum)
            VALUES (%s, %s, %s, %s, %s::jsonb, 'form_kaydedildi')
        """, (devir_id, body.sube_id, tarih, body.devreden_id, _json.dumps(body.form_data)))
        conn.commit()
    return {"devir_id": devir_id, "yeni": True, "mesaj": "Form kaydedildi. Sabahçı telefondan onaylayacak."}


class DevirSabahOnaylaBody(BaseModel):
    sube_id: str
    personel_id: str
    devir_id: str
    lat: Optional[float] = None
    lng: Optional[float] = None

@router.post("/api/gorev/devir-sabah-onayla")
def devir_sabah_onayla(body: DevirSabahOnaylaBody):
    """Sabahçı telefondan devri onaylar: adim1 + cikis_ts set."""
    from tr_saat import is_gunu_tr, dt_now_tr
    import json as _json
    tarih = str(is_gunu_tr())
    with db() as (conn, cur):
        try:
            _kasa_devir_onay_migrate(cur)
        except Exception:
            pass
        # Devir kaydını kontrol et
        cur.execute("""
            SELECT id, durum, devreden_id, form_data
            FROM kasa_devir_onay
            WHERE id=%s AND sube_id=%s
        """, (body.devir_id, body.sube_id))
        devir = cur.fetchone()
        if not devir:
            raise HTTPException(404, "Devir kaydı bulunamadı.")
        if devir["durum"] == 'bekliyor':
            raise HTTPException(409, "Devir zaten onaylandı.")
        if devir["durum"] == 'onaylandi':
            raise HTTPException(409, "Devir tamamen tamamlandı.")
        if devir["durum"] != 'form_kaydedildi':
            raise HTTPException(400, f"Beklenmeyen durum: {devir['durum']}")
        if str(devir["devreden_id"]) != str(body.personel_id):
            raise HTTPException(403, "Bu devir sana ait değil.")

        # Konum kontrolü
        cur.execute("SELECT lat, lng, konum_radius_m FROM subeler WHERE id=%s", (body.sube_id,))
        sube = cur.fetchone()
        cur.execute("SELECT panel_yonetici, ad_soyad FROM personel WHERE id::text=%s", (body.personel_id,))
        p_row = cur.fetchone()
        yonetici = bool(p_row and p_row.get("panel_yonetici"))
        devreden_ad = ((p_row.get("ad_soyad") or "").strip() if p_row else "") or "—"
        if sube and sube["lat"] and sube["lng"] and not yonetici:
            if body.lat is not None and body.lng is not None:
                mesafe = _haversine_m(body.lat, body.lng, sube["lat"], sube["lng"])
                radius = sube["konum_radius_m"] or 150
                if mesafe > radius:
                    raise HTTPException(403, f"sube_disinda|Şubeye çok uzaksın ({int(mesafe)} m).")

        simdi = dt_now_tr()

        # Kasa devir onayını 'bekliyor' durumuna al (akşamcı için)
        cur.execute("""
            UPDATE kasa_devir_onay
            SET devreden_ts=%s, durum='bekliyor'
            WHERE id=%s
        """, (simdi, body.devir_id))

        # Mesai çıkışı (cikis_ts) set et
        from datetime import date as _d3
        gun = str(_d3.fromisoformat(tarih))
        cur.execute("""
            UPDATE gorev_yoklama
            SET cikis_ts=%s, cikis_tip='kasa_devri'
            WHERE sube_id=%s AND personel_id=%s AND tarih=%s AND cikis_ts IS NULL
        """, (simdi, body.sube_id, body.personel_id, gun))

        # adim1 — kapanis_kayit INSERT (form_data'dan bilgileri al)
        fd = devir["form_data"] or {}
        if isinstance(fd, str):
            try:
                fd = _json.loads(fd)
            except Exception:
                fd = {}

        from sube_kapanis_dual import kasa_devir_adim1_kaydet, _korumali_yan_etki

        def _adim1():
            kasa_devir_adim1_kaydet(cur, body.sube_id, body.personel_id, devreden_ad, simdi, gun, fd)

        _korumali_yan_etki(cur, "kasa_devir_adim1", _adim1)

        conn.commit()

    return {"basarili": True, "mesaj": "Devir onaylandı. Mesain sona erdi. Akşamcı devri alacak."}

class DevirKabulBody(BaseModel):
    sube_id: str
    kabul_eden_id: str
    devir_id: str

@router.post("/api/gorev/devir-baslat")
def devir_baslat(body: DevirBaslatBody):
    """Sabahci/ara vardiya cikarken kasa devir kaydini olusturur (durum=bekliyor)."""
    from tr_saat import is_gunu_tr
    tarih = str(is_gunu_tr())
    with db() as (conn, cur):
        try:
            _kasa_devir_onay_migrate(cur)
        except Exception:
            pass
        # Bugün bu şube için zaten bekleyen devir var mı?
        cur.execute("""
            SELECT id FROM kasa_devir_onay
            WHERE sube_id=%s AND tarih=%s AND durum='bekliyor'
        """, (body.sube_id, tarih))
        mevcut = cur.fetchone()
        if mevcut:
            return {"devir_id": mevcut["id"], "yeni": False,
                    "mesaj": "Zaten bekleyen devir kaydı var."}
        import uuid as _uuid
        devir_id = str(_uuid.uuid4())
        cur.execute("""
            INSERT INTO kasa_devir_onay (id, sube_id, tarih, devreden_id, devralan_id, not_aciklama)
            VALUES (%s, %s, %s, %s, %s, %s)
        """, (devir_id, body.sube_id, tarih, body.devreden_id, body.devralan_id, body.not_aciklama))
        conn.commit()
    return {"devir_id": devir_id, "yeni": True,
            "mesaj": "Devir kaydı oluşturuldu. Gelen vardiya kabul etmeli."}

@router.get("/api/gorev/devir-bekleyen")
def devir_bekleyen(sube_id: str):
    """Bu şubede bugün bekleyen devir kaydı var mı? form_kaydedildi + bekliyor durumlarını döner."""
    from tr_saat import is_gunu_tr
    tarih = str(is_gunu_tr())
    with db() as (conn, cur):
        try:
            _kasa_devir_onay_migrate(cur)
            conn.commit()
        except Exception:
            pass
        cur.execute("""
            SELECT d.id, d.devreden_id, d.devralan_id, d.devreden_ts, d.not_aciklama, d.durum,
                   COALESCE(d.form_data, '{}'::jsonb) AS form_data,
                   COALESCE(p.ad_soyad, d.devreden_id) AS devreden_ad,
                   pd.ad_soyad AS devralan_ad
            FROM kasa_devir_onay d
            LEFT JOIN personel p ON p.id::text = d.devreden_id
            LEFT JOIN personel pd ON pd.id::text = d.devralan_id
            WHERE d.sube_id=%s AND d.tarih=%s AND d.durum IN ('form_kaydedildi','bekliyor')
            ORDER BY d.created_at DESC LIMIT 1
        """, (sube_id, tarih))
        row = cur.fetchone()
        if not row:
            return {"bekliyor": False, "sabah_onay_bekliyor": False}
        import json as _json
        fd = row["form_data"]
        if isinstance(fd, str):
            try: fd = _json.loads(fd)
            except: fd = {}
        # Form özeti (akşamcının göreceği)
        form_ozet = {
            "teslim": fd.get("teslim", 0),
            "bardak_kucuk": fd.get("bardak_kucuk", 0),
            "bardak_buyuk": fd.get("bardak_buyuk", 0),
            "bardak_plastik": fd.get("bardak_plastik", 0),
            "pasta_adet": fd.get("pasta_adet", 0),
            "su_adet": fd.get("su_adet", 0),
        }
        if row["durum"] == 'form_kaydedildi':
            return {
                "bekliyor": False,
                "sabah_onay_bekliyor": True,
                "devir_id": row["id"],
                "devreden_id": str(row["devreden_id"]),
                "devreden_ad": row["devreden_ad"],
                "form_ozet": form_ozet,
            }
        # bekliyor — akşamcı için
        return {
            "bekliyor": True,
            "sabah_onay_bekliyor": False,
            "devir_id": row["id"],
            "devreden_ad": row["devreden_ad"],
            "devreden_ts": str(row["devreden_ts"]) if row["devreden_ts"] else None,
            "not_aciklama": row["not_aciklama"],
            "form_ozet": form_ozet,
            "devralan_id": row["devralan_id"],
            "devralan_ad": row["devralan_ad"],
        }


class DevirGunSifirlaBody(BaseModel):
    sube_id: str
    tarih: Optional[str] = None  # YYYY-MM-DD, default: bugün (TR günü)


@router.post("/api/gorev/devir-gun-sifirla")
def devir_gun_sifirla(body: DevirGunSifirlaBody):
    """DEV/TEST ARACI: Belirtilen şube + gün için kasa devri kayıtlarını sıfırlar.
    - kasa_devir_onay kayıtlarını siler
    - kasa_devri ile yapılmış mesai çıkışlarını geri açar (cikis_ts/cikis_tip temizlenir)
    - bekleyen 'vardiya_sabah_aksam_devri' kapanış kaydını siler
    Böylece o gün için devir akışı sıfırdan tekrar denenebilir."""
    from tr_saat import is_gunu_tr
    tarih = body.tarih or str(is_gunu_tr())
    with db() as (conn, cur):
        try:
            _kasa_devir_onay_migrate(cur)
        except Exception:
            pass
        cur.execute("DELETE FROM kasa_devir_onay WHERE sube_id=%s AND tarih=%s", (body.sube_id, tarih))
        devir_silindi = cur.rowcount
        cur.execute("""
            UPDATE gorev_yoklama SET cikis_ts=NULL, cikis_tip=NULL
            WHERE sube_id=%s AND tarih=%s AND cikis_tip='kasa_devri'
        """, (body.sube_id, tarih))
        yoklama_sifirlandi = cur.rowcount
        cur.execute("""
            DELETE FROM kapanis_kayit
            WHERE sube_id=%s AND tarih=%s AND olay='vardiya_sabah_aksam_devri'
              AND durum IN ('acilis_bekliyor', 'tamamlandi')
        """, (body.sube_id, tarih))
        kapanis_silindi = cur.rowcount
        conn.commit()
    return {
        "basarili": True,
        "tarih": tarih,
        "devir_kayit_silindi": devir_silindi,
        "yoklama_cikis_sifirlandi": yoklama_sifirlandi,
        "kapanis_kayit_silindi": kapanis_silindi,
        "mesaj": "Bu şube ve gün için kasa devri akışı sıfırlandı. Sıfırdan tekrar deneyebilirsin.",
    }


@router.post("/api/gorev/devir-kabul")
def devir_kabul(body: DevirKabulBody):
    """Gelen vardiya devri onaylar."""
    from tr_saat import is_gunu_tr, dt_now_tr
    with db() as (conn, cur):
        cur.execute("""
            SELECT id, durum FROM kasa_devir_onay
            WHERE id=%s AND sube_id=%s
        """, (body.devir_id, body.sube_id))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Devir kaydı bulunamadı.")
        if row["durum"] != 'bekliyor':
            raise HTTPException(400, f"Devir zaten {row['durum']} durumunda.")
        cur.execute("""
            UPDATE kasa_devir_onay
            SET kabul_eden_id=%s, kabul_ts=%s, durum='onaylandi'
            WHERE id=%s
        """, (body.kabul_eden_id, dt_now_tr(), body.devir_id))
        conn.commit()
    return {"basarili": True, "mesaj": "Devir kabul edildi. Vardiyaya hos geldin!"}


class DevirGirisBody(BaseModel):
    sube_id: str
    personel_id: str
    devir_id: str
    lat: Optional[float] = None
    lng: Optional[float] = None

@router.post("/api/gorev/devir-giris")
def devir_giris(body: DevirGirisBody):
    """
    QR ile devir kabulu - PIN gerektirmez.
    Yoklama olusturur + devri onaylar, oturum bilgisi doner.
    """
    from tr_saat import is_gunu_tr, dt_now_tr
    from datetime import date as _d2
    tarih = str(is_gunu_tr())
    bugun = _d2.fromisoformat(tarih)

    with db() as (conn, cur):
        # Devir kaydını kontrol et
        cur.execute("""
            SELECT id, durum, devreden_id, devralan_id FROM kasa_devir_onay
            WHERE id=%s AND sube_id=%s
        """, (body.devir_id, body.sube_id))
        devir = cur.fetchone()
        if not devir:
            raise HTTPException(404, "Devir kaydı bulunamadı.")
        if devir["durum"] != 'bekliyor':
            raise HTTPException(400, "Bu devir zaten onaylandı.")
        if devir["devralan_id"] and str(devir["devralan_id"]) != str(body.personel_id):
            raise HTTPException(403, "Bu devir sana ait değil — devreden seni hedef olarak seçmemiş.")

        # Personel bilgisi
        cur.execute("SELECT * FROM personel WHERE id::text=%s", (body.personel_id,))
        p = cur.fetchone()
        if not p:
            raise HTTPException(404, "Personel bulunamadı.")

        # Konum kontrolü (şubede koordinat varsa)
        konum_mesafe_m = None
        konum_onaylandi = False
        yonetici = bool(p.get("panel_yonetici"))
        cur.execute("SELECT lat, lng, konum_radius_m FROM subeler WHERE id=%s", (body.sube_id,))
        sube = cur.fetchone()
        if sube and sube["lat"] and sube["lng"] and not yonetici:
            if body.lat is not None and body.lng is not None:
                konum_mesafe_m = _haversine_m(body.lat, body.lng, sube["lat"], sube["lng"])
                radius = sube["konum_radius_m"] or 150
                if konum_mesafe_m > radius:
                    raise HTTPException(403,
                        f"sube_disinda|Şubeye çok uzaksın ({int(konum_mesafe_m)} m).")
                konum_onaylandi = True
        else:
            konum_onaylandi = True

        # Vardiya planından tip belirle
        SLOT_TIP_MAP = {'acilis': 'sabahci', 'normal': 'sabahci',
                        'yogun': 'ara_vardiya', 'kapanis': 'kapanis'}
        haftanin_gunu = bugun.weekday() + 1
        cur.execute("""
            SELECT vs.tip, va.baslangic_saat,
                   EXTRACT(EPOCH FROM (
                       CASE WHEN va.bitis_saat <= va.baslangic_saat
                            THEN (va.bitis_saat::time + INTERVAL '24h') - va.baslangic_saat::time
                            ELSE va.bitis_saat::time - va.baslangic_saat::time END
                   ))/3600.0 AS planlanan_saat
            FROM vardiya_atama va
            JOIN vardiya_slot vs ON vs.id = va.slot_id
            WHERE va.personel_id=%s AND va.tarih=%s
              AND vs.sube_id=%s AND va.durum IN ('planli','onayli')
              AND vs.aktif=TRUE
            ORDER BY va.baslangic_saat LIMIT 1
        """, (body.personel_id, bugun, body.sube_id))
        slot_row = cur.fetchone()
        vardiya_tip = SLOT_TIP_MAP.get(slot_row["tip"], "sabahci") if slot_row else "sabahci"
        planlanan_saat = float(slot_row["planlanan_saat"] or 0) if slot_row else 0.0
        vardiya_tanimli = bool(slot_row)
        calisma_turu = p.get("calisma_turu") or "surekli"
        asil_sube_id = p.get("sube_id") or body.sube_id
        vardiya_disi = str(asil_sube_id) != str(body.sube_id) or not vardiya_tanimli

        # Yoklama kaydı oluştur (zaten varsa güncelleme yok, tekrar giremez)
        cur.execute("""
            SELECT id FROM gorev_yoklama
            WHERE sube_id=%s AND personel_id=%s AND tarih=%s
        """, (body.sube_id, body.personel_id, tarih))
        if cur.fetchone():
            raise HTTPException(400, "Bu şube için bugün zaten giriş kaydın var.")

        import uuid as _uuid2
        giris_ts = dt_now_tr()
        cur.execute("""
            INSERT INTO gorev_yoklama
                (id, tarih, sube_id, personel_id, vardiya_tip, konum_mesafe_m,
                 konum_onaylandi, vardiya_disi, asil_sube_id, giris_ts)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (str(_uuid2.uuid4()), tarih, body.sube_id, body.personel_id, vardiya_tip,
              konum_mesafe_m, konum_onaylandi, vardiya_disi, str(asil_sube_id), giris_ts))

        # Devri onayla
        cur.execute("""
            UPDATE kasa_devir_onay
            SET kabul_eden_id=%s, kabul_ts=%s, durum='onaylandi'
            WHERE id=%s
        """, (body.personel_id, giris_ts, body.devir_id))

        # Eğer kapanis_kayit'te bekleyen vardiya devri varsa adim2'yi otomatik tamamla
        from sube_kapanis_dual import kasa_devir_adim2_kaydet, _korumali_yan_etki

        def _adim2():
            cur.execute("""
                SELECT id, sabahci_personel_id FROM kapanis_kayit
                WHERE sube_id=%s AND tarih=%s
                  AND olay='vardiya_sabah_aksam_devri'
                  AND durum='acilis_bekliyor'
                LIMIT 1
            """, (body.sube_id, tarih))
            kk = cur.fetchone()
            if kk:
                kk = dict(kk)
                # Aynı kişi her iki imzayı atamaz
                sabah_pid = kk.get("sabahci_personel_id") or ""
                if str(body.personel_id) != str(sabah_pid):
                    kasa_devir_adim2_kaydet(cur, body.sube_id, kk["id"], body.personel_id, p["ad_soyad"], giris_ts)

        _korumali_yan_etki(cur, "kasa_devir_adim2", _adim2)

        conn.commit()

    return {
        "personel_id": str(p["id"]),
        "ad_soyad": p["ad_soyad"],
        "sube_id": body.sube_id,
        "tarih": tarih,
        "vardiya_tip": vardiya_tip,
        "vardiya_tanimli": vardiya_tanimli,
        "planlanan_saat": planlanan_saat,
        "calisma_turu": calisma_turu,
        "yemek_mola_hakki": True,
        "giris_ts": str(giris_ts),
        "devir_kabul": True,
    }


@router.get("/api/gorev/kapanis-bekleyen")
def kapanis_bekleyen(sube_id: str):
    """
    Bugun kapanis vardiyasinda giris yapip henuz cikis yapmamis personelleri doner.
    KapanisMuhurBandi QR polling + GorevGiris kapanis onay ekrani icin kullanilir.
    """
    from tr_saat import is_gunu_tr
    tarih = str(is_gunu_tr())
    with db() as (_, cur):
        cur.execute("""
            SELECT gy.id, gy.personel_id, gy.giris_ts,
                   p.ad_soyad
            FROM gorev_yoklama gy
            JOIN personel p ON p.id::text = gy.personel_id
            WHERE gy.sube_id = %s
              AND gy.tarih = %s
              AND gy.vardiya_tip = 'kapanis'
              AND gy.cikis_ts IS NULL
        """, (sube_id, tarih))
        rows = cur.fetchall()
    return {
        "bekleyen": [
            {"yoklama_id": r["id"], "personel_id": r["personel_id"],
             "ad_soyad": r["ad_soyad"], "giris_ts": str(r["giris_ts"])}
            for r in rows
        ]
    }


class KapanisMuhurleBody(BaseModel):
    sube_id: str
    personel_id: str
    lat: Optional[float] = None
    lng: Optional[float] = None


@router.post("/api/gorev/kapanis-muhurle")
def kapanis_muhurle(body: KapanisMuhurleBody):
    """
    QR ile kapanis onaylama - pin gerektirmez.
    Mevcut mesai-cikis mantigi ile kapanis cikisi yapar.
    """
    from tr_saat import is_gunu_tr, dt_now_tr
    tarih = str(is_gunu_tr())
    with db() as (conn, cur):
        cur.execute("""
            SELECT id, cikis_ts FROM gorev_yoklama
            WHERE sube_id=%s AND personel_id=%s AND tarih=%s AND vardiya_tip='kapanis'
        """, (body.sube_id, body.personel_id, tarih))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Kapanis yoklama bulunamadi.")
        if row["cikis_ts"]:
            return {"mesaj": "Kapanis zaten muhürlendi.", "zaten_muhürlü": True}

        cur.execute("""
            UPDATE gorev_yoklama
            SET cikis_ts=%s, cikis_tip='kapalis'
            WHERE id=%s
        """, (dt_now_tr(), row["id"]))
        conn.commit()
    return {"mesaj": "Kapanis muhürlendi.", "zaten_muhürlü": False}


@router.post("/api/gorev/kapanis-sifirla")
def kapanis_sifirla(sube_id: str):
    """Bugunun kapanis cikis_ts'ini temizler - tekrar yapilabilir hale getirir."""
    from tr_saat import is_gunu_tr
    tarih = str(is_gunu_tr())
    with db() as (conn, cur):
        cur.execute("""
            UPDATE gorev_yoklama
            SET cikis_ts = NULL, cikis_tip = NULL
            WHERE sube_id = %s AND tarih = %s AND vardiya_tip = 'kapanis'
        """, (sube_id, tarih))
        etkilenen = cur.rowcount
        conn.commit()
    return {"mesaj": f"{etkilenen} kapanış kaydı sıfırlandı.", "sube_id": sube_id, "tarih": tarih}


@router.patch("/api/gorev/yoklama/{yoklama_id}/cikis-sifirla")
def yoklama_cikis_sifirla(yoklama_id: str):
    """Belirli bir yoklama kaydının cikis bilgisini sıfırlar (hata düzeltme için)."""
    with db() as (conn, cur):
        cur.execute("""
            UPDATE gorev_yoklama
            SET cikis_ts = NULL, cikis_tip = NULL
            WHERE id = %s
        """, (yoklama_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Yoklama kaydı bulunamadı")
        conn.commit()
    return {"mesaj": "Çıkış bilgisi sıfırlandı.", "yoklama_id": yoklama_id}


@router.delete("/api/gorev/yoklama/{sube_id}")
def gorev_yoklama_sil(sube_id: str, tarih: Optional[str] = None, kasa_da: bool = False, acilis_da: bool = False):
    """Şube yoklama kaydını sil (test/sıfırlama). kasa_da=true ile kasa kaydını da siler.
    acilis_da=true ile sube_acilis kaydı da silinir — şube yeniden 'açılış bekliyor' durumuna döner."""
    from tr_saat import is_gunu_tr
    t = tarih or str(is_gunu_tr())
    with db() as (conn, cur):
        cur.execute("DELETE FROM gorev_yoklama WHERE sube_id=%s AND tarih=%s", (sube_id, t))
        silinen_yoklama = cur.rowcount
        silinen_kasa = 0
        if kasa_da:
            cur.execute("DELETE FROM sube_kasa_gun_acma WHERE sube_id=%s AND tarih=%s", (sube_id, t))
            silinen_kasa = cur.rowcount
        silinen_acilis = 0
        if acilis_da:
            cur.execute("DELETE FROM sube_acilis WHERE sube_id=%s AND tarih=%s", (sube_id, t))
            silinen_acilis = cur.rowcount
        conn.commit()
    return {"silinen_yoklama": silinen_yoklama, "silinen_kasa": silinen_kasa, "silinen_acilis": silinen_acilis, "sube_id": sube_id, "tarih": t}


# ── PERSONEL VARDİYA TAKİP ───────────────────────────────────────────────────

@router.get("/api/gorev/vardiya-takip")
def vardiya_takip(yil: int, ay: int, personel_id: Optional[str] = None):
    """
    Aylık personel vardiya takip raporu.
    Her gün için: planlanan saat, çalışılan saat, gecikme, fazla mesai,
    yemek molası durumu, part-tam uyarısı.
    """
    from calendar import monthrange
    from datetime import date as _date, timedelta
    d1 = _date(yil, ay, 1)
    d2 = _date(yil, ay, monthrange(yil, ay)[1])
    # Sistem başlangıcından önce veri hesaplanmaz
    if d1 < SISTEM_BASLANGIC:
        d1 = SISTEM_BASLANGIC

    with db() as (conn, cur):
        # Personel listesi
        if personel_id:
            cur.execute("""
                SELECT id::text, ad_soyad, calisma_turu, maas, saatlik_ucret,
                       yemek_ucreti, yol_ucreti, aktif, cikis_tarihi
                FROM personel WHERE id::text=%s
            """, (personel_id,))
        else:
            cur.execute("""
                SELECT id::text, ad_soyad, calisma_turu, maas, saatlik_ucret,
                       yemek_ucreti, yol_ucreti, aktif, cikis_tarihi
                FROM personel
                ORDER BY aktif DESC, ad_soyad
            """)
        personeller = [dict(r) for r in cur.fetchall()]

        sonuclar = []
        for p in personeller:
            pid = p["id"]
            is_part = (p.get("calisma_turu") or "").lower() in ("part", "part_time", "part-time")

            # Çıkmış personel için son gün dahil, sonrasını hesaplama
            cikis = p.get("cikis_tarihi")
            if cikis and not p.get("aktif", True):
                if isinstance(cikis, str):
                    from datetime import date as _d
                    cikis = _d.fromisoformat(cikis)
                p_d2 = min(d2, cikis)  # cikis_tarihi günü dahil
            else:
                p_d2 = d2

            # Vardiya atamaları bu ay
            cur.execute("""
                SELECT va.tarih, va.baslangic_saat, va.bitis_saat,
                       vs.sube_id, s.acilis_saati AS sube_acilis,
                       EXTRACT(EPOCH FROM (
                           CASE WHEN va.bitis_saat <= va.baslangic_saat
                                THEN (va.bitis_saat::time + INTERVAL '24h') - va.baslangic_saat::time
                                ELSE va.bitis_saat::time - va.baslangic_saat::time END
                       ))/3600.0 AS planlanan_saat
                FROM vardiya_atama va
                JOIN vardiya_slot vs ON vs.id = va.slot_id
                JOIN subeler s ON s.id = vs.sube_id
                WHERE va.personel_id=%s AND va.tarih BETWEEN %s AND %s
                  AND va.durum IN ('planli','onayli')
                ORDER BY va.tarih
            """, (pid, d1, p_d2))
            vardiyalar = {str(r["tarih"]): dict(r) for r in cur.fetchall()}

            # Yoklama kayıtları (giriş saatleri)
            cur.execute("""
                SELECT tarih::text, giris_ts, vardiya_tip
                FROM gorev_yoklama
                WHERE personel_id=%s AND tarih BETWEEN %s AND %s
                ORDER BY tarih, giris_ts
            """, (pid, d1, p_d2))
            yoklamalar = {}
            for r in cur.fetchall():
                t = str(r["tarih"])
                if t not in yoklamalar:
                    yoklamalar[t] = dict(r)

            # Yemek molaları
            cur.execute("""
                SELECT tarih::text, sure_dk, ucret_hakki
                FROM yemek_molasi
                WHERE personel_id=%s AND tarih BETWEEN %s AND %s
            """, (pid, d1, p_d2))
            molalar = {str(r["tarih"]): dict(r) for r in cur.fetchall()}

            # Şube açılış gecikmeleri
            cur.execute("""
                SELECT sa.tarih::text, sa.acilis_saati, s.acilis_saati AS planlanan_acilis,
                       sa.personel_id
                FROM sube_acilis sa
                JOIN subeler s ON s.id = sa.sube_id
                WHERE sa.personel_id=%s AND sa.tarih BETWEEN %s AND %s AND sa.durum='acildi'
            """, (pid, d1, p_d2))
            acilislar = {str(r["tarih"]): dict(r) for r in cur.fetchall()}

            # Haftalık izin analizi - her Pazartesi başlayan haftayı tara
            # Kural: 7 günlük haftada HİÇ boş gün yoksa → haftalık izin kullanılmamış
            from datetime import date as _date2, timedelta as _td
            haftalik_izin_kullanilmadi = 0  # kaç haftada izin kullanılmamış
            haftalik_izin_detay = []        # [{hafta_baslangic, calisilan_gun, izin_var}]

            # Ayın ilk Pazartesisini bul (veya d1'den geriye git)
            hafta_bas = d1 - _td(days=d1.weekday())
            while hafta_bas <= d2:
                hafta_bit = hafta_bas + _td(days=6)
                # Bu haftanın ay içindeki günleri
                kontrol_bas = max(hafta_bas, d1)
                kontrol_bit = min(hafta_bit, d2)
                calisilan = 0
                gün = kontrol_bas
                while gün <= kontrol_bit:
                    if str(gün) in vardiyalar:
                        calisilan += 1
                    gün += _td(days=1)
                hafta_gun_sayisi = (kontrol_bit - kontrol_bas).days + 1
                izin_var = calisilan < hafta_gun_sayisi  # en az 1 gün boş
                if not izin_var and hafta_gun_sayisi >= 6:  # tam hafta kontrolü
                    haftalik_izin_kullanilmadi += 1
                haftalik_izin_detay.append({
                    "hafta": str(hafta_bas),
                    "calisilan_gun": calisilan,
                    "toplam_gun": hafta_gun_sayisi,
                    "izin_var": izin_var,
                })
                hafta_bas += _td(days=7)

            # Günlük analiz
            gunler = []
            toplam_planlanan = 0.0
            toplam_gecikme_dk = 0.0
            toplam_fazla_saat = 0.0
            yemek_ucret_gun = 0
            part_tam_gun = 0
            STANDART = 9.5

            tarih = d1
            while tarih <= p_d2:
                t = str(tarih)
                v = vardiyalar.get(t)
                y = yoklamalar.get(t)
                m = molalar.get(t)
                a = acilislar.get(t)

                if v:
                    planlanan = float(v["planlanan_saat"] or 0)
                    toplam_planlanan += planlanan

                    # Sistem kurulum öncesi (1-9 Haziran) - herkes tam+doğru çalışmış sayılır
                    baslangic_gunu = (tarih <= _SYSTEM_DATE(2025, 6, 9))

                    if baslangic_gunu:
                        # Tam çalışmış gibi: gecikme=0, fazla=0, yemek=hak kazanmış
                        gecikme_dk = 0.0
                        fazla = 0.0
                        part_tam = False
                        yemek_hak = not is_part  # sürekli personele yemek ücreti ver
                        if yemek_hak:
                            yemek_ucret_gun += 1
                        gunler.append({
                            "tarih": t,
                            "planlanan_saat": round(planlanan, 2),
                            "gecikme_dk": 0.0,
                            "fazla_mesai_saat": 0.0,
                            "yemek_ucret_hakki": yemek_hak,
                            "yemek_sure_dk": None,
                            "part_tam_uyari": False,
                            "giris_var": True,
                            "baslangic_gunu": True,
                        })
                    else:
                        # Normal hesaplama
                        part_tam = is_part and planlanan >= 9.4

                        # Gecikme: planlanan başlangıç vs giriş
                        gecikme_dk = 0.0
                        if y and v.get("baslangic_saat"):
                            plan_bas_str = str(v["baslangic_saat"])[:5]
                            giris_ts = y["giris_ts"]
                            if giris_ts:
                                from datetime import datetime
                                plan_h, plan_m = int(plan_bas_str[:2]), int(plan_bas_str[3:5])
                                plan_dt = datetime(tarih.year, tarih.month, tarih.day, plan_h, plan_m)
                                giris_naive = giris_ts.replace(tzinfo=None) if hasattr(giris_ts, 'replace') else giris_ts
                                fark = (giris_naive - plan_dt).total_seconds() / 60
                                gecikme_dk = max(0.0, fark)
                        toplam_gecikme_dk += gecikme_dk

                        # Fazla mesai
                        fazla = max(0.0, planlanan - STANDART)
                        toplam_fazla_saat += fazla

                        # Yemek ücreti hakkı
                        yemek_hak = False
                        if m and m.get("ucret_hakki") is True:
                            if part_tam or not is_part:
                                yemek_hak = True
                                yemek_ucret_gun += 1

                        if part_tam:
                            part_tam_gun += 1

                        gunler.append({
                            "tarih": t,
                            "planlanan_saat": round(planlanan, 2),
                            "gecikme_dk": round(gecikme_dk, 1),
                            "fazla_mesai_saat": round(fazla, 2),
                            "yemek_ucret_hakki": yemek_hak,
                            "yemek_sure_dk": float(m["sure_dk"]) if m and m.get("sure_dk") else None,
                            "part_tam_uyari": part_tam,
                            "giris_var": y is not None,
                            "baslangic_gunu": False,
                        })

                tarih += timedelta(days=1)

            yemek_ucret_tutari = yemek_ucret_gun * float(p.get("yemek_ucreti") or 0)

            # ── ÜCRET HESABI - İş Kanunu standardı (30 gün) ──────────
            GUNLUK_SAAT = 9.5
            AYLIK_GUN   = 30.0   # İş Kanunu: izin günleri dahil
            AYLIK_SAAT  = GUNLUK_SAAT * AYLIK_GUN  # 285
            is_surekli  = (p.get("calisma_turu") or "surekli") == "surekli"
            maas_taban  = float(p.get("maas") or 0)
            saatlik_ucr = float(p.get("saatlik_ucret") or 0)
            yol_ucr     = float(p.get("yol_ucreti") or 0)

            if is_surekli:
                saatlik     = maas_taban / AYLIK_SAAT if AYLIK_SAAT > 0 else 0
                gunluk      = maas_taban / AYLIK_GUN  if AYLIK_GUN  > 0 else 0
                fazla_ucret = toplam_fazla_saat * saatlik
                net_hesap   = maas_taban + fazla_ucret + yemek_ucret_tutari + yol_ucr
                ucret_detay = {
                    "taban_maas":       round(maas_taban, 2),
                    "saatlik_ucret":    round(saatlik, 2),
                    "gunluk_ucret":     round(gunluk, 2),
                    "fazla_mesai_saat": round(toplam_fazla_saat, 2),
                    "fazla_mesai_ucret":round(fazla_ucret, 2),
                    "yemek_ucret":      round(yemek_ucret_tutari, 2),
                    "yol_ucret":        round(yol_ucr, 2),
                    "net_hakediş":      round(net_hesap, 2),
                }
            else:
                # Part-time: toplam planlanan saat × saatlik ücret
                calisma_saati = toplam_planlanan
                normal_ucret  = calisma_saati * saatlik_ucr
                net_hesap     = normal_ucret + yemek_ucret_tutari + yol_ucr
                ucret_detay = {
                    "saatlik_ucret":    round(saatlik_ucr, 4),
                    "calisma_saati":    round(calisma_saati, 2),
                    "normal_ucret":     round(normal_ucret, 2),
                    "yemek_ucret":      round(yemek_ucret_tutari, 2),
                    "yol_ucret":        round(yol_ucr, 2),
                    "net_hakediş":      round(net_hesap, 2),
                    "not": "Part-time: toplam saat × saatlik ücret",
                }

            sonuclar.append({
                "personel_id": pid,
                "ad_soyad": p["ad_soyad"],
                "calisma_turu": p.get("calisma_turu"),
                "toplam_planlanan_saat": round(toplam_planlanan, 2),
                "toplam_gecikme_dk": round(toplam_gecikme_dk, 1),
                "toplam_fazla_mesai_saat": round(toplam_fazla_saat, 2),
                "yemek_ucret_gun": yemek_ucret_gun,
                "yemek_ucret_tutari": yemek_ucret_tutari,
                "part_tam_gun": part_tam_gun,
                "haftalik_izin_kullanilmadi": haftalik_izin_kullanilmadi,
                "haftalik_izin_detay": haftalik_izin_detay,
                "ucret_detay": ucret_detay,
                "net_hakediş": ucret_detay["net_hakediş"],
                "aktif": bool(p.get("aktif", True)),
                "cikis_tarihi": str(p["cikis_tarihi"]) if p.get("cikis_tarihi") else None,
                "gunler": gunler,
            })

        return {"yil": yil, "ay": ay, "personeller": sonuclar}


class GecikmeEksikGunBody(BaseModel):
    personel_id: str
    yil: int
    ay: int
    eksik_gun: float          # kaç gün sayılacak (0.5 veya 1.0)
    not_aciklama: Optional[str] = None


@router.post("/api/gorev/gecikme-eksik-gun")
def gecikme_eksik_gun_isle(body: GecikmeEksikGunBody):
    """
    Yönetici kararıyla gecikmeyi eksik gün olarak işler.
    personel_aylik tablosunu günceller, net maaş yeniden hesaplanır.
    """
    with db() as (conn, cur):
        # Personel bilgisi
        cur.execute("SELECT * FROM personel WHERE id::text=%s", (body.personel_id,))
        p = cur.fetchone()
        if not p:
            raise HTTPException(404, "Personel bulunamadı")

        # Mevcut aylık kaydı
        cur.execute("""
            SELECT * FROM personel_aylik
            WHERE personel_id=%s AND yil=%s AND ay=%s
        """, (body.personel_id, body.yil, body.ay))
        mevcut = cur.fetchone()

        if mevcut and mevcut.get("durum") == "onaylandi":
            raise HTTPException(400, "Onaylı kayıt değiştirilemez. Önce kilidi aç.")

        mevcut_eksik = float((mevcut or {}).get("eksik_gun") or 0)
        yeni_eksik   = round(mevcut_eksik + body.eksik_gun, 1)

        # Maaş yeniden hesapla
        import uuid as _uuid
        GUNLUK_SAAT = 9.5
        AYLIK_GUN   = 30.0
        AYLIK_SAAT  = GUNLUK_SAAT * AYLIK_GUN
        maas   = float(p.get("maas") or 0)
        yemek  = float(p.get("yemek_ucreti") or 0)
        yol    = float(p.get("yol_ucreti") or 0)
        gunluk = maas / AYLIK_GUN

        mevcut_dict = dict(mevcut) if mevcut else {}
        fazla  = float(mevcut_dict.get("fazla_mesai_saat") or 0)
        bayram = float(mevcut_dict.get("bayram_mesai_saat") or 0)
        saatlik = maas / AYLIK_SAAT
        net = maas - (gunluk * yeni_eksik) + (fazla * saatlik) + (bayram * saatlik * 2) + yemek + yol

        not_ekle = body.not_aciklama or f"Gecikme → {body.eksik_gun} eksik gün olarak işlendi"
        kid = str(_uuid.uuid4())
        cur.execute("""
            INSERT INTO personel_aylik
                (id, personel_id, yil, ay, calisma_saati, fazla_mesai_saat,
                 bayram_mesai_saat, eksik_gun, hesaplanan_net, not_aciklama, durum)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'taslak')
            ON CONFLICT (personel_id, yil, ay) DO UPDATE SET
                eksik_gun = %s,
                hesaplanan_net = %s,
                not_aciklama = COALESCE(personel_aylik.not_aciklama,'') || ' | ' || %s,
                durum = 'taslak'
        """, (kid, body.personel_id, body.yil, body.ay,
              float(mevcut_dict.get("calisma_saati") or 0), fazla, bayram,
              yeni_eksik, round(net, 2), not_ekle,
              yeni_eksik, round(net, 2), not_ekle))
        conn.commit()

    return {
        "basarili": True,
        "yeni_eksik_gun": yeni_eksik,
        "hesaplanan_net": round(net, 2),
        "kesinti": round(gunluk * body.eksik_gun, 2),
    }


@router.get("/api/gorev/izin-alacagi")
def izin_alacagi(personel_id: Optional[str] = None):
    """
    Birikimli haftalık izin alacağı - sistem başlangıcından (2025-06-10) bugüne.
    Verilen izin günleri (personel_izin tablosu) düşülür.
    """
    from datetime import date as _date, timedelta as _td
    from calendar import monthrange

    bugun = _date.today()
    d1 = SISTEM_BASLANGIC

    with db() as (conn, cur):
        if personel_id:
            cur.execute("""
                SELECT id::text, ad_soyad FROM personel WHERE id::text=%s
            """, (personel_id,))
        else:
            cur.execute("""
                SELECT id::text, ad_soyad FROM personel ORDER BY ad_soyad
            """)
        personeller = [dict(r) for r in cur.fetchall()]

        sonuclar = []
        for p in personeller:
            pid = p["id"]

            # Tüm vardiya atama günleri (hangi günler çalışma var)
            cur.execute("""
                SELECT DISTINCT va.tarih::text
                FROM vardiya_atama va
                JOIN vardiya_slot vs ON vs.id = va.slot_id
                WHERE va.personel_id = %s
                  AND va.tarih BETWEEN %s AND %s
                  AND va.durum IN ('planli','onayli')
            """, (pid, d1, bugun))
            calisma_gunleri = {r["tarih"] for r in cur.fetchall()}

            # Haftalık izin tarama - Pazartesi başlayan haftalar (sistem başlangıcından itibaren)
            haftalik_borclar = []
            borclu_hafta = 0
            _tarama_bas = max(d1, SISTEM_BASLANGIC)

            hafta = _tarama_bas - _td(days=_tarama_bas.weekday())
            while hafta <= bugun:
                hafta_bit = hafta + _td(days=6)
                if hafta_bit > bugun:
                    hafta_bit = bugun
                # Bu haftanın çalışma günleri
                calisilan = sum(
                    1 for i in range((hafta_bit - hafta).days + 1)
                    if str(hafta + _td(days=i)) in calisma_gunleri
                )
                toplam_gun = (hafta_bit - hafta).days + 1
                # Sistem başlangıç haftasını borçlu sayma - o hafta temiz başlangıç
                baslangic_haftasi = (hafta <= SISTEM_BASLANGIC <= hafta + _td(days=6))
                # Tam hafta (6+ gün) ve hiç boş gün yoksa borç
                if not baslangic_haftasi and toplam_gun >= 6 and calisilan >= toplam_gun:
                    borclu_hafta += 1
                    haftalik_borclar.append({
                        "hafta": str(hafta),
                        "calisilan": calisilan,
                        "toplam": toplam_gun,
                    })
                hafta += _td(days=7)

            # Verilen izin günleri (personel_izin tablosu, tüm tipler haftalık izin hesabında sayılır)
            cur.execute("""
                SELECT baslangic_tarih, bitis_tarih,
                       COALESCE(gun_kesri, 1.0) AS gun_kesri, tip
                FROM personel_izin
                WHERE personel_id = %s
                  AND baslangic_tarih >= %s AND baslangic_tarih <= %s
                ORDER BY baslangic_tarih
            """, (pid, SISTEM_BASLANGIC, bugun))
            izinler = [dict(r) for r in cur.fetchall()]

            # Verilen toplam izin günü (gün kesrini dikkate alarak)
            verilen_izin_gun = 0.0
            for iz in izinler:
                bas = iz["baslangic_tarih"]
                bit = iz["bitis_tarih"]
                gun_sayisi = (bit - bas).days + 1
                # gun_kesri tek günlük izinlerde 0.5 olabilir
                if gun_sayisi == 1:
                    verilen_izin_gun += float(iz["gun_kesri"])
                else:
                    verilen_izin_gun += gun_sayisi  # çok günlük izinde tam gün sayılır

            net_alacak = max(0.0, borclu_hafta - verilen_izin_gun)

            sonuclar.append({
                "personel_id": pid,
                "ad_soyad": p["ad_soyad"],
                "borclu_hafta_sayisi": borclu_hafta,
                "verilen_izin_gun": round(verilen_izin_gun, 1),
                "net_alacak_gun": round(net_alacak, 1),
                "izinler": [
                    {
                        "tarih": str(iz["baslangic_tarih"]),
                        "gun": float(iz["gun_kesri"]) if (iz["bitis_tarih"] - iz["baslangic_tarih"]).days == 0
                               else (iz["bitis_tarih"] - iz["baslangic_tarih"]).days + 1,
                        "tip": iz["tip"],
                    } for iz in izinler
                ],
                "borclu_haftalar": haftalik_borclar[-12:],  # son 12 hafta
            })

        return {
            "baslangic": str(d1),
            "bitis": str(bugun),
            "personeller": sonuclar,
        }


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
