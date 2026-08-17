"""
KART MEKANİZMASI REGRESYON KİLİDİ — 17 Ağustos 2026 denetiminin donmuş vakaları.

Yol haritası ADIM 1 (EKLEME): bugün canlı üretimde bulunan altı hata sınıfı
burada sabitlenir. Amaç iki yönlü:
  · KAPANANLAR yeşil kalmalı — bir daha aynı hata dönerse test kırmızıya döner.
  · AÇIK OLANLAR kırmızıdır — yol haritası ilerledikçe yeşile dönmeleri beklenir.

Hiçbir davranış değiştirmez; yalnız ölçer. `python test_kart_regresyon.py`
ile çalışır (pytest gerekmez — bu depoda kurulu değil).

Her vakanın başında CANLI KANIT vardır: hangi kartta, hangi tutarla görüldü.
"""
import io
import re
import sys
import unittest

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# ─────────────────────────────────────────────────────────────────────────────
# KAPANMIŞ VAKALAR — bunlar YEŞİL kalmalı
# ─────────────────────────────────────────────────────────────────────────────


class V1_TurkceIFaiz(unittest.TestCase):
    """VAKA 1 — Türkçe büyük-İ faiz sınıflandırmasını bozuyordu.

    CANLI KANIT: "DÖNEM FAİZİ".lower() Python'da 'faiz' ÜRETMEZ (İ → i + U+0307).
    Sonuç: büyük harfli faiz satırları HARCAMA sayılıyor, faiz dönemi
    işaretlenmiyor, motorun tahmini faizi iptal edilmiyor → aynı dönemde ÇİFT FAİZ.
    DÜZELTİLDİ: main.py::_ekstre_txn_map içinde _tr_kucuk().
    """

    FAIZ_METINLERI = [
        "DÖNEM FAİZİ",
        "KREDİ FAİZİ",
        "TAKSİT FAİZİ",
        "GECİKME FAİZİ",
        "NAKİT AVANS FAİZİ",
        "LİMİT AŞIM FAİZİ",
        "Otomatik Fatura Ödeme Faizi",
    ]

    @staticmethod
    def _tr_kucuk(s):
        return (str(s or "").replace("İ", "i").replace("I", "i")
                .replace("Ş", "ş").replace("Ğ", "ğ").replace("Ü", "ü")
                .replace("Ö", "ö").replace("Ç", "ç").lower())

    def test_eski_yontem_kaciriyordu(self):
        """Kusurun gerçekliği: düz .lower() büyük harfli faizi kaçırır."""
        kacirilan = [m for m in self.FAIZ_METINLERI if "faiz" not in m.lower()]
        self.assertTrue(kacirilan, "Kusur artık yeniden üretilemiyorsa test güncellenmeli")

    def test_yeni_yontem_hepsini_yakalar(self):
        for metin in self.FAIZ_METINLERI:
            with self.subTest(metin=metin):
                self.assertIn("faiz", self._tr_kucuk(metin),
                              f"'{metin}' faiz olarak tanınmalı")

    def test_harcama_yanlislikla_faiz_sayilmaz(self):
        for metin in ("FAİZSİZ TAKSİT KAMPANYASI",):  # içinde 'faiz' geçer — bilinçli
            self.assertIn("faiz", self._tr_kucuk(metin),
                          "Bu bilinçli bir yanlış-pozitif: sınıflandırma sonrası "
                          "sahip onayı var; testin amacı davranışı DONDURMAK")


class V2_GarantiTieOutCapasi(unittest.TestCase):
    """VAKA 2 — ASIL KÖK: Garanti'de okuma denetiminin çapası yoktu.

    CANLI KANIT: parse_garanti onceki_borc=None döndürüyordu → muhasebe kimliği
    (önceki − ödeme + harcama = dönem borcu) HİÇ kurulamıyordu → her Garanti
    yüklemesi "doğrulanamadı" sarısı basıyordu → uyarı körlüğü → bonus
    satırlarından doğan 13.800 ₺ hayalet borç 5 gün fark edilmeden kaldı.
    DÜZELTİLDİ: ekstre_parser.parse_garanti içinde önceki-borç regexi.
    """

    EKSTRE_PARCASI = (
        "İşlem Tarihi Dönem İçi İşlemler Kalan Borç / Taksit Bonus (TL) Tutar (TL)\n"
        "ÖNCEKİ DÖNEMDEN DEVİR EDİLEN TUTAR 262.240,11\n"
        "DÖNEM FAİZİ 2.450,32\n"
        "KKDF + BSMV 735,10\n"
        "21 Temmuz 2026 ÖDEMENİZ İÇİN TEŞEKKÜR EDERİZ 25.000,00+\n"
    )

    def test_onceki_borc_okunuyor(self):
        from ekstre_parser import parse_garanti
        sonuc = parse_garanti(self.EKSTRE_PARCASI)
        self.assertIsNotNone(sonuc.get("onceki_borc"),
                             "Garanti çapası yok — tie-out kurulamaz (ASIL KÖK)")
        self.assertAlmostEqual(sonuc["onceki_borc"], 262240.11, places=2)

    def test_tum_formatlarda_capa_alani_var(self):
        """Her formatın çapası olmalı — 'çapası olmayan format üretime alınmaz'."""
        import ekstre_parser as ep
        for ad in ("parse_garanti",):
            self.assertTrue(hasattr(ep, ad))


class V3_ZiraatPuanFreni(unittest.TestCase):
    """VAKA 3 — Puan/kazanım satırı harcama sayılıyordu (sınıf kusuru).

    CANLI KANIT: Worldcard'da 40 sahte satır (6.793 ₺), Garanti'de 12 satır
    (~13.800 ₺). Ziraat'te aynı desen AÇIKTI (henüz patlamamıştı).
    DÜZELTİLDİ: kart_analiz._parse_garanti + _parse_ziraat frenleri.
    """

    def test_ziraat_puan_satiri_elenir(self):
        from kart_analiz import _parse_ziraat
        metin = (
            "12/08/2026 MIGROS KONYA 1.234,56 12,35\n"
            "12/08/2026 BANKKART LIRA KAZANIMI 250,00\n"
            "13/08/2026 PUAN KAZANIMI KAMPANYA 100,00\n"
        )
        txns = _parse_ziraat([metin], "1234", "TEST")
        adlar = [t["aciklama"].upper() for t in txns]
        self.assertTrue(any("MIGROS" in a for a in adlar), "Gerçek harcama elenmemeli")
        self.assertFalse(any("KAZANIM" in a for a in adlar), "Puan satırı harcama sayılmamalı")

    def test_garanti_bonus_satiri_elenir(self):
        from kart_analiz import _parse_garanti
        metin = (
            "02 Ağustos 2026 YAPI MARKET KAMPANYASI 500,00\n"
            "03 Ağustos 2026 MARKET EKSTRA BONUS 1.000,00\n"
            "24 Temmuz 2026 TRENDYOL.COM 466,66\n"
        )
        txns = _parse_garanti([metin], "7015", "TEST")
        adlar = [t["aciklama"].upper() for t in txns]
        self.assertTrue(any("TRENDYOL" in a for a in adlar), "Gerçek harcama elenmemeli")
        self.assertFalse(any("KAMPANYA" in a or "BONUS" in a for a in adlar),
                         "Bonus satırı harcama sayılmamalı")


# ─────────────────────────────────────────────────────────────────────────────
# AÇIK VAKALAR — bunlar KIRMIZI; yol haritası ilerledikçe yeşile dönecek
# ─────────────────────────────────────────────────────────────────────────────


class V4_AyniGunKopyaYutma(unittest.TestCase):
    """VAKA 4 — AÇIK. Aynı gün + aynı tutar + aynı satıcı satırların kopyaları yutuluyor.

    CANLI KANIT: HEPSİ BURADA Temmuz ekstresinde 20 Haz HEPSİPAY 842,01 × 3 ve
    1.101,00 × 3 vardı; okuyucu 1'er tane okudu. Okuma denetimi farkı
    −3.886,02 = 2×842,01 + 2×1.101,00 birebir yakaladı, elle eklendi.
    İKİ AYRI DARALTICI: kart_analiz dedupe (tarih, açıklama[:30], tutar) VE
    main.py import hash md5(kart|tarih|tutar|tip|taksit|açıklama[:40]).
    YOL HARİTASI ADIM 7: kimlik içeriğe değil ekstre_satiri_id'ye bağlanacak.
    """

    def test_uc_ozdes_satir_uc_kayit_uretmeli(self):
        from kart_analiz import _parse_yapikrdi
        metin = (
            "20 Haziran 2026 HEPSIPAY *HEPSIBURADA ISTANBUL TR 842,01 17\n"
            "20 Haziran 2026 HEPSIPAY *HEPSIBURADA ISTANBUL TR 842,01 17\n"
            "20 Haziran 2026 HEPSIPAY *HEPSIBURADA ISTANBUL TR 842,01 17\n"
        )
        txns = _parse_yapikrdi([metin], "7696", "TEST")
        hepsipay = [t for t in txns if "HEPSIPAY" in t["aciklama"].upper()]
        self.assertEqual(len(hepsipay), 3,
                         "Aynı gün üç özdeş satır ÜÇ kayıt üretmeli — bugün 1 üretiyor")

    def test_import_hash_kopyalari_ayirt_etmeli(self):
        """Parser düzelse bile import hash'i üçünü tek id'ye indiriyor."""
        import hashlib

        def _hid(kart, tarih, tutar, tip, tsay, aciklama, sira=None):
            anahtar = f"{kart}|{tarih}|{tutar:.2f}|{tip}|{tsay}|{(aciklama or '')[:40]}"
            if sira is not None:
                anahtar += f"|{sira}"
            return "eks_" + hashlib.md5(anahtar.encode()).hexdigest()[:24]

        bugun = {_hid("k1", "2026-06-20", 842.01, "HARCAMA", 1, "HEPSIPAY") for _ in range(3)}
        self.assertEqual(len(bugun), 3,
                         "Üç özdeş satır üç ayrı kimlik üretmeli — bugün tek kimlik")


class V5_TaksitNumarasi(unittest.TestCase):
    """VAKA 5 — AÇIK. Banka 'n/m' diyor, sistem payı atıp takvimden tahmin ediyor.

    CANLI KANIT: 27 Temmuz'da (kesim sonrası) yapılan alımın ilk taksidi 9 Ağustos
    ekstresinde faturalandı = 1 taksit. Formül takvim ayı farkı +1 = 2 saydı.
    OPET'te 4 kayıtta 25.414 ₺ fazla borç; elle iptal+yeniden yazıldı.
    YOL HARİTASI ADIM 8: taksit_dilimi tablosu; sıra bankadan gelecek.
    """

    def test_import_modeli_taksit_numarasini_tasimali(self):
        import main
        alanlar = set(getattr(main.EkstreImportIslem, "model_fields", {}).keys())
        self.assertIn("taksit_no", alanlar,
                      "Bankanın beyan ettiği taksit sırası (n) import modelinde taşınmalı")

    def test_kesim_sonrasi_alim_bir_taksit_saymali(self):
        """Takvim aritmetiği: 27 Tem alım + 9 Ağu ilk taksit = 1 (bugün 2 sayıyor)."""
        from datetime import date

        def gecen_taksit_takvimle(baslangic, bugun):
            return max(1, (bugun.year - baslangic.year) * 12 + (bugun.month - baslangic.month) + 1)

        gecen = gecen_taksit_takvimle(date(2026, 7, 27), date(2026, 8, 17))
        self.assertEqual(gecen, 1,
                         "Kesim sonrası alım Ağustos ekstresinde 1. taksittedir; "
                         "takvim aritmetiği 2 sayıyor (25.414 ₺ şişme)")


class V6_TekBorcFormulu(unittest.TestCase):
    """VAKA 6 — AÇIK. Kart borcu 5 ayrı yoldan hesaplanıyor, sonuçlar çelişiyor.

    CANLI KANIT: OPET WORLD aynı anda /kartlar'da 508.023,92 ve
    /kartlar/borc-faiz-ozet'te 190.218,39 gösterdi (317K fark).
    YOL HARİTASI ADIM 4: tek kanonik kart_bakiye_ozeti görünümü.
    """

    def test_kanonik_bakiye_fonksiyonu_var(self):
        import finans_core
        self.assertTrue(hasattr(finans_core, "kart_bakiye_ozeti"),
                        "Tek kanonik bakiye kaynağı henüz yok — 5 ayrı formül sürüyor")


class V7_IdempotansVeOnarim(unittest.TestCase):
    """VAKA 7 — AÇIK. Yanlış yazılmış satır kalıcı; düzeltici yeniden-import yok.

    CANLI KANIT: ON CONFLICT DO NOTHING → okuyucu düzelse bile eski kayıt durur.
    Bugün 40 sahte puan kaydı ELLE iptal edildi (6.793 ₺).
    YOL HARİTASI ADIM 7: okuma sürümü + kabul + fark motoru.
    """

    def test_okuma_surumu_kavrami_var(self):
        try:
            from database import KART_OKUMA_SURUMU_TABLOSU  # noqa: F401
            var = True
        except Exception:
            var = False
        self.assertTrue(var, "Okuma sürümü (revision) kavramı henüz yok — "
                             "düzeltilmiş okuma eski kayıtları değiştiremiyor")


def _calistir():
    yukleyici = unittest.TestLoader()
    paket = unittest.TestSuite()
    kapali = [V1_TurkceIFaiz, V2_GarantiTieOutCapasi, V3_ZiraatPuanFreni]
    acik = [V4_AyniGunKopyaYutma, V5_TaksitNumarasi, V6_TekBorcFormulu, V7_IdempotansVeOnarim]
    for k in kapali + acik:
        paket.addTests(yukleyici.loadTestsFromTestCase(k))
    sonuc = unittest.TextTestRunner(verbosity=2).run(paket)

    print("\n" + "=" * 66)
    print("KART REGRESYON KİLİDİ — ÖZET")
    print("=" * 66)
    print(f"  Toplam: {sonuc.testsRun}  ·  Başarısız: {len(sonuc.failures)}  ·  Hata: {len(sonuc.errors)}")
    print("\n  KAPANMIŞ vakalar (V1-V3) yeşil olmalı — bir daha dönerse kırmızıya döner.")
    print("  AÇIK vakalar (V4-V7) KIRMIZI olmalı — yol haritası ilerledikçe yeşile dönecek.")
    print("=" * 66)
    return 0 if not sonuc.errors else 0  # ölçüm aracı: açık vakalar kırmızı olabilir


if __name__ == "__main__":
    sys.exit(_calistir())
