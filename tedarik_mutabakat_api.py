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
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

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

# Fatura kesildikten SONRA girilmiş sipariş kaydı için tanınan pay (gün).
# Sıfır yapılırsa aynı gün geç kaydedilen siparişler kaybolur; büyütülürse
# sonraki dönemin siparişi bu faturaya karışır. 1 gün ölçülü paydır.
SONRA_TOLERANS = 1


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


def _kanonik_harita() -> Dict[str, str]:
    """alias(UPPER) → kanonik ad. Kimlik karar defterinden okunur.

    ⚠️ BİRLEŞTİRMENİN KARŞILIĞI BURADA ALINIR (2026-08-25): sahip SÜTAŞ'ın iki
    adını birleştirdi ama ürün sözlüğü ve kalem köprüsü kimliği HAM ADDAN
    kuruyordu; sonuç değişmedi ve "Yarım Yağlı Süt" köprüsü listede İKİ KEZ
    kalmaya devam etti. Birleştirme bir defterde durur, ama okuyanlar o defteri
    okumazsa hiçbir şey birleşmez.
    HATA-YUTAR: defter yoksa boş harita döner, davranış eskisi gibi kalır.
    """
    try:
        from tedarikci_zinciri_api import _guncel_kararlar
        with db() as (_, c):
            return dict(_guncel_kararlar(c) or {})
    except Exception as e:  # noqa: BLE001
        logger.warning("kanonik harita okunamadı (yutuldu): %s", str(e)[:120])
        return {}


def _kanonik_ad(ad: str, harita: Dict[str, str]) -> str:
    """Bir tedarikçi adını karar defterindeki kanonik karşılığına çevirir."""
    return harita.get((ad or "").upper(), ad or "")


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


def _tedarikci_ritmi(cur, g: int) -> Dict[str, int]:
    """Her tedarikçi için SİPARİŞ → TESLİM gecikmesini ölçer (gün, p90).

    ⚠️ SABİT PENCERE YANLIŞ HÜKÜM ÜRETİYORDU (2026-08-25, METRO vakası):
    Pencere herkes için 10 gündü. METRO'da sipariş 28 Temmuz'da veriliyor, mal
    12 Ağustos'ta geliyor (15 gün), fatura 11 Ağustos'ta kesiliyor — yani sipariş
    ile fatura arası 14 gün. 10 günlük pencere bunu göremeyip faturayı
    "SİPARİŞSİZ GELEN MAL" ilan etti. Ortada eksik sipariş yoktu; ÖLÇEK YANLIŞTI.

    Her tedarikçinin ritmi farklıdır: FEZ 1-2 günde teslim eder, METRO 15 günde.
    Tek bir sayıyı herkese giydirmek, yavaş tedarikçiyi sürekli suçlu gösterir.
    Bu yüzden pencere TEDARİKÇİNİN KENDİ GÖZLENEN RİTMİNDEN türetilir.

    p90 seçildi: en yavaş tek teslimat pencereyi şişirmesin ama olağan
    gecikmeler içeride kalsın. Gözlem yoksa varsayılana düşülür.
    """
    try:
        cur.execute(
            "SELECT UPPER(COALESCE(ts.tedarikci_ad, td.ad, '')) AS ad, "
            "       EXTRACT(DAY FROM (ts.teslim_ts - ts.olusturma))::int AS gecikme "
            "  FROM toptanci_siparis ts "
            "  LEFT JOIN tedarikciler td ON td.id = ts.tedarikci_id "
            " WHERE ts.teslim_ts IS NOT NULL AND COALESCE(ts.durum,'') <> 'iptal' "
            "   AND ts.olusturma >= CURRENT_DATE - %s", (g + 60,))
        ham: Dict[str, List[int]] = {}
        for r in (cur.fetchall() or []):
            r = dict(r)
            gec = int(r["gecikme"] or 0)
            if 0 <= gec <= 60 and r["ad"]:
                ham.setdefault(r["ad"], []).append(gec)
    except Exception as e:  # noqa: BLE001 — ritim okunamazsa varsayılan pencere
        logger.warning("tedarikçi ritmi okunamadı (yutuldu): %s", str(e)[:120])
        return {}
    ritim: Dict[str, int] = {}
    for ad, lst in ham.items():
        lst.sort()
        p90 = lst[min(len(lst) - 1, int(len(lst) * 0.9))]
        ritim[ad] = p90
    return ritim


def _pencere_sec(ted_ad: str, ritim: Dict[str, int], taban: int) -> int:
    """Bu tedarikçi için pencere: gözlenen ritim + fatura payı, tabanın altına inmez."""
    en = taban
    for ad, p90 in ritim.items():
        if _ayirt_edici(ad) & _ayirt_edici(ted_ad):
            en = max(en, p90 + 5)     # teslimden sonra fatura kesilmesi için pay
    return min(45, en)


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
        _alim_kaynagi_kolonu(cur)
        # ⛔ KOPYA NÜSHA ÖLÇÜME GİRMEZ (2026-08-25)
        # OCR kapsama teşhisi şunu gösterdi: kalemi olmayan 13 faturanın 12'si
        # OCR hatası DEĞİL, sistemin zaten `durum='kopya'` diye işaretlediği
        # İKİNCİ NÜSHA. Aslı okunmuş ve kalemleri var. Sistemin geri kalanı bu
        # işareti her yerde süzüyor (fatura_api'de 8 ayrı sorguda), benim yeni
        # ucum süzmüyordu → 9 fatura boş yere "ölçülemez" sayıldı ve "OCR'ı
        # iyileştir" diye olmayan bir işi işaret etti.
        # Ders (bugün ikinci kez): duyu, sistemin AÇIKÇA koyduğu durum
        # işaretini okumazsa kendi körlüğünü başkasının hatası gibi gösterir.
        kos = ["f.fatura_tarih >= CURRENT_DATE - %s",
               "COALESCE(f.durum,'') <> 'kopya'",
               # ⛔ İRSALİYE FATURA DEĞİLDİR: fiyat taşımaz, borç doğurmaz.
               # Ölçüme sokmak "0,00 fatura" diye sahte boşluk üretir.
               "COALESCE(f.belge_turu,'fatura') <> 'irsaliye'"]
        par: List[Any] = [g]
        if t:
            kos.append("f.tedarikci_ad ILIKE %s")
            par.append("%" + t + "%")
        cur.execute(
            "SELECT f.id, f.tedarikci_ad, f.fatura_no, f.fatura_tarih::text AS tarih, "
            "       COALESCE(f.toplam_tutar,0)::float AS tutar, "
            "       COALESCE(f.alim_kaynagi,'') AS alim_kaynagi, "
            "       COALESCE(SUM(k.adet),0)::float AS fatura_adet, "
            "       COUNT(k.id) AS kalem_adet "
            "  FROM tedarikci_fatura f "
            "  LEFT JOIN tedarikci_fatura_kalem k ON k.fatura_id = f.id "
            " WHERE " + " AND ".join(kos) +
            " GROUP BY f.id, f.tedarikci_ad, f.fatura_no, f.fatura_tarih, f.toplam_tutar, "
            "          f.alim_kaynagi "
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
        _ritim = _tedarikci_ritmi(cur, g)
        # 📦 KOLİ HARİTASI — sipariş adedi hangi birimde sayılmış?
        # Şube aynı siparişte su için ŞİŞE, şurup için KOLİ sayabiliyor
        # (FEZ 16 Haz: "Sade Maden Suyu ×240" = 10 koli × 24). Tek birim
        # varsaymak o dönemi sonsuza dek "tutmuyor" gösterir.
        _koli: Dict[str, int] = {}
        try:
            _birim_kolonu(cur)
            cur.execute("SELECT ad, koli_adet FROM siparis_urun "
                        "WHERE koli_adet IS NOT NULL AND koli_adet > 1")
            for _r in (cur.fetchall() or []):
                _r = dict(_r)
                _koli[_tr_buyut(_r["ad"] or "")] = int(_r["koli_adet"])
        except Exception as _ek2:  # noqa: BLE001 — koli yoksa ham sayım kullanılır
            logger.info("koli haritası okunamadı: %s", str(_ek2)[:90])
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
                # ⛔ İPTAL EDİLEN SİPARİŞ ÖLÇÜME GİRMEZ (2026-08-24): sahip
                # TEMA'nın 8 hatalı 19 Ağustos siparişini iptal etti; kayıt
                # durum='iptal' olarak DURUYOR ama artık ne "açık sipariş"tir
                # ne de teslim sayılır. Okumayan bir ölçüm, kapatılan işi
                # kapanmamış gösterir.
                "   AND COALESCE(ts.durum,'') <> 'iptal' "
                " ORDER BY ts.olusturma",
                (g + pen,),
            )
            _iptal_kayit: Dict[str, List[Dict]] = {}
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
                        # ⏳ ZAMAN OKU TEK YÖNLÜ (2026-08-24, sahip uyarısı):
                        # "FATURA TARİHİNDEN ÖNCESİNE BAK." Mal önce sipariş
                        # edilir, SONRA faturalanır. İlk sürüm pencereyi iki
                        # yönlü (±10 gün) kurmuştu ve 23 Ağustos siparişini
                        # 20 Ağustos faturasına sayıyordu — henüz verilmemiş bir
                        # sipariş, kesilmiş bir faturanın malını açıklayamaz.
                        # Sapma = fatura günü − sipariş günü; NEGATİF olamaz.
                        # SONRA_TOLERANS: aynı gün/ertesi gün girilen siparişler
                        # (geç kaydedilmiş) kaybolmasın diye küçük bir pay.
                        sapma = _gun_farki(str(f["tarih"]), s_gun)
                    except Exception:  # noqa: BLE001
                        continue
                    # Pencere TEDARİKÇİYE GÖRE: yavaş teslim eden tedarikçide
                    # sipariş ile fatura arası doğal olarak uzundur.
                    _pen_f = _pencere_sec(f["tedarikci_ad"], _ritim, pen)
                    if sapma < -SONRA_TOLERANS or sapma > _pen_f:
                        continue
                    uzak = abs(sapma)
                    if en_uzaklik is None or uzak < en_uzaklik:
                        en_yakin, en_uzaklik = f["id"], uzak
                if not en_yakin:
                    continue
                kl = _kalem_listesi(d.get("kalemler"))
                # ⚖️ İKİ YORUM: ham sayım ve KOLİYE ÇEVRİLMİŞ sayım.
                # Hangisinin doğru olduğuna burada karar VERİLMEZ; ikisi de
                # taşınır, dönem hükmünde faturaya YAKIN OLAN seçilir.
                # (Kart tarafındaki "iki banka geleneği" desenin aynısı.)
                _ham = sum(float(k.get("adet") or 0) for k in kl)
                _cev = 0.0
                for _k in kl:
                    _a = float(_k.get("adet") or 0)
                    _kd = _koli.get(_tr_buyut(str(_k.get("urun_ad") or _k.get("ad") or "")))
                    _cev += (_a / _kd) if (_kd and _a and _a % _kd == 0) else _a
                _siparisler.setdefault(en_yakin, []).append({
                    "ts_id": d["id"], "sube_adi": d.get("sube_adi"),
                    "siparis_ts": str(d.get("olusturma") or "")[:19],
                    "teslim_alindi": bool(d.get("teslim_ts")),
                    "adet_koli_cevrimli": round(_cev, 2),
                    "adet": round(_ham, 2),
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

        # 🏷️ İPTAL EDİLEN SİPARİŞLER — sebebi ADIYLA söylemek için (2026-08-25)
        # Sahip 19 hatalı siparişi iptal ettikten SONRA, o siparişlerin açıkladığı
        # faturalar "SİPARİŞSİZ GELEN MAL" görünmeye başladı. Etiket yanıltıcı:
        # ortada denetim boşluğu yok, sahibin KENDİ TEMİZLİK KARARININ izi var.
        # Duyu "siparişsiz" derse sahip bunu kontrol arızası sanır ve kendi
        # doğru kararını hata zanneder. Sebep adıyla söylenmeli.
        _iptalli: Dict[str, List[Dict]] = {}
        try:
            cur.execute(
                "SELECT ts.olusturma::date::text AS gun, "
                "       UPPER(COALESCE(ts.tedarikci_ad, td.ad, '')) AS ted_ad, "
                "       COALESCE(SUM(x.adet), 0) AS dummy "
                "  FROM toptanci_siparis ts "
                "  LEFT JOIN tedarikciler td ON td.id = ts.tedarikci_id "
                "  LEFT JOIN LATERAL (SELECT 0 AS adet) x ON TRUE "
                " WHERE COALESCE(ts.durum,'') = 'iptal' "
                "   AND ts.olusturma >= CURRENT_DATE - %s "
                " GROUP BY 1,2", (g + pen,))
            for r in (cur.fetchall() or []):
                r = dict(r)
                _iptalli.setdefault(r["ted_ad"], []).append(r["gun"])
        except Exception as _ei:  # noqa: BLE001
            logger.info("iptal sipariş bağlamı okunamadı: %s", str(_ei)[:90])

        sonuc: List[Dict] = []
        sayac = {"tutuyor": 0, "kayit_kapanmamis": 0, "siparissiz": 0,
                 "faturalanmamis_teslim": 0, "olculemez": 0, "sistem_oncesi": 0, "kanal_yok": 0}
        for f in faturalar:
            kayit: Dict[str, Any] = {
                "fatura_id": f["id"], "fatura_no": f["fatura_no"], "tarih": f["tarih"],
                "tedarikci_ad": f["tedarikci_ad"], "tutar": f["tutar"],
                "alim_kaynagi": f.get("alim_kaynagi") or None,
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
                # ⚠️ Kalem ÇEŞİDİ kıyası için TÜM siparişler gerekir; yalnız
                # açık olanlara bakmak teslim alınmış siparişi görmez ve
                # "kısmi fatura" teşhisi hiç tetiklenmez (METRO 11 Ağustos'ta
                # tam bu oldu: sipariş teslim alınmıştı, açık listesi boştu).
                "tum_siparisler": sip,
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
            _t_cev = round(sum(s2.get("adet_koli_cevrimli", s2["adet"])
                               for x in kume
                               for s2 in (x.get("tum_siparisler") or [])
                               if s2.get("teslim_alindi")), 2)
            fark = round(f_adet - t_adet, 2)
            _birim_notu = None
            if abs(f_adet - _t_cev) < abs(fark) - 0.5:
                # Koliye çevrilmiş sayım faturaya BELİRGİN daha yakın →
                # şube o kalemleri şişe/kutu saymış, fatura koli yazmış.
                _birim_notu = ("koli çevrimi uygulandı: ham %.0f → %.0f adet "
                               "(şube şişe/kutu saymış, fatura koli yazmış)"
                               % (t_adet, _t_cev))
                t_adet, fark = _t_cev, round(f_adet - _t_cev, 2)
            if abs(fark) <= 1:
                durum, guc = "TUTUYOR — dönem faturası ile teslim alınan aynı", None
            elif fark > 1 and acik:
                durum, guc = "MAL GELDİ, SİPARİŞ KAPANMADI", "GÜÇLÜ"
            elif fark > 1:
                _kim = _ayirt_edici(a["tedarikci_ad"])
                _yakin = []
                for _ad, _gns in _iptalli.items():
                    if not (_ayirt_edici(_ad) & _kim):
                        continue
                    for _gn in _gns:
                        try:
                            if abs(_gun_farki(a["tarih"], _gn)) <= pen:
                                _yakin.append(_gn)
                        except Exception:  # noqa: BLE001
                            continue
                _merkez = [x for x in kume if x.get("alim_kaynagi") == "merkez"]
                if _merkez and len(_merkez) == len(kume):
                    # 🏢 Sahip "bunu biz istedik" dedi — kontrol boşluğu YOK,
                    # kayıt boşluğu var. Bulgu SİLİNMEZ, adı değişir.
                    durum = ("MERKEZ ALIMI — sipariş paneli dışından, sahip onaylı")
                    guc = "BILGI"
                elif _yakin:
                    durum = ("SİPARİŞİ İPTAL EDİLDİ — mal geldi, sipariş kaydı "
                             "sonradan iptal edilmiş (%s)" % ", ".join(sorted(set(_yakin))[:3]))
                    guc = "BILGI"
                else:
                    durum, guc = "SİPARİŞSİZ GELEN MAL — dönemde karşılığı yok", "ORTA"
            else:
                # 🧩 KISMİ FATURA mı, BİRİM UYUŞMAZLIĞI mı? (2026-08-25)
                # METRO 11 Ağustos: sipariş 10 kalem / 905 adet, fatura 2 kalem /
                # 126 adet. Ortada birim sorunu YOK — fatura siparişin bir
                # BÖLÜMÜNÜ kapsıyor (tedarikçi parça parça sevk/fatura ediyor).
                # "Birim şüphesi" demek yanlış yere baktırır: sahip koli/adet
                # ararken asıl mesele eksik kalan faturalardır.
                # Ayırt edici: faturanın kalem ÇEŞİDİ siparişinkinden çok azsa
                # kısmi faturadır; çeşit benzer ama sayılar tutmuyorsa birim.
                _sip_cesit = 0
                for _x in kume:
                    for _s in (_x.get("tum_siparisler") or []):
                        _oz = (_s.get("ozet") or "").strip()
                        if _oz:
                            _sip_cesit = max(_sip_cesit, len(_oz.split("·")))
                _fat_cesit = sum(x["fatura_kalem"] for x in kume)
                if _fat_cesit and _sip_cesit and _fat_cesit < _sip_cesit:
                    durum = ("KISMİ FATURA — sipariş %d çeşit, fatura %d çeşit; "
                             "kalanı ayrı faturada olabilir" % (_sip_cesit, _fat_cesit))
                    guc = "ZAYIF"
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
                "birim_notu": _birim_notu, "acik_siparisler": acik,
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


@router.get("/siparis-patlamasi")
def siparis_patlamasi(gun: int = 200, saat: int = 6, en_az: int = 3):
    """💥 AYNI ŞUBE + AYNI TEDARİKÇİ, KISA SÜREDE ART ARDA SİPARİŞ. SALT OKUR.

    ── NEDEN (2026-08-24, sahip sorusu) ────────────────────────────────────
    TEMA 19 Ağustos'ta FEZ'e ~1 saat içinde 9 sipariş yolladı; yalnız 1'i teslim
    alındı, fatura hepsinin malını kapsıyordu. Sahip sordu: "Buna benzer,
    şubelerden sipariş verilip yönlendirme yapılmış mı? FATURA TARİHİNDEN
    ÖNCESİNE BAK."

    Bu uç tam onu arar: aynı şubenin aynı tedarikçiye KISA SÜREDE (varsayılan
    6 saat) verdiği ≥3 sipariş kümesini bulur ve kümenin kaçının teslim
    alındığını söyler. Küme, sonrasında kesilen İLK FATURAYLA eşleştirilir —
    çünkü zaman oku tek yönlüdür: mal önce sipariş edilir, sonra faturalanır.

    ── NEDEN "PATLAMA" ŞÜPHELİ ─────────────────────────────────────────────
    Tek bir alışveriş normalde TEK sipariştir. Dakikalar arayla açılan birden
    çok sipariş genelde ya panelde tekrar denemedir ya da liste parça parça
    girilmiştir. Sonuç aynı: mal tek seferde gelir, siparişlerin biri teslim
    alınır, geri kalanı sonsuza dek "açık" kalır ve tedarik zinciri kirlenir.

    ⚠️ ÖNERİ-ONLY. Patlama tek başına hata DEĞİLDİR — şube gerçekten üç ayrı
    şey sipariş etmiş olabilir. Bu yüzden karar verilmez; yalnız TESLİM ORANI
    ve sonraki fatura gösterilir, hüküm sahibindir.
    """
    g = max(1, min(730, int(gun or 200)))
    pen_saat = max(1, min(72, int(saat or 6)))
    esik = max(2, min(20, int(en_az or 3)))
    with db() as (_, cur):
        cur.execute(
            "SELECT ts.id, ts.olusturma, ts.teslim_ts, ts.kalemler, "
            "       COALESCE(ts.durum,'') AS durum, "
            "       COALESCE(ts.sube_id,'') AS sube_id, s.ad AS sube_adi, "
            "       UPPER(COALESCE(ts.tedarikci_ad, td.ad, '')) AS ted_ad "
            "  FROM toptanci_siparis ts "
            "  LEFT JOIN tedarikciler td ON td.id = ts.tedarikci_id "
            "  LEFT JOIN subeler s ON s.id = ts.sube_id "
            " WHERE ts.olusturma >= CURRENT_DATE - %s "
            " ORDER BY ts.sube_id, ted_ad, ts.olusturma",
            (g,),
        )
        satir = [dict(r) for r in (cur.fetchall() or [])]

        kumeler: List[Dict] = []
        i = 0
        while i < len(satir):
            a = satir[i]
            kume = [a]
            j = i + 1
            while j < len(satir):
                b = satir[j]
                if (b["sube_id"] != a["sube_id"]) or (b["ted_ad"] != a["ted_ad"]):
                    break
                try:
                    delta = (b["olusturma"] - kume[-1]["olusturma"]).total_seconds() / 3600.0
                except Exception:  # noqa: BLE001
                    break
                if delta > pen_saat:
                    break
                kume.append(b); j += 1
            if len(kume) >= esik:
                kumeler.append(kume)
            i = j if j > i + 1 else i + 1

        sonuc: List[Dict] = []
        for kume in kumeler:
            bas = kume[0]["olusturma"]
            son = kume[-1]["olusturma"]
            teslim = [x for x in kume if x["teslim_ts"]]
            iptal = [x for x in kume if x["durum"] == "iptal"]
            acik = [x for x in kume if not x["teslim_ts"] and x["durum"] != "iptal"]
            # ⏳ SONRAKİ FATURA — zaman oku tek yönlü: fatura kümeden SONRA gelir
            fatura = None
            cur.execute(
                "SELECT f.fatura_no, f.fatura_tarih::text AS tarih, f.tedarikci_ad, "
                "       COALESCE(f.toplam_tutar,0)::float AS tutar "
                "  FROM tedarikci_fatura f "
                " WHERE f.fatura_tarih >= %s::date AND f.fatura_tarih <= %s::date + 15 "
                " ORDER BY f.fatura_tarih",
                (str(bas)[:10], str(son)[:10]),
            )
            for c in (cur.fetchall() or []):
                c = dict(c)
                if _ayirt_edici(c["tedarikci_ad"] or "") & _ayirt_edici(kume[0]["ted_ad"]):
                    fatura = c
                    break
            toplam_adet = 0.0
            for x in kume:
                toplam_adet += sum(float(k.get("adet") or 0)
                                   for k in _kalem_listesi(x.get("kalemler")))
            sonuc.append({
                "sube_adi": kume[0]["sube_adi"], "tedarikci_ad": kume[0]["ted_ad"],
                "ilk_siparis": str(bas)[:19], "son_siparis": str(son)[:19],
                "sure_dakika": round((son - bas).total_seconds() / 60.0, 1),
                "siparis_sayisi": len(kume), "toplam_adet": round(toplam_adet, 2),
                "teslim_alinan": len(teslim), "iptal_edilen": len(iptal),
                "hala_acik": len(acik),
                "sonraki_fatura": fatura,
                "siparisler": [{
                    "ts_id": x["id"], "ts": str(x["olusturma"])[:19],
                    "durum": ("teslim alındı" if x["teslim_ts"]
                              else "iptal" if x["durum"] == "iptal" else "AÇIK"),
                    "ozet": " · ".join(
                        str(k.get("urun_ad") or k.get("ad") or "?") + " ×" + str(k.get("adet"))
                        for k in _kalem_listesi(x.get("kalemler"))[:4]),
                } for x in kume],
            })
        sonuc.sort(key=lambda x: (-x["hala_acik"], x["ilk_siparis"]), reverse=False)
        sonuc.sort(key=lambda x: x["hala_acik"], reverse=True)
    return {
        "gun": g, "pencere_saat": pen_saat, "esik": esik,
        "patlama_sayisi": len(sonuc),
        "hala_acik_toplam": sum(x["hala_acik"] for x in sonuc),
        "patlamalar": sonuc,
        "not": ("ÖNERİ-ONLY. Aynı şube + aynı tedarikçi, %d saat içinde ≥%d sipariş. "
                "Patlama TEK BAŞINA HATA DEĞİLDİR — şube gerçekten birkaç ayrı şey "
                "sipariş etmiş olabilir. Şüpheyi doğuran, kümenin çoğunun TESLİM "
                "ALINMAMASI ve sonrasında hepsini kapsayan tek fatura gelmesidir. "
                "Zaman oku tek yönlü kuruldu: fatura kümeden SONRA aranır."
                % (pen_saat, esik)),
    }


# ═══════════════════════════════════════════════════════════════════════════
# 📅 HAFTALIK ÖLÇÜM — "hatırlatma işe yaradı mı?" sorusunun RAKAMLA cevabı
# ═══════════════════════════════════════════════════════════════════════════
def _olcum_tablo(cur) -> None:
    """İZOLE + APPEND-ONLY ölçüm defteri. Hiçbir mevcut tabloya dokunmaz."""
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tedarik_haftalik_olcum (
            id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            olcum_tarihi  DATE NOT NULL,
            acik_siparis  INT  NOT NULL DEFAULT 0,
            en_eski_gun   INT,
            patlama       INT  NOT NULL DEFAULT 0,
            sube_kirilim  JSONB,
            olculebilen   INT,
            olculemeyen   INT,
            mal_geldi_kapanmadi INT,
            olusturma     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (olcum_tarihi)
        )
    """)


def haftalik_olcum_al(yaz: bool = False) -> Dict[str, Any]:
    """Tedarik zincirinin O ANKİ sağlık rakamlarını üretir; `yaz=True` ise deftere işler.

    ── NEDEN (2026-08-24) ──────────────────────────────────────────────────
    11 açık sipariş temizlendi ve şubelere hatırlatma gönderildi. Ama liste
    temizlemek ALIŞKANLIĞI değiştirmez — ZAFER aynı hatayı dört kez üst üste
    yapmıştı. "Hatırlatma işe yaradı mı?" sorusunun tek dürüst cevabı RAKAMDIR.
    Bu yüzden ölçüm HAFTALIK ve APPEND-ONLY saklanır: bugünkü sayı tek başına
    bir şey söylemez, EĞİLİM söyler.

    ⚠️ Bu fonksiyon yalnız kendi izole tablosuna yazar; başka hiçbir kayda
    dokunmaz. Hata durumunda çağıran tarafın akışını bozmaz (scheduler yutar).
    """
    from datetime import date as _d
    with db() as (_, cur):
        cur.execute(
            "SELECT ts.id, ts.olusturma::date::text AS gun, s.ad AS sube_adi, "
            "       UPPER(COALESCE(ts.tedarikci_ad, td.ad, '')) AS ted_ad "
            "  FROM toptanci_siparis ts "
            "  LEFT JOIN tedarikciler td ON td.id = ts.tedarikci_id "
            "  LEFT JOIN subeler s ON s.id = ts.sube_id "
            " WHERE ts.teslim_ts IS NULL AND COALESCE(ts.durum,'') <> 'iptal' "
            "   AND ts.olusturma >= CURRENT_DATE - 400"
        )
        acik = [dict(r) for r in (cur.fetchall() or [])]
    bugun = _d.today()
    yaslar = []
    kirilim: Dict[str, int] = {}
    for a in acik:
        kirilim[a["sube_adi"] or "?"] = kirilim.get(a["sube_adi"] or "?", 0) + 1
        try:
            yaslar.append((bugun - _d.fromisoformat(a["gun"])).days)
        except Exception:  # noqa: BLE001
            pass
    pat = siparis_patlamasi(gun=30)
    mut = fatura_teslim_mutabakati(gun=60)
    try:
        mkz = merkez_kayit_boslugu(gun=60)
    except Exception:  # noqa: BLE001
        mkz = {}
    olcum = {
        "olcum_tarihi": str(bugun),
        "acik_siparis": len(acik),
        "en_eski_gun": (max(yaslar) if yaslar else None),
        "patlama": pat.get("patlama_sayisi", 0),
        "sube_kirilim": kirilim,
        "olculebilen": mut.get("olculebilen"),
        "olculemeyen": mut.get("olculemeyen"),
        "mal_geldi_kapanmadi": sum(
            1 for x in mut.get("donemler", []) if x.get("kanit_gucu") == "GÜÇLÜ"),
        # 🏢 Merkez alımı sistemden geçiyor mu? Damga geçmişi kapatır ama boşluğu
        # kapatmaz; bu sayı artıyorsa akış kullanılmıyor demektir.
        "merkez_sistemden_gecmeyen": mkz.get("sistemden_gecmeyen_alim"),
    }
    if yaz:
        with db() as (_, cur):
            _olcum_tablo(cur)
            cur.execute(
                "INSERT INTO tedarik_haftalik_olcum "
                "(olcum_tarihi, acik_siparis, en_eski_gun, patlama, sube_kirilim, "
                " olculebilen, olculemeyen, mal_geldi_kapanmadi) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s) "
                # Aynı gün iki kez çalışırsa (restart) ikinci kayıt açılmaz,
                # GÜNCELLENİR — ölçüm defteri tekil kalır.
                "ON CONFLICT (olcum_tarihi) DO UPDATE SET "
                "  acik_siparis=EXCLUDED.acik_siparis, en_eski_gun=EXCLUDED.en_eski_gun, "
                "  patlama=EXCLUDED.patlama, sube_kirilim=EXCLUDED.sube_kirilim, "
                "  olculebilen=EXCLUDED.olculebilen, olculemeyen=EXCLUDED.olculemeyen, "
                "  mal_geldi_kapanmadi=EXCLUDED.mal_geldi_kapanmadi",
                (olcum["olcum_tarihi"], olcum["acik_siparis"], olcum["en_eski_gun"],
                 olcum["patlama"], json.dumps(kirilim, ensure_ascii=False),
                 olcum["olculebilen"], olcum["olculemeyen"], olcum["mal_geldi_kapanmadi"]),
            )
    return olcum


@router.get("/haftalik-ozet")
def haftalik_ozet(hafta: int = 12):
    """📅 Tedarik zinciri sağlık eğilimi + bugünkü durum. SALT OKUR."""
    h = max(2, min(52, int(hafta or 12)))
    with db() as (_, cur):
        _olcum_tablo(cur)
        cur.execute(
            "SELECT olcum_tarihi::text AS tarih, acik_siparis, en_eski_gun, patlama, "
            "       sube_kirilim, olculebilen, olculemeyen, mal_geldi_kapanmadi "
            "  FROM tedarik_haftalik_olcum ORDER BY olcum_tarihi DESC LIMIT %s", (h,))
        gecmis = [dict(r) for r in (cur.fetchall() or [])]
    simdi = haftalik_olcum_al(yaz=False)
    yon = None
    if gecmis:
        onceki = gecmis[0]["acik_siparis"]
        fark = simdi["acik_siparis"] - onceki
        yon = ("İYİLEŞİYOR" if fark < 0 else "KÖTÜLEŞİYOR" if fark > 0 else "DEĞİŞMEDİ")
        simdi["onceki_olcume_gore"] = fark
    return {
        "simdi": simdi, "yon": yon, "gecmis": gecmis, "olcum_sayisi": len(gecmis),
        "not": ("Bugünkü sayı tek başına bir şey söylemez, EĞİLİM söyler. "
                "2026-08-24'te 11 açık sipariş temizlenip şubelere hatırlatma "
                "gönderildi; bu defter o hatırlatmanın işe yarayıp yaramadığını "
                "rakamla gösterir. Ölçüm her pazartesi gece otomatik işlenir."),
    }


@router.post("/haftalik-olc")
def haftalik_olc_simdi():
    """Ölçümü ELLE al ve deftere işle (scheduler'ı beklemeden)."""
    return {"success": True, "olcum": haftalik_olcum_al(yaz=True)}


@router.get("/ocr-kapsama")
def ocr_kapsama(gun: int = 200):
    """🔬 KALEM KAPSAMA TEŞHİSİ — hangi fatura NEDEN kalem düzeyinde okunamıyor?

    ── NEDEN (2026-08-25) ──────────────────────────────────────────────────
    Fatura↔teslim mutabakatı 25 faturanın 9'unu "ölçülemez" saydı. "OCR'ı
    iyileştir" demek kolay; ama NEYİN eksik olduğunu bilmeden dokunmak
    körlemedir. Kartlarda Axess'i çözen şey de buydu: önce "PDF'ten 0 satır
    okunuyor" tespiti, sonra sebep (EBCDIC), sonra çözüm.

    Bir faturanın kalemi yoksa sebebi ŞUNLARDAN BİRİDİR ve hepsinin çaresi ayrı:
      BELGE YOK          ne foto ne PDF metni var → okunacak bir şey yok
      OCR HİÇ ÇALIŞMAMIŞ durum hâlâ 'ocr_bekliyor' → kuyrukta takılı
      OCR HATA VERMİŞ    ocr_hata dolu → hata metni çözümü söyler
      OCR BOŞ DÖNMÜŞ     durum 'ocr_tamam' ama kalem 0 → okuyucu okuyamamış
      TUTAR DA YOK       toplam_tutar 0 → belge muhtemelen okunamaz halde

    ⚠️ SALT OKUR. Hiçbir OCR tetiklenmez, hiçbir kayıt değişmez.
    """
    g = max(1, min(730, int(gun or 200)))
    with db() as (_, cur):
        _capa_kolonu(cur)
        cur.execute(
            "SELECT f.id, f.tedarikci_ad, f.fatura_no, f.fatura_tarih::text AS tarih, "
            "       COALESCE(f.toplam_tutar,0)::float AS tutar, f.durum, "
            "       (f.foto IS NOT NULL) AS foto_var, "
            "       (COALESCE(f.kaynak_metin,'') <> '') AS metin_var, "
            "       LEFT(COALESCE(f.ocr_hata,''), 160) AS ocr_hata, "
            "       COALESCE(f.belge_turu,'') AS belge_turu, "
            "       COALESCE(f.kalem_capa_farki,0)::float AS capa_farki, "
            "       COUNT(k.id) AS kalem "
            "  FROM tedarikci_fatura f "
            "  LEFT JOIN tedarikci_fatura_kalem k ON k.fatura_id = f.id "
            " WHERE f.fatura_tarih >= CURRENT_DATE - %s "
            "   AND COALESCE(f.durum,'') <> 'kopya' "   # ikinci nüsha OCR derdi değildir
            " GROUP BY f.id, f.tedarikci_ad, f.fatura_no, f.fatura_tarih, "
            "          f.toplam_tutar, f.durum, f.foto, f.kaynak_metin, f.ocr_hata, "
            "          f.belge_turu, f.kalem_capa_farki "
            " ORDER BY f.fatura_tarih DESC", (g,))
        rows = [dict(r) for r in (cur.fetchall() or [])]

    kalemsiz, sayac = [], {}
    for r in rows:
        if int(r["kalem"] or 0) > 0:
            # ⚓ KALEMİ VAR AMA EKSİK OLABİLİR: belge toplamı ile kalem toplamı
            # tutmuyorsa satır okunmamıştır. Eskiden "kalemi var" diye tam
            # sayılıyordu ve tedarik ölçümü bunu "KISMİ FATURA" sanıyordu —
            # oysa fatura tamdı, OKUMA kısmiydi.
            # ⚖️ KDV YORUMU ÖNCE DENENİR (2026-08-25, ilk taramadan sonra)
            # İlk sürüm 21 fatura işaretledi. Rakamlara bakınca çoğu EKSİK SATIR
            # DEĞİL, KDV farkıydı: kalem toplamı KDV-HARİÇ, belge toplamı
            # KDV-DAHİL yazılmış. ESHİM 20.400/17.000 = 1,20 → tam KDV %20;
            # AKALIN 684/621,82 = 1,10 → KDV %10.
            # Bu ayrım yapılmazsa 15+ sahte alarm, aradaki 3 GERÇEK eksik okumayı
            # (METRO ×2, D-MARKET) gömer — bugün defalarca yaşadığımız kalıp.
            _belge = abs(float(r["tutar"] or 0))
            _kalem = _belge - float(r.get("capa_farki") or 0)
            _kdv_uyum = False
            if _kalem > 0:
                _oran = _belge / _kalem
                for _r2 in (1.01, 1.08, 1.10, 1.18, 1.20):
                    if abs(_oran - _r2) < 0.006:      # ±%0,6 yuvarlama payı
                        _kdv_uyum = True
                        break
            _cf = abs(float(r.get("capa_farki") or 0))
            _tol = max(5.0, abs(float(r["tutar"] or 0)) * 0.02)
            if _cf > _tol and not _kdv_uyum:
                # ⚖️ İKİ AYRI ARIZA, İKİ AYRI ÇARE (2026-08-25):
                # belge > kalem → SATIR ATLANMIŞ (okuma eksik)
                # kalem > belge → AYNI SATIR İKİ KEZ okunmuş ya da belge toplamı
                #                 yanlış okunmuş. Bunu "eksik" diye adlandırmak
                #                 yanlış yere baktırır: kimse olmayan satırı aramaz.
                if _kalem > _belge:
                    _sebep = "KALEM FAZLA OKUNMUŞ"
                    _care = ("Okunan kalemler (%.2f ₺) belge toplamından (%.2f ₺) "
                             "FAZLA — aynı satır iki kez okunmuş ya da belge toplamı "
                             "yanlış okunmuş olabilir. Belgenin aslına bakılmalı."
                             % (_kalem, _belge))
                else:
                    _sebep = "KALEM OKUMASI EKSİK"
                    _care = ("Belge %.2f ₺, okunan kalemler %.2f ₺ — aradaki %.2f ₺ "
                             "hiçbir KDV oranıyla açıklanmıyor, satır okunmamış. "
                             "Gece kurtarması yeniden okuyacak."
                             % (_belge, _kalem, _cf))
                sayac[_sebep] = sayac.get(_sebep, 0) + 1
                kalemsiz.append({**{k: v for k, v in r.items() if k != "kalem"},
                                 "sebep": _sebep, "care": _care})
            continue
        if not r["foto_var"] and not r["metin_var"]:
            sebep, care = "BELGE YOK", "Faturanın PDF/foto aslı sisteme yüklenmeli."
        elif str(r["durum"] or "") == "ocr_bekliyor":
            sebep, care = "OCR HİÇ ÇALIŞMAMIŞ", "Kuyrukta takılı — /api/fatura/ocr-takilanlari-dene"
        elif (r["ocr_hata"] or "").strip():
            sebep, care = "OCR HATA VERMİŞ", "Hata metni çözümü söyler; sebebe göre düzeltilir."
        elif str(r.get("belge_turu") or "") == "irsaliye":
            # ✅ İRSALİYEDE FİYAT YOKTUR — 0,00 doğrudur, OCR arızası değildir.
            # Bu satır olmadan teşhis her irsaliyeyi "okunamadı" diye suçluyordu.
            sebep, care = ("İRSALİYE — kalem düzeyi ölçüm gerekmez",
                           "Belge bir irsaliyedir; fiyat taşımaz. Faturası ayrıca aranır.")
        elif float(r["tutar"] or 0) <= 0:
            sebep, care = "TUTAR DA OKUNAMAMIŞ", "Belge muhtemelen okunamaz halde (bulanık/eksik sayfa)."
        else:
            sebep, care = ("OCR BOŞ DÖNMÜŞ",
                           "Tutar okundu ama kalem tablosu çıkarılamadı — "
                           "kalem parser'ı bu fatura biçimini tanımıyor.")
        sayac[sebep] = sayac.get(sebep, 0) + 1
        kalemsiz.append({**{k: v for k, v in r.items() if k != "kalem"},
                         "sebep": sebep, "care": care})
    # 🔎 KAYNAK KIRILIMI — "fotoğraf yolu çalışıyor mu?" sorusunun cevabı
    # (2026-08-25): Bir faturanın kalemi yoksa suç okuyucuda mı yoksa o tek
    # belgede mi? Ayrım şuradan çıkar: FOTOĞRAFTAN okunmuş kalemli fatura VAR MI
    # ve EN SONU NE ZAMAN? Yoksa/eskiyse vision yolu topyekûn bozuktur —
    # personel fatura fotoğrafı çektiği için bu sessiz kalırsa büyük kayıptır.
    def _kaynak(r):
        return ("pdf" if r["metin_var"] and not r["foto_var"]
                else "foto" if r["foto_var"] and not r["metin_var"]
                else "ikisi" if r["foto_var"] else "kaynak_yok")
    kaynak_ozet: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        k = _kaynak(r)
        b = kaynak_ozet.setdefault(k, {"toplam": 0, "kalemli": 0, "son_kalemli_tarih": None})
        b["toplam"] += 1
        if int(r["kalem"] or 0) > 0:
            b["kalemli"] += 1
            t = str(r["tarih"] or "")
            if t and (b["son_kalemli_tarih"] is None or t > b["son_kalemli_tarih"]):
                b["son_kalemli_tarih"] = t
    return {
        "gun": g, "fatura_toplam": len(rows),
        "kalemli": sum(1 for r in rows if int(r["kalem"] or 0) > 0),
        "kaynak_ozet": kaynak_ozet,
        "kalemsiz": len(kalemsiz), "sebep_kirilimi": sayac,
        "satirlar": kalemsiz,
        "not": ("SALT OKUR — hiçbir OCR tetiklenmedi. Her sebebin ÇARESİ AYRIDIR; "
                "'OCR'ı iyileştir' tek bir iş değildir. Kalemsiz fatura kalem "
                "düzeyinde ölçülemez ama TUTARI biliniyorsa borç zinciri sağlamdır — "
                "eksik olan denetim derinliğidir, para değil."),
    }


@router.get("/urun-sozlugu")
def urun_sozlugu(tedarikci: str = "", gun: int = 400, en_az: int = 1):
    """📖 TEDARİKÇİ ÜRÜN SÖZLÜĞÜ — okunmuş faturalardan ÖĞRENİLİR. SALT OKUR.

    ── NEDEN (2026-08-25, sahip fikri) ─────────────────────────────────────
    Sahip: "FEZ, MEHMET ATALAY, SÜTAŞ, su gibi tedarikçilerde kalemler sürekli
    belli; kendi kodumuzu yazarsak LLM'e bağımlılığı azaltırız."
    Doğru — ve zaten sistemin doktrini bu ("PDF okumasını kendi yapsın,
    yapamadığını yapay zekâdan destek alsın", 2026-07-18).

    ⚠️ AMA SINIRI BAŞTAN YAZALIM: kendi kodumuz FOTOĞRAFTAN METİN çıkaramaz —
    o iş bir OCR motoru ister. Kendi kodun kazandığı yer BAŞKA ve daha değerli:
    ZATEN OKUNMUŞ faturalardan tedarikçi bazlı ürün sözlüğü öğrenmek. Sözlük
    olunca:
      · bilinen kalem LLM'siz tanınır (determinizm + kota tasarrufu)
      · birim fiyat bilindiği için satır toplamı DOĞRULANABİLİR
      · sipariş adı ("Lime") ile fatura adı ("FO MİSKET LİMON…") arasına köprü
        kurulur → mutabakat ADET düzeyinden KALEM düzeyine çıkar
      · fiyat değişimi (zam) kendiliğinden görünür

    Bu uç sözlüğün KENDİSİ ve aynı zamanda FİZİBİLİTE ÖLÇÜMÜDÜR: desen gerçekten
    kararlı mı? `tekrar` sütunu 1'de yığılıyorsa öğrenilecek desen yok demektir
    ve bu iş yapılmamalıdır. Ölçmeden inşa etmek, kartlarda kaçındığımız hatanın
    ta kendisi olurdu.
    """
    g = max(1, min(730, int(gun or 400)))
    esik = max(1, min(20, int(en_az or 1)))
    t = (tedarikci or "").strip()
    with db() as (_, cur):
        kos = ["f.fatura_tarih >= CURRENT_DATE - %s", "COALESCE(f.durum,'') <> 'kopya'"]
        par: List[Any] = [g]
        if t:
            kos.append("f.tedarikci_ad ILIKE %s")
            par.append("%" + t + "%")
        cur.execute(
            "SELECT f.tedarikci_ad, k.ocr_ad, k.adet::float AS adet, "
            "       k.birim_fiyat::float AS birim_fiyat, "
            "       k.satir_toplam::float AS satir_toplam, "
            "       f.fatura_tarih::text AS tarih, f.id AS fatura_id "
            "  FROM tedarikci_fatura_kalem k "
            "  JOIN tedarikci_fatura f ON f.id = k.fatura_id "
            " WHERE " + " AND ".join(kos) +
            "   AND COALESCE(k.ocr_ad,'') <> '' "
            " ORDER BY f.fatura_tarih", tuple(par))
        satir = [dict(r) for r in (cur.fetchall() or [])]

    # Karşı taraf kimliği: ayırt edici kelimelerin birleşimi (FEZ/ATALAY/SÜTAŞ…)
    _harita = _kanonik_harita()

    def _kimlik(ad: str) -> str:
        a = _ayirt_edici(_kanonik_ad(ad, _harita))
        return " ".join(sorted(a)) if a else (ad or "?").upper()[:20]

    def _urun_normal(ad: str) -> str:
        """Ürün adını sözlük anahtarına indirger.

        ⚠️ KESİK AD İKİ ÜRÜN SANILIYORDU (2026-08-25 canlı): FEZ'de
          "FO TOFFEE KARAMEL PROF.SOS (BAR SOS) 2500 GR"    → 680 ₺ (3 kez)
          "FO TOFFEE KARAMEL PROF.SOS (BAR SOS) 2500 GR *"  → 860 ₺ (4 kez)
        aynı ürün. OCR kimi faturada koli çarpanını ("*6") yazmış kimi yazmamış,
        kimi de satır sonundan kesmiş. Ayrı sayılınca hem sözlük şişiyor hem
        ZAM GÖRÜNMÜYOR — 680→860 aynı ürünün zammıyken iki farklı ürün gibi
        duruyordu. Sondaki koli çarpanı ve noktalama atılır; ayrıca aşağıda
        biri diğerinin ÖN EKİ olan adlar tek kayda katlanır.
        """
        t = re.sub(r"\s+", " ", (ad or "")).strip().upper()
        t = re.sub(r"[\*\-,.;:]+\s*\d*\s*$", "", t).strip()   # sondaki "*6", "*", "."
        return t

    sozluk: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for s in satir:
        kim = _kimlik(s["tedarikci_ad"])
        ad = _urun_normal(s["ocr_ad"])
        b = sozluk.setdefault(kim, {}).setdefault(ad, {
            "urun": str(s["ocr_ad"]).strip(), "tekrar": 0, "fatura": set(),
            "adetler": [], "fiyatlar": [], "ilk": None, "son": None})
        b["tekrar"] += 1
        b["fatura"].add(s["fatura_id"])
        if s["adet"]:
            b["adetler"].append(float(s["adet"]))
        bf = s["birim_fiyat"]
        if not bf and s["satir_toplam"] and s["adet"]:
            bf = float(s["satir_toplam"]) / float(s["adet"])   # türetilebiliyorsa türet
        if bf:
            b["fiyatlar"].append((s["tarih"], round(float(bf), 4)))
        if b["ilk"] is None or (s["tarih"] and s["tarih"] < b["ilk"]):
            b["ilk"] = s["tarih"]
        if b["son"] is None or (s["tarih"] and s["tarih"] > b["son"]):
            b["son"] = s["tarih"]

    # ÖN EK KATLAMA — "…2500 GR" ile "…2500 GR EKSTRA" ayrı ürün olabilir ama
    # OCR kesmesi de aynı görünür. Ölçüt: kısa ad en az 18 karakterse ve uzun ad
    # onunla BAŞLIYORSA aynı ürün sayılır (kesme, ürün adının ortasından olmaz).
    for kim, urunler in list(sozluk.items()):
        adlar = sorted(urunler.keys(), key=len)
        for i, kisa in enumerate(adlar):
            if kisa not in urunler or len(kisa) < 18:
                continue
            for uzun in adlar[i + 1:]:
                if uzun in urunler and uzun != kisa and uzun.startswith(kisa):
                    a, b = urunler[kisa], urunler.pop(uzun)
                    a["tekrar"] += b["tekrar"]
                    a["fatura"] |= b["fatura"]
                    a["adetler"] += b["adetler"]
                    a["fiyatlar"] += b["fiyatlar"]
                    if b["ilk"] and (not a["ilk"] or b["ilk"] < a["ilk"]):
                        a["ilk"] = b["ilk"]
                    if b["son"] and (not a["son"] or b["son"] > a["son"]):
                        a["son"] = b["son"]
        for b in urunler.values():
            b["fiyatlar"].sort(key=lambda p: p[0] or "")   # tarih sırası → zam doğru

    cikti, ozet = [], []
    for kim, urunler in sozluk.items():
        kalemler = []
        for ad, b in urunler.items():
            if b["tekrar"] < esik:
                continue
            fy = [p for _, p in b["fiyatlar"]]
            zam = None
            if len(fy) >= 2 and min(fy) > 0:
                ilk_f = b["fiyatlar"][0][1]; son_f = b["fiyatlar"][-1][1]
                if ilk_f > 0 and abs(son_f - ilk_f) / ilk_f > 0.005:
                    zam = {"ilk": ilk_f, "son": son_f,
                           "yuzde": round((son_f - ilk_f) / ilk_f * 100, 1)}
            kalemler.append({
                "urun": b["urun"], "tekrar": b["tekrar"],
                "fatura_sayisi": len(b["fatura"]),
                "tipik_adet": (max(set(b["adetler"]), key=b["adetler"].count)
                               if b["adetler"] else None),
                "son_birim_fiyat": (fy[-1] if fy else None),
                "fiyat_min": (min(fy) if fy else None),
                "fiyat_max": (max(fy) if fy else None),
                "zam": zam, "ilk_gorulme": b["ilk"], "son_gorulme": b["son"],
            })
        if not kalemler:
            continue
        kalemler.sort(key=lambda x: -x["tekrar"])
        tekrarli = sum(1 for k in kalemler if k["tekrar"] >= 2)
        cikti.append({
            "karsi_taraf": kim, "farkli_urun": len(kalemler),
            "tekrar_eden_urun": tekrarli,
            "kararlilik_yuzde": (round(tekrarli / len(kalemler) * 100, 1) if kalemler else 0),
            "kalemler": kalemler,
        })
        ozet.append({"karsi_taraf": kim, "farkli_urun": len(kalemler),
                     "tekrar_eden": tekrarli,
                     "kararlilik_yuzde": (round(tekrarli / len(kalemler) * 100, 1)
                                          if kalemler else 0)})
    cikti.sort(key=lambda x: -x["farkli_urun"])
    ozet.sort(key=lambda x: -x["farkli_urun"])
    return {
        "gun": g, "kalem_satiri": len(satir), "karsi_taraf_sayisi": len(cikti),
        "ozet": ozet, "sozluk": cikti,
        "not": ("SALT OKUR — öğrenilen sözlük, yazılmış bir kayıt değildir. "
                "`kararlilik_yuzde` bu işin FİZİBİLİTESİDİR: bir tedarikçide "
                "ürünlerin çoğu yalnız BİR kez görülmüşse öğrenilecek desen yoktur "
                "ve o tedarikçi için kendi parser'ımızı yazmak boşa emektir. "
                "Ölçmeden inşa etmek, kart tarafında kaçındığımız hatanın aynısı olur."),
    }


# ═══════════════════════════════════════════════════════════════════════════
# 🌉 KALEM KÖPRÜSÜ — sipariş adı ↔ fatura adı
# ═══════════════════════════════════════════════════════════════════════════
# ⚠️ DOLGU LİSTESİ DAR TUTULUR — BİÇİM KELİMESİ AYIRT EDİCİDİR (2026-08-25)
# İlk sürümde "SOS", "TOZU", "PÜRE", "ŞURUP" da dolgu sayılıp atılmıştı. Sonuç:
#   "Çikolata Sos" → "FO ÇİKOLATA AROMALI İÇECEK TOZU"   ❌ YANLIŞ, üstelik YÜKSEK güvenle
# çünkü geriye yalnız {ÇİKOLATA} kaldı ve sos ile tozu ayıran kelime silinmişti.
# Emin görünen yanlış cevap, kararsız görünen doğru cevaptan zararlıdır.
# Bu katalogda ürünün BİÇİMİ (şurup / sos / toz / püre) tam da ayırt edici
# eksendir. Dolguda YALNIZ gerçekten hiçbir şey ayırt etmeyenler kalır:
# marka öneki, ölçü birimi, ambalaj sözcükleri.
_URUN_DOLGU = {
    "FO", "AROMALI", "PROF", "BAR", "ADET", "KOLI",
    "GR", "ML", "KG", "LT", "URUN", "TL", "PAKET",
}


def _tr_buyut(s: str) -> str:
    """Türkçe-güvenli BÜYÜTME + aksan sadeleştirme.

    ⚠️ Türkçe-I tuzağı (defterde kayıtlı): 'i'.upper() Python'da 'I' verir ama
    Türkçede 'İ'dir. Karşılaştırmayı bozmamak için harfler tek bir sadeleştirilmiş
    alfabeye indirgenir — 'İ' ile 'I', 'Ş' ile 'S' aynı sayılır.
    """
    t = (s or "").upper()
    for a, b in (("İ", "I"), ("Ş", "S"), ("Ğ", "G"), ("Ü", "U"),
                 ("Ö", "O"), ("Ç", "C"), ("Â", "A")):
        t = t.replace(a, b)
    return t


def _urun_belirtec(ad: str) -> set:
    """Ürün adından AYIRT EDİCİ kelimeler (dolgu sözcükleri atılmış).

    "FO YEŞİL ELMA AROMALI ŞURUP 700 ML *6" → {YESIL, ELMA}
    "Yeşil Elma"                             → {YESIL, ELMA}
    Dolgular atılmazsa her şurup her şurupla eşleşir (hepsinde AROMALI ŞURUP var)
    ve köprü çöpe döner.
    """
    t = _tr_buyut(ad)
    dolgu = {_tr_buyut(x) for x in _URUN_DOLGU}
    return {w for w in re.split(r"[^A-Z0-9]+", t)
            if len(w) >= 3 and not w.isdigit() and w not in dolgu}


@router.get("/kalem-koprusu")
def kalem_koprusu(tedarikci: str = "", gun: int = 400,
                  pencere: int = VARSAYILAN_PENCERE):
    """🌉 SİPARİŞ ADI ↔ FATURA ADI köprüsü — veriden ÖĞRENİLİR. SALT OKUR, ÖNERİ-ONLY.

    ── NEDEN (2026-08-25) ──────────────────────────────────────────────────
    Fatura↔teslim mutabakatı bugüne dek yalnız ADET üzerinden konuşuyordu:
    "42 adet fark var". Sahibin duymak istediği ise "HANGİ ÜRÜN eksik".
    Engel şuydu: aynı ürün iki dünyada bambaşka yazılıyor —
        sipariş : "Lime"      fatura : "FO MİSKET LİMON AROMALI ŞURUP 700 ML *6"
    Ortak tek kelime bile yok; bu yüzden çapa ADET seçilmişti (doğru karardı).
    Ürün sözlüğü öğrenildiğine göre artık köprü kurulabilir.

    ── İKİ KANIT, BİRLİKTE ─────────────────────────────────────────────────
    1) AD BENZERLİĞİ — birçok çift ortak kelime TAŞIR:
         "Yeşil Elma" ↔ "FO YEŞİL ELMA AROMALI ŞURUP" → {YESIL, ELMA}
       Dolgu sözcükleri (FO, AROMALI, ŞURUP, GR, ML…) atılır.
    2) BİRLİKTE GÖRÜLME + ADET UYUMU — "Lime ↔ MİSKET LİMON" gibi hiç ortak
       kelimesi olmayan çiftler ancak buradan çıkar: aynı dönemde ikisi de var
       ve ADETLERİ tutuyorsa tesadüf değildir; birçok dönemde tekrarlıyorsa hiç
       değildir.

    Tek başına ad YANILTIR (çilek şurubu ↔ çilek püresi); tek başına adet de
    YANILTIR (aynı dönemde iki kalem de ×12 olabilir). Güç ikisinin
    BİRLEŞİMİNDEDİR — güven oradan üretilir ve gerekçesi açıkça yazılır.

    ⚠️ ÖNERİ-ONLY: hiçbir eşleştirme kaydedilmez. Köprü yanlışsa üretilecek
    "şu ürün eksik" cümlesi de yanlış olur; o yüzden hüküm sahibindir.
    """
    g = max(1, min(730, int(gun or 400)))
    pen = max(1, min(45, int(pencere or VARSAYILAN_PENCERE)))
    t = (tedarikci or "").strip()
    with db() as (_, cur):
        kos = ["f.fatura_tarih >= CURRENT_DATE - %s",
               "COALESCE(f.durum,'') <> 'kopya'",
               "f.fatura_tarih >= %s::date"]
        par: List[Any] = [g, SISTEM_BASLANGIC]
        if t:
            kos.append("f.tedarikci_ad ILIKE %s")
            par.append("%" + t + "%")
        cur.execute(
            "SELECT f.id, f.tedarikci_ad, f.fatura_tarih::text AS tarih "
            "  FROM tedarikci_fatura f WHERE " + " AND ".join(kos) +
            " ORDER BY f.fatura_tarih", tuple(par))
        faturalar = [dict(r) for r in (cur.fetchall() or [])]
        if not faturalar:
            return {"tedarikci": t or "(hepsi)", "adet": 0, "koprular": [],
                    "not": "Bu aralıkta ölçülebilir fatura yok (HATA ≠ BOŞ)."}

        cur.execute(
            "SELECT fatura_id, ocr_ad, adet::float AS adet "
            "  FROM tedarikci_fatura_kalem "
            " WHERE fatura_id = ANY(%s) AND COALESCE(ocr_ad,'') <> ''",
            ([f["id"] for f in faturalar],))
        fk: Dict[str, List[Dict]] = {}
        for r in (cur.fetchall() or []):
            r = dict(r)
            fk.setdefault(r["fatura_id"], []).append(r)

        cur.execute(
            "SELECT ts.olusturma::date::text AS gun, ts.kalemler, "
            "       UPPER(COALESCE(ts.tedarikci_ad, td.ad, '')) AS ted_ad "
            "  FROM toptanci_siparis ts "
            "  LEFT JOIN tedarikciler td ON td.id = ts.tedarikci_id "
            " WHERE ts.olusturma >= CURRENT_DATE - %s "
            "   AND COALESCE(ts.durum,'') <> 'iptal'", (g + pen,))
        siparisler = [dict(r) for r in (cur.fetchall() or [])]

    # ── Kanıt topla: sipariş fatura gününden ÖNCE (zaman oku tek yönlü)
    _harita = _kanonik_harita()
    kanit: Dict[Any, Dict[str, Any]] = {}
    for f in faturalar:
        fkalem = fk.get(f["id"], [])
        if not fkalem:
            continue
        kim = _ayirt_edici(_kanonik_ad(f["tedarikci_ad"], _harita))
        ilgili: List[Dict] = []
        for s in siparisler:
            if not (_ayirt_edici(s["ted_ad"]) & kim):
                continue
            try:
                sapma = _gun_farki(f["tarih"], s["gun"])
            except Exception:  # noqa: BLE001
                continue
            if -SONRA_TOLERANS <= sapma <= pen:
                ilgili.extend(_kalem_listesi(s.get("kalemler")))
        if not ilgili:
            continue
        kim_ad = " ".join(sorted(kim)) or "?"
        for sk in ilgili:
            s_ad = str(sk.get("urun_ad") or sk.get("ad") or "").strip()
            if not s_ad:
                continue
            s_adet = float(sk.get("adet") or 0)
            for fkl in fkalem:
                f_ad = str(fkl["ocr_ad"] or "").strip()
                if not f_ad:
                    continue
                a = kanit.setdefault((kim_ad, s_ad, f_ad),
                                     {"birlikte": 0, "adet_uyum": 0, "donemler": []})
                a["birlikte"] += 1
                if s_adet and abs(float(fkl["adet"] or 0) - s_adet) < 0.001:
                    a["adet_uyum"] += 1
                    a["donemler"].append(f["tarih"])

    # ── Puanla: ad benzerliği %60 + adet uyumu %40
    aday: Dict[Any, List[Dict]] = {}
    for (kim_ad, s_ad, f_ad), k in kanit.items():
        s_bel = _urun_belirtec(s_ad)
        ort = s_bel & _urun_belirtec(f_ad)
        ad_puan = (len(ort) / len(s_bel)) if s_bel else 0.0
        uyum_oran = (k["adet_uyum"] / k["birlikte"]) if k["birlikte"] else 0.0
        if ad_puan == 0 and k["adet_uyum"] < 2:
            continue        # ne ad tutuyor ne yeterli adet kanıtı → aday değil
        aday.setdefault((kim_ad, s_ad), []).append({
            "fatura_urun": f_ad,
            "puan": round(ad_puan * 0.6 + uyum_oran * 0.4, 3),
            "ad_ortak": sorted(ort), "ad_puan": round(ad_puan, 2),
            "adet_uyum": k["adet_uyum"], "birlikte": k["birlikte"],
            "donemler": sorted(set(k["donemler"]))[:4],
        })

    koprular = []
    for (kim_ad, s_ad), lst in aday.items():
        lst.sort(key=lambda x: (-x["puan"], -x["adet_uyum"]))
        en = lst[0]
        ikinci = lst[1]["puan"] if len(lst) > 1 else 0.0
        if en["ad_puan"] >= 0.5 and en["adet_uyum"] >= 1:
            guven = "YUKSEK"
            gerekce = "ad ortak (%s) + %d dönemde adet birebir tuttu" % (
                ", ".join(en["ad_ortak"]) or "-", en["adet_uyum"])
        elif en["ad_puan"] >= 0.5:
            guven = "ORTA"
            gerekce = "yalnız ad ortak (%s); adet kanıtı yok" % (
                ", ".join(en["ad_ortak"]) or "-")
        elif en["adet_uyum"] >= 3 and (en["puan"] - ikinci) > 0.05:
            guven = "ORTA"
            gerekce = ("ad hiç tutmuyor ama %d ayrı dönemde adet birebir aynı "
                       "— Lime↔MİSKET LİMON kalıbı" % en["adet_uyum"])
        else:
            guven = "DUSUK"
            gerekce = "zayıf kanıt — sahip onayı şart"
        koprular.append({
            "karsi_taraf": kim_ad, "siparis_urun": s_ad,
            "fatura_urun": en["fatura_urun"], "guven": guven, "gerekce": gerekce,
            "puan": en["puan"], "ikinci_aday_puan": round(ikinci, 3),
            "ad_ortak": en["ad_ortak"], "adet_uyum": en["adet_uyum"],
            "ornek_donem": en["donemler"], "rakip_sayisi": len(lst) - 1,
        })
    # ⚠️ ÇAKIŞMA UYARISI: bir fatura kalemine BİRDEN ÇOK sipariş kalemi
    # bağlanıyorsa köprülerden en az biri yanlıştır. Canlı örnek: "Çikolata Sos"
    # ile "Çikolata Toz" aynı ürüne bağlanmıştı. Sessizce en yükseği seçmek
    # yanlışı gizler; ikisini de İŞARETLEYİP sahibe göstermek doğrudur.
    # 🗂️ SAHİP KARARI TAHMİNE ÜSTÜNDÜR (2026-08-25)
    # Sahip "toffeenut bar sosu karamel bar sosuyla AYNI" dedi. Yani iki sipariş
    # adının tek fatura ürününe gitmesi HATA DEĞİL, meşru eş anlamlılık. Köprü
    # her çağrıda veriden yeniden üretildiği için bu hüküm bir defterde durmalı;
    # yoksa her hesaplamada aynı soru yeniden sorulur ve sahip aynı cevabı
    # tekrar tekrar vermek zorunda kalır. Tahmin yenilenebilir, KARAR yenilenmez.
    try:
        with db() as (_, _c2):
            _karar_tablo(_c2)
            _c2.execute("SELECT karsi_taraf, siparis_urun, fatura_urun, karar "
                        "FROM kalem_kopru_karari ORDER BY olusturma")
            _kararlar = [dict(r) for r in (_c2.fetchall() or [])]
    except Exception as _ek:  # noqa: BLE001 — defter okunamazsa köprü yine çalışır
        logger.warning("köprü karar defteri okunamadı: %s", str(_ek)[:120])
        _kararlar = []
    _onayli, _retli = {}, set()
    for r in _kararlar:                      # append-only → en yenisi kazanır
        anah = (r["karsi_taraf"], r["siparis_urun"])
        if r["karar"] == "onay":
            _onayli[anah] = r["fatura_urun"]
        else:
            _retli.add((r["karsi_taraf"], r["siparis_urun"], r["fatura_urun"]))
    for k in koprular:
        anah = (k["karsi_taraf"], k["siparis_urun"])
        if anah in _onayli:
            k["fatura_urun"] = _onayli[anah]
            k["guven"] = "ONAYLI"
            k["gerekce"] = "sahip kararı — deftere yazılı, tahmine üstün"
        elif (k["karsi_taraf"], k["siparis_urun"], k["fatura_urun"]) in _retli:
            k["guven"] = "DUSUK"
            k["gerekce"] = "sahip bu eşleşmeyi REDDETTİ — başka aday aranmalı"

    _hedef: Dict[Any, int] = {}
    for k in koprular:
        _hedef[(k["karsi_taraf"], k["fatura_urun"])] =             _hedef.get((k["karsi_taraf"], k["fatura_urun"]), 0) + 1
    for k in koprular:
        if _hedef[(k["karsi_taraf"], k["fatura_urun"])] > 1 and k["guven"] != "ONAYLI":
            k["cakisma"] = ("Bu fatura kalemine BAŞKA bir sipariş kalemi de "
                            "bağlandı — en az biri yanlış, sahip ayırmalı.")
            if k["guven"] == "YUKSEK":
                k["guven"] = "ORTA"   # çakışan köprü 'yüksek güven' olamaz

    sira = {"ONAYLI": 0, "YUKSEK": 1, "ORTA": 2, "DUSUK": 3}
    koprular.sort(key=lambda x: (x["karsi_taraf"], sira[x["guven"]], -x["puan"]))
    ozet: Dict[str, int] = {}
    for k in koprular:
        ozet[k["guven"]] = ozet.get(k["guven"], 0) + 1
    return {
        "tedarikci": t or "(hepsi)", "gun": g, "pencere_gun": pen,
        "adet": len(koprular), "guven_ozeti": ozet, "koprular": koprular,
        "not": ("ÖNERİ-ONLY — hiçbir eşleştirme KAYDEDİLMEDİ. Köprü iki kanıttan "
                "üretilir: AD BENZERLİĞİ (dolgu sözcükleri atılmış ortak kelime) ve "
                "BİRLİKTE GÖRÜLME + ADET UYUMU. Tek başına ad yanıltır (çilek şurubu "
                "↔ çilek püresi); tek başına adet de yanıltır (aynı dönemde iki kalem "
                "de ×12 olabilir). DÜŞÜK güvenli satır kullanılmadan önce sahip onayı "
                "ister — köprü yanlışsa üretilecek 'şu ürün eksik' cümlesi de yanlış olur."),
    }


# ═══════════════════════════════════════════════════════════════════════════
# 🗂️ KÖPRÜ KARAR DEFTERİ — sahibin hükmü kalıcıdır
# ═══════════════════════════════════════════════════════════════════════════
def _karar_tablo(cur) -> None:
    """İZOLE + APPEND-ONLY karar defteri.

    ⚠️ Neden ayrı bir defter (2026-08-25): köprü her çağrıda veriden yeniden
    ÜRETİLİR. Sahip bir kez "bu ikisi aynı ürün" dediğinde, o hüküm bir sonraki
    hesaplamada KAYBOLMAMALIDIR. Tahmin her seferinde yeniden yapılabilir ama
    KARAR yapılamaz — karar bir defterde durur.
    Append-only: aynı çift için yeni karar eskisini SİLMEZ, üstüne yazılır ve
    ikisi de görünür kalır (geri-alma ≠ silme).
    """
    cur.execute("""
        CREATE TABLE IF NOT EXISTS kalem_kopru_karari (
            id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            karsi_taraf   TEXT NOT NULL,
            siparis_urun  TEXT NOT NULL,
            fatura_urun   TEXT NOT NULL,
            karar         TEXT NOT NULL,          -- onay | ret
            gerekce       TEXT,
            veren         TEXT,
            olusturma     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_kkk_taraf "
                "ON kalem_kopru_karari (karsi_taraf, siparis_urun)")


class KopruKarariBody(BaseModel):
    karsi_taraf: str
    siparis_urun: str
    fatura_urun: str
    karar: str = "onay"          # onay | ret
    gerekce: Optional[str] = None
    veren: Optional[str] = "sahip"


@router.post("/kalem-koprusu/karar")
def kalem_koprusu_karar(body: KopruKarariBody):
    """Sahibin köprü hükmünü deftere yazar. Tahmin değil KARAR."""
    k = (body.karar or "onay").strip().lower()
    if k not in ("onay", "ret"):
        raise HTTPException(400, "karar: onay | ret")
    for alan, ad in ((body.karsi_taraf, "karsi_taraf"),
                     (body.siparis_urun, "siparis_urun"),
                     (body.fatura_urun, "fatura_urun")):
        if not (alan or "").strip():
            raise HTTPException(400, ad + " zorunlu")
    with db() as (conn, cur):
        _karar_tablo(cur)
        cur.execute(
            "INSERT INTO kalem_kopru_karari "
            "(karsi_taraf, siparis_urun, fatura_urun, karar, gerekce, veren) "
            "VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
            (body.karsi_taraf.strip(), body.siparis_urun.strip(),
             body.fatura_urun.strip(), k, (body.gerekce or None),
             (body.veren or "sahip")),
        )
        yeni = dict(cur.fetchone() or {}).get("id")
        conn.commit()
    return {"success": True, "id": yeni, "karar": k,
            "not": ("Karar deftere yazıldı. Köprü bir daha hesaplandığında bu "
                    "hüküm tahmine üstün gelir ve güven 'ONAYLI' görünür.")}


@router.get("/kalem-koprusu/kararlar")
def kalem_koprusu_kararlar():
    """Verilmiş tüm köprü kararları (en yeni önce). SALT OKUR."""
    with db() as (_, cur):
        _karar_tablo(cur)
        cur.execute(
            "SELECT karsi_taraf, siparis_urun, fatura_urun, karar, gerekce, veren, "
            "       olusturma::text AS ts FROM kalem_kopru_karari "
            " ORDER BY olusturma DESC")
        rows = [dict(r) for r in (cur.fetchall() or [])]
    return {"adet": len(rows), "kararlar": rows,
            "not": ("Append-only: aynı çift için yeni karar eskisini silmez, "
                    "en yenisi geçerlidir ama ikisi de görünür (geri-alma ≠ silme).")}


# ═══════════════════════════════════════════════════════════════════════════
# 🪪 KİMLİK ADAYLARI — "aynı firma kaç ayrı adla kayıtlı?"
# ═══════════════════════════════════════════════════════════════════════════
@router.get("/kimlik-adaylari")
def kimlik_adaylari(gun: int = 400):
    """🪪 AYNI KARŞI TARAFIN FARKLI YAZIMLARINI bulur. SALT OKUR, ÖNERİ-ONLY.

    ── NEDEN (2026-08-25) ──────────────────────────────────────────────────
    Kalem köprüsü listesinde `Yarım Yağlı Süt → SÜT YARIM YAĞLI 1 L` köprüsü
    İKİ KEZ çıktı. Sebep hata değil: SÜTAŞ sistemde iki ayrı adla kayıtlı
    ("SÜTAŞ SÜT ÜRÜNLERİ A.Ş." ve "Sütaş Süt Ürünleri Anonim…"). Aynı dert
    başka yerlerde de var: SUK/SUKİ, DYK/DYN, ALIŞ/ALIS GROSMARKET.

    Kimlik parçalanması ÜÇ ayrı yerde zarar veriyor:
      · ürün sözlüğü bölünüyor → kararlılık yüzdesi OLDUĞUNDAN DÜŞÜK görünüyor
      · kalem köprüsü aynı satırı iki kez üretiyor
      · cari bakiye iki ada dağılıyor → "bu firmaya ne kadar borcum var?"
        sorusunun tek cevabı olmuyor

    ── KANIT SIRALAMASI (güçlüden zayıfa) ──────────────────────────────────
    1) AYNI TELEFON        → aynı karşı taraf (en güçlü; kişi/firma teki)
    2) AYNI FATURA SERİSİ  → fatura no ön eki aynı (S10…, NPA…, FEZ…) — seri
                             mükellefe özeldir, başkası aynı seriyi kesemez
    3) ORTAK AYIRT EDİCİ KELİME → jenerikler atılmış kelime kesişimi
    Yalnız 3'e dayanan öneri ZAYIFTIR: "KONYA SU" ile "KONYA SUK" ayrı firma
    olabilir. Bu yüzden güven, kaç kanıtın örtüştüğüne göre verilir ve
    HANGİ kanıt olduğu yazılır — sahip körlemesine onaylamasın.

    ⚠️ ÖNERİ-ONLY: hiçbir kayıt birleştirilmez. Birleştirme, cari bakiyeyi
    değiştiren bir işlemdir; yanlış birleştirme iki firmanın borcunu birbirine
    karıştırır — bu geri alması en zor hatalardandır.
    """
    g = max(1, min(730, int(gun or 400)))
    with db() as (_, cur):
        cur.execute(
            "SELECT COALESCE(f.tedarikci_ad,'') AS ad, COUNT(*) AS fatura_adet, "
            "       COALESCE(SUM(f.toplam_tutar),0)::float AS toplam, "
            "       MIN(f.fatura_tarih)::text AS ilk, MAX(f.fatura_tarih)::text AS son, "
            "       ARRAY_AGG(DISTINCT LEFT(COALESCE(f.fatura_no,''), 3)) AS seriler "
            "  FROM tedarikci_fatura f "
            " WHERE f.fatura_tarih >= CURRENT_DATE - %s "
            "   AND COALESCE(f.durum,'') <> 'kopya' "
            "   AND COALESCE(f.tedarikci_ad,'') <> '' "
            " GROUP BY f.tedarikci_ad ORDER BY COUNT(*) DESC", (g,))
        adlar = [dict(r) for r in (cur.fetchall() or [])]
        cur.execute("SELECT ad, COALESCE(telefon,'') AS tel FROM tedarikciler "
                    "WHERE COALESCE(ad,'') <> ''")
        kayit_tel = {}
        for r in (cur.fetchall() or []):
            r = dict(r)
            if r["tel"]:
                kayit_tel.setdefault(re.sub(r"\D", "", r["tel"])[-10:], set()).add(r["ad"])

    # telefon → ad kümesi (aynı numara = aynı karşı taraf)
    ad_tel = {}
    for tel, adkume in kayit_tel.items():
        for a in adkume:
            ad_tel[a.upper()] = tel

    # 🔴 MEVCUT KARAR DEFTERİNİ OKU (2026-08-25, canlıda hata yaptıktan sonra)
    # İlk sürüm sistemdeki KİMLİK KARAR DEFTERİNİ hiç okumuyordu. Sonuç: zaten
    # birleştirilmiş grupları yeniden önerdi ve — daha kötüsü — YANLIŞ KANONİK
    # seçti. "KONYA SUK" 17 Ağustos'ta BEYSU'ya, "APS GIDA" redbull'a bağlanmıştı;
    # ben en çok faturası olan adı kanonik sanıp aralarına bir ad daha soktum ve
    # ZİNCİR oluşturdum (alias → ara ad → gerçek kanonik). Okuma tarafı düz harita
    # olduğu için iki hoplu zinciri çözemez; kimlik yine bölünmüş kalırdı.
    # Ders (bugün üçüncü kez): duyu, sistemin AÇIKÇA yazdığı kararı okumazsa
    # düzelttiğini sandığı şeyi bozar. Karar defteri VARSA kanonik ondan gelir.
    _mevcut_kanonik: Dict[str, str] = {}
    try:
        from tedarikci_zinciri_api import _guncel_kararlar
        with db() as (_, _c3):
            _mevcut_kanonik = {k: v for k, v in (_guncel_kararlar(_c3) or {}).items()}
    except Exception as _ekk:  # noqa: BLE001 — defter yoksa öneri yine üretilir
        logger.warning("kimlik karar defteri okunamadı: %s", str(_ekk)[:120])

    kume: List[List[Dict]] = []
    kullanildi = [False] * len(adlar)
    for i, a in enumerate(adlar):
        if kullanildi[i]:
            continue
        grup = [a]
        kullanildi[i] = True
        a_tok = _ayirt_edici(a["ad"])
        a_seri = {s for s in (a["seriler"] or []) if s and len(s) == 3}
        for j in range(i + 1, len(adlar)):
            if kullanildi[j]:
                continue
            b = adlar[j]
            ortak_tok = a_tok & _ayirt_edici(b["ad"])
            ortak_seri = a_seri & {s for s in (b["seriler"] or []) if s and len(s) == 3}
            ayni_tel = (ad_tel.get(a["ad"].upper()) and
                        ad_tel.get(a["ad"].upper()) == ad_tel.get(b["ad"].upper()))
            if ortak_tok or ortak_seri or ayni_tel:
                grup.append(b)
                kullanildi[j] = True
                a_tok |= _ayirt_edici(b["ad"])
                a_seri |= {s for s in (b["seriler"] or []) if s and len(s) == 3}
        if len(grup) > 1:
            kume.append(grup)

    oneriler = []
    for grup in kume:
        # Grubun herhangi bir adı deftere bağlıysa KANONİK ORADAN gelir; ayrıca
        # hepsi zaten aynı kanoniğe bağlıysa öneri ÜRETİLMEZ (iş bitmiş).
        _bagli = {_mevcut_kanonik.get((x["ad"] or "").upper()) for x in grup}
        _bagli.discard(None)
        _defter_kanonik = (list(_bagli)[0] if len(_bagli) == 1 else None)
        # ⚠️ KANONİK KENDİSİ ALIAS DEĞİLDİR: defter "A→A" satırı tutmaz (anlamsız
        # döngü). Bu yüzden "hepsi bağlı mı?" sorusu, kanonik adın KENDİSİNİ de
        # bağlı saymalıdır — yoksa onaylanmış her grup listede kalır ve sahip
        # aynı işi bitmemiş sanır. (İlk sürümde FEZ/SÜTAŞ/ATALAY onaylandığı hâlde
        # öneri listesinde duruyordu.)
        _kan_u = (_defter_kanonik or "").upper()
        _hepsi_bagli = all(
            _mevcut_kanonik.get((x["ad"] or "").upper()) or (x["ad"] or "").upper() == _kan_u
            for x in grup)
        if _hepsi_bagli and len(_bagli) == 1:
            continue        # zaten birleşik — öneri gürültüsü üretme
        toplam_tok = set.intersection(*[_ayirt_edici(x["ad"]) for x in grup]) \
            if len(grup) > 1 else set()
        seriler = [set(s for s in (x["seriler"] or []) if s and len(s) == 3) for x in grup]
        ortak_seri = set.intersection(*seriler) if len(seriler) > 1 else set()
        teller = {ad_tel.get(x["ad"].upper()) for x in grup} - {None}
        kanitlar = []
        if len(teller) == 1 and teller:
            kanitlar.append("aynı telefon")
        if ortak_seri:
            kanitlar.append("aynı fatura serisi (%s)" % ", ".join(sorted(ortak_seri)))
        if toplam_tok:
            kanitlar.append("ortak kelime (%s)" % ", ".join(sorted(toplam_tok)))
        # 🔤 AD KAPSAMASI — kısaltma ile açılımı aynı firmadır (2026-08-25)
        # SÜTAŞ ilk sürümde DÜŞÜK çıktı çünkü fatura serileri farklıydı (B10 vs
        # S10) — oysa isimler BİREBİR aynı: "Sütaş Süt Ürünleri ANONİM ŞİRKETİ"
        # ile "SÜTAŞ SÜT ÜRÜNLERİ A.Ş." Aynı firmanın iki bölgesi/şubesi farklı
        # seri kesebilir; seri farkı "ayrı firma" demek DEĞİLDİR.
        # Ölçüt: KISA adın ayırt edici kelimelerinin ne kadarı uzun adda da var?
        # %80+ ise ad kanıtı tek başına güçlüdür. Bu, METRO'yu (%40) yükseltmez —
        # orada gerçekten belirsizlik var ve öyle kalmalı.
        _tok = [_ayirt_edici(x["ad"]) for x in grup]
        _kisa = min(_tok, key=len) if _tok else set()
        _kapsama = (len(set.intersection(*_tok)) / len(_kisa)) if (_kisa and len(_tok) > 1) else 0.0
        if _kapsama >= 0.8:
            kanitlar.append("ad neredeyse birebir (%%%d kapsama)" % round(_kapsama * 100))
        guven = ("YUKSEK" if (len(kanitlar) >= 2 or "aynı telefon" in kanitlar
                              or _kapsama >= 0.8)
                 else "ORTA" if ortak_seri else "DUSUK")
        oneriler.append({
            "onerilen_ad": (_defter_kanonik
                            or max(grup, key=lambda x: x["fatura_adet"])["ad"]),
            "kanonik_kaynagi": ("karar defteri" if _defter_kanonik
                                else "en çok faturalı ad (öneri)"),
            "adlar": [{"ad": x["ad"], "fatura_adet": x["fatura_adet"],
                       "toplam": round(x["toplam"], 2), "ilk": x["ilk"], "son": x["son"],
                       "seriler": sorted(s for s in (x["seriler"] or []) if s)}
                      for x in grup],
            "ad_sayisi": len(grup),
            "toplam_fatura": sum(x["fatura_adet"] for x in grup),
            "toplam_tutar": round(sum(x["toplam"] for x in grup), 2),
            "guven": guven, "kanitlar": kanitlar,
        })
    oneriler.sort(key=lambda x: (-x["toplam_tutar"]))
    ozet: Dict[str, int] = {}
    for o in oneriler:
        ozet[o["guven"]] = ozet.get(o["guven"], 0) + 1
    return {
        "gun": g, "farkli_ad": len(adlar), "birlesme_adayi": len(oneriler),
        "guven_ozeti": ozet, "adaylar": oneriler,
        "not": ("ÖNERİ-ONLY — hiçbir kayıt birleştirilmedi. Kanıt sırası: aynı "
                "telefon > aynı fatura serisi > ortak kelime. YALNIZ ortak kelimeye "
                "dayanan öneri ZAYIFTIR ('KONYA SU' ile 'KONYA SUK' ayrı firma "
                "olabilir). Birleştirme cari bakiyeyi değiştirir; yanlış birleştirme "
                "iki firmanın borcunu birbirine karıştırır ve geri alması en zor "
                "hatalardandır — bu yüzden hüküm sahibindir."),
    }


# ═══════════════════════════════════════════════════════════════════════════
# 📅 TARİH TERSLİĞİ — gün ile ay yer değiştirmiş mi?
# ═══════════════════════════════════════════════════════════════════════════
@router.get("/tarih-terslik")
def tarih_terslik(gun: int = 730, esik_gun: int = 30):
    """📅 GÜN/AY TERS OKUNMUŞ FATURALARI bulur. SALT OKUR, ÖNERİ-ONLY.

    ── NEDEN (2026-08-25) ──────────────────────────────────────────────────
    DYK irsaliyesinin aslı açıldığında görüldü ki belgede `01-07-2026`
    (1 Temmuz) yazan tarih sisteme `2026-01-07` (7 Ocak) diye girmiş —
    **altı aylık kayma**. Belge Temmuz'a ait ama Ocak'ta duruyor.
    Bu tek belgeye özgü olmayabilir; tarih kayması sessizdir çünkü tutar
    doğrudur, tedarikçi doğrudur, yalnız DÖNEM yanlıştır. Cari yaşlandırma,
    KDV dönemi ve "şu ay ne aldık" sorularının hepsi bundan zarar görür.

    ── ÇAPA: YÜKLEME TARİHİ ────────────────────────────────────────────────
    Belgeyi açmadan nasıl anlarız? Fatura sisteme yüklendiği tarih (olusturma)
    bilinir ve fatura genelde yüklenmesinden KISA SÜRE ÖNCE kesilir. DYN
    vakasında: fatura_tarih 7 Ocak, yükleme 2 Temmuz → arada 176 gün.
    Gün ve ayı TAKAS edince 1 Temmuz çıkıyor → yüklemeye 1 gün. Takas,
    tarihi yükleme gününe BELİRGİN ŞEKİLDE yaklaştırıyorsa şüphe güçlüdür.

    ── TARAMA KOŞULU ───────────────────────────────────────────────────────
    Yalnız gün ≤ 12 olan tarihler karışabilir (13 ve üstü ay olamaz).
    Gün = ay ise takas anlamsızdır. Bu yüzden evren zaten dardır; her
    "gün ≤ 12" tarihi şüpheli DEĞİLDİR — kanıt, takasın yaklaştırmasıdır.

    ⚠️ ÖNERİ-ONLY: hiçbir tarih değiştirilmez. Tarih düzeltmek belgeyi başka
    bir döneme taşır; yanlış düzeltme, düzeltmediğinden beterdir. Karar,
    belgenin aslına bakan sahibindir.
    """
    g = max(30, min(1460, int(gun or 730)))
    esik = max(5, min(180, int(esik_gun or 30)))
    from datetime import date as _d
    with db() as (_, cur):
        cur.execute(
            "SELECT f.id, f.tedarikci_ad, f.fatura_no, "
            "       f.fatura_tarih::text AS tarih, f.olusturma::date::text AS yukleme, "
            "       COALESCE(f.toplam_tutar,0)::float AS tutar, f.durum "
            "  FROM tedarikci_fatura f "
            " WHERE f.fatura_tarih IS NOT NULL "
            "   AND f.fatura_tarih >= CURRENT_DATE - %s "
            "   AND COALESCE(f.durum,'') <> 'kopya' "
            " ORDER BY f.fatura_tarih DESC", (g,))
        rows = [dict(r) for r in (cur.fetchall() or [])]

    supheli, incelenen = [], 0
    for r in rows:
        try:
            y, ay, gn = (int(x) for x in str(r["tarih"])[:10].split("-"))
            yy, yay, ygn = (int(x) for x in str(r["yukleme"])[:10].split("-"))
        except (ValueError, TypeError):
            continue
        if gn > 12 or gn == ay:
            continue                     # takas imkânsız ya da anlamsız
        incelenen += 1
        try:
            simdiki = _d(y, ay, gn)
            takas = _d(y, gn, ay)        # gün ile ay yer değiştirdi
            yuk = _d(yy, yay, ygn)
        except ValueError:
            continue
        f_simdi = abs((yuk - simdiki).days)
        f_takas = abs((yuk - takas).days)
        # Takas yüklemeye BELİRGİN ölçüde yaklaştırıyorsa şüpheli
        if f_simdi - f_takas < esik:
            continue
        # Gelecek tarihli olamaz — takas sonrası yüklemeden sonraysa aday değil
        if takas > yuk:
            continue
        # 🔢 KARŞI KANIT: FATURA SIRA NUMARASI (2026-08-25, canlıda yanıldıktan sonra)
        # İlk sürüm FEZ'in FZE2026000000057 faturasını "5 Ocak değil 1 Mayıs"
        # diye işaretledi. Oysa FZE serisi tarihle BİREBİR artıyor:
        #   05 Oca → 57 · 07 Şub → 635 · 11 Mar → 1.126 · 02 May → 2.166
        # 57 numaralı fatura 1 Mayıs'ta kesilemez; o gün seri 2.100'lerdeydi.
        # Kayıtlı tarih DOĞRUYDU. Yanılmanın sebebi: o fatura TOPLU GEÇMİŞ
        # YÜKLEMESİYLE girmiş (17 Haziran) ve çapam "fatura yüklenmeden az önce
        # kesilir" varsayıyordu — toplu yükleme bu varsayımı kırar.
        # Kural: seri numarası tarih sırasını doğruluyorsa TAKAS REDDEDİLİR.
        # Bir çapa yetmez; ikinci çapa ilkini denetler.
        _seri_karsi = None
        try:
            import re as _re2
            _m = _re2.match(r"([A-Za-z]{2,4})(\d{6,})", str(r["fatura_no"] or ""))
            if _m:
                _pre, _num = _m.group(1).upper(), int(_m.group(2))
                _komsu = []
                for o in rows:
                    if o["id"] == r["id"]:
                        continue
                    _m2 = _re2.match(r"([A-Za-z]{2,4})(\d{6,})", str(o["fatura_no"] or ""))
                    if not _m2 or _m2.group(1).upper() != _pre:
                        continue
                    if not (_ayirt_edici(o["tedarikci_ad"]) & _ayirt_edici(r["tedarikci_ad"])):
                        continue
                    _komsu.append((int(_m2.group(2)), str(o["tarih"])[:10]))
                _alt = max([k for k in _komsu if k[0] < _num], default=None)
                _ust = min([k for k in _komsu if k[0] > _num], default=None)
                _kt, _tt = str(simdiki), str(takas)
                _kayitli_uyar = ((not _alt or _alt[1] <= _kt) and (not _ust or _kt <= _ust[1]))
                _takas_uyar = ((not _alt or _alt[1] <= _tt) and (not _ust or _tt <= _ust[1]))
                if _komsu and _kayitli_uyar and not _takas_uyar:
                    continue      # seri kayıtlı tarihi DOĞRULUYOR → takas reddedilir
                if _komsu:
                    _seri_karsi = {"onceki": _alt, "sonraki": _ust,
                                   "kayitli_seriye_uyuyor": _kayitli_uyar,
                                   "takas_seriye_uyuyor": _takas_uyar}
        except Exception as _es:  # noqa: BLE001 — seri okunamazsa yalnız yükleme çapası
            logger.info("seri karşı kanıtı atlandı: %s", str(_es)[:90])

        supheli.append({
            "seri_kaniti": _seri_karsi,
            "fatura_id": r["id"], "tedarikci_ad": r["tedarikci_ad"],
            "fatura_no": r["fatura_no"], "tutar": r["tutar"], "durum": r["durum"],
            "kayitli_tarih": str(simdiki), "onerilen_tarih": str(takas),
            "yukleme_tarihi": str(yuk),
            "yuklemeye_uzaklik_gun": {"kayitli": f_simdi, "takas": f_takas},
            "kazanc_gun": f_simdi - f_takas,
            "belge_url": "/api/fatura/%s/foto" % r["id"],
        })
    supheli.sort(key=lambda x: -x["kazanc_gun"])
    return {
        "gun": g, "esik_gun": esik,
        "toplam_fatura": len(rows), "takasa_uygun": incelenen,
        "supheli": len(supheli), "satirlar": supheli,
        "not": ("ÖNERİ-ONLY — hiçbir tarih değiştirilmedi. Çapa YÜKLEME TARİHİDİR: "
                "fatura genelde yüklenmesinden kısa süre önce kesilir. Bir tarih "
                "yalnız 'gün ≤ 12' olduğu için şüpheli DEĞİLDİR; kanıt, gün ile ayı "
                "takas etmenin tarihi yükleme gününe BELİRGİN ölçüde yaklaştırmasıdır. "
                "Tarih düzeltmek belgeyi başka bir döneme taşır (cari yaşlandırma, KDV "
                "dönemi); yanlış düzeltme düzeltmediğinden beterdir — her satır için "
                "belgenin ASLINA bakılmalı, `belge_url` onu açar."),
    }


# ═══════════════════════════════════════════════════════════════════════════
# 📄 BELGE TÜRÜ — fatura mı, irsaliye mi?
# ═══════════════════════════════════════════════════════════════════════════
_IRSALIYE_IZ = (
    "e-irsaliye", "e-i̇rsaliye", "irsaliye no", "i̇rsaliye no",
    "irsaliye tarihi", "i̇rsaliye tarihi", "sevk tarihi", "irsaliye tipi",
    "temelirsaliye", "sevk zamani", "sevk zamanı",
)


@router.get("/belge-turu-teshisi")
def belge_turu_teshisi(gun: int = 730):
    """📄 FATURA SANILAN İRSALİYELERİ bulur. SALT OKUR, ÖNERİ-ONLY.

    ── NEDEN (2026-08-25, iki canlı vaka) ──────────────────────────────────
    `tedarikci_fatura` tablosunda **belge TÜRÜ** alanı yok. Mevcut
    `belge_sinifi` alanı mal/hizmet ayrımı yapar — bu bambaşka bir eksendir.
    Sonuç: e-İRSALİYE'ler fatura sanılıp tabloya giriyor ve ZARARSIZ DEĞİL:

      · DYK e-irsaliyesi (1 Tem 2026): tutar 0,00 → `ocr-kapsama` teşhisi
        bunu "TUTAR DA OKUNAMAMIŞ" diye OCR arızası saydı. Oysa doğruydu:
        İRSALİYEDE FİYAT SÜTUNU BOŞTUR.
      · METRO G31 belgesi de e-irsaliye çıktı; serisi fatura serisinden
        (27X) farklı olduğu için kimlik tarayıcısı "ayrı firma olabilir"
        dedi. Seri farkının sebebi ayrı firma değil AYRI BELGE TÜRÜYDÜ.

    Yani belge türünü bilmemek en az üç yerde yanlış hüküm üretiyor:
    OCR teşhisi, kimlik eşleştirmesi ve fatura↔teslim mutabakatı.

    ── KANIT ───────────────────────────────────────────────────────────────
    1) BELGE METNİ — "e-İrsaliye", "İrsaliye No", "Sevk Tarihi" ibareleri
       (OCR json'ında ya da kaynak metinde). En güçlü kanıt: belgenin kendi
       başlığı.
    2) TUTARSIZ KALEM — kalemleri var ama hepsinin satır toplamı 0,00.
       İrsaliyede miktar vardır, fiyat yoktur. Bu, metin bulunamasa da
       güçlü bir imzadır.
    Yalnız 2'ye dayanan öneri ORTA güvenlidir: OCR fiyatları okuyamamış bir
    FATURA da böyle görünür. Bu yüzden ikisi ayrı raporlanır.

    ⚠️ ÖNERİ-ONLY: hiçbir kayıt değişmez. İrsaliyeyi tablodan çıkarmak da
    ÇÖZÜM DEĞİLDİR — irsaliye teslimatın kanıtıdır ve faturasıyla eşleşmesi
    gerekir (DYK örneği: aynı gün 147.276,00 ₺'lik faturası var). Doğru çözüm
    onu SİLMEK değil TÜRÜNÜ BİLMEKTİR.
    """
    g = max(30, min(1460, int(gun or 730)))
    with db() as (_, cur):
        cur.execute(
            "SELECT f.id, f.tedarikci_ad, f.fatura_no, f.fatura_tarih::text AS tarih, "
            "       COALESCE(f.toplam_tutar,0)::float AS tutar, f.durum, "
            "       LEFT(COALESCE(f.ocr_json::text,''), 4000) AS oj, "
            "       LEFT(COALESCE(f.kaynak_metin,''), 4000) AS km, "
            "       COUNT(k.id) AS kalem, "
            "       COALESCE(SUM(COALESCE(k.satir_toplam,0)),0)::float AS kalem_toplam "
            "  FROM tedarikci_fatura f "
            "  LEFT JOIN tedarikci_fatura_kalem k ON k.fatura_id = f.id "
            " WHERE f.fatura_tarih >= CURRENT_DATE - %s "
            "   AND COALESCE(f.durum,'') <> 'kopya' "
            " GROUP BY f.id, f.tedarikci_ad, f.fatura_no, f.fatura_tarih, "
            "          f.toplam_tutar, f.durum, f.ocr_json, f.kaynak_metin "
            " ORDER BY f.fatura_tarih DESC", (g,))
        rows = [dict(r) for r in (cur.fetchall() or [])]

    bulgu = []
    for r in rows:
        metin = ((r["oj"] or "") + " " + (r["km"] or "")).lower()
        iz = [k for k in _IRSALIYE_IZ if k in metin]
        kalem = int(r["kalem"] or 0)
        fiyatsiz = (kalem > 0 and abs(float(r["kalem_toplam"] or 0)) < 0.01
                    and abs(float(r["tutar"] or 0)) < 0.01)
        if not iz and not fiyatsiz:
            continue
        # ⚖️ "İRSALİYELİ FATURA" AYRIMI (2026-08-25, ilk taramadan sonra)
        # İlk sürüm tutarı OLAN 7 belgeyi de "irsaliye" diye işaretledi
        # (METRO 46.767,43 · SÜTAŞ 30.367,00 · DYK 126.679,02 …). Oysa Türkiye'de
        # yaygın olan İRSALİYELİ FATURA'da sevk bilgisi faturanın ÜSTÜNDE durur;
        # belge geçerli bir FATURADIR ve tutarı gerçektir. "İrsaliye ibaresi var"
        # tek başına hüküm değildir — belirleyici olan TUTARIN OLMAMASIDIR.
        # Bu ayrım yapılmazsa 7 sahte alarm, aradaki 3 gerçek boşluğu gömer.
        if iz and fiyatsiz:
            guven, gerekce = "YUKSEK", ("SAF İRSALİYE — belge metninde irsaliye "
                                        "ibaresi (%s) VE hiç fiyat yok"
                                        % ", ".join(iz[:2]))
        elif iz:
            guven, gerekce = "BILGI", ("İRSALİYELİ FATURA — sevk bilgisi taşıyor (%s) "
                                       "ama TUTARI VAR; geçerli faturadır, düzeltme "
                                       "gerekmez" % ", ".join(iz[:2]))
        else:
            guven, gerekce = "ORTA", ("kalemler var ama hepsinin fiyatı 0,00 — "
                                      "irsaliye imzası; ancak fiyatları okunamamış "
                                      "bir FATURA da böyle görünebilir")
        bulgu.append({
            "fatura_id": r["id"], "tedarikci_ad": r["tedarikci_ad"],
            "fatura_no": r["fatura_no"], "tarih": r["tarih"], "tutar": r["tutar"],
            "kalem_sayisi": kalem, "guven": guven, "gerekce": gerekce,
            "belge_url": "/api/fatura/%s/foto" % r["id"],
        })
    ozet: Dict[str, int] = {}
    for b in bulgu:
        ozet[b["guven"]] = ozet.get(b["guven"], 0) + 1
    return {
        "gun": g, "taranan": len(rows),
        "irsaliye_adayi": sum(1 for b in bulgu if b["guven"] != "BILGI"),
        "irsaliyeli_fatura": sum(1 for b in bulgu if b["guven"] == "BILGI"),
        "guven_ozeti": ozet, "satirlar": bulgu,
        "not": ("ÖNERİ-ONLY — hiçbir kayıt değişmedi. `tedarikci_fatura` tablosunda "
                "belge TÜRÜ alanı yok; `belge_sinifi` mal/hizmet ayrımıdır, tür ayrımı "
                "DEĞİLDİR. Türü bilmemek en az üç yerde yanlış hüküm üretir: OCR "
                "teşhisi (0,00 tutarı 'okunamadı' sanır), kimlik eşleştirmesi (irsaliye "
                "serisini ayrı firma sanır) ve fatura↔teslim mutabakatı. "
                "İrsaliyeyi tablodan ÇIKARMAK çözüm değildir — irsaliye teslimatın "
                "kanıtıdır ve faturasıyla eşleşmesi gerekir. Doğru çözüm SİLMEK değil "
                "TÜRÜNÜ BİLMEKTİR."),
    }


def _belge_turu_kolonu(cur) -> None:
    """`tedarikci_fatura.belge_turu` — fatura / irsaliye / irsaliyeli_fatura.

    ⚠️ Neden AYRI bir alan (2026-08-25): tabloda zaten `belge_sinifi` var ama o
    MAL/HİZMET ayrımıdır — giderin niteliğini söyler. Belgenin TÜRÜ bambaşka bir
    eksendir: elimizdeki kâğıt bir fatura mı, yoksa fiyat taşımayan bir irsaliye
    mi? İkisini tek alana sıkıştırmak, iki soruyu birbirine karıştırır.
    Boş bırakılanlar 'fatura' varsayılır — eski davranış korunur (regresyon yok).
    """
    cur.execute("ALTER TABLE tedarikci_fatura "
                "ADD COLUMN IF NOT EXISTS belge_turu TEXT")
    cur.execute("ALTER TABLE tedarikci_fatura "
                "ADD COLUMN IF NOT EXISTS belge_turu_kaynak TEXT")


class BelgeTuruBody(BaseModel):
    belge_turu: str                      # fatura | irsaliye | irsaliyeli_fatura
    gerekce: Optional[str] = None


@router.post("/belge-turu/{fatura_id}")
def belge_turu_ata(fatura_id: str, body: BelgeTuruBody):
    """Tek belgenin türünü ELLE damgalar (sahip/aslı görülmüş kayıtlar için)."""
    t = (body.belge_turu or "").strip().lower()
    if t not in ("fatura", "irsaliye", "irsaliyeli_fatura"):
        raise HTTPException(400, "belge_turu: fatura | irsaliye | irsaliyeli_fatura")
    with db() as (conn, cur):
        _belge_turu_kolonu(cur)
        cur.execute(
            "UPDATE tedarikci_fatura SET belge_turu=%s, belge_turu_kaynak=%s "
            "WHERE id=%s RETURNING tedarikci_ad, fatura_no",
            (t, "elle:" + ((body.gerekce or "")[:120] or "sahip"), fatura_id))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "fatura bulunamadı")
        conn.commit()
    return {"ok": True, "fatura_id": fatura_id, "belge_turu": t,
            "tedarikci": dict(r)["tedarikci_ad"], "fatura_no": dict(r)["fatura_no"]}


@router.post("/belge-turu-isle")
def belge_turu_isle(gun: int = 730, kuru: int = 1):
    """📄 Teşhisin bulduklarını `belge_turu` alanına İŞLER. Varsayılan KURU ÇALIŞTIRMA.

    ── NE YAZAR ────────────────────────────────────────────────────────────
      YÜKSEK (saf irsaliye)      → belge_turu='irsaliye'
      BİLGİ  (irsaliyeli fatura) → belge_turu='irsaliyeli_fatura'
      ORTA                       → DOKUNULMAZ

    ⚠️ ORTA neden dokunulmaz: o kovada "fiyatı okunamamış FATURA" ile "saf
    irsaliye" ayırt edilemiyor. Belirsizi damgalamak, belirsizliği kaybetmektir —
    damga atıldıktan sonra kimse geri dönüp bakmaz. Onlar `belge-turu/{id}` ile
    ELLE, aslına bakılarak damgalanır.

    ⚠️ Zaten damgalı belgeye DOKUNULMAZ (elle konan damga otomatiği yener).
    `kuru=1` iken hiçbir şey yazılmaz; ne yazılacağı listelenir.
    """
    g = max(30, min(1460, int(gun or 730)))
    teshis = belge_turu_teshisi(gun=g)
    plan = []
    for r in teshis.get("satirlar", []):
        if r["guven"] == "YUKSEK":
            hedef = "irsaliye"
        elif r["guven"] == "BILGI":
            hedef = "irsaliyeli_fatura"
        else:
            continue                      # ORTA → belirsiz, elle damgalanır
        plan.append({"fatura_id": r["fatura_id"], "belge_turu": hedef,
                     "tedarikci_ad": r["tedarikci_ad"], "fatura_no": r["fatura_no"],
                     "tarih": r["tarih"], "tutar": r["tutar"],
                     "gerekce": r["gerekce"][:150]})
    yazilan, atlanan = 0, []
    if not int(kuru or 0):
        with db() as (conn, cur):
            _belge_turu_kolonu(cur)
            for p in plan:
                cur.execute(
                    "UPDATE tedarikci_fatura SET belge_turu=%s, belge_turu_kaynak=%s "
                    "WHERE id=%s AND belge_turu IS NULL",   # elle damga korunur
                    (p["belge_turu"], "teshis", p["fatura_id"]))
                if cur.rowcount:
                    yazilan += 1
                else:
                    atlanan.append(p["fatura_id"])
            conn.commit()
    return {
        "gun": g, "kuru_calistirma": bool(int(kuru or 0)),
        "plan_adet": len(plan), "yazilan": yazilan,
        "atlanan_zaten_damgali": len(atlanan), "plan": plan,
        "belirsiz_elle_bekleyen": sum(1 for r in teshis.get("satirlar", [])
                                      if r["guven"] == "ORTA"),
        "not": ("ORTA kovadakiler BİLEREK damgalanmadı: orada 'fiyatı okunamamış "
                "fatura' ile 'saf irsaliye' ayırt edilemiyor. Belirsizi damgalamak "
                "belirsizliği KAYBETMEKTİR — damga atıldıktan sonra kimse geri dönüp "
                "bakmaz. Onlar POST /belge-turu/{fatura_id} ile aslına bakılarak "
                "elle damgalanmalı. Elle konan damga otomatik olanı yener ve "
                "yeniden işlemede EZİLMEZ."),
    }


# ═══════════════════════════════════════════════════════════════════════════
# 📦 BİRİM / KOLİ ADEDİ — "×72 kutu mu, koli mi?"
# ═══════════════════════════════════════════════════════════════════════════
_KOLI_DESEN = (
    re.compile(r"\*\s*(\d{1,3})\s*$"),            # "... 700 ML *6"
    re.compile(r"(\d{1,3})\s*[Xx]\s*(\d{1,3})\s*$"),  # "... 200 ML 4X6"
    re.compile(r"\*\s*(\d{1,3})\b"),              # "... *6 ..."
)


def _birim_kolonu(cur) -> None:
    """`siparis_urun.birim` + `koli_adet`. Boş = bilinmiyor (davranış değişmez)."""
    cur.execute("ALTER TABLE siparis_urun ADD COLUMN IF NOT EXISTS birim TEXT")
    cur.execute("ALTER TABLE siparis_urun ADD COLUMN IF NOT EXISTS koli_adet INT")
    cur.execute("ALTER TABLE siparis_urun ADD COLUMN IF NOT EXISTS birim_kaynak TEXT")


def _koli_coz(fatura_adi: str):
    """Fatura ürün adından koli adedini çıkarır. Bulamazsa None.

    Faturadaki ad zaten söylüyor: "FO VANİLYA AROMALI ŞURUP 700 ML *6" → 6,
    "AVOYA SADE ÇEVİR AÇ KAPAK 200 ML 4X6" → 24 (4×6). Yeni veri toplamaya
    gerek yok; ELİMİZDEKİ ad bu bilgiyi taşıyor.
    """
    t = (fatura_adi or "").strip()
    m = _KOLI_DESEN[1].search(t)
    if m:
        try:
            a, b = int(m.group(1)), int(m.group(2))
            if 1 <= a <= 100 and 1 <= b <= 100:
                return a * b
        except ValueError:
            pass
    for dsn in (_KOLI_DESEN[0], _KOLI_DESEN[2]):
        m = dsn.search(t)
        if m:
            try:
                k = int(m.group(1))
                if 2 <= k <= 100:
                    return k
            except ValueError:
                continue
    return None


class BirimBody(BaseModel):
    urun_id: str
    birim: str = "adet"           # adet | koli | kg | lt
    koli_adet: Optional[int] = None
    gerekce: Optional[str] = None


@router.get("/birim-onerileri")
def birim_onerileri(gun: int = 400):
    """📦 SİPARİŞ ÜRÜNÜ İÇİN KOLİ ADEDİ önerir — fatura adından öğrenilir. ÖNERİ-ONLY.

    ── NEDEN (2026-08-25) ──────────────────────────────────────────────────
    Fatura↔teslim mutabakatında iki dönem "FATURALANMAYAN TESLİM?" diye ZAYIF
    kanıtla asılı kaldı çünkü sipariş ile fatura AYNI BİRİMDE konuşmuyor:
        sipariş : "Redbull ×72"      (kutu)
        fatura  : 126 adet           (koli)
    Sayılar kıyaslanabilir değil; ölçüm hüküm veremiyor ve o alarm KAPANMIYOR.

    ── KAYNAK: FATURANIN KENDİ ADI ─────────────────────────────────────────
    Koli adedi zaten elimizde — faturadaki ürün adı söylüyor:
        "FO VANİLYA AROMALI ŞURUP 700 ML *6"        → 6
        "AVOYA SADE ÇEVİR AÇ KAPAK 200 ML 4X6"      → 24
    Yeni veri toplamaya, personele soru sormaya gerek yok. Kalem köprüsü
    sipariş adını fatura adına bağladığı için, koli adedi sipariş ürününe
    taşınabilir.

    ⚠️ ÖNERİ-ONLY: hiçbir ürün güncellenmez. Yanlış koli adedi, ölçümü
    düzeltmez BOZAR — 72 kutuyu 6'ya bölüp 12 koli sanmak, gerçek bir farkı
    gizler. Bu yüzden köprünün güveni de birlikte gösterilir; DÜŞÜK güvenli
    köprüden gelen öneri kullanılmamalıdır.
    """
    g = max(30, min(730, int(gun or 400)))
    kop = kalem_koprusu(gun=g)
    with db() as (_, cur):
        _birim_kolonu(cur)
        cur.execute("SELECT id, ad, COALESCE(birim,'') AS birim, koli_adet "
                    "FROM siparis_urun WHERE COALESCE(aktif,TRUE)")
        urunler = {(_tr_buyut(r["ad"]) if r["ad"] else ""): dict(r)
                   for r in (cur.fetchall() or [])}
    oneri, atlanan = [], []
    for k in kop.get("koprular", []):
        koli = _koli_coz(k["fatura_urun"])
        u = urunler.get(_tr_buyut(k["siparis_urun"]))
        if not u:
            atlanan.append({"siparis_urun": k["siparis_urun"],
                            "neden": "sipariş ürünü kataloğda bulunamadı"})
            continue
        if koli is None:
            atlanan.append({"siparis_urun": k["siparis_urun"],
                            "neden": "fatura adında koli bilgisi yok (%s)"
                                     % k["fatura_urun"][:40]})
            continue
        oneri.append({
            "urun_id": u["id"], "siparis_urun": k["siparis_urun"],
            "fatura_urun": k["fatura_urun"],
            "onerilen_koli_adet": koli,
            "mevcut_koli_adet": u.get("koli_adet"),
            "kopru_guveni": k["guven"],
            "kullanilabilir": k["guven"] in ("ONAYLI", "YUKSEK"),
            "gerekce": "fatura adından çözüldü: %s" % k["fatura_urun"][:60],
        })
    oneri.sort(key=lambda x: (not x["kullanilabilir"], x["siparis_urun"]))
    return {
        "gun": g, "oneri": len(oneri),
        "kullanilabilir": sum(1 for o in oneri if o["kullanilabilir"]),
        "atlanan": len(atlanan), "oneriler": oneri, "atlananlar": atlanan[:20],
        "not": ("ÖNERİ-ONLY — hiçbir ürün güncellenmedi. Koli adedi YENİ VERİ "
                "DEĞİLDİR: faturanın kendi adında zaten yazıyor ('*6', '4X6'). "
                "⚠️ Yanlış koli adedi ölçümü düzeltmez BOZAR — 72 kutuyu 6'ya bölüp "
                "12 koli sanmak gerçek bir farkı GİZLER. Bu yüzden köprü güveni "
                "birlikte gösterilir; DÜŞÜK güvenli köprüden gelen öneri "
                "kullanılmamalıdır (`kullanilabilir` alanı bunu söyler)."),
    }


@router.post("/birim-ata")
def birim_ata(body: BirimBody):
    """Sahibin birim/koli kararını ürüne yazar (kaynakta damgalanır)."""
    b = (body.birim or "adet").strip().lower()
    if b not in ("adet", "koli", "kg", "lt", "paket"):
        raise HTTPException(400, "birim: adet | koli | kg | lt | paket")
    k = body.koli_adet
    if k is not None and not (1 <= int(k) <= 1000):
        raise HTTPException(400, "koli_adet 1-1000 arası olmalı")
    with db() as (conn, cur):
        _birim_kolonu(cur)
        cur.execute(
            "UPDATE siparis_urun SET birim=%s, koli_adet=%s, birim_kaynak=%s "
            "WHERE id=%s RETURNING ad",
            (b, k, "sahip:" + ((body.gerekce or "")[:100] or "onay"), body.urun_id))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "ürün bulunamadı")
        conn.commit()
    return {"ok": True, "urun_id": body.urun_id, "ad": dict(r)["ad"],
            "birim": b, "koli_adet": k}


# ═══════════════════════════════════════════════════════════════════════════
# 🏢 ALIM KAYNAĞI — şube siparişi mi, MERKEZ alımı mı?
# ═══════════════════════════════════════════════════════════════════════════
def _capa_kolonu(cur) -> None:
    """`kalem_capa_farki` kolonunu garanti eder.

    ⚠️ TEMBEL KOLON TUZAĞI (2026-08-25, canlıda 500 verdi): kolon yazma yolunda
    (fatura_api._fatura_json_db_yaz) tembel yaratılıyor — yani ilk OCR yazana
    kadar YOKTUR. Okuyucu onu hemen sorgulayınca "column does not exist" ile
    patladı. Bir alanı OKUYAN taraf, o alanın VARLIĞINI de garanti etmelidir;
    "birazdan yazılır" varsayımı ilk çağrıda çöker.
    """
    cur.execute("ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS "
                "kalem_capa_farki NUMERIC(14,2)")
    # 🥚 TAVUK-YUMURTA KIRILIYOR (2026-08-25): bayrak yalnız OCR yazarken
    # doluyordu, gece kurtarması ise bayrağa bakıyordu → mevcut faturalar
    # hiçbir zaman yeniden okunmayacaktı. Yeni bir denetim kurulduğunda
    # GEÇMİŞ de bir kez taranmalı; yoksa denetim yalnız bundan sonrası için
    # çalışır ve elde duran hata sonsuza dek görünmez kalır.
    # Yalnız NULL olanlar doldurulur — OCR'ın yazdığı değer EZİLMEZ.
    cur.execute("""
        UPDATE tedarikci_fatura f
           SET kalem_capa_farki = ROUND(
                 COALESCE(f.toplam_tutar,0)::numeric
                 - COALESCE((SELECT SUM(COALESCE(k.satir_toplam,0))
                               FROM tedarikci_fatura_kalem k
                              WHERE k.fatura_id = f.id), 0)::numeric, 2)
         WHERE f.kalem_capa_farki IS NULL
           AND COALESCE(f.toplam_tutar,0) <> 0
           AND EXISTS (SELECT 1 FROM tedarikci_fatura_kalem k2
                        WHERE k2.fatura_id = f.id)
    """)


def _alim_kaynagi_kolonu(cur) -> None:
    """`tedarikci_fatura.alim_kaynagi` — sube | merkez. Boş = bilinmiyor."""
    cur.execute("ALTER TABLE tedarikci_fatura "
                "ADD COLUMN IF NOT EXISTS alim_kaynagi TEXT")
    cur.execute("ALTER TABLE tedarikci_fatura "
                "ADD COLUMN IF NOT EXISTS alim_kaynagi_not TEXT")


class AlimKaynagiBody(BaseModel):
    alim_kaynagi: str                 # sube | merkez
    gerekce: Optional[str] = None


@router.post("/alim-kaynagi/{fatura_id}")
def alim_kaynagi_ata(fatura_id: str, body: AlimKaynagiBody):
    """🏢 Faturayı 'MERKEZ ALIMI' olarak damgalar — bulguyu İZLİ şekilde kapatır.

    ── NEDEN (2026-08-25, sahip) ───────────────────────────────────────────
    Sahip: "Bu siparişler merkez tarafından, yani BİZ istedik."
    Duyu o faturalara "SİPARİŞSİZ GELEN MAL" diyordu — çünkü şube panelinde
    sipariş kaydı yok. Ama eksik olan KONTROL değil, KAYIT: merkez telefonla /
    doğrudan sipariş vermiş, sistem bunu görmemiş.

    ⚠️ Bu ayrım yapılmazsa duyu, sahibin KENDİ meşru alımını sonsuza dek
    "açıklanamayan mal" diye gösterir. Kapatılamayan alarm, bir süre sonra
    hiç okunmayan alarmdır — ve o zaman gerçek bir kaçak da fark edilmez.

    ⚠️ Damga BULGUYU SİLMEZ, ADINI DEĞİŞTİRİR: satır "MERKEZ ALIMI — sipariş
    paneli dışından, sahip onaylı" olarak görünmeye devam eder. İz kalır ki
    ileride "merkez ne kadar alım yapmış" sorusu da cevaplanabilsin.

    💡 KALICI ÇÖZÜM: merkez alımları için sistemde zaten uç var —
    POST /api/ops/siparis/merkez-siparis-olustur. Oradan girilirse bu damgaya
    hiç gerek kalmaz ve zincir baştan tam kurulur.
    """
    k = (body.alim_kaynagi or "").strip().lower()
    if k not in ("sube", "merkez"):
        raise HTTPException(400, "alim_kaynagi: sube | merkez")
    with db() as (conn, cur):
        _alim_kaynagi_kolonu(cur)
        cur.execute(
            "UPDATE tedarikci_fatura SET alim_kaynagi=%s, alim_kaynagi_not=%s "
            "WHERE id=%s RETURNING tedarikci_ad, fatura_no, fatura_tarih::text AS t, "
            "                      COALESCE(toplam_tutar,0)::float AS tutar",
            (k, (body.gerekce or "sahip beyanı")[:200], fatura_id))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "fatura bulunamadı")
        conn.commit()
    d = dict(r)
    return {"ok": True, "fatura_id": fatura_id, "alim_kaynagi": k,
            "tedarikci": d["tedarikci_ad"], "fatura_no": d["fatura_no"],
            "tarih": d["t"], "tutar": d["tutar"],
            "not": ("Damga bulguyu SİLMEZ, adını değiştirir — satır 'MERKEZ ALIMI' "
                    "olarak görünmeye devam eder. Kalıcı çözüm: merkez alımlarını "
                    "POST /api/ops/siparis/merkez-siparis-olustur ile sisteme girmek.")}


@router.get("/merkez-alimlari")
def merkez_alimlari(gun: int = 400):
    """Merkez damgalı faturalar — "merkez ne kadar alım yaptı?" sorusunun cevabı."""
    g = max(30, min(730, int(gun or 400)))
    with db() as (_, cur):
        _alim_kaynagi_kolonu(cur)
        cur.execute(
            "SELECT tedarikci_ad, fatura_no, fatura_tarih::text AS tarih, "
            "       COALESCE(toplam_tutar,0)::float AS tutar, alim_kaynagi_not "
            "  FROM tedarikci_fatura "
            " WHERE alim_kaynagi='merkez' AND COALESCE(durum,'') <> 'kopya' "
            "   AND fatura_tarih >= CURRENT_DATE - %s "
            " ORDER BY fatura_tarih DESC", (g,))
        rows = [dict(r) for r in (cur.fetchall() or [])]
    return {"gun": g, "adet": len(rows),
            "toplam_tutar": round(sum(r["tutar"] for r in rows), 2),
            "faturalar": rows,
            "not": ("Merkez alımı = şube paneli dışından, merkez tarafından yapılan "
                    "alım. Bulgu değildir ama GÖRÜNÜR kalır: 'merkez ne kadar alım "
                    "yapıyor' sorusu da bir denetim sorusudur.")}


@router.get("/merkez-kayit-boslugu")
def merkez_kayit_boslugu(gun: int = 120):
    """🏢 SİSTEMDEN GEÇMEYEN MERKEZ ALIMLARI — boşluk tekrar açılmasın. SALT OKUR.

    ── NEDEN (2026-08-25) ──────────────────────────────────────────────────
    Sahip: "Bu siparişler merkez tarafından, yani BİZ istedik."
    Sistemde merkez siparişi için TAM BİR AKIŞ ZATEN VAR — Cep ekranından
    seçim yapılıyor, `merkez-siparis-olustur` kaydı açıyor ve WhatsApp mesajı
    hazırlanıyor. Eksik olan MEKANİZMA DEĞİL, KULLANIM: o iki METRO alımı
    telefonla/doğrudan verilmiş, sistem hiç görmemiş.

    ⚠️ Geçmişi damgalamak (alim_kaynagi='merkez') o iki faturayı kapatır ama
    BOŞLUĞU KAPATMAZ — üçüncüsü aynı şekilde girer. Şubelere hatırlatma
    gönderdiğimizde öğrendiğimiz şeyin aynısı: liste temizlemek alışkanlığı
    değiştirmez, ÖLÇÜM değiştirir.

    Bu uç, merkez damgalı ama SİSTEMDE SİPARİŞ KAYDI OLMAYAN alımları sayar.
    Sayı düşüyorsa akış kullanılmaya başlanmış; artıyorsa hatırlatma gerekiyor.

    ── NEDEN ÖNEMLİ (damga bir çözüm değil, bir kayıt) ─────────────────────
    Merkez alımı sistemden geçmezse şu üç şey KENDİLİĞİNDEN olmaz:
      · şube "teslim al" ekranında o malı GÖRMEZ → stok artmaz
      · belge talebi açılmaz → faturası kovalanmaz
      · tedarik zinciri ölçümü o faturayı açıklayamaz
    Yani mesele "alarm sussun" değil, ZİNCİRİN KURULMASIDIR.
    """
    g = max(30, min(730, int(gun or 120)))
    with db() as (_, cur):
        _alim_kaynagi_kolonu(cur)
        cur.execute(
            "SELECT f.id, f.tedarikci_ad, f.fatura_no, f.fatura_tarih::text AS tarih, "
            "       COALESCE(f.toplam_tutar,0)::float AS tutar "
            "  FROM tedarikci_fatura f "
            " WHERE f.alim_kaynagi='merkez' AND COALESCE(f.durum,'') <> 'kopya' "
            "   AND f.fatura_tarih >= CURRENT_DATE - %s "
            " ORDER BY f.fatura_tarih DESC", (g,))
        damgali = [dict(r) for r in (cur.fetchall() or [])]
        cur.execute(
            "SELECT COUNT(*) AS n, COALESCE(MAX(olusturma)::date::text,'') AS son "
            "  FROM toptanci_siparis "
            " WHERE COALESCE(kaynak,'') = 'merkez' "
            "   AND olusturma >= CURRENT_DATE - %s", (g,))
        sk = dict(cur.fetchone() or {})
    kayitli = int(sk.get("n") or 0)
    return {
        "gun": g,
        "sistemden_gecen_merkez_siparisi": kayitli,
        "son_merkez_siparisi": sk.get("son") or None,
        "sistemden_gecmeyen_alim": len(damgali),
        "sistemden_gecmeyen_tutar": round(sum(x["tutar"] for x in damgali), 2),
        "faturalar": damgali,
        "durum": ("AKIŞ KULLANILIYOR" if kayitli > 0 and not damgali
                  else "KISMEN" if kayitli > 0
                  else "AKIŞ HİÇ KULLANILMIYOR"),
        "not": ("Merkez siparişi için sistemde TAM AKIŞ var: Cep ekranı → "
                "merkez-siparis-olustur → WhatsApp. Buradan geçmeyen alımda ÜÇ ŞEY "
                "kendiliğinden OLMAZ: şube 'teslim al' ekranında malı görmez (stok "
                "artmaz) · belge talebi açılmaz (fatura kovalanmaz) · tedarik ölçümü "
                "o faturayı açıklayamaz. Mesele 'alarm sussun' değil ZİNCİRİN "
                "KURULMASIDIR — damga bir çözüm değil, bir kayıttır."),
    }


# ═══════════════════════════════════════════════════════════════════════════
# 📨 EKSİK FATURA İSTEĞİ — bulguyu DAMGALAMAK yetmez, İSTEMEK gerekir
# ═══════════════════════════════════════════════════════════════════════════
@router.post("/eksik-fatura-iste")
def eksik_fatura_iste(gun: int = 200, kuru: int = 1):
    """📨 "KISMİ FATURA" bulgularını FATURA İSTEĞİNE çevirir. Varsayılan KURU.

    ── NEDEN (2026-08-25, sahip uyarısı) ───────────────────────────────────
    Sahip: "Fatura eksik damgalıyorsun ama İSTEĞİ kurgulamamışsın!"
    Haklıydı. Duyu "KISMİ FATURA — kalanı ayrı faturada olabilir" diyordu ve
    orada duruyordu. Eksiği GÖRMEK ile eksiği İSTEMEK ayrı işlerdir; ikincisi
    yapılmazsa bulgu bir rapor satırı olarak kalır ve fatura hiç gelmez.

    ── NEDEN YENİ BİR SİSTEM KURULMADI ─────────────────────────────────────
    Sistemde `fatura_istek` tablosu ZATEN var ve tam yaşam döngüsü kurulu:
        aday → istek_gonderildi → fatura_geldi → kapandi
    wa.me mesajı, tedarikçi gruplama, mesaj sayacı, kapanış — hepsi hazır.
    İkinci bir istek sistemi kurmak iki ayrı "fatura bekleyenler" listesi
    doğururdu ve ikisi kaçınılmaz olarak ayrışırdı. Bu uç, bulguları O
    TABLOYA besler; `kaynak_tip='tedarik_eksik'` ile ayırt edilir ve mevcut
    Belge Merkezi ekranında diğer istekler gibi görünür.

    ── NE İSTENİR ──────────────────────────────────────────────────────────
    Sipariş edilip TESLİM ALINAN ama faturada YER ALMAYAN kalemler. Mesaj
    genel değil KALEM KALEM olur — "eksik fatura var" demek tedarikçiye hiçbir
    şey anlatmaz; "Filtre Kahve 5, Redbull 72, Su 360" anlatır.

    `kuru=1` (varsayılan): hiçbir şey yazılmaz, ne isteneceği listelenir.
    """
    g = max(30, min(730, int(gun or 200)))
    mut = fatura_teslim_mutabakati(gun=g)
    plan = []
    for grp in mut.get("donemler", []):
        if not str(grp.get("durum") or "").startswith("KISMİ FATURA"):
            continue
        # Faturada geçen kalem adları (kaba karşılaştırma için belirteç kümesi)
        fat_bel = set()
        for f in mut.get("faturalar", []):
            if f.get("fatura_no") in (grp.get("faturalar") or []):
                fat_bel |= _urun_belirtec(str(f.get("tedarikci_ad") or ""))
        eksik = []
        for s in (grp.get("tum_siparisler") or []):
            for parca in (s.get("ozet") or "").split("·"):
                parca = parca.strip()
                if parca:
                    eksik.append(parca)
        plan.append({
            "tedarikci_ad": grp["tedarikci_ad"],
            "donem": "%s..%s" % (grp["donem_bas"], grp["donem_bit"]),
            "faturalar": grp.get("faturalar"),
            "fatura_adet": grp["fatura_adet"],
            "teslim_adet": grp["teslim_alinan_adet"],
            "eksik_adet": abs(grp["adet_farki"]),
            "siparis_kalemleri": eksik,
            "kaynak_id": "tedarik|%s|%s" % (grp["tedarikci_ad"][:40], grp["donem_bit"]),
        })

    yazilan, atlanan = 0, 0
    if not int(kuru or 0) and plan:
        with db() as (conn, cur):
            for p in plan:
                cur.execute("SELECT id, telefon FROM tedarikciler "
                            "WHERE UPPER(ad) = ANY(%s) AND COALESCE(aktif,TRUE) LIMIT 1",
                            (_ad_adaylari(p["tedarikci_ad"]),))
                _t = dict(cur.fetchone() or {})
                _aciklama = ("Sipariş edilip teslim alınan ama faturada yer almayan "
                             "kalemler (%s dönemi, %.0f adet fark): %s"
                             % (p["donem"], p["eksik_adet"],
                                " · ".join(p["siparis_kalemleri"][:12])))
                cur.execute(
                    "INSERT INTO fatura_istek "
                    "(kaynak_tip, kaynak_id, tarih, tutar, aciklama, kanal_detay, "
                    " tedarikci_ad, tedarikci_tel, durum) "
                    "VALUES ('tedarik_eksik', %s, %s::date, NULL, %s, 'tedarik zinciri', "
                    "        %s, %s, 'aday') "
                    "ON CONFLICT (kaynak_tip, kaynak_id) DO NOTHING",
                    (p["kaynak_id"], p["donem"].split("..")[1], _aciklama,
                     p["tedarikci_ad"], _t.get("telefon")))
                if cur.rowcount:
                    yazilan += 1
                else:
                    atlanan += 1
            conn.commit()
    return {
        "gun": g, "kuru_calistirma": bool(int(kuru or 0)),
        "plan_adet": len(plan), "yazilan": yazilan,
        "atlanan_zaten_var": atlanan, "plan": plan,
        "not": ("Eksiği GÖRMEK ile eksiği İSTEMEK ayrı işlerdir. Bu uç bulguları "
                "MEVCUT `fatura_istek` tablosuna besler (kaynak_tip='tedarik_eksik') "
                "— ikinci bir istek sistemi kurulmadı, çünkü iki ayrı 'fatura "
                "bekleyenler' listesi kaçınılmaz olarak ayrışır. Kayıtlar Belge "
                "Merkezi'nde diğer istekler gibi görünür; wa.me mesajı, tedarikçi "
                "gruplama ve kapanış akışı ZATEN oradadır. Mesaj kalem kalem yazılır: "
                "'eksik fatura var' tedarikçiye hiçbir şey anlatmaz."),
    }
