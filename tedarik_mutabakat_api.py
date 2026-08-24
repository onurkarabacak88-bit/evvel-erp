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

        sonuc: List[Dict] = []
        sayac = {"tutuyor": 0, "kayit_kapanmamis": 0, "siparissiz": 0,
                 "faturalanmamis_teslim": 0, "olculemez": 0}
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

            adaylar = _ad_adaylari(f["tedarikci_ad"])
            cur.execute(
                "SELECT ts.id, ts.olusturma, ts.teslim_ts, ts.kalemler, s.ad AS sube_adi "
                "  FROM toptanci_siparis ts "
                "  LEFT JOIN tedarikciler td ON td.id = ts.tedarikci_id "
                "  LEFT JOIN subeler s ON s.id = ts.sube_id "
                " WHERE ts.olusturma >= %s::date - %s "
                "   AND ts.olusturma <= %s::date + %s "
                "   AND (UPPER(COALESCE(ts.tedarikci_ad,'')) = ANY(%s) "
                "        OR UPPER(COALESCE(td.ad,'')) = ANY(%s)) "
                " ORDER BY ts.olusturma",
                (f["tarih"], pen, f["tarih"], pen, adaylar, adaylar),
            )
            sip: List[Dict] = []
            for r in (cur.fetchall() or []):
                d = dict(r)
                kl = _kalem_listesi(d.get("kalemler"))
                sip.append({
                    "ts_id": d["id"], "sube_adi": d.get("sube_adi"),
                    "siparis_ts": str(d.get("olusturma") or "")[:19],
                    "teslim_alindi": bool(d.get("teslim_ts")),
                    "adet": round(sum(float(k.get("adet") or 0) for k in kl), 2),
                    "ozet": " · ".join(
                        str(k.get("urun_ad") or k.get("ad") or "?") + " ×" + str(k.get("adet"))
                        for k in kl[:4]),
                })
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
                kayit["eylem"] = "Şube bu siparişleri teslim-al ile kapatmalı."
                sayac["kayit_kapanmamis"] += 1
            elif fark > 1:
                kayit["durum"] = "SİPARİŞSİZ GELEN MAL — faturada var, sipariş yok"
                kayit["eylem"] = ("Sistem dışı gelen mal olabilir; elle belge talebi "
                                  "açılmalı ya da sipariş penceresi genişletilmeli.")
                sayac["siparissiz"] += 1
            else:
                kayit["durum"] = "FATURALANMAYAN TESLİM — teslim alınan, faturadan fazla"
                kayit["eylem"] = "Eksik fatura tedarikçiden istenmeli."
                sayac["faturalanmamis_teslim"] += 1
            sonuc.append(kayit)

    return {
        "tedarikci": t or "(hepsi)", "gun": g, "pencere_gun": pen,
        "toplam": len(sonuc), "ozet": sayac,
        "olculebilen": sum(1 for x in sonuc if x.get("olcum_gecerli")),
        "olculemeyen": sayac["olculemez"],
        "faturalar": sonuc,
        "not": ("ÖNERİ-ONLY — hiçbir kayıt yazılmadı. Çapa ADETTİR: ürün adları iki "
                "dünyada farklı yazıldığı için ada dayanan ölçüm kırılır, adet kırılmaz. "
                "Kalemleri okunmamış fatura ÖLÇÜLEMEZ sayılır ve toplamlara girmez — "
                "kör aletle defter suçlanmaz. 'MAL GELDİ, SİPARİŞ KAPANMADI' bir "
                "muhasebe hatası değil KAYIT eksiğidir: şube teslim-al ile kapatmalıdır."),
    }
