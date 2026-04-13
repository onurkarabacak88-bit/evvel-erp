"""
EVVEL operasyon — Faz 2: merkez onay disiplini + defter zinciri.

Bu modül zorunlu import değildir; mimari referans.

1) Merkez panel PIN / yönetici rolü
-----------------------------------
``count_personel_panel_yonetici >= 1`` iken:

- ``PUT .../merkez/personel/{id}/panel-pin`` → ``onaylayan_personel_id`` +
  ``onaylayan_pin`` (panel **yöneticisi** personel + PIN) zorunlu.
- ``PUT .../merkez/personel/{id}/panel-yonetici`` → aynı onay alanları.

Hiç yönetici yokken (ilk kurulum) onay istenmez — aksi halde kilitlenirdi.

Her PIN / yönetici değişiminde ``operasyon_defter`` satırı (hedef personelin
``sube_id``'si veya ``sube-merkez``): ``MERKEZ_PANEL_PIN_DEGISTI``,
``MERKEZ_PANEL_YONETICI_DEGISTI``.

2) Defter zinciri (şube bazlı)
-------------------------------
``operasyon_defter`` kolonları: ``defter_onceki_id``, ``defter_zincir_hmac``.
Yeni satır eklenirken aynı ``sube_id`` için advisory lock + önceki satırın
zincir özeti ile HMAC (Faz 1 ile aynı env: ``EVVEL_OPERASYON_DEFTER_IMZA_ANAHTARI``,
türev önek ``evvel-defter-zincir-v1:``).

``GET /api/ops/defter?sube_id=...&zincir_dogrula=true`` → yanıtta
``zincir_dogrula`` özeti (seçilen ay/gün filtresinde kronolojik doğrulama).

Arayüz: ``src/pages/SubePanelPinleri.jsx`` (EVVEL build).

Legacy PIN uçu ``sube_kapanis_dual.panel_kullanici_ekle``: yönetici varken aynı
onay kuralı (``yetkili_panel_kullanici_id`` + ``yetkili_pin``) zorunlu.

Faz 3: ``evvel_operasyon_faz3.py`` — ``X-Evvel-Merkez-Key`` + ``/defter-guvenlik-ozet``.
"""

from __future__ import annotations

FAZ2_DEPLOY_PYTHON: tuple[str, ...] = (
    "main.py",
    "database.py",
    "operasyon_defter.py",
    "sube_panel.py",
    "sube_kapanis_dual.py",
    "operasyon_merkez_api.py",
    "personel_panel_auth.py",
)

FAZ2_DEPLOY_STATIC: tuple[str, ...] = ()
FAZ2_DEPLOY_FRONTEND: tuple[str, ...] = ("src/pages/SubePanelPinleri.jsx",)
