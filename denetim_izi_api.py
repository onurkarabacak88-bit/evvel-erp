"""
DENETİM İZİ — `audit_log`'un OKUMA ucu. İZOLE, SALT OKUR.

── NEDEN VAR (2026-09-02, SYS-AUDIT okuma boşluğu) ──────────────────────────
Sistemde 161+ çağrı noktası `audit(cur, ...)` ile `audit_log`'a yazıyordu
(main.py, kasa_service.py, sube_panel.py …). Bu izleri OKUYAN tek satır
`duyu_gorunumler.py`'deki bir COUNT(*) idi; ne bir API ucu, ne bir ekran vardı.

    Yazılıp okunamayan iz, iz DEĞİLDİR.

Sahip şu üç soruyu soramıyordu:
    "bu rakamı KİM, NE ZAMAN değiştirdi"
    "bu kural ne zaman değişti"
    "bu kayıt neden silindi"
Aynı gün eklenen `KESIM_TOLERANS` izi de tam bu yüzden doğrulanamadı.

── DOKTRİNLER ───────────────────────────────────────────────────────────────
· SALT OKUR — bu modül audit_log'a (ya da başka bir tabloya) TEK SATIR YAZMAZ.
  Denetim defterini değiştirebilen bir uç, defterin kendisini anlamsız kılar.
  (Aynı ilke VERI-011'de "sıfırla" listesinden audit_log'u çıkarmıştı.)
· ŞEMA VARSAYILMAZ — prod `audit_log` koddan ESKİ bir şemayla kurulmuş
  olabilir (`CREATE TABLE IF NOT EXISTS` yeni kolon eklemez) ve aktör
  migrasyonu `lock_timeout`'a takılıp ATLANMIŞ olabilir
  (bkz. database.ensure_audit_aktor). Kolon adları information_schema'dan
  OKUNUR; olmayan kolona sorgu yazmak tüm ekranı çökertirdi.
· AKTÖR KAYBOLMAZ — aktör kolonu yoksa `audit()` aktörü `yeni_deger` JSON'una
  `_aktor/_aktor_id/_aktor_kaynak` olarak koyar. Okuma bunu da toplar; yoksa
  sahip "kim yaptı" sorusunun cevabını defterde varken göremezdi.
· 'beyan' DOĞRULANMIŞ DEĞİLDİR — aktor_kaynak='beyan', istemcinin SÖYLEDİĞİ
  kimliktir. Doğrulanmış kimlikle aynı görünmesin diye her satırda
  `aktor_guvenilir` bayrağıyla ayrılır.
· HATA ≠ BOŞ — sorgu düşerse "kayıt yok" DENMEZ; okunamadığı AÇIKÇA yazılır.
  Yoksa arıza, "hiç iz yok" gibi görünür ve sahip olmayan bir gerçeğe inanır.
· SESSİZ KIRPMA YOK — kaç satır gösterildiği, devamı olup olmadığı ve
  varsayılan tarih penceresinin ne olduğu her yanıtta yazılıdır.

── PERFORMANS / İNDEKS NOTU ─────────────────────────────────────────────────
`audit_log`'da PK dışında indeks YOKTUR ve bilerek eklenmemiştir: sıcak
tabloda indeks kurmak yazmayı bloklar (aynı tuzak canlıyı 15 dk 502'ye
düşürdü). Bu yüzden BURADAKİ HER SORGU ZAMAN PENCERESİYLE SINIRLIDIR ve
kendi `statement_timeout`'u vardır — yavaşlarsa uygulamayı bekletmez, dürüst
bir "okunamadı" döner. Tablo büyüyüp ekran yavaşlarsa indeks ELLE, transaction
DIŞINDA açılmalıdır:
    CREATE INDEX CONCURRENTLY idx_audit_log_olusturma ON audit_log (olusturma DESC);
    CREATE INDEX CONCURRENTLY idx_audit_log_kayit ON audit_log (tablo, kayit_id);
"""
from __future__ import annotations

import json
import logging
import re
from datetime import date, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query

from database import db, savepoint

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/denetim-izi", tags=["denetim-izi"])

# Okuma sorgusu ne kadar beklesin — uygulamayı asla bekletme.
_SORGU_TIMEOUT = "12s"

# Şema süreç ömrü boyunca bir kez ölçülür (None = henüz ölçülmedi).
_SEMA: Optional[Dict[str, Any]] = None

# Aktör, kolon yoksa yeni_deger JSON'una bu anahtarlarla yazılır (kasa_service.audit)
_JSON_AKTOR = "_aktor"
_JSON_AKTOR_ID = "_aktor_id"
_JSON_AKTOR_KAYNAK = "_aktor_kaynak"

# aktor_kaynak değerlerinden hangileri DOĞRULANMIŞ kimliktir.
# 'beyan' bilerek dışarıda: istemcinin söylediği, doğrulanmamış addır.
_GUVENILIR_KAYNAK = {"isletme_pin", "panel_pin", "oturum", "sistem"}

# "Geçmişe dokunan" işlem örüntüsü — duyu_gorunumler._GERIYE_DONUK_ISLEMLER ile
# aynı aileyi tarif eder; orası YOĞUNLUK sayar, burası SATIRI gösterir.
_RISKLI_ORUNTU = ("IPTAL", "GERI_AL", "DUZELT", "TERS", "SIL", "TEMIZLE", "MUKERRER")

_AD = re.compile(r"[a-z_][a-z0-9_]*")


def _sema(cur) -> Dict[str, Any]:
    """audit_log'un GERÇEK kolonlarını prod'un kendisinden okur, cache'ler."""
    global _SEMA
    if _SEMA is not None:
        return _SEMA
    kolonlar: Dict[str, str] = {}
    try:
        # ⚠️ SAVEPOINT: yutulan bir cur.execute transaction'ı ZEHİRLER —
        # sonraki her sorgu InFailedSqlTransaction ile düşerdi.
        with savepoint(cur, "sp_audit_sema"):
            cur.execute(
                """
                SELECT column_name, data_type FROM information_schema.columns
                WHERE table_name = 'audit_log'
                ORDER BY ordinal_position
                """
            )
            for r in (cur.fetchall() or []):
                d = dict(r)
                ad = str(d.get("column_name") or "")
                if _AD.fullmatch(ad):
                    kolonlar[ad] = str(d.get("data_type") or "")
    except Exception:
        logger.warning("audit_log şeması okunamadı", exc_info=True)
        kolonlar = {}

    zaman = None
    for ad, tip in kolonlar.items():
        if tip.startswith("timestamp") or tip == "date":
            zaman = ad
            break

    _SEMA = {
        "var": bool(kolonlar),
        "kolonlar": kolonlar,
        "zaman": zaman,
        "aktor": "aktor" in kolonlar,
        "aktor_id": "aktor_id" in kolonlar,
        "aktor_kaynak": "aktor_kaynak" in kolonlar,
    }
    return _SEMA


def _json_coz(ham: Any) -> Any:
    """eski_deger/yeni_deger metni sözlüğe çevirir; çözülemezse HAM METNİ döndürür.
    ⚠️ None DÖNDÜRMEZ: çözülemeyen bir değeri yutmak, defterde yazan bilgiyi
    ekranda yok göstermektir."""
    if ham is None:
        return None
    if isinstance(ham, (dict, list)):
        return ham
    s = str(ham)
    try:
        return json.loads(s)
    except Exception:
        return {"_ham": s}


def _satir(r: Dict[str, Any], sema: Dict[str, Any]) -> Dict[str, Any]:
    """Bir audit_log satırını ekrana hazır hâle getirir: JSON çözülür, aktör
    (kolondan ya da JSON yedeğinden) toplanır, DEĞİŞEN ALANLAR hesaplanır."""
    eski = _json_coz(r.get("eski_deger"))
    yeni = _json_coz(r.get("yeni_deger"))

    aktor = (r.get("aktor") or None) if sema["aktor"] else None
    aktor_id = (r.get("aktor_id") or None) if sema["aktor_id"] else None
    kaynak = (r.get("aktor_kaynak") or None) if sema["aktor_kaynak"] else None

    # Aktör kolonu yoksa audit() onu yeni_deger JSON'una koymuştu — oradan al.
    yedekten = False
    if isinstance(yeni, dict):
        if not aktor and yeni.get(_JSON_AKTOR):
            aktor, yedekten = str(yeni[_JSON_AKTOR]), True
        if not aktor_id and yeni.get(_JSON_AKTOR_ID):
            aktor_id, yedekten = str(yeni[_JSON_AKTOR_ID]), True
        if not kaynak and yeni.get(_JSON_AKTOR_KAYNAK):
            kaynak, yedekten = str(yeni[_JSON_AKTOR_KAYNAK]), True

    gorunen = yeni
    if isinstance(yeni, dict) and yedekten:
        gorunen = {k: v for k, v in yeni.items()
                   if k not in (_JSON_AKTOR, _JSON_AKTOR_ID, _JSON_AKTOR_KAYNAK, "_not")}

    degisen: List[Dict[str, Any]] = []
    if isinstance(eski, dict) and isinstance(gorunen, dict):
        for k in sorted(set(eski) | set(gorunen)):
            if k.startswith("_"):
                continue
            a, b = eski.get(k), gorunen.get(k)
            if str(a) != str(b):
                degisen.append({"alan": k, "eski": a, "yeni": b})

    islem = str(r.get("islem") or "")
    return {
        "id": r.get("id"),
        "tablo": r.get("tablo"),
        "kayit_id": r.get("kayit_id"),
        "islem": islem,
        "zaman": r.get("_zaman"),
        "aktor": aktor,
        "aktor_id": aktor_id,
        "aktor_kaynak": kaynak,
        # 'beyan' ve aktörsüz satır DOĞRULANMIŞ SAYILMAZ — ekran ikisini ayırsın.
        "aktor_guvenilir": bool(kaynak and kaynak in _GUVENILIR_KAYNAK),
        "aktor_yedekten": yedekten,   # kolon yoktu, JSON'dan kurtarıldı
        "eski_deger": eski,
        "yeni_deger": gorunen,
        "degisen_alanlar": degisen,
        "riskli": any(p in islem.upper() for p in _RISKLI_ORUNTU),
    }


def _pencere(bas: Optional[str], bit: Optional[str], varsayilan_gun: int):
    """Tarih penceresini normalize eder. Pencere ZORUNLUDUR: indekssiz sıcak
    tabloda sınırsız sorgu tüm worker'ı yiyebilir."""
    try:
        b = date.fromisoformat(bas) if bas else (date.today() - timedelta(days=varsayilan_gun - 1))
    except ValueError:
        raise HTTPException(400, f"Geçersiz başlangıç tarihi: {bas} (YYYY-AA-GG bekleniyor)")
    try:
        s = date.fromisoformat(bit) if bit else date.today()
    except ValueError:
        raise HTTPException(400, f"Geçersiz bitiş tarihi: {bit} (YYYY-AA-GG bekleniyor)")
    if b > s:
        raise HTTPException(400, "Başlangıç tarihi bitişten sonra olamaz.")
    return b, s


def _sema_yok_yaniti(ek: Dict[str, Any]) -> Dict[str, Any]:
    yanit: Dict[str, Any] = {
        "okunabildi": False,
        "not": "audit_log tablosu ya da zaman kolonu bulunamadı — denetim izi şema "
               "uyumu bekliyor. (Veri silinmedi; yalnızca okunamıyor.)",
    }
    yanit.update(ek)
    return yanit


# ══════════════════════════════════════════════════════════════════════════
# ⚠️ ROTA SIRASI: statik uçlar ÖNCE, yol-parametreli uçlar EN SONDA.
# Bu projede dosya ortasındaki bir `/{id}` rotası kendisinden sonra kaydedilen
# statik uçları yutmuştu (`/cari-odenecekler` böyle kaybolmuştu, ödeme ekranı
# kördü). scripts/kapi_kontrol.py bunu ölçer.
# ══════════════════════════════════════════════════════════════════════════


@router.get("/ozet")
def denetim_izi_ozet(gun: int = Query(30, ge=1, le=365)):
    """Filtre seçenekleri + defterin kaba büyüklüğü. Ekran açılışında çağrılır."""
    bas, bit = _pencere(None, None, gun)
    with db() as (_, cur):
        sema = _sema(cur)
        if not sema["var"] or not sema["zaman"]:
            return _sema_yok_yaniti({"kesit": {"bas": str(bas), "bit": str(bit), "gun": gun},
                                     "tablolar": [], "islemler": [], "aktorler": [],
                                     "toplam": 0, "sema": {"aktor_kolonu": False}})
        zk = sema["zaman"]
        aktor_kaynak_sec = "aktor_kaynak" if sema["aktor_kaynak"] else "NULL::text AS aktor_kaynak"
        try:
            cur.execute(f"SET LOCAL statement_timeout = '{_SORGU_TIMEOUT}'")
            cur.execute(
                f"""SELECT tablo, COUNT(*)::int AS adet, MAX({zk})::text AS son
                    FROM audit_log WHERE {zk} >= %s AND {zk} < (%s::date + 1)
                    GROUP BY tablo ORDER BY adet DESC LIMIT 200""",
                (str(bas), str(bit)),
            )
            tablolar = [dict(r) for r in (cur.fetchall() or [])]
            cur.execute(
                f"""SELECT islem, COUNT(*)::int AS adet
                    FROM audit_log WHERE {zk} >= %s AND {zk} < (%s::date + 1)
                    GROUP BY islem ORDER BY adet DESC LIMIT 200""",
                (str(bas), str(bit)),
            )
            islemler = [dict(r) for r in (cur.fetchall() or [])]
            aktorler: List[Dict[str, Any]] = []
            if sema["aktor"]:
                cur.execute(
                    f"""SELECT aktor, {aktor_kaynak_sec}, COUNT(*)::int AS adet
                        FROM audit_log
                        WHERE {zk} >= %s AND {zk} < (%s::date + 1) AND aktor IS NOT NULL
                        GROUP BY 1,2 ORDER BY adet DESC LIMIT 100""",
                    (str(bas), str(bit)),
                )
                aktorler = [dict(r) for r in (cur.fetchall() or [])]
            cur.execute(
                f"""SELECT COUNT(*)::int AS n,
                           MIN({zk})::text AS ilk, MAX({zk})::text AS son
                    FROM audit_log WHERE {zk} >= %s AND {zk} < (%s::date + 1)""",
                (str(bas), str(bit)),
            )
            k = dict(cur.fetchone() or {})
        except Exception as e:  # noqa: BLE001
            logger.warning("denetim izi özeti okunamadı", exc_info=True)
            return _sema_yok_yaniti({
                "kesit": {"bas": str(bas), "bit": str(bit), "gun": gun},
                "tablolar": [], "islemler": [], "aktorler": [], "toplam": 0,
                "sema": {"aktor_kolonu": sema["aktor"]},
                "not": f"Denetim defteri okunamadı ({type(e).__name__}). Bu 'iz yok' "
                       f"DEMEK DEĞİLDİR — sorgu tamamlanamadı.",
            })

    toplam = int(k.get("n") or 0)
    return {
        "okunabildi": True,
        "kesit": {"bas": str(bas), "bit": str(bit), "gun": gun,
                  "ilk_kayit": k.get("ilk"), "son_kayit": k.get("son")},
        "toplam": toplam,
        "tablolar": tablolar,
        "islemler": islemler,
        "aktorler": aktorler,
        "sema": {
            "aktor_kolonu": sema["aktor"],
            "not": None if sema["aktor"] else
                   "audit_log'da aktör kolonu YOK (migrasyon kilide takılmış olabilir). "
                   "Aktör bilgisi varsa yeni_deger JSON'undan kurtarılıyor.",
        },
        "not": "Denetim defteri SALT OKUNUR. Bu ekran hiçbir izi değiştiremez/silemez.",
    }


@router.get("/ara")
def denetim_izi_ara(
    tablo: Optional[str] = Query(None, description="Tablo adı (tam eşleşme)"),
    kayit_id: Optional[str] = Query(None, description="Kayıt kimliği (tam eşleşme)"),
    islem: Optional[str] = Query(None, description="İşlem türü (tam eşleşme)"),
    aktor: Optional[str] = Query(None, description="Aktör adı/kimliği (içerir)"),
    q: Optional[str] = Query(None, description="Eski/yeni değer metninde ara (içerir)"),
    riskli: bool = Query(False, description="Yalnız iptal/geri-al/düzeltme/silme izleri"),
    bas: Optional[str] = Query(None, description="Başlangıç YYYY-AA-GG"),
    bit: Optional[str] = Query(None, description="Bitiş YYYY-AA-GG (dahil)"),
    gun: int = Query(30, ge=1, le=365, description="bas verilmezse son N gün"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    sayim: bool = Query(False, description="Eşleşen toplam satırı da say (yavaş olabilir)"),
):
    """Filtreli, sayfalı denetim izi araması — en yeni önce."""
    b, s = _pencere(bas, bit, gun)
    with db() as (_, cur):
        sema = _sema(cur)
        if not sema["var"] or not sema["zaman"]:
            return _sema_yok_yaniti({"kesit": {"bas": str(b), "bit": str(s)},
                                     "satirlar": [], "gosterilen": 0, "devam_var": False,
                                     "toplam": None})
        zk = sema["zaman"]

        kosul = [f"{zk} >= %s", f"{zk} < (%s::date + 1)"]
        par: List[Any] = [str(b), str(s)]
        if tablo:
            kosul.append("tablo = %s")
            par.append(tablo)
        if kayit_id:
            kosul.append("kayit_id = %s")
            par.append(kayit_id)
        if islem:
            kosul.append("islem = %s")
            par.append(islem)
        if aktor:
            if sema["aktor"]:
                # Aktör kolonu varken bile JSON yedeğinde kalmış satırlar olabilir
                # (migrasyon geç geldi) — ikisini de ara, yoksa geçmiş yarım görünür.
                parcalar = ["aktor ILIKE %s"]
                par.append(f"%{aktor}%")
                if sema["aktor_id"]:
                    parcalar.append("aktor_id ILIKE %s")
                    par.append(f"%{aktor}%")
                parcalar.append("COALESCE(yeni_deger,'') ILIKE %s")
                par.append(f"%_aktor%{aktor}%")
                kosul.append("(" + " OR ".join(parcalar) + ")")
            else:
                kosul.append("COALESCE(yeni_deger,'') ILIKE %s")
                par.append(f"%_aktor%{aktor}%")
        if q:
            kosul.append("(COALESCE(eski_deger,'') ILIKE %s OR COALESCE(yeni_deger,'') ILIKE %s "
                         "OR kayit_id ILIKE %s)")
            par += [f"%{q}%", f"%{q}%", f"%{q}%"]
        if riskli:
            kosul.append("(" + " OR ".join(["UPPER(islem) LIKE %s"] * len(_RISKLI_ORUNTU)) + ")")
            par += [f"%{p}%" for p in _RISKLI_ORUNTU]

        nerede = " AND ".join(kosul)
        toplam = None
        try:
            cur.execute(f"SET LOCAL statement_timeout = '{_SORGU_TIMEOUT}'")
            if sayim:
                cur.execute(f"SELECT COUNT(*)::int AS n FROM audit_log WHERE {nerede}", par)
                toplam = int(dict(cur.fetchone() or {}).get("n") or 0)
            # limit+1 çekilir: "devamı var mı" sorusunun cevabı COUNT'suz alınır
            # (indekssiz tabloda her sayfada tam sayım pahalıya patlar).
            cur.execute(
                f"""SELECT *, {zk}::text AS _zaman FROM audit_log
                    WHERE {nerede} ORDER BY {zk} DESC, id DESC LIMIT %s OFFSET %s""",
                par + [limit + 1, offset],
            )
            ham = [dict(r) for r in (cur.fetchall() or [])]
        except Exception as e:  # noqa: BLE001
            logger.warning("denetim izi araması düştü", exc_info=True)
            return _sema_yok_yaniti({
                "kesit": {"bas": str(b), "bit": str(s)},
                "satirlar": [], "gosterilen": 0, "devam_var": False, "toplam": None,
                "not": f"Denetim defteri okunamadı ({type(e).__name__}). Bu 'iz yok' "
                       f"DEMEK DEĞİLDİR — sorgu tamamlanamadı. Tarih aralığını daralt.",
            })

    devam = len(ham) > limit
    satirlar = [_satir(r, sema) for r in ham[:limit]]
    return {
        "okunabildi": True,
        "kesit": {"bas": str(b), "bit": str(s), "gun": None if bas else gun},
        "filtre": {"tablo": tablo, "kayit_id": kayit_id, "islem": islem,
                   "aktor": aktor, "q": q, "riskli": riskli},
        "satirlar": satirlar,
        "gosterilen": len(satirlar),
        "offset": offset,
        "limit": limit,
        "devam_var": devam,
        "toplam": toplam,   # yalnız sayim=true istendiyse dolu
        "not": None if toplam is not None else
               "Toplam sayı hesaplanmadı (indekssiz sıcak tablo). 'devam_var' bir sonraki "
               "sayfanın olup olmadığını söyler; kesin sayı için sayim=true.",
    }


@router.get("/tablolar")
def denetim_izi_tablolar(gun: int = Query(365, ge=1, le=3650)):
    """Defterde izi olan tablolar — filtre açılır listesi için (geniş pencere)."""
    bas, bit = _pencere(None, None, gun)
    with db() as (_, cur):
        sema = _sema(cur)
        if not sema["var"] or not sema["zaman"]:
            return _sema_yok_yaniti({"tablolar": []})
        zk = sema["zaman"]
        try:
            cur.execute(f"SET LOCAL statement_timeout = '{_SORGU_TIMEOUT}'")
            cur.execute(
                f"""SELECT tablo, COUNT(*)::int AS adet FROM audit_log
                    WHERE {zk} >= %s AND {zk} < (%s::date + 1)
                    GROUP BY tablo ORDER BY tablo LIMIT 300""",
                (str(bas), str(bit)),
            )
            tablolar = [dict(r) for r in (cur.fetchall() or [])]
        except Exception:
            logger.warning("denetim izi tablo listesi okunamadı", exc_info=True)
            return _sema_yok_yaniti({"tablolar": []})
    return {"okunabildi": True, "kesit": {"bas": str(bas), "bit": str(bit)},
            "tablolar": tablolar}


# ── YOL PARAMETRELİ UÇ — DOSYANIN SONUNDA (rota gölgelenmesi) ───────────────
@router.get("/kayit/{tablo}/{kayit_id}")
def denetim_izi_kayit(tablo: str, kayit_id: str, limit: int = Query(200, ge=1, le=500)):
    """TEK bir kaydın tüm geçmişi — ESKİDEN YENİYE. Kayıt detay panelindeki
    'geçmiş' bölümünün beslendiği uç.

    ⚠️ Burada tarih penceresi YOKTUR ve olması da doğru değildir: bir kaydın
    geçmişi 'son 30 gün' değil, DOĞUMUNDAN BUGÜNE'dir. Pencere yerine
    `tablo`+`kayit_id` eşitliği sorguyu daraltır."""
    if not tablo or not kayit_id:
        raise HTTPException(400, "tablo ve kayit_id zorunlu")
    with db() as (_, cur):
        sema = _sema(cur)
        if not sema["var"] or not sema["zaman"]:
            return _sema_yok_yaniti({"tablo": tablo, "kayit_id": kayit_id,
                                     "satirlar": [], "adet": 0})
        zk = sema["zaman"]
        try:
            cur.execute(f"SET LOCAL statement_timeout = '{_SORGU_TIMEOUT}'")
            cur.execute(
                f"""SELECT *, {zk}::text AS _zaman FROM audit_log
                    WHERE tablo = %s AND kayit_id = %s
                    ORDER BY {zk} ASC, id ASC LIMIT %s""",
                (tablo, kayit_id, limit + 1),
            )
            ham = [dict(r) for r in (cur.fetchall() or [])]
        except Exception as e:  # noqa: BLE001
            logger.warning("kayıt geçmişi okunamadı", exc_info=True)
            return _sema_yok_yaniti({
                "tablo": tablo, "kayit_id": kayit_id, "satirlar": [], "adet": 0,
                "not": f"Kaydın geçmişi okunamadı ({type(e).__name__}). Bu 'geçmiş yok' "
                       f"DEMEK DEĞİLDİR — sorgu tamamlanamadı.",
            })

    kirpildi = len(ham) > limit
    satirlar = [_satir(r, sema) for r in ham[:limit]]
    return {
        "okunabildi": True,
        "tablo": tablo,
        "kayit_id": kayit_id,
        "satirlar": satirlar,
        "adet": len(satirlar),
        "kirpildi": kirpildi,
        "ilk": satirlar[0]["zaman"] if satirlar else None,
        "son": satirlar[-1]["zaman"] if satirlar else None,
        "not": ("Yalnız ilk %d iz gösterildi — daha fazlası var." % limit) if kirpildi else
               ("Bu kayıt için denetim defterinde iz yok. Not: iz yalnız `audit()` çağıran "
                "akışlarda doğar; izsizlik 'değişiklik olmadı' anlamına GELMEZ."
                if not satirlar else None),
    }
