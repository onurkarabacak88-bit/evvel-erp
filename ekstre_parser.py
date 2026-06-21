"""
ekstre_parser.py — Banka kredi kartı ekstresi (PDF metni) ayrıştırıcı.

Faz E0: Worldcard (Yapı Kredi / Worldpuan) + Enpara formatları.
Yalnızca METİN çıkarılabilen PDF'ler (Axess gibi gömülü-font/taranmış PDF'ler
OCR gerektirir; bu modül onları desteklemez — detect_bank 'bilinmiyor' döner).

Çıktı (dict): banka_format, son_dort, kesim_tarihi, son_odeme_tarihi, donem_borcu,
asgari_tutar, asgari_oran, limit, onceki_borc, donem_harcama, donem_odeme,
kalan_taksit, kart_sahibi, islemler[].
"""
from __future__ import annotations

import re
from datetime import date
from typing import Any, Dict, List, Optional

_AYLAR = {
    "ocak": 1, "şubat": 2, "subat": 2, "mart": 3, "nisan": 4, "mayıs": 5, "mayis": 5,
    "haziran": 6, "temmuz": 7, "ağustos": 8, "agustos": 8, "eylül": 9, "eylul": 9,
    "ekim": 10, "kasım": 11, "kasim": 11, "aralık": 12, "aralik": 12,
}


def _num(s: Optional[str]) -> Optional[float]:
    """'270.557,61 TL' / '+45.000,00' → 270557.61 / 45000.0"""
    if s is None:
        return None
    t = str(s)
    t = re.sub(r"(TL|₺)", "", t, flags=re.I)
    t = t.replace("+", "").replace(" ", "").strip()
    if not t:
        return None
    # Türk formatı: binlik '.', ondalık ','
    t = t.replace(".", "").replace(",", ".")
    t = re.sub(r"[^0-9.\-]", "", t)
    try:
        return round(float(t), 2)
    except ValueError:
        return None


def _tarih_ddmmyyyy(s: Optional[str]) -> Optional[str]:
    """'18/05/2026' → '2026-05-18'"""
    if not s:
        return None
    m = re.search(r"(\d{2})/(\d{2})/(\d{4})", s)
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None


def _tarih_tr_uzun(s: str) -> Optional[str]:
    """'8 Şubat 2026' → '2026-02-08'"""
    m = re.search(r"(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]+)\s+(\d{4})", s)
    if not m:
        return None
    g, ay_ad, y = int(m.group(1)), m.group(2).lower(), int(m.group(3))
    ay = _AYLAR.get(ay_ad)
    if not ay:
        return None
    try:
        return str(date(y, ay, g))
    except ValueError:
        return None


def _tarih_slash(s: str) -> Optional[str]:
    """'08/02/2026' → '2026-02-08'"""
    m = re.search(r"(\d{2})/(\d{2})/(\d{4})", s)
    if not m:
        return None
    try:
        return str(date(int(m.group(3)), int(m.group(2)), int(m.group(1))))
    except ValueError:
        return None


def _son_dort(text: str) -> Optional[str]:
    """Kart numarası maskesinden son 4 hane: '5400 61** **** 7708' → '7708'"""
    m = re.search(r"(\d{4})\s*\d{2}\*+\s*\*+\s*(\d{4})", text)
    if m:
        return m.group(2)
    m = re.search(r"\*{2,}\s*(\d{4})\b", text)
    return m.group(1) if m else None


def detect_bank(text: str) -> str:
    t = text.lower()
    # 1) Worldcard kesin işareti (Worldpuan) ÖNCE → worldcard hiçbir zaman ziraat'a kaçmaz
    if "worldpuan" in t:
        return "worldcard"
    # 2) Ziraat — yalnızca Ziraat'a ÖZGÜ güçlü işaretler ('bankkart' / 'ziraat'); 'önceki aydan
    #    devir' gibi GENEL ifadeler kullanılmaz (başka banka ekstresine kaçmasın)
    if "bankkart" in t or "ziraat" in t:
        return "ziraat"
    # 2b) Garanti (Bonus) — Yapı Kredi worldcard generic'inden ÖNCE
    if "bbva" in t or "bonus fb card" in t or "dönem borcunuz" in t:
        return "garanti"
    # 3) Generic worldcard (Yapı Kredi/Garanti vb. — worldpuan yok ama klasik başlık var)
    if "hesap kesim tarihi" in t and "dönem borcu" in t:
        return "worldcard"
    if "enpara" in t or ("ekstre borcu" in t and "minimum ödeme" in t):
        return "enpara"
    if "axess" in t or "wings" in t:
        return "axess_ocr_gerekli"
    return "bilinmiyor"


# ─────────────────────────── WORLDCARD ───────────────────────────
def parse_worldcard(text: str) -> Dict[str, Any]:
    def g(pat):
        m = re.search(pat, text, re.I)
        return m.group(1).strip() if m else None

    asgari_raw = g(r"Asgari\s*Tutar/Oran\s*:?\s*([\d.,]+)\s*TL")
    asgari_oran = g(r"Asgari\s*Tutar/Oran\s*:?\s*[\d.,]+\s*TL\s*/\s*(\d+)\s*%")
    # Sahip: BÜYÜK harf isim (re.I YOK — küçük harfli 'Müşteri Numarası' yakalanmasın)
    _sm = re.search(r"Sn\.\s*([A-ZÇĞİÖŞÜ][A-ZÇĞİÖŞÜ ]{3,})", text)
    if not _sm:
        _sm = re.search(r"\*{2,}\s*\d{4}\s+([A-ZÇĞİÖŞÜ][A-ZÇĞİÖŞÜ ]{3,})", text)
    sahip = _sm.group(1).strip() if _sm else None

    out = {
        "banka_format": "worldcard",
        "son_dort": _son_dort(text),
        "kesim_tarihi": _tarih_tr_uzun(g(r"Hesap Kesim Tarihi\s*:?\s*(.+)") or ""),
        "son_odeme_tarihi": _tarih_tr_uzun(g(r"Son Ödeme Tarihi\s*:?\s*(.+)") or ""),
        "donem_borcu": _num(g(r"Dönem Borcu\s*:?\s*([\d.,]+)")),
        "asgari_tutar": _num(asgari_raw),
        "asgari_oran": float(asgari_oran) if asgari_oran else None,
        "onceki_borc": _num(g(r"Önceki Dönem Hesap Özeti Borcu\s*:?\s*([\d.,]+)")),
        "donem_harcama": _num(g(r"Dönem İçi Harcamalar\s*:?\s*([\d.,]+)")),
        "donem_odeme": _num(g(r"Dönem İçi Ödemeler\s*:?\s*\+?([\d.,]+)")),
        "kalan_taksit": _num(g(r"Kalan Toplam Taksit Tutarı\s*:?\s*([\d.,]+)")),
        "limit": _num(g(r"Kart Limiti\s*:?\s*([\d.,]+)")),
        "kart_sahibi": (sahip or "").strip().title() or None,
    }
    out["islemler"] = _worldcard_islemler(text)
    out["donem_faizi"] = round(sum(float(i["tutar"] or 0) for i in out["islemler"] if i.get("tip") == "FAIZ"), 2)
    # Faiz oranları (ekstreden — her ay otomatik güncellenir): "Akdi Faiz Oranı %3,75 / %45,00"
    fa = re.search(r"Akdi Faiz Oranı\s*%[\d.,]+\s*/\s*%([\d.,]+)", text)
    fg = re.search(r"Gecikme Faiz Oranı\s*%[\d.,]+\s*/\s*%([\d.,]+)", text)
    out["akdi_faiz_yillik"] = _num(fa.group(1)) if fa else None
    out["gecikme_faiz_yillik"] = _num(fg.group(1)) if fg else None
    return out


def _worldcard_islemler(text: str) -> List[Dict[str, Any]]:
    islemler: List[Dict[str, Any]] = []
    satir_re = re.compile(
        r"^(\d{1,2}\s+[A-Za-zÇĞİÖŞÜçğıöşü]+\s+\d{4})\s+(.+?)\s+([+]?[\d.]+,\d{2})(?:\s+\d+)?\s*$"
    )
    taksit_re = re.compile(r"([\d.,]+)\s*TL'lik işlemin\s*(\d+)\s*/\s*(\d+)\s*taksidi", re.I)
    for ln in text.splitlines():
        ln = ln.strip()
        if not ln or "ÖNCEKİ DÖNEM" in ln.upper():
            continue
        tk = taksit_re.search(ln)
        if tk and islemler:
            islemler[-1]["taksit"] = f"{tk.group(2)}/{tk.group(3)}"
            islemler[-1]["taksit_anapara"] = _num(tk.group(1))
            continue
        m = satir_re.match(ln)
        if not m:
            continue
        tarih = _tarih_tr_uzun(m.group(1))
        aciklama = m.group(2).strip()
        tutar_raw = m.group(3)
        tutar = _num(tutar_raw)
        odeme = tutar_raw.strip().startswith("+") or "ÖDEME" in aciklama.upper()
        faiz = "DÖNEM FAİZİ" in aciklama.upper() or "FAİZ" in aciklama.upper()
        islemler.append({
            "tarih": tarih, "aciklama": aciklama, "tutar": tutar,
            "tip": "ODEME" if odeme else ("FAIZ" if faiz else "HARCAMA"),
        })
    return islemler


# ─────────────────────────── ENPARA ───────────────────────────
def parse_enpara(text: str) -> Dict[str, Any]:
    def g(pat):
        m = re.search(pat, text, re.I)
        return m.group(1).strip() if m else None

    out = {
        "banka_format": "enpara",
        "son_dort": _son_dort(text),
        "kesim_tarihi": _tarih_slash(g(r"Ekstre tarihi\s*([\d/]+)") or ""),
        "son_odeme_tarihi": _tarih_slash(g(r"Son ödeme tarihi\s*([\d/]+)") or ""),
        "donem_borcu": _num(g(r"Ekstre borcu\s*([\d.,]+)")),
        "asgari_tutar": _num(g(r"Minimum ödeme tutarı\s*([\d.,]+)")),
        "asgari_oran": None,
        "onceki_borc": _num(g(r"Bir önceki ekstre (?:bakiyeniz|borcu)\s*([\d.,]+)")),
        "donem_harcama": None,
        "donem_odeme": None,
        "kalan_taksit": None,
        "limit": _num(g(r"Kart limiti\s*([\d.,]+)")),
        "kart_sahibi": (g(r"Ad soyad\s*(.+)") or "").strip() or None,
    }
    out["islemler"] = _enpara_islemler(text)
    # Enpara: faiz başlıkta "Faiz, vergiler, ücreler ve diğer ... 925,57" satırında
    fm = re.search(r"Faiz[,\s].*?([\d.]+,\d{2})\s*TL", text)
    out["donem_faizi"] = _num(fm.group(1)) if fm else round(
        sum(float(i["tutar"] or 0) for i in out["islemler"] if i.get("tip") == "FAIZ"), 2)
    return out


def _enpara_islemler(text: str) -> List[Dict[str, Any]]:
    islemler: List[Dict[str, Any]] = []
    # 11/01/2026 Açıklama [a/b] [- ]12.257,00 TL
    satir_re = re.compile(
        r"^(\d{2}/\d{2}/\d{4})\s+(.+?)\s+(?:(\d+)\s*/\s*(\d+)\s+)?(-?\s?[\d.]+,\d{2})\s*TL\s*$"
    )
    for ln in text.splitlines():
        ln = ln.strip()
        m = satir_re.match(ln)
        if not m:
            continue
        aciklama = m.group(2).strip()
        tutar = _num(m.group(5))
        odeme = "ödeme" in aciklama.lower() or (m.group(5).strip().startswith("-"))
        faiz = "faiz" in aciklama.lower()
        rec = {
            "tarih": _tarih_slash(m.group(1)), "aciklama": aciklama,
            "tutar": abs(tutar) if tutar is not None else None,
            "tip": "ODEME" if odeme else ("FAIZ" if faiz else "HARCAMA"),
        }
        if m.group(3) and m.group(4):
            rec["taksit"] = f"{m.group(3)}/{m.group(4)}"
        islemler.append(rec)
    return islemler


def parse_ziraat(text: str) -> Dict[str, Any]:
    """Ziraat Bankkart ekstresi başlığı. İşlemler kart_analiz'den gelir (ekstre-yukle birleştirir)."""
    def g(pat, grp=1):
        m = re.search(pat, text, re.I)
        return m.group(grp).strip() if m else None

    # Kart no: "4446-####-####-3696" → son 4 = 3696
    son4 = g(r"\d{4}-#+-#+-(\d{4})")
    # Sahip (PDF'te maskeli olabilir, ör. 'F**** K********') — yine de al
    sahip = g(r"Say[ıi]n\s+([^\n]+)")
    if not sahip:
        sahip = g(r"KART NO\s*:.*?/\s*([^\n]+)")
    return {
        "banka_format": "ziraat",
        "son_dort": son4,
        "kesim_tarihi": _tarih_ddmmyyyy(g(r"Hesap Kesim Tarihi\s*:?\s*(\d{2}/\d{2}/\d{4})")),
        "son_odeme_tarihi": _tarih_ddmmyyyy(g(r"Son Ödeme Tarihi\s*:?\s*(\d{2}/\d{2}/\d{4})")),
        "donem_borcu": _num(g(r"Dönem Borcu TL\s*:?\s*([\d.,]+)\s*TL")),
        "asgari_tutar": _num(g(r"Asgari Ödeme Tutar[ıi] TL\s*:?\s*([\d.,]+)\s*TL")),
        "asgari_oran": None,
        "limit": _num(g(r"Kart Limiti\s*:?\s*([\d.,]+)")),
        "onceki_borc": _num(g(r"ÖNCEK[İI] AYDAN DEV[İI]R\s*([\d.,]+)")),
        "donem_harcama": None,
        "donem_odeme": None,
        "kalan_taksit": None,
        "donem_faizi": 0,
        "kart_sahibi": (sahip or "").strip() or None,
        "akdi_faiz_yillik": None,
        "gecikme_faiz_yillik": None,
        "islemler": [],
    }


def parse_garanti(text: str) -> Dict[str, Any]:
    """Garanti BBVA (Bonus) ekstresi başlığı. İşlemler kart_analiz'den gelir."""
    def g(pat, grp=1):
        m = re.search(pat, text, re.I)
        return m.group(grp).strip() if m else None

    son4 = g(r"\d{4}\s+\d{2}\*+\s+\*+\s+(\d{4})") or _son_dort(text)
    _sm = re.search(r"Say[ıi]n\s+([A-ZÇĞİÖŞÜ][A-ZÇĞİÖŞÜ ]{3,})", text)
    sahip = _sm.group(1).strip() if _sm else None
    return {
        "banka_format": "garanti",
        "son_dort": son4,
        "kesim_tarihi": _tarih_tr_uzun(g(r"Hesap Kesim Tarihi\s*:?\s*(\d{1,2}\s+[A-Za-zÇĞİÖŞÜçğıöşü]+\s+\d{4})") or ""),
        "son_odeme_tarihi": _tarih_tr_uzun(g(r"Son Ödeme Tarihi\s*:?\s*(\d{1,2}\s+[A-Za-zÇĞİÖŞÜçğıöşü]+\s+\d{4})") or ""),
        "donem_borcu": _num(g(r"Dönem Borcunuz\s*:?\s*([\d.,]+)")),
        "asgari_tutar": _num(g(r"Min\.?\s*Ödeme Tutar[ıi]\s*:?\s*([\d.,]+)")),
        "asgari_oran": None,
        "limit": _num(g(r"Kart Limiti\s*:?\s*([\d.,]+)")),
        # Bankanın yazdığı GERÇEK kullanılabilir limit (gelecek taksit anaparasını da
        # düşer → limit−borç'tan farklı). "nakit limitiniz" satırını ELE: kullan...limit
        # arasında 'nakit' geçen satır eşleşmez.
        "kullanilabilir_limit": _num(g(r"kullan\S*\s+limit\S*\s+([\d.,]+)\s*TL")),
        "onceki_borc": None,
        "donem_harcama": None,
        "donem_odeme": None,
        "kalan_taksit": None,
        "donem_faizi": 0,
        "kart_sahibi": (sahip or "").strip().title() or None,
        "akdi_faiz_yillik": None,
        "gecikme_faiz_yillik": None,
        "islemler": [],
    }


# Garanti/Bonus özet kutusundaki TARİHSİZ faiz & ücret satırları. kart_analiz yalnızca
# tarihli satırları okuduğu için bunlar kaçıyordu → FAIZ işlemi olarak enjekte edilir.
_GARANTI_FAIZ_AMT = re.compile(r"^([A-ZÇĞİÖŞÜ][A-ZÇĞİÖŞÜ +/&]+?)\s+([\d.]+,\d{2})\s*$")


def garanti_faiz_enjekte(sonuc: Dict[str, Any], text: str) -> None:
    """Garanti/Bonus ekstresinde özet kutusundaki tarihsiz faiz/ücret satırlarını
    (DÖNEM FAİZİ, GEÇ ÖDEME FAİZİ, LİMİT AŞIM FAİZİ, NAKİT AVANS FAİZİ, KKDF+BSMV)
    FAIZ işlemi olarak ekler ve yıllık faiz oranlarını çıkarır. sonuc'u yerinde değiştirir.
    Idempotent: aynı (açıklama,tutar) zaten varsa eklemez. (Axess deseniyle aynı yaklaşım.)"""
    kesim = sonuc.get("kesim_tarihi")
    islemler = sonuc.setdefault("islemler", [])
    mevcut = {(str(i.get("aciklama", "")).strip().upper(), round(float(i.get("tutar") or 0), 2))
              for i in islemler}
    eklenen_toplam = 0.0
    for ln in text.splitlines():
        L = ln.strip()
        if not L or "%" in L or "ORAN" in L.upper():
            continue
        m = _GARANTI_FAIZ_AMT.match(L)
        if not m:
            continue
        etiket = m.group(1).strip()
        et_up = etiket.upper()
        # Sadece faiz/ücret/vergi satırları (DEVİR, harcama başlıkları HARİÇ)
        if not any(k in et_up for k in ("FAİZ", "FAIZ", "KKDF", "BSMV")):
            continue
        tutar = _num(m.group(2))
        if tutar is None or tutar <= 0:
            continue
        if (et_up, round(tutar, 2)) in mevcut:
            continue
        islemler.append({
            "tarih": kesim,
            "aciklama": etiket,
            "tutar": tutar,
            "tip": "FAIZ",
            "kategori": "Faiz",
            "taksit": None,
            "taksit_anapara": None,
            "taksit_sayisi": None,
        })
        mevcut.add((et_up, round(tutar, 2)))
        eklenen_toplam += tutar

    # Dönem faizini işlemlerden (yeni eklenenler dahil) yeniden hesapla
    sonuc["donem_faizi"] = round(
        sum(float(i["tutar"] or 0) for i in islemler if i.get("tip") == "FAIZ"), 2)

    # Yıllık faiz oranları — "Yıllık güncel faiz oranları: Akdi faiz: %51,00, Gecikme faizi: %54,60"
    # Satır-bazlı + toleranslı: hem 'yıllık' hem 'akdi faiz' içeren satırı bul.
    for ln in text.splitlines():
        low = ln.lower()
        if ("y" in low and "ll" in low and "akdi faiz" in low and "%" in ln):
            # 'yıllık' satırı (aylık satırından ayır: yıllık oranlar > %40)
            a = re.search(r"akdi faiz:\s*%(\d[\d.]*,\d{2})", ln, re.I)
            g = re.search(r"gecikme faizi:\s*%(\d[\d.]*,\d{2})", ln, re.I)
            av = _num(a.group(1)) if a else None
            gv = _num(g.group(1)) if g else None
            # Yıllık satırı: akdi oranı yüksek (>20). Aylık satırını atla.
            if av is not None and av > 20:
                if sonuc.get("akdi_faiz_yillik") is None:
                    sonuc["akdi_faiz_yillik"] = av
                if gv is not None and sonuc.get("gecikme_faiz_yillik") is None:
                    sonuc["gecikme_faiz_yillik"] = gv
                break


def ziraat_faiz_finalize(sonuc: Dict[str, Any], text: str) -> None:
    """Ziraat/Bankkart: faiz satırları TARİHLİ olduğu için kart_analiz onları FAIZ olarak
    zaten yakalıyor (Kredi faizi, Taksit faizi, KKDF, BSMV). Burada yalnızca eksik kalan
    iki ÖZET alanını tamamlarız: dönem faizini işlemlerden yeniden hesapla + yıllık oranlar.
    sonuc'u yerinde değiştirir. Idempotent."""
    isl = sonuc.get("islemler") or []
    sonuc["donem_faizi"] = round(
        sum(float(i["tutar"] or 0) for i in isl if i.get("tip") == "FAIZ"), 2)
    # Yıllık oranlar: "Yıllık Faiz Oranları: Alışveriş Faizi %51,00; Alışveriş Gecikme Faizi %54,60"
    for ln in text.splitlines():
        low = ln.lower()
        if "y" in low and "ll" in low and "faiz oran" in low and "%" in ln:
            a = re.search(r"al[ıi]şveriş faizi\s*%(\d[\d.]*,\d{2})", ln, re.I)
            g = re.search(r"al[ıi]şveriş gecikme faizi\s*%(\d[\d.]*,\d{2})", ln, re.I)
            av = _num(a.group(1)) if a else None
            gv = _num(g.group(1)) if g else None
            if av is not None and av > 20:
                if sonuc.get("akdi_faiz_yillik") is None:
                    sonuc["akdi_faiz_yillik"] = av
                if gv is not None and sonuc.get("gecikme_faiz_yillik") is None:
                    sonuc["gecikme_faiz_yillik"] = gv
                break


def parse_ekstre(text: str) -> Dict[str, Any]:
    banka = detect_bank(text)
    if banka == "worldcard":
        return parse_worldcard(text)
    if banka == "garanti":
        return parse_garanti(text)
    if banka == "ziraat":
        return parse_ziraat(text)
    if banka == "enpara":
        return parse_enpara(text)
    return {
        "banka_format": banka,
        "hata": "Bu ekstre formatı metin olarak ayrıştırılamadı "
                "(Axess gibi taranmış/gömülü-font PDF'ler OCR gerektirir).",
        "islemler": [],
    }


# ════════════════════════════════════════════════════════════════════
# AXESS / AKBANK  (gömülü-font, EBCDIC kodlamalı PDF — OCR'a gerek yok)
#   PDF metni özel font yüzünden bozuk görünür; aslında EBCDIC (cp037).
#   pymupdf ile sayfa metni alınır, glyph-arası satırsonları atılır,
#   bayt-bayt cp037 çözülür → temiz metin. Sayı formatı US (1,234.56).
# ════════════════════════════════════════════════════════════════════

_AXESS_DUZELT = str.maketrans({"Ð": "İ", "Ý": "Ş", "Þ": "ı", "ý": "ı", "ð": "ş"})


def _axess_decode(raw: bytes) -> str:
    import fitz  # pymupdf
    doc = fitz.open(stream=raw, filetype="pdf")
    parcalar = []
    for pg in doc:
        s = pg.get_text()
        b = bytes((ord(c) & 0xFF) for c in s if ord(c) not in (0x0A, 0x0D))
        parcalar.append(b.decode("cp037", errors="replace"))
    return " ".join(parcalar)


def is_axess(raw: bytes) -> bool:
    """Ham PDF baytlarını EBCDIC çözüp Axess/Akbank ekstresi mi diye bakar."""
    try:
        t = _axess_decode(raw)
    except Exception:
        return False
    return ("Axess" in t) or ("Hesap Kesim Tarihi" in t and "Akbank" in t)


def _ax_num(s: Optional[str]) -> Optional[float]:
    """US format: '34,335.59' → 34335.59"""
    if s is None:
        return None
    try:
        return float(str(s).replace(",", "").strip())
    except ValueError:
        return None


def _ax_faiz(s: Optional[str]) -> Optional[float]:
    """TR yüzde: '%45,00' → 45.0"""
    if s is None:
        return None
    try:
        return float(str(s).replace(".", "").replace(",", "."))
    except ValueError:
        return None


def _ax_tarih(s: Optional[str]) -> Optional[str]:
    """'08/05/2026' → '2026-05-08'"""
    if not s:
        return None
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", s)
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None


def parse_axess(raw: bytes) -> Dict[str, Any]:
    """Axess (Akbank) ekstresi → birleşik sonuç (başlık + birleşik-format işlemler)."""
    t = _axess_decode(raw)

    def gs(p, grp=1):
        m = re.search(p, t)
        return m.group(grp) if m else None

    def gn(p, grp=1, f=_ax_num):
        m = re.search(p, t)
        return f(m.group(grp)) if m else None

    son4 = gs(r"Kart Numaras.\s*\d{4} \d{2}\*+ \*+ (\d{4})")
    borc = gn(r"Dönem Borcu([\d,]+\.\d{2}) TL")
    asgari = gn(r"En Az Ödeme Tutar.([\d,]+\.\d{2}) TL")
    sot = _ax_tarih(gs(r"Son Ödeme Tarihi(\d{2}/\d{2}/\d{4})"))
    kesim = _ax_tarih(gs(r"Hesap Kesim Tarihi(\d{2}/\d{2}/\d{4})"))
    limit = gn(r"Kart Limiti([\d,]+\.\d{2}) TL")
    onceki = gn(r"Bakiyesi([\d,]+\.\d{2})")
    akdi = gn(r"Akdi Faiz Oran.\*?%[\d,]+\s*Y.ll.k:\s*%([\d,]+)", f=_ax_faiz)
    gec = gn(r"Gecikme Faiz\s*Oran.\*?\s*%[\d,]+\s*Y.ll.k:\s*%([\d,]+)", f=_ax_faiz)
    sahip = gs(r"içerir\.([A-ZÇĞİÖŞÜ][A-ZÇĞİÖŞÜ ]+?)(?=[a-zçğıöşü])")
    donem_faizi = sum(
        _ax_num(x) or 0
        for x in re.findall(r"(?:Toplam Dönem Faizi|Otomatik Fatura Ödeme Faizi)\s*([\d,]+\.\d{2})", t)
    )

    # ── İşlemler: "Önceki ... Bakiyesi<tutar>" ile "Toplam<tutar>" arası
    islemler: List[Dict[str, Any]] = []
    reg = re.search(r"Bakiyesi[\d,]+\.\d{2}(.*?)Toplam[\d,]+\.\d{2}", t, re.S)
    if reg:
        region = re.sub(r"\*+ \*+ \*+ \d{4} .*?Harcamalar.", "|", reg.group(1))
        for c in re.split(r"(?=\d{2}/\d{2}/\d{4})", region):
            md = re.match(r"(\d{2}/\d{2}/\d{4})(.*)", c.strip().lstrip("|").strip(), re.S)
            if not md:
                continue
            rest = md.group(2)
            tk = re.search(r"\(([\d.,]+) TL\)\s*(\d+)/(\d+)\.taksit\s*([\d,]+\.\d{2})", rest)
            odeme = "(-)" in rest
            anapara = tsay = taks = None
            if tk:
                anapara = _ax_num(tk.group(1))
                tsay = int(tk.group(2))        # toplam taksit adedi
                no = int(tk.group(3))          # kaçıncı taksit
                tutar = _ax_num(tk.group(4))   # bu dönem ödenen taksit payı
                taks = f"{no}/{tsay}"
            else:
                am = re.search(r"[\d,]+\.\d{2}", rest)
                tutar = _ax_num(am.group(0)) if am else None
            tip = "ODEME" if odeme else ("FAIZ" if "Faiz" in rest else "HARCAMA")
            desc = re.sub(r"\([\d.,]+ TL\)\s*\d+/\d+\.taksit", "", rest)
            desc = re.sub(r"[\d,]+\.\d{2}", "", desc).replace("(-)", "").strip()
            desc = re.sub(r"\s{2,}", " ", desc).translate(_AXESS_DUZELT)[:60]
            if tutar is None or tutar == 0:
                continue
            islemler.append({
                "tarih": _ax_tarih(md.group(1)),
                "tutar": abs(tutar),
                "tip": tip,
                "aciklama": desc,
                "kategori": None,
                "taksit": taks,
                "taksit_anapara": anapara,
                "taksit_sayisi": tsay,
            })

    # Dönem faizini de işlem olarak ekle (FAIZ → kart borcuna yansısın)
    for et, tut in re.findall(r"(Toplam Dönem Faizi|Otomatik Fatura Ödeme Faizi)\s*([\d,]+\.\d{2})", t):
        v = _ax_num(tut)
        if v:
            islemler.append({
                "tarih": kesim, "tutar": v, "tip": "FAIZ", "aciklama": et,
                "kategori": "Faiz", "taksit": None, "taksit_anapara": None, "taksit_sayisi": None,
            })

    return {
        "banka_format": "axess",
        "son_dort": son4,
        "kesim_tarihi": kesim,
        "son_odeme_tarihi": sot,
        "donem_borcu": borc,
        "asgari_tutar": asgari,
        "asgari_oran": None,
        "limit": limit,
        "onceki_borc": onceki,
        "donem_harcama": round(sum(i["tutar"] for i in islemler if i["tip"] == "HARCAMA"), 2),
        "donem_odeme": round(sum(i["tutar"] for i in islemler if i["tip"] == "ODEME"), 2),
        "donem_faizi": round(donem_faizi, 2),
        "kalan_taksit": None,
        "kart_sahibi": (sahip or "").strip() or None,
        "akdi_faiz_yillik": akdi,
        "gecikme_faiz_yillik": gec,
        "islemler": islemler,
    }
