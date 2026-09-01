"""
Sevkiyat durumu yardımcıları — çift kolon geçiş katmanı.

Tablo şemasında iki kolon mevcut:
  - sevkiyat_durumu  (yeni, birincil)
  - sevkiyat_durum   (eski, legacy)

Geçiş tamamlanana kadar her iki kolona yazılır, okuma her zaman bu
modüldeki fonksiyonlar üzerinden yapılır.

KULLANIM:
  Statik SQL içinde (alias 't'):
      from sevkiyat_helpers import SD_T, SD_ST
      ... f"{SD_T} AS sevkiyat_durumu" ...

  Dinamik alias ile:
      sevkiyat_durumu_sql_expr('x')

  UPDATE parametreleri için:
      yeni, eski = sevkiyat_durumu_guncelle_params('gonderildi')
      SET sevkiyat_durumu=%s, sevkiyat_durum=%s  => (yeni, eski)
"""
from __future__ import annotations

import re
import unicodedata
from typing import Optional, Tuple


def ad_anahtar(v: Optional[str]) -> str:
    """Ürün adını EŞLEŞTİRME ANAHTARINA çevirir — tek merkez.

    ⚠️ NEDEN BURADA: aynı normalleştirme mantığı `sube_panel._norm_ad_tr`'de
    de vardı. İki kopya zamanla ayrışır ve o gün eşleşme sessizce kırılır;
    kırıldığı da fark edilmez çünkü "eşleşmedi" bir hata değil, sadece
    "bulunamadı"dır. Tek kaynak: her iki taraf da buradan okur.

    ⚠️ TÜRKÇE BÜYÜK İ: Python'da "İ".lower() → "i" + U+0307 (birleşik nokta)
    üretir; regex o noktayı "_" yapar ve "FİLTRE" → "fi_ltre" olur.
    Bu yüzden büyük harfler ÖNCE sabitlenir (İ→i, I→ı), sonra kalan
    birleşik işaretler NFKD ile temizlenir.

    ⚠️ Bu anahtar GÖSTERİM için değil, yalnız KIYAS için. Ekranda hep
    ürünün kendi yazımı gösterilir.
    """
    s = (v or "").strip().replace("İ", "i").replace("I", "ı").lower()
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    for _a, _b in (("ğ", "g"), ("ü", "u"), ("ş", "s"), ("ı", "i"),
                   ("ö", "o"), ("ç", "c")):
        s = s.replace(_a, _b)
    return re.sub(r"[^a-z0-9]+", "_", s).strip("_")

# Geçerli durum değerleri (referans — kontroller burada merkezileşir)
SEVKIYAT_DURUMLAR = frozenset({
    "bekliyor",
    "depoda_hazirlaniyor",
    "kismi_hazirlandi",
    "hazirlaniyor",
    "gonderildi",
    "teslim_edildi",
})

# Legacy değer → canonical map
_LEGACY_MAP = {
    "hazirlaniyor": "depoda_hazirlaniyor",  # eski sevkiyat_durum değeri
}

_VARSAYILAN = "bekliyor"


def sevkiyat_durumu_coz(
    yeni: Optional[str],
    eski: Optional[str] = None,
    varsayilan: str = _VARSAYILAN,
) -> str:
    """
    İki kolondan canonical sevkiyat durumunu döner.

    Öncelik: yeni (sevkiyat_durumu) > eski (sevkiyat_durum) > varsayilan.
    Her iki kolon da None/boş ise varsayilan döner.
    """
    for raw in (yeni, eski):
        v = (raw or "").strip()
        if v:
            return _LEGACY_MAP.get(v, v)
    return varsayilan


def sevkiyat_durumu_sql_expr(alias: str = "t") -> str:
    """
    SELECT içinde kullanılmak üzere COALESCE ifadesi döner.

    Örnek:
        f"SELECT {sevkiyat_durumu_sql_expr('t')} AS sevkiyat_durumu ..."
    """
    return (
        f"COALESCE(NULLIF(TRIM({alias}.sevkiyat_durumu), ''), "
        f"{alias}.sevkiyat_durum, '{_VARSAYILAN}')"
    )


# Sık kullanılan alias'lar için hazır sabitler —
# statik SQL triple-quote bloklarında f-string açmadan kullanılır.
# Örnek: f"SELECT {SD_T} AS sevkiyat_durumu FROM siparis_talep t ..."
SD_T  = sevkiyat_durumu_sql_expr("t")   # alias: t
SD_ST = sevkiyat_durumu_sql_expr("st")  # alias: st (hub alarm satırları)

# Tablo aliası olmayan sub-query / CTE içleri için (kolonlar direkt isimle)
SD_NOALIAS = "COALESCE(NULLIF(TRIM(sevkiyat_durumu), ''), sevkiyat_durum, 'bekliyor')"


def sevkiyat_durumu_guncelle_params(yeni_durum: str) -> Tuple[str, str]:
    """
    UPDATE SET sevkiyat_durumu=%s, sevkiyat_durum=%s için parametre çifti döner.

    Eski kolona (sevkiyat_durum) legacy karşılığı yazar; bilinmiyorsa aynı değeri yazar.
    """
    _YENI_TO_ESKI = {
        "depoda_hazirlaniyor": "hazirlaniyor",
        "kismi_hazirlandi":    "hazirlaniyor",
        "gonderildi":          "gonderildi",
        "teslim_edildi":       "teslim_edildi",
        "bekliyor":            "bekliyor",
    }
    eski = _YENI_TO_ESKI.get(yeni_durum, yeni_durum)
    return yeni_durum, eski

# ─────────────────────────────────────────────────────────────────────────────
# 🪪 KANONİK TEDARİKÇİ ADI — TEK SQL PARÇASI (2026-09-02)
# ─────────────────────────────────────────────────────────────────────────────
# ⚠️ NEDEN (canlı ölçüm, ATALAY vakası):
# `toptanci_siparis.tedarikci_ad` sipariş ANINDAKİ adın KOPYASIDIR. Tedarikçi
# sonradan yeniden adlandırılınca eski satırlar eski metinle kalır ve ekranda
# İKİ AYRI TEDARİKÇİ gibi görünür:
#     "ATALAY KAHVE"  (06.08 öncesi kayıtlar)
#     "MEHMET ATALAY" (23.08 sonrası kayıtlar)
# Oysa `tedarikci_id` İKİSİNDE DE AYNIDIR (ee7e7adf-…): kimlik tekti, ad çiftti.
# Kullanıcı haklı olarak "çift kimlik" gördü — ama veri değil GÖRÜNTÜ çiftti.
#
# Sorgular `COALESCE(ts.tedarikci_ad, td.ad)` yazıyordu: SNAPSHOT kazanıyor,
# canlı ad yedek kalıyordu. Sıra TERS olmalı — kimlik varsa GÜNCEL ad konuşur.
# (Sahibin kuralı: kanonik kimliği kaynakta çöz; ad yalnız gösterimdir.)
#
# ⚠️ TARİHÇE SİLİNMEZ: snapshot da ayrı alanda döner (`*_ad_kayit`), böylece
# "o gün bu adla sipariş verildi" bilgisi korunur. Ad değişimini gizlemiyoruz,
# hangisinin KANONİK olduğunu söylüyoruz.
#
# Kullanım (sorguda `tedarikciler td` JOIN'i şart):
#     f"{TED_AD_KANONIK} AS tedarikci_ad, {TED_AD_KAYIT} AS tedarikci_ad_kayit"
#     ... FROM toptanci_siparis ts
#         LEFT JOIN tedarikciler td ON td.id = ts.tedarikci_id
TED_AD_KANONIK = "COALESCE(NULLIF(TRIM(td.ad), ''), ts.tedarikci_ad)"
TED_AD_KAYIT = "ts.tedarikci_ad"
# `tedarikciler` JOIN'i eklemek için hazır parça (tekrar yazılmasın):
TED_JOIN = "LEFT JOIN tedarikciler td ON td.id = ts.tedarikci_id"
