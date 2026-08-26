"""
ARAMA — "şu belirli şeyi arıyorum" sorusunun TEK kapısı. İZOLE, SALT OKUR.

── NEDEN VAR (2026-08-26, Codex bulunabilirlik denetimi) ────────────────────
Codex: "'bugün ne yapmalıyım' akışı güçlü; 'şu spesifik şeyi arıyorum' akışı
parçalı." Sahibin günlük soruları çoğunlukla VERİ sorusudur:
    "geçen ay FEZ'e ne ödedik"  ·  "şu faturanın izi nerede"
    "bu tutar hangi kayıttan"   ·  "Ahmet'in bordrosu nerede"
Sistemde arama vardı ama PARÇALIYDI: ⌘K paleti yalnız EKRAN ADI arıyordu,
fatura araması Belge Merkezi'nin içine gömülüydü, ödeme/kasa/personel için
arama HİÇ yoktu. Sahip önce hangi modülün hangi soruyu cevapladığını bilmek
zorundaydı — bilgiyi bilene kolay, bilmeyene imkânsız yapan klasik kusur.

── NE KURULMADI (yerleşim disiplini) ────────────────────────────────────────
⚠️ FATURA ARAMASI YENİDEN YAZILMADI. `GET /api/fatura/ara` ZATEN var ve iyi:
GIN indeksli tsvector + ILIKE yedeği, tedarikçi adı + fatura no + belge metni +
KALEM adları üzerinde. Bu modül onu ÇAĞIRIR. İkinci bir fatura araması iki ayrı
"fatura bulundu" sonucu doğururdu ve ikisi kaçınılmaz olarak ayrışırdı.
Buraya eklenen YALNIZ eksik kaynaklar: ödeme planı · kasa hareketi ·
tedarikçi kartı · personel.

── DOKTRİNLER ───────────────────────────────────────────────────────────────
· SALT OKUR — hiçbir tabloya yazmaz, hiçbir şey değiştirmez.
· HATA ≠ BOŞ — bir kaynak düşerse "sonuç yok" DENMEZ; o kaynağın okunamadığı
  AÇIKÇA söylenir. Yoksa arıza, "aradığın şey yok" gibi görünür ve sahip
  olmayan bir gerçeğe ikna olur.
· SESSİZ ELEME YASAK — her kaynak kaç kayıt buldu, kaçını gösterdi, ayrı yazar.
· HER SONUÇ BİR KAPI — sonuç tıklanınca gideceği ekran (köprü) ile birlikte
  döner. Gösterip götürmemek, aramanın yarısını yapmaktır.
· ŞEMA VARSAYILMAZ — kolon adları information_schema'dan OKUNUR. Olmayan
  kolona sorgu yazmak, tüm aramayı tek bir tabloda çökertirdi.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional, Set
from urllib.parse import quote

from fastapi import APIRouter, HTTPException

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/ara", tags=["arama"])

# Köprü hedefleri — HEPSİ tema.js MODULLER ağacından doğrulandı (2026-08-26):
#   belge/arsiv (tema.js:319) · odeme/bekleyen (202) · odeme/tedarikci (206)
#   rapor/defter (205) · ekip/kadro (306)
# ⚠️ Doğrulanmamış hedef sessizce YANLIŞ ekrana düşürür — bu yüzden sabitler
# burada, tek yerde durur ve satır numaralarıyla birlikte yazılır.
HEDEF = {
    "fatura": "__modul:belge:arsiv",
    "odeme": "__modul:odeme:bekleyen",
    "tedarikci": "__modul:belge:cari",
    "kasa": "__modul:rapor:defter",
    "personel": "__modul:ekip:kadro",
}

# ══════════════════════════════════════════════════════════════════════════
# 🎯 KAYDA GÖTÜRME (2026-08-26) — "ekrana götürmek yetmez"
# ══════════════════════════════════════════════════════════════════════════
# İlk sürüm sonucu doğru EKRANA götürüyordu ama sahip orada kaydı TEKRAR
# aramak zorundaydı — aramanın yarısı. Kabuk zaten 4. parçayı parametre olarak
# çözüyor (`__modul:<modul>:<gorunum>:<deger>` → kopruParam) ve iki tüketici
# var: Ödeme Merkezi (kalemi açar) ve Cari Ekstre (tedarikçiyi açar).
#
# ⚠️ PARAMETRE YALNIZ TÜKETİCİSİ OLAN HEDEFE EKLENİR. Tüketicisi olmayan
# ekrana parametre yollamak sessizce yutulur ve "kayda götürdüm" YALANI
# üretir — kasa hareketi ve personel bu yüzden parametresiz kalır.
def _hedef(tur: str, deger: Optional[str] = None) -> str:
    t = HEDEF[tur]
    if deger and tur in ("fatura", "odeme", "tedarikci"):
        return f"{t}:{quote(str(deger), safe='')}"
    return t


def _kolonlar(cur, tablo: str) -> Set[str]:
    """Tablonun GERÇEK kolon adları. Şema varsayılmaz, sorulur."""
    cur.execute(
        "SELECT column_name FROM information_schema.columns "
        " WHERE table_schema='public' AND table_name=%s", (tablo,))
    return {r["column_name"] for r in (cur.fetchall() or [])}


def _ilk_var(kolonlar: Set[str], adaylar: List[str]) -> Optional[str]:
    """Adaylardan tabloda GERÇEKTEN olan ilkini seç (kolon adı tahmini yok)."""
    for a in adaylar:
        if a in kolonlar:
            return a
    return None


def _tl(v) -> Optional[float]:
    try:
        return round(float(v), 2)
    except Exception:  # noqa: BLE001
        return None


def _metin_kosulu(alanlar: List[str]) -> str:
    """Verilen kolonlarda ILIKE araması — hepsi OR'lanır."""
    return " OR ".join(f"COALESCE({a}::text,'') ILIKE %s" for a in alanlar)


@router.get("")
def ara(q: str, limit: int = 6):
    """🔎 TEK ARAMA KAPISI — beş kaynakta arar, her sonucu bir kapıya bağlar.

    Dönen her sonuç: {tur, baslik, alt, tutar, tarih, hedef}
    `hedef` = v2 köprü adresi; ekran onu tıklanabilir yapar.

    ⚠️ Her kaynak KENDİ try/except'inde: biri patlarsa diğerleri çalışmaya
    devam eder ve patlayan kaynak `kaynak_durumu` içinde ADIYLA raporlanır.
    Sessizce atlansaydı sahip eksik sonucu tam sanırdı.
    """
    q = (q or "").strip()
    if len(q) < 2:
        raise HTTPException(400, "En az 2 harf yazın")
    lim = max(1, min(25, int(limit or 6)))
    kalip = f"%{q}%"
    sonuclar: List[Dict[str, Any]] = []
    durum: Dict[str, Any] = {}

    # ── 1) FATURA — MEVCUT tam metin aramasını çağırır, yeniden yazmaz ──────
    try:
        from fatura_api import fatura_ara
        fr = fatura_ara(q=q, limit=lim)
        for f in (fr.get("sonuclar") or [])[:lim]:
            sonuclar.append({
                "tur": "fatura",
                "baslik": f"{f.get('tedarikci_ad') or '—'} · {f.get('fatura_no') or 'no yok'}",
                "alt": "fatura",
                "tutar": _tl(f.get("tutar")),
                "tarih": f.get("tarih"),
                "hedef": _hedef("fatura", f.get("fatura_no")),
            })
        durum["fatura"] = {"bulunan": int(fr.get("adet") or 0), "gosterilen": min(lim, int(fr.get("adet") or 0))}
    except Exception as e:  # noqa: BLE001
        durum["fatura"] = {"hata": str(e)[:120]}

    with db() as (_, cur):
        # ── 2) ÖDEME PLANI ──────────────────────────────────────────────────
        try:
            k = _kolonlar(cur, "odeme_plani")
            ad = _ilk_var(k, ["ad", "aciklama", "gider_adi", "baslik"])
            if ad:
                aramalar = [a for a in ("ad", "aciklama", "gider_adi") if a in k] or [ad]
                tutar_k = _ilk_var(k, ["tutar", "odenecek_tutar", "asgari_tutar"])
                tarih_k = _ilk_var(k, ["odeme_tarihi", "plan_tarihi", "tarih", "vade_tarihi"])
                # 🎯 `id` KAYDA GÖTÜRMEK İÇİN: Ödeme Merkezi hedefi `o.id` /
                # `o.odeme_id` / `o.sabit_gider_id` ile eşleştiriyor
                # (OdemeModulu.hedefEslesir). Kimlik yoksa parametre yollanmaz —
                # eşleşmeyecek bir kimlik yollamak "bulunamadı" tostu doğurur.
                kimlik_k = "id" if "id" in k else None
                # ⚠️ DURUM DA OKUNUR (2026-08-26, canlı doğrulamada çıktı):
                # "Bekleyen Ödemeler" ekranı SADECE bekleyenleri ve yalnız 14
                # günlük pencereyi gösteriyor. Arama ise ÖDENMİŞ kayıtları da
                # buluyor — ki "geçen ay FEZ'e ne ödedik" sorusunun cevabı tam
                # olarak onlar. Ödenmiş bir kaydı bekleyen kuyruğuna köprülemek
                # HİÇBİR ZAMAN eşleşmez ve sahibe "bulunamadı" tostu attırır:
                # arama doğru cevabı bulup YANLIŞ KAPIYA götürmüş olur.
                # Çözüm: durumuna göre kapı seç (bekliyor → kuyruk · ödendi →
                # Ödeme Geçmişi). Ödenmişte parametre YOK — o ekranın tüketicisi
                # yok, parametre yollamak "kayda götürdüm" yalanı olurdu.
                durum_k = _ilk_var(k, ["durum", "odeme_durumu"])
                cur.execute(
                    f"SELECT {ad} AS baslik"
                    f"{f', {durum_k}::text AS durum' if durum_k else ', NULL AS durum'}"
                    f"{f', {kimlik_k}::text AS kimlik' if kimlik_k else ', NULL AS kimlik'}"
                    f"{f', {tutar_k} AS tutar' if tutar_k else ', NULL AS tutar'}"
                    f"{f', {tarih_k}::text AS tarih' if tarih_k else ', NULL AS tarih'}"
                    f", COUNT(*) OVER () AS toplam "
                    f"  FROM odeme_plani WHERE {_metin_kosulu(aramalar)} "
                    f" ORDER BY {tarih_k or ad} DESC NULLS LAST LIMIT %s",
                    tuple([kalip] * len(aramalar) + [lim]))
                rows = [dict(r) for r in (cur.fetchall() or [])]
                for r in rows:
                    d = str(r.get("durum") or "").lower()
                    bekliyor = d in ("", "bekliyor", "aktif", "planlandi")
                    sonuclar.append({
                        "tur": "odeme",
                        "baslik": str(r.get("baslik") or "—")[:90],
                        # Sahip nereye gideceğini ÖNCEDEN bilsin: satırın kendisi
                        # ödenmiş mi bekliyor mu söyler.
                        "alt": "ödeme planı · bekliyor" if bekliyor else f"ödeme planı · {d or 'geçmiş'}",
                        "tutar": _tl(r.get("tutar")),
                        "tarih": r.get("tarih"),
                        "hedef": (_hedef("odeme", r.get("kimlik")) if bekliyor
                                  else "__modul:odeme:gecmis"),   # tema.js:251
                    })
                durum["odeme"] = {"bulunan": int(rows[0]["toplam"]) if rows else 0,
                                  "gosterilen": len(rows)}
            else:
                durum["odeme"] = {"hata": "aranabilir metin kolonu bulunamadı"}
        except Exception as e:  # noqa: BLE001
            durum["odeme"] = {"hata": str(e)[:120]}

        # ── 3) KASA HAREKETİ ────────────────────────────────────────────────
        try:
            k = _kolonlar(cur, "kasa_hareketleri")
            aramalar = [a for a in ("aciklama", "islem_turu") if a in k]
            if aramalar:
                cur.execute(
                    "SELECT COALESCE(aciklama, islem_turu) AS baslik, islem_turu, "
                    "       tutar, tarih::text AS tarih, COUNT(*) OVER () AS toplam "
                    f"  FROM kasa_hareketleri WHERE durum='aktif' AND ({_metin_kosulu(aramalar)}) "
                    "  ORDER BY tarih DESC LIMIT %s",
                    tuple([kalip] * len(aramalar) + [lim]))
                rows = [dict(r) for r in (cur.fetchall() or [])]
                for r in rows:
                    sonuclar.append({
                        "tur": "kasa", "baslik": str(r.get("baslik") or "—")[:90],
                        "alt": f"kasa · {r.get('islem_turu') or '—'}",
                        "tutar": _tl(r.get("tutar")), "tarih": r.get("tarih"),
                        "hedef": _hedef("kasa"),
                    })
                durum["kasa"] = {"bulunan": int(rows[0]["toplam"]) if rows else 0,
                                 "gosterilen": len(rows)}
            else:
                durum["kasa"] = {"hata": "aranabilir metin kolonu bulunamadı"}
        except Exception as e:  # noqa: BLE001
            durum["kasa"] = {"hata": str(e)[:120]}

        # ── 4) TEDARİKÇİ KARTI ──────────────────────────────────────────────
        try:
            k = _kolonlar(cur, "tedarikciler")
            if "ad" in k:
                aramalar = [a for a in ("ad", "telefon", "vergi_no") if a in k]
                cur.execute(
                    "SELECT ad, COUNT(*) OVER () AS toplam "
                    f"  FROM tedarikciler WHERE {_metin_kosulu(aramalar)} "
                    "  ORDER BY ad LIMIT %s", tuple([kalip] * len(aramalar) + [lim]))
                rows = [dict(r) for r in (cur.fetchall() or [])]
                for r in rows:
                    sonuclar.append({
                        "tur": "tedarikci", "baslik": str(r.get("ad") or "—")[:90],
                        "alt": "tedarikçi · cari bakiye", "tutar": None, "tarih": None,
                        "hedef": _hedef("tedarikci", r.get("ad")),
                    })
                durum["tedarikci"] = {"bulunan": int(rows[0]["toplam"]) if rows else 0,
                                      "gosterilen": len(rows)}
            else:
                durum["tedarikci"] = {"hata": "ad kolonu yok"}
        except Exception as e:  # noqa: BLE001
            durum["tedarikci"] = {"hata": str(e)[:120]}

        # ── 5) PERSONEL ─────────────────────────────────────────────────────
        try:
            k = _kolonlar(cur, "personel")
            ad = _ilk_var(k, ["ad_soyad", "ad", "isim"])
            if ad:
                cur.execute(
                    f"SELECT {ad} AS baslik, COUNT(*) OVER () AS toplam "
                    f"  FROM personel WHERE COALESCE({ad}::text,'') ILIKE %s "
                    f" ORDER BY {ad} LIMIT %s", (kalip, lim))
                rows = [dict(r) for r in (cur.fetchall() or [])]
                for r in rows:
                    sonuclar.append({
                        "tur": "personel", "baslik": str(r.get("baslik") or "—")[:90],
                        "alt": "personel", "tutar": None, "tarih": None,
                        "hedef": _hedef("personel"),
                    })
                durum["personel"] = {"bulunan": int(rows[0]["toplam"]) if rows else 0,
                                     "gosterilen": len(rows)}
            else:
                durum["personel"] = {"hata": "ad kolonu bulunamadı"}
        except Exception as e:  # noqa: BLE001
            durum["personel"] = {"hata": str(e)[:120]}

    bulunan = sum(int(v.get("bulunan") or 0) for v in durum.values() if "bulunan" in v)
    dusen = [ad for ad, v in durum.items() if "hata" in v]
    return {
        "q": q,
        "sonuclar": sonuclar,
        "gosterilen": len(sonuclar),
        "bulunan": bulunan,
        # ⚠️ HATA ≠ BOŞ: düşen kaynak ADIYLA döner. Ekran bunu yazmak ZORUNDA —
        # yoksa "3 sonuç" derken aslında iki kaynak hiç okunamamış olabilir ve
        # sahip eksik listeyi tam sanar.
        "dusen_kaynaklar": dusen,
        "kaynak_durumu": durum,
        "not": ("Fatura sonuçları MEVCUT tam metin aramasından gelir "
                "(/api/fatura/ara — GIN tsvector + kalem adları); burada yeniden "
                "yazılmadı. Bu uç yalnız eksik kaynakları ekler: ödeme planı, "
                "kasa hareketi, tedarikçi kartı, personel. Her sonuç bir köprü "
                "hedefiyle döner; göstermek yetmez, götürmek gerekir."),
    }
