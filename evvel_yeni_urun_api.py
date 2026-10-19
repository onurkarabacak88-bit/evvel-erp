"""📚 EVVEL YENİ · ÜRÜN KATALOĞU — tak-çıkar modül "urun" (sektor genel, gerekir []).

SIFIRDAN KURULUM (sahip 2026-10-18): "Hataları tespit ettik; bunu sıfırdan kuruyoruz, uçları da sıfırdan yazacağız —
kopyalayıp oradan tekrar bağlayıp Evvel'in ilk versiyonu gibi olmasın."
  · Eski sisteme HİÇBİR bağ yok: eski kimlik, eski depo kodu / takma ad, eski kataloğa geri yazma YOK. Eski tablolar okunmaz.
  · Başlangıç listesi: 2026-10-17/18 akşamı sahiple temizlenen liste (mükerrerler ayıklanmış, birim / koli / KDV düzeltilmiş) — YENİ kimliklerle,
    bir kez yazılır (sürüm 2). İlk denemenin tabloları silinmez, *_v1_yedek adıyla saklanır (sürümleri sakla).
  · DEĞİŞİKLİK İZİ: ürünün güncel kartı + her değişiklik bir kayıt (alan, eski → yeni, kim, zaman). Silme yok: pasif + iz.
  · ÜÇ ÖLÇÜ (sahip 2026-10-18: "biz bunları koli değil PAKET olarak saydırıyoruz; faturada adet var, pakette 50"):
      sayım birimi (birim: personelin saydığı — adet/paket/kutu/şişe/rulo, hep TAM SAYI) · koli (1 koli kaç sayım birimi) ·
      fatura birimi (faturada nasıl geliyor) + çevrim: 1 sayım birimi = sayim_ici fatura adedi (peçete: 1 paket = 50 adet)
      YA DA 1 fatura birimi = fatura_ici sayım birimi (Z peçete: 1 koli = 12 paket). Maliyet çevrimi TEK yerde: birim_maliyet().
  · TAKİP (sahip 2026-10-18: "kapak sayımı önemli değil ama bardak günlük sayılır"; "ürün aç sistemi olduğu için her açtığı pakette maliyet var"):
      'sayim' = düzenli sayılır · 'acilinca' = sayılmaz, gideri ürün açılınca (ürün aç) yazılır — sayım listesine çıkmaz.
  · PANEL SAYIMI (sahip 2026-10-18: "açılış listesi eskiden ne varsa onun gösterilmesi"): panel_sayim = şube açılış/kapanışında
      sayılan ürün (eski panel: bardaklar, su, süt, Redbull, soda, cookie, pastalar). Diğer 'sayim' ürünleri depo sayımında.
  · KDV ürün kartında. FİYAT katalogda değil.
  · PUBLIC servis: urun_haritasi(cur) · katalog(cur) · urun_bilgi(cur, idler) · urun_ad(cur, id) · urun_olustur(cur, …).
"""

import json
import logging
import uuid
from decimal import Decimal
from typing import Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from database import db
from evvel_yeni_cekirdek import aktor as _aktor, bekleyen_is_kaydet

router = APIRouter(prefix="/api/evvel-yeni/urun", tags=["evvel-yeni-urun"])
log = logging.getLogger(__name__)
BIRIMLER = ("adet", "paket", "kutu", "şişe", "rulo")      # sayım birimi (tam sayı); kg / lt miktar zinciri ondalığa geçince
FATURA_BIRIMLER = ("adet", "paket", "kutu", "koli", "şişe", "rulo")
TAKIPLER = ("sayim", "acilinca", "gununde")   # gununde (pasta, sahip P1 20 Eki): depoya girdiği an tüketilir — sayılmaz, açılmaz
KDV_ORANLARI = (Decimal("0"), Decimal("0.01"), Decimal("0.10"), Decimal("0.20"))
SURUM = 5
_HAZIR = False


def _n(x) -> str:
    """Ad anahtarı (Türkçe İ/I tuzağı güvenli): büyük/küçük harf ve boşluk farkı yok sayılır."""
    return " ".join(str(x or "").replace("İ", "i").replace("I", "ı").lower().split())


def _tablo_var(cur, ad: str) -> bool:
    cur.execute("SELECT to_regclass(%s) IS NOT NULL AS v", (ad,))
    return bool(dict(cur.fetchone())["v"])


def _hazirla():
    global _HAZIR
    if _HAZIR:
        return
    with db() as (conn, cur):
        cur.execute("SELECT pg_advisory_xact_lock(7012041)")   # kurulum çok işçide bir kez
        cur.execute("SET LOCAL lock_timeout = '3s'")
        cur.execute("CREATE TABLE IF NOT EXISTS ey_urun_surum (surum INT NOT NULL)")
        cur.execute("SELECT MAX(surum) AS s FROM ey_urun_surum")
        s = dict(cur.fetchone())["s"] or 0
        if s < 2:
            _surum2(cur)
        if s < 3:      # fatura birimi + çevrim
            cur.execute("ALTER TABLE ey_urun ADD COLUMN IF NOT EXISTS fatura_birim TEXT")
            cur.execute("ALTER TABLE ey_urun ADD COLUMN IF NOT EXISTS sayim_ici INT")    # 1 sayım birimi = N fatura adedi
            cur.execute("ALTER TABLE ey_urun ADD COLUMN IF NOT EXISTS fatura_ici INT")   # 1 fatura birimi = N sayım birimi
        if s < 4:      # takip biçimi
            cur.execute("ALTER TABLE ey_urun ADD COLUMN IF NOT EXISTS takip TEXT NOT NULL DEFAULT 'sayim'")
        if s < 5:      # açılış / kapanışta sayılır
            cur.execute("ALTER TABLE ey_urun ADD COLUMN IF NOT EXISTS panel_sayim BOOLEAN NOT NULL DEFAULT FALSE")
        if s < SURUM:
            cur.execute("INSERT INTO ey_urun_surum (surum) VALUES (%s)", (SURUM,))
    _HAZIR = True


def _tablolar(cur):
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_urun_kategori (
        id TEXT PRIMARY KEY, ad TEXT NOT NULL, emoji TEXT, sira INT NOT NULL DEFAULT 0, aktif BOOLEAN NOT NULL DEFAULT TRUE)""")
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_urun (
        id TEXT PRIMARY KEY, ad TEXT NOT NULL, kategori_id TEXT NOT NULL, birim TEXT NOT NULL DEFAULT 'adet', birim_teyit BOOLEAN NOT NULL DEFAULT FALSE,
        koli_ici INT, kdv_oran NUMERIC(5,4), aktif BOOLEAN NOT NULL DEFAULT TRUE, sira INT NOT NULL DEFAULT 0,
        olusturma TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_urun_iz (
        id TEXT PRIMARY KEY, urun_id TEXT NOT NULL, alan TEXT NOT NULL, eski TEXT, yeni TEXT, kim TEXT,
        zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ey_urun_iz_urun ON ey_urun_iz (urun_id, zaman)")


def _surum2(cur):
    """İlk deneme (sürüm 1: eski sistemden kopya + köprü) varsa yedeğe kaldırılır; temizlenmiş liste YENİ kimliklerle yazılır.
    İlk deneme yoksa (yeni kurulum / başka iş kolu) katalog boş başlar."""
    eski = _tablo_var(cur, "ey_urun") and not _tablo_var(cur, "ey_urun_v1_yedek")
    if eski:
        for t in ("ey_urun", "ey_urun_kategori", "ey_urun_iz", "ey_urun_takma"):
            if _tablo_var(cur, t):
                cur.execute(f"ALTER TABLE {t} RENAME TO {t}_v1_yedek")
        # Fable: yedeğe kalkan tabloların BÜTÜN indeksleri (adı bilinmeyen dahil) yeniden adlandırılır → yeni tablolarla çakışmaz
        cur.execute("""SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
                        AND tablename IN ('ey_urun_v1_yedek', 'ey_urun_kategori_v1_yedek', 'ey_urun_iz_v1_yedek', 'ey_urun_takma_v1_yedek')""")
        for i in [dict(x)["indexname"] for x in cur.fetchall() or []]:
            if not i.startswith("v1y_"):
                cur.execute(f'ALTER INDEX "{i}" RENAME TO "{("v1y_" + i)[:63]}"')
    _tablolar(cur)
    if not eski:
        return
    # Başlangıç listesi = sahiple temizlenen kullanımdaki ürünler (mükerrer / pasif / birleştirilmiş HARİÇ), yeni kimlik, eski bağ YOK
    cur.execute("SELECT id, ad, emoji, sira FROM ey_urun_kategori_v1_yedek WHERE aktif ORDER BY sira, ad")
    kat = {}
    for r in [dict(x) for x in cur.fetchall() or []]:
        kat[r["id"]] = str(uuid.uuid4())
        cur.execute("INSERT INTO ey_urun_kategori (id, ad, emoji, sira, aktif) VALUES (%s,%s,%s,%s,TRUE)",
                    (kat[r["id"]], r["ad"], r["emoji"], int(r["sira"] or 0)))
    cur.execute("ALTER TABLE ey_urun_v1_yedek ADD COLUMN IF NOT EXISTS birlesti TEXT")   # Codex: en eski v1 şemasında yok
    cur.execute("""SELECT ad, kategori_id, birim_teyit, koli_ici, kdv_oran, sira FROM ey_urun_v1_yedek
                    WHERE aktif AND birlesti IS NULL ORDER BY sira, ad""")
    n, atlanan = 0, []
    for r in [dict(x) for x in cur.fetchall() or []]:
        if r["kategori_id"] not in kat:
            atlanan.append(r["ad"])     # Fable: kategorisiz / pasif kategorideki ürün sessiz kaybolmasın
            continue
        uid = str(uuid.uuid4())
        cur.execute("""INSERT INTO ey_urun (id, ad, kategori_id, birim, birim_teyit, koli_ici, kdv_oran, aktif, sira)
                       VALUES (%s,%s,%s,'adet',%s,%s,%s,TRUE,%s)""",
                    (uid, r["ad"].strip(), kat[r["kategori_id"]], bool(r["birim_teyit"]), r["koli_ici"], r["kdv_oran"], int(r["sira"] or 0)))
        cur.execute("INSERT INTO ey_urun_iz (id, urun_id, alan, eski, yeni, kim) VALUES (%s,%s,'olusturma',NULL,%s,%s)",
                    (str(uuid.uuid4()), uid, r["ad"].strip(), "başlangıç listesi (2026-10-18, sahiple temizlendi)"))
        n += 1
    log.info("ürün kataloğu: sıfırdan kuruldu, başlangıç listesi %s ürün", n)
    if atlanan:
        log.warning("ürün kataloğu: kategorisi olmadığı için başlangıç listesine alınmayan %s ürün: %s", len(atlanan), ", ".join(atlanan)[:500])


# ─────────────────────────── PUBLIC SERVİSLER ───────────────────────────
def urun_haritasi(cur):
    """Kimlik ya da ad → (urun_id, ad). Bulunamayan 'ad:<ad>' / 'kod:<kod>' döner (kaybolmaz, okuyan modül Bekleyen işlere yazar)."""
    _hazirla()
    cur.execute("SELECT id, ad FROM ey_urun ORDER BY aktif DESC, sira, ad")
    ad = {dict(r)["id"]: dict(r)["ad"] for r in cur.fetchall() or []}
    by_ad: Dict[str, str] = {}
    for uid, a in ad.items():
        by_ad.setdefault(_n(a), uid)

    def coz(kod, adi=None):
        kod = str(kod or "").strip()
        if kod in ad:
            return kod, ad[kod]
        if adi and _n(adi) in by_ad:
            u = by_ad[_n(adi)]
            return u, ad[u]
        return ("kod:" + kod if kod else "ad:" + _n(adi)), (adi or kod)
    return coz


def katalog(cur, hepsi: bool = False) -> List[dict]:
    """Kategori → ürünler (birim, koli, KDV, aktif). Fiyat YOK."""
    _hazirla()
    cur.execute("SELECT * FROM ey_urun_kategori" + ("" if hepsi else " WHERE aktif") + " ORDER BY sira, ad")
    kats = [dict(r) for r in cur.fetchall() or []]
    cur.execute("SELECT * FROM ey_urun" + ("" if hepsi else " WHERE aktif") + " ORDER BY sira, ad")
    by_k: Dict[str, list] = {}
    for u in [dict(r) for r in cur.fetchall() or []]:
        by_k.setdefault(u["kategori_id"], []).append({
            "id": u["id"], "ad": u["ad"], "birim": u["birim"], "birim_teyit": u["birim_teyit"], "koli_ici": u.get("koli_ici"),
            "kdv_oran": float(u["kdv_oran"]) if u.get("kdv_oran") is not None else None, "aktif": u["aktif"],
            "fatura_birim": u.get("fatura_birim") or u["birim"], "sayim_ici": u.get("sayim_ici"), "fatura_ici": u.get("fatura_ici"),
            "takip": u.get("takip") or "sayim", "panel_sayim": bool(u.get("panel_sayim"))})
    return [{"id": k["id"], "ad": k["ad"], "emoji": k.get("emoji"), "aktif": k["aktif"], "urunler": by_k.get(k["id"], [])} for k in kats]


def urun_bilgi(cur, idler) -> Dict[str, dict]:
    """{urun_id: {ad, birim, koli_ici, kdv_oran, aktif}} — okuyucular için toplu bilgi."""
    _hazirla()
    idler = [str(i) for i in (idler or []) if i]
    if not idler:
        return {}
    cur.execute("SELECT id, ad, birim, koli_ici, kdv_oran, aktif, fatura_birim, sayim_ici, fatura_ici, takip, panel_sayim FROM ey_urun WHERE id = ANY(%s)", (idler,))
    return {dict(r)["id"]: {**dict(r), "kdv_oran": float(dict(r)["kdv_oran"]) if dict(r)["kdv_oran"] is not None else None,
                            "fatura_birim": dict(r)["fatura_birim"] or dict(r)["birim"]}
            for r in cur.fetchall() or []}


def urun_ad(cur, uid: str) -> Optional[str]:
    return (urun_bilgi(cur, [uid]).get(str(uid)) or {}).get("ad")


def birim_maliyet(urun: dict, fatura_birim_fiyat) -> Optional[Decimal]:
    """PUBLIC: faturadaki birim fiyat → 1 SAYIM biriminin maliyeti (peçete: 0,21 ₺/adet × 50 = 10,50 ₺/paket;
    Z peçete: 917,50 ₺/koli ÷ 12 = 76,46 ₺/paket). Çevrim kuralının TEK yeri."""
    if fatura_birim_fiyat is None:
        return None
    f = Decimal(str(fatura_birim_fiyat))
    return f * int(urun.get("sayim_ici") or 1) / int(urun.get("fatura_ici") or 1)


def faturadan_sayima(urun: dict, fatura_adet) -> Decimal:
    """PUBLIC: faturadaki miktar → sayım birimi (60.000 adet peçete = 1.200 paket; 3 koli Z peçete = 36 paket)."""
    return Decimal(str(fatura_adet or 0)) * int(urun.get("fatura_ici") or 1) / int(urun.get("sayim_ici") or 1)


def _ayni_ad(cur, kategori_id: str, ad: str, haric: Optional[str]) -> None:
    """Aynı kategoride aynı adlı KULLANIMDAKİ ürün (büyük/küçük harf, Türkçe İ/I, boşluk farkı dahil) → 409."""
    cur.execute("SELECT id, ad FROM ey_urun WHERE kategori_id=%s AND aktif", (kategori_id,))
    for r in cur.fetchall() or []:
        if dict(r)["id"] != haric and _n(dict(r)["ad"]) == _n(ad):
            raise HTTPException(409, f"Bu kategoride aynı adlı ürün var: {dict(r)['ad']}")


def _cevrim(birim: str, koli_ici, fatura_birim, sayim_ici, fatura_ici):
    """Sayım / fatura birimi kuralı (tek yer). Döner: (fatura_birim, sayim_ici, fatura_ici) — aynı birimse üçü boş.
    Faturada KOLİ geliyorsa çevrim koli bilgisinden türer (Fable: aynı bilgi iki yerde tutulup çelişmesin)."""
    if birim not in BIRIMLER:
        raise HTTPException(400, "Sayım birimi: " + " / ".join(BIRIMLER))
    if fatura_birim in (None, "", birim):
        return None, None, None
    if fatura_birim not in FATURA_BIRIMLER:
        raise HTTPException(400, "Faturadaki birim: " + " / ".join(FATURA_BIRIMLER))
    if fatura_birim == "koli":
        if not koli_ici:
            raise HTTPException(400, f"Faturada koli geliyor — '1 koli kaç {birim}' yaz")
        return "koli", None, int(koli_ici)
    for v in (sayim_ici, fatura_ici):
        if v is not None and not 2 <= int(v) <= 100000:
            raise HTTPException(400, "Çevrim sayısı 2 ya da daha fazla olmalı")
    if bool(sayim_ici) == bool(fatura_ici):
        raise HTTPException(400, f"Faturada '{fatura_birim}' geliyor: ya '1 {birim} kaç {fatura_birim}' ya da '1 {fatura_birim} kaç {birim}' — birini yaz")
    return fatura_birim, (int(sayim_ici) if sayim_ici else None), (int(fatura_ici) if fatura_ici else None)


def _kdv_koli(kdv_oran, koli_ici) -> None:
    """Codex: HTTP ucu da PUBLIC servis de aynı sınır — KDV yalnız %0/%1/%10/%20, koli 2–10000."""
    if kdv_oran is not None and Decimal(str(kdv_oran)).quantize(Decimal("0.01")) not in KDV_ORANLARI:
        raise HTTPException(400, "KDV oranı: %0 · %1 · %10 · %20")
    if koli_ici is not None and not 2 <= int(koli_ici) <= 10000:
        raise HTTPException(400, "1 koli kaç? (2 ya da daha fazla; koliyle gelmiyorsa boş bırak)")


def urun_olustur(cur, kategori_id: str, ad: str, kim: str, koli_ici: Optional[int] = None, kdv_oran=None,
                 aktif: bool = True, birim_teyit: bool = True, birim: str = "adet", fatura_birim: Optional[str] = None,
                 sayim_ici: Optional[int] = None, fatura_ici: Optional[int] = None, takip: str = "sayim") -> dict:
    """PUBLIC servis: yeni ürün + iz. Çağıranın işleminde çalışır (ya tam ya hiç)."""
    _hazirla()
    ad = " ".join(str(ad or "").split())[:120]
    if len(ad) < 2:
        raise HTTPException(400, "Ürün adı en az 2 harf")
    fatura_birim, sayim_ici, fatura_ici = _cevrim(birim, koli_ici, fatura_birim, sayim_ici, fatura_ici)
    if takip not in TAKIPLER:
        raise HTTPException(400, "Takip: " + " / ".join(TAKIPLER))
    _kdv_koli(kdv_oran, koli_ici)
    cur.execute("SELECT 1 FROM ey_urun_kategori WHERE id=%s AND aktif FOR SHARE", (kategori_id,))
    if not kategori_id or not cur.fetchone():
        raise HTTPException(400, "Kategori seç")
    cur.execute("SELECT pg_advisory_xact_lock(7012042)")   # eşzamanlı iki ekleme çift ürün açmasın
    _ayni_ad(cur, kategori_id, ad, None)
    cur.execute("SELECT COALESCE(MAX(sira), 0) + 10 AS s FROM ey_urun WHERE kategori_id=%s", (kategori_id,))
    sira = int(dict(cur.fetchone())["s"])
    uid = str(uuid.uuid4())
    cur.execute("""INSERT INTO ey_urun (id, ad, kategori_id, birim, birim_teyit, koli_ici, kdv_oran, aktif, sira, fatura_birim, sayim_ici, fatura_ici, takip)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (uid, ad, kategori_id, birim, bool(birim_teyit) or koli_ici is not None, koli_ici, kdv_oran, bool(aktif), sira,
                 fatura_birim, sayim_ici, fatura_ici, takip))
    cur.execute("INSERT INTO ey_urun_iz (id, urun_id, alan, eski, yeni, kim) VALUES (%s,%s,'olusturma',NULL,%s,%s)",
                (str(uuid.uuid4()), uid, json.dumps({"ad": ad, "birim": birim, "koli_ici": koli_ici, "fatura_birim": fatura_birim, "sayim_ici": sayim_ici, "fatura_ici": fatura_ici, "takip": takip, "kdv_oran": None if kdv_oran is None else str(kdv_oran),
                                                     "aktif": bool(aktif)}, ensure_ascii=False), kim))
    return {"id": uid, "ad": ad, "kategori_id": kategori_id}


# ─────────────────────────── UÇLAR ───────────────────────────
@router.get("/katalog")
def katalog_ucu(hepsi: bool = True):
    with db() as (conn, cur):
        k = katalog(cur, hepsi=hepsi)
        cur.execute("SELECT COUNT(*) AS n FROM ey_urun WHERE aktif AND NOT birim_teyit")
        belirsiz = int(dict(cur.fetchone())["n"])
    return {"kategoriler": k, "birim_belirsiz": belirsiz, "birimler": list(BIRIMLER), "fatura_birimleri": list(FATURA_BIRIMLER)}


class KategoriBody(BaseModel):
    ad: str
    emoji: Optional[str] = None
    aktif: bool = True


def _kategori_dogrula(cur, b: KategoriBody, haric: Optional[str]) -> str:
    ad = " ".join(b.ad.split())[:60]
    if len(ad) < 2:
        raise HTTPException(400, "Kategori adı en az 2 harf")
    cur.execute("SELECT id, ad FROM ey_urun_kategori WHERE aktif")
    for r in cur.fetchall() or []:
        if dict(r)["id"] != haric and _n(dict(r)["ad"]) == _n(ad):
            raise HTTPException(409, f"Bu adla kategori var: {dict(r)['ad']}")
    return ad


@router.post("/kategori")
def kategori_ekle(b: KategoriBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    _hazirla()
    with db() as (conn, cur):
        _aktor(cur, x_evvel_oturum)
        cur.execute("SELECT pg_advisory_xact_lock(7012043)")
        ad = _kategori_dogrula(cur, b, None)
        cur.execute("SELECT COALESCE(MAX(sira), 0) + 10 AS s FROM ey_urun_kategori")
        kid = str(uuid.uuid4())
        cur.execute("INSERT INTO ey_urun_kategori (id, ad, emoji, sira, aktif) VALUES (%s,%s,%s,%s,TRUE)",
                    (kid, ad, (b.emoji or "").strip()[:4] or None, int(dict(cur.fetchone())["s"])))
    return {"ok": True, "id": kid, "mesaj": f"{ad} kategorisi eklendi"}


@router.post("/kategori/{kid}")
def kategori_duzelt(kid: str, b: KategoriBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    _hazirla()
    with db() as (conn, cur):
        _aktor(cur, x_evvel_oturum)
        cur.execute("SELECT pg_advisory_xact_lock(7012043)")   # Codex: ekleme ile aynı kilit — iki kategori aynı ada dönmesin
        cur.execute("SELECT 1 FROM ey_urun_kategori WHERE id=%s FOR UPDATE", (kid,))
        if not cur.fetchone():
            raise HTTPException(404, "Kategori bulunamadı")
        ad = _kategori_dogrula(cur, b, kid) if b.aktif else " ".join(b.ad.split())[:60]
        if len(ad) < 2:
            raise HTTPException(400, "Kategori adı en az 2 harf")
        if not b.aktif:
            cur.execute("SELECT COUNT(*) AS n FROM ey_urun WHERE kategori_id=%s AND aktif", (kid,))
            if int(dict(cur.fetchone())["n"]):
                raise HTTPException(409, "Kategoride kullanımdaki ürün var — önce ürünleri taşı ya da pasif yap")
        cur.execute("UPDATE ey_urun_kategori SET ad=%s, emoji=%s, aktif=%s WHERE id=%s", (ad, (b.emoji or "").strip()[:4] or None, b.aktif, kid))
    return {"ok": True, "mesaj": "Kaydedildi"}


class UrunBody(BaseModel):
    ad: str
    kategori_id: str
    birim: str = "adet"
    koli_ici: Optional[int] = None
    kdv_oran: Optional[Decimal] = None     # 0.01 · 0.10 · 0.20
    aktif: bool = True
    fatura_birim: Optional[str] = None     # boş = sayım birimiyle aynı
    sayim_ici: Optional[int] = None        # 1 sayım birimi = N fatura adedi (peçete 1 paket = 50 adet)
    fatura_ici: Optional[int] = None       # 1 fatura birimi = N sayım birimi (Z peçete 1 koli = 12 paket)
    takip: str = "sayim"                   # sayim · acilinca
    panel_sayim: Optional[bool] = None     # açılış / kapanışta sayılır — boş = değiştirme (eski istemciler sıfırlamasın)


def _dogrula(b: UrunBody) -> None:
    if not b.ad.strip():
        raise HTTPException(400, "Ürünün adını yaz")
    if b.birim not in BIRIMLER:
        raise HTTPException(400, "Sayım birimi: " + " / ".join(BIRIMLER))
    if b.koli_ici is not None and not 2 <= int(b.koli_ici) <= 10000:
        raise HTTPException(400, "1 koli kaç adet? (2 ya da daha fazla; koliyle gelmiyorsa boş bırak)")
    _kdv_koli(b.kdv_oran, b.koli_ici)
    b.fatura_birim, b.sayim_ici, b.fatura_ici = _cevrim(b.birim, b.koli_ici, b.fatura_birim, b.sayim_ici, b.fatura_ici)
    if b.takip not in TAKIPLER:
        raise HTTPException(400, "Takip: " + " / ".join(TAKIPLER))


@router.post("")
def urun_ekle(b: UrunBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    _hazirla()
    _dogrula(b)
    with db() as (conn, cur):
        kim = _aktor(cur, x_evvel_oturum)
        r = urun_olustur(cur, b.kategori_id, b.ad, kim, koli_ici=b.koli_ici, kdv_oran=b.kdv_oran, aktif=b.aktif, birim=b.birim,
                         fatura_birim=b.fatura_birim, sayim_ici=b.sayim_ici, fatura_ici=b.fatura_ici, takip=b.takip)
        if b.panel_sayim:
            cur.execute("UPDATE ey_urun SET panel_sayim=TRUE WHERE id=%s", (r["id"],))
    return {"ok": True, "id": r["id"], "mesaj": f"{r['ad']} eklendi"}


@router.post("/{uid}")
def urun_duzelt(uid: str, b: UrunBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Değişen her alan ayrı iz kaydı. Kaydetmek birimi TEYİT eder (değişmese bile)."""
    _hazirla()
    _dogrula(b)
    with db() as (conn, cur):
        kim = _aktor(cur, x_evvel_oturum)
        cur.execute("SELECT * FROM ey_urun WHERE id=%s FOR UPDATE", (uid,))
        e = cur.fetchone()
        if not e:
            raise HTTPException(404, "Ürün bulunamadı")
        e = dict(e)
        cur.execute("SELECT 1 FROM ey_urun_kategori WHERE id=%s AND aktif FOR SHARE", (b.kategori_id,))
        if not cur.fetchone():
            raise HTTPException(400, "Kategori seç")
        yeni = {"ad": " ".join(b.ad.split())[:120], "kategori_id": b.kategori_id, "birim": b.birim, "koli_ici": b.koli_ici,
                "kdv_oran": b.kdv_oran, "aktif": b.aktif, "fatura_birim": b.fatura_birim, "sayim_ici": b.sayim_ici, "fatura_ici": b.fatura_ici, "takip": b.takip,
                "panel_sayim": bool(e.get("panel_sayim")) if b.panel_sayim is None else bool(b.panel_sayim)}

        def _es(a, b_):
            if a is None or b_ is None:
                return a is None and b_ is None
            if isinstance(a, (Decimal, float)) or isinstance(b_, (Decimal, float)):
                return Decimal(str(a)).quantize(Decimal("0.0001")) == Decimal(str(b_)).quantize(Decimal("0.0001"))
            return str(a) == str(b_)
        degisen = [k for k, v in yeni.items() if not _es(e.get(k), v)]
        if b.aktif and ("ad" in degisen or "kategori_id" in degisen or "aktif" in degisen):
            cur.execute("SELECT pg_advisory_xact_lock(7012042)")
            _ayni_ad(cur, b.kategori_id, yeni["ad"], uid)
        # Fable (altyapı #6): BİRİM KİLİDİ — yeni panel ey_urun kimliğiyle hareket yazıyor; hareket görmüş ürünün birim/çevrim
        # alanları değişirse eski adetlerin anlamı kayar → 409. Depo kapalıysa (tak-çıkar) kilit uygulanamaz, sessiz geçilir.
        birim_alanlari = {"birim", "sayim_ici", "fatura_ici", "koli_ici", "fatura_birim"}
        if birim_alanlari & set(degisen):
            try:
                from evvel_yeni_moduller import DURUM
                hareketli = False
                if DURUM.get("depo") == "yuklendi":   # Fable: depo kapalıysa (tak-çıkar) gerçekten atla
                    from evvel_yeni_depo_api import urun_hareketi_var
                    hareketli = urun_hareketi_var(cur, uid)
            except HTTPException:
                raise
            except Exception:  # noqa: BLE001
                hareketli = False
            if hareketli:
                raise HTTPException(409, "Bu ürünün stok hareketi var — birimi / koli içeriği değiştirilemez. Yeni ürün aç, bunu pasifleştir.")
        if not degisen and e["birim_teyit"]:
            return {"ok": True, "mesaj": "Değişiklik yok"}
        cur.execute("""UPDATE ey_urun SET ad=%s, kategori_id=%s, birim=%s, birim_teyit=TRUE, koli_ici=%s, kdv_oran=%s, aktif=%s,
                              fatura_birim=%s, sayim_ici=%s, fatura_ici=%s, takip=%s, panel_sayim=%s WHERE id=%s""",
                    (yeni["ad"], b.kategori_id, b.birim, b.koli_ici, b.kdv_oran, b.aktif, b.fatura_birim, b.sayim_ici, b.fatura_ici, b.takip,
                     yeni["panel_sayim"], uid))
        for k in degisen + ([] if e["birim_teyit"] else ["birim_teyit"]):
            cur.execute("INSERT INTO ey_urun_iz (id, urun_id, alan, eski, yeni, kim) VALUES (%s,%s,%s,%s,%s,%s)",
                        (str(uuid.uuid4()), uid, k, None if e.get(k) is None else str(e.get(k)),
                         "TRUE" if k == "birim_teyit" else (None if yeni.get(k) is None else str(yeni.get(k))), kim))
    return {"ok": True, "mesaj": "Kaydedildi" + (" (birim teyit edildi)" if not e["birim_teyit"] else "")}


@router.get("/{uid}/iz")
def urun_iz(uid: str):
    _hazirla()
    with db() as (conn, cur):
        cur.execute("SELECT alan, eski, yeni, kim, zaman FROM ey_urun_iz WHERE urun_id=%s ORDER BY zaman DESC, alan", (uid,))
        return {"iz": [{**dict(r), "zaman": str(dict(r)["zaman"])[:16]} for r in cur.fetchall() or []]}


def _bekleyen(cur, baglam: dict) -> list:
    """Bekleyen işler › Tedarik & depo: birimi teyit edilmemiş aktif ürünler (tek satır)."""
    _hazirla()
    cur.execute("SELECT COUNT(*) AS n FROM ey_urun WHERE aktif AND NOT birim_teyit")
    n = int(dict(cur.fetchone())["n"])
    if not n:
        return []
    from evvel_yeni_cekirdek import bugun
    return [{"tur": "urun_birim", "genel": True, "grup": "tedarik", "id": "urun_birim", "tarih": bugun().isoformat(),
             "etiket": "📚 Birim belirsiz", "ad": f"{n} üründe koli bilgisi teyit edilmedi",
             "alt": "Ürünler'de ürünü açıp 'kaydet' — koliyle geliyorsa 1 koli kaç adet", "sayfa": "urunler", "dugme": "Ürünler"}]


bekleyen_is_kaydet("urun_birim", _bekleyen)
