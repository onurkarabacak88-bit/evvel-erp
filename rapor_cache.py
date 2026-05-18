"""
rapor_cache.py
--------------
Raporlama hızlandırma — özet tablolarını yazan ve okuyan tek modül.

Tablolar (database.py'da CREATE):
- rapor_gunluk_sube_ozet (sube,tarih) → ciro/kasa/gider/personel
- rapor_gunluk_urun_ozet (sube,tarih,kalem) → açılan/sevk/kullanılan/kalan
- rapor_aylik_food_cost (sube,year_month) → ciro/gider/food_cost%
- rapor_batch_log → batch izleme

Kullanım:
1) Gece batch: `gunluk_ozet_topla_tum_subeler(cur, tarih)` + `aylik_food_cost_hesapla(cur, ym)`
2) Olay-tetikli (kapanış/gider/ciro sonrası): `gunluk_ozet_yenile(cur, sube_id, tarih, kaynak='event')`
3) Okuma: `gunluk_ozet_oku(cur, sube_id, tarih)` veya `aylik_food_cost_oku(cur, sube_id, ym)`

DEFENSIVE: Tüm fonksiyonlar try/except içinde. Tablo yoksa veya
hata olursa sessiz dön — caller'ın akışını bozmasın.
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

log = logging.getLogger(__name__)


def _safe_exec(cur: Any, sql: str, params: tuple = ()) -> bool:
    """Defensive: SQL execute — savepoint ile sar, hata olursa False dön."""
    try:
        cur.execute("SAVEPOINT sp_rapor_cache")
        cur.execute(sql, params)
        cur.execute("RELEASE SAVEPOINT sp_rapor_cache")
        return True
    except Exception as e:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_rapor_cache")
        except Exception:
            pass
        log.debug("rapor_cache safe_exec hata: %s | sql=%s", e, sql[:100])
        return False


# ─────────────────────────────────────────────────────────────────
# GÜNLÜK ŞUBE ÖZETİ
# ─────────────────────────────────────────────────────────────────

def gunluk_ozet_topla(cur: Any, sube_id: str, tarih: Any) -> Optional[Dict[str, Any]]:
    """Bir şubenin verilen günü için tüm metrikleri DB'den toplar.
    Hata olursa None döner."""
    try:
        tarih_str = str(tarih)
        sonuc: Dict[str, Any] = {"sube_id": sube_id, "tarih": tarih_str}

        # 1) Ciro
        cur.execute(
            """
            SELECT COALESCE(SUM(nakit), 0)::float  AS ciro_nakit,
                   COALESCE(SUM(pos), 0)::float    AS ciro_pos,
                   COALESCE(SUM(online), 0)::float AS ciro_online,
                   COALESCE(SUM(toplam), 0)::float AS ciro_toplam,
                   COUNT(*) AS ciro_sayi
            FROM ciro
            WHERE sube_id=%s AND tarih=%s::date AND durum='aktif'
            """,
            (sube_id, tarih_str),
        )
        cr = dict(cur.fetchone() or {})
        sonuc["ciro_nakit"]  = float(cr.get("ciro_nakit") or 0)
        sonuc["ciro_pos"]    = float(cr.get("ciro_pos") or 0)
        sonuc["ciro_online"] = float(cr.get("ciro_online") or 0)
        sonuc["ciro_toplam"] = float(cr.get("ciro_toplam") or 0)
        sonuc["ciro_durum"]  = "onaylandi" if int(cr.get("ciro_sayi") or 0) > 0 else None

        if sonuc["ciro_durum"] is None:
            cur.execute(
                """
                SELECT nakit::float, pos::float, online::float, durum
                FROM ciro_taslak
                WHERE sube_id=%s AND tarih=%s::date AND durum IN ('bekliyor','onaylandi')
                ORDER BY olusturma DESC LIMIT 1
                """,
                (sube_id, tarih_str),
            )
            tr = cur.fetchone()
            if tr:
                tr = dict(tr)
                sonuc["ciro_nakit"]  = float(tr.get("nakit") or 0)
                sonuc["ciro_pos"]    = float(tr.get("pos") or 0)
                sonuc["ciro_online"] = float(tr.get("online") or 0)
                sonuc["ciro_toplam"] = round(sonuc["ciro_nakit"] + sonuc["ciro_pos"] + sonuc["ciro_online"], 2)
                sonuc["ciro_durum"]  = "taslak"

        # 2) Anlık giderler (aktif + onay_bekliyor)
        cur.execute(
            """
            SELECT
              COALESCE(SUM(tutar) FILTER (
                WHERE LOWER(COALESCE(NULLIF(TRIM(odeme_yontemi),''),'nakit'))='nakit'
              ), 0)::float AS gider_nakit,
              COALESCE(SUM(tutar) FILTER (
                WHERE LOWER(COALESCE(NULLIF(TRIM(odeme_yontemi),''),'nakit'))='kart'
              ), 0)::float AS gider_kart,
              COUNT(*) AS gider_adet
            FROM anlik_giderler
            WHERE sube=%s AND tarih=%s::date AND durum IN ('aktif','onay_bekliyor')
            """,
            (sube_id, tarih_str),
        )
        gr = dict(cur.fetchone() or {})
        sonuc["anlik_gider_nakit"] = float(gr.get("gider_nakit") or 0)
        sonuc["anlik_gider_kart"]  = float(gr.get("gider_kart") or 0)
        sonuc["anlik_gider_adet"]  = int(gr.get("gider_adet") or 0)

        # 3) Ara teslimler
        cur.execute(
            """
            SELECT COALESCE(SUM(tutar), 0)::float AS toplam
            FROM kasa_teslim
            WHERE sube_id=%s AND tarih=%s::date AND teslim_turu='ara'
            """,
            (sube_id, tarih_str),
        )
        sonuc["ara_teslim"] = float((cur.fetchone() or {}).get("toplam") or 0)

        # 4) ACILIS event
        cur.execute(
            """
            SELECT kasa_sayim::float AS kasa, personel_ad
            FROM sube_operasyon_event
            WHERE sube_id=%s AND tarih=%s::date AND tip='ACILIS' AND durum='tamamlandi'
            ORDER BY cevap_ts DESC NULLS LAST LIMIT 1
            """,
            (sube_id, tarih_str),
        )
        ar = cur.fetchone()
        if ar:
            ar = dict(ar)
            sonuc["kasa_acilis"]    = float(ar.get("kasa") or 0)
            sonuc["acilis_yapildi"] = True
            sonuc["acilis_personel"] = str(ar.get("personel_ad") or "")
        else:
            sonuc["kasa_acilis"]    = 0.0
            sonuc["acilis_yapildi"] = False
            sonuc["acilis_personel"] = None

        # 5) KAPANIS event
        cur.execute(
            """
            SELECT kasa_sayim::float AS kasa,
                   COALESCE(teslim, 0)::float AS teslim,
                   COALESCE(devir, 0)::float AS devir,
                   personel_ad
            FROM sube_operasyon_event
            WHERE sube_id=%s AND tarih=%s::date AND tip='KAPANIS' AND durum='tamamlandi'
            ORDER BY cevap_ts DESC NULLS LAST LIMIT 1
            """,
            (sube_id, tarih_str),
        )
        kr = cur.fetchone()
        if kr:
            kr = dict(kr)
            sonuc["kasa_kapanis"]    = float(kr.get("kasa") or 0)
            sonuc["kasa_teslim"]     = float(kr.get("teslim") or 0)
            sonuc["kasa_devir"]      = float(kr.get("devir") or 0)
            sonuc["kapanis_yapildi"] = True
            sonuc["kapanis_personel"] = str(kr.get("personel_ad") or "")
        else:
            sonuc["kasa_kapanis"]    = 0.0
            sonuc["kasa_teslim"]     = 0.0
            sonuc["kasa_devir"]      = 0.0
            sonuc["kapanis_yapildi"] = False
            sonuc["kapanis_personel"] = None

        # 6) Kasa farkı (efektif)
        cur.execute(
            """
            SELECT COALESCE(cozum_duzeltilen_tl, fark_tl)::float AS efektif_fark,
                   seviye, okundu
            FROM sube_operasyon_uyari
            WHERE sube_id=%s AND tarih=%s::date AND tip='KAPANIS_KASA_FARK'
            ORDER BY olusturma DESC LIMIT 1
            """,
            (sube_id, tarih_str),
        )
        ur = cur.fetchone()
        if ur:
            ur = dict(ur)
            sonuc["kasa_fark_tl"] = float(ur.get("efektif_fark") or 0)
            if bool(ur.get("okundu")):
                sonuc["kasa_fark_durum"] = "cozuldu"
            else:
                sonuc["kasa_fark_durum"] = str(ur.get("seviye") or "normal")
        else:
            sonuc["kasa_fark_tl"] = None
            sonuc["kasa_fark_durum"] = None

        return sonuc
    except Exception as e:
        log.warning("gunluk_ozet_topla hata sube=%s tarih=%s: %s", sube_id, tarih, e)
        return None


def gunluk_ozet_yaz(cur: Any, ozet: Dict[str, Any], kaynak: str = "batch") -> bool:
    """gunluk_ozet_topla() çıktısını DB'ye UPSERT eder. Hata olursa False."""
    if not ozet:
        return False
    return _safe_exec(
        cur,
        """
        INSERT INTO rapor_gunluk_sube_ozet
            (sube_id, tarih, ciro_nakit, ciro_pos, ciro_online, ciro_toplam, ciro_durum,
             fis_sayisi, kasa_acilis, kasa_kapanis, kasa_teslim, kasa_devir, ara_teslim,
             kasa_fark_tl, kasa_fark_durum,
             anlik_gider_nakit, anlik_gider_kart, anlik_gider_adet,
             acilis_yapildi, kapanis_yapildi, acilis_personel, kapanis_personel,
             guncelleme, kaynak)
        VALUES (%s, %s::date, %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s, %s,
                %s, %s,
                %s, %s, %s,
                %s, %s, %s, %s,
                NOW(), %s)
        ON CONFLICT (sube_id, tarih) DO UPDATE SET
            ciro_nakit = EXCLUDED.ciro_nakit,
            ciro_pos = EXCLUDED.ciro_pos,
            ciro_online = EXCLUDED.ciro_online,
            ciro_toplam = EXCLUDED.ciro_toplam,
            ciro_durum = EXCLUDED.ciro_durum,
            fis_sayisi = EXCLUDED.fis_sayisi,
            kasa_acilis = EXCLUDED.kasa_acilis,
            kasa_kapanis = EXCLUDED.kasa_kapanis,
            kasa_teslim = EXCLUDED.kasa_teslim,
            kasa_devir = EXCLUDED.kasa_devir,
            ara_teslim = EXCLUDED.ara_teslim,
            kasa_fark_tl = EXCLUDED.kasa_fark_tl,
            kasa_fark_durum = EXCLUDED.kasa_fark_durum,
            anlik_gider_nakit = EXCLUDED.anlik_gider_nakit,
            anlik_gider_kart = EXCLUDED.anlik_gider_kart,
            anlik_gider_adet = EXCLUDED.anlik_gider_adet,
            acilis_yapildi = EXCLUDED.acilis_yapildi,
            kapanis_yapildi = EXCLUDED.kapanis_yapildi,
            acilis_personel = EXCLUDED.acilis_personel,
            kapanis_personel = EXCLUDED.kapanis_personel,
            guncelleme = NOW(),
            kaynak = EXCLUDED.kaynak
        """,
        (
            ozet["sube_id"], ozet["tarih"],
            ozet["ciro_nakit"], ozet["ciro_pos"], ozet["ciro_online"], ozet["ciro_toplam"], ozet.get("ciro_durum"),
            int(ozet.get("fis_sayisi") or 0),
            ozet["kasa_acilis"], ozet["kasa_kapanis"], ozet["kasa_teslim"], ozet["kasa_devir"], ozet["ara_teslim"],
            ozet.get("kasa_fark_tl"), ozet.get("kasa_fark_durum"),
            ozet["anlik_gider_nakit"], ozet["anlik_gider_kart"], ozet["anlik_gider_adet"],
            ozet["acilis_yapildi"], ozet["kapanis_yapildi"],
            ozet.get("acilis_personel"), ozet.get("kapanis_personel"),
            kaynak,
        ),
    )


def gunluk_ozet_yenile(cur: Any, sube_id: str, tarih: Any, kaynak: str = "event") -> bool:
    """Topla + Yaz tek seferde. Event-driven kullanımda çağrılır.
    Hata olursa sessizce False — caller'ı bozmaz."""
    try:
        ozet = gunluk_ozet_topla(cur, sube_id, tarih)
        if ozet:
            return gunluk_ozet_yaz(cur, ozet, kaynak=kaynak)
        return False
    except Exception as e:
        log.warning("gunluk_ozet_yenile hata: %s", e)
        return False


def gunluk_ozet_topla_tum_subeler(cur: Any, tarih: Any) -> int:
    """Tüm aktif şubeler için günlük özeti hesaplar ve yazar."""
    try:
        cur.execute("SELECT id::text FROM subeler WHERE aktif=TRUE")
        sube_ids = [r["id"] for r in (cur.fetchall() or [])]
    except Exception as e:
        log.warning("subeler okunamadı: %s", e)
        return 0
    sayac = 0
    for sid in sube_ids:
        if gunluk_ozet_yenile(cur, sid, tarih, kaynak="batch"):
            sayac += 1
    return sayac


# ─────────────────────────────────────────────────────────────────
# AYLIK FOOD COST
# ─────────────────────────────────────────────────────────────────

def aylik_food_cost_hesapla(cur: Any, year_month: str) -> int:
    """Verilen ay için tüm şubelerin food cost özetini hesaplar ve yazar."""
    if len(year_month) != 7 or year_month[4] != "-":
        return 0
    try:
        cur.execute("SELECT id::text FROM subeler WHERE aktif=TRUE")
        sube_ids = [r["id"] for r in (cur.fetchall() or [])]
    except Exception:
        return 0
    sayac = 0
    for sid in sube_ids:
        try:
            cur.execute(
                """
                SELECT
                  COALESCE(SUM(ciro_toplam), 0)::float AS toplam_ciro,
                  COALESCE(SUM(anlik_gider_nakit + anlik_gider_kart), 0)::float AS anlik_g,
                  COALESCE(SUM(fis_sayisi), 0) AS fis
                FROM rapor_gunluk_sube_ozet
                WHERE sube_id=%s
                  AND to_char(tarih, 'YYYY-MM') = %s
                """,
                (sid, year_month),
            )
            r = dict(cur.fetchone() or {})
            toplam_ciro = float(r.get("toplam_ciro") or 0)
            anlik = float(r.get("anlik_g") or 0)
            fis = int(r.get("fis") or 0)
            sabit = 0.0
            toplam_gider = anlik + sabit
            fc_pct = round((toplam_gider / toplam_ciro) * 100, 2) if toplam_ciro > 0 else None
            ort_fis = round(toplam_ciro / fis, 2) if fis > 0 else None

            ok = _safe_exec(
                cur,
                """
                INSERT INTO rapor_aylik_food_cost
                    (sube_id, year_month, toplam_ciro, toplam_gider,
                     anlik_gider, sabit_gider, food_cost_pct,
                     fis_sayisi, ortalama_fis_tutari, guncelleme)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
                ON CONFLICT (sube_id, year_month) DO UPDATE SET
                    toplam_ciro = EXCLUDED.toplam_ciro,
                    toplam_gider = EXCLUDED.toplam_gider,
                    anlik_gider = EXCLUDED.anlik_gider,
                    sabit_gider = EXCLUDED.sabit_gider,
                    food_cost_pct = EXCLUDED.food_cost_pct,
                    fis_sayisi = EXCLUDED.fis_sayisi,
                    ortalama_fis_tutari = EXCLUDED.ortalama_fis_tutari,
                    guncelleme = NOW()
                """,
                (sid, year_month, toplam_ciro, toplam_gider, anlik, sabit,
                 fc_pct, fis, ort_fis),
            )
            if ok:
                sayac += 1
        except Exception as e:
            log.warning("aylik_food_cost hata sube=%s ym=%s: %s", sid, year_month, e)
    return sayac


# ─────────────────────────────────────────────────────────────────
# HIZLI OKUMA
# ─────────────────────────────────────────────────────────────────

def gunluk_ozet_oku(cur: Any, sube_id: Optional[str] = None,
                    bastar: Any = None, bittar: Any = None) -> List[Dict[str, Any]]:
    """Cache'ten günlük şube özeti döndür."""
    try:
        params: List[Any] = []
        where = []
        if sube_id:
            where.append("sube_id=%s")
            params.append(sube_id)
        if bastar:
            where.append("tarih >= %s::date")
            params.append(str(bastar))
        if bittar:
            where.append("tarih <= %s::date")
            params.append(str(bittar))
        if not where:
            where.append("tarih = CURRENT_DATE")
        sql = f"""
            SELECT * FROM rapor_gunluk_sube_ozet
            WHERE {' AND '.join(where)}
            ORDER BY tarih DESC, sube_id
        """
        cur.execute(sql, tuple(params))
        return [dict(r) for r in (cur.fetchall() or [])]
    except Exception as e:
        log.warning("gunluk_ozet_oku hata: %s", e)
        return []


def aylik_food_cost_oku(cur: Any, sube_id: Optional[str] = None,
                        year_month: Optional[str] = None) -> List[Dict[str, Any]]:
    """Cache'ten aylık food cost döndür."""
    try:
        params: List[Any] = []
        where = []
        if sube_id:
            where.append("sube_id=%s")
            params.append(sube_id)
        if year_month:
            where.append("year_month=%s")
            params.append(year_month)
        sql = f"""
            SELECT * FROM rapor_aylik_food_cost
            {'WHERE ' + ' AND '.join(where) if where else ''}
            ORDER BY year_month DESC, sube_id
        """
        cur.execute(sql, tuple(params))
        return [dict(r) for r in (cur.fetchall() or [])]
    except Exception as e:
        log.warning("aylik_food_cost_oku hata: %s", e)
        return []


# ─────────────────────────────────────────────────────────────────
# BATCH LOG
# ─────────────────────────────────────────────────────────────────

def batch_log_basla(cur: Any, tipi: str, detay: Optional[Dict] = None) -> Optional[str]:
    """Batch başlat — döndürülen ID None ise log yazılamadı."""
    try:
        import uuid
        bid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO rapor_batch_log (id, batch_tipi, baslangic_ts, durum, detay)
            VALUES (%s, %s, NOW(), 'calisiyor', %s::jsonb)
            """,
            (bid, tipi, json.dumps(detay or {}, ensure_ascii=False)),
        )
        return bid
    except Exception as e:
        log.warning("batch_log_basla hata: %s", e)
        return None


def batch_log_bitir(cur: Any, batch_id: Optional[str], islenen: int, sure_ms: int,
                    detay: Optional[Dict] = None) -> None:
    if not batch_id:
        return
    try:
        cur.execute(
            """
            UPDATE rapor_batch_log
            SET bitis_ts=NOW(), durum='basarili',
                islenen_kayit=%s, sure_ms=%s,
                detay=COALESCE(%s::jsonb, detay)
            WHERE id=%s
            """,
            (islenen, sure_ms, json.dumps(detay, ensure_ascii=False) if detay else None, batch_id),
        )
    except Exception:
        pass


def batch_log_hata(cur: Any, batch_id: Optional[str], hata: str, sure_ms: int = 0) -> None:
    if not batch_id:
        return
    try:
        cur.execute(
            """
            UPDATE rapor_batch_log
            SET bitis_ts=NOW(), durum='hatali', sure_ms=%s, hata_mesaji=%s
            WHERE id=%s
            """,
            (sure_ms, hata[:2000], batch_id),
        )
    except Exception:
        pass
