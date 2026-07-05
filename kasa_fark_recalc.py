"""
kasa_fark_recalc.py
-------------------
Kasa uyumsuzluğunun zincirleme yeniden hesaplanması.

Tek sorumluluk:
    1) İlgili gün için ACILIS veya KAPANIS bileşenlerini DB'den yeniden topla,
    2) Formülü çalıştır → yeni fark hesapla,
    3) sube_operasyon_uyari satırını güncelle (beklenen/gercek/fark/seviye),
    4) onay_kuyrugu kaydı varsa tutar/durum/iptal mantığını yürüt,
    5) Tolerans eşiği altına düşerse otomatik 'çözüldü' işaretle.

Bu modül kullanıcı düzeltme yaptığında (ciro/açılış/gider/devir) çağrılır.
Asla DB transaction'ı açmaz — caller'ın cur'unu kullanır (atomicity korunur).
"""
from __future__ import annotations

import hashlib
import json
import logging
import uuid as _uuid
from datetime import date
from typing import Any, Dict, Optional, Tuple

from operasyon_kurallar import tolerans_seviyesi, beklenen_onceki_kapanis_kasa

log = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────
# CONCURRENCY LOCK — aynı şube/gün için tüm operasyonları seri hale getirir.
# kapanış-event, /coz, /kaynak-duzelt, yeniden_hesap arasında race önler.
# pg_advisory_xact_lock: transaction sonunda OTOMATİK düşer (commit/rollback).
# ─────────────────────────────────────────────────────────────────

def kasa_gun_lock(cur: Any, sube_id: str, tarih: Any) -> None:
    """Aynı (sube_id, tarih) için işlem-seviyesi kilit alır.
    Bu transaction commit/rollback olunca otomatik düşer."""
    key = f"kasa_fark:{sube_id}:{tarih}"
    h = hashlib.sha256(key.encode("utf-8")).digest()
    lock1 = int.from_bytes(h[:4], "big", signed=True)
    lock2 = int.from_bytes(h[4:8], "big", signed=True)
    cur.execute("SELECT pg_advisory_xact_lock(%s, %s)", (lock1, lock2))


# ─────────────────────────────────────────────────────────────────
# CONSTRAINT GARANTİSİ — Stripe Expand-Contract + Heroku idempotent
# onay_kuyrugu.durum CHECK constraint'i 'iptal_revize' kabul etmiyor olabilir
# (Railway DB'de manuel eski migration ile eklenmiş). Lazy + idempotent fix.
# ─────────────────────────────────────────────────────────────────

_ONAY_KUYRUGU_CONSTRAINT_KONTROL = False  # process-level cache


def _onay_kuyrugu_constraint_garantile(cur: Any) -> None:
    """Idempotent: CHECK constraint tüm gerekli durumları kabul etsin.
    Sadece process'te bir kez çalışır (cache)."""
    global _ONAY_KUYRUGU_CONSTRAINT_KONTROL
    if _ONAY_KUYRUGU_CONSTRAINT_KONTROL:
        return
    try:
        cur.execute("SAVEPOINT sp_ok_constraint")
        # 1) Mevcut constraint'i kontrol et
        cur.execute("""
            SELECT pg_get_constraintdef(oid) AS def
            FROM pg_constraint
            WHERE conname = 'onay_kuyrugu_durum_check'
        """)
        row = cur.fetchone()
        mevcut = (dict(row).get("def") if row else "") or ""
        # 2) Gerekli tüm değerler var mı?
        gerekli = ['bekliyor', 'onaylandi', 'iptal', 'iptal_revize']
        eksik = [v for v in gerekli if f"'{v}'" not in mevcut]
        if not eksik:
            cur.execute("RELEASE SAVEPOINT sp_ok_constraint")
            _ONAY_KUYRUGU_CONSTRAINT_KONTROL = True
            return
        # 3) EXPAND: DROP + ADD (idempotent, atomic — tek DDL transaction)
        log.info("onay_kuyrugu constraint genişletiliyor (eksik: %s)", eksik)
        cur.execute("ALTER TABLE onay_kuyrugu DROP CONSTRAINT IF EXISTS onay_kuyrugu_durum_check")
        cur.execute("""
            ALTER TABLE onay_kuyrugu
            ADD CONSTRAINT onay_kuyrugu_durum_check
            CHECK (durum IN ('bekliyor','onaylandi','iptal','iptal_revize','reddedildi'))
        """)
        cur.execute("RELEASE SAVEPOINT sp_ok_constraint")
        _ONAY_KUYRUGU_CONSTRAINT_KONTROL = True
        log.info("onay_kuyrugu constraint güncellendi başarılı")
    except Exception as e:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_ok_constraint")
        except Exception:
            pass
        log.warning("onay_kuyrugu constraint güncellenemedi: %s", e)
        # Cache'leme: tekrar denesin
        _ONAY_KUYRUGU_CONSTRAINT_KONTROL = False


def _bilesenleri_topla_kapanis(cur: Any, sube_id: str, tarih: Any) -> Dict[str, float]:
    """KAPANIS fark formülünün 6 bileşenini DB'nin mevcut halinden topla."""
    # 1. acilis_kasa — sube_operasyon_event ACILIS.kasa_sayim
    cur.execute(
        """
        SELECT kasa_sayim
        FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=%s::date AND tip='ACILIS' AND durum='tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST LIMIT 1
        """,
        (sube_id, str(tarih)),
    )
    acilis_kasa = float((cur.fetchone() or {}).get("kasa_sayim") or 0)

    # 2. z_nakit — ciro.nakit (onaylanmış)
    cur.execute(
        """
        SELECT COALESCE(SUM(nakit), 0) AS nakit
        FROM ciro
        WHERE sube_id=%s AND tarih=%s::date AND durum='aktif'
        """,
        (sube_id, str(tarih)),
    )
    z_nakit = float((cur.fetchone() or {}).get("nakit") or 0)

    # 3. nakit_giderler — anlik_giderler nakit + aktif/onay_bekliyor
    cur.execute(
        """
        SELECT COALESCE(SUM(tutar), 0) AS toplam
        FROM anlik_giderler
        WHERE sube=%s AND tarih=%s::date
          AND LOWER(COALESCE(NULLIF(TRIM(odeme_yontemi), ''), 'nakit')) = 'nakit'
          AND durum IN ('aktif','onay_bekliyor')
        """,
        (sube_id, str(tarih)),
    )
    nakit_giderler = float((cur.fetchone() or {}).get("toplam") or 0)

    # 4. ara_teslim — kasa_teslim teslim_turu='ara'
    cur.execute(
        """
        SELECT COALESCE(SUM(tutar), 0) AS toplam
        FROM kasa_teslim
        WHERE sube_id=%s AND tarih=%s::date AND teslim_turu='ara'
        """,
        (sube_id, str(tarih)),
    )
    ara_teslim = float((cur.fetchone() or {}).get("toplam") or 0)

    # 5+6. teslim, devir — sube_operasyon_event KAPANIS
    cur.execute(
        """
        SELECT COALESCE(teslim, 0) AS teslim, COALESCE(devir, 0) AS devir,
               COALESCE(kasa_sayim, 0) AS kasa_sayim
        FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=%s::date AND tip='KAPANIS' AND durum='tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST LIMIT 1
        """,
        (sube_id, str(tarih)),
    )
    kr = cur.fetchone() or {}
    teslim = float(kr.get("teslim") or 0)
    devir = float(kr.get("devir") or 0)
    kasa_sayim = float(kr.get("kasa_sayim") or 0)

    return {
        "acilis_kasa": acilis_kasa,
        "z_nakit": z_nakit,
        "nakit_giderler": nakit_giderler,
        "ara_teslim": ara_teslim,
        "teslim": teslim,
        "devir": devir,
        "kasa_sayim": kasa_sayim,
    }


def _formul_kapanis(b: Dict[str, float]) -> float:
    """KAPANIS mutabakat formülü (tutarlı, tek yerden)."""
    return round(
        b["acilis_kasa"] + b["z_nakit"]
        - b["nakit_giderler"] - b["teslim"] - b["devir"] - b["ara_teslim"],
        2,
    )


def _bilesenleri_topla_acilis(cur: Any, sube_id: str, tarih: Any) -> Dict[str, float]:
    """ACILIS fark = sabah kasa sayım - beklenen dünkü kapanış kasa."""
    cur.execute(
        """
        SELECT kasa_sayim FROM sube_operasyon_event
        WHERE sube_id=%s AND tarih=%s::date AND tip='ACILIS' AND durum='tamamlandi'
        ORDER BY cevap_ts DESC NULLS LAST LIMIT 1
        """,
        (sube_id, str(tarih)),
    )
    row = cur.fetchone()
    sabah_kasa = float(dict(row).get("kasa_sayim") or 0) if row else 0.0
    try:
        bek_raw = beklenen_onceki_kapanis_kasa(cur, sube_id, tarih)
        bek = float(bek_raw if bek_raw is not None else 0)
    except Exception:
        bek = 0.0
    return {"sabah_kasa": sabah_kasa, "beklenen": bek}


# ─────────────────────────────────────────────────────────────────
# ANA FONKSİYON
# ─────────────────────────────────────────────────────────────────

# Tolerans eşiği — bu seviyenin altında otomatik çözüldü işaretlenir
OTOMATIK_COZUM_ESIK_TL = 0.01


def sube_gun_kapanis_recalc(cur: Any, sube_id: str, tarih: Any, *, kim_pid=None, kim_ad=None):
    """TEK TETİKLEME NOKTASI (KÖK-E, FIX KP3): nakit ciro/gider değişen akışlar (avans teslim,
    ciro iptal, nakit gider red) bunu çağırır → o gün+şube KAPANIS kasa fark uyarısı güncel tutulur,
    böylece masum personele eski/yanlış zimmet yüklenmez. Uyarı henüz yoksa no-op (tazelenecek fark
    yok). yeniden_hesapla AŞAĞIDA tanımlı (aynı modül, runtime resolve). Çağıranın transaction'ında çalışır."""
    cur.execute(
        """
        SELECT id FROM sube_operasyon_uyari
        WHERE sube_id=%s AND tarih=%s::date AND tip='KAPANIS_KASA_FARK'
        ORDER BY tarih DESC LIMIT 1
        """,
        (str(sube_id), str(tarih)),
    )
    row = cur.fetchone()
    if not row:
        return None  # o gün+şube için kasa fark uyarısı yok — tazelenecek bir şey yok
    return yeniden_hesapla(cur, dict(row)["id"], kim_pid=kim_pid, kim_ad=kim_ad)


def yeniden_hesapla(
    cur: Any,
    uyari_id: str,
    *,
    kim_pid: Optional[str] = None,
    kim_ad: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Verilen kasa fark uyarısını DB'nin güncel haline göre yeniden hesaplar.

    Yapılan iş:
    - sube_operasyon_uyari satırı bulunur (tip ACILIS_KASA_FARK / KAPANIS_KASA_FARK)
    - İlgili bileşenler yeniden toplanır
    - Yeni fark hesaplanır
    - Eski fark ile karşılaştırılır:
        * yeni_fark ≤ eşik → otomatik 'çözüldü' işaretle (cozum_duzeltilen_tl = yeni_fark)
        * yeni_fark > eşik → uyari satırını güncelle (beklenen/gercek/fark/seviye/detay_json)
    - onay_kuyrugu kaydı varsa:
        * durum='bekliyor' + yeni_fark ≤ eşik → onay_kuyrugu iptal et
        * durum='bekliyor' + yeni_fark > eşik → tutar/aciklama güncelle
        * durum='onaylandi' → revize kayıt log'la (manuel müdahale gerekli)

    Returns:
        {
          "uyari_id": ...,
          "eski_fark": float,
          "yeni_fark": float,
          "otomatik_cozuldu": bool,
          "onay_durumu_eski": str | None,
          "onay_durumu_yeni": str | None,
          "uyari_silindi_mi": False,  # uyari silinmez, sadece okundu=TRUE
        }
    """
    # Pre-flight: constraint genişletilmiş olsun (process-level cache, 1 kez kontrol)
    _onay_kuyrugu_constraint_garantile(cur)

    cur.execute(
        """
        SELECT id, sube_id::text, tarih::text, tip, fark_tl, beklenen_tl, gercek_tl,
               okundu, cozum_duzeltilen_tl, detay_json
        FROM sube_operasyon_uyari
        WHERE id=%s AND tip IN ('ACILIS_KASA_FARK','KAPANIS_KASA_FARK')
        FOR UPDATE
        """,
        (uyari_id,),
    )
    row = cur.fetchone()
    if not row:
        raise ValueError(f"Uyari bulunamadi: {uyari_id}")
    u = dict(row)
    sube_id = str(u["sube_id"])
    tarih = u["tarih"]
    tip = str(u["tip"])
    eski_fark = float(u.get("fark_tl") or 0)
    eski_beklenen = float(u.get("beklenen_tl") or 0)
    eski_gercek = float(u.get("gercek_tl") or 0)

    # Yeniden hesapla
    if tip == "KAPANIS_KASA_FARK":
        bilesenler = _bilesenleri_topla_kapanis(cur, sube_id, tarih)
        yeni_fark = _formul_kapanis(bilesenler)
        yeni_beklenen = bilesenler["acilis_kasa"] + bilesenler["z_nakit"] - bilesenler["nakit_giderler"] - bilesenler["ara_teslim"]
        yeni_gercek = bilesenler["teslim"] + bilesenler["devir"]
        detay_json_yeni = {
            "acilis_kasa": bilesenler["acilis_kasa"],
            "z_nakit": bilesenler["z_nakit"],
            "nakit_giderler": bilesenler["nakit_giderler"],
            "ara_teslim": bilesenler["ara_teslim"],
            "teslim": bilesenler["teslim"],
            "devir": bilesenler["devir"],
            "fark": yeni_fark,
            "yeniden_hesap_ts": True,
        }
    else:  # ACILIS_KASA_FARK
        bilesenler = _bilesenleri_topla_acilis(cur, sube_id, tarih)
        yeni_fark = round(bilesenler["sabah_kasa"] - bilesenler["beklenen"], 2)
        yeni_beklenen = bilesenler["beklenen"]
        yeni_gercek = bilesenler["sabah_kasa"]
        detay_json_yeni = {
            "sabah_kasa": bilesenler["sabah_kasa"],
            "beklenen": bilesenler["beklenen"],
            "fark": yeni_fark,
            "yeniden_hesap_ts": True,
        }

    yeni_seviye = tolerans_seviyesi(yeni_fark)
    otomatik_cozuldu = abs(yeni_fark) <= OTOMATIK_COZUM_ESIK_TL

    # Uyari satırını güncelle
    if otomatik_cozuldu:
        cur.execute(
            """
            UPDATE sube_operasyon_uyari
            SET fark_tl=%s, beklenen_tl=%s, gercek_tl=%s, seviye=%s,
                detay_json=%s,
                okundu=TRUE,
                cozum_duzeltilen_tl=%s,
                cozum_notu=COALESCE(cozum_notu, 'Kaynak düzeltildi — fark sıfırlandı'),
                cozum_ts=COALESCE(cozum_ts, NOW()),
                cozum_personel_id=COALESCE(cozum_personel_id, %s),
                cozum_personel_ad=COALESCE(cozum_personel_ad, %s)
            WHERE id=%s
            """,
            (yeni_fark, yeni_beklenen, yeni_gercek, yeni_seviye,
             json.dumps(detay_json_yeni, ensure_ascii=False),
             yeni_fark, kim_pid, kim_ad, uyari_id),
        )
        # ── PREMATURE SİNYAL TEMİZLİĞİ ──
        # Düzeltme sonrası gerçek fark ~0 → bu bir SAYIM HATASIYDI (kayıp yok).
        # Kapanış/açılış anında ham veriden tetiklenen personel "kasa açık" sinyalini
        # ŞÜPHE → DİSİPLİN'e indir: özensizlik olarak izlenir ama hırsızlık paternine SAYILMAZ.
        try:
            cur.execute(
                """
                UPDATE personel_risk_sinyal
                SET sinyal_turu = 'SAYIM_OZENSIZLIK',
                    agirlik = LEAST(COALESCE(agirlik, 0), 3),
                    aciklama = COALESCE(aciklama, '') ||
                               ' | [Düzeltme sonrası fark 0 — sayım özensizliği, kayıp yok]'
                WHERE sube_id = %s AND tarih = %s::date AND sinyal_turu = %s
                """,
                (sube_id, str(tarih), tip),
            )
        except Exception as _ex_sig:
            log.warning("premature risk sinyali yeniden sınıflanamadı: %s", _ex_sig)
    else:
        cur.execute(
            """
            UPDATE sube_operasyon_uyari
            SET fark_tl=%s, beklenen_tl=%s, gercek_tl=%s, seviye=%s,
                detay_json=%s
            WHERE id=%s
            """,
            (yeni_fark, yeni_beklenen, yeni_gercek, yeni_seviye,
             json.dumps(detay_json_yeni, ensure_ascii=False),
             uyari_id),
        )

    # onay_kuyrugu senkronizasyonu — HEM ACILIS_KASA_FARK HEM KAPANIS_KASA_FARK.
    # (Önceden yalnız KAPANIS senkronlanıyordu; ACILIS düzeltilince kuyrukta eski
    #  tutarla hayalet 'bekliyor' kayıt kalıyordu — düzeltildi.)
    # Eşleştirme sağlamlaştırıldı: aciklama '[sube_id]' ile BAŞLAR (alt-dizgi çakışması yok),
    # ve 'bekliyor' kayıt 'iptal'/'onaylandi'dan önce gelir.
    onay_durumu_eski = None
    onay_durumu_yeni = None
    if True:
        cur.execute(
            """
            SELECT id, durum FROM onay_kuyrugu
            WHERE islem_turu=%s
              AND kaynak_tablo='kasa_farki'
              AND tarih=%s::date
              AND aciklama LIKE %s
            ORDER BY (durum='bekliyor') DESC, olusturma DESC LIMIT 1
            """,
            (tip, str(tarih), f"[{sube_id}]%"),
        )
        onay_row = cur.fetchone()
        if onay_row:
            onay_row = dict(onay_row)
            onay_id = onay_row["id"]
            onay_durumu_eski = str(onay_row.get("durum") or "")
            if onay_durumu_eski == "bekliyor":
                if otomatik_cozuldu:
                    # Onay kuyruğu otomatik iptal
                    cur.execute(
                        "UPDATE onay_kuyrugu SET durum='iptal', onay_tarihi=NOW() WHERE id=%s",
                        (onay_id,),
                    )
                    onay_durumu_yeni = "iptal"
                else:
                    # Tutar güncelle
                    cur.execute(
                        """
                        UPDATE onay_kuyrugu
                        SET tutar=%s,
                            aciklama=%s
                        WHERE id=%s
                        """,
                        (
                            yeni_fark,
                            f"[{sube_id}] {'Açılış' if tip == 'ACILIS_KASA_FARK' else 'Kapanış'} kasa farkı (yeniden hesap): {yeni_fark:+,.2f}₺",
                            onay_id,
                        ),
                    )
                    onay_durumu_yeni = "bekliyor"
            elif onay_durumu_eski == "onaylandi":
                # Onaylanmış onay — REVİZE AKIŞI (Stripe Expand-Contract):
                # 1) Eski onayı 'iptal_revize' yap (constraint genişletildi, semantik ayrım korunur)
                # 2) Yeni fark > eşik ise YENİ 'bekliyor' kayıt aç (merkez yeniden onaylasın)
                # 3) Yeni fark ~ 0 ise sadece iptal_revize yeter (yeni onaya gerek yok)
                cur.execute(
                    """
                    UPDATE onay_kuyrugu
                    SET durum='iptal_revize',
                        onay_tarihi=NOW(),
                        aciklama = COALESCE(aciklama, '') ||
                                   ' | [REVİZE-' ||
                                   to_char(NOW() AT TIME ZONE 'Europe/Istanbul','YYYY-MM-DD HH24:MI') ||
                                   '] kaynak düzeltildi, yeni fark ' || %s::text || '₺'
                    WHERE id=%s
                    """,
                    (f"{yeni_fark:+.2f}", onay_id),
                )
                onay_durumu_yeni = "iptal_revize"
                if not otomatik_cozuldu:
                    # Yeni bekliyor kayıt — merkez yeniden onaylasın
                    yeni_onay_id = str(_uuid.uuid4())
                    _fark_etiket = "Açılış" if tip == "ACILIS_KASA_FARK" else "Kapanış"
                    cur.execute(
                        """
                        INSERT INTO onay_kuyrugu
                            (id, islem_turu, kaynak_tablo, kaynak_id, aciklama, tutar, tarih, durum)
                        VALUES (%s, %s, 'kasa_farki', %s, %s, %s, %s::date, 'bekliyor')
                        """,
                        (
                            yeni_onay_id,
                            tip,
                            yeni_onay_id,
                            (f"[{sube_id}] {_fark_etiket} kasa farkı (REVİZE — eski onay "
                             f"{onay_id[:8]}…): {yeni_fark:+,.2f}₺"),
                            yeni_fark,
                            str(tarih),
                        ),
                    )
                    onay_durumu_yeni = "iptal_revize_yeni_bekliyor"

    return {
        "uyari_id": uyari_id,
        "eski_fark": eski_fark,
        "yeni_fark": yeni_fark,
        "eski_beklenen": eski_beklenen,
        "yeni_beklenen": yeni_beklenen,
        "eski_gercek": eski_gercek,
        "yeni_gercek": yeni_gercek,
        "yeni_seviye": yeni_seviye,
        "otomatik_cozuldu": otomatik_cozuldu,
        "onay_durumu_eski": onay_durumu_eski,
        "onay_durumu_yeni": onay_durumu_yeni,
        "detay_json": detay_json_yeni,
    }
