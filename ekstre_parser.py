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
    if "worldpuan" in t or ("hesap kesim tarihi" in t and "dönem borcu" in t):
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


def parse_ekstre(text: str) -> Dict[str, Any]:
    banka = detect_bank(text)
    if banka == "worldcard":
        return parse_worldcard(text)
    if banka == "enpara":
        return parse_enpara(text)
    return {
        "banka_format": banka,
        "hata": "Bu ekstre formatı metin olarak ayrıştırılamadı "
                "(Axess gibi taranmış/gömülü-font PDF'ler OCR gerektirir).",
        "islemler": [],
    }
