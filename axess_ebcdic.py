"""
axess_ebcdic.py — Akbank/Axess ekstresinin OKUNAMAYAN PDF'ini okunur hâle getirir.

── SORUN ────────────────────────────────────────────────────────────────────
Axess ekstresi PDF'i, metnini gömülü **Type3** fontlarla çiziyor ve o fontlarda
`ToUnicode` haritası YOK. Normal metin çıkarıcı (pdfplumber/pdfminer) bu yüzden
ya `(cid:133)` gibi çözülmemiş kodlar ya da `⁄¨(cid:211)@(cid:215)ØK` gibi
anlamsız harfler döndürüyordu. Sonuç: sistem 5 bankanın 4'ünü okurken Axess'i
HİÇ okuyamıyordu.

Satır denetimi bunu canlıda şöyle gösterdi (2026-08-24):
    Axess Temmuz : PDF'ten okunan harcama 0,00 · bankanın dediği 9.124,09
    Axess Ağustos: PDF'ten okunan harcama 0,00 · bankanın dediği 11.220,80
Duyu bu yüzden "defterde 27 fazla kayıt var" diyordu — oysa defter değil OKUMA
eksikti. (Bu, "önce ölçüm aletini denetle" kuralının doğduğu vaka.)

── KÖK NEDEN ────────────────────────────────────────────────────────────────
Font kodları **EBCDIC**. İmzası çıplak gözle görülüyordu: metinde boşluk olması
gereken yerde `@` (EBCDIC 0x40 = boşluk), nokta olması gereken yerde `K`
(0x4B = '.'). Yani baytlar doğru, sadece yanlış alfabeyle okunuyorlardı.

Çözüm iki adım:
  1) HAM BAYTA İN — PyMuPDF (fitz) glif kodlarını olduğu gibi verir; pdfplumber
     ise kendi tablosundan geçirip bozar. Küçük harfler tesadüfen doğru
     çıkıyordu, BÜYÜK harfler bozuluyordu; bu yüzden pdfplumber çıktısını
     "yarı doğru" sanıp düzeltmeye çalışmak çıkmaz sokaktı.
  2) cp500 ile ÇÖZ — IBM EBCDIC. Türkçe Ö/Ç/ü doğru geliyor; ş/ı/ğ ayrı bir
     Type3 fontta olduğu için düşüyor. Tutar ve tarih ASCII olduğundan PARA
     TARAFI ETKİLENMİYOR; yalnız bazı açıklamalarda harf eksilir.
     ⚠️ Bu bilinçli bir sınır: açıklamayı eksik okumak, tutarı yanlış okumaktan
     yeğdir. Eksik harf gözle anlaşılır, yanlış tutar anlaşılmaz.

── SATIR YENİDEN KURULUMU ───────────────────────────────────────────────────
Type3 fontta her glif ayrı yerleştirildiği için metin doğal olarak satırsızdır.
Karakterler y koordinatına göre gruplanıp x'e göre sıralanarak satırlar yeniden
kurulur (2 punto tolerans — aynı satırdaki gliflerin y'si birebir aynı değil).

⚠️ AXESS SAYI BİÇİMİ AMERİKANDIR: "36,396.74" = 36.396,74 ₺. Virgül binlik,
nokta ondalık. Diğer bankaların tam TERSİ. Bu karıştırılırsa 36 bin ₺'lik borç
36 ₺ görünür — sessiz ve büyük bir hata olurdu.
"""
from __future__ import annotations

import collections
import re
from typing import List, Optional

# EBCDIC imzası: boşluk yerine @, nokta yerine K + hiç Latin kelime olmaması
_CID_IZI = re.compile(r"\(cid:\d+\)")


def _satirlari_kur(sayfa, tolerans: float = 2.0) -> List[str]:
    """Bir fitz sayfasındaki glifleri y'ye göre satırlara toplar, x'e göre sıralar."""
    kova = collections.defaultdict(list)
    rd = sayfa.get_text("rawdict")
    for blok in rd.get("blocks", []):
        for satir in blok.get("lines", []):
            for span in satir.get("spans", []):
                for ch in span.get("chars", []):
                    y = round(ch["bbox"][1] / tolerans) * tolerans
                    kova[y].append((ch["bbox"][0], ch["c"]))
    out = []
    for y in sorted(kova):
        out.append("".join(c for _, c in sorted(kova[y], key=lambda p: p[0])))
    return out


def _ebcdic_coz(s: str) -> str:
    """Glif kodlarını bayta çevirip cp500 (IBM EBCDIC) ile çözer."""
    try:
        ham = bytes((ord(c) & 0xFF) for c in s)
    except (TypeError, ValueError):
        return ""
    return ham.decode("cp500", "replace")


def ebcdic_pdf_mi(pdf_bytes: bytes) -> bool:
    """Bu PDF, ToUnicode'suz EBCDIC Type3 fontlarla mı yazılmış?

    İki kanıt aranır (ikisi de olmalı — tek başına yanılabilir):
      · normal çıkarım anlamsız  (cid: kodları var YA DA Latin kelime yok)
      · fitz + cp500 çözümü ANLAMLI Türkçe/Latin metin üretiyor
    """
    return kanit_var(metin_coz(pdf_bytes) or "")


def kanit_var(coz: str) -> bool:
    """Çözülmüş metin gerçekten bir Axess ekstresi mi? (en az 2 başlık ipucu)

    ⚠️ İKİ TUZAK BİRDEN (ikisi de canlıda yaşandı):
    1) Satır ayırıcıyı da çözmek — `get_text()` çıktısındaki '\\n' (0x0A) EBCDIC'ten
       geçince U+008E'ye dönüşüp metnin İÇİNE serpiliyor ("axess" → "a\\x8exess").
       Bu yüzden tespit HAM çıkarım üzerinden değil, satırları kurulmuş metin
       üzerinden yapılır.
    2) Boşluk normalizasyonu — Type3 fontta glifler ayrı yerleştirildiği için
       "Hesap Özeti" satır ortasından bölünebiliyor; ipucu ararken metin düzleştirilir.
    İlk sürüm ikisini de yapmıyordu: modül doğru çalışıyor ama tespit HEP False
    dönüyordu — yani sessiz ölü kod. Çalışan bir çözücüden daha tehlikelisi,
    çalıştığı sanılan ama hiç çağrılmayan çözücüdür.
    """
    ipuclari = ("axess", "hesapözeti", "ekstredönemi", "hesapkesim", "akbank",
                "enazödeme", "kartlimiti", "sonödemetarihi", "chippara")
    dc = re.sub(r"\s+", "", (coz or "").lower())
    return sum(1 for k in ipuclari if k in dc) >= 2


def metin_coz(pdf_bytes: bytes) -> Optional[str]:
    """EBCDIC Type3 PDF → okunabilir metin. Değilse/başarısızsa None.

    None dönmek ÖNEMLİ: çağıran taraf eski yola düşebilsin. Yarım/bozuk bir
    metin döndürmek, hiç döndürmemekten kötüdür — parser onu ciddiye alır.
    """
    try:
        import fitz  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        return None
    try:
        parcalar: List[str] = []
        with fitz.open(stream=pdf_bytes, filetype="pdf") as d:
            for sayfa in d:
                for satir in _satirlari_kur(sayfa):
                    parcalar.append(_ebcdic_coz(satir))
        metin = "\n".join(parcalar)
    except Exception:  # noqa: BLE001
        return None
    if len(metin.strip()) < 40:
        return None
    return metin


def us_tutar(s: str) -> float:
    """'36,396.74' → 36396.74.  Axess AMERİKAN biçimi kullanır (virgül binlik).

    Diğer bankaların tam tersi olduğu için ayrı fonksiyon: ortak bir çözücüye
    emanet edilirse 36.396,74 ₺ sessizce 36,40 ₺'ye döner.
    """
    t = (s or "").strip().replace(" ", "").replace(",", "")
    try:
        return abs(float(t))
    except ValueError:
        return 0.0
