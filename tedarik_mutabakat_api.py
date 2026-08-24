"""
tedarik_mutabakat_api.py — FATURA ↔ TESLİM MUTABAKATI (izole duyu, SALT OKUR)

═══════════════════════════════════════════════════════════════════════════════
NEDEN VAR (2026-08-24)
═══════════════════════════════════════════════════════════════════════════════
Zincir izi "20 sipariş TESLİM ALINMAMIŞ" dedi. Ama bu tek cümle İKİ AYRI şeyi
birden anlatıyor ve ikisi taban tabana zıt:

    (a) mal gerçekten gelmedi        → TEDARİKÇİ kovalanacak
    (b) mal geldi, KAYIT kapanmadı   → ŞUBE kaydı kapatacak

Şubeyi suçlamadan önce kanıt gerekiyordu. Kanıt FATURADADIR. Kredi kartlarında
ekstrenin kendi toplamı nasıl çapa olduysa, burada da fatura çapadır:
**tedarikçi göndermediği malı faturalamaz.**

CANLI KANIT (FEZ, 20 Ağustos 2026):
    fatura                126 adet
    teslim alınan sipariş  84 adet
    fark                   42 adet
Faturada "SÜTLÜ ÇİKOLATALI SOS ×6", "BEYAZ ÇİKOLATALI SOS ×12", "TOFFEE KARAMEL
SOS ×12" satırları var ve bunlar teslim alınan siparişte YOK — 19 Ağustos'un
"teslim alınmamış" görünen siparişlerinde var. Yani mal geldi, sipariş kapanmadı.

═══════════════════════════════════════════════════════════════════════════════
ÇAPA NEDEN ADET? (ada değil sayıya dayanır)
═══════════════════════════════════════════════════════════════════════════════
Aynı ürün iki dünyada bambaşka yazılır:
    sipariş : "Lime"
    fatura  : "FO MİSKET LİMON AROMALI ŞURUP 700 ML *6"
Ada dayanan bir ölçüm burada kırılır — ortak tek kelime bile yok. ADET kırılmaz.
Bu, kart tarafındaki dersin aynısı: ölçüyü, biçimi değişen alana değil,
DEĞİŞMEYEN alana bağla.

═══════════════════════════════════════════════════════════════════════════════
ÖNCE ÖLÇÜM ALETİ (kartlardan gelen kural)
═══════════════════════════════════════════════════════════════════════════════
Faturanın kalemleri okunmamışsa bu fatura kalem düzeyinde ÖLÇÜLEMEZ. O zaman
"sipariş kapanmamış" DENMEZ, "ölçülemiyor" denir. Axess vakasında öğrenildi:
aletin körlüğü defterin suçu değildir. Ölçülemeyen fatura toplamlara da girmez.

⚠️ ÖNERİ-ONLY: bu modül hiçbir kayıt yazmaz/silmez/kapatmaz.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List

from fastapi import APIRouter

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/tedarik-mutabakat", tags=["tedarik-mutabakat"])

# Fatura ile teslim arasındaki makul gecikme; dışında kalan sipariş bu faturaya
# ait sayılmaz. Küçük tutulursa gerçek eşler kaçar, büyük tutulursa yabancı
# sipariş karışır — 10 gün canlı FEZ/ATALAY ritmine göre seçildi (medyan 3-4 gün).
VARSAYILAN_PENCERE = 10

# Sistem bu tarihte açıldı; öncesinde SİPARİŞ KAYDI YOKTUR. Bu tarihten eski bir
# faturaya "siparişsiz gelen mal" demek, olmayan bir defteri suçlamaktır.
SISTEM_BASLANGIC = "2026-06-01"


def _ad_adaylari(fatura_ad: str) -> List[str]:
    """Faturadaki resmî unvandan, sipariş tarafındaki KISA ada köprü kurar.

    ⚠️ KİMLİK ÇATLAĞI (2026-08-24 canlı): teslimat tedarikçi KAYDINA bağlıdır
    ("FEZ"), fatura ise resmî unvana ("FEZ KAHVE GIDA İTHALAT İHRACAT SANAYİ VE
    TİCARET LİMİTED ŞİRKETİ"). Düz eşitlik aranırsa HİÇBİR fatura hiçbir
    siparişle eşleşmez ve uç sessizce "sipariş yok" der — sahte yeşilin ta
    kendisi. Bu yüzden ilk kelimeler üzerinden aday listesi üretilir; eşleşme
    yine de ADETLE sınanır, yani gevşek köprü tek başına hüküm vermez.
    """
    ad = (fatura_ad or "").upper().strip()
    if not ad:
        return [""]
    kelime = [w for w in re.split(r"[^A-ZÇĞİÖŞÜ0-9]+", ad) if w]
    adaylar = {ad}
    if kelime:
        adaylar.add(kelime[0])
        if len(kelime) > 1:
            adaylar.add(" ".join(kelime[:2]))
    return list(adaylar)


# Firma adlarında HERKESTE geçen, bu yüzden KİMLİK TAŞIMAYAN kelimeler. Bunlarla
# köprü kurmak "KONYA" yüzünden iki yabancı firmayı birleştirir.
_JENERIK = {
    "LIMITED", "LİMİTED", "LTD", "SIRKETI", "ŞİRKETİ", "STI", "ŞTİ", "ANONIM",
    "ANONİM", "SANAYI", "SANAYİ", "TICARET", "TİCARET", "SAN", "TIC", "TİC",
    "GIDA", "GİDA", "KAHVE", "ITHALAT", "İTHALAT", "IHRACAT", "İHRACAT", "VE",
    "PAZARLAMA", "HIZMETLERI", "HİZMETLERİ", "URUNLERI", "ÜRÜNLERİ", "GRUP",
    "KONYA", "ISTANBUL", "İSTANBUL", "MARKET", "TURIZM", "TURİZM", "ENERJI",
    "ENERJİ", "KIMYA", "KİMYA", "AS", "A", "S", "INS", "İNŞ", "TEKNIK", "TEKNİK",
}


def _ayirt_edici(ad: str) -> set:
    """Bir firma adındaki KİMLİK TAŞIYAN kelimeler (jenerikler atılmış).

    ⚠️ ÜÇ KİMLİK TEK KARŞI TARAF (2026-08-24 canlı, Atalay pilotunun aynısı):
    Faturalar "MEHMET ATALAY" adına, siparişler "ATALAY KAHVE" adına yazılmış.
    İlk kelime üzerinden köprü kuran ilk sürüm bunları eşleştiremedi ve 7 ATALAY
    faturasına "SİPARİŞSİZ GELEN MAL" dedi — oysa siparişleri vardı, sadece
    başka bir adın altındaydı. Kimlik hatası, bulgu kılığına girmişti.
    Doğrusu: ORTAK AYIRT EDİCİ KELİME üzerinden köprü kur ({ATALAY} kesişimi).
    Jenerikler ("GIDA", "KAHVE", "LİMİTED", "KONYA") kimlik taşımaz; onlarla
    köprü kurmak iki yabancı firmayı birleştirir.
    """
    return {w for w in re.split(r"[^A-ZÇĞİÖŞÜ0-9]+", (ad or "").upper())
            if len(w) >= 3 and w not in _JENERIK}


def _gun_farki(a: str, b: str) -> int:
    """İki 'YYYY-MM-DD' arasındaki gün farkı."""
    from datetime import date as _d
    ya, ma, ga = (int(x) for x in a[:10].split("-"))
    yb, mb, gb = (int(x) for x in b[:10].split("-"))
    return (_d(ya, ma, ga) - _d(yb, mb, gb)).days


def _kalem_listesi(ham: Any) -> List[Dict]:
    if isinstance(ham, str):
        try:
            ham = json.loads(ham)
        except (ValueError, TypeError):
            return []
    return [k for k in (ham or []) if isinstance(k, dict)]


@router.get("/fatura-teslim")
def fatura_teslim_mutabakati(tedarikci: str = "", gun: int = 120,
                             pencere: int = VARSAYILAN_PENCERE):
    """Faturayı, aynı tedarikçinin siparişleriyle ADET üzerinden kıyaslar.

    Dönen her fatura için `durum` şunlardan biridir:
      ÖLÇÜLEMEZ                    faturanın kalemleri okunmamış
      TUTUYOR                      fatura ile teslim alınan sipariş aynı (±1 adet)
      MAL GELDİ, SİPARİŞ KAPANMADI fatura fazla + o pencerede açık sipariş var
      SİPARİŞSİZ GELEN MAL         fatura fazla ama hiç açık sipariş yok
      FATURALANMAYAN TESLİM        teslim alınan, faturadan fazla
    """
    g = max(1, min(730, int(gun or 120)))
    pen = max(1, min(45, int(pencere or VARSAYILAN_PENCERE)))
    t = (tedarikci or "").strip()
    with db() as (_, cur):
        kos = ["f.fatura_tarih >= CURRENT_DATE - %s"]
        par: List[Any] = [g]
        if t:
            kos.append("f.tedarikci_ad ILIKE %s")
            par.append("%" + t + "%")
        cur.execute(
            "SELECT f.id, f.tedarikci_ad, f.fatura_no, f.fatura_tarih::text AS tarih, "
            "       COALESCE(f.toplam_tutar,0)::float AS tutar, "
            "       COALESCE(SUM(k.adet),0)::float AS fatura_adet, "
            "       COUNT(k.id) AS kalem_adet "
            "  FROM tedarikci_fatura f "
            "  LEFT JOIN tedarikci_fatura_kalem k ON k.fatura_id = f.id "
            " WHERE " + " AND ".join(kos) +
            " GROUP BY f.id, f.tedarikci_ad, f.fatura_no, f.fatura_tarih, f.toplam_tutar "
            " ORDER BY f.fatura_tarih DESC",
            tuple(par),
        )
        faturalar = [dict(r) for r in (cur.fetchall() or [])]

        # ── 1) MÜKERRER FATURA KAYDI (2026-08-24 canlı) ────────────────────
        # FEZ2026000001891 ve ...1703 `tedarikci_fatura`da İKİŞER KEZ duruyor:
        # biri kalemleriyle, biri boş. Boş kopya "ÖLÇÜLEMEZ" diye rapora giriyor
        # ve gerçek bir körlük varmış gibi görünüyordu. Aynı fatura no + aynı
        # tutar = tek belgedir; ölçüme KALEMİ OLAN kopya girer, diğeri ayrı bir
        # bulgu olarak GİZLENMEDEN raporlanır (sessiz eleme yasak).
        _grup: Dict[Any, List[Dict]] = {}
        for f in faturalar:
            _grup.setdefault((f["fatura_no"], round(float(f["tutar"] or 0), 2)), []).append(f)
        faturalar, mukerrer = [], []
        for anahtar, grup in _grup.items():
            grup.sort(key=lambda x: int(x["kalem_adet"] or 0), reverse=True)
            faturalar.append(grup[0])
            for k in grup[1:]:
                mukerrer.append({"fatura_id": k["id"], "fatura_no": k["fatura_no"],
                                 "tarih": k["tarih"], "tutar": k["tutar"],
                                 "kalem_adet": int(k["kalem_adet"] or 0),
                                 "ayni_belge": grup[0]["id"]})
        faturalar.sort(key=lambda x: str(x["tarih"] or ""), reverse=True)

        # ── 2) HER SİPARİŞ EN FAZLA BİR FATURAYA (2026-08-24 canlı) ────────
        # İlk sürüm her faturanın ±pencere gününe düşen TÜM siparişleri
        # sayıyordu. Aynı sipariş birden çok faturaya sayılınca 10 Ağustos
        # faturası, 19 Ağustos'un teslimatlarını da üstlendi ve "FATURALANMAYAN
        # TESLİM −84 adet" diye SAHTE bir bulgu üretti. Haziran'da fark −324'e
        # kadar çıktı. Doğrusu: her sipariş, tarihçe EN YAKIN faturaya (pencere
        # içinde) ait sayılır — atıf TEKİL olmalıdır, yoksa aynı mal iki kez
        # ölçülür. (Kartlardaki "yinelenen sayfa" dersinin tedarik hâli.)
        _siparisler: Dict[str, List[Dict]] = {}
        if faturalar:
            _tum_ad: set = set()
            for f in faturalar:
                _tum_ad.update(_ad_adaylari(f["tedarikci_ad"]))
            cur.execute(
                "SELECT ts.id, ts.olusturma, ts.teslim_ts, ts.kalemler, s.ad AS sube_adi, "
                "       UPPER(COALESCE(ts.tedarikci_ad, td.ad, '')) AS ted_ad "
                "  FROM toptanci_siparis ts "
                "  LEFT JOIN tedarikciler td ON td.id = ts.tedarikci_id "
                "  LEFT JOIN subeler s ON s.id = ts.sube_id "
                " WHERE ts.olusturma >= CURRENT_DATE - %s "
                " ORDER BY ts.olusturma",
                (g + pen,),
            )
            for r in (cur.fetchall() or []):
                d = dict(r)
                s_gun = str(d.get("olusturma") or "")[:10]
                if not s_gun:
                    continue
                en_yakin, en_uzaklik = None, None
                for f in faturalar:
                    if not f["tarih"]:
                        continue
                    if str(f["tarih"]) < SISTEM_BASLANGIC:
                        continue
                    if not (_ayirt_edici(d.get("ted_ad") or "")
                            & _ayirt_edici(f["tedarikci_ad"])):
                        continue   # ortak ayırt edici kelime yok → aynı taraf değil
                    try:
                        uzak = abs((_gun_farki(s_gun, str(f["tarih"]))))
                    except Exception:  # noqa: BLE001
                        continue
                    if uzak > pen:
                        continue
                    if en_uzaklik is None or uzak < en_uzaklik:
                        en_yakin, en_uzaklik = f["id"], uzak
                if not en_yakin:
                    continue
                kl = _kalem_listesi(d.get("kalemler"))
                _siparisler.setdefault(en_yakin, []).append({
                    "ts_id": d["id"], "sube_adi": d.get("sube_adi"),
                    "siparis_ts": str(d.get("olusturma") or "")[:19],
                    "teslim_alindi": bool(d.get("teslim_ts")),
                    "adet": round(sum(float(k.get("adet") or 0) for k in kl), 2),
                    "ozet": " · ".join(
                        str(k.get("urun_ad") or k.get("ad") or "?") + " ×" + str(k.get("adet"))
                        for k in kl[:4]),
                })

        # ── 3) SİPARİŞ KANALINI HİÇ KULLANMAYAN TEDARİKÇİ (2026-08-24) ─────
        # 🔔 UYARI BÜTÇESİ: ilk sürüm 25 faturaya "SİPARİŞSİZ GELEN MAL" dedi.
        # Bakınca çoğu matbaa, uydu servisi, enerji, ambalaj — yani şube panelinden
        # SİPARİŞ VERİLMEYEN tedarikçiler. Onların faturasında sipariş aramak,
        # olmayan bir kanalı yok diye suçlamaktır. 25 sahte alarm, aradaki 2
        # gerçek bulguyu görünmez kılardı.
        # Kural: bu tedarikçi hayatında HİÇ sipariş almadıysa, bu araç onu
        # ÖLÇEMEZ. (Axess dersi: aletin kapsamadığı yer hata değil, kör noktadır.)
        cur.execute(
            "SELECT DISTINCT UPPER(COALESCE(ts.tedarikci_ad, td.ad, '')) AS ad "
            "  FROM toptanci_siparis ts "
            "  LEFT JOIN tedarikciler td ON td.id = ts.tedarikci_id"
        )
        _kanal_kullanan = {str(r["ad"] or "") for r in (cur.fetchall() or []) if r["ad"]}

        sonuc: List[Dict] = []
        sayac = {"tutuyor": 0, "kayit_kapanmamis": 0, "siparissiz": 0,
                 "faturalanmamis_teslim": 0, "olculemez": 0, "sistem_oncesi": 0, "kanal_yok": 0}
        for f in faturalar:
            kayit: Dict[str, Any] = {
                "fatura_id": f["id"], "fatura_no": f["fatura_no"], "tarih": f["tarih"],
                "tedarikci_ad": f["tedarikci_ad"], "tutar": f["tutar"],
                "fatura_kalem": int(f["kalem_adet"] or 0),
                "fatura_adet": round(float(f["fatura_adet"] or 0), 2),
            }
            if not f["kalem_adet"]:
                # ⛔ KÖR ALETLE DEFTER SUÇLANMAZ (Axess dersi)
                kayit.update({
                    "durum": "ÖLÇÜLEMEZ — faturanın kalemleri okunmamış",
                    "olcum_gecerli": False,
                    "neden": ("Bu faturada satır kalemi yok (OCR yapılmamış ya da "
                              "okunamamış). Kalem yokken 'sipariş kapanmamış' demek, "
                              "ölçemediğin şeyi hata saymaktır."),
                })
                sayac["olculemez"] += 1
                sonuc.append(kayit)
                continue

            if str(f["tarih"] or "") < SISTEM_BASLANGIC:
                # ⛔ OLMAYAN DEFTERİ SUÇLAMA (2026-08-24): ilk sürüm sistem
                # açılmadan önceki 4 FEZ faturasını "SİPARİŞSİZ GELEN MAL" diye
                # bulgu saydı. O tarihlerde sipariş kaydı DİYE BİR ŞEY YOKTU.
                # Kartlardaki kuralın aynısı: ölçüm aletinin bulunmadığı dönem
                # ölçülemez sayılır, hata sayılmaz.
                kayit.update({
                    "durum": "SİSTEM ÖNCESİ — sipariş kaydı yoktu, ölçülemez",
                    "olcum_gecerli": False,
                    "neden": ("Sistem %s'de açıldı; bu faturadan önce sipariş kaydı "
                              "tutulmuyordu." % SISTEM_BASLANGIC),
                })
                sayac["sistem_oncesi"] += 1
                sonuc.append(kayit)
                continue

            if not any(_ayirt_edici(f["tedarikci_ad"]) & _ayirt_edici(k)
                       for k in _kanal_kullanan):
                kayit.update({
                    "durum": "SİPARİŞ KANALI KULLANILMIYOR — bu araçla ölçülemez",
                    "olcum_gecerli": False,
                    "neden": ("Bu tedarikçiden şube paneli üzerinden HİÇ sipariş "
                              "verilmemiş. Faturasında sipariş aramak, olmayan bir "
                              "kanalı yok diye suçlamak olur."),
                })
                sayac["kanal_yok"] += 1
                sonuc.append(kayit)
                continue

            sip = _siparisler.get(f["id"], [])
            teslim_adet = round(sum(x["adet"] for x in sip if x["teslim_alindi"]), 2)
            acik = [x for x in sip if not x["teslim_alindi"]]
            fark = round(kayit["fatura_adet"] - teslim_adet, 2)
            kayit.update({
                "olcum_gecerli": True, "pencere_gun": pen,
                "siparis_sayisi": len(sip), "teslim_alinan_adet": teslim_adet,
                "adet_farki": fark, "acik_siparisler": acik,
            })

            if abs(fark) <= 1:
                # ±1 adet: kısmi gönderim / yuvarlama gürültüsü. Alarm üretmez.
                kayit["durum"] = "TUTUYOR — fatura ile teslim alınan sipariş aynı"
                sayac["tutuyor"] += 1
            elif fark > 1 and acik:
                kayit["durum"] = "MAL GELDİ, SİPARİŞ KAPANMADI"
                kayit["kanit"] = (
                    "Fatura %.0f adet içeriyor ama teslim alınan sipariş %.0f adet. "
                    "Aradaki %.0f adet, aşağıdaki %d açık siparişten geliyor — "
                    "tedarikçi göndermediği malı faturalamaz."
                    % (kayit["fatura_adet"], teslim_adet, fark, len(acik)))
                kayit["kanit_gucu"] = "GÜÇLÜ"
                kayit["eylem"] = "Şube bu siparişleri teslim-al ile kapatmalı."
                sayac["kayit_kapanmamis"] += 1
            elif fark > 1:
                kayit["durum"] = "SİPARİŞSİZ GELEN MAL — faturada var, sipariş yok"
                kayit["eylem"] = ("Sistem dışı gelen mal olabilir; elle belge talebi "
                                  "açılmalı ya da sipariş penceresi genişletilmeli.")
                sayac["siparissiz"] += 1
            else:
                # ⚖️ KANIT GÜCÜ SİMETRİK DEĞİLDİR (2026-08-24) — bunu yazmak şart:
                # FARK POZİTİFSE (fatura fazla) kanıt GÜÇLÜDÜR — tedarikçi
                # göndermediği malı faturalamaz; demek ki mal geldi.
                # FARK NEGATİFSE (teslim fazla) kanıt ZAYIFTIR — çünkü siparişin
                # "adet"i ile faturanın "adet"i AYNI BİRİM OLMAYABİLİR: şube
                # "Sade Maden Suyu ×240" (şişe) yazarken fatura "×10" (koli)
                # yazabilir. Canlı örnek: 16 Haziran, teslim 336 / fatura 104.
                # Bu yüzden burada "eksik fatura var" diye kesin hüküm VERİLMEZ;
                # önce birim uyuşmazlığından şüphelenilir.
                kayit["durum"] = "FATURALANMAYAN TESLİM? — teslim alınan, faturadan fazla"
                kayit["kanit_gucu"] = "ZAYIF"
                kayit["uyari"] = (
                    "Sipariş adedi ile fatura adedi aynı birimde olmayabilir "
                    "(koli ↔ şişe). Bu satır tek başına 'fatura eksik' demez; "
                    "önce birimleri karşılaştırın.")
                kayit["eylem"] = ("Birimler aynıysa eksik fatura tedarikçiden istenmeli; "
                                  "değilse sipariş kalemine birim bilgisi eklenmeli.")
                sayac["faturalanmamis_teslim"] += 1
            sonuc.append(kayit)

        # ── 4) DÖNEM MUTABAKATI — hüküm FATURADAN DÖNEME taşındı (2026-08-24)
        # 🪤 Aynı tedarikçi aynı gün BİRKAÇ fatura kesince (ATALAY 6 Temmuz'da üç
        # tane: 12 + 13 + 3 adet), siparişler "en yakın faturaya" gidiyor ve
        # geri kalan faturalar "SİPARİŞSİZ GELEN MAL" görünüyordu. Ortada
        # siparişsiz mal yoktu — ÖLÇÜ BİRİMİ YANLIŞTI.
        # Kartlarda öğrenilen kural: tek satırı değil DÖNEMİ mutabık kıl.
        # Burada dönem = aynı karşı tarafın, birbirine `pencere` günden yakın
        # faturalarının oluşturduğu küme. Hüküm küme düzeyinde verilir.
        gruplar: List[Dict] = []
        _olculebilir = [x for x in sonuc if x.get("olcum_gecerli")]
        _kullanildi = [False] * len(_olculebilir)
        for i, a in enumerate(_olculebilir):
            if _kullanildi[i]:
                continue
            kume = [a]
            _kullanildi[i] = True
            for j in range(i + 1, len(_olculebilir)):
                b = _olculebilir[j]
                if _kullanildi[j]:
                    continue
                if not (_ayirt_edici(a["tedarikci_ad"]) & _ayirt_edici(b["tedarikci_ad"])):
                    continue
                try:
                    if abs(_gun_farki(a["tarih"], b["tarih"])) <= pen:
                        kume.append(b)
                        _kullanildi[j] = True
                except Exception:  # noqa: BLE001
                    continue
            f_adet = round(sum(x["fatura_adet"] for x in kume), 2)
            # aynı sipariş iki faturaya sayılmasın diye ts_id ile tekilleştir
            _gorulen, t_adet, acik = set(), 0.0, []
            for x in kume:
                for s in (x.get("acik_siparisler") or []):
                    if s["ts_id"] not in _gorulen:
                        _gorulen.add(s["ts_id"]); acik.append(s)
                t_adet += x["teslim_alinan_adet"]
            t_adet = round(t_adet, 2)
            fark = round(f_adet - t_adet, 2)
            if abs(fark) <= 1:
                durum, guc = "TUTUYOR — dönem faturası ile teslim alınan aynı", None
            elif fark > 1 and acik:
                durum, guc = "MAL GELDİ, SİPARİŞ KAPANMADI", "GÜÇLÜ"
            elif fark > 1:
                durum, guc = "SİPARİŞSİZ GELEN MAL — dönemde karşılığı yok", "ORTA"
            else:
                durum, guc = "FATURALANMAYAN TESLİM? — birim şüphesi", "ZAYIF"
            gruplar.append({
                "tedarikci_ad": a["tedarikci_ad"],
                "donem_bas": min(x["tarih"] for x in kume),
                "donem_bit": max(x["tarih"] for x in kume),
                "fatura_adet_sayisi": len(kume),
                "faturalar": [x["fatura_no"] for x in kume],
                "fatura_tutari": round(sum(x["tutar"] or 0 for x in kume), 2),
                "fatura_adet": f_adet, "teslim_alinan_adet": t_adet,
                "adet_farki": fark, "durum": durum, "kanit_gucu": guc,
                "acik_siparisler": acik,
            })
        gruplar.sort(key=lambda x: x["donem_bit"], reverse=True)
        grup_ozet: Dict[str, int] = {}
        for gg in gruplar:
            _k = gg["durum"].split("—")[0].strip()
            grup_ozet[_k] = grup_ozet.get(_k, 0) + 1

    return {
        "tedarikci": t or "(hepsi)", "gun": g, "pencere_gun": pen,
        "toplam": len(sonuc), "ozet": sayac,
        "donem_sayisi": len(gruplar), "donem_ozet": grup_ozet, "donemler": gruplar,
        "olculebilen": sum(1 for x in sonuc if x.get("olcum_gecerli")),
        "olculemeyen": sayac["olculemez"] + sayac["sistem_oncesi"] + sayac["kanal_yok"],
        "mukerrer_fatura_kaydi": mukerrer,
        "mukerrer_adet": len(mukerrer),
        "faturalar": sonuc,
        "not": ("ÖNERİ-ONLY — hiçbir kayıt yazılmadı. Çapa ADETTİR: ürün adları iki "
                "dünyada farklı yazıldığı için ada dayanan ölçüm kırılır, adet kırılmaz. "
                "Kalemleri okunmamış fatura ÖLÇÜLEMEZ sayılır ve toplamlara girmez — "
                "kör aletle defter suçlanmaz. 'MAL GELDİ, SİPARİŞ KAPANMADI' bir "
                "muhasebe hatası değil KAYIT eksiğidir: şube teslim-al ile kapatmalıdır. "
                "⚖️ KANIT GÜCÜ SİMETRİK DEĞİL: fatura FAZLAYSA kanıt güçlüdür (tedarikçi "
                "göndermediğini faturalamaz); teslim fazlaysa ZAYIFTIR (sipariş adedi ile "
                "fatura adedi aynı birimde olmayabilir — koli ↔ şişe)."),
    }
