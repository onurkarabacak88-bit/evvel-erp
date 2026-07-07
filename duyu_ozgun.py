"""
ÖZGÜN KURGU DUYULARI — işletmenin kendi ruhundan doğanlar (2026-07-06)

5-YZ turu genel perakende klasiklerini verdi; bu üçü İŞLETMEYE ÖZGÜ boşluklardan doğdu
(tasarımcı-şapka turu, veri temeli keşif-doğrulamalı):

  1) VARDİYA PLAN-GERÇEK SAPMASI: bu sistemde ÜCRET PLANLANAN saatten hesaplanır —
     plan ile mühür (operasyon event) arasındaki sapma sessiz para sızıntısıdır.
     KİMLİKSİZ: şube-gün toplamı (kişi-saat + uç saat sapmaları); kişi yok.
  2) MENÜ FİYAT DEĞİŞİM İZİ: tv_menu güncellemesi eskiyi ezer, tarih tutmaz.
     Değişim OLAY olur → zımni-fiyat sapmalarının doğal açıklayıcısı (sarmal hammaddesi).
  3) BİLDİRİM İLETİM DUYUSU: sistem artık konuşuyor (WhatsApp) ama gönderim sonuçları
     kaydedilmiyordu — sesi kısılırsa (466 kota) kimse bilmezdi. Sistemin kendi sesinin
     sağlığı: nabız her gönderimde, olay yalnız İLETİM HATASINDA.

Sözleşme: izole modül · idempotent omurga olayları · hata-yutar · kimlik yok · Sv0.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

from fastapi import APIRouter, Query

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/duyu", tags=["duyu-ozgun"])


# ── 1) VARDİYA PLAN-GERÇEK SAPMASI ───────────────────────────────────────────
def _plan_gercek_hesapla(cur, gun: date) -> list:
    """Şube-gün: plan (vardiya_atama toplam kişi-saat + planlı ilk açılış / son kapanış)
    ↔ gerçek (operasyon event ilk ACILIS / son KAPANIS cevabı). KİMLİKSİZ toplamlar."""
    cur.execute(
        """
        WITH plan AS (
            SELECT vs.sube_id,
                   COUNT(*)::int AS atama_n,
                   ROUND(SUM(
                       EXTRACT(EPOCH FROM (va.bitis_saat - va.baslangic_saat)) / 3600.0
                       + CASE WHEN va.gece_vardiyasi THEN 24 ELSE 0 END
                   )::numeric, 1) AS plan_kisi_saat,
                   MIN(va.baslangic_saat)::text AS plan_ilk_baslangic,
                   MAX(va.bitis_saat)::text AS plan_son_bitis
            FROM vardiya_atama va JOIN vardiya_slot vs ON vs.id = va.slot_id
            WHERE va.tarih = %s AND va.durum <> 'iptal'
            GROUP BY vs.sube_id
        ),
        gercek AS (
            SELECT sube_id,
                   MIN(cevap_ts) FILTER (WHERE tip = 'ACILIS')::text AS gercek_acilis,
                   MAX(cevap_ts) FILTER (WHERE tip = 'KAPANIS')::text AS gercek_kapanis
            FROM sube_operasyon_event
            WHERE tarih = %s AND cevap_ts IS NOT NULL
            GROUP BY sube_id
        )
        SELECT s.ad AS sube_ad, p.sube_id, p.atama_n, p.plan_kisi_saat,
               p.plan_ilk_baslangic, p.plan_son_bitis,
               g.gercek_acilis, g.gercek_kapanis,
               CASE WHEN g.gercek_acilis IS NOT NULL THEN
                   ROUND((EXTRACT(EPOCH FROM (g.gercek_acilis::timestamp
                        - (%s::date + p.plan_ilk_baslangic::time))) / 60.0)::numeric, 0)
               END AS acilis_sapma_dk
        FROM plan p
        JOIN subeler s ON s.id = p.sube_id
        LEFT JOIN gercek g ON g.sube_id = p.sube_id
        """,
        (str(gun), str(gun), str(gun)),
    )
    return [dict(r) for r in (cur.fetchall() or [])]


def gece_vardiya_plan_gercek() -> None:
    """GECE: dünün şube-gün plan↔gerçek kesiti → omurga. Ücret planlanan saatten
    hesaplandığı için plan_kisi_saat aynı zamanda MALİYET tabanıdır (ham kayıt)."""
    from duyu_omurga import duyu_nabiz_yaz, duyu_olay_yaz
    try:
        dun = date.today() - timedelta(days=1)
        with db() as (_, cur):
            satirlar = _plan_gercek_hesapla(cur, dun)
        for s in satirlar:
            duyu_olay_yaz(
                "vardiya_plan_gercek", "operasyon.vardiya.plan_gercek_kesiti",
                f"{s['sube_id']}_{dun}",
                entity_scope="sube", entity_id=str(s["sube_id"]), occurred_at=str(dun),
                signal_name="Vardiya plan↔gerçek kesiti",
                payload={k: s.get(k) for k in ("sube_ad", "atama_n", "plan_kisi_saat",
                                               "plan_ilk_baslangic", "plan_son_bitis",
                                               "gercek_acilis", "gercek_kapanis",
                                               "acilis_sapma_dk")},
            )
        duyu_nabiz_yaz("vardiya_plan_gercek", taranan=len(satirlar), uretilen=len(satirlar))
    except Exception as e:  # noqa: BLE001
        logger.warning("gece vardiya plan-gercek yutuldu: %s", str(e)[:120])
        duyu_nabiz_yaz("vardiya_plan_gercek", durum="hata", yutulan_hata=1,
                       not_metin=str(e)[:200])


# ── 2) MENÜ FİYAT DEĞİŞİM İZİ (olay güdümlü — tv_menu_api kancasından) ───────
def fiyat_degisim_kaydet(urun_ad: str, kolon: str, eski, yeni, kaynak: str) -> None:
    """tv_menu güncelleme kancası: fiyat kolonu DEĞİŞTİYSE omurgaya olay.
    Hata-yutar — menü güncellemesi bu iz yüzünden asla çökmez. Zımni-fiyat sapmalarının
    doğal açıklayıcısı: 'fiyat dün değişti → sapma ondandır' sarmalının hammaddesi."""
    try:
        from duyu_omurga import duyu_nabiz_yaz, duyu_olay_yaz
        e = float(eski) if eski is not None else None
        y = float(yeni) if yeni is not None else None
        if e == y:
            return
        bugun = date.today()
        duyu_olay_yaz(
            "menu_fiyat_izi", "fiyat.menu.degisim",
            f"{urun_ad}_{kolon}_{bugun}",
            entity_scope="kalem", entity_id=str(urun_ad), occurred_at=str(bugun),
            signal_name="Menü fiyat değişimi",
            payload={"kolon": kolon, "eski": e, "yeni": y, "kaynak": kaynak},
        )
        duyu_nabiz_yaz("menu_fiyat_izi", taranan=1, uretilen=1)
    except Exception as ex:  # noqa: BLE001
        logger.warning("fiyat degisim izi yutuldu: %s", str(ex)[:100])


# ── 3) BİLDİRİM İLETİM DUYUSU (olay güdümlü — whatsapp_bildirim kancasından) ─
def bildirim_sonuc_kaydet(kanal: str, basarili: bool, hata: str | None = None) -> None:
    """Her gönderim denemesinde nabız; yalnız HATADA olay (spam yok, sessizlik≠sağlık
    burada geçerli değil — gönderim İSTEĞİ oldu, sonucu ölçüyoruz). Hata-yutar."""
    try:
        from duyu_omurga import duyu_nabiz_yaz, duyu_olay_yaz
        duyu_nabiz_yaz("bildirim_iletim", durum="basari" if basarili else "hata",
                       taranan=1, uretilen=0 if basarili else 1,
                       yutulan_hata=0 if basarili else 1,
                       not_metin=None if basarili else (hata or "iletim hatasi")[:150])
        if not basarili:
            bugun = date.today()
            duyu_olay_yaz(
                "bildirim_iletim", "iletisim.mesaj.gonderim_hatasi",
                f"{kanal}_{bugun}",  # gün başına kanal başına tek olay (furya spam'i yok)
                entity_scope="genel", occurred_at=str(bugun),
                signal_name="Bildirim iletilemedi",
                payload={"kanal": kanal, "hata": (hata or "")[:200]},
            )
    except Exception as ex:  # noqa: BLE001
        logger.warning("bildirim iletim izi yutuldu: %s", str(ex)[:100])


def gece_ozgun_calistir() -> None:
    """Gece zinciri girişi — yalnız zamanlı olan (plan-gerçek) koşar;
    fiyat izi ve iletim duyusu olay-güdümlüdür (kancalardan beslenir)."""
    gece_vardiya_plan_gercek()


# ── İŞLETME GÜNLÜĞÜ (beynin İLK VERİ DİLEĞİ — kullanıcı onayı 2026-07-07) ────
# Beyin "ciro neden arttı?" sorusunda "kampanya/müşteri trafiği verisi toplanmalı"
# dileği yazdı; sahip onayladı. Elle girilen bağlam notları: kampanya, etkinlik,
# özel gün, hava... Ciro-neden sorularının AÇIKLAYICI hammaddesi (kanıt değil bağlam).
from pydantic import BaseModel  # noqa: E402

_GUNLUK_TIPLERI = ("kampanya", "etkinlik", "ozel_gun", "hava", "tadilat", "diger")


def _gunluk_ensure(cur) -> None:
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS isletme_gunlugu (
            id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            tarih      DATE NOT NULL,
            sube_id    TEXT,                -- NULL = tüm işletme
            tip        TEXT NOT NULL,
            baslik     TEXT NOT NULL,
            aciklama   TEXT,
            olusturma  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    cur.execute("CREATE INDEX IF NOT EXISTS idx_isletme_gunlugu ON isletme_gunlugu (tarih DESC)")


class GunlukNotBody(BaseModel):
    tarih: str | None = None   # YYYY-MM-DD; boş = bugün
    sube_id: str | None = None
    tip: str = "kampanya"
    baslik: str
    aciklama: str | None = None


@router.post("/gunluk-not")
def gunluk_not_ekle(body: GunlukNotBody):
    """Elle bağlam notu: 'bugün kampanya vardı' gibi. Beyin neden-sorularında görür."""
    baslik = (body.baslik or "").strip()
    if len(baslik) < 3:
        return {"ok": False, "hata": "başlık en az 3 karakter"}
    tip = body.tip if body.tip in _GUNLUK_TIPLERI else "diger"
    tarih = (body.tarih or "").strip() or str(date.today())
    with db() as (_, cur):
        _gunluk_ensure(cur)
        cur.execute(
            """INSERT INTO isletme_gunlugu (tarih, sube_id, tip, baslik, aciklama)
               VALUES (%s,%s,%s,%s,%s) RETURNING id""",
            (tarih, (body.sube_id or None), tip, baslik[:120],
             (body.aciklama or "")[:400] or None),
        )
        nid = dict(cur.fetchone() or {}).get("id")
    # Omurgaya bağlam olayı (hata-yutar) — sarmal/kompozit hammaddesi
    try:
        from duyu_omurga import duyu_nabiz_yaz, duyu_olay_yaz
        duyu_olay_yaz(
            "isletme_gunlugu", "baglam.not.girildi", str(nid),
            entity_scope="sube" if body.sube_id else "genel",
            entity_id=body.sube_id, occurred_at=tarih,
            signal_name="İşletme günlüğü notu",
            payload={"tip": tip, "baslik": baslik[:120]},
        )
        duyu_nabiz_yaz("isletme_gunlugu", taranan=1, uretilen=1)
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "id": nid, "tarih": tarih, "tip": tip}


@router.get("/gunluk-notlar")
def gunluk_notlar(gun: int = Query(30, ge=1, le=120)):
    with db() as (_, cur):
        _gunluk_ensure(cur)
        cur.execute(
            """SELECT g.id, g.tarih::text, s.ad AS sube_ad, g.tip, g.baslik, g.aciklama
               FROM isletme_gunlugu g LEFT JOIN subeler s ON s.id = g.sube_id
               WHERE g.tarih >= %s ORDER BY g.tarih DESC, g.olusturma DESC LIMIT 100""",
            (str(date.today() - timedelta(days=gun - 1)),),
        )
        return {"notlar": [dict(r) for r in (cur.fetchall() or [])],
                "tipler": list(_GUNLUK_TIPLERI)}


# ── SALT-OKUR UÇ ─────────────────────────────────────────────────────────────
@router.get("/ozgun-duyular")
def ozgun_duyular(gun: int = Query(7, ge=1, le=30)):
    """Üç özgün duyunun kesiti: plan-gerçek (canlı, dün) + son fiyat değişimleri +
    son iletim hataları (omurgadan)."""
    dun = date.today() - timedelta(days=1)
    bas = date.today() - timedelta(days=gun - 1)
    with db() as (_, cur):
        try:
            plan_gercek = _plan_gercek_hesapla(cur, dun)
        except Exception as e:  # noqa: BLE001
            plan_gercek = []
            logger.warning("ozgun plan-gercek atlandi: %s", str(e)[:100])
        cur.execute(
            """
            SELECT duyu, olay_tipi, entity_id, occurred_at::text, payload_json
            FROM duyu_olay
            WHERE duyu IN ('menu_fiyat_izi', 'bildirim_iletim')
              AND observed_at >= %s
            ORDER BY observed_at DESC LIMIT 40
            """,
            (str(bas),),
        )
        olaylar = [dict(r) for r in (cur.fetchall() or [])]
    return {
        "plan_gercek_dun": plan_gercek,
        "fiyat_degisimleri": [o for o in olaylar if o["duyu"] == "menu_fiyat_izi"],
        "iletim_hatalari": [o for o in olaylar if o["duyu"] == "bildirim_iletim"],
        "not": "Sv0 ham — plan sapması mesai gerçeğidir hüküm değil; fiyat değişimi "
               "meşru karardır (izi sarmalı besler); iletim hatası kota/ağ olabilir.",
    }
