"""🚚 EVVEL YENİ · TOPTANCILAR (2026-10-16) — genel hatlar. Sahip + Codex + Fable kurgusu.

Sahip: mal hem depoya hem şubeye gelir · borç TESLİMDE doğar · fatura bazen gelir bazen gelmez · ödeme çoğu vadeli,
genelde kartla (Ödeme formundan) · sipariş AYRI alan · teslimi ŞUBE PANELİ girer; fatura geldiyse tutarı yazar,
gelmediyse kâğıtta fiyat yoksa tutarı göremez.

TEK KAYIT = TESLİM (ey_toptanci_teslim). İçinde hem TAHMİNİ hem KESİN tutar:
  · kesin_tutar: şubenin yazdığı fatura/fiş tutarı ya da merkezin sonradan girdiği → borç bu.
  · tahmini: adet × birim fiyat (önce bu toptancının önceki kesinleşmiş teslimlerinden çıkan birim fiyat,
    yoksa ürünün son alış fiyatı KDV dahil, yoksa katalog) — fiyatı olmayan kalem UYDURULMAZ ("fiyat eksik").
  · Fatura gelince AYNI kaydın kesin_tutarı dolar → yeni borç açılmaz → çift sayım yapısal olarak imkânsız
    (eski Evvel'in GRNI + fatura çift sayımı burada olamaz).
BORÇ = açılış + Σ(kesin ya da tahmini) − Σ ödeme (Ödeme formu, konu=Toptancı). Ekranda kesin · tahmini · tutarı
bilinmeyen ayrı. Vadesi geçen = ödemeler en eski borçtan düşülerek EKRANDA hesaplanır (hiçbir yere yazılmaz; FIFO sonra).
Sapma: kesin tutar tahminden %30+ farklıysa uyarı (koli/adet karışmış olabilir).
"""

import json
import logging
import uuid
from datetime import date, timedelta
from decimal import Decimal
from typing import List, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from database import db, savepoint
from evvel_yeni_kasa_api import kasa_hazirla as _hazirla, kasa_kayitlari as _yukle
from evvel_yeni_cekirdek import merkez_aktor
from evvel_yeni_cekirdek import aktor as _aktor, bugun as _bugun, kurus as _kurus, tl_sayi as _tl_sayi, bekleyen_is_kaydet

router = APIRouter(prefix="/api/evvel-yeni/toptanci", tags=["evvel-yeni-toptanci"])
log = logging.getLogger(__name__)
_HAZIR = False
SAPMA_ORAN = 0.30
BILINMEYEN_UYARI_GUN = 7


def _kr(x) -> int:
    """Kuruşa YUVARLAYARAK çevir (KDV / oran çarpımı) — çekirdek kurus_yuvarla (Dalga 4, F#5: aynısının kopyasıydı)."""
    from evvel_yeni_cekirdek import kurus_yuvarla
    return kurus_yuvarla(x)


def _kdv_kesir(oran) -> Decimal:
    """kalem_kdv_oran KESİR saklıyor (0.10 = %10); yüzde (10) gelirse çevir. Önceki '/100' KDV'yi binde bire indiriyordu
    (Espresso 750 ₺ + %1 = 757,50 olmalıyken 750,75 gösteriyordu)."""
    o = Decimal(str(oran or 0))
    return o / 100 if o >= 1 else o


def toptanci_hazirla(cur) -> None:
    """Canlı 503 dersi (2026-10-19): ayrı bağlantı (havuz dolu / kilit) düşüyordu → hazırlık ÇAĞIRANIN işleminde, SAVEPOINT +
    kısa lock_timeout ile ve yalnız EKSİK olanı kurar. Bayrak ancak bir SONRAKİ çağrıda nesneler (işlenmiş) görülünce açılır —
    çağıranın işlemi geri alınsa da 'tablo yok + bayrak açık' kalmaz (Fable E1 #1)."""
    global _HAZIR
    if _HAZIR:
        return
    if (__import__("evvel_yeni_cekirdek").tablo_var(cur, "ey_toptanci_belge", "idx_ey_top_belge", "ey_urun_fiyat_gecmis", "ey_toptanci_teslim")
            and _kolon_var(cur, "ey_toptanci_belge", "iptal_zaman") and _kolon_var(cur, "ey_toptanci", "vade_gun")):
        _HAZIR = True
        return
    try:
        with savepoint(cur, "sp_ey_toptanci_hazirla"):
            cur.execute("SET LOCAL lock_timeout = '3s'")
            _toptanci_ddl(cur)
            cur.execute("SET LOCAL lock_timeout = DEFAULT")
    except Exception:  # noqa: BLE001 — kilit beklemesi vb.: ana tablolar varsa ekran AÇIK kalır, sonraki istek yine dener
        log.warning("toptancı hazırlığı yapılamadı — ana tablolar varsa devam", exc_info=True)
        if not _var(cur, "ey_toptanci_teslim"):
            raise HTTPException(503, "Toptancı tabloları hazırlanamadı — birazdan tekrar dene")


def _kolon_var(cur, tablo: str, kolon: str) -> bool:
    cur.execute("SELECT 1 FROM information_schema.columns WHERE table_name=%s AND column_name=%s", (tablo, kolon))
    return cur.fetchone() is not None


def _var(cur, ad: str) -> bool:
    return __import__("evvel_yeni_cekirdek").tablo_var(cur, ad)   # çekirdek (F#14)


def _toptanci_ddl(cur) -> None:
    """Yalnız EKSİK olanı kurar — var olan tabloya ALTER / INDEX kilidi istenmez (canlı 503 dersi, 2026-10-19)."""
    if not _var(cur, "ey_toptanci"):
        from evvel_yeni_tanim_api import tanim_hazirla
        tanim_hazirla(cur)
    if not _kolon_var(cur, "ey_toptanci", "vade_gun"):   # vade_gun Tanımlar'da tanımlı (tek şema sahibi — Dalga 3)
        from evvel_yeni_tanim_api import tanim_hazirla
        tanim_hazirla(cur)
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_toptanci_teslim (
        id TEXT PRIMARY KEY, kaynak_ref TEXT UNIQUE, toptanci_id TEXT NOT NULL, toptanci_ad TEXT,
        sube_id TEXT, tarih DATE NOT NULL, kalemler JSONB NOT NULL DEFAULT '[]'::jsonb,
        tahmini BIGINT, fiyat_eksik INT NOT NULL DEFAULT 0,
        fatura_geldi BOOLEAN, kesin_tutar BIGINT, fatura_no TEXT, kesin_kaynak TEXT,
        teslim_alan TEXT, aciklama TEXT, iptal BOOLEAN NOT NULL DEFAULT FALSE, iptal_sebep TEXT,
        iz JSONB NOT NULL DEFAULT '[]'::jsonb, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    # Sahip (2026-10-16): "ürün fiyatlarını paneldeki kategori şekliyle kur; fiyatı olmayanı elle girebilelim" (KDV dahil, kuruş)
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_urun_fiyat (
        urun_id TEXT PRIMARY KEY, birim BIGINT NOT NULL, girilen TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_toptanci_fiyat (
        toptanci_id TEXT NOT NULL, urun_anahtar TEXT NOT NULL, birim BIGINT NOT NULL, tarih DATE NOT NULL,
        kaynak TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (toptanci_id, urun_anahtar))""")
    # Fable (altyapı #3): TARİHLİ fiyat geçmişi — YALNIZ EKLENİR (silinmez, ezilmez). "O gün geçerli fiyat" buradan okunur.
    # tur: 'elle' (merkez girdi; birim NULL = elle fiyat o günden itibaren kaldırıldı) · 'toptanci' (kesin tutardan öğrenilen).
    # Sözleşme: birim = KURUŞ, KDV DAHİL, 1 SAYIM BİRİMİ (yeni katalog). Eski kimlikli kayıtlar eski birimdedir.
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_urun_fiyat_gecmis (
        id TEXT PRIMARY KEY, urun_id TEXT NOT NULL, tur TEXT NOT NULL, toptanci_id TEXT, birim BIGINT, tarih DATE NOT NULL,
        kaynak TEXT, girilen TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    if not _var(cur, "idx_ey_fiyat_g"):
        cur.execute("CREATE INDEX IF NOT EXISTS idx_ey_fiyat_g ON ey_urun_fiyat_gecmis (urun_id, tur, tarih DESC, zaman DESC)")
    # E1 (sahip onayı 2026-10-19): fatura belgesi TESLİMİN EKİ — ayrı fatura nesnesi / OCR / eşleştirme YOK (eski hastalık).
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_toptanci_belge (
        id TEXT PRIMARY KEY, teslim_id TEXT NOT NULL, sayfa INT NOT NULL, mime TEXT NOT NULL, boyut INT NOT NULL, veri BYTEA NOT NULL,
        sha256 TEXT NOT NULL, yukleyen TEXT, kaynak TEXT NOT NULL, iptal BOOLEAN NOT NULL DEFAULT FALSE, iptal_kim TEXT, iptal_zaman TIMESTAMPTZ,
        zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    for k_, t_ in (("iptal_kim", "TEXT"), ("iptal_zaman", "TIMESTAMPTZ")):
        if not _kolon_var(cur, "ey_toptanci_belge", k_):
            cur.execute(f"ALTER TABLE ey_toptanci_belge ADD COLUMN IF NOT EXISTS {k_} {t_}")
    if not _var(cur, "idx_ey_top_belge"):
        cur.execute("CREATE INDEX IF NOT EXISTS idx_ey_top_belge ON ey_toptanci_belge (teslim_id) WHERE NOT iptal")
    from evvel_yeni_cekirdek import ayar_oku, ayar_yaz
    if not ayar_oku(cur, "fiyat_gecmis_kopya"):   # bir kez: bugünkü fiyatlar 1 Ekim'den geçerli ilk satır olur
        _idler = __import__("evvel_yeni_urun_api").urun_idleri(cur)   # Ürün'ün PUBLIC kapısı (Codex P2: ey_urun JOIN'i kalktı)
        cur.execute("""INSERT INTO ey_urun_fiyat_gecmis (id, urun_id, tur, birim, tarih, kaynak, girilen)
                       SELECT 'fg-' || md5(f.urun_id || ':ilk'), f.urun_id, 'elle', f.birim, DATE '2026-10-01', 'ilk kopya (ey_urun_fiyat)', f.girilen
                         FROM ey_urun_fiyat f WHERE f.urun_id = ANY(%s) ON CONFLICT (id) DO NOTHING""", (_idler,))   # Fable: eski kimlik kopyalanmaz
        cur.execute("""INSERT INTO ey_urun_fiyat_gecmis (id, urun_id, tur, toptanci_id, birim, tarih, kaynak)
                       SELECT 'fg-' || md5(toptanci_id || ':' || urun_anahtar || ':ilk'), urun_anahtar, 'toptanci', toptanci_id, birim, tarih,
                              'ilk kopya (' || COALESCE(kaynak, 'toptancı') || ')'
                         FROM ey_toptanci_fiyat f WHERE f.urun_anahtar = ANY(%s) ON CONFLICT (id) DO NOTHING""", (_idler,))
        ayar_yaz(cur, "fiyat_gecmis_kopya", "1", "kurulum")


def _fiyat_gecmis_yaz(cur, urun_id: str, tur: str, birim: Optional[int], tarih: date, kaynak: str,
                      toptanci_id: Optional[str] = None, girilen: Optional[str] = None) -> None:
    cur.execute("""INSERT INTO ey_urun_fiyat_gecmis (id, urun_id, tur, toptanci_id, birim, tarih, kaynak, girilen)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                ("fg-" + uuid.uuid4().hex[:16], str(urun_id), tur, toptanci_id, birim, tarih, kaynak, girilen))


from evvel_yeni_cekirdek import ad_anahtari as _n  # noqa: E402 — ad anahtarı TEK yerde (F#6)


def _anahtar(k: dict) -> str:
    uid = str(k.get("urun_id") or "").strip()
    if uid:
        return uid
    return "ad:" + _n(k.get("urun_ad") or k.get("ad") or "")


def _tahmin(cur, toptanci_id: str, kalemler: List[dict], gun: date):
    """Kalem kalem adet × birim (kuruş, KDV dahil). Dönüş: (kalem satırları, tahmini toplam | None, fiyat_eksik sayısı)."""
    satir, eksik, top = [], 0, 0
    kalemler = [dict(k) for k in kalemler]
    adsiz = [k for k in kalemler if not k.get("urun_id") and (k.get("urun_ad") or k.get("ad"))]
    from evvel_yeni_cekirdek import yeni_donem as _yd
    if adsiz and _yd(cur):   # yeni dönem: ad çözümü YENİ katalogdan (eski kimlik sızmasın)
        from evvel_yeni_urun_api import katalog as _kat
        _ad = {_n(u["ad"]): str(u["id"]) for kk in _kat(cur) for u in kk["urunler"]}
        for k in adsiz:
            n = _n(k.get("urun_ad") or k.get("ad"))
            if n in _ad:
                k["urun_id"] = _ad[n]
        adsiz = []
    if adsiz:   # geçiş: panel kalemi urun_id taşımazsa ADIYLA eski katalogdan bul (yoksa gereksiz "fiyat yok")
        try:
            with savepoint(cur, "sp_ey_top_ad"):
                cur.execute("SELECT id::text AS id, ad FROM siparis_urun WHERE aktif")
                ad_id = {_n(dict(x)["ad"]): dict(x)["id"] for x in cur.fetchall() or []}
                for k in adsiz:
                    n = _n(k.get("urun_ad") or k.get("ad"))
                    if n in ad_id:
                        k["urun_id"] = ad_id[n]
        except Exception:  # noqa: BLE001
            pass
    anahtarlar = [_anahtar(k) for k in kalemler]
    tf = {}
    cur.execute("SELECT urun_anahtar, birim FROM ey_toptanci_fiyat WHERE toptanci_id=%s AND urun_anahtar = ANY(%s)",
                (toptanci_id, anahtarlar))
    for r in cur.fetchall() or []:
        tf[dict(r)["urun_anahtar"]] = int(dict(r)["birim"])
    genel, kdv, katalog, elle = {}, {}, {}, {}
    idler = [str(k.get("urun_id")) for k in kalemler if k.get("urun_id")]
    if idler:
        cur.execute("SELECT urun_id, birim FROM ey_urun_fiyat WHERE urun_id = ANY(%s)", (idler,))
        elle = {dict(r)["urun_id"]: int(dict(r)["birim"]) for r in cur.fetchall() or []}
    from evvel_yeni_urun_api import urun_bilgi
    yeni_k = set(urun_bilgi(cur, [i for i in idler]))   # yeni katalog kimlikleri → tek fiyat servisi (fiyat_bilgi, o gün geçerli)
    eski_idler = [i for i in idler if i not in yeni_k]
    if eski_idler and not _yd(cur):   # F#39: eski fiyat kaynakları YALNIZ geçişte ve yalnız eski kimlikler için (kesimden sonra hiç sorulmaz)
        try:
            with savepoint(cur, "sp_ey_top_fiyat"):
                cur.execute("SELECT id::text AS id, depo_stok_kalem_kodu, birim_fiyat_tl FROM siparis_urun WHERE id::text = ANY(%s)", (eski_idler,))
                urun = {dict(r)["id"]: dict(r) for r in cur.fetchall() or []}
                kodlar = set(eski_idler) | {u["depo_stok_kalem_kodu"] for u in urun.values() if u.get("depo_stok_kalem_kodu")}
                cur.execute("""SELECT DISTINCT ON (kalem_kodu) kalem_kodu, birim_maliyet_tl FROM urun_alis_fiyat
                                WHERE kalem_kodu = ANY(%s) AND birim_maliyet_tl > 0 AND gecerli_baslangic <= %s
                                ORDER BY kalem_kodu, gecerli_baslangic DESC, created_at DESC""", (list(kodlar), gun))
                af = {dict(r)["kalem_kodu"]: Decimal(dict(r)["birim_maliyet_tl"]) for r in cur.fetchall() or []}
                cur.execute("SELECT kalem_kodu, kdv_oran FROM kalem_kdv_oran WHERE kalem_kodu = ANY(%s)", (list(kodlar),))
                ko = {dict(r)["kalem_kodu"]: Decimal(dict(r)["kdv_oran"] or 0) for r in cur.fetchall() or []}
                for uid in eski_idler:
                    u = urun.get(uid) or {}
                    for kod in (uid, u.get("depo_stok_kalem_kodu")):
                        if kod and kod in af:
                            genel[uid] = af[kod]
                            kdv[uid] = ko.get(kod, ko.get(uid))
                            break
                    if u.get("birim_fiyat_tl"):
                        katalog[uid] = Decimal(u["birim_fiyat_tl"])
        except Exception as e:  # noqa: BLE001
            log.warning("toptancı tahmin: fiyat okunamadı: %s", str(e)[:150])
    for k, an in zip(kalemler, anahtarlar):
        adet = int(k.get("adet") or 0)
        uid = str(k.get("urun_id") or "")
        birim, fk = None, None
        if uid in yeni_k:   # F#18: yeni katalogda TEK fiyat kuralı (Ürün fiyatları ekranıyla AYNI), bu toptancının fiyatıyla
            f_ = fiyat_bilgi(cur, uid, gun, toptanci_id) or fiyat_bilgi(cur, uid, gun)
            if f_:
                birim, fk = f_["kurus"], f"{f_['kaynak']} fiyatı"
        elif an in tf:   # eski kimlik / ad anahtarı (geçiş) — tarihsiz toptancı fiyatı
            birim, fk = tf[an], "bu toptancının önceki faturası"
        elif uid in elle:
            birim, fk = elle[uid], "elle girilen fiyat"
        elif uid in genel:
            oran = (kdv.get(uid) if kdv.get(uid) is not None else Decimal(0))
            birim, fk = _kr(genel[uid] * (1 + _kdv_kesir(oran))), "son alış fiyatı" + ("" if kdv.get(uid) is not None else " (KDV oranı yok)")
        elif uid in katalog:
            birim, fk = _kr(katalog[uid]), "katalog"
        t = birim * adet if birim is not None else None
        if t is None:
            eksik += 1
        else:
            top += t
        satir.append({"urun_id": uid or None, "anahtar": an, "ad": k.get("urun_ad") or k.get("ad"), "adet": adet,
                      "birim": _tl_sayi(birim) if birim is not None else None, "tutar": _tl_sayi(t) if t is not None else None, "fk": fk})
    return satir, (top if satir and eksik < len(satir) else None), eksik


def _fiyat_ogren(cur, t: dict, gun: date) -> None:
    """Kesin tutar gelince bu toptancı için birim fiyatları öğren (tahmin oranına göre dağıt; tek ürünse tutar ÷ adet)."""
    kal = __import__("evvel_yeni_cekirdek").json_ac(t["kalemler"], [])
    kesin = t.get("kesin_tutar")
    if not kal or not kesin:
        return
    if t.get("tahmini") and abs(kesin - int(t["tahmini"])) / int(t["tahmini"]) > SAPMA_ORAN:
        return   # Fable: %30+ sapma = birim karışmış olabilir → bu tutardan fiyat ÖĞRENME (sonraki tahminler bozulmasın)
    if len(kal) == 1 and kal[0].get("adet"):
        birimler = {kal[0]["anahtar"]: int(round(kesin / int(kal[0]["adet"])))}
    elif t.get("tahmini") and all(x.get("tutar") is not None for x in kal):
        oran = kesin / int(t["tahmini"])
        birimler = {x["anahtar"]: int(round(_kr(x["birim"]) * oran)) for x in kal if x.get("adet")}
    else:
        return
    from evvel_yeni_urun_api import urun_bilgi
    yeni_idler = set(urun_bilgi(cur, [a for a in birimler if not str(a).startswith("ad:")]))   # Fable: geçmişe yalnız ey_urun kimliği
    for an, b in birimler.items():
        if b > 0 and an in yeni_idler:
            _fiyat_gecmis_yaz(cur, an, "toptanci", b, gun, f"kesin tutar · teslim {t.get('id') or ''}".strip(" ·"), toptanci_id=t["toptanci_id"])
        if b > 0:
            cur.execute("""INSERT INTO ey_toptanci_fiyat (toptanci_id, urun_anahtar, birim, tarih, kaynak) VALUES (%s,%s,%s,%s,'kesin tutar')
                           ON CONFLICT (toptanci_id, urun_anahtar) DO UPDATE SET birim=EXCLUDED.birim, tarih=EXCLUDED.tarih, zaman=NOW()
                           WHERE ey_toptanci_fiyat.tarih <= EXCLUDED.tarih""", (t["toptanci_id"], an, b, gun))


def fiyat_bilgi(cur, urun_id: str, gun: Optional[date] = None, toptanci_id: Optional[str] = None) -> Optional[dict]:
    """PUBLIC — TEK FİYAT KURALI, SÖZLEŞMELİ: {kurus, kdv_dahil: True, birim: 'sayim', kaynak, tarih} ya da None.
    O GÜN geçerli fiyat (tarihli geçmişten): o güne kadar öğrenilen en yeni TOPTANCI fiyatı → yoksa o güne kadar en yeni ELLE fiyat
    (kaldırıldıysa yok) → geçmişte hiç satır yoksa bugünkü tablo (eski kimlik / geçiş). Okuyan modül KDV EKLEMEZ.
    toptanci_id verilirse (teslim tahmini — tekrar denetimi F#18/C-T1-13: tahmin ayrı kuralla ey_toptanci_fiyat'ı ÖNCE okuyordu):
    AYNI kural, yalnız BAŞKA toptancıların öğrenilmiş fiyatları yok sayılır (elle fiyat yine en yeniyse kazanır)."""
    toptanci_hazirla(cur)
    uid = str(urun_id or "").strip()
    if not uid:
        return None
    g = gun or _bugun()
    # Fable: o güne kadar EN YENİ satır kazanır (toptancıdan öğrenilen ya da merkezin elle girdiği) — elle düzeltme toptancı fiyatını
    # ezebilir; en yeni satır "elle kaldırıldı" ise toptancının o güne kadarki en yeni fiyatına düşülür.
    tq, tp = ("", ()) if not toptanci_id else (" AND (tur <> 'toptanci' OR toptanci_id = %s)", (str(toptanci_id),))
    cur.execute(f"""SELECT tur, birim, tarih FROM ey_urun_fiyat_gecmis WHERE urun_id=%s AND tarih <= %s{tq}
                    ORDER BY tarih DESC, zaman DESC LIMIT 1""", (uid, g) + tp)
    r = cur.fetchone()
    if r and dict(r)["birim"] is not None:
        r = dict(r)
        return {"kurus": int(r["birim"]), "kdv_dahil": True, "birim": "sayim", "kaynak": "toptancı" if r["tur"] == "toptanci" else "elle",
                "tarih": r["tarih"].isoformat()}
    if r:   # en yeni = elle fiyat kaldırıldı
        cur.execute(f"""SELECT birim, tarih FROM ey_urun_fiyat_gecmis WHERE urun_id=%s AND tur='toptanci' AND tarih <= %s AND birim IS NOT NULL{tq}
                        ORDER BY tarih DESC, zaman DESC LIMIT 1""", (uid, g) + tp)
        t = cur.fetchone()
        return {"kurus": int(dict(t)["birim"]), "kdv_dahil": True, "birim": "sayim", "kaynak": "toptancı",
                "tarih": dict(t)["tarih"].isoformat()} if t else None
    cur.execute("SELECT 1 FROM ey_urun_fiyat_gecmis WHERE urun_id=%s LIMIT 1", (uid,))
    if cur.fetchone():
        return None   # geçmişi var ama o gün geçerli fiyat yok (sonra girilmiş) — UYDURMA
    cur.execute("SELECT birim FROM ey_urun_fiyat WHERE urun_id=%s", (uid,))
    r = cur.fetchone()
    return {"kurus": int(dict(r)["birim"]), "kdv_dahil": True, "birim": "sayim", "kaynak": "elle", "tarih": None} if r else None


def guncel_fiyat(cur, urun_id: str, gun: Optional[date] = None) -> Optional[int]:
    """PUBLIC — TEK FİYAT KURALI (kuruş, KDV dahil): o güne kadar öğrenilen en yeni toptancı fiyatı (kesin tutardan)
    → elle girilen ürün fiyatı → yok (None: okuyan modül 'fiyatı eksik' der, uydurmaz).
    BİRİM: fiyat, kaydın girildiği birimdedir. Yeni şube panelinin kayıtları (ey_urun kimliği) SAYIM biriminde girilir → fiyat
    1 sayım birimidir. Ekim'e kadarki eski kimlikli kayıtlar eski birimdedir (Fable: çevrim yapılmış sanılmasın)."""
    f = fiyat_bilgi(cur, urun_id, gun)   # Fable: tarihli geçmişten (o gün geçerli); sözleşme fiyat_bilgi'de
    return f["kurus"] if f else None


def teslim_kalemleri(cur, teslim_idler: List[str]) -> dict:
    """PUBLIC (Sipariş takibi): {teslim_id: {urun_id: adet}} — iptal edilmiş teslim dönmez."""
    idler = sorted({str(x) for x in teslim_idler or [] if x})
    if not idler or not _var(cur, "ey_toptanci_teslim"):
        return {}
    cur.execute("SELECT id, kalemler FROM ey_toptanci_teslim WHERE id = ANY(%s) AND NOT iptal", (idler,))
    out = {}
    for r in cur.fetchall() or []:
        r = dict(r)
        ks = __import__("evvel_yeni_cekirdek").json_ac(r["kalemler"], [])
        d = out.setdefault(r["id"], {})
        for k in ks:
            d[str(k.get("urun_id"))] = d.get(str(k.get("urun_id")), 0) + int(k.get("adet") or 0)
    return out


def son_toptancilar(cur, urun_idler: List[str]) -> dict:
    """PUBLIC (Sipariş 'varsayılanları uygula'): {urun_id: toptanci_id} — ürünün EN SON teslim edildiği (iptal olmayan) toptancı."""
    idler = sorted({str(x) for x in urun_idler or [] if x})
    if not idler or not _var(cur, "ey_toptanci_teslim"):
        return {}
    cur.execute("""SELECT DISTINCT ON (k->>'urun_id') k->>'urun_id' AS u, t.toptanci_id AS t
                     FROM ey_toptanci_teslim t, jsonb_array_elements(t.kalemler) k
                    WHERE NOT t.iptal AND k->>'urun_id' = ANY(%s) ORDER BY k->>'urun_id', t.tarih DESC, t.zaman DESC""", (idler,))
    return {dict(r)["u"]: str(dict(r)["t"]) for r in cur.fetchall() or []}


def iptal_teslim_refleri(cur, bas: date, son: date, onek: str = "panel:teslim:") -> set:
    """PUBLIC (Gider): iptal edilmiş teslimlerin kaynak_ref'leri (tarih bas..son, önekli). Tablo yoksa boş."""
    if not __import__("evvel_yeni_cekirdek").tablo_var(cur, "ey_toptanci_teslim"):
        return set()
    cur.execute("SELECT kaynak_ref FROM ey_toptanci_teslim WHERE iptal AND kaynak_ref LIKE %s AND tarih BETWEEN %s AND %s",
                (onek.replace("%", r"\%").replace("_", r"\_") + "%", bas, son))
    return {dict(r)["kaynak_ref"] for r in cur.fetchall() or []}


def teslim_yaz(cur, *, kaynak_ref: str, toptanci_id: str, toptanci_ad: str, sube_id: Optional[str], gun: date,
               kalemler: List[dict], fatura_geldi: Optional[bool], kesin_tutar: Optional[int], fatura_no: Optional[str],
               teslim_alan: Optional[str], aciklama: Optional[str] = None, kesin_kaynak: str = "şube") -> Optional[str]:
    """Panel ya da merkez teslimi → tek kayıt (kaynak_ref ile bir kez)."""
    toptanci_hazirla(cur)
    # Fable: eski sistemde sonradan açılan toptancı Evvel Yeni'de yoksa teslim görünmezdi → tanımı kendiliğinden aç
    from evvel_yeni_tanim_api import toptanci_yoksa_ac   # toptancı tablosu Tanımlar'ın (F#32)
    toptanci_yoksa_ac(cur, toptanci_id, toptanci_ad, "panel teslimi")
    satir, tahmini, eksik = _tahmin(cur, toptanci_id, kalemler, gun)
    tid = "tt-" + uuid.uuid4().hex[:12]
    cur.execute("""INSERT INTO ey_toptanci_teslim (id, kaynak_ref, toptanci_id, toptanci_ad, sube_id, tarih, kalemler, tahmini, fiyat_eksik,
                        fatura_geldi, kesin_tutar, fatura_no, kesin_kaynak, teslim_alan, aciklama)
                   VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (kaynak_ref) DO NOTHING RETURNING id""",
                (tid, kaynak_ref, toptanci_id, toptanci_ad, sube_id, gun, json.dumps(satir, ensure_ascii=False), tahmini, eksik,
                 fatura_geldi, kesin_tutar, (fatura_no or "").strip()[:40] or None, kesin_kaynak if kesin_tutar else None,
                 teslim_alan, (aciklama or "").strip()[:300] or None))
    r = cur.fetchone()
    if r and kesin_tutar and kesin_kaynak != "şube":   # sahip (2026-10-19, E5): fiyat YALNIZ merkez kesinleştirince öğrenilir
        _fiyat_ogren(cur, {"toptanci_id": toptanci_id, "kalemler": satir, "kesin_tutar": kesin_tutar, "tahmini": tahmini}, gun)
    return dict(r)["id"] if r else None


def panel_teslim_yaz(cur, *, defter_id, sube_id, toptanci_id, toptanci_ad, kalemler, fatura_geldi, fatura_tutar, fatura_no, teslim_alan) -> None:
    """sube_panel /urun-sevk kancası — kendi SAVEPOINT'inde; hata teslimi (stok) BOZMAZ, iz bırakır."""
    try:
        from evvel_yeni_cekirdek import is_gunu as _ig, yeni_donem as _yd
        # Codex: yeni dönemde (iş günü ≥ panel_baslangic) eski panelden teslim gelirse borç KAYBOLMASIN (sessiz kayıp) ama
        # yeni panelle çift kayıt olabilir → yazılır + "⚠ ESKİ PANELDEN" işareti (merkez Toptancılar'da görür, çiftse iptal eder)
        isaret = "⚠ ESKİ PANELDEN (yeni dönem) — yeni panelde aynı teslim varsa birini iptal et" if _yd(cur) else None   # TEK kural (çekirdek)
        with savepoint(cur, "sp_ey_top_panel"):   # Fable: tarih = İŞ GÜNÜ (yeni panelle aynı; 00–02 çifti yakalansın)
            teslim_yaz(cur, kaynak_ref=f"urun_sevk:{defter_id}", toptanci_id=str(toptanci_id), toptanci_ad=toptanci_ad,
                       sube_id=str(sube_id), gun=_ig(), kalemler=kalemler or [], fatura_geldi=fatura_geldi,
                       kesin_tutar=_kr(fatura_tutar) if fatura_tutar else None, fatura_no=fatura_no, teslim_alan=teslim_alan,
                       aciklama=isaret)
    except Exception as e:  # noqa: BLE001
        log.warning("Evvel Yeni toptancı teslimi yazılamadı (stok etkilenmedi) defter=%s: %s", defter_id, str(e)[:200])


def panel_teslim_iptal(cur, defter_id, sebep: str) -> None:
    try:
        with savepoint(cur, "sp_ey_top_panel_iptal"):
            toptanci_hazirla(cur)
            cur.execute("UPDATE ey_toptanci_teslim SET iptal=TRUE, iptal_sebep=%s WHERE kaynak_ref=%s AND NOT iptal",
                        (("panelde geri alındı · " + (sebep or ""))[:200], f"urun_sevk:{defter_id}"))
    except Exception as e:  # noqa: BLE001
        log.warning("Evvel Yeni toptancı teslimi iptal edilemedi defter=%s: %s", defter_id, str(e)[:200])


def _hesap(cur, bugun: date):
    toptanci_hazirla(cur)
    from evvel_yeni_tanim_api import tanim_listesi   # Tanımlar'ın kapısı (F#32)
    tlar = tanim_listesi(cur, "ey_toptanci", ("ad", "kategori", "telefon", "acilis_bakiye", "aktif", "vade_gun"))
    belge_say = {}
    if _var(cur, "ey_toptanci_belge"):   # canlı 503 dersi: belge tablosu henüz yoksa Toptancılar yine AÇILIR
        cur.execute("SELECT teslim_id, COUNT(*) AS n FROM ey_toptanci_belge WHERE NOT iptal GROUP BY teslim_id")
        belge_say = {dict(r)["teslim_id"]: int(dict(r)["n"]) for r in cur.fetchall() or []}
    cur.execute("SELECT * FROM ey_toptanci_teslim ORDER BY tarih, zaman")
    teslimler = [dict(r) for r in cur.fetchall() or []]
    bilinen = {t["id"] for t in tlar}
    for x in teslimler:
        if x["toptanci_id"] not in bilinen:
            bilinen.add(x["toptanci_id"])
            tlar.append({"id": x["toptanci_id"], "ad": f"{x.get('toptanci_ad') or x['toptanci_id']} (Tanımlarda yok)", "kategori": None,
                         "telefon": None, "acilis_bakiye": 0, "aktif": True, "vade_gun": None})
    sube_ad = __import__("evvel_yeni_tanim_api").adlar(cur, "ey_sube")
    _, C, kayit, _ = _yukle(cur, tum_donemler=True)
    from evvel_yeni_odeme_api import konu_odemeleri   # Ödeme'nin tek okuyucusu (Kaçırılan #1) — 'nereden' de orada
    odemeler = {}
    for x in konu_odemeleri(cur, "toptanci", kayit=kayit, C=C):
        if x["toptanci_id"]:
            odemeler.setdefault(str(x["toptanci_id"]), []).append(
                {"id": x["id"], "tarih": x["tarih"], "tur": "odeme", "tutar": x["toplam"], "aciklama": x["aciklama"], "kim": x["kim"],
                 "kartla": x["kartla"], "nereden": x["nereden"]})
    out = []
    for t in tlar:
        ts = [x for x in teslimler if x["toptanci_id"] == t["id"]]
        od = sorted(odemeler.get(t["id"], []), key=lambda x: x["tarih"])
        if not t["aktif"] and not ts and not od:
            continue
        vg = t.get("vade_gun")
        acilis = int(t["acilis_bakiye"] or 0)
        kesin = tahmini = 0
        bilinmeyen = []
        borclar = ([{"tarih": None, "vade": None, "tutar": acilis, "ad": "açılış"}] if acilis > 0 else [])
        har = []
        for x in ts:
            kal = __import__("evvel_yeni_cekirdek").json_ac(x["kalemler"], [])
            borc = int(x["kesin_tutar"]) if x.get("kesin_tutar") is not None else (int(x["tahmini"]) if x.get("tahmini") is not None else None)
            sapma = None
            if x.get("kesin_tutar") and x.get("tahmini"):
                sapma = (int(x["kesin_tutar"]) - int(x["tahmini"])) / int(x["tahmini"])
            vade = (x["tarih"] + timedelta(days=vg)) if vg is not None else None
            if not x["iptal"]:
                if x.get("kesin_tutar") is not None:
                    kesin += int(x["kesin_tutar"])
                elif borc is not None:
                    tahmini += borc
                else:
                    bilinmeyen.append(x)
                if borc:
                    borclar.append({"tarih": x["tarih"], "vade": vade, "tutar": borc})
            har.append({"id": x["id"], "tur": "teslim", "tarih": x["tarih"].isoformat(), "sube": sube_ad.get(x.get("sube_id"), x.get("sube_id") or "—"),
                        "kalemler": kal, "tahmini": _tl_sayi(int(x["tahmini"])) if x.get("tahmini") is not None else None,
                        "fiyat_eksik": x.get("fiyat_eksik") or 0, "kesin": _tl_sayi(int(x["kesin_tutar"])) if x.get("kesin_tutar") is not None else None,
                        "fatura_geldi": x.get("fatura_geldi"), "fatura_no": x.get("fatura_no"), "kesin_kaynak": x.get("kesin_kaynak"),
                        "borc": _tl_sayi(borc) if borc is not None else None, "durum": ("kesin" if x.get("kesin_tutar") is not None else "tahmini" if borc is not None else "bilinmiyor"),
                        "sapma": round(sapma * 100) if sapma is not None else None, "sapma_uyari": bool(sapma is not None and abs(sapma) > SAPMA_ORAN),
                        "vade": vade.isoformat() if vade else None, "teslim_alan": x.get("teslim_alan"), "aciklama": x.get("aciklama"),
                        "iptal": x["iptal"], "iptal_sebep": x.get("iptal_sebep"), "iz": x.get("iz") or [],
                        "belge_sayi": belge_say.get(x["id"], 0),
                        "belge_eksik": bool(x.get("fatura_geldi") and not belge_say.get(x["id"]) and not x["iptal"])})
        od_top = sum(o["tutar"] for o in od)
        har += [{**o, "tutar": _tl_sayi(o["tutar"])} for o in od]
        har.sort(key=lambda z: z["tarih"], reverse=True)
        # vadesi geçen: ödemeyi en eski borçtan düş (yalnız ekranda)
        kalan_od = od_top + (-acilis if acilis < 0 else 0)   # Codex: eksi açılış (alacak) vadeli borçtan düşer
        gecen = hafta = uc_gun = belirsiz = 0
        for b in borclar:
            k_ = max(0, b["tutar"] - kalan_od)
            kalan_od = max(0, kalan_od - b["tutar"])
            if not k_:
                continue
            if b["vade"] is None:
                belirsiz += k_
            elif b["vade"] < bugun:
                gecen += k_
            elif (b["vade"] - bugun).days <= 7:
                hafta += k_
                if (b["vade"] - bugun).days <= 3:
                    uc_gun += k_
        bakiye = acilis + kesin + tahmini - od_top
        sube_dag, odeme_dag = {}, {}
        for x in har:
            if x["tur"] == "teslim" and not x["iptal"] and x.get("borc") is not None:
                d = sube_dag.setdefault(x["sube"], {"tutar": 0.0, "sayi": 0})
                d["tutar"] = round(d["tutar"] + x["borc"], 2)
                d["sayi"] += 1
            elif x["tur"] == "odeme":
                for n in x.get("nereden") or []:
                    k_ = ("💳 " if n["tur"] == "kart" else "💵 ") + n["ad"]
                    odeme_dag[k_] = round(odeme_dag.get(k_, 0) + n["tutar"], 2)
        eksik_tahmin = [x for x in ts if not x["iptal"] and x.get("kesin_tutar") is None and x.get("tahmini") is not None and (x.get("fiyat_eksik") or 0) > 0]
        out.append({"id": t["id"], "ad": t["ad"], "kategori": t.get("kategori"), "aktif": t["aktif"], "vade_gun": vg,
                    "eksik_tahmin_sayi": len(eksik_tahmin),
                    "acilis": _tl_sayi(acilis), "kesin": _tl_sayi(kesin), "tahmini": _tl_sayi(tahmini), "odenen": _tl_sayi(od_top),
                    "bakiye": _tl_sayi(bakiye), "bilinmeyen_sayi": len(bilinmeyen),
                    "bilinmeyen_eski": [{"id": b["id"], "tarih": b["tarih"].isoformat()} for b in bilinmeyen if (bugun - b["tarih"]).days >= BILINMEYEN_UYARI_GUN],
                    "vadesi_gecen": _tl_sayi(gecen), "bu_hafta": _tl_sayi(hafta), "uc_gun": _tl_sayi(uc_gun), "vadesi_belirsiz": _tl_sayi(belirsiz),
                    "sapma_sayi": sum(1 for h in har if h.get("sapma_uyari") and not h.get("iptal")),
                    "sube_dagilim": [{"sube": k, **v} for k, v in sorted(sube_dag.items(), key=lambda z: -z[1]["tutar"])],
                    "odeme_dagilim": [{"nereden": k, "tutar": v} for k, v in sorted(odeme_dag.items(), key=lambda z: -z[1])],
                    "hareketler": har, "son_hareket": har[0]["tarih"] if har else None})
    out.sort(key=lambda x: (-(x["vadesi_gecen"] or 0), -x["bakiye"], x["ad"]))
    return out


@router.get("/ozet")
def toptanci_ozet():
    _hazirla()
    with db() as (conn, cur):
        tl = _hesap(cur, _bugun())
    T = lambda k: round(sum(x[k] for x in tl if x["bakiye"] > 0 or k != "bakiye"), 2)  # noqa: E731
    return {"toptancilar": tl,
            "toplam": {"bakiye": round(sum(x["bakiye"] for x in tl if x["bakiye"] > 0), 2),
                       "alacak": round(-sum(x["bakiye"] for x in tl if x["bakiye"] < 0), 2),
                       "borclu_sayi": sum(1 for x in tl if x["bakiye"] > 0), "kesin": T("kesin"), "tahmini": T("tahmini"),
                       "vadesi_gecen": T("vadesi_gecen"), "bu_hafta": T("bu_hafta"), "vadesi_belirsiz": T("vadesi_belirsiz"),
                       "bilinmeyen_sayi": sum(x["bilinmeyen_sayi"] for x in tl), "eksik_tahmin_sayi": sum(x["eksik_tahmin_sayi"] for x in tl)},
            "not": "Borç = açılış + teslimler (kesin tutar, yoksa adet × fiyat tahmini) − ödemeler. Fatura gelince aynı teslimin tutarı "
                   "kesinleşir, yeni borç açılmaz. Vadesi geçen: ödemeler en eski borçtan düşülerek hesaplanır."}


def toptanci_isleri(cur) -> list:
    """Bekleyen işler: vadesi geçen / 3 gün içinde dolan borç · 7+ gündür tutarı bilinmeyen teslim."""
    bugun = _bugun()
    out = []
    for t in _hesap(cur, bugun):
        if t["vadesi_gecen"] > 0:
            out.append({"tur": "toptanci_vade", "grup": "odeme", "id": f"tv:{t['id']}", "tarih": bugun.isoformat(), "ad": t["ad"],
                        "tutar": t["vadesi_gecen"], "gecti": True})
        if t["uc_gun"] > 0:
            out.append({"tur": "toptanci_vade", "grup": "odeme", "id": f"t3:{t['id']}", "tarih": bugun.isoformat(), "ad": t["ad"],
                        "tutar": t["uc_gun"], "gecti": False})
        if t["bilinmeyen_eski"]:
            out.append({"tur": "toptanci_tutar", "grup": "tedarik", "id": f"tb:{t['id']}", "tarih": t["bilinmeyen_eski"][0]["tarih"], "ad": t["ad"],
                        "sayi": len(t["bilinmeyen_eski"])})
    return out


class TeslimBody(BaseModel):
    toptanci_id: str
    sube_id: Optional[str] = None
    tarih: Optional[str] = None
    tutar: Optional[Decimal] = None
    fatura_geldi: Optional[bool] = None
    fatura_no: Optional[str] = None
    aciklama: Optional[str] = None


@router.post("/teslim")
def merkez_teslim(body: TeslimBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkezin elle girdiği teslim (panel dışı gelen mal, açılış sonrası unutulan teslim)."""
    try:
        gun = date.fromisoformat((body.tarih or _bugun().isoformat())[:10])
    except ValueError:
        raise HTTPException(400, "Tarih YYYY-AA-GG olmalı")
    if gun > _bugun():
        raise HTTPException(400, "Gelecek tarihli teslim girilemez")
    t = _kurus(body.tutar) if body.tutar is not None else None
    if t is not None and t <= 0:
        raise HTTPException(400, "Tutar sıfırdan büyük olmalı")
    _hazirla()
    with db() as (conn, cur):
        toptanci_hazirla(cur)
        r = __import__("evvel_yeni_tanim_api").tanim_oku(cur, "ey_toptanci", body.toptanci_id, ("ad",))   # F#32
        if not r:
            raise HTTPException(404, "Toptancı bulunamadı")
        if t:
            cur.execute("""SELECT 1 FROM ey_toptanci_teslim WHERE toptanci_id=%s AND tarih=%s AND kesin_tutar=%s AND NOT iptal""",
                        (body.toptanci_id, gun, t))
            if cur.fetchone() and not (body.aciklama or "").startswith("!"):
                raise HTTPException(409, "BENZER KAYIT: aynı toptancı, aynı gün, aynı tutarda teslim zaten var. Gerçekten ikinci teslimse açıklamanın başına ! koy.")
        kim = _aktor(cur, x_evvel_oturum)
        teslim_yaz(cur, kaynak_ref="merkez:" + uuid.uuid4().hex[:12], toptanci_id=body.toptanci_id, toptanci_ad=dict(r)["ad"],
                   sube_id=body.sube_id, gun=gun, kalemler=[], fatura_geldi=body.fatura_geldi, kesin_tutar=t,
                   fatura_no=body.fatura_no, teslim_alan=kim, aciklama=(body.aciklama or "").lstrip("!"), kesin_kaynak="merkez")
    return {"ok": True, "mesaj": f"{dict(r)['ad']} teslimi girildi" + ("" if t else " — tutar sonra girilecek")}


class TutarBody(BaseModel):
    tutar: Decimal
    fatura_geldi: Optional[bool] = True
    fatura_no: Optional[str] = None
    sebep: Optional[str] = None


@router.post("/teslim/{tid}/tutar")
def teslim_tutar(tid: str, body: TutarBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Fatura sonradan geldi / tutar düzeltmesi — AYNI teslimin kesin tutarı (eski değer izde kalır)."""
    t = _kurus(body.tutar)
    if t <= 0:
        raise HTTPException(400, "Tutar sıfırdan büyük olmalı")
    _hazirla()
    with db() as (conn, cur):
        toptanci_hazirla(cur)
        cur.execute("SELECT * FROM ey_toptanci_teslim WHERE id=%s AND NOT iptal FOR UPDATE", (tid,))
        x = cur.fetchone()
        if not x:
            raise HTTPException(404, "Teslim bulunamadı ya da iptal")
        x = dict(x)
        if x.get("kesin_tutar") is not None and len((body.sebep or "").strip()) < 3:
            raise HTTPException(400, "Tutar zaten kesin — değiştirmek için sebep yaz")
        kim = _aktor(cur, x_evvel_oturum)
        iz = (x.get("iz") or []) + [{"zaman": _bugun().isoformat(), "kim": kim, "eski": _tl_sayi(int(x["kesin_tutar"])) if x.get("kesin_tutar") else None,
                                     "yeni": _tl_sayi(t), "sebep": (body.sebep or "fatura geldi").strip()[:150]}]
        cur.execute("""UPDATE ey_toptanci_teslim SET kesin_tutar=%s, fatura_geldi=%s, fatura_no=COALESCE(%s, fatura_no), kesin_kaynak='merkez',
                              iz=%s::jsonb WHERE id=%s""",
                    (t, body.fatura_geldi, (body.fatura_no or "").strip()[:40] or None, json.dumps(iz, ensure_ascii=False), tid))
        x["kesin_tutar"] = t
        _fiyat_ogren(cur, x, x["tarih"])
    sap = ""
    if x.get("tahmini"):
        s = (t - int(x["tahmini"])) / int(x["tahmini"])
        if abs(s) > SAPMA_ORAN:
            sap = f" ⚠ tahminden %{round(s * 100)} farklı — birim (koli/adet) karışmış olabilir"
    return {"ok": True, "mesaj": f"Tutar kesinleşti: {_tl_sayi(t):,.2f} ₺{sap}"}


class IptalBody(BaseModel):
    sebep: str


# ─────────────── E1 · FATURA BELGESİ (teslimin eki) ───────────────
BELGE_MAX_SAYFA = 6
BELGE_MAX = {"image/jpeg": 900_000, "image/png": 900_000, "image/webp": 900_000, "application/pdf": 3_500_000}


def _belge_coz(veri: str, mime: Optional[str]) -> tuple:
    import base64
    import hashlib
    v = (veri or "").strip()
    if v.startswith("data:"):
        bas, _, v = v.partition(",")
        mime = mime or bas[5:].split(";")[0]
    if mime not in BELGE_MAX:
        raise HTTPException(400, "Yalnız fotoğraf (JPEG/PNG) ya da PDF")
    try:
        ham = base64.b64decode(v, validate=True)
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "Dosya okunamadı")
    if not ham:
        raise HTTPException(400, "Dosya boş")
    if len(ham) > BELGE_MAX[mime]:
        raise HTTPException(400, "Dosya çok büyük (fotoğraf en çok 0,9 MB · PDF en çok 3,5 MB)")
    imza = {b"\xff\xd8\xff": "image/jpeg", b"\x89PNG": "image/png", b"%PDF": "application/pdf", b"RIFF": "image/webp"}
    if not any(ham.startswith(k) and (m == mime) for k, m in imza.items()) or (mime == "image/webp" and ham[8:12] != b"WEBP"):
        raise HTTPException(400, "Dosya türü içeriğiyle uyuşmuyor")
    return ham, mime, hashlib.sha256(ham).hexdigest()


def _belge_ekle(cur, tid: str, ham: bytes, mime: str, sha: str, yukleyen: str, kaynak: str) -> dict:
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("ey_top_belge:" + tid,))
    cur.execute("SELECT id FROM ey_toptanci_belge WHERE teslim_id=%s AND sha256=%s AND NOT iptal", (tid, sha))
    r = cur.fetchone()
    if r:   # aynı dosya ikinci kez (tekrar gönderim) → yeni sayfa açılmaz
        return {"id": dict(r)["id"], "tekrar": True}
    cur.execute("SELECT COALESCE(MAX(sayfa), 0) AS s, COUNT(*) AS n FROM ey_toptanci_belge WHERE teslim_id=%s AND NOT iptal", (tid,))
    s = dict(cur.fetchone())
    if int(s["n"]) >= BELGE_MAX_SAYFA:
        raise HTTPException(409, f"Bu teslime en çok {BELGE_MAX_SAYFA} sayfa eklenir")
    bid = "tb-" + uuid.uuid4().hex[:12]
    cur.execute("""INSERT INTO ey_toptanci_belge (id, teslim_id, sayfa, mime, boyut, veri, sha256, yukleyen, kaynak)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""", (bid, tid, int(s["s"]) + 1, mime, len(ham), ham, sha, yukleyen, kaynak))
    return {"id": bid, "sayfa": int(s["s"]) + 1, "tekrar": False}


GOVDE_MAX = 5_000_000   # base64 3,5 MB PDF ≈ 4,7 MB (Fable E1 #2: kimlik doğrulamadan önce sınırsız gövde okunmasın)


async def _govde_oku(request: Request) -> dict:
    try:
        n = int(request.headers.get("content-length") or 0)
    except ValueError:
        n = 0
    if n > GOVDE_MAX:
        raise HTTPException(413, "Dosya çok büyük")
    ham = bytearray()
    async for parca in request.stream():
        ham.extend(parca)
        if len(ham) > GOVDE_MAX:
            raise HTTPException(413, "Dosya çok büyük")
    try:
        v = json.loads(bytes(ham) or b"{}")
    except ValueError:
        raise HTTPException(400, "İstek okunamadı")
    if not isinstance(v, dict):
        raise HTTPException(400, "İstek okunamadı")
    return {"ham": bytes(ham), "v": v}


@router.post("/teslim/{tid}/belge")
async def belge_merkez(tid: str, request: Request, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez: faturayı sonradan (PDF / fotoğraf) teslime ekler. Gövde: {veri: base64/data URL, mime?}."""
    g = await _govde_oku(request)
    return await run_in_threadpool(lambda: _belge_merkez(tid, g["v"], x_evvel_oturum))


def _belge_merkez(tid: str, v: dict, x_evvel_oturum: Optional[str]) -> dict:
    ham, mime, sha = _belge_coz(str(v.get("veri") or ""), v.get("mime"))
    with db() as (conn, cur):
        toptanci_hazirla(cur)
        kim = merkez_aktor(cur, x_evvel_oturum)   # çekirdek kapısı (F#2)
        cur.execute("SELECT 1 FROM ey_toptanci_teslim WHERE id=%s AND NOT iptal", (tid,))
        if not cur.fetchone():
            raise HTTPException(404, "Teslim bulunamadı ya da iptal")
        r = _belge_ekle(cur, tid, ham, mime, sha, kim, "merkez")
    return {"ok": True, **r, "mesaj": "Belge zaten ekliydi" if r["tekrar"] else f"Belge eklendi (sayfa {r['sayfa']})"}


def _telefon_teslim(cur, request_headers, method, yol, govde: bytes, tid: str, sube: Optional[str]) -> tuple:
    """Telefon (imzalı) → kişi; teslim o şubenin, son 2 gün, iptal değil; kişi o şubede İÇERİDE. Yoklama kapalıysa 503."""
    from evvel_yeni_moduller import acik as _acik
    if not _acik("yoklama"):
        raise HTTPException(503, "Telefon onayı kapalı — merkez PDF ekler")
    import evvel_yeni_yoklama_api as y
    _c, p = y.telefon_kisisi(cur, request_headers, method, yol, govde)   # Yoklama'nın tek kapısı (K4)
    cur.execute("SELECT id, sube_id, toptanci_ad, tarih, kesin_tutar, tahmini, fatura_geldi FROM ey_toptanci_teslim WHERE id=%s AND NOT iptal", (tid,))
    t = cur.fetchone()
    if not t:
        raise HTTPException(404, "Teslim bulunamadı")
    t = dict(t)
    if sube and str(t["sube_id"]) != str(sube):
        raise HTTPException(409, "Bu teslim başka şubenin")
    if t["tarih"] < _bugun() - timedelta(days=2):
        raise HTTPException(409, "Teslim eski — faturayı merkez eklesin")
    if not y.acik_mi(cur, str(t["sube_id"]), p["id"]):
        raise HTTPException(409, "Önce bu şubeye QR ile giriş yap")
    return p, t


@router.get("/teslim/{tid}/belge-telefon")
async def belge_telefon_ozet(tid: str, request: Request, sube: Optional[str] = None):
    def _is():
        with db() as (conn, cur):
            toptanci_hazirla(cur)
            p, t = _telefon_teslim(cur, request.headers, "GET", request.url.path, b"", tid, sube)
            cur.execute("SELECT COUNT(*) AS n FROM ey_toptanci_belge WHERE teslim_id=%s AND NOT iptal", (tid,))
            n = int(dict(cur.fetchone())["n"])
        tut = t.get("kesin_tutar") if t.get("kesin_tutar") is not None else t.get("tahmini")
        return {"kisi": p["ad"], "toptanci": t["toptanci_ad"], "tarih": t["tarih"].isoformat(), "belge_sayi": n, "max": BELGE_MAX_SAYFA,
                "tutar": _tl_sayi(int(tut)) if tut is not None else None, "fatura_geldi": t.get("fatura_geldi")}
    return await run_in_threadpool(_is)


@router.post("/teslim/{tid}/belge-telefon")
async def belge_telefon(tid: str, request: Request):
    g = await _govde_oku(request)
    ham_govde, v = g["ham"], g["v"]
    if len(str(v.get("veri") or "")) > 1_300_000:   # telefon fotoğrafı küçültülmüş JPEG — çözmeden önce kes
        raise HTTPException(400, "Fotoğraf çok büyük — yeniden çek")

    def _is():
        with db() as (conn, cur):
            toptanci_hazirla(cur)
            p, t = _telefon_teslim(cur, request.headers, "POST", request.url.path, ham_govde, tid, v.get("sube"))
            ham, mime, sha = _belge_coz(str(v.get("veri") or ""), v.get("mime"))
            return _belge_ekle(cur, tid, ham, mime, sha, p["ad"], "telefon")
    r = await run_in_threadpool(_is)
    return {"ok": True, **r, "mesaj": "Bu sayfa zaten eklendi" if r["tekrar"] else f"Sayfa {r['sayfa']} eklendi"}


@router.get("/teslim/{tid}/belgeler")
def belgeler(tid: str, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez (Toptancı Kitabı): teslimin sayfa listesi (META — veri yok; her sayfa /belge/{id} ile tek tek)."""
    with db() as (conn, cur):
        toptanci_hazirla(cur)
        merkez_aktor(cur, x_evvel_oturum)   # çekirdek kapısı (F#2)
        cur.execute("""SELECT id, sayfa, mime, boyut, yukleyen, kaynak, zaman FROM ey_toptanci_belge
                        WHERE teslim_id=%s AND NOT iptal ORDER BY sayfa""", (tid,))
        rows = [dict(x) for x in cur.fetchall() or []]
    return {"sayfalar": [{"id": r["id"], "sayfa": r["sayfa"], "mime": r["mime"], "boyut": r["boyut"], "yukleyen": r["yukleyen"],
                          "kaynak": r["kaynak"], "zaman": r["zaman"].isoformat()} for r in rows]}


@router.get("/belge/{bid}")
def belge_getir(bid: str, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez: tek sayfanın kendisi (resim / PDF)."""
    from fastapi.responses import Response
    with db() as (conn, cur):
        toptanci_hazirla(cur)
        merkez_aktor(cur, x_evvel_oturum)   # çekirdek kapısı (F#2)
        cur.execute("SELECT mime, veri FROM ey_toptanci_belge WHERE id=%s AND NOT iptal", (bid,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Belge bulunamadı")
        r = dict(r)
    return Response(content=bytes(r["veri"]), media_type=r["mime"], headers={"Cache-Control": "private, max-age=3600"})


@router.post("/belge/{bid}/kaldir")
def belge_kaldir(bid: str, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez: yanlış sayfayı kaldırır (silinmez — iptal, iz kalır)."""
    with db() as (conn, cur):
        toptanci_hazirla(cur)
        kim = merkez_aktor(cur, x_evvel_oturum)   # çekirdek kapısı (F#2)
        cur.execute("UPDATE ey_toptanci_belge SET iptal=TRUE, iptal_kim=%s, iptal_zaman=NOW() WHERE id=%s AND NOT iptal RETURNING id", (kim, bid))
        if not cur.fetchone():
            raise HTTPException(404, "Belge bulunamadı")
    return {"ok": True, "mesaj": "Sayfa kaldırıldı"}


@router.post("/teslim/{tid}/iptal")
def teslim_iptal(tid: str, body: IptalBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    if len((body.sebep or "").strip()) < 3:
        raise HTTPException(400, "İptal sebebini yaz")
    _hazirla()
    with db() as (conn, cur):
        toptanci_hazirla(cur)
        cur.execute("SELECT kaynak_ref FROM ey_toptanci_teslim WHERE id=%s", (tid,))
        r0 = cur.fetchone()
        if r0 and (dict(r0)["kaynak_ref"] or "").startswith("panel:teslim:"):
            from evvel_yeni_moduller import acik as _acik
            if not _acik("depo"):   # Codex: borç düşüp stok kalmasın — önce Depo açılmalı
                raise HTTPException(409, "Depo modülü kapalı — bu teslimin depo girişi de geri alınmalı; önce Depo'yu aç")
        cur.execute("UPDATE ey_toptanci_teslim SET iptal=TRUE, iptal_sebep=%s WHERE id=%s AND NOT iptal RETURNING id, kaynak_ref",
                    (f"{body.sebep.strip()[:150]} · {_aktor(cur, x_evvel_oturum)}", tid))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Teslim bulunamadı ya da zaten iptal")
        ek = ""
        ref = dict(r)["kaynak_ref"] or ""
        if ref.startswith("panel:teslim:"):   # yeni panel teslimi: depo girişi de geri alınır (Depo açık — yukarıda denetlendi)
            from evvel_yeni_depo_api import hareket_iptal
            d = hareket_iptal(cur, bag=ref, sebep=f"toptancı teslimi iptal · {body.sebep.strip()[:100]}")
            ek = f" · depo girişi geri alındı ({d['iptal']} kalem)" + (
                f" · sonradan SAYILAN {', '.join(d['kalan'])} geri alınmadı (stok sayımla kesinleşti)" if d["kalan"] else "")
    return {"ok": True, "mesaj": "Teslim iptal edildi — borçtan düştü" + ek}



# ─────────────── ÜRÜN FİYATLARI (panel kataloğu şeklinde) ───────────────
def _elle_ve_toptanci_fiyatlari(cur, idler: Optional[List[str]] = None) -> tuple:
    """(elle girilen fiyat {urun_id: satır}, toptancı fiyatları {anahtar: [{toptanci, birim, tarih}]}) — yeni ve eski fiyat ekranı
    ORTAK (Dalga 4, K8: iki birebir kopya). idler None → hepsi."""
    kos, prm = ("WHERE urun_id = ANY(%s)", (idler,)) if idler is not None else ("", ())
    cur.execute(f"SELECT urun_id, birim, girilen, zaman FROM ey_urun_fiyat {kos}", prm)
    elle = {dict(r)["urun_id"]: dict(r) for r in cur.fetchall() or []}
    tad = __import__("evvel_yeni_tanim_api").adlar(cur, "ey_toptanci")   # toptancı adı Tanımlar'dan (F#32)
    kos2 = "WHERE f.urun_anahtar = ANY(%s)" if idler is not None else ""
    cur.execute(f"SELECT f.urun_anahtar, f.birim, f.tarih, f.toptanci_id FROM ey_toptanci_fiyat f {kos2}", prm)
    top_f = {}
    for r in cur.fetchall() or []:
        r = dict(r)
        top_f.setdefault(r["urun_anahtar"], []).append({"toptanci": tad.get(str(r["toptanci_id"])), "birim": _tl_sayi(int(r["birim"])),
                                                        "tarih": r["tarih"].isoformat()})
    return elle, top_f


def _fiyatlar_yeni(cur) -> dict:
    """Yeni katalog (ey_urun) × o gün geçerli fiyat (fiyat_bilgi). 1 SAYIM birimi, KDV dahil."""
    from evvel_yeni_urun_api import katalog as _ey_katalog
    kat = _ey_katalog(cur)
    idler = [str(u["id"]) for k in kat for u in k["urunler"]]
    elle, top_f = _elle_ve_toptanci_fiyatlari(cur, idler)
    out = []
    for k in kat:
        satir = []
        for u in k["urunler"]:
            uid = str(u["id"])
            f = fiyat_bilgi(cur, uid)
            e = elle.get(uid)
            satir.append({"id": uid, "ad": u["ad"], "gecerli": _tl_sayi(f["kurus"]) if f else None, "kaynak": f["kaynak"] if f else None,
                          "birim": u.get("birim") or "adet", "koli": u.get("koli_ici"),
                          "elle": _tl_sayi(int(e["birim"])) if e else None, "elle_kim": e.get("girilen") if e else None,
                          "son_alis": None, "katalog": None, "toptanci": top_f.get(uid, [])})
        out.append({"id": str(k["id"]), "ad": k["ad"], "emoji": k.get("emoji"), "urunler": satir,
                    "eksik": sum(1 for x in satir if x["gecerli"] is None)})
    from evvel_yeni_cekirdek import yeni_donem
    return {"kategoriler": out, "eksik": sum(k["eksik"] for k in out), "toplam": sum(len(k["urunler"]) for k in out), "evren": "yeni",
            "varsayilan_evren": "yeni" if yeni_donem(cur) else "eski",
            "not": "YENİ KATALOG — fiyat 1 SAYIM birimi başına (ürünün biriminde), KDV DAHİL. Sıra: toptancının kesin faturasından öğrenilen "
                   "→ elle girilen. Her değişiklik tarihli geçmişe yazılır (geçen ayın gideri o günün fiyatıyla hesaplanır)."}


@router.get("/fiyatlar")
def urun_fiyatlari(evren: Optional[str] = None):
    """Panel kataloğu (siparis_kategori → siparis_urun) + her ürünün GEÇERLİ fiyatı (KDV dahil) ve kaynağı.
    Sıra: elle girilen → son alış (KDV dahil) → katalog. Toptancıya özel öğrenilen fiyatlar ayrıca listelenir."""
    _hazirla()
    with db() as (conn, cur):
        toptanci_hazirla(cur)
        from evvel_yeni_cekirdek import yeni_donem
        if (evren == "yeni") if evren in ("yeni", "eski") else yeni_donem(cur):
            return _fiyatlar_yeni(cur)
        cur.execute("SELECT id::text AS id, kod, ad, emoji, sira FROM siparis_kategori WHERE aktif ORDER BY sira, ad")
        kats = [dict(r) for r in cur.fetchall() or []]
        cur.execute("""SELECT id::text AS id, kategori_id::text AS kategori_id, ad, sira, birim_fiyat_tl, depo_stok_kalem_kodu
                         FROM siparis_urun WHERE aktif ORDER BY sira, ad""")
        urunler = [dict(r) for r in cur.fetchall() or []]
        birimler = {}
        try:   # birim / koli bilgisi (eski kurulumda kolon olmayabilir)
            with savepoint(cur, "sp_ey_fiyat_birim"):
                cur.execute("""SELECT id::text AS id, birim, COALESCE(koli_ic_adet, koli_adet) AS koli FROM siparis_urun WHERE aktif""")
                birimler = {dict(r)["id"]: dict(r) for r in cur.fetchall() or []}
        except Exception:  # noqa: BLE001
            pass
        idler = [u["id"] for u in urunler]
        kodlar = list(set(idler) | {u["depo_stok_kalem_kodu"] for u in urunler if u.get("depo_stok_kalem_kodu")})
        af, ko = {}, {}
        try:
            with savepoint(cur, "sp_ey_fiyat_af"):
                cur.execute("""SELECT DISTINCT ON (kalem_kodu) kalem_kodu, birim_maliyet_tl, gecerli_baslangic FROM urun_alis_fiyat
                                WHERE kalem_kodu = ANY(%s) AND birim_maliyet_tl > 0
                                ORDER BY kalem_kodu, gecerli_baslangic DESC, created_at DESC""", (kodlar,))
                af = {dict(r)["kalem_kodu"]: dict(r) for r in cur.fetchall() or []}
                cur.execute("SELECT kalem_kodu, kdv_oran FROM kalem_kdv_oran WHERE kalem_kodu = ANY(%s)", (kodlar,))
                ko = {dict(r)["kalem_kodu"]: Decimal(dict(r)["kdv_oran"] or 0) for r in cur.fetchall() or []}
        except Exception as e:  # noqa: BLE001
            log.warning("ürün fiyatları: alış fiyatı okunamadı: %s", str(e)[:150])
        elle, top_f = _elle_ve_toptanci_fiyatlari(cur)
    out = []
    for k in kats:
        satir = []
        for u in [x for x in urunler if x["kategori_id"] == k["id"]]:
            son = None
            for kod in (u["id"], u.get("depo_stok_kalem_kodu")):
                if kod and kod in af:
                    oran = ko.get(kod, ko.get(u["id"]))
                    son = {"birim": _tl_sayi(_kr(Decimal(af[kod]["birim_maliyet_tl"]) * (1 + _kdv_kesir(oran or 0)))),
                           "kdv_yok": oran is None, "tarih": af[kod]["gecerli_baslangic"].isoformat() if af[kod].get("gecerli_baslangic") else None}
                    break
            e = elle.get(u["id"])
            kat = float(u["birim_fiyat_tl"]) if u.get("birim_fiyat_tl") else None
            if e:
                gecerli, kaynak = _tl_sayi(int(e["birim"])), "elle"
            elif son:
                gecerli, kaynak = son["birim"], "son alış"
            elif kat:
                gecerli, kaynak = kat, "katalog"
            else:
                gecerli, kaynak = None, None
            bk = birimler.get(u["id"]) or {}
            satir.append({"id": u["id"], "ad": u["ad"], "gecerli": gecerli, "kaynak": kaynak,
                          "birim": (bk.get("birim") or "").strip() or None, "koli": int(bk["koli"]) if bk.get("koli") else None,
                          "elle": _tl_sayi(int(e["birim"])) if e else None, "elle_kim": e.get("girilen") if e else None,
                          "son_alis": son, "katalog": kat, "toptanci": top_f.get(u["id"], [])})
        out.append({"id": k["id"], "ad": k["ad"], "emoji": k.get("emoji"), "urunler": satir,
                    "eksik": sum(1 for x in satir if x["gecerli"] is None)})
    return {"kategoriler": out, "eksik": sum(k["eksik"] for k in out), "toplam": sum(len(k["urunler"]) for k in out), "evren": "eski",
            "varsayilan_evren": "eski",
            "not": "GEÇİŞ (eski katalog) — Her şey ADET başına (sahip: 'her şeyi sayılabilir, adet mantığında fiyatlayalım'), KDV DAHİL — şube teslimde adet sayar. "
                   "Sıra: elle girilen → son alış → katalog. "
                   "Toptancı tahmini önce o toptancının kendi faturasından öğrenilen fiyatı kullanır."}


class FiyatBody(BaseModel):
    urun_id: str
    birim: Optional[Decimal] = None     # boş → elle fiyat silinir


def tahminleri_tazele(cur) -> int:
    """Kesinleşmemiş (ve iptal olmayan) teslimlerin tahminini güncel fiyatlarla yeniden hesapla (Codex: fiyat girilince eski tahmin kalıyordu)."""
    cur.execute("SELECT id, toptanci_id, tarih, kalemler FROM ey_toptanci_teslim WHERE kesin_tutar IS NULL AND NOT iptal")
    n = 0
    for x in [dict(r) for r in cur.fetchall() or []]:
        kal = __import__("evvel_yeni_cekirdek").json_ac(x["kalemler"], [])
        if not kal:
            continue
        satir, tahmini, eksik = _tahmin(cur, x["toptanci_id"], [{"urun_id": k.get("urun_id"), "urun_ad": k.get("ad"), "adet": k.get("adet")} for k in kal], x["tarih"])
        cur.execute("UPDATE ey_toptanci_teslim SET kalemler=%s::jsonb, tahmini=%s, fiyat_eksik=%s WHERE id=%s",
                    (json.dumps(satir, ensure_ascii=False), tahmini, eksik, x["id"]))
        n += 1
    return n


@router.post("/fiyat")
def urun_fiyat_gir(body: FiyatBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    _hazirla()
    with db() as (conn, cur):
        toptanci_hazirla(cur)
        # F#38: ÖNCE yeni katalog (PUBLIC urun_ad); eski siparis_urun yalnız geçişte ve savepoint'te — eski tablo kalkınca 500 olmasın
        from evvel_yeni_cekirdek import yeni_donem
        from evvel_yeni_urun_api import urun_ad
        ad = urun_ad(cur, body.urun_id)
        r = {"ad": ad} if ad else None
        if not r and not yeni_donem(cur):
            try:
                with savepoint(cur, "sp_ey_fiyat_eski_ad"):
                    cur.execute("SELECT ad FROM siparis_urun WHERE id::text=%s", (body.urun_id,))
                    r = cur.fetchone()
            except Exception:  # noqa: BLE001
                r = None
        if not r:
            raise HTTPException(404, "Ürün bulunamadı")
        kim = _aktor(cur, x_evvel_oturum)
        if body.birim is None:
            cur.execute("DELETE FROM ey_urun_fiyat WHERE urun_id=%s RETURNING urun_id", (body.urun_id,))
            from evvel_yeni_urun_api import urun_bilgi
            if cur.fetchone() and urun_bilgi(cur, [body.urun_id]):
                _fiyat_gecmis_yaz(cur, body.urun_id, "elle", None, _bugun(), "elle fiyat kaldırıldı", girilen=kim)
            tahminleri_tazele(cur)
            return {"ok": True, "mesaj": f"{dict(r)['ad']}: elle fiyat kaldırıldı"}
        b = _kurus(body.birim)
        if b <= 0:
            raise HTTPException(400, "Fiyat sıfırdan büyük olmalı")
        cur.execute("""INSERT INTO ey_urun_fiyat (urun_id, birim, girilen) VALUES (%s,%s,%s)
                       ON CONFLICT (urun_id) DO UPDATE SET birim=EXCLUDED.birim, girilen=EXCLUDED.girilen, zaman=NOW()""",
                    (body.urun_id, b, kim))
        from evvel_yeni_urun_api import urun_bilgi
        if urun_bilgi(cur, [body.urun_id]):   # Fable: eski kimlik fiyat geçmişine girmez
            _fiyat_gecmis_yaz(cur, body.urun_id, "elle", b, _bugun(), "elle", girilen=kim)
        tahminleri_tazele(cur)
    return {"ok": True, "mesaj": f"{dict(r)['ad']}: {_tl_sayi(b):,.2f} ₺ (KDV dahil) kaydedildi"}


# 🧩 Bekleyen işler kayıt defterine (Kasa bu modülü tanımaz; modül kapanınca satırları da kalkar)
bekleyen_is_kaydet("toptanci", lambda cur, b: toptanci_isleri(cur))
