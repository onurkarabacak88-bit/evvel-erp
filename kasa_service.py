"""
Merkezi kasa yazma, iptal, vadeli alım kapatma ve audit / onay kuyruğu.
HTTP bilmez; `main` ve diğer modüller burayı çağırır.
"""

import json
import uuid
from typing import Any, Optional

# Tüm kasa işlem tipleri — bilinmeyen tip default true alır (güvenli)
KASA_ETKISI_MAP = {
    "CIRO": True,
    "CIRO_IPTAL": True,
    "CIRO_DUZELTME": True,
    "DIS_KAYNAK": True,
    "DIS_KAYNAK_IPTAL": True,
    "ANLIK_GIDER": True,
    "ANLIK_GIDER_IPTAL": True,
    "KART_ODEME": True,
    "KART_ODEME_IPTAL": True,
    "KART_FAIZ": True,
    "VADELI_ODEME": True,
    "VADELI_IPTAL": True,
    "PERSONEL_MAAS": True,
    "SABIT_GIDER": True,
    "BORC_TAKSIT": True,
    "FATURA_ODEMESI": True,
    "ODEME_PLANI": False,
    "ODEME_IPTAL": False,
    "KASA_GIRIS": True,
    "KASA_DUZELTME": True,
    "POS_KESINTI": True,
    "ONLINE_KESINTI": True,
    "KISMI_ODE": True,
    "DEVIR": False,
}


def insert_kasa_hareketi(
    cur,
    tarih,
    islem_turu,
    tutar,
    aciklama,
    kaynak_tablo=None,
    kaynak_id=None,
    ref_id=None,
    ref_type=None,
):
    """
    Merkezi kasa yazma.
    - kaynak_id = business ID (gider_id, ciro_id vb.) — değişmez
    - ref_id    = ledger event ID — her yazımda benzersiz
    - kasa_etkisi = KASA_ETKISI_MAP'ten — DEVIR hariç hepsi true
    """
    _event_id = ref_id or str(uuid.uuid4())
    _ref_type = ref_type or (kaynak_tablo.upper() if kaynak_tablo else "GENEL")
    _kasa_etkisi = KASA_ETKISI_MAP.get(islem_turu, True)

    cur.execute(
        """
        INSERT INTO kasa_hareketleri
            (id, tarih, islem_turu, tutar, aciklama, kaynak_tablo, kaynak_id, ref_id, ref_type, kasa_etkisi)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            str(uuid.uuid4()),
            str(tarih),
            islem_turu,
            tutar,
            aciklama,
            kaynak_tablo,
            kaynak_id,
            _event_id,
            _ref_type,
            _kasa_etkisi,
        ),
    )

    if cur.rowcount == 0:
        raise RuntimeError(f"KASA YAZILMADI — {islem_turu} / {kaynak_id}")


# Kasa etkisi mapping — her iptal tipi dahil, bilinmeyen tip sistemi durdurur
KASA_IPTAL_MAP = {
    "ANLIK_GIDER_IPTAL": True,
    "CIRO_IPTAL": True,
    "CIRO_DUZELTME": True,
    "DIS_KAYNAK_IPTAL": True,
    "KART_ODEME_IPTAL": True,
    "VADELI_IPTAL": True,
    "ODEME_IPTAL": True,
}


def iptal_kasa_hareketi(
    cur,
    kaynak_id,
    kaynak_tablo,
    islem_turu,
    iptal_turu,
    aciklama,
):
    """
    Merkezi kasa iptal.
    KURAL 1: Sadece aktif, kasa_etkisi=true satırlar iptal edilir.
    KURAL 2: Aynı kayıt iki kez iptal edilemez.
    KURAL 3: Ters kayıt yazılır; kasa_etkisi KASA_IPTAL_MAP'ten.
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
        raise RuntimeError(f"İptal edilecek kayıt bulunamadı — {islem_turu} / {kaynak_id}")

    cur.execute(
        """
        SELECT 1 FROM kasa_hareketleri
        WHERE kaynak_id=%s AND islem_turu=%s
        LIMIT 1
        """,
        (kaynak_id, iptal_turu),
    )
    if cur.fetchone():
        raise RuntimeError(f"Bu kayıt zaten iptal edilmiş — {iptal_turu} / {kaynak_id}")

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
        raise RuntimeError(f"İptal kaydı yazılamadı — {iptal_turu} / {kaynak_id}")


def vadeli_alim_kapat(cur, vadeli_id: str, tarih: str):
    """
    Merkezi vadeli alım kapatma.
    Nereden onaylanırsa onaylansın bu fonksiyon çağrılır — tablolar atomik kapanır.
    Zaten 'odendi' ise sessizce geçer (idempotent).
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


def audit(
    cur,
    tablo: str,
    kayit_id: str,
    islem: str,
    eski: Optional[Any] = None,
    yeni: Optional[Any] = None,
):
    def safe_json(d):
        if not d:
            return None
        return json.dumps(
            {
                k: str(v) if not isinstance(v, (str, int, float, bool, type(None))) else v
                for k, v in dict(d).items()
            }
        )

    cur.execute(
        """INSERT INTO audit_log (id,tablo,kayit_id,islem,eski_deger,yeni_deger)
        VALUES (%s,%s,%s,%s,%s,%s)""",
        (
            str(uuid.uuid4()),
            tablo,
            kayit_id,
            islem,
            safe_json(eski),
            safe_json(yeni),
        ),
    )


def onay_ekle(
    cur,
    islem_turu: str,
    kaynak_tablo: str,
    kaynak_id: str,
    aciklama: str,
    tutar: float,
    tarih: str,
):
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


def kart_plan_guncelle_tx(cur) -> list[str]:
    """
    Aktif kartlar için bekleyen ödeme planı satırlarını güncel borç / asgariye göre yeniler.
    Aynı transaction içinde çağrılmalıdır (commit öncesi).
    """
    from datetime import date

    import calendar as _cal

    from finans_core import kart_bankacilik_ozet, kart_borc

    bugun = date.today()
    yil, ay = bugun.year, bugun.month
    guncellenen: list[str] = []

    cur.execute("SELECT * FROM kartlar WHERE aktif=TRUE")
    for k in cur.fetchall():
        son_odeme_gun = k["son_odeme_gunu"] or 25
        son_gun = _cal.monthrange(yil, ay)[1]
        son_odeme_gun = min(son_odeme_gun, son_gun)
        odeme_tarihi = date(yil, ay, son_odeme_gun)

        borc = kart_borc(cur, k["id"])
        if borc <= 0:
            continue

        bio = kart_bankacilik_ozet(cur, k["id"], dict(k))
        asgari = bio["asgari_odeme"]

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
