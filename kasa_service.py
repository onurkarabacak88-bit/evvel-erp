"""
Merkezi kasa yazma ve audit — main.py ile döngüsel import olmaması için ayrı modül.
sube_panel ve main aynı insert_kasa_hareketi / audit imzasını kullanır.
"""
from __future__ import annotations

import calendar
import hashlib
import json
import uuid
from datetime import date
from typing import List

from finans_core import kart_borc
from tr_saat import bugun_tr


KASA_ETKISI_MAP = {
    'CIRO': True, 'CIRO_IPTAL': True,
    'DIS_KAYNAK': True, 'DIS_KAYNAK_IPTAL': True,
    'ANLIK_GIDER': True, 'ANLIK_GIDER_IPTAL': True,
    'KART_ODEME': True, 'KART_ODEME_IPTAL': True, 'KART_FAIZ': True,
    'VADELI_ODEME': True, 'VADELI_IPTAL': True,
    'PERSONEL_MAAS': True, 'SABIT_GIDER': True,
    'BORC_TAKSIT': True, 'FATURA_ODEMESI': True,
    'ODEME_PLANI': False, 'ODEME_IPTAL': False,
    'KASA_GIRIS': True, 'KASA_DUZELTME': True, 'POS_KESINTI': True,
    'ONLINE_KESINTI': True, 'KISMI_ODE': True,
    'DEVIR': False,
}


def insert_kasa_hareketi(cur, tarih, islem_turu, tutar, aciklama,
                        kaynak_tablo=None, kaynak_id=None, ref_id=None, ref_type=None, idempotency_key=None):
    """
    Merkezi kasa yazma fonksiyonu.
    - kaynak_id = business ID (gider_id, ciro_id vb.) — değişmez
    - ref_id    = ledger event ID — her yazımda benzersiz
    - kasa_etkisi = KASA_ETKISI_MAP'ten — DEVIR hariç hepsi true
    - idempotency_key: verilmezse geriye uyumlu deterministic anahtar üretilir.
    """
    def _norm(v):
        return str(v).strip() if v is not None else ""

    def _make_idem_key():
        t = _norm(tarih)
        tt = f"{float(tutar):.2f}"
        if ref_id:
            # Yeni yol: event bazlı anahtar (retry-safe)
            raw = f"v2|ref|{_norm(islem_turu)}|{_norm(kaynak_tablo)}|{_norm(kaynak_id)}|{_norm(ref_id)}|{t}|{tt}"
        else:
            # Geriye uyum: eski çağrılar ref_id geçmese de temel business anahtarıyla dedupe.
            raw = f"v2|legacy|{_norm(islem_turu)}|{_norm(kaynak_tablo)}|{_norm(kaynak_id)}|{t}|{tt}|{_norm(aciklama)}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    _event_id = ref_id or str(uuid.uuid4())
    _ref_type = ref_type or (kaynak_tablo.upper() if kaynak_tablo else 'GENEL')
    _kasa_etkisi = KASA_ETKISI_MAP.get(islem_turu, True)
    _idem = (idempotency_key or "").strip() or _make_idem_key()

    cur.execute("""
        INSERT INTO kasa_hareketleri
            (id, tarih, islem_turu, tutar, aciklama, kaynak_tablo, kaynak_id, ref_id, ref_type, kasa_etkisi, idempotency_key)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (idempotency_key) DO NOTHING
    """, (str(uuid.uuid4()), str(tarih), islem_turu, tutar, aciklama,
          kaynak_tablo, kaynak_id, _event_id, _ref_type, _kasa_etkisi, _idem))

    if cur.rowcount == 0:
        # Aynı anahtarla daha önce yazıldıysa idempotent başarı kabul edilir.
        cur.execute("SELECT 1 FROM kasa_hareketleri WHERE idempotency_key=%s", (_idem,))
        if cur.fetchone():
            return
        raise Exception(f"KASA YAZILMADI — {islem_turu} / {kaynak_id}")


def audit(cur, tablo, kayit_id, islem, eski=None, yeni=None):
    def safe_json(d):
        if not d:
            return None
        return json.dumps({k: str(v) if not isinstance(v, (str, int, float, bool, type(None))) else v
                          for k, v in dict(d).items()})
    cur.execute("""INSERT INTO audit_log (id,tablo,kayit_id,islem,eski_deger,yeni_deger)
        VALUES (%s,%s,%s,%s,%s,%s)""",
        (str(uuid.uuid4()), tablo, kayit_id, islem,
         safe_json(eski), safe_json(yeni)))


KASA_IPTAL_MAP = {
    "ANLIK_GIDER_IPTAL": True,
    "CIRO_IPTAL": True,
    "DIS_KAYNAK_IPTAL": True,
    "KART_ODEME_IPTAL": True,
    "VADELI_IPTAL": True,
    "ODEME_IPTAL": True,
}


def iptal_kasa_hareketi(cur, kaynak_id, kaynak_tablo, islem_turu, iptal_turu, aciklama):
    """
    Merkezi kasa iptal fonksiyonu.
    KURAL 1: Olmayan şey iptal edilemez (durum filtresi YOK — kasa_etkisi bazlı)
    KURAL 2: Aynı şey iki kez iptal edilemez
    KURAL 3: Her hareketin karşılığı vardır + kasa_etkisi zorunlu
    """
    cur.execute(
        """
        SELECT id, tutar FROM kasa_hareketleri
        WHERE kaynak_id=%s AND islem_turu=%s AND kasa_etkisi=true AND durum='aktif'
    """,
        (kaynak_id, islem_turu),
    )
    mevcutlar = cur.fetchall()
    if not mevcutlar:
        raise Exception(f"İptal edilecek kayıt bulunamadı — {islem_turu} / {kaynak_id}")

    cur.execute(
        """
        SELECT 1 FROM kasa_hareketleri
        WHERE kaynak_id=%s AND islem_turu=%s
        LIMIT 1
    """,
        (kaynak_id, iptal_turu),
    )
    if cur.fetchone():
        raise Exception(f"Bu kayıt zaten iptal edilmiş — {iptal_turu} / {kaynak_id}")

    for m in mevcutlar:
        cur.execute("UPDATE kasa_hareketleri SET durum='iptal' WHERE id=%s", (m["id"],))

    net_tutar = sum(float(m["tutar"]) for m in mevcutlar)
    _kasa_etkisi = KASA_IPTAL_MAP.get(iptal_turu, True)
    cur.execute(
        """
        INSERT INTO kasa_hareketleri
            (id, tarih, islem_turu, tutar, aciklama, kaynak_tablo, kaynak_id, ref_id, ref_type, kasa_etkisi)
        VALUES (%s, CURRENT_DATE, %s, %s, %s, %s, %s, %s, %s, %s)
    """,
        (
            str(uuid.uuid4()),
            iptal_turu,
            -net_tutar,
            aciklama,
            kaynak_tablo,
            kaynak_id,
            str(uuid.uuid4()),
            kaynak_tablo.upper(),
            _kasa_etkisi,
        ),
    )

    if cur.rowcount == 0:
        raise Exception(f"İptal kaydı yazılamadı — {iptal_turu} / {kaynak_id}")


def vadeli_kasadan_odenen_toplam(cur, vadeli_id: str) -> float:
    """
    Vadeli alıma ait nakit VADELI_ODEME toplamı.
    Eski kayıtlar odeme_plani.id ile, kısmi ödeme ve yeni tam ödeme vadeli_alimlar.id ile tutulabilir — ikisini de sayar.
    """
    cur.execute(
        """
        SELECT COALESCE(SUM(ABS(tutar)), 0) AS t
        FROM kasa_hareketleri
        WHERE islem_turu = 'VADELI_ODEME' AND kasa_etkisi = true AND durum = 'aktif'
        AND (
            (kaynak_tablo = 'vadeli_alimlar' AND kaynak_id = %s)
            OR kaynak_id IN (
                SELECT id FROM odeme_plani
                WHERE kaynak_tablo = 'vadeli_alimlar' AND kaynak_id = %s
            )
        )
        """,
        (vadeli_id, vadeli_id),
    )
    return float(cur.fetchone()["t"])


def vadeli_alim_kapat(cur, vadeli_id: str, tarih: str):
    """
    Vadeli alım kapatma — 3 tabloyu atomik kapatır (çağıran transaction içinde çalışır).
    Zaten 'odendi' ise idempotent (UPDATE 0 row).
    """
    cur.execute(
        "UPDATE vadeli_alimlar SET durum='odendi' WHERE id=%s AND durum='bekliyor'",
        (vadeli_id,),
    )
    cur.execute(
        """
        UPDATE odeme_plani
        SET durum='odendi', odeme_tarihi=%s
        WHERE kaynak_tablo='vadeli_alimlar' AND kaynak_id=%s
        AND durum IN ('bekliyor','onay_bekliyor')
    """,
        (tarih, vadeli_id),
    )
    cur.execute(
        """
        UPDATE onay_kuyrugu
        SET durum='onaylandi', onay_tarihi=NOW()
        WHERE kaynak_tablo='vadeli_alimlar' AND kaynak_id=%s
        AND durum='bekliyor'
    """,
        (vadeli_id,),
    )
    cur.execute(
        """
        UPDATE onay_kuyrugu
        SET durum='onaylandi', onay_tarihi=NOW()
        WHERE kaynak_id IN (
            SELECT id FROM odeme_plani
            WHERE kaynak_tablo='vadeli_alimlar' AND kaynak_id=%s
        )
        AND durum='bekliyor'
    """,
        (vadeli_id,),
    )


def onay_ekle(cur, islem_turu, kaynak_tablo, kaynak_id, aciklama, tutar, tarih):
    cur.execute(
        """INSERT INTO onay_kuyrugu (id,islem_turu,kaynak_tablo,kaynak_id,aciklama,tutar,tarih)
        VALUES (%s,%s,%s,%s,%s,%s,%s)""",
        (
            str(uuid.uuid4()),
            islem_turu,
            kaynak_tablo,
            kaynak_id,
            aciklama,
            tutar,
            tarih,
        ),
    )


def kart_plan_guncelle_tx(cur) -> List[str]:
    """
    Mevcut cursor ile ödeme planlarını günceller — ayrı db() açmaz.
    Kart harcama/fatura/vadeli ödemesi ile aynı transaction içinde çağrılmalıdır.
    FOR UPDATE: iki eş zamanlı işlem aynı kart için çift plan oluşturmasın.
    """
    bugun = bugun_tr()
    yil, ay = bugun.year, bugun.month
    guncellenen: List[str] = []
    cur.execute("SELECT * FROM kartlar WHERE aktif=TRUE FOR UPDATE")
    for k in cur.fetchall():
        son_odeme_gun = k["son_odeme_gunu"] or 25
        son_gun = calendar.monthrange(yil, ay)[1]
        son_odeme_gun = min(son_odeme_gun, son_gun)
        odeme_tarihi = date(yil, ay, son_odeme_gun)

        borc = kart_borc(cur, k["id"])
        if borc <= 0:
            continue

        asgari_oran_pct = float(k.get("asgari_oran", 40)) / 100
        asgari = round(borc * asgari_oran_pct, 2)

        cur.execute(
            """
            UPDATE odeme_plani
            SET odenecek_tutar=%s, asgari_tutar=%s
            WHERE kart_id=%s
            AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', %s::date)
            AND durum IN ('bekliyor','onay_bekliyor')
        """,
            (borc, asgari, k["id"], str(odeme_tarihi)),
        )

        if cur.rowcount > 0:
            guncellenen.append(f"{k['kart_adi']}: {borc:,.0f}₺")
        else:
            pid = str(uuid.uuid4())
            cur.execute(
                """
                INSERT INTO odeme_plani
                    (id, kart_id, tarih, odenecek_tutar, asgari_tutar, aciklama, durum)
                VALUES (%s, %s, %s, %s, %s, %s, 'bekliyor')
            """,
                (
                    pid,
                    k["id"],
                    odeme_tarihi,
                    borc,
                    asgari,
                    f"Kart: {k['kart_adi']} — {k['banka']}",
                ),
            )
            guncellenen.append(f"{k['kart_adi']}: {borc:,.0f}₺ (yeni plan)")
    return guncellenen
