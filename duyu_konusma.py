"""
KONUŞMA İZİ DUYULARI — "söylenen söz de bir olaydır" (2026-07-07, Codex çaprazlı)

Sistemin sahibe giden ÜÇ SESİ var: V1 günlük rapor (defter), V2 akıllı denetim özeti
(dedektif), V3 beyin günlüğü (anlatıcı). Bu modül V1+V2'nin KİMLİKSİZ özetini omurgaya
olay olarak yazar — sistemin dışa dönük sözü denetlenebilir tarih olur.

CODEX FRENLERİ (2026-07-07 danışma, repo-doğrulamalı):
- YANKI ODASI: V3 (beynin kendi anlatısı) omurgaya ASLA yazılmaz — beyin kendi sesini
  duyu verisi olarak okuyup kendini pekiştiremez (V3 zaten beyin_gunluk arşivinde).
- KABALAŞTIR + GECİKTİR: motor özeti omurgaya ancak D+2 olgun pencereden ve kaba
  kovalarla girer — 4 şubeli sistemde şube+gün+keskin güven dolaylı kişi işaretçisidir.
  Kesin güven yüzdesi yok, vardiya/kişi taneciği yok, tanı adları ARINDIRMA_HARITASI'ndan.
- KANIT DEĞİL: konuşma izleri (kaynak_aile=iletisim) motor uyanış kapısında kanıt
  SAYILMAZ — motor kendi sesini kanıt olarak duyamaz (kanit_paketi 'iletisim' ailesini
  meta gibi dışlar).
- SÖZ→AKSİYON (Codex'in 4. ilişkisi): hangi ses gereksiz telaş yaratmadan işe yaradı?
  Konuşma izi × ertesi-gün insan aksiyonu eşleşmesi aday olay olur (öneri dili).
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

from database import db

logger = logging.getLogger(__name__)


# ── V1 İZİ: günlük rapor özeti (gönderim kancasından) ────────────────────────
def rapor_izi_kaydet(tarih: date) -> None:
    """Günlük özet WhatsApp'a gittikten sonra: raporun SAYISAL özü omurgaya.
    Kişi adları (açılış listesi, teslim eden...) BİLEREK yok — sadece rakamlar."""
    try:
        from duyu_omurga import duyu_nabiz_yaz, duyu_olay_yaz
        with db() as (_, cur):
            cur.execute(
                """
                SELECT s.ad, COALESCE(SUM(c.toplam), 0) AS ciro
                FROM subeler s
                LEFT JOIN ciro c ON c.sube_id = s.id AND c.tarih = %s AND c.durum = 'aktif'
                WHERE s.aktif = TRUE
                GROUP BY s.ad
                """,
                (str(tarih),),
            )
            satirlar = [dict(r) for r in (cur.fetchall() or [])]
        sube_ciro = {s["ad"]: float(s["ciro"] or 0) for s in satirlar}
        eksik = sorted([ad for ad, c in sube_ciro.items() if c == 0])
        duyu_olay_yaz(
            "rapor_izi", "iletisim.rapor.gunluk_ozet",
            str(tarih),
            entity_scope="genel", occurred_at=str(tarih),
            signal_name="Günlük rapor gönderildi (sayısal öz)",
            payload={"sube_ciro": sube_ciro,
                     "toplam_ciro": round(sum(sube_ciro.values()), 2),
                     "kapanis_girilmeyen": eksik},
        )
        duyu_nabiz_yaz("rapor_izi", taranan=1, uretilen=1)
    except Exception as e:  # noqa: BLE001
        logger.warning("rapor izi yutuldu: %s", str(e)[:120])


# ── V2 İZİ: motor bulgu özeti (KABA + D+2 GECİKMELİ) ─────────────────────────
def gece_motor_bulgu_izi() -> None:
    """GECE: D-2 gününün motor gözlemleri şube başına KABA özet olarak omurgaya.
    personel_id OKUNMAZ; tanılar arındırma haritasından geçer (bilinmeyen → 'diger');
    sayılar kovalıdır (yok/az/cok). Motorun sesi kanıt DEĞİLDİR (aile=iletisim)."""
    from duyu_omurga import duyu_nabiz_yaz, duyu_olay_yaz
    try:
        from duyu_uyanis import ARINDIRMA_HARITASI
        hedef = date.today() - timedelta(days=2)  # Codex: olgun pencere, taze gece verisi girmez
        with db() as (_, cur):
            cur.execute(
                """
                SELECT h.sube_id, s.ad AS sube_ad,
                       COUNT(*)::int AS gozlem_n,
                       COUNT(*) FILTER (WHERE h.sonuc_anomali)::int AS anomali_n,
                       ARRAY_AGG(DISTINCT h.sonuc_tani)
                           FILTER (WHERE h.sonuc_anomali AND h.sonuc_tani IS NOT NULL) AS taniler
                FROM denetim_hipotez_gozlem h JOIN subeler s ON s.id = h.sube_id
                WHERE h.tarih = %s
                GROUP BY h.sube_id, s.ad
                """,
                (str(hedef),),
            )
            satirlar = [dict(r) for r in (cur.fetchall() or [])]
        uretilen = 0
        for r in satirlar:
            anomali_n = int(r.get("anomali_n") or 0)
            kova = "yok" if anomali_n == 0 else ("az" if anomali_n <= 2 else "cok")
            taniler = sorted({ARINDIRMA_HARITASI.get(str(t), "diger")
                              for t in (r.get("taniler") or [])})[:5]
            duyu_olay_yaz(
                "motor_bulgu_izi", "iletisim.motor.bulgu_kesiti",
                f"{r['sube_id']}_{hedef}",
                entity_scope="sube", entity_id=str(r["sube_id"]), occurred_at=str(hedef),
                signal_name="Motor bulgu kesiti (kaba, gecikmeli)",
                payload={"sube_ad": r.get("sube_ad"), "gozlem_kova":
                         "yok" if int(r.get("gozlem_n") or 0) == 0 else
                         ("az" if int(r.get("gozlem_n") or 0) <= 5 else "cok"),
                         "anomali_kova": kova, "taniler": taniler},
            )
            uretilen += 1
        duyu_nabiz_yaz("motor_bulgu_izi", taranan=len(satirlar), uretilen=uretilen)
    except Exception as e:  # noqa: BLE001
        logger.warning("gece motor bulgu izi yutuldu: %s", str(e)[:120])
        duyu_nabiz_yaz("motor_bulgu_izi", durum="hata", yutulan_hata=1, not_metin=str(e)[:200])


# ── SÖZ → AKSİYON: hangi ses işe yaradı? (Codex'in 4. ilişkisi) ──────────────
def gece_soz_aksiyon() -> None:
    """GECE: D-3'te söylenen motor bulgu kesiti × sonraki 2 günde aynı şubede insan
    aksiyonu (onay kararı köprü etiketi / manuel düzeltme / geriye-dönük müdahale) →
    söz-aksiyon adayı. ÖNERİ dili; 'ses işe yaradı' hükmü değil, birliktelik kaydı."""
    from duyu_omurga import duyu_nabiz_yaz, duyu_olay_yaz
    try:
        soz_gun = date.today() - timedelta(days=3)
        aksiyon_bas, aksiyon_bit = soz_gun, soz_gun + timedelta(days=2)
        with db() as (_, cur):
            cur.execute(
                """
                SELECT event_id, entity_id, payload_json
                FROM duyu_olay
                WHERE duyu = 'motor_bulgu_izi' AND occurred_at::date = %s
                  AND (payload_json->>'anomali_kova') <> 'yok'
                """,
                (str(soz_gun),),
            )
            sozler = [dict(r) for r in (cur.fetchall() or [])]
            aksiyonlar = {}
            if sozler:
                cur.execute(
                    """
                    SELECT sube_id, COUNT(*)::int AS n FROM envanter_duzeltme
                    WHERE olusturma::date BETWEEN %s AND %s
                    GROUP BY sube_id
                    """,
                    (str(aksiyon_bas), str(aksiyon_bit)),
                )
                aksiyonlar = {str(dict(r)["sube_id"]): int(dict(r)["n"])
                              for r in (cur.fetchall() or [])}
        uretilen = 0
        for s in sozler:
            n = aksiyonlar.get(str(s.get("entity_id") or ""), 0)
            if n == 0:
                continue
            duyu_olay_yaz(
                "soz_aksiyon", "meta.iletisim.soz_aksiyon_adayi",
                f"{s['event_id']}",
                entity_scope="sube", entity_id=str(s.get("entity_id")),
                occurred_at=str(soz_gun),
                signal_name="Söz sonrası aksiyon birlikteliği (aday)",
                evidence_class="oneri", assertion_level="korele", confidence=0.4,
                payload={"soz_event_id": s["event_id"],
                         "sonraki_2gun_duzeltme_n": n,
                         "not": "Birliktelik ≠ nedensellik; L4 hammaddesi."},
            )
            uretilen += 1
        duyu_nabiz_yaz("soz_aksiyon", taranan=len(sozler), uretilen=uretilen)
    except Exception as e:  # noqa: BLE001
        logger.warning("gece soz-aksiyon yutuldu: %s", str(e)[:120])
        duyu_nabiz_yaz("soz_aksiyon", durum="hata", yutulan_hata=1, not_metin=str(e)[:200])


def gece_konusma_calistir() -> None:
    """Tek giriş — motor izi + söz-aksiyon (rapor izi gönderim kancasından beslenir)."""
    gece_motor_bulgu_izi()
    gece_soz_aksiyon()
