"""👥 EVVEL YENİ · MAAŞLAR (2026-10-16) — kişi × ÇALIŞMA AYI: hak ediş − avans − ödenen = kalan.

Ortak karar (sahip + Codex + Claude):
  · TEK hesap, TEK ekran. Satır = kişi × çalışma ayı (ödeme ayı DEĞİL: Ekim maaşı Kasım'da ödenir, ait_ay=Ekim).
  · Tam zamanlı: taban = maaş/30 × geçen gün (tam ay 30; ay ortası giriş/çıkışta takvim günü, en çok 30)
                 mesai = mesai saati × maaş/(30 × 9,5) · bayram = saat × maaş/285 × 2 · yol = yol/30 × gün
                 − (eksik gün [+ raporlu gün, kesinti seçiliyse]) × maaş/30 · ± gerekçeli düzeltme
  · Yarı zamanlı: saat × saatlik ücret (+ bayram ×2). Eksik gün kesintisi YOK. Saatlik ücret yoksa "ücret tanımsız" —
    99 ₺ varsayımı YOK (Codex).
  · Yemek (sahip: Kasım'dan): aylık sabit yemek × geçen gün/30 — mola kontrolü ücretten ayrı.
  · Gün/mesai/saat ÖNERİSİ şube panelinin vardiya planından (eski gorev_api.vardiya_takip; panel taşınana kadar);
    elle girilen değer öneriyi ezer.
  · Avans: o ayın avansı + önceki aydan devreden → hak ediş kadar MAHSUP; karşılanamayan ertesi aya DEVİR.
    Şubenin elden verdiği avans da (anlik_giderler → Kasa) kişinin avansı sayılır.
  · GİDER hak edişten (çalışma ayına) BİR KEZ yazılır; maaş/avans ödemeleri yalnız kasadan düşer.
  · EKİM (geçiş): eski sistemin hesabıyla kapanır (personel_aylik: hesaplanan_net avans düşülmüş + avans_mahsup).
"""

import json
import logging
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Optional

from evvel_yeni_cekirdek import TrTutar   # para alanı: Türkçe tutar kuralı (TEK yer)
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from evvel_yeni_cekirdek import kurus_yuvarla as _kurus_yuvarla, tl_sayi as _tl_sayi
from database import db, savepoint

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/evvel-yeni/maas", tags=["evvel-yeni-maas"])

AY_GUN = 30
GUNLUK_SAAT = Decimal("9.5")
BAYRAM_KAT = 2
def _yeni_hesap(cur) -> str:
    """Yeni maaş hesabının ilk ayı = panel_baslangic'ın ayı (tekrar denetimi "dört ayrı başlangıç": sabit "2026-11" ayardan kopuktu).
    Öncesi (Ekim) eski sistemin hesabıyla."""
    from evvel_yeni_cekirdek import panel_baslangic
    return panel_baslangic(cur).strftime("%Y-%m")
KAPALI_SON_AY = "2026-09"            # Sahip (2026-10-16): "Eylül'ü Eylül sonu/Ekim başı ödüyoruz" → Evvel Yeni
                                     # (1 Ekim) öncesi çalışma ayları ÖDENMİŞ ve KAPANMIŞ sayılır
ODENEN_KALEMLER = ("Maaş", "Yemek ücreti", "Prim")   # SGK/vergi kişinin bakiyesini kapatmaz
_HAZIR = False


def _kurus(x) -> int:
    """Hesaplanan / eski tablodan gelen tutar → kuruş (yuvarlayarak) — çekirdeğin TEK kuralı (Dalga 4, F#5)."""
    return _kurus_yuvarla(x or 0)


_tl = _tl_sayi   # kuruş → ₺ (çekirdek)


def _ay_sinir(ay: str):
    b = date.fromisoformat(ay[:7] + "-01")
    s = (b.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    return b, s


from evvel_yeni_cekirdek import ay_kaydir as _ay_kaydir  # noqa: E402 — ay aritmetiği TEK yerde (Codex T1-22)


def _hazirla(cur):
    global _HAZIR
    if _HAZIR:
        return
    from evvel_yeni_tanim_api import tanim_hazirla
    from evvel_yeni_cekirdek import ddl_kur, tablo_var
    tanim_hazirla(cur)
    # Codex P2: tablolar yokken kuran çağrı sonra 404 ile geri alınırsa bayrak açık kalıp sonraki çağrı UndefinedTable/500 veriyordu →
    # bayrak YALNIZ tablolar GÖRÜLÜNCE; DDL TEK modelle (savepoint + çağıranın lock_timeout'u geri yüklenir)
    from evvel_yeni_cekirdek import kolon_var
    if tablo_var(cur, "ey_maas_ay", "ey_personel_yoklama_karar") and kolon_var(cur, "ey_personel_yoklama_karar", "iptal_zaman"):
        _HAZIR = True
        return
    ddl_kur(cur, "sp_ey_maas_ddl", _maas_ddl)


def _maas_ddl(cur) -> None:
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_maas_ay (
        personel_id TEXT NOT NULL, ay TEXT NOT NULL,
        eksik_gun NUMERIC(5,2) NOT NULL DEFAULT 0, rapor_gun NUMERIC(5,2) NOT NULL DEFAULT 0, rapor_kesinti BOOLEAN NOT NULL DEFAULT FALSE,
        bayram_saat NUMERIC(6,2) NOT NULL DEFAULT 0, mesai_saat NUMERIC(6,2), calisma_saat NUMERIC(7,2),
        duzeltme BIGINT NOT NULL DEFAULT 0, aciklama TEXT,
        onay BOOLEAN NOT NULL DEFAULT FALSE, onaylayan TEXT, onay_zaman TIMESTAMPTZ, kalemler JSONB,
        degistiren TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (personel_id, ay))""")
    # Sahip: "arka arkaya iki gün QR yoksa sistem SORSUN: ayrıldı mı, yıllık izinde mi, devam mı" — cevap izi
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_personel_yoklama_karar (
        id TEXT PRIMARY KEY, personel_id TEXT NOT NULL, tarih DATE NOT NULL, karar TEXT NOT NULL,
        izin_bitis DATE, aciklama TEXT, degistiren TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    # İzin kaldırma izli (silinmez): Vardiya planı izni buraya yazar/kaldırır — izin TEK gerçek burada (sahip 20 Eki)
    cur.execute("ALTER TABLE ey_personel_yoklama_karar ADD COLUMN IF NOT EXISTS iptal_zaman TIMESTAMPTZ")
    cur.execute("ALTER TABLE ey_personel_yoklama_karar ADD COLUMN IF NOT EXISTS iptal_kim TEXT")
    cur.execute("DELETE FROM ey_maas_ay WHERE personel_id='takvim' AND ay='karar'")   # gölgelenme artığı (2026-10-16)


FM_GUNLUK_ESIK = 9.5   # günlük fazla mesai eşiği (eski vardiya_takip'in varsayılanı — fm_gunluk_esik)


PLAN_YOK = "__plan_yok__"   # _yeni_oneri sözlüğünde kişi değil BAYRAK anahtarı


def _yeni_oneri(cur, ay: str) -> dict:
    """YENİ DÖNEM öneri (tekrar denetimi C-T3-13: eski vardiya_takip eski QR'ı okuyordu). Sahip (2026-10-20): saat ÖNCE vardiya
    PLANINDAN; o gün plan yoksa QR giriş–çıkışından; çıkışı okutulmamış / gece sistemin kapattığı gün GÜVENİLMEZ → sayılmaz, uyarı.
    {pid: {calisma_saat, planli_gun, mesai_saat, guvenilmez_gun}} · mesai = güvenilir QR günü − FM_GUNLUK_ESIK (gerçek süre gerekir)."""
    y_, m_ = int(ay[:4]), int(ay[5:7])
    bas = date(y_, m_, 1)
    son = (date(y_ + (m_ == 12), m_ % 12 + 1, 1) - timedelta(days=1))
    plan, plan_yok = {}, False
    try:
        with savepoint(cur, "sp_ey_maas_plan"):
            # Codex P1: (1) yalnız BUGÜNE KADARKİ plan (gelecek vardiya hak edişe / avans tavanına girmesin);
            # (2) gece vardiyası (18:00–02:00): 'time + 24h' yine saat değeri → −16 saat çıkıyordu → fark ≤ 0 ise +24 saat.
            from evvel_yeni_cekirdek import is_gunu as _ig
            cur.execute("""SELECT a.personel_id::text AS pid, a.tarih,
                                  EXTRACT(EPOCH FROM (a.bitis_saat::time - a.baslangic_saat::time))/3600.0 AS fark
                             FROM vardiya_atama a WHERE a.tarih BETWEEN %s AND %s AND COALESCE(a.durum,'') <> 'iptal'""",
                        (bas, min(son, _ig())))
            for x in cur.fetchall() or []:
                x = dict(x)
                f_ = float(x["fark"] or 0)
                x["saat"] = f_ + 24 if f_ <= 0 else f_
                k = (x["pid"], x["tarih"])
                plan[k] = plan.get(k, 0.0) + float(x["saat"] or 0)
    except Exception as e:  # noqa: BLE001
        # Fable O-4: plan ESKİ vardiya_atama tablosunda (yeni sistemde plan tablosu yok) — kalkarsa sessizce "yalnız QR"a düşmesin
        plan_yok = True
        log.warning("evvel-yeni maaş: vardiya planı okunamadı: %s", str(e)[:160])
    _, rows = _yeni_yoklama(cur, bas, son)
    qr, bozuk = {}, set()
    for x in rows or []:
        k = (x["pid"], x["tarih"])
        if not x.get("cikis_ts") or x.get("cikis_tur") == "gece_otomatik":
            bozuk.add(k)   # çıkış okutulmamış → süre bilinmiyor
            continue
        qr[k] = qr.get(k, 0.0) + max(0.0, (x["cikis_ts"] - x["giris_ts"]).total_seconds() / 3600.0)
    out = {}
    for k in set(plan) | set(qr) | bozuk:
        pid, _g = k
        o = out.setdefault(pid, {"calisma_saat": 0.0, "planli_gun": 0, "mesai_saat": 0.0, "guvenilmez_gun": 0})
        if k in plan:
            o["calisma_saat"] += plan[k]
            o["planli_gun"] += 1
        elif k in qr and k not in bozuk:
            o["calisma_saat"] += qr[k]
            o["planli_gun"] += 1
        else:
            o["guvenilmez_gun"] += 1
        if k in qr and k not in bozuk:
            o["mesai_saat"] += max(0.0, qr[k] - FM_GUNLUK_ESIK)
    for o in out.values():
        o["calisma_saat"] = round(o["calisma_saat"], 2)
        o["mesai_saat"] = round(o["mesai_saat"], 2)
        o["plan_yok"] = plan_yok
    out[PLAN_YOK] = plan_yok   # Codex P1: hiç QR/plan satırı olmayan kişiye de uyarı ulaşsın (kişi kaydı yoksa bayrak buradan)
    return out


def _odemeler(cur) -> dict:
    """(personel_id, ait_ay) → {kalem: kuruş} — Evvel Yeni ödeme formu + şubenin elden avansı (iptaller hariç)."""
    from evvel_yeni_odeme_api import konu_odemeleri   # Ödeme'nin tek okuyucusu (Kaçırılan #1)
    out = {}
    for x in konu_odemeleri(cur, "personel"):
        if not x["personel_id"]:
            continue
        anah = (str(x["personel_id"]), x["ay"])
        kal = x["kalem"] or "Maaş"
        if kal == "Avans" and x["kaynak"] == "sube_avansi":
            kal = "Avans (şube)"   # eski sistem Ekim netinde ZATEN düşülü → Ekim'de ayrıca düşülmez
        out.setdefault(anah, {})
        out[anah][kal] = out[anah].get(kal, 0) + x["toplam"]
    return out


def _eski_ekim(cur, ay: str) -> dict:
    """Eski sistemin ay kaydı: hesaplanan_net (avans DÜŞÜLMÜŞ) + avans_mahsup → hak ediş."""
    out = {}
    try:
        with savepoint(cur, "sp_ey_maas_eski"):
            cur.execute("""SELECT personel_id::text AS pid, hesaplanan_net, avans_mahsup, durum FROM personel_aylik
                            WHERE yil=%s AND ay=%s""", (int(ay[:4]), int(ay[5:7])))
            for r in cur.fetchall() or []:
                r = dict(r)
                net = _kurus(r.get("hesaplanan_net") or 0)
                mah = _kurus(r.get("avans_mahsup") or 0)
                out[r["pid"]] = {"net": net, "mahsup": mah, "hak": net + mah, "durum": r.get("durum")}
    except Exception as e:  # noqa: BLE001
        log.info("evvel-yeni maaş: eski personel_aylik okunamadı: %s", str(e)[:120])
    return out


def _eski_odenen(cur, ay: str) -> dict:
    """Eski sistemden ÖDENMİŞ maaş: odeme_plani kaynak_tablo='personel', referans_ay = ÖDEME ayı (çalışma ayı + 1)."""
    out = {}
    try:
        with savepoint(cur, "sp_ey_maas_eski_od"):
            cur.execute("""SELECT kaynak_id::text AS pid, SUM(COALESCE(odenen_tutar, odenecek_tutar)) AS t FROM odeme_plani
                            WHERE kaynak_tablo='personel' AND durum='odendi' AND referans_ay = %s::date GROUP BY 1""",
                        (_ay_kaydir(ay, 1) + "-01",))
            for r in cur.fetchall() or []:
                out[dict(r)["pid"]] = _kurus(dict(r)["t"] or 0)
    except Exception as e:  # noqa: BLE001
        log.info("evvel-yeni maaş: eski ödeme planı okunamadı: %s", str(e)[:120])
    return out


def _ucretler(cur, ay: str) -> dict:
    from evvel_yeni_tanim_api import ay_ucretleri   # ücret tablosu Tanımlar'ın (C-T2-10)
    return ay_ucretleri(cur, ay)


def _yemek_kaynagi(cur, ay: str, ay_bas: date, ay_son: date):
    """F4 — VAR OLAN yemek kalemi okuyucusunun KAYNAĞI: panel başlangıç ayından (1 Kasım) itibaren yoklama modülünün
    PUBLIC yemek_ozet'i (K7/K8). Öncesi: eski formül (None). Modül kapalıysa {'kapali': True} → tam + uyarı."""
    from evvel_yeni_moduller import acik as _acik
    from evvel_yeni_cekirdek import panel_baslangic
    bas = panel_baslangic(cur).isoformat()   # Fable: tek yerde ayrıştırılır
    if ay < bas[:7]:
        return None
    if not _acik("yoklama"):
        return {"kapali": True}
    import evvel_yeni_yoklama_api as yoklama
    return yoklama.yemek_ozet(cur, max(ay_bas, date.fromisoformat(bas)), ay_son)


def _yemek_kalemi(k, pid: str, aylik: int, gun: int, uyari: list) -> dict:
    """Yemek tek POZİTİF kalem (kesinti satırı yok): aylık × gün/30 × hak_gün/çalışılan_gün. Müdür tam (F1b)."""
    tam = {"kod": "yemek", "ad": f"Yemek: aylık × {gun}/30", "tutar": _tl(aylik * gun // AY_GUN)}
    if k is None:
        return tam
    if k.get("kapali"):
        uyari.append("Yoklama modülü kapalı — yemek tam sayıldı")
        return tam
    if pid in k["mudur"]:
        return {**tam, "ad": tam["ad"] + " (müdür — tam)"}
    h = k["kisi"].get(pid) or {"calisilan_gun": 0, "hak_gun": 0, "dusen": []}
    payda, hak = h["calisilan_gun"], h["hak_gun"]
    if not payda:
        uyari.append("Bu ay yoklama kaydı yok — yemek tam sayıldı")
        return tam
    kurus = (Decimal(aylik) * gun * hak / (AY_GUN * payda)).quantize(Decimal(1), rounding=ROUND_HALF_UP)   # Codex: kesme değil yuvarlama
    return {"kod": "yemek", "ad": f"Yemek: aylık × {gun}/30 × {hak}/{payda} gün (mola ≤ {k.get('limit_dk', 60)} dk)",
            "tutar": _tl(int(kurus)), "dusen": h["dusen"]}


def _gecen_gun(giris, cikis, ay_bas, ay_son, bugun):
    if ay_bas > bugun:
        return 0, True
    bas = max(ay_bas, giris) if giris else ay_bas
    son = min(ay_son, cikis) if cikis else ay_son
    acik = son >= bugun and ay_bas <= bugun <= ay_son
    if acik:
        son = min(son, bugun)
    if son < bas:
        return 0, acik
    if bas == ay_bas and son == ay_son:
        return AY_GUN, acik
    return min(AY_GUN, (son - bas).days + 1), acik


def hesapla(cur, ay: str, sadece: Optional[str] = None, odemeler: Optional[dict] = None, _devir_cache=None) -> list:
    """Ayın bütün personel satırları. Avans devri için önceki ayları yeni hesap başlangıcından zincirler."""
    from evvel_yeni_cekirdek import bugun as _bugun
    _hazirla(cur)
    bugun = _bugun()
    ay_bas, ay_son = _ay_sinir(ay)
    odemeler = odemeler if odemeler is not None else _odemeler(cur)
    from evvel_yeni_tanim_api import tanim_listesi   # personel tablosu Tanımlar'ın (C-T2-10)
    kisiler = tanim_listesi(cur, "ey_personel", ("ad", "sube_id", "gorev", "giris", "cikis", "calisma_turu", "aktif"))
    cur.execute("SELECT * FROM ey_maas_ay WHERE ay=%s", (ay,))
    elle = {dict(r)["personel_id"]: dict(r) for r in cur.fetchall() or []}
    yh = _yeni_hesap(cur)
    eski_mod = ay < yh
    eski = _eski_ekim(cur, ay) if eski_mod else {}
    eski_od = _eski_odenen(cur, ay) if eski_mod else {}
    ucret = _ucretler(cur, ay)
    oneri = _yeni_oneri(cur, ay) if not eski_mod else {}   # C-T3-13: yeni dönem plan > QR (eski vardiya_takip değil)
    yemek_k = _yemek_kaynagi(cur, ay, ay_bas, ay_son) if not eski_mod else None
    # önceki aydan avans devri (yeni hesap başlangıcından itibaren zincir)
    devir_in = {}
    if not eski_mod and ay > yh:
        onceki = _ay_kaydir(ay, -1)
        for r in hesapla(cur, onceki, sadece, odemeler):
            devir_in[r["personel_id"]] = _kurus(r["avans_devir_sonraki"])
    satir = []
    for p in kisiler:
        pid = p["id"]
        if sadece and pid != sadece:
            continue
        if p.get("giris") and p["giris"] > ay_son:
            continue
        if p.get("cikis") and p["cikis"] < ay_bas:
            continue
        od = odemeler.get((pid, ay), {})
        avans = od.get("Avans", 0) + (0 if eski_mod else od.get("Avans (şube)", 0))
        odenen = sum(od.get(k, 0) for k in ODENEN_KALEMLER)
        e = elle.get(pid) or {}
        if eski_mod:
            x = eski.get(pid)
            if not x and not od:
                continue
            hak = x["hak"] if x else 0
            # Eski net avansı zaten düşmüş; Evvel Yeni formundan girilen Ekim avansı eskide YOK → ayrıca düş
            kalemler = [{"kod": "eski", "ad": "Eski sistem hak edişi (Ekim kapanışı)", "tutar": _tl(hak)}]
            mahsup = (x["mahsup"] if x else 0) + avans
            eo = eski_od.get(pid, 0)
            if ay <= KAPALI_SON_AY:
                # Evvel Yeni öncesi: maaş ödenmiş kabul — kalan sıfırlanır (iz: "ödendi sayıldı")
                eo = max(eo, hak - mahsup - odenen)
                od = {**od, "Ödendi sayıldı (Evvel Yeni öncesi)": eo}
            elif eo:
                od = {**od, "Eski sistemde ödenen": eo}
            if ay <= KAPALI_SON_AY:
                odenen += eo   # "ödendi sayıldı" TAMAMLAYICI (kalan 0) — gerçek ödeme değil, toplanır
            else:
                from evvel_yeni_kopru import gecis_odenen
                odenen, iki_yerde = gecis_odenen(odenen, eo)   # T1-08: gerçek eski ödeme — Kira/Kredi/Kart ile AYNI kural, toplanmaz
                if iki_yerde:
                    od = {**od, "⚠ iki sistemde de ödeme (toplanmadı, büyüğü)": 0}
            satir.append(_satir(p, ay, hak, kalemler, mahsup, avans, 0, odenen, od, e, ucret.get(pid), "eski_sistem",
                                {"eski_durum": (x or {}).get("durum"), "eski_avans_mahsup": _tl((x or {}).get("mahsup", 0))}, False))
            continue
        u = ucret.get(pid) or {"maas": 0, "yemek": 0, "saatlik": 0, "yol": 0}
        gun, acik = _gecen_gun(p.get("giris"), p.get("cikis"), ay_bas, ay_son, bugun)
        o = oneri.get(pid) or {}
        uyari = []
        if (o.get("plan_yok") or oneri.get(PLAN_YOK)) and e.get("calisma_saat") is None and (p.get("calisma_turu") or "tam") == "yari":
            uyari.append("Vardiya planı okunamadı — saat yalnız QR giriş–çıkışından, elle kontrol et")
        if o.get("guvenilmez_gun") and e.get("calisma_saat") is None:
            uyari.append(f"{o['guvenilmez_gun']} günde plan yok ve QR çıkışı okutulmamış — o günlerin saati sayılmadı, elle kontrol et")
        yari = (p.get("calisma_turu") or "tam") == "yari"
        maas = int(u["maas"] or 0)
        kalemler = []
        if yari:
            saat = float(e["calisma_saat"]) if e.get("calisma_saat") is not None else o.get("calisma_saat", 0)
            sat = int(u.get("saatlik") or 0)
            if not sat:
                uyari.append("Saatlik ücret tanımsız — Tanımlar → Personel")
            kalemler.append({"kod": "saat", "ad": f"Çalışma {saat:g} saat × {_tl(sat):g} ₺" + (" (elle)" if e.get("calisma_saat") is not None else " (plan / QR)"),
                             "tutar": _tl(int(Decimal(str(saat)) * sat))})
            if e.get("bayram_saat"):
                kalemler.append({"kod": "bayram", "ad": f"Bayram {float(e['bayram_saat']):g} saat × 2",
                                 "tutar": _tl(int(Decimal(str(e["bayram_saat"])) * sat * BAYRAM_KAT))})
        else:
            if not maas:
                uyari.append("Maaş tanımsız (0) — Tanımlar → Personel")
            kalemler.append({"kod": "taban", "ad": f"Taban: maaş/30 × {gun} gün", "tutar": _tl(maas * gun // AY_GUN)})
            mesai = float(e["mesai_saat"]) if e.get("mesai_saat") is not None else o.get("mesai_saat", 0)
            if mesai:
                kalemler.append({"kod": "mesai", "ad": f"Fazla mesai {mesai:g} saat" + (" (elle)" if e.get("mesai_saat") is not None else " (vardiya planı)"),
                                 "tutar": _tl(int(Decimal(str(mesai)) * maas / (AY_GUN * GUNLUK_SAAT)))})
            if e.get("bayram_saat"):
                kalemler.append({"kod": "bayram", "ad": f"Bayram {float(e['bayram_saat']):g} saat × 2",
                                 "tutar": _tl(int(Decimal(str(e["bayram_saat"])) * maas / (AY_GUN * GUNLUK_SAAT) * BAYRAM_KAT))})
            kes_gun = Decimal(str(e.get("eksik_gun") or 0)) + (Decimal(str(e.get("rapor_gun") or 0)) if e.get("rapor_kesinti") else 0)
            if kes_gun:
                kalemler.append({"kod": "eksik", "ad": f"Eksik gün {kes_gun:g} × maaş/30", "tutar": -_tl(int(kes_gun * maas / AY_GUN))})
        yemek_dusen = []
        if u.get("yemek"):
            yk = _yemek_kalemi(yemek_k, pid, int(u["yemek"]), gun, uyari)
            yemek_dusen = yk.pop("dusen", [])
            kalemler.append(yk)
        if u.get("yol"):
            kalemler.append({"kod": "yol", "ad": f"Yol: aylık × {gun}/30", "tutar": _tl(int(u["yol"]) * gun // AY_GUN)})
        if e.get("duzeltme"):
            kalemler.append({"kod": "duzeltme", "ad": "Düzeltme" + (f" — {e.get('aciklama')}" if e.get("aciklama") else ""), "tutar": _tl(e["duzeltme"])})
        # Onaylı ay: kalemler dondurulur (sonradan değişen ücret/vardiya geçmişi bozmaz)
        if e.get("onay") and e.get("kalemler"):
            kalemler = __import__("evvel_yeni_cekirdek").json_ac(e["kalemler"], [])
        hak = sum(_kurus(k["tutar"]) for k in kalemler)
        din = devir_in.get(pid, 0)
        mahsup = min(avans + din, max(hak, 0))
        ek = {"gun": gun, "ay_acik": acik, "uyari": uyari, "avans_devir_onceki": _tl(din),
              "hesap_saat": saat if yari else None,   # avans tavanı bunu okur (Fable O-3: _yeni_oneri ikinci kez çalışmasın)
              "yemek_hak": next((k["tutar"] for k in kalemler if k["kod"] == "yemek"), 0), "yemek_dusen": yemek_dusen}
        satir.append(_satir(p, ay, hak, kalemler, mahsup, avans, din, odenen, od, e, u, "evvel_yeni", ek, yari))
    satir.sort(key=lambda x: (not x["aktif"], x["ad"]))
    return satir


def _satir(p, ay, hak, kalemler, mahsup, avans, din, odenen, od, e, u, kaynak, ek, yari):
    kalan = hak - mahsup - odenen
    devir = max(0, avans + din - mahsup) if kaynak == "evvel_yeni" else 0
    yemek_hak = _kurus(ek.get("yemek_hak") or 0)
    yemek_kalan = max(0, yemek_hak - od.get("Yemek ücreti", 0))
    return {
        "personel_id": p["id"], "ad": p["ad"], "sube_id": p.get("sube_id"), "gorev": p.get("gorev"), "aktif": bool(p.get("aktif", True)),
        "cikis": p["cikis"].isoformat() if p.get("cikis") else None, "calisma_turu": "yari" if yari else "tam", "ay": ay, "kaynak": kaynak,
        "kalemler": kalemler, "hak_edis": _tl(hak), "avans": _tl(avans), "avans_mahsup": _tl(mahsup), "odenen": _tl(odenen),
        "odeme_kalemleri": {k: _tl(v) for k, v in od.items()}, "kalan": _tl(kalan), "avans_devir_sonraki": _tl(devir),
        "oneri": {"Maaş": _tl(max(0, kalan - yemek_kalan)), "Yemek ücreti": _tl(min(yemek_kalan, max(kalan, 0)))},
        "onay": bool(e.get("onay")), "onaylayan": e.get("onaylayan"),
        "elle": {k: (float(e[k]) if isinstance(e.get(k), Decimal) else e.get(k)) for k in
                 ("eksik_gun", "rapor_gun", "rapor_kesinti", "bayram_saat", "mesai_saat", "calisma_saat", "aciklama")} | {"duzeltme": _tl(e.get("duzeltme") or 0)},
        **ek,
    }


AVANS_SABIT_TAVAN = 2_000_000   # 20.000 ₺ (kuruş) — eski avans_service ile AYNI kural (sahip 20 Eki: "eski oran")
AVANS_HAKEDIS_ORAN = 0.50       # bugüne kadarki hak edişin %50'si
AVANS_NET_ORAN = 0.30           # ay sonu beklenen netin %30'u


def avans_tavani(cur, personel_id: str, gun: Optional[date] = None) -> dict:
    """PUBLIC (Avans modülü) — hak edişin sahibi Maaş: tavan = min(20.000 ₺, bugüne kadarki hak ediş × %50, beklenen net × %30);
    ikisi de ölçülemiyorsa 0 (hak ediş oluşmadan avans açılmaz — eski kural). Kuruş. Beklenen: tam zamanlı maaş+yemek+yol,
    yarı zamanlı (ayın vardiya planı / güvenilir QR saati) × saatlik."""
    from evvel_yeni_cekirdek import is_gunu as _ig
    ay = (gun or _ig()).strftime("%Y-%m")
    _hazirla(cur)
    r = next(iter(hesapla(cur, ay, sadece=str(personel_id))), None)
    hak = _kurus(r["hak_edis"]) if r else 0
    u = _ucretler(cur, ay).get(str(personel_id)) or {}
    if r and r.get("calisma_turu") == "yari":
        saat = r.get("hesap_saat")
        if saat is None:   # eski dönem satırı (1 Kasım öncesi) — hesapla saat üretmedi
            saat = (_yeni_oneri(cur, ay).get(str(personel_id)) or {}).get("calisma_saat", 0)
        bek = int(Decimal(str(saat)) * int(u.get("saatlik") or 0))
    else:
        bek = int(u.get("maas") or 0) + int(u.get("yemek") or 0) + int(u.get("yol") or 0)
    aday = [AVANS_SABIT_TAVAN] + ([int(hak * AVANS_HAKEDIS_ORAN)] if hak > 0 else []) + ([int(bek * AVANS_NET_ORAN)] if bek > 0 else [])
    return {"ay": ay, "tavan": 0 if (hak <= 0 and bek <= 0) else min(aday), "hakedis": hak, "beklenen": bek}


def personel_giderleri(cur, ay: str) -> list:
    """GİDER için: [(sube_id|None, hak kuruş, ad, tahmini)] — hak edişten, çalışma ayına, BİR KEZ."""
    out = []
    for r in hesapla(cur, ay):
        h = _kurus(r["hak_edis"])
        if h:
            out.append({"sube_id": r["sube_id"], "tutar": h, "ad": r["ad"], "tahmini": not r["onay"] and r["kaynak"] == "evvel_yeni",
                        "kaynak": r["kaynak"]})
    return out


@router.get("/liste")
def maas_liste(ay: Optional[str] = None):
    from evvel_yeni_cekirdek import bugun as _bugun
    a_ = (ay or _ay_kaydir(_bugun().strftime("%Y-%m"), -1))[:7]   # varsayılan: ödenecek ay = geçen ay
    with db() as (conn, cur):
        _hazirla(cur)
        sube_ad = __import__("evvel_yeni_tanim_api").adlar(cur, "ey_sube")
        rows = hesapla(cur, a_)
        yh = _yeni_hesap(cur)
    for r in rows:
        r["sube_ad"] = sube_ad.get(r["sube_id"]) or "Ortak"
    T = lambda k: round(sum(r[k] for r in rows), 2)  # noqa: E731
    return {"ay": a_, "eski_mod": a_ < yh, "personel": rows,
            "toplam": {"hak_edis": T("hak_edis"), "avans_mahsup": T("avans_mahsup"), "odenen": T("odenen"), "kalan": T("kalan")},
            "kapali": a_ <= KAPALI_SON_AY,
            "not": ("Evvel Yeni (1 Ekim) öncesi ay: maaşlar ödenmiş ve kapanmış sayılır. " if a_ <= KAPALI_SON_AY else "")
            + ("Ekim ve öncesi eski sistemin hesabıyla (avans düşülmüş net + mahsup). " if a_ < yh else "")
            + "Kalan = hak ediş − avans mahsubu − ödenen (maaş, yemek, prim). SGK/vergi kişinin bakiyesini kapatmaz."}


class ElleBody(BaseModel):
    eksik_gun: Optional[Decimal] = None
    rapor_gun: Optional[Decimal] = None
    rapor_kesinti: Optional[bool] = None
    bayram_saat: Optional[Decimal] = None
    mesai_saat: Optional[Decimal] = None        # boş gönderilirse vardiya önerisi
    calisma_saat: Optional[Decimal] = None
    duzeltme: Optional[TrTutar] = None
    aciklama: Optional[str] = None
    mesai_oneriye_don: bool = False
    saat_oneriye_don: bool = False


@router.post("/{pid}/{ay}")
def maas_elle(pid: str, ay: str, b: ElleBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    from evvel_yeni_cekirdek import aktor as _aktor
    with db() as (_c0, _k0):
        if ay[:7] < _yeni_hesap(_k0):
            raise HTTPException(400, "Ekim ve öncesi eski sistemin hesabıyla kapanır")
    if b.duzeltme and not (b.aciklama or "").strip():
        raise HTTPException(400, "Düzeltmenin gerekçesini yaz")
    with db() as (conn, cur):
        _hazirla(cur)
        kim = _aktor(cur, x_evvel_oturum)
        cur.execute("SELECT onay FROM ey_maas_ay WHERE personel_id=%s AND ay=%s", (pid, ay[:7]))
        r = cur.fetchone()
        if r and dict(r)["onay"]:
            raise HTTPException(409, "Bu ay onaylanmış — önce onayı kaldır")
        cur.execute("INSERT INTO ey_maas_ay (personel_id, ay, degistiren) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING", (pid, ay[:7], kim))
        set_, prm = [], []
        for k in ("eksik_gun", "rapor_gun", "rapor_kesinti", "bayram_saat", "aciklama"):
            v = getattr(b, k)
            if v is not None:
                set_.append(f"{k}=%s")
                prm.append(v.strip()[:200] if isinstance(v, str) else v)
        if b.duzeltme is not None:
            set_.append("duzeltme=%s")
            prm.append(_kurus(b.duzeltme))
        if b.mesai_oneriye_don:
            set_.append("mesai_saat=NULL")
        elif b.mesai_saat is not None:
            set_.append("mesai_saat=%s")
            prm.append(b.mesai_saat)
        if b.saat_oneriye_don:
            set_.append("calisma_saat=NULL")
        elif b.calisma_saat is not None:
            set_.append("calisma_saat=%s")
            prm.append(b.calisma_saat)
        if set_:
            cur.execute(f"UPDATE ey_maas_ay SET {', '.join(set_)}, degistiren=%s, zaman=NOW() WHERE personel_id=%s AND ay=%s",
                        prm + [kim, pid, ay[:7]])
    return {"ok": True, "mesaj": "Kaydedildi"}


@router.post("/{pid}/{ay}/onay")
def maas_onay(pid: str, ay: str, kaldir: bool = False, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Onay: ayın kalemleri DONDURULUR (ücret/vardiya sonradan değişse de bu ay bozulmaz); gider 'kesin' olur."""
    from evvel_yeni_cekirdek import aktor as _aktor
    with db() as (_c0, _k0):
        if ay[:7] < _yeni_hesap(_k0):
            raise HTTPException(400, "Ekim ve öncesi eski sistemin hesabıyla kapanır")
    with db() as (conn, cur):
        _hazirla(cur)
        kim = _aktor(cur, x_evvel_oturum)
        if kaldir:
            cur.execute("UPDATE ey_maas_ay SET onay=FALSE, kalemler=NULL, onaylayan=%s, onay_zaman=NOW() WHERE personel_id=%s AND ay=%s",
                        (kim, pid, ay[:7]))
            return {"ok": True, "mesaj": "Onay kaldırıldı — yeniden hesaplanır"}
        r = next(iter(hesapla(cur, ay[:7], sadece=pid)), None)
        if not r:
            raise HTTPException(404, "Bu ay için personel satırı yok")
        if r.get("ay_acik"):
            raise HTTPException(400, "Ay bitmeden onaylanamaz")
        cur.execute("INSERT INTO ey_maas_ay (personel_id, ay, degistiren) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING", (pid, ay[:7], kim))
        cur.execute("""UPDATE ey_maas_ay SET onay=TRUE, kalemler=%s::jsonb, onaylayan=%s, onay_zaman=NOW()
                        WHERE personel_id=%s AND ay=%s""", (json.dumps(r["kalemler"], ensure_ascii=False), kim, pid, ay[:7]))
    return {"ok": True, "mesaj": f"{r['ad']} · {ay[:7]} onaylandı · hak ediş {r['hak_edis']:,.2f} ₺"}


from evvel_yeni_cekirdek import tr_saat as _tr_saat   # Dalga 4 (F#4): saat biçimi TEK yerde — çekirdek


@router.get("/takvim")
def personel_takvim(ay: Optional[str] = None):
    """👥 PERSONEL TAKVİMİ (sahip 2026-10-16): "personellerin panel verilerinden bulundukları şubeler gün gün;
    panelde QR girişi olmadıysa izinlidir." Kaynak: 1 Kasım'dan önce eski panel QR'ı (gorev_yoklama), sonra yeni yoklama (Y3). Okurken yoklamanın gece kapatması çalışır.
    Gün: QR girişi varsa şube(ler) + giriş saati; yoksa 'izinli'; işe girişinden önce / ayrılışından sonra '—'."""
    from evvel_yeni_cekirdek import bugun as _bugun
    bugun = _bugun()
    a_ = (ay or bugun.strftime("%Y-%m"))[:7]
    ay_bas, ay_son = _ay_sinir(a_)
    with db() as (conn, cur):
        _hazirla(cur)
        sube_ad = __import__("evvel_yeni_tanim_api").adlar(cur, "ey_sube")
        from evvel_yeni_tanim_api import tanim_listesi
        kisiler = tanim_listesi(cur, "ey_personel", ("ad", "sube_id", "gorev", "giris", "cikis", "calisma_turu", "aktif"))
        cur.execute("SELECT personel_id, tarih, karar, izin_bitis FROM ey_personel_yoklama_karar WHERE iptal_zaman IS NULL ORDER BY zaman")
        kararlar = {}
        for r in cur.fetchall() or []:
            r = dict(r)
            kararlar.setdefault(r["personel_id"], []).append(r)
        yok = {}
        pb, yeni_qr = _yeni_yoklama(cur, ay_bas, ay_son)   # 1 Kasım'dan itibaren YENİ QR (Y3); öncesi eski panel QR'ı
        yoklama_kapali = yeni_qr is None
        yeni_qr = yeni_qr or []
        try:
            with savepoint(cur, "sp_ey_takvim"):
                cur.execute("""SELECT personel_id::text AS pid, tarih, sube_id::text AS sid, vardiya_tip, giris_ts, vardiya_disi
                                 FROM gorev_yoklama WHERE tarih BETWEEN %s AND %s AND tarih < %s ORDER BY giris_ts""", (ay_bas, ay_son, pb))
                for r in cur.fetchall() or []:
                    r = dict(r)
                    yok.setdefault((r["pid"], r["tarih"].isoformat()), []).append(r)
        except Exception as e:  # noqa: BLE001
            log.warning("personel takvim: yoklama okunamadı: %s", str(e)[:150])
        for r in yeni_qr:
            yok.setdefault((r["pid"], r["tarih"].isoformat()), []).append(
                {"pid": r["pid"], "tarih": r["tarih"], "sid": r["sid"], "vardiya_tip": "QR", "giris_ts": r["giris_ts"], "vardiya_disi": False})
        # Sahip (2026-10-16): "QR okutarak giriş yaptığı BÜTÜN şubeleri tara" —
        # (1) başka kimlikle (aynı kişinin ikinci kaydı) yazılmış QR'lar ADA göre kişiye bağlanır;
        # (2) QR okutmadan panelde açılış/kapanış/teslim yaptıysa o gün o şubede ÇALIŞTI sayılır (panel izi).
        from evvel_yeni_cekirdek import ad_anahtari as _n   # ad anahtarı TEK yerde (F#6)
        ey_ids = {p["id"] for p in kisiler}
        ad_kimlik = {}
        for p in kisiler:
            ad_kimlik.setdefault(_n(p["ad"]), p["id"])
        yabanci = {k[0] for k in yok if k[0] not in ey_ids}
        eslesmeyen = []
        if yabanci:
            try:
                with savepoint(cur, "sp_ey_takvim_ad"):
                    cur.execute("SELECT id::text AS id, ad_soyad FROM personel WHERE id::text = ANY(%s)", (list(yabanci),))
                    eski_ad = {dict(r)["id"]: dict(r)["ad_soyad"] for r in cur.fetchall() or []}
            except Exception:  # noqa: BLE001
                eski_ad = {}
            for k in list(yok):
                if k[0] not in yabanci:
                    continue
                hedef = ad_kimlik.get(_n(eski_ad.get(k[0])))
                rows = yok.pop(k)
                if hedef:
                    yok.setdefault((hedef, k[1]), []).extend(rows)
                else:
                    eslesmeyen.append({"ad": eski_ad.get(k[0]) or k[0], "gun": k[1], "sube": sube_ad.get(rows[0]["sid"], rows[0]["sid"])})
        panel = []
        try:
            with savepoint(cur, "sp_ey_takvim_panel"):
                cur.execute("""SELECT personel_id::text AS pid, personel_ad AS ad, tarih, sube_id::text AS sid, cevap_ts AS ts, tip
                                 FROM sube_operasyon_event WHERE tarih BETWEEN %s AND %s AND tarih < %s AND durum='tamamlandi'
                                  AND tip IN ('ACILIS','KAPANIS')""", (ay_bas, ay_son, pb))
                panel += [dict(r) for r in cur.fetchall() or []]
                cur.execute("""SELECT teslim_eden_personel_id::text AS pid, teslim_eden_ad AS ad, tarih, sube_id::text AS sid, olusturma AS ts, 'TESLIM' AS tip
                                 FROM kasa_teslim WHERE tarih BETWEEN %s AND %s AND tarih < %s""", (ay_bas, ay_son, pb))
                panel += [dict(r) for r in cur.fetchall() or []]
        except Exception as e:  # noqa: BLE001
            log.warning("personel takvim: panel izi okunamadı: %s", str(e)[:150])
        panel += [{**r, "tip": r["tip_ad"]} for r in _yeni_panel_izi(cur, ay_bas, ay_son, pb)]   # yeni dönem panel izi
        for r in panel:
            pid = r["pid"] if r["pid"] in ey_ids else ad_kimlik.get(_n(r.get("ad")))
            if not pid or not r.get("tarih"):
                continue
            key = (pid, r["tarih"].isoformat())
            if any(x["sid"] == r["sid"] for x in yok.get(key, [])):
                continue
            yok.setdefault(key, []).append({"pid": pid, "tarih": r["tarih"], "sid": r["sid"], "giris_ts": r["ts"], "vardiya_disi": False,
                                            "vardiya_tip": {"ACILIS": "panel: açılış", "KAPANIS": "panel: kapanış", "TESLIM": "panel: teslim"}.get(r["tip"], r["tip"]),
                                            "panel": True})
    # Sahip: Alsancak QR kullanmıyor → o ay HİÇ QR girişi olmayan şubenin personeline soru sorulmaz
    qr_sube = {r["sid"] for rows in yok.values() for r in rows if not r.get("panel")}
    gunler = []
    g = ay_bas
    while g <= ay_son:
        gunler.append(g.isoformat())
        g += timedelta(days=1)
    out = []
    for p in kisiler:
        pid = p["id"]
        calisti = any((pid, d) in yok for d in gunler)
        # Fable: ay içinde ayrılan (pasif ama çıkışı bu ay) kişi maaş listesinde vardı, takvimde yoktu → yalnız çıkışı AYDAN ÖNCE olan / çıkışsız pasif elenir
        if not calisti and ((p.get("giris") and p["giris"] > ay_son) or (p.get("cikis") and p["cikis"] < ay_bas)
                            or (not p.get("aktif", True) and not p.get("cikis"))):
            continue
        satir, say = [], {}
        mudur = __import__("evvel_yeni_tanim_api").mudur_mu(p.get("gorev"))   # TEK müdür kuralı (F#10)
        for d in gunler:
            dd = date.fromisoformat(d)
            rows = yok.get((pid, d)) or []
            if rows:
                subeler_g = []
                for r in rows:
                    ad = sube_ad.get(r["sid"], r["sid"])
                    if ad not in subeler_g:
                        subeler_g.append(ad)
                for ad in subeler_g:
                    say[ad] = say.get(ad, 0) + 1 / len(subeler_g)
                rows = sorted(rows, key=lambda r: (r.get("panel", False), str(r["giris_ts"] or "")))
                ilk = rows[0]["giris_ts"]
                girisler = []
                for r in rows:
                    girisler.append({"sube": sube_ad.get(r["sid"], r["sid"]), "saat": _tr_saat(r["giris_ts"]), "vardiya": r["vardiya_tip"],
                                     "panel": bool(r.get("panel"))})
                satir.append({"gun": d, "durum": "calisti", "subeler": subeler_g, "girisler": girisler,
                              "saat": _tr_saat(ilk),
                              "vardiya": sorted({r["vardiya_tip"] for r in rows}), "disi": any(r.get("vardiya_disi") for r in rows),
                              "qrsiz": all(r.get("panel") for r in rows)})
            elif dd > bugun:
                satir.append({"gun": d, "durum": "gelecek"})
            elif (p.get("giris") and dd < p["giris"]) or (p.get("cikis") and dd > p["cikis"]):
                satir.append({"gun": d, "durum": "yok"})
            elif mudur:
                satir.append({"gun": d, "durum": "mudur"})   # sahip: "müdürlerde QR aranmasın"
            else:
                satir.append({"gun": d, "durum": "izinli"})
        en_cok = max(say.items(), key=lambda x: x[1])[0] if say else None
        # İKİ GÜN KURALI: dünden geriye aralıksız ≥2 gün QR yok (ve kişi aktif) → SOR; verilen cevap o dönemi kapatır
        seri, son_qr = [], None
        for x in satir:
            if x["durum"] == "calisti":
                seri, son_qr = [], x["gun"]
            elif x["durum"] == "izinli":
                seri.append(x["gun"])
        dun = (bugun - timedelta(days=1)).isoformat()
        bugun_qr = any(x["gun"] == bugun.isoformat() and x["durum"] == "calisti" for x in satir)
        seri = [d for d in seri if d <= dun]
        soru = None
        qr_yok_sube = bool(p.get("sube_id")) and p["sube_id"] not in qr_sube
        if p.get("aktif", True) and not mudur and not qr_yok_sube and not yoklama_kapali and not bugun_qr and len(seri) >= 2 and seri[-1] == dun:
            cevapli = any(k["tarih"].isoformat() >= seri[0] and (k["karar"] in ("devam", "ayrildi") or
                          (k["karar"] == "izin" and (not k.get("izin_bitis") or k["izin_bitis"] >= bugun)))
                          for k in kararlar.get(pid, []))
            if not cevapli:
                soru = {"gun_sayisi": len(seri), "ilk_gun": seri[0], "son_qr": son_qr}
        izinde = next((k for k in reversed(kararlar.get(pid, [])) if k["karar"] == "izin" and (not k.get("izin_bitis") or k["izin_bitis"] >= bugun)), None)
        kayitli = sube_ad.get(p.get("sube_id")) if p.get("sube_id") else "Ortak"
        out.append({"personel_id": pid, "ad": p["ad"], "kayitli_sube": kayitli, "aktif": bool(p.get("aktif", True)),
                    "cikis": p["cikis"].isoformat() if p.get("cikis") else None, "calisma_turu": p.get("calisma_turu") or "tam",
                    "gunler": satir, "sube_gun": {k: round(v, 1) for k, v in sorted(say.items(), key=lambda x: -x[1])},
                    "calisti_gun": sum(1 for x in satir if x["durum"] == "calisti"),
                    "qrsiz_gun": sum(1 for x in satir if x["durum"] == "calisti" and x.get("qrsiz")), "izinli_gun": sum(1 for x in satir if x["durum"] == "izinli"),
                    "en_cok_sube": en_cok, "uyusmaz": bool(en_cok and kayitli != "Ortak" and en_cok != kayitli),
                    "soru": soru, "yillik_izinde": bool(izinde), "mudur": mudur, "sube_qr_yok": qr_yok_sube,
                    "izin_bitis": izinde["izin_bitis"].isoformat() if izinde and izinde.get("izin_bitis") else None})
    out.sort(key=lambda x: (not x["aktif"], x["kayitli_sube"] or "", x["ad"]))
    return {"ay": a_, "gunler": gunler, "personel": out, "subeler": sorted({s["ad"] for s in _ey_subeler_aktif()}),
            "sorulacak": [{"personel_id": x["personel_id"], "ad": x["ad"], **x["soru"]} for x in out if x.get("soru")],
            "uyari": "⚠ Yoklama modülü kapalı ya da okunamadı — 1 Kasım sonrası günler 'izinli' görünebilir, soru üretilmedi" if yoklama_kapali else None,
            "eslesmeyen": eslesmeyen,
            "not": "Kaynak: şube panelindeki QR girişi (bütün şubeler) + panel izi (QR okutmadan açılış/kapanış/teslim yaptıysa, çizgili kutu). "
                   "Hiçbiri yoksa 'izinli'. Bir günde iki şubeye girdiyse ikisi de yazılır."}



class YoklamaKararBody(BaseModel):
    personel_id: str
    karar: str                       # ayrildi | izin | devam
    tarih: Optional[str] = None      # sorunun başladığı gün
    izin_bitis: Optional[str] = None
    aciklama: Optional[str] = None


@router.post("/takvim-karar")   # ⚠ "/takvim/karar" → "/{pid}/{ay}" kalıbına takılıyordu (rota gölgelenmesi)
def takvim_karar(b: YoklamaKararBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """İki gün QR yok sorusunun cevabı. 'ayrildi' → personel pasif, ayrılış = son QR günü (yoksa sorunun ilk günü − 1)."""
    import uuid as _uuid
    from evvel_yeni_cekirdek import aktor as _aktor, bugun as _bugun
    if b.karar not in ("ayrildi", "izin", "devam"):
        raise HTTPException(400, "karar: ayrildi | izin | devam")
    with db() as (conn, cur):
        _hazirla(cur)
        kim = _aktor(cur, x_evvel_oturum)
        t = (b.tarih or _bugun().isoformat())[:10]
        cur.execute("""INSERT INTO ey_personel_yoklama_karar (id, personel_id, tarih, karar, izin_bitis, aciklama, degistiren)
                       VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                    (str(_uuid.uuid4()), b.personel_id, t, b.karar, (b.izin_bitis or None), (b.aciklama or None), kim))
        mesaj = {"izin": "Yıllık izin olarak işaretlendi", "devam": "Devam ediyor — soru kapandı"}.get(b.karar)
        if b.karar == "ayrildi":
            son = None
            try:
                with savepoint(cur, "sp_ey_son_qr"):
                    cur.execute("SELECT MAX(tarih) AS t FROM gorev_yoklama WHERE personel_id::text=%s", (b.personel_id,))
                    son = (dict(cur.fetchone() or {}) or {}).get("t")
            except Exception:  # noqa: BLE001
                son = None
            try:
                with savepoint(cur, "sp_ey_son_qr_yeni"):   # yeni dönem QR'ı da (Y3) — Yoklama'nın kapısı (F#36)
                    from evvel_yeni_yoklama_api import son_yoklama_gunu
                    son = max([x for x in (son, son_yoklama_gunu(cur, b.personel_id)) if x], default=None)
            except Exception:  # noqa: BLE001
                pass
            cikis = son or (date.fromisoformat(t) - timedelta(days=1))
            from evvel_yeni_tanim_api import tanim_guncelle
            tanim_guncelle(cur, "ey_personel", b.personel_id, {"aktif": False}, bos_ise={"cikis": cikis}, kim=kim)   # Tanımlar'ın kapısı (C-T2-07)
            mesaj = f"Ayrıldı olarak işaretlendi — ayrılış {cikis}"
    return {"ok": True, "mesaj": mesaj}


# ─────────── 🏖 İZİN — TEK gerçek (sahip 20 Eki: vardiyadaki gri 'izinli' hücre = bu kayıt; iki ayrı izin defteri YOK) ───────────
def izin_araliklari(cur, bas: date, son: date, personel_id: Optional[str] = None) -> list:
    """PUBLIC — [bas, son] ile kesişen izinler [{id, personel_id, bas, bit (None = bitişi belli değil), aciklama, degistiren}].
    Kaynak: takvim kararı 'izin' (2 gün QR yok sorusu) + Vardiya planı izin hücresi — ikisi de AYNI kayıt."""
    _hazirla(cur)
    kos, prm = ["karar='izin'", "iptal_zaman IS NULL", "tarih <= %s", "(izin_bitis IS NULL OR izin_bitis >= %s)"], [son, bas]
    if personel_id:
        kos.append("personel_id=%s")
        prm.append(str(personel_id))
    cur.execute(f"""SELECT id, personel_id, tarih AS bas, izin_bitis AS bit, aciklama, degistiren FROM ey_personel_yoklama_karar
                     WHERE {' AND '.join(kos)} ORDER BY tarih""", tuple(prm))
    return [dict(r) for r in cur.fetchall() or []]


def izin_yaz(cur, *, personel_id: str, bas: date, bit: Optional[date], kim: str, aciklama: Optional[str] = None) -> str:
    """PUBLIC — izin aralığı yaz (çakışan açık izin varsa 409). Kaldırma izin_kaldir ile (silinmez, izli)."""
    import uuid as _uuid
    if bit and bit < bas:
        raise HTTPException(400, "İzin bitişi başlangıçtan önce olamaz")
    if izin_araliklari(cur, bas, bit or date(2999, 12, 31), personel_id):
        raise HTTPException(409, "Bu tarihlerde zaten izin var — önce onu kaldır")
    kid = str(_uuid.uuid4())
    cur.execute("""INSERT INTO ey_personel_yoklama_karar (id, personel_id, tarih, karar, izin_bitis, aciklama, degistiren)
                   VALUES (%s,%s,%s,'izin',%s,%s,%s)""", (kid, str(personel_id), bas, bit, (aciklama or "vardiya planı")[:200], kim))
    return kid


def izin_kaldir(cur, izin_id: str, kim: str) -> None:
    """PUBLIC — izni kaldır (satır silinmez: iptal_zaman + iptal_kim)."""
    _hazirla(cur)
    cur.execute("""UPDATE ey_personel_yoklama_karar SET iptal_zaman=NOW(), iptal_kim=%s
                    WHERE id=%s AND karar='izin' AND iptal_zaman IS NULL RETURNING id""", (kim, izin_id))
    if not cur.fetchone():
        raise HTTPException(409, "İzin bulunamadı ya da kaldırılmış — sayfayı yenile")


GEC_TOLERANS_DK = 5   # planlanan başlangıçtan bu kadar sonrasına kadar "zamanında"


@router.get("/yoklama")
def gunluk_yoklama(gun: Optional[str] = None, gun_sayisi: int = 1):
    """📋 GÜNLÜK YOKLAMA (sahip 2026-10-16): "personel hangi gün hangi şubede QR okutmuş, kim okutmamış,
    okutan geç mi kalmış — bunu görmek dert." Panelin VARDİYA PLANI (vardiya_atama) × QR girişi (gorev_yoklama).
    Durum: zamaninda · gec (dk) · okutmadi (planlı, QR yok) · plansiz (planda yok, QR var). 1 Kasım'dan itibaren QR = yeni yoklama (Y3)."""
    from evvel_yeni_cekirdek import bugun as _bugun
    from evvel_yeni_tanim_api import subeler as _ey_subeler
    from zoneinfo import ZoneInfo
    TR = ZoneInfo("Europe/Istanbul")
    son = date.fromisoformat(gun[:10]) if gun else _bugun()
    gun_sayisi = max(1, min(int(gun_sayisi or 1), 31))
    bas = son - timedelta(days=gun_sayisi - 1)
    with db() as (conn, cur):
        _hazirla(cur)
        sube_ad = __import__("evvel_yeni_tanim_api").adlar(cur, "ey_sube")
        aktif_sube = {s["id"] for s in _ey_subeler(cur)}
        from evvel_yeni_tanim_api import tanim_listesi
        pad = {r["id"]: r for r in tanim_listesi(cur, "ey_personel", ("ad", "gorev"))}
        plan, qr = [], []
        try:
            with savepoint(cur, "sp_ey_yok_plan"):
                cur.execute("""SELECT a.tarih, a.personel_id::text AS pid, s.sube_id::text AS sid, a.baslangic_saat, a.bitis_saat, s.ad AS slot
                                 FROM vardiya_atama a JOIN vardiya_slot s ON s.id = a.slot_id
                                WHERE a.tarih BETWEEN %s AND %s AND a.durum <> 'iptal'""", (bas, son))
                plan = [dict(r) for r in cur.fetchall() or []]
        except Exception as e:  # noqa: BLE001
            log.warning("yoklama: plan okunamadı: %s", str(e)[:150])
        pb, yeni_qr = _yeni_yoklama(cur, bas, son)   # 1 Kasım'dan itibaren YENİ QR (Y3)
        yoklama_kapali = yeni_qr is None
        yeni_qr = yeni_qr or []
        try:
            with savepoint(cur, "sp_ey_yok_qr"):
                cur.execute("""SELECT tarih, personel_id::text AS pid, sube_id::text AS sid, giris_ts, cikis_ts, vardiya_tip
                                 FROM gorev_yoklama WHERE tarih BETWEEN %s AND %s AND tarih < %s ORDER BY giris_ts""", (bas, son, pb))
                qr = [dict(r) for r in cur.fetchall() or []]
        except Exception:  # noqa: BLE001
            with savepoint(cur, "sp_ey_yok_qr2"):
                cur.execute("""SELECT tarih, personel_id::text AS pid, sube_id::text AS sid, giris_ts, NULL AS cikis_ts, vardiya_tip
                                 FROM gorev_yoklama WHERE tarih BETWEEN %s AND %s AND tarih < %s ORDER BY giris_ts""", (bas, son, pb))
                qr = [dict(r) for r in cur.fetchall() or []]
        qr += [{"tarih": r["tarih"], "pid": r["pid"], "sid": r["sid"], "giris_ts": r["giris_ts"],
                "cikis_ts": None if r.get("cikis_tur") == "gece_otomatik" else r["cikis_ts"],   # Fable: sistem kapattı → giriş saati çıkış SANILMASIN
                "sistem_kapatti": r.get("cikis_tur") == "gece_otomatik", "vardiya_tip": "QR"} for r in yeni_qr]
        qr.sort(key=lambda x: str(x["giris_ts"] or ""))

    def tr(ts):
        if not ts:
            return None
        return ts.astimezone(TR).replace(tzinfo=None) if getattr(ts, "tzinfo", None) else ts

    def ad(pid):
        return (pad.get(pid) or {}).get("ad") or pid
    gunler = []
    g = son
    while g >= bas:
        gi = g
        satirlar = {}
        qr_g = [q for q in qr if q["tarih"] == gi]
        kullanildi = set()
        for p in sorted([p for p in plan if p["tarih"] == gi], key=lambda x: str(x["baslangic_saat"])):
            q = next((i for i, x in enumerate(qr_g) if i not in kullanildi and x["pid"] == p["pid"] and x["sid"] == p["sid"]), None)
            if q is None:   # başka şubede okuttuysa onu da göster
                q = next((i for i, x in enumerate(qr_g) if i not in kullanildi and x["pid"] == p["pid"]), None)
            plan_bas = p["baslangic_saat"].strftime("%H:%M") if p.get("baslangic_saat") else None
            s = {"personel_id": p["pid"], "ad": ad(p["pid"]), "plan": f"{plan_bas}–{p['bitis_saat'].strftime('%H:%M') if p.get('bitis_saat') else ''}",
                 "slot": p.get("slot"), "qr": None, "qr_sube": None, "durum": "okutmadi", "gec_dk": None}
            if q is not None:
                kullanildi.add(q)
                x = qr_g[q]
                t = tr(x["giris_ts"])
                s.update(qr=t.strftime("%H:%M") if t else None, qr_sube=sube_ad.get(x["sid"], x["sid"]), cikis=(tr(x.get("cikis_ts")) or None) and tr(x["cikis_ts"]).strftime("%H:%M"))
                if t and p.get("baslangic_saat"):
                    from datetime import datetime as _dt
                    dk = (t - _dt.combine(gi, p["baslangic_saat"])).total_seconds() / 60
                    s["gec_dk"] = int(round(dk)) if dk > GEC_TOLERANS_DK else 0
                    s["durum"] = "gec" if dk > GEC_TOLERANS_DK else "zamaninda"
                else:
                    s["durum"] = "zamaninda"
            elif gi == _bugun() and p.get("baslangic_saat"):
                from datetime import datetime as _dt
                if _dt.now(TR).replace(tzinfo=None) < _dt.combine(gi, p["baslangic_saat"]):
                    s["durum"] = "bekleniyor"
            satirlar.setdefault(p["sid"], []).append(s)
        for i, x in enumerate(qr_g):
            if i in kullanildi:
                continue
            t = tr(x["giris_ts"])
            satirlar.setdefault(x["sid"], []).append({"personel_id": x["pid"], "ad": ad(x["pid"]), "plan": None, "slot": None,
                                                      "qr": t.strftime("%H:%M") if t else None, "qr_sube": sube_ad.get(x["sid"], x["sid"]),
                                                      "durum": "plansiz", "gec_dk": None,
                                                      "cikis": tr(x.get("cikis_ts")).strftime("%H:%M") if x.get("cikis_ts") else None})
        subeler_out = []
        for sid, ad_ in sorted(sube_ad.items(), key=lambda z: z[1]):
            ss = satirlar.get(sid, [])
            if sid not in aktif_sube and not ss:
                continue   # Fable: pasif şube (MERKEZ) boşken listelenmesin
            subeler_out.append({"sube_id": sid, "ad": ad_, "kisiler": ss,
                                "ozet": {k: sum(1 for x in ss if x["durum"] == k) for k in ("zamaninda", "gec", "okutmadi", "plansiz", "bekleniyor")}})
        gunler.append({"gun": gi.isoformat(), "subeler": subeler_out, "plan_var": any(p["tarih"] == gi for p in plan)})
        g -= timedelta(days=1)
    return {"son": son.isoformat(), "gunler": gunler, "tolerans_dk": GEC_TOLERANS_DK,
            "uyari": "⚠ Yoklama modülü kapalı ya da okunamadı — 1 Kasım sonrası QR görünmüyor" if yoklama_kapali else None,
            "not": f"Plan: şube panelinin vardiya planı · QR: panelde okutulan giriş (1 Kasım'dan itibaren telefon QR'ı). Çıkış yapılmayan gün gece sistem kapatır (çıkış '—'). Başlangıçtan {GEC_TOLERANS_DK} dk sonrasına kadar zamanında sayılır."}



def _yeni_yoklama(cur, bas: date, son: date):
    """1 Kasım (panel_baslangic) sınırı + yeni dönem QR satırları (yoklama modülünün PUBLIC servisi; Y3 planı).
    Dönüş (sinir, satirlar). Yoklama modülü kapalıysa satırlar boş (tak-çıkar)."""
    from evvel_yeni_cekirdek import panel_baslangic
    from evvel_yeni_moduller import acik as _acik
    pb = panel_baslangic(cur)
    if son < pb:
        return pb, []
    if not _acik("yoklama"):
        return pb, None   # Fable: yeni dönem + modül kapalı → None (okuyucu uyarı verir, "herkes izinli" sanılmasın)
    import evvel_yeni_yoklama_api as y
    try:
        with savepoint(cur, "sp_ey_maas_yoklama"):
            return pb, y.yoklama_satirlari(cur, max(bas, pb), son)
    except Exception:  # noqa: BLE001
        log.warning("maaş: yeni yoklama okunamadı", exc_info=True)
        return pb, None


def _yeni_panel_izi(cur, bas: date, son: date, pb: date) -> list:
    """Yeni dönem panel izi: QR okutmadan yeni panelde açılış / kapanış / teslim yapan o gün o şubede ÇALIŞTI sayılır."""
    if son < pb:
        return []
    try:
        from evvel_yeni_olay import panel_olaylari   # F#12
    except Exception:  # noqa: BLE001
        return []
    ad = {"acilis": "panel: açılış", "kapanis": "panel: kapanış", "teslim": "panel: teslim", "teslim_al": "panel: teslim al"}
    out = []
    try:
        with savepoint(cur, "sp_ey_maas_panel_izi"):
            ol = panel_olaylari(cur, bas=max(bas, pb), son=son, turler=set(ad))
    except Exception:  # noqa: BLE001
        log.warning("maaş: panel izi okunamadı", exc_info=True)
        return []
    for o in ol:
        if not o.get("personel_id"):
            continue
        out.append({"pid": str(o["personel_id"]), "ad": o.get("personel_ad"), "tarih": o["is_gunu"], "sid": str(o["sube_id"]),
                    "ts": o["olay_zamani"], "tip_ad": ad[o["tur"]]})
    return out


def _ey_subeler_aktif():
    from evvel_yeni_tanim_api import subeler as _s
    with db() as (conn, cur):
        return _s(cur)
