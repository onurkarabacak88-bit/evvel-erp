# -*- coding: utf-8 -*-
"""
MAAŞ SERVİSİ — personel maaşının TEK MERKEZİ.

Daha önce main.py + motors.py arasında kopyalanan dört bilgi burada tek yerde yaşar:
  1. HESAP     : kanonik hesap (Vardiya Takip kurgusu) + manuel katman + yedek formül
  2. PLAN      : ödeme planı yazımı — hem aylık üretici (motors) hem ekran senkronu
                 AYNI fonksiyonu çağırır → çift plan / konvansiyon kayması imkânsızlaşır
  3. DÖNEM     : "referans_ay = ÖDEME AYI = çalışma ayı + 1" (arrears) kuralı tek fonksiyonda
  4. SABİTLER  : 285 saat/ay, 30 gün, TR ay adları

Kanonik hesap kararı (kullanıcı, 2026-07-04, b585911): bordronun otomatik kalemleri
Vardiya Takip'in hesabından gelir; maas_hesapla yalnızca yedek yoldur (takip çökerse).

Tüm fonksiyonlar çağıranın transaction'ındaki cursor ile çalışır (kendi bağlantı açmaz);
tek istisna vardiya_takip_hesap — gorev_api.vardiya_takip kendi bağlantısını açar (salt-okur).
"""

import calendar
import logging
import uuid
from datetime import date
from typing import Any, Dict, Optional, Tuple

import vardiya_v2 as _vv2

logger = logging.getLogger("maas_service")

# ── SABİTLER (tek kaynak) ──────────────────────────────────────
GUNLUK_SAAT = 9.5
AYLIK_GUN = 30                      # İş Kanunu standardı: izin günleri dahil 30 gün
AYLIK_SAAT = GUNLUK_SAAT * AYLIK_GUN  # 285

# Haftalık çalışma günü — atama YOKKEN kurulacak varsayımın iskeleti
# (sahip kararı 2026-08-08: "6 gün 9,5 saatten hesapla"). 7. gün haftalık
# izindir (İş Kanunu md.46); ilk sürüm her günü çalışma sayıyordu ve haftada
# bir günlük fazla hakediş üretiyordu.
HAFTALIK_CALISMA_GUN = 6

# Part-time günlük mesai — sahip kararı (2026-08-08): "partlar en fazla 5,5 saat
# çalışıyor; damgalama, part ise bu mantığı çalıştır." Yani part-time için bu bir
# VARSAYIM değil İŞLETME STANDARDIdır → kaynak etiketi 'part_standart' olur ve
# ekranda uyarı rozeti çıkmaz. (Tam zamanlı taban GUNLUK_SAAT = 9,5 olarak kalır.)
PART_GUNLUK_SAAT = 5.5

# Saatlik ücreti TANIMSIZ part-time personel için varsayılan (sahip kararı
# 2026-08-08: "girilmemişse de saatlik 99 TL olarak hesapla"). Kadrodaki mevcut
# part-time ücretleri 98,55–99,30 ₺ bandında; 99 ₺ bu bandın ortasıdır.
# Hakediş bu değerle hesaplandığında kayıt DAMGALANIR (ucret_varsayildi) ve
# ekran "varsayılan ücret" uyarısı gösterir — sessiz sayı üretilmez.
VARSAYILAN_SAATLIK_UCRET = 99.0

TR_AYLAR = ["", "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
            "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"]


# ── DÖNEM KURALLARI ────────────────────────────────────────────

def maas_odeme_tarihi(yil: int, ay: int) -> date:
    """ARREARS kuralı: (yil, ay) = ÇALIŞMA dönemi → ödeme, takip eden ayın 1'i.
    referans_ay konvansiyonu da bu tarihten türetilir (referans_ay = ödeme ayı)."""
    odeme_yil = yil + 1 if ay == 12 else yil
    odeme_ay = 1 if ay == 12 else ay + 1
    return date(odeme_yil, odeme_ay, 1)


def referans_to_donem(ref) -> tuple:
    """maas_odeme_tarihi'nin TERSİ: plan referans_ay'ı (ÖDEME ayı) → çalışma dönemi (yil, ay).
    Örn. referans 2026-07-01 → Haziran 2026 dönemi."""
    yil = ref.year - 1 if ref.month == 1 else ref.year
    ay = 12 if ref.month == 1 else ref.month - 1
    return yil, ay


def plan_aciklama(p: dict, yil: int, ay: int) -> str:
    """CFO panel / Yaklaşan Ödemeler'de hangi ayın maaşı olduğu okunsun diye dönem etiketi."""
    return f"Personel Maaş: {p.get('ad_soyad') or ''} — {TR_AYLAR[ay]} {yil} dönemi"


def personel_donem_orani(p: dict, yil: int, ay: int) -> Optional[float]:
    """Dönem içi çalışma oranı (0..1). Ay ortasında işe giren/ayrılan sürekli personel
    tam 30 gün değil, çalıştığı takvim günü oranında hakediş alır (kural 2026-07-03:
    'Dönem hakedişi aktiflikten bağımsızdır' — 10 günlük alacak silinmez, 20 günlük
    çalışana 30 gün yazılmaz). Dönemle hiç kesişmiyorsa None döner."""
    sgun = calendar.monthrange(yil, ay)[1]
    d1, d2 = date(yil, ay, 1), date(yil, ay, sgun)
    b, c = p.get('baslangic_tarihi'), p.get('cikis_tarihi')
    eff1 = max(d1, b) if b else d1
    eff2 = min(d2, c) if c else d2
    if eff1 > eff2:
        return None
    gun = (eff2 - eff1).days + 1
    return 1.0 if gun >= sgun else gun / sgun


# ── HESAP MOTORLARI ────────────────────────────────────────────

def vardiya_takip_hesap(pid, yil: int, ay: int) -> Optional[dict]:
    """TEK GERÇEK KAYNAK (kullanıcı kararı 2026-07-04): bordronun otomatik kalemleri
    Vardiya Takip'in hesabından gelir — iki ekran her zaman aynı rakamı söyler.
    Kurgu (takip ekseni): taban=(maaş/30)×geçen gün (başlangıç/çıkış kırpılmış),
    fazla mesai=GÜNLÜK bazlı (9.5 saat üstü planlanan)×saatlik, yemek=hak edilen
    fiilî gün×(aylık yemek/30), yol=(yol/30)×geçen gün; part-time=planlanan saat×saatlik.
    (gorev_api.vardiya_takip kendi bağlantısını açar; salt-okur, güvenli.)"""
    try:
        from gorev_api import vardiya_takip as _vt
        res = _vt(yil, ay, personel_id=str(pid))
        rows = (res or {}).get("personeller") or []
        return rows[0] if rows else None
    except Exception as e:
        logger.warning("vardiya takip hesap hatasi (%s %s-%s): %s", pid, yil, ay, e)
        return None


def sabit_mesai_saati(cur, p: dict, yil: int, ay: int) -> Tuple[float, str]:
    """SABİT TANIMLI MESAİ — vardiya ataması YOKKEN kullanılacak taban saat.

    SAHİP DOKTRİNİ (2026-08-07): "vardiya ataması da aynı, sadece TEYİT mantığında.
    İzinli gün girildiğinde, vardiya ataması yapılmışsa ilk oradan alınsın;
    yapılmamışsa SABİTTE TANIMLI MESAİ mantığıyla aktarım yapsın."

    Yani öncelik: (1) gerçek atama → (2) sabit tanım → (3) uyarı.
    Bu fonksiyon 2. basamaktır. İzinli günler HER İKİ yolda da düşülür.

    Neden gerekliydi: canlıda vardiya planı BOŞ (0 atama) ve part-time personelin
    `vardiya_max_weekly_hours` alanı NULL → planlanan saat 0 → part-time hakedişi
    (saat × saatlik ücret) **0 ₺** çıkıyordu. Aktif kadroda 2 part-time vardı ve
    ikisinin de bordrosu sıfırdı; kimse fark etmemişti çünkü sürekli personel
    maaş bazlı hesaplandığı için ekranda toplam makul görünüyordu.

    Döner: (saat, kaynak_etiketi)
    """
    sgun = calendar.monthrange(yil, ay)[1]
    d1, d2 = date(yil, ay, 1), date(yil, ay, sgun)
    b, c = p.get("baslangic_tarihi"), p.get("cikis_tarihi")
    eff1 = max(d1, b) if b else d1
    eff2 = min(d2, c) if c else d2
    # ⚠️ GÜN GÜN BİRİKİR (sahip düzeltmesi 2026-08-07): dönem SÜRÜYORSA hakediş
    # ayın tamamı üzerinden PEŞİN yazılmaz — bugüne kadar geçen gün sayılır ve
    # her gece senkronda bir gün daha eklenir. İlk sürüm ay sonunu taban alıyordu:
    # 8 Ağustos'ta part-time'a 31 günlük (29.155 ₺) hakediş çıkarıyordu; oysa
    # 23 gün henüz çalışılmamıştı. Geçmiş ayda tam ay doğrudur (dönem kapandı).
    # ⚠️ TZ TUZAĞI: sunucu UTC'de koşar, Türkiye UTC+3. `date.today()` gece
    # yarısından sonraki 3 saatte BİR GÜN GERİ gösterir — canlıda tam bu oldu:
    # 8 Ağustos'ta 7 günlük hakediş yazdı (66,5 sa). Takvim günü kararı hep
    # İstanbul saatinden alınır (kanonik: tr_saat.bugun_tr).
    from tr_saat import bugun_tr as _bugun_tr
    _bugun = _bugun_tr()
    if _bugun < d2:
        eff2 = min(eff2, _bugun)
    if eff1 > eff2:
        return 0.0, "donem_disi"
    donem_gun = (eff2 - eff1).days + 1

    # İzinli günler düşülür (gun_kesri: yarım gün izin 0.5)
    izin_gun = 0.0
    try:
        cur.execute(
            """SELECT COALESCE(SUM(
                   (LEAST(COALESCE(bitis_tarih, baslangic_tarih), %s)
                    - GREATEST(baslangic_tarih, %s) + 1) * COALESCE(gun_kesri, 1.0)
               ), 0)::float AS g
               FROM personel_izin
               WHERE personel_id = %s
                 AND baslangic_tarih <= %s
                 AND COALESCE(bitis_tarih, baslangic_tarih) >= %s""",
            (eff2, eff1, p["id"], eff2, eff1),
        )
        izin_gun = max(0.0, float((cur.fetchone() or {}).get("g") or 0))
    except Exception as e:  # noqa: BLE001
        logger.warning("sabit mesai izin okunamadi (%s): %s", p.get("ad_soyad"), e)

    calisilan_gun = max(0.0, donem_gun - izin_gun)

    # Haftalık tanım varsa onu kullan; yoksa tam gün standardına düş (damgalı).
    haftalik = p.get("vardiya_max_weekly_hours")
    try:
        haftalik = float(haftalik) if haftalik is not None else None
    except (TypeError, ValueError):
        haftalik = None

    if haftalik and haftalik > 0:
        return round(calisilan_gun * (haftalik / 7.0), 2), "sabit_tanim_haftalik"
    # Tanım yoksa: HAFTADA 6 GÜN × 9,5 saat (7. gün haftalık izin — İş Kanunu md.46).
    # Takvim günü sayısı 6/7 ile ölçeklenir; ilk sürüm her takvim gününü çalışma
    # sayıyordu ve haftada bir günlük FAZLA hakediş üretiyordu (8 günde 76 sa
    # yerine doğrusu ~65 sa). VARSAYIM olduğu için etiketi ayrı — ekran bunu
    # "sabit mesai tanımlı değil" uyarısıyla gösterir.
    _calisma_gun = calisilan_gun * (HAFTALIK_CALISMA_GUN / 7.0)
    # Part-time'ın günlük mesaisi işletme standardıdır (5,5 sa) — tahmin değil,
    # bu yüzden UYARI DAMGASI BASILMAZ. Tam zamanlıda taban 9,5 sa ve o hâlâ
    # varsayımdır (atama da tanım da yokken kurulmuş bir iskelet).
    if (p.get("calisma_turu") or "surekli") != "surekli":
        return round(_calisma_gun * PART_GUNLUK_SAAT, 2), "part_standart"
    return round(_calisma_gun * GUNLUK_SAAT, 2), "varsayilan_gunluk"


def kanonik_net(p: dict, vt: dict, kayit: dict) -> float:
    """Bordro neti = Vardiya Takip net_hakedişi (otomatik kalemler) + MANUEL katman:
    bayram mesaisi ×2 (takipte yok) − eksik gün/rapor kesintisi (günlük ücret) + manuel düzeltme."""
    if (p.get("calisma_turu") or "surekli") == "surekli":
        maas = float(p.get("maas") or 0)
        saatlik = maas / AYLIK_SAAT
        gunluk = maas / AYLIK_GUN
    else:
        saatlik = float(p.get("saatlik_ucret") or 0)
        gunluk = saatlik * GUNLUK_SAAT
    net = float(vt.get("net_hakediş") or 0)
    net += float(kayit.get("bayram_mesai_saat") or 0) * saatlik * 2
    kesinti_gun = float(kayit.get("eksik_gun") or 0) + (
        float(kayit.get("raporlu_gun") or 0) if kayit.get("rapor_kesinti") else 0)
    net -= gunluk * kesinti_gun
    net += float(kayit.get("manuel_duzeltme") or 0)
    return round(max(0.0, net), 2)


def maas_hesapla(p: dict, kayit: dict, yil: int = None, ay: int = None) -> float:
    """YEDEK YOL (kanonik hesap alınamazsa sistem durmasın diye). Kanonik = Vardiya Takip.

    SÜREKLİ:
      - Günlük standart: 9.5 saat, aylık 30 gün (izin günleri dahil, İş Kanunu standardı)
      - Saatlik ücret = maaş / 285; fazla mesai ×1, bayram ×2
      - Eksik gün kesintisi: (maaş / 30) × eksik_gün
      - DÖNEM PRO-RATA: yil/ay verildiyse maaş+yemek+yol tabanı çalışılan gün oranında
        (mesai ve eksik-gün birim ücretleri TAM maaştan)
    PART-TIME:
      - Ay boyunca TOPLAM saat × saatlik ücret; fazla mesai kavramı YOK; yemek yok, yol var.
    """
    yol = float(p.get('yol_ucreti') or 0)
    manuel = float(kayit.get('manuel_duzeltme') or 0)
    eksik = float(kayit.get('eksik_gun') or 0)
    raporlu = float(kayit.get('raporlu_gun') or 0)
    fazla_normal = float(kayit.get('fazla_mesai_saat') or 0)
    fazla_bayram = float(kayit.get('bayram_mesai_saat') or 0)
    rapor_kesinti = kayit.get('rapor_kesinti', False)

    if p.get('calisma_turu') == 'surekli':
        maas = float(p.get('maas') or 0)
        yemek = float(p.get('yemek_ucreti') or 0)
        saatlik = maas / AYLIK_SAAT if AYLIK_SAAT > 0 else 0
        gunluk = maas / AYLIK_GUN if AYLIK_GUN > 0 else 0

        oran = 1.0
        if yil and ay:
            _o = personel_donem_orani(p, yil, ay)
            if _o is None:
                return 0.0  # dönemle kesişmiyor (dönemden önce ayrıldı / sonra başlayacak)
            oran = _o

        kesinti_gun = eksik + (raporlu if rapor_kesinti else 0)
        kesinti = gunluk * kesinti_gun  # günlük ücret × eksik gün (İş Kanunu)

        fazla_ucret = (fazla_normal * saatlik) + (fazla_bayram * saatlik * 2)
        net = (maas * oran) - kesinti + fazla_ucret + (yemek * oran) + (yol * oran) + manuel
    else:
        saatlik = float(p.get('saatlik_ucret') or 0)
        saat = float(kayit.get('calisma_saati') or 0)
        net = (saat * saatlik) + yol + manuel

    return round(max(0, net), 2)


def vardiya_kayit_dict(cur, p: dict, yil: int, ay: int, mevcut: Optional[dict] = None) -> dict:
    """Yedek yolun veri kaynağı: vardiya_v2'den saat/ek mesai çekip kayıt sözlüğü kurar."""
    mevcut = dict(mevcut or {})
    vk = _vv2.personel_ay_vardiya_maas_kaynagi(cur, p["id"], yil, ay)
    calisma = float(mevcut.get("calisma_saati") or 0)
    fazla = float(mevcut.get("fazla_mesai_saat") or 0)

    if (p.get("calisma_turu") or "surekli") == "surekli":
        fazla = float(vk.get("ek_mesai_haftalik_toplam") or 0)
    else:
        calisma = float(vk.get("toplam_ay_saat") or 0)

    return {
        "calisma_saati": calisma,
        "fazla_mesai_saat": fazla,
        "bayram_mesai_saat": float(mevcut.get("bayram_mesai_saat") or 0),
        "eksik_gun": float(mevcut.get("eksik_gun") or 0),
        "raporlu_gun": float(mevcut.get("raporlu_gun") or 0),
        "rapor_kesinti": bool(mevcut.get("rapor_kesinti") or False),
        "manuel_duzeltme": float(mevcut.get("manuel_duzeltme") or 0),
        "not_aciklama": mevcut.get("not_aciklama"),
        "_vardiya": vk,
    }


# ── AVANS MAHSUBU (avans_service'ten SADECE OKUR — mimari sınır) ──

def avans_mahsup_uygula(cur, p: dict, yil: int, ay: int, brut_net: float) -> tuple:
    """Dönemin ödenmiş avanslarını + önceki dönem devrini brüt netten düşer.
    KURAL (kullanıcı+GPT, 2026-07-04): negatif maaş ENGELLENİR; karşılanamayan
    mahsup 'mahsup_devir' olarak sonraki döneme yazılır. Maaş motoru avansı
    yalnızca OKUR — kasa hareketi üretme yetkisi avans_service'tedir.
    Dönüş: (net, avans_mahsup, mahsup_devir)."""
    try:
        import avans_service as _av  # lazy: döngüsel import kırıcı (avans → maas tek yön top-level)
        istek = _av.onceki_devir(cur, p["id"], yil, ay) + _av.donem_odenen_avans(cur, p["id"], yil, ay)
    except Exception as e:
        logger.warning("avans mahsubu okunamadi (%s %s-%s): %s", p.get("id"), yil, ay, e)
        return brut_net, 0.0, 0.0
    if istek <= 0:
        return brut_net, 0.0, 0.0
    mahsup = round(min(istek, max(0.0, brut_net)), 2)
    devir = round(istek - mahsup, 2)
    return round(brut_net - mahsup, 2), mahsup, devir


# ── TEK PLAN YAZICI ────────────────────────────────────────────

def odeme_plani_esitle(cur, p: dict, yil: int, ay: int, net: float,
                       guncelle: bool = True) -> Optional[Dict[str, Any]]:
    """Personelin (yil, ay) ÇALIŞMA dönemi maaş ödeme planını tek noktadan yazar.

    - guncelle=True  (ekran senkronu): bekleyen plan varsa tutar/tarih/açıklama GÜNCELLENİR,
      yoksa oluşturulur.
    - guncelle=False (aylık üretici / motors): plan varsa DOKUNULMAZ (kanonik senkron
      rakamı ezilmesin), yoksa oluşturulur.

    referans_ay/tarih/açıklama HEP buradan üretilir → iki yazıcının konvansiyon
    kayması (çift plan üretimi) yapısal olarak kapanır.
    Dönüş: {"id": plan_id, "yeni": bool} veya None (net<=0 ya da plan zaten var/insert edilmedi).
    """
    if net <= 0:
        # FIX AV5 (2026-07-06): net 0'a düştüyse (örn. maaşın tamamı avans mahsubuyla karşılandı)
        # bekleyen ESKİ plan güncellenmeden kalıyordu → panelde hayalet "ödenecek maaş".
        # Ekran senkronu modunda bekleyen plan iptal edilir (append-only: silinmez, durum='iptal')
        # + bağlı bekleyen onaylar da kapatılır (MN10 yetim-onay dersi).
        if guncelle:
            _ot = maas_odeme_tarihi(yil, ay)
            cur.execute(
                """
                UPDATE odeme_plani
                SET durum='iptal',
                    aciklama = COALESCE(aciklama,'') || ' · iptal: net 0 (avans mahsubu)'
                WHERE kaynak_tablo='personel' AND kaynak_id=%s
                  AND durum IN ('bekliyor','onay_bekliyor')
                  AND referans_ay = DATE_TRUNC('month', %s::date)
                RETURNING id
                """,
                (p["id"], str(_ot)),
            )
            _iptal_ids = [str(r["id"]) for r in (cur.fetchall() or [])]
            if _iptal_ids:
                cur.execute(
                    """
                    UPDATE onay_kuyrugu SET durum='reddedildi', onay_tarihi=NOW()
                    WHERE durum NOT IN ('onaylandi','reddedildi') AND kaynak_id = ANY(%s)
                    """,
                    (_iptal_ids,),
                )
        return None

    odeme_tarihi = maas_odeme_tarihi(yil, ay)
    aciklama = plan_aciklama(p, yil, ay)

    if guncelle:
        cur.execute(
            """
            UPDATE odeme_plani
            SET tarih=%s, referans_ay=DATE_TRUNC('month', %s::date),
                odenecek_tutar=%s, asgari_tutar=%s, aciklama=%s
            WHERE kaynak_tablo='personel' AND kaynak_id=%s
              AND durum IN ('bekliyor','onay_bekliyor')
              AND referans_ay = DATE_TRUNC('month', %s::date)
            RETURNING id
            """,
            (odeme_tarihi, str(odeme_tarihi), net, net, aciklama, p["id"], str(odeme_tarihi)),
        )
        row = cur.fetchone()
        if row:
            return {"id": row["id"], "yeni": False}

    pid = str(uuid.uuid4())
    cur.execute(
        """
        INSERT INTO odeme_plani
            (id, kart_id, tarih, referans_ay, odenecek_tutar, asgari_tutar,
             aciklama, durum, kaynak_tablo, kaynak_id)
        SELECT %s, NULL, %s, DATE_TRUNC('month', %s::date), %s, %s,
               %s, 'bekliyor', 'personel', %s
        WHERE NOT EXISTS (
            SELECT 1 FROM odeme_plani
            WHERE kaynak_tablo='personel' AND kaynak_id=%s
              AND durum != 'iptal'
              AND referans_ay = DATE_TRUNC('month', %s::date)
        )
        RETURNING id
        """,
        (
            pid,
            odeme_tarihi,
            str(odeme_tarihi),
            net,
            net,
            aciklama,
            p["id"],
            p["id"],
            str(odeme_tarihi),
        ),
    )
    row = cur.fetchone()
    if row:
        return {"id": row["id"], "yeni": True}
    return None


# ── SENKRON (kayıt + plan birlikte) ────────────────────────────

def aylik_vardiya_senkronize(cur, p: dict, yil: int, ay: int) -> dict:
    """Personelin (yil, ay) dönemini vardiyadan hesaplayıp personel_aylik kaydını ve
    ödeme planını eşitler. Onaylı kayıt EZİLMEZ (sadece planı tazeler)."""
    cur.execute(
        "SELECT * FROM personel_aylik WHERE personel_id=%s AND yil=%s AND ay=%s",
        (p["id"], yil, ay),
    )
    mevcut = cur.fetchone()
    if mevcut and mevcut.get("durum") == "onaylandi":
        net = float(mevcut.get("hesaplanan_net") or 0)
        odeme_plani_esitle(cur, p, yil, ay, net)
        return {"atlandi": True, "neden": "onaylandi", "hesaplanan_net": net}
    # Dönemle hiç kesişmeyen personele (dönemden önce ayrıldı / sonra başlayacak) kayıt açma
    if personel_donem_orani(p, yil, ay) is None:
        return {"atlandi": True, "neden": "donem_disi", "hesaplanan_net": 0}

    # KANONİK HESAP = Vardiya Takip kurgusu (kullanıcı kararı 2026-07-04); manuel alanlar korunur
    vt = vardiya_takip_hesap(p["id"], yil, ay)
    mev = dict(mevcut or {})
    # ── SABİT MESAİ FALLBACK (sahip doktrini 2026-08-07) ───────────────────────
    # Vardiya ataması TEYİT katmanıdır: varsa gerçek plan oradan okunur; YOKSA
    # sabit tanımlı mesaiden aktarılır. Yalnız PART-TIME için devreye girer —
    # sürekli personelin tabanı zaten maaş bazlıdır (maaş/30 × geçen gün), atama
    # olmasa da doğru hesaplanır. Part-time'da ise hakediş = saat × saatlik ücret
    # olduğu için atama yokken sonuç 0 ₺ çıkıyordu (canlı: 2 aktif part-time).
    _sabit_kaynak = None
    if vt is not None:
        _is_part = (p.get("calisma_turu") or "surekli") != "surekli"
        _planlanan = float(vt.get("toplam_planlanan_saat") or 0)
        if _is_part and _planlanan <= 0:
            _saat, _sabit_kaynak = sabit_mesai_saati(cur, dict(p), yil, ay)
            if _saat > 0:
                _saatlik = float(p.get("saatlik_ucret") or 0)
                if _saatlik <= 0:
                    # Ücret de tanımsız → sahip kararı: 99 ₺/saat varsay, DAMGALA.
                    _saatlik = VARSAYILAN_SAATLIK_UCRET
                    _sabit_kaynak = f"{_sabit_kaynak}+varsayilan_ucret"
                vt = dict(vt)
                vt["toplam_planlanan_saat"] = _saat
                # Part-time hakedişi: saat × saatlik + yol payı (yemek/fazla mesai YOK —
                # vardiya_takip kurgusuyla aynı; bkz. vardiya_takip_hesap açıklaması).
                vt["net_hakediş"] = round(_saat * _saatlik, 2) + float(vt.get("yol_ucreti") or 0)
                vt["hesap_kaynagi"] = _sabit_kaynak
    if vt is not None:
        kayit = {
            "calisma_saati": float(vt.get("toplam_planlanan_saat") or 0),
            "fazla_mesai_saat": float(vt.get("toplam_fazla_mesai_saat") or 0),
            "bayram_mesai_saat": float(mev.get("bayram_mesai_saat") or 0),
            "eksik_gun": float(mev.get("eksik_gun") or 0),
            "raporlu_gun": float(mev.get("raporlu_gun") or 0),
            "rapor_kesinti": bool(mev.get("rapor_kesinti") or False),
            "manuel_duzeltme": float(mev.get("manuel_duzeltme") or 0),
            "not_aciklama": mev.get("not_aciklama"),
        }
        net = kanonik_net(dict(p), vt, kayit)
        # Kaynak damgası: saat gerçek atamadan mı, sabit tanımdan mı geldi?
        # Ekran bunu göstermeli — "bu rakam nereden çıktı" cevapsız kalmasın.
        vk = {"kaynak": _sabit_kaynak or "vardiya_takip",
              "toplam_planlanan_saat": kayit["calisma_saati"],
              "fazla_mesai_saat": kayit["fazla_mesai_saat"]}
    else:
        # savunma: takip hesabı alınamazsa eski yerel formüle düş (sistem durmaz)
        kayit = vardiya_kayit_dict(cur, p, yil, ay, mevcut)
        vk = kayit.pop("_vardiya", {})
        net = maas_hesapla(dict(p), kayit, yil, ay)
    # Avans mahsubu — dönemin ödenmiş avansları + önceki devir netten düşer
    net, avans_mahsup, mahsup_devir = avans_mahsup_uygula(cur, dict(p), yil, ay, net)
    kid = str(uuid.uuid4())
    cur.execute(
        """
        INSERT INTO personel_aylik
            (id, personel_id, yil, ay, calisma_saati, fazla_mesai_saat, bayram_mesai_saat,
             eksik_gun, raporlu_gun, rapor_kesinti, manuel_duzeltme,
             not_aciklama, hesaplanan_net, avans_mahsup, mahsup_devir, durum)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'taslak')
        ON CONFLICT (personel_id, yil, ay) DO UPDATE SET
            calisma_saati=%s, fazla_mesai_saat=%s, bayram_mesai_saat=%s,
            eksik_gun=%s, raporlu_gun=%s, rapor_kesinti=%s, manuel_duzeltme=%s,
            not_aciklama=%s, hesaplanan_net=%s, avans_mahsup=%s, mahsup_devir=%s, durum='taslak'
        """,
        (
            kid,
            p["id"],
            yil,
            ay,
            kayit["calisma_saati"],
            kayit["fazla_mesai_saat"],
            kayit["bayram_mesai_saat"],
            kayit["eksik_gun"],
            kayit["raporlu_gun"],
            kayit["rapor_kesinti"],
            kayit["manuel_duzeltme"],
            kayit["not_aciklama"],
            net,
            avans_mahsup,
            mahsup_devir,
            kayit["calisma_saati"],
            kayit["fazla_mesai_saat"],
            kayit["bayram_mesai_saat"],
            kayit["eksik_gun"],
            kayit["raporlu_gun"],
            kayit["rapor_kesinti"],
            kayit["manuel_duzeltme"],
            kayit["not_aciklama"],
            net,
            avans_mahsup,
            mahsup_devir,
        ),
    )
    plan = odeme_plani_esitle(cur, p, yil, ay, net)
    return {"atlandi": False, "hesaplanan_net": net, "vardiya": vk,
            "plan_id": (plan or {}).get("id")}


# ── ANOMALİ TARAMASI — "istisnaya göre onay" (approval by exception) ──────────
#
# NEDEN: bordro akışı taslak → onaylandi → ödeme. Onay İNSAN kararıdır ve
# ödeme guard'ı onaysız kaydı geçirmez. Ama onay TEK TEK yapılıyordu; canlıda
# Temmuz 2026'da 11 kayıttan 10'u taslakta kaldı ve 228.622,82 ₺ maaş 9 gün
# ödenemedi. Kimse hata yapmadı — süreç insanı 11 ayrı tıklamaya zorluyordu.
#
# DÜNYA PRATİĞİ (Codex ikinci görüşü, 2026-08-10): büyük bordro sistemleri her
# kaydı insana sormaz; kaydı ÖNCE tarar, yalnızca ANOMALİLİ olanı önüne koyar
# ("approval by exception"), gerisini toplu onaya açar. Sahip kararı elinden
# alınmaz — sahip TEMİZ yığını tek tuşla onaylar, şüpheliyi tek tek görür.
#
# BURADA: hesabı DEĞİŞTİRMİYORUZ. kanonik_net tek gerçek olarak kalır. Bu katman
# yalnızca "bu rakam gözle kontrol ister mi?" sorusunu yanıtlar → ÖNERİ-ONLY.

# Geçen döneme göre kabul edilen sapma bandı. Üstü "neden değişti?" sorusudur.
SAPMA_BANDI = 0.25


def bordro_anomali_kurallari(p: dict, kayit: dict, onceki_net: Optional[float],
                             yil: int, ay: int) -> list:
    """Tek kaydın anomali listesi. Boş liste = TEMİZ (toplu onaya uygun).

    Seviye 'kritik' → rakamın kendisi şüpheli (ödeme yanlış çıkabilir).
    Seviye 'incele' → rakam makul ama gözle teyit ister (elle müdahale, sapma).
    """
    bulgular = []
    net = float(kayit.get("hesaplanan_net") or 0)
    saat = float(kayit.get("calisma_saati") or 0)
    part = (p.get("calisma_turu") or "surekli") != "surekli"

    # 1) Sıfır/negatif net — bordroda bu bir HESAP SONUCU değil, veri alarmıdır.
    if net <= 0:
        bulgular.append({"kod": "net_sifir", "seviye": "kritik",
                         "mesaj": "Net hakediş 0 ₺ — hesabın dayanağı eksik"})

    # 2) Part-time'da saat yoksa hakedişin temeli yok (sürekli personelin tabanı
    #    maaş bazlıdır, atama olmasa da doğru hesaplanır — onu kritik saymayız).
    if part and saat <= 0:
        bulgular.append({"kod": "saat_yok", "seviye": "kritik",
                         "mesaj": "Part-time personelde çalışma saati 0 — vardiya/sabit mesai tanımı yok"})

    # 3) Sürekli personelde maaş tanımsızsa hesap havada kalır.
    if not part and float(p.get("maas") or 0) <= 0:
        bulgular.append({"kod": "maas_tanimsiz", "seviye": "kritik",
                         "mesaj": "Sürekli personelin aylık maaşı tanımsız"})

    # 4) Varsayılan saatlik ücret damgası (99 ₺) — sessiz sayı üretilmesin.
    if part and float(p.get("saatlik_ucret") or 0) <= 0:
        bulgular.append({"kod": "ucret_varsayildi", "seviye": "incele",
                         "mesaj": f"Saatlik ücret tanımsız — {VARSAYILAN_SAATLIK_UCRET:.0f} ₺ varsayıldı"})

    # 5) Geçen döneme göre sapma — "neden bu ay farklı?" sorusu.
    #    AMA: iki dönemden biri KISMİ ise (işe giriş/çıkış ayı) sapmanın sebebi
    #    zaten bellidir; bunu anomali saymak gürültüdür. Canlı kalibrasyon
    #    (2026-08-10): sistem yeni olduğu için kadronun çoğu Temmuz'da başlamış;
    #    ham kural 8 kişiden 7'sini incelemeye düşürüyordu → sahip 10 tıklamadan
    #    8 tıklamaya inerdi, kazanç yok. Kıyas ancak iki taraf da TAM dönemse anlamlı.
    _bu_oran = personel_donem_orani(p, yil, ay)
    _ony, _ona = (yil - 1, 12) if ay == 1 else (yil, ay - 1)
    _onceki_oran = personel_donem_orani(p, _ony, _ona)
    #    Ayrıca dönem HENÜZ BİTMEDİYSE kıyas anlamsızdır: 10 Ağustos'ta Ağustos
    #    hakedişi doğal olarak Temmuz'un üçte biridir. Canlıda 3 kişi bu yüzden
    #    "%72 azaldı" diye incelemeye düşüyordu — ay kapanmadan sapma ölçülmez.
    _son_gun = calendar.monthrange(yil, ay)[1]
    _donem_kapandi = date(yil, ay, _son_gun) < date.today()
    _kiyas_saglam = (_bu_oran == 1.0) and (_onceki_oran == 1.0) and _donem_kapandi
    if onceki_net and onceki_net > 0 and net > 0 and _kiyas_saglam:
        oran = abs(net - onceki_net) / onceki_net
        if oran > SAPMA_BANDI:
            yon = "arttı" if net > onceki_net else "azaldı"
            bulgular.append({"kod": "sapma", "seviye": "incele",
                             "mesaj": f"Geçen döneme göre %{oran*100:.0f} {yon} "
                                      f"({onceki_net:,.0f} ₺ → {net:,.0f} ₺)".replace(",", ".")})

    # 6) Elle müdahale — insan dokunduysa insan teyit etsin.
    if abs(float(kayit.get("manuel_duzeltme") or 0)) > 0:
        bulgular.append({"kod": "elle_duzeltme", "seviye": "incele",
                         "mesaj": f"Manuel düzeltme uygulanmış: {float(kayit['manuel_duzeltme']):,.2f} ₺".replace(",", ".")})
    if float(kayit.get("eksik_gun") or 0) > 0:
        bulgular.append({"kod": "eksik_gun", "seviye": "incele",
                         "mesaj": f"{float(kayit['eksik_gun']):g} gün eksik gün kesintisi var"})

    # 7) Kısmi dönem (işe giriş/çıkış bu aya denk geldi) — BİLGİ, anomali DEĞİL.
    #    Pro-rata zaten hesaba giriyor; tutar doğru. Sahip rakamı okurken "neden
    #    düşük?" sorusunun cevabı ekranda dursun diye taşınır ama onayı bekletmez.
    if _bu_oran is not None and _bu_oran < 1.0:
        bulgular.append({"kod": "kismi_donem", "seviye": "bilgi",
                         "mesaj": f"Kısmi dönem — ayın %{_bu_oran*100:.0f}'i çalışıldı (giriş/çıkış)"})

    return bulgular


def _onay_bekletir(bulgular: list) -> bool:
    """Onayı bekleten bulgu var mı? 'bilgi' seviyesi bekletmez (yalnız açıklar)."""
    return any(b.get("seviye") in ("kritik", "incele") for b in bulgular)


def bordro_anomali_tara(cur, yil: int, ay: int) -> dict:
    """(yil, ay) döneminin bordro kayıtlarını tarar, TEMİZ / İNCELE ayrımını üretir.

    Salt-okur: hiçbir kaydı değiştirmez, onaylamaz. Yalnızca sınıflandırır.
    """
    oy, oa = (yil - 1, 12) if ay == 1 else (yil, ay - 1)
    cur.execute(
        """
        SELECT pa.*, p.ad_soyad, p.calisma_turu, p.maas, p.saatlik_ucret,
               p.baslangic_tarihi, p.cikis_tarihi, p.sube_id,
               (SELECT o.hesaplanan_net FROM personel_aylik o
                 WHERE o.personel_id = pa.personel_id AND o.yil=%s AND o.ay=%s) AS onceki_net
          FROM personel_aylik pa
          JOIN personel p ON p.id = pa.personel_id
         WHERE pa.yil=%s AND pa.ay=%s
         ORDER BY p.ad_soyad
        """,
        (oy, oa, yil, ay),
    )
    satirlar = cur.fetchall() or []

    temiz, incele, onayli = [], [], []
    for r in satirlar:
        k = dict(r)
        net = float(k.get("hesaplanan_net") or 0)
        kayit = {
            "personel_id": k["personel_id"],
            "ad_soyad": k.get("ad_soyad"),
            "sube_id": k.get("sube_id"),
            "calisma_turu": k.get("calisma_turu"),
            "hesaplanan_net": net,
            "calisma_saati": float(k.get("calisma_saati") or 0),
            "manuel_duzeltme": float(k.get("manuel_duzeltme") or 0),
            "eksik_gun": float(k.get("eksik_gun") or 0),
            "avans_mahsup": float(k.get("avans_mahsup") or 0),
            "durum": k.get("durum") or "taslak",
        }
        if kayit["durum"] == "onaylandi":
            kayit["anomaliler"] = []
            kayit["sinif"] = "onayli"
            onayli.append(kayit)
            continue
        bulgular = bordro_anomali_kurallari(
            k, kayit, float(k["onceki_net"]) if k.get("onceki_net") is not None else None, yil, ay
        )
        kayit["anomaliler"] = bulgular
        bekletir = _onay_bekletir(bulgular)
        kayit["sinif"] = "incele" if bekletir else "temiz"
        (incele if bekletir else temiz).append(kayit)

    def _top(lst):
        return round(sum(x["hesaplanan_net"] for x in lst), 2)

    return {
        "yil": yil, "ay": ay, "donem": f"{TR_AYLAR[ay]} {yil}",
        "odeme_tarihi": maas_odeme_tarihi(yil, ay).isoformat(),
        "temiz": temiz, "incele": incele, "onayli": onayli,
        "ozet": {
            "toplam_kayit": len(satirlar),
            "temiz_adet": len(temiz), "temiz_tutar": _top(temiz),
            "incele_adet": len(incele), "incele_tutar": _top(incele),
            "onayli_adet": len(onayli), "onayli_tutar": _top(onayli),
            "bekleyen_adet": len(temiz) + len(incele),
            "bekleyen_tutar": round(_top(temiz) + _top(incele), 2),
        },
    }
