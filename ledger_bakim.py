"""
Ledger düzeltmeleri — yanlışlıkla 'fatura' kanalına yazılmış kira / sabit gider kayıtlarını
sabit gider havuzuna taşır (panel özetleri ve kart kırılımlarıyla uyum).

Kural: sabit_giderler kaydı tip != 'degisken' VEYA kategori 'kira' ise,
- kasa: FATURA_ODEMESI → SABIT_GIDER
- kart: kaynak_tablo fatura_giderleri → sabit_giderler
"""

from __future__ import annotations

from typing import Any, Callable, Dict, Optional


def _sg_yanlis_fatura_hedefi() -> str:
    """sabit_giderler ile eşleşen WHERE parçası (tip/kategori)."""
    return """
        (
            sg.tip IS DISTINCT FROM 'degisken'
            OR LOWER(TRIM(COALESCE(sg.kategori, ''))) = 'kira'
        )
    """


def yanlis_fatura_siniflandirma_ozet(cur) -> Dict[str, Any]:
    """Dry-run sayıları — güncelleme yapmaz."""
    wh = _sg_yanlis_fatura_hedefi()
    cur.execute(
        f"""
        SELECT COUNT(*) AS n
        FROM kasa_hareketleri kh
        INNER JOIN sabit_giderler sg ON sg.id::text = kh.kaynak_id::text
        WHERE kh.kaynak_tablo = 'sabit_giderler'
          AND kh.islem_turu = 'FATURA_ODEMESI'
          AND kh.kasa_etkisi = true
          AND kh.durum = 'aktif'
          AND {wh}
        """
    )
    kasa_n = int(cur.fetchone()["n"])
    cur.execute(
        f"""
        SELECT COUNT(*) AS n
        FROM kart_hareketleri kh
        INNER JOIN sabit_giderler sg ON sg.id::text = kh.kaynak_id::text
        WHERE kh.kaynak_tablo = 'fatura_giderleri'
          AND kh.islem_turu = 'HARCAMA'
          AND kh.durum = 'aktif'
          AND {wh}
        """
    )
    kart_n = int(cur.fetchone()["n"])
    return {"kasa_fatura_yanlis": kasa_n, "kart_fatura_yanlis": kart_n}


def duzelt_yanlis_fatura_siniflandirma(cur, dry_run: bool = False) -> Dict[str, Any]:
    """
    Eski kayıtları doğru türe taşır. Tek transaction içinde cur ile çağrılmalı (db()).
    """
    ozet = yanlis_fatura_siniflandirma_ozet(cur)
    out: Dict[str, Any] = {
        "dry_run": dry_run,
        "once_kasa_fatura_yanlis": ozet["kasa_fatura_yanlis"],
        "once_kart_fatura_yanlis": ozet["kart_fatura_yanlis"],
    }
    if dry_run:
        out["mesaj"] = "Dry-run: güncelleme yapılmadı."
        return out

    wh = _sg_yanlis_fatura_hedefi()
    cur.execute(
        f"""
        UPDATE kasa_hareketleri kh
        SET
            islem_turu = 'SABIT_GIDER',
            ref_type = CASE
                WHEN kh.ref_type IN ('FATURA_ODEMESI', 'FATURA') THEN 'SABIT_GIDER'
                ELSE kh.ref_type
            END
        FROM sabit_giderler sg
        WHERE kh.kaynak_tablo = 'sabit_giderler'
          AND kh.kaynak_id::text = sg.id::text
          AND kh.islem_turu = 'FATURA_ODEMESI'
          AND kh.kasa_etkisi = true
          AND kh.durum = 'aktif'
          AND {wh}
        """
    )
    kasa_guncel = cur.rowcount

    cur.execute(
        f"""
        UPDATE kart_hareketleri kh
        SET kaynak_tablo = 'sabit_giderler'
        FROM sabit_giderler sg
        WHERE kh.kaynak_id::text = sg.id::text
          AND kh.kaynak_tablo = 'fatura_giderleri'
          AND kh.islem_turu = 'HARCAMA'
          AND kh.durum = 'aktif'
          AND {wh}
        """
    )
    kart_guncel = cur.rowcount

    out["kasa_guncellenen"] = kasa_guncel
    out["kart_guncellenen"] = kart_guncel
    son = yanlis_fatura_siniflandirma_ozet(cur)
    out["sonra_kasa_fatura_yanlis"] = son["kasa_fatura_yanlis"]
    out["sonra_kart_fatura_yanlis"] = son["kart_fatura_yanlis"]
    out["mesaj"] = (
        f"Kasa: {kasa_guncel} satır SABIT_GIDER yapıldı; "
        f"kart: {kart_guncel} satır sabit_giderler kaynağına alındı."
    )
    return out


def ledger_fatura_sabit_otomatik_tamamla(
    kart_plan_guncelle_fn: Optional[Callable[[], Any]] = None,
    log_info: Optional[Callable[[str], None]] = None,
    log_warning: Optional[Callable[[str], None]] = None,
) -> Dict[str, Any]:
    """
    Doğru sıra (sistem tek giriş noktası):
    1) Kasa + kart ledger düzeltmelerini uygula ve commit et
    2) Kart satırı değiştiyse kart ödeme planını güncelle

    İkinci ve sonraki çalıştırmalarda eşleşen satır yoksa no-op (idempotent).
    """
    from database import db

    with db() as (conn, cur):
        sonuc = duzelt_yanlis_fatura_siniflandirma(cur, dry_run=False)

    n_kart = int(sonuc.get("kart_guncellenen") or 0)
    n_kasa = int(sonuc.get("kasa_guncellenen") or 0)
    sonuc["adimlar"] = [
        "ledger_guncelle_commit",
        "kart_plan_guncelle" if n_kart > 0 and kart_plan_guncelle_fn else "kart_plan_atlandi",
    ]

    if n_kart > 0 and kart_plan_guncelle_fn:
        try:
            kart_plan_guncelle_fn()
            sonuc["kart_plani_yenilendi"] = True
        except Exception as e:
            sonuc["kart_plani_yenilendi"] = False
            sonuc["kart_plani_hata"] = str(e)
            if log_warning:
                log_warning(f"kart_plan_guncelle: {e}")
    else:
        sonuc["kart_plani_yenilendi"] = False

    if n_kasa + n_kart > 0 and log_info:
        log_info(f"Ledger fatura→sabit (otomatik sıra): {sonuc.get('mesaj', '')}")

    return sonuc
