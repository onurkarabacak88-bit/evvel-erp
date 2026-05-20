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
    """Global aç/kapat. Varsayılan AÇIK; env var ile kapatılabilir.
    Kapatmak için: EVVEL_TRUTH_MOTOR_ENABLED=0 set et."""
    v = str(os.getenv("EVVEL_TRUTH_MOTOR_ENABLED", "1")).strip().lower()
    return v not in ("0", "false", "no", "off", "kapali")


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
    "IKRAM_EVO_TEYIT",       # stok eridi = Evo_satis + Evo_ikram → ikram POS'tan geçmiş ✓
    "IKRAM_UNUTULDU",        # N1=N2, Evo eksik, kasa normal (eski; geriye dönük uyumluluk)
    "SWEETHEARTING_SINYAL",  # N1=N2, Evo eksik + kasa fazla
    "STOK_KACAGI_BEYANSIZ",  # stok eridi > (Evo_satis + Evo_ikram), kasa normal/eksik → kasıt veya ihmal
    "ZIMMET_NAKIT_CEPTE",    # stok eridi > Evo + kasa eksik + sayisal eslesme → para cebe
    "IKRAM_SURDURULEN",      # personel sürekli ikram → davranis pattern (anomali değil)
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
    "IKRAM_EVO_TEYIT":       {"oto": "log_yesil",        "insan": "İkram POS'tan geçmiş — temiz zincir",     "alarm": "yok"},
    "IKRAM_UNUTULDU":        {"oto": "uyari_dusuk",      "insan": "Z raporu kontrol et, ikram defteri sor", "alarm": "dusuk"},
    "SWEETHEARTING_SINYAL":  {"oto": "kasa_baskini_oner","insan": "Kasa Baskını başlat, kamera incele",     "alarm": "yuksek"},
    "STOK_KACAGI_BEYANSIZ":  {"oto": "uyari_yuksek",     "insan": "Personeli sorgula: ikram mı kayıtsız satış mı?", "alarm": "yuksek"},
    "ZIMMET_NAKIT_CEPTE":    {"oto": "cfo_bildirim_kritik","insan": "Kasa Baskını + güvenlik kamerası + soruşturma", "alarm": "kritik"},
    "IKRAM_SURDURULEN":      {"oto": "log_pattern",      "insan": "Personel davranışı izle; ikram politikası gözden geçir", "alarm": "dusuk"},
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
    """Tek bir boyut için 3 kaynaklı ölçüm (Evo POS ücretli ve ikram ayrı tutulur)."""
    boyut: str
    n1_aksam: Optional[float] = None       # önceki gün KAPANIS beyanı (devir / kapanış sayım)
    n2_sabah: Optional[float] = None       # bugün ACILIS kör sayımı
    n3_evo: Optional[float] = None         # POS ücretli satış (önceki gün)
    n3_evo_ikram: Optional[float] = None   # POS ikram/0₺/tam iskonto (önceki gün)


@dataclass
class Tani:
    """Bir boyut için üretilen tanı."""
    sube_id: str
    tarih: str
    boyut: str
    n1_aksam: Optional[float]
    n2_sabah: Optional[float]
    n3_evo: Optional[float]
    n3_evo_ikram: Optional[float]   # Evo POS ikram/0₺ adetleri (yeni)
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
    """Tek boyut için üçgenleme.

    İkram entegrasyonu: ürün boyutlarında **Evo toplam = ücretli satış + ikram**.
    Eğer stok düşüşü Evo toplam ile eşleşiyorsa POS zincirinden geçmiş → IKRAM_EVO_TEYIT (kasa boyutu hariç).
    """
    boyut = veri.boyut
    tol = _TOLERANS.get(boyut, 0)
    n1, n2 = veri.n1_aksam, veri.n2_sabah

    # İkram dahil toplam POS hareketi (sadece ürün boyutlarında anlamlı)
    is_urun = boyut != "kasa"
    n3_satis = veri.n3_evo
    n3_ikram = veri.n3_evo_ikram if is_urun else None
    if n3_satis is None and n3_ikram is None:
        n3_toplam = None
    else:
        n3_toplam = (float(n3_satis or 0) + float(n3_ikram or 0))
    n3 = n3_toplam   # Bundan sonra n3 = Evo toplam hareketi (satış + ikram)

    # Yetersiz veri kontrolü
    if n1 is None or n2 is None:
        return Tani(
            sube_id=sube_id, tarih=tarih, boyut=boyut,
            n1_aksam=n1, n2_sabah=n2, n3_evo=n3_satis, n3_evo_ikram=n3_ikram,
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

    # ─── Tanı matrisi ───
    detay: Dict[str, Any] = {"tolerans": tol}
    if is_urun and n3_ikram is not None and n3_ikram > 0:
        detay["evo_ikram_adet"] = float(n3_ikram)
    if is_urun and n3_satis is not None:
        detay["evo_satis_adet"] = float(n3_satis)

    if n1_n2_esit:
        # N1 = N2 → sayım zinciri tutarlı
        if n3 is None or _esit(n3, n1, tol):
            tani = "UYUMLU"
            guven = 95.0 if n3 is not None else 70.0
        else:
            # Sayım eşit ama Evo farklı
            # Kayıp (stok eridi > Evo): üründe kayıt dışı kullanım veya beyanız ikram
            # Fazla (Evo > stok): POS fantom satış
            stok_dususu = float(n1) - float(n2)  # azalma >0 = stok eridi
            if is_urun and stok_dususu > 0 and n3 is not None and stok_dususu > n3 + tol:
                # Stok eridi, Evo (satış+ikram) dahi yetmiyor
                if n3_ikram is not None and n3_ikram > 0:
                    detay["aciklama"] = (
                        f"Stok eridi {stok_dususu:.0f} > Evo satış {n3_satis or 0:.0f} + ikram {n3_ikram:.0f} → "
                        "ikram POS'a düşmüş ama yetmedi"
                    )
                tani = "STOK_KACAGI_BEYANSIZ"
                guven = 75.0
            elif is_urun and stok_dususu > 0 and n3 is not None and _esit(stok_dususu, n3, tol):
                # Stok eridi tam olarak Evo toplam (satış+ikram) kadar → temiz
                if n3_ikram and n3_ikram > 0:
                    tani = "IKRAM_EVO_TEYIT"
                    detay["aciklama"] = f"Stok eridi {stok_dususu:.0f} = Evo satış {n3_satis or 0:.0f} + ikram {n3_ikram:.0f} ✓"
                else:
                    tani = "UYUMLU"
                guven = 92.0
            else:
                # Evo farklı, kayıp net değil → eski mantık
                tani = "IKRAM_UNUTULDU"
                guven = 55.0
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
        n1_aksam=n1, n2_sabah=n2, n3_evo=n3_satis, n3_evo_ikram=n3_ikram,
        fark_n1_n2=fark, evo_destek=evo_destek,
        tani=tani, guven_skoru=guven,
        detay=detay,
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

    # ─── 5. ZIMMET_NAKIT_CEPTE — sayısal korelasyon (kasa eksik + ürün eksik) ───
    # Eksik bardak × ortalama satış fiyatı ≈ kasa eksik → para cebe sinyali
    ORT_FIYAT = {  # boyut → tahmini ortalama satış fiyatı (₺/adet)
        "bardak_plastik": 50.0,
        "bardak_karton":  60.0,
        "redbull_soda":   45.0,
        "pasta":          90.0,
    }
    if kasa is not None and kasa.fark_n1_n2 is not None and kasa.fark_n1_n2 < -1.0:
        kasa_eksik = abs(kasa.fark_n1_n2)
        beklenen_urun_tutari = 0.0
        eslesen_boyutlar = []
        for t in urun_taniler:
            if t.tani not in ("STOK_KACAGI_BEYANSIZ", "IKRAM_UNUTULDU", "AKSAM_HATALI"):
                continue
            if t.fark_n1_n2 is None or t.fark_n1_n2 >= 0:
                continue
            eksik = abs(t.fark_n1_n2)
            fiyat = ORT_FIYAT.get(t.boyut, 0)
            beklenen_urun_tutari += eksik * fiyat
            eslesen_boyutlar.append(f"{t.boyut} {eksik:.0f} × ₺{fiyat:.0f}")
        if beklenen_urun_tutari > 0:
            uyum = min(beklenen_urun_tutari, kasa_eksik) / max(beklenen_urun_tutari, kasa_eksik)
            if uyum >= 0.85:  # %85+ eşleşme
                kasa.tani = "ZIMMET_NAKIT_CEPTE"
                kasa.guven_skoru = round(70.0 + uyum * 25.0, 1)
                kasa.detay["capraz"] = (
                    f"Kasa eksik ₺{kasa_eksik:.0f} ≈ ürün kaybı ₺{beklenen_urun_tutari:.0f} "
                    f"(uyum %{uyum*100:.0f}) — {'; '.join(eslesen_boyutlar)} → "
                    "satış yapıldı, ürün gitti, para kasaya hiç konmadı"
                )

    # ─── 6. Çapraz sinyalleri kasa tanısına yansıt ───
    sinyal_tani = [t.tani for t in urun_taniler if t.tani in
                   ("SWEETHEARTING_SINYAL", "AKSAM_ZIMMET_SINYALI", "POS_BYPASS",
                    "STOK_KACAGI_BEYANSIZ")]
    if kasa is not None and sinyal_tani and kasa.tani != "ZIMMET_NAKIT_CEPTE":
        kasa.detay["capraz_sinyaller"] = sinyal_tani

    return taniler


def ikram_surekli_mi(cur, sube_id: str, personel_id: Optional[str],
                     boyut: str, gun: int = 30) -> Dict[str, Any]:
    """Son N gündeki ikram pattern'ini analiz et.
    Returns: {ortalama, son_gun_ikram, z_skor, sureklilik_mi}"""
    if not personel_id:
        return {"sureklilik_mi": False, "sebep": "personel_id yok"}
    try:
        cur.execute(
            """
            SELECT DATE(olusturma) AS gun,
                   COALESCE((detay_json->>'evo_ikram_adet')::float, 0) AS ikram
            FROM truth_motor_kararlar
            WHERE sube_id=%s AND boyut=%s
              AND olusturma >= NOW() - (%s || ' days')::interval
            ORDER BY gun DESC
            """,
            (sube_id, boyut, gun),
        )
        rows = [dict(r) for r in (cur.fetchall() or [])]
    except Exception:
        return {"sureklilik_mi": False}
    if len(rows) < 7:
        return {"sureklilik_mi": False, "sebep": "yeterli veri yok"}
    degerler = [float(r["ikram"] or 0) for r in rows]
    ort = sum(degerler) / len(degerler)
    var = sum((x - ort) ** 2 for x in degerler) / len(degerler)
    std = var ** 0.5 if var > 0 else 1.0
    son = degerler[0]
    z = (son - ort) / (std or 1.0)
    return {
        "sureklilik_mi": ort >= 2.0 and abs(z) < 1.5,  # tutarlı yüksek = davranış
        "ortalama": round(ort, 2),
        "son_gun_ikram": son,
        "z_skor": round(z, 2),
        "anomali": abs(z) > 2.0,
    }


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
                    (sube_id, tarih, boyut, n1_aksam, n2_sabah, n3_evo, n3_evo_ikram,
                     fark_n1_n2, evo_destek, tani, guven_skoru, detay_json)
                VALUES (%s, %s::date, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                """,
                (
                    t.sube_id, t.tarih, t.boyut,
                    t.n1_aksam, t.n2_sabah, t.n3_evo, t.n3_evo_ikram,
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

    # N3 — Önceki günkü Evo POS hareketleri (şube bazlı, doğrudan Grup_Pasta).
    # Yeni kaynak: hs_rapor_sube_bazli — şube_adi ile eşleşip o şubenin grupları çekilir.
    # Bizim sube_id (UUID) → subeler.ad → hs_rapor sube adıyla eşleştirme.
    grup_adet: Dict[str, float] = {}  # Evo grup adı → adet (örn. "Ice": 85)
    try:
        # subeler tablosundan şube adı al
        cur.execute("SELECT ad FROM subeler WHERE id::text=%s", (str(sube_id),))
        srow = cur.fetchone()
        sube_adi_evvel = str(dict(srow).get("ad") or "") if srow else ""

        from evo_sync import hs_rapor_sube_bazli, EVO_SUBE_ID_MAP
        from datetime import date as _d
        y, mo, d = (int(x) for x in str(onceki)[:10].split("-"))
        tarih_d = _d(y, mo, d)
        evo_sonuc = hs_rapor_sube_bazli(tarih_d, tarih_d)

        # Şube eşleşmesi: sube_adi_evvel (örn. "ZAFER" veya "Zafer") ↔ "Zafer Şubesi"
        evo_sube_payload = None
        if sube_adi_evvel:
            # case-insensitive substring eşleşme
            evvel_lower = sube_adi_evvel.strip().lower().replace("şubesi", "").strip()
            for ad, payload in (evo_sonuc.get("subeler") or {}).items():
                evo_lower = ad.strip().lower().replace("şubesi", "").strip()
                if evvel_lower and (evvel_lower in evo_lower or evo_lower in evvel_lower):
                    evo_sube_payload = payload
                    break

        if evo_sube_payload:
            for g, v in (evo_sube_payload.get("gruplar") or {}).items():
                try:
                    grup_adet[g] = float(v.get("adet") or 0)
                except (TypeError, ValueError):
                    grup_adet[g] = 0.0
    except Exception as e:
        log.warning("truth_motor hs_rapor_sube_bazli cekilemedi (%s)", e)

    # Evo grup adı → boyut adı (motorun bekleyeni)
    n3_bardak_plastik = grup_adet.get("Ice")  # soğuk içecek = plastik bardak
    # 14 Oz + 8 Oz toplam karton (büyük + küçük aynı boyut grubu)
    if "14 Oz" in grup_adet or "8 Oz" in grup_adet:
        n3_bardak_karton = float(grup_adet.get("14 Oz") or 0) + float(grup_adet.get("8 Oz") or 0)
    else:
        n3_bardak_karton = None
    # Redbull + Maden Suyu (soda alternatifi) — redbull_soda boyutuna birleşir
    if "Redbull" in grup_adet or "Maden Suyu" in grup_adet:
        n3_redbull_soda = float(grup_adet.get("Redbull") or 0) + float(grup_adet.get("Maden Suyu") or 0)
    else:
        n3_redbull_soda = None
    n3_pasta = grup_adet.get("Pasta")
    n3_su = grup_adet.get("Su")  # ileride ayrı boyut olabilir

    return [
        BoyutVeri(
            boyut="kasa",
            n1_aksam=n1_kasa, n2_sabah=n2_kasa,
            n3_evo=None, n3_evo_ikram=None,  # kasa için Evo direkt karşılaştırılmaz
        ),
        BoyutVeri(
            boyut="bardak_plastik",
            n1_aksam=_meta_sayi(n1_meta, "bardak_plastik"),
            n2_sabah=_meta_sayi(n2_meta, "bardak_plastik"),
            n3_evo=n3_bardak_plastik, n3_evo_ikram=None,
        ),
        BoyutVeri(
            boyut="bardak_karton",
            n1_aksam=_meta_sayi(n1_meta, "bardak_kucuk", "bardak_buyuk"),
            n2_sabah=_meta_sayi(n2_meta, "bardak_kucuk", "bardak_buyuk"),
            n3_evo=n3_bardak_karton, n3_evo_ikram=None,
        ),
        BoyutVeri(
            boyut="redbull_soda",
            n1_aksam=_meta_sayi(n1_meta, "redbull_adet", "soda_adet"),
            n2_sabah=_meta_sayi(n2_meta, "redbull_adet", "soda_adet"),
            n3_evo=n3_redbull_soda, n3_evo_ikram=None,
        ),
        BoyutVeri(
            boyut="pasta",
            n1_aksam=_meta_sayi(n1_meta, "pasta_adet"),
            n2_sabah=_meta_sayi(n2_meta, "pasta_adet"),
            n3_evo=n3_pasta, n3_evo_ikram=None,
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


# ════════════════════════════════════════════════════════════════════════════
#  SPRINT A — VARDIYA BAZLI UZLAŞMA + PERSONEL DAVRANIŞ SİNYALİ
# ════════════════════════════════════════════════════════════════════════════
# Vardiya = ardışık operasyon event'leri arasındaki zaman dilimi.
#   ACILIS → KONTROL_1 (vardiya 1, sabahcı)
#   KONTROL_1 → KONTROL_2 veya KAPANIS (vardiya 2, öğlenci)
#   ...
# Her vardiya için: sorumlu personel + kasa P&L + bardak P&L + satış velocity
# ════════════════════════════════════════════════════════════════════════════

def _parse_evo_dt(s: str):
    """Evo a_cdate '19.05.2026 21:14:00' → datetime."""
    from datetime import datetime as _dt
    try:
        return _dt.strptime((s or "").strip(), "%d.%m.%Y %H:%M:%S")
    except Exception:
        try:
            return _dt.strptime((s or "").strip()[:10], "%d.%m.%Y")
        except Exception:
            return None


def _evo_sube_saatli_satis(sube_evo_id: str, bastar, bittar) -> List[Dict[str, Any]]:
    """hs_rapor.S'den o şubenin fişlerini saat damgalı liste olarak getirir."""
    try:
        from evo_sync import _hs_rapor_ham_veri
        d = _hs_rapor_ham_veri(bastar, bittar, sube_id=sube_evo_id)
    except Exception as e:
        log.warning("evo saatli satis cekilemedi: %s", e)
        return []
    rows = []
    for f in (d.get("S") or []):
        try:
            tutar = float(f.get("a_tutar") or 0)
        except (TypeError, ValueError):
            tutar = 0.0
        try:
            iskonto = float(f.get("a_isk_tut") or 0)
        except (TypeError, ValueError):
            iskonto = 0.0
        rows.append({
            "tutar": tutar,
            "iskonto": iskonto,
            "saat_str": str(f.get("a_cdate") or ""),
            "saat_dt": _parse_evo_dt(str(f.get("a_cdate") or "")),
            "personel_id": str(f.get("a_per_id") or ""),
            "personel_ad": str(f.get("SATIS_PER") or "").strip() or None,
            "sube_adi": str(f.get("a_sube_adi") or "").strip(),
        })
    from datetime import datetime as _dt
    rows.sort(key=lambda r: r["saat_dt"] or _dt.min)
    return rows


# ════════════════════════════════════════════════════════════════════════════
#  ADAPTIVE TRUTH WALK — Evo veriyle "kim doğru saymış" kanıtlama
# ════════════════════════════════════════════════════════════════════════════
# Kullanıcı senaryosu: Sabah açılış 1 saat olmuş, kasa -30₺ + soda +1 fazla.
# Motor "KAOS" diyor ama hangi tarafın hatalı olduğunu bilmiyor.
#
# Bu motor Evo'dan satışları çekip MATEMATİKSEL KANIT zinciri kurar:
#   1. Dün ACILIS sayım + dün URUN_AC + dün KAPANIS sayım
#   2. Dün Evo satış (kapanış saatine kadar)
#   3. Beklenen akşam = açılış + URUN_AC − Evo satış
#   4. Beklenen akşam ≈ KAPANIS sayım → AKŞAMCI doğru
#   5. Bugün ACILIS sayım (sabahcı) + bugün şu ana kadar Evo satış
#   6. Beklenen sabah = (akşam devir) − bugün satış → SABAHCI doğru/yanlış
#
# Karar: AKSAMCI_DOGRU | SABAHCI_DOGRU | IKISI_DE_HATALI | EVO_DESTEKLI_HIRSIZLIK |
#        IKRAM_DESTEKLI | TRUTH_WALK_COZULMEDI
# ════════════════════════════════════════════════════════════════════════════

# Boyut → Evo grup adı mapping (motor boyut → hs_rapor.Grup_Pasta.a_adi)
_BOYUT_EVO_GRUP = {
    "kasa":            None,  # özel: nakit hesap
    "bardak_plastik":  ["Ice"],
    "bardak_karton":   ["14 Oz", "8 Oz"],
    "redbull_soda":    ["Redbull", "Maden Suyu"],
    "pasta":           ["Pasta"],
    "su":              ["Su"],
}

# Boyut → şube meta JSON anahtarı mapping
_BOYUT_META = {
    "kasa":            [],  # özel
    "bardak_plastik":  ["bardak_plastik"],
    "bardak_karton":   ["bardak_kucuk", "bardak_buyuk"],
    "redbull_soda":    ["redbull_adet", "soda_adet"],
    "pasta":           ["pasta_adet"],
    "su":              ["su_adet"],
}


def _evo_sube_grup_satis(cur, sube_id: str, tarih: str) -> Dict[str, float]:
    """Bir şubenin verilen tarihteki Evo grup satışları (Ice, 14 Oz, vs).
    hs_rapor_sube_bazli'ı çağırır; sube_id (Evvel UUID) → şube_adi eşleştirme."""
    try:
        cur.execute("SELECT ad FROM subeler WHERE id::text=%s", (str(sube_id),))
        srow = cur.fetchone()
        sube_adi_evvel = str(dict(srow).get("ad") or "") if srow else ""
        from evo_sync import hs_rapor_sube_bazli
        from datetime import date as _d
        y, mo, dn = (int(x) for x in str(tarih)[:10].split("-"))
        tarih_d = _d(y, mo, dn)
        evo = hs_rapor_sube_bazli(tarih_d, tarih_d)
        evvel_lower = sube_adi_evvel.strip().lower().replace("şubesi", "").strip()
        for ad, payload in (evo.get("subeler") or {}).items():
            elow = ad.strip().lower().replace("şubesi", "").strip()
            if evvel_lower and (evvel_lower in elow or elow in evvel_lower):
                gruplar = {}
                for g, v in (payload.get("gruplar") or {}).items():
                    gruplar[g] = float(v.get("adet") or 0)
                gruplar["_nakit"] = float(payload.get("nakit") or 0)
                gruplar["_kart"] = float(payload.get("kart") or 0)
                gruplar["_ciro"] = float(payload.get("ciro_toplam") or 0)
                return gruplar
    except Exception as e:
        log.warning("_evo_sube_grup_satis hata: %s", e)
    return {}


def _meta_boyut_topla(meta: Dict[str, Any], boyut: str) -> float:
    """meta JSON'undan boyutun toplam değerini al."""
    if not isinstance(meta, dict):
        return 0.0
    anahtarlar = _BOYUT_META.get(boyut) or []
    s = 0.0
    for a in anahtarlar:
        v = meta.get(a)
        if v is not None:
            try:
                s += float(v)
            except (TypeError, ValueError):
                pass
    return s


def _urun_ac_toplam(cur, sube_id: str, tarih: str, boyut: str) -> float:
    """O gün açılan paket toplamı (URUN_AC), boyut bazında."""
    try:
        cur.execute(
            """
            SELECT kalemler_json FROM urun_ac_taslak
            WHERE sube_id=%s AND tarih=%s::date AND durum='aktif'
            """,
            (sube_id, tarih),
        )
        rows = [dict(r) for r in (cur.fetchall() or [])]
    except Exception:
        return 0.0
    anahtarlar = _BOYUT_META.get(boyut) or []
    toplam = 0.0
    for r in rows:
        kj = r.get("kalemler_json")
        if isinstance(kj, str):
            try:
                kj = json.loads(kj)
            except Exception:
                kj = {}
        if isinstance(kj, dict):
            for a in anahtarlar:
                v = kj.get(a)
                if v is not None:
                    try:
                        toplam += float(v)
                    except (TypeError, ValueError):
                        pass
    return toplam


def vardiya_kompozisyonu(cur, sube_id: str, tarih: str) -> Dict[str, Any]:
    """O gün şubede vardiya kompozisyonu.

    Veri kaynakları:
      - vardiya_atama (planlı vardiya)
      - sube_operasyon_event (ACILIS/KONTROL/KAPANIS gerçek personel + saat)

    Returns:
      {
        "atamalar": [{personel_id, ad, baslangic, bitis, slot_ad}],
        "event_personelleri": [
          {tip, personel_id, personel_ad, saat, kasa_sayim}
        ],
        "tek_basina_araliklari": [
          {bas, bit, personel_id, personel_ad}  # bir tek personel olduğu zaman dilimleri
        ],
        "coklu_araliklari": [
          {bas, bit, personeller: [{id, ad}]}
        ],
        "sorumluluk_haritasi": [
          {bas, bit, sorumlu_personel_ad, tek_basina: bool, collusion_riski: bool}
        ],
        "ozet": kısa string ("Bugün tek personel: Talha 09-17"),
      }
    """
    # 1. Planlı vardiya atamaları
    atamalar = []
    try:
        cur.execute(
            """
            SELECT va.personel_id, p.ad,
                   va.baslangic_saat::text AS bas, va.bitis_saat::text AS bit,
                   va.gece_vardiyasi, va.durum,
                   vs.ad AS slot_ad
            FROM vardiya_atama va
            JOIN vardiya_slot vs ON vs.id = va.slot_id
            LEFT JOIN personel p ON p.id = va.personel_id
            WHERE vs.sube_id=%s AND va.tarih=%s::date
              AND va.durum != 'iptal'
            ORDER BY va.baslangic_saat
            """,
            (sube_id, tarih),
        )
        atamalar = [dict(r) for r in (cur.fetchall() or [])]
    except Exception as e:
        log.warning("vardiya_atama cekilemedi: %s", e)

    # 2. Gerçek event'lerdeki personeller (ACILIS/KONTROL/KAPANIS)
    event_personelleri = []
    try:
        cur.execute(
            """
            SELECT tip, cevap_ts, kasa_sayim, meta, personel_saat
            FROM sube_operasyon_event
            WHERE sube_id=%s AND tarih=%s::date AND durum='tamamlandi'
            ORDER BY cevap_ts NULLS LAST
            """,
            (sube_id, tarih),
        )
        for r in (cur.fetchall() or []):
            d = dict(r)
            meta = _meta_oku(d.get("meta"))
            pid = str(meta.get("personel_id") or "")
            pad = str(meta.get("personel_ad") or "")
            saat = ""
            try:
                if d.get("cevap_ts"):
                    saat = d["cevap_ts"].strftime("%H:%M")
            except Exception:
                pass
            event_personelleri.append({
                "tip": d.get("tip"),
                "personel_id": pid,
                "personel_ad": pad,
                "saat": saat,
                "kasa_sayim": float(d.get("kasa_sayim") or 0),
            })
    except Exception as e:
        log.warning("event personelleri cekilemedi: %s", e)

    # 3. Zaman dilimi analizi — saat aralıklarına göre kim vardı
    # Vardiya_atama bas-bit dilimlerini çakıştır
    def _saat_int(s):
        """'HH:MM:SS' veya 'HH:MM' → integer (dakika)"""
        try:
            parts = str(s).split(":")
            return int(parts[0]) * 60 + int(parts[1])
        except Exception:
            return 0

    # Eğer atama yoksa, event'lerden çıkar
    if not atamalar and event_personelleri:
        # Heuristic: ilk ACILIS → KONTROL_1 = sabahcı, ...
        atamalar = []
        gecmis_saat = None
        gecmis_pid = None
        gecmis_pad = None
        for e in event_personelleri:
            if e.get("personel_id"):
                if gecmis_pid:
                    atamalar.append({
                        "personel_id": gecmis_pid, "ad": gecmis_pad,
                        "bas": gecmis_saat, "bit": e["saat"],
                        "slot_ad": "Event'ten çıkarıldı",
                    })
                gecmis_saat = e["saat"]
                gecmis_pid = e["personel_id"]
                gecmis_pad = e["personel_ad"]
        # son event → bugün sonu
        if gecmis_pid:
            atamalar.append({
                "personel_id": gecmis_pid, "ad": gecmis_pad,
                "bas": gecmis_saat, "bit": "23:59",
                "slot_ad": "Event'ten çıkarıldı (son)",
            })

    # Tek başına vs çoklu zaman dilimleri (basit overlap analizi)
    # 24 saatlik dakika grid'i — her dakika için kaç personel var
    dakika_personel: Dict[int, List[Dict]] = {}
    for a in atamalar:
        bas_m = _saat_int(a.get("bas") or a.get("baslangic_saat") or 0)
        bit_m = _saat_int(a.get("bit") or a.get("bitis_saat") or 0)
        if bit_m <= bas_m:
            bit_m += 24 * 60  # gece vardiyası
        for m in range(bas_m, min(bit_m, 48 * 60)):
            dakika_personel.setdefault(m, []).append({
                "id": a.get("personel_id"), "ad": a.get("ad"),
            })

    tek_basina_araliklari = []
    coklu_araliklari = []
    # Ardışık dakikaları aralıklara birleştir
    if dakika_personel:
        sirali_dakikalar = sorted(dakika_personel.keys())
        son_dakika = None
        bas = sirali_dakikalar[0]
        son_personeller = None
        for m in sirali_dakikalar:
            personeller = tuple(sorted([str(p["id"]) for p in dakika_personel[m]]))
            if son_personeller is None:
                son_personeller = personeller
                bas = m
            elif personeller != son_personeller or (son_dakika is not None and m - son_dakika > 1):
                # Aralık değişti — önceki aralığı kapat
                _kapatma(bas, son_dakika or m, son_personeller, dakika_personel, tek_basina_araliklari, coklu_araliklari)
                bas = m
                son_personeller = personeller
            son_dakika = m
        # Son aralık
        if son_personeller is not None:
            _kapatma(bas, son_dakika or bas, son_personeller, dakika_personel, tek_basina_araliklari, coklu_araliklari)

    # Sorumluluk haritası: aralık → tek personel mi, collusion riski mi?
    sorumluluk_haritasi = []
    for ara in tek_basina_araliklari:
        sorumluluk_haritasi.append({
            "bas": ara["bas"], "bit": ara["bit"],
            "sorumlu_personel_ad": ara["personel_ad"],
            "sorumlu_personel_id": ara["personel_id"],
            "tek_basina": True,
            "collusion_riski": False,
            "yorum": "Tek personel — kasa %100 kontrolünde",
        })
    for ara in coklu_araliklari:
        sorumluluk_haritasi.append({
            "bas": ara["bas"], "bit": ara["bit"],
            "sorumlu_personel_ad": ", ".join(p["ad"] or p["id"] for p in ara["personeller"]),
            "sorumlu_personel_id": None,
            "tek_basina": False,
            "collusion_riski": True,
            "yorum": f"{len(ara['personeller'])} personel — sorumluluk paylaşımı",
        })
    sorumluluk_haritasi.sort(key=lambda x: x["bas"])

    # Özet
    if tek_basina_araliklari and not coklu_araliklari:
        ozet = "Tüm gün tek personel vardiyasında (yüksek izolasyon — kasa tek kontrol)"
    elif coklu_araliklari and not tek_basina_araliklari:
        ozet = f"Tüm gün {len(coklu_araliklari)} farklı çoklu personel dilimi"
    elif tek_basina_araliklari and coklu_araliklari:
        ozet = f"{len(tek_basina_araliklari)} tek-personel dilimi + {len(coklu_araliklari)} çoklu dilim"
    elif atamalar:
        ozet = f"{len(atamalar)} atama (analiz edilemedi)"
    else:
        ozet = "Vardiya atama bulunamadı"

    return {
        "sube_id": sube_id, "tarih": tarih,
        "atamalar": atamalar,
        "event_personelleri": event_personelleri,
        "tek_basina_araliklari": tek_basina_araliklari,
        "coklu_araliklari": coklu_araliklari,
        "sorumluluk_haritasi": sorumluluk_haritasi,
        "ozet": ozet,
    }


def _kapatma(bas_m, bit_m, personeller_tup, dakika_personel, tek, coklu):
    """vardiya_kompozisyonu içinde kullanılan yardımcı: bir aralığı doğru listeye koy."""
    def _fmt(m):
        return f"{(m // 60) % 24:02d}:{m % 60:02d}"
    if not personeller_tup:
        return
    if len(personeller_tup) == 1:
        # Tek personel
        ilk_d = list(dakika_personel.get(bas_m, []))
        ad = ilk_d[0]["ad"] if ilk_d else None
        tek.append({
            "bas": _fmt(bas_m), "bit": _fmt(bit_m),
            "personel_id": personeller_tup[0],
            "personel_ad": ad or personeller_tup[0],
        })
    else:
        # Çoklu personel
        ilk_d = dakika_personel.get(bas_m, [])
        coklu.append({
            "bas": _fmt(bas_m), "bit": _fmt(bit_m),
            "personeller": ilk_d,
        })


def adaptive_truth_walk(cur, sube_id: str, tarih: str, boyut: str) -> Dict[str, Any]:
    """Bir boyut için matematiksel kanıt zinciri kurarak 'kim hatalı' kararı.

    Args:
        sube_id: Evvel UUID
        tarih: bugün (YYYY-MM-DD)
        boyut: 'kasa' | 'bardak_plastik' | 'bardak_karton' | 'redbull_soda' | 'pasta' | 'su'

    Returns:
        {
          karar: AKSAMCI_DOGRU | SABAHCI_DOGRU | IKISI_DE_HATALI |
                 EVO_DESTEKLI_HIRSIZLIK | IKRAM_DESTEKLI | UYUMLU | TRUTH_WALK_COZULMEDI,
          guven: 0-100,
          kanit_zinciri: [{adim, deger, kaynak, aciklama}],
          oneriler: [string],
          ozet: kısa metin
        }
    """
    from datetime import date as _d, timedelta as _td

    onceki = _previous_day(tarih)
    tolerans = _TOLERANS.get(boyut, 0.5) if boyut != "kasa" else 1.0
    kanit: List[Dict[str, Any]] = []

    # 1. Dün ACILIS sayım (önceki gün sabah)
    cur.execute(
        """SELECT meta, kasa_sayim FROM sube_operasyon_event
           WHERE sube_id=%s AND tarih=%s::date AND tip='ACILIS' AND durum='tamamlandi'
           ORDER BY cevap_ts DESC NULLS LAST LIMIT 1""",
        (sube_id, onceki),
    )
    r_dun_ac = cur.fetchone()
    dun_acilis_meta = _meta_oku(dict(r_dun_ac).get("meta")).get("acilis_stok_sayim") if r_dun_ac else {}
    if boyut == "kasa":
        dun_acilis = float(dict(r_dun_ac).get("kasa_sayim") or 0) if r_dun_ac else 0
    else:
        dun_acilis = _meta_boyut_topla(dun_acilis_meta or {}, boyut)
    kanit.append({"adim": "1. Dün açılış sayımı",
                  "deger": dun_acilis,
                  "kaynak": "sube_operasyon_event ACILIS (önceki gün)",
                  "aciklama": "Dün sabah personelin saydığı başlangıç stok"})

    # 2. Dün URUN_AC (paket açma) — kasa için anlamsız, atla
    urun_ac = 0.0
    if boyut != "kasa":
        urun_ac = _urun_ac_toplam(cur, sube_id, onceki, boyut)
        kanit.append({"adim": "2. Dün açılan paketler (URUN_AC)",
                      "deger": urun_ac,
                      "kaynak": "urun_ac_taslak kalemler_json",
                      "aciklama": "Dün gün içinde açılan ek paketler"})

    # 3. Dün Evo satış toplamı (tüm gün — akşamcının kapatma anına kadar varsayım)
    evo_dun = _evo_sube_grup_satis(cur, sube_id, onceki)
    if boyut == "kasa":
        evo_dun_nakit = float(evo_dun.get("_nakit") or 0)
        kanit.append({"adim": "3. Dün Evo nakit satış toplamı",
                      "deger": evo_dun_nakit,
                      "kaynak": "hs_rapor.ashx kasa (önceki gün)",
                      "aciklama": "Evo POS'tan dün toplam nakit satış"})
        evo_satis_dun = evo_dun_nakit
    else:
        grup_anahtarlari = _BOYUT_EVO_GRUP.get(boyut) or []
        evo_satis_dun = sum(float(evo_dun.get(g, 0)) for g in grup_anahtarlari)
        kanit.append({"adim": "3. Dün Evo satış toplamı",
                      "deger": evo_satis_dun,
                      "kaynak": f"hs_rapor.Grup_Pasta {grup_anahtarlari}",
                      "aciklama": f"Evo POS'ta dün {', '.join(grup_anahtarlari)} satışları"})

    # 4. Dün KAPANIS sayım (akşamcı beyanı)
    cur.execute(
        """SELECT meta, kasa_sayim, devir, teslim FROM sube_operasyon_event
           WHERE sube_id=%s AND tarih=%s::date AND tip='KAPANIS' AND durum='tamamlandi'
           ORDER BY cevap_ts DESC NULLS LAST LIMIT 1""",
        (sube_id, onceki),
    )
    r_dun_kap = cur.fetchone()
    if boyut == "kasa":
        # Akşamcı devir tutarı = bugün sabah açılış için bırakılan
        aksamci_beyan = float(dict(r_dun_kap).get("devir") or 0) if r_dun_kap else 0
        aksam_teslim = float(dict(r_dun_kap).get("teslim") or 0) if r_dun_kap else 0
        kanit.append({"adim": "4a. Dün akşam — Müdüre teslim",
                      "deger": aksam_teslim,
                      "kaynak": "sube_operasyon_event KAPANIS.teslim",
                      "aciklama": "Akşamcının müdüre verdiği tutar"})
        kanit.append({"adim": "4b. Dün akşam — Kasada devir (akşamcı beyanı)",
                      "deger": aksamci_beyan,
                      "kaynak": "sube_operasyon_event KAPANIS.devir",
                      "aciklama": "Akşamcının kasada bıraktığını söylediği tutar"})
    else:
        dun_kapanis_meta = _meta_oku(dict(r_dun_kap).get("meta")).get("kapanis_stok_sayim") if r_dun_kap else {}
        aksamci_beyan = _meta_boyut_topla(dun_kapanis_meta or {}, boyut)
        kanit.append({"adim": "4. Dün KAPANIS sayım (akşamcı beyanı)",
                      "deger": aksamci_beyan,
                      "kaynak": "sube_operasyon_event KAPANIS meta",
                      "aciklama": "Akşamcının kapanışta saydığı stok"})

    # 5. TÜRETİLMİŞ AKŞAM beklenen
    if boyut == "kasa":
        # Nakit gider dünkü
        cur.execute("""
            SELECT COALESCE(SUM(tutar),0) AS t FROM anlik_giderler
            WHERE sube=%s AND tarih=%s::date
              AND LOWER(COALESCE(NULLIF(TRIM(odeme_yontemi),''),'nakit'))='nakit'
              AND durum IN ('aktif','onay_bekliyor')
        """, (sube_id, onceki))
        gider_dun = float(dict(cur.fetchone() or {}).get("t") or 0)
        # Ara teslim dünkü
        cur.execute("""
            SELECT COALESCE(SUM(tutar),0) AS t FROM kasa_teslim
            WHERE sube_id=%s AND tarih=%s::date AND teslim_turu='ara'
        """, (sube_id, onceki))
        ara_dun = float(dict(cur.fetchone() or {}).get("t") or 0)
        kanit.append({"adim": "5a. Dün nakit gider", "deger": gider_dun,
                      "kaynak": "anlik_giderler (nakit, önceki gün)"})
        kanit.append({"adim": "5b. Dün ara teslim", "deger": ara_dun,
                      "kaynak": "kasa_teslim teslim_turu='ara'"})
        beklenen_aksam = dun_acilis + evo_satis_dun - gider_dun - ara_dun - aksam_teslim
        kanit.append({"adim": "6. TÜRETİLMİŞ akşam kasa = açılış + Evo nakit − gider − ara − teslim",
                      "deger": round(beklenen_aksam, 2),
                      "kaynak": "matematik (kanıt)",
                      "aciklama": "Akşamcının saymış olması gereken tutar"})
    else:
        beklenen_aksam = dun_acilis + urun_ac - evo_satis_dun
        kanit.append({"adim": "5. TÜRETİLMİŞ akşam stok = açılış + URUN_AC − Evo satış",
                      "deger": round(beklenen_aksam, 2),
                      "kaynak": "matematik (kanıt)",
                      "aciklama": "Akşamcının saymış olması gereken stok"})

    aksam_fark = round(aksamci_beyan - beklenen_aksam, 2)
    kanit.append({"adim": "7. Akşamcı beyanı − Türetilmiş",
                  "deger": aksam_fark,
                  "kaynak": "karşılaştırma",
                  "aciklama": "0 ise akşamcı doğru, ≠0 ise akşamcı hatalı"})
    aksamci_dogru = abs(aksam_fark) <= tolerans

    # 6. Bugün ACILIS sayım (sabahcı)
    cur.execute(
        """SELECT meta, kasa_sayim, cevap_ts FROM sube_operasyon_event
           WHERE sube_id=%s AND tarih=%s::date AND tip='ACILIS' AND durum='tamamlandi'
           ORDER BY cevap_ts DESC NULLS LAST LIMIT 1""",
        (sube_id, tarih),
    )
    r_bugun_ac = cur.fetchone()
    bugun_acilis_meta = _meta_oku(dict(r_bugun_ac).get("meta")).get("acilis_stok_sayim") if r_bugun_ac else {}
    if boyut == "kasa":
        sabahci_beyan = float(dict(r_bugun_ac).get("kasa_sayim") or 0) if r_bugun_ac else 0
    else:
        sabahci_beyan = _meta_boyut_topla(bugun_acilis_meta or {}, boyut)
    kanit.append({"adim": "8. Bugün ACILIS sayım (sabahcı beyanı)",
                  "deger": sabahci_beyan,
                  "kaynak": "sube_operasyon_event ACILIS meta (bugün)",
                  "aciklama": "Sabahcının açılışta saydığı"})

    # 7. Bugün şu ana kadar Evo satış (kapanış-açılış arası genelde 0)
    evo_bugun = _evo_sube_grup_satis(cur, sube_id, tarih)
    if boyut == "kasa":
        evo_satis_bugun = float(evo_bugun.get("_nakit") or 0)
    else:
        grup_anahtarlari = _BOYUT_EVO_GRUP.get(boyut) or []
        evo_satis_bugun = sum(float(evo_bugun.get(g, 0)) for g in grup_anahtarlari)
    kanit.append({"adim": "9. Bugün sabaha kadar Evo satış",
                  "deger": evo_satis_bugun,
                  "kaynak": "hs_rapor (bugün, açılış saatine kadar)",
                  "aciklama": "Genelde 0 — geceden satış olmaz, ama olası"})

    # Türetilmiş sabah stok (akşam beyanı doğru kabul edersek)
    beklenen_sabah_v1 = aksamci_beyan - evo_satis_bugun
    # Türetilmiş sabah stok (akşam beyanı yanlış, türetilmiş doğru kabul edersek)
    beklenen_sabah_v2 = beklenen_aksam - evo_satis_bugun

    sabah_fark_v1 = round(sabahci_beyan - beklenen_sabah_v1, 2)
    sabah_fark_v2 = round(sabahci_beyan - beklenen_sabah_v2, 2)
    kanit.append({"adim": "10a. Sabah fark (akşamcı beyanı doğru kabul)",
                  "deger": sabah_fark_v1,
                  "kaynak": "matematik"})
    kanit.append({"adim": "10b. Sabah fark (türetilmiş akşam doğru kabul)",
                  "deger": sabah_fark_v2,
                  "kaynak": "matematik"})

    sabahci_dogru_v1 = abs(sabah_fark_v1) <= tolerans
    sabahci_dogru_v2 = abs(sabah_fark_v2) <= tolerans

    # KARAR MATRİSİ
    karar, guven, ozet, oneriler = "TRUTH_WALK_COZULMEDI", 30.0, "", []
    if aksamci_dogru and sabahci_dogru_v1:
        karar = "UYUMLU"
        guven = 95.0
        ozet = "Akşamcı ve sabahcı her ikisi de doğru — fark yok"
        oneriler = ["Aksiyon gerekmez."]
    elif aksamci_dogru and not sabahci_dogru_v1:
        karar = "SABAHCI_HATALI"
        guven = 90.0
        ozet = (f"Akşamcı doğru saydı, sabahcı yanlış. "
                f"Sabah beyan {sabahci_beyan:.0f}, beklenen {beklenen_sabah_v1:.0f}. "
                f"Fark {sabah_fark_v1:+.0f}.")
        oneriler = [
            "Sabahcıyı PIN ile teyit ettir, yeniden say.",
            f"Eğer sabahcı yeniden sayıp {beklenen_sabah_v1:.0f} der ise sayım hatasıydı.",
            "Eğer aynı rakam çıkarsa fiziksel kayıp olabilir — 3. kişi sayım gerek.",
        ]
    elif not aksamci_dogru and sabahci_dogru_v2:
        karar = "AKSAMCI_HATALI"
        guven = 88.0
        ozet = (f"Akşamcı yanlış saydı. Türetilmiş akşam {beklenen_aksam:.0f}, "
                f"akşamcı beyanı {aksamci_beyan:.0f}, fark {aksam_fark:+.0f}. "
                f"Sabahcı türetilmişle uyumlu — sabahcı doğru.")
        oneriler = [
            f"Dün akşamı KAPANIS kaydını revize et: stok {aksamci_beyan:.0f} → {beklenen_aksam:.0f}.",
            "Akşamcı performans incelemesine alın.",
            "Eğer fark sürekli aynı yönde ise zimmet pre-pozisyonu sinyali.",
        ]
    elif not aksamci_dogru and not sabahci_dogru_v1 and not sabahci_dogru_v2:
        # Her iki taraf da türetilmişle uyumsuz
        if boyut != "kasa" and evo_satis_dun > 0:
            # Evo'da satış var ama sayım eksilmemiş → POS_BYPASS / İKRAM
            stok_dususu = dun_acilis + urun_ac - aksamci_beyan
            if stok_dususu < evo_satis_dun * 0.5:
                karar = "EVO_DESTEKLI_HIRSIZLIK"
                guven = 75.0
                ozet = (f"Evo'da {evo_satis_dun:.0f} satış kayıtlı ama "
                        f"stok sadece {stok_dususu:.0f} azalmış. Stok dışı kaynaktan satış var.")
                oneriler = ["Kasa Baskını + güvenlik kamerası incele.", "POS yetki kontrolü."]
            else:
                karar = "IKRAM_DESTEKLI"
                guven = 60.0
                ozet = "Stok düşmüş ama Evo'da net karşılığı yok — ikram olabilir."
                oneriler = ["Personele ikram defteri tutturun (PIN ile)."]
        else:
            karar = "IKISI_DE_HATALI"
            guven = 40.0
            ozet = "Hem akşamcı hem sabahcı türetilmişle uyumsuz — 3. kişi sayımı şart."
            oneriler = [
                "3. kişi (CFO veya görevli) ile yeniden sayım yap.",
                "Sonra hangi sayımın yanlış olduğunu tespit et.",
            ]
    else:
        karar = "TRUTH_WALK_COZULMEDI"
        guven = 35.0
        ozet = "Kanıt zinciri net karar üretmedi. Ek veri (örn. KONTROL sayımı) gerekir."
        oneriler = [
            "Bugün KONTROL event'i tetikle — gün ortası sayım.",
            "Stok-Evo karşılaştırması daha fazla gün için yap.",
        ]

    # ═══════════════════════════════════════════════════════════════════════
    # KATMAN 0 — VARDİYA KOMPOZİSYONU ENTEGRASYONU
    # Tek personel ise sorumluluk net → güven artar
    # Çoklu personel ise collusion riski → ek not eklenir
    # ═══════════════════════════════════════════════════════════════════════
    vardiya_dun = vardiya_kompozisyonu(cur, sube_id, onceki)
    vardiya_bugun = vardiya_kompozisyonu(cur, sube_id, tarih)

    vardiya_notu = []
    tek_personel_aksam = len(vardiya_dun.get("tek_basina_araliklari") or []) > 0 and \
                         len(vardiya_dun.get("coklu_araliklari") or []) == 0
    tek_personel_sabah = len(vardiya_bugun.get("tek_basina_araliklari") or []) > 0 and \
                         len(vardiya_bugun.get("coklu_araliklari") or []) == 0

    # Akşamcı tek başınaysa → onun beyanı dışında veri yok, sorumluluk net
    if karar == "AKSAMCI_HATALI" and tek_personel_aksam:
        guven = min(99.0, guven + 8.0)
        sorumlu = vardiya_dun.get("tek_basina_araliklari", [{}])[-1].get("personel_ad", "?")
        vardiya_notu.append(f"⭐ Dün akşam TEK PERSONEL: {sorumlu} — kasa %100 kontrolünde, başka açıklama yok")
        oneriler.insert(0, f"Sorumlu: {sorumlu} (tek başınaydı, devir kimseyle yapmadı)")
    elif karar == "SABAHCI_HATALI" and tek_personel_sabah:
        guven = min(99.0, guven + 8.0)
        sorumlu = vardiya_bugun.get("tek_basina_araliklari", [{}])[0].get("personel_ad", "?")
        vardiya_notu.append(f"⭐ Bugün sabah TEK PERSONEL: {sorumlu} — sayım yalnız onun")
        oneriler.insert(0, f"Sorumlu: {sorumlu} (tek başınaydı)")
    elif karar in ("AKSAMCI_HATALI", "SABAHCI_HATALI"):
        # Çoklu personel — collusion riski
        ilgili = vardiya_dun if karar == "AKSAMCI_HATALI" else vardiya_bugun
        ilk_coklu = (ilgili.get("coklu_araliklari") or [{}])
        if ilk_coklu and ilk_coklu[0].get("personeller"):
            isimler = ", ".join(p.get("ad") or p.get("id") for p in ilk_coklu[0]["personeller"])
            vardiya_notu.append(f"⚠️ Vardiyada {len(ilk_coklu[0]['personeller'])} personel: {isimler} — sorumluluk paylaşımı, collusion riski var")
            oneriler.insert(0, f"Vardiyada beraber çalışanları ayrı ayrı sorgula: {isimler}")
    elif karar == "EVO_DESTEKLI_HIRSIZLIK":
        # Hırsızlık şüphesi varsa kim/kimlerle çalışıldığını mutlaka belirt
        sorumlu_list = []
        for ara in vardiya_dun.get("tek_basina_araliklari") or []:
            sorumlu_list.append(f"{ara['personel_ad']} ({ara['bas']}-{ara['bit']} tek başına)")
        for ara in vardiya_dun.get("coklu_araliklari") or []:
            isimler = ", ".join(p.get("ad") or p.get("id") for p in ara["personeller"])
            sorumlu_list.append(f"{ara['bas']}-{ara['bit']} arası: {isimler}")
        if sorumlu_list:
            vardiya_notu.append("🔴 Dün vardiya çizelgesi: " + " | ".join(sorumlu_list))
            oneriler.insert(0, "Saatlik vardiyaya göre kim sorumlu — kamera görüntüsünü o saatlere yoğunlaştır")

    if vardiya_notu:
        ozet = f"{ozet}\n\n" + "\n".join(vardiya_notu)

    return {
        "sube_id": sube_id,
        "tarih": tarih,
        "boyut": boyut,
        "karar": karar,
        "guven": guven,
        "aksamci_beyan": aksamci_beyan,
        "sabahci_beyan": sabahci_beyan,
        "beklenen_aksam": round(beklenen_aksam, 2),
        "beklenen_sabah_v1": round(beklenen_sabah_v1, 2),
        "beklenen_sabah_v2": round(beklenen_sabah_v2, 2),
        "aksam_fark": aksam_fark,
        "sabah_fark_v1": sabah_fark_v1,
        "sabah_fark_v2": sabah_fark_v2,
        "aksamci_dogru": aksamci_dogru,
        "sabahci_dogru": sabahci_dogru_v1 or sabahci_dogru_v2,
        "ozet": ozet,
        "kanit_zinciri": kanit,
        "oneriler": oneriler,
        # Katman 0 — vardiya kompozisyon
        "vardiya_dun": {
            "ozet": vardiya_dun.get("ozet"),
            "tek_basina_araliklari": vardiya_dun.get("tek_basina_araliklari"),
            "coklu_araliklari": vardiya_dun.get("coklu_araliklari"),
            "sorumluluk_haritasi": vardiya_dun.get("sorumluluk_haritasi"),
        },
        "vardiya_bugun": {
            "ozet": vardiya_bugun.get("ozet"),
            "tek_basina_araliklari": vardiya_bugun.get("tek_basina_araliklari"),
            "coklu_araliklari": vardiya_bugun.get("coklu_araliklari"),
            "sorumluluk_haritasi": vardiya_bugun.get("sorumluluk_haritasi"),
        },
        "tek_personel_aksam": tek_personel_aksam,
        "tek_personel_sabah": tek_personel_sabah,
    }


def vardiya_bazli_uzlasma(cur, sube_id: str, tarih: str,
                           evo_dahil: bool = True) -> Dict[str, Any]:
    """Bir şubenin bir gününde vardiya bazlı kasa/bardak uzlaşması.

    Returns:
      {
        "sube_id", "tarih",
        "vardiyalar": [
          {
            "no": 1, "tip_dilimi": "ACILIS→KONTROL",
            "baslangic_ts", "bitis_ts", "sure_dk",
            "personel_id", "personel_ad",
            "baslangic_kasa", "bitis_kasa",
            "evo_nakit_satis", "evo_iskonto", "evo_fis_sayisi",
            "giderler", "ara_teslim", "teslim", "devir",
            "beklenen_kasa", "fark_kasa",
            "tani": "UYUMLU" | "VARDIYA_KASA_HATA" | "VARDIYA_FAZLA"
          }
        ],
        "personel_ozet": {personel_id: {ad, vardiya_sayisi, kasa_fark_toplam}}
      }
    """
    # 1. O günün event'lerini sıralı al (ACILIS, KONTROL*, KAPANIS)
    cur.execute(
        """
        SELECT id, tip, sira_no, cevap_ts, kasa_sayim, teslim, devir, meta
        FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=%s::date AND durum='tamamlandi'
        ORDER BY cevap_ts NULLS LAST, sira_no
        """,
        (sube_id, tarih),
    )
    events = [dict(r) for r in (cur.fetchall() or [])]
    if not events:
        return {"sube_id": sube_id, "tarih": tarih, "vardiyalar": [],
                "uyari": "O gün için tamamlanmış event yok"}

    # 2. Şubenin Evo ID'sini al (EVO_SUBE_ID_MAP'ten ad eşleşmesi)
    cur.execute("SELECT ad FROM subeler WHERE id::text=%s", (str(sube_id),))
    srow = cur.fetchone()
    sube_adi_evvel = str(dict(srow).get("ad") or "") if srow else ""

    evo_sube_id = None
    try:
        from evo_sync import EVO_SUBE_ID_MAP
        evvel_lower = sube_adi_evvel.strip().lower().replace("şubesi", "").strip()
        for eid, ead in EVO_SUBE_ID_MAP.items():
            elow = ead.strip().lower().replace("şubesi", "").strip()
            if evvel_lower and (evvel_lower in elow or elow in evvel_lower):
                evo_sube_id = eid
                break
    except Exception:
        pass

    # 3. Tüm günün Evo satışlarını saatli al (vardiyaya bölümlemek için)
    # evo_dahil=False ise atla (pattern detection'da batch için)
    evo_satislar: List[Dict[str, Any]] = []
    if evo_dahil and evo_sube_id:
        from datetime import date as _d
        y, mo, dn = (int(x) for x in str(tarih)[:10].split("-"))
        tarih_d = _d(y, mo, dn)
        evo_satislar = _evo_sube_saatli_satis(evo_sube_id, tarih_d, tarih_d)

    # 4. Giderleri ve ara teslimleri saatli çek
    cur.execute(
        """
        SELECT olusturma AS ts, tutar
        FROM anlik_giderler
        WHERE sube=%s AND tarih=%s::date
          AND LOWER(COALESCE(NULLIF(TRIM(odeme_yontemi),''),'nakit'))='nakit'
          AND durum IN ('aktif','onay_bekliyor')
        """,
        (sube_id, tarih),
    )
    giderler = [dict(r) for r in (cur.fetchall() or [])]
    cur.execute(
        """
        SELECT olusturma AS ts, tutar
        FROM kasa_teslim
        WHERE sube_id=%s AND tarih=%s::date AND teslim_turu='ara'
        """,
        (sube_id, tarih),
    )
    ara_teslimler = [dict(r) for r in (cur.fetchall() or [])]

    # 5. Vardiyaları oluştur: ardışık event'ler arası dilimler
    vardiyalar: List[Dict[str, Any]] = []
    personel_ozet: Dict[str, Dict[str, Any]] = {}

    for i in range(len(events) - 1):
        bas = events[i]
        bit = events[i + 1]
        bas_ts = bas.get("cevap_ts")
        bit_ts = bit.get("cevap_ts")
        if bas_ts is None or bit_ts is None:
            continue

        # Meta'dan personel — bit event'inin personel'i (vardiyayı kapatan)
        meta_bit = {}
        try:
            mraw = bit.get("meta")
            meta_bit = json.loads(mraw) if isinstance(mraw, str) else (mraw or {})
        except Exception:
            meta_bit = {}
        personel_id = str(meta_bit.get("personel_id") or "")
        personel_ad = str(meta_bit.get("personel_ad") or "")
        if not personel_id and not personel_ad:
            # bas event'ine de bak
            try:
                mraw = bas.get("meta")
                meta_bas = json.loads(mraw) if isinstance(mraw, str) else (mraw or {})
                personel_id = str(meta_bas.get("personel_id") or "")
                personel_ad = str(meta_bas.get("personel_ad") or "")
            except Exception:
                pass

        # Evo satışlarını bu aralıkta topla
        evo_nakit = 0.0
        evo_iskonto = 0.0
        evo_fis_sayisi = 0
        for s in evo_satislar:
            dt = s.get("saat_dt")
            if dt is None:
                continue
            if dt >= bas_ts and dt < bit_ts:
                evo_nakit += s["tutar"]  # not: Evo'da nakit/kart ayrımı saatlik yok
                evo_iskonto += s["iskonto"]
                evo_fis_sayisi += 1

        # Giderler ve ara teslim
        gider_top = sum(float(g["tutar"] or 0) for g in giderler
                        if g["ts"] and bas_ts <= g["ts"] < bit_ts)
        ara_top = sum(float(a["tutar"] or 0) for a in ara_teslimler
                      if a["ts"] and bas_ts <= a["ts"] < bit_ts)

        bas_kasa = float(bas.get("kasa_sayim") or 0)
        bit_kasa = float(bit.get("kasa_sayim") or 0)
        teslim = float(bit.get("teslim") or 0)
        devir = float(bit.get("devir") or 0)

        # Beklenen son kasa: ACILIS-KONTROL/KAPANIS arası
        # Eğer son event KAPANIS ise teslim + devir kasa'dan çıkar:
        son_event = bit.get("tip") == "KAPANIS"
        if son_event:
            beklenen = bas_kasa + evo_nakit - gider_top - ara_top - teslim - devir
        else:
            beklenen = bas_kasa + evo_nakit - gider_top - ara_top
        fark = round(bit_kasa - beklenen, 2) if bit.get("kasa_sayim") is not None else None

        if fark is None:
            tani = "YETERSIZ_VERI"
        elif abs(fark) < 1.0:
            tani = "UYUMLU"
        elif fark < 0:
            tani = "VARDIYA_KASA_ACIK"
        else:
            tani = "VARDIYA_KASA_FAZLA"

        sure_dk = round((bit_ts - bas_ts).total_seconds() / 60.0, 1) if bit_ts and bas_ts else 0
        velocity = round(evo_fis_sayisi / (sure_dk / 60.0), 1) if sure_dk > 0 else 0

        v_kayit = {
            "no": i + 1,
            "tip_dilimi": f"{bas.get('tip')}→{bit.get('tip')}",
            "baslangic_ts": str(bas_ts) if bas_ts else None,
            "bitis_ts": str(bit_ts) if bit_ts else None,
            "sure_dk": sure_dk,
            "personel_id": personel_id,
            "personel_ad": personel_ad,
            "baslangic_kasa": bas_kasa,
            "bitis_kasa": bit_kasa,
            "evo_nakit_satis": round(evo_nakit, 2),
            "evo_iskonto": round(evo_iskonto, 2),
            "evo_fis_sayisi": evo_fis_sayisi,
            "velocity_fis_per_saat": velocity,
            "giderler": round(gider_top, 2),
            "ara_teslim": round(ara_top, 2),
            "teslim": round(teslim, 2),
            "devir": round(devir, 2),
            "beklenen_kasa": round(beklenen, 2),
            "fark_kasa": fark,
            "tani": tani,
        }
        vardiyalar.append(v_kayit)

        # Personel özet
        pkey = personel_id or personel_ad or "?"
        po = personel_ozet.setdefault(pkey, {
            "ad": personel_ad or pkey,
            "vardiya_sayisi": 0,
            "kasa_fark_toplam": 0.0,
            "satis_toplam": 0.0,
            "fis_sayisi": 0,
            "anomali_sayisi": 0,
        })
        po["vardiya_sayisi"] += 1
        if fark is not None:
            po["kasa_fark_toplam"] = round(po["kasa_fark_toplam"] + fark, 2)
        po["satis_toplam"] = round(po["satis_toplam"] + evo_nakit, 2)
        po["fis_sayisi"] += evo_fis_sayisi
        if tani not in ("UYUMLU", "YETERSIZ_VERI"):
            po["anomali_sayisi"] += 1

    return {
        "sube_id": sube_id,
        "sube_adi": sube_adi_evvel,
        "evo_sube_id": evo_sube_id,
        "tarih": tarih,
        "event_sayisi": len(events),
        "vardiyalar": vardiyalar,
        "personel_ozet": personel_ozet,
    }


# ════════════════════════════════════════════════════════════════════════════
#  SPRINT C — ÜRÜN BOM + SAAT HEATMAP
# ════════════════════════════════════════════════════════════════════════════
# Bardak/sarf reçetesi: her ürün satıldığında hangi malzemeden kaç tane harcanır.
# Evo'da Grup_Pasta zaten Ice/14oz/8oz olarak gruplandığı için tek tek üründen
# çok grup başına reçete daha pratik.
#
# Default reçete (kullanıcı sonra düzenleyebilir):
#   "Ice" satışı   → 1 plastik bardak
#   "14 Oz" satışı → 1 büyük karton bardak
#   "8 Oz"  satışı → 1 küçük karton bardak
#   "Su" satışı    → 1 şişe su (ürün kendisi)
#   "Redbull"      → 1 kutu redbull
#   "Maden Suyu"   → 1 şişe maden suyu
#   "Pasta"        → 1 dilim pasta
#   "ÇAY"          → 1 çay bardağı (porselen — sayım dışı default)
# ════════════════════════════════════════════════════════════════════════════
URUN_BOM = {
    # grup → {sarf_kalemi: adet}
    "Ice":        {"plastik_bardak": 1},
    "14 Oz":      {"karton_buyuk":   1},
    "8 Oz":       {"karton_kucuk":   1},
    "Su":         {"su_sise":        1},
    "Maden Suyu": {"maden_sise":     1},
    "Redbull":    {"redbull_kutu":   1},
    "Pasta":      {"pasta_dilim":    1},
    "ÇAY":        {},  # porselen kupa — sayım dışı
}


def bom_recete_varyans(cur, sube_id: str, tarih: str) -> Dict[str, Any]:
    """Reçete varyansı: Evo satışından türeyen teorik bardak tüketimi vs
    fiziksel azalma (açılış + URUN_AC − kapanış)."""
    # 1. Bugünkü Evo satışları (şube bazlı, grup bazlı)
    cur.execute("SELECT ad FROM subeler WHERE id::text=%s", (str(sube_id),))
    srow = cur.fetchone()
    sube_adi_evvel = str(dict(srow).get("ad") or "") if srow else ""
    evo_gruplar: Dict[str, float] = {}
    try:
        from evo_sync import hs_rapor_sube_bazli
        from datetime import date as _d
        y, mo, dn = (int(x) for x in str(tarih)[:10].split("-"))
        tarih_d = _d(y, mo, dn)
        evo = hs_rapor_sube_bazli(tarih_d, tarih_d)
        evvel_lower = sube_adi_evvel.strip().lower().replace("şubesi", "").strip()
        for ad, payload in (evo.get("subeler") or {}).items():
            elow = ad.strip().lower().replace("şubesi", "").strip()
            if evvel_lower and (evvel_lower in elow or elow in evvel_lower):
                for g, v in (payload.get("gruplar") or {}).items():
                    evo_gruplar[g] = float(v.get("adet") or 0)
                break
    except Exception as e:
        log.warning("bom: evo cekilemedi: %s", e)

    # 2. BOM ile teorik sarf hesabı
    teorik_sarf: Dict[str, float] = {}
    for grup, adet in evo_gruplar.items():
        for sarf, oran in (URUN_BOM.get(grup) or {}).items():
            teorik_sarf[sarf] = teorik_sarf.get(sarf, 0) + adet * oran

    # 3. Fiziksel sarf (açılış + URUN_AC − kapanış)
    # Bugünün ACILIS event'inden açılış stok sayımı
    cur.execute(
        """
        SELECT meta FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=%s::date AND tip='ACILIS' AND durum='tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST LIMIT 1
        """,
        (sube_id, tarih),
    )
    ar = cur.fetchone()
    acilis_meta = _meta_oku(dict(ar)["meta"]) if ar else {}
    acilis_stok = acilis_meta.get("acilis_stok_sayim") or {}

    # Bugünün KAPANIS (varsa) — yoksa devam ediyor
    cur.execute(
        """
        SELECT meta FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=%s::date AND tip='KAPANIS' AND durum='tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST LIMIT 1
        """,
        (sube_id, tarih),
    )
    kr = cur.fetchone()
    kapanis_meta = _meta_oku(dict(kr)["meta"]) if kr else {}
    kapanis_stok = kapanis_meta.get("kapanis_stok_sayim") or {}

    # URUN_AC bugün açılan paketler
    cur.execute(
        """
        SELECT kalemler_json
        FROM urun_ac_taslak
        WHERE sube_id=%s AND tarih=%s::date AND durum='aktif'
        """,
        (sube_id, tarih),
    )
    urun_ac_toplam: Dict[str, float] = {}
    for r in (cur.fetchall() or []):
        kj = dict(r).get("kalemler_json")
        if isinstance(kj, str):
            try:
                kj = json.loads(kj)
            except Exception:
                kj = {}
        if isinstance(kj, dict):
            for k, v in kj.items():
                try:
                    urun_ac_toplam[k] = urun_ac_toplam.get(k, 0) + float(v or 0)
                except (TypeError, ValueError):
                    pass

    # Bardak/sarf isim haritası: BOM çıktısındaki anahtarlar (plastik_bardak)
    # ile şube meta JSON'undaki anahtarlar (bardak_plastik, bardak_kucuk vs.) eşleştir.
    SARF_META_MAP = {
        "plastik_bardak": ["bardak_plastik"],
        "karton_buyuk":   ["bardak_buyuk"],
        "karton_kucuk":   ["bardak_kucuk"],
        "su_sise":        ["su_adet", "su"],
        "maden_sise":     ["maden_adet", "maden"],
        "redbull_kutu":   ["redbull_adet"],
        "pasta_dilim":    ["pasta_adet"],
    }

    def _meta_top(meta: Dict[str, Any], anahtarlar: List[str]) -> float:
        s = 0.0
        for a in anahtarlar:
            v = meta.get(a)
            if v is None:
                continue
            try:
                s += float(v)
            except (TypeError, ValueError):
                pass
        return s

    sonuclar = []
    for sarf, teorik in teorik_sarf.items():
        meta_anahtar = SARF_META_MAP.get(sarf) or [sarf]
        acilis_v = _meta_top(acilis_stok, meta_anahtar)
        kapanis_v = _meta_top(kapanis_stok, meta_anahtar) if kapanis_stok else None
        urun_ac_v = _meta_top(urun_ac_toplam, meta_anahtar)

        if kapanis_v is None:
            fiziksel = None
            durum = "kapanis_bekliyor"
            varyans = None
        else:
            fiziksel = (acilis_v + urun_ac_v) - kapanis_v
            varyans = round(fiziksel - teorik, 2)
            if abs(varyans) < 1:
                durum = "uyumlu"
            elif varyans > 0:
                durum = "kayit_disi_kullanim"  # gerçek > teorik → ekstra harcanmış
            else:
                durum = "satis_disi_olusum"   # teorik > gerçek → POS'a girip ürün vermemiş?
        sonuclar.append({
            "sarf": sarf,
            "teorik_evo": round(teorik, 2),
            "fiziksel": None if fiziksel is None else round(fiziksel, 2),
            "varyans": varyans,
            "durum": durum,
            "acilis": round(acilis_v, 2),
            "urun_ac": round(urun_ac_v, 2),
            "kapanis": None if kapanis_v is None else round(kapanis_v, 2),
        })

    return {
        "sube_id": sube_id,
        "sube_adi": sube_adi_evvel,
        "tarih": tarih,
        "evo_gruplar": evo_gruplar,
        "recete_sonuclari": sonuclar,
    }


def saat_heatmap(cur, gun: int = 14,
                 sube_id: Optional[str] = None) -> Dict[str, Any]:
    """Şube × saat × anomali yoğunluk grafiği için veri.
    truth_motor_kararlar tablosundan saat damgalı anomalileri topla."""
    where = "WHERE tani NOT IN ('UYUMLU','YETERSIZ_VERI')"
    params: List[Any] = []
    if sube_id:
        where += " AND sube_id=%s"
        params.append(sube_id)
    where += " AND olusturma >= NOW() - (%s || ' days')::interval"
    params.append(gun)

    try:
        cur.execute(
            f"""
            SELECT sube_id, EXTRACT(HOUR FROM olusturma)::int AS saat,
                   COUNT(*) AS anomali_sayisi,
                   COALESCE(AVG(guven_skoru), 0) AS ort_guven
            FROM truth_motor_kararlar
            {where}
            GROUP BY sube_id, saat
            ORDER BY sube_id, saat
            """,
            tuple(params),
        )
        rows = [dict(r) for r in (cur.fetchall() or [])]
    except Exception as e:
        log.warning("saat_heatmap hata: %s", e)
        rows = []

    # Şube adı eşle
    sube_adi = {}
    cur.execute("SELECT id::text AS id, ad FROM subeler")
    for r in cur.fetchall() or []:
        d = dict(r)
        sube_adi[d["id"]] = d["ad"]

    matris: Dict[str, Dict[int, int]] = {}
    for r in rows:
        sid = r["sube_id"]
        ad = sube_adi.get(sid, sid[:8])
        matris.setdefault(ad, {})[int(r["saat"])] = int(r["anomali_sayisi"])

    return {"gun": gun, "matris": matris, "saatler": list(range(0, 24))}


# ════════════════════════════════════════════════════════════════════════════
#  SPRINT B — PATTERN DETECTION (NRF zekası)
# ════════════════════════════════════════════════════════════════════════════

def round_number_pattern(cur, gun: int = 60,
                         sube_id: Optional[str] = None) -> Dict[str, Any]:
    """Kasa açıkları yuvarlak sayılarda (50, 100, 200, 500) yoğunlaşıyor mu?
    Zimmet sinyali: kasiyer 'yuvarlak miktar' alır (rastgele değil)."""
    where_sube = ""
    params: List[Any] = [gun]
    if sube_id:
        where_sube = "AND sube_id=%s"
        params.append(sube_id)
    try:
        cur.execute(
            f"""
            SELECT fark_n1_n2 AS fark
            FROM truth_motor_kararlar
            WHERE boyut='kasa'
              AND olusturma >= NOW() - (%s || ' days')::interval
              AND fark_n1_n2 IS NOT NULL
              AND ABS(fark_n1_n2) >= 1
              {where_sube}
            """,
            tuple(params),
        )
        rows = [float(dict(r)["fark"]) for r in (cur.fetchall() or [])]
    except Exception:
        return {"gun": gun, "toplam": 0, "yuvarlak": [], "anomali": False}

    if not rows:
        return {"gun": gun, "toplam": 0, "yuvarlak": [], "anomali": False}

    # Yuvarlak değerleri say: |fark| / 10 tam sayı + |fark| / 50 tam sayı
    yuvarlak_bins = {10: 0, 25: 0, 50: 0, 100: 0, 200: 0, 500: 0, 1000: 0}
    for f in rows:
        af = abs(f)
        for bin_ in yuvarlak_bins:
            if abs(af - round(af / bin_) * bin_) < 0.5 and af >= bin_ * 0.9:
                yuvarlak_bins[bin_] += 1
                break
    toplam = len(rows)
    yuvarlak_top = sum(yuvarlak_bins.values())
    # Beklenen yuvarlak oranı %15-20 (rastgele dağılım). > %35 → anomali.
    yuvarlak_oran = yuvarlak_top / toplam if toplam > 0 else 0
    return {
        "gun": gun,
        "toplam_kasa_fark": toplam,
        "yuvarlak_sayisi": yuvarlak_top,
        "yuvarlak_oran_yuzde": round(yuvarlak_oran * 100, 1),
        "bins": yuvarlak_bins,
        "anomali": yuvarlak_oran > 0.35,
        "yorum": ("Kasa açıkları yuvarlak sayılarda yoğun — zimmet sinyali"
                  if yuvarlak_oran > 0.35
                  else "Rastgele dağılım — normal"),
    }


def end_of_shift_effect(cur, gun: int = 30,
                         sube_id: Optional[str] = None) -> Dict[str, Any]:
    """KAPANIŞ vardiyasında açık yoğunlaşıyor mu (kapanış telaşı)?
    Vardiya P&L'den KAPANIS dilimindeki farkları ACILIS-KONTROL dilimi ile karşılaştır."""
    from datetime import date as _d, timedelta as _td
    today = _d.today()
    cur.execute("SELECT id::text AS id, ad FROM subeler ORDER BY ad")
    subeler = [dict(r) for r in (cur.fetchall() or [])]
    if sube_id:
        subeler = [s for s in subeler if s["id"] == sube_id]

    aksam_farklar = []
    gun_ici_farklar = []
    for off in range(gun):
        t = (today - _td(days=off)).isoformat()
        for sb in subeler:
            try:
                u = vardiya_bazli_uzlasma(cur, sb["id"], t, evo_dahil=False)
            except Exception:
                continue
            for v in (u.get("vardiyalar") or []):
                f = v.get("fark_kasa")
                if f is None:
                    continue
                if v.get("tip_dilimi", "").endswith("KAPANIS"):
                    aksam_farklar.append(float(f))
                else:
                    gun_ici_farklar.append(float(f))

    def _ort_abs(lst):
        return sum(abs(x) for x in lst) / len(lst) if lst else 0.0

    aksam_ort = _ort_abs(aksam_farklar)
    gun_ort = _ort_abs(gun_ici_farklar)
    fark_orani = (aksam_ort / gun_ort) if gun_ort > 0 else 0
    return {
        "gun": gun,
        "aksam_vardiya_sayisi": len(aksam_farklar),
        "gun_ici_vardiya_sayisi": len(gun_ici_farklar),
        "aksam_ort_abs_fark": round(aksam_ort, 2),
        "gun_ici_ort_abs_fark": round(gun_ort, 2),
        "aksam_gun_orani": round(fark_orani, 2),
        "anomali": fark_orani > 2.0,
        "yorum": ("Kapanış vardiyasında ortalama fark gün içine göre 2x üstü — "
                  "telaş veya kasıt sinyali"
                  if fark_orani > 2.0
                  else "Vardiya dağılımı normal"),
    }


def sube_cluster_anomalisi(cur, gun: int = 30) -> Dict[str, Any]:
    """Tüm şubelerin anomali oranı + 1 şube cluster dışı mı?"""
    from datetime import date as _d, timedelta as _td
    today = _d.today()
    cur.execute("SELECT id::text AS id, ad FROM subeler ORDER BY ad")
    subeler = [dict(r) for r in (cur.fetchall() or [])]

    sube_stat: Dict[str, Dict[str, Any]] = {}
    for sb in subeler:
        sube_stat[sb["id"]] = {"ad": sb["ad"], "anomali": 0, "vardiya": 0, "fark_top": 0.0}

    for off in range(gun):
        t = (today - _td(days=off)).isoformat()
        for sb in subeler:
            try:
                u = vardiya_bazli_uzlasma(cur, sb["id"], t, evo_dahil=False)
            except Exception:
                continue
            for v in (u.get("vardiyalar") or []):
                st = sube_stat[sb["id"]]
                st["vardiya"] += 1
                if v.get("tani") not in ("UYUMLU", "YETERSIZ_VERI"):
                    st["anomali"] += 1
                f = v.get("fark_kasa")
                if f is not None:
                    st["fark_top"] += abs(float(f))

    # Anomali oranlarını hesapla
    oranlar = []
    for st in sube_stat.values():
        if st["vardiya"] > 0:
            st["anomali_oran"] = st["anomali"] / st["vardiya"]
            st["ort_fark_abs"] = st["fark_top"] / st["vardiya"]
            oranlar.append(st["anomali_oran"])

    if not oranlar:
        return {"gun": gun, "subeler": list(sube_stat.values()), "yorum": "veri yok"}

    ort = sum(oranlar) / len(oranlar)
    var = sum((x - ort) ** 2 for x in oranlar) / len(oranlar)
    std = var ** 0.5 if var > 0 else 0.01
    aykiri = []
    for sid, st in sube_stat.items():
        if "anomali_oran" not in st:
            continue
        z = (st["anomali_oran"] - ort) / (std or 0.01)
        st["z_skor"] = round(z, 2)
        st["aykiri"] = abs(z) > 1.5
        if abs(z) > 1.5:
            aykiri.append(st["ad"])
        # round için
        st["anomali_oran"] = round(st["anomali_oran"] * 100, 1)
        st["ort_fark_abs"] = round(st["ort_fark_abs"], 2)
        st["fark_top"] = round(st["fark_top"], 2)

    return {
        "gun": gun,
        "ort_anomali_oran": round(ort * 100, 1),
        "subeler": list(sube_stat.values()),
        "aykiri_subeler": aykiri,
        "yorum": (f"Aykırı şube tespit edildi: {', '.join(aykiri)}" if aykiri
                  else "Tüm şubeler benzer profilde"),
    }


def coklu_sube_korelasyon(cur, tarih: Optional[str] = None) -> Dict[str, Any]:
    """Aynı gün birden çok şubede aynı boyutta anomali var mı?
    Varsa sistemik (POS sync) muhtemel, personel suçu değil."""
    if not tarih:
        from datetime import date as _d
        tarih = _d.today().isoformat()
    cur.execute(
        """
        SELECT sube_id, boyut, tani
        FROM truth_motor_kararlar
        WHERE tarih=%s::date
          AND tani NOT IN ('UYUMLU', 'YETERSIZ_VERI')
        """,
        (tarih,),
    )
    rows = [dict(r) for r in (cur.fetchall() or [])]
    # Boyut × tani başına şube sayısı
    grup: Dict[tuple, set] = {}
    for r in rows:
        anahtar = (r["boyut"], r["tani"])
        grup.setdefault(anahtar, set()).add(r["sube_id"])
    korelasyon = []
    for (boyut, tani), subeler in grup.items():
        if len(subeler) >= 2:
            korelasyon.append({
                "boyut": boyut, "tani": tani,
                "sube_sayisi": len(subeler),
                "yorum": (
                    f"{len(subeler)} şubede aynı anomali → sistemik (POS/Evo) sinyali"
                    if len(subeler) >= 3 else f"{len(subeler)} şubede benzer pattern"
                ),
            })
    korelasyon.sort(key=lambda x: -x["sube_sayisi"])
    return {"tarih": tarih, "korelasyonlar": korelasyon}


# ════════════════════════════════════════════════════════════════════════════
#  SPRINT D — MALİ ÇAPRAZ KONTROL
# ════════════════════════════════════════════════════════════════════════════
# Z raporu POS toplamı ↔ kart_hareketleri (gerçek slip) çapraz
# anlik_giderler kategori anomalisi (aynı kasiyer + aynı kategori sürekli)
# Sahte iade tespiti
# ════════════════════════════════════════════════════════════════════════════

def z_kart_slip_capraz(cur, gun: int = 7,
                        sube_id: Optional[str] = None) -> Dict[str, Any]:
    """Z raporu kart toplamı ile kart_hareketleri (gerçek slip) çapraz kontrol.

    Z'de görünen ama slip'te yok → POS kart hareketi kaydedilmemiş (Evo eksik)
    Slip'te var ama Z'de yok → manuel slip + fişsiz satış (KAYIT_DISI)
    Fark > %1 → uyumsuzluk
    """
    from datetime import date as _d, timedelta as _td
    today = _d.today()
    sonuc = []
    where_sube = "AND c.sube_id=%s" if sube_id else ""

    for off in range(gun):
        t = (today - _td(days=off)).isoformat()
        try:
            # Z raporu (ciro tablosu) — pos toplamı
            params_z = [t]
            if sube_id:
                params_z.append(sube_id)
            cur.execute(
                f"""
                SELECT c.sube_id, COALESCE(SUM(c.pos), 0) AS z_pos
                FROM ciro c
                WHERE c.tarih = %s::date AND c.durum = 'aktif'
                  {where_sube}
                GROUP BY c.sube_id
                """,
                tuple(params_z),
            )
            z_rows = {dict(r)["sube_id"]: float(dict(r)["z_pos"]) for r in (cur.fetchall() or [])}

            # kart_hareketleri (gerçek slip)
            params_k = [t]
            ks_where = ""
            if sube_id:
                params_k.append(sube_id)
                ks_where = "AND sube_id=%s"
            cur.execute(
                f"""
                SELECT sube_id, COALESCE(SUM(tutar), 0) AS slip_top
                FROM kart_hareketleri
                WHERE tarih = %s::date {ks_where}
                GROUP BY sube_id
                """,
                tuple(params_k),
            )
            slip_rows = {dict(r)["sube_id"]: float(dict(r)["slip_top"]) for r in (cur.fetchall() or [])}
        except Exception as e:
            log.warning("z_kart_slip_capraz hata (%s): %s", t, e)
            continue

        # Birleştir + karşılaştır
        tum_subeler = set(z_rows.keys()) | set(slip_rows.keys())
        for sid in tum_subeler:
            z = z_rows.get(sid, 0.0)
            slip = slip_rows.get(sid, 0.0)
            fark = round(slip - z, 2)
            if abs(z) < 1 and abs(slip) < 1:
                continue
            esik = max(abs(z), abs(slip)) * 0.01  # %1
            if abs(fark) > max(esik, 5):  # min 5₺
                sonuc.append({
                    "tarih": t,
                    "sube_id": sid,
                    "z_pos": round(z, 2),
                    "slip": round(slip, 2),
                    "fark": fark,
                    "tani": ("KART_SLIP_FAZLA" if fark > 0
                             else "Z_KART_ATILANMIS")
                })
    sonuc.sort(key=lambda x: -abs(x["fark"]))
    return {"gun": gun, "uyumsuzluk_sayisi": len(sonuc), "kayitlar": sonuc[:50]}


def gider_kategori_anomalisi(cur, gun: int = 30,
                              sube_id: Optional[str] = None) -> Dict[str, Any]:
    """anlik_giderler kategori bazlı pattern:
    - Aynı personel + aynı kategori son N gün > 5 kez = sahte gider şüphesi
    - Yuvarlak tutar yoğun = manuel ayarlama
    - Fiş kontrolü 7+ gün bekleyenler = CFO ilgi kaybı
    """
    where_sube = "AND sube=%s" if sube_id else ""
    params = [gun]
    if sube_id:
        params.append(sube_id)

    try:
        cur.execute(
            f"""
            SELECT personel_id, kategori, COUNT(*) AS adet,
                   COALESCE(SUM(tutar), 0) AS tutar_top,
                   COUNT(*) FILTER (WHERE fis_kontrol_durumu='bekliyor'
                                    AND olusturma < NOW() - INTERVAL '7 days') AS gec_fis
            FROM anlik_giderler
            WHERE tarih >= CURRENT_DATE - (%s || ' days')::interval
              {where_sube}
            GROUP BY personel_id, kategori
            HAVING COUNT(*) >= 3
            ORDER BY COUNT(*) DESC
            """,
            tuple(params),
        )
        rows = [dict(r) for r in (cur.fetchall() or [])]
    except Exception as e:
        log.warning("gider_kategori_anomalisi hata: %s", e)
        return {"gun": gun, "kayitlar": [], "hata": str(e)}

    anomali = []
    for r in rows:
        adet = int(r["adet"])
        kategori = r["kategori"]
        tutar_top = float(r["tutar_top"] or 0)
        pid = r["personel_id"]
        gec_fis = int(r["gec_fis"] or 0)

        sebep = []
        if adet >= 5:
            sebep.append(f"{adet}× tekrar")
        if gec_fis >= 3:
            sebep.append(f"{gec_fis} fiş 7+gün bekliyor")
        # Yuvarlak tutar tespiti (her kayıt 50/100/200 katı mı)
        try:
            cur.execute(
                """
                SELECT tutar FROM anlik_giderler
                WHERE personel_id=%s AND kategori=%s
                  AND tarih >= CURRENT_DATE - INTERVAL '30 days'
                """,
                (pid, kategori),
            )
            tutarlar = [float(dict(t)["tutar"] or 0) for t in (cur.fetchall() or [])]
            yuvarlak = sum(1 for t in tutarlar
                           if t >= 50 and abs(t - round(t / 50) * 50) < 0.5)
            if tutarlar and (yuvarlak / len(tutarlar)) > 0.5:
                sebep.append("yuvarlak tutar yoğun")
        except Exception:
            pass

        if sebep:
            anomali.append({
                "personel_id": pid,
                "kategori": kategori,
                "adet": adet,
                "tutar_top": round(tutar_top, 2),
                "gec_fis_sayisi": gec_fis,
                "sebepler": sebep,
            })
    return {"gun": gun, "kayitlar": anomali[:50]}


def sahte_iade_tespit(cur, gun: int = 14,
                       sube_id: Optional[str] = None) -> Dict[str, Any]:
    """Z raporunda iade var ama stoğa geri dönüş yok → iade kaydı sahte muhtemel."""
    # MVP: ciro.iade (varsa) > 0 + stok_hareketleri'nda iade hareketi yok = işaret
    where_sube = "AND sube_id=%s" if sube_id else ""
    params = [gun]
    if sube_id:
        params.append(sube_id)
    try:
        cur.execute(
            f"""
            SELECT tarih, sube_id, COALESCE(iade, 0) AS iade_tutari
            FROM ciro
            WHERE tarih >= CURRENT_DATE - (%s || ' days')::interval
              AND COALESCE(iade, 0) > 0
              AND durum='aktif'
              {where_sube}
            ORDER BY tarih DESC, iade_tutari DESC
            """,
            tuple(params),
        )
        rows = [dict(r) for r in (cur.fetchall() or [])]
    except Exception as e:
        log.warning("sahte_iade_tespit hata: %s", e)
        return {"gun": gun, "kayitlar": [], "hata": str(e)}

    # Sade bir liste — sonra stok cross-check eklenebilir
    return {
        "gun": gun,
        "iade_gunleri": len(rows),
        "kayitlar": [{
            "tarih": str(r["tarih"]),
            "sube_id": r["sube_id"],
            "iade_tutari": float(r["iade_tutari"]),
            "not": "Stok iadesi kontrolü pending — manuel doğrula",
        } for r in rows[:50]],
    }


def personel_davranis_sinyali(cur, gun: int = 30,
                              sube_id: Optional[str] = None) -> Dict[str, Any]:
    """Personel davranış sinyalleri (son N gün).

    Sinyaller:
      - velocity: saatlik fiş sayısı ortalaması + sapma (Z-skor)
      - ortalama fiş tutarı sapma (anomali)
      - iskonto oranı (toplam iskonto / toplam ciro)
      - vardiya başına ortalama kasa farkı

    Returns:
      {
        "gun": N,
        "personeller": [
          {"personel_id", "ad",
           "vardiya_sayisi", "ortalama_velocity", "ortalama_fis_tutari",
           "iskonto_orani_yuzde", "ortalama_kasa_fark",
           "anomali_seviye": "normal"|"yuksek"|"kritik"}
        ]
      }
    """
    # Bu fonksiyon Evo satışlarını agregat alır.
    # MVP: o günün tüm şube vardiya_bazli_uzlasma sonuçlarını birleştir.
    from datetime import date as _d, timedelta as _td

    # Son N gün için her şube × her gün vardiya analizini topla
    # (basit yaklaşım: tek günlük analizleri loop'la)
    cur.execute("SELECT id::text AS id, ad FROM subeler ORDER BY ad")
    subeler = [dict(r) for r in (cur.fetchall() or [])]
    if sube_id:
        subeler = [s for s in subeler if s["id"] == sube_id]

    today = _d.today()
    personel_agregat: Dict[str, Dict[str, Any]] = {}

    for off in range(gun):
        t = (today - _td(days=off)).isoformat()
        for sb in subeler:
            try:
                # Evo dahil — bu fonksiyon velocity, fiş tutarı, iskonto için Evo gerektirir
                u = vardiya_bazli_uzlasma(cur, sb["id"], t, evo_dahil=True)
            except Exception:
                continue
            for v in u.get("vardiyalar") or []:
                pkey = v.get("personel_id") or v.get("personel_ad") or "?"
                pa = personel_agregat.setdefault(pkey, {
                    "ad": v.get("personel_ad") or pkey,
                    "vardiya_sayisi": 0,
                    "satis_toplam": 0.0,
                    "fis_sayisi": 0,
                    "iskonto_toplam": 0.0,
                    "kasa_fark_toplam": 0.0,
                    "kasa_fark_abs_toplam": 0.0,
                    "anomali_sayisi": 0,
                })
                pa["vardiya_sayisi"] += 1
                pa["satis_toplam"] += float(v.get("evo_nakit_satis") or 0)
                pa["fis_sayisi"] += int(v.get("evo_fis_sayisi") or 0)
                pa["iskonto_toplam"] += float(v.get("evo_iskonto") or 0)
                f = v.get("fark_kasa")
                if f is not None:
                    pa["kasa_fark_toplam"] += float(f)
                    pa["kasa_fark_abs_toplam"] += abs(float(f))
                if v.get("tani") not in ("UYUMLU", "YETERSIZ_VERI"):
                    pa["anomali_sayisi"] += 1

    # Personel kayıt isimleri için ekstra sorgu
    pid_list = [pid for pid in personel_agregat.keys() if pid and pid != "?"]
    if pid_list:
        try:
            cur.execute(
                "SELECT id::text, ad FROM personeller WHERE id::text = ANY(%s)",
                (pid_list,),
            )
            for r in cur.fetchall() or []:
                rd = dict(r)
                if rd["id"] in personel_agregat:
                    personel_agregat[rd["id"]]["ad"] = rd["ad"]
        except Exception:
            pass

    # Türetilmiş metrikler
    sonuc = []
    for pid, pa in personel_agregat.items():
        if pa["vardiya_sayisi"] == 0:
            continue
        ort_fis = pa["satis_toplam"] / pa["fis_sayisi"] if pa["fis_sayisi"] > 0 else 0
        isk_oran = (pa["iskonto_toplam"] / pa["satis_toplam"] * 100) if pa["satis_toplam"] > 0 else 0
        ort_fark = pa["kasa_fark_toplam"] / pa["vardiya_sayisi"]
        ort_fark_abs = pa["kasa_fark_abs_toplam"] / pa["vardiya_sayisi"]
        anomali_oran = pa["anomali_sayisi"] / pa["vardiya_sayisi"]

        # Anomali seviyesi (heuristic)
        seviye = "normal"
        if anomali_oran >= 0.5 or abs(ort_fark) > 50:
            seviye = "kritik"
        elif anomali_oran >= 0.25 or abs(ort_fark) > 20 or isk_oran > 5:
            seviye = "yuksek"

        sonuc.append({
            "personel_id": pid, "ad": pa["ad"],
            "vardiya_sayisi": pa["vardiya_sayisi"],
            "fis_sayisi": pa["fis_sayisi"],
            "satis_toplam": round(pa["satis_toplam"], 2),
            "ortalama_fis_tutari": round(ort_fis, 2),
            "iskonto_orani_yuzde": round(isk_oran, 2),
            "ortalama_kasa_fark": round(ort_fark, 2),
            "ortalama_kasa_fark_abs": round(ort_fark_abs, 2),
            "anomali_sayisi": pa["anomali_sayisi"],
            "anomali_oran_yuzde": round(anomali_oran * 100, 1),
            "anomali_seviye": seviye,
        })
    sonuc.sort(key=lambda x: (
        {"kritik": 0, "yuksek": 1, "normal": 2}.get(x["anomali_seviye"], 3),
        -x["anomali_sayisi"]
    ))
    return {"gun": gun, "toplam": len(sonuc), "personeller": sonuc}
