"""
Merkezi kasa yazma ve audit — main.py ile döngüsel import olmaması için ayrı modül.
sube_panel ve main aynı insert_kasa_hareketi / audit imzasını kullanır.
"""
import json
import uuid


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
                        kaynak_tablo=None, kaynak_id=None, ref_id=None, ref_type=None):
    """
    Merkezi kasa yazma fonksiyonu.
    - kaynak_id = business ID (gider_id, ciro_id vb.) — değişmez
    - ref_id    = ledger event ID — her yazımda benzersiz
    - kasa_etkisi = KASA_ETKISI_MAP'ten — DEVIR hariç hepsi true
    """
    _event_id = ref_id or str(uuid.uuid4())
    _ref_type = ref_type or (kaynak_tablo.upper() if kaynak_tablo else 'GENEL')
    _kasa_etkisi = KASA_ETKISI_MAP.get(islem_turu, True)

    cur.execute("""
        INSERT INTO kasa_hareketleri
            (id, tarih, islem_turu, tutar, aciklama, kaynak_tablo, kaynak_id, ref_id, ref_type, kasa_etkisi)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """, (str(uuid.uuid4()), str(tarih), islem_turu, tutar, aciklama,
          kaynak_tablo, kaynak_id, _event_id, _ref_type, _kasa_etkisi))

    if cur.rowcount == 0:
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
