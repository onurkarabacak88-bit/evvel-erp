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
    "CIRO_IPTAL": False,       # Orijinal zaten 'iptal' yapılıyor — CIRO_IPTAL sadece audit kaydı
    "CIRO_DUZELTME": False,    # Orijinal zaten 'iptal' yapılıyor — CIRO_DUZELTME sadece audit kaydı
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

    # Bu kesim (kesim → son_odeme] arası ödemeler
    cur.execute("""
        SELECT COALESCE(SUM(tutar), 0) AS odenen FROM kart_hareketleri
        WHERE kart_id=%s AND durum='aktif' AND islem_turu='ODEME'
          AND tarih > %s::date AND tarih <= %s::date
    """, (k["id"], bu_ay_kesim, son_odeme_tarihi))
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

    # Aktif plan yaz (yoksa) veya güncelle (varsa)
    pid = str(uuid.uuid4())
    cur.execute("""
        INSERT INTO odeme_plani (id, kart_id, tarih, odenecek_tutar, asgari_tutar, aciklama, durum)
        SELECT %s, %s, %s, %s, %s, %s, 'bekliyor'
        WHERE NOT EXISTS (SELECT 1 FROM odeme_plani WHERE kart_id=%s
            AND DATE_TRUNC('month', tarih)=DATE_TRUNC('month', %s::date)
            AND (durum IN ('bekliyor','onay_bekliyor')
                 -- DÖNEM AYIRACI (2026-07-10): 'odendi' satır yalnız YENİ KESİMDEN
                 -- SONRAKİ ödemeyle kapandıysa bu dönemi temsil eder; kesim-öncesi
                 -- ödemeli 'odendi' ESKİ dönemin kapanışıdır, yeni planı BLOKE ETMEZ.
                 OR (durum='odendi' AND COALESCE(odeme_tarihi, tarih) >= %s::date)))
    """, (pid, k["id"], son_odeme_tarihi, odenecek, asgari,
          f"Kart ekstre: {k['kart_adi']} — {k.get('banka','')} (kesim {bu_ay_kesim})",
          k["id"], str(son_odeme_tarihi), str(bu_ay_kesim)))
    yeni = cur.rowcount > 0
    if not yeni:
        cur.execute("""
            UPDATE odeme_plani SET odenecek_tutar=%s, asgari_tutar=%s
            WHERE kart_id=%s AND DATE_TRUNC('month', tarih)=DATE_TRUNC('month', %s::date)
              AND durum IN ('bekliyor','onay_bekliyor')
        """, (odenecek, asgari, k["id"], str(son_odeme_tarihi)))

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
    for k in cur.fetchall():
        r = kart_kesim_plani_yaz_tx(cur, dict(k), yil, ay)
        if r.get("durum") in ("uretildi", "guncellendi"):
            guncellenen.append(f"{k['kart_adi']}: {r['odenecek']:,.0f}₺")
    return guncellenen
