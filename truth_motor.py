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
import uuid
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

BOYUTLAR = ("kasa", "bardak_plastik", "bardak_buyuk", "bardak_kucuk", "redbull_soda", "pasta")

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
    # ── Sprint F — QSR Büyük Zincir Senaryoları ──────────────────────────
    "SUT_SAPMA",                 # gerçek süt tüketimi > teorik BOM → aşırı porsiyon/kayıt dışı ürün
    "SAHTE_FIRE_KAYDI",          # fire kaydı var ama zamanlama+miktar şüpheli → sprint E bypass girişimi
    "BOM_SAPMA",                 # fiziksel bardak/sarf tüketimi > Evo satış BOM → kayıt dışı kullanım
    # ── Sprint G — Cross-day Akşamcı Zimmet Korelasyonu ──────────────────
    "AKSAM_KASAYI_SISIRDI",      # bugün N1>N2 + dün stok açığı → akşamcı N1 şişirerek zimmet gizledi
    "IPTAL_SUPHE",               # N1>N2 kasa açığı + stok normal + Evo açıklaması yok → iptal fiş kontrol
    # ── Sprint G.2 — Sabahçı N2 Düşük Beyan (bardak çapraz doğrulama) ────
    "SABAH_ZIMMET_SUPHE",        # N1>N2 + dün bardak UYUMLU → N1 fiziksel kanıtla doğrulandı, sabahçı düşük beyan
    # ── Sprint H (C Bendi) — Akşam Vardiyası Bardak P&L (devir→kapanis) ─────
    "AKSAM_VARDIYA_BARDAK_ACIK", # Devir→kapanis fiziksel bardak farkı > Evo akşam tahmini → kayıt dışı satış şüphesi
    # ── Sprint I (D Bendi) — Küçük Tutarlı Günlük Kasa Eksilmesi Pattern ────
    "KUCUK_TUTAR_BIRIKIM",       # Personel son 30g'de >%55 günde küçük negatif fark → birikim/drift zimmeti
    # ── Sprint J — Cross-day Bardak Devamlılık Kontrolü ──────────────────────
    "AKSAM_BARDAK_SISIRDI",      # Dün KAPANIS bardak > bugün ACILIS bardak → gece "eridi" → akşamcı şişirdi
    # ── Sprint K — COZULMEDI otomatik Truth Walk re-check ────────────────────
    "AKSAMCI_SAYIM_HATASI",      # Truth Walk: bugünkü zincir tutarlı, fark dünden geliyor → akşamcı kapanış sayım hatası, zimmet değil
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
    "BELGELENMIS_IADE":          {"oto": "log_yesil",            "insan": "Fire kaydı + iade belgesi mevcut — araştırma gerekmez",       "alarm": "yok"},
    "BELGELENMIS_FIRE":          {"oto": "log_yesil",            "insan": "Fire kaydı mevcut (zayi/bozulma) — açıklanmış kayıp",          "alarm": "yok"},
    "ZIMMET_IPTAL_MANIPULASYON": {"oto": "cfo_bildirim_kritik",  "insan": "Sahte Evo iptali + para cepde — soruşturma + kamera",          "alarm": "kritik"},
    # Sprint F — QSR büyük zincir senaryoları
    "SUT_SAPMA":                 {"oto": "uyari_orta",           "insan": "Reçete kontrolü + personel porsiyonlama izle + fire sor",       "alarm": "orta"},
    "SAHTE_FIRE_KAYDI":          {"oto": "cfo_bildirim_log",     "insan": "Fire kaydı şüpheli — zamanlama + miktar incele + kamera bak",   "alarm": "yuksek"},
    "BOM_SAPMA":                 {"oto": "uyari_yuksek",         "insan": "Sarf tüketimi BOM'u aşıyor — kayıt dışı kullanım soruştur",    "alarm": "yuksek"},
    # Sprint G — Cross-day akşamcı zimmet korelasyonu
    "AKSAM_KASAYI_SISIRDI":      {"oto": "cfo_bildirim_kritik",  "insan": "Dün akşamcı N1'i şişirdi + stok açığı eşleşiyor → zimmet soruşturması + kamera", "alarm": "kritik"},
    "IPTAL_SUPHE":               {"oto": "uyari_yuksek",         "insan": "Kasa açığı Evo'da açıklanamıyor — satış panelinde o vardiya iptal fişlerini manuel kontrol et", "alarm": "yuksek"},
    # Sprint G.2 — Sabahçı N2 düşük beyan
    "SABAH_ZIMMET_SUPHE":        {"oto": "cfo_bildirim_kritik",  "insan": "Dün bardak+Evo N1'i doğruluyor, sabahçı kasayı düşük beyan etmiş → soruşturma + kamera", "alarm": "kritik"},
    # Sprint H (C Bendi) — Akşam vardiyası bardak P&L
    "AKSAM_VARDIYA_BARDAK_ACIK": {"oto": "cfo_bildirim_log",     "insan": "Akşam vardiyası bardak açığı — devir→kapanis fiziksel fark Evo satış tahminini aşıyor → kayıt dışı satış + nakit soruşturması", "alarm": "yuksek"},
    # Sprint I (D Bendi) — Küçük tutarlı günlük birikim
    "KUCUK_TUTAR_BIRIKIM":       {"oto": "cfo_bildirim_log",     "insan": "Personel her gün küçük tutarda kasa açığı oluşturuyor → 30 günlük seri korelasyon soruşturması + birebir gözlem", "alarm": "yuksek"},
    # Sprint J — Cross-day bardak devamlılık
    "AKSAM_BARDAK_SISIRDI":      {"oto": "cfo_bildirim_kritik",  "insan": "Dün akşamcı KAPANIS bardak sayısını şişirdi — sabahçı kör sayımda gerçeği buldu → gece bardak kaybolmaz → zimmet soruşturması + kamera", "alarm": "kritik"},
    # Sprint K — COZULMEDI otomatik Truth Walk re-check
    "AKSAMCI_SAYIM_HATASI":      {"oto": "log_sari",             "insan": "Düşük öncelik: en olası açıklama akşamcının kapanış sayım hatası (fark dünden geliyor). Sıraya al — doğrulanana kadar zimmet ihtimali elenmez, alarmı kapatma", "alarm": "dusuk"},
}

@dataclass
class BoyutVeri:
    """Tek bir boyut için 3 kaynaklı ölçüm (Evo POS ücretli ve ikram ayrı tutulur)."""
    boyut: str
    n1_aksam: Optional[float] = None       # önceki gün KAPANIS beyanı (devir / kapanış sayım)
    n2_sabah: Optional[float] = None       # bugün ACILIS kör sayımı
    n3_evo: Optional[float] = None         # POS ücretli satış (önceki gün)
    n3_evo_ikram: Optional[float] = None   # POS ikram/0₺/tam iskonto (önceki gün)
    ek_detay: Dict[str, Any] = field(default_factory=dict)  # ör. büyük/küçük bardak kırılımı


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
    # Kasa: ±5 TL "önemsiz fark" sayılır (sayım/yuvarlama payı) — kullanıcı kararı
    # 2026-06-14. Bu eşiğin altında kasa UYUMLU sayılır (personel risk skoruna
    # yansımaz); merkez tarafı (sube_operasyon_uyari) farkı zaten ayrıca gösterir.
    "kasa":           5.00,   # ₺
    "bardak_plastik": 0,      # adet
    "bardak_buyuk":   0,      # adet (14 Oz)
    "bardak_kucuk":   0,      # adet (8 Oz)
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

    # Evo verisi bu boyut için hiç gelmemiş — ürün boyutlarında bunu kararın
    # detayına işaretliyoruz ki özet/rapor "Evo verisi yok, manuel sayım
    # kontrolü önerilir" diyebilsin.
    evo_eksik = is_urun and n3_satis is None

    # Yetersiz veri kontrolü
    if n1 is None or n2 is None:
        _detay: Dict[str, Any] = {"sebep": "n1 veya n2 eksik"}
        if evo_eksik:
            _detay["evo_eksik"] = True
        if veri.ek_detay:
            _detay.update(veri.ek_detay)
        return Tani(
            sube_id=sube_id, tarih=tarih, boyut=boyut,
            n1_aksam=n1, n2_sabah=n2, n3_evo=n3_satis, n3_evo_ikram=n3_ikram,
            fark_n1_n2=None, evo_destek="yok",
            tani="YETERSIZ_VERI", guven_skoru=0.0,
            detay=_detay,
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
    if evo_eksik:
        detay["evo_eksik"] = True
    if veri.ek_detay:
        detay.update(veri.ek_detay)

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
    # ⚠️ TRUTH-001 (2026-09-02): bu fiyatlar HARDCODE TAHMİNDİR — canlı satış
    # fiyatına bağlı değil. Zam yapıldığında burası eskir ve "kasa eksiği ≈ ürün
    # kaybı" eşleşmesi kayar. Eşleşmenin kendisi bir ZİMMET HÜKMÜ ürettiği için,
    # yanlış fiyat doğrudan yanlış suçlama demektir.
    # Canlı fiyat kaynağı bağlanana kadar: fiyatın tahmin olduğu ÇIKTIDA yazılı
    # (detay["fiyat_kaynak"]) ve hüküm dili "şüphe"ye çekildi.
    ORT_FIYAT = {  # boyut → TAHMİNİ ortalama satış fiyatı (₺/adet)
        "bardak_plastik": 50.0,
        "bardak_buyuk":   60.0,
        "bardak_kucuk":   50.0,
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
                # 🔴 TRUTH-001: güven skoru TAHMİNİ FİYATA dayanıyor. Fiyat
                # tahmin olduğu sürece skorun tavanı da düşürülür — %95 güven,
                # kaynağı tahmin olan bir hesaptan çıkmamalı.
                kasa.guven_skoru = round(min(70.0 + uyum * 25.0, 85.0), 1)
                kasa.detay["fiyat_kaynak"] = "tahmini_sabit_liste"
                kasa.detay["fiyat_uyarisi"] = (
                    "Eşleşme, koda gömülü TAHMİNİ satış fiyatlarıyla hesaplandı; "
                    "güncel fiyatlarla doğrulanmadı."
                )
                kasa.detay["capraz"] = (
                    f"Kasa eksik ₺{kasa_eksik:.0f} ≈ ürün kaybı ₺{beklenen_urun_tutari:.0f} "
                    f"(uyum %{uyum*100:.0f}) — {'; '.join(eslesen_boyutlar)}. "
                    "Bu tabloyu ÜRETEBİLECEK en olası senaryo: ürün verildi, POS "
                    "atlandı, para kasaya konmadı. ⚠️ Tek başına KANIT DEĞİLDİR — "
                    "fiyatlar tahminidir ve aynı tabloyu fire/ikram/sayım hatası "
                    "birlikte de üretebilir."
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
    # Sprint F
    "SAHTE_FIRE_KAYDI":          88,
    "BOM_SAPMA":                 65,
    "SUT_SAPMA":                 55,
    # Sprint G
    "AKSAM_KASAYI_SISIRDI":      97,
    "IPTAL_SUPHE":               62,
    # Sprint G.2
    "SABAH_ZIMMET_SUPHE":        96,
    # Sprint H (C Bendi)
    "AKSAM_VARDIYA_BARDAK_ACIK": 87,
    # Sprint I (D Bendi)
    "KUCUK_TUTAR_BIRIKIM":       82,
    # Sprint J — Cross-day bardak devamlılık
    "AKSAM_BARDAK_SISIRDI":      93,
    # Sprint K — COZULMEDI otomatik Truth Walk re-check
    "AKSAMCI_SAYIM_HATASI":       1,
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
    # Sprint F
    "SUT_SAPMA":                 "Süt tüketimi BOM'u aşıyor — aşırı porsiyonlama veya kayıt dışı ürün",
    "SAHTE_FIRE_KAYDI":          "Fire kaydı şüpheli — zimmet örtbas girişimi olabilir",
    "BOM_SAPMA":                 "Sarf tüketimi Evo satış BOM'undan fazla — kayıt dışı kullanım",
    # Sprint G
    "AKSAM_KASAYI_SISIRDI":      "Akşamcı N1 şişirdi — dünkü stok açığı ile eşleşiyor → ZİMMET",
    "IPTAL_SUPHE":               "Açıklanamayan kasa açığı — iptal fiş manipülasyonu şüphesi",
    # Sprint G.2
    "SABAH_ZIMMET_SUPHE":        "Sabahçı N2 düşük beyan — dün bardak N1'i doğruluyor → ZİMMET şüphesi",
    # Sprint H (C Bendi)
    "AKSAM_VARDIYA_BARDAK_ACIK": "Akşam vardiyası bardak açığı — devir→kapanis fark Evo tahminini aşıyor → kayıt dışı satış şüphesi",
    # Sprint I (D Bendi)
    "KUCUK_TUTAR_BIRIKIM":       "Günlük küçük kasa eksilmesi — birikim zimmeti şüphesi",
    # Sprint J — Cross-day bardak devamlılık
    "AKSAM_BARDAK_SISIRDI":      "Dün akşamcı bardak şişirdi — gece bardak kaybolmaz, sabahçı gerçeği buldu → ZİMMET",
    # Sprint K — COZULMEDI otomatik Truth Walk re-check
    "AKSAMCI_SAYIM_HATASI":      "Bugünkü zincir tutarlı, fark dünden geliyor — en olası açıklama akşamcının kapanış sayım hatası (doğrulanana kadar zimmet ihtimali elenmez)",
}

_ALARM_ESIK = {
    "kritik": 85,   # ≥85 → kritik
    "yuksek": 60,   # ≥60 → yüksek
    "orta":   30,   # ≥30 → orta
}

_BOYUT_KISA = {
    "kasa": "kasa", "bardak_plastik": "plastik bardak",
    "bardak_buyuk": "14oz bardak", "bardak_kucuk": "8oz bardak", "redbull_soda": "RedBull/soda", "pasta": "pasta",
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
                "anomali_boyutlar": [], "capraz_aciklama": "", "evo_eksik_boyutlar": []}

    # Evo verisi hiç gelmemiş ürün boyutları — bu boyutlardaki kararlar
    # sadece beyan (n1/n2) karşılaştırmasına dayanıyor, "manuel sayım
    # kontrolü önerilir" notuna konu olacak.
    evo_eksik_boyutlar = [
        t.boyut for t in taniler
        if t.boyut != "kasa" and (t.detay or {}).get("evo_eksik")
    ]

    # Tüm anomalileri önceliğe göre sırala
    anomaliler = [
        t for t in taniler
        if t.tani not in ("UYUMLU", "YETERSIZ_VERI")
    ]
    anomaliler.sort(key=lambda t: -_TANI_ONCELIK.get(t.tani, 0))

    # Normal akış
    if not anomaliler:
        yorum = (
            "🟢 Normal\n\n"
            "✅ Kasa ve stok uyumlu. Evo POS verileri beyanlarla örtüşüyor.\n"
            "   Aksiyon gerekmez."
        )
        ozet = "Tüm kontroller uyumlu — sorun yok"
        if evo_eksik_boyutlar:
            etkilenen_evo = ", ".join(_BOYUT_KISA.get(b, b) for b in evo_eksik_boyutlar)
            yorum = (
                "🟢 Normal (Evo verisi eksik)\n\n"
                "✅ Sayım zinciri (akşam→sabah) tutarlı, sorun görünmüyor.\n"
                f"⚠️ Ama Evo POS verisi gelmedi: {etkilenen_evo} — bu boyutlar şu an "
                "sadece beyana göre değerlendirildi, manuel sayım kontrolü önerilir."
            )
            ozet = f"Sayım tutarlı ama Evo verisi eksik [{etkilenen_evo}] — manuel kontrol önerilir"
        return {
            "alarm": "normal",
            "ana_tani": "UYUMLU",
            "guven": 100,
            "ozet": ozet,
            "yorum_metni": yorum,
            "anomali_boyutlar": [],
            "capraz_aciklama": "",
            "evo_eksik_boyutlar": evo_eksik_boyutlar,
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

    # Sorumlu personel — sprint G/G2/H tanılarında detay'a yazılmış olabilir
    _sorumlu_ad = (
        (ana.detay or {}).get("aksamci_ad")
        or (ana.detay or {}).get("sabahci_ad")
    )
    if _sorumlu_ad:
        satirlar.append(f"👤 İlgili personel: {_sorumlu_ad}")

    # Sprint M — geç açılış bağlamı
    _gec_acilis = (ana.detay or {}).get("sabahci_gec_acilis")
    if _gec_acilis:
        _kim = f" ({_gec_acilis['personel_ad']})" if _gec_acilis.get("personel_ad") else ""
        satirlar.append(
            f"🕐 Not: Bugün açılış {_gec_acilis['gecikme_dk']:.0f} dk gecikmeli yapıldı"
            f"{_kim} (planlanan {_gec_acilis.get('planlanan_saat') or '?'}, "
            f"gerçek {_gec_acilis.get('gercek_saat') or '?'}) — sayım baskı altında "
            "yapılmış olabilir, bu ihtimal de değerlendirilmeli."
        )

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

    # Evo verisi eksik boyutlar — anomali değerlendirmesine ek not
    if evo_eksik_boyutlar:
        etkilenen_evo = ", ".join(_BOYUT_KISA.get(b, b) for b in evo_eksik_boyutlar)
        satirlar.append(f"\n⚠️ Evo verisi gelmedi: {etkilenen_evo} — manuel sayım kontrolü önerilir")

    return {
        "alarm": alarm,
        "ana_tani": ana.tani,
        "guven": round(ana.guven_skoru, 1),
        "ozet": ozet,
        "yorum_metni": "\n".join(satirlar),
        "anomali_boyutlar": anomali_boyutlar,
        "capraz_aciklama": capraz,
        "evo_eksik_boyutlar": evo_eksik_boyutlar,
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

def kararlari_kaydet(cur, taniler: List[Tani], hatalar: Optional[List[str]] = None) -> int:
    """Üretilen tanıları truth_motor_kararlar tablosuna yazar. Sayıyı döner.

    Her INSERT kendi SAVEPOINT'i içinde — biri hata verirse (örn. şema
    uyumsuzluğu) transaction "aborted" durumuna düşmez, diğer kayıtlar ve
    sonraki adımlar (personel_risk_sinyal, son_calisma update) etkilenmez.

    `hatalar` verilirse, başarısız INSERT'lerin hata metni buraya eklenir
    (API yanıtında görünür hale getirip log erişimi gerektirmeden teşhis
    edilebilsin diye — 2026-06).
    """
    n = 0
    for i, t in enumerate(taniler):
        sp = f"sp_karar_{i}"
        try:
            cur.execute(f"SAVEPOINT {sp}")
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
            cur.execute(f"RELEASE SAVEPOINT {sp}")
            n += 1
        except Exception as e:
            try:
                cur.execute(f"ROLLBACK TO SAVEPOINT {sp}")
                cur.execute(f"RELEASE SAVEPOINT {sp}")
            except Exception:
                pass
            log.warning("truth_motor karar yazılamadı sube=%s boyut=%s: %s",
                        t.sube_id, t.boyut, e)
            if hatalar is not None:
                hatalar.append(f"{t.boyut}: {e}")
    return n


# ════════════════════════════════════════════════════════════════════════════
#  PERSONEL RİSK SİNYALİ — Truth Motor → personel_risk_sinyal entegrasyonu
# ════════════════════════════════════════════════════════════════════════════
#
# NOT: Bu sinyaller SADECE CFO/operasyon tarafında gösterilir (örn. Akıllı
# Denetim panelinde "Personel Risk Skorları"). Personelin kendi gördüğü
# herhangi bir panelde (QR görev girişi, fire-foto yükleme vb.) BU VERİYE
# kesinlikle yer verilmez — kullanıcı kararı (2026-06-14).

# Yalnızca bu tanılar + yeterli güven varsa sinyal üretilir (gürültü olmasın)
_RISK_SINYAL_MIN_GUVEN = 65.0


def _personel_id_by_ad(cur, ad: Optional[str], tarih: Optional[str] = None) -> Optional[str]:
    """Truth Motor'daki serbest-metin personel adını personel.id'ye eşler.

    ── 🔴 DÜZELTİLDİ (2026-08-26) — ÇIKIP GERİ GELEN PERSONEL ─────────────────
    ESKİ HÂL:  SELECT id FROM personel WHERE ad_soyad ILIKE %s LIMIT 1
    Sıralama YOK, aktiflik filtresi YOK. Aynı adda İKİ kayıt varsa (personel
    çıkıp geri girdiyse) veritabanı hangisini verirse o alınıyordu.

    CANLI KANIT: SILA AKBAY 10 Ağustos'ta yeniden başladı; 14 Ağustos tarihli
    risk sinyalleri ve hipotez gözlemleri 26 MAYIS'TA KAPANMIŞ kayda yazılmış.
    Sonuç: sinyal aktif kadroda görünmez, personel risk skoru eksik kalır —
    ve bu SILA'ya özel değil, GERİ GELEN HER PERSONELDE tekrarlar.

    DOĞRU CEVAP "aktif olanı seç" DEĞİL: 14 Ağustos'un sinyali, 14 Ağustos'ta
    YÜRÜRLÜKTE OLAN döneme aittir. Geçmiş bir günü analiz ederken o günkü
    dönem doğru cevaptır. Sıra:
      1) dönemi o günü KAPSAYAN kayıt
      2) aktif olan
      3) en güncel başlangıç
    `tarih` verilmezse 1. ölçüt devre dışı kalır ama 2-3 yine çalışır —
    yani hiçbir çağrı eskisinden kötü olmaz.
    """
    ad = (ad or "").strip()
    if not ad:
        return None
    t = (tarih or None)
    try:
        cur.execute(
            """SELECT id FROM personel
                WHERE ad_soyad ILIKE %s
                ORDER BY
                  (CASE WHEN %s::date IS NOT NULL
                         AND (baslangic_tarihi IS NULL OR baslangic_tarihi <= %s::date)
                         AND (cikis_tarihi     IS NULL OR cikis_tarihi     >= %s::date)
                        THEN 0 ELSE 1 END),
                  (CASE WHEN COALESCE(aktif, TRUE) THEN 0 ELSE 1 END),
                  baslangic_tarihi DESC NULLS LAST
                LIMIT 1""",
            (ad, t, t, t))
        r = cur.fetchone()
        return r["id"] if r else None
    except Exception:
        return None


def _risk_sinyal_yaz(cur, pid: str, sube_id: str, sinyal_tarih: str,
                      sinyal_turu: str, agirlik: int, aciklama: str,
                      referans_id: str) -> bool:
    """Tek bir personel_risk_sinyal satırı yazar (idempotent — referans_id ile)."""
    try:
        cur.execute("SAVEPOINT sp_risk_sinyal")
        cur.execute("SELECT 1 FROM personel_risk_sinyal WHERE referans_id = %s", (referans_id,))
        if cur.fetchone():
            cur.execute("RELEASE SAVEPOINT sp_risk_sinyal")
            return False
        cur.execute(
            """
            INSERT INTO personel_risk_sinyal
                (id, personel_id, sube_id, tarih, sinyal_turu, agirlik, aciklama, referans_id)
            VALUES (%s, %s, %s, %s::date, %s, %s, %s, %s)
            """,
            (str(uuid.uuid4()), pid, sube_id, sinyal_tarih, sinyal_turu, agirlik, aciklama, referans_id),
        )
        cur.execute("RELEASE SAVEPOINT sp_risk_sinyal")
        return True
    except Exception as e:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_risk_sinyal")
            cur.execute("RELEASE SAVEPOINT sp_risk_sinyal")
        except Exception:
            pass
        log.warning("personel_risk_sinyal yazılamadı sube=%s referans=%s: %s", sube_id, referans_id, e)
        return False


def hipotez_gozlem_kaydet(cur, hipotez_turu: str, sube_id: str, tarih: str,
                          kosul_var: bool, sonuc_anomali: bool,
                          kosul_siddet: Optional[float] = None,
                          boyut: Optional[str] = None,
                          sonuc_tani: Optional[str] = None,
                          personel_id: Optional[str] = None,
                          detay: Optional[Dict[str, Any]] = None) -> bool:
    """Akıllı Denetim öğrenme defterine HAM (koşul, sonuç) gözlemi yazar.

    Eşik UYGULAMAZ, yorum YAPMAZ, istatistik ÇIKARMAZ — sadece ham veri toplar.
    Yeterli veri birikince (≥~25 olay) ayrı bir katman lift/oran analizi yapacak.
    Idempotent: referans_id = tm:hipotez:<tur>:<sube>:<tarih>:<boyut>.

    Returns: yeni satır yazıldıysa True (zaten varsa False).
    """
    referans_id = f"tm:hipotez:{hipotez_turu}:{sube_id}:{tarih}:{boyut or '-'}"
    try:
        cur.execute("SAVEPOINT sp_hipotez")
        cur.execute(
            "SELECT 1 FROM denetim_hipotez_gozlem WHERE referans_id = %s", (referans_id,)
        )
        if cur.fetchone():
            cur.execute("RELEASE SAVEPOINT sp_hipotez")
            return False
        cur.execute(
            """
            INSERT INTO denetim_hipotez_gozlem
                (id, hipotez_turu, sube_id, tarih, boyut, kosul_var, kosul_siddet,
                 sonuc_anomali, sonuc_tani, personel_id, detay_json, referans_id)
            VALUES (%s, %s, %s, %s::date, %s, %s, %s, %s, %s, %s, %s::jsonb, %s)
            """,
            (
                str(uuid.uuid4()), hipotez_turu, sube_id, tarih, boyut,
                bool(kosul_var), kosul_siddet, bool(sonuc_anomali), sonuc_tani,
                personel_id, json.dumps(detay or {}, ensure_ascii=False, default=str),
                referans_id,
            ),
        )
        cur.execute("RELEASE SAVEPOINT sp_hipotez")
        return True
    except Exception as e:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_hipotez")
            cur.execute("RELEASE SAVEPOINT sp_hipotez")
        except Exception:
            pass
        log.warning("hipotez_gozlem yazılamadı sube=%s referans=%s: %s", sube_id, referans_id, e)
        return False


def personel_risk_sinyal_uret(cur, sube_id: str, tarih: str, taniler: List["Tani"]) -> int:
    """Anomali tanılarından (sorumlu personel tanımlıysa) personel_risk_sinyal üretir.

    Idempotent: aynı (sube,tarih,boyut,tani) için referans_id ile tek kayıt yazılır
    — gece scheduler restart olsa da tekrar yazılmaz.

    Çapraz-gün tarih atfı: n1_aksam = ÖNCEKİ günün akşamcı kapanış beyanı,
    n2_sabah = bugünün (tarih) sabahçı açılış sayımı. Yani "aksamci_ad" → o
    kişi (tarih - 1) gününde çalıştı; sinyal o güne yazılmalı, "tarih"e değil.
    "sabahci_ad" ise bugünün (tarih) sabahçısı, tarih doğru.

    QR ile mühürleyen (KAPANIS'ı kapatan, n1_aksam'ı beyan eden) `aksamci_ad`
    ÖNCELİKLİ/birincil sorumlu olarak tam ağırlıkla; aynı akşam vardiyasında
    bulunup mührü basmayan `aksamci_diger_adlar` ise yarım ağırlıkla
    (ikincil sorumlu — birlikte çalıştı, ama beyanı o vermedi) işaretlenir.
    """
    n = 0
    for t in taniler:
        if t.tani in ("NORMAL", "YETERSIZ_VERI"):
            continue
        if (t.guven_skoru or 0) < _RISK_SINYAL_MIN_GUVEN:
            continue

        aksamci_ad = (t.detay or {}).get("aksamci_ad")
        sabahci_ad = (t.detay or {}).get("sabahci_ad")
        ad = aksamci_ad or sabahci_ad
        sinyal_tarih = _previous_day(tarih) if aksamci_ad else tarih
        # Sinyal HANGİ GÜNE aitse o günkü dönem seçilir (bkz. fonksiyon notu).
        pid = _personel_id_by_ad(cur, ad, sinyal_tarih)
        if not pid:
            continue

        agirlik = max(1, min(20, round((t.guven_skoru or 0) / 5)))
        aciklama = (t.detay or {}).get("eylem", {}).get("insan") or t.tani
        sinyal_turu = f"truth_motor_{t.tani.lower()}"

        # FIX T2 (2026-07-05): shift-level bardak tanıları (Sprint H/J üç bardak boyutunu —
        # büyük/küçük/plastik — AYNI tanıya yükseltir) TEK fiziksel olaydır. referans_id'de boyut
        # kaldığı için aynı olay 3 ayrı sinyal + 3× ağırlık üretiyordu (tek gecelik anomali personeli
        # otomatik "kritik takip" eşiğine sokuyordu). Bu tanılarda boyutu "bardak"a sabitle →
        # referans_id idempotency dedup'ı 3'ü 1'e indirir (tek sinyal, tek ağırlık).
        _SHIFT_LEVEL_BARDAK = ("AKSAM_VARDIYA_BARDAK_ACIK", "AKSAM_BARDAK_SISIRDI")
        _ref_boyut = "bardak" if t.tani in _SHIFT_LEVEL_BARDAK else t.boyut

        referans_id = f"tm:{sube_id}:{tarih}:{_ref_boyut}:{t.tani}"
        if _risk_sinyal_yaz(cur, pid, sube_id, sinyal_tarih, sinyal_turu, agirlik, aciklama, referans_id):
            n += 1

        # ── İkincil sorumlular ───────────────────────────────────────────
        # Aynı akşam vardiyasında bulunup KAPANIS'ı mühürlemeyen personel —
        # yarım ağırlıkla, ayrı referans_id ile işaretlenir.
        if aksamci_ad:
            for _diger_ad in (t.detay or {}).get("aksamci_diger_adlar") or []:
                if not _diger_ad or _diger_ad == aksamci_ad:
                    continue
                _diger_pid = _personel_id_by_ad(cur, _diger_ad, sinyal_tarih)
                if not _diger_pid:
                    continue
                _diger_agirlik = max(1, round(agirlik / 2))
                _diger_referans = f"tm:{sube_id}:{tarih}:{_ref_boyut}:{t.tani}:diger:{_diger_pid}"
                if _risk_sinyal_yaz(cur, _diger_pid, sube_id, sinyal_tarih, sinyal_turu,
                                    _diger_agirlik, aciklama, _diger_referans):
                    n += 1
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


_GEC_ACILIS_ESIK_DK = 15.0  # operasyon_merkez_api "Geç Açılan Şubeler" ile aynı eşik


def _acilis_gecikme_bilgisi(cur, sube_id: str, tarih: str) -> Optional[Dict[str, Any]]:
    """Bugünkü ACILIS event'inin ne kadar gecikmeli yapıldığını döner.

    Referans: operasyon_merkez_api `/gec-acilan-subeler` ile aynı hesap —
    vardiya planı varsa (MIN başlangıç saati) ona göre, yoksa sistem_slot_ts'e
    göre gecikme dakikası. Açılış yoksa veya gecikme yoksa None döner.
    """
    try:
        cur.execute(
            """
            SELECT
                e.cevap_ts,
                CASE
                    WHEN va.bek_saat IS NOT NULL THEN
                        ROUND(EXTRACT(EPOCH FROM
                            (e.cevap_ts AT TIME ZONE 'Europe/Istanbul'
                             - (e.tarih::date + va.bek_saat))
                        ) / 60.0, 2)
                    WHEN e.sistem_slot_ts IS NOT NULL THEN
                        ROUND(EXTRACT(EPOCH FROM (e.cevap_ts - e.sistem_slot_ts)) / 60.0, 2)
                    ELSE 0.0
                END AS gecikme_dk,
                CASE
                    WHEN va.bek_saat IS NOT NULL THEN TO_CHAR(va.bek_saat, 'HH24:MI')
                    WHEN e.sistem_slot_ts IS NOT NULL THEN TO_CHAR(e.sistem_slot_ts AT TIME ZONE 'Europe/Istanbul', 'HH24:MI')
                    ELSE NULL
                END AS planlanan_saat,
                x.personel_ad
            FROM sube_operasyon_event e
            LEFT JOIN LATERAL (
                SELECT MIN(va2.baslangic_saat) AS bek_saat
                FROM vardiya_atama va2
                JOIN vardiya_slot vs2 ON vs2.id = va2.slot_id
                WHERE vs2.sube_id = e.sube_id AND va2.tarih = e.tarih AND va2.durum != 'iptal'
            ) va ON TRUE
            LEFT JOIN LATERAL (
                SELECT COALESCE(NULLIF(TRIM(d.personel_ad), ''), p.ad_soyad, d.personel_id::text) AS personel_ad
                FROM operasyon_defter d
                LEFT JOIN personel p ON p.id = d.personel_id
                WHERE d.ref_event_id = e.id
                ORDER BY d.olay_ts DESC NULLS LAST, d.id DESC LIMIT 1
            ) x ON TRUE
            WHERE e.sube_id=%s AND e.tarih=%s::date AND e.tip='ACILIS' AND e.sira_no=0
              AND e.durum='tamamlandi' AND e.cevap_ts IS NOT NULL
            ORDER BY e.cevap_ts DESC LIMIT 1
            """,
            (sube_id, tarih),
        )
        row = cur.fetchone()
        if not row:
            return None
        row = dict(row)
        gecikme = round(max(0.0, float(row.get("gecikme_dk") or 0.0)), 2)
        return {
            "gecikme_dk": gecikme,
            "planlanan_saat": row.get("planlanan_saat"),
            "gercek_saat": row["cevap_ts"].strftime("%H:%M") if hasattr(row.get("cevap_ts"), "strftime") else None,
            "personel_ad": (row.get("personel_ad") or "").strip() or None,
        }
    except Exception as e:
        log.warning("truth_motor _acilis_gecikme_bilgisi hata sube=%s tarih=%s: %s", sube_id, tarih, e)
        return None


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

        from evo_sync import hs_rapor_sube_bazli_cached, EVO_SUBE_ID_MAP
        from datetime import date as _d
        y, mo, d = (int(x) for x in str(onceki)[:10].split("-"))
        tarih_d = _d(y, mo, d)
        evo_sonuc = hs_rapor_sube_bazli_cached(tarih_d, tarih_d)

        # FIX T5 (2026-07-06): kırık .lower() substring kopyası (Türkçe İ tuzağı: KÖYCEĞİZ
        # eşleşmiyordu; TEMA=Gazze alias'ı bilinmiyordu) → evo_sync merkezî eşleştirici.
        from evo_sync import _evvel_sube_evo_payload_eslestir as _sube_esle_t5
        evo_sube_payload = (
            _sube_esle_t5(sube_adi_evvel, evo_sonuc.get("subeler") or {})
            if sube_adi_evvel else None
        )

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
    # 14 Oz (büyük) ve 8 Oz (küçük) AYRI boyutlar (karton birleşimi kaldırıldı)
    n3_bardak_buyuk = float(grup_adet["14 Oz"]) if "14 Oz" in grup_adet else None
    n3_bardak_kucuk = float(grup_adet["8 Oz"]) if "8 Oz" in grup_adet else None
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
            boyut="bardak_buyuk",
            n1_aksam=_meta_sayi(n1_meta, "bardak_buyuk"),
            n2_sabah=_meta_sayi(n2_meta, "bardak_buyuk"),
            n3_evo=n3_bardak_buyuk, n3_evo_ikram=None,
        ),
        BoyutVeri(
            boyut="bardak_kucuk",
            n1_aksam=_meta_sayi(n1_meta, "bardak_kucuk"),
            n2_sabah=_meta_sayi(n2_meta, "bardak_kucuk"),
            n3_evo=n3_bardak_kucuk, n3_evo_ikram=None,
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

def otomatik_calistir(cur, sube_id: str, tarih: str) -> Optional[Dict[str, Any]]:
    """Açılış tamamlanınca güvenli otomatik tetik (N2 sabah kör sayım hazır anı).
    HİÇBİR hata fırlatmaz — çağıran akışı (açılış) asla bozmaz. Pasifse/koşul yoksa None.
    read_only modda yalnız append-only truth_motor_kararlar'a yazar; mevcut akışı etkilemez."""
    try:
        if not _global_aktif():
            return None
        if not sube_aktif_mi(cur, sube_id):
            return None
        # İdempotent: aynı gün tekrar tetiklenirse mükerrer karar oluşmasın —
        # o güne ait önceki kararları sil, taze tanı setiyle yeniden yaz.
        try:
            cur.execute(
                "DELETE FROM truth_motor_kararlar WHERE sube_id=%s AND tarih=%s::date",
                (sube_id, str(tarih)),
            )
        except Exception:
            pass
        veriler = veri_topla(cur, sube_id, str(tarih))
        return motor_calistir(cur, sube_id, str(tarih), veriler)
    except Exception as e:
        log.warning("truth_motor otomatik_calistir hata (sube=%s tarih=%s): %s", sube_id, tarih, e)
        return None


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

    # Sprint alt-fonksiyonlarındaki hatalar da burada toplanır (debug — 2026-06)
    karar_hatalari: List[str] = []

    # ── Sprint E: İkram vs Zimmet ayırım sinyalleri ──────────────────────────
    sprint_e_meta: Dict[str, Any] = {}
    try:
        cur.execute("SAVEPOINT sp_e")
        sprint_e_meta = sprint_e_ikram_zimmet_ayir(cur, sube_id, tarih, taniler)
        cur.execute("RELEASE SAVEPOINT sp_e")
    except Exception as _e:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_e")
            cur.execute("RELEASE SAVEPOINT sp_e")
        except Exception:
            pass
        log.warning("sprint_e_ikram_zimmet_ayir hata: %s", _e)
        karar_hatalari.append(f"sprint_e: {_e}")

    # ── Sprint G: Akşamcı N1 Şişirme (cross-day kasa korelasyonu) ───────────
    sprint_g_meta: Dict[str, Any] = {}
    try:
        cur.execute("SAVEPOINT sp_g")
        sprint_g_meta = aksam_kasa_sisirme_tespit(cur, sube_id, tarih)
        if sprint_g_meta.get("tani") == "AKSAM_KASAYI_SISIRDI":
            # Kasa boyutundaki AKSAM_HATALI / COZULMEDI tanısını yükselt
            for _t in taniler:
                if (
                    _t.boyut == "kasa"
                    and _t.tani in ("AKSAM_HATALI", "COZULMEDI", "AKSAM_TOPYEKUN")
                    and _t.fark_n1_n2 is not None
                    and _t.fark_n1_n2 < -0.99   # N2 < N1 → akşamcı fazla beyan
                ):
                    _t.tani = "AKSAM_KASAYI_SISIRDI"
                    _t.guven_skoru = sprint_g_meta["guven"]
                    _t.detay["sprint_g"] = sprint_g_meta
                    if sprint_g_meta.get("aksamci_ad"):
                        _t.detay["aksamci_ad"] = sprint_g_meta["aksamci_ad"]
                    log.info(
                        "sprint_g kasa tanisi yukseltildi sube=%s tarih=%s "
                        "sisirme=%.0f aksamci=%s",
                        sube_id, tarih,
                        sprint_g_meta.get("sisirme_tl", 0),
                        sprint_g_meta.get("aksamci_ad", "?"),
                    )
                    break
        cur.execute("RELEASE SAVEPOINT sp_g")
    except Exception as _e:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_g")
            cur.execute("RELEASE SAVEPOINT sp_g")
        except Exception:
            pass
        log.warning("sprint_g aksam_kasa_sisirme_tespit hata: %s", _e)
        karar_hatalari.append(f"sprint_g: {_e}")

    # ── IPTAL_SUPHE: Sprint G tetiklenmediyse + açıklanamayan kasa açığı ────
    # Sprint G stok açığı bulamadı → AKSAM_KASAYI_SISIRDI yok
    # Ama kasa boyutunda AKSAM_HATALI / COZULMEDI + fark var → iptal fiş şüphesi
    if not sprint_g_meta.get("tani"):
        _diger_stok_sorun = any(
            _t.boyut != "kasa" and _t.tani in (
                "STOK_KACAGI_BEYANSIZ", "ZIMMET_NAKIT_CEPTE",
                "SWEETHEARTING_SINYAL", "AKSAM_ZIMMET_SINYALI", "POS_BYPASS",
            )
            for _t in taniler
        )
        if not _diger_stok_sorun:
            for _t in taniler:
                if (
                    _t.boyut == "kasa"
                    and _t.tani in ("AKSAM_HATALI", "COZULMEDI", "AKSAM_TOPYEKUN")
                    and _t.fark_n1_n2 is not None
                    and _t.fark_n1_n2 < -5.0   # N2 < N1, en az 5₺ fark
                ):
                    _acik = abs(_t.fark_n1_n2)
                    _t.tani = "IPTAL_SUPHE"
                    _t.detay["iptal_suphe"] = {
                        "kasa_acigi_tl": round(_acik, 2),
                        "detay": (
                            f"Kasa {_acik:.0f}₺ açık — Evo'da açıklama yok, stok normal. "
                            "Satış paneli kapalı devre: o vardiya iptal fişlerini manuel kontrol et."
                        ),
                    }
                    log.info(
                        "IPTAL_SUPHE tetiklendi sube=%s tarih=%s acik=%.0f",
                        sube_id, tarih, _acik,
                    )
                    break

    # ── Sprint G.2: Sabahçı N2 düşük beyan (bardak çapraz doğrulama) ─────────
    # SABAH_ZIMMET_SUPHE: kasa boyutunda SABAH_HATALI var ama
    # dün bardak akışı UYUMLU → N1 doğrulandı → sabahçı düşük beyan şüphesi
    sprint_g2_meta: Dict[str, Any] = {}
    try:
        cur.execute("SAVEPOINT sp_g2")
        sprint_g2_meta = sabah_zimmet_suphe_tespit(cur, sube_id, tarih)
        if sprint_g2_meta.get("tani") == "SABAH_ZIMMET_SUPHE":
            for _t in taniler:
                if (
                    _t.boyut == "kasa"
                    and _t.tani in ("SABAH_HATALI", "SABAH_TOPYEKUN", "COZULMEDI")
                    and _t.fark_n1_n2 is not None
                    and _t.fark_n1_n2 < -0.99   # N2 < N1: fark = N2 - N1 < 0 → sabahçı düşük saydı
                ):
                    _t.tani = "SABAH_ZIMMET_SUPHE"
                    _t.guven_skoru = sprint_g2_meta["guven"]
                    _t.detay["sprint_g2"] = sprint_g2_meta
                    if sprint_g2_meta.get("sabahci_ad"):
                        _t.detay["sabahci_ad"] = sprint_g2_meta["sabahci_ad"]
                    log.info(
                        "sprint_g2 sabah_zimmet_suphe tetiklendi sube=%s tarih=%s "
                        "dusuk_beyan=%.0f sabahci=%s",
                        sube_id, tarih,
                        sprint_g2_meta.get("dusuk_beyan_tl", 0),
                        sprint_g2_meta.get("sabahci_ad", "?"),
                    )
                    break
        cur.execute("RELEASE SAVEPOINT sp_g2")
    except Exception as _e:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_g2")
            cur.execute("RELEASE SAVEPOINT sp_g2")
        except Exception:
            pass
        log.warning("sprint_g2 sabah_zimmet_suphe_tespit hata: %s", _e)
        karar_hatalari.append(f"sprint_g2: {_e}")

    # ── Sprint H (C Bendi): Akşam vardiyası bardak P&L (devir→kapanis) ───────
    # Devir anındaki bardak sayısı - kapanis bardak sayısı = akşam fiziksel kullanım
    # Evo saatli filtre (devir_ts→kapanis_ts) ile karşılaştırılır
    # Fiziksel >> Evo tahmini → kayıt dışı satış + nakit zimmet şüphesi
    sprint_h_meta: Dict[str, Any] = {}
    try:
        cur.execute("SAVEPOINT sp_h")
        sprint_h_meta = aksam_vardiya_bardak_pnl(cur, sube_id, tarih)
        if sprint_h_meta.get("tani") == "AKSAM_VARDIYA_BARDAK_ACIK":
            # Önce bardak boyutlarında anomali var mı bak, orayı yükselt
            _upgraded_h = False
            _bardak_yukselt_tanilar = {
                "STOK_KACAGI_BEYANSIZ", "ZIMMET_NAKIT_CEPTE",
                "AKSAM_ZIMMET_SINYALI", "POS_BYPASS",
                "COZULMEDI", "AKSAM_HATALI", "AKSAM_TOPYEKUN",
            }
            for _t in taniler:
                if (
                    _t.boyut in ("bardak_buyuk", "bardak_kucuk", "bardak_plastik")
                    and _t.tani in _bardak_yukselt_tanilar
                ):
                    _t.tani = "AKSAM_VARDIYA_BARDAK_ACIK"
                    _t.guven_skoru = sprint_h_meta["guven"]
                    _t.detay["sprint_h"] = sprint_h_meta
                    if sprint_h_meta.get("aksamci_ad"):
                        _t.detay["aksamci_ad"] = sprint_h_meta["aksamci_ad"]
                    _upgraded_h = True
            if _upgraded_h:
                log.info(
                    "sprint_h aksam_vardiya_bardak_acik tetiklendi sube=%s tarih=%s "
                    "karton_acik=%.0f plastik_acik=%.0f aksamci=%s",
                    sube_id, tarih,
                    sprint_h_meta.get("karton_acik", 0),
                    sprint_h_meta.get("plastik_acik", 0),
                    sprint_h_meta.get("aksamci_ad", "?"),
                )
            else:
                # Günlük bardak analizi UYUMLU ama shift-level anomali → kasa boyutuna not ekle
                for _t in taniler:
                    if _t.boyut == "kasa":
                        _t.detay["sprint_h_uyari"] = (
                            f"Akşam vardiyası bardak açığı tespit edildi "
                            f"(karton {sprint_h_meta.get('karton_acik', 0):.0f} + "
                            f"plastik {sprint_h_meta.get('plastik_acik', 0):.0f} adet)"
                        )
                        break
        cur.execute("RELEASE SAVEPOINT sp_h")
    except Exception as _e:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_h")
            cur.execute("RELEASE SAVEPOINT sp_h")
        except Exception:
            pass
        log.warning("sprint_h aksam_vardiya_bardak_pnl hata: %s", _e)
        karar_hatalari.append(f"sprint_h: {_e}")

    # ── Sprint J — Cross-day Bardak Devamlılık Kontrolü ──────────────────────
    # Akşamcı dün KAPANIS'ta bardağı şişirdiyse sabahçı bugün gerçeği sayar.
    # Gece arası bardak kaybolmaz → dün_kapanis > bugün_acilis → AKSAM_BARDAK_SISIRDI.
    # Cross-sinyal: Aynı gün N1>N2 kasa açığı da varsa → akşamcı hem kasa hem bardak şişirdi.
    sprint_j_meta: Dict[str, Any] = {}
    try:
        cur.execute("SAVEPOINT sp_j")
        sprint_j_meta = aksam_bardak_sisirme_tespit(cur, sube_id, tarih)
        if sprint_j_meta.get("tani") == "AKSAM_BARDAK_SISIRDI":
            _upgraded_j = False
            _bardak_j_yukselt = {
                "AKSAM_HATALI", "AKSAM_TOPYEKUN",
                "STOK_KACAGI_BEYANSIZ", "ZIMMET_NAKIT_CEPTE",
                "AKSAM_ZIMMET_SINYALI", "POS_BYPASS",
                "COZULMEDI", "AKSAM_KASAYI_SISIRDI",
            }
            for _t in taniler:
                if (
                    _t.boyut in ("bardak_buyuk", "bardak_kucuk", "bardak_plastik")
                    and _t.tani in _bardak_j_yukselt
                ):
                    _t.tani = "AKSAM_BARDAK_SISIRDI"
                    _t.guven_skoru = sprint_j_meta["guven"]
                    _t.detay["sprint_j"] = sprint_j_meta
                    if sprint_j_meta.get("aksamci_ad"):
                        _t.detay["aksamci_ad"] = sprint_j_meta["aksamci_ad"]
                    _upgraded_j = True
            if _upgraded_j:
                log.info(
                    "sprint_j aksam_bardak_sisirdi tetiklendi sube=%s tarih=%s "
                    "gece_karton=%.0f gece_plastik=%.0f aksamci=%s",
                    sube_id, tarih,
                    sprint_j_meta.get("gece_karton_kaybi", 0),
                    sprint_j_meta.get("gece_plastik_kaybi", 0),
                    sprint_j_meta.get("aksamci_ad", "?"),
                )
            else:
                # Bardak tanısı yok ama cross-day anomali var → kasa boyutuna not ekle
                for _t in taniler:
                    if _t.boyut == "kasa":
                        _t.detay["sprint_j_uyari"] = (
                            f"Dün akşamcı bardak şişirme sinyali: "
                            f"karton {sprint_j_meta.get('gece_karton_kaybi', 0):.0f} + "
                            f"plastik {sprint_j_meta.get('gece_plastik_kaybi', 0):.0f} adet gece eridi"
                        )
                        break
        cur.execute("RELEASE SAVEPOINT sp_j")
    except Exception as _e:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_j")
            cur.execute("RELEASE SAVEPOINT sp_j")
        except Exception:
            pass
        log.warning("sprint_j aksam_bardak_sisirme_tespit hata: %s", _e)
        karar_hatalari.append(f"sprint_j: {_e}")

    # ── Sprint K: COZULMEDI boyutları için otomatik Truth Walk re-check ──────
    # Bugünkü açılış sayımı geldiğinde, COZULMEDI olarak işaretlenmiş boyutlar
    # adaptive_truth_walk ile yeniden değerlendirilir. Eğer akşamcı→sabahcı
    # zinciri tutarlıysa (fark dünden geliyor) → AKSAMCI_SAYIM_HATASI'a çevrilir,
    # 3. kişi sayımı/ikram araştırması istenmez.
    for _t in taniler:
        if _t.tani != "COZULMEDI":
            continue
        try:
            cur.execute("SAVEPOINT sp_k")
            _walk = adaptive_truth_walk(cur, sube_id, tarih, _t.boyut)
            if _walk.get("karar") == "AKSAMCI_SAYIM_HATASI":
                _t.tani = "AKSAMCI_SAYIM_HATASI"
                _t.guven_skoru = _walk.get("guven", _t.guven_skoru)
                _t.detay["sprint_k_truth_walk"] = {
                    "ozet": _walk.get("ozet"),
                    "aksam_fark": _walk.get("aksam_fark"),
                    "sabah_fark_v1": _walk.get("sabah_fark_v1"),
                }
                # Sorumlu kişi(ler): birincil sorumlu = dünkü KAPANIS'ı QR ile
                # mühürleyen kişi (n1_aksam beyanını o verdi). Aynı akşam
                # vardiyasında bulunup mührü basmayan diğer personel de
                # ikincil sorumlu olarak işaretlenir (personel_risk_sinyal_uret
                # bunu yarım ağırlıkla yazar).
                _onceki_tarih = _previous_day(tarih)
                _primary_ad = None
                try:
                    cur.execute(
                        """
                        SELECT personel_ad FROM sube_operasyon_event
                        WHERE sube_id=%s AND tarih=%s::date AND tip='KAPANIS' AND durum='tamamlandi'
                        ORDER BY cevap_ts DESC NULLS LAST LIMIT 1
                        """,
                        (sube_id, _onceki_tarih),
                    )
                    _kr = cur.fetchone()
                    if _kr:
                        _primary_ad = (dict(_kr).get("personel_ad") or "").strip() or None
                except Exception:
                    _primary_ad = None

                _vardiya_dun = _walk.get("vardiya_dun") or {}
                _tum_adlar = set()
                for _ara in (_vardiya_dun.get("tek_basina_araliklari") or []) + \
                             (_vardiya_dun.get("coklu_araliklari") or []):
                    if _ara.get("personel_ad"):
                        _tum_adlar.add(_ara["personel_ad"])
                    for _p in _ara.get("personeller") or []:
                        _ad2 = _p.get("ad") or _p.get("personel_ad")
                        if _ad2:
                            _tum_adlar.add(_ad2)

                if not _primary_ad and len(_vardiya_dun.get("tek_basina_araliklari") or []) == 1 \
                        and not (_vardiya_dun.get("coklu_araliklari") or []):
                    _primary_ad = _vardiya_dun["tek_basina_araliklari"][-1].get("personel_ad")

                if _primary_ad:
                    _t.detay["aksamci_ad"] = _primary_ad
                    _diger = sorted(a for a in _tum_adlar if a and a != _primary_ad)
                    if _diger:
                        _t.detay["aksamci_diger_adlar"] = _diger
                log.info(
                    "sprint_k aksamci_sayim_hatasi tetiklendi sube=%s tarih=%s boyut=%s",
                    sube_id, tarih, _t.boyut,
                )
            cur.execute("RELEASE SAVEPOINT sp_k")
        except Exception as _e:
            try:
                cur.execute("ROLLBACK TO SAVEPOINT sp_k")
                cur.execute("RELEASE SAVEPOINT sp_k")
            except Exception:
                pass
            log.warning("sprint_k adaptive_truth_walk hata sube=%s boyut=%s: %s",
                        sube_id, _t.boyut, _e)
            karar_hatalari.append(f"sprint_k:{_t.boyut}: {_e}")

    # ── Sprint M: Geç açılış bağlamı ─────────────────────────────────────────
    # Bugünkü sabahçı planlanan saatten geç açtıysa, bu durum sabah sayımının
    # baskı altında yapılmış olabileceğine işaret eder. Sabahçıyı ilgilendiren
    # anomalilere (SABAH_*, COZULMEDI, AKSAMCI_SAYIM_HATASI vb.) bu bağlamı
    # ekliyoruz; ayrıca geç açılışın kendisi için ayrı, düşük ağırlıklı bir
    # "eğitim/dikkat" risk sinyali yazılır (zimmet sinyaliyle karıştırılmaz).
    try:
        cur.execute("SAVEPOINT sp_m")
        _gecikme = _acilis_gecikme_bilgisi(cur, sube_id, tarih)

        # Sabahçıyı ilgilendiren anomali var mı? (öğrenme defterinin SONUÇ'u)
        _sabah_anomali_tani = None
        for _t in taniler:
            if _t.boyut != "kasa" and _t.tani not in ("UYUMLU", "YETERSIZ_VERI"):
                _sabah_anomali_tani = _t.tani
                break
        _sonuc_anomali = _sabah_anomali_tani is not None

        # ── Ham gözlem kaydı (öğrenme defteri) ──────────────────────────────
        # Açılış event'i varsa HER GÜN kaydet — hem geç hem zamanında açılan
        # günler 2x2 analizine girsin. EŞİK UYGULANMAZ; kosul_siddet = ham
        # gecikme dk (sonra istenen eşikle yeniden değerlendirilebilir).
        if _gecikme is not None:
            _gec_dk = _gecikme["gecikme_dk"]
            _sabah_pid = _personel_id_by_ad(cur, _gecikme.get("personel_ad"), tarih) \
                if _gecikme.get("personel_ad") else None
            hipotez_gozlem_kaydet(
                cur, "gec_acilis", sube_id, tarih,
                kosul_var=(_gec_dk > 0),
                sonuc_anomali=_sonuc_anomali,
                kosul_siddet=_gec_dk,
                sonuc_tani=_sabah_anomali_tani,
                personel_id=_sabah_pid,
                detay={
                    "planlanan_saat": _gecikme.get("planlanan_saat"),
                    "gercek_saat": _gecikme.get("gercek_saat"),
                    "personel_ad": _gecikme.get("personel_ad"),
                },
            )

        # ── Bağlam notu + risk sinyali (mevcut davranış, eşik bazlı) ────────
        # NOT: 15dk eşiği geçici/sezgisel — öğrenme defteri yeterli veri
        # biriktirince (≥~25 olay) bu eşik veriyle değiştirilecek.
        if _gecikme and _gecikme["gecikme_dk"] > _GEC_ACILIS_ESIK_DK:
            for _t in taniler:
                if _t.boyut != "kasa" and _t.tani not in ("UYUMLU", "YETERSIZ_VERI"):
                    _t.detay["sabahci_gec_acilis"] = _gecikme
            if _gecikme.get("personel_ad"):
                _pid = _personel_id_by_ad(cur, _gecikme["personel_ad"], tarih)
                if _pid:
                    _agirlik_m = max(1, min(10, round(_gecikme["gecikme_dk"] / 10)))
                    _risk_sinyal_yaz(
                        cur, _pid, sube_id, tarih,
                        "truth_motor_gec_acilis", _agirlik_m,
                        f"Açılış {_gecikme['gecikme_dk']:.0f} dk gecikmeli "
                        f"(planlanan {_gecikme.get('planlanan_saat') or '?'}, "
                        f"gerçek {_gecikme.get('gercek_saat') or '?'})",
                        f"tm:{sube_id}:{tarih}:gec_acilis",
                    )
        cur.execute("RELEASE SAVEPOINT sp_m")
    except Exception as _e:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_m")
            cur.execute("RELEASE SAVEPOINT sp_m")
        except Exception:
            pass
        log.warning("sprint_m gec_acilis hata sube=%s tarih=%s: %s", sube_id, tarih, _e)
        karar_hatalari.append(f"sprint_m: {_e}")

    # Eylem önerisi enjekte et
    for t in taniler:
        t.detay["eylem"] = eylem_oner(t.tani)

    # Log'a yaz
    kaydedildi = kararlari_kaydet(cur, taniler, karar_hatalari)

    # ─── Personel risk sinyalleri — CFO/operasyon tarafı için (personel görmez) ───
    try:
        personel_risk_sinyal_uret(cur, sube_id, tarih, taniler)
    except Exception as _e:
        log.warning("personel_risk_sinyal_uret hata sube=%s tarih=%s: %s", sube_id, tarih, _e)

    # ─── KASA BASKINI OTOMATİK TETİK ───
    # SWEETHEARTING veya AKSAM_ZIMMET → otomatik baskın öner (apply modunda hemen başlat)
    baskin_tetik = otomatik_baskin_tetik(cur, sube_id, tarih, taniler, mod)

    # Şube ayar son_calisma güncelle
    try:
        cur.execute("SAVEPOINT sp_son_calisma")
        cur.execute(
            "UPDATE truth_motor_ayar SET son_calisma=NOW() WHERE sube_id=%s",
            (sube_id,),
        )
        cur.execute("RELEASE SAVEPOINT sp_son_calisma")
    except Exception as _e:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_son_calisma")
            cur.execute("RELEASE SAVEPOINT sp_son_calisma")
        except Exception:
            pass
        log.warning("truth_motor_ayar güncelleme başarısız sube=%s: %s", sube_id, _e)

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
        "karar_hatalari": karar_hatalari,
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
        # Sprint G — cross-day akşamcı N1 şişirme
        "sprint_g": sprint_g_meta,
        # Sprint G.2 — sabahçı N2 düşük beyan (bardak doğrulama)
        "sprint_g2": sprint_g2_meta,
        # Sprint H (C Bendi) — akşam vardiyası bardak P&L (devir→kapanis)
        "sprint_h": sprint_h_meta,
        # Sprint J — cross-day bardak devamlılık (dün KAPANIS → bugün ACILIS)
        "sprint_j": sprint_j_meta,
    }


# ════════════════════════════════════════════════════════════════════════════
#  Sprint L — Evo gecikmeli veri telafisi
#  Gece 00:30 motoru çalıştığında Evo henüz veri vermemiş olabilir (n3_evo=NULL).
#  Evo verisi sonradan (gün içinde) geldiğinde, bu fonksiyon son birkaç günün
#  "n3_evo eksik" kalmış kararlarını bulup motoru o gün için tekrar çalıştırır.
#  truth_motor_kararlar append-only olduğu için yeni satır eklenir, panel/WhatsApp
#  zaten en güncel (olusturma DESC) satırı okuyor.
# ════════════════════════════════════════════════════════════════════════════

_EVO_URUN_BOYUTLARI = ("bardak_plastik", "bardak_buyuk", "bardak_kucuk", "redbull_soda", "pasta")


def evo_eksik_gunleri_yeniden_degerlendir(cur, sube_id: str, gun_sayisi: int = 3) -> List[str]:
    """Son `gun_sayisi` gün içinde Evo verisi (n3_evo) eksik kalmış ürün
    boyutlarını bulur. Evo verisi artık geldiyse (n3_evo dolu çıkarsa) o gün
    için motoru yeniden çalıştırır, böylece COZULMEDI/YETERSIZ_VERI gibi
    "Evo verisi yoktu" yüzünden verilmiş kararlar düzeltilir.

    Returns: yeniden değerlendirilen tarihlerin listesi (YYYY-MM-DD).
    """
    duzeltilen_tarihler: List[str] = []
    try:
        cur.execute(
            """
            SELECT DISTINCT tarih::text AS tarih
            FROM (
                SELECT tarih, boyut, n3_evo,
                       ROW_NUMBER() OVER (PARTITION BY tarih, boyut ORDER BY olusturma DESC) AS rn
                FROM truth_motor_kararlar
                WHERE sube_id=%s
                  AND tarih >= CURRENT_DATE - (%s || ' days')::interval
                  AND tarih < CURRENT_DATE
                  AND boyut = ANY(%s)
            ) x
            WHERE rn = 1 AND n3_evo IS NULL
            ORDER BY 1
            """,
            (sube_id, gun_sayisi, list(_EVO_URUN_BOYUTLARI)),
        )
        eksik_tarihler = [dict(r)["tarih"] for r in (cur.fetchall() or [])]
    except Exception as e:
        log.warning("sprint_l evo_eksik tarama hata sube=%s: %s", sube_id, e)
        return duzeltilen_tarihler

    for _tarih in eksik_tarihler:
        try:
            cur.execute("SAVEPOINT sp_evo_eksik")
            _veriler = veri_topla(cur, sube_id, _tarih)
            _evo_geldi = any(
                v.n3_evo is not None for v in _veriler if v.boyut in _EVO_URUN_BOYUTLARI
            )
            if _evo_geldi:
                motor_calistir(cur, sube_id, _tarih, _veriler)
                duzeltilen_tarihler.append(_tarih)
                log.info("sprint_l evo_eksik_telafi sube=%s tarih=%s", sube_id, _tarih)
            cur.execute("RELEASE SAVEPOINT sp_evo_eksik")
        except Exception as e:
            try:
                cur.execute("ROLLBACK TO SAVEPOINT sp_evo_eksik")
                cur.execute("RELEASE SAVEPOINT sp_evo_eksik")
            except Exception:
                pass
            log.warning("sprint_l evo_eksik_telafi hata sube=%s tarih=%s: %s", sube_id, _tarih, e)

    return duzeltilen_tarihler


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
    "bardak_buyuk":    ["14 Oz"],
    "bardak_kucuk":    ["8 Oz"],
    "redbull_soda":    ["Redbull", "Maden Suyu"],
    "pasta":           ["Pasta"],
    "su":              ["Su"],
}

# Boyut → şube meta JSON anahtarı mapping
_BOYUT_META = {
    "kasa":            [],  # özel
    "bardak_plastik":  ["bardak_plastik"],
    "bardak_buyuk":    ["bardak_buyuk"],
    "bardak_kucuk":    ["bardak_kucuk"],
    "redbull_soda":    ["redbull_adet", "soda_adet"],
    "pasta":           ["pasta_adet"],
    "su":              ["su_adet"],
}


def _evo_sube_grup_satis(cur, sube_id: str, tarih: str) -> Dict[str, float]:
    """Bir şubenin verilen tarihteki Evo grup satışları (Ice, 14 Oz, vs).
    hs_rapor_sube_bazli'ı çağırır; sube_id (Evvel UUID) → şube_adi eşleştirme."""
    try:
        cur.execute("SAVEPOINT sp_evogrup")
        cur.execute("SELECT ad FROM subeler WHERE id::text=%s", (str(sube_id),))
        srow = cur.fetchone()
        sube_adi_evvel = str(dict(srow).get("ad") or "") if srow else ""
        cur.execute("RELEASE SAVEPOINT sp_evogrup")
        from evo_sync import hs_rapor_sube_bazli_cached
        from datetime import date as _d
        y, mo, dn = (int(x) for x in str(tarih)[:10].split("-"))
        tarih_d = _d(y, mo, dn)
        evo = hs_rapor_sube_bazli_cached(tarih_d, tarih_d)
        # FIX T5 (2026-07-06): kırık .lower() substring → evo_sync merkezî eşleştirici
        from evo_sync import _evvel_sube_evo_payload_eslestir as _sube_esle_t5
        payload = _sube_esle_t5(sube_adi_evvel, evo.get("subeler") or {})
        if payload:
            gruplar = {}
            for g, v in (payload.get("gruplar") or {}).items():
                gruplar[g] = float(v.get("adet") or 0)
            gruplar["_nakit"] = float(payload.get("nakit") or 0)
            gruplar["_kart"] = float(payload.get("kart") or 0)
            gruplar["_ciro"] = float(payload.get("ciro_toplam") or 0)
            gruplar["_evo_canli"] = 1.0 if evo.get("canli") else 0.0
            return gruplar
    except Exception as e:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_evogrup")
            cur.execute("RELEASE SAVEPOINT sp_evogrup")
        except Exception:
            pass
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
        cur.execute("SAVEPOINT sp_urunac")
        cur.execute(
            """
            SELECT kalemler_json FROM urun_ac_taslak
            WHERE sube_id=%s AND tarih=%s::date AND durum='aktif'
            """,
            (sube_id, tarih),
        )
        rows = [dict(r) for r in (cur.fetchall() or [])]
        cur.execute("RELEASE SAVEPOINT sp_urunac")
    except Exception:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_urunac")
            cur.execute("RELEASE SAVEPOINT sp_urunac")
        except Exception:
            pass
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
        "bardak_buyuk":   60.0,
        "bardak_kucuk":   50.0,
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
        "bardak_buyuk": "14oz bardak", "bardak_kucuk": "8oz bardak", "redbull_soda": "RedBull/soda",
        "pasta": "pasta dilimi",
    }
    KARAR_TR = {
        "AKSAMCI_HATALI": "akşamcı hatalı saydı",
        "AKSAMCI_SAYIM_HATASI": "akşamcının kapanış sayımı hatalı (dünden gelen fark)",
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
    elif karar == "AKSAMCI_SAYIM_HATASI":
        parcalar.append(
            f"Bugünkü {boyut_tr} zinciri (akşamcı {aksamci_beyan:.0f} → sabahcı) tutarlı "
            f"(fark {sabah_fark_v1:+.0f}) — asıl fark dünden geliyor, akşamcı "
            f"{aksamci_beyan:.0f} beyan etti ama matematik {beklenen_aksam:.0f} "
            f"bekliyordu (fark {aksam_fark:+.0f}). Muhtemelen akşamcının kapanış "
            "sayımında hata var, zimmet değil."
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
        "dusuk" if karar == "AKSAMCI_SAYIM_HATASI"
        else "kritik" if final_guven >= 90 and karar in (
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
        boyut: 'kasa' | 'bardak_plastik' | 'bardak_buyuk' | 'bardak_kucuk' | 'redbull_soda' | 'pasta' | 'su'

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
    # Kasa farkında ±5 TL "önemsiz" sayılır (sayım/yuvarlama payı) — _TOLERANS["kasa"]
    tolerans = _TOLERANS.get(boyut, 0.5)
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
    elif not aksamci_dogru and not sabahci_dogru_v1 and not sabahci_dogru_v2 \
            and abs(sabah_fark_v1) <= max(tolerans, 1):
        # Bugünkü zincir (akşamcı→sabahcı) kendi içinde tutarlı (sabah_fark_v1 ≈ 0) —
        # asıl uyumsuzluk dünden geliyor (akşamcı beyanı ≠ türetilmiş akşam).
        # EN OLASI açıklama: akşamcının kapanış sayımı hatalı yazılmış (kasıtlı
        # değil). AMA bu bir BERAAT DEĞİL — consistency engine yalnızca tutarlılığı
        # ölçer; tutarlı bir yalan da bu desene uyabilir. Alarm kapatılmaz, düşük
        # önceliğe alınır; doğrulanana kadar zimmet ihtimali elenmez.
        karar = "AKSAMCI_SAYIM_HATASI"
        guven = 85.0
        ozet = (f"Bugünkü zincir tutarlı (akşamcı beyanı {aksamci_beyan:.0f} → sabahcı {sabahci_beyan:.0f}, "
                f"fark {sabah_fark_v1:+.0f} — normal sapma). Asıl fark dünden geliyor: "
                f"akşamcının kapanış sayımı {aksamci_beyan:.0f}, matematik {beklenen_aksam:.0f} olmasını "
                f"bekliyordu (fark {aksam_fark:+.0f}). EN OLASI açıklama akşamcının kapanış "
                f"sayım hatası — ama doğrulanana kadar zimmet ihtimali elenmez, alarm kapatılmaz.")
        oneriler = [
            "Düşük öncelik: dünkü (akşamcı) kapanış sayımını sıraya al — en olası açıklama sayım/yazım hatası.",
            "Acil 3. kişi sayımı gerekmiyor; ama tekrarlarsa veya başka sinyal eşlik ederse zimmet ihtimali yeniden değerlendirilmeli.",
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

    # FIX T1 (2026-07-05): K2/K3 delta'sı BURADA eklenmez. K7 Bayesian konsensüs (aşağıda, "tüm
    # kanıt katmanlarını birleştiren TEK toplama noktası") zaten guven_base üstüne K2 prior
    # (+10/+5) ve K3 sistematik (+15/+8) delta'sını ekliyor — K2/K3'ün ürettiği guven_delta ile
    # BİREBİR AYNI değerler. Burada bir kez daha toplamak ÇİFTE SAYIMDI (kronik 7 gün → +30 yerine
    # +15 olmalı) → sınır vakaları hak etmediği "kritik" alarma yükseliyordu. guven K0-sonrası ham kalır;
    # k6 (NLP açıklama) bunu ön-değerlendirme olarak görür, FİNAL güven K7'den gelir.

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
        # FIX T5 (2026-07-06): kırık .lower() substring → evo_sync merkezî id eşleştirici
        from evo_sync import evvel_sube_evo_id_eslestir
        evo_sube_id = evvel_sube_evo_id_eslestir(sube_adi_evvel)
    except Exception as _e:
        log.warning("evo_sync import veya şube eşleştirme başarısız sube=%s: %s", sube_id, _e)

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
        from evo_sync import hs_rapor_sube_bazli_cached
        from datetime import date as _d
        y, mo, dn = (int(x) for x in str(tarih)[:10].split("-"))
        tarih_d = _d(y, mo, dn)
        evo = hs_rapor_sube_bazli_cached(tarih_d, tarih_d)
        # FIX T5 (2026-07-06): kırık .lower() substring → evo_sync merkezî eşleştirici
        from evo_sync import _evvel_sube_evo_payload_eslestir as _sube_esle_t5
        payload = _sube_esle_t5(sube_adi_evvel, evo.get("subeler") or {})
        if payload:
            for g, v in (payload.get("gruplar") or {}).items():
                evo_gruplar[g] = float(v.get("adet") or 0)
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
            -- ARŞİV FİLTRESİ (2026-08-10): ekstre içe aktarmanın ürettiği eski
            -- gider satırları durum='arsiv' oldu. Bu motor personel bazlı anomali
            -- arıyor; arşiv satırlarının personeli yok (MERKEZ) ve NULL grubunda
            -- birikip sahte "tekrar eden gider" alarmı üretirdi.
            WHERE COALESCE(durum,'aktif') = 'aktif'
              AND tarih >= CURRENT_DATE - (%s || ' days')::interval
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
                WHERE COALESCE(durum,'aktif') = 'aktif'
                  AND personel_id=%s AND kategori=%s
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
    "bardak_buyuk":   60.0,
    "bardak_kucuk":   50.0,
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
        cur.execute("SAVEPOINT sp_fire")
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
        cur.execute("RELEASE SAVEPOINT sp_fire")
    except Exception as e:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_fire")
            cur.execute("RELEASE SAVEPOINT sp_fire")
        except Exception:
            pass
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
        cur.execute("SAVEPOINT sp_iptal1")
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
        cur.execute("RELEASE SAVEPOINT sp_iptal1")
    except Exception:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_iptal1")
            cur.execute("RELEASE SAVEPOINT sp_iptal1")
        except Exception:
            pass

    # kasa_hareketleri fallback
    if sonuc["iptal_toplam"] == 0:
        try:
            cur.execute("SAVEPOINT sp_iptal2")
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
            cur.execute("RELEASE SAVEPOINT sp_iptal2")
        except Exception:
            try:
                cur.execute("ROLLBACK TO SAVEPOINT sp_iptal2")
                cur.execute("RELEASE SAVEPOINT sp_iptal2")
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
        cur.execute("SAVEPOINT sp_velocity")
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
        cur.execute("RELEASE SAVEPOINT sp_velocity")
    except Exception as e:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_velocity")
            cur.execute("RELEASE SAVEPOINT sp_velocity")
        except Exception:
            pass
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
            cur.execute("SAVEPOINT sp_velocity2")
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
            cur.execute("RELEASE SAVEPOINT sp_velocity2")
        except Exception:
            try:
                cur.execute("ROLLBACK TO SAVEPOINT sp_velocity2")
                cur.execute("RELEASE SAVEPOINT sp_velocity2")
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


# ════════════════════════════════════════════════════════════════════════════
#  SPRINT F — QSR BÜYÜK ZİNCİR SENARYO KÜTÜPHANESİ
#  McDonald's / Starbucks / Domino's kaynaklı kanıtlanmış fraud pattern'leri
#
#  1. sut_sapma_analiz()     → Starbucks süt cross-reference (QSR evrensel sinyal)
#  2. sahte_fire_tespiti()   → Waste Manipulation (McD / Starbucks #1 kör nokta)
#  3. bom_sapma_tani()       → BOM varyans → kayıt dışı sarf tanısı
# ════════════════════════════════════════════════════════════════════════════

# Süt BOM — litre/satış (kullanıcı onaylı değerler 2026-05-21)
SUT_BOM: Dict[str, float] = {
    "14 Oz": 0.23,   # büyük karton kahve → 230ml (latte, cappuccino, vb.)
    "8 Oz":  0.18,   # küçük karton kahve → 180ml
    # Ice grubu: iced latte (süt var) + frozen (püreli, süt yok) karışık →
    # bireysel hesaba dahil edilmiyor; %30 sapma eşiği bu toleransı karşılar.
    # Milkshake: Evo'da ayrı grup yok → teorik'te yok, eşiğe gömülü.
}

# Süt sapma eşiği: %30 — milkshake + iced latte + ölçüm toleransı için buffer
SUT_SAPMA_ESIK_YZ = 30.0

# Sahte fire tespiti — zamanlama eşiği: kapanış öncesi kaç dakika?
SAHTE_FIRE_KAPANIS_DK = 45   # kapanış öncesi 45dk içindeyse şüpheli


def _meta_sut_bul(stok: Dict[str, Any]) -> Optional[float]:
    """Stok sayım dict'inden süt değerini bul (çoklu anahtar denemesi)."""
    for key in ("sut", "süt", "sut_litre", "süt_litre", "milk", "full_fat_milk",
                "sut_lt", "süt_lt"):
        v = stok.get(key)
        if v is not None:
            try:
                return float(v)
            except (TypeError, ValueError):
                pass
    return None


def _is_sut_key(key: str) -> bool:
    """URUN_AC kalemler_json anahtarının süt olup olmadığını kontrol et."""
    k = str(key).lower().strip()
    return k in ("sut", "süt", "sut_litre", "süt_litre", "milk",
                 "full_fat_milk", "sut_lt", "süt_lt")


def sut_sapma_analiz(cur, sube_id: str, tarih: str) -> Dict[str, Any]:
    """Sprint F / Signal 1 — Süt çapraz referans analizi (Starbucks pattern).

    Formül:
      gercek_tuketim = acilis_sut + urun_ac_sut − kapanis_sut
      teorik_tuketim = (14oz_satis × 0.23L) + (8oz_satis × 0.18L)
      sapma_yuzde    = (gercek − teorik) / gercek × 100

    Eşik: %30 (milkshake + iced latte + ölçüm buffer)

    Returns dict: tani, sapma_litre, sapma_yuzde, gercek/teorik, yorum
    """
    sonuc: Dict[str, Any] = {
        "acilis_sut": None,
        "kapanis_sut": None,
        "urun_ac_sut": 0.0,
        "gercek_tuketim": None,
        "teorik_tuketim": 0.0,
        "sapma_litre": None,
        "sapma_yuzde": None,
        "tani": "VERI_YOK",
        "yorum": "Süt sayım verisi bulunamadı",
    }

    # 1. ACILIS süt stoku
    try:
        cur.execute(
            """SELECT meta FROM sube_operasyon_event
               WHERE sube_id=%s AND tarih=%s::date AND tip='ACILIS'
                 AND durum='tamamlandi'
               ORDER BY cevap_ts DESC NULLS LAST LIMIT 1""",
            (sube_id, tarih),
        )
        r = cur.fetchone()
        if r:
            m = _meta_oku(dict(r)["meta"])
            v = _meta_sut_bul(m.get("acilis_stok_sayim") or {})
            if v is not None:
                sonuc["acilis_sut"] = v
    except Exception as e:
        log.warning("sut_sapma acilis hata: %s", e)

    # 2. KAPANIS süt stoku
    try:
        cur.execute(
            """SELECT meta FROM sube_operasyon_event
               WHERE sube_id=%s AND tarih=%s::date AND tip='KAPANIS'
                 AND durum='tamamlandi'
               ORDER BY cevap_ts DESC NULLS LAST LIMIT 1""",
            (sube_id, tarih),
        )
        r = cur.fetchone()
        if r:
            m = _meta_oku(dict(r)["meta"])
            v = _meta_sut_bul(m.get("kapanis_stok_sayim") or {})
            if v is not None:
                sonuc["kapanis_sut"] = v
    except Exception as e:
        log.warning("sut_sapma kapanis hata: %s", e)

    # 3. URUN_AC süt girişi (gün içi açılan stok)
    try:
        cur.execute(
            """SELECT kalemler_json FROM urun_ac_taslak
               WHERE sube_id=%s AND tarih=%s::date AND durum='aktif'""",
            (sube_id, tarih),
        )
        for rr in (cur.fetchall() or []):
            kj = dict(rr).get("kalemler_json")
            if isinstance(kj, str):
                try:
                    kj = json.loads(kj)
                except Exception:
                    kj = {}
            if isinstance(kj, dict):
                for k, v in kj.items():
                    if _is_sut_key(k):
                        try:
                            sonuc["urun_ac_sut"] += float(v or 0)
                        except (TypeError, ValueError):
                            pass
    except Exception as e:
        log.warning("sut_sapma urun_ac hata: %s", e)

    # 4. Teorik süt tüketimi (Evo satış × BOM)
    try:
        evo_gruplar = _evo_sube_grup_satis(cur, sube_id, tarih)
        teorik = sum(
            float(evo_gruplar.get(grup) or 0) * bom_lt
            for grup, bom_lt in SUT_BOM.items()
        )
        sonuc["teorik_tuketim"] = round(teorik, 3)
    except Exception as e:
        log.warning("sut_sapma teorik hata: %s", e)

    # 5. Sapma hesapla
    if sonuc["acilis_sut"] is None or sonuc["kapanis_sut"] is None:
        return sonuc   # VERI_YOK

    gercek = round(
        float(sonuc["acilis_sut"]) + float(sonuc["urun_ac_sut"])
        - float(sonuc["kapanis_sut"]),
        3,
    )
    sonuc["gercek_tuketim"] = gercek

    if gercek <= 0:
        sonuc["yorum"] = "Süt tüketimi sıfır/negatif — veri hatası olabilir"
        return sonuc

    sapma = round(gercek - sonuc["teorik_tuketim"], 3)
    sapma_yz = round(sapma / gercek * 100, 1)
    sonuc["sapma_litre"] = sapma
    sonuc["sapma_yuzde"] = sapma_yz

    if sapma_yz > SUT_SAPMA_ESIK_YZ:
        sonuc["tani"] = "SUT_SAPMA"
        sonuc["yorum"] = (
            f"Gerçek süt tüketimi {gercek:.2f}L — teorik {sonuc['teorik_tuketim']:.2f}L. "
            f"Açıklanamayan {sapma:.2f}L (%{sapma_yz:.0f}) — "
            "aşırı porsiyonlama veya kayıt dışı ürün üretimi."
        )
    else:
        sonuc["tani"] = "SUT_UYUMLU"
        sonuc["yorum"] = (
            f"Süt tüketimi {gercek:.2f}L — teorik {sonuc['teorik_tuketim']:.2f}L "
            f"(%{sapma_yz:.0f} sapma) — normal aralıkta."
        )

    return sonuc


def sahte_fire_tespiti(cur, sube_id: str, tarih: str,
                       fire_sonuc: Optional[Dict] = None) -> Dict[str, Any]:
    """Sprint F / Signal 2 — Sahte fire kaydı tespiti (Waste Manipulation).

    Sprint E, fire kaydı varsa BELGELENMIS der ve bırakır.
    Bu fonksiyon o kararı SORGULAR:

    Şüphe sinyalleri:
      1. Zamanlama: fire kaydı kapanış öncesi 45dk içinde → kapanışta oluşturulmuş
      2. Tam eşleşme: fire adet = stok açığı ile birebir uyuşuyor (çok mükemmel)
      3. Sıklık: bu personel son 7 günde >3 fire kaydı yazmış

    Eğer ≥2 sinyal → SAHTE_FIRE_KAYDI tanısı.

    Returns:
        {
          "sinyaller": [...],
          "sinyal_sayisi": int,
          "tani": "SAHTE_FIRE_KAYDI" | "FIRE_GUVENLIR" | "VERI_YOK",
          "yorum": str,
        }
    """
    sonuc: Dict[str, Any] = {
        "sinyaller": [],
        "sinyal_sayisi": 0,
        "tani": "VERI_YOK",
        "yorum": "Fire kaydı yok veya veri yetersiz",
    }

    if fire_sonuc is None:
        try:
            fire_sonuc = fire_bildirim_capraz(cur, sube_id, tarih)
        except Exception:
            return sonuc

    if not fire_sonuc.get("fire_kayit_var"):
        sonuc["tani"] = "FIRE_YOK"
        sonuc["yorum"] = "Fire kaydı yok — sahte fire analizi uygulanamaz"
        return sonuc

    sinyaller = []

    # ── Sinyal 1: Zamanlama — kapanış öncesi 45dk içinde mi? ────────────────
    try:
        cur.execute(
            """SELECT cevap_ts FROM sube_operasyon_event
               WHERE sube_id=%s AND tarih=%s::date AND tip='KAPANIS'
                 AND durum='tamamlandi'
               ORDER BY cevap_ts DESC NULLS LAST LIMIT 1""",
            (sube_id, tarih),
        )
        kr = cur.fetchone()
        kapanis_ts = dict(kr).get("cevap_ts") if kr else None

        cur.execute(
            """SELECT olusturma FROM sube_fire_bildirim
               WHERE sube_id=%s AND tarih=%s::date
               ORDER BY olusturma""",
            (sube_id, tarih),
        )
        fire_rows = [dict(r) for r in (cur.fetchall() or [])]

        if kapanis_ts and fire_rows:
            from datetime import timedelta
            for fr in fire_rows:
                ot = fr.get("olusturma")
                if ot and kapanis_ts:
                    try:
                        fark_dk = (kapanis_ts - ot).total_seconds() / 60
                        if 0 <= fark_dk <= SAHTE_FIRE_KAPANIS_DK:
                            sinyaller.append({
                                "tip": "ZAMANLAMA",
                                "detay": f"Fire kaydı kapanıştan {fark_dk:.0f}dk önce — kapanış telaşı",
                            })
                            break
                    except Exception:
                        pass
    except Exception as e:
        log.warning("sahte_fire zamanlama hata: %s", e)

    # ── Sinyal 2: Sıklık — aynı personel son 7 günde kaç fire yazmış? ───────
    try:
        cur.execute(
            """SELECT sube_fire_bildirim.personel_id,
                      COUNT(*) AS fire_sayisi
               FROM sube_fire_bildirim
               WHERE sube_id=%s
                 AND tarih BETWEEN (%s::date - INTERVAL '7 days') AND %s::date
               GROUP BY personel_id
               HAVING COUNT(*) > 3""",
            (sube_id, tarih, tarih),
        )
        supheli = [dict(r) for r in (cur.fetchall() or [])]
        if supheli:
            for s in supheli:
                sinyaller.append({
                    "tip": "SIKLIK",
                    "detay": (
                        f"Personel {s.get('personel_id')} son 7 günde "
                        f"{s.get('fire_sayisi')} fire kaydı — ortalama üstü"
                    ),
                })
    except Exception as e:
        log.warning("sahte_fire siklik hata: %s", e)

    # ── Sinyal 3: Toplam adet anormalliği — şube günlük ortalaması ile kıyasla
    try:
        cur.execute(
            """SELECT AVG(toplam_adet) AS ort
               FROM sube_fire_bildirim
               WHERE sube_id=%s
                 AND tarih BETWEEN (%s::date - INTERVAL '30 days') AND (%s::date - INTERVAL '1 day')""",
            (sube_id, tarih, tarih),
        )
        r = cur.fetchone()
        ort_adet = float(dict(r).get("ort") or 0) if r else 0.0
        bugun_adet = float(fire_sonuc.get("toplam_adet") or 0)
        if ort_adet > 0 and bugun_adet > ort_adet * 2.5:
            sinyaller.append({
                "tip": "MIKTAR_ANOMALI",
                "detay": (
                    f"Bugün fire {bugun_adet:.0f} adet — "
                    f"30 gün ortalaması {ort_adet:.1f} (×{bugun_adet/ort_adet:.1f})"
                ),
            })
    except Exception as e:
        log.warning("sahte_fire miktar hata: %s", e)

    sinyal_sayisi = len(sinyaller)
    sonuc["sinyaller"] = sinyaller
    sonuc["sinyal_sayisi"] = sinyal_sayisi

    if sinyal_sayisi >= 2:
        sonuc["tani"] = "SAHTE_FIRE_KAYDI"
        sonuc["yorum"] = (
            f"{sinyal_sayisi} şüphe sinyali tespit edildi — "
            "fire kaydı stok açığını örtbas ediyor olabilir: "
            + "; ".join(s["detay"] for s in sinyaller)
        )
    elif sinyal_sayisi == 1:
        sonuc["tani"] = "FIRE_ZAYIF_SUPHE"
        sonuc["yorum"] = (
            f"1 zayıf sinyal: {sinyaller[0]['detay']} — "
            "tek başına yeterli değil, izlemede tut"
        )
    else:
        sonuc["tani"] = "FIRE_GUVENLIR"
        sonuc["yorum"] = "Fire kaydı zamanlama + miktar açısından güvenilir görünüyor"

    return sonuc


def bom_sapma_tani(bom_varyans_sonuc: Dict[str, Any]) -> Dict[str, Any]:
    """Sprint F / Signal 3 — BOM varyans sonucundan BOM_SAPMA tanısı üret.

    bom_recete_varyans() çıktısını alır; eşik aşanları tanıya dönüştürür.

    Eşik: fiziksel tüketim > teorik × 1.25 (>%25 fazla) → BOM_SAPMA
    """
    sonuclar = bom_varyans_sonuc.get("sonuclar") or []
    bom_aciklar = []
    for s in sonuclar:
        if s.get("durum") != "kayit_disi_kullanim":
            continue
        teorik = float(s.get("teorik_evo") or 0)
        fiziksel = float(s.get("fiziksel") or 0)
        if teorik <= 0 or fiziksel <= 0:
            continue
        oran = fiziksel / teorik
        if oran > 1.25:   # %25 fazla tüketim eşiği
            bom_aciklar.append({
                "sarf": s["sarf"],
                "teorik": teorik,
                "fiziksel": fiziksel,
                "fazla_oran": round((oran - 1) * 100, 1),
                "varyans": s.get("varyans"),
            })

    if bom_aciklar:
        tani = "BOM_SAPMA"
        yorum = (
            f"{len(bom_aciklar)} sarf kalemi BOM'u aşıyor: "
            + "; ".join(
                f"{b['sarf']} %{b['fazla_oran']:.0f} fazla"
                for b in bom_aciklar
            )
            + " — kayıt dışı kullanım veya reçete dışı üretim."
        )
    else:
        tani = "BOM_UYUMLU"
        yorum = "Tüm sarf kalemleri BOM eşiği içinde — reçete uyumlu."

    return {
        "tani": tani,
        "bom_aciklar": bom_aciklar,
        "yorum": yorum,
    }


# ════════════════════════════════════════════════════════════════════════════
#  SPRINT G — Cross-day Akşamcı N1 Şişirme Tespiti
# ════════════════════════════════════════════════════════════════════════════

def aksam_kasa_sisirme_tespit(cur, sube_id: str, tarih: str) -> Dict[str, Any]:
    """Sprint G — Akşamcı N1 Şişirme Tespiti (cross-day kasa korelasyonu).

    Senaryo (Hikaye 1):
      Akşamcı unreported satış parasını (85₺) cebe koydu. Kasayı dengede göstermek için
      N1 devir beyanını 85₺ şişirdi. Ertesi sabah sabahçı kör sayım yapar → N2 < N1.
      Sistem "AKSAM_HATALI" der — ama gerçek suçlu akşamcı zimmetidir.

    İki zorunlu sinyal:
      1. N1_dün (KAPANIS.devir) > N2_bugün (ACILIS.kasa_sayim)  — akşamcı fazla beyan
      2. Dün stok açığı var (STOK_ACIK)                          — unreported satış kanıtı

    Üçüncü sinyal (güven artırıcı):
      3. |N1 − N2| ≈ dünkü stok açığının ₺ karşılığı (±%30)     — sayısal eşleşme

    Args:
        cur:     DB cursor (dict_cursor)
        sube_id: şube UUID
        tarih:   BUGÜN — sabahçının saydığı gün (ACILIS günü, YYYY-MM-DD)

    Returns:
        {
          "tani":          "AKSAM_KASAYI_SISIRDI" | None,
          "sisirme_tl":    float,           # N1 − N2 (akşamcının şişirdiği tutar ₺)
          "n1_aksam":      float,           # dün akşam KAPANIS.devir
          "n2_sabah":      float,           # bugün ACILIS.kasa_sayim (kör sayım)
          "onceki_tarih":  str,             # dün (YYYY-MM-DD)
          "dun_stok_acik": bool,
          "acik_boyutlar": dict,            # boyut → varyans (negatif = açık)
          "dun_stok_tl":   float | None,   # stok açığının tahmini ₺ karşılığı
          "tl_eslesen":    bool,            # sayısal eşleşme var mı?
          "guven":         float,
          "detay":         str,
          "aksamci_ad":    str | None,      # dünkü akşamcı personel adı
        }
    """
    from datetime import date, timedelta

    sonuc: Dict[str, Any] = {"tani": None}

    try:
        onceki = (date.fromisoformat(tarih) - timedelta(days=1)).isoformat()
    except Exception:
        return sonuc

    # ── Sinyal 1: Bugün kasa N1 > N2 (akşamcı fazla beyan) ─────────────────
    cur.execute("""
        SELECT kasa_sayim FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=%s::date AND tip='ACILIS' AND durum='tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST LIMIT 1
    """, (sube_id, tarih))
    r_acilis = cur.fetchone()
    if not r_acilis:
        return sonuc
    n2_sabah = float(dict(r_acilis).get("kasa_sayim") or 0)

    cur.execute("""
        SELECT devir, meta FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=%s::date AND tip='KAPANIS' AND durum='tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST LIMIT 1
    """, (sube_id, onceki))
    r_kapanis = cur.fetchone()
    if not r_kapanis:
        return sonuc
    r_kap_dict = dict(r_kapanis)
    n1_aksam = float(r_kap_dict.get("devir") or 0)

    sisirme_tl = round(n1_aksam - n2_sabah, 2)
    if sisirme_tl < 1.0:
        # Şişirme yok veya önemsiz — AKSAM_HATALI nedenini araştırmaya gerek yok
        return sonuc

    # ── Sinyal 2: Dün stok açığı var mı? ────────────────────────────────────
    try:
        dun_stok = stok_akis_tablosu(cur, sube_id, onceki)
    except Exception as e:
        log.warning("sprint_g stok_akis_tablosu hata: %s", e)
        return sonuc

    dun_boyutlar = dun_stok.get("boyutlar") or {}
    acik_boyutlar = {
        b: d for b, d in dun_boyutlar.items()
        if d.get("tani") == "STOK_ACIK" and d.get("varyans") is not None
    }

    if not acik_boyutlar:
        # Dün stok açığı yok → N1 şişirmesi tesadüfi sayım hatası olabilir
        return sonuc

    # ── Sinyal 3: ₺ değeri eşleşiyor mu? (güven artırıcı) ──────────────────
    dun_evo = _evo_sube_grup_satis(cur, sube_id, onceki)
    evo_ciro = float(dun_evo.get("_ciro") or 0)
    evo_toplam_adet = sum(
        float(dun_evo.get(g, 0)) for g in ("14 Oz", "8 Oz", "Ice")
    )
    toplam_acik_adet = sum(
        abs(float(d["varyans"])) for d in acik_boyutlar.values()
    )

    dun_stok_tl: Optional[float] = None
    tl_eslesen = False
    if evo_toplam_adet > 0 and evo_ciro > 0 and toplam_acik_adet > 0:
        avg_price = evo_ciro / evo_toplam_adet           # ₺/adet (Evo bazlı)
        dun_stok_tl = round(toplam_acik_adet * avg_price, 2)
        tolerans = max(dun_stok_tl * 0.30, 15.0)         # ±%30 veya min 15₺
        tl_eslesen = abs(sisirme_tl - dun_stok_tl) <= tolerans

    # ── Dünkü akşamcı kimdi? (KAPANIS meta'sından) ──────────────────────────
    aksamci_ad: Optional[str] = None
    try:
        m = _meta_oku(r_kap_dict.get("meta"))
        aksamci_ad = (
            m.get("personel_ad")
            or m.get("ad")
            or m.get("kullanici_ad")
            or None
        )
    except Exception:
        pass

    # ── Güven skoru & açıklama ───────────────────────────────────────────────
    ad_str = f" ({aksamci_ad})" if aksamci_ad else ""
    if tl_eslesen:
        guven = 93.0
        detay = (
            f"Akşamcı{ad_str} N1−N2={sisirme_tl:.0f}₺ şişirdi. "
            f"Dün stok açığı {toplam_acik_adet:.0f} adet ≈ {dun_stok_tl:.0f}₺ (eşleşiyor). "
            f"Sinyal: unreported satış parası cebe alındı → N1 şişirildi."
        )
    else:
        guven = 74.0
        acik_str = ", ".join(
            f"{b}:{abs(float(d['varyans'])):.0f}"
            for b, d in acik_boyutlar.items()
        )
        detay = (
            f"Akşamcı{ad_str} N1−N2={sisirme_tl:.0f}₺ şişirdi. "
            f"Dün stok açığı var ({acik_str}). "
            + (f"Tahmini ₺={dun_stok_tl:.0f} (değer farkı var, belirsizlik)."
               if dun_stok_tl else "₺ değeri hesaplanamadı.")
        )

    return {
        "tani":          "AKSAM_KASAYI_SISIRDI",
        "sisirme_tl":    sisirme_tl,
        "n1_aksam":      n1_aksam,
        "n2_sabah":      n2_sabah,
        "onceki_tarih":  onceki,
        "dun_stok_acik": True,
        "acik_boyutlar": {
            b: round(float(d["varyans"]), 2) for b, d in acik_boyutlar.items()
        },
        "dun_stok_tl":   dun_stok_tl,
        "tl_eslesen":    tl_eslesen,
        "guven":         guven,
        "detay":         detay,
        "aksamci_ad":    aksamci_ad,
    }


# ════════════════════════════════════════════════════════════════════════════
#  SPRINT G.2 — Sabahçı N2 Düşük Beyan Tespiti (bardak çapraz doğrulama)
# ════════════════════════════════════════════════════════════════════════════

def sabah_zimmet_suphe_tespit(cur, sube_id: str, tarih: str) -> Dict[str, Any]:
    """Sprint G.2 — Sabahçı N2 Düşük Beyan Tespiti.

    Hikaye 1B: Sabahçı kasada bulduğundan az beyan eder, farkı cebe koyar.

    Validasyon zinciri (veri bağımsızlığı kritik):
      ┌─ N1: sube_operasyon_event[DÜN, KAPANIS].devir
      │       → Akşamcının bıraktığını söylediği tutar
      │       → KAPANIS formu akşamcı tarafından doldurulur
      │
      ├─ N2: sube_operasyon_event[BUGÜN, ACILIS].kasa_sayim
      │       → Sabahçının saydığı tutar (kör sayım)
      │       → ACILIS formu sabahçı tarafından doldurulur
      │
      └─ Bardak doğrulama: stok_akis_tablosu(DÜN) → bardak boyutları
              ├─ acilis_stok: [DÜN, ACILIS].meta.acilis_stok_sayim   (dünkü sabahçı)
              ├─ kapanis_stok: [DÜN, KAPANIS].meta.kapanis_stok_sayim (akşamcı)
              ├─ urun_ac: urun_ac_taslak[DÜN]                         (sistem)
              └─ evo_satis: hs_rapor.ashx[DÜN]                        (Evo POS)

    Mantık:
      Dün bardak akışı UYUMLU → akşamcı X bardak kahve yaptı, Evo X bardak satış
      kaydetmiş → N1 fiziksel kanıtla doğrulandı → N2 < N1 ise sabahçı kasıtlı
      düşük beyan etmiş olabilir.

    NOT: Sabahçı bardak sayımına (ACILIS.meta) dokunabilir ama KAPANIS.meta'ya
    (akşamcının kapanış stok sayımı) erişemez. Bu yüzden DÜN'ün bardak akışı
    bağımsız kanıt niteliği taşır.

    Args:
        cur:     DB cursor (dict_cursor)
        sube_id: şube UUID
        tarih:   BUGÜN — sabahçının kasa saydığı gün (YYYY-MM-DD)

    Returns:
        {
          "tani":                   "SABAH_ZIMMET_SUPHE" | None,
          "dusuk_beyan_tl":         float,   # N1 − N2
          "n1_aksam":               float,   # akşamcı devir beyanı
          "n2_sabah":               float,   # sabahçı kör sayım
          "onceki_tarih":           str,
          "bardak_plastik_tani":    str,     # UYUMLU / STOK_ACIK / KAPANIS_YOK
          "bardak_karton_tani":     str,   # 14oz+8oz birlesik (geriye uyum)
          "bardak_tamamen_uyumlu":  bool,
          "aksamci_ad":             str | None,
          "sabahci_ad":             str | None,
          "guven":                  float,
          "detay":                  str,
        }
    """
    from datetime import date, timedelta

    sonuc: Dict[str, Any] = {"tani": None}

    try:
        onceki = (date.fromisoformat(tarih) - timedelta(days=1)).isoformat()
    except Exception:
        return sonuc

    # ── 1. N2: Bugün ACILIS kasa_sayim (sabahçı kör sayım) ──────────────────
    # Kaynak: sube_operasyon_event.kasa_sayim — sabahçı tarafından girilen
    cur.execute("""
        SELECT kasa_sayim, personel_ad FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=%s::date AND tip='ACILIS' AND durum='tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST LIMIT 1
    """, (sube_id, tarih))
    r_acilis = cur.fetchone()
    if not r_acilis:
        return sonuc
    r_ac_dict = dict(r_acilis)
    n2_sabah = float(r_ac_dict.get("kasa_sayim") or 0)
    sabahci_ad: Optional[str] = r_ac_dict.get("personel_ad") or None

    # ── 2. N1: Dün KAPANIS devir (akşamcı beyanı) ───────────────────────────
    # Kaynak: sube_operasyon_event.devir — akşamcı tarafından girilen
    # KAPANIS.devir ≠ KAPANIS.kasa_sayim: devir = kasada bırakılan, kasa_sayim = ayrı
    cur.execute("""
        SELECT devir, personel_ad FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=%s::date AND tip='KAPANIS' AND durum='tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST LIMIT 1
    """, (sube_id, onceki))
    r_kapanis = cur.fetchone()
    if not r_kapanis:
        return sonuc
    r_kap_dict = dict(r_kapanis)
    n1_aksam = float(r_kap_dict.get("devir") or 0)
    aksamci_ad: Optional[str] = r_kap_dict.get("personel_ad") or None

    # Sabahçı düşük beyan mı etti?
    dusuk_beyan = round(n1_aksam - n2_sabah, 2)
    if dusuk_beyan < 1.0:
        return sonuc   # Fark yok veya sabahçı daha yüksek buldu

    # ── 3. Dün bardak akışı — akşamcı vardiyası bağımsız doğrulama ──────────
    # Kaynak: stok_akis_tablosu(dün) → içinde ACILIS.meta + KAPANIS.meta + URUN_AC + Evo
    # Neden bağımsız? Sabahçı KAPANIS.meta'ya (dünkü akşamcının stok sayımına) erişemez.
    try:
        dun_stok = stok_akis_tablosu(cur, sube_id, onceki)
    except Exception as e:
        log.warning("sabah_zimmet_suphe stok_akis hata: %s", e)
        return sonuc

    dun_boyutlar = dun_stok.get("boyutlar") or {}
    plastik = dun_boyutlar.get("bardak_plastik") or {}
    buyuk   = dun_boyutlar.get("bardak_buyuk")   or {}
    kucuk   = dun_boyutlar.get("bardak_kucuk")   or {}

    plastik_tani = plastik.get("tani") or "KAPANIS_YOK"
    buyuk_tani   = buyuk.get("tani")   or "KAPANIS_YOK"
    kucuk_tani   = kucuk.get("tani")   or "KAPANIS_YOK"
    # Karton (14oz+8oz) artık ayrı boyut; doğrulama için ikisini birleştir:
    # ikisinden biri sorunluysa karton sorunlu; ikisi de uyumluysa karton uyumlu.
    _karton_taniler = [t for t in (buyuk_tani, kucuk_tani) if t != "KAPANIS_YOK"]
    if not _karton_taniler:
        karton_tani = "KAPANIS_YOK"
    elif any(t in ("STOK_ACIK", "STOK_FAZLA") for t in _karton_taniler):
        karton_tani = "STOK_ACIK"
    elif all(t == "UYUMLU" for t in _karton_taniler):
        karton_tani = "UYUMLU"
    else:
        karton_tani = _karton_taniler[0]

    # Dünkü akşamcı vardiyasında bardak problemi var mıydı?
    # STOK_ACIK veya STOK_FAZLA → akşamcı da tutarsız → sabahçıyı suçlamak doğru olmaz
    bardak_sorunlu = plastik_tani in ("STOK_ACIK", "STOK_FAZLA") or \
                     karton_tani  in ("STOK_ACIK", "STOK_FAZLA")
    if bardak_sorunlu:
        # Akşamcı vardiyasında da ürün tutarsızlığı var → karışık senaryo,
        # sabahçı zimmet tespiti güvenilmez
        return sonuc

    # Bardak doğrulama seviyesi
    bardak_tamamen_uyumlu = (plastik_tani == "UYUMLU" and karton_tani == "UYUMLU")
    bardak_kismen_uyumlu  = (plastik_tani == "UYUMLU" or karton_tani == "UYUMLU")

    if not bardak_kismen_uyumlu and plastik_tani != "KAPANIS_YOK":
        # Hiçbir bardak boyutu doğrulanamıyor
        return sonuc

    # ── 4. Evo satış miktarı — akşamcı gerçekten bu kadar sattı mı? ─────────
    # Kaynak: _evo_sube_grup_satis(dün) → hs_rapor.ashx (Evo POS sunucusu)
    # Evo verisi: kasa_sayim veya devir ile hiçbir ilgisi yok — bağımsız
    dun_evo = _evo_sube_grup_satis(cur, sube_id, onceki)
    evo_bardak_toplam = sum(
        float(dun_evo.get(g, 0)) for g in ("14 Oz", "8 Oz", "Ice")
    )
    evo_nakit_dun = float(dun_evo.get("_nakit") or 0)

    # Evo nakit ≈ N1 kontrolü (ek sinyal — bağımsız üçüncü kaynak)
    evo_n1_yakin = False
    if evo_nakit_dun > 0 and n1_aksam > 0:
        # Açılış kasası bilinmiyorsa sadece fark kontrolü
        oran = evo_nakit_dun / n1_aksam if n1_aksam else 0
        evo_n1_yakin = 0.30 <= oran <= 3.0   # makul aralık

    # ── 5. Güven skoru ve tanı metni ────────────────────────────────────────
    sab_str = f" ({sabahci_ad})" if sabahci_ad else ""
    aks_str = f" ({aksamci_ad})" if aksamci_ad else ""

    if bardak_tamamen_uyumlu:
        guven = 91.0
        detay = (
            f"Sabahçı{sab_str} N2={n2_sabah:.0f}₺ beyan etti, "
            f"akşamcı{aks_str} N1={n1_aksam:.0f}₺ bırakmıştı. "
            f"Fark: {dusuk_beyan:.0f}₺. "
            f"Dün bardak_plastik+karton UYUMLU ({evo_bardak_toplam:.0f} adet Evo satışı eşleşiyor) "
            f"→ N1 fiziksel kanıtla doğrulandı. "
            f"Sabahçı kasayı {dusuk_beyan:.0f}₺ düşük beyan etmiş olabilir."
        )
    else:
        guven = 76.0
        detay = (
            f"Sabahçı{sab_str} N2={n2_sabah:.0f}₺ beyan, "
            f"akşamcı{aks_str} N1={n1_aksam:.0f}₺ idi. "
            f"Fark: {dusuk_beyan:.0f}₺. "
            f"Bardak kısmi doğrulama (plastik:{plastik_tani}, karton:{karton_tani}). "
            f"N1 güvenilebilir, sabahçı düşük beyan şüphesi."
        )

    return {
        "tani":                  "SABAH_ZIMMET_SUPHE",
        "dusuk_beyan_tl":        dusuk_beyan,
        "n1_aksam":              n1_aksam,
        "n2_sabah":              n2_sabah,
        "onceki_tarih":          onceki,
        "bardak_plastik_tani":   plastik_tani,
        "bardak_karton_tani":    karton_tani,
        "bardak_tamamen_uyumlu": bardak_tamamen_uyumlu,
        "evo_bardak_toplam":     evo_bardak_toplam,
        "evo_nakit_dun":         evo_nakit_dun,
        "aksamci_ad":            aksamci_ad,
        "sabahci_ad":            sabahci_ad,
        "guven":                 guven,
        "detay":                 detay,
    }


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
    "bardak_buyuk":   "14oz bardak",
    "bardak_kucuk":   "8oz bardak",
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

    # 8. Sprint F — QSR büyük zincir çapraz kontrolleri
    # 8a. Süt çapraz referans
    sut_sapma: Dict[str, Any] = {}
    try:
        sut_sapma = sut_sapma_analiz(cur, sube_id, tarih)
    except Exception as e:
        log.warning("tam_analiz sut_sapma hata: %s", e)

    # 8b. Sahte fire tespiti (fire kayıt varsa sprint_e'yi sorgula)
    sahte_fire: Dict[str, Any] = {}
    try:
        fire_sonuc_ref = fire_bildirim_capraz(cur, sube_id, tarih)
        if fire_sonuc_ref.get("fire_kayit_var"):
            sahte_fire = sahte_fire_tespiti(cur, sube_id, tarih, fire_sonuc=fire_sonuc_ref)
    except Exception as e:
        log.warning("tam_analiz sahte_fire hata: %s", e)

    # 8c. BOM reçete varyansı → BOM_SAPMA tanısı
    bom_sapma_sonuc: Dict[str, Any] = {}
    try:
        bom_varyans = bom_recete_varyans(cur, sube_id, tarih)
        bom_sapma_sonuc = bom_sapma_tani(bom_varyans)
    except Exception as e:
        log.warning("tam_analiz bom_sapma hata: %s", e)

    # 8d. Sprint G — Akşamcı N1 Şişirme (cross-day kasa korelasyonu)
    sprint_g_sonuc: Dict[str, Any] = {}
    try:
        sprint_g_sonuc = aksam_kasa_sisirme_tespit(cur, sube_id, tarih)
    except Exception as e:
        log.warning("tam_analiz sprint_g hata: %s", e)

    # 8e. Sprint G.2 — Sabahçı N2 Düşük Beyan (bardak çapraz doğrulama)
    sprint_g2_sonuc: Dict[str, Any] = {}
    try:
        sprint_g2_sonuc = sabah_zimmet_suphe_tespit(cur, sube_id, tarih)
    except Exception as e:
        log.warning("tam_analiz sprint_g2 hata: %s", e)

    # 8f. Sprint H (C Bendi) — Akşam Vardiyası Bardak P&L (devir→kapanis)
    sprint_h_sonuc: Dict[str, Any] = {}
    try:
        sprint_h_sonuc = aksam_vardiya_bardak_pnl(cur, sube_id, tarih)
    except Exception as e:
        log.warning("tam_analiz sprint_h hata: %s", e)

    # 8g. Sprint J — Cross-day Bardak Devamlılık Kontrolü (dün KAPANIS → bugün ACILIS)
    sprint_j_sonuc: Dict[str, Any] = {}
    try:
        sprint_j_sonuc = aksam_bardak_sisirme_tespit(cur, sube_id, tarih)
    except Exception as e:
        log.warning("tam_analiz sprint_j hata: %s", e)

    # 9. Genel alarm seviyesi
    has_kritik = any(ps.get("risk_seviye") == "kritik" for ps in personel_sorumlu)
    has_yuksek = any(ps.get("risk_seviye") == "yuksek" for ps in personel_sorumlu)
    birincil_koken = kok_nedenler[0].get("tip", "") if kok_nedenler else ""

    sprint_f_yuksek = (
        sahte_fire.get("tani") == "SAHTE_FIRE_KAYDI"
        or bom_sapma_sonuc.get("tani") == "BOM_SAPMA"
    )
    sprint_f_orta = (sut_sapma.get("tani") == "SUT_SAPMA")
    sprint_g_kritik  = (sprint_g_sonuc.get("tani")  == "AKSAM_KASAYI_SISIRDI")
    sprint_g2_kritik = (sprint_g2_sonuc.get("tani") == "SABAH_ZIMMET_SUPHE")
    sprint_h_yuksek  = (sprint_h_sonuc.get("tani")  == "AKSAM_VARDIYA_BARDAK_ACIK")
    sprint_j_kritik  = (sprint_j_sonuc.get("tani")  == "AKSAM_BARDAK_SISIRDI")
    # IPTAL_SUPHE: tam_analiz'de kasa_fark + stok açığı yok kombinasyonu
    iptal_suphe = (
        not sprint_g_kritik
        and not sprint_g2_kritik
        and abs(kasa_fark_toplam) > 5
        and stok_acik_sayisi == 0
        and not has_kritik
        and not has_yuksek
    )

    if has_kritik or sprint_g_kritik or sprint_g2_kritik or sprint_j_kritik or birincil_koken in ("SWEETHEARTING_ZIMMET",):
        alarm = "kritik"
    elif has_yuksek or sprint_f_yuksek or sprint_h_yuksek or iptal_suphe or birincil_koken in ("NAKIT_CEKILDI", "AKSAM_ZIMMET_POZISYON"):
        alarm = "yuksek"
    elif stok_acik_sayisi > 0 or abs(kasa_fark_toplam) > 5 or sprint_f_orta:
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
    if sprint_g_kritik:
        g_ad = sprint_g_sonuc.get("aksamci_ad") or "Akşamcı"
        g_tl = sprint_g_sonuc.get("sisirme_tl", 0)
        ozet_parcalari.append(f"⚠ {g_ad} {g_tl:.0f}₺ N1 şişirdi (dün stok açığı)")
    if sprint_g2_kritik:
        s_ad = sprint_g2_sonuc.get("sabahci_ad") or "Sabahçı"
        s_tl = sprint_g2_sonuc.get("dusuk_beyan_tl", 0)
        ozet_parcalari.append(f"⚠ {s_ad} {s_tl:.0f}₺ N2 düşük beyan (bardak doğruladı)")
    if sprint_h_yuksek:
        h_ad = sprint_h_sonuc.get("aksamci_ad") or "Akşamcı"
        h_karton = sprint_h_sonuc.get("karton_acik", 0)
        h_plastik = sprint_h_sonuc.get("plastik_acik", 0)
        ozet_parcalari.append(
            f"⚠ {h_ad} vardiya bardak açığı: "
            f"{h_karton:.0f} karton + {h_plastik:.0f} plastik kayıt dışı"
        )
    if sprint_j_kritik:
        j_ad = sprint_j_sonuc.get("aksamci_ad") or "Akşamcı"
        j_karton = sprint_j_sonuc.get("gece_karton_kaybi", 0)
        j_plastik = sprint_j_sonuc.get("gece_plastik_kaybi", 0)
        kasa_str = " + kasa açığı eşleşiyor" if sprint_j_sonuc.get("kasada_acik") else ""
        ozet_parcalari.append(
            f"⚠ {j_ad} bardak şişirdi: "
            f"{j_karton:.0f} karton + {j_plastik:.0f} plastik gece 'eridi'{kasa_str}"
        )
    if iptal_suphe:
        ozet_parcalari.append(
            f"⚠ Kasa {abs(kasa_fark_toplam):.0f}₺ açık, stok normal → iptal fiş kontrol"
        )
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
        # Sprint F — QSR büyük zincir çapraz kontrolleri
        "sprint_f": {
            "sut_sapma":    sut_sapma,
            "sahte_fire":   sahte_fire,
            "bom_sapma":    bom_sapma_sonuc,
        },
        # Sprint G — cross-day akşamcı N1 şişirme
        "sprint_g":  sprint_g_sonuc,
        # Sprint G.2 — sabahçı N2 düşük beyan (bardak çapraz doğrulama)
        "sprint_g2": sprint_g2_sonuc,
        # Sprint H (C Bendi) — akşam vardiyası bardak P&L (devir→kapanis)
        "sprint_h":  sprint_h_sonuc,
        # Sprint J — cross-day bardak devamlılık (dün KAPANIS → bugün ACILIS)
        "sprint_j":  sprint_j_sonuc,
    }


# ════════════════════════════════════════════════════════════════════════════
#  SPRINT H (C BENDİ) — Akşam Vardiyası Bardak P&L (devir→kapanis)
# ════════════════════════════════════════════════════════════════════════════

def aksam_vardiya_bardak_pnl(cur, sube_id: str, tarih: str) -> Dict[str, Any]:
    """Sprint H (C Bendi): Akşam vardiyası bardak P&L — devir anından kapanışa.

    Hikaye 1C: Akşamcı devir alır, kayıt dışı satış yapıp nakit cebe koyar.
    Devir→kapanis fiziksel bardak farkı, Evo akşam satış tahminiyle karşılaştırılır.

    Veri kaynakları (bağımsız):
      ┌─ DEVIR BARDAK:  kapanis_kayit[olay='vardiya_sabah_aksam_devri']
      │    → meta.vardiya_devir_stok_sayim   (sabahçı teslim anındaki sayım)
      │    → kapanisci_onay_ts               (devir zamanı, ~17:30)
      │
      ├─ KAPANİŞ BARDAK: sube_operasyon_event[tarih, KAPANIS]
      │    → meta.kapanis_stok_sayim         (akşamcı kapanış sayımı)
      │    → cevap_ts                        (kapanış zamanı, ~00:00)
      │
      ├─ URUN_AC (gün içi açılan paket): urun_ac_taslak[tarih]
      │    → akşam payı = toplam × aksam_oran
      │
      └─ EVO POS (bağımsız):
           _evo_sube_saatli_satis() → devir_ts→kapanis_ts arası fiş sayısı + tutar
           _evo_sube_grup_satis()   → tüm gün grup dağılımı (14oz/8oz/Ice)
           → Akşam bardak tahmini = grup_toplam × aksam_oran

    Sonuç:
      aksam_fiziksel = (devir_bardak + urun_ac_aksam) − kapanis_bardak
      evo_tahmin     = tum_gun_evo_bardak × aksam_oran
      Eğer fiziksel >> tahmin (>%30 ve >3 adet) → AKSAM_VARDIYA_BARDAK_ACIK

    Returns:
        {
          "tani":                    "AKSAM_VARDIYA_BARDAK_ACIK" | "UYUMLU" | None,
          "devir_karton":            int,    # devir anındaki toplam karton bardak (buyuk+kucuk)
          "devir_plastik":           int,    # devir anındaki plastik bardak
          "kapanis_karton":          int,
          "kapanis_plastik":         int,
          "urun_ac_karton_aksam":    float,  # devir sonrası açılan karton paket payı
          "urun_ac_plastik_aksam":   float,
          "aksam_karton_kullanim":   int,    # fiziksel kullanım
          "aksam_plastik_kullanim":  int,
          "evo_aksam_karton_est":    float,  # Evo tabanlı tahmin
          "evo_aksam_plastik_est":   float,
          "karton_acik":             float,  # fiziksel − tahmin
          "plastik_acik":            float,
          "karton_anomali":          bool,
          "plastik_anomali":         bool,
          "devir_ts":                str | None,
          "aksam_fis_count":         int,
          "aksam_fis_tutar":         float,
          "aksam_oran":              float,  # akşam tutar / gün tutar
          "aksamci_ad":              str | None,
          "guven":                   float,
          "detay":                   str,
        }
    """
    sonuc: Dict[str, Any] = {"tani": None}

    # ── 1. Devir kayıt (sabahçı → akşamcı teslim anı) ───────────────────────
    # kapanis_kayit.olay='vardiya_sabah_aksam_devri' → sabahçı tarafından oluşturuldu
    # meta.vardiya_devir_stok_sayim: akşamcıya bırakılan bardak sayımı
    try:
        cur.execute("SAVEPOINT sp_h_devir")
        cur.execute("""
            SELECT meta, kapanisci_onay_ts, devir,
                   aksamci_personel_id, sabahci_personel_id
            FROM kapanis_kayit
            WHERE sube_id=%s AND tarih=%s::date
              AND olay = 'vardiya_sabah_aksam_devri'
              AND durum IN ('tamamlandi', 'aktif', 'acilis_bekliyor')
            ORDER BY kapanisci_onay_ts DESC NULLS LAST
            LIMIT 1
        """, (sube_id, tarih))
        r_devir = cur.fetchone()
        cur.execute("RELEASE SAVEPOINT sp_h_devir")
    except Exception as e:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_h_devir")
            cur.execute("RELEASE SAVEPOINT sp_h_devir")
        except Exception:
            pass
        log.warning("aksam_vardiya_bardak_pnl devir sorgu hata: %s", e)
        return sonuc

    if not r_devir:
        return sonuc   # Devir kaydı yok — bu gün vardiya devri yapılmamış

    r_devir_dict = dict(r_devir)
    devir_ts = r_devir_dict.get("kapanisci_onay_ts")
    if devir_ts is None:
        return sonuc   # Devir zamanı bilinmiyor — analiz yapılamaz

    devir_meta_raw = r_devir_dict.get("meta") or {}
    if isinstance(devir_meta_raw, str):
        try:
            devir_meta_raw = json.loads(devir_meta_raw)
        except Exception:
            devir_meta_raw = {}
    devir_stok = devir_meta_raw.get("vardiya_devir_stok_sayim") or {}

    devir_buyuk   = int(devir_stok.get("bardak_buyuk",   0) or 0)
    devir_kucuk   = int(devir_stok.get("bardak_kucuk",   0) or 0)
    devir_plastik = int(devir_stok.get("bardak_plastik", 0) or 0)
    devir_karton  = devir_buyuk + devir_kucuk

    if devir_karton == 0 and devir_plastik == 0:
        return sonuc   # Devir stok sayımı girilmemiş → analiz yapılamaz

    # ── 2. Akşamcı adı ─────────────────────────────────────────────────────
    aksamci_ad: Optional[str] = None
    aksamci_pid = r_devir_dict.get("aksamci_personel_id")
    if aksamci_pid:
        try:
            cur.execute("SAVEPOINT sp_h_pers")
            cur.execute(
                "SELECT ad FROM personel WHERE id::text=%s LIMIT 1",
                (str(aksamci_pid),)
            )
            pr = cur.fetchone()
            if pr:
                aksamci_ad = dict(pr).get("ad") or None
            cur.execute("RELEASE SAVEPOINT sp_h_pers")
        except Exception:
            try:
                cur.execute("ROLLBACK TO SAVEPOINT sp_h_pers")
                cur.execute("RELEASE SAVEPOINT sp_h_pers")
            except Exception:
                pass
    if not aksamci_ad:
        # Fallback: KAPANIS event personel_ad
        try:
            cur.execute("SAVEPOINT sp_h_persfb")
            cur.execute("""
                SELECT personel_ad FROM sube_operasyon_event
                WHERE sube_id=%s AND tarih=%s::date AND tip='KAPANIS' AND durum='tamamlandi'
                ORDER BY cevap_ts DESC NULLS LAST LIMIT 1
            """, (sube_id, tarih))
            pr = cur.fetchone()
            if pr:
                aksamci_ad = dict(pr).get("personel_ad") or None
            cur.execute("RELEASE SAVEPOINT sp_h_persfb")
        except Exception:
            try:
                cur.execute("ROLLBACK TO SAVEPOINT sp_h_persfb")
                cur.execute("RELEASE SAVEPOINT sp_h_persfb")
            except Exception:
                pass

    # ── 3. Kapanis bardak sayımı (akşamcının kapanış sayımı) ─────────────────
    try:
        cur.execute("SAVEPOINT sp_h_kapanis")
        cur.execute("""
            SELECT meta, kasa_sayim, cevap_ts FROM sube_operasyon_event
            WHERE sube_id=%s AND tarih=%s::date AND tip='KAPANIS' AND durum='tamamlandi'
            ORDER BY cevap_ts DESC NULLS LAST LIMIT 1
        """, (sube_id, tarih))
        r_kapanis = cur.fetchone()
        cur.execute("RELEASE SAVEPOINT sp_h_kapanis")
    except Exception as e:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_h_kapanis")
            cur.execute("RELEASE SAVEPOINT sp_h_kapanis")
        except Exception:
            pass
        log.warning("aksam_vardiya_bardak_pnl kapanis sorgu hata: %s", e)
        return sonuc

    if not r_kapanis:
        return sonuc   # Kapanış tamamlanmamış — günlük analiz için bekle

    r_kap_dict = dict(r_kapanis)
    kapanis_ts  = r_kap_dict.get("cevap_ts")

    kapanis_meta_raw = r_kap_dict.get("meta") or {}
    if isinstance(kapanis_meta_raw, str):
        try:
            kapanis_meta_raw = json.loads(kapanis_meta_raw)
        except Exception:
            kapanis_meta_raw = {}
    kapanis_stok = kapanis_meta_raw.get("kapanis_stok_sayim") or {}

    if not kapanis_stok:
        return sonuc   # Kapanış stok sayımı girilmemiş

    kapanis_buyuk   = int(kapanis_stok.get("bardak_buyuk",   0) or 0)
    kapanis_kucuk   = int(kapanis_stok.get("bardak_kucuk",   0) or 0)
    kapanis_plastik = int(kapanis_stok.get("bardak_plastik", 0) or 0)
    kapanis_karton  = kapanis_buyuk + kapanis_kucuk

    # ── 4. Evo akşam satışları (time-filtered: devir_ts → kapanis_ts) ────────
    evo_sube_id: Optional[str] = None
    try:
        cur.execute("SAVEPOINT sp_h_evoid")
        cur.execute("SELECT ad FROM subeler WHERE id::text=%s", (str(sube_id),))
        srow = cur.fetchone()
        sube_adi_evvel = str(dict(srow).get("ad") or "") if srow else ""
        cur.execute("RELEASE SAVEPOINT sp_h_evoid")
        # FIX T5 (2026-07-06): kırık .lower() substring → evo_sync merkezî id eşleştirici
        from evo_sync import evvel_sube_evo_id_eslestir
        evo_sube_id = evvel_sube_evo_id_eslestir(sube_adi_evvel)
    except Exception as e:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_h_evoid")
            cur.execute("RELEASE SAVEPOINT sp_h_evoid")
        except Exception:
            pass
        log.warning("aksam_vardiya_bardak_pnl evo_id hata: %s", e)

    aksam_fis_count = 0
    aksam_fis_tutar = 0.0
    total_fis_count = 0
    total_fis_tutar = 0.0

    if evo_sube_id:
        try:
            from datetime import date as _d2
            y2, mo2, dn2 = (int(x) for x in str(tarih)[:10].split("-"))
            tarih_d2 = _d2(y2, mo2, dn2)
            tum_fis = _evo_sube_saatli_satis(evo_sube_id, tarih_d2, tarih_d2)
            for fis in tum_fis:
                dt = fis.get("saat_dt")
                if dt is None:
                    continue
                total_fis_count += 1
                total_fis_tutar += float(fis.get("tutar") or 0)
                # Akşam vardiyası: devir_ts'ten kapanis_ts'e (veya gece sonuna)
                if dt >= devir_ts and (kapanis_ts is None or dt <= kapanis_ts):
                    aksam_fis_count += 1
                    aksam_fis_tutar += float(fis.get("tutar") or 0)
        except Exception as e:
            log.warning("aksam_vardiya_bardak_pnl evo saatli hata: %s", e)

    # Akşam oranı (tutar bazlı; fiş bazlı fallback; hiç veri yoksa 0.5)
    if total_fis_tutar > 1.0:
        aksam_oran = min(aksam_fis_tutar / total_fis_tutar, 1.0)
    elif total_fis_count > 0:
        aksam_oran = min(aksam_fis_count / total_fis_count, 1.0)
    else:
        aksam_oran = 0.50   # veri yok — %50 varsayım

    # ── 5. Tüm gün Evo grup → akşam bardak tahmini ───────────────────────────
    evo_grup = _evo_sube_grup_satis(cur, sube_id, tarih)
    evo_14oz = float(evo_grup.get("14 Oz") or 0)
    evo_8oz  = float(evo_grup.get("8 Oz")  or 0)
    evo_ice  = float(evo_grup.get("Ice")   or 0)

    evo_aksam_karton_est  = round((evo_14oz + evo_8oz) * aksam_oran, 1)
    evo_aksam_plastik_est = round(evo_ice * aksam_oran, 1)

    # ── 6. URUN_AC (gün içi açılan paket) — akşam payı ──────────────────────
    # Tüm gün URUN_AC'ı akşam oranıyla bölüştür (saatli veri yok)
    try:
        urun_ac_karton_gun  = (_urun_ac_toplam(cur, sube_id, tarih, "bardak_buyuk")
                               + _urun_ac_toplam(cur, sube_id, tarih, "bardak_kucuk"))
        urun_ac_plastik_gun = _urun_ac_toplam(cur, sube_id, tarih, "bardak_plastik")
    except Exception:
        urun_ac_karton_gun  = 0.0
        urun_ac_plastik_gun = 0.0

    urun_ac_karton_aksam  = round(urun_ac_karton_gun  * aksam_oran, 1)
    urun_ac_plastik_aksam = round(urun_ac_plastik_gun * aksam_oran, 1)

    # ── 7. Fiziksel akşam bardak kullanımı ───────────────────────────────────
    # Formül: devir_stok + urun_ac_aksam − kapanis_stok = fiziksel_kullanim
    aksam_karton_kullanim  = max(0, round(devir_karton  + urun_ac_karton_aksam  - kapanis_karton,  0))
    aksam_plastik_kullanim = max(0, round(devir_plastik + urun_ac_plastik_aksam - kapanis_plastik, 0))

    toplam_fiziksel = aksam_karton_kullanim + aksam_plastik_kullanim
    if toplam_fiziksel < 2:
        # Çok az kullanım → akşam vardiyası bardak verisi anlamsız
        return sonuc

    # ── 8. Anomali tespiti ────────────────────────────────────────────────────
    # Eşik: fiziksel fark > %30 aşım VE en az 3 bardak
    ESIK_ADET = 3
    ESIK_ORAN = 0.30

    karton_acik  = round(aksam_karton_kullanim  - evo_aksam_karton_est,  1)
    plastik_acik = round(aksam_plastik_kullanim - evo_aksam_plastik_est, 1)

    karton_anomali = bool(
        karton_acik > ESIK_ADET
        and evo_aksam_karton_est > 0
        and karton_acik / evo_aksam_karton_est > ESIK_ORAN
    )
    plastik_anomali = bool(
        plastik_acik > ESIK_ADET
        and evo_aksam_plastik_est > 0
        and plastik_acik / evo_aksam_plastik_est > ESIK_ORAN
    )

    aks_str = f" ({aksamci_ad})" if aksamci_ad else ""
    oran_pct = f"%{aksam_oran * 100:.0f}"

    # ── 9. Ortak sonuç alanları ───────────────────────────────────────────────
    ortak = {
        "devir_karton":            devir_karton,
        "devir_plastik":           devir_plastik,
        "kapanis_karton":          kapanis_karton,
        "kapanis_plastik":         kapanis_plastik,
        "urun_ac_karton_aksam":    urun_ac_karton_aksam,
        "urun_ac_plastik_aksam":   urun_ac_plastik_aksam,
        "aksam_karton_kullanim":   int(aksam_karton_kullanim),
        "aksam_plastik_kullanim":  int(aksam_plastik_kullanim),
        "evo_aksam_karton_est":    evo_aksam_karton_est,
        "evo_aksam_plastik_est":   evo_aksam_plastik_est,
        "karton_acik":             karton_acik,
        "plastik_acik":            plastik_acik,
        "karton_anomali":          karton_anomali,
        "plastik_anomali":         plastik_anomali,
        "devir_ts":                devir_ts.isoformat() if devir_ts else None,
        "aksam_fis_count":         aksam_fis_count,
        "aksam_fis_tutar":         round(aksam_fis_tutar, 2),
        "aksam_oran":              round(aksam_oran, 3),
        "total_fis_count":         total_fis_count,
        "aksamci_ad":              aksamci_ad,
    }

    if karton_anomali or plastik_anomali:
        # Güven: hem boyut hem Evo fiş miktarına göre
        guven = 85.0
        if karton_anomali and plastik_anomali:
            guven = 91.0
        if aksam_fis_count >= 5:
            guven = min(95.0, guven + 4.0)

        anomali_parcalar = []
        if karton_anomali:
            anomali_parcalar.append(
                f"karton {int(aksam_karton_kullanim)} fiziksel vs {evo_aksam_karton_est:.0f} Evo "
                f"→ {karton_acik:.0f} açık"
            )
        if plastik_anomali:
            anomali_parcalar.append(
                f"plastik {int(aksam_plastik_kullanim)} fiziksel vs {evo_aksam_plastik_est:.0f} Evo "
                f"→ {plastik_acik:.0f} açık"
            )

        detay = (
            f"Akşamcı{aks_str} devir anında {devir_karton} karton + {devir_plastik} plastik bardak devraldı. "
            f"Kapanışta {kapanis_karton} karton + {kapanis_plastik} plastik kaldı. "
            f"Akşam kullanım (fiziksel): {int(aksam_karton_kullanim)} karton + {int(aksam_plastik_kullanim)} plastik. "
            f"Evo akşam tahmini ({oran_pct} oran, {aksam_fis_count} fiş): "
            f"{evo_aksam_karton_est:.0f} karton + {evo_aksam_plastik_est:.0f} plastik. "
            f"Anomali: {'; '.join(anomali_parcalar)}. "
            f"Kayıt dışı satış şüphesi — nakit akşam vardiyasında cepde kalmış olabilir."
        )
        return {
            **ortak,
            "tani":   "AKSAM_VARDIYA_BARDAK_ACIK",
            "guven":  guven,
            "detay":  detay,
        }

    # UYUMLU — bardak kullanımı Evo tahminiyle örtüşüyor
    detay = (
        f"Akşamcı{aks_str} devir→kapanis: {int(aksam_karton_kullanim)} karton + "
        f"{int(aksam_plastik_kullanim)} plastik kullandı. "
        f"Evo tahmini ({oran_pct}, {aksam_fis_count} akşam fişi): "
        f"{evo_aksam_karton_est:.0f} karton + {evo_aksam_plastik_est:.0f} plastik. "
        f"Uyumlu — kayıt dışı satış sinyali yok."
    )
    return {
        **ortak,
        "tani":  "UYUMLU",
        "guven": 82.0,
        "detay": detay,
    }


# ════════════════════════════════════════════════════════════════════════════
#  SPRINT I (D BENDİ) — Küçük Tutarlı Günlük Kasa Eksilmesi Pattern Tespiti
# ════════════════════════════════════════════════════════════════════════════

def kucuk_tutar_birikim_tespit(cur, sube_id: str = None,
                                gun: int = 30) -> Dict[str, Any]:
    """Sprint I (D Bendi): Günlük küçük tutarlı kasa eksilmesi — birikim zimmeti.

    Hikaye 1D: Personel her gün 10-50₺ götürüyor. Tek güne bakıldığında
    "normal tolerans" gibi görünür, geçer. Ama 30 günlük seriye bakıldığında:
    aynı kişi, aynı yön, benzer miktar — bu rastlantı değil, sistematik.

    Sinyal kriterleri (5 koşulun tamamı):
    ┌─ 1. Personel ≥7 iş günü çalışmış (yeterli örnek)
    ├─ 2. Çalıştığı günlerin >%55'inde kasa farkı < -4₺ (sistematik yön)
    ├─ 3. Günlük ortalama fark: -4₺ ile -80₺ arası
    │       Alt sınır: <4₺ gürültü, Sprint G/G.2 zaten >= 80₺ yakalıyor
    ├─ 4. Kümülatif fark < -80₺ (toplam zarar anlamlı)
    └─ 5. Aynı kişinin aynı dönemde AKSAM_KASAYI_SISIRDI / SABAH_ZIMMET_SUPHE
           tanısı YOK (çifte sayım önleme)

    Güven faktörleri:
      Eksi oran >%70        → +10 (çok sistematik)
      Maks ardışık seri ≥5  → +8  (seri var, rastlantı değil)
      Kümülatif < -200₺    → +5  (büyük zarar)
      Temel güven           = 72

    Veri kaynağı: sube_operasyon_event (yalnızca okuma)
      - ACILIS.kasa_sayim  (N2) + ACILIS.personel_ad → sabahçı
      - Önceki gün KAPANIS.devir (N1) + KAPANIS.personel_ad → akşamcı
      fark = N2 - N1   (negatif = kasa açığı)

    Args:
        cur:     DB cursor (dict_cursor)
        sube_id: Filtre — None ise tüm şubeler
        gun:     Son kaç gün incelensin (varsayılan 30)

    Returns:
        {
          "gun": int,
          "tespit_sayisi": int,
          "riskli_personeller": [
            {
              "personel_ad":  str,
              "sube_id":      str,
              "rol":          "sabahci" | "aksamci",
              "gun_sayisi":   int,       # kaç gün çalışmış
              "eksi_gun":     int,       # kaç günde fark < -4₺
              "eksi_oran":    float,     # 0-1
              "ort_fark":     float,     # günlük ortalama ₺
              "toplam_fark":  float,     # kümülatif ₺
              "maks_seri":    int,       # en uzun ardışık eksi gün serisi
              "tani":         "KUCUK_TUTAR_BIRIKIM",
              "guven":        float,
              "detay":        str,
            }
          ]
        }
    """
    where_sube = ""
    params_base: List[Any] = [gun]
    if sube_id:
        where_sube = "AND a.sube_id = %s::uuid"
        params_base.append(sube_id)

    # ── 1. Günlük fark serisi: ACILIS(N2) × önceki gün KAPANIS(N1) ──────────
    # fark = N2 - N1 (negatif = kasa açığı, pozitif = fazla)
    # Her gün için hem sabahçıyı (ACILIS personel) hem akşamcıyı (KAPANIS personel) kaydediyoruz
    try:
        cur.execute(f"""
            WITH daily_fark AS (
                SELECT
                    a.sube_id,
                    a.tarih,
                    COALESCE(a.kasa_sayim, 0)::float  AS n2,
                    COALESCE(k.devir,      0)::float  AS n1,
                    (COALESCE(a.kasa_sayim, 0) - COALESCE(k.devir, 0))::float  AS fark,
                    COALESCE(a.personel_ad, '')        AS sabahci_ad,
                    COALESCE(k.personel_ad, '')        AS aksamci_ad
                FROM sube_operasyon_event a
                LEFT JOIN sube_operasyon_event k
                  ON  k.sube_id = a.sube_id
                  AND k.tarih   = (a.tarih - INTERVAL '1 day')::date
                  AND k.tip     = 'KAPANIS'
                  AND k.durum   = 'tamamlandi'
                  AND k.devir   IS NOT NULL
                WHERE a.tip   = 'ACILIS'
                  AND a.durum = 'tamamlandi'
                  AND a.kasa_sayim IS NOT NULL
                  AND a.tarih >= CURRENT_DATE - (%s || ' days')::interval
                  {where_sube}
            ),
            -- 🔴 TRUTH-004 (2026-09-02): AYNI `fark` hem sabahçıya hem akşamcıya
            -- toplanıyor. Bu bir hata DEĞİL bir BELİRSİZLİKTİR: 100₺'lik açık ya
            -- akşamcının fazla beyanından ya sabahçının eksik saymasından gelir,
            -- hangisi olduğunu bu veri SÖYLEYEMEZ. Ama iki satırı bağımsız bulgu
            -- gibi okumak, tek açığı 200₺ risk gibi gösterir ve İKİ kişiyi birden
            -- suçlar. Çözüm: satırlar kalsın (ikisi de aday), fakat KARŞI TARAF
            -- adı taşınsın ve çıktı bunun PAYLAŞILAN sorumluluk olduğunu söylesin.
            sabahci_agg AS (
                SELECT
                    sube_id,
                    sabahci_ad              AS personel_ad,
                    'sabahci'::text         AS rol,
                    (array_agg(DISTINCT aksamci_ad) FILTER (WHERE aksamci_ad <> ''))
                                            AS karsi_taraf,
                    COUNT(*)                AS gun_sayisi,
                    SUM(CASE WHEN fark < -4 THEN 1 ELSE 0 END) AS eksi_gun,
                    ROUND(AVG(fark)::numeric, 2)  AS ort_fark,
                    ROUND(SUM(fark)::numeric, 2)  AS toplam_fark,
                    array_agg(fark ORDER BY tarih) AS fark_seri,
                    array_agg(tarih ORDER BY tarih) AS tarih_seri
                FROM daily_fark
                WHERE sabahci_ad != ''
                GROUP BY sube_id, sabahci_ad
            ),
            aksamci_agg AS (
                SELECT
                    sube_id,
                    aksamci_ad              AS personel_ad,
                    'aksamci'::text         AS rol,
                    (array_agg(DISTINCT sabahci_ad) FILTER (WHERE sabahci_ad <> ''))
                                            AS karsi_taraf,
                    COUNT(*)                AS gun_sayisi,
                    SUM(CASE WHEN fark < -4 THEN 1 ELSE 0 END) AS eksi_gun,
                    ROUND(AVG(fark)::numeric, 2)  AS ort_fark,
                    ROUND(SUM(fark)::numeric, 2)  AS toplam_fark,
                    array_agg(fark ORDER BY tarih) AS fark_seri,
                    array_agg(tarih ORDER BY tarih) AS tarih_seri
                FROM daily_fark
                WHERE aksamci_ad != ''
                GROUP BY sube_id, aksamci_ad
            )
            SELECT * FROM sabahci_agg
            UNION ALL
            SELECT * FROM aksamci_agg
        """, tuple(params_base))
    except Exception as e:
        log.warning("kucuk_tutar_birikim SQL hata: %s", e)
        return {"gun": gun, "tespit_sayisi": 0, "riskli_personeller": [], "hata": str(e)}

    rows = [dict(r) for r in (cur.fetchall() or [])]

    # ── 5. KRİTER (docstring'de yazıyordu ama UYGULANMIYORDU) ────────────────
    # "Aynı kişinin aynı dönemde AKSAM_KASAYI_SISIRDI / SABAH_ZIMMET_SUPHE
    #  tanısı YOK (çifte sayım önleme)"
    # Sprint G zaten büyük tutarlı olayı yakalıyor; aynı kişiyi burada tekrar
    # saymak, tek olayı iki ayrı bulguya çeviriyordu. Belgelenmiş ama kurulmamış
    # bir kriter, kurulmuş sanılır — en sinsi tür.
    # ⚠️ `truth_motor_kararlar`da personel_ad KOLONU YOK — ad `detay_json`
    # içinde saklanıyor ve anahtar adı tanıya göre değişiyor (aksamci_ad,
    # sabahci_ad, personel_ad…). Anahtar adı TAHMİN ETMİYORUZ: JSON'un tüm
    # metin değerleri toplanıp ada göre eşleştiriliyor. Alan adı tahmini bu
    # projede tekrar eden bir tuzak.
    from database import savepoint as _savepoint
    _zaten_tanili = set()
    try:
        with _savepoint(cur, "sp_birikim_kriter5"):
            cur.execute(
                """SELECT detay_json FROM truth_motor_kararlar
                   WHERE tarih >= CURRENT_DATE - (%s || ' days')::interval
                     AND tani IN ('AKSAM_KASAYI_SISIRDI','SABAH_ZIMMET_SUPHE')""",
                (gun,))
            for _r in (cur.fetchall() or []):
                _dj = dict(_r).get("detay_json")
                if isinstance(_dj, str):
                    try:
                        _dj = json.loads(_dj)
                    except Exception:
                        _dj = None
                if not isinstance(_dj, dict):
                    continue
                for _k2, _v2 in _dj.items():
                    if "ad" in str(_k2).lower() and isinstance(_v2, str) and _v2.strip():
                        _zaten_tanili.add(_v2.strip().lower())
    except Exception as e:  # noqa: BLE001
        # Kriter uygulanamadıysa SESSİZ GEÇMİYORUZ — çıktıda işaretlenecek.
        log.warning("kucuk_tutar_birikim 5. kriter uygulanamadı: %s", e)
        _zaten_tanili = None

    # ── 2. Kriterleri uygula + maks_seri hesapla ─────────────────────────────
    riskli: List[Dict[str, Any]] = []
    elenen_kriter5: List[str] = []

    for r in rows:
        gun_sayisi  = int(r.get("gun_sayisi")  or 0)
        eksi_gun    = int(r.get("eksi_gun")    or 0)
        ort_fark    = float(r.get("ort_fark")  or 0)
        toplam_fark = float(r.get("toplam_fark") or 0)
        personel_ad = str(r.get("personel_ad") or "").strip()
        rol         = str(r.get("rol") or "")
        sube_id_r   = str(r.get("sube_id") or "")
        fark_seri   = list(r.get("fark_seri") or [])

        # Kriter filtresi
        if gun_sayisi < 7:
            continue
        if gun_sayisi == 0:
            continue
        eksi_oran = eksi_gun / gun_sayisi
        if eksi_oran <= 0.55:
            continue
        if not (-80.0 <= ort_fark <= -4.0):
            continue
        if toplam_fark >= -80.0:
            continue
        if not personel_ad:
            continue
        if _zaten_tanili and personel_ad.strip().lower() in _zaten_tanili:
            elenen_kriter5.append(personel_ad)
            continue

        # Maks ardışık eksi gün serisi (gaps-and-islands Python'da)
        maks_seri = 0
        cari_seri = 0
        for f in fark_seri:
            try:
                fv = float(f)
            except (TypeError, ValueError):
                fv = 0.0
            if fv < -4.0:
                cari_seri += 1
                maks_seri = max(maks_seri, cari_seri)
            else:
                cari_seri = 0

        # ── Güven skoru ──────────────────────────────────────────────────────
        guven = 72.0
        if eksi_oran > 0.70:
            guven += 10.0
        if maks_seri >= 5:
            guven += 8.0
        if toplam_fark < -200.0:
            guven += 5.0
        guven = min(guven, 96.0)

        # ── Detay metni ──────────────────────────────────────────────────────
        rol_tr = "Sabahçı" if rol == "sabahci" else "Akşamcı"
        detay = (
            f"{rol_tr} {personel_ad}: {gun_sayisi} günde {eksi_gun} günde kasa açığı "
            f"(%{eksi_oran*100:.0f}). "
            f"Günlük ortalama {ort_fark:.1f}₺ — kümülatif {toplam_fark:.0f}₺. "
            f"En uzun ardışık eksi seri: {maks_seri} gün. "
            f"Rastlantısal değil — sistematik birikim ŞÜPHESİ."
        )
        _karsi = [str(x) for x in (r.get("karsi_taraf") or []) if str(x).strip()]
        if _karsi:
            detay += (" ⚖️ Aynı fark karşı vardiyaya da yazılıyor ("
                      + ", ".join(_karsi[:3])
                      + ") — hangisinden kaynaklandığı bu veriyle AYIRT EDİLEMEZ.")

        riskli.append({
            "personel_ad":  personel_ad,
            # ⚖️ Aynı günlük fark karşı vardiyaya da atfediliyor. Tüketici bu
            # iki satırı BAĞIMSIZ bulgu gibi toplamamalı.
            "karsi_taraf":  _karsi,
            "paylasilan_sorumluluk": bool(_karsi),
            "sube_id":      sube_id_r,
            "rol":          rol,
            "gun_sayisi":   gun_sayisi,
            "eksi_gun":     eksi_gun,
            "eksi_oran":    round(eksi_oran, 3),
            "ort_fark":     ort_fark,
            "toplam_fark":  toplam_fark,
            "maks_seri":    maks_seri,
            "tani":         "KUCUK_TUTAR_BIRIKIM",
            "guven":        round(guven, 1),
            "detay":        detay,
        })

    # Kümülatif farka göre en kötüden sırala
    riskli.sort(key=lambda x: x["toplam_fark"])

    # ⚖️ `tespit_sayisi` SATIR sayısıdır, OLAY sayısı değil: bir açık hem
    # sabahçıya hem akşamcıya satır üretir. Olay sayısı ayrı veriliyor ki
    # "kaç ayrı sorun var" sorusu yanlış cevaplanmasın.
    _olay = len({(x["sube_id"], round(x["toplam_fark"], 2)) for x in riskli})
    return {
        "gun":                gun,
        "tespit_sayisi":      len(riskli),
        "tekil_olay_tahmini": _olay,
        "riskli_personeller": riskli,
        "kriter5_uygulandi":  _zaten_tanili is not None,
        "kriter5_elenen":     elenen_kriter5,
    }


# ════════════════════════════════════════════════════════════════════════════
#  SPRINT J — Cross-day Bardak Devamlılık Kontrolü (Akşamcı Bardak Şişirme)
# ════════════════════════════════════════════════════════════════════════════

def aksam_bardak_sisirme_tespit(cur, sube_id: str, tarih: str) -> Dict[str, Any]:
    """Sprint J — Cross-day bardak devamlılık kontrolü.

    Senaryo (Hikaye 1J):
      Akşamcı kayıt dışı satış yapar. Stok farkını gizlemek için KAPANIS'ta
      bardak sayısını fazla beyan eder (örn: 20 yerine 32 karton). Sabahçı
      ertesi gün kör sayım yapar — gerçeği görür: 20 bardak.
      Gece arası bardak KAYBOLAMAZ → fark = akşamcının şişirmesi.

    İki kaynak BİRBİRİNDEN BAĞIMSIZ:
      dün  → sube_operasyon_event[DÜN,  KAPANIS].meta.kapanis_stok_sayim  (akşamcı beyanı)
      bugün → sube_operasyon_event[BUGÜN, ACILIS].meta.acilis_stok_sayim  (sabahçı kör sayımı)

    Cross-sinyal (güçlendirici):
      Aynı gün N1 (dün KAPANIS.devir) > N2 (bugün ACILIS.kasa_sayim):
      akşamcı hem kasa hem bardak şişirdi → çok güçlü zimmet korelasyonu.

    Eşik:
      gece_karton_kaybi > 3 VE/VEYA gece_plastik_kaybi > 3 → AKSAM_BARDAK_SISIRDI

    Returns:
        {
          "tani":               "AKSAM_BARDAK_SISIRDI" | "UYUMLU" | "YETERSIZ_VERI",
          "guven":              float,
          "gece_karton_kaybi":  int,     # pozitif = "eridi" (anomali)
          "gece_plastik_kaybi": int,
          "dun_karton":         int,     # dün KAPANIS beyanı
          "dun_plastik":        int,
          "bugun_karton":       int,     # bugün ACILIS kör sayım
          "bugun_plastik":      int,
          "karton_anomali":     bool,
          "plastik_anomali":    bool,
          "kasada_acik":        bool,    # N1 > N2 kasa cross-sinyal
          "n1_devir":           float,
          "n2_kasa":            float,
          "fark_n1_n2":         float,   # N2 − N1 (negatif = kasa açığı)
          "aksamci_ad":         str,
          "detay":              str,
        }
    """
    from datetime import date, timedelta

    sonuc: Dict[str, Any] = {
        "tani":               "YETERSIZ_VERI",
        "guven":              0.0,
        "gece_karton_kaybi":  0,
        "gece_plastik_kaybi": 0,
    }

    # tarih = bugün (ACILIS tarihi); dun_tarih = bugün − 1 gün (KAPANIS tarihi)
    try:
        dun_tarih = (date.fromisoformat(str(tarih)) - timedelta(days=1)).isoformat()
    except Exception:
        return sonuc

    # ── 1. Dün KAPANIS: bardak sayımı + devir (N1 kasa) + akşamcı adı ─────────
    cur.execute("""
        SELECT meta, devir, personel_ad
        FROM sube_operasyon_event
        WHERE sube_id = %s
          AND tarih = %s::date
          AND tip = 'KAPANIS'
          AND durum = 'tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST
        LIMIT 1
    """, (sube_id, dun_tarih))
    dun_row = cur.fetchone()
    if not dun_row:
        return sonuc

    dun = dict(dun_row)
    dun_meta = _meta_oku(dun.get("meta"))
    dun_stok  = dun_meta.get("kapanis_stok_sayim") or {}
    n1_devir  = float(dun.get("devir") or 0)
    aksamci_ad = str(dun.get("personel_ad") or "").strip() or None

    # ── 2. Bugün ACILIS: bardak sayımı + kasa_sayim (N2) + sabahçı adı ────────
    cur.execute("""
        SELECT meta, kasa_sayim, personel_ad
        FROM sube_operasyon_event
        WHERE sube_id = %s
          AND tarih = %s::date
          AND tip = 'ACILIS'
          AND durum = 'tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST
        LIMIT 1
    """, (sube_id, tarih))
    bugun_row = cur.fetchone()
    if not bugun_row:
        return sonuc

    bugun = dict(bugun_row)
    bugun_meta = _meta_oku(bugun.get("meta"))
    bugun_stok = bugun_meta.get("acilis_stok_sayim") or {}
    n2_kasa    = float(bugun.get("kasa_sayim") or 0)
    sabahci_ad = str(bugun.get("personel_ad") or "").strip() or None

    # ── 3. Bardak değerleri ──────────────────────────────────────────────────
    dun_kucuk   = float(dun_stok.get("bardak_kucuk",   0) or 0)
    dun_buyuk   = float(dun_stok.get("bardak_buyuk",   0) or 0)
    dun_plastik = float(dun_stok.get("bardak_plastik", 0) or 0)
    dun_karton  = dun_kucuk + dun_buyuk

    bugun_kucuk   = float(bugun_stok.get("bardak_kucuk",   0) or 0)
    bugun_buyuk   = float(bugun_stok.get("bardak_buyuk",   0) or 0)
    bugun_plastik = float(bugun_stok.get("bardak_plastik", 0) or 0)
    bugun_karton  = bugun_kucuk + bugun_buyuk

    # En az bir tarafın dolu olması gerekir; tamamen sıfır → veri yok
    if dun_karton == 0 and dun_plastik == 0:
        return sonuc

    # ── 4. Gece kaybı (pozitif = bardak "eridi" → anomali) ──────────────────
    gece_karton_kaybi  = int(round(dun_karton  - bugun_karton,  0))
    gece_plastik_kaybi = int(round(dun_plastik - bugun_plastik, 0))

    # ── 5. Cross-sinyal: N1 > N2 kasa açığı ─────────────────────────────────
    fark_n1_n2  = round(n2_kasa - n1_devir, 2)   # negatif = kasa açığı
    kasada_acik = bool(fark_n1_n2 < -0.99)

    sonuc.update({
        "dun_karton":         int(dun_karton),
        "dun_plastik":        int(dun_plastik),
        "bugun_karton":       int(bugun_karton),
        "bugun_plastik":      int(bugun_plastik),
        "gece_karton_kaybi":  gece_karton_kaybi,
        "gece_plastik_kaybi": gece_plastik_kaybi,
        "n1_devir":           n1_devir,
        "n2_kasa":            n2_kasa,
        "fark_n1_n2":         fark_n1_n2,
        "kasada_acik":        kasada_acik,
        "aksamci_ad":         aksamci_ad,
        "sabahci_ad":         sabahci_ad,
        "onceki_tarih":       dun_tarih,
    })

    # ── 6. Eşik: bardak gece kaybolmaz ──────────────────────────────────────
    ESIK_ADET = 3
    karton_anomali  = gece_karton_kaybi  > ESIK_ADET
    plastik_anomali = gece_plastik_kaybi > ESIK_ADET

    sonuc["karton_anomali"]  = karton_anomali
    sonuc["plastik_anomali"] = plastik_anomali

    if not (karton_anomali or plastik_anomali):
        aks_isim = aksamci_ad or "Akşamcı"
        sab_isim = sabahci_ad or "Sabahçı"
        detay = (
            f"Gece bardak kaybı normal sınırlar içinde: "
            f"karton {gece_karton_kaybi:+d} adet, plastik {gece_plastik_kaybi:+d} adet. "
            f"(dün {aks_isim} KAPANIS → bugün {sab_isim} ACILIS) — uyumlu."
        )
        sonuc["tani"]       = "UYUMLU"
        sonuc["guven"]      = 80.0
        sonuc["detay"]      = detay
        sonuc["karar_ozeti"] = (
            f"{aks_isim} kapanışı ile {sab_isim} açılışı örtüşüyor. "
            f"Bardak sayımında anlamlı fark yok — her iki taraf uyumlu."
        )
        return sonuc

    # ── 7. Güven skoru ───────────────────────────────────────────────────────
    guven = 78.0
    if karton_anomali and plastik_anomali:
        guven += 8.0     # → 86: hem karton hem plastik anormal → çok güçlü
    if kasada_acik:
        guven += 10.0    # → 88–96: N1>N2 kasa açığı da var → koleksiyon kanıtı
    if gece_karton_kaybi > 10 or gece_plastik_kaybi > 10:
        guven += 3.0     # büyük fark → daha yüksek güven
    guven = min(guven, 96.0)

    # ── 8. İki senaryo analizi — kim suçlu? kasa hakem ──────────────────────
    aks_isim = aksamci_ad or "Akşamcı"
    sab_isim = sabahci_ad or "Sabahçı"
    toplam_kayip_adet = max(0, gece_karton_kaybi) + max(0, gece_plastik_kaybi)

    anomali_parcalar = []
    if karton_anomali:
        anomali_parcalar.append(
            f"karton {int(dun_karton)} → {int(bugun_karton)} ({gece_karton_kaybi:+d} adet)"
        )
    if plastik_anomali:
        anomali_parcalar.append(
            f"plastik {int(dun_plastik)} → {int(bugun_plastik)} ({gece_plastik_kaybi:+d} adet)"
        )
    fark_ozet = " | ".join(anomali_parcalar)

    # Senaryo A: Akşamcı doğru saydı, sabahçı yanlış saydı → para kaybı yok
    senaryo_a = {
        "harf":    "A",
        "baslik":  f"{sab_isim} sayım hatası",
        "kim":     sab_isim,
        "aciklama": (
            f"{sab_isim} açılış kör sayımında {toplam_kayip_adet} bardak eksik gördü. "
            f"{aks_isim} kapanışı doğru yapmış olabilir — para kaybı yok, sayım hatası."
        ),
        "kanitlar": (
            ["Kasa dengede (N1≈N2) → para yerinde, sayım yanlış" ]
            if not kasada_acik else []
        ),
        "zayiflatanlar": (
            [f"Kasa da {abs(fark_n1_n2):.0f}₺ açık → para da eksik, sayım hatası tek başına açıklamaz"]
            if kasada_acik else []
        ),
        "muhtemel": not kasada_acik,
    }

    # Senaryo B: Sabahçı doğru saydı, akşamcı şişirdi → zimmet
    senaryo_b = {
        "harf":    "B",
        "baslik":  f"{aks_isim} kapanış şişirmesi",
        "kim":     aks_isim,
        "aciklama": (
            f"{aks_isim} kapanışta bardak sayısını {toplam_kayip_adet} adet fazla yazdı. "
            f"Kayıt dışı satış geliri gizlenmiş, para kasaya girmemiş olabilir."
        ),
        "kanitlar": (
            [f"Kasa da açık: N1={n1_devir:.0f}₺ (devir) vs N2={n2_kasa:.0f}₺ (kör) = {abs(fark_n1_n2):.0f}₺ fark — çift sinyal"]
            if kasada_acik else []
        ),
        "zayiflatanlar": (
            ["Kasa dengede — para kaybı yok, bardak farkı tek başına sayım hatasından kaynaklanıyor olabilir"]
            if not kasada_acik else []
        ),
        "muhtemel": kasada_acik,
    }

    # Hakem kararı: kasa cross-sinyali
    kasa_fazla = fark_n1_n2 > 0.99   # N2 > N1 (sabahçı kasayı fazla buldu)
    if kasada_acik:
        olasi_senaryo = "B"
        karar_ozeti = (
            f"⚖️ Kasa da açık ({abs(fark_n1_n2):.0f}₺): "
            f"{aks_isim} {n1_devir:.0f}₺ devir bıraktı dedi, "
            f"{sab_isim} {n2_kasa:.0f}₺ buldu. "
            f"Hem bardak ({fark_ozet}) hem kasa açığı → "
            f"Senaryo B daha muhtemel: {aks_isim} kasayı şişirdi."
        )
    elif kasa_fazla:
        olasi_senaryo = "BELIRSIZ"
        karar_ozeti = (
            f"⚖️ Kasa fazla ({abs(fark_n1_n2):.0f}₺ — {sab_isim} beklenenden fazla buldu) + "
            f"bardak eksik ({fark_ozet}). Her iki tarafın da hata yapmış olması mümkün. "
            f"Fiziksel yeniden sayım gerekli."
        )
    else:
        olasi_senaryo = "A"
        karar_ozeti = (
            f"⚖️ Kasa dengede (N1={n1_devir:.0f}₺ ≈ N2={n2_kasa:.0f}₺, para kaybı yok). "
            f"Bardak farkı ({fark_ozet}) büyük ihtimalle "
            f"{sab_isim}'in açılış kör sayım hatasıdır. "
            f"Senaryo A daha muhtemel: eğitim yeterli, soruşturma gerekmez."
        )

    # ── 9. Detay metni ───────────────────────────────────────────────────────
    detay = (
        f"Dün {aks_isim} KAPANIS beyanı: {int(dun_karton)} karton + {int(dun_plastik)} plastik. "
        f"Bugün {sab_isim} kör ACILIS sayımı: {int(bugun_karton)} karton + {int(bugun_plastik)} plastik. "
        f"Gece arası bardak kaybolmaz → {fark_ozet}. {karar_ozeti}"
    )

    sonuc.update({
        "tani":               "AKSAM_BARDAK_SISIRDI",
        "guven":              round(guven, 1),
        "detay":              detay,
        "senaryo_a":          senaryo_a,
        "senaryo_b":          senaryo_b,
        "olasi_senaryo":      olasi_senaryo,
        "karar_ozeti":        karar_ozeti,
        "toplam_kayip_adet":  toplam_kayip_adet,
        "sabahci_ad":         sabahci_ad,
    })
    return sonuc


# ════════════════════════════════════════════════════════════════════════════
#  OLAY ÖZETİ — Tüm sprint bulgularını tek insan-okunabilir anlatıda birleştir
# ════════════════════════════════════════════════════════════════════════════

def gunluk_teyit_karti(cur, sube_id: str, tarih: str) -> Dict[str, Any]:
    """Günlük Teyit + Bulgu Kartı — Her kontrol boyutunu sade Türkçe özetler.

    Her olası durum ve varyant için önceden tanımlanmış açıklama içerir:
      - ne oldu (sayısal gerçek)
      - ne anlama geliyor (yorum)
      - olası nedenler (liste)
      - ne yapılmalı (aksiyon)
      - çapraz korelasyon (birden fazla kontrol tetiklenince bağlantı)

    Sistem N1/N2/N3 gibi teknik kodlar KULLANMAZ:
      N2 → "Sabah kasası" | N1 → "Akşam devir" | N3 → "Evo POS teyidi"
    """
    from datetime import date, timedelta

    # ════════════════════════════════════════════════════════════════════════
    #  TÜM DURUM YORUMLARI — her state için önceden yazılmış açıklama
    # ════════════════════════════════════════════════════════════════════════
    _Y: Dict[str, Dict[str, Any]] = {

        # ── 1. SABAH KASASI ──────────────────────────────────────────────────
        "sabah_kasasi.dengede": {
            "anlam": "Dünkü akşamcı kasayı doğru bırakmış, sabahçı da doğru saymış. Devir zinciri temiz — iki bağımsız kişi aynı değerde buluştu.",
            "nedenler": [],
            "aksiyon": "Rutin takip yeterli.",
        },
        "sabah_kasasi.kucuk_acik": {
            "anlam": "1–20₺ aralığındaki farklar genellikle bozuk para sayım hatasından kaynaklanır. Kasa defteri ile çapraz bakılmalı. Tek başına zimmet göstergesi sayılmaz.",
            "nedenler": ["Bozuk para yanlış sınıflandırıldı", "Sayım sırası karışıklığı", "İnce fark — fiş farkı"],
            "aksiyon": "Kasayı tekrar say. Aynı kişide arka arkaya tekrarlanıyorsa bildir.",
        },
        "sabah_kasasi.orta_acik": {
            "anlam": "20–100₺ aralığı sayım hatası için büyük, tek başına zimmet için küçük. İki senaryo var: (A) dünkü akşamcı deviri şişirdi — kasadan para almak için, (B) sabahçı gerçek sayım yaptı ama gece kasa açıldı. Bardak ve stok kontrolleriyle çapraz bakılıyor.",
            "nedenler": [
                "Akşamcı deviri fazla beyan etti (kasadan para almak için)",
                "Sabahçı sayım hatası",
                "Gece kasadan bilinmeyen nakit çıkışı",
            ],
            "aksiyon": "Akşam devir ve gece bardak kontrolüne bak. İkisi de tetiklendiyse soruşturma.",
        },
        "sabah_kasasi.buyuk_acik": {
            "anlam": "100₺ üzeri fark ciddi. Bu düzeyde hata olasılığı düşüktür — devir şişirme veya gece kasa açma senaryoları güçlüdür. Kamera ve stok verisiyle çapraz doğrulama şart.",
            "nedenler": [
                "Akşamcı kasayı önemli miktarda şişirerek para cebe koymuş olabilir",
                "Sabahçı önceki vardiyadan para almış olabilir",
                "Kasa soyulmuş veya yetkisiz kişi girişi",
            ],
            "aksiyon": "Kamera inceleme + her iki personeli ayrı ayrı sorgula + stok kontrolü + soruşturma.",
        },
        "sabah_kasasi.kucuk_fazla": {
            "anlam": "Sabahçı deviri beklenenden fazla bulmuş. 1–20₺ aralığında bozuk para ekstrası veya küçük ölçüm farkı olarak değerlendirilebilir. Nadir ama normal.",
            "nedenler": ["Bozuk para sayım ekstrası", "Küçük nakit bırakıldı"],
            "aksiyon": "Kayıt altına al, rutin takip.",
        },
        "sabah_kasasi.buyuk_fazla": {
            "anlam": "Sabahçı deviri beklenenden belirgin şekilde fazla bulmuş. Nadir ama dikkat çekici: dünkü akşamcı deviri düşük beyan etmiş (kendi lehine koruma?) ya da bilinmeyen bir nakit kasaya girmiş.",
            "nedenler": [
                "Akşamcı deviri eksik beyan etti — kasada bırakıp defterini az yazdı",
                "Kasaya bilinmeyen nakit girişi (iade, bağış, bulunan para)",
                "Sabahçı sayım fazla okudu",
            ],
            "aksiyon": "Akşamcıyla birebir görüş — deviri neden düşük beyan ettiğini sor. Kasa defteri incele.",
        },
        "sabah_kasasi.acilis_yok": {
            "anlam": "Açılış sayımı henüz sisteme girilmemiş. Mesai başlamamış, personel bekliyor ya da sistem kaydı yapılmadı.",
            "nedenler": ["Erken saat — açılış yapılmamış", "Açılış yapıldı ama PIN girilmedi"],
            "aksiyon": "Açılış PIN girişi tamamlandı mı kontrol et.",
        },
        "sabah_kasasi.ref_yok": {
            "anlam": "Önceki gün kapanış kaydı bulunamadı. Karşılaştırma yapılamıyor. İlk gün veya dün kapanış kaydedilmemişse normaldir.",
            "nedenler": ["Şube dün kapalıydı", "Kapanış sisteme kaydedilmedi", "İlk operasyon günü"],
            "aksiyon": "Dünkü kapanış kaydını kontrol et.",
        },

        # ── 2. AKŞAM DEVİR BEYANI ─────────────────────────────────────────────
        "aksam_devir.uyumlu": {
            "anlam": "Dünkü akşamcının bıraktığı devir tutarı, sabahçının kör sayımıyla uyuşuyor ve dünkü stokta açık yoktu. Devir beyanı güvenilir.",
            "nedenler": [],
            "aksiyon": "Rutin takip yeterli.",
        },
        "aksam_devir.aksam_sisirdi": {
            "anlam": "Akşamcı kasayı fazla göstermiş: devir olarak söylediği ile sabahçının bulduğu arasında fark var, üstelik dünkü stokta da açık çıkmış. Bu iki sinyal birlikte 'akşamcı kasadan para aldı, farkı devir tutarını şişirerek kapattı' senaryosuna işaret eder.",
            "nedenler": [
                "Akşamcı kayıt dışı satış gelirini cebe koydu, stok açığını devir şişirerek kapattı",
                "İptal edilmeyen satış fişi — para cebe, kayıt kasada kaldı",
                "Koordineli iki personel (akşamcı + bir diğeri) — daha az olası",
            ],
            "aksiyon": "Zimmet soruşturması: kamera inceleme + stok ve fiş çapraz tutma + personeli bildir + CFO bildirim.",
        },
        "aksam_devir.sabah_zimmet": {
            "anlam": "N1>N2 farkı var, ama dünkü bardak sayımı uyumlu — bu, N1'in (akşamcı deviri) fiziksel stokla doğrulandığı anlamına gelir. Dolayısıyla sabahçı kasayı düşük saymış olabilir, para almış olabilir.",
            "nedenler": [
                "Sabahçı kör sayımda kasayı eksik beyan etti — açığı kapatmak için",
                "Akşamcı doğru bıraktı, sabahçı parayı aldı",
            ],
            "aksiyon": "Sabahçı kamera inceleme + sayımın tekrar edilmesi + CFO bildirim.",
        },
        "aksam_devir.iptal_suphe": {
            "anlam": "Kasa açığı var ama stok ve Evo'da açıklama yok. Bu 'hayalet iptal' senaryosuna işaret eder: satış yapıldı, sonra sisteme sahte iptal girildi, para cebe alındı.",
            "nedenler": [
                "Evo'da sahte iptal fişi oluşturuldu — gerçek satış iptali değil",
                "Nakit satış gerçekleşti, iptal girilerek kasadan para çekildi",
            ],
            "aksiyon": "Evo satış panelinde o vardiya iptal fişlerini manuel kontrol et. Fiş ID'lerini kamera görüntüsüyle eşleştir.",
        },
        "aksam_devir.kucuk_fark": {
            "anlam": "Devir ile sabah sayımı arasında küçük bir fark var ama dünkü stokta açık yok. Stok uyumluyken kasa farkının stok kayıpla bağı kurulamadı — büyük ihtimalle sayım hatası.",
            "nedenler": ["Bozuk para sayım hatası", "Kasa defteri fark", "Küçük ölçüm sapması"],
            "aksiyon": "Kasayı bir kez daha say. Tekrar ediyorsa stokla birlikte değerlendir.",
        },
        "aksam_devir.orta_fark_stoksuz": {
            "anlam": "20–100₺ fark var ama dünkü stok açığı bulunamadı veya motor henüz çalışmamış. Stok verisini bekle — eşleşirse şişirme, eşleşmezse sayım hatası yönünde ilerle.",
            "nedenler": [
                "Devir şişirme ama stok verisi henüz mevcut değil",
                "Sayım hatası — stok uyumlu çıkarsa bu güçlenir",
            ],
            "aksiyon": "Motoru çalıştır, stok verisini güncelle. Ardından tekrar değerlendir.",
        },
        "aksam_devir.buyuk_fark_stoksuz": {
            "anlam": "100₺ üzeri devir farkı var ve stok analizi henüz yapılmamış veya açık çıkmadı. Bu büyüklükte hata sayım hatası olmaz — ama stok verisi yoksa kesin karar verilemez.",
            "nedenler": [
                "Devir şişirme — stok açığı gizlenmiş olabilir",
                "Stok motor verisi eksik — yanıltıcı uyumluluk",
                "Kasa soyulmuş (stok bozulmadan sadece nakit)",
            ],
            "aksiyon": "Acil: motoru çalıştır, stok ve kamera incele, personeli haberdar et.",
        },
        "aksam_devir.ref_yok": {
            "anlam": "Önceki gün kapanış kaydı yok. Devir beyanının doğrulanacak referansı yok.",
            "nedenler": ["İlk gün", "Dün kapanış girilmedi"],
            "aksiyon": "Dünkü kapanış kaydını kontrol et.",
        },

        # ── 3. EVO POS TEYİDİ ─────────────────────────────────────────────────
        "evo_teyit.uyumlu": {
            "anlam": "Evo POS sistemi, kasa beyanını doğruluyor. Satış geliri, ikram ve nakit akışı kasa sayımıyla matematiksel olarak örtüşüyor. En güçlü bağımsız teyit.",
            "nedenler": [],
            "aksiyon": "Rutin takip.",
        },
        "evo_teyit.ikram_evo_teyit": {
            "anlam": "Stok düştü ama POS'tan geçmiş (ikram veya satış olarak kayıtlı). Temiz zincir — hem ürün çıkışı hem kayıt uyumlu.",
            "nedenler": [],
            "aksiyon": "İkram politikasını gözden geçir — sık tekrarlanıyorsa ikram miktarı değerlendirilebilir.",
        },
        "evo_teyit.ikram_unutuldu": {
            "anlam": "N1=N2 (sayım uyumlu) ama Evo beklenenden farklı. Ürün kullanıldı ama POS'a yazılmadı. İkram veya dahili tüketim kayıt dışı kalmış olabilir.",
            "nedenler": ["İkram POS'a girilmedi", "Personel tüketimi kayıtsız", "Demo ürünler sisteme işlenmedi"],
            "aksiyon": "Z raporu ve ikram defteri kontrol et. İkram politikasını hatırlat.",
        },
        "evo_teyit.sweethearting": {
            "anlam": "Sayım uyumlu ama Evo'da açıklanamayan fazla nakit var. Klasik sweethearting: personel arkadaşına/tanıdığına ürünü verir, POS'a farklı (daha ucuz) şey girer. Nakit fark kasada kalmış.",
            "nedenler": [
                "Personel arkadaşına indirimli veya farklı ürün girdi — nakit fark kasada",
                "Düşük fiyatlı ürün girilip yüksek fiyatlı verildi",
                "Kasa farkı birikiyor ama stok bunu desteklemiyor",
            ],
            "aksiyon": "Kasa baskını başlat. Kamera inceleme: son 7 gün POS girişleriyle ürün çıkışlarını karşılaştır.",
        },
        "evo_teyit.stok_kacagi": {
            "anlam": "Stok düştü, Evo (satış+ikram) bile yetmiyor. Ürün kullanıldı ama kayıt yok. Bu kasıtlı bir kayıt dışı kullanım veya ihmal olabilir.",
            "nedenler": [
                "Kayıt dışı satış — ürün verildi, POS atlandı, nakit alındı",
                "Personel tüketimi (özellikle vardiya sonunda)",
                "Fire olarak yazılması unutulmuş bozulma/zayi",
            ],
            "aksiyon": "Personeli sorgula: ikram mı yoksa kayıt dışı satış mı? Kamera bak. Fire kaydı var mı kontrol et.",
        },
        "evo_teyit.zimmet_nakit": {
            # 🔴 TRUTH-001: burada "bu zimmettir" deniyordu. Oysa eşleşme,
            # koda gömülü TAHMİNİ fiyatlarla kuruluyor ve aynı tabloyu birkaç
            # masum senaryo da üretebiliyor. Motor şüphe üretir, hüküm vermez;
            # hükmü veren, kanıta bakan insandır.
            "anlam": "Stok düştü, Evo eksik, kasa açık — ve üçü sayısal olarak birbirini tutuyor. Bu tabloyu üretebilecek EN OLASI senaryo zimmettir (ürün verildi, POS atlandı, para alındı). ⚠️ Eşleşme TAHMİNİ satış fiyatlarıyla kurulduğu için tek başına kanıt sayılmaz.",
            "nedenler": [
                "Personel ürünü sattı, POS'a girmedi, parayı cebe koydu",
                "Kasadan açık alındı ve stok bu açığı haklı kılıyor",
                "Kayıtsız fire/ikram + ayrı bir kasa sayım hatası aynı anda oldu (masum açıklama)",
            ],
            "aksiyon": "ÖNCE kanıt topla: o günün kamera kaydı, fire/ikram defteri, POS iptal logu ve kasa yeniden sayımı. Tablo bu kanıtlarla da duruyorsa soruşturma başlat. Kişiyle konuşmadan önce sayıları doğrula.",
        },
        "evo_teyit.sabah_hatali": {
            "anlam": "Bu boyutta N1 ile N2 farklı, ve Evo N1'i destekliyor. Yani akşamcının söylediği değer POS verileriyle daha uyumlu — sabahçı saymış ama hata yapmış olabilir.",
            "nedenler": ["Sabahçı sayım hatası", "Stok fiziksel transferi var mı?"],
            "aksiyon": "Sabahçıyı çağır, yeniden PIN ile teyit et. Gerekirse üçüncü kişi say.",
        },
        "evo_teyit.aksam_hatali": {
            "anlam": "N1 ile N2 farklı, Evo N2'yi destekliyor. Sabahçının bulduğu değer POS verileriyle daha uyumlu — akşamcı beyanı güvenilir değil.",
            "nedenler": ["Akşamcı yanlış saydı veya kasıtlı beyan değiştirdi", "Devir anında stok değişmiş"],
            "aksiyon": "Akşamcı çağır, PIN teyit et. Stok kontrol et.",
        },
        "evo_teyit.cozulmedi": {
            "anlam": "Tek boyutta fark var, Evo nötr — ne N1 ne N2'yi destekliyor. Üçüncü bağımsız sayım gerekiyor.",
            "nedenler": ["Evo verisi bu boyut için yeterli değil", "Her iki taraf da hatalı olabilir"],
            "aksiyon": "Üçüncü kişi sayım talep et. Evo'yu güncelle.",
        },
        "evo_teyit.pos_sync": {
            "anlam": "Kasa ve stok sayımları uyumlu ama Evo sürekli farklı değer gösteriyor. Büyük ihtimalle teknik senkronizasyon sorunu — gerçek bir zimmet değil.",
            "nedenler": ["Evobulut bağlantı sorunu", "Rapor cache eski", "Farklı şube ID eşleşme hatası"],
            "aksiyon": "IT/Evo destek: rapor cache'i temizle, şube ID eşleşmesini kontrol et.",
        },
        "evo_teyit.pos_bypass": {
            "anlam": "Bardak düştü ama Evo'da hiç kayıt yok. POS tamamen atlanmış — ürün verildi, POS'a girilmedi, para alındı ama izler yok.",
            "nedenler": [
                "POS cihazı devre dışı bırakıldı veya atlandı",
                "Ürün kayıt dışı verildi, nakit doğrudan alındı",
                "Teknik arıza sırasında satış yapıldı",
            ],
            "aksiyon": "Evo yetki logları + manuel iade kontrol + kamera.",
        },
        "evo_teyit.motor_yok": {
            "anlam": "Akıllı motor bu güne henüz çalışmamış. Evo karşılaştırması YAPILMADI — bu 'temiz' demek DEĞİL, 'BAKILMADI' demektir.",
            "nedenler": ["Motor henüz tetiklenmedi"],
            "aksiyon": "Panelden 'Çalıştır' butonuna bas veya otomatik zamanlamayı kontrol et.",
        },
        # 🔴 TRUTH-011 (2026-09-02): KAOS tanımı "her iki taraf da hatalı, Evo
        # nötr"dür — yani ÇÖZÜLEMEMİŞ bir durumdur. Buna rağmen hırsızlık
        # anlatısına (zimmet_nakit) eşlenmişti: aksiyonu "kasa baskını + kamera
        # + hukuki süreç" diyordu. Belirsizliği suçlamaya çevirmek, motorun
        # yapabileceği en pahalı hatadır — masum personeli hedef alır.
        "evo_teyit.kaos": {
            "anlam": "Sabahçı ve akşamcının beyanları BİRBİRİYLE de Evo ile de tutmuyor. Bu, kimin haklı olduğunu SÖYLEYEMEDİĞİMİZ bir durumdur — hırsızlık kanıtı DEĞİLDİR. Aynı tabloyu sayım hatası, kayıt gecikmesi ve zimmet birlikte üretebilir.",
            "nedenler": [
                "Her iki sayım da hatalı olabilir",
                "Evo verisi o gün için eksik/gecikmeli olabilir",
                "Gün içinde kayıtsız hareket olmuş olabilir (fire, ikram, transfer)",
            ],
            "aksiyon": "Suçlama YAPMA. Üçüncü bağımsız sayım al, Evo verisini tazele, gün içi hareketleri (fire/ikram/transfer) kontrol et. Tablo netleşmeden kişi konuşulmaz.",
        },
        # 🔴 TRUTH-013: SABAH_ZIMMET_SUPHE, "sabahçı kasayı düşük beyan etti"
        # tanısıdır — ama `sabah_hatali` anlatısına eşlenmişti ve orada
        # "sabahçı saymış ama hata yapmış olabilir · yeniden say" yazıyordu.
        # Yani ZİMMET ŞÜPHESİ sonraki katmanda SAYIM HATASINA dönüşüyordu:
        # sinyal severity'de kritik kalıyor ama anlatı onu silikleştiriyordu.
        "evo_teyit.sabah_zimmet_suphe": {
            "anlam": "Dün akşamki bardak sayımı ve Evo satışı akşamcının beyanını destekliyor; sabahçının bildirdiği kasa ise bunun ALTINDA. Bu bir ŞÜPHEDİR, hüküm değil — aynı tabloyu para sayma hatası da üretebilir.",
            "nedenler": [
                "Sabahçı kasayı eksik saymış olabilir (dürüst hata)",
                "Devir anında para fiziksel olarak eksik verilmiş olabilir",
                "Kasadan kayıtsız çıkış yapılmış olabilir",
            ],
            "aksiyon": "ÖNCE yeniden say ve devir kaydını kontrol et. Fark doğrulanırsa kamera kaydına bak. Kişiye tek başına dayanan sonuç çıkarma.",
        },

        # ── 4. GECE BARDAK DEVAMLILIĞI ─────────────────────────────────────────
        "gece_bardak.uyumlu": {
            "anlam": "Dün akşamcının saydığı bardak sayısıyla bugün sabahçının saydığı uyuşuyor. Gece bardak kaybolmaz — uyuşmaları her ikisinin de dürüst sayım yaptığını gösterir.",
            "nedenler": [],
            "aksiyon": "Rutin takip.",
        },
        "gece_bardak.sisirme_kasa_acik": {
            "anlam": "Dün gece bardak eridi VE kasa açığı da var. İki sinyal birlikte çok güçlü: akşamcı hem bardak sayısını hem devir tutarını şişirdi — kayıt dışı satış gelirini böyle gizlemiş olabilir.",
            "nedenler": [
                "Akşamcı kayıt dışı sattı, stok farkını kapanışta bardak sayısını şişirerek kapattı",
                "Deviri de fazla beyan etti, sabahçı her ikisini de gerçek değerde buldu",
            ],
            "aksiyon": "Kritik zimmet soruşturması: kamera + akşamcı sorgulama + CFO bildirim.",
        },
        "gece_bardak.sisirme_kasa_dengede": {
            "anlam": "Gece bardak eridi AMA kasa dengede. Bu bir gerilim yaratıyor: bardak şişirmesi var ama kasada karşılığı yok. İki senaryo: (A) sabahçı bardakları yanlış saydı — para kaybı yok. (B) Akşamcı şişirdi ama gizledi. Kasa dengede olduğu için Senaryo A daha güçlü.",
            "nedenler": [
                "Senaryo A (daha muhtemel): Sabahçı açılış sayımında bardakları eksik saydı — yanlış kasa, yanlış yer",
                "Senaryo B (daha az muhtemel): Akşamcı şişirdi ama paranın izini başka şekilde kapattı",
            ],
            "aksiyon": "Sabahçıya fiziksel yeniden sayım yaptır. Kasa dengeli kalıyorsa Senaryo A — tutanağa geç.",
        },
        "gece_bardak.veri_yok": {
            "anlam": "Dün kapanış bardak sayımı veya bugün açılış bardak sayımı eksik. Kontrol yapılamıyor.",
            "nedenler": ["Kapanış meta'sı bardak alanı boş", "Açılış meta'sı bardak alanı boş", "Personel doldurma atladı"],
            "aksiyon": "Kapanış ve açılış ekranlarında bardak sayım alanlarının doldurulduğunu kontrol et.",
        },

        # ── 5. SÜT KULLANIMI ──────────────────────────────────────────────────
        "sut_kullanimi.uyumlu": {
            "anlam": "Gerçek süt tüketimi teorik değere (reçete × satış adedi) yakın. Baristaların porsiyonları düzgün yapıldığını, kayıt dışı ürün üretimi olmadığını gösterir.",
            "nedenler": [],
            "aksiyon": "Rutin takip.",
        },
        "sut_kullanimi.hafif_sapma": {
            "anlam": "%30–50 sapma genellikle porsiyonlama tolerans aralığının dışına çıkmış demektir. Eğitim kaynaklı olabilir — barista reçeteyi ezberden yapıyor, ölçmüyor.",
            "nedenler": [
                "Barista sütü reçeteye göre değil gözle koyuyor — tutarsız porsiyon",
                "Büyük boy fincan kullanımı yüksek",
                "Özel içecek (sıcak süt, foam) kaydedilmedi",
            ],
            "aksiyon": "Barista porsiyonlama gözlemi + ölçüm fincancığı kullanımını kontrol et.",
        },
        "sut_kullanimi.ciddi_sapma": {
            "anlam": "%50–80 sapma ciddi. Porsiyonlama hatasının bu kadar büyük olması çok düşük ihtimal — kayıt dışı ürün (özel müşteri için yapılan gizli içecek veya personel tüketimi) veya stok sayım hatası var.",
            "nedenler": [
                "Kayıt dışı içecek üretimi — POS'a girilmeden müşteriye verildi",
                "Personel süt tüketimi (kahve, çay vs.) kaydedilmedi",
                "Stok sayımında hata — gerçek tüketim farklı",
            ],
            "aksiyon": "Barista gözlem + POS kayıt dışı satış taraması + süt stok fiziksel kontrol.",
        },
        "sut_kullanimi.cok_ciddi_sapma": {
            "anlam": "%80 üzeri sapma son derece yüksek. Bu ölçekte kayıt dışı satış veya organize süt israfı/hırsızlığı şüphesi doğuruyor.",
            "nedenler": [
                "Kayıt dışı toplu sipariş (catering, kurumsal — POS atlandı)",
                "Süt çalınması veya dışarıya çıkarılması",
                "Stok açılış/kapanış hatası — veri bütünlüğü sorunu",
            ],
            "aksiyon": "CFO bildirim + kamera + stok fiziksel sayım + fiş incele.",
        },
        "sut_kullanimi.az_tuketim": {
            "anlam": "Gerçek tüketim teorik değerin altında. Evo'da teorik tüketimi haklı kılacak kadar satış görünüyor ama süt az kullanılmış. Ya Evo rakamları fazla ya da süt sayımı hatalı.",
            "nedenler": [
                "Evo satış adedi fazla kayıtlı (teknik hata veya çift kayıt)",
                "Süt açılış/kapanış sayımı hatalı — ölçüm birimi karışıklığı (litre vs. paket)",
                "İçecek reçetelerinde değişiklik ama BOM güncellenmedi",
            ],
            "aksiyon": "Evo satış adedini çapraz kontrol et. BOM reçetelerini gözden geçir.",
        },
        "sut_kullanimi.veri_yok": {
            "anlam": "Süt sayım verisi yok — açılış veya kapanış meta'sında süt alanı boş. Kontrol yapılamıyor.",
            "nedenler": ["Personel süt alanını doldurmadı", "Stok sayım ekranı atlandı"],
            "aksiyon": "Açılış ve kapanış ekranlarında süt litre alanının zorunlu doldurulduğunu kontrol et.",
        },

        # ── 6. AKŞAM VARDIYASI BARDAK DENGESİ ─────────────────────────────────
        "aksam_vardiya_bardak.uyumlu": {
            "anlam": "Akşam vardiyasında devir alınan bardak sayısından kapanışa kadar kullanılan bardak, Evo'nun o saat dilimine ait satış tahminiyle uyuşuyor. Akşam vardiyası temiz.",
            "nedenler": [],
            "aksiyon": "Rutin takip.",
        },
        "aksam_vardiya_bardak.orta_acik": {
            "anlam": "Akşam vardiyasında Evo satışından fazla bardak harcanmış. Orta düzey fark — kayıt dışı satış veya porsiyonlama sapması olabilir.",
            "nedenler": [
                "Kayıt dışı satış — bardak verildi, POS'a girilmedi",
                "İkram veya personel tüketimi kaydedilmedi",
                "Evo'nun akşam saatine ait satış tahmini düşük çıktı",
            ],
            "aksiyon": "Akşam vardiyası kamera inceleme + ikram kontrol.",
        },
        "aksam_vardiya_bardak.buyuk_acik": {
            "anlam": "Akşam vardiyasında ciddi bardak açığı var. Bu ölçekte kayıt dışı satış veya bilinçli stok manipülasyonu olabilir.",
            "nedenler": [
                "Büyük kayıt dışı satış serisi — nakit alındı, POS atlandı",
                "Toplu ikram veya etkinlik kayıt dışı yapıldı",
                "Bardak çalındı veya dışarıya çıkarıldı",
            ],
            "aksiyon": "Kamera + akşamcı sorgulama + nakit ve POS fişlerini karşılaştır.",
        },
        "aksam_vardiya_bardak.veri_yok": {
            "anlam": "Vardiya devri kaydı bulunamadı. Sabahçı → akşamcı bardak teslimi sisteme girilmemişse bu kontrol çalışmaz.",
            "nedenler": ["Vardiya devri yapılmadı (tek vardiyalı gün)", "Devir kaydı sisteme girilmedi"],
            "aksiyon": "Vardiya devri işleminin eksiksiz yapıldığını kontrol et.",
        },

        # ── 7. KASA BİRİKİM TRENDİ ───────────────────────────────────────────
        "kasa_birikim_trendi.normal": {
            "anlam": "Son 30 günde hiçbir personelde sistematik küçük kasa açığı pattern'i tespit edilmedi. Bu, kasıtlı küçük tutarlı zimmet (micro-skimming) olmadığını gösterir.",
            "nedenler": [],
            "aksiyon": "Aylık kontrol yeterli.",
        },
        "kasa_birikim_trendi.bir_kisi": {
            "anlam": "Bir personel son 30 günde günlerin çoğunda küçük kasa açığı oluşturmuş ve bu birikmiş. Tek seferlik sayım hatası olmaz — sistematik bir pattern. 'Her gün az al, fark edilme' stratejisi.",
            "nedenler": [
                "Personel her gün az miktarda nakit alıyor — kasa açığını kasıtlı küçük tutuyor",
                "Personel kasadan birikim yapıyor (uzun vadeli zimmet)",
            ],
            "aksiyon": "30 gün detaylı kasa dökümü + birebir izlem başlat + CFO'ya bildir.",
        },
        "kasa_birikim_trendi.cok_kisi": {
            "anlam": "Birden fazla personelde aynı anda birikim pattern'i var. Bu koordineli bir aksiyon veya yönetimsel bir kontrol boşluğu işareti.",
            "nedenler": [
                "Personeller birbirleriyle koordineli — örgütlü zimmet",
                "Kontrol sistemi zayıf — herkes küçük miktarlar alabiliyor",
                "Kasa protokolü uygulanmıyor",
            ],
            "aksiyon": "Acil kasa protokolü denetimi + tüm personel ayrı ayrı sor + CFO + hukuki danışma.",
        },
        "kasa_birikim_trendi.veri_yok": {
            "anlam": "30 günlük kasa verisi yetersiz. Trend analizi için en az 7–10 gün veri gerekir.",
            "nedenler": ["Şube yeni açıldı", "Geçmiş kapanış kayıtları eksik"],
            "aksiyon": "Kapanış kayıtlarının düzenli girildiğini kontrol et.",
        },
    }

    # ════════════════════════════════════════════════════════════════════════
    #  YARDIMCI FONKSIYON
    # ════════════════════════════════════════════════════════════════════════
    kontroller: List[Dict[str, Any]] = []

    def _k(kod: str, ad: str, durum: str, state_key: str,
           deger: str = "", detay: str = "", personel: str = None):
        # ⏳ "veri_yok": bakılmadı. ✅ ile aynı görünmemeli — ✅ "baktım, temiz"
        # demektir; burada bakılmamıştır (TRUTH-012).
        ikon = {"ok": "✅", "uyari": "⚠️", "kritik": "🚨",
                "veri_yok": "⏳"}.get(durum, "—")
        yor = _Y.get(state_key) or {}
        kontroller.append({
            "kod":     kod,
            "ad":      ad,
            "durum":   durum,
            "ikon":    ikon,
            "deger":   deger or "",
            "detay":   detay or "",
            "anlam":   yor.get("anlam") or "",
            "nedenler": yor.get("nedenler") or [],
            "aksiyon": yor.get("aksiyon") or "",
            "personel": personel,
        })

    try:
        onceki = (date.fromisoformat(str(tarih)) - timedelta(days=1)).isoformat()
    except Exception:
        onceki = None

    # ────────────────────────────────────────────────────────────────────────
    # 1. SABAH KASASI
    # ────────────────────────────────────────────────────────────────────────
    n1_val: Optional[float] = None
    n2_val: Optional[float] = None
    sabahci_ad: Optional[str] = None
    aksamci_ad_dun: Optional[str] = None

    try:
        cur.execute("""
            SELECT kasa_sayim, personel_ad FROM sube_operasyon_event
            WHERE sube_id=%s AND tarih=%s::date AND tip='ACILIS' AND durum='tamamlandi'
            ORDER BY cevap_ts DESC NULLS LAST LIMIT 1
        """, (sube_id, tarih))
        r = cur.fetchone()
        if r:
            rd = dict(r)
            n2_val = float(rd.get("kasa_sayim") or 0)
            sabahci_ad = (rd.get("personel_ad") or "").strip() or None
    except Exception as e:
        log.warning("gunluk_teyit sabah kasasi hata: %s", e)

    if onceki:
        try:
            cur.execute("""
                SELECT devir, personel_ad FROM sube_operasyon_event
                WHERE sube_id=%s AND tarih=%s::date AND tip='KAPANIS' AND durum='tamamlandi'
                ORDER BY cevap_ts DESC NULLS LAST LIMIT 1
            """, (sube_id, onceki))
            r = cur.fetchone()
            if r:
                rd = dict(r)
                n1_val = float(rd.get("devir") or 0)
                aksamci_ad_dun = (rd.get("personel_ad") or "").strip() or None
        except Exception as e:
            log.warning("gunluk_teyit dun kapanis hata: %s", e)

    if n2_val is None:
        _k("sabah_kasasi", "Sabah kasası", "uyari", "sabah_kasasi.acilis_yok",
           "—", "Sabah sayımı henüz yapılmadı")
    elif n1_val is None:
        _k("sabah_kasasi", "Sabah kasası", "ok", "sabah_kasasi.ref_yok",
           f"{n2_val:.0f}₺", "Sayıldı — önceki gün deviri yok (ilk gün?)", personel=sabahci_ad)
    else:
        fark = round(n2_val - n1_val, 2)   # pozitif = sabahçı fazla buldu
        abs_fark = abs(fark)
        if abs_fark <= 1.0:
            _k("sabah_kasasi", "Sabah kasası", "ok", "sabah_kasasi.dengede",
               f"{n2_val:.0f}₺", f"Doğru — devir {n1_val:.0f}₺ ile uyumlu", personel=sabahci_ad)
        elif fark < -1.0:
            if abs_fark <= 20:
                sk = "sabah_kasasi.kucuk_acik"
                du = "uyari"
            elif abs_fark <= 100:
                sk = "sabah_kasasi.orta_acik"
                du = "uyari"
            else:
                sk = "sabah_kasasi.buyuk_acik"
                du = "kritik"
            _k("sabah_kasasi", "Sabah kasası", du, sk,
               f"{n2_val:.0f}₺",
               f"Açık — devir {n1_val:.0f}₺, bulundu {n2_val:.0f}₺ → {abs_fark:.0f}₺ eksik",
               personel=sabahci_ad)
        else:  # fazla bulundu
            if abs_fark <= 20:
                sk = "sabah_kasasi.kucuk_fazla"; du = "ok"
            else:
                sk = "sabah_kasasi.buyuk_fazla"; du = "uyari"
            _k("sabah_kasasi", "Sabah kasası", du, sk,
               f"{n2_val:.0f}₺",
               f"Fazla — devir {n1_val:.0f}₺, bulundu {n2_val:.0f}₺ → {abs_fark:.0f}₺ fazla",
               personel=sabahci_ad)

    # ────────────────────────────────────────────────────────────────────────
    # 2. AKŞAM DEVİR BEYANI
    # ────────────────────────────────────────────────────────────────────────
    sprint_g: Dict[str, Any] = {}
    try:
        sprint_g = aksam_kasa_sisirme_tespit(cur, sube_id, tarih)
    except Exception as e:
        log.warning("gunluk_teyit sprint_g hata: %s", e)

    # Ek: truth_motor_kararlar'da SABAH_ZIMMET_SUPHE veya IPTAL_SUPHE var mı?
    kararlar_tani: Optional[str] = None
    try:
        cur.execute("""
            SELECT tani FROM truth_motor_kararlar
            WHERE sube_id=%s AND tarih=%s::date AND boyut='kasa'
            ORDER BY olusturma DESC LIMIT 1
        """, (sube_id, tarih))
        r_k = cur.fetchone()
        if r_k:
            kararlar_tani = str(dict(r_k).get("tani") or "")
    except Exception as e:
        log.warning("gunluk_teyit kararlar_tani hata: %s", e)

    sg_tani = sprint_g.get("tani")
    if sg_tani == "AKSAM_KASAYI_SISIRDI":
        aks_ad = sprint_g.get("aksamci_ad") or aksamci_ad_dun or "Akşamcı"
        sisirme = sprint_g.get("sisirme_tl", 0)
        sg_n1   = sprint_g.get("n1_aksam", 0)
        sg_n2   = sprint_g.get("n2_sabah", 0)
        _k("aksam_devir", "Akşam devir beyanı", "kritik", "aksam_devir.aksam_sisirdi",
           f"{sg_n1:.0f}₺",
           f"Şişirme — {aks_ad} {sg_n1:.0f}₺ devir dedi, sabah {sg_n2:.0f}₺ bulundu → {sisirme:.0f}₺ fark",
           personel=aks_ad)
    elif kararlar_tani == "SABAH_ZIMMET_SUPHE":
        sab_ad = sabahci_ad or "Sabahçı"
        _k("aksam_devir", "Akşam devir beyanı", "kritik", "aksam_devir.sabah_zimmet",
           f"{n1_val:.0f}₺" if n1_val else "—",
           f"Sabahçı düşük beyan — dünkü bardak N1'i doğruluyor, {sab_ad} kasayı eksik saydı",
           personel=sab_ad)
    elif kararlar_tani == "IPTAL_SUPHE":
        _k("aksam_devir", "Akşam devir beyanı", "uyari", "aksam_devir.iptal_suphe",
           f"{n1_val:.0f}₺" if n1_val else "—",
           "İptal şüphesi — kasa açığı Evo'da açıklanamıyor")
    elif n1_val is not None and n2_val is not None:
        fark_devir = round(n1_val - n2_val, 2)  # pozitif = akşamcı fazla beyan
        if fark_devir <= 1.0:
            _k("aksam_devir", "Akşam devir beyanı", "ok", "aksam_devir.uyumlu",
               f"{n1_val:.0f}₺", "Uyumlu — stok açığıyla çakışma yok", personel=aksamci_ad_dun)
        elif fark_devir <= 20:
            _k("aksam_devir", "Akşam devir beyanı", "uyari", "aksam_devir.kucuk_fark",
               f"{n1_val:.0f}₺",
               f"Küçük fark — devir {n1_val:.0f}₺, bulundu {n2_val:.0f}₺ ({fark_devir:.0f}₺ fazla beyan?)",
               personel=aksamci_ad_dun)
        elif fark_devir <= 100:
            _k("aksam_devir", "Akşam devir beyanı", "uyari", "aksam_devir.orta_fark_stoksuz",
               f"{n1_val:.0f}₺",
               f"Orta fark — {fark_devir:.0f}₺ açık, stok verisi bekleniyor",
               personel=aksamci_ad_dun)
        else:
            _k("aksam_devir", "Akşam devir beyanı", "kritik", "aksam_devir.buyuk_fark_stoksuz",
               f"{n1_val:.0f}₺",
               f"Büyük fark — {fark_devir:.0f}₺ açık, stok verisi bekleniyor",
               personel=aksamci_ad_dun)
    else:
        _k("aksam_devir", "Akşam devir beyanı", "ok", "aksam_devir.ref_yok",
           "—", "Önceki gün devir verisi yok — karşılaştırma yapılamadı")

    # ────────────────────────────────────────────────────────────────────────
    # 3. EVO POS TEYİDİ
    # ────────────────────────────────────────────────────────────────────────
    r_evo = None
    try:
        cur.execute("""
            SELECT tani, guven_skoru FROM truth_motor_kararlar
            WHERE sube_id=%s AND tarih=%s::date AND boyut='kasa'
            ORDER BY olusturma DESC LIMIT 1
        """, (sube_id, tarih))
        r_evo = cur.fetchone()
    except Exception as e:
        log.warning("gunluk_teyit evo teyit hata: %s", e)

    _EVO_STATE_MAP: Dict[str, tuple] = {
        "UYUMLU":                    ("ok",     "evo_teyit.uyumlu"),
        "IKRAM_EVO_TEYIT":           ("ok",     "evo_teyit.ikram_evo_teyit"),
        "IKRAM_SURDURULEN":          ("ok",     "evo_teyit.ikram_evo_teyit"),
        "IKRAM_UNUTULDU":            ("uyari",  "evo_teyit.ikram_unutuldu"),
        "SWEETHEARTING_SINYAL":      ("kritik", "evo_teyit.sweethearting"),
        "STOK_KACAGI_BEYANSIZ":      ("uyari",  "evo_teyit.stok_kacagi"),
        "ZIMMET_NAKIT_CEPTE":        ("kritik", "evo_teyit.zimmet_nakit"),
        "ZIMMET_IPTAL_MANIPULASYON": ("kritik", "evo_teyit.zimmet_nakit"),
        "SABAH_HATALI":              ("uyari",  "evo_teyit.sabah_hatali"),
        "AKSAM_HATALI":              ("uyari",  "evo_teyit.aksam_hatali"),
        "SABAH_TOPYEKUN":            ("uyari",  "evo_teyit.sabah_hatali"),
        "AKSAM_TOPYEKUN":            ("uyari",  "evo_teyit.aksam_hatali"),
        # TRUTH-011: belirsizlik hırsızlık değildir — kendi anlatısına bağlandı.
        # Severity "uyari": ciddiye alınmalı ama suçlama üretmemeli.
        "KAOS":                      ("uyari",  "evo_teyit.kaos"),
        "COZULMEDI":                 ("uyari",  "evo_teyit.cozulmedi"),
        "POS_SYNC_HATA":             ("uyari",  "evo_teyit.pos_sync"),
        "POS_BYPASS":                ("kritik", "evo_teyit.pos_bypass"),
        "AKSAM_ZIMMET_SINYALI":      ("kritik", "evo_teyit.zimmet_nakit"),
        "AKSAM_KASAYI_SISIRDI":      ("kritik", "evo_teyit.zimmet_nakit"),
        # TRUTH-013: zimmet şüphesi, sayım-hatası anlatısına düşmesin.
        "SABAH_ZIMMET_SUPHE":        ("kritik", "evo_teyit.sabah_zimmet_suphe"),
        "IPTAL_SUPHE":               ("uyari",  "evo_teyit.pos_bypass"),
        # 🔴 TRUTH-012: "veri yok" YEŞİL basılıyordu. Bakılmamış bir şeyi temiz
        # göstermek, denetimin en tehlikeli yalanıdır — sahip ekranda ✅ görüp
        # geçer. Ayrı bir durum: ne yeşil ne alarm, "BAKILMADI".
        "YETERSIZ_VERI":             ("veri_yok", "evo_teyit.motor_yok"),
    }

    if r_evo:
        rd_evo = dict(r_evo)
        evo_tani   = str(rd_evo.get("tani") or "")
        evo_guven  = float(rd_evo.get("guven_skoru") or 0)
        evo_du, evo_sk = _EVO_STATE_MAP.get(evo_tani, ("uyari", "evo_teyit.cozulmedi"))
        evo_detay = (
            f"Uyumlu (güven %{evo_guven:.0f})" if evo_du == "ok"
            else f"Anomali — {evo_tani} (güven %{evo_guven:.0f})"
        )
        _k("evo_teyit", "Evo POS teyidi", evo_du, evo_sk, "", evo_detay)
    else:
        # TRUTH-012: motor çalışmamışsa bu kontrol YEŞİL olamaz — ölçüm yok.
        _k("evo_teyit", "Evo POS teyidi", "veri_yok", "evo_teyit.motor_yok",
           "", "Motor bu güne henüz çalışmamış — TEYİT YAPILMADI (temiz demek değil)")

    # ────────────────────────────────────────────────────────────────────────
    # 4. GECE BARDAK DEVAMLILIĞI
    # ────────────────────────────────────────────────────────────────────────
    sprint_j: Dict[str, Any] = {}
    try:
        sprint_j = aksam_bardak_sisirme_tespit(cur, sube_id, tarih)
    except Exception as e:
        log.warning("gunluk_teyit sprint_j hata: %s", e)

    j_tani = sprint_j.get("tani") or "YETERSIZ_VERI"
    if j_tani == "AKSAM_BARDAK_SISIRDI":
        j_ad      = sprint_j.get("aksamci_ad") or "Akşamcı"
        j_kayip   = sprint_j.get("toplam_kayip_adet", 0)
        kasada_acik_j = sprint_j.get("kasada_acik", False)
        state_key  = ("gece_bardak.sisirme_kasa_acik" if kasada_acik_j
                      else "gece_bardak.sisirme_kasa_dengede")
        durum_j    = "kritik" if kasada_acik_j else "uyari"
        _k("gece_bardak", "Gece bardak devamlılığı", durum_j, state_key,
           f"{j_kayip} adet fark",
           f"Dün gece {j_kayip} adet bardak eridi — sabahçı kör sayımda tespit etti",
           personel=j_ad)
    elif j_tani == "UYUMLU":
        ozet_parts = []
        if sprint_j.get("dun_karton", 0) > 0:
            ozet_parts.append(f"karton {sprint_j.get('dun_karton',0)}→{sprint_j.get('bugun_karton',0)}")
        if sprint_j.get("dun_plastik", 0) > 0:
            ozet_parts.append(f"plastik {sprint_j.get('dun_plastik',0)}→{sprint_j.get('bugun_plastik',0)}")
        ozet_str = " | ".join(ozet_parts) if ozet_parts else "devamlılık normal"
        _k("gece_bardak", "Gece bardak devamlılığı", "ok", "gece_bardak.uyumlu",
           "", f"Kayıp yok ({ozet_str})",
           personel=sprint_j.get("aksamci_ad") or aksamci_ad_dun or None)
    else:
        _k("gece_bardak", "Gece bardak devamlılığı", "ok", "gece_bardak.veri_yok",
           "—", "Önceki gün kapanış bardak verisi yok — kontrol yapılamadı")

    # ────────────────────────────────────────────────────────────────────────
    # 5. SÜT KULLANIMI
    # ────────────────────────────────────────────────────────────────────────
    sut: Dict[str, Any] = {}
    try:
        sut = sut_sapma_analiz(cur, sube_id, tarih)
    except Exception as e:
        log.warning("gunluk_teyit sut hata: %s", e)

    sut_tani = sut.get("tani") or "VERI_YOK"
    gercek_sut = float(sut.get("gercek_tuketim") or 0)
    teorik_sut = float(sut.get("teorik_tuketim") or 0)
    sapma_l    = float(sut.get("sapma_litre") or 0)
    sapma_yz   = float(sut.get("sapma_yuzde") or 0)

    if sut_tani == "SUT_SAPMA":
        if sapma_yz >= 80:
            sk_sut = "sut_kullanimi.cok_ciddi_sapma"; du_sut = "kritik"
        elif sapma_yz >= 50:
            sk_sut = "sut_kullanimi.ciddi_sapma"; du_sut = "uyari"
        else:
            sk_sut = "sut_kullanimi.hafif_sapma"; du_sut = "uyari"
        _k("sut_kullanimi", "Süt kullanımı", du_sut, sk_sut,
           f"{gercek_sut:.1f}L",
           f"Fazla — teorik {teorik_sut:.1f}L, kullanılan {gercek_sut:.1f}L → {sapma_l:.1f}L fazla (%{sapma_yz:.0f})")
    elif sut_tani == "SUT_UYUMLU":
        if sapma_yz < 0:
            _k("sut_kullanimi", "Süt kullanımı", "uyari", "sut_kullanimi.az_tuketim",
               f"{gercek_sut:.1f}L",
               f"Az tüketim — teorik {teorik_sut:.1f}L, kullanılan {gercek_sut:.1f}L (%{abs(sapma_yz):.0f} eksik)")
        else:
            _k("sut_kullanimi", "Süt kullanımı", "ok", "sut_kullanimi.uyumlu",
               f"{gercek_sut:.1f}L",
               f"Normal — teorik {teorik_sut:.1f}L, kullanılan {gercek_sut:.1f}L (%{abs(sapma_yz):.0f} sapma)")
    else:
        _k("sut_kullanimi", "Süt kullanımı", "ok", "sut_kullanimi.veri_yok",
           "—", "Süt sayım verisi yok — kontrol yapılamadı")

    # ────────────────────────────────────────────────────────────────────────
    # 6. AKŞAM VARDIYASI BARDAK DENGESİ
    # ────────────────────────────────────────────────────────────────────────
    sprint_h: Dict[str, Any] = {}
    try:
        sprint_h = aksam_vardiya_bardak_pnl(cur, sube_id, tarih)
    except Exception as e:
        log.warning("gunluk_teyit sprint_h hata: %s", e)

    h_tani = sprint_h.get("tani")
    if h_tani == "AKSAM_VARDIYA_BARDAK_ACIK":
        h_ad    = sprint_h.get("aksamci_ad") or "Akşamcı"
        h_k     = float(sprint_h.get("karton_acik", 0) or 0)
        h_p     = float(sprint_h.get("plastik_acik", 0) or 0)
        h_guven = float(sprint_h.get("guven", 0) or 0)
        toplam_acik = h_k + h_p
        sk_h = "aksam_vardiya_bardak.buyuk_acik" if toplam_acik >= 10 else "aksam_vardiya_bardak.orta_acik"
        _k("aksam_vardiya_bardak", "Akşam vardiyası bardak dengesi", "uyari", sk_h,
           "",
           f"Açık — {h_k:.0f} karton + {h_p:.0f} plastik bardak Evo satışını aşıyor (güven %{h_guven:.0f})",
           personel=h_ad)
    elif h_tani == "UYUMLU":
        _k("aksam_vardiya_bardak", "Akşam vardiyası bardak dengesi", "ok",
           "aksam_vardiya_bardak.uyumlu",
           "", "Uyumlu — bardak kullanımı Evo satışıyla örtüşüyor")
    else:
        _k("aksam_vardiya_bardak", "Akşam vardiyası bardak dengesi", "ok",
           "aksam_vardiya_bardak.veri_yok",
           "—", "Vardiya devri verisi yok — kontrol yapılamadı")

    # ────────────────────────────────────────────────────────────────────────
    # 7. KASA BİRİKİM TRENDİ (30 gün)
    # ────────────────────────────────────────────────────────────────────────
    sprint_i: Dict[str, Any] = {}
    try:
        sprint_i = kucuk_tutar_birikim_tespit(cur, sube_id=sube_id, gun=30)
    except Exception as e:
        log.warning("gunluk_teyit sprint_i hata: %s", e)

    riskli_i = sprint_i.get("riskli_personeller") or []
    if len(riskli_i) >= 2:
        _k("kasa_birikim_trendi", "Kasa birikim trendi (30 gün)", "kritik",
           "kasa_birikim_trendi.cok_kisi",
           f"{len(riskli_i)} kişi",
           f"Kritik — {len(riskli_i)} personelde aynı anda birikim pattern'i var")
    elif len(riskli_i) == 1:
        rp = riskli_i[0]
        i_ad   = rp.get("personel_ad") or "Personel"
        i_tl   = abs(rp.get("toplam_fark", 0) or 0)
        i_gun  = rp.get("gun_sayisi", 0) or 0
        i_guven = rp.get("guven", 0) or 0
        _k("kasa_birikim_trendi", "Kasa birikim trendi (30 gün)", "uyari",
           "kasa_birikim_trendi.bir_kisi",
           f"{i_tl:.0f}₺ toplam",
           f"Dikkat — {i_ad} son {i_gun} günde kümülatif {i_tl:.0f}₺ açık (güven %{i_guven:.0f})",
           personel=i_ad)
    else:
        _k("kasa_birikim_trendi", "Kasa birikim trendi (30 gün)", "ok",
           "kasa_birikim_trendi.normal",
           "", "Normal — 30 günde şüpheli birikim pattern yok")

    # ════════════════════════════════════════════════════════════════════════
    #  ÇAPRAZ KORELASYON — birden fazla sinyal aynı anda yanıyorsa bağlantı
    #  Her korelasyon: kod, baslik, seviye, ikon, anlam, nedenler, aksiyon
    # ════════════════════════════════════════════════════════════════════════
    korelasyon: List[Dict[str, Any]] = []
    dur = {k["kod"]: k["durum"] for k in kontroller}

    def _kor(kod: str, baslik: str, seviye: str,
             anlam: str, nedenler: List[str], aksiyon: str):
        ikon = {"kritik": "🔴", "uyari": "🟠", "bilgi": "ℹ️"}.get(seviye, "ℹ️")
        korelasyon.append({
            "kod":      kod,
            "baslik":   baslik,
            "seviye":   seviye,
            "ikon":     ikon,
            "anlam":    anlam,
            "nedenler": nedenler,
            "aksiyon":  aksiyon,
        })

    # ── 1. Devir şişirme + bardak eridi — çift kanal zimmet ─────────────────
    if dur.get("aksam_devir") == "kritik" and dur.get("gece_bardak") in ("kritik", "uyari"):
        _kor(
            "devir_bardak_cift_kanal",
            "Hem devir şişirme hem bardak eridi — çift kanal",
            "kritik",
            "Bu kombinasyon en güçlü zimmet sinyalidir. Akşamcı tek kanalı gizlemek yerine "
            "iki kanalı aynı anda manipüle etmiş: N1 devir tutarını fazla yazarak kasa açığını kapattı, "
            "kapanış bardak sayısını da fazla yazarak stok açığını kapattı. "
            "Sabahçı kör sayımda her ikisini de gerçek değerde buldu.",
            [
                "Akşamcı kayıt dışı satış yaptı, parayı cebe koydu",
                "Stok farkını gizlemek için kapanış bardak sayısını şişirdi",
                "Kasa farkını gizlemek için devir tutarını şişirdi",
                "Sabahçı bağımsız sayımda hem kasayı hem bardağı gerçek değerde buldu",
            ],
            "Kritik zimmet soruşturması: akşamcıyı ayır, güvenlik kamerası incele, "
            "stok + kasa çapraz hesapla, CFO'ya bildir."
        )

    # ── 2. Kasa dengede ama bardak farkı var — büyük ihtimalle sayım hatası ─
    elif dur.get("sabah_kasasi") == "ok" and dur.get("gece_bardak") == "uyari":
        _kor(
            "kasa_dengede_bardak_farki",
            "Kasa dengede, bardak farkı var — sayım hatası daha muhtemel",
            "bilgi",
            "Önemli bir ayrım: kasa dengeli olduğu için bardak farkının parasal karşılığı görünmüyor. "
            "Eğer akşamcı bardağı şişirip para almış olsaydı kasada da açık olması gerekirdi. "
            "Kasanın dengeli çıkması Senaryo A'yı (sayım hatası) güçlendiriyor.",
            [
                "Sabahçı açılış bardak sayımını yanlış yerden veya eksik saydı",
                "Dünkü akşamcı kapanış bardak sayımını fazla okudu (kasıtsız hata)",
                "Bardaklar gece başka yere taşındı veya sayım alanları karıştı",
            ],
            "Sabahçıya fiziksel bardak sayımı tekrarı yaptır. "
            "Kasa dengeli kalıyorsa para kaybı yok — tutanağa geç ve kapan."
        )

    # ── 3. Devir kritik + Evo de kritik — iki bağımsız sistem örtüşüyor ─────
    if dur.get("aksam_devir") == "kritik" and dur.get("evo_teyit") == "kritik":
        _kor(
            "devir_evo_otuşuyor",
            "Devir şişirme ile Evo anomalisi aynı günde örtüşüyor",
            "kritik",
            "İki tamamen bağımsız kaynak — akşamcının kendi beyanı (N1) ve Evo POS sistemi — "
            "aynı güne işaret ediyor. N1 şişirmesi ile POS anomalisinin aynı anda tetiklenmesi "
            "tesadüf değil, kasıtlı eylem izine işaret eder.",
            [
                "Akşamcı hem POS akışını manipüle etti hem deviri şişirdi",
                "Kayıt dışı satış geliri: POS'ta kayıt yok, devire yansıtıldı",
            ],
            "İki tanı için ortak soruşturma başlat. "
            "Evo iptal + devir beyanını birlikte incele. CFO + hukuki süreç."
        )

    # ── 4. Süt fazla + akşam vardiya bardak açık — akşam shift pattern ──────
    if dur.get("sut_kullanimi") in ("uyari", "kritik") and dur.get("aksam_vardiya_bardak") == "uyari":
        _kor(
            "sut_vardiya_bardak",
            "Akşam vardiyasında kayıt dışı içecek paterni",
            "uyari",
            "Hem süt fazla kullanılmış hem de akşam vardiyasında bardak açığı var. "
            "Bu iki sinyal birlikte 'akşam saatlerinde kayıt dışı içecek üretildi' "
            "senaryosuna işaret eder: bardak verildi, POS girilmedi, süt harcandı. "
            "Her iki kontrol de akşam vardiyasını gösteriyor.",
            [
                "Akşamcı müşteriye içecek yapıp POS'a girmedi — nakit aldı",
                "Toplu sipariş (tablo, etkinlik) Evo'ya girilmedi",
                "Personel tüketimi (kendi için yapılan içecek) sisteme yazılmadı",
            ],
            "Akşam vardiyası kamera inceleme + o saate ait POS fişlerini say + "
            "süt tüketim saatini geriye dönük analiz et."
        )

    # ── 5. Birikim trendi + bugün de açık — sistematik pattern ───────────────
    if (dur.get("kasa_birikim_trendi") in ("uyari", "kritik")
            and dur.get("sabah_kasasi") in ("uyari", "kritik")):
        # İlgili personeli bul
        birikim_p = next(
            (k["personel"] for k in kontroller if k["kod"] == "kasa_birikim_trendi" and k["personel"]),
            "İlgili personel"
        )
        _kor(
            "birikim_ve_bugun_acik",
            f"30 günlük birikim trendi + bugün de açık ({birikim_p})",
            "uyari",
            f"Aynı personel hem 30 günlük birikim pattern'ine giriyor hem bugün kasa açığı oluşturmuş. "
            "Bu, 'her gün az al, tek seferinde çok değil' stratejisiyle uzun vadeli zimmet "
            "yürütüldüğünü güçlü biçimde gösteriyor. Bugünkü açık bu pattern'in devamı.",
            [
                f"{birikim_p} her gün küçük miktarda kasa açığı oluşturuyor",
                "Tek seferlik büyük bir eylem yerine düşük alarm eşiği altında kalan seri",
                "Bugünkü açık aynı kişiye ait pattern ile örtüşüyor",
            ],
            "30 gün detaylı kasa dökümü + bugünkü açığı aynı dosyaya ekle + "
            "birebir gözetleme başlat + CFO'ya bildir."
        )

    # ── 6. Evo anomali + kasa açık — bağımsız iki kaynak ────────────────────
    if (dur.get("evo_teyit") in ("uyari", "kritik")
            and dur.get("sabah_kasasi") in ("uyari", "kritik")
            and dur.get("aksam_devir") != "kritik"):  # devir zaten kapsıyorsa tekrar etme
        _kor(
            "evo_ve_kasa_acik",
            "Evo anomalisi ile kasa açığı aynı günde",
            "uyari",
            "Motor bir POS anomalisi tespit etti (kayıt dışı kullanım, sweethearting veya benzeri) "
            "ve aynı gün sabah kasasında da açık var. İki bağımsız kontrol aynı güne işaret edince "
            "tesadüf ihtimali düşer. Evo tanısı ve kasa açığının aynı kişiyle bağlantısı araştırılmalı.",
            [
                "POS anomalisi nakit kasa açığıyla doğrudan bağlantılı olabilir",
                "Kayıt dışı satış → hem Evo'da iz bırakmadı hem kasada eksik kaldı",
            ],
            "Evo tanısına ve kasa açığına bak: aynı vardiya, aynı personel mi? "
            "Birleşik soruşturma başlat."
        )

    # ── 7. Süt sapma + Evo anomali — içecek bazlı kayıt dışı ────────────────
    if (dur.get("sut_kullanimi") in ("uyari", "kritik")
            and dur.get("evo_teyit") in ("uyari", "kritik")
            and dur.get("aksam_vardiya_bardak") != "uyari"):  # vardiya zaten kapsıyorsa tekrar etme
        _kor(
            "sut_ve_evo_anomali",
            "Süt sapması Evo anomalisiyle aynı günde",
            "uyari",
            "Motor POS anomalisi tespit etmiş ve aynı gün süt de fazla kullanılmış. "
            "Süt içecek bazlı kayıt dışı üretimin en somut izlerinden biri — "
            "bardak ve POS girilmeden içecek yapılıp verildiğinde hem süt hem Evo etkilenir.",
            [
                "Kayıt dışı içecek üretimi — süt harcandı, POS atlandı",
                "İki sinyal aynı müdahale noktasına işaret ediyor",
            ],
            "İçecek türü bazlı inceleme: hangi içecek hem süt yoğun hem POS anomalisiyle örtüşüyor?"
        )

    # ── 8. Çok sayıda kritik — koordineli eylem veya sistemik boşluk ─────────
    kritik_kontroller = [k["ad"] for k in kontroller if k["durum"] == "kritik"]
    if len(kritik_kontroller) >= 3:
        _kor(
            "cok_kritik_sinyal",
            f"{len(kritik_kontroller)} kritik sinyal aynı anda — koordineli eylem şüphesi",
            "kritik",
            f"Aynı günde {len(kritik_kontroller)} farklı kontrol birden kritik seviyeye çıktı: "
            f"{', '.join(kritik_kontroller)}. Bu kadar sayıda bağımsız sinyalin aynı anda "
            "tetiklenmesi tek kişinin tek başına yapabileceği bir şey değildir. "
            "Ya koordineli (birden fazla personel) ya da bir sistemik kontrol boşluğu var.",
            [
                "Birden fazla personel koordineli hareket ediyor",
                "Kontrol mekanizmaları çökmüş — herkes fırsatçı davranıyor",
                "Yönetimsel güven ortamı sistemik boşluk yaratmış",
            ],
            "Acil CFO bildirimi + dış denetçi + tüm vardiya personeli ayrı ayrı sorgulama. "
            "Tek tek bakma — büyük resme bak."
        )

    # ── 9. Tüm kontroller temiz ───────────────────────────────────────────────
    if all(k["durum"] == "ok" for k in kontroller):
        _kor(
            "tum_temiz",
            "Tüm 7 kontrol geçti — gün temiz",
            "bilgi",
            "Yedi bağımsız kontrol (kasa, devir, Evo, bardak devamlılığı, süt, vardiya bardak, "
            "30 gün trendi) aynı sonuca ulaştı: anomali yok. Bu, sistemin beklendiği gibi "
            "çalıştığını gösteriyor. Tek bir kontrol bile tesadüfen temiz çıkabilir — "
            "ama yedisi birden temiz çıkması gerçekten sorun olmadığına işaret eder.",
            [],
            "Rutin aylık trend inceleme yeterli. "
            "Kontrol frekansını düşürme — tespit edilemeyen düşük seviye şeyler olabilir."
        )

    # ── Özet ────────────────────────────────────────────────────────────────
    ok_sayi     = sum(1 for x in kontroller if x["durum"] == "ok")
    uyari_sayi  = sum(1 for x in kontroller if x["durum"] == "uyari")
    kritik_sayi = sum(1 for x in kontroller if x["durum"] == "kritik")
    toplam      = len(kontroller)

    if kritik_sayi > 0:
        genel_durum = "kritik"
    elif uyari_sayi > 0:
        genel_durum = "uyari"
    else:
        genel_durum = "ok"

    if genel_durum == "ok":
        ozet = f"Tüm {toplam} kontrol geçti — gün normal seyirde."
    elif genel_durum == "uyari":
        sorunlar = [x["ad"] for x in kontroller if x["durum"] != "ok"]
        ozet = f"{ok_sayi}/{toplam} kontrol geçti. Dikkat: {', '.join(sorunlar)}."
    else:
        kritik_adlar = [x["ad"] for x in kontroller if x["durum"] == "kritik"]
        ozet = f"Kritik bulgu: {', '.join(kritik_adlar)}. Soruşturma gerekli."

    return {
        "kontroller":   kontroller,
        "korelasyon":   korelasyon,
        "genel_durum":  genel_durum,
        "gecen_sayi":   ok_sayi,
        "uyari_sayi":   uyari_sayi,
        "kritik_sayi":  kritik_sayi,
        "toplam_sayi":  toplam,
        "ozet":         ozet,
        "tarih":        tarih,
        "sube_id":      str(sube_id),
    }


def olay_ozeti_uret(cur, sube_id: str, tarih: str) -> Dict[str, Any]:
    """Tüm sprint sonuçlarını birleştirerek denetçi anlatısı üretir.

    Sistemi "insan gibi konuşturan" katman:
    - Kim ne yaptı (kişi adıyla)
    - Kanıtlar (bardak + kasa + seri)
    - Hangi senaryo daha muhtemel (hakem kararı)
    - Ne yapılmalı

    Returns:
        {
          "alarm":          str,
          "anlatı":         str,   # paragraf metin (UI'de direkt göster)
          "personeller":    List,  # tespit edilen kişiler
          "sprint_ozet":    Dict,  # G/H/I/J sonuçları
          "aksiyon":        str,
        }
    """
    alarm   = "normal"
    parcalar: List[str] = []
    personeller: List[str] = []
    aksiyonlar: List[str] = []

    # ── Sprint G: Kasa şişirme ───────────────────────────────────────────────
    sprint_g: Dict[str, Any] = {}
    try:
        sprint_g = aksam_kasa_sisirme_tespit(cur, sube_id, tarih)
    except Exception as _e:
        log.warning("Sprint G (kasa şişirme) başarısız sube=%s tarih=%s: %s", sube_id, tarih, _e)

    if sprint_g.get("tani") == "AKSAM_KASAYI_SISIRDI":
        alarm = "kritik"
        ad  = sprint_g.get("aksamci_ad") or "Akşamcı"
        tl  = sprint_g.get("sisirme_tl", 0)
        n1  = sprint_g.get("n1_aksam", 0)
        n2  = sprint_g.get("n2_sabah", 0)
        if ad not in personeller:
            personeller.append(ad)
        parcalar.append(
            f"**Kasa şişirme ({ad}):** Dün akşam kasaya "
            f"{n1:.0f}₺ devir bıraktım dedi, sabahçı {n2:.0f}₺ buldu → "
            f"{tl:.0f}₺ açık. Dünkü stok açığıyla da örtüşüyor "
            f"(güven %{sprint_g.get('guven', 0):.0f})."
        )
        aksiyonlar.append("Kasa baskını + güvenlik kamerası + soruşturma")

    # ── Sprint J: Bardak şişirme (cross-day) ────────────────────────────────
    sprint_j: Dict[str, Any] = {}
    try:
        sprint_j = aksam_bardak_sisirme_tespit(cur, sube_id, tarih)
    except Exception as _e:
        log.warning("Sprint J (bardak şişirme) başarısız sube=%s tarih=%s: %s", sube_id, tarih, _e)

    if sprint_j.get("tani") == "AKSAM_BARDAK_SISIRDI":
        if alarm != "kritik":
            alarm = "kritik"
        j_ad  = sprint_j.get("aksamci_ad") or "Akşamcı"
        s_ad  = sprint_j.get("sabahci_ad") or "Sabahçı"
        j_karar = sprint_j.get("karar_ozeti", "")
        j_kayip = sprint_j.get("toplam_kayip_adet", 0)
        if j_ad not in personeller:
            personeller.append(j_ad)
        parcalar.append(
            f"**Bardak şişirme:** {j_ad} kapanışta {j_kayip} adet bardak fazla yazdı. "
            f"{s_ad} açılışta gerçek sayıyı buldu — gece bardak kaybolmaz. {j_karar}"
        )
        if sprint_j.get("olasi_senaryo") == "B":
            aksiyonlar.append(f"{j_ad} ile görüşme + sayım tekrarı")

    # ── Sprint H: Vardiya bardak P&L ─────────────────────────────────────────
    sprint_h: Dict[str, Any] = {}
    try:
        sprint_h = aksam_vardiya_bardak_pnl(cur, sube_id, tarih)
    except Exception as _e:
        log.warning("Sprint H (vardiya bardak P&L) başarısız sube=%s tarih=%s: %s", sube_id, tarih, _e)

    if sprint_h.get("tani") == "AKSAM_VARDIYA_BARDAK_ACIK":
        if alarm not in ("kritik",):
            alarm = "yuksek"
        h_ad = sprint_h.get("aksamci_ad") or "Akşamcı"
        h_k  = sprint_h.get("karton_acik", 0)
        h_p  = sprint_h.get("plastik_acik", 0)
        if h_ad not in personeller:
            personeller.append(h_ad)
        parcalar.append(
            f"**Vardiya bardak açığı ({h_ad}):** Devir aldıktan sonra kapanışa kadar "
            f"{h_k:.0f} karton + {h_p:.0f} plastik bardak Evo satışını aşan fiziksel kullanım var. "
            f"Kayıt dışı satış şüphesi (güven %{sprint_h.get('guven', 0):.0f})."
        )
        aksiyonlar.append("Akşam vardiyası kamera inceleme")

    # ── Sprint I: Küçük tutarlı birikim ──────────────────────────────────────
    sprint_i: Dict[str, Any] = {}
    try:
        sprint_i = kucuk_tutar_birikim_tespit(cur, sube_id, gun=30)
    except Exception as _e:
        log.warning("Sprint I (küçük tutar birikim) başarısız sube=%s tarih=%s: %s", sube_id, tarih, _e)

    riskli_i = sprint_i.get("riskli_personeller") or []
    if riskli_i:
        if alarm not in ("kritik", "yuksek"):
            alarm = "yuksek"
        for rp in riskli_i[:2]:
            i_ad  = rp.get("personel_ad") or "Personel"
            i_tl  = rp.get("toplam_fark", 0)
            i_gun = rp.get("gun_sayisi", 0)
            if i_ad not in personeller:
                personeller.append(i_ad)
            parcalar.append(
                f"**30 günlük birikim ({i_ad}):** Son {i_gun} günde "
                f"kümülatif {i_tl:.0f}₺ kasa açığı — sistematik micro-skimming şüphesi "
                f"(güven %{rp.get('guven', 0):.0f})."
            )
        aksiyonlar.append("30 gün detaylı kasa dökümü + birebir gözlem")

    # ── Final anlatı ─────────────────────────────────────────────────────────
    if not parcalar:
        anlatı = "Bu gün için kayda değer anomali tespit edilmedi — tüm kontroller uyumlu."
        aksiyon = "Rutin takip yeterli."
    else:
        tarih_str = str(tarih)
        kim_str   = " & ".join(personeller) if personeller else "ilgili personel"
        baslik = {
            "kritik": f"⚠️ KRİTİK — {tarih_str} — Şüpheli: {kim_str}",
            "yuksek": f"🟠 YÜKSEK RİSK — {tarih_str} — İnceleme: {kim_str}",
        }.get(alarm, f"🟡 ORTA RİSK — {tarih_str}")

        anlatı = baslik + "\n\n" + "\n\n".join(parcalar)
        aksiyon = " | ".join(dict.fromkeys(aksiyonlar)) or "Soruşturma başlat"

    return {
        "alarm":       alarm,
        "anlatı":      anlatı,
        "personeller": personeller,
        "aksiyon":     aksiyon,
        "sprint_ozet": {
            "sprint_g": sprint_g,
            "sprint_h": sprint_h,
            "sprint_j": sprint_j,
            "sprint_i_riskli": len(riskli_i),
        },
    }


# ════════════════════════════════════════════════════════════════════════════
#  KATMAN 2: SENARYO MOTORU — Bayesian olasılık hesabı
#  KATMAN 3: CFO SESİ — Doğal Türkçe anlatı
#  KATMAN 4: GÖZLEM KAYIT + ÖĞRENİM GERİ BİLDİRİMİ
#
#  Araştırma kaynakları:
#    - ACFE 2024 Report to the Nations (baz oranlar)
#    - NRF Loss Prevention Research (sinyal ağırlıkları)
#    - ResearchGate: "Detecting Sweethearting in Retail" (sweethearting sinyalleri)
#    - University of Florida: micro-skimming fark edilmeme süresi ~18 ay
# ════════════════════════════════════════════════════════════════════════════

# ── DDL ─────────────────────────────────────────────────────────────────────
_GOZLEM_DDL = """
CREATE TABLE IF NOT EXISTS truth_gozlem (
    id                      SERIAL PRIMARY KEY,
    sube_id                 TEXT        NOT NULL,
    tarih                   DATE        NOT NULL,
    sinyal_vektor           JSONB       NOT NULL DEFAULT '{}',
    senaryo_olasiliklari    JSONB                DEFAULT '{}',
    en_olasilik_senaryo     TEXT,
    en_olasilik_puan        FLOAT,
    gercek_senaryo          TEXT,
    olusturma_ts            TIMESTAMPTZ          DEFAULT NOW(),
    UNIQUE (sube_id, tarih)
);
"""

_GERI_BILDIRIM_DDL = """
CREATE TABLE IF NOT EXISTS truth_geri_bildirim (
    id                  SERIAL      PRIMARY KEY,
    gozlem_id           INT         REFERENCES truth_gozlem(id) ON DELETE CASCADE,
    sube_id             TEXT        NOT NULL,
    tarih               DATE        NOT NULL,
    kategori            TEXT        NOT NULL,
    gercek_senaryo      TEXT,
    notlar              TEXT,
    giren_personel_id   TEXT,
    ts                  TIMESTAMPTZ DEFAULT NOW()
);
"""

# ── Senaryo tanımları ────────────────────────────────────────────────────────
#
#  agirlik_base  : ACFE/NRF baz oran (prior probability).
#  sinyaller     : sinyal_vektor anahtar → log-skor katkısı.
#                  Pozitif = bu sinyal görününce senaryo olası ↑
#                  Negatif = görününce olası ↓
#
SENARYOLAR: Dict[str, Dict] = {

    "insan_sayim_hatasi": {
        "ad":           "İnsan / Sayım Hatası",
        "aciklama":     "Kasıtsız sayım veya giriş hatası — personel dürüst, rakam yanlış",
        "agirlik_base": 0.38,
        "sinyaller": {
            "fark_abs_kucuk":       +2.0,
            "fark_abs_orta":        -0.5,
            "fark_abs_buyuk":       -2.5,
            "birikim_yok":          +1.5,
            "birikim_var":          -3.0,
            "evo_uyumlu":           +1.0,
            "devir_tani_temiz":     +1.0,
            "devir_tani_var":       -2.5,
            "bardak_acik_buyuk":    -1.0,
            "gece_bardak_sisirdi":  -2.0,
        },
    },

    "n1_sisirme": {
        "ad":           "N1 Şişirme (Akşam Zimmet)",
        "aciklama":     "Akşamcı devir beyanını şişirdi — kasadan para aldı, rakamı büyük gösterdi",
        "agirlik_base": 0.22,
        "sinyaller": {
            "n1_buyuk_n2_den":      +4.0,
            "fark_abs_orta":        +1.5,
            "fark_abs_buyuk":       +2.0,
            "fark_abs_kucuk":       -1.5,
            "bardak_acik_var":      +2.0,
            "evo_uyumlu":           +0.5,
            "devir_tani_var":       +3.0,
            "birikim_var":          +1.0,
            "gece_bardak_sisirdi":  +2.0,
        },
    },

    "sweethearting": {
        "ad":           "Sweethearting (Bedava Servis)",
        "aciklama":     "Ürün bedelsiz verildi — kasa normal ama stok eridi; nakit değil ürün çalındı",
        "agirlik_base": 0.11,
        "sinyaller": {
            "kasa_dengede":         +2.0,
            "bardak_acik_var":      +2.5,
            "sut_sapma_yuksek":     +2.0,
            "evo_ikram_artis":      +2.5,
            "evo_iptal_artis":      +1.5,
            "fark_abs_kucuk":       +1.0,
            "n1_buyuk_n2_den":      -2.0,
            "birikim_var":          +0.5,
            "vardiya_bardak_acik":  +2.0,
        },
    },

    "stok_hirsizligi": {
        "ad":           "Stok / Ürün Hırsızlığı",
        "aciklama":     "Nakit değil ürün alındı — bardak/stok kayboldu ama kasa tutarlı",
        "agirlik_base": 0.07,
        "sinyaller": {
            "kasa_dengede":         +2.5,
            "bardak_acik_buyuk":    +3.0,
            "gece_bardak_sisirdi":  +2.5,
            "evo_uyumlu":           +1.0,
            "sut_sapma_yuksek":     +1.5,
            "n1_buyuk_n2_den":      -1.5,
            "birikim_yok":          +0.5,
            "vardiya_bardak_acik":  +2.0,
        },
    },

    "kucuk_tutar_birikim": {
        "ad":           "Küçük Tutarlı Birikim (Micro-skimming)",
        "aciklama":     "Her gün küçük tutarda kasa açığı — gün içi fark edilmez, 30 günde birikir",
        "agirlik_base": 0.14,
        "sinyaller": {
            "birikim_var":          +5.0,
            "birikim_cok_kisi":     +1.5,
            "fark_abs_kucuk":       +2.0,
            "fark_abs_orta":        +0.5,
            "fark_abs_buyuk":       -2.0,
            "kasa_dengede":         -1.0,
            "devir_tani_temiz":     +0.5,
            "evo_uyumlu":           +1.0,
        },
    },

    "koluzyon": {
        "ad":           "Kolüzyon (İki Personel Anlaşması)",
        "aciklama":     "Sabahçı ve akşamcı koordineli — her sinyal küçük ama birlikte pattern var",
        "agirlik_base": 0.04,
        "sinyaller": {
            "birikim_cok_kisi":     +4.0,
            "birikim_var":          +2.0,
            "fark_abs_kucuk":       +1.5,
            "tum_sinyaller_zayif":  +3.0,
            "n1_buyuk_n2_den":      -1.0,
            "devir_tani_var":       -1.0,
            "evo_uyumlu":           +1.0,
        },
    },

    "urun_bozulma_fire": {
        "ad":           "Ürün Bozulması / Fire",
        "aciklama":     "Stok açığı fire kaydı veya bozulmayla açıklanıyor — kasıt yok",
        "agirlik_base": 0.04,
        "sinyaller": {
            "fire_kaydi_var":       +5.0,
            "bardak_acik_var":      +1.0,
            "kasa_dengede":         +1.5,
            "birikim_yok":          +1.0,
            "devir_tani_temiz":     +1.0,
            "n1_buyuk_n2_den":      -2.0,
        },
    },
}


# ── Sinyal vektörü çıkarma ───────────────────────────────────────────────────

def _sinyal_vektor_cikar(
    teyit: Dict[str, Any],
    sprint_g: Dict[str, Any],
    sprint_h: Dict[str, Any],
    sprint_i: Dict[str, Any],
    sprint_j: Dict[str, Any],
    evo_tani: Optional[str] = None,
) -> Dict[str, Any]:
    """Tüm sprint çıktılarından normalize sinyal vektörü üret."""

    kontroller = teyit.get("kontroller") or []

    kasa_k    = next((k for k in kontroller if k.get("kod") == "sabah_kasasi"), {})
    devir_k   = next((k for k in kontroller if k.get("kod") == "aksam_devir"),  {})
    gece_k    = next((k for k in kontroller if k.get("kod") == "gece_bardak"),  {})
    # FIX T8 (2026-07-05): kod isimleri kontroller listesindekiyle EŞLEŞMİYORDU → 3 sinyal
    # (süt/vardiya-bardak/birikim) Bayesian modele HİÇ ULAŞMIYORDU (durum hep "ok"). Gerçek
    # üretilen kodlar: sut_kullanimi / aksam_vardiya_bardak / kasa_birikim_trendi.
    sut_k     = next((k for k in kontroller if k.get("kod") == "sut_kullanimi"),        {})
    vardiya_k = next((k for k in kontroller if k.get("kod") == "aksam_vardiya_bardak"), {})
    birikim_k = next((k for k in kontroller if k.get("kod") == "kasa_birikim_trendi"),  {})

    kasa_durum    = kasa_k.get("durum", "ok")
    devir_durum   = devir_k.get("durum", "ok")
    gece_durum    = gece_k.get("durum", "ok")
    vardiya_durum = vardiya_k.get("durum", "ok")
    birikim_durum = birikim_k.get("durum", "ok")

    # N1/N2 fark (sprint_g'den)
    fark     = float(sprint_g.get("fark_n1_n2", 0) or 0)
    fark_abs = abs(fark)

    # Birikim detayı
    riskli_personeller  = sprint_i.get("riskli_personeller") or []
    birikim_kisi_sayisi = len(riskli_personeller)

    # Evo sinyal
    evo_anomali_var = bool(evo_tani) and evo_tani not in ("UYUMLU", "YETERSIZ_VERI")
    evo_iptal_artis = evo_tani in ("ZIMMET_IPTAL_MANIPULASYON", "IPTAL_SUPHE")
    evo_ikram_artis = evo_tani in ("SWEETHEARTING_SINYAL", "STOK_KACAGI_BEYANSIZ",
                                   "IKRAM_EVO_TEYIT", "IKRAM_SURDURULEN")
    fire_kaydi_var  = evo_tani in ("BELGELENMIS_IADE", "BELGELENMIS_FIRE")

    # Devir tani tetiklendi mi
    devir_tani_var = any(
        str(sprint_g.get(alan) or "") in (
            "AKSAM_KASAYI_SISIRDI", "SABAH_ZIMMET_SUPHE", "IPTAL_SUPHE"
        )
        for alan in ("tani", "sabah_zimmet_tani")
    )

    # Bardak sinyalleri
    gece_kayip       = int(sprint_j.get("toplam_kayip_adet") or 0)
    bardak_acik_var  = gece_kayip > 0 or gece_durum in ("uyari", "kritik")
    bardak_acik_buyuk = gece_kayip > 10 or gece_durum == "kritik"
    gece_state       = gece_k.get("state_key", "")
    gece_bardak_sisirdi = "sisirdi" in gece_state

    # Süt sapma yüzdesi
    sut_sapma_yuz = 0.0
    try:
        sut_deger = str(sut_k.get("deger", ""))
        if "%" in sut_deger:
            pct_raw = sut_deger.split("(")[-1].replace("%)", "").replace("+", "").strip()
            sut_sapma_yuz = abs(float(pct_raw))
    except Exception:
        pass

    return {
        # Fark
        "fark_n1_n2":           round(fark, 2),
        "fark_abs":             round(fark_abs, 2),
        "fark_abs_kucuk":       fark_abs <= 20,
        "fark_abs_orta":        20 < fark_abs <= 100,
        "fark_abs_buyuk":       fark_abs > 100,
        "n1_buyuk_n2_den":      fark < -20,
        # Kasa
        "kasa_dengede":         kasa_durum == "ok",
        "kasa_kritik":          kasa_durum == "kritik",
        # Devir
        "devir_tani_var":       devir_tani_var,
        "devir_tani_temiz":     not devir_tani_var and devir_durum == "ok",
        # Bardak
        "bardak_acik_var":      bardak_acik_var,
        "bardak_acik_buyuk":    bardak_acik_buyuk,
        "gece_bardak_sisirdi":  gece_bardak_sisirdi,
        "vardiya_bardak_acik":  vardiya_durum != "ok",
        # Evo
        "evo_uyumlu":           not evo_anomali_var,
        "evo_anomali_var":      evo_anomali_var,
        "evo_iptal_artis":      evo_iptal_artis,
        "evo_ikram_artis":      evo_ikram_artis,
        "fire_kaydi_var":       fire_kaydi_var,
        # Süt
        "sut_sapma_yuksek":     sut_sapma_yuz > 30,
        "sut_sapma_yuz":        sut_sapma_yuz,
        # Birikim
        "birikim_var":          birikim_durum != "ok",
        "birikim_yok":          birikim_durum == "ok",
        "birikim_kisi_sayisi":  birikim_kisi_sayisi,
        "birikim_cok_kisi":     birikim_kisi_sayisi >= 2,
        # Meta-sinyal: her şey küçük → kolüzyon
        "tum_sinyaller_zayif": (
            fark_abs <= 20
            and not bardak_acik_buyuk
            and not evo_anomali_var
            and not devir_tani_var
        ),
    }


# ── Bayesian olasılık hesabı ─────────────────────────────────────────────────

def senaryo_olasiliklari(sinyal_vektor: Dict[str, Any]) -> Dict[str, float]:
    """
    P(senaryo | sinyaller) hesapla.
    Log-linear skorlama (log prior + sinyal katkıları) → softmax → olasılık vektörü.
    """
    import math

    skorlar: Dict[str, float] = {}
    for senaryo_ad, senaryo in SENARYOLAR.items():
        log_skor = math.log(max(senaryo["agirlik_base"], 1e-9))
        for sinyal_ad, katki in senaryo["sinyaller"].items():
            deger = sinyal_vektor.get(sinyal_ad)
            if deger is True or (isinstance(deger, (int, float)) and deger > 0 and not isinstance(deger, bool)):
                log_skor += katki
        skorlar[senaryo_ad] = log_skor

    # Softmax normalize (numerik kararlılık için maks çıkar)
    maks = max(skorlar.values())
    exp_s = {k: math.exp(v - maks) for k, v in skorlar.items()}
    toplam = sum(exp_s.values())
    return {k: round(v / toplam, 4) for k, v in exp_s.items()}


# ── CFO Anlatı Şablonları ────────────────────────────────────────────────────

_CFO_ANLATILARI: Dict[str, Dict[str, str]] = {

    "insan_sayim_hatasi": {
        "guclu": (
            "Fark, sayım veya giriş hatası kapsamında. Küçük tutar, tekrarsız pattern ve "
            "Evo uyumu — üç sinyal birlikte kasıtsız hataya işaret ediyor. "
            "Rutin izleme yeterli, aksiyon gerekmez."
        ),
        "zayif": (
            "Sinyaller belirsiz; sayım hatası mümkün ancak tam dışlanamıyor. "
            "Yarın da benzer fark görülürse birikim takibine alınmalı."
        ),
        "gecmis": "Bu şubede son 7 günde sayım hatası senaryosu {gun} kez birincil çıktı.",
        "aksiyon": "Rutin takip. Tekrar ederse 3. kişi sayımı.",
    },

    "n1_sisirme": {
        "guclu": (
            "Akşamcı devir beyanını şişirdi — sabahçı kasayı {fark:.0f}₺ eksik buldu. "
            "İki bağımsız sayımın farkı bu tutarda kasıtlı olarak açıklanabilir: "
            "akşamcı kasadan para alıp devir rakamını büyük yazdı. "
            "Dünkü stok veya bardak açığı eşlik ediyorsa zimmet çok güçlü kanıtlanıyor."
        ),
        "zayif": (
            "Akşam deviri sabah sayımını {fark:.0f}₺ aşıyor. "
            "Tek sinyal — bardak veya Evo çapraz kanıtı olmadan sayım hatası da mümkün."
        ),
        "gecmis": "Bu akşamcıda/şubede son 7 günde {gun} kez N1>N2 farkı görüldü.",
        "aksiyon": "Zimmet soruşturması: kamera + akşamcı görüşme + CFO bildirimi.",
    },

    "sweethearting": {
        "guclu": (
            "Kasa normal ama stok eridi — ürün bedelsiz verildi. "
            "Evo ikram artışı ve bardak açığı birlikte: personel ürünü kayıt dışı "
            "arkadaşına/tanıdığına servis etti. Nakit değil, ürün çalındı. "
            "NRF verilerine göre QSR'lardaki kayıpların %11'i bu kategoride."
        ),
        "zayif": (
            "Bardak açığı + süt sapması sweethearting'e işaret ediyor "
            "ancak Evo teyidi net değil. İkram reçetesini kontrol et."
        ),
        "gecmis": "Bu şubede son 7 günde {gun} kez benzer bardak/süt pattern'i görüldü.",
        "aksiyon": "İkram defteri + kamera + personele ikram politikası hatırlatma.",
    },

    "stok_hirsizligi": {
        "guclu": (
            "Kasa tutarlı ama bardak stoku açık veriyor — nakit değil ürün alındı. "
            "Gece bardak kaybolmaz kuralı gereği cross-day fark kasıtlı eyleme işaret ediyor. "
            "Kayıt dışı satış veya fiziksel çıkarma ihtimali yüksek."
        ),
        "zayif": (
            "Bardak açığı var, kasa normal — stok hırsızlığı ihtimali mevcut "
            "ama fire veya sayım hatası da dışlanamıyor."
        ),
        "gecmis": "Son 7 günde {gun} kez benzer bardak farkı görüldü.",
        "aksiyon": "Bardak sayım tekrarı + kamera + fire kaydı sorgula.",
    },

    "kucuk_tutar_birikim": {
        "guclu": (
            "30 günlük kasa verisi sistematik mikro açık gösteriyor. "
            "Her gün küçük tutarda — tek başına 'sayım hatası' denilebilecek boyutta, "
            "ama ay sonunda toplam anlamlı. "
            "ACFE verilerine göre bu pattern tespit edilene kadar ortalama 18 ay sürüyor. "
            "Evvel bunu {gun} gün içinde yakaladı."
        ),
        "zayif": (
            "Birikim sinyali var ancak güven eşiğinin hemen üzerinde. "
            "Bir hafta daha gözlemle, pattern güçlenirse soruşturmaya al."
        ),
        "gecmis": "{gun} personelde aktif birikim sinyali görülüyor.",
        "aksiyon": "30 gün kasa dökümü + birebir vardiya gözlemi + CFO haftalık özet.",
    },

    "koluzyon": {
        "guclu": (
            "Birden fazla personelde sistematik küçük anomali — tek başına eşik altı, "
            "ama birlikte kolüzyon pattern'i oluşturuyor. "
            "Sabahçı ve akşamcı koordineli hareket ediyorsa her sinyal kasıtlı olarak "
            "küçük tutulmaktadır — en zor tespit edilen fraud türü. "
            "Kontrol 1 rastgele zamanlaması bu anlaşmayı 3. kişiye genişletmeyi zorlaştırıyor."
        ),
        "zayif": (
            "Zayıf kolüzyon sinyali. Birden fazla personelde küçük anomali "
            "ancak kesin bulgu yok. Haftalık korelasyon takibi gerekli."
        ),
        "gecmis": "Son 7 günde {gun} kez çoklu personel anomalisi görüldü.",
        "aksiyon": "CFO haftalık korelasyon raporu + vardiya çiftlerini değiştirmeyi değerlendir.",
    },

    "urun_bozulma_fire": {
        "guclu": (
            "Fire kaydı mevcut ve açığı açıklıyor. "
            "Stok kayıpları bozulma veya iade ile belgelenmiş — zimmet şüphesi düşük. "
            "Rutin fire takibi yeterli."
        ),
        "zayif": (
            "Fire kaydı var ancak miktar veya zamanlama dikkat istiyor. "
            "Sprint E analizi ile fire kaydının sahte olup olmadığını kontrol et."
        ),
        "gecmis": "Son 7 günde {gun} kez fire kaydı oluşturuldu.",
        "aksiyon": "Fire kaydı doğrula + zaman-miktar makul mu kontrol et.",
    },
}

_SUBE_AD_MAP = {
    "2": "Zafer", "3": "Alsancak", "4": "Gazze", "5": "Köyceğiz",
}


def cfo_konusmasi(
    cur,
    sube_id: str,
    tarih: str,
    sinyal_vektor: Optional[Dict] = None,
    olasiliklar: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    """
    CFO için doğal Türkçe anlatı üretir.

    sinyal_vektor ve olasiliklar verilmezse DB'den çekmeye çalışır.
    Her iki veri de yoksa boş yanıt döner.
    """
    # DB'den çek (verilmemişse)
    if sinyal_vektor is None or olasiliklar is None:
        try:
            cur.execute(_GOZLEM_DDL)
            cur.execute(
                "SELECT sinyal_vektor, senaryo_olasiliklari "
                "FROM truth_gozlem WHERE sube_id=%s AND tarih=%s",
                (sube_id, tarih),
            )
            row = cur.fetchone()
            if row:
                d = dict(row)
                sinyal_vektor = sinyal_vektor or d.get("sinyal_vektor") or {}
                olasiliklar   = olasiliklar   or d.get("senaryo_olasiliklari") or {}
        except Exception:
            pass

    if not olasiliklar:
        return {
            "anlati":        "Bugün için senaryo analizi henüz çalışmadı.",
            "en_senaryo":    None,
            "guven_yuzde":   0,
            "aksiyon":       "",
            "tum_olasiliklar": {},
        }

    sinyal_vektor = sinyal_vektor or {}

    # En yüksek 2 senaryo
    sirali        = sorted(olasiliklar.items(), key=lambda x: -x[1])
    en_senaryo, en_puan       = sirali[0]
    ikinci_senaryo, ikinci_puan = sirali[1] if len(sirali) > 1 else (None, 0.0)

    anlati_dict = _CFO_ANLATILARI.get(en_senaryo, {})

    # Son 7 günlük geçmiş
    gecmis_7gun: List[Dict] = []
    try:
        cur.execute(
            "SELECT en_olasilik_senaryo FROM truth_gozlem "
            "WHERE sube_id=%s AND tarih < %s ORDER BY tarih DESC LIMIT 7",
            (sube_id, tarih),
        )
        gecmis_7gun = [dict(r) for r in (cur.fetchall() or [])]
    except Exception:
        pass

    gecmis_gun = sum(
        1 for g in gecmis_7gun if g.get("en_olasilik_senaryo") == en_senaryo
    )

    fark       = abs(sinyal_vektor.get("fark_abs", 0))
    guven_yuzde = round(en_puan * 100)
    sube_adi   = _SUBE_AD_MAP.get(str(sube_id), f"Şube {sube_id}")

    ana_metin = (
        anlati_dict.get("guclu", "") if en_puan >= 0.50
        else anlati_dict.get("zayif", "")
    )
    try:
        ana_metin = ana_metin.format(fark=fark, gun=gecmis_gun)
    except Exception:
        pass

    gecmis_metin = ""
    if gecmis_gun >= 2:
        try:
            gecmis_metin = anlati_dict.get("gecmis", "").format(gun=gecmis_gun, fark=fark)
        except Exception:
            pass

    belirsizlik_notu = ""
    if en_puan < 0.50 and ikinci_senaryo:
        ikinci_ad = SENARYOLAR.get(ikinci_senaryo, {}).get("ad", ikinci_senaryo)
        belirsizlik_notu = (
            f"İki senaryo yakın — %{guven_yuzde} vs %{round(ikinci_puan*100)} "
            f"({SENARYOLAR[en_senaryo]['ad']} / {ikinci_ad}). Ek veri gerekiyor."
        )

    parcalar = [
        f"{sube_adi} — {tarih} — {SENARYOLAR[en_senaryo]['ad']} (%{guven_yuzde})",
        "",
        ana_metin,
    ]
    if gecmis_metin:
        parcalar += ["", gecmis_metin]
    if belirsizlik_notu:
        parcalar += ["", belirsizlik_notu]

    return {
        "anlati":             "\n".join(parcalar),
        "en_senaryo":         en_senaryo,
        "en_senaryo_ad":      SENARYOLAR[en_senaryo]["ad"],
        "guven_yuzde":        guven_yuzde,
        "ikinci_senaryo":     ikinci_senaryo,
        "ikinci_guven_yuzde": round(ikinci_puan * 100),
        "aksiyon":            anlati_dict.get("aksiyon", ""),
        "gecmis_gun":         gecmis_gun,
        "tum_olasiliklar":    {
            k: {"ad": SENARYOLAR[k]["ad"], "yuzde": round(v * 100)}
            for k, v in sirali
        },
    }


# ── Gözlem Kayıt ────────────────────────────────────────────────────────────

def gozlem_kaydet(
    cur,
    sube_id: str,
    tarih: str,
    sinyal_vektor: Dict[str, Any],
    olasiliklar: Dict[str, float],
) -> int:
    """
    Günün sinyal vektörü + senaryo olasılıklarını DB'ye yazar.
    Zaten varsa günceller (UPSERT). Gözlem ID döner.
    """
    try:
        cur.execute(_GOZLEM_DDL)
    except Exception:
        pass

    sirali     = sorted(olasiliklar.items(), key=lambda x: -x[1])
    en_senaryo = sirali[0][0] if sirali else None
    en_puan    = sirali[0][1] if sirali else 0.0

    try:
        cur.execute(
            """
            INSERT INTO truth_gozlem
                (sube_id, tarih, sinyal_vektor, senaryo_olasiliklari,
                 en_olasilik_senaryo, en_olasilik_puan)
            VALUES (%s, %s, %s::jsonb, %s::jsonb, %s, %s)
            ON CONFLICT (sube_id, tarih) DO UPDATE SET
                sinyal_vektor           = EXCLUDED.sinyal_vektor,
                senaryo_olasiliklari    = EXCLUDED.senaryo_olasiliklari,
                en_olasilik_senaryo     = EXCLUDED.en_olasilik_senaryo,
                en_olasilik_puan        = EXCLUDED.en_olasilik_puan
            RETURNING id
            """,
            (
                sube_id, tarih,
                json.dumps(sinyal_vektor, ensure_ascii=False, default=str),
                json.dumps(olasiliklar,   ensure_ascii=False, default=str),
                en_senaryo, en_puan,
            ),
        )
        row = cur.fetchone()
        return int((dict(row) if row else {}).get("id", 0))
    except Exception as e:
        log.warning("gozlem_kaydet hata: %s", e)
        return 0


# ── Geri Bildirim + Öğrenme ─────────────────────────────────────────────────

def geri_bildirim_isle(
    cur,
    sube_id: str,
    tarih: str,
    kategori: str,
    gercek_senaryo: Optional[str] = None,
    notlar: Optional[str] = None,
    giren_personel_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Yönetici geri bildirimini kaydet + gozlem tablosunu güncelle.

    kategori: 'onaylandi' | 'yanlis_alarm' | 'bilinmiyor' | 'arastirildi'

    Bu veriler ileriki sprint'te eşik kalibrasyonu için kullanılacak
    (Öğrenme Katmanı — Katman 4 seed).
    """
    try:
        cur.execute(_GOZLEM_DDL)
        cur.execute(_GERI_BILDIRIM_DDL)
    except Exception:
        pass

    gozlem_id: Optional[int] = None
    try:
        cur.execute(
            "SELECT id FROM truth_gozlem WHERE sube_id=%s AND tarih=%s",
            (sube_id, tarih),
        )
        row = cur.fetchone()
        if row:
            gozlem_id = int(dict(row).get("id", 0) or 0)
    except Exception:
        pass

    if not gozlem_id:
        return {
            "kaydedildi": False,
            "sebep":      "Gözlem bulunamadı — önce günlük tam analizi çalıştır",
        }

    if gercek_senaryo:
        try:
            cur.execute(
                "UPDATE truth_gozlem SET gercek_senaryo=%s WHERE id=%s",
                (gercek_senaryo, gozlem_id),
            )
        except Exception:
            pass

    try:
        cur.execute(
            """
            INSERT INTO truth_geri_bildirim
                (gozlem_id, sube_id, tarih, kategori,
                 gercek_senaryo, notlar, giren_personel_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (gozlem_id, sube_id, tarih, kategori,
             gercek_senaryo, notlar, giren_personel_id),
        )
    except Exception as e:
        return {"kaydedildi": False, "hata": str(e)}

    return {
        "kaydedildi":     True,
        "gozlem_id":      gozlem_id,
        "kategori":       kategori,
        "gercek_senaryo": gercek_senaryo,
        "mesaj": (
            "Geri bildirim kaydedildi. "
            "Bu veri ileride senaryo eşiklerinin kalibrasyonunda kullanılacak."
        ),
    }


def ogrenme_ozeti(cur, sube_id: str, son_gun: int = 90) -> Dict[str, Any]:
    """
    Son N günün gözlem + geri bildirim istatistiklerini özetle.
    Hangi senaryolar ne sıklıkla görüldü, geri bildirim ve doğruluk oranları.
    Bu özet motor'un 'ne kadar iyi öğrendiğini' gösterir.
    """
    try:
        cur.execute(_GOZLEM_DDL)
        cur.execute(_GERI_BILDIRIM_DDL)
    except Exception:
        pass

    try:
        cur.execute(
            """
            SELECT
                g.en_olasilik_senaryo,
                COUNT(*)                                                       AS toplam,
                SUM(CASE WHEN gb.kategori = 'onaylandi'    THEN 1 ELSE 0 END) AS onaylandi,
                SUM(CASE WHEN gb.kategori = 'yanlis_alarm' THEN 1 ELSE 0 END) AS yanlis_alarm,
                AVG(g.en_olasilik_puan)                                        AS ort_guven
            FROM truth_gozlem g
            LEFT JOIN truth_geri_bildirim gb ON gb.gozlem_id = g.id
            WHERE g.sube_id = %s
              AND g.tarih >= CURRENT_DATE - (%s || ' days')::INTERVAL
            GROUP BY g.en_olasilik_senaryo
            ORDER BY toplam DESC
            """,
            (sube_id, str(son_gun)),
        )
        rows = [dict(r) for r in (cur.fetchall() or [])]
    except Exception as e:
        return {"hata": str(e)}

    toplam_gun          = sum(int(r.get("toplam") or 0) for r in rows)
    yanlis_alarm_toplam = sum(int(r.get("yanlis_alarm") or 0) for r in rows)
    onaylandi_toplam    = sum(int(r.get("onaylandi") or 0) for r in rows)

    # Her senaryo için senaryo adını ekle
    for r in rows:
        s = r.get("en_olasilik_senaryo") or ""
        r["senaryo_ad"] = SENARYOLAR.get(s, {}).get("ad", s)
        r["ort_guven_yuzde"] = round(float(r.get("ort_guven") or 0) * 100, 1)

    return {
        "son_gun":            son_gun,
        "toplam_gozlem":      toplam_gun,
        "onaylandi":          onaylandi_toplam,
        "yanlis_alarm":       yanlis_alarm_toplam,
        "yanlis_alarm_orani": round(yanlis_alarm_toplam / toplam_gun * 100, 1) if toplam_gun else 0,
        "senaryo_dagilimi":   rows,
        "mesaj": (
            f"Son {son_gun} günde {toplam_gun} gözlem. "
            f"{onaylandi_toplam} onaylı bulgu, {yanlis_alarm_toplam} yanlış alarm "
            f"(%{round(yanlis_alarm_toplam/toplam_gun*100, 1) if toplam_gun else 0} yanlış alarm oranı)."
        ),
    }


# ── MASTER: Tüm katmanları birleştiren tek çağrı ────────────────────────────

def gunluk_tam_analiz(
    cur,
    sube_id: str,
    tarih: str,
    gozlem_kaydet_flag: bool = True,
) -> Dict[str, Any]:
    """
    Katman 1-2-3-4 hepsini sırayla çalıştırır:

      1. gunluk_teyit_karti  → 7 kontrol + korelasyon (Katman 1)
      2. Sprint verileri      → G (N1 sisirme), H (vardiya bardak), I (birikim), J (gece bardak)
      3. Sinyal vektörü       → _sinyal_vektor_cikar (Katman 2 girişi)
      4. Senaryo olasılıkları → senaryo_olasiliklari  (Katman 2)
      5. CFO anlatısı         → cfo_konusmasi          (Katman 3)
      6. Gözlem kaydet        → gozlem_kaydet           (Katman 4)

    Returns:
        teyit + senaryo + cfo + sinyal_vektor — tek dict.
    """
    # 1. Teyit kartı
    teyit: Dict[str, Any] = {}
    try:
        teyit = gunluk_teyit_karti(cur, sube_id, tarih)
    except Exception as e:
        teyit = {"hata": str(e)}

    # 2. Sprint çıktıları
    sprint_g: Dict[str, Any] = {}
    sprint_h: Dict[str, Any] = {}
    sprint_i: Dict[str, Any] = {}
    sprint_j: Dict[str, Any] = {}
    # 🔴 TRUTH-007 (2026-09-02): dört sprint de çıplak `except: pass` ile
    # yutuluyordu. Bir sprint patlarsa sözlüğü BOŞ kalıyor, sinyal vektörüne
    # "sinyal yok" olarak giriyor ve sonuç "o boyutta sorun bulunmadı" gibi
    # okunuyordu. Oysa BAKILAMAMIŞTI. Ölçemediğini temiz saymak, denetimin
    # kendi kendini kandırmasıdır — ve tam da bu motorun yakalaması gereken
    # şeyin aynısını motor kendi içinde yapıyordu.
    #
    # Artık: hata loglanır, boyut `eksik_boyutlar`a yazılır ve sonuç bunu
    # TAŞIR. Analiz durmaz (kısmi sonuç hiç sonuçtan iyidir) ama "kısmi"
    # olduğunu SÖYLER.
    eksik_boyutlar = []

    def _sprint(ad, fn):
        try:
            return fn() or {}
        except Exception as e:  # noqa: BLE001
            log.warning("gunluk_tam_analiz sprint %s başarısız: %s", ad, e)
            eksik_boyutlar.append({"boyut": ad, "hata": str(e)[:200]})
            return {}

    sprint_g = _sprint("kasa_sisirme", lambda: aksam_kasa_sisirme_tespit(cur, sube_id, tarih))
    sprint_h = _sprint("vardiya_bardak_pnl", lambda: aksam_vardiya_bardak_pnl(cur, sube_id, tarih))
    sprint_i = _sprint("kucuk_tutar_birikim", lambda: kucuk_tutar_birikim_tespit(cur, sube_id, gun=30))
    sprint_j = _sprint("bardak_sisirme", lambda: aksam_bardak_sisirme_tespit(cur, sube_id, tarih))

    # Evo tani — teyit kontrollerinden çek
    # FIX T8 (2026-07-05): kod "evo" değil "evo_teyit"; ayrıca state_key ("evo_teyit.sweethearting")
    # ile _sinyal_vektor_cikar'ın beklediği tani kodları ("SWEETHEARTING_SINYAL") uyuşmuyordu →
    # evo sinyali hiç girmiyordu. state_key son ekini kanonik tani koduna eşle.
    kontroller = teyit.get("kontroller") or []
    evo_k    = next((k for k in kontroller if k.get("kod") == "evo_teyit"), {})
    # ⚠️ TRUTH-013 (2026-09-02): bu harita, ekrana basılan state_key'i TANIYA
    # geri çevirir. `sabah_zimmet_suphe` burada YOKSA `_evo_sk_son.upper()`
    # ile "SABAH_ZIMMET_SUPHE"ye döner — doğru. Ama `sabah_hatali` üzerinden
    # gidildiğinde zimmet şüphesi SAYIM HATASINA dönüşüyordu; anlatı ayrıldığı
    # için o yol artık kapalı. İki tanı ayrı ayrı yazılı ki gelecekte biri
    # ötekinin üstünü örtmesin.
    _EVO_SK_TANI = {
        "uyumlu": "UYUMLU", "motor_yok": "YETERSIZ_VERI", "cozulmedi": "YETERSIZ_VERI",
        "kaos": "KAOS",
        "sweethearting": "SWEETHEARTING_SINYAL", "stok_kacagi": "STOK_KACAGI_BEYANSIZ",
        "ikram_evo_teyit": "IKRAM_EVO_TEYIT", "ikram_unutuldu": "IKRAM_SURDURULEN",
        "zimmet_nakit": "ZIMMET_IPTAL_MANIPULASYON",
        "sabah_hatali": "SABAH_HATALI",
        "sabah_zimmet_suphe": "SABAH_ZIMMET_SUPHE",
    }
    _evo_sk_son = (evo_k.get("state_key") or "").split(".")[-1]
    evo_tani = _EVO_SK_TANI.get(_evo_sk_son, (_evo_sk_son.upper() if _evo_sk_son else None))

    # 3. Sinyal vektörü
    sinyal = _sinyal_vektor_cikar(teyit, sprint_g, sprint_h, sprint_i, sprint_j, evo_tani)

    # 4. Senaryo olasılıkları
    olasiliklar = senaryo_olasiliklari(sinyal)

    # 5. CFO anlatısı
    cfo = cfo_konusmasi(cur, sube_id, tarih, sinyal, olasiliklar)

    # 6. Gözlem kaydet
    gozlem_id = 0
    if gozlem_kaydet_flag:
        try:
            gozlem_id = gozlem_kaydet(cur, sube_id, tarih, sinyal, olasiliklar)
        except Exception as e:
            log.warning("gunluk_tam_analiz gozlem_kaydet hata: %s", e)

    return {
        **teyit,
        "senaryo": {
            "olasiliklar":   cfo.get("tum_olasiliklar", {}),
            "en_senaryo":    cfo.get("en_senaryo"),
            "en_senaryo_ad": cfo.get("en_senaryo_ad"),
            "guven_yuzde":   cfo.get("guven_yuzde", 0),
        },
        "cfo": {
            "anlati":    cfo.get("anlati", ""),
            "aksiyon":   cfo.get("aksiyon", ""),
            "gecmis_gun": cfo.get("gecmis_gun", 0),
        },
        "sinyal_vektor": sinyal,
        "gozlem_id":     gozlem_id,
        # 🔴 TRUTH-007: hangi boyuta BAKILAMADI. Boş liste = tam analiz.
        # Dolu liste = sonuç KISMİ; eksik boyut "temiz" sayılmamalı.
        "eksik_boyutlar": eksik_boyutlar,
        "analiz_tam": not eksik_boyutlar,
    }


# ════════════════════════════════════════════════════════════════════════════
#  PERSONEL RİSK SKORLARI — CFO/operasyon görünümü (personel görmez)
# ════════════════════════════════════════════════════════════════════════════

_RISK_DECAY_YARI_OMUR_GUN = 30.0  # sinyal etkisi her 30 günde yarıya iner


def personel_risk_skorlari(cur, gun: int = 90, min_skor: float = 1.0) -> List[Dict[str, Any]]:
    """Son `gun` gündeki personel_risk_sinyal kayıtlarından, zaman-ağırlıklı
    (üstel decay) bir risk skoru üretir. Sadece CFO/operasyon panelinde
    kullanılmak üzere — personelin kendi gördüğü hiçbir ekrana eklenmez.
    """
    cur.execute(
        """
        SELECT prs.personel_id, p.ad_soyad, prs.sube_id, s.ad AS sube_ad,
               prs.tarih, prs.sinyal_turu, prs.agirlik, prs.aciklama, prs.olusturma
        FROM personel_risk_sinyal prs
        LEFT JOIN personel p ON p.id = prs.personel_id
        LEFT JOIN subeler s ON s.id = prs.sube_id
        WHERE prs.tarih >= CURRENT_DATE - (%s || ' days')::interval
        ORDER BY prs.tarih DESC, prs.olusturma DESC
        """,
        (int(gun),),
    )
    rows = cur.fetchall() or []

    from datetime import date as _date
    bugun = _date.today()

    agg: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        pid = r["personel_id"]
        if not pid:
            continue
        gun_farki = max(0, (bugun - r["tarih"]).days) if r["tarih"] else 0
        decay = 0.5 ** (gun_farki / _RISK_DECAY_YARI_OMUR_GUN)
        a = agg.setdefault(pid, {
            "personel_id": pid,
            "ad_soyad": r["ad_soyad"] or pid,
            "skor": 0.0,
            "sinyal_sayisi": 0,
            "son_sinyaller": [],
        })
        a["skor"] += float(r["agirlik"] or 0) * decay
        a["sinyal_sayisi"] += 1
        if len(a["son_sinyaller"]) < 8:
            a["son_sinyaller"].append({
                "tarih": str(r["tarih"]),
                "sube_ad": r["sube_ad"],
                "sinyal_turu": r["sinyal_turu"],
                "agirlik": r["agirlik"],
                "aciklama": r["aciklama"],
            })

    sonuc = [
        {**v, "skor": round(v["skor"], 1)}
        for v in agg.values()
        if round(v["skor"], 1) >= min_skor
    ]
    sonuc.sort(key=lambda x: -x["skor"])
    return sonuc
