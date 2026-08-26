"""
PERSONEL KİMLİĞİ — "aynı insan mı?" ve "gerçekten ne zaman başladı?" İZOLE.

── NEDEN (2026-08-26, sahip: "çıktı geri girdi") ────────────────────────────
SILA AKBAY `personel` tablosunda İKİ KAYIT: biri aktif, biri 2026-05-26 çıkışlı.
Bu MÜKERRER DEĞİL — iki ayrı çalışma dönemi ve ikisi de doğru. Ama sistemde iki
gerçek sorun var:

  1) İKİSİNİ BAĞLAYAN HİÇBİR ALAN YOK. Ortak olan tek şey AD. TC kimlik alanı
     yok, telefonlar eşleşmiyor. Yani sistem bunların AYNI İNSAN olduğunu
     BİLMİYOR. Kıdem toplansın mı toplanmasın mı sorusunun cevabı ne olursa
     olsun, bu bağ olmadan HİÇBİRİ hesaplanamaz. Kimlik önce gelir, kural sonra.
  2) ESKİ KAYDIN TARİHLERİ TUTARSIZ: başlangıç 2026-08-10, çıkış 2026-05-26 —
     çıkış başlangıçtan İKİ BUÇUK AY ÖNCE. İmkânsız. Muhtemelen yeni kayıt
     açılırken eskisinin başlangıcı da ezilmiş; eski dönemin gerçek başlangıcı
     KAYIP.

── DOKTRİNLER ───────────────────────────────────────────────────────────────
· ÖNERİ-ONLY — bu modül HİÇBİR kaydı kendiliğinden birleştirmez/düzeltmez.
  Aday gösterir, sahip onaylar. Aynı ada sahip iki kişi gerçekten olabilir;
  otomatik birleştirme iki insanı tek bordroda toplardı.
· BİRLEŞTİRME ≠ SİLME — `kisi_id` damgası kayıtları BAĞLAR, hiçbirini silmez
  ya da içeriğini değiştirmez. Her dönem kendi bordro/vardiya geçmişini taşımaya
  devam eder.
· TARİH UYDURULMAZ — düzeltme önerisi KANITTAN türer: o personel kimliğine
  bağlı en eski gerçek iz (puantaj, aylık bordro, vardiya takibi…). Kanıt yoksa
  öneri de yok; "muhtemelen şu tarihtir" demek bordroya yalan yazmaktır.
· İZ BIRAKIR — hem bağlama hem tarih düzeltmesi ESKİ DEĞERİ saklar.
· ŞEMA VARSAYILMAZ — hangi tablonun `personel_id`'si ve tarih kolonu var,
  information_schema'dan okunur.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Set

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/personel-kimlik", tags=["personel-kimlik"])

# Kanıt aranacak tarih kolonu adayları (ilk bulunan kullanılır).
TARIH_ADAYLARI = ("tarih", "gun", "calisma_tarihi", "olusturma", "created_at", "kayit_tarihi")


def _tr_kucuk(s: str) -> str:
    """Türkçe küçültme — 'İ'→'i', 'I'→'ı'. Ad karşılaştırması bunsuz yanılır."""
    return (str(s or "").replace("İ", "i").replace("I", "ı").lower().strip())


def _kolonlar(cur, tablo: str) -> Set[str]:
    cur.execute(
        "SELECT column_name FROM information_schema.columns "
        " WHERE table_schema='public' AND table_name=%s", (tablo,))
    return {r["column_name"] for r in (cur.fetchall() or [])}


def _kimlik_kolonlari(cur) -> None:
    """Modülün KENDİ kolonları — eklemeli, mevcut davranışa dokunmaz."""
    cur.execute("ALTER TABLE personel ADD COLUMN IF NOT EXISTS kisi_id TEXT")
    cur.execute("ALTER TABLE personel ADD COLUMN IF NOT EXISTS kisi_bag_notu TEXT")
    cur.execute("ALTER TABLE personel ADD COLUMN IF NOT EXISTS baslangic_duzeltme_notu TEXT")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_personel_kisi ON personel (kisi_id)")


@router.get("/adaylar")
def adaylar():
    """👥 AYNI KİŞİ OLABİLECEK KAYITLAR — SALT OKUR, ÖNERİ-ONLY.

    Ad (Türkçe küçültülmüş) aynı olan ama kimliği farklı kayıtlar. Bu bir
    HÜKÜM DEĞİL: aynı adda iki farklı insan gerçekten olabilir. Sahip bakar,
    onaylarsa `/bagla` ile damgalanır.
    """
    with db() as (conn, cur):
        _kimlik_kolonlari(cur)
        conn.commit()
        cur.execute(
            "SELECT id::text AS id, ad_soyad, gorev, sube_id::text AS sube_id, "
            "       baslangic_tarihi::text AS baslangic, cikis_tarihi::text AS cikis, "
            "       COALESCE(aktif,TRUE) AS aktif, kisi_id, telefon "
            "  FROM personel ORDER BY ad_soyad")
        rows = [dict(r) for r in (cur.fetchall() or [])]

    gruplar: Dict[str, List[Dict[str, Any]]] = {}
    for r in rows:
        gruplar.setdefault(_tr_kucuk(r.get("ad_soyad")), []).append(r)

    cikti = []
    for ad, grup in gruplar.items():
        if len(grup) < 2:
            continue
        # Zaten bağlanmışsa (hepsi aynı kisi_id) aday listesinden düşer —
        # kapanabilen öneri: iş bitince liste kendiliğinden boşalır.
        kimlikler = {g.get("kisi_id") for g in grup}
        bagli = len(kimlikler) == 1 and None not in kimlikler
        cikti.append({
            "ad": grup[0].get("ad_soyad"),
            "kayit_sayisi": len(grup),
            "bagli_mi": bagli,
            "kayitlar": sorted(grup, key=lambda x: str(x.get("baslangic") or "")),
            # Tarih tutarsızlığı burada da görünür olsun — asıl bulgu buydu.
            "tarih_tutarsiz": [
                g["id"] for g in grup
                if g.get("cikis") and g.get("baslangic") and g["cikis"] < g["baslangic"]
            ],
        })
    return {
        "aday_grup": len([c for c in cikti if not c["bagli_mi"]]),
        "gruplar": cikti,
        "not": ("ÖNERİ-ONLY: aynı ad AYNI KİŞİ DEMEK DEĞİLDİR — iki farklı insan "
                "olabilir. Otomatik birleştirme iki insanı tek bordroda toplardı. "
                "Sahip onaylayınca /bagla damgalar; damga kayıtları BAĞLAR, "
                "hiçbirini silmez, içeriğini değiştirmez."),
    }


class BaglaBody(BaseModel):
    personel_idler: List[str]
    gerekce: Optional[str] = None


@router.post("/bagla")
def bagla(body: BaglaBody):
    """🔗 Verilen kayıtları AYNI KİŞİ olarak damgalar. Sahip onayıyla.

    ⚠️ SİLMEZ, BİRLEŞTİRMEZ: her kayıt olduğu gibi kalır; yalnız ortak bir
    `kisi_id` alır. Böylece "toplam kıdem" gibi sorular hesaplanabilir hâle
    gelir ama her dönemin kendi bordrosu bozulmaz.
    """
    idler = [str(x).strip() for x in (body.personel_idler or []) if str(x).strip()]
    if len(idler) < 2:
        raise HTTPException(400, "En az iki kayıt seçilmeli")
    with db() as (conn, cur):
        _kimlik_kolonlari(cur)
        cur.execute("SELECT id::text AS id, ad_soyad, kisi_id FROM personel "
                    " WHERE id::text = ANY(%s)", (idler,))
        bulunan = [dict(r) for r in (cur.fetchall() or [])]
        if len(bulunan) != len(idler):
            raise HTTPException(404, "Bazı kayıtlar bulunamadı")
        # Kanonik kimlik: varsa mevcut kisi_id korunur (ikinci bir kimlik
        # doğurmamak için), yoksa en eski kaydın id'si çekirdek olur.
        mevcut = [b["kisi_id"] for b in bulunan if b.get("kisi_id")]
        kok = mevcut[0] if mevcut else sorted(idler)[0]
        not_metni = (body.gerekce or "sahip onayı: aynı kişi")[:200]
        cur.execute(
            "UPDATE personel SET kisi_id=%s, kisi_bag_notu=%s WHERE id::text = ANY(%s)",
            (kok, not_metni, idler))
        conn.commit()
    return {"ok": True, "kisi_id": kok, "baglanan": len(idler),
            "not": "Kayıtlar bağlandı. Hiçbiri silinmedi; her dönem kendi geçmişini taşır."}


@router.get("/tarih-kaniti/{personel_id}")
def tarih_kaniti(personel_id: str):
    """🔍 "Bu kişi GERÇEKTEN ne zaman çalışmaya başladı?" — SALT OKUR.

    Kayıtlı `baslangic_tarihi` yanlış olabilir (canlı örnek: çıkış tarihi
    başlangıçtan önce). Bu uç TAHMİN YAPMAZ; `personel_id` taşıyan tablolarda
    o kişiye ait EN ESKİ İZİ arar ve nereden geldiğini söyler.

    ⚠️ Kanıt yoksa öneri de YOK. "Muhtemelen şu tarihtir" demek bordroya yalan
    yazmaktır — sahip gerçek tarihi biliyorsa elle girer.
    """
    with db() as (_, cur):
        cur.execute(
            "SELECT id::text AS id, ad_soyad, baslangic_tarihi::text AS baslangic, "
            "       cikis_tarihi::text AS cikis FROM personel WHERE id::text=%s",
            (str(personel_id),))
        p = cur.fetchone()
        if not p:
            raise HTTPException(404, "personel bulunamadı")
        p = dict(p)

        # personel_id taşıyan TÜM tabloları şemadan bul (varsayım yok).
        cur.execute(
            "SELECT table_name FROM information_schema.columns "
            " WHERE table_schema='public' AND column_name='personel_id'")
        tablolar = sorted({r["table_name"] for r in (cur.fetchall() or [])})

        izler = []
        for t in tablolar:
            try:
                kol = _kolonlar(cur, t)
                tar = next((c for c in TARIH_ADAYLARI if c in kol), None)
                if not tar:
                    continue
                cur.execute(
                    f"SELECT MIN({tar})::text AS en_eski, COUNT(*) AS adet "
                    f"  FROM {t} WHERE personel_id::text = %s", (str(personel_id),))
                r = dict(cur.fetchone() or {})
                if r.get("adet"):
                    izler.append({"tablo": t, "tarih_kolonu": tar,
                                  "en_eski": (r.get("en_eski") or "")[:10],
                                  "kayit": int(r["adet"])})
            except Exception as e:  # noqa: BLE001 — bir tablo okunamazsa diğerleri sürsün
                logger.warning("tarih kaniti %s okunamadi: %s", t, str(e)[:100])

        # personel_aylik yıl/ay taşıyorsa ayrıca bak (tarih kolonu olmayabilir)
        try:
            ka = _kolonlar(cur, "personel_aylik")
            if {"yil", "ay"} <= ka:
                cur.execute(
                    "SELECT MIN(yil*100+ay) AS en_eski, COUNT(*) AS adet "
                    "  FROM personel_aylik WHERE personel_id::text=%s", (str(personel_id),))
                r = dict(cur.fetchone() or {})
                if r.get("adet") and r.get("en_eski"):
                    v = int(r["en_eski"])
                    izler.append({"tablo": "personel_aylik", "tarih_kolonu": "yil/ay",
                                  "en_eski": f"{v // 100}-{v % 100:02d}-01",
                                  "kayit": int(r["adet"])})
        except Exception as e:  # noqa: BLE001
            logger.warning("personel_aylik kaniti okunamadi: %s", str(e)[:100])

    gecerli = [i for i in izler if i["en_eski"]]
    onerilen = min((i["en_eski"] for i in gecerli), default=None)
    tutarsiz = bool(p.get("cikis") and p.get("baslangic") and p["cikis"] < p["baslangic"])
    return {
        "personel": p,
        "tarih_tutarsiz": tutarsiz,
        "izler": sorted(gecerli, key=lambda x: x["en_eski"]),
        "onerilen_baslangic": onerilen,
        "not": ("Öneri KANITTAN gelir: bu kişiye ait en eski gerçek iz. Kanıt yoksa "
                "öneri de yoktur — 'muhtemelen' demek bordroya yalan yazmaktır. "
                "Karar sahibin; /baslangic-duzelt eski değeri saklayarak yazar."),
    }


class TarihBody(BaseModel):
    yeni_baslangic: str        # YYYY-MM-DD
    gerekce: Optional[str] = None


@router.post("/baslangic-duzelt/{personel_id}")
def baslangic_duzelt(personel_id: str, body: TarihBody):
    """📅 Başlangıç tarihini düzeltir — ESKİ DEĞERİ SAKLAYARAK. Sahip onayıyla.

    ⚠️ Eski değer `baslangic_duzeltme_notu` içinde kalır: bordro geçmişe dönük
    sorgulanırsa "bu tarih neden değişti" cevaplanabilsin. İzsiz düzeltme,
    düzeltilmiş bir yalandır.
    """
    import re as _re
    yeni = (body.yeni_baslangic or "").strip()
    if not _re.match(r"^\d{4}-\d{2}-\d{2}$", yeni):
        raise HTTPException(400, "yeni_baslangic YYYY-AA-GG olmalı")
    with db() as (conn, cur):
        _kimlik_kolonlari(cur)
        cur.execute("SELECT baslangic_tarihi::text AS eski, cikis_tarihi::text AS cikis, "
                    "       ad_soyad FROM personel WHERE id::text=%s", (str(personel_id),))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "personel bulunamadı")
        r = dict(r)
        # Yeni tarih çıkıştan SONRA olamaz — düzeltirken aynı hatayı kurmayalım.
        if r.get("cikis") and yeni > r["cikis"]:
            raise HTTPException(
                400, f"Başlangıç ({yeni}) çıkıştan ({r['cikis']}) sonra olamaz")
        not_metni = (f"eski başlangıç: {r.get('eski') or '—'} · "
                     f"{(body.gerekce or 'sahip düzeltmesi')}")[:300]
        cur.execute(
            "UPDATE personel SET baslangic_tarihi=%s::date, baslangic_duzeltme_notu=%s "
            " WHERE id::text=%s", (yeni, not_metni, str(personel_id)))
        conn.commit()
    return {"ok": True, "personel": r.get("ad_soyad"),
            "eski_baslangic": r.get("eski"), "yeni_baslangic": yeni,
            "not": "Eski değer `baslangic_duzeltme_notu` içinde saklandı — izsiz düzeltme yapılmadı."}
