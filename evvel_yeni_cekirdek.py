"""🧩 EVVEL YENİ · ÇEKİRDEK (2026-10-17) — sahip: "özellik ekleyebilmek/kaldırabilmek için alt yapı BAĞIMSIZ kurulsun".

Codex + Fable mimari denetimi: modüller birbirinin İÇ (_) fonksiyonlarını kullanıyordu (Kasa 2.119 satır "her şeyin ortağı");
bir modülü çıkarmak başka modülleri kırıyordu. Kural:

  · ÇEKİRDEK HİÇBİR MODÜLÜ IMPORT ETMEZ. Yalnız ortak, sektörden bağımsız yardımcılar: tarih/iş günü, para (kuruş/TL),
    oturumdaki kişi, yazma kilidi + KAYIT DEFTERLERİ (registry).
  · Modüller çekirdeği ve diğer modüllerin yalnız PUBLIC (alt çizgisiz) servis fonksiyonlarını kullanır.
  · Toplayıcılar (Bekleyen işler …) modülleri TANIMAZ: her modül kendi sağlayıcısını kayıt defterine bırakır; modül
    kaldırılınca kaydı da gider, toplayıcı bozulmaz.
"""

import logging
import math
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Callable, Dict, List, Optional

from fastapi import HTTPException

from database import db, savepoint

log = logging.getLogger(__name__)

MAKS_KURUS = 10 ** 12          # 10 milyar ₺ — saçma girişe karşı sınır
KASA_KILIT = 7_012_026         # para defterinin tek yazma kilidi (pg_advisory_xact_lock)


# ─────────────────────────── TARİH ───────────────────────────
def bugun() -> date:
    """Türkiye TAKVİM günü (tr_saat.bugun_tr — gece yarısında değişir). Şube iş günü (02:00) için is_gunu() kullan (Fable düzeltmesi)."""
    try:
        from tr_saat import bugun_tr
        return bugun_tr()
    except Exception:  # noqa: BLE001
        return date.today()


def is_gunu() -> date:
    """Şube İŞ GÜNÜ: gece 00:00–02:00 arası hâlâ önceki gün (kapanış son teslim 02:00 — tr_saat.is_gunu_tr).
    Codex: yeni şube paneli takvim günü kullanıyordu; gece kapanışı ertesi güne yazılırdı."""
    try:
        from tr_saat import is_gunu_tr
        return is_gunu_tr()
    except Exception:  # noqa: BLE001
        return bugun()


def tr_saat(ts, gun: Optional[date] = None) -> Optional[str]:
    """TR saati "HH:MM"; kayıt verilen iş gününden FARKLI bir günde girildiyse "GG.AA HH:MM"."""
    if not ts:
        return None
    from zoneinfo import ZoneInfo
    try:
        t = ts.astimezone(ZoneInfo("Europe/Istanbul")) if getattr(ts, "tzinfo", None) else ts
        if gun is not None and t.date() != gun and not (t.date() == gun + timedelta(days=1) and t.hour < 6):
            return t.strftime("%d.%m %H:%M")
        return t.strftime("%H:%M")
    except Exception:  # noqa: BLE001
        return None


def tr_gun(ts) -> date:
    """Zaman damgasının Türkiye takvim günü."""
    from zoneinfo import ZoneInfo
    try:
        return (ts.astimezone(ZoneInfo("Europe/Istanbul")) if getattr(ts, "tzinfo", None) else ts).date()
    except Exception:  # noqa: BLE001
        return bugun()


def ay_kaydir(ay: str, n: int) -> str:
    """'2026-10', +1 → '2026-11'."""
    y, m = int(ay[:4]), int(ay[5:7])
    t = y * 12 + (m - 1) + n
    return f"{t // 12:04d}-{t % 12 + 1:02d}"


def tr_baslik(s: str) -> str:
    """'KÖYCEĞİZ' → 'Köyceğiz' (Türkçe I/İ kuralıyla; str.title() bozar)."""
    def kucuk(x):
        return x.replace("I", "ı").replace("İ", "i").lower()
    return " ".join((w[:1] + kucuk(w[1:])) if w else w for w in (s or "").split(" "))


# ─────────────────────────── PARA ───────────────────────────
def kurus(x) -> int:
    """Tutarı KURUŞA çevirir: Decimal ile, en fazla 2 ondalık, sonlu, sınırlı. Hatalı girişte 400."""
    try:
        d = Decimal(str(x))
    except (InvalidOperation, TypeError, ValueError):
        raise HTTPException(400, "Tutar sayı olmalı")
    if not d.is_finite() or (isinstance(x, float) and not math.isfinite(x)):
        raise HTTPException(400, "Tutar geçersiz")
    if d != d.quantize(Decimal("0.01")):
        raise HTTPException(400, "Tutar en fazla 2 ondalık (kuruş) olabilir")
    k = int(d * 100)
    if abs(k) > MAKS_KURUS:
        raise HTTPException(400, "Tutar çok büyük")
    return k


def kurus_yuvarla(x) -> int:
    """Hesaplanan (çarpım/oran) tutarı kuruşa YUVARLAYARAK çevirir — KDV çarpımı çok ondalık üretir."""
    return kurus(Decimal(str(x)).quantize(Decimal("0.01")))


def tl_sayi(k: int) -> float:
    return round(k / 100.0, 2)


def tl(k: int) -> str:
    tam, kr = divmod(abs(int(k)), 100)
    s = f"{tam:,}".replace(",", ".") + (f",{kr:02d}" if kr else "")
    return ("−" if k < 0 else "") + s + " ₺"


# ─────────────────────────── OTURUM / KİLİT ───────────────────────────
def kilit(cur, anahtar: int = KASA_KILIT) -> None:
    """İşlem sonuna kadar süren yazma kilidi (aynı anahtar = sıraya girer)."""
    cur.execute("SELECT pg_advisory_xact_lock(%s)", (anahtar,))


def aktor(cur, jeton: Optional[str]) -> str:
    """Kaydı yapan — oturum jetonundan (istemciden gelen isim yazılmaz)."""
    try:
        from admin_oturum import jeton_coz
        gecerli, _, kid = jeton_coz(jeton or "")
        if not gecerli:
            return "oturumsuz"
        if kid:
            with savepoint(cur, "sp_pi_aktor"):
                cur.execute("SELECT ad FROM kullanici WHERE id=%s", (kid,))
                r = cur.fetchone()
                if r and dict(r).get("ad"):
                    return str(dict(r)["ad"])[:60]
        return "yönetim (ortak giriş)"
    except Exception:  # noqa: BLE001
        return "bilinmiyor"


# ─────────────────────────── AYAR (tek ayar defteri) ───────────────────────────
_AYAR_HAZIR = False


def _ayar_hazirla(cur) -> None:
    """Codex: tablo ÇAĞIRANIN işleminde kurulursa o işlem geri alındığında tablo kaybolur ama bayrak kalırdı →
    ayrı kısa işlemde, süreçlerarası kilit altında kurulur; bayrak yalnız başarılı commit sonrası açılır."""
    global _AYAR_HAZIR
    if _AYAR_HAZIR:
        return
    with db() as (_c, c2):
        c2.execute("SELECT pg_advisory_xact_lock(7012044)")
        c2.execute("SET LOCAL lock_timeout = '3s'")
        c2.execute("""CREATE TABLE IF NOT EXISTS ey_ayar (
            anahtar TEXT PRIMARY KEY, deger TEXT, degistiren TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    _AYAR_HAZIR = True


def ayar_oku(cur, anahtar: str, varsayilan: Optional[str] = None) -> Optional[str]:
    """Modüllerin ortak ayarı (ör. 'donem_baslangic' = yeni panelle sıfırdan başlama günü). Yoksa varsayılan."""
    _ayar_hazirla(cur)
    cur.execute("SELECT deger FROM ey_ayar WHERE anahtar=%s", (anahtar,))
    r = cur.fetchone()
    return dict(r)["deger"] if r else varsayilan


def panel_baslangic(cur) -> date:
    """PUBLIC: yeni panelin gerçek kayda geçtiği gün (ey_ayar 'panel_baslangic', varsayılan 1 Kasım) — TEK yerde ayrıştırılır."""
    try:
        return date.fromisoformat((ayar_oku(cur, "panel_baslangic", "2026-11-01") or "2026-11-01")[:10])
    except ValueError:
        return date(2026, 11, 1)


def yeni_donem(cur) -> bool:
    """PUBLIC: panel_baslangic (1 Kasım) geldi mi — okuyucular bundan sonra YALNIZ Evvel Yeni kaynaklarını (yeni katalog
    kimliği) okur; öncesi geçiş (eski aktarım). Tek kural, tek yer (Fable altyapı denetimi)."""
    return bugun() >= panel_baslangic(cur)


def ayar_yaz(cur, anahtar: str, deger: Optional[str], kim: str) -> None:
    _ayar_hazirla(cur)
    cur.execute("""INSERT INTO ey_ayar (anahtar, deger, degistiren) VALUES (%s,%s,%s)
                   ON CONFLICT (anahtar) DO UPDATE SET deger=EXCLUDED.deger, degistiren=EXCLUDED.degistiren, zaman=NOW()""",
                (anahtar, deger, kim))


# ─────────────────────────── KAYIT DEFTERLERİ (registry) ───────────────────────────
# Bekleyen işler: her sağlayıcı (cur, baglam) → [ {tur, id, tarih, ad, ...} ]. baglam = {"kayit": para defteri kayıtları, "C": cepler}
_BEKLEYEN_IS: Dict[str, Callable] = {}


def bekleyen_is_kaydet(ad: str, saglayici: Callable) -> None:
    """Modül, Bekleyen işler'e kendi satırlarını bu kayıtla ekler. Modül kaldırılırsa kaydı da kalkar."""
    _BEKLEYEN_IS[ad] = saglayici


def bekleyen_isler(cur, baglam: dict) -> List[dict]:
    """Kayıtlı bütün sağlayıcıları — her biri kendi savepoint'inde; biri hata verirse diğerleri yine gelir."""
    out: List[dict] = []
    for ad, f in list(_BEKLEYEN_IS.items()):
        try:
            with savepoint(cur, f"sp_ey_bi_{ad}"[:60]):
                out.extend(f(cur, baglam) or [])
        except Exception as e:  # noqa: BLE001
            log.warning("bekleyen işler sağlayıcısı '%s' okunamadı: %s", ad, str(e)[:150])
    return out


def bekleyen_saglayicilar() -> List[str]:
    return sorted(_BEKLEYEN_IS)


__all__ = ["bugun", "tr_saat", "tr_gun", "ay_kaydir", "tr_baslik", "kurus", "kurus_yuvarla", "tl_sayi", "tl", "kilit", "aktor",
           "bekleyen_is_kaydet", "bekleyen_isler", "bekleyen_saglayicilar", "MAKS_KURUS", "KASA_KILIT", "datetime",
           "ayar_oku", "ayar_yaz", "is_gunu"]
