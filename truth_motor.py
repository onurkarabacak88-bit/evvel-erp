"""
TRUTH ESTABLISHMENT MOTOR — İzole tanı motoru

Konsept: Akşamcı beyanı (N1) + Sabahcı kör sayım (N2) + Evo POS gerçeği (N3) → üçgenleme.
5 paralel boyutta çalışır: kasa, plastik bardak, karton bardak, redbull/soda, pasta.

Güvenlik:
  - Env var EVVEL_TRUTH_MOTOR_ENABLED=1 olmadan ASLA çalışmaz (global kill switch)
  - Her şubeye truth_motor_ayar.aktif=TRUE gerekir
  - Default mod 'read_only' — sadece tanı üretir, hiçbir kaynak tabloyu değiştirmez
  - 'apply' modu için ayrıca CFO onayı endpoint'i (henüz eklenmedi)

Bu modül:
  - SADECE okuma yapar (sube_operasyon_event, evo_satis, ciro)
  - SADECE truth_motor_kararlar tablosuna yazar (append-only log)
  - Hiçbir mevcut motoru, scheduler'ı, hesap akışını etkilemez
  - Hata atarsa try/except ile yutulur — ana akışta crash yok

Pattern: Google SRE Toil reduction + Netflix Bulkhead (izolasyon).
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, asdict, field
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)


# ════════════════════════════════════════════════════════════════════════════
#  FEATURE FLAG — global kill switch
# ════════════════════════════════════════════════════════════════════════════

def _global_aktif() -> bool:
    """Env var ile global aç/kapat. Çalışmazsa flag=0 → motor tamamen pasif."""
    v = str(os.getenv("EVVEL_TRUTH_MOTOR_ENABLED", "0")).strip().lower()
    return v in ("1", "true", "yes", "on")


def sube_aktif_mi(cur, sube_id: str) -> bool:
    """Per-şube aktiflik. Hem global flag hem şube ayarı gerekli."""
    if not _global_aktif():
        return False
    try:
        cur.execute(
            "SELECT aktif FROM truth_motor_ayar WHERE sube_id=%s",
            (sube_id,),
        )
        row = cur.fetchone()
        if not row:
            return False
        return bool(dict(row).get("aktif"))
    except Exception as e:
        log.warning("truth_motor sube_aktif_mi hata: %s", e)
        return False


def sube_mod(cur, sube_id: str) -> str:
    """Şube modu — 'read_only' veya 'apply'. Default read_only."""
    try:
        cur.execute(
            "SELECT mod FROM truth_motor_ayar WHERE sube_id=%s",
            (sube_id,),
        )
        row = cur.fetchone()
        if not row:
            return "read_only"
        return str(dict(row).get("mod") or "read_only")
    except Exception:
        return "read_only"


# ════════════════════════════════════════════════════════════════════════════
#  DATA CLASSES — boyut & karar
# ════════════════════════════════════════════════════════════════════════════

BOYUTLAR = ("kasa", "bardak_plastik", "bardak_karton", "redbull_soda", "pasta")

TANI_TIPLERI = (
    "UYUMLU",
    "IKRAM_UNUTULDU",        # N1=N2, Evo eksik, kasa normal
    "SWEETHEARTING_SINYAL",  # N1=N2, Evo eksik + kasa fazla
    "SABAH_HATALI",          # tek boyut: N1≠N2, Evo N1'i destekliyor
    "AKSAM_HATALI",          # tek boyut: N1≠N2, Evo N2'yi destekliyor
    "SABAH_TOPYEKUN",        # çoklu boyut hepsi N1 yönünde → sabah dikkat zayıf
    "AKSAM_TOPYEKUN",        # çoklu boyut hepsi N2 yönünde → akşam dikkat zayıf
    "KAOS",                  # her iki taraf da hatalı, Evo nötr
    "COZULMEDI",             # tek boyut, Evo nötr → Truth Walk
    "POS_SYNC_HATA",         # tüm sayım UYUMLU ama Evo hep farklı
    "AKSAM_ZIMMET_SINYALI",  # kasa+ & bardak− & Evo bardak destekli
    "POS_BYPASS",            # bardak eksik ama Evo yok → kayıt dışı satış
    "YETERSIZ_VERI",         # N1 veya N2 yok
)

# Her tanı için (otomatik aksiyon, insan aksiyonu, alarm seviyesi)
EYLEM_MAP: Dict[str, Dict[str, str]] = {
    "UYUMLU":                {"oto": "log_yesil",        "insan": "—",                                       "alarm": "yok"},
    "IKRAM_UNUTULDU":        {"oto": "uyari_dusuk",      "insan": "Z raporu kontrol et, ikram defteri sor", "alarm": "dusuk"},
    "SWEETHEARTING_SINYAL":  {"oto": "kasa_baskini_oner","insan": "Kasa Baskını başlat, kamera incele",     "alarm": "yuksek"},
    "SABAH_HATALI":          {"oto": "sabah_update_oner","insan": "Sabahcı PIN ile teyit, gerekirse 3. say","alarm": "orta"},
    "AKSAM_HATALI":          {"oto": "aksam_update_oner","insan": "Akşamcı çağır, PIN teyit",               "alarm": "orta"},
    "SABAH_TOPYEKUN":        {"oto": "sabah_supheli_tag","insan": "Sabahcı + 3. kişi tüm boyutları say",    "alarm": "yuksek"},
    "AKSAM_TOPYEKUN":        {"oto": "aksam_supheli_tag","insan": "Akşamcı performans incele, eğitim",      "alarm": "yuksek"},
    "KAOS":                  {"oto": "cfo_bildirim",     "insan": "Fiziksel soruşturma + güvenlik kamerası","alarm": "yuksek"},
    "COZULMEDI":             {"oto": "truth_walk_iste",  "insan": "3. kişi sayım talep et",                 "alarm": "orta"},
    "POS_SYNC_HATA":         {"oto": "evo_refresh_iste", "insan": "Evobulut destek + IT kontrol",           "alarm": "orta"},
    "AKSAM_ZIMMET_SINYALI":  {"oto": "cfo_bildirim_log", "insan": "Soruşturma, kamera, 3-ay pattern bak",   "alarm": "kritik"},
    "POS_BYPASS":            {"oto": "evo_yetki_kontrol","insan": "Evo yetki + manuel iade kontrol",        "alarm": "yuksek"},
    "YETERSIZ_VERI":         {"oto": "—",                "insan": "Eksik sayımı tamamla",                   "alarm": "yok"},
}


@dataclass
class BoyutVeri:
    """Tek bir boyut için 3 kaynaklı ölçüm."""
    boyut: str
    n1_aksam: Optional[float] = None    # önceki gün KAPANIS beyanı (devir / kapanış sayım)
    n2_sabah: Optional[float] = None    # bugün ACILIS kör sayımı
    n3_evo: Optional[float] = None      # POS gerçeği (önceki günkü satış)


@dataclass
class Tani:
    """Bir boyut için üretilen tanı."""
    sube_id: str
    tarih: str
    boyut: str
    n1_aksam: Optional[float]
    n2_sabah: Optional[float]
    n3_evo: Optional[float]
    fark_n1_n2: Optional[float]
    evo_destek: str   # 'n1' | 'n2' | 'notr' | 'yok'
    tani: str         # TANI_TIPLERI'nden biri
    guven_skoru: float
    detay: Dict[str, Any] = field(default_factory=dict)


# ════════════════════════════════════════════════════════════════════════════
#  ÜÇGENLEME ALGORITMASI — tek boyut için
# ════════════════════════════════════════════════════════════════════════════

# Tolerans eşikleri — boyut başına ayarlanabilir
_TOLERANS = {
    "kasa":           1.00,   # ₺
    "bardak_plastik": 0,      # adet
    "bardak_karton":  0,      # adet
    "redbull_soda":   0,      # adet
    "pasta":          0,      # adet (dilim toleransı)
}


def _esit(a: Optional[float], b: Optional[float], tol: float) -> bool:
    if a is None or b is None:
        return False
    return abs(float(a) - float(b)) <= tol


def boyut_taniyi_uret(sube_id: str, tarih: str, veri: BoyutVeri) -> Tani:
    """Tek boyut için üçgenleme."""
    boyut = veri.boyut
    tol = _TOLERANS.get(boyut, 0)
    n1, n2, n3 = veri.n1_aksam, veri.n2_sabah, veri.n3_evo

    # Yetersiz veri kontrolü
    if n1 is None or n2 is None:
        return Tani(
            sube_id=sube_id, tarih=tarih, boyut=boyut,
            n1_aksam=n1, n2_sabah=n2, n3_evo=n3,
            fark_n1_n2=None, evo_destek="yok",
            tani="YETERSIZ_VERI", guven_skoru=0.0,
            detay={"sebep": "n1 veya n2 eksik"},
        )

    fark = round(float(n2) - float(n1), 2)
    n1_n2_esit = _esit(n1, n2, tol)

    # N3 (Evo) destek analizi
    evo_destek = "yok"
    if n3 is not None:
        if _esit(n3, n1, tol) and not n1_n2_esit:
            evo_destek = "n1"
        elif _esit(n3, n2, tol) and not n1_n2_esit:
            evo_destek = "n2"
        else:
            evo_destek = "notr"

    # Tanı matrisi
    if n1_n2_esit:
        if n3 is None or _esit(n3, n1, tol):
            tani = "UYUMLU"
            guven = 95.0 if n3 is not None else 70.0
        else:
            # N1=N2 ama Evo farklı — sweethearting veya ikram
            tani = "IKRAM_UNUTULDU"
            guven = 60.0  # SWEETHEARTING_SINYAL çapraz boyut analizinde yükseltilir
    else:
        # N1 ≠ N2 — uzlaşmazlık
        if evo_destek == "n1":
            tani = "SABAH_HATALI"   # sabahcı yanlış saymış
            guven = 85.0
        elif evo_destek == "n2":
            tani = "AKSAM_HATALI"   # akşamcı yanlış yazmış (zimmet riski)
            guven = 85.0
        else:
            tani = "COZULMEDI"
            guven = 40.0

    return Tani(
        sube_id=sube_id, tarih=tarih, boyut=boyut,
        n1_aksam=n1, n2_sabah=n2, n3_evo=n3,
        fark_n1_n2=fark, evo_destek=evo_destek,
        tani=tani, guven_skoru=guven,
        detay={"tolerans": tol},
    )


def capraz_boyut_yorumla(taniler: List[Tani]) -> List[Tani]:
    """Karar Matrix Engine v2 — 12 senaryo cascade.

    Çapraz boyut analizi:
      1. Topyekun pattern: çoklu boyutta hep aynı yönde hata → SABAH_TOPYEKUN / AKSAM_TOPYEKUN
      2. Kasa+ & bardak− → SWEETHEARTING veya AKSAM_ZIMMET_SINYALI (Evo destekliyorsa)
      3. Bardak eksik & Evo yok → POS_BYPASS
      4. Tüm sayım UYUMLU & Evo hep farklı → POS_SYNC_HATA
      5. Tek boyut COZULMEDI + diğerler UYUMLU → COZULMEDI olduğu gibi kalır

    Mevcut taniler in-place güncellenir; yeni tani da eklenebilir.
    """
    kasa = next((t for t in taniler if t.boyut == "kasa"), None)
    urun_taniler = [t for t in taniler if t.boyut != "kasa"]

    # ─── 1. POS_SYNC_HATA — tüm sayım uyumlu ama Evo hep farklı ───
    if all(t.tani == "UYUMLU" for t in taniler):
        evo_farkli = sum(
            1 for t in taniler
            if t.n3_evo is not None
            and t.n2_sabah is not None
            and not _esit(t.n3_evo, t.n2_sabah, _TOLERANS.get(t.boyut, 0))
        )
        if evo_farkli >= 3:
            for t in taniler:
                t.tani = "POS_SYNC_HATA"
                t.detay["sebep"] = "tüm sayım uyumlu ama Evo POS hep farklı → sync hatası"
                t.guven_skoru = 75.0
            return taniler

    # ─── 2. SABAH_TOPYEKUN / AKSAM_TOPYEKUN — çoklu boyut aynı yönde ───
    sabah_hata_sayisi = sum(1 for t in taniler if t.tani == "SABAH_HATALI")
    aksam_hata_sayisi = sum(1 for t in taniler if t.tani == "AKSAM_HATALI")
    if sabah_hata_sayisi >= 3:
        for t in taniler:
            if t.tani == "SABAH_HATALI":
                t.tani = "SABAH_TOPYEKUN"
                t.detay["capraz"] = f"{sabah_hata_sayisi} boyutta sabahcı hatası → topyekun dikkat zayıf"
                t.guven_skoru = 85.0
    elif aksam_hata_sayisi >= 3:
        for t in taniler:
            if t.tani == "AKSAM_HATALI":
                t.tani = "AKSAM_TOPYEKUN"
                t.detay["capraz"] = f"{aksam_hata_sayisi} boyutta akşamcı hatası → topyekun dikkat zayıf"
                t.guven_skoru = 85.0

    # ─── 3. KAOS — N1≠N2 birden fazla boyutta + Evo nötr/yok ───
    cozulmedi_sayisi = sum(1 for t in taniler if t.tani == "COZULMEDI")
    if cozulmedi_sayisi >= 2:
        # Birden fazla boyutta üçgenleme başarısız → KAOS
        for t in taniler:
            if t.tani == "COZULMEDI":
                t.tani = "KAOS"
                t.detay["capraz"] = f"{cozulmedi_sayisi} boyutta çözülemedi → fiziksel soruşturma"
                t.guven_skoru = 30.0

    # ─── 4. SWEETHEARTING / AKSAM_ZIMMET_SINYALI / IKRAM_UNUTULDU ───
    # Kasa fazlası varsa + ürünlerde eksiklik (sayım veya Evo)
    kasa_fazla = (kasa is not None and kasa.fark_n1_n2 is not None and kasa.fark_n1_n2 > 1.0)
    kasa_eksik = (kasa is not None and kasa.fark_n1_n2 is not None and kasa.fark_n1_n2 < -1.0)

    for t in urun_taniler:
        if t.boyut == "kasa":
            continue
        # Ürün eksik durumu (sayım azalmış ama Evo yok)
        sayim_eksik = (t.n1_aksam is not None and t.n2_sabah is not None
                       and t.n2_sabah < t.n1_aksam)
        evo_destekli = (t.n3_evo is not None and t.n1_aksam is not None
                        and _esit(t.n3_evo, abs(t.n1_aksam - (t.n2_sabah or 0)), _TOLERANS.get(t.boyut, 0)))

        if t.tani == "IKRAM_UNUTULDU":
            if kasa_fazla and not evo_destekli:
                # Kasa fazla + ürün eksik + Evo yok → para alındı POS'a girmedi
                t.tani = "SWEETHEARTING_SINYAL"
                t.guven_skoru = 80.0
                t.detay["capraz"] = (
                    f"Kasa +{kasa.fark_n1_n2:.2f}₺ fazla & {t.boyut} eksik & Evo yok → "
                    "satış kayıt dışı (sweethearting)"
                )
            elif kasa_fazla and evo_destekli:
                t.tani = "AKSAM_ZIMMET_SINYALI"
                t.guven_skoru = 70.0
                t.detay["capraz"] = (
                    f"Kasa +{kasa.fark_n1_n2:.2f}₺ fazla & {t.boyut} eksik & Evo destekli → "
                    "akşamcı zimmet pre-pozisyonu olabilir"
                )
            elif sayim_eksik and t.n3_evo is None:
                t.tani = "POS_BYPASS"
                t.guven_skoru = 65.0
                t.detay["capraz"] = f"{t.boyut} sayımı eksildi ama Evo'da satış yok → kayıt dışı kullanım"

    # ─── 5. Çapraz sinyalleri kasa tanısına yansıt ───
    sinyal_tani = [t.tani for t in urun_taniler if t.tani in
                   ("SWEETHEARTING_SINYAL", "AKSAM_ZIMMET_SINYALI", "POS_BYPASS")]
    if kasa is not None and sinyal_tani:
        kasa.detay["capraz_sinyaller"] = sinyal_tani

    return taniler


def eylem_oner(tani: str) -> Dict[str, str]:
    """Tanı için (otomatik aksiyon kodu, insan eylemi, alarm seviyesi) döner."""
    return EYLEM_MAP.get(tani, EYLEM_MAP["YETERSIZ_VERI"])


# ════════════════════════════════════════════════════════════════════════════
#  KARAR YAZMA — append-only log
# ════════════════════════════════════════════════════════════════════════════

def kararlari_kaydet(cur, taniler: List[Tani]) -> int:
    """Üretilen tanıları truth_motor_kararlar tablosuna yazar. Sayıyı döner."""
    n = 0
    for t in taniler:
        try:
            cur.execute(
                """
                INSERT INTO truth_motor_kararlar
                    (sube_id, tarih, boyut, n1_aksam, n2_sabah, n3_evo,
                     fark_n1_n2, evo_destek, tani, guven_skoru, detay_json)
                VALUES (%s, %s::date, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                """,
                (
                    t.sube_id, t.tarih, t.boyut,
                    t.n1_aksam, t.n2_sabah, t.n3_evo,
                    t.fark_n1_n2, t.evo_destek, t.tani, t.guven_skoru,
                    json.dumps(t.detay, ensure_ascii=False, default=str),
                ),
            )
            n += 1
        except Exception as e:
            log.warning("truth_motor karar yazılamadı sube=%s boyut=%s: %s",
                        t.sube_id, t.boyut, e)
    return n


# ════════════════════════════════════════════════════════════════════════════
#  VERİ TOPLAYICI — 3 kaynak read-only
# ════════════════════════════════════════════════════════════════════════════

def _meta_oku(meta_raw: Any) -> Dict[str, Any]:
    """sube_operasyon_event.meta — TEXT (JSON string) veya JSONB olabilir."""
    if not meta_raw:
        return {}
    if isinstance(meta_raw, dict):
        return meta_raw
    try:
        return json.loads(str(meta_raw))
    except Exception:
        return {}


def _meta_sayi(m: Dict[str, Any], *keys: str) -> Optional[float]:
    """meta sözlüğünden sayı topla (birden fazla anahtar = toplam)."""
    s, var = 0.0, False
    for k in keys:
        v = m.get(k)
        if v is None:
            continue
        try:
            s += float(v); var = True
        except (TypeError, ValueError):
            pass
    return s if var else None


def _previous_day(tarih: str) -> str:
    """YYYY-MM-DD → bir önceki gün."""
    from datetime import date as _d, timedelta as _td
    y, mo, d = (int(x) for x in str(tarih)[:10].split("-"))
    return (_d(y, mo, d) - _td(days=1)).isoformat()


def veri_topla(cur, sube_id: str, tarih: str) -> List[BoyutVeri]:
    """5 boyut için (kasa + 4 ürün) N1/N2/N3 üçlüsünü topla.

    N1 = önceki gün KAPANIS (akşamcı beyanı)
    N2 = bugün ACILIS (sabahcı kör sayım)
    N3 = önceki günkü Evo POS satışı (fiziksel azalmayı doğrular)

    NOT: Evo verisi yoksa N3=None bırakılır → tanı 'YETERSIZ_VERI' veya düşük güven olur.
    """
    onceki = _previous_day(tarih)

    # N1 — Önceki gün KAPANIS
    cur.execute(
        """
        SELECT COALESCE(kasa_sayim, 0) AS kasa, COALESCE(devir, 0) AS devir, meta
        FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=%s::date AND tip='KAPANIS' AND durum='tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST LIMIT 1
        """,
        (sube_id, onceki),
    )
    kap = cur.fetchone()
    if kap:
        kap = dict(kap)
        n1_kasa = float(kap.get("devir") or 0)  # akşam devir = sabah açılış beklentisi
        n1_meta = _meta_oku(kap.get("meta")).get("kapanis_stok_sayim") or {}
    else:
        n1_kasa = None
        n1_meta = {}

    # N2 — Bugün ACILIS
    cur.execute(
        """
        SELECT COALESCE(kasa_sayim, 0) AS kasa, meta
        FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=%s::date AND tip='ACILIS' AND durum='tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST LIMIT 1
        """,
        (sube_id, tarih),
    )
    ac = cur.fetchone()
    if ac:
        ac = dict(ac)
        n2_kasa = float(ac.get("kasa") or 0)
        n2_meta = _meta_oku(ac.get("meta")).get("acilis_stok_sayim") or {}
    else:
        n2_kasa = None
        n2_meta = {}

    # N3 — Önceki günkü Evo POS satışları (lazy, opsiyonel)
    # evo_satis veya benzeri bir tablodan satış adetleri çekilir.
    # Şema bilinmediği için defensive try/except.
    evo: Dict[str, float] = {}
    try:
        cur.execute(
            """
            SELECT urun_ad, COALESCE(SUM(adet),0) AS adet
            FROM evo_satis
            WHERE sube_id=%s AND tarih=%s::date
            GROUP BY urun_ad
            """,
            (sube_id, onceki),
        )
        for r in (cur.fetchall() or []):
            d = dict(r)
            evo[str(d.get("urun_ad", "")).lower()] = float(d.get("adet") or 0)
    except Exception:
        # evo_satis tablosu yok veya farklı şema — N3 yok kabul edilir
        evo = {}

    def _evo(*anahtar_parcalari: str) -> Optional[float]:
        """evo dict'inden ürün adına göre arama (substring)."""
        if not evo:
            return None
        s, var = 0.0, False
        for k, adet in evo.items():
            if any(p in k for p in anahtar_parcalari):
                s += adet; var = True
        return s if var else None

    # Boyut → kaynak haritası
    return [
        BoyutVeri(
            boyut="kasa",
            n1_aksam=n1_kasa,
            n2_sabah=n2_kasa,
            n3_evo=None,  # kasa için Evo direkt karşılaştırılmaz (ciro_nakit ayrı kontrol)
        ),
        BoyutVeri(
            boyut="bardak_plastik",
            n1_aksam=_meta_sayi(n1_meta, "bardak_plastik"),
            n2_sabah=_meta_sayi(n2_meta, "bardak_plastik"),
            n3_evo=_evo("plastik bardak", "plastik_bardak"),
        ),
        BoyutVeri(
            boyut="bardak_karton",
            n1_aksam=_meta_sayi(n1_meta, "bardak_kucuk", "bardak_buyuk"),
            n2_sabah=_meta_sayi(n2_meta, "bardak_kucuk", "bardak_buyuk"),
            n3_evo=_evo("karton bardak", "kucuk bardak", "buyuk bardak"),
        ),
        BoyutVeri(
            boyut="redbull_soda",
            n1_aksam=_meta_sayi(n1_meta, "redbull_adet", "soda_adet"),
            n2_sabah=_meta_sayi(n2_meta, "redbull_adet", "soda_adet"),
            n3_evo=_evo("redbull", "soda"),
        ),
        BoyutVeri(
            boyut="pasta",
            n1_aksam=_meta_sayi(n1_meta, "pasta_adet"),
            n2_sabah=_meta_sayi(n2_meta, "pasta_adet"),
            n3_evo=_evo("pasta"),
        ),
    ]


# ════════════════════════════════════════════════════════════════════════════
#  PUBLIC API — entry point
# ════════════════════════════════════════════════════════════════════════════

def motor_calistir(cur, sube_id: str, tarih: str,
                   veriler: List[BoyutVeri]) -> Dict[str, Any]:
    """
    Ana giriş noktası. Verilen boyut verileri için tanı üretir + log'a yazar.

    Args:
        cur: psycopg2 cursor (dict_cursor)
        sube_id: şube
        tarih: YYYY-MM-DD (bugün ACILIS günü)
        veriler: 5 boyut için ölçümler (her biri BoyutVeri)

    Returns:
        {
          "calisti": bool,
          "sebep": str (calisti=False ise),
          "mod": "read_only" | "apply",
          "taniler": [{"boyut", "tani", "guven_skoru", ...}],
          "kaydedildi": int,
        }
    """
    if not sube_aktif_mi(cur, sube_id):
        return {
            "calisti": False,
            "sebep": "Motor bu şube için pasif (feature flag veya şube ayarı kapalı)",
            "mod": None, "taniler": [], "kaydedildi": 0,
        }

    mod = sube_mod(cur, sube_id)

    # Her boyut için üçgenle
    taniler: List[Tani] = []
    for v in veriler:
        if v.boyut not in BOYUTLAR:
            log.warning("truth_motor bilinmeyen boyut atlandı: %s", v.boyut)
            continue
        taniler.append(boyut_taniyi_uret(sube_id, tarih, v))

    # Çapraz boyut yorumla (sweethearting, sistemik hata, topyekun)
    taniler = capraz_boyut_yorumla(taniler)

    # Eylem önerisi enjekte et
    for t in taniler:
        t.detay["eylem"] = eylem_oner(t.tani)

    # Log'a yaz
    kaydedildi = kararlari_kaydet(cur, taniler)

    # ─── KASA BASKINI OTOMATİK TETİK ───
    # SWEETHEARTING veya AKSAM_ZIMMET → otomatik baskın öner (apply modunda hemen başlat)
    baskin_tetik = otomatik_baskin_tetik(cur, sube_id, tarih, taniler, mod)

    # Şube ayar son_calisma güncelle
    try:
        cur.execute(
            "UPDATE truth_motor_ayar SET son_calisma=NOW() WHERE sube_id=%s",
            (sube_id,),
        )
    except Exception:
        pass

    log.info("truth_motor sube=%s tarih=%s mod=%s kaydedildi=%d",
             sube_id, tarih, mod, kaydedildi)

    return {
        "calisti": True,
        "sebep": None,
        "mod": mod,
        "taniler": [asdict(t) for t in taniler],
        "kaydedildi": kaydedildi,
        "baskin_tetik": baskin_tetik,
    }


# ════════════════════════════════════════════════════════════════════════════
#  KASA BASKINI OTOMATİK TETİK
# ════════════════════════════════════════════════════════════════════════════

def otomatik_baskin_tetik(cur, sube_id: str, tarih: str,
                           taniler: List[Tani], mod: str) -> Optional[Dict[str, Any]]:
    """SWEETHEARTING_SINYAL veya AKSAM_ZIMMET_SINYALI tespit edildiğinde
    otomatik Kasa Baskını önerir (apply modunda hemen başlatır).

    Returns:
        None — tetik yok
        {"oneri": True, ...} — read_only modda, sadece öneri
        {"baslatildi": True, "id": ...} — apply modda, baskın açıldı
    """
    yuksek_tehdit = [
        t for t in taniler
        if t.tani in ("SWEETHEARTING_SINYAL", "AKSAM_ZIMMET_SINYALI")
    ]
    if not yuksek_tehdit:
        return None

    sebep_listesi = [t.tani for t in yuksek_tehdit]
    notu = (
        "🤖 Akıllı Denetim otomatik öneri — "
        f"{', '.join(sebep_listesi)} tespit edildi"
    )

    if mod != "apply":
        return {"oneri": True, "tani": sebep_listesi, "notu": notu}

    # apply mod — baskını gerçekten başlat
    try:
        # Aynı şubede aktif baskın varsa çift başlatma
        cur.execute(
            "SELECT id FROM kasa_baskini WHERE sube_id=%s AND durum='aktif' LIMIT 1",
            (sube_id,),
        )
        if cur.fetchone():
            return {"baslatildi": False, "sebep": "Zaten aktif baskın var", "tani": sebep_listesi}

        # Beklenen tutarı hesapla (basit formül)
        cur.execute("""
            SELECT COALESCE(kasa_sayim,0) AS k FROM sube_operasyon_event
            WHERE sube_id=%s AND tarih=%s::date AND tip='ACILIS' AND durum='tamamlandi'
            ORDER BY cevap_ts DESC NULLS LAST LIMIT 1
        """, (sube_id, tarih))
        acilis = float((cur.fetchone() or {}).get("k") or 0)
        cur.execute("""
            SELECT COALESCE(SUM(nakit),0) AS n FROM ciro
            WHERE sube_id=%s AND tarih=%s::date AND durum='aktif'
        """, (sube_id, tarih))
        z = float((cur.fetchone() or {}).get("n") or 0)
        cur.execute("""
            SELECT COALESCE(SUM(tutar),0) AS t FROM anlik_giderler
            WHERE sube=%s AND tarih=%s::date
              AND LOWER(COALESCE(NULLIF(TRIM(odeme_yontemi),''),'nakit'))='nakit'
              AND durum IN ('aktif','onay_bekliyor')
        """, (sube_id, tarih))
        g = float((cur.fetchone() or {}).get("t") or 0)
        beklenen = round(acilis + z - g, 2)

        import uuid as _u
        bid = str(_u.uuid4())
        cur.execute(
            """
            INSERT INTO kasa_baskini
                (id, sube_id, baslatan_cfo_id, baslatan_cfo_ad,
                 son_tarih_ts, beklenen_tutar, notu, durum)
            VALUES (%s, %s, 'auto_truth_motor', 'Akıllı Denetim (otomatik)',
                    NOW() + INTERVAL '20 minutes', %s, %s, 'aktif')
            """,
            (bid, sube_id, beklenen, notu),
        )
        log.warning("AKILLI_DENETIM otomatik kasa baskını sube=%s id=%s sebep=%s",
                    sube_id, bid, sebep_listesi)
        return {"baslatildi": True, "id": bid, "tani": sebep_listesi, "beklenen": beklenen}
    except Exception as e:
        log.exception("Otomatik baskın tetiklenemedi: %s", e)
        return {"baslatildi": False, "hata": str(e), "tani": sebep_listesi}
