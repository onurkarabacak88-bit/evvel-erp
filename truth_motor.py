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
    "AKSAM_ZIMMET_SINYALI",      # kasa+ & bardak− & Evo bardak destekli
    "POS_BYPASS",                # bardak eksik ama Evo yok → kayıt dışı satış
    "YETERSIZ_VERI",             # N1 veya N2 yok
    # ── Sprint E — İkram vs Zimmet ayırım tanıları ───────────────────────
    "BELGELENMIS_IADE",          # fire kaydı 'iade'/'siparis_iptali' → açıklanmış, zimmet yok
    "BELGELENMIS_FIRE",          # fire kaydı 'skt_bozulma'/'kirilma' vb. → açıklanmış
    "ZIMMET_IPTAL_MANIPULASYON", # Evo iptal tutarı ≈ kasa açığı → sahte iptal + para cepde
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
    "YETERSIZ_VERI":             {"oto": "—",                    "insan": "Eksik sayımı tamamla",                                 "alarm": "yok"},
    # Sprint E
    "BELGELENMIS_IADE":          {"oto": "log_yesil",            "insan": "Fire kaydı + iade belgesi mevcut — araştırma gerekmez", "alarm": "yok"},
    "BELGELENMIS_FIRE":          {"oto": "log_yesil",            "insan": "Fire kaydı mevcut (zayi/bozulma) — açıklanmış kayıp",  "alarm": "yok"},
    "ZIMMET_IPTAL_MANIPULASYON": {"oto": "cfo_bildirim_kritik",  "insan": "Sahte Evo iptali + para cepde — soruşturma + kamera",  "alarm": "kritik"},
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


# ════════════════════════════════════════════════════════════════════════════
#  ZEKÂ ÖZETİ — motor_calistir'in son adımı
#  Taniler listesinden tek denetçi kararı üretir (insan diliyle).
# ════════════════════════════════════════════════════════════════════════════

# Tanı tipi → öncelik (yüksek = daha tehlikeli)
_TANI_ONCELIK = {
    "ZIMMET_NAKIT_CEPTE":    100,
    "AKSAM_ZIMMET_SINYALI":  95,
    "SWEETHEARTING_SINYAL":  90,
    "KAOS":                  85,
    "STOK_KACAGI_BEYANSIZ":  80,
    "POS_BYPASS":            75,
    "SABAH_TOPYEKUN":        70,
    "AKSAM_TOPYEKUN":        70,
    "POS_SYNC_HATA":         60,
    "SABAH_HATALI":          40,
    "AKSAM_HATALI":          40,
    "COZULMEDI":             35,
    "IKRAM_SURDURULEN":      20,
    "IKRAM_UNUTULDU":        15,
    "IKRAM_EVO_TEYIT":           5,
    "YETERSIZ_VERI":             3,
    "UYUMLU":                    0,
    # Sprint E
    "ZIMMET_IPTAL_MANIPULASYON": 98,
    "BELGELENMIS_IADE":          2,
    "BELGELENMIS_FIRE":          2,
}

_TANI_INSAN = {
    "ZIMMET_NAKIT_CEPTE":    "Satış yapıldı, para kasaya konmadı — ZİMMET",
    "AKSAM_ZIMMET_SINYALI":  "Akşam vardiyası zimmet pozisyonu",
    "SWEETHEARTING_SINYAL":  "Kayıt dışı satış sinyali (sweethearting)",
    "KAOS":                  "Birden fazla boyutta çözümsüz fark — soruşturma gerekli",
    "STOK_KACAGI_BEYANSIZ":  "Ürün eksildi, beyan yok",
    "POS_BYPASS":            "POS kaydı olmadan ürün verildi",
    "SABAH_TOPYEKUN":        "Sabah vardiyası tüm sayımlarda hatalı",
    "AKSAM_TOPYEKUN":        "Akşam vardiyası tüm sayımlarda hatalı",
    "POS_SYNC_HATA":         "Evo POS ile sayım uyumsuz — sistem sorunu",
    "SABAH_HATALI":          "Sabah sayım hatası",
    "AKSAM_HATALI":          "Akşam devir hatası",
    "COZULMEDI":             "Fark var, kaynak belirlenemedi — yeniden say",
    "IKRAM_SURDURULEN":      "Süregelen ikram pattern — onaylı mı?",
    "IKRAM_UNUTULDU":        "Kayıtsız ikram",
    "IKRAM_EVO_TEYIT":           "Evo onaylı ikram — normal",
    "YETERSIZ_VERI":             "Veri yetersiz",
    "UYUMLU":                    "Uyumlu",
    # Sprint E
    "BELGELENMIS_IADE":          "Fire kaydı var — iade/iptal belgeli, zimmet yok",
    "BELGELENMIS_FIRE":          "Fire kaydı var — zayi/bozulma belgeli",
    "ZIMMET_IPTAL_MANIPULASYON": "Sahte Evo iptali — satış yapıldı, para kasaya konmadı",
}

_ALARM_ESIK = {
    "kritik": 85,   # ≥85 → kritik
    "yuksek": 60,   # ≥60 → yüksek
    "orta":   30,   # ≥30 → orta
}

_BOYUT_KISA = {
    "kasa": "kasa", "bardak_plastik": "plastik bardak",
    "bardak_karton": "karton bardak", "redbull_soda": "RedBull/soda", "pasta": "pasta",
}


def _zeka_ozet_uret(taniler: List["Tani"],
                     baskin_tetik: Optional[Dict] = None) -> Dict[str, Any]:
    """Motor tarafından üretilen tanilerden tek bir denetçi kararı yaz.

    motor_calistir → capraz_boyut_yorumla bittikten SONRA çağrılır.
    Ekstra DB sorgusu YOK — yalnızca taniler listesini kullanır.

    Returns:
        {
          alarm: "kritik"|"yuksek"|"orta"|"normal",
          ana_tani: str,            # en yüksek öncelikli tani tipi
          guven: float,             # ana tanının güven skoru
          ozet: str,                # 1 cümle (teknik, gösterge paneli için)
          yorum_metni: str,         # çok satır, insan dili, denetçi raporu
          anomali_boyutlar: List,   # sadece anomali olan boyutlar
          capraz_aciklama: str,     # varsa cross-dim detay_capraz metni
        }
    """
    if not taniler:
        return {"alarm": "normal", "ana_tani": "YETERSIZ_VERI",
                "guven": 0, "ozet": "Veri yok", "yorum_metni": "⚪ Veri yok",
                "anomali_boyutlar": [], "capraz_aciklama": ""}

    # Tüm anomalileri önceliğe göre sırala
    anomaliler = [
        t for t in taniler
        if t.tani not in ("UYUMLU", "YETERSIZ_VERI")
    ]
    anomaliler.sort(key=lambda t: -_TANI_ONCELIK.get(t.tani, 0))

    # Normal akış
    if not anomaliler:
        return {
            "alarm": "normal",
            "ana_tani": "UYUMLU",
            "guven": 100,
            "ozet": "Tüm kontroller uyumlu — sorun yok",
            "yorum_metni": (
                "🟢 Normal\n\n"
                "✅ Kasa ve stok uyumlu. Evo POS verileri beyanlarla örtüşüyor.\n"
                "   Aksiyon gerekmez."
            ),
            "anomali_boyutlar": [],
            "capraz_aciklama": "",
        }

    # Ana tanı (en tehlikeli)
    ana = anomaliler[0]
    oncelik = _TANI_ONCELIK.get(ana.tani, 0)
    alarm = (
        "kritik" if oncelik >= _ALARM_ESIK["kritik"]
        else "yuksek" if oncelik >= _ALARM_ESIK["yuksek"]
        else "orta"
    )
    alarm_emoji = {"kritik": "🔴", "yuksek": "🟠", "orta": "🟡"}.get(alarm, "⚪")
    alarm_tr    = {"kritik": "KRİTİK", "yuksek": "YÜKSEK RİSK", "orta": "ORTA RİSK"}.get(alarm, "")

    # Anomali boyut listesi
    anomali_boyutlar = [
        {"boyut": t.boyut, "tani": t.tani, "fark": t.fark_n1_n2, "guven": t.guven_skoru}
        for t in anomaliler
    ]

    # Çapraz açıklama — varsa ana tanının detay_capraz'ını al
    capraz = (ana.detay or {}).get("capraz", "")
    if not capraz:
        for t in anomaliler[1:]:
            capraz = (t.detay or {}).get("capraz", "")
            if capraz:
                break

    # ─── Tek cümle özet ───────────────────────────────────────────────────
    kisa = _TANI_INSAN.get(ana.tani, ana.tani)
    etkilenen = ", ".join(_BOYUT_KISA.get(t.boyut, t.boyut) for t in anomaliler[:3])
    ozet = f"{kisa} [{etkilenen}] — güven %{ana.guven_skoru:.0f}"

    # ─── Çok satır insan-dili yorum ──────────────────────────────────────
    satirlar: List[str] = [f"{alarm_emoji} {alarm_tr}", ""]

    # Bulgular — her anomali boyut
    kasa_t = next((t for t in taniler if t.boyut == "kasa"), None)
    urun_anomali = [t for t in anomaliler if t.boyut != "kasa"]

    if kasa_t and kasa_t.fark_n1_n2 is not None and abs(kasa_t.fark_n1_n2) > 0.5:
        yon = "açık (eksik)" if kasa_t.fark_n1_n2 < 0 else "fazla (açıklanamayan gelir)"
        satirlar.append(f"💰 Kasa: ₺{abs(kasa_t.fark_n1_n2):.0f} {yon}")

    for t in urun_anomali[:3]:
        fark_str = ""
        if t.fark_n1_n2 is not None:
            fark_str = f" ({abs(t.fark_n1_n2):.0f} adet {'eksik' if t.fark_n1_n2 < 0 else 'fazla'})"
        tani_kisa = _TANI_INSAN.get(t.tani, t.tani)
        satirlar.append(f"📦 {_BOYUT_KISA.get(t.boyut, t.boyut)}{fark_str}: {tani_kisa}")

    # Çapraz bağlantı — asıl zekâ burada
    satirlar.append("")
    if capraz:
        satirlar.append(f"🔗 Çapraz bağlantı:")
        satirlar.append(f"   → {capraz}")
    else:
        # Capraz yoksa ana tanıdan çıkar
        satirlar.append(f"🔍 Sonuç: {kisa} (güven %{ana.guven_skoru:.0f})")

    # Eylem
    eylem = (ana.detay or {}).get("eylem", {})
    insan_eylem = eylem.get("insan", "")
    oto_eylem   = eylem.get("oto", "")
    satirlar.append("")
    if insan_eylem or oto_eylem:
        satirlar.append(f"⚡ Aksiyon:")
        if insan_eylem:
            satirlar.append(f"   • {insan_eylem}")
        if oto_eylem:
            satirlar.append(f"   • Otomatik: {oto_eylem}")
    elif alarm in ("kritik", "yuksek"):
        satirlar.append("⚡ Aksiyon: Kasa + stok yeniden sayım, kamera inceleme")

    # Kasa baskını
    if baskin_tetik:
        if baskin_tetik.get("baslatildi"):
            satirlar.append(f"\n🚨 KASA BASKINI BAŞLATILDI (id: {str(baskin_tetik.get('id',''))[:8]})")
        elif baskin_tetik.get("oneri"):
            satirlar.append(f"\n⚠️ Kasa baskını ÖNERİSİ — {', '.join(baskin_tetik.get('tani', []))}")

    return {
        "alarm": alarm,
        "ana_tani": ana.tani,
        "guven": round(ana.guven_skoru, 1),
        "ozet": ozet,
        "yorum_metni": "\n".join(satirlar),
        "anomali_boyutlar": anomali_boyutlar,
        "capraz_aciklama": capraz,
    }


def zeka_ozet_from_rows(rows: List[Dict]) -> Dict[str, Any]:
    """DB karar satırlarından (truth_motor_kararlar) zekâ özeti üret.

    gunluk_rapor endpoint'inde her şube için çağrılır — ekstra DB sorgusu yok.
    rows: [{"boyut","tani","guven_skoru","fark_n1_n2","detay_json"}, ...]
    """
    if not rows:
        return {"alarm": "normal", "ana_tani": "YETERSIZ_VERI",
                "guven": 0, "ozet": "Veri yok", "yorum_metni": "⚪ Veri yok"}

    class _TaniProxy:
        __slots__ = ("boyut", "tani", "guven_skoru", "fark_n1_n2", "detay")
        def __init__(self, r: Dict):
            self.boyut       = r.get("boyut", "")
            self.tani        = r.get("tani", "YETERSIZ_VERI")
            self.guven_skoru = float(r.get("guven_skoru") or 0)
            f                = r.get("fark_n1_n2")
            self.fark_n1_n2  = float(f) if f is not None else None
            dj               = r.get("detay_json") or {}
            self.detay       = dj if isinstance(dj, dict) else {}

    taniler = [_TaniProxy(r) for r in rows]
    return _zeka_ozet_uret(taniler)  # type: ignore[arg-type]


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

    # ── Sprint E: İkram vs Zimmet ayırım sinyalleri ──────────────────────────
    sprint_e_meta: Dict[str, Any] = {}
    try:
        sprint_e_meta = sprint_e_ikram_zimmet_ayir(cur, sube_id, tarih, taniler)
    except Exception as _e:
        log.warning("sprint_e_ikram_zimmet_ayir hata: %s", _e)

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

    # ─── ZEKÂ ÖZETİ — tanilerden tek denetçi kararı ──────────────────────
    zeka = _zeka_ozet_uret(taniler, baskin_tetik=baskin_tetik)

    return {
        "calisti": True,
        "sebep": None,
        "mod": mod,
        "taniler": [asdict(t) for t in taniler],
        "kaydedildi": kaydedildi,
        "baskin_tetik": baskin_tetik,
        # Tek denetçi kararı — motorun ZEKÂsi
        "alarm": zeka["alarm"],
        "ana_tani": zeka["ana_tani"],
        "guven": zeka["guven"],
        "ozet": zeka["ozet"],
        "yorum_metni": zeka["yorum_metni"],
        "anomali_boyutlar": zeka["anomali_boyutlar"],
        "capraz_aciklama": zeka["capraz_aciklama"],
        # Sprint E — ikram/zimmet ayırım meta
        "sprint_e": sprint_e_meta,
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


# ════════════════════════════════════════════════════════════════════════════
#  KATMAN 1-7 YARDIMCI FONKSİYONLAR — adaptive_truth_walk tarafından çağrılır
# ════════════════════════════════════════════════════════════════════════════

def _katman_1_sayisal_korelasyon(
    boyut: str, aksam_fark: float, sabah_fark_v1: float,
) -> Dict[str, Any]:
    """Katman 1: Kasa/stok farkının ürün birim fiyatıyla sayısal eşleşmesi.
    Tam adet × fiyat ≈ fark → kasıtlı miktar sinyali."""
    if boyut == "kasa":
        return {"katman": 1, "aktif": False, "sebep": "kasa boyutu için geçersiz"}
    BIRIM_FIYAT = {
        "bardak_plastik": 50.0,
        "bardak_karton":  60.0,
        "redbull_soda":   45.0,
        "pasta":          90.0,
    }
    fiyat = BIRIM_FIYAT.get(boyut)
    if not fiyat:
        return {"katman": 1, "aktif": False}
    en_buyuk_fark = max(abs(aksam_fark or 0), abs(sabah_fark_v1 or 0))
    if en_buyuk_fark < 0.5:
        return {"katman": 1, "aktif": False, "sebep": "fark çok küçük"}
    tam_adet = round(en_buyuk_fark / fiyat)
    if tam_adet == 0:
        return {"katman": 1, "aktif": False}
    beklenen = tam_adet * fiyat
    uyum = 1.0 - abs(en_buyuk_fark - beklenen) / beklenen
    eslesme = uyum >= 0.85
    return {
        "katman": 1, "aktif": True,
        "boyut_fiyat": fiyat,
        "fark": round(en_buyuk_fark, 2),
        "tahmini_adet": tam_adet,
        "beklenen_tutar": round(beklenen, 2),
        "uyum_yuzde": round(uyum * 100, 1),
        "eslesme": eslesme,
        "yorum": (
            f"{boyut} {tam_adet} adet × ₺{fiyat:.0f} = ₺{beklenen:.0f} "
            f"↔ fark ₺{en_buyuk_fark:.0f} (uyum %{uyum*100:.0f}) → "
            + ("Sayısal eşleşme: kasıtlı miktar sinyali" if eslesme
               else "Eşleşme yok — rastgele hata olabilir")
        ),
        "guven_delta": 12.0 if eslesme else 0.0,
    }


def _katman_2_bayesian_gecmis(
    cur, sube_id: str, boyut: str, tarih: str, gun: int = 30,
) -> Dict[str, Any]:
    """Katman 2: Son N günün aynı boyut anomali oranı → prior probability."""
    try:
        cur.execute(
            """
            SELECT COUNT(*) AS toplam,
                   COUNT(*) FILTER (WHERE tani NOT IN ('UYUMLU','YETERSIZ_VERI')) AS anomali
            FROM truth_motor_kararlar
            WHERE sube_id=%s AND boyut=%s
              AND tarih >= %s::date - (%s || ' days')::interval
              AND tarih < %s::date
            """,
            (sube_id, boyut, tarih, gun, tarih),
        )
        row = dict(cur.fetchone() or {})
    except Exception as e:
        return {"katman": 2, "aktif": False, "hata": str(e)}
    toplam = int(row.get("toplam") or 0)
    anomali = int(row.get("anomali") or 0)
    if toplam < 5:
        return {"katman": 2, "aktif": False,
                "sebep": f"Yeterli geçmiş yok ({toplam} kayıt, min 5 gerekli)"}
    prior = anomali / toplam
    return {
        "katman": 2, "aktif": True,
        "gun": gun,
        "toplam_kayit": toplam,
        "anomali_sayisi": anomali,
        "prior_oran": round(prior, 3),
        "prior_yuzde": round(prior * 100, 1),
        "yorum": (
            f"Son {gun} günde {anomali}/{toplam} anomali (%{prior*100:.0f}) → "
            + ("Yüksek tekrarlama riski" if prior >= 0.4
               else "Orta risk" if prior >= 0.2
               else "Düşük geçmiş anomali")
        ),
        "guven_delta": 10.0 if prior >= 0.4 else 5.0 if prior >= 0.2 else 0.0,
    }


def _katman_3_sistematik_mi(
    cur, sube_id: str, boyut: str, tarih: str, karar: str, gun: int = 14,
) -> Dict[str, Any]:
    """Katman 3: Aynı tanı kaç gün ardışık tekrarlandı? 3+ = sistematik, 7+ = kronik."""
    if karar in ("UYUMLU", "YETERSIZ_VERI", "TRUTH_WALK_COZULMEDI"):
        return {"katman": 3, "aktif": False, "sebep": "Belirsiz karar — pattern aramaya değmez"}
    try:
        cur.execute(
            """
            SELECT tani FROM truth_motor_kararlar
            WHERE sube_id=%s AND boyut=%s
              AND tarih >= %s::date - (%s || ' days')::interval
              AND tarih < %s::date
            ORDER BY tarih DESC
            """,
            (sube_id, boyut, tarih, gun, tarih),
        )
        rows = [dict(r) for r in (cur.fetchall() or [])]
    except Exception as e:
        return {"katman": 3, "aktif": False, "hata": str(e)}
    if not rows:
        return {"katman": 3, "aktif": False, "sebep": "Geçmiş kayıt yok"}
    ardisik = 0
    for r in rows:
        if r["tani"] == karar:
            ardisik += 1
        else:
            break
    sistematik = ardisik >= 3
    cok_sistematik = ardisik >= 7
    return {
        "katman": 3, "aktif": True,
        "ardisik_gun": ardisik,
        "sistematik": sistematik,
        "cok_sistematik": cok_sistematik,
        "hedef_tani": karar,
        "yorum": (
            f"Aynı tanı ({karar}) {ardisik} gün ardışık → "
            + ("KRONİK DAVRANIŞ (7+ gün!)" if cok_sistematik
               else "Sistematik pattern (3+ gün)" if sistematik
               else "Tek seferlik — alışkanlık henüz oluşmamış")
        ),
        "guven_delta": 15.0 if cok_sistematik else 8.0 if sistematik else 0.0,
    }


def _katman_4_saat_daralma(
    cur, sube_id: str, tarih: str, boyut: str, karar: str,
) -> Dict[str, Any]:
    """Katman 4: KONTROL event'leri kullanarak anomali zaman penceresini daralt.
    ACILIS→KONTROL uyumlu, KONTROL→KAPANIS bozuk = anomali ikinci yarıda."""
    try:
        cur.execute(
            """
            SELECT tip, cevap_ts, kasa_sayim, meta, sira_no
            FROM sube_operasyon_event
            WHERE sube_id=%s AND tarih=%s::date AND durum='tamamlandi'
            ORDER BY cevap_ts NULLS LAST, sira_no
            """,
            (sube_id, tarih),
        )
        events = [dict(r) for r in (cur.fetchall() or [])]
    except Exception as e:
        return {"katman": 4, "aktif": False, "hata": str(e)}
    kontrol_events = [e for e in events if (e.get("tip") or "").startswith("KONTROL")]
    if not kontrol_events:
        return {
            "katman": 4, "aktif": False,
            "sebep": "O gün KONTROL event'i yok — daraltma yapılamadı",
            "oneri": "Günde en az 1 KONTROL tetikle (öğle saati): 8 saatlik pencere → 4 saat",
        }
    if boyut == "kasa":
        sayimlar = []
        for e in kontrol_events:
            ks = e.get("kasa_sayim")
            if ks is not None:
                sayimlar.append({
                    "tip": e["tip"],
                    "saat": str(e["cevap_ts"])[:16] if e.get("cevap_ts") else "",
                    "kasa": float(ks),
                })
        return {
            "katman": 4, "aktif": True, "boyut": "kasa",
            "kontrol_sayimlar": sayimlar,
            "kontrol_sayisi": len(kontrol_events),
            "yorum": (
                f"{len(kontrol_events)} ara kontrol var. "
                "Kasa sayımları karşılaştırılarak anomali penceresi daraltılır — "
                "kamera görüntüsünü o saate yoğunlaştır."
            ),
        }
    else:
        stoklar = []
        for e in kontrol_events:
            meta = _meta_oku(e.get("meta"))
            stok = _meta_boyut_topla(meta.get("kontrol_stok_sayim") or {}, boyut)
            stoklar.append({
                "tip": e["tip"],
                "saat": str(e["cevap_ts"])[:16] if e.get("cevap_ts") else "",
                "stok": stok,
            })
        return {
            "katman": 4, "aktif": True, "boyut": boyut,
            "kontrol_stoklar": stoklar,
            "kontrol_sayisi": len(kontrol_events),
            "yorum": (
                f"{len(kontrol_events)} ara kontrol var. "
                f"Stok: {[k['stok'] for k in stoklar]} → "
                "Hangi kontrol sonrası değer değiştiyse o pencereye odaklan."
            ),
        }


def _katman_5_baskin_dogrulama(cur, sube_id: str) -> Dict[str, Any]:
    """Katman 5: Son 7 günde kasa baskını sonucu var mı? Varsa motor bulgusuyla karşılaştır."""
    try:
        cur.execute(
            """
            SELECT id, baslatan_ts, durum, beklenen_tutar, gercek_tutar, notu
            FROM kasa_baskini
            WHERE sube_id=%s AND baslatan_ts >= NOW() - INTERVAL '7 days'
            ORDER BY baslatan_ts DESC
            LIMIT 5
            """,
            (sube_id,),
        )
        rows = [dict(r) for r in (cur.fetchall() or [])]
    except Exception as e:
        return {"katman": 5, "aktif": False, "hata": str(e)}
    if not rows:
        return {"katman": 5, "aktif": False, "sebep": "Son 7 günde baskın yok"}
    son = rows[0]
    gercek_fark = None
    if son.get("gercek_tutar") is not None and son.get("beklenen_tutar") is not None:
        gercek_fark = round(float(son["gercek_tutar"]) - float(son["beklenen_tutar"]), 2)
    return {
        "katman": 5, "aktif": True,
        "baskin_sayisi": len(rows),
        "son_baskin": {
            "id": str(son.get("id") or ""),
            "durum": son.get("durum"),
            "beklenen": float(son.get("beklenen_tutar") or 0),
            "gercek": float(son.get("gercek_tutar") or 0) if son.get("gercek_tutar") is not None else None,
            "fark": gercek_fark,
            "notu": son.get("notu"),
        },
        "yorum": (
            f"Son baskın ({son.get('durum')}): "
            + (f"Baskın farkı {gercek_fark:+.0f}₺ — DOĞRULANDI (açık gerçek)"
               if gercek_fark is not None and gercek_fark < -5
               else "Normal sayım çıktı" if gercek_fark is not None
               else "Sonuç henüz girilmemiş")
        ),
        "guven_delta": 15.0 if (gercek_fark is not None and gercek_fark < -5) else 0.0,
    }


def _katman_6_nlp_aciklama(
    karar: str, guven: float, boyut: str,
    aksamci_beyan: float, sabahci_beyan: float,
    beklenen_aksam: float, aksam_fark: float, sabah_fark_v1: float,
    k0_vardiya: Dict[str, Any],
    k1: Dict[str, Any], k2: Dict[str, Any], k3: Dict[str, Any],
    k4: Dict[str, Any], k5: Dict[str, Any],
) -> Dict[str, Any]:
    """Katman 6: Tüm katman bulgularını insan-okunabilir Türkçe anlatıya dönüştür."""
    BOYUT_TR = {
        "kasa": "kasa", "bardak_plastik": "plastik bardak",
        "bardak_karton": "karton bardak", "redbull_soda": "RedBull/soda",
        "pasta": "pasta dilimi",
    }
    KARAR_TR = {
        "AKSAMCI_HATALI": "akşamcı hatalı saydı",
        "SABAHCI_HATALI": "sabahcı hatalı saydı",
        "IKISI_DE_HATALI": "iki taraf da hatalı",
        "EVO_DESTEKLI_HIRSIZLIK": "kayıt dışı satış şüphesi",
        "IKRAM_DESTEKLI": "kayıtsız ikram şüphesi",
        "UYUMLU": "her şey uyumlu",
        "TRUTH_WALK_COZULMEDI": "kanıt zinciri yeterli değil",
    }
    boyut_tr = BOYUT_TR.get(boyut, boyut)
    karar_tr = KARAR_TR.get(karar, karar)
    parcalar = []
    if karar == "AKSAMCI_HATALI":
        parcalar.append(
            f"Dün akşam {boyut_tr} için akşamcı {aksamci_beyan:.0f} beyan etti, "
            f"matematik {beklenen_aksam:.0f} olmasını bekliyordu (fark {aksam_fark:+.0f})."
        )
    elif karar == "SABAHCI_HATALI":
        parcalar.append(
            f"Bugün sabah {boyut_tr} için sabahcı {sabahci_beyan:.0f} beyan etti, "
            f"matematik {aksamci_beyan:.0f} olmasını bekliyordu (fark {sabah_fark_v1:+.0f})."
        )
    elif karar == "EVO_DESTEKLI_HIRSIZLIK":
        parcalar.append(
            f"{boyut_tr} stoku beklenen kadar azalmadı ama "
            "Evo'da satış kaydı var — ürün dışarıdan karşılandı veya satış kasaya girmedi."
        )
    elif karar == "IKISI_DE_HATALI":
        parcalar.append(
            f"{boyut_tr} için hem akşamcı hem sabahcı türetilmiş değerden sapıyor — "
            "3. kişi sayımı zorunlu."
        )
    sorumlu_ad = None
    if k0_vardiya:
        tek = k0_vardiya.get("tek_basina_araliklari") or []
        coklu = k0_vardiya.get("coklu_araliklari") or []
        if tek:
            sorumlu_ad = tek[-1].get("personel_ad") or tek[-1].get("personel_id")
            parcalar.append(f"O günkü vardiyada tek personel ({sorumlu_ad}) kasa kontrolündeydi.")
        elif coklu and coklu[0].get("personeller"):
            isimler = ", ".join(p.get("ad") or p.get("id") for p in coklu[0]["personeller"])
            parcalar.append(f"Vardiyada birden fazla personel çalıştı ({isimler}) — sorumluluk paylaşımlı.")
    if k2.get("aktif") and k2.get("prior_yuzde", 0) >= 20:
        parcalar.append(
            f"Son {k2.get('gun', 30)} günde {boyut_tr} için %{k2['prior_yuzde']:.0f} anomali oranı var."
        )
    if k3.get("sistematik"):
        parcalar.append(
            f"Bu tanı {k3.get('ardisik_gun', 0)} gündür ardışık tekrarlanıyor — "
            + ("kronik alışkanlık." if k3.get("cok_sistematik") else "sistematik pattern.")
        )
    if k1.get("eslesme"):
        parcalar.append(
            f"Sayısal eşleşme: fark ₺{k1.get('fark', 0):.0f} ≈ "
            f"{k1.get('tahmini_adet', 0)} adet × ₺{k1.get('boyut_fiyat', 0):.0f} — kasıtlı miktar sinyali."
        )
    if k4.get("aktif") and k4.get("kontrol_sayisi", 0) > 0:
        parcalar.append(
            f"Gün içinde {k4['kontrol_sayisi']} ara kontrol anomali penceresini daraltabilir."
        )
    sb = (k5.get("son_baskin") or {}) if k5.get("aktif") else {}
    if sb.get("fark") is not None and sb["fark"] < -5:
        parcalar.append(f"Son baskın {sb['fark']:.0f}₺ açık ortaya koydu — motor bulgusuyla örtüşüyor.")
    guven_yorum = (
        "Çok yüksek güven" if guven >= 90 else
        "Yüksek güven" if guven >= 75 else
        "Orta güven — doğrulama gerekli" if guven >= 55 else
        "Düşük güven — ek veri gerekli"
    )
    anlatim = " ".join(parcalar) or f"Karar: {karar_tr}. Güven: %{guven:.0f}."
    return {
        "katman": 6, "aktif": True,
        "karar_tr": karar_tr,
        "guven_yorum": guven_yorum,
        "anlatim": anlatim,
        "sorumlu_ad": sorumlu_ad,
    }


def _katman_7_bayesian_konsensus(
    guven_base: float, karar: str,
    k1: Dict[str, Any], k2: Dict[str, Any],
    k3: Dict[str, Any], k5: Dict[str, Any],
) -> Dict[str, Any]:
    """Katman 7: Tüm kanıt katmanlarını Bayesian ağırlıklarla birleştir → final güven."""
    delta = 0.0
    parcalar = []
    if k1.get("eslesme"):
        delta += 12.0
        parcalar.append(f"K1+12 (sayısal eşleşme %{k1.get('uyum_yuzde', 0):.0f})")
    if k2.get("aktif"):
        prior = k2.get("prior_yuzde", 0.0)
        if prior >= 40:
            delta += 10.0; parcalar.append(f"K2+10 (geçmiş %{prior:.0f})")
        elif prior >= 20:
            delta += 5.0; parcalar.append(f"K2+5 (geçmiş %{prior:.0f})")
    if k3.get("cok_sistematik"):
        delta += 15.0; parcalar.append(f"K3+15 (kronik {k3.get('ardisik_gun', 0)} gün)")
    elif k3.get("sistematik"):
        delta += 8.0; parcalar.append(f"K3+8 (sistematik {k3.get('ardisik_gun', 0)} gün)")
    if k5.get("guven_delta", 0) > 0:
        delta += k5["guven_delta"]; parcalar.append(f"K5+{k5['guven_delta']:.0f} (baskın doğrulama)")
    if karar in ("TRUTH_WALK_COZULMEDI", "IKISI_DE_HATALI"):
        delta -= 10.0; parcalar.append("K7-10 (belirsiz karar)")
    final_guven = min(99.0, max(10.0, guven_base + delta))
    alarm = (
        "kritik" if final_guven >= 90 and karar in (
            "EVO_DESTEKLI_HIRSIZLIK", "AKSAMCI_HATALI", "SABAHCI_HATALI")
        else "yuksek" if final_guven >= 75
        else "orta" if final_guven >= 55
        else "dusuk"
    )
    return {
        "katman": 7, "aktif": True,
        "guven_base": round(guven_base, 1),
        "delta": round(delta, 1),
        "final_guven": round(final_guven, 1),
        "alarm_seviyesi": alarm,
        "kanit_parcalari": parcalar,
        "yorum": (
            f"Bayesian konsensus: {guven_base:.0f} + {delta:+.0f} = {final_guven:.0f}. "
            f"Alarm: {alarm.upper()}."
        ),
    }


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

    # ═══════════════════════════════════════════════════════════════════════
    # KATMAN 1-7 — GELİŞMİŞ ANALİZ KATMANLARI
    # Her katman bağımsız çalışır; hata atarsa try/except ile yutulur.
    # ═══════════════════════════════════════════════════════════════════════
    try:
        k1 = _katman_1_sayisal_korelasyon(boyut, aksam_fark, sabah_fark_v1)
    except Exception as _e:
        k1 = {"katman": 1, "aktif": False, "hata": str(_e)}
    try:
        k2 = _katman_2_bayesian_gecmis(cur, sube_id, boyut, tarih)
    except Exception as _e:
        k2 = {"katman": 2, "aktif": False, "hata": str(_e)}
    try:
        k3 = _katman_3_sistematik_mi(cur, sube_id, boyut, tarih, karar)
    except Exception as _e:
        k3 = {"katman": 3, "aktif": False, "hata": str(_e)}
    try:
        k4 = _katman_4_saat_daralma(cur, sube_id, tarih, boyut, karar)
    except Exception as _e:
        k4 = {"katman": 4, "aktif": False, "hata": str(_e)}
    try:
        k5 = _katman_5_baskin_dogrulama(cur, sube_id)
    except Exception as _e:
        k5 = {"katman": 5, "aktif": False, "hata": str(_e)}

    # Bayesian güven güncellemesi — K2 + K3 + K5 deltas Katman 0 sonrasına eklenir
    guven = min(99.0, max(10.0,
        guven
        + k2.get("guven_delta", 0.0)
        + k3.get("guven_delta", 0.0)
    ))

    try:
        k6 = _katman_6_nlp_aciklama(
            karar=karar, guven=guven, boyut=boyut,
            aksamci_beyan=aksamci_beyan, sabahci_beyan=sabahci_beyan,
            beklenen_aksam=beklenen_aksam, aksam_fark=aksam_fark,
            sabah_fark_v1=sabah_fark_v1,
            k0_vardiya=vardiya_dun,
            k1=k1, k2=k2, k3=k3, k4=k4, k5=k5,
        )
    except Exception as _e:
        k6 = {"katman": 6, "aktif": False, "hata": str(_e)}
    try:
        k7 = _katman_7_bayesian_konsensus(
            guven_base=guven, karar=karar, k1=k1, k2=k2, k3=k3, k5=k5,
        )
    except Exception as _e:
        k7 = {"katman": 7, "aktif": False, "hata": str(_e)}

    # Final güven K7 Bayesian konsensus'tan alınır
    guven = k7.get("final_guven", guven) if k7.get("aktif") else guven

    # NLP anlatımını özet'e ekle
    if k6.get("aktif") and k6.get("anlatim"):
        ozet = f"{ozet}\n\n💬 {k6['anlatim']}"

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
        # Katman 1-7 — gelişmiş analiz
        "katmanlar": {
            "k1_sayisal_korelasyon": k1,
            "k2_bayesian_gecmis": k2,
            "k3_sistematik": k3,
            "k4_saat_daralma": k4,
            "k5_baskin_dogrulama": k5,
            "k6_nlp_aciklama": k6,
            "k7_bayesian_konsensus": k7,
        },
        "alarm_seviyesi": k7.get("alarm_seviyesi") if k7.get("aktif") else "bilinmiyor",
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


# ════════════════════════════════════════════════════════════════════════════
#  PROAKTİF RİSK MOTORU — "Mini AI"
#  Sorunları tespit eder → etki alanını belirler → kuralları değerlendirir →
#  sistemi otomatik adapte eder (form alanı ekle, ek kontrol iste, CFO bildir).
#
#  Felsefe: "Ahmet riskli ise KONTROL formuna bardak sayımı alanı kendiliğinden
#            eklensin" — sistem riski bilerek fazladan veri toplar.
# ════════════════════════════════════════════════════════════════════════════

# ─── Kural tanımları (statik, genişletilebilir) ───────────────────────────
# koşul anahtarları → risk_haritasi() çıktısındaki alanlara karşılık gelir
# aksiyonlar → adaptif_ayar_oku() tarafından okunur, UI buna göre form değiştirir
RISK_KURALLARI: List[Dict] = [
    {
        "id":         "yuksek_risk_personel",
        "aciklama":   "Personel Bayesian risk skoru ≥ 70",
        "kosul":      {"personel_risk_min": 70},
        "aksiyonlar": {"bardak_sayim_iste": True, "ara_kontrol_sayisi": 2},
        "aciliyet":   "yuksek",
    },
    {
        "id":         "zimmet_gecmis",
        "aciklama":   "Geçmişte ZIMMET veya SWEETHEARTING tanısı var",
        "kosul":      {"tani_gecmis_icerir": ["ZIMMET_NAKIT_CEPTE", "SWEETHEARTING_SINYAL"]},
        "aksiyonlar": {"ucuncu_kisi_kapanis": True, "cfo_bildirim_shift_basi": True,
                       "bardak_sayim_iste": True},
        "aciliyet":   "kritik",
    },
    {
        "id":         "sistematik_stok_acik",
        "aciklama":   "3+ gün ardışık stok açığı tespit edildi",
        "kosul":      {"stok_acik_ardisik_min": 3},
        "aksiyonlar": {"kontrol_stok_sayim_iste": True, "bom_dogrulama_gunluk": True},
        "aciliyet":   "orta",
    },
    {
        "id":         "yuksek_sube_anomali",
        "aciklama":   "Şube genel anomali oranı ≥ %40",
        "kosul":      {"sube_anomali_oran_min": 40.0},
        "aksiyonlar": {"haftalik_baskin_planla": True, "ara_kontrol_sayisi": 2},
        "aciliyet":   "yuksek",
    },
    {
        "id":         "kapanış_riski",
        "aciklama":   "Kapanış vardiyası açığı gün içine 2× üstünde",
        "kosul":      {"kapanış_fark_oran_min": 2.0},
        "aksiyonlar": {"ucuncu_kisi_kapanis": True, "cfo_bildirim_shift_basi": True},
        "aciliyet":   "yuksek",
    },
    {
        "id":         "kasa_acik_kritik",
        "aciklama":   "Son kasa farkı ≥ ₺200 açık",
        "kosul":      {"kasa_acik_tl_min": 200.0},
        "aksiyonlar": {"cfo_bildirim_shift_basi": True, "baskin_onerisi": True},
        "aciliyet":   "kritik",
    },
    {
        "id":         "dusuk_risk_normal",
        "aciklama":   "Tüm sinyaller normal — ekstra kontrol yok",
        "kosul":      {"personel_risk_max": 30, "sube_anomali_oran_max": 15.0},
        "aksiyonlar": {},
        "aciliyet":   "dusuk",
    },
]

# Anomali tipi → etkilenen sistemler / yayılma / kamera
_ETKI_MATRISI: Dict[str, Dict] = {
    "SWEETHEARTING_ZIMMET":  {"yayilim": "yuksek",  "sistemler": ["kasa", "stok", "personel"], "kamera": True,  "diger_gun": True},
    "ZIMMET_NAKIT_CEPTE":    {"yayilim": "kritik",  "sistemler": ["kasa", "personel"],           "kamera": True,  "diger_gun": True},
    "NAKIT_CEKILDI":         {"yayilim": "yuksek",  "sistemler": ["kasa", "evo"],                "kamera": True,  "diger_gun": True},
    "AKSAM_ZIMMET_POZISYON": {"yayilim": "yuksek",  "sistemler": ["kasa", "personel"],           "kamera": True,  "diger_gun": True},
    "POS_FANTOM_SATIS":      {"yayilim": "orta",    "sistemler": ["evo", "pos"],                 "kamera": False, "diger_gun": False},
    "KAYITSIZ_IKRAM_FIRE":   {"yayilim": "dusuk",   "sistemler": ["stok", "ikram"],              "kamera": False, "diger_gun": False},
    "STOK_ACIK":             {"yayilim": "orta",    "sistemler": ["stok", "urun_ac"],             "kamera": False, "diger_gun": False},
    "STOK_FAZLA":            {"yayilim": "dusuk",   "sistemler": ["stok", "evo"],                "kamera": False, "diger_gun": False},
    "BELIRSIZ":              {"yayilim": "dusuk",   "sistemler": [],                              "kamera": False, "diger_gun": False},
}

_AKSIYON_ACIKLAMA: Dict[str, str] = {
    "bardak_sayim_iste":      "Bu personelin vardiyasında kasa + bardak sayımı isteyin",
    "ara_kontrol_sayisi":     "{deger}x ara KONTROL planlayın (normalde 1)",
    "ucuncu_kisi_kapanis":    "Kapanış sayımına 3. kişi (müdür/CFO) dahil edin",
    "cfo_bildirim_shift_basi":"Vardiya başında CFO'ya otomatik bildirim gönderin",
    "bom_dogrulama_gunluk":   "Günlük BOM reçete varyansı otomatik çalışsın",
    "kontrol_stok_sayim_iste":"KONTROL event formuna stok sayımı alanı ekleyin",
    "haftalik_baskin_planla": "Haftalık periyodik Kasa Baskını planlayın",
    "baskin_onerisi":         "Kasa Baskını başlatın — açık kritik eşiği aştı",
    "kamera_incele":          "Kamera görüntüsü inceleyin — anomali saatine odaklanın",
}

_ADAPTIF_AYAR_DDL = """
CREATE TABLE IF NOT EXISTS truth_motor_adaptif_ayar (
    id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    sube_id           TEXT NOT NULL,
    personel_id       TEXT,
    gecerli_baslangic DATE NOT NULL DEFAULT CURRENT_DATE,
    gecerli_bitis     DATE,
    ayar_json         JSONB NOT NULL DEFAULT '{}',
    sebep             TEXT,
    tetikleyen_kural  TEXT,
    olusturan         TEXT DEFAULT 'truth_motor_otomatik',
    olusturma         TIMESTAMPTZ DEFAULT NOW()
)
"""


def _kural_tetiklendi_mi(kural: Dict, harita: Dict) -> bool:
    """Kuralın kosul bloğunu harita verisine göre değerlendir."""
    k = kural.get("kosul") or {}
    if "personel_risk_min" in k and harita.get("personel_risk", 0) < k["personel_risk_min"]:
        return False
    if "personel_risk_max" in k and harita.get("personel_risk", 100) > k["personel_risk_max"]:
        return False
    if "tani_gecmis_icerir" in k:
        gecmis = harita.get("personel_tani_gecmis") or []
        if not any(t in gecmis for t in k["tani_gecmis_icerir"]):
            return False
    if "stok_acik_ardisik_min" in k and harita.get("stok_acik_ardisik", 0) < k["stok_acik_ardisik_min"]:
        return False
    if "sube_anomali_oran_min" in k and harita.get("sube_anomali_oran", 0) < k["sube_anomali_oran_min"]:
        return False
    if "sube_anomali_oran_max" in k and harita.get("sube_anomali_oran", 100) > k["sube_anomali_oran_max"]:
        return False
    if "kapanış_fark_oran_min" in k and harita.get("kapanış_fark_orani", 0) < k["kapanış_fark_oran_min"]:
        return False
    if "kasa_acik_tl_min" in k and abs(harita.get("kasa_acik_en_son", 0)) < k["kasa_acik_tl_min"]:
        return False
    return True


def risk_haritasi(cur, sube_id: str, tarih: str,
                   personel_id: Optional[str] = None) -> Dict[str, Any]:
    """Mevcut context için risk puanı haritası — tüm sinyal kaynakları tek objede.

    Bileşenler:
      personel_risk        : Welford profil risk_skoru (0-100)
      personel_tani_gecmis : son 30 gün tanı türleri
      sube_anomali_oran    : şube genel anomali yüzdesi
      kapanış_fark_orani   : kapanış vardiyası / gün içi fark oranı
      stok_acik_ardisik    : kaç gündür ardışık stok açığı
      kasa_acik_en_son     : en son kasa farkı (₺)
    """
    harita: Dict[str, Any] = {
        "sube_id": sube_id, "tarih": tarih, "personel_id": personel_id,
        "personel_risk": 50.0,
        "personel_tani_gecmis": [],
        "sube_anomali_oran": 0.0,
        "kapanış_fark_orani": 1.0,
        "stok_acik_ardisik": 0,
        "kasa_acik_en_son": 0.0,
    }

    if personel_id:
        profil = ogrenme_profili_oku(cur, personel_id, sube_id)
        if profil.get("var_mi"):
            harita["personel_risk"] = float(profil.get("risk_skoru") or 50)

    try:
        cur.execute(
            """
            SELECT COUNT(*) FILTER (WHERE tani NOT IN ('UYUMLU','YETERSIZ_VERI')) AS anomali,
                   COUNT(*) AS toplam
            FROM truth_motor_kararlar
            WHERE sube_id=%s AND olusturma >= NOW() - INTERVAL '30 days'
            """,
            (sube_id,),
        )
        r = dict(cur.fetchone() or {})
        if int(r.get("toplam") or 0) > 0:
            harita["sube_anomali_oran"] = round(
                int(r.get("anomali") or 0) / int(r["toplam"]) * 100, 1
            )
    except Exception:
        pass

    try:
        cur.execute(
            """
            SELECT DISTINCT tani FROM truth_motor_kararlar
            WHERE sube_id=%s
              AND olusturma >= NOW() - INTERVAL '30 days'
              AND tani NOT IN ('UYUMLU','YETERSIZ_VERI')
            LIMIT 20
            """,
            (sube_id,),
        )
        harita["personel_tani_gecmis"] = [dict(r)["tani"] for r in (cur.fetchall() or [])]
    except Exception:
        pass

    try:
        ef = end_of_shift_effect(cur, gun=14, sube_id=sube_id)
        harita["kapanış_fark_orani"] = float(ef.get("aksam_gun_orani") or 1.0)
    except Exception:
        pass

    try:
        cur.execute(
            """
            SELECT COUNT(DISTINCT tarih) AS n FROM truth_motor_kararlar
            WHERE sube_id=%s AND boyut != 'kasa'
              AND tani = 'STOK_ACIK'
              AND tarih >= CURRENT_DATE - INTERVAL '14 days'
            """,
            (sube_id,),
        )
        r = dict(cur.fetchone() or {})
        harita["stok_acik_ardisik"] = int(r.get("n") or 0)
    except Exception:
        pass

    try:
        cur.execute(
            """
            SELECT COALESCE(fark_n1_n2, 0) AS f FROM truth_motor_kararlar
            WHERE sube_id=%s AND boyut='kasa' AND tarih < %s::date
            ORDER BY tarih DESC LIMIT 1
            """,
            (sube_id, tarih),
        )
        r = cur.fetchone()
        if r:
            harita["kasa_acik_en_son"] = float(dict(r).get("f") or 0)
    except Exception:
        pass

    return harita


def etki_alani_analiz(cur, sube_id: str, tarih: str,
                       anomali_tipi: str,
                       etkilenen_boyutlar: Optional[List[str]] = None) -> Dict[str, Any]:
    """Bir anomalinin yayılma alanı: hangi sistemler, kaç gün, kaç şube, tekrar sayısı."""
    bilgi = _ETKI_MATRISI.get(anomali_tipi, _ETKI_MATRISI["BELIRSIZ"])

    tekrar_sayisi = 0
    try:
        cur.execute(
            """
            SELECT COUNT(*) AS n FROM truth_motor_kararlar
            WHERE sube_id=%s AND tani=%s
              AND olusturma >= NOW() - INTERVAL '30 days'
            """,
            (sube_id, anomali_tipi),
        )
        tekrar_sayisi = int(dict(cur.fetchone() or {}).get("n") or 0)
    except Exception:
        pass

    diger_sube_sayisi = 0
    try:
        cur.execute(
            """
            SELECT COUNT(DISTINCT sube_id) AS n FROM truth_motor_kararlar
            WHERE tani=%s AND tarih=%s::date AND sube_id != %s
            """,
            (anomali_tipi, tarih, sube_id),
        )
        diger_sube_sayisi = int(dict(cur.fetchone() or {}).get("n") or 0)
    except Exception:
        pass

    sistemik = diger_sube_sayisi >= 2
    yayilim = "sistemik" if sistemik else bilgi["yayilim"]

    oneri_listesi = []
    if bilgi["kamera"]:
        oneri_listesi.append("Kamera görüntüsü inceleyin — anomali saatine odaklanın")
    if sistemik:
        oneri_listesi.append(f"{diger_sube_sayisi} şubede aynı anda → Evo/POS sync hatası olabilir, IT'ye danışın")
    if tekrar_sayisi >= 3:
        oneri_listesi.append(f"Son 30 günde {tekrar_sayisi}. tekrar → sistematik, soruşturma başlatın")
    if bilgi["diger_gun"]:
        oneri_listesi.append("Bu anomali tipi geçmiş günleri de etkileyebilir — trend analizi yapın")

    return {
        "anomali_tipi": anomali_tipi,
        "etkilenen_sistemler": bilgi["sistemler"],
        "etkilenen_boyutlar": etkilenen_boyutlar or [],
        "risk_yayilimi": yayilim,
        "kamera_gerekli": bilgi["kamera"],
        "diger_gunler_etkilenir": bilgi["diger_gun"],
        "tekrar_sayisi_30gun": tekrar_sayisi,
        "diger_sube_sayisi": diger_sube_sayisi,
        "sistemik_risk": sistemik,
        "oneriler": oneri_listesi,
        "yorum": (
            f"SİSTEMİK: {diger_sube_sayisi} şubede aynı anomali!" if sistemik
            else f"Son 30 günde {tekrar_sayisi}. tekrar" if tekrar_sayisi > 0
            else "İlk tespit"
        ),
    }


def onlem_plani_uret(harita: Dict,
                      etki: Optional[Dict] = None) -> Dict[str, Any]:
    """Kural motoru: risk haritası + etki alanı → aksiyon listesi + adaptif ayarlar."""
    tetiklenen_aksiyonlar: Dict[str, Any] = {}
    tetiklenen_kurallar: List[str] = []
    onlemler: List[Dict] = []

    for kural in RISK_KURALLARI:
        if _kural_tetiklendi_mi(kural, harita):
            tetiklenen_kurallar.append(kural["id"])
            for ak, deger in (kural.get("aksiyonlar") or {}).items():
                if isinstance(deger, bool):
                    tetiklenen_aksiyonlar[ak] = tetiklenen_aksiyonlar.get(ak, False) or deger
                elif isinstance(deger, (int, float)):
                    tetiklenen_aksiyonlar[ak] = max(
                        tetiklenen_aksiyonlar.get(ak, deger), deger
                    )

    # Etki alanından ek aksiyonlar
    if etki:
        if etki.get("kamera_gerekli"):
            tetiklenen_aksiyonlar["kamera_incele"] = True
        if etki.get("sistemik_risk"):
            onlemler.append({
                "aksiyon_kodu": "sistemik_uyari",
                "tip": "SİSTEMİK_UYARI",
                "aciklama": etki.get("yorum", ""),
                "deger": True,
                "aciliyet": "kritik",
            })

    # Aksiyonları okunabilir önlem listesine çevir
    for ak, deger in tetiklenen_aksiyonlar.items():
        if not deger:
            continue
        aciklama_sablonu = _AKSIYON_ACIKLAMA.get(ak, ak)
        aciklama = aciklama_sablonu.format(deger=deger)
        # Aciliyet — kural listesinden en yüksek
        aciliyet = "orta"
        for kural in RISK_KURALLARI:
            if kural["id"] in tetiklenen_kurallar and ak in (kural.get("aksiyonlar") or {}):
                kural_aciliyet = kural.get("aciliyet", "orta")
                if {"kritik": 0, "yuksek": 1, "orta": 2, "dusuk": 3}.get(kural_aciliyet, 2) < \
                   {"kritik": 0, "yuksek": 1, "orta": 2, "dusuk": 3}.get(aciliyet, 2):
                    aciliyet = kural_aciliyet
        onlemler.append({
            "aksiyon_kodu": ak,
            "tip": ak.upper(),
            "aciklama": aciklama,
            "deger": deger,
            "aciliyet": aciliyet,
        })

    onlemler.sort(key=lambda x: {"kritik": 0, "yuksek": 1, "orta": 2, "dusuk": 3}.get(x["aciliyet"], 4))

    return {
        "tetiklenen_kurallar": tetiklenen_kurallar,
        "adaptif_ayarlar": tetiklenen_aksiyonlar,
        "onlemler": onlemler,
    }


def adaptif_ayar_guncelle(cur, sube_id: str,
                            personel_id: Optional[str],
                            ayarlar: Dict[str, Any],
                            sebep: str = "",
                            tetikleyen_kural: str = "") -> Dict:
    """Sistem davranış ayarını güncelle — sonraki forma/event'e yansır.

    7 gün geçerli olarak kaydedilir; sube_panel.html her KONTROL/KAPANIS
    öncesinde adaptif_ayar_oku() ile kontrol eder.
    """
    try:
        cur.execute(_ADAPTIF_AYAR_DDL)
        cur.execute(
            """
            INSERT INTO truth_motor_adaptif_ayar
                (sube_id, personel_id, gecerli_baslangic, gecerli_bitis,
                 ayar_json, sebep, tetikleyen_kural)
            VALUES (%s, %s, CURRENT_DATE, CURRENT_DATE + INTERVAL '7 days',
                    %s::jsonb, %s, %s)
            RETURNING id
            """,
            (
                sube_id, personel_id,
                json.dumps(ayarlar, ensure_ascii=False, default=str),
                sebep[:500] if sebep else "",
                tetikleyen_kural[:200] if tetikleyen_kural else "",
            ),
        )
        r = cur.fetchone()
        return {"kaydedildi": True, "id": str(dict(r or {}).get("id") or "")}
    except Exception as e:
        log.warning("adaptif_ayar_guncelle hata: %s", e)
        return {"kaydedildi": False, "hata": str(e)}


def adaptif_ayar_oku(cur, sube_id: str,
                      personel_id: Optional[str] = None) -> Dict[str, Any]:
    """Bu şube/personel için aktif adaptif ayarları oku.

    Şube geneli + personel özel ayarlar birleştirilir (personel özel > şube geneli).
    sube_panel.html her KONTROL/KAPANIS formunu açmadan önce bunu çağırır;
    dönen ayarlara göre formu dinamik olarak genişletir.
    """
    try:
        cur.execute(_ADAPTIF_AYAR_DDL)
        if personel_id:
            cur.execute(
                """
                SELECT ayar_json, sebep, personel_id
                FROM truth_motor_adaptif_ayar
                WHERE sube_id=%s
                  AND (personel_id IS NULL OR personel_id=%s)
                  AND gecerli_baslangic <= CURRENT_DATE
                  AND (gecerli_bitis IS NULL OR gecerli_bitis >= CURRENT_DATE)
                ORDER BY personel_id DESC NULLS LAST, olusturma DESC
                """,
                (sube_id, personel_id),
            )
        else:
            cur.execute(
                """
                SELECT ayar_json, sebep, personel_id
                FROM truth_motor_adaptif_ayar
                WHERE sube_id=%s AND personel_id IS NULL
                  AND gecerli_baslangic <= CURRENT_DATE
                  AND (gecerli_bitis IS NULL OR gecerli_bitis >= CURRENT_DATE)
                ORDER BY olusturma DESC
                """,
                (sube_id,),
            )
        rows = [dict(r) for r in (cur.fetchall() or [])]
    except Exception as e:
        return {"aktif": False, "hata": str(e), "ayarlar": {}}

    if not rows:
        return {"aktif": False, "ayarlar": {}, "aciklamalar": []}

    birlesik: Dict[str, Any] = {}
    for r in rows:
        ayar = r.get("ayar_json") or {}
        if isinstance(ayar, str):
            try:
                ayar = json.loads(ayar)
            except Exception:
                ayar = {}
        for k, v in ayar.items():
            if isinstance(v, bool):
                birlesik[k] = birlesik.get(k, False) or v
            elif isinstance(v, (int, float)):
                birlesik[k] = max(birlesik.get(k, v), v)
            else:
                birlesik[k] = v

    return {
        "aktif": bool(birlesik),
        "ayarlar": birlesik,
        "kayit_sayisi": len(rows),
        "aciklamalar": [r["sebep"] for r in rows if r.get("sebep")],
        "yorum": _adaptif_ayar_yorumla(birlesik),
    }


def _adaptif_ayar_yorumla(ayarlar: Dict) -> str:
    """Adaptif ayar dict'ini insan-okunabilir tek cümleye çevir."""
    if not ayarlar:
        return "Ekstra kontrol yok"
    yorumlar = []
    if ayarlar.get("bardak_sayim_iste"):
        yorumlar.append("bardak sayımı iste")
    n_kontrol = ayarlar.get("ara_kontrol_sayisi")
    if n_kontrol and n_kontrol > 1:
        yorumlar.append(f"{n_kontrol}x ara kontrol")
    if ayarlar.get("ucuncu_kisi_kapanis"):
        yorumlar.append("3. kişi kapanış")
    if ayarlar.get("cfo_bildirim_shift_basi"):
        yorumlar.append("CFO bildirim")
    if ayarlar.get("kontrol_stok_sayim_iste"):
        yorumlar.append("stok sayım ekle")
    if ayarlar.get("haftalik_baskin_planla"):
        yorumlar.append("haftalık baskın")
    if ayarlar.get("baskin_onerisi"):
        yorumlar.append("🔴 BASKIN ÖNERİSİ")
    return "Aktif: " + ", ".join(yorumlar) if yorumlar else "Pasif ayar"


def proaktif_denetim(cur, sube_id: str, tarih: str,
                      personel_id: Optional[str] = None,
                      ogrenme_aktif: bool = False) -> Dict[str, Any]:
    """Ana proaktif denetim — mini AI tek giriş noktası.

    Sıra:
      1. tam_analiz       → bugünün durumu (kasa + stok + kök neden)
      2. risk_haritasi    → tüm sinyal kaynakları tek haritada
      3. etki_alani_analiz→ anomali yayılma alanı + sistemik test
      4. onlem_plani_uret → kural motoru → aksiyon listesi
      5. adaptif_ayar_guncelle → yarın için sistem davranışını kaydet
      6. adaptif_ayar_oku → mevcut aktif ayarları döndür

    ogrenme_aktif=True → Welford profil güncellemesi de çalışır.
    """
    # 1. Tam analiz
    try:
        analiz = tam_analiz(cur, sube_id, tarih, ogrenme_aktif=ogrenme_aktif)
    except Exception as e:
        log.warning("proaktif_denetim tam_analiz hata: %s", e)
        analiz = {"alarm_seviyesi": "bilinmiyor", "ozet": str(e),
                  "kok_nedenler": [], "stok_ozet": {}, "kasa_ozet": {}}

    # 2. Risk haritası
    try:
        harita = risk_haritasi(cur, sube_id, tarih, personel_id=personel_id)
    except Exception as e:
        log.warning("proaktif_denetim risk_haritasi hata: %s", e)
        harita = {"personel_risk": 50.0, "sube_anomali_oran": 0.0,
                  "kapanış_fark_orani": 1.0, "stok_acik_ardisik": 0,
                  "kasa_acik_en_son": 0.0, "personel_tani_gecmis": []}

    # 3. Etki alanı — birincil anomali
    kok_nedenler = analiz.get("kok_nedenler") or []
    birincil_anomali = kok_nedenler[0].get("tip", "BELIRSIZ") if kok_nedenler else "BELIRSIZ"
    stok_aciklar = list((analiz.get("stok_ozet") or {}).get("aciklar", {}).keys())
    try:
        etki = etki_alani_analiz(cur, sube_id, tarih, birincil_anomali, stok_aciklar)
    except Exception as e:
        log.warning("proaktif_denetim etki_alani hata: %s", e)
        etki = {"anomali_tipi": birincil_anomali, "sistemik_risk": False,
                "etkilenen_sistemler": [], "oneriler": []}

    # 4. Önlem planı
    try:
        plan = onlem_plani_uret(harita, etki)
    except Exception as e:
        log.warning("proaktif_denetim onlem_plani hata: %s", e)
        plan = {"tetiklenen_kurallar": [], "adaptif_ayarlar": {}, "onlemler": []}

    # 5. Adaptif ayarı kaydet (risk varsa)
    adaptif = plan.get("adaptif_ayarlar") or {}
    ayar_kaydedildi = {}
    if any(v for v in adaptif.values()):
        sebep = (
            f"Proaktif [{', '.join(plan.get('tetiklenen_kurallar') or [])}] "
            f"→ {birincil_anomali} — tarih {tarih}"
        )
        try:
            ayar_kaydedildi = adaptif_ayar_guncelle(
                cur, sube_id, personel_id, adaptif,
                sebep=sebep,
                tetikleyen_kural=";".join(plan.get("tetiklenen_kurallar") or []),
            )
        except Exception as e:
            ayar_kaydedildi = {"kaydedildi": False, "hata": str(e)}

    # 6. Mevcut aktif ayarlar
    try:
        aktif_ayarlar = adaptif_ayar_oku(cur, sube_id, personel_id=personel_id)
    except Exception as e:
        aktif_ayarlar = {"aktif": False, "hata": str(e)}

    # 7. Proaktif alarm seviyesi
    onlemler = plan.get("onlemler") or []
    ac_seviyeler = {o.get("aciliyet") for o in onlemler}
    proaktif_alarm = (
        "kritik" if "kritik" in ac_seviyeler
        else "yuksek" if "yuksek" in ac_seviyeler
        else "orta" if "orta" in ac_seviyeler
        else "dusuk"
    )

    # 8. Personel bazlı özet mesaj
    en_riskli_personel = None
    personel_listesi = analiz.get("personel_sorumlu") or []
    if personel_listesi and personel_listesi[0].get("risk_seviye") != "normal":
        ep = personel_listesi[0]
        en_riskli_personel = {
            "ad": ep.get("ad"),
            "risk_seviye": ep.get("risk_seviye"),
            "kasa_fark_ort": ep.get("kasa_fark_ort"),
            "anomali_oran": ep.get("anomali_oran_yuzde"),
            "aktif_ayarlar": aktif_ayarlar.get("ayarlar"),
            "yorum": aktif_ayarlar.get("yorum"),
        }

    log.info("proaktif_denetim sube=%s tarih=%s alarm=%s kurallar=%s",
             sube_id, tarih, proaktif_alarm, plan.get("tetiklenen_kurallar"))

    # Proaktif yorum — onlemler dahil daha zengin metin
    stok_aciklar_map = dict(analiz.get("stok_ozet", {}).get("aciklar") or {})
    personel_sorumlu_liste = analiz.get("personel_sorumlu") or []
    kok_nedenler_liste = analiz.get("kok_nedenler") or []
    proaktif_yorum = _yorum_uret(
        alarm=proaktif_alarm,
        kasa_fark=float((analiz.get("kasa_ozet") or {}).get("toplam_fark") or 0),
        stok_aciklar=stok_aciklar_map,
        kok_nedenler=kok_nedenler_liste,
        personel_sorumlu=personel_sorumlu_liste,
        onlemler=onlemler,
        tarih=tarih,
    )

    return {
        "sube_id": sube_id,
        "tarih": tarih,
        "personel_id": personel_id,
        "proaktif_alarm": proaktif_alarm,
        "yorum_metni": proaktif_yorum,       # ← insan-okunabilir rapor
        # Bugünün özeti
        "bugun": {
            "alarm": analiz.get("alarm_seviyesi"),
            "ozet": analiz.get("ozet"),
            "kasa_fark": (analiz.get("kasa_ozet") or {}).get("toplam_fark"),
            "stok_acik_sayisi": (analiz.get("stok_ozet") or {}).get("acik_boyut_sayisi"),
            "kok_neden": birincil_anomali,
        },
        # Risk haritası
        "risk_haritasi": harita,
        # Etki alanı
        "etki_alani": etki,
        # Önlemler (kural motoru çıktısı)
        "tetiklenen_kurallar": plan.get("tetiklenen_kurallar") or [],
        "onlemler": onlemler,
        # Adaptif sistem ayarları
        "adaptif": {
            "yeni_ayarlar": adaptif,
            "kaydedildi": ayar_kaydedildi,
            "aktif_ayarlar": aktif_ayarlar,
        },
        # En riskli personel özeti
        "en_riskli_personel": en_riskli_personel,
        # Ham veriler
        "tam_analiz_sonucu": analiz,
    }


# TAM ANALİZ — KAPSAMLI MOTOR
#  Kasa Akışı + Stok Akışı + Personel Sorumluluk + Kök Neden + Öğrenme
# ════════════════════════════════════════════════════════════════════════════
# Felsefe: Her ₺ ve her ürün birimi izlenir. Bir açık oluştuğunda "kim,
# ne zaman, neden" sorusu matematiksel kanıtla yanıtlanır.
# Öğrenme: Her personelin "tipik sapması" Welford online algoritmasıyla
# öğrenilir; sapma tarihsel norma göre değerlendirilir.
# ════════════════════════════════════════════════════════════════════════════

_FIRE_TABLOLAR = ("fire_kayit", "fire_kayitlari", "stok_fire")

ORT_FIYAT_MAP = {
    "bardak_plastik": 50.0,
    "bardak_karton":  60.0,
    "redbull_soda":   45.0,
    "pasta":          90.0,
}


def _fire_sorgula(cur, sube_id: str, tarih: str) -> Dict[str, float]:
    """Fire/waste kayıtlarını sorgula. Tablo yoksa {} döner.
    Alternatif: anlik_giderler'de fire/ziyan/bozulma kategorisi."""
    for tablo in _FIRE_TABLOLAR:
        try:
            cur.execute(
                f"SELECT * FROM {tablo} WHERE sube_id=%s AND tarih=%s::date",
                (sube_id, tarih),
            )
            rows = [dict(r) for r in (cur.fetchall() or [])]
            if rows:
                fire: Dict[str, float] = {}
                for r in rows:
                    for boyut in BOYUTLAR:
                        v = r.get(boyut) or r.get(f"{boyut}_adet") or r.get(f"{boyut}_fire")
                        if v is not None:
                            try:
                                fire[boyut] = fire.get(boyut, 0) + float(v)
                            except (TypeError, ValueError):
                                pass
                return fire
        except Exception:
            continue
    try:
        cur.execute(
            """
            SELECT kategori, COALESCE(tutar, 0) AS tutar
            FROM anlik_giderler
            WHERE sube=%s AND tarih=%s::date
              AND LOWER(TRIM(COALESCE(kategori,''))) IN
                  ('fire','fire_kayip','ziyan','bozulma','hurda','stok_fire')
            """,
            (sube_id, tarih),
        )
        rows = [dict(r) for r in (cur.fetchall() or [])]
        if rows:
            return {"_nakit_degeri": sum(float(r["tutar"] or 0) for r in rows)}
    except Exception:
        pass
    return {}


# ════════════════════════════════════════════════════════════════════════════
#  SPRINT E — İKRAM vs ZİMMET AYIRIM SİNYALLERİ
#  Signal 1: Fire Bildirim Çapraz  → sube_fire_bildirim tablosu
#  Signal 2: Evo İptal Çapraz      → sahte iptal + para cepde
#  Signal 3: Satış Velocity Analiz → yoğunluk bağlamı
#
#  Motor akışı:
#    Stok açığı tespit
#      → fire_bildirim_capraz():  fire kayıt var? → BELGELENMIS (bitti)
#      → evo_iptal_capraz():      iptal ≈ fark?   → ZIMMET_IPTAL_MANIPULASYON
#      → satis_velocity_analiz(): bağlam detay eklenir (tanı değişmez)
# ════════════════════════════════════════════════════════════════════════════

def fire_bildirim_capraz(cur, sube_id: str, tarih: str,
                         stok_aciklar: Optional[Dict[str, float]] = None
                         ) -> Dict[str, Any]:
    """Signal 1 — sube_fire_bildirim tablosunu sorgula.

    Aynı şube + tarih için fire kaydı bulunursa anomali BELGELENMIS sayılır
    ve zimmet araştırması gerekmez.  Kayıt yoksa Signal 2/3'e devam edilir.

    Args:
        stok_aciklar: {boyut → açık_adet} — boyut eşleşmesi için opsiyonel.

    Returns:
        {
          "fire_kayit_var": bool,
          "kayit_sayisi": int,
          "toplam_adet": int,
          "sebep_dagilimi": {"iade": 2, "skt_bozulma": 1, ...},
          "iade_var": bool,
          "belgelenmis": bool,
          "kayitlar": [...],
        }
    """
    sonuc: Dict[str, Any] = {
        "fire_kayit_var": False,
        "kayit_sayisi": 0,
        "toplam_adet": 0,
        "sebep_dagilimi": {},
        "iade_var": False,
        "belgelenmis": False,
        "kayitlar": [],
    }
    try:
        cur.execute(
            """
            SELECT id, sebep_kodu, sebep_label, aciklama,
                   kalemler, toplam_adet, fis_no, iade_zaman
            FROM sube_fire_bildirim
            WHERE sube_id=%s AND tarih=%s::date
            ORDER BY olusturma
            """,
            (sube_id, tarih),
        )
        rows = [dict(r) for r in (cur.fetchall() or [])]
    except Exception as e:
        log.warning("fire_bildirim_capraz sorgu hata: %s", e)
        return sonuc

    if not rows:
        return sonuc

    sonuc["fire_kayit_var"] = True
    sonuc["kayit_sayisi"] = len(rows)

    sebep_dagil: Dict[str, int] = {}
    toplam_adet = 0
    for r in rows:
        sk = r.get("sebep_kodu") or "diger"
        sebep_dagil[sk] = sebep_dagil.get(sk, 0) + 1
        try:
            toplam_adet += int(r.get("toplam_adet") or 0)
        except (TypeError, ValueError):
            pass
        sonuc["kayitlar"].append({
            "id":          r.get("id"),
            "sebep":       sk,
            "label":       r.get("sebep_label"),
            "aciklama":    r.get("aciklama"),
            "toplam_adet": r.get("toplam_adet"),
            "fis_no":      r.get("fis_no"),
            "iade_zaman":  str(r.get("iade_zaman") or ""),
        })

    sonuc["toplam_adet"] = toplam_adet
    sonuc["sebep_dagilimi"] = sebep_dagil
    sonuc["iade_var"] = bool(
        sebep_dagil.get("iade") or sebep_dagil.get("siparis_iptali")
    )

    # Belgelenmis mi? — fire adet vs stok açığı kıyaslama
    if stok_aciklar:
        # kalemler JSONB'den boyut bazlı adet topla
        fire_boyut: Dict[str, float] = {}
        for r in rows:
            kl = r.get("kalemler")
            if isinstance(kl, str):
                try:
                    kl = json.loads(kl)
                except Exception:
                    kl = []
            if isinstance(kl, list):
                for item in kl:
                    if not isinstance(item, dict):
                        continue
                    urun_ad = (item.get("urun") or item.get("ad") or "").lower()
                    adet = float(item.get("adet") or 0)
                    for boyut in BOYUTLAR:
                        if boyut[:5] in urun_ad or boyut in urun_ad:
                            fire_boyut[boyut] = fire_boyut.get(boyut, 0) + adet
                            break
        if fire_boyut:
            eslesen = sum(
                1 for boyut, acik in stok_aciklar.items()
                if fire_boyut.get(boyut, 0) >= abs(acik) * 0.8   # %80 tolerans
            )
            sonuc["belgelenmis"] = eslesen > 0
        else:
            # boyut eşleşemedi ama kayıt var → belgelenmis say
            sonuc["belgelenmis"] = True
    else:
        sonuc["belgelenmis"] = sonuc["fire_kayit_var"]

    return sonuc


def evo_iptal_capraz(cur, sube_id: str, tarih: str,
                     kasa_fark: Optional[float] = None) -> Dict[str, Any]:
    """Signal 2 — Evo iptal/void tutarı ile kasa farkını kıyasla.

    Sahte iptal senaryosu:
      Ürün verildi + ödeme alındı → Evo'ya iptal girildi → para cepde kaldı.
    Tespit: kasa açığı ≈ iptal tutarı (≥%70 eşleşme).

    Returns:
        {
          "iptal_toplam": float,
          "kasa_fark": float,
          "eslesme_yuzdesi": float,
          "zimmet_sinyali": bool,
          "yorum": str,
        }
    """
    sonuc: Dict[str, Any] = {
        "iptal_toplam": 0.0,
        "kasa_fark": round(float(kasa_fark or 0), 2),
        "eslesme_yuzdesi": 0.0,
        "zimmet_sinyali": False,
        "yorum": "İptal verisi bulunamadı",
    }
    # ciro_giris tablosundan negatif / iade / iptal kayıtları
    try:
        cur.execute(
            """
            SELECT COALESCE(SUM(ABS(ciro_tl)), 0) AS iptal_tl
            FROM ciro_giris
            WHERE sube_id=%s AND tarih=%s::date
              AND (ciro_tl < 0 OR LOWER(COALESCE(tip,'')) IN ('iade','iptal','void','cancel'))
            """,
            (sube_id, tarih),
        )
        r = cur.fetchone()
        if r:
            sonuc["iptal_toplam"] = round(float(dict(r).get("iptal_tl") or 0), 2)
    except Exception:
        pass

    # kasa_hareketleri fallback
    if sonuc["iptal_toplam"] == 0:
        try:
            cur.execute(
                """
                SELECT COALESCE(SUM(ABS(tutar)), 0) AS iptal_tl
                FROM kasa_hareketleri
                WHERE sube_id=%s AND tarih=%s::date
                  AND LOWER(COALESCE(tip,'')) IN ('iade','iptal','void')
                """,
                (sube_id, tarih),
            )
            r = cur.fetchone()
            if r:
                sonuc["iptal_toplam"] = round(float(dict(r).get("iptal_tl") or 0), 2)
        except Exception:
            pass

    iptal = sonuc["iptal_toplam"]
    kf = abs(float(kasa_fark or 0))

    if iptal > 0 and kf > 1:
        eslesme = min(iptal, kf) / max(iptal, kf)
        sonuc["eslesme_yuzdesi"] = round(eslesme * 100, 1)
        if eslesme >= 0.70:
            sonuc["zimmet_sinyali"] = True
            sonuc["yorum"] = (
                f"İptal tutarı ₺{iptal:.0f} — kasa açığı ₺{kf:.0f} ile "
                f"%{eslesme*100:.0f} eşleşiyor. Sahte iptal + para cepde sinyali."
            )
        else:
            sonuc["yorum"] = (
                f"İptal ₺{iptal:.0f} var ama kasa farkı ₺{kf:.0f} ile "
                f"eşleşme %{eslesme*100:.0f} — zimmet eşiğinin (%70) altında."
            )
    elif iptal > 0:
        sonuc["yorum"] = f"İptal ₺{iptal:.0f} kaydedilmiş, kasa farkı yok — normal."
    elif kf > 1:
        sonuc["yorum"] = f"Kasa açığı ₺{kf:.0f} var ama iptal kaydı bulunamadı."

    return sonuc


def satis_velocity_analiz(cur, sube_id: str, tarih: str) -> Dict[str, Any]:
    """Signal 3 — Satış yoğunluğu (velocity) bağlam analizi.

    Yüksek velocity → çok yoğun → personel zimmet için fırsat bulamaz
    → STOK_KACAGI sinyali 'ikram/unutulan' yönüne ağırlık verir.
    Düşük velocity → sakin dönem → fırsat penceresi açık
    → zimmet araştırması daha güçlü gerekçeye sahip.

    NOT: Bu fonksiyon tanı DEĞİŞTİRMEZ — sadece detay bağlamı ekler.

    Returns:
        {
          "vardiya_sayisi": int,
          "toplam_sure_dk": float,
          "toplam_fis": int,
          "fis_per_saat": float,
          "velocity_seviye": "yuksek"|"orta"|"dusuk"|"bilinmiyor",
          "ikram_firsati_yuksek": bool,
          "yorum": str,
        }
    """
    sonuc: Dict[str, Any] = {
        "vardiya_sayisi": 0,
        "toplam_sure_dk": 0.0,
        "toplam_fis": 0,
        "fis_per_saat": 0.0,
        "velocity_seviye": "bilinmiyor",
        "ikram_firsati_yuksek": False,
        "yorum": "Velocity verisi yok",
    }
    try:
        cur.execute(
            """
            SELECT meta FROM sube_operasyon_event
            WHERE sube_id=%s AND tarih=%s::date
              AND tip IN ('VARDIYA','KAPANIS','ACILIS')
              AND durum='tamamlandi'
            ORDER BY cevap_ts
            """,
            (sube_id, tarih),
        )
        rows = [dict(r) for r in (cur.fetchall() or [])]
    except Exception as e:
        log.warning("satis_velocity_analiz sorgu hata: %s", e)
        return sonuc

    toplam_sure = 0.0
    toplam_fis = 0
    vardiya_sayisi = 0
    for r in rows:
        m = _meta_oku(r.get("meta"))
        if not m:
            continue
        sure = float(m.get("sure_dk") or m.get("vardiya_sure_dk") or 0)
        fis = int(m.get("evo_fis_sayisi") or m.get("fis_sayisi") or 0)
        if sure > 0:
            toplam_sure += sure
            vardiya_sayisi += 1
        if fis > 0:
            toplam_fis += fis

    # Fallback: ciro_giris fiş sayısı
    if toplam_fis == 0:
        try:
            cur.execute(
                """
                SELECT COUNT(*) AS n FROM ciro_giris
                WHERE sube_id=%s AND tarih=%s::date AND durum='aktif'
                """,
                (sube_id, tarih),
            )
            r = cur.fetchone()
            if r:
                toplam_fis = int(dict(r).get("n") or 0)
        except Exception:
            pass

    sonuc["vardiya_sayisi"] = vardiya_sayisi
    sonuc["toplam_sure_dk"] = round(toplam_sure, 1)
    sonuc["toplam_fis"] = toplam_fis

    if toplam_sure > 0 and toplam_fis > 0:
        fis_per_saat = round(toplam_fis / (toplam_sure / 60), 1)
        sonuc["fis_per_saat"] = fis_per_saat
        # Kahve dükkanı eşikleri: saatte 20+ fis = yoğun
        if fis_per_saat >= 20:
            sonuc["velocity_seviye"] = "yuksek"
            sonuc["ikram_firsati_yuksek"] = False
            sonuc["yorum"] = (
                f"Saatte {fis_per_saat:.0f} fiş — çok yoğun. "
                "Personel zimmet için fırsat bulmakta zorlanır; stok açığı ikramsızlık hatası olabilir."
            )
        elif fis_per_saat >= 8:
            sonuc["velocity_seviye"] = "orta"
            sonuc["ikram_firsati_yuksek"] = True
            sonuc["yorum"] = (
                f"Saatte {fis_per_saat:.0f} fiş — orta yoğunluk. "
                "İkram ve zimmet her ikisi de mümkün; ek sinyal gerekli."
            )
        else:
            sonuc["velocity_seviye"] = "dusuk"
            sonuc["ikram_firsati_yuksek"] = True
            sonuc["yorum"] = (
                f"Saatte {fis_per_saat:.0f} fiş — sakin dönem. "
                "Zimmet için fırsat penceresi açık — soruşturma güçlü gerekçeye sahip."
            )

    return sonuc


def sprint_e_ikram_zimmet_ayir(cur, sube_id: str, tarih: str,
                                taniler: List["Tani"]) -> Dict[str, Any]:
    """Sprint E ana akışı — 3 sinyalle ikram/zimmet ayırımı.

    AKIŞ:
      1. fire_bildirim_capraz() → BELGELENMIS?
         ├─ Evet → BELGELENMIS_IADE / BELGELENMIS_FIRE tanısı → bitti
         └─ Hayır → devam
      2. evo_iptal_capraz() → İptal ≈ kasa farkı?
         ├─ Evet → ZIMMET_IPTAL_MANIPULASYON → bitti
         └─ Hayır → devam
      3. satis_velocity_analiz() → tanı değiştirmez, bağlam ekler

    Returns:
        sprint_e_meta dict (karar, fire/velocity/iptal sonuçları)
    """
    # Stok anomalisi olan boyutları + kasa bilgisini topla
    stok_aciklar: Dict[str, float] = {}
    kasa_tani = None
    kasa_fark = 0.0
    for t in taniler:
        if t.boyut == "kasa":
            kasa_tani = t
            kasa_fark = float(t.fark_n1_n2 or 0)
        elif t.tani in (
            "STOK_KACAGI_BEYANSIZ", "IKRAM_UNUTULDU",
            "SWEETHEARTING_SINYAL", "ZIMMET_NAKIT_CEPTE",
        ):
            if t.fark_n1_n2 is not None and t.fark_n1_n2 < 0:
                stok_aciklar[t.boyut] = abs(float(t.fark_n1_n2))

    meta: Dict[str, Any] = {
        "sprint_e_aktif": True,
        "stok_acik_boyutlar": list(stok_aciklar.keys()),
    }

    # ── Signal 1: Fire Bildirim Çapraz ──────────────────────────────────────
    fire_sonuc = fire_bildirim_capraz(cur, sube_id, tarih, stok_aciklar or None)
    meta["fire_bildirim"] = fire_sonuc

    if fire_sonuc["fire_kayit_var"]:
        iade_sebep = fire_sonuc.get("iade_var", False)
        yeni_tani = "BELGELENMIS_IADE" if iade_sebep else "BELGELENMIS_FIRE"
        # Ürün tanılarını güncelle
        for t in taniler:
            if t.boyut == "kasa":
                continue
            if t.tani not in (
                "STOK_KACAGI_BEYANSIZ", "IKRAM_UNUTULDU",
                "SWEETHEARTING_SINYAL",
            ):
                continue
            t.tani = yeni_tani
            t.guven_skoru = 88.0
            t.detay["sprint_e"] = {
                "karar": "BELGELENMIS",
                "fire_kayit_sayisi": fire_sonuc["kayit_sayisi"],
                "sebep_dagilimi": fire_sonuc["sebep_dagilimi"],
                "aciklama": (
                    f"Fire kaydı mevcut ({fire_sonuc['kayit_sayisi']} kayıt) — "
                    "stok anomalisi belgelenmiş, zimmet araştırması gerekmiyor."
                ),
            }
        # Kasa zimmet tanısını da güncelle
        if kasa_tani and kasa_tani.tani == "ZIMMET_NAKIT_CEPTE":
            kasa_tani.tani = "BELGELENMIS_IADE"
            kasa_tani.guven_skoru = 85.0
            kasa_tani.detay["sprint_e"] = {
                "karar": "BELGELENMIS",
                "aciklama": "Kasa farkı fire belgesiyle açıklanmış — iade/zayi kaydı mevcut.",
            }
        meta["karar"] = "BELGELENMIS"
        return meta

    # ── Signal 2: Evo İptal Çapraz ──────────────────────────────────────────
    iptal_sonuc = evo_iptal_capraz(cur, sube_id, tarih, kasa_fark=kasa_fark)
    meta["evo_iptal"] = iptal_sonuc

    if iptal_sonuc["zimmet_sinyali"] and kasa_tani:
        kasa_tani.tani = "ZIMMET_IPTAL_MANIPULASYON"
        kasa_tani.guven_skoru = 82.0
        kasa_tani.detay["sprint_e"] = {
            "karar": "ZIMMET_IPTAL",
            "iptal_tl": iptal_sonuc["iptal_toplam"],
            "eslesme_yuzdesi": iptal_sonuc["eslesme_yuzdesi"],
            "aciklama": iptal_sonuc["yorum"],
        }
        meta["karar"] = "ZIMMET_IPTAL_MANIPULASYON"
        return meta

    # ── Signal 3: Satış Velocity — bağlam ekle (tanı değiştirmez) ───────────
    velocity_sonuc = satis_velocity_analiz(cur, sube_id, tarih)
    meta["velocity"] = velocity_sonuc

    for t in taniler:
        if t.tani in ("STOK_KACAGI_BEYANSIZ", "IKRAM_UNUTULDU"):
            t.detay.setdefault("sprint_e", {})["velocity"] = {
                "seviye": velocity_sonuc["velocity_seviye"],
                "fis_per_saat": velocity_sonuc["fis_per_saat"],
                "yorum": velocity_sonuc["yorum"],
            }

    meta["karar"] = "ACIKLANAMAZ_DEVAM"
    return meta


def stok_akis_tablosu(cur, sube_id: str, tarih: str) -> Dict[str, Any]:
    """5 boyut için tam stok akış tablosu.

    Formül (her boyut):
      ACILIS_stok + URUN_AC − Evo_satis − Evo_ikram − fire = beklenen_KAPANIS
      varyans = gercek_KAPANIS − beklenen_KAPANIS

    varyans > 0 : STOK_FAZLA (Evo eksik kayıt?)
    varyans < 0 : STOK_ACIK  (kayıtsız tüketim / ikram / hırsızlık)
    varyans = 0 : UYUMLU
    """
    cur.execute(
        """SELECT meta FROM sube_operasyon_event
           WHERE sube_id=%s AND tarih=%s::date AND tip='ACILIS' AND durum='tamamlandi'
           ORDER BY cevap_ts DESC NULLS LAST LIMIT 1""",
        (sube_id, tarih),
    )
    r = cur.fetchone()
    acilis_stok = _meta_oku(dict(r)["meta"]).get("acilis_stok_sayim") or {} if r else {}

    cur.execute(
        """SELECT meta FROM sube_operasyon_event
           WHERE sube_id=%s AND tarih=%s::date AND tip='KAPANIS' AND durum='tamamlandi'
           ORDER BY cevap_ts DESC NULLS LAST LIMIT 1""",
        (sube_id, tarih),
    )
    r = cur.fetchone()
    kapanis_raw = _meta_oku(dict(r)["meta"]) if r else None
    kapanis_stok = kapanis_raw.get("kapanis_stok_sayim") or {} if kapanis_raw else None

    # KONTROL event'lerinden ara sayım (zaman damgalı stok noktaları)
    cur.execute(
        """SELECT tip, cevap_ts, meta FROM sube_operasyon_event
           WHERE sube_id=%s AND tarih=%s::date AND durum='tamamlandi'
             AND tip LIKE 'KONTROL%%'
           ORDER BY cevap_ts NULLS LAST""",
        (sube_id, tarih),
    )
    kontrol_stok_list = []
    for rr in (cur.fetchall() or []):
        d = dict(rr)
        m = _meta_oku(d.get("meta"))
        ks = m.get("kontrol_stok_sayim")
        if ks:
            kontrol_stok_list.append({
                "tip": d["tip"],
                "saat": str(d["cevap_ts"])[:16] if d.get("cevap_ts") else "",
                "stok": ks,
            })

    # URUN_AC (paket açma)
    cur.execute(
        "SELECT kalemler_json FROM urun_ac_taslak WHERE sube_id=%s AND tarih=%s::date AND durum='aktif'",
        (sube_id, tarih),
    )
    urun_ac: Dict[str, float] = {}
    for rr in (cur.fetchall() or []):
        kj = dict(rr).get("kalemler_json")
        if isinstance(kj, str):
            try:
                kj = json.loads(kj)
            except Exception:
                kj = {}
        if isinstance(kj, dict):
            for k, v in kj.items():
                try:
                    urun_ac[k] = urun_ac.get(k, 0) + float(v or 0)
                except (TypeError, ValueError):
                    pass

    # Evo günlük grup satışı
    evo_gruplar = _evo_sube_grup_satis(cur, sube_id, tarih)

    # Fire
    fire_kayitlar = _fire_sorgula(cur, sube_id, tarih)

    # Her boyut hesapla
    sonuclar: Dict[str, Dict] = {}
    for boyut in BOYUTLAR:
        if boyut == "kasa":
            continue
        acilis_v = _meta_boyut_topla(acilis_stok, boyut)
        urun_ac_v = _meta_boyut_topla(urun_ac, boyut)

        grup_adi_list = _BOYUT_EVO_GRUP.get(boyut) or []
        evo_satis_v = sum(float(evo_gruplar.get(g, 0)) for g in grup_adi_list)
        evo_ikram_v = 0.0  # Fiş bazlı detay gerekir — şimdilik 0
        fire_v = float(fire_kayitlar.get(boyut, 0))

        beklenen = acilis_v + urun_ac_v - evo_satis_v - evo_ikram_v - fire_v

        if kapanis_stok is not None:
            gercek = _meta_boyut_topla(kapanis_stok, boyut)
            varyans = round(gercek - beklenen, 2)
            if abs(varyans) < 1:
                tani = "UYUMLU"
            elif varyans > 0:
                tani = "STOK_FAZLA"
            else:
                tani = "STOK_ACIK"
        else:
            gercek = None
            varyans = None
            tani = "KAPANIS_YOK"

        sonuclar[boyut] = {
            "acilis": round(acilis_v, 2),
            "urun_ac": round(urun_ac_v, 2),
            "evo_satis": round(evo_satis_v, 2),
            "evo_ikram": round(evo_ikram_v, 2),
            "fire": round(fire_v, 2),
            "beklenen_kapanis": round(beklenen, 2),
            "gercek_kapanis": round(gercek, 2) if gercek is not None else None,
            "varyans": varyans,
            "tani": tani,
        }

    return {
        "sube_id": sube_id,
        "tarih": tarih,
        "boyutlar": sonuclar,
        "kontrol_stok_list": kontrol_stok_list,
        "fire_kayitlar": fire_kayitlar,
        "kapanis_tamamlandi": kapanis_stok is not None,
    }


def personel_sorumluluk_matrisi(cur, sube_id: str, tarih: str,
                                  vardiya_data: Optional[Dict] = None,
                                  stok_data: Optional[Dict] = None) -> List[Dict]:
    """Her personelin vardiya bazlı kasa + stok sorumluluk hesabı.

    Kasa:  devraldı + Evo_nakit − gider − ara_teslim = beklenen_devir
           gerçek_devir − beklenen_devir = kasa_fark (kim, ne kadar, ne zaman)

    Stok:  gün sonu kapanış sorumlusu = son vardiyacı
           KONTROL event'leri varsa ara sorumluluk tespit edilir.

    Risk skoru: |kasa_fark_ort| + anomali_oran × ağırlık
    """
    if vardiya_data is None:
        vardiya_data = vardiya_bazli_uzlasma(cur, sube_id, tarih, evo_dahil=True)
    if stok_data is None:
        stok_data = stok_akis_tablosu(cur, sube_id, tarih)

    vardiyalar = vardiya_data.get("vardiyalar") or []
    stok_boyutlar = stok_data.get("boyutlar") or {}
    stok_aciklar = {b: d for b, d in stok_boyutlar.items() if d.get("tani") == "STOK_ACIK"}
    kontrol_stok = stok_data.get("kontrol_stok_list") or []

    # Personel bazlı topla
    personel_map: Dict[str, Dict] = {}
    for v in vardiyalar:
        pid = v.get("personel_id") or v.get("personel_ad") or "?"
        pad = v.get("personel_ad") or pid
        ps = personel_map.setdefault(pid, {
            "personel_id": pid,
            "ad": pad,
            "vardiya_sayisi": 0,
            "kasa_fark_toplam": 0.0,
            "kasa_fark_abs": 0.0,
            "evo_nakit_toplam": 0.0,
            "evo_fis_sayisi": 0,
            "anomaliler": [],
            "stok_sorumluluk": {},
            "risk_seviye": "normal",
        })
        ps["vardiya_sayisi"] += 1
        fark = v.get("fark_kasa")
        if fark is not None:
            ps["kasa_fark_toplam"] = round(ps["kasa_fark_toplam"] + fark, 2)
            ps["kasa_fark_abs"] = round(ps["kasa_fark_abs"] + abs(fark), 2)
        ps["evo_nakit_toplam"] = round(
            ps["evo_nakit_toplam"] + float(v.get("evo_nakit_satis") or 0), 2)
        ps["evo_fis_sayisi"] += int(v.get("evo_fis_sayisi") or 0)
        if v.get("tani") not in ("UYUMLU", "YETERSIZ_VERI"):
            ps["anomaliler"].append({
                "vardiya_no": v.get("no"),
                "dilim": v.get("tip_dilimi"),
                "kasa_fark": fark,
                "tani": v.get("tani"),
                "sure_dk": v.get("sure_dk"),
            })

    # Stok sorumluluğu: son vardiyacı KAPANIS'tan sorumlu
    if vardiyalar and stok_aciklar:
        son = vardiyalar[-1]
        son_pid = son.get("personel_id") or son.get("personel_ad") or "?"
        if son_pid in personel_map:
            for boyut, d in stok_aciklar.items():
                personel_map[son_pid]["stok_sorumluluk"][boyut] = {
                    "varyans": d["varyans"],
                    "tani": d["tani"],
                    "sebep": "Kapanış sayımı sorumlusu",
                }

    # KONTROL stok noktaları ile orta vardiya sorumluluğu
    if kontrol_stok and len(vardiyalar) >= 2:
        for ks in kontrol_stok:
            ks_stok = ks.get("stok") or {}
            ks_saat = ks.get("saat", "")
            for v in vardiyalar:
                if v.get("bitis_ts", "")[:16] == ks_saat:
                    pid = v.get("personel_id") or v.get("personel_ad") or "?"
                    if pid in personel_map:
                        for boyut in BOYUTLAR:
                            if boyut == "kasa":
                                continue
                            stok_d = stok_boyutlar.get(boyut) or {}
                            beklenen_k = stok_d.get("beklenen_kapanis")
                            ks_v = _meta_boyut_topla(ks_stok, boyut)
                            if beklenen_k is not None and abs(ks_v - beklenen_k) > 1:
                                personel_map[pid]["stok_sorumluluk"].setdefault(boyut, {
                                    "varyans": round(ks_v - beklenen_k, 2),
                                    "tani": "KONTROL_ANLIK",
                                    "sebep": f"KONTROL {ks_saat} sorumlusu",
                                })
                    break

    # Risk seviyesi + öğrenilmiş eşik
    for pid, ps in personel_map.items():
        n = ps["vardiya_sayisi"]
        kasa_fark_ort = ps["kasa_fark_toplam"] / n if n > 0 else 0
        anomali_oran = len(ps["anomaliler"]) / n if n > 0 else 0

        # Öğrenilmiş profil var mı?
        profil = ogrenme_profili_oku(cur, pid, sube_id)
        tipik_sapma = float(profil.get("tipik_sapma") or 5.0) if profil.get("var_mi") else 5.0
        esik = max(1.0, tipik_sapma)  # Personelin kendi "normalı"

        ps["kasa_fark_ort"] = round(kasa_fark_ort, 2)
        ps["anomali_oran_yuzde"] = round(anomali_oran * 100, 1)
        ps["ogrenilmis_tipik_sapma"] = round(tipik_sapma, 2)
        ps["ogrenilmis_risk_skoru"] = profil.get("risk_skoru") if profil.get("var_mi") else None

        has_stok_acik = bool(ps["stok_sorumluluk"])
        if abs(kasa_fark_ort) > max(esik * 3, 50) or anomali_oran >= 0.5:
            ps["risk_seviye"] = "kritik"
        elif abs(kasa_fark_ort) > max(esik * 2, 20) or anomali_oran >= 0.25 or (has_stok_acik and abs(kasa_fark_ort) > esik):
            ps["risk_seviye"] = "yuksek"
        elif abs(kasa_fark_ort) > esik or has_stok_acik:
            ps["risk_seviye"] = "orta"

    return sorted(personel_map.values(), key=lambda x: (
        {"kritik": 0, "yuksek": 1, "orta": 2, "normal": 3}.get(x["risk_seviye"], 4),
        -abs(x["kasa_fark_abs"])
    ))


def kok_neden_analiz(kasa_fark: float,
                     stok_boyutlar: Dict[str, Dict],
                     evo_nakit: float,
                     evo_ikram_var: bool = False) -> List[Dict]:
    """Kasa + stok varyansları verildiğinde olası kök nedenleri öncelik sırası ile üret.

    Karar matrisi (NRF + retail forensics):
      kasa_acik + stok_acik + sayisal_esleme → SWEETHEARTING / ZIMMET
      kasa_acik + stok_tamam                → NAKIT_CEKILDI (satış kasaya girmedi)
      kasa_tamam + stok_acik                → KAYITSIZ_IKRAM / FIRE
      kasa_fazla + stok_acik                → AKSAM_ZIMMET_POZISYON
      stok_fazla + kasa_acik                → POS_FANTOM_SATIS
    """
    sebepler: List[Dict] = []

    stok_aciklar = {b: d for b, d in stok_boyutlar.items()
                    if d.get("tani") == "STOK_ACIK" and d.get("varyans") is not None}
    stok_fazlalar = {b: d for b, d in stok_boyutlar.items()
                     if d.get("tani") == "STOK_FAZLA"}

    # Teorik kayıp tutarı (stok açığı × birim fiyat)
    teorik_kayip = sum(
        abs(float(d["varyans"])) * ORT_FIYAT_MAP.get(b, 0)
        for b, d in stok_aciklar.items()
    )

    # 1. Kasa açık + stok açık + sayısal eşleşme → sweethearting/zimmet
    if kasa_fark < -1 and stok_aciklar and teorik_kayip > 0:
        uyum = min(abs(kasa_fark), teorik_kayip) / max(abs(kasa_fark), teorik_kayip)
        stok_ozet = ", ".join(
            f"{b} {abs(float(d['varyans'])):.0f} adet" for b, d in stok_aciklar.items()
        )
        if uyum >= 0.65:
            sebepler.append({
                "sira": 1,
                "tip": "SWEETHEARTING_ZIMMET",
                "guven": round(min(95, uyum * 100), 0),
                "aciklama": (
                    f"Kasa ₺{abs(kasa_fark):.0f} açık + stok açığı ({stok_ozet}) "
                    f"≈ ₺{teorik_kayip:.0f} teorik kayıp (uyum %{uyum*100:.0f}). "
                    "Ürün satıldı, para kasaya konmadı veya kasadan çekildi."
                ),
                "aksiyon": "Kasa Baskını + kamera inceleme + personel sorgulama",
            })
        else:
            sebepler.append({
                "sira": 2,
                "tip": "KASA_STOK_BIRLIKTE_ACIK",
                "guven": 55.0,
                "aciklama": (
                    f"Kasa ₺{abs(kasa_fark):.0f} açık + stok açığı var ama "
                    f"sayısal eşleşme zayıf (%{uyum*100:.0f}). "
                    "Sayım hatası veya fire olabilir."
                ),
                "aksiyon": "3. kişi sayım + fire beyanı sor",
            })

    # 2. Kasa açık + stok tamam → Nakit çekildi
    if kasa_fark < -1 and not stok_aciklar and evo_nakit > 0:
        sebepler.append({
            "sira": 2 if not sebepler else 3,
            "tip": "NAKIT_CEKILDI",
            "guven": 65.0,
            "aciklama": (
                f"Kasa ₺{abs(kasa_fark):.0f} açık ama stok tutarlı. "
                f"Evo'da ₺{evo_nakit:.0f} nakit satış kayıtlı. "
                "Nakit satış gerçekleşti ama kasaya girmeden alındı."
            ),
            "aksiyon": "Kasa Baskını + Z raporu vs nakit fişleri karşılaştır",
        })

    # 3. Kasa tamam + stok açık → kayıtsız ikram veya fire
    if abs(kasa_fark) <= 5 and stok_aciklar:
        stok_ozet = ", ".join(
            f"{b} -{abs(float(d['varyans'])):.0f}" for b, d in stok_aciklar.items()
        )
        sebep_tip = "KAYITSIZ_IKRAM_FIRE" if not evo_ikram_var else "IKRAM_POLICY_IHLALI"
        sebepler.append({
            "sira": 3,
            "tip": sebep_tip,
            "guven": 60.0,
            "aciklama": (
                f"Kasa normal ama stok açığı var: {stok_ozet}. "
                "Ürün kullanıldı ama kaydedilmedi — ikram, fire veya kişisel tüketim."
            ),
            "aksiyon": "İkram defteri kontrol + fire beyanı sor + personel ifadesi al",
        })

    # 4. Kasa fazla + stok açık → Akşam zimmet pozisyonu
    if kasa_fark > 5 and stok_aciklar:
        sebepler.append({
            "sira": 4,
            "tip": "AKSAM_ZIMMET_POZISYON",
            "guven": 70.0,
            "aciklama": (
                f"Kasa ₺{kasa_fark:.0f} FAZLA + stok açık. "
                "Akşamcı kasayı yüksek beyan etti (yarın zimmet için "
                "'hazırlık pozisyonu' oluşturuyor olabilir)."
            ),
            "aksiyon": "3. kişi sayım + akşamcı performans inceleme + 30 gün trend bak",
        })

    # 5. Stok fazla + kasa açık → POS fantom satış
    if kasa_fark < -1 and stok_fazlalar:
        sebepler.append({
            "sira": 5,
            "tip": "POS_FANTOM_SATIS",
            "guven": 55.0,
            "aciklama": (
                "Kasa açık ama stok beklenenden fazla kaldı — "
                "Evo'ya satış girilmiş ama ürün verilmemiş "
                "(void sonrası iade veya fantom kayıt?)."
            ),
            "aksiyon": "Evo void/iade loglarını kontrol et + POS yetki denetimi",
        })

    # 6. Sadece kasa açık, Evo yok → kayıtsız satış
    if kasa_fark < -1 and evo_nakit == 0 and not stok_aciklar:
        sebepler.append({
            "sira": 6,
            "tip": "EVO_KAYDI_YOK",
            "guven": 45.0,
            "aciklama": (
                f"Kasa ₺{abs(kasa_fark):.0f} açık ama Evo'da nakit satış kaydı yok. "
                "Evo erişim sorunu mu, yoksa satış POS'a hiç girilmedi mi?"
            ),
            "aksiyon": "Evo bağlantı kontrolü + manuel satış defteri var mı?",
        })

    if not sebepler:
        sebepler.append({
            "sira": 99,
            "tip": "BELIRSIZ",
            "guven": 20.0,
            "aciklama": "Mevcut veri ile kök neden tespit edilemedi. Ek sayım ve doğrulama gerekli.",
            "aksiyon": "3. kişi sayım + ERP log inceleme",
        })

    return sorted(sebepler, key=lambda x: x["sira"])


# ════════════════════════════════════════════════════════════════════════════
#  ÖĞRENME MOTORU — Personel bazlı adaptif eşik
#  Algoritma: Welford online (sayısal kararlı, O(1) güncelleme)
#  Tablo: truth_motor_personel_profil (otomatik oluşturulur)
# ════════════════════════════════════════════════════════════════════════════

_PROFIL_DDL = """
CREATE TABLE IF NOT EXISTS truth_motor_personel_profil (
    personel_id    TEXT NOT NULL,
    sube_id        TEXT NOT NULL,
    guncelleme_n   INT  DEFAULT 0,
    kasa_fark_ort  FLOAT DEFAULT 0,
    kasa_fark_m2   FLOAT DEFAULT 0,
    anomali_sayisi INT  DEFAULT 0,
    toplam_vardiya INT  DEFAULT 0,
    risk_skoru     FLOAT DEFAULT 50,
    son_guncelleme DATE,
    PRIMARY KEY (personel_id, sube_id)
)
"""


def _welford(n: int, mean: float, m2: float, x: float):
    """Welford online algoritması: (n, mean, M2) → güncel istatistik."""
    n += 1
    delta = x - mean
    mean += delta / n
    delta2 = x - mean
    m2 += delta * delta2
    return n, mean, m2


def ogrenme_profili_guncelle(cur, personel_id: str, sube_id: str,
                               kasa_fark: float, tani: str) -> Dict:
    """Bir vardiya tamamlandığında personel profilini güncelle.

    Welford online: kasa_fark ortalaması + varyansı = personelin "normal sapma" aralığı.
    risk_skoru = f(anomali_oran, |kasa_fark_ort|) → 0 temiz, 100 kritik.
    """
    if not personel_id or personel_id == "?":
        return {"guncellendi": False, "sebep": "personel_id yok"}
    try:
        cur.execute(_PROFIL_DDL)
    except Exception:
        pass
    try:
        cur.execute(
            "SELECT * FROM truth_motor_personel_profil WHERE personel_id=%s AND sube_id=%s",
            (personel_id, sube_id),
        )
        profil = dict(cur.fetchone() or {})
    except Exception as e:
        return {"guncellendi": False, "hata": str(e)}

    n = int(profil.get("guncelleme_n") or 0)
    mean = float(profil.get("kasa_fark_ort") or 0)
    m2 = float(profil.get("kasa_fark_m2") or 0)
    anomali_s = int(profil.get("anomali_sayisi") or 0)
    toplam_v = int(profil.get("toplam_vardiya") or 0)

    n, mean, m2 = _welford(n, mean, m2, kasa_fark)
    toplam_v += 1
    if tani not in ("UYUMLU", "YETERSIZ_VERI"):
        anomali_s += 1

    std = (m2 / (n - 1)) ** 0.5 if n > 1 else 0.0
    anomali_oran = anomali_s / toplam_v if toplam_v > 0 else 0.0
    risk = min(99.0, max(1.0,
        50.0 * anomali_oran + min(50.0, abs(mean) / 2.0)
    ))

    try:
        cur.execute(
            """
            INSERT INTO truth_motor_personel_profil
                (personel_id, sube_id, guncelleme_n, kasa_fark_ort, kasa_fark_m2,
                 anomali_sayisi, toplam_vardiya, risk_skoru, son_guncelleme)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,CURRENT_DATE)
            ON CONFLICT (personel_id, sube_id) DO UPDATE SET
                guncelleme_n   = EXCLUDED.guncelleme_n,
                kasa_fark_ort  = EXCLUDED.kasa_fark_ort,
                kasa_fark_m2   = EXCLUDED.kasa_fark_m2,
                anomali_sayisi = EXCLUDED.anomali_sayisi,
                toplam_vardiya = EXCLUDED.toplam_vardiya,
                risk_skoru     = EXCLUDED.risk_skoru,
                son_guncelleme = EXCLUDED.son_guncelleme
            """,
            (personel_id, sube_id, n, round(mean, 4), round(m2, 4),
             anomali_s, toplam_v, round(risk, 2)),
        )
    except Exception as e:
        return {"guncellendi": False, "hata": str(e)}

    return {
        "guncellendi": True,
        "personel_id": personel_id,
        "guncelleme_n": n,
        "kasa_fark_ort": round(mean, 2),
        "kasa_fark_std": round(std, 2),
        "tipik_sapma": round(std * 2, 2),   # ±2σ = "bu personel için normal"
        "anomali_oran_yuzde": round(anomali_oran * 100, 1),
        "risk_skoru": round(risk, 2),
    }


def ogrenme_profili_oku(cur, personel_id: str, sube_id: str) -> Dict:
    """Personelin öğrenilmiş profilini oku. Yoksa var_mi=False döner."""
    try:
        cur.execute(_PROFIL_DDL)
    except Exception:
        pass
    try:
        cur.execute(
            "SELECT * FROM truth_motor_personel_profil WHERE personel_id=%s AND sube_id=%s",
            (personel_id, sube_id),
        )
        r = cur.fetchone()
        if not r:
            return {"var_mi": False}
        d = dict(r)
        n = int(d.get("guncelleme_n") or 0)
        m2 = float(d.get("kasa_fark_m2") or 0)
        std = (m2 / (n - 1)) ** 0.5 if n > 1 else 0.0
        toplam_v = int(d.get("toplam_vardiya") or 1)
        return {
            "var_mi": True,
            "personel_id": personel_id,
            "guncelleme_n": n,
            "kasa_fark_ort": round(float(d.get("kasa_fark_ort") or 0), 2),
            "kasa_fark_std": round(std, 2),
            "tipik_sapma": round(std * 2, 2),
            "anomali_oran_yuzde": round(
                int(d.get("anomali_sayisi") or 0) / toplam_v * 100, 1
            ),
            "risk_skoru": round(float(d.get("risk_skoru") or 50), 2),
            "son_guncelleme": str(d.get("son_guncelleme") or ""),
        }
    except Exception as e:
        return {"var_mi": False, "hata": str(e)}


_ALARM_EMOJI = {"kritik": "🔴", "yuksek": "🟠", "orta": "🟡", "dusuk": "🟢"}

_TANI_TR = {
    "SWEETHEARTING_ZIMMET":     "Hırsızlık / Sweethearting",
    "KASA_STOK_BIRLIKTE_ACIK":  "Kasa + Stok birlikte açık",
    "NAKIT_CEKILDI":            "Nakit çekildi (satış kasaya girmedi)",
    "AKSAM_ZIMMET_POZISYON":    "Akşam vardiyası zimmet pozisyonu",
    "POS_FANTOM_SATIS":         "POS fantom satış",
    "FAZLA_PARA_STOK_ACIK":     "Kasa fazla ama stok açık (iade hata?)",
    "KAYITSIZ_IKRAM":           "Kayıtsız ikram / fire",
    "UYUMLU":                   "Uyumlu — sorun yok",
    "YETERSIZ_VERI":            "Yetersiz veri",
}

_BOYUT_TR = {
    "bardak_plastik": "plastik bardak",
    "bardak_karton":  "karton bardak",
    "redbull_soda":   "RedBull/soda",
    "pasta":          "pasta",
}


def _yorum_uret(
    alarm: str,
    kasa_fark: float,
    stok_aciklar: Dict[str, Any],
    kok_nedenler: List[Dict],
    personel_sorumlu: List[Dict],
    onlemler: Optional[List[Dict]] = None,
    tarih: Optional[str] = None,
) -> str:
    """Tüm analiz verilerinden insan-okunabilir Türkçe rapor metni üret.

    Denetçi gibi konuşur: ne buldu → neden önemli → kim → ne yapılmalı.
    """
    emoji = _ALARM_EMOJI.get(alarm, "⚪")
    satirlar: List[str] = []

    # ── Başlık ────────────────────────────────────────────────────────────
    alarm_tr = {"kritik": "KRİTİK", "yuksek": "YÜKSEK RİSK",
                "orta": "ORTA RİSK", "dusuk": "Normal"}.get(alarm, alarm.upper())
    baslik = f"{emoji} {alarm_tr}"
    if tarih:
        baslik += f" ({tarih})"
    satirlar.append(baslik)
    satirlar.append("")

    # ── 1. Kasa durumu ────────────────────────────────────────────────────
    if abs(kasa_fark) > 1:
        yon = "açık" if kasa_fark < 0 else "fazla"
        satirlar.append(
            f"💰 Kasa {yon}: ₺{abs(kasa_fark):.0f} "
            f"({'eksik — para yerinde değil' if kasa_fark < 0 else 'fazla — açıklanamayan gelir var'})"
        )
    else:
        satirlar.append("💰 Kasa: Dengede")

    # ── 2. Stok durumu ────────────────────────────────────────────────────
    if stok_aciklar:
        stok_str_parcalari = []
        for boyut, varyans in stok_aciklar.items():
            adet = abs(float(varyans))
            boyut_tr = _BOYUT_TR.get(boyut, boyut)
            stok_str_parcalari.append(f"{boyut_tr} {adet:.0f} adet eksik")
        satirlar.append("📦 Stok: " + ", ".join(stok_str_parcalari))
    else:
        satirlar.append("📦 Stok: Uyumlu")

    # ── 3. Ne anlama geliyor (kök neden) ─────────────────────────────────
    satirlar.append("")
    if kok_nedenler:
        birincil = kok_nedenler[0]
        tip_tr = _TANI_TR.get(birincil.get("tip", ""), birincil.get("tip", "?"))
        guven = birincil.get("guven", 0)
        satirlar.append(f"🔍 Muhtemel sebep: {tip_tr} (güven %{guven:.0f})")
        # Kısa insan-dili açıklama
        aciklama = birincil.get("aciklama", "")
        if aciklama:
            # İlk cümleyi al (nokta veya 120 karakter)
            kisalt = aciklama.split(".")[0].strip()
            if len(kisalt) > 10:
                satirlar.append(f"   → {kisalt}.")
        # İkinci kök neden varsa kısaca ekle
        if len(kok_nedenler) > 1:
            ikinci = kok_nedenler[1]
            tip2_tr = _TANI_TR.get(ikinci.get("tip", ""), ikinci.get("tip", ""))
            guven2 = ikinci.get("guven", 0)
            if guven2 >= 40:
                satirlar.append(f"   (Alternatif: {tip2_tr}, %{guven2:.0f})")
    else:
        satirlar.append("🔍 Kök neden: Belirlenemedi — veri yetersiz")

    # ── 4. Personel bağlantısı ────────────────────────────────────────────
    satirlar.append("")
    riskli = [p for p in personel_sorumlu if p.get("risk_seviye") != "normal"]
    if riskli:
        satirlar.append("👤 Şüpheli personel:")
        for p in riskli[:3]:
            ad = p.get("ad", "?")
            seviye = p.get("risk_seviye", "?")
            kf = p.get("kasa_fark_toplam", 0)
            anomali_sayisi = len(p.get("anomaliler") or [])
            stok_sorum = p.get("stok_sorumluluk") or {}
            stok_acik_kisi = [_BOYUT_TR.get(b, b) for b in stok_sorum]

            satir = f"   • {ad} — risk: {seviye}"
            if abs(kf) > 1:
                satir += f", kasa farkı ₺{kf:+.0f}"
            if anomali_sayisi:
                satir += f", {anomali_sayisi} vardiya anomalisi"
            if stok_acik_kisi:
                satir += f", stok sorumlusu: {', '.join(stok_acik_kisi)}"
            satirlar.append(satir)
    else:
        satirlar.append("👤 Personel: Bireysel risk tespit edilmedi")

    # ── 5. Ne yapılmalı (aksiyon) ─────────────────────────────────────────
    satirlar.append("")
    if onlemler:
        kritik_aksiyonlar = [o for o in onlemler if o.get("aciliyet") in ("kritik", "yuksek")]
        if kritik_aksiyonlar:
            satirlar.append("⚡ Hemen yapılması gerekenler:")
            for o in kritik_aksiyonlar[:3]:
                satirlar.append(f"   • {o.get('aciklama', o.get('aksiyon_kodu', ''))}")
        diger = [o for o in onlemler if o.get("aciliyet") not in ("kritik", "yuksek")]
        if diger:
            satirlar.append("📋 Önerilen:")
            for o in diger[:2]:
                satirlar.append(f"   • {o.get('aciklama', o.get('aksiyon_kodu', ''))}")
    else:
        # Kök nedenden aksiyon türet
        if kok_nedenler and kok_nedenler[0].get("aksiyon"):
            satirlar.append(f"⚡ Önerilen aksiyon: {kok_nedenler[0]['aksiyon']}")
        elif alarm == "dusuk":
            satirlar.append("✅ Aksiyon gerekmez — rutin takip yeterli")
        else:
            satirlar.append("⚡ Kasa + stok yeniden sayım yapılması önerilir")

    return "\n".join(satirlar)


def tam_analiz(cur, sube_id: str, tarih: str,
               ogrenme_aktif: bool = False) -> Dict[str, Any]:
    """Master tam analiz — tek çağrı ile kapsamlı tanı.

    Çalışma sırası:
      1. vardiya_bazli_uzlasma  → kasa P&L vardiya bazlı
      2. stok_akis_tablosu      → 5 boyut stok akışı + fire
      3. personel_sorumluluk_matrisi → kim, ne kadar, neden
      4. kok_neden_analiz       → kausal zincir + öncelikli sebepler
      5. ogrenme profilleri oku → tarihsel bağlam
      6. ogrenme profilleri güncelle (ogrenme_aktif=True ise)

    Args:
        ogrenme_aktif: True ise vardiya sonunda profil güncellenir (uygulama modunda).

    Returns: Kapsamlı rapor dict.
    """
    # 1. Kasa vardiya P&L
    try:
        vardiya_data = vardiya_bazli_uzlasma(cur, sube_id, tarih, evo_dahil=True)
    except Exception as e:
        log.warning("tam_analiz vardiya hata: %s", e)
        vardiya_data = {"vardiyalar": [], "uyari": str(e)}

    # 2. Stok akış tablosu
    try:
        stok_data = stok_akis_tablosu(cur, sube_id, tarih)
    except Exception as e:
        log.warning("tam_analiz stok hata: %s", e)
        stok_data = {"boyutlar": {}, "uyari": str(e)}

    # 3. Personel sorumluluk matrisi
    try:
        personel_sorumlu = personel_sorumluluk_matrisi(
            cur, sube_id, tarih,
            vardiya_data=vardiya_data, stok_data=stok_data,
        )
    except Exception as e:
        log.warning("tam_analiz personel hata: %s", e)
        personel_sorumlu = []

    # 4. Özet metrikler
    vardiyalar = vardiya_data.get("vardiyalar") or []
    evo_nakit_toplam = sum(float(v.get("evo_nakit_satis") or 0) for v in vardiyalar)
    kasa_fark_toplam = sum(
        float(v.get("fark_kasa") or 0) for v in vardiyalar
        if v.get("fark_kasa") is not None
    )
    stok_boyutlar = stok_data.get("boyutlar") or {}
    stok_acik_sayisi = sum(1 for d in stok_boyutlar.values() if d.get("tani") == "STOK_ACIK")
    stok_aciklar_detay = {b: d for b, d in stok_boyutlar.items() if d.get("tani") == "STOK_ACIK"}

    # 5. Kök neden analizi
    try:
        kok_nedenler = kok_neden_analiz(
            kasa_fark=kasa_fark_toplam,
            stok_boyutlar=stok_boyutlar,
            evo_nakit=evo_nakit_toplam,
        )
    except Exception as e:
        log.warning("tam_analiz kok_neden hata: %s", e)
        kok_nedenler = [{"tip": "HATA", "aciklama": str(e)}]

    # 6. Öğrenilmiş profiller
    profiller: Dict[str, Dict] = {}
    for ps in personel_sorumlu:
        pid = ps.get("personel_id")
        if pid and pid != "?":
            try:
                profil = ogrenme_profili_oku(cur, pid, sube_id)
                if profil.get("var_mi"):
                    profiller[pid] = profil
            except Exception:
                pass

    # 7. Öğrenme güncelleme (ogrenme_aktif=True ise)
    ogrenme_log: Dict[str, Any] = {}
    if ogrenme_aktif:
        for v in vardiyalar:
            pid = v.get("personel_id") or v.get("personel_ad")
            if pid:
                try:
                    r = ogrenme_profili_guncelle(
                        cur, pid, sube_id,
                        kasa_fark=float(v.get("fark_kasa") or 0),
                        tani=v.get("tani") or "YETERSIZ_VERI",
                    )
                    if r.get("guncellendi"):
                        ogrenme_log[pid] = r
                except Exception:
                    pass

    # 8. Genel alarm seviyesi
    has_kritik = any(ps.get("risk_seviye") == "kritik" for ps in personel_sorumlu)
    has_yuksek = any(ps.get("risk_seviye") == "yuksek" for ps in personel_sorumlu)
    birincil_koken = kok_nedenler[0].get("tip", "") if kok_nedenler else ""

    if has_kritik or birincil_koken in ("SWEETHEARTING_ZIMMET",):
        alarm = "kritik"
    elif has_yuksek or birincil_koken in ("NAKIT_CEKILDI", "AKSAM_ZIMMET_POZISYON"):
        alarm = "yuksek"
    elif stok_acik_sayisi > 0 or abs(kasa_fark_toplam) > 5:
        alarm = "orta"
    else:
        alarm = "dusuk"

    # 9. Özet açıklama (kısa)
    en_riskli = personel_sorumlu[0] if personel_sorumlu else {}
    en_riskli_ad = en_riskli.get("ad", "?")
    ozet_parcalari = []
    if abs(kasa_fark_toplam) > 1:
        ozet_parcalari.append(f"Kasa: ₺{kasa_fark_toplam:+.0f}")
    if stok_acik_sayisi > 0:
        stok_str = ", ".join(
            f"{b} {abs(float(d['varyans'])):.0f}↓"
            for b, d in stok_aciklar_detay.items()
        )
        ozet_parcalari.append(f"Stok açığı: {stok_str}")
    if birincil_koken and birincil_koken != "BELIRSIZ":
        ozet_parcalari.append(f"Kök neden: {birincil_koken}")
    if en_riskli.get("risk_seviye") not in (None, "normal"):
        ozet_parcalari.append(f"En riskli: {en_riskli_ad} ({en_riskli.get('risk_seviye')})")
    ozet = " | ".join(ozet_parcalari) or "Tüm kontroller uyumlu"

    # 10. İnsan-okunabilir yorum metni
    yorum_metni = _yorum_uret(
        alarm=alarm,
        kasa_fark=kasa_fark_toplam,
        stok_aciklar={b: d["varyans"] for b, d in stok_aciklar_detay.items()},
        kok_nedenler=kok_nedenler,
        personel_sorumlu=personel_sorumlu,
        onlemler=None,
        tarih=tarih,
    )

    return {
        "sube_id": sube_id,
        "tarih": tarih,
        "alarm_seviyesi": alarm,
        "ozet": ozet,
        "yorum_metni": yorum_metni,          # ← insan-okunabilir rapor
        # Kasa özeti
        "kasa_ozet": {
            "toplam_fark": round(kasa_fark_toplam, 2),
            "evo_nakit_toplam": round(evo_nakit_toplam, 2),
            "vardiya_sayisi": len(vardiyalar),
            "anomali_vardiya": sum(
                1 for v in vardiyalar
                if v.get("tani") not in ("UYUMLU", "YETERSIZ_VERI")
            ),
        },
        # Stok özeti
        "stok_ozet": {
            "acik_boyut_sayisi": stok_acik_sayisi,
            "aciklar": {b: d["varyans"] for b, d in stok_aciklar_detay.items()},
            "fire_kayitlar": stok_data.get("fire_kayitlar") or {},
            "kapanis_tamamlandi": stok_data.get("kapanis_tamamlandi"),
        },
        # Personel sorumluluk (öncelik sıralı)
        "personel_sorumlu": personel_sorumlu,
        # Kök neden (öncelik sıralı)
        "kok_nedenler": kok_nedenler,
        # Öğrenilmiş profiller
        "personel_profiller": profiller,
        # Öğrenme güncelleme
        "ogrenme_aktif": ogrenme_aktif,
        "ogrenme_log": ogrenme_log,
        # Ham veriler
        "vardiya_data": vardiya_data,
        "stok_data": stok_data,
    }
