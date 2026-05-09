"""
EVVEL operasyon — Faz 0 sabitleme referansı.

Bu modül zorunlu import değildir; mimari harita ve deploy listesi için tek kaynak.

PIN / onay zinciri → kod konumu
--------------------------------
- Kasa kilidi (PIN): ``sube_panel.kasa_kilit_ac`` → ``dogrula_personel_panel_pin``,
  ``operasyon_defter`` etiketleri ``KASA_KILIT_PIN_ONAY`` / ``KASA_KILIT_PIN_ONAY_IDEMPOTENT``.
- Şube açılış kaydı (zincir: önce kasa): ``sube_panel.sube_acilis_kaydet`` → audit
  ``ACILIS_PANEL``; defter ``ACILIS_PANEL_KAYIT``.
- Operasyon adımları (PIN): ``sube_operasyon`` tamamlama → defter
  ``ACILIS_TAMAM``, ``KONTROL_TAMAM``, ``KAPANIS_TAMAM``, ``CIKIS_TAMAM``.
- Vardiya devir imzaları (PIN): ``sube_kapanis_dual`` → defter
  ``VARDIYA_DEVIR_IMZA1_PIN``, ``VARDIYA_DEVIR_IMZA2_PIN``.

Merkez PIN / yönetici rolü: ``sube_panel`` ``merkez_personel_panel_pin_guncelle``,
``merkez_personel_panel_yonetici`` → Faz 2: yönetici varken onay alanları + defter
``MERKEZ_PANEL_*``; ``audit`` korunur.

Faz 1: ``evvel_operasyon_faz1.py`` — satır ``imza_hmac``. Faz 2:
``evvel_operasyon_faz2.py`` — zincir + merkez onay. Faz 3:
``evvel_operasyon_faz3.py`` — HTTP mutasyon anahtarı + güvenlik özeti. Faz 4:
``evvel_operasyon_faz4.py`` — DB append-only, PIN kilidi, defter CSV. Faz 5:
``evvel_operasyon_faz5.py`` — PIN güvenlik olay gözlemi. Faz 6:
``evvel_operasyon_faz6.py`` — eşik bazlı güvenlik alarmı. Faz 7:
``evvel_operasyon_faz7.py`` — alarm okundu/susturuldu.

Yaz-yükle deploy paketi (tipik)
--------------------------------
"""
from __future__ import annotations

FAZ0_DEPLOY_PYTHON: tuple[str, ...] = (
    "main.py",
    "sube_panel.py",
    "sube_operasyon.py",
    "sube_kapanis_dual.py",
    "operasyon_defter.py",
    "personel_panel_auth.py",
    "operasyon_merkez_api.py",
)

FAZ0_DEPLOY_STATIC: tuple[str, ...] = ("static/sube_panel.html",)
