"""
Merkezi kasa yazma ve audit — main.py ile döngüsel import olmaması için ayrı modül.
sube_panel ve main aynı insert_kasa_hareketi / audit imzasını kullanır.
"""
from __future__ import annotations

import calendar
import hashlib
import json
import re
import uuid
from datetime import date
from typing import List

from finans_core import (
    kart_borc, kart_asgari_orani, kart_ekstre,
    kesim_tarihi_hesapla, son_odeme_tarihi_hesapla, kart_ekstre_donem_override,
)
from tr_saat import bugun_tr


KASA_ETKISI_MAP = {
    'CIRO': True, 'CIRO_IPTAL': True,
    'DIS_KAYNAK': True, 'DIS_KAYNAK_IPTAL': True,
    'ANLIK_GIDER': True, 'ANLIK_GIDER_IPTAL': True,
    'KART_ODEME': True, 'KART_ODEME_IPTAL': True, 'KART_FAIZ': True,
    'VADELI_ODEME': True, 'VADELI_IPTAL': True,
    'PERSONEL_MAAS': True, 'SABIT_GIDER': True,
    'PERSONEL_AVANS': True,  # avans_service — maaşın erken ödenen parçası (mahsup avans_service'te)
    'BORC_TAKSIT': True, 'FATURA_ODEMESI': True,
    'ODEME_PLANI': False, 'ODEME_IPTAL': False,
    'KASA_GIRIS': True, 'KASA_DUZELTME': True, 'POS_KESINTI': True,
    'ONLINE_KESINTI': True, 'KISMI_ODE': True,
    'DEVIR': False,
}


def insert_kasa_hareketi(cur, tarih, islem_turu, tutar, aciklama,
                        kaynak_tablo=None, kaynak_id=None, ref_id=None, ref_type=None,
                        idempotency_key=None, sube_id=None, odeme_yontemi=None):
    """
    Merkezi kasa yazma fonksiyonu.
    - kaynak_id = business ID (gider_id, ciro_id vb.) — değişmez
    - ref_id    = ledger event ID — her yazımda benzersiz
    - kasa_etkisi = KASA_ETKISI_MAP'ten — DEVIR hariç hepsi true
    - idempotency_key: verilmezse geriye uyumlu deterministic anahtar üretilir.
    - sube_id: hangi şubenin kasasından (2026-08-09). None = merkez/atanmamış.
      Merkez kasa şube kasalarının TOPLAMIDIR; şube taşımayan hareket toplamı
      bozmaz ama "hangi şubeden çıktı" sorusunu cevapsız bırakır.
    - odeme_yontemi: 'elden' | 'havale' | 'kart' | 'nakit'(belirsiz). Elden
      ödenen nakit elde nakiti azaltır, havale banka hesabından çıkar —
      ayrım olmadan banka mutabakatı doğru çalışmaz (sahip 2026-08-09).
    ⚠️ İdempotency anahtarına GİRMEZLER: aynı iş için sonradan şube/yöntem
      düzeltilebilsin, mükerrer kayıt doğmasın.
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
            (id, tarih, islem_turu, tutar, aciklama, kaynak_tablo, kaynak_id, ref_id,
             ref_type, kasa_etkisi, idempotency_key, sube_id, odeme_yontemi)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, COALESCE(%s,'nakit'))
        ON CONFLICT (idempotency_key) DO NOTHING
    """, (str(uuid.uuid4()), str(tarih), islem_turu, tutar, aciklama,
          kaynak_tablo, kaynak_id, _event_id, _ref_type, _kasa_etkisi, _idem,
          sube_id, odeme_yontemi))

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


# ⚠️ ÇİFT SAYIM DÜZELTMESİ (2026-08-09, canlı ölçümle yakalandı)
# iptal_kasa_hareketi() aşağıda orijinal hareketleri KOŞULSUZ `durum='iptal'`
# yapıyor — yani tutar kasa toplamından zaten çıkıyor. Ters kaydın DA kasaya
# etki etmesi aynı düzeltmeyi İKİ KEZ uygulamaktır.
#   Ölçüm: 2.250 ₺ gider silindi → kasa 2.864.581,78 yerine 2.866.831,78 oldu
#          (+2.250 ₺ fazla). Gider iptali kasayı ŞİŞİRİYORDU.
# CIRO_IPTAL/CIRO_DUZELTME için bu daha önce fark edilip False yapılmış ama
# diğer türlere uygulanmamıştı. Ters kayıt HER TÜRDE yalnız AUDIT izidir:
# ne olduğu defterde görünür, kasa toplamına girmez.
KASA_IPTAL_MAP = {
    "ANLIK_GIDER_IPTAL": False,
    "CIRO_IPTAL": False,
    "CIRO_DUZELTME": False,
    "DIS_KAYNAK_IPTAL": False,
    "KART_ODEME_IPTAL": False,
    "VADELI_IPTAL": False,
    "ODEME_IPTAL": False,
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

    # FIX O6 (2026-07-06): eski KURAL 2 ("kaynak_id'de iptal_turu kaydı varsa reddet") kaldırıldı.
    # Analiz: sıralı çift-iptali zaten KURAL 1 durdurur (aktif kayıt kalmaz), eşzamanlı çift-iptali
    # aşağıdaki idempotency anahtarı durdurur. Eski KURAL 2'nin fiilen tetiklendiği TEK senaryo
    # "iptal → yeniden yazım → tekrar iptal" (örn. aynı ciroya 2. düzeltme) = MEŞRU döngüydü →
    # 500 veriyordu. Artık aktif kayıt varsa iptal meşrudur.

    for m in mevcutlar:
        cur.execute("UPDATE kasa_hareketleri SET durum='iptal' WHERE id=%s", (m["id"],))

    net_tutar = sum(float(m["tutar"]) for m in mevcutlar)
    _kasa_etkisi = KASA_IPTAL_MAP.get(iptal_turu, True)
    # FIX A1 (2026-07-05) + O6 (2026-07-06): ters kayda OLAY-bazlı idempotency_key — anahtar
    # iptal edilen hareket ID setinden türer. Eşzamanlı çift istek aynı aktif seti görür → aynı
    # anahtar → tek ters kayıt (A1 korunur). Meşru yeni iptal döngüsünde (yeniden yazım sonrası)
    # set farklı → ters kayıt YAZILIR (eski kaynak_id-bazlı anahtar bunu sessizce yutuyordu —
    # K1'deki "olay yerine kap kimliği" dersinin birebir kopyası).
    _iptal_set = ",".join(sorted(str(m["id"]) for m in mevcutlar))
    _iptal_idem = hashlib.sha256(
        f"v2|iptal|{iptal_turu}|{kaynak_tablo}|{kaynak_id}|{_iptal_set}".encode("utf-8")
    ).hexdigest()
    cur.execute(
        """
        INSERT INTO kasa_hareketleri
            (id, tarih, islem_turu, tutar, aciklama, kaynak_tablo, kaynak_id, ref_id, ref_type, kasa_etkisi, idempotency_key)
        VALUES (%s, CURRENT_DATE, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (idempotency_key) DO NOTHING
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
            _iptal_idem,
        ),
    )

    # ON CONFLICT ile rowcount=0 artık HATA DEĞİL — aynı iptal zaten yazılmış (idempotent
    # başarı). KURAL 2 normal çift-iptali zaten yukarıda yakaladığı için buraya yalnızca
    # eşzamanlı çift-çağrı düşer; sessizce başarı kabul edilir.


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
    # odeme_tarihi (2026-08-09): "ne zaman ödendi" bilgisi hiçbir yere
    # yazılmıyordu; cari ekstre vade tarihini ödeme tarihi sanıyordu.
    cur.execute(
        "UPDATE vadeli_alimlar SET durum='odendi', odeme_tarihi=%s "
        "WHERE id=%s AND durum='bekliyor'",
        (tarih, vadeli_id),
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
        WHERE kaynak_tablo='odeme_plani'
          AND kaynak_id IN (
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


def kart_plani_upsert(cur, kart_id: str, son_odeme_tarihi, odenecek: float,
                      asgari: float, aciklama: str) -> bool:
    """💳 KART ÖDEME PLANI — TEK YAZICI (2026-08-08, sahip: 'kök nedeni kapat').

    MÜKERRER PLAN KÖK NEDENİ: kart planını üç ayrı yer yazıyordu ve korumaları
    FARKLI anahtarlara bakıyordu, birbirini görmüyorlardı:
      · kasa_service  "Kart ekstre:"           → kart_id + tarih ayı + dönem ayıracı
      · manuel giriş  "Kart ekstresi (manuel):" → kart_id + tarih ayı + odendi/kesim
      · motors        "Kart:"                   → kendi koşulu
    Sonuç: aynı ekstre 2-6 kez plana yazıldı (canlı: 22 fazla satır / 2.326.814 ₺,
    "EN PARA" aynı gün 6 kayıt). Dönem ayıracı da boşluk bırakıyordu: 'odendi'
    satır kesim-öncesi ödemeliyse yeni planı BLOKE ETMİYORDU.

    YENİ KURAL — dönem kimliği REFERANS AY'dır:
      · Aynı (kart_id, referans_ay) için EN FAZLA BİR aktif satır olur
      · Satır varsa: bekliyor/onay_bekliyor → tutar güncellenir; 'odendi' →
        DOKUNULMAZ (o dönem kapanmış, yeni satır AÇILMAZ)
      · Yoksa yeni satır açılır ve referans_ay MUTLAKA doldurulur
    Eski satırlarda referans_ay NULL olabildiği için arama iki yönlü:
    referans_ay eşleşmesi VEYA tarih'in ayı eşleşmesi.

    Dönüş: True = yeni satır açıldı, False = mevcut satır güncellendi/korundu.
    """
    sot = str(son_odeme_tarihi)[:10]
    cur.execute(
        """SELECT id, durum FROM odeme_plani
           WHERE kart_id = %s AND kaynak_tablo IS NULL
             AND COALESCE(durum,'') <> 'iptal'
             AND (referans_ay = DATE_TRUNC('month', %s::date)
                  OR DATE_TRUNC('month', tarih) = DATE_TRUNC('month', %s::date))
           ORDER BY CASE WHEN durum='odendi' THEN 0 ELSE 1 END, olusturma
           LIMIT 1""",
        (kart_id, sot, sot))
    mevcut = cur.fetchone()
    if mevcut:
        if (mevcut.get("durum") or "") == "odendi":
            return False          # dönem kapanmış — yeni satır AÇMA
        cur.execute(
            """UPDATE odeme_plani
                 SET odenecek_tutar=%s, asgari_tutar=%s, tarih=%s::date,
                     aciklama=%s, referans_ay=DATE_TRUNC('month', %s::date)
               WHERE id=%s""",
            (odenecek, asgari, sot, aciklama, sot, mevcut["id"]))
        return False
    cur.execute(
        """INSERT INTO odeme_plani
             (id, kart_id, tarih, referans_ay, odenecek_tutar, asgari_tutar, aciklama, durum)
           VALUES (%s, %s, %s::date, DATE_TRUNC('month', %s::date), %s, %s, %s, 'bekliyor')""",
        (str(uuid.uuid4()), kart_id, sot, sot, odenecek, asgari, aciklama))
    return True


def kart_kesim_plani_yaz_tx(cur, k: dict, yil: int, ay: int) -> dict:
    """TEK-OTORİTE kart plan yazıcı — kart planı tutarı SADECE kesim ekstresinden türer.

    FIX A4/K2 (2026-07-05): eskiden kart_plan_guncelle_tx anlık TOPLAM borç (kart_borc)
    yazıyordu; gece motors.aylik_odeme_plani_uret ise KESİM ekstresi yazıyordu → aynı
    (kart_id, ay) planı gün içinde iki farklı değere oynuyordu (harcama anında şişik toplam
    borç, gece doğru kesim). Kredi kartında bu ay KESİLEN ekstre ödenir (toplam borç değil)
    → kesim ekstresi tek otorite yapıldı. Kesim sonrası harcamalar sonraki kesime devreder.

    onay_kuyrugu senkronu (çift-kasa engeli) KORUNDU — eski kart_plan_guncelle_tx'in yaptığı
    reddet/tutar-güncelle davranışı burada da var (motors'ta yoktu, kaybolmasın diye taşındı).

    Dönüş: {"durum": "uretildi"|"guncellendi"|"atlandi", "neden":..., "odenecek":..., "asgari":...}
    """
    kesim_gunu       = int(k["kesim_gunu"])
    son_odeme_gunu   = int(k["son_odeme_gunu"] or 25)
    bu_ay_kesim      = kesim_tarihi_hesapla(yil, ay, kesim_gunu)
    son_odeme_tarihi = son_odeme_tarihi_hesapla(bu_ay_kesim, son_odeme_gunu)

    # Kesim ekstresi (önceki kesim → bu kesim). GERÇEK ekstre snapshot'ı (PDF/manuel) varsa o ezmez.
    ekstre_v  = kart_ekstre(cur, k["id"], kesim_gunu, kesim_tarihi=bu_ay_kesim)
    bu_ekstre = ekstre_v["ekstre_toplam"]
    ov_borc, ov_asgari = kart_ekstre_donem_override(cur, k["id"], bu_ay_kesim)
    # F3 BAYAT-SNAPSHOT FRENİ (2026-07-09 kart derin incelemesi): override'ın
    # "son snapshot" fallback'i BAYAT dönemin borcunu YENİ ayın planına taşıyordu
    # (3018/Ziraat 2x vakalarının kökü). Kural: override yalnız BU KESİM AYINA ait
    # snapshot'tan gelir; yoksa defter tahminine düşülür (taşıma YOK) ve döngü
    # duyusu 'ekstre bekleniyor' der.
    cur.execute(
        """SELECT 1 FROM kart_ekstre_donem
           WHERE kart_id=%s AND donem=DATE_TRUNC('month',%s::date) LIMIT 1""",
        (k["id"], str(bu_ay_kesim)))
    if ov_borc is not None and cur.fetchone() is None:
        ov_borc, ov_asgari = None, None
    if ov_borc is not None:
        odenecek = round(ov_borc, 2)
        # SAHTE-ÖDENDİ FRENİ (2026-07-26): snapshot'ta asgari 0/boş kalabiliyor
        # (PDF'ten okunamadı) — 0 asgari, aşağıdaki 'asgari ödendi' koşulunu
        # 0>=0 ile ödemesiz doğruluyordu → plan ödemesiz kapanıyor, kart ÖM'den
        # kayboluyordu (4 kart vakası). 0/negatif asgari = değer YOK say, orana düş.
        asgari   = (round(ov_asgari, 2) if (ov_asgari is not None and float(ov_asgari) > 0)
                    else round(ov_borc * kart_asgari_orani(k), 2))
    else:
        if bu_ekstre <= 0:
            return {"durum": "atlandi", "neden": "ekstre_yok"}
        asgari   = round(bu_ekstre * kart_asgari_orani(k), 2)
        odenecek = round(bu_ekstre, 2)

    # ── BU DÖNEMİN ÖDEME PENCERESİ: [kesim, sonraki_kesim) ───────────────────
    # 🔴 KÖK NEDEN (2026-08-14, Ziraat vakası — kanıtlı):
    # Pencere eskiden (kesim, son_odeme] idi ve İKİ UCU DA yanlıştı:
    #
    #  F1 — BAŞLANGIÇ STRICT'Tİ (`tarih > kesim`): Ziraat'in 182.275 ₺'lik
    #       ödemesi TAM KESİM GÜNÜNDE (2026-07-20) yapılmıştı → pencere DIŞI
    #       kaldı. Geriye 86.168 ₺ sayıldı, asgari 107.377 ₺'nin altında kaldı,
    #       plan ne "tam ödendi" ne "asgari ödendi" yoluna girdi — 268.443 ₺
    #       ekstre planı hiç kapanmadı ve aylarca gecikmiş göründü.
    #       Muhasebe gerçeği: ekstre kesim günü KESİLİR, ödeme kesildikten
    #       SONRA yapılır → kesim günü ödemesi YENİ döneme aittir.
    #
    #  ÇİFT SAYIM YOK: önceki dönemin penceresi de aynı kuralla
    #       [önceki_kesim, bu_kesim) olduğundan bu kesim günü oraya GİRMEZ
    #       (üst sınır strict). Her ödeme tam olarak bir döneme sayılır.
    #
    #  F2 — SON `son_odeme_tarihi` İDİ: son ödeme gününden SONRA yapılan GEÇ
    #       ödemeler hiçbir döneme sayılmıyordu (para çıkmış, plan açık kalmış).
    #       Üst sınır bir sonraki kesime çekildi: geç de olsa bu ekstreye
    #       yapılan ödeme bu planı kapatır.
    _sonraki_yil, _sonraki_ay = (yil + 1, 1) if ay == 12 else (yil, ay + 1)
    sonraki_kesim = kesim_tarihi_hesapla(_sonraki_yil, _sonraki_ay, kesim_gunu)
    cur.execute("""
        SELECT COALESCE(SUM(tutar), 0) AS odenen FROM kart_hareketleri
        WHERE kart_id=%s AND durum='aktif' AND islem_turu='ODEME'
          AND tarih >= %s::date AND tarih < %s::date
    """, (k["id"], bu_ay_kesim, sonraki_kesim))
    odenen_kesim = float(cur.fetchone()["odenen"])

    def _onay_reddet():
        # Plan ödendi/atlandı → bekleyen ODEME_PLANI onayını iptal et (çift kasa riski engeli)
        cur.execute("""
            UPDATE onay_kuyrugu SET durum='reddedildi'
            WHERE islem_turu='ODEME_PLANI' AND durum='bekliyor'
              AND kaynak_id IN (SELECT id FROM odeme_plani WHERE kart_id=%s
                  AND DATE_TRUNC('month', tarih)=DATE_TRUNC('month', %s::date))
        """, (k["id"], str(son_odeme_tarihi)))

    # Tam ödendiyse → plan 'odendi', onay reddet
    if odenen_kesim >= odenecek - 0.01:
        cur.execute("""
            UPDATE odeme_plani SET durum='odendi', odenen_tutar=%s,
                   odeme_tarihi=COALESCE(odeme_tarihi, CURRENT_DATE)
            WHERE kart_id=%s AND DATE_TRUNC('month', tarih)=DATE_TRUNC('month', %s::date)
              AND durum IN ('bekliyor','onay_bekliyor')
        """, (odenen_kesim, k["id"], str(son_odeme_tarihi)))
        _onay_reddet()
        return {"durum": "atlandi", "neden": "tam_odendi", "odenecek": odenecek}

    # Asgari ödendiyse → plan 'odendi' (kalan sonraki aya devreder), onay reddet
    # (asgari > 0 şartı: sahte-ödendi freni — 0 asgari ödemesiz kapanış üretemez)
    if asgari > 0 and odenen_kesim > 0 and odenen_kesim >= asgari * 0.999:
        cur.execute("""
            UPDATE odeme_plani SET durum='odendi', odenen_tutar=%s,
                   odeme_tarihi=COALESCE(odeme_tarihi, CURRENT_DATE),
                   aciklama=COALESCE(aciklama,'') || ' [ASGARİ ÖDENDİ — kalan ' ||
                            ROUND((%s - %s)::numeric, 2)::text || ' TL sonraki aya devretti]'
            WHERE kart_id=%s AND DATE_TRUNC('month', tarih)=DATE_TRUNC('month', %s::date)
              AND durum IN ('bekliyor','onay_bekliyor')
        """, (odenen_kesim, odenecek, odenen_kesim, k["id"], str(son_odeme_tarihi)))
        _onay_reddet()
        return {"durum": "atlandi", "neden": "asgari_odendi", "odenecek": odenecek}

    # ── TEK BORÇ KURALI (2026-07-23, sahip: 'ödemedim, iki borç görünüyor') ──
    # Devreden bakiye artık YENİ kesim ekstresinin içinde (kart_devreden_bakiye) →
    # ÖNCEKİ ayların bekleyen kart planları ayrı borç satırı olarak KALMAMALI.
    # Eski planı 'iptal' + not; bekleyen onayı reddet → panelde tek güncel borç görünür.
    cur.execute("""
        UPDATE onay_kuyrugu SET durum='reddedildi'
        WHERE islem_turu='ODEME_PLANI' AND durum='bekliyor'
          AND kaynak_id IN (SELECT id FROM odeme_plani WHERE kart_id=%s
              AND durum IN ('bekliyor','onay_bekliyor')
              AND DATE_TRUNC('month', tarih) < DATE_TRUNC('month', %s::date))
    """, (k["id"], str(son_odeme_tarihi)))
    cur.execute("""
        UPDATE odeme_plani
        SET durum='iptal',
            aciklama=COALESCE(aciklama,'') || ' [kalan ' || ROUND(GREATEST(odenecek_tutar - COALESCE(odenen_tutar,0),0)::numeric,2)::text ||
                     ' TL yeni ekstreye devretti — ' || %s || ']'
        WHERE kart_id=%s AND durum IN ('bekliyor','onay_bekliyor')
          AND DATE_TRUNC('month', tarih) < DATE_TRUNC('month', %s::date)
    """, (str(bu_ay_kesim), k["id"], str(son_odeme_tarihi)))

    # Aktif plan yaz/güncelle — TEK YAZICI (2026-08-08 mükerrer plan düzeltmesi)
    yeni = kart_plani_upsert(
        cur, k["id"], son_odeme_tarihi, odenecek, asgari,
        f"Kart ekstre: {k['kart_adi']} — {k.get('banka','')} (kesim {bu_ay_kesim})",
    )

    # onay_kuyrugu tutar senkronu (bekleyen ODEME_PLANI varsa kesim tutarına çek — çift kasa engeli)
    cur.execute("""
        UPDATE onay_kuyrugu SET tutar=%s
        WHERE islem_turu='ODEME_PLANI' AND durum='bekliyor'
          AND kaynak_id IN (SELECT id FROM odeme_plani WHERE kart_id=%s
              AND DATE_TRUNC('month', tarih)=DATE_TRUNC('month', %s::date)
              AND durum IN ('bekliyor','onay_bekliyor'))
    """, (odenecek, k["id"], str(son_odeme_tarihi)))
    return {"durum": ("uretildi" if yeni else "guncellendi"), "odenecek": odenecek, "asgari": asgari}


def kart_plan_guncelle_tx(cur) -> List[str]:
    """Kart ödeme planlarını KESİM EKSTRESİ bazlı günceller (tek-otorite: kart_kesim_plani_yaz_tx).

    FIX A4/K2 (2026-07-05): eskiden anlık TOPLAM borç (kart_borc) yazıyordu → gece motors'un
    kesim-ekstresi değeriyle çelişiyordu (aynı plan gün içi iki değere oynuyordu). Artık kesim
    ekstresi tek otorite; onay_kuyrugu senkronu (çift-kasa engeli) korundu.
    FOR UPDATE: iki eş zamanlı işlem aynı kart için çift plan oluşturmasın.
    """
    bugun = bugun_tr()
    yil, ay = bugun.year, bugun.month
    guncellenen: List[str] = []
    cur.execute("SELECT * FROM kartlar WHERE aktif=TRUE FOR UPDATE")
    kartlar = [dict(k) for k in cur.fetchall()]
    for k in kartlar:
        r = kart_kesim_plani_yaz_tx(cur, k, yil, ay)
        if r.get("durum") in ("uretildi", "guncellendi"):
            guncellenen.append(f"{k['kart_adi']}: {r['odenecek']:,.0f}₺")

    # ── F3: ÖKSÜZ PLAN ZİYARETİ (2026-08-14) ─────────────────────────────────
    # İkincil kök neden: bu fonksiyon yalnız BUGÜNÜN (yıl, ay) dönemini işliyordu.
    # Geçmiş bir dönemin planı bir kez açık kaldıysa (Ziraat'te olduğu gibi, hatalı
    # pencere yüzünden) bir daha HİÇ ziyaret edilmiyordu — pencere düzelse bile
    # eski satır sonsuza dek 'bekliyor' kalırdı. Artık geçmiş açık planlar kendi
    # DÖNEMLERİYLE yeniden değerlendirilir; düzeltilmiş pencere onları da kapatır.
    #
    # Sonsuz döngü/ağırlık freni: yalnız son 6 ay, dönem başına TEK çağrı.
    # ⚠️ ov_borc snapshot'ı zaten dönem eşleşmesine (DATE_TRUNC month) bakıyor →
    # geçmiş dönem çağrısında o dönemin snapshot'ı kullanılır, dokunulmadı.
    for k in kartlar:
        kesim_gunu_k = int(k["kesim_gunu"])
        son_odeme_gunu_k = int(k["son_odeme_gunu"] or 25)
        # Plan satırının `tarih`i SON ÖDEME tarihinin ta kendisidir (kart_plani_upsert
        # onu `sot` ile yazar) → ay değil TAM TARİH üzerinden eşleştiriyoruz.
        # aciklama da alınır: içindeki "(kesim YYYY-AA-GG)" damgası, çözülen
        # dönemin çapraz doğrulaması için kullanılır (aşağıya bkz.).
        cur.execute("""
            SELECT tarih, COALESCE(aciklama,'') AS aciklama
              FROM odeme_plani
             WHERE kart_id=%s AND durum IN ('bekliyor','onay_bekliyor')
               AND DATE_TRUNC('month', tarih) < DATE_TRUNC('month', CURRENT_DATE)
               AND tarih >= CURRENT_DATE - INTERVAL '6 months'
             ORDER BY tarih DESC
        """, (k["id"],))
        # Aynı tarihte birden çok satır olabilir → tarih başına TÜM açıklamalar
        # toplanır (hepsinin damgası kontrol edilir). En yeni 6 tarih yeter.
        _damga_map: dict = {}
        for _r in (cur.fetchall() or []):
            _damga_map.setdefault(_r["tarih"], []).append(_r["aciklama"])
        oksuzler = list(_damga_map.keys())[:6]
        for donem in oksuzler:
            # Plan satırının tarihi SON ÖDEME tarihidir, kesim tarihi değil —
            # kart_kesim_plani_yaz_tx ise KESİM dönemini (yil, ay) bekler. İkisi
            # çoğu kartta FARKLI aylardadır (kesim 20 Tem → son ödeme 10 Ağu).
            # Dönemi TAHMİN ETMEK yerine çözüyoruz: aday iki ayın (aynı ay ve bir
            # önceki ay) gerçek son-ödeme tarihini hesaplayıp planın ayına düşeni
            # seçiyoruz. Kaba kural (kesim_gunu > son_odeme_gunu) iş günü kayması
            # kesimin gününü değiştirdiğinde yanlış aya gidebiliyordu.
            # Aday dönemler: planın ayı ve ondan önceki İKİ ay. Neden iki?
            # son_odeme_gunu < kesim_gunu olan kartlarda son ödeme zaten sonraki
            # aya taşar; üstüne hafta sonu kayması onu ayın 1'ine atarsa kesim
            # dönemi plan ayından İKİ ay geride kalabiliyor (kesim 28 / son 27,
            # Şub 2027 vakası). Dar pencere o durumda yanlış döneme kilitleniyordu.
            adaylar = []
            _y, _m = donem.year, donem.month
            for _ in range(3):
                adaylar.append((_y, _m))
                _y, _m = (_y - 1, 12) if _m == 1 else (_y, _m - 1)
            uyan = []
            for _cy, _cm in adaylar:
                _kt = kesim_tarihi_hesapla(_cy, _cm, kesim_gunu_k)
                if son_odeme_tarihi_hesapla(_kt, son_odeme_gunu_k) == donem:
                    uyan.append((_cy, _cm))
            # TAM OLARAK BİR dönem uymalı. Sıfır uyarsa çözülemedi (kart ayarı
            # plan yazıldıktan sonra değişmiş olabilir); İKİSİ birden uyarsa kart
            # ayarı belirsizdir (kesim ile son ödeme günü bitişik olduğunda iki
            # ardışık ekstre aynı son-ödeme gününe düşebiliyor). Bu iki dönemin
            # ödeme PENCERESİ farklıdır — yanlışını seçmek planı hatalı kapatır.
            # Tahmin etmek yerine bu öksüz atlanır: onarım turunun zarar verme
            # hakkı yok, plan açık kalır ve sahip görmeye devam eder.
            if len(uyan) != 1:
                continue
            p_yil, p_ay = uyan[0]

            # ── KESİM DAMGASI ÇAPRAZ DOĞRULAMASI (Codex P1) ──────────────────
            # Yukarıdaki çözüm kartın BUGÜNKÜ kesim/son-ödeme ayarlarını kullanır.
            # Ayar plan yazıldıktan SONRA değiştiyse exact-date eşleşmesi tesadüfen
            # YANLIŞ-AMA-TEK bir döneme kilitlenebilir → plan yanlış pencereyle
            # hatalı kapanır. Plan yazıcısı açıklamaya "(kesim YYYY-AA-GG)" damgası
            # bastığı için gerçek kesim tarihi satırın kendisinde duruyor: damga
            # varsa çözülen dönemle karşılaştırılır, tutmuyorsa öksüz ATLANIR.
            # Damga yoksa (eski/elle yazılmış plan) mevcut davranış korunur.
            _beklenen_kesim = kesim_tarihi_hesapla(p_yil, p_ay, kesim_gunu_k)
            _damga_catisti = False
            for _ac in _damga_map.get(donem, []):
                _m = re.search(r"\(kesim (\d{4}-\d{2}-\d{2})\)", _ac or "")
                if _m and _m.group(1) != _beklenen_kesim.isoformat():
                    _damga_catisti = True
                    break
            if _damga_catisti:
                continue

            try:
                s = kart_kesim_plani_yaz_tx(cur, k, p_yil, p_ay)
            except Exception:  # noqa: BLE001
                continue      # tek kartın geçmişi bugünkü koşuyu düşürmesin
            if s.get("neden") in ("tam_odendi", "asgari_odendi"):
                guncellenen.append(
                    f"{k['kart_adi']}: {p_yil}-{p_ay:02d} öksüz planı kapandı ({s['neden']})")
    return guncellenen
