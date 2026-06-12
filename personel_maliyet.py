"""Personel günlük maliyet hesabı — tek yerden, tutarlı mantık.

"Vardiyam" / Vardiya Takip sayfasındaki ücret hesabıyla AYNI İş Kanunu
standardını kullanır (gorev_api.py::vardiya_takip), Maliyet sayfasının
günlük şube bazlı personel maliyetinde de bu fonksiyon kullanılır —
böylece iki sayfa arasında tutarsızlık olmaz.

Standart:
  - Günlük: 9.5 saat, Aylık: 30 gün (izin günleri dahil) → Aylık saat: 285
  - Sürekli (tam zamanlı): günlük taban = maaş/30. O gün planlanan vardiya
    9.5 saati aşarsa fark "fazla mesai" sayılır, saatlik ücret (maaş/285)
    ile günlük taban'a eklenir.
  - Part-time: fazla mesai kavramı YOK — planlanan saat × saatlik ücret
    (saatlik_ucret kolonundan).
  - Yol ücreti (aylık sabit) /30 ile günlük paya bölünüp her iki türde de
    eklenir (o gün vardiyası varsa).
"""

from typing import Any, Dict, Optional

STANDART_GUNLUK_SAAT = 9.5
AYLIK_GUN = 30.0
AYLIK_SAAT = STANDART_GUNLUK_SAAT * AYLIK_GUN  # 285


def gunluk_personel_maliyeti(
    calisma_turu: Optional[str],
    maas: Optional[float],
    saatlik_ucret: Optional[float],
    yol_ucreti: Optional[float],
    planlanan_saat: float,
) -> Dict[str, Any]:
    """Bir personelin belirli bir gündeki (tek vardiya) maliyetini hesaplar.

    Dönen dict:
      taban              — sürekli için maaş/30, part-time için saat×saatlik
      fazla_mesai_saat   — 9.5 saat üstü (sadece sürekli)
      fazla_mesai_ucret  — fazla_mesai_saat × (maaş/285) (sadece sürekli)
      yol_ucret_gunluk   — yol_ucreti/30
      toplam             — taban + fazla_mesai_ucret + yol_ucret_gunluk
    """
    maas = float(maas or 0)
    saatlik_ucret = float(saatlik_ucret or 0)
    yol_ucreti = float(yol_ucreti or 0)
    planlanan_saat = float(planlanan_saat or 0)
    is_surekli = (calisma_turu or "surekli") == "surekli"

    yol_gunluk = (yol_ucreti / AYLIK_GUN) if AYLIK_GUN else 0.0

    if is_surekli:
        taban = (maas / AYLIK_GUN) if AYLIK_GUN else 0.0
        saatlik = (maas / AYLIK_SAAT) if AYLIK_SAAT else 0.0
        fazla_saat = max(0.0, planlanan_saat - STANDART_GUNLUK_SAAT)
        fazla_ucret = fazla_saat * saatlik
    else:
        # Part-time: tüm saatler zaten saat başı ödeniyor, fazla mesai kavramı yok.
        taban = planlanan_saat * saatlik_ucret
        fazla_saat = 0.0
        fazla_ucret = 0.0

    toplam = taban + fazla_ucret + yol_gunluk

    return {
        "taban": round(taban, 4),
        "fazla_mesai_saat": round(fazla_saat, 4),
        "fazla_mesai_ucret": round(fazla_ucret, 4),
        "yol_ucret_gunluk": round(yol_gunluk, 4),
        "toplam": round(toplam, 4),
    }
