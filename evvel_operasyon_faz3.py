"""
EVVEL operasyon — Faz 3: merkez mutasyon anahtarı + defter güvenlik özeti.

1) İsteğe bağlı HTTP anahtarı
------------------------------
``EVVEL_MERKEZ_MUTASYON_ANAHTARI`` tanımlıysa şu uçlar ``X-Evvel-Merkez-Key``
başlığında aynı değeri ister (SHA-256 ile timing-safe karşılaştırma):

- ``PUT /api/sube-panel/merkez/personel/{id}/panel-pin``
- ``PUT /api/sube-panel/merkez/personel/{id}/panel-yonetici``
- ``POST /api/sube-panel/{sube_id}/panel-kullanici`` (legacy)

Boş bırakılırsa davranış önceki gibi (sadece Faz 2 yönetici onayı vb.).

2) Operasyon merkezi
--------------------
``GET /api/ops/defter-guvenlik-ozet?year_month=YYYY-MM`` — aktif şubeler için
aylık defter: satır sayısı, imzasız, imza geçersiz, zincir özeti.

3) EVVEL arayüzü
----------------
``src/utils/api.js`` — ``localStorage.evvelMerkezMutasyonKey`` varsa mutasyon
isteklerine başlık ekler. ``SubePanelPinleri.jsx`` — isteğe bağlı anahtar alanı.

Deploy: ``evvel_merkez_guard.py``, ``sube_panel.py``, ``sube_kapanis_dual.py``,
``operasyon_merkez_api.py``, frontend dosyaları.

Faz 4: ``evvel_operasyon_faz4.py`` — append-only tetikleyici, PIN kilidi, CSV export.
"""

from __future__ import annotations

FAZ3_DEPLOY_PYTHON: tuple[str, ...] = (
    "evvel_merkez_guard.py",
    "main.py",
    "sube_panel.py",
    "sube_kapanis_dual.py",
    "operasyon_merkez_api.py",
)

FAZ3_DEPLOY_FRONTEND: tuple[str, ...] = (
    "src/utils/api.js",
    "src/pages/SubePanelPinleri.jsx",
)
