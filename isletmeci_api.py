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

import re
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
        # ŞEMA DENETİMİ — migration startup'ta try/except içinde çağrılıyor; bir
        # SQL sürüm farkı yüzünden düşerse hata YUTULUYOR ve ekran hiçbir şey
        # olmamış gibi liste basıyordu (canlıda tam bu oldu: ad_anahtar kolonu
        # hiç eklenmedi, mükerrer "Fethi Karabacak" kayıtları birleşmedi).
        # Eksiklik artık yanıtta GÖRÜNÜR — sessiz bozukluk kalmaz.
        cur.execute(
            "SELECT COUNT(*) AS var FROM information_schema.columns "
            "WHERE table_name='isletmeci' AND column_name='ad_anahtar'")
        _sema_tam = int((cur.fetchone() or {}).get("var") or 0) > 0

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
    return {"isletmeciler": kisiler, "adet": len(kisiler),
            "sema_tam": _sema_tam,
            "sema_notu": (None if _sema_tam else
                          "Kimlik normalleştirme kolonu (ad_anahtar) yok — migration "
                          "çalışmamış. Aynı kişi birden çok kez görünebilir.")}


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


def _sade(s) -> str:
    """Türkçe-duyarsız sadeleştirme (bu modül içi; _satici_anahtar ile aynı ruh)."""
    x = str(s or "")
    for a_, b_ in zip("çğıöşüÇĞİıÖŞÜâîû", "cgiosuCGIIOSUaiu"):
        x = x.replace(a_, b_)
    return re.sub(r"[^A-Z0-9]+", " ", x.upper()).strip()


# main._SATICI_ATIL'ın birebir kopyası (kopya bilinçli — import döngüsü riski).
# 🔴 P1 (2026-08-14, EVV-KART / Codex): eski kopya bu listeyi TAŞIMIYORDU —
# "KONYA SU" ile "KONYA KENTPLAZA" aynı 'KONYA' grubuna düşüyor, birine yapılan
# kişi ataması öğrenilip alakasız Konya satıcılarına öneriliyordu (para-eşleştirme
# dersi: şehir adı gürültüsü). İki modülün kuralı DEĞİŞİRSE BİRLİKTE değişmeli.
_SATICI_ATIL = {
    "KONYA", "ISTANBUL", "İSTANBUL", "IZMIR", "İZMİR", "ANKARA", "KARAMAN",
    "BURSA", "ANTALYA", "ADANA", "MERSIN", "MERSİN", "TR", "TUR", "TURKIYE",
    "FATURA", "ODEME", "ÖDEME", "OTOMATIK", "OTOMATİK", "TALIMAT", "TALİMAT",
    "SAN", "TIC", "TİC", "LTD", "STI", "ŞTI", "AS", "A.S", "ANONIM", "ANONİM",
    "SIRKETI", "ŞİRKETİ", "LIMITED", "LİMİTED", "MERKEZ", "SUBE", "ŞUBE",
}


def _satici_anahtar(aciklama):
    """Açıklamadan satıcı anahtarı — main._satici_anahtar ile AYNI kural
    ('METRO METRO GROSMARKET KOKONYA TR' → 'METRO'). Şehir/jenerik kelimeler
    atlanır; hepsi atılırsa ilk kelimeye düşülür."""
    import re as _re
    s = (aciklama or "").upper().strip()
    s = _re.sub(r"[^A-ZÇĞİÖŞÜ0-9 ]", " ", s)
    ilk = None
    for tok in s.split():
        if len(tok) < 3 or tok.isdigit():
            continue
        if ilk is None:
            ilk = tok
        if tok not in _SATICI_ATIL:
            return tok
    return ilk


@router.get("/api/isletmeci/sahsi-bekleyen")
def sahsi_bekleyen(limit: int = 400):
    """Sahibi atanmamış şahsi harcamalar — SATICIYA göre gruplanmış + öneri.

    ⚠️ KART SAHİBİNDEN OTOMATİK ATAMA YOK (sahip kararı 2026-08-10: "kartların
    direkt atama mantığında kurgulama — aynı kartı bazen 3 kişinin şahsi
    harcamasına uygulanabilir"). Kart hamili ≠ harcamayı yapan kişi.
    Kart adı yalnız İPUCU olarak taşınır, atama sebebi değildir.

    Öneri kaynağı satıcı hafızasıdır (sahsi_kisi_kural): sahip bir kez
    "TRENDYOL → Fatma" dediyse sonraki TRENDYOL satırları önerilir — yazılmaz.
    """
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT h.id, h.tarih, h.aciklama, ABS(h.tutar) AS tutar, k.kart_adi
              FROM kart_hareketleri h
              LEFT JOIN kartlar k ON k.id = h.kart_id
             WHERE COALESCE(h.harcama_tipi,'belirsiz')='sahsi'
               AND h.sahsi_isletmeci_id IS NULL
               AND COALESCE(h.durum,'aktif')='aktif'
             ORDER BY h.tarih DESC
             LIMIT %s
            """,
            (int(limit),),
        )
        satirlar = [dict(r) for r in (cur.fetchall() or [])]
        cur.execute(
            "SELECT r.anahtar, r.isletmeci_id, r.adet, i.ad "
            "FROM sahsi_kisi_kural r JOIN isletmeci i ON i.id=r.isletmeci_id WHERE i.aktif=TRUE"
        )
        kural = {r["anahtar"]: {"isletmeci_id": str(r["isletmeci_id"]), "kisi": r["ad"],
                                "kez": int(r["adet"])} for r in (cur.fetchall() or [])}

    gruplar: dict = {}
    for s in satirlar:
        ak = _satici_anahtar(s.get("aciklama")) or "(?)"
        g = gruplar.setdefault(ak, {"satici": ak, "adet": 0, "tutar": 0.0,
                                    "kartlar": set(), "hareket_idler": [],
                                    "ornek": None, "_kart": {}})
        g["adet"] += 1
        g["tutar"] = round(g["tutar"] + float(s["tutar"] or 0), 2)
        kad = s.get("kart_adi") or "(kartsız)"
        g["kartlar"].add(kad)
        g["hareket_idler"].append(str(s["id"]))
        # KART ALT KIRILIMI: aynı satıcı birden çok karttan kullanılmış olabilir
        # (canlıda 13 satıcı böyle — TRENDYOL hem Fethi hem Onur kartından).
        # Satıcıyı tek kişiye toptan yazmak o durumda YANLIŞ olur; ekran alt
        # kırılımı gösterip "bu karttakiler" ayrımını yapabilsin.
        a = g["_kart"].setdefault(kad, {"kart": kad, "adet": 0, "tutar": 0.0, "hareket_idler": []})
        a["adet"] += 1
        a["tutar"] = round(a["tutar"] + float(s["tutar"] or 0), 2)
        a["hareket_idler"].append(str(s["id"]))
        if not g["ornek"]:
            g["ornek"] = {"tarih": str(s.get("tarih") or ""), "aciklama": s.get("aciklama")}

    liste = []
    for ak, g in gruplar.items():
        oneri = kural.get(ak)
        kart_kirilim = sorted(g.pop("_kart").values(), key=lambda x: -x["tutar"])
        liste.append({**g, "kartlar": sorted(g["kartlar"]),
                      "kart_kirilim": kart_kirilim,
                      "cok_kartli": len(kart_kirilim) > 1,
                      "oneri": oneri,
                      "oneri_notu": (f"Daha önce {oneri['kez']} kez {oneri['kisi']} olarak "
                                     "işaretlendi" if oneri else None)})
    liste.sort(key=lambda x: -x["tutar"])
    return {
        "gruplar": liste,
        "grup_adet": len(liste),
        "toplam_adet": sum(g["adet"] for g in liste),
        "toplam_tutar": round(sum(g["tutar"] for g in liste), 2),
        "onerili_adet": sum(g["adet"] for g in liste if g["oneri"]),
        "cok_kartli_grup": sum(1 for g in liste if g["cok_kartli"]),
        "not": ("Kart sahibi atama sebebi DEĞİLDİR — aynı kart birden çok kişi "
                "tarafından kullanılabilir. Kart adı yalnız ipucu olarak gösterilir."),
        "uyari": ("Bir satıcı birden çok karttan kullanılmışsa (cok_kartli) toptan "
                  "atama yanlış olabilir — kart kırılımından seçerek atayın."),
    }


class SaticiAtaBody(BaseModel):
    satici: str
    isletmeci_id: str
    ogren: bool = True          # bir dahaki sefere önerilsin mi
    hareket_idler: Optional[list] = None   # verilmezse o satıcının TÜM bekleyenleri


@router.post("/api/isletmeci/satici-ata")
def satici_ata(body: SaticiAtaBody):
    """Bir satıcının bekleyen şahsi harcamalarını tek seferde bir kişiye bağlar.

    275 kaydı tek tek tıklamak insanlık dışı; satıcı grubu doğal toplu birimdir
    ("TRENDYOL YEMEK'in 12 kaydı Fatma'nın"). ogren=True ise kural yazılır ve
    sonraki aynı satıcı satırlarında ÖNERİ olarak çıkar — otomatik yazılmaz.
    """
    ak = (body.satici or "").strip().upper()
    if not ak:
        raise HTTPException(400, "satici gerekli")
    with db() as (conn, cur):
        cur.execute("SELECT ad FROM isletmeci WHERE id=%s AND aktif=TRUE", (body.isletmeci_id,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "İşletmeci bulunamadı")
        ad = r["ad"]
        if body.hareket_idler:
            cur.execute(
                """UPDATE kart_hareketleri
                      SET sahsi_isletmeci_id=%s, sahsi_isletmeci_ad=%s
                    WHERE id = ANY(%s)
                      AND COALESCE(harcama_tipi,'belirsiz')='sahsi'""",
                (body.isletmeci_id, ad, [str(x) for x in body.hareket_idler]),
            )
        else:
            # Satıcı anahtarı ilk anlamlı kelimedir; SQL'de aynı kuralı kurmak
            # yerine adayları çekip Python'da eşleştiriyoruz (tek doğruluk kaynağı
            # _satici_anahtar kalsın — iki farklı eşleştirme mantığı sapma üretir).
            cur.execute(
                """SELECT id, aciklama FROM kart_hareketleri
                    WHERE COALESCE(harcama_tipi,'belirsiz')='sahsi'
                      AND sahsi_isletmeci_id IS NULL
                      AND COALESCE(durum,'aktif')='aktif'"""
            )
            hedef = [str(x["id"]) for x in (cur.fetchall() or [])
                     if (_satici_anahtar(x["aciklama"]) or "") == ak]
            if not hedef:
                return {"success": True, "guncellenen": 0,
                        "mesaj": f"'{ak}' için bekleyen şahsi harcama kalmadı."}
            cur.execute(
                """UPDATE kart_hareketleri
                      SET sahsi_isletmeci_id=%s, sahsi_isletmeci_ad=%s
                    WHERE id = ANY(%s)""",
                (body.isletmeci_id, ad, hedef),
            )
        yazilan = cur.rowcount
        if body.ogren:
            cur.execute(
                """INSERT INTO sahsi_kisi_kural (anahtar, isletmeci_id, adet)
                   VALUES (%s,%s,%s)
                   ON CONFLICT (anahtar) DO UPDATE
                     SET isletmeci_id=EXCLUDED.isletmeci_id,
                         adet=sahsi_kisi_kural.adet + EXCLUDED.adet,
                         guncelleme=NOW()""",
                (ak, body.isletmeci_id, max(1, yazilan)),
            )
    return {"success": True, "satici": ak, "kisi": ad, "guncellenen": yazilan,
            "ogrenildi": bool(body.ogren),
            "mesaj": (f"'{ak}' satıcısının {yazilan} şahsi harcaması {ad} kaydına bağlandı."
                      + (" Bir dahaki sefere bu satıcı için aynı kişi önerilecek."
                         if body.ogren else ""))}


@router.get("/api/isletmeci/harcama-baglam")
def harcama_baglam(hareket_id: str = "", satici: str = "", gun_pencere: int = 7):
    """"BU HARCAMA NEYDİ?" — sınıflandırma kararı için BAĞLAM (salt-okur).

    Sahip (2026-08-10): "bunları şahsi olarak hatırlamıyorum ama bu da burada
    böyle bekliyor, içeriklerini bilseydik belki?"

    Karar verememesinin sebebi kararsızlık değil, BİLGİ EKSİKLİĞİ. Sistem o
    tarihte ne olduğunu aslında biliyor; bu uç onu bir araya getirir:
      · aynı satıcıdan TÜM geçmiş (tekrar mı, tek sefer mi — desen kimlik verir)
      · ±N gün içinde gelen TEDARİKÇİ FATURASI (varsa işletme olma ihtimali yüksek)
      · aynı pencerede açılan SİPARİŞ
      · aynı gün yapılan diğer harcamalar (bağlam: alışveriş turu mu?)
      · o gün şubeler ciro yapmış mı (işletme aktif miydi)

    HÜKÜM VERMEZ — kanıtları sıralar, kararı sahip verir.
    """
    with db() as (conn, cur):
        h = None
        if hareket_id:
            cur.execute(
                """SELECT h.id, h.tarih::text AS tarih, h.aciklama,
                          ABS(h.tutar)::float AS tutar, h.harcama_tipi,
                          h.kategori, k.kart_adi, k.sahip AS kart_sahibi
                     FROM kart_hareketleri h LEFT JOIN kartlar k ON k.id=h.kart_id
                    WHERE h.id=%s""", (hareket_id,))
            r = cur.fetchone()
            if not r:
                raise HTTPException(404, "Kart hareketi bulunamadı")
            h = dict(r)
            # ⚠️ BAĞLAMDA TEK KELİME YETMEZ (2026-08-10, sahip sorusu üzerine
            # yakalandı): _satici_anahtar ilk anlamlı kelimeyi verir ("MUSTAFA"),
            # oysa bu bir ÖN ADDIR. Canlıda "MUSTAFA KORKMAZ 36.000" için
            # "5 harcama var, tekrar eden ilişki" ipucu ürettim — meğer üç ayrı
            # kişiymiş (KORKMAZ / SERKAN TOPATAN / BETEK-DOĞAN). Yanlış ipucu,
            # yanlış sınıflandırmaya götürür. Bağlamda İKİ anlamlı kelime kullanılır.
            if not satici:
                _kel = [w for w in _sade(h["aciklama"]).split()
                        if len(w) >= 3 and not w.isdigit()]
                satici = " ".join(_kel[:2]) if len(_kel) >= 2 else (
                    _satici_anahtar(h["aciklama"]) or "")
        if not satici:
            raise HTTPException(400, "hareket_id veya satici gerekli")

        sa = _sade(satici)
        # 1) Aynı satıcıdan tüm geçmiş — tekrar deseni kimlik verir
        cur.execute(
            """SELECT h.tarih::text AS tarih, ABS(h.tutar)::float AS tutar,
                      h.aciklama, h.harcama_tipi, h.taksit_sayisi, k.kart_adi
                 FROM kart_hareketleri h LEFT JOIN kartlar k ON k.id=h.kart_id
                WHERE h.islem_turu='HARCAMA' AND COALESCE(h.durum,'aktif')='aktif'
                ORDER BY h.tarih DESC""")
        tum = [dict(x) for x in (cur.fetchall() or [])]
        gecmis = [x for x in tum if sa and sa in _sade(x["aciklama"])]

        _t = (h or {}).get("tarih")
        fatura, siparis, ayni_gun, ciro_var = [], [], [], None
        if _t:
            # 2) Pencerede gelen tedarikçi faturası
            try:
                cur.execute(
                    """SELECT tedarikci_ad, fatura_tarih::text AS tarih,
                              COALESCE(toplam_tutar,0)::float AS tutar, fatura_no
                         FROM tedarikci_fatura
                        WHERE fatura_tarih BETWEEN %s::date - %s AND %s::date + %s
                          AND COALESCE(durum,'') <> 'kopya'
                        ORDER BY ABS(fatura_tarih - %s::date)""",
                    (_t, gun_pencere, _t, gun_pencere, _t))
                fatura = [dict(x) for x in (cur.fetchall() or [])][:8]
            except Exception:  # noqa: BLE001
                fatura = []
            # 3) Pencerede açılan sipariş
            try:
                cur.execute(
                    """SELECT ts.tedarikci_ad, ts.olusturma::date::text AS tarih,
                              ts.durum
                         FROM toptanci_siparis ts
                        WHERE ts.olusturma::date BETWEEN %s::date - %s AND %s::date + %s
                        ORDER BY ts.olusturma DESC""",
                    (_t, gun_pencere, _t, gun_pencere))
                siparis = [dict(x) for x in (cur.fetchall() or [])][:8]
            except Exception:  # noqa: BLE001
                siparis = []
            # 4) Aynı gün yapılan diğer kart harcamaları
            ayni_gun = [{"aciklama": x["aciklama"], "tutar": x["tutar"],
                         "tip": x["harcama_tipi"], "kart": x["kart_adi"]}
                        for x in tum
                        if x["tarih"] == _t and x["aciklama"] != (h or {}).get("aciklama")][:10]
            # 5) O gün ciro var mıydı (işletme aktif miydi)
            try:
                cur.execute(
                    """SELECT COUNT(*)::int AS adet, COALESCE(SUM(toplam),0)::float AS toplam
                         FROM ciro WHERE tarih=%s::date AND COALESCE(durum,'aktif')='aktif'""",
                    (_t,))
                _c = dict(cur.fetchone() or {})
                ciro_var = {"adet": int(_c.get("adet") or 0),
                            "toplam": round(float(_c.get("toplam") or 0), 2)}
            except Exception:  # noqa: BLE001
                ciro_var = None

    tutarlar = [x["tutar"] for x in gecmis]
    ipuclari = []
    # Tek kelimelik anahtar (ör. yalnız bir ön ad) farklı kişileri birleştirebilir;
    # bu durumda "tekrar eden ilişki" ipucu üretilmez.
    _guvenilir_ad = len(str(satici).split()) >= 2
    if len(gecmis) >= 3 and _guvenilir_ad:
        ipuclari.append(f"Bu satıcıdan {len(gecmis)} harcama var — tekrar eden bir ilişki, "
                        "tek seferlik şahsi alışverişe benzemiyor.")
    if len(set(round(t) for t in tutarlar)) == 1 and len(tutarlar) > 1:
        ipuclari.append("Tutar her seferinde AYNI — abonelik/düzenli ödeme olabilir.")
    if fatura:
        ipuclari.append(f"Aynı pencerede {len(fatura)} tedarikçi faturası var — "
                        "harcama bir mal alımına denk gelmiş olabilir.")
    if siparis:
        ipuclari.append(f"Aynı pencerede {len(siparis)} sipariş açılmış.")
    if ciro_var and ciro_var["adet"]:
        ipuclari.append(f"O gün {ciro_var['adet']} şube ciro yapmış "
                        f"({ciro_var['toplam']:,.0f} ₺) — işletme açıktı.".replace(",", "."))
    if len(gecmis) >= 3 and not _guvenilir_ad:
        ipuclari.append(f"'{satici}' tek kelimelik bir eşleşme — FARKLI kişi/firmaları "
                        "birleştirmiş olabilir, tekrar sayısına güvenmeyin.")
    if len(gecmis) == 1:
        ipuclari.append("Bu satıcıdan TEK harcama var — mükerrer kayıt yok.")
    _taksitli = [x for x in gecmis if (x.get("taksit_sayisi") or 1) > 1]
    if _taksitli:
        ipuclari.append(f"{len(_taksitli)} kayıt TAKSİTLİ — aynı alımın parçaları olabilir.")
    elif gecmis:
        ipuclari.append("Kayıtlar taksitsiz (tek çekim).")
    if not ipuclari:
        ipuclari.append("Sistemde bu harcamayı açıklayan başka bir iz yok — "
                        "tek seferlik bir ödeme gibi görünüyor.")

    return {
        "hareket": h, "satici": satici,
        "ayni_saticidan_gecmis": {
            "adet": len(gecmis),
            "toplam": round(sum(tutarlar), 2),
            "en_dusuk": round(min(tutarlar), 2) if tutarlar else 0,
            "en_yuksek": round(max(tutarlar), 2) if tutarlar else 0,
            "kayitlar": [{"tarih": x["tarih"], "tutar": x["tutar"],
                          "tip": x["harcama_tipi"], "kart": x["kart_adi"],
                          "taksit": x.get("taksit_sayisi"),
                          "aciklama": x["aciklama"][:60]} for x in gecmis[:12]],
            "mukerrer_suphesi": [
                {"tarih": t, "tutar": tu, "adet": n} for (t, tu), n in
                {(x["tarih"], round(x["tutar"], 2)): sum(
                    1 for y in gecmis
                    if y["tarih"] == x["tarih"] and round(y["tutar"], 2) == round(x["tutar"], 2))
                 for x in gecmis}.items() if n > 1],
        },
        "pencere_gun": gun_pencere,
        "yakin_faturalar": fatura,
        "yakin_siparisler": siparis,
        "ayni_gun_diger_harcamalar": ayni_gun,
        "o_gun_ciro": ciro_var,
        "ipuclari": ipuclari,
        "not": ("Bu uç HÜKÜM VERMEZ — kanıtları sıralar. 'İşletme mi şahsi mi' "
                "kararı sahibindir; sistem yalnız hatırlamaya yardım eder."),
    }


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
