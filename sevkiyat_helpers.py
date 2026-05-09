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

from typing import Optional, Tuple

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
