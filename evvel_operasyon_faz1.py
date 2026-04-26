"""
EVVEL operasyon — Faz 1: defter satırı bütünlük imzası (HMAC-SHA256).

Bu modül zorunlu import değildir; mimari ve ortam değişkeni referansı.

Ne yapıldı
----------
- ``operasyon_defter`` tablosuna ``imza_hmac`` (migration: ``database.py``).
- ``operasyon_defter_ekle``: PostgreSQL ``CURRENT_DATE`` ve ``NOW()`` ile aynı
  anı kullanarak kanonik JSON + HMAC üretir; PIN düz metin imzaya girmez.
- ``GET /api/ops/defter``: her satırda ``imza_hmac`` ve ``imza_gecerli`` (bool
  veya eski satırlar için ``null``).

Üretim ortamı
-------------
Railway (veya barındırıcı) üzerinde güçlü bir gizli anahtar tanımlayın::

    EVVEL_OPERASYON_DEFTER_IMZA_ANAHTARI=<uzun-rastgele-dizge>

Boş bırakılırsa uygulama uyarıyla geliştirme varsayılanına düşer; üretimde
kullanmayın — aksi halde imza sırrı tahmin edilebilir olur.

Anahtar değişirse eski satırların ``imza_gecerli`` değeri ``false`` olur;
bu beklenen davranıştır (o anahtarla mühürlenmiş tarihsel kayıtlar).

Konum özeti
-----------
- Mantık: ``operasyon_defter.py`` (``operasyon_defter_canonical_v1``, ``operasyon_defter_imza_uret``).
- Okuma / doğrulama alanı: ``operasyon_merkez_api.ops_defter``.

Faz 2: ``evvel_operasyon_faz2.py`` — şube bazlı zincir + merkez yönetici onayı.
"""

from __future__ import annotations

# Faz 0 ile aynı deploy seti; ek olarak env yukarıda.
FAZ1_DEPLOY_PYTHON: tuple[str, ...] = (
    "main.py",
    "database.py",
    "operasyon_defter.py",
    "sube_panel.py",
    "sube_operasyon.py",
    "sube_kapanis_dual.py",
    "personel_panel_auth.py",
    "operasyon_merkez_api.py",
)

FAZ1_DEPLOY_STATIC: tuple[str, ...] = ("static/sube_panel.html",)
