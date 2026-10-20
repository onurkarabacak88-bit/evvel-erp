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


def tr_duvar(ts):
    """Saat dilimli zamanı TR duvar saatine (DİLİMSİZ) çevir — panel saatleri dilimsiz TR tutulur (Codex C3). Dilimsiz gelirse aynen."""
    if ts is None or getattr(ts, "tzinfo", None) is None:
        return ts
    from zoneinfo import ZoneInfo
    return ts.astimezone(ZoneInfo("Europe/Istanbul")).replace(tzinfo=None)


def tr_tarih_saat(ts) -> Optional[str]:
    """TR "GG.AA HH:MM" (yoksa None)."""
    if not ts:
        return None
    from zoneinfo import ZoneInfo
    try:
        return (ts.astimezone(ZoneInfo("Europe/Istanbul")) if getattr(ts, "tzinfo", None) else ts).strftime("%d.%m %H:%M")
    except Exception:  # noqa: BLE001
        return None


def simdi_tr():
    """Şu an — Türkiye saati, dilimli (container UTC; dilimsiz datetime.now() 3 saat erken yazıyordu)."""
    try:
        from tr_saat import dt_now_tr
        return dt_now_tr()
    except Exception:  # noqa: BLE001
        return datetime.now()


def is_gunu_zamani(gun: date, hh: int, mm: int):
    """İş günü + "SS:DD" → TR dilimli zaman. 02:00'den önceki saat ERTESİ takvim gününe düşer (iş günü kuralıyla aynı)."""
    from zoneinfo import ZoneInfo
    g = gun + (timedelta(days=1) if hh < 2 else timedelta(0))
    return datetime(g.year, g.month, g.day, hh, mm, tzinfo=ZoneInfo("Europe/Istanbul"))


def tr_gun(ts) -> date:
    """Zaman damgasının Türkiye takvim günü."""
    from zoneinfo import ZoneInfo
    try:
        return (ts.astimezone(ZoneInfo("Europe/Istanbul")) if getattr(ts, "tzinfo", None) else ts).date()
    except Exception:  # noqa: BLE001
        return bugun()


_TR_ABC = "abcçdefgğhıijklmnoöprsştuüvwxyz"


def tr_sira(s) -> tuple:
    """Türkçe alfabe sıralama anahtarı (Ç, Ğ, İ, Ö, Ş, Ü yerinde; büyük/küçük harf duyarsız). Python'un kod noktası sırası
    'Çağla'yı 'Zeynep'ten sonraya atıyordu (Fable Dalga 3 B6 — SQL ORDER BY Türkçe sıralıyordu)."""
    t = str(s or "").replace("I", "ı").replace("İ", "i").lower()
    return tuple((_TR_ABC.index(ch) if ch in _TR_ABC else 100 + ord(ch)) for ch in t)


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


MAKS_ADET = 99_999   # tek adet üst sınırı (sevk / kabul / sipariş / sayım aynı — önce 99.999 ile 100.000 ayrışmıştı)


def adet_oku(v, ad: str = "Adet", en_az: int = 0, en_cok: int = MAKS_ADET) -> int:
    """PUBLIC — TEK adet kuralı (Dalga 4, F#17): tam sayı, en_az..en_cok; "12" ve "12,0" kabul, 1,5 / eksi / boş / True reddedilir.
    Önce 4 ayrı yazım vardı (biri float ile, biri Decimal ile, ikisi yalnız int; sınırlar farklı)."""
    if isinstance(v, bool) or v is None or (isinstance(v, str) and not v.strip()):
        raise HTTPException(400, f"{ad}: sayı yaz")
    try:
        d = Decimal(str(v).strip().replace(",", "."))
    except (InvalidOperation, ValueError):
        raise HTTPException(400, f"{ad}: sayı yaz")
    if not d.is_finite() or d != d.to_integral_value():
        raise HTTPException(400, f"{ad}: tam sayı yaz")
    if d < en_az or d > en_cok:
        raise HTTPException(400, f"{ad}: {en_az} – {en_cok:,} arası yaz".replace(",", "."))
    return int(d)


def kalem_topla(kalemler, oneri_olur: bool = False, en_cok_kalem: int = 80, birim: str = "pakette") -> tuple:
    """PUBLIC — [{urun_id, adet}] listesini doğrula + aynı ürünü topla → ({urun_id: adet}, öneriler). oneri_olur: ürün kimliği yoksa
    katalog dışı {ad, adet} öneri (Sipariş D4). Sipariş ve Sevk aynı döngüyü ayrı yazıyordu (Dalga 4, F#22)."""
    top, oneriler = {}, []
    for x in kalemler or []:
        x = x if isinstance(x, dict) else {}
        a = adet_oku(x.get("adet"), "Adet", en_az=1)
        u = str(x.get("urun_id") or "").strip()
        if u:
            top[u] = top.get(u, 0) + a
        elif oneri_olur:
            ad = " ".join(str(x.get("ad") or "").split())[:80]
            if len(ad) < 2:
                raise HTTPException(400, "Katalogda olmayan ürünün adını yaz")
            oneriler.append({"ad": ad, "adet": a})
        else:
            raise HTTPException(400, "Ürün seçilmemiş kalem var — listeyi yenile")
    if not top and not oneriler:
        raise HTTPException(400, "En az bir ürün seç")
    if len(top) + len(oneriler) > en_cok_kalem:
        raise HTTPException(400, f"Bir {birim} en çok {en_cok_kalem} kalem")
    return top, oneriler


def tl_sayi(k) -> float:
    """Kuruş → ₺ sayı (ekrana / JSON). None → 0."""
    return round(int(k or 0) / 100.0, 2)


def tutar_oku(x, ad: str = "Tutar") -> Decimal:
    """Telefondan / formdan gelen TÜRKÇE tutar yazısı → Decimal (₺). "1.250,50" · "1250,50" · "1250.50" · 1250.5 hepsi aynı.
    Tek nokta ve 3 hane ("1.250") BİN ayıracıdır (Türkçe) — önce '.replace(",", ".")' bunu 1,25 ₺ okuyordu (Dalga 4, F#5).
    Ön yüzdeki karşılığı src/utils/trSayi.js sayiTR."""
    if x is None or isinstance(x, bool) or (isinstance(x, str) and not x.strip()):
        raise HTTPException(400, f"{ad}: tutarı yaz")
    if isinstance(x, (int, float, Decimal)):
        s = str(x)
    else:
        s = str(x).strip().replace(" ", "").replace("₺", "")
        if "," in s:
            s = s.replace(".", "").replace(",", ".")
        elif s.count(".") > 1 or (s.count(".") == 1 and len(s.split(".")[1]) == 3):
            s = s.replace(".", "")
    try:
        d = Decimal(s)
    except (InvalidOperation, ValueError):
        raise HTTPException(400, f"{ad}: sayı olarak yaz")
    if not d.is_finite():
        raise HTTPException(400, f"{ad}: geçersiz")
    return d


def tl(k: int) -> str:
    tam, kr = divmod(abs(int(k)), 100)
    s = f"{tam:,}".replace(",", ".") + (f",{kr:02d}" if kr else "")
    return ("−" if k < 0 else "") + s + " ₺"


# ─────────────────────────── OTURUM / KİLİT ───────────────────────────
def kilit(cur, anahtar: int = KASA_KILIT) -> None:
    """İşlem sonuna kadar süren yazma kilidi (aynı anahtar = sıraya girer)."""
    cur.execute("SELECT pg_advisory_xact_lock(%s)", (anahtar,))


class KuruGeriAl(Exception):
    """PUBLIC — deneme (kuru) modunda işlem yapılır, sonuç okunur, savepoint/işlem GERİ ALINIR (sonuç taşıyabilir). Panel + Depo ortak (F#21)."""

    def __init__(self, sonuc: Optional[dict] = None):
        super().__init__("kuru")
        self.sonuc = sonuc


def tablo_var(cur, *adlar: str) -> bool:
    """PUBLIC — verilen tablo / indeks adlarının HEPSİ var mı (salt okur, kilit istemez). Dalga 4 (F#14): 6 yerel kopya + ~10 satır içi."""
    cur.execute("SELECT bool_and(to_regclass(x) IS NOT NULL) AS v FROM unnest(%s::text[]) AS x", (list(adlar),))
    return bool(dict(cur.fetchone() or {}).get("v"))


def merkez_aktor(cur, jeton: Optional[str]) -> str:
    """PUBLIC — merkez ucu kapısı: geçerli oturumun adı, yoksa 401 (Dalga 4, F#2: aynı 3 satır 12 yerde)."""
    kim = aktor(cur, jeton)
    if kim in ("oturumsuz", "bilinmiyor"):
        raise HTTPException(401, "Merkez oturumu gerekli")
    return kim


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


def eski_panel_zinciri_acik() -> bool:
    """PUBLIC 🔌 TEK ANAHTAR: eski panel tablolarına bakan gece/gündüz işleri (main.py halkaları, beyin gece WhatsApp'ı) çalışsın mı?
    İş günü < panel_baslangic → açık. ey_ayar 'eski_gece_zinciri'='acik' → zorla açık (geri dönüş, silinmez).
    Ayar okunamazsa (Codex #8) sabit 1 Kasım'a göre karar verir — hata yüzünden kesimden sonra eski uyarı üretilmez."""
    try:
        with db() as (_c, cur):
            if (ayar_oku(cur, "eski_gece_zinciri", "") or "").strip() == "acik":
                return True
            return is_gunu() < panel_baslangic(cur)
    except Exception as e:  # noqa: BLE001
        log.warning("🔌 eski panel zinciri anahtarı okunamadı (sabit 1 Kasım'a göre): %s", str(e)[:150])
        return is_gunu() < date(2026, 11, 1)


def yeni_donem(cur, gun: Optional[date] = None) -> bool:
    """PUBLIC — TEK KURAL "1 Kasım geldi mi" (tekrar denetimi F#1/F#23/C-T1-17: 12 yerde ayrı yazılmış, bir kısmı TAKVİM bir kısmı İŞ
    gününe bakıyordu → 1 Kasım 00:00–02:00 arası okuyucular yeni evrene geçip yazıcılar hâlâ denemedeydi). Artık HEPSİ İŞ GÜNÜ
    (gece 02:00'ye kadar önceki gün). gun verilirse o güne göre (ör. mutabakatta bakılan gün)."""
    return (gun or is_gunu()) >= panel_baslangic(cur)


def deneme_mi(cur, gun: Optional[date] = None) -> bool:
    """PUBLIC — deneme (kuru) dönemi mi: yeni_donem'in tersi. Panel / Depo / Sipariş kuru kapıları bunu kullanır."""
    return not yeni_donem(cur, gun)


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


__all__ = ["bugun", "tr_saat", "tr_gun", "tr_duvar", "tr_tarih_saat", "simdi_tr", "is_gunu_zamani", "ay_kaydir", "tr_baslik", "tr_sira", "kurus", "kurus_yuvarla", "tl_sayi", "tutar_oku", "adet_oku", "kalem_topla", "MAKS_ADET", "tl", "kilit", "aktor", "merkez_aktor", "tablo_var", "KuruGeriAl",
           "bekleyen_is_kaydet", "bekleyen_isler", "bekleyen_saglayicilar", "MAKS_KURUS", "KASA_KILIT", "datetime",
           "ayar_oku", "ayar_yaz", "is_gunu", "panel_baslangic", "yeni_donem", "deneme_mi", "takvim_durumu", "eski_panel_zinciri_acik"]


def takvim_durumu(beklenen, odenen, vade, bugun, once: bool = False, tolerans=100) -> str:
    """PUBLIC — ödeme takvimi hücresinin durumu TEK kural (tekrar denetimi C-T1-11: Kira/Kredi/Kart 'kısmi', Mülk 'gecikti' diyordu).
    Codex kuralı: vadesi GEÇMİŞ kısmi ödeme = gecikti. once=True: Evvel Yeni öncesi, kayıt yok — borç sayılmaz.
    tolerans: birim farkı (kuruş için 100 = 1 ₺; TL için 1)."""
    if beklenen is not None and odenen >= beklenen - tolerans:   # 0 ekstre = ödendi (eski davranış)
        return "odendi"
    if odenen > 0:
        return "gecikti" if (vade and vade < bugun) else "kismi"
    if once:
        return "once"
    if vade and vade < bugun:
        return "gecikti"
    if vade and (vade - bugun).days <= 7:
        return "yaklasiyor"
    return "gelecek"
