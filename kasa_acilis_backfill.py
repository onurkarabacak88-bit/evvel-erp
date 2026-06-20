"""
Açılış Kasa Farkı — Geriye Dönük Backfill (İZOLE).

Sorun: ACILIS_KASA_FARK uyarısı yalnızca SABAH AÇILIŞI KAYDEDİLİRKEN ve o an
"dünkü beklenen devir" biliniyorsa yazılır (sube_operasyon.py). Dünkü kapanış geç
kesinleştiyse beklenen devir o an boştu → uyarı HİÇ yazılmadı. Sonra Şubeler ekranı
farkı CANLI hesaplayıp gösteriyor ama Kasa Uyumsuzluk (kalıcı kayıt) boş kalıyor.
Geriye dönük yeniden-hesap (kasa_fark_recalc) sadece VAR OLAN kaydı günceller, eksik
kaydı OLUŞTURMAZ → fark kalıcı olarak Kasa Uyumsuzluk dışında kalıyordu.

Çözüm: Bu modül son N iş gününü tarar; bir şube+gün için açılış farkı varsa
(sabah sayım ≠ dün devir, |fark|>eşik) AMA ACILIS_KASA_FARK kaydı YOKSA → kaydı
OLUŞTURUR. Mevcut INSERT deseninin (sube_operasyon.py) birebir aynısı; çift kayıt
yapmaz (varsa atlar). Hiçbir mevcut kaydı bozmaz → öneri-only, geri-dönüşsüz değil.

Kullanım:
  - POST /api/ops/kasa-uyumsuzluk/acilis-backfill?gun=21&dry_run=true  → önizleme (kaç eksik)
  - POST /api/ops/kasa-uyumsuzluk/acilis-backfill?gun=21               → yaz
  - kasa-uyumsuzluk LIST ucu açılışta SELF-HEAL olarak hata-yutar çağırır (o günü).
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Optional

logger = logging.getLogger(__name__)

ESIK_TL = 0.01


def _acilis_fark_eksikleri(cur: Any, gun: int) -> list[dict]:
    """Son `gun` iş gününde: açılış farkı olan ama ACILIS_KASA_FARK kaydı OLMAYAN
    (sube_id, tarih) satırlarını döndür — beklenen/gercek/fark/seviye hesaplı."""
    from operasyon_kurallar import tolerans_seviyesi, beklenen_onceki_kapanis_kasa

    # Tamamlanmış açılış event'leri (iş günü = event.tarih) — son N gün
    cur.execute(
        """
        SELECT DISTINCT ON (e.sube_id, e.tarih)
               e.sube_id::text AS sube_id, e.tarih::text AS tarih,
               e.kasa_sayim, e.personel_id::text AS acilis_pid, e.personel_ad AS acilis_pad
        FROM sube_operasyon_event e
        WHERE e.tip='ACILIS' AND e.durum='tamamlandi'
          AND e.tarih >= CURRENT_DATE - (%s || ' days')::interval
        ORDER BY e.sube_id, e.tarih, e.cevap_ts DESC NULLS LAST
        """,
        (int(gun),),
    )
    acilislar = [dict(r) for r in (cur.fetchall() or [])]

    eksik: list[dict] = []
    for a in acilislar:
        sube_id = a["sube_id"]
        tarih = a["tarih"]
        ks = float(a.get("kasa_sayim") or 0)
        # Beklenen dünkü devir (artık biliniyor)
        try:
            bek_raw = beklenen_onceki_kapanis_kasa(cur, sube_id, tarih)
        except Exception:
            bek_raw = None
        if bek_raw is None:
            continue  # hâlâ beklenen yok → fark hesaplanamaz, atla
        bek = float(bek_raw)
        fark = round(ks - bek, 2)
        if abs(fark) <= ESIK_TL:
            continue  # fark yok / önemsiz
        # Bu şube+gün için zaten ACILIS_KASA_FARK var mı?
        cur.execute(
            "SELECT 1 FROM sube_operasyon_uyari WHERE sube_id=%s AND tarih=%s::date AND tip='ACILIS_KASA_FARK' LIMIT 1",
            (sube_id, tarih),
        )
        if cur.fetchone():
            continue  # zaten var → atla
        # Dünkü kapanış personeli (atıf için)
        cur.execute(
            """
            SELECT personel_id::text AS pid, personel_ad AS pad
            FROM sube_operasyon_event
            WHERE sube_id=%s AND tip='KAPANIS' AND durum='tamamlandi'
              AND tarih = (%s::date - INTERVAL '1 day')
            ORDER BY cevap_ts DESC NULLS LAST, id DESC LIMIT 1
            """,
            (sube_id, tarih),
        )
        kp = cur.fetchone() or {}
        eksik.append({
            "sube_id": sube_id, "tarih": tarih, "kasa_sayim": ks, "beklenen": bek,
            "fark": fark, "seviye": tolerans_seviyesi(fark),
            "acilis_pid": a.get("acilis_pid"), "acilis_pad": a.get("acilis_pad"),
            "kapanis_pid": (kp.get("pid") or None), "kapanis_pad": (kp.get("pad") or None),
        })
    return eksik


def backfill(cur: Any, gun: int = 21, dry_run: bool = False) -> dict:
    """Eksik ACILIS_KASA_FARK uyarılarını oluştur (veya dry_run ile sadece say).
    sube_operasyon.py'deki INSERT'in birebir aynısı."""
    eksikler = _acilis_fark_eksikleri(cur, gun)
    if dry_run:
        return {
            "ok": True, "dry_run": True, "gun": gun, "eksik_sayisi": len(eksikler),
            "eksikler": [
                {"sube_id": e["sube_id"], "tarih": e["tarih"], "fark_tl": e["fark"], "seviye": e["seviye"]}
                for e in eksikler
            ],
        }
    yazilan = 0
    for e in eksikler:
        mesaj = (
            f"Açılış kasası dün devirine göre fark: {e['fark']:+,.2f} TL "
            f"(beklenen {e['beklenen']:,.0f}₺ → gerçek {e['kasa_sayim']:,.0f}₺, {e['seviye']}) "
            f"[geriye dönük backfill]"
        )
        cur.execute(
            """
            INSERT INTO sube_operasyon_uyari
                (id, sube_id, tarih, tip, seviye, beklenen_tl, gercek_tl, fark_tl, mesaj,
                 acilis_personel_id, acilis_personel_ad, kapanis_personel_id, kapanis_personel_ad)
            VALUES (%s, %s, %s::date, 'ACILIS_KASA_FARK', %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (str(uuid.uuid4()), e["sube_id"], e["tarih"], e["seviye"], e["beklenen"],
             e["kasa_sayim"], e["fark"], mesaj, e["acilis_pid"], e["acilis_pad"],
             e["kapanis_pid"], e["kapanis_pad"]),
        )
        yazilan += 1
    return {"ok": True, "dry_run": False, "gun": gun, "yazilan": yazilan}


def self_heal_gun(tarih: str) -> int:
    """Kasa Uyumsuzluk LIST açılışında çağrılır — SADECE verilen gün için eksik açılış
    uyarısını yaz. KENDİ transaction'ında çalışır; hata YUTULUR (liste sorgusunu asla
    bozmaz/zehirlemez). Yazılan sayı döner."""
    from database import db
    try:
        with db() as (_, cur):
            eksikler = [e for e in _acilis_fark_eksikleri(cur, 3) if e["tarih"] == str(tarih)]
            n = 0
            for e in eksikler:
                mesaj = (
                    f"Açılış kasası dün devirine göre fark: {e['fark']:+,.2f} TL "
                    f"(beklenen {e['beklenen']:,.0f}₺ → gerçek {e['kasa_sayim']:,.0f}₺, {e['seviye']}) "
                    f"[geriye dönük backfill]"
                )
                cur.execute(
                    """
                    INSERT INTO sube_operasyon_uyari
                        (id, sube_id, tarih, tip, seviye, beklenen_tl, gercek_tl, fark_tl, mesaj,
                         acilis_personel_id, acilis_personel_ad, kapanis_personel_id, kapanis_personel_ad)
                    VALUES (%s, %s, %s::date, 'ACILIS_KASA_FARK', %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (str(uuid.uuid4()), e["sube_id"], e["tarih"], e["seviye"], e["beklenen"],
                     e["kasa_sayim"], e["fark"], mesaj, e["acilis_pid"], e["acilis_pad"],
                     e["kapanis_pid"], e["kapanis_pad"]),
                )
                n += 1
        return n
    except Exception as ex:  # noqa: BLE001 — self-heal asla listeyi bozmaz
        logger.warning("acilis backfill self-heal yutuldu: %s", str(ex)[:160])
        return 0
