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


def _ad_katla(s: str) -> str:
    """Türkçe harfleri ASCII'ye indirger — 'GÖKÇE' ile 'gökce' aynı sayılsın diye.
    _tr_kucuk yalnız büyük/küçük çözer; ç/c, ş/s, ğ/g farkı orada KALIR ve
    'gökçe değirmenci' ile 'GÖKCE ESRA DEĞİRMENCİ' bambaşka görünür."""
    t = _tr_kucuk(s)
    for a, b in (("ı", "i"), ("ş", "s"), ("ğ", "g"), ("ü", "u"),
                 ("ö", "o"), ("ç", "c"), ("â", "a"), ("î", "i")):
        t = t.replace(a, b)
    return " ".join(t.split())


def _benzer_ad(a: str, b: str) -> Optional[str]:
    """İki adın AYNI KİŞİ olabileceğine dair ZAYIF işaret. Hüküm DEĞİL.

    Canlı desen (2026-09-06, sahip: "girdiler çıktılar yeniden girdiler"):
    geri dönen personel yeni kayıtta adını farklı yazdırıyor —
    'ERSEN KAZAN'/'ersan kazan', 'AYŞENAZ DAL'/'naz dal',
    'GÖKCE ESRA DEĞİRMENCİ'/'gökçe değirmenci'. Tam ad eşleşmesi üçünü de
    kaçırıyordu; uç "0 aday" diyor, oysa üç geri dönüş bağsız duruyordu.

    Kural: SOYAD (son kelime) aynı olacak — bu şart. Ad tarafında:
      · biri diğerinin ön/son eki   ('naz' ⊂ 'aysenaz')
      · ya da ilk üç harf ortak     ('ersan' / 'ersen')
    Dönen metin GEREKÇEdir; sahip okur, kararı o verir.
    """
    pa, pb = _ad_katla(a).split(), _ad_katla(b).split()
    if not pa or not pb or pa == pb:
        return None
    if pa[-1] != pb[-1]:
        return None
    soyad, x, y = pa[-1], pa[0], pb[0]
    if x == y:
        return f"soyad '{soyad}' ve ilk ad '{x}' aynı, ara ad farklı"
    if x.startswith(y) or y.startswith(x) or x.endswith(y) or y.endswith(x):
        return f"soyad '{soyad}' aynı, ad biri diğerini kapsıyor ('{x}' / '{y}')"
    if len(x) >= 3 and len(y) >= 3 and x[:3] == y[:3]:
        return f"soyad '{soyad}' aynı, ad ilk üç harfi ortak ('{x}' / '{y}')"
    return None


def _donem_ortusuyor(u: Dict[str, Any], v: Dict[str, Any]) -> bool:
    """İki dönem takvimde çakışıyor mu? Çakışma 'çıktı-geri girdi' tezine
    KARŞI kanıttır: aynı anda iki açık kayıt, büyük ihtimalle iki ayrı insan."""
    ab, bb = u.get("baslangic"), v.get("baslangic")
    if not ab or not bb:
        return False
    ac = u.get("cikis") or "9999-12-31"
    bc = v.get("cikis") or "9999-12-31"
    return ab <= bc and bb <= ac


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
    # ── 2. KATMAN: BENZER AD (zayıf kanıt) ──────────────────────────────
    # Tam ad eşleşmesi geri dönen personeli KAÇIRIYOR: yeni kayıtta ad yazımı
    # değişiyor. Bu katman olmadan uç "0 aday" diyordu (2026-09-06 canlı).
    benzer: List[Dict[str, Any]] = []
    for i in range(len(rows)):
        for j in range(i + 1, len(rows)):
            u, v = rows[i], rows[j]
            if _tr_kucuk(u.get("ad_soyad")) == _tr_kucuk(v.get("ad_soyad")):
                continue                      # 1. katman zaten gösteriyor
            if u.get("kisi_id") and u.get("kisi_id") == v.get("kisi_id"):
                continue                      # zaten bağlı
            gerekce = _benzer_ad(u.get("ad_soyad"), v.get("ad_soyad"))
            if not gerekce:
                continue
            benzer.append({
                "adlar": [u.get("ad_soyad"), v.get("ad_soyad")],
                "gerekce": gerekce,
                "guven": "zayif",
                "donem_ortusuyor": _donem_ortusuyor(u, v),
                "kayitlar": sorted([u, v], key=lambda x: str(x.get("baslangic") or "")),
            })

    return {
        "aday_grup": len([c for c in cikti if not c["bagli_mi"]]),
        "gruplar": cikti,
        "aday_benzer": len(benzer),
        "benzer_gruplar": benzer,
        "not": ("ÖNERİ-ONLY: aynı ad AYNI KİŞİ DEMEK DEĞİLDİR — iki farklı insan "
                "olabilir. Otomatik birleştirme iki insanı tek bordroda toplardı. "
                "Sahip onaylayınca /bagla damgalar; damga kayıtları BAĞLAR, "
                "hiçbirini silmez, içeriğini değiştirmez."),
        "not_benzer": ("benzer_gruplar ZAYIF kanıttır — yalnız soyad + ad yazım "
                       "yakınlığı. 'donem_ortusuyor=true' ise iki kayıt aynı anda "
                       "açıktı; bu geri-dönüş tezine KARŞI kanıttır, önce ona bakın."),
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
