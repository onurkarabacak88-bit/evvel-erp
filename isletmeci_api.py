# -*- coding: utf-8 -*-
"""
İŞLETMECİ TANIMI — şahsi harcamanın SAHİBİ.

Sahip (2026-08-10): "şahsi harcamaları Onur Karabacak, Fethi Karabacak ve Fatma
Karabacak olarak ayrışmasını sağlamalıyız ama burada isim isim ekleme, yani
işletmeci tanımlarını kurmalıyız — aynı kasa teslimde kullanılan desen gibi!"

NEDEN: 'şahsi' TEK KOVAYDI. Canlıda 275 kayıt / 549.628 ₺ "şahsi" diye ayrılmış
ama KİMİN olduğu hiçbir yerde yazmıyordu. Ortaklar arası hesaplaşma da,
"bu ay kim ne harcadı" sorusu da cevapsızdı.

DESEN (kasa_teslim_alici ile birebir):
  1. Tanım tablosu + CRUD; silme YOK, pasife çekme var (geçmiş kaybolmaz).
  2. Harekette hem `_id` hem `_ad` durur. Ad'ın kopyalanması bilinçlidir
     ("kar tanesi"): kişi kaydı düzeltilse/pasife çekilse bile geçmiş hareket
     kimin olduğunu söylemeye devam eder.
  3. İsimler KODA GÖMÜLMEZ — tohum mevcut kart sahiplerinden türer (database.
     ensure_isletmeci), gerisi bu uçlardan yönetilir.

SINIR: bu modül yalnız KİMLİK tutar. Harcamanın şahsi olup olmadığına
`kart_hareketleri.harcama_tipi` karar verir; burası "şahsiyse kimin?" sorusunu
cevaplar. Vergi hesabına dokunmaz (şahsi zaten matrahtan düşülmez).
"""

import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db

router = APIRouter()


class IsletmeciBody(BaseModel):
    ad: str
    unvan: str = ""


def _satir(r) -> dict:
    d = dict(r)
    if d.get("olusturma"):
        d["olusturma"] = str(d["olusturma"])
    return d


@router.get("/api/isletmeci")
def isletmeci_liste(aktif: bool = True, harcama: bool = True):
    """İşletmeci listesi. harcama=True ise her kişinin şahsi harcama yükü de gelir
    (kayıt sayısı + tutar) — ekran ayrı bir uca gitmeden kırılımı gösterebilsin."""
    with db() as (conn, cur):
        cur.execute("SELECT * FROM isletmeci WHERE (%s IS FALSE OR aktif=TRUE) ORDER BY ad", (aktif,))
        kisiler = [_satir(r) for r in (cur.fetchall() or [])]
        if harcama and kisiler:
            cur.execute(
                """
                SELECT sahsi_isletmeci_id AS kid,
                       COUNT(*)                          AS adet,
                       COALESCE(SUM(ABS(tutar)), 0)      AS tutar,
                       MAX(tarih)                        AS son_tarih
                  FROM kart_hareketleri
                 WHERE COALESCE(harcama_tipi,'belirsiz') = 'sahsi'
                   AND sahsi_isletmeci_id IS NOT NULL
                   AND COALESCE(durum,'aktif') = 'aktif'
                 GROUP BY sahsi_isletmeci_id
                """
            )
            yuk = {str(r["kid"]): r for r in (cur.fetchall() or [])}
            for k in kisiler:
                y = yuk.get(str(k["id"]))
                k["sahsi_adet"] = int((y or {}).get("adet") or 0)
                k["sahsi_tutar"] = round(float((y or {}).get("tutar") or 0), 2)
                k["son_harcama"] = str((y or {}).get("son_tarih") or "") or None
        # Kaç kart bu kişiye bağlı?
        cur.execute(
            "SELECT sahip_isletmeci_id AS kid, COUNT(*) AS adet FROM kartlar "
            "WHERE aktif=TRUE AND sahip_isletmeci_id IS NOT NULL GROUP BY sahip_isletmeci_id"
        )
        kart_adet = {str(r["kid"]): int(r["adet"]) for r in (cur.fetchall() or [])}
        for k in kisiler:
            k["kart_adet"] = kart_adet.get(str(k["id"]), 0)
    return {"isletmeciler": kisiler, "adet": len(kisiler)}


@router.post("/api/isletmeci")
def isletmeci_ekle(body: IsletmeciBody):
    ad = (body.ad or "").strip()
    if len(ad) < 2:
        raise HTTPException(400, "Ad en az 2 karakter olmalı")
    with db() as (conn, cur):
        # ⚠️ Kimlik NORMALİZE anahtar üzerinden kurulur, ad'ın kendisiyle DEĞİL.
        # lower(ad) yetmiyordu: "Fethi̇" (i + U+0307 kombine nokta) ile "Fethi"
        # ekranda aynı görünür ama lower() eşitlemez — canlıda iki ayrı
        # "Fethi Karabacak" kaydı doğmuştu. isletmeci_ad_anahtar() tek kapıdır.
        cur.execute("SELECT id, aktif FROM isletmeci WHERE ad_anahtar=isletmeci_ad_anahtar(%s)", (ad,))
        var = cur.fetchone()
        if var:
            if not var["aktif"]:
                # Pasife çekilmiş kişi yeniden eklenmek isteniyor → dirilt
                cur.execute("UPDATE isletmeci SET aktif=TRUE, unvan=COALESCE(NULLIF(%s,''), unvan) WHERE id=%s",
                            ((body.unvan or "").strip(), var["id"]))
                return {"success": True, "id": var["id"], "yeniden_aktif": True}
            raise HTTPException(400, f"'{ad}' zaten tanımlı")
        kid = str(uuid.uuid4())
        cur.execute(
            "INSERT INTO isletmeci (id, ad, ad_anahtar, unvan) "
            "VALUES (%s,%s,isletmeci_ad_anahtar(%s),%s)",
            (kid, ad, ad, (body.unvan or "").strip() or None))
    return {"success": True, "id": kid}


@router.put("/api/isletmeci/{kid}")
def isletmeci_guncelle(kid: str, body: IsletmeciBody):
    ad = (body.ad or "").strip()
    if len(ad) < 2:
        raise HTTPException(400, "Ad en az 2 karakter olmalı")
    with db() as (conn, cur):
        cur.execute("SELECT id FROM isletmeci WHERE ad_anahtar=isletmeci_ad_anahtar(%s) "
                    "AND id<>%s AND aktif=TRUE", (ad, kid))
        if cur.fetchone():
            raise HTTPException(400, f"'{ad}' başka bir kayıtta zaten tanımlı")
        cur.execute("UPDATE isletmeci SET ad=%s, ad_anahtar=isletmeci_ad_anahtar(%s), unvan=%s "
                    "WHERE id=%s", (ad, ad, (body.unvan or "").strip() or None, kid))
        if cur.rowcount == 0:
            raise HTTPException(404, "Kayıt bulunamadı")
        # Geçmiş hareketlerdeki AD kopyası da tazelenir — isim düzeltmesi
        # eski kayıtları eski adla bırakmasın (id bağı zaten sağlam).
        cur.execute("UPDATE kart_hareketleri SET sahsi_isletmeci_ad=%s WHERE sahsi_isletmeci_id=%s", (ad, kid))
        cur.execute("UPDATE kartlar SET sahip=%s WHERE sahip_isletmeci_id=%s", (ad, kid))
    return {"success": True}


@router.delete("/api/isletmeci/{kid}")
def isletmeci_sil(kid: str):
    """Pasife çeker — SİLMEZ. Geçmiş harcamalar kime ait olduğunu söylemeye devam eder."""
    with db() as (conn, cur):
        cur.execute(
            "SELECT COUNT(*) AS adet FROM kart_hareketleri "
            "WHERE sahsi_isletmeci_id=%s AND COALESCE(durum,'aktif')='aktif'", (kid,))
        bagli = int((cur.fetchone() or {}).get("adet") or 0)
        cur.execute("UPDATE isletmeci SET aktif=FALSE WHERE id=%s", (kid,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Kayıt bulunamadı")
    return {"success": True, "pasife_alindi": True, "bagli_harcama_adet": bagli,
            "mesaj": ("Kişi pasife alındı. Geçmiş harcamalar silinmedi — "
                      f"{bagli} kayıt hâlâ bu kişiye bağlı görünür.")}


# ── ŞAHSİ HARCAMA → KİŞİ ATAMASI ─────────────────────────────────────────────

class SahsiAtaBody(BaseModel):
    hareket_idler: list
    isletmeci_id: Optional[str] = None   # None = atamayı kaldır


@router.post("/api/isletmeci/sahsi-ata")
def sahsi_harcama_ata(body: SahsiAtaBody):
    """Seçili şahsi harcamaları bir kişiye bağlar (veya bağı kaldırır).

    Yalnız harcama_tipi='sahsi' satırlara dokunur — işletme harcamasının sahibi
    işletmedir, kişiye yazılmaz.
    """
    idler = [str(x) for x in (body.hareket_idler or []) if str(x).strip()]
    if not idler:
        raise HTTPException(400, "hareket_idler boş")
    with db() as (conn, cur):
        ad = None
        if body.isletmeci_id:
            cur.execute("SELECT ad FROM isletmeci WHERE id=%s", (body.isletmeci_id,))
            r = cur.fetchone()
            if not r:
                raise HTTPException(404, "İşletmeci bulunamadı")
            ad = r["ad"]
        cur.execute(
            """UPDATE kart_hareketleri
                  SET sahsi_isletmeci_id=%s, sahsi_isletmeci_ad=%s
                WHERE id = ANY(%s)
                  AND COALESCE(harcama_tipi,'belirsiz')='sahsi'""",
            (body.isletmeci_id, ad, idler),
        )
        yazilan = cur.rowcount
    return {"success": True, "guncellenen": yazilan, "atlanan": len(idler) - yazilan,
            "isletmeci": ad,
            "mesaj": (f"{yazilan} şahsi harcama {ad or '(atama kaldırıldı)'} kaydına bağlandı."
                      + (f" {len(idler) - yazilan} satır şahsi olmadığı için atlandı."
                         if len(idler) - yazilan else ""))}


@router.post("/api/isletmeci/kart-sahibinden-doldur")
def kart_sahibinden_doldur(kuru: bool = True):
    """Sahipsiz şahsi harcamaları KARTIN SAHİBİNE bağlar (öneri-only toplu işlem).

    Gerekçe: bir kişinin kendi kartından yaptığı şahsi harcama, aksi söylenmedikçe
    o kişinindir. Aksi durum (birinin başkasının kartını kullanması) satır bazında
    düzeltilir — bu yüzden kuru=True VARSAYILAN, önce ne olacağı gösterilir.
    """
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT k.sahip_isletmeci_id AS kid, i.ad AS kisi, COUNT(*) AS adet,
                   COALESCE(SUM(ABS(h.tutar)),0) AS tutar
              FROM kart_hareketleri h
              JOIN kartlar k   ON k.id = h.kart_id
              JOIN isletmeci i ON i.id = k.sahip_isletmeci_id
             WHERE COALESCE(h.harcama_tipi,'belirsiz')='sahsi'
               AND h.sahsi_isletmeci_id IS NULL
               AND COALESCE(h.durum,'aktif')='aktif'
             GROUP BY k.sahip_isletmeci_id, i.ad
             ORDER BY 4 DESC
            """
        )
        plan = [{"isletmeci_id": str(r["kid"]), "kisi": r["kisi"],
                 "adet": int(r["adet"]), "tutar": round(float(r["tutar"]), 2)}
                for r in (cur.fetchall() or [])]
        # Kartı bir kişiye bağlı OLMAYAN şahsi harcamalar — elle karar ister
        cur.execute(
            """
            SELECT COUNT(*) AS adet, COALESCE(SUM(ABS(h.tutar)),0) AS tutar
              FROM kart_hareketleri h
              JOIN kartlar k ON k.id = h.kart_id
             WHERE COALESCE(h.harcama_tipi,'belirsiz')='sahsi'
               AND h.sahsi_isletmeci_id IS NULL
               AND k.sahip_isletmeci_id IS NULL
               AND COALESCE(h.durum,'aktif')='aktif'
            """
        )
        _k = cur.fetchone() or {}
        kalan = {"adet": int(_k.get("adet") or 0), "tutar": round(float(_k.get("tutar") or 0), 2)}
        if kuru:
            return {"kuru": True, "plan": plan,
                    "toplam_adet": sum(p["adet"] for p in plan),
                    "toplam_tutar": round(sum(p["tutar"] for p in plan), 2),
                    "kart_sahibi_tanimsiz": kalan,
                    "mesaj": ("PROVA — hiçbir kayıt değişmedi. Uygulamak için kuru=false gönderin."
                              + (f" {kalan['adet']} harcama kartın sahibi tanımsız olduğu için "
                                 "eşleşmedi; o kartlara önce sahip atayın." if kalan["adet"] else ""))}
        cur.execute(
            """
            UPDATE kart_hareketleri h
               SET sahsi_isletmeci_id = k.sahip_isletmeci_id,
                   sahsi_isletmeci_ad = i.ad
              FROM kartlar k
              JOIN isletmeci i ON i.id = k.sahip_isletmeci_id
             WHERE h.kart_id = k.id
               AND COALESCE(h.harcama_tipi,'belirsiz')='sahsi'
               AND h.sahsi_isletmeci_id IS NULL
               AND COALESCE(h.durum,'aktif')='aktif'
            """
        )
        yazilan = cur.rowcount
    return {"success": True, "kuru": False, "guncellenen": yazilan, "plan": plan,
            "kart_sahibi_tanimsiz": kalan,
            "mesaj": f"{yazilan} şahsi harcama kart sahibine bağlandı."}


@router.get("/api/isletmeci/sahsi-kirilim")
def sahsi_kirilim(gun: int = 365):
    """Şahsi harcamanın KİŞİ kırılımı + hangi karttan + atanmamış yığın.

    'Şahsi' tek kova olduğu sürece ortaklar arası hesaplaşma yapılamıyordu;
    bu uç o kovayı kişilere böler. Salt-okur.
    """
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT COALESCE(h.sahsi_isletmeci_ad, i.ad)      AS kisi,
                   h.sahsi_isletmeci_id                       AS kisi_id,
                   k.kart_adi                                 AS kart,
                   COUNT(*)                                   AS adet,
                   COALESCE(SUM(ABS(h.tutar)),0)              AS tutar
              FROM kart_hareketleri h
              LEFT JOIN kartlar k   ON k.id = h.kart_id
              LEFT JOIN isletmeci i ON i.id = h.sahsi_isletmeci_id
             WHERE COALESCE(h.harcama_tipi,'belirsiz')='sahsi'
               AND COALESCE(h.durum,'aktif')='aktif'
               AND h.tarih >= (CURRENT_DATE - (%s || ' days')::interval)
             GROUP BY 1,2,3
             ORDER BY 5 DESC
            """,
            (int(gun),),
        )
        ham = [dict(r) for r in (cur.fetchall() or [])]

    kisiler: dict = {}
    atanmamis = {"adet": 0, "tutar": 0.0, "kartlar": []}
    for r in ham:
        adet, tutar = int(r["adet"]), round(float(r["tutar"]), 2)
        if not r.get("kisi_id"):
            atanmamis["adet"] += adet
            atanmamis["tutar"] = round(atanmamis["tutar"] + tutar, 2)
            atanmamis["kartlar"].append({"kart": r.get("kart"), "adet": adet, "tutar": tutar})
            continue
        k = kisiler.setdefault(str(r["kisi_id"]),
                               {"kisi_id": str(r["kisi_id"]), "kisi": r["kisi"],
                                "adet": 0, "tutar": 0.0, "kartlar": []})
        k["adet"] += adet
        k["tutar"] = round(k["tutar"] + tutar, 2)
        k["kartlar"].append({"kart": r.get("kart"), "adet": adet, "tutar": tutar})

    liste = sorted(kisiler.values(), key=lambda x: -x["tutar"])
    toplam = round(sum(x["tutar"] for x in liste) + atanmamis["tutar"], 2)
    return {
        "gun": int(gun),
        "kisiler": liste,
        "atanmamis": atanmamis,
        "toplam_sahsi_tutar": toplam,
        "toplam_sahsi_adet": sum(x["adet"] for x in liste) + atanmamis["adet"],
        "kapsama_orani": round((toplam - atanmamis["tutar"]) / toplam * 100, 1) if toplam else 0.0,
    }
