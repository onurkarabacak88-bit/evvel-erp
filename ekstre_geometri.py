"""
ekstre_geometri.py — BANKA-BAĞIMSIZ GEOMETRİK EKSTRE OKUYUCU
================================================================================
Kart mekanizması yeniden kurgusu · ADIM 5 (kök-neden aşısı)

NEDEN VAR
─────────
Metin tabanlı ekstre okuyucuları tutarı "satırın SON sayısı" tahminiyle bulur.
Bu tahmin 2026-08-10 .. 2026-08-17 arasında ÜÇ ayrı CANLI kusur üretti ve
üçü de kart borcunu bozacak noktaya kadar geldi:

  1) Worldcard (2026-08-10) — satırın sonunda PUAN durur, tutar değil:
       ENES SAAT   1.950,00 ₺  →  7.800,00 ₺ okundu (puan)
       KARABULUT   20.000,00 ₺ →      4,00 ₺ okundu (taksit sayısı)
  2) Garanti (2026-08-17) — Tutar hücresi BOŞ, değer BONUS sütununda:
       12 sahte harcama satırı ≈ 13.800 ₺ hayalet borç
  3) Garanti (2026-08-17) — pdfplumber boş hücreye 'bosluk' yazdı; son token
     sayı olmadığı için SATIR SESSİZCE ATLANDI:
       ESER TİCARET 41.250,00 + U.S. POLO 943,29 = 42.193,29 ₺ KAYIP

Üçünün kökü TEK: TUTARIN YERİ YAPISAL DEĞİL, TAHMİNE BAĞLI.
Kanıt — aynı kavram iki bankada TERS yönde durur:
       Garanti:   ... | Bonus(TL) x≈445 | Tutar(TL) x≈553      → puan SOLDA
       Worldcard: ... | Tutar(TL) x≈426 | ... | Puan   x≈567    → puan SAĞDA
"Son sayıyı al" kuralı bu ikisinde aynı anda doğru olamaz.

NE YAPAR
────────
Tutarı SÜTUN KOORDİNATINDAN okur. Başlık satırındaki etiketlerden ("Tutar(TL)",
"Bonus", "Worldpuan", "Bankkart Lira", "Kalan Borç / Taksit" ...) sütun bantları
kurulur; her kelime x-örtüşmesine göre kendi hücresine düşer.

Sonuç:
  · BONUS sütunundaki sayı ASLA tutar olamaz (kusur 1 ve 2 yapısal olarak imkânsız)
  · Boş Tutar hücresi satırı YUTMAZ — satır `tutarsiz` listesine RAPORLANIR (kusur 3)
  · 'bosluk' gibi çöp token sayı olmadığı için hücreye giremez

DOKTRİN UYUMU
─────────────
· SESSİZ ELEME YASAK — elenen her satır sayısı + gerekçesiyle döner
  (`tutarsiz`, `tarihsiz_tutarli`, `basliksiz_sayfa`)
· HATA ≠ BOŞ — başlık bulunamazsa boş liste değil `basarili=False` döner;
  çağıran metin okuyucusuna düşer, sahte "0 işlem" üretilmez
· DUYU HAM VERİ ÖNCE — ödül/taksit/döviz hücreleri kullanılmasa da toplanır
· SAHTE YEŞİL YASAK — okuma denetimi (çapa) kararı main.py'de verir; bu modül
  hüküm vermez, sadece ölçer

Salt-okur: veritabanına dokunmaz, hiçbir şey yazmaz.
"""
from __future__ import annotations

import io
import re
from typing import Any, Dict, List, Optional, Tuple

import pdfplumber

# ─── Türkçe küçültme (İ tuzağı) ──────────────────────────────────────────────
# "DÖNEM FAİZİ".lower() → 'faiz' ÜRETMEZ: İ, i + U+0307 (combining dot) olur ve
# 'faizi' araması tutmaz. Bu tuzak 2026-08 ekstre turunda 5 faiz satırını
# görünmez yapmıştı. Aşağıdaki eşleme .lower()'dan ÖNCE uygulanır.
_TR_HARITA = str.maketrans({
    "İ": "i", "I": "ı", "Ş": "ş", "Ğ": "ğ", "Ü": "ü", "Ö": "ö", "Ç": "ç",
})


def tr_kucuk(s: str) -> str:
    """Türkçe-güvenli küçültme. 'DÖNEM FAİZİ' → 'dönem faizi'."""
    return (s or "").translate(_TR_HARITA).lower()


# ─── Tutar biçimi ────────────────────────────────────────────────────────────
# KURUŞ ZORUNLU. Bu tek kural puanı/taksit sayısını tutardan ayıran ikinci
# hattır (puan "1.820", taksit "4" — kuruşu yoktur). Geometri birinci hat.
_SAYI = re.compile(r"^[+-]?(?:\d{1,3}(?:\.\d{3})*|\d+),\d{2}[+-]?$")
# Kuruşsuz tam sayı (puan / taksit sayısı) — ödül hücresinde kabul edilir
_SAYI_GEVSEK = re.compile(r"^[+-]?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?[+-]?$")


def _tutar_coz(token: str) -> Optional[Tuple[float, str]]:
    """'41.250,00+' → (41250.0, '+')   ·   '-1.352,65' → (1352.65, '-')

    İşaret döndürülür AMA yorumlanmaz — hangi işaretin 'alacak' olduğu bankaya
    göre değişir (Garanti '+' ödeme, Enpara '-' ödeme). Yorum aşağıda,
    _ODEME_ISARETI tablosunda.
    """
    t = (token or "").strip()
    if not _SAYI.match(t):
        return None
    isaret = ""
    if t.startswith(("+", "-")):
        isaret = t[0]
    elif t.endswith(("+", "-")):
        isaret = t[-1]
    temiz = t.strip("+-").replace(".", "").replace(",", ".")
    try:
        return abs(float(temiz)), isaret
    except ValueError:
        return None


# ─── Sütun kavramları ────────────────────────────────────────────────────────
# SIRA ÖNEMLİ: özelden genele. "USD Tutar" ve "Kalan Tutar/Taksit" ifadeleri
# 'tutar' kelimesini İÇERİR; onları önce yakalamazsak TL tutar sütunu yanlış
# yere kurulur. Bu sıralama testle korunur (test_ekstre_geometri.py).
_KAVRAM_DESENLERI: List[Tuple[str, List[str]]] = [
    # Döviz tutarı — TL tutarıyla karıştırılırsa borç yabancı para ile toplanır
    ("doviz", [r"^usd\s*tutar", r"^tutar\s*usd", r"^eur\s*tutar", r"^döviz\s*tutar"]),
    # Ödül/puan — kusur 1 ve 2'nin kaynağı. ASLA tutar olarak kullanılmaz.
    ("odul", [
        r"^bonus", r"worldpuan", r"^puan", r"bankkart\s*lira", r"^mil\b",
        r"chip[\s-]*para", r"^ödül", r"maximum\s*puan", r"^para\s*puan",
    ]),
    # Taksit / kalan borç — "4" gibi kuruşsuz sayıların yeri
    ("taksit", [
        r"^kalan\s*borç", r"^kalan\s*tutar", r"tutar\s*/\s*taksit",
        r"^kalan\b", r"^taksit", r"^vade",
    ]),
    # TL tutarı — borcun TEK kaynağı
    ("tutar", [
        r"^tutar\s*\(?\s*tl\s*\)?", r"^tl\s*tutar", r"^tutar$",
        r"^işlem\s*tutar", r"^harcama\s*tutar", r"^tutar\s*\(tl\)",
    ]),
    ("tarih", [r"^işlem\s*tarihi", r"^tarih[i]?$", r"^işlem\s*tar"]),
    ("aciklama", [
        r"^işlem\s*açıklama", r"^açıklama", r"^dönem\s*içi\s*işlem",
        r"^işlemler$", r"^işlem\s*tür", r"^harcama\s*yeri", r"^açıklamalar",
    ]),
]

# Bir başlık satırı sayılmak için ZORUNLU kavramlar
_ZORUNLU = {"tarih", "tutar"}

# Hangi işaret "alacak" (ödeme/iade) demek — bankaya göre TERS
_ODEME_ISARETI: Dict[str, str] = {
    "Garanti BBVA": "+",
    "Yapı Kredi": "+",
    "Enpara": "-",
    "Ziraat": "-",
    "Axess": "-",
}

# Ödemeyi açıklamadan doğrulayan ikinci hat (işaretle çelişirse işaret kazanır,
# ama açıklama netse — "ÖDEMENİZ İÇİN TEŞEKKÜR" — ödeme kabul edilir)
_ODEME_METNI = re.compile(
    r"teşekkür|ödemeniz|kart\s*ödeme|hesaptan\s*ödeme|virman|otomatik\s*ödeme"
    r"|tahsilat|iade|geri\s*ödeme",
    re.I,
)
# Faiz/ücret satırları alacak DEĞİLDİR — işareti ne olursa olsun borç yazar
_UCRET_METNI = re.compile(
    r"faiz|bsmv|kkdf|ücret|aidat|gecikme|limit\s*aşım|nakit\s*avans", re.I
)


# ─── Kelimeleri satıra grupla ────────────────────────────────────────────────
def _satirlara_bol(kelimeler: List[Dict], tolerans: float = 3.0) -> List[List[Dict]]:
    """Aynı yatay bantta duran kelimeleri tek satır yapar."""
    if not kelimeler:
        return []
    sirali = sorted(kelimeler, key=lambda w: (w["top"], w["x0"]))
    satirlar: List[List[Dict]] = [[sirali[0]]]
    for w in sirali[1:]:
        if abs(w["top"] - satirlar[-1][0]["top"]) <= tolerans:
            satirlar[-1].append(w)
        else:
            satirlar.append([w])
    for s in satirlar:
        s.sort(key=lambda w: w["x0"])
    return satirlar


def _kavram_bul(ifade: str) -> Optional[str]:
    k = tr_kucuk(ifade).strip()
    if not k:
        return None
    for kavram, desenler in _KAVRAM_DESENLERI:
        for d in desenler:
            if re.search(d, k):
                return kavram
    return None


def _baslik_coz(satir: List[Dict], maks_bosluk: float = 14.0) -> Optional[Dict[str, Tuple[float, float]]]:
    """Bir satır başlık mı? Evetse {kavram: (x0, x1)} döner.

    Etiketler birden çok kelimeye bölünmüş olabilir ("İşlem"+"Tarihi",
    "Tutar"+"(TL)"). Bu yüzden 1..3 komşu kelime birleştirilerek denenir —
    ama SADECE aralarındaki boşluk küçükse; yoksa uzaktaki iki sütunun
    başlığı tek ifade sanılır ve bantlar birbirine girer.
    """
    bulunan: Dict[str, Tuple[float, float]] = {}
    n = len(satir)
    for i in range(n):
        for uzunluk in (3, 2, 1):  # uzun ifade önce: "USD Tutar" > "Tutar"
            j = i + uzunluk
            if j > n:
                continue
            grup = satir[i:j]
            kopuk = any(
                grup[k + 1]["x0"] - grup[k]["x1"] > maks_bosluk
                for k in range(len(grup) - 1)
            )
            if kopuk:
                continue
            ifade = " ".join(w["text"] for w in grup)
            kavram = _kavram_bul(ifade)
            if not kavram:
                continue
            x0, x1 = grup[0]["x0"], grup[-1]["x1"]
            if kavram in bulunan:  # aynı kavram iki parçada → birleştir
                x0 = min(x0, bulunan[kavram][0])
                x1 = max(x1, bulunan[kavram][1])
            bulunan[kavram] = (x0, x1)
            break  # bu kelimeden başlayan en uzun eşleşme alındı
    if not _ZORUNLU.issubset(bulunan.keys()):
        return None
    if len(bulunan) < 3:
        return None
    return bulunan


def _bantlar_kur(baslik: Dict[str, Tuple[float, float]], sayfa_genisligi: float) -> List[Tuple[str, float, float]]:
    """Başlık x-aralıklarını, sayfayı döşeyen bantlara çevirir.

    Sayılar sütunda SAĞA dayalı yazılır; değerin x'i başlığın x'iyle birebir
    örtüşmez. Bu yüzden sınır, iki komşu başlığın ORTA noktasıdır — böylece
    sağa dayalı değer kendi sütununda kalır.
    """
    sirali = sorted(baslik.items(), key=lambda kv: kv[1][0])
    bantlar: List[Tuple[str, float, float]] = []
    for idx, (kavram, (x0, x1)) in enumerate(sirali):
        sol = 0.0 if idx == 0 else (sirali[idx - 1][1][1] + x0) / 2.0
        sag = sayfa_genisligi if idx == len(sirali) - 1 else (x1 + sirali[idx + 1][1][0]) / 2.0
        bantlar.append((kavram, sol, sag))
    return bantlar


def _hucrelere_dagit(satir: List[Dict], bantlar: List[Tuple[str, float, float]]) -> Dict[str, List[Dict]]:
    """Her kelimeyi en çok örtüştüğü banda atar (kelime NESNESİ döner, metin değil).

    Koordinat aşağıda lazım: sağa dayalı sütunda doğru sayıyı seçmek için
    kelimenin sağ kenarı bilinmeli (bkz. _tutar_sec).
    """
    hucre: Dict[str, List[Dict]] = {k: [] for k, _, _ in bantlar}
    for w in satir:
        en_iyi, en_ortusme = None, 0.0
        for kavram, sol, sag in bantlar:
            ortusme = min(w["x1"], sag) - max(w["x0"], sol)
            if ortusme > en_ortusme:
                en_ortusme, en_iyi = ortusme, kavram
        if en_iyi is None:  # hiç örtüşme yok → merkeze en yakın bant
            merkez = (w["x0"] + w["x1"]) / 2.0
            en_iyi = min(bantlar, key=lambda b: min(abs(merkez - b[1]), abs(merkez - b[2])))[0]
        hucre[en_iyi].append(w)
    return hucre


def _metin(hucre: Dict[str, List[Dict]], kavram: str) -> str:
    return " ".join(w["text"] for w in hucre.get(kavram, []))


# ─── Tarih çözümü ────────────────────────────────────────────────────────────
_AY_TR = {
    "ocak": 1, "şubat": 2, "subat": 2, "mart": 3, "nisan": 4, "mayıs": 5,
    "mayis": 5, "haziran": 6, "temmuz": 7, "ağustos": 8, "agustos": 8,
    "eylül": 9, "eylul": 9, "ekim": 10, "kasım": 11, "kasim": 11,
    "aralık": 12, "aralik": 12,
}


def _tarih_coz(metin: str) -> Optional[str]:
    m = re.search(r"(\d{1,2})[/.](\d{1,2})[/.](\d{4})", metin)
    if m:
        g, a, y = int(m.group(1)), int(m.group(2)), m.group(3)
        if 1 <= a <= 12 and 1 <= g <= 31:
            return f"{y}-{a:02d}-{g:02d}"
    m = re.search(r"(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]+)\s+(\d{4})", metin)
    if m:
        ay = _AY_TR.get(tr_kucuk(m.group(2)))
        if ay:
            g = int(m.group(1))
            if 1 <= g <= 31:
                return f"{m.group(3)}-{ay:02d}-{g:02d}"
    return None


# ─── Taksit çözümü ───────────────────────────────────────────────────────────
def _taksit_coz(taksit_metni: str, aciklama: str) -> Dict[str, Any]:
    """Taksit bilgisi bankaya göre farklı hücrede/biçimde durur:

      Garanti:   '41.250,00x4=165.000,00'  +  '3.Taksit'
      Worldcard: '123.456,78 / 3'
      Enpara:    '3/6'
      Ziraat:    açıklama içinde 'İşlemin 1/4 Taksidi'
    """
    havuz = f"{taksit_metni} {aciklama}"
    sonuc: Dict[str, Any] = {"taksit_no": None, "taksit_sayisi": None, "taksit_toplam": None}

    m = re.search(r"([\d.]+,\d{2})\s*[xX]\s*(\d{1,2})\s*=\s*([\d.]+,\d{2})", havuz)
    if m:
        sonuc["taksit_sayisi"] = int(m.group(2))
        t = _tutar_coz(m.group(3))
        if t:
            sonuc["taksit_toplam"] = t[0]

    m = re.search(r"(\d{1,2})\s*[./]\s*(\d{1,2})\s*[Tt]aksi", havuz)
    if m:
        sonuc["taksit_no"] = int(m.group(1))
        sonuc["taksit_sayisi"] = sonuc["taksit_sayisi"] or int(m.group(2))
    else:
        m = re.search(r"(\d{1,2})\s*\.\s*[Tt]aksit", havuz)
        if m:
            sonuc["taksit_no"] = int(m.group(1))
        m = re.search(r"(?<![\d,.])(\d{1,2})\s*/\s*(\d{1,2})(?![\d,.])", havuz)
        if m:
            sonuc["taksit_no"] = sonuc["taksit_no"] or int(m.group(1))
            sonuc["taksit_sayisi"] = sonuc["taksit_sayisi"] or int(m.group(2))
    return sonuc


def _aciklama_temizle(hucre: Dict[str, List[Dict]], kavram: str) -> str:
    """Açıklama hücresinden taksit/hesap artığı token'ları atar."""
    atilacak = re.compile(
        r"^(bosluk|b(?:os){2,}luk|bboosslluukk)$|^[\d.]+,\d{2}[xX]\d+=|^\d{1,2}\.taksit$",
        re.I,
    )
    parcalar = [w["text"] for w in hucre.get(kavram, [])]
    kalan = [p for p in parcalar if p and not atilacak.match(p)]
    metin = " ".join(kalan)
    # pdfplumber'ın harf ikizlemesi ('bboosslluukk') ve TL eki
    metin = re.sub(r"\b(?:bosluk|bboosslluukk)\b", " ", metin, flags=re.I)
    metin = re.sub(r"\s+", " ", metin).strip()
    return metin


# ─── ANA GİRİŞ ───────────────────────────────────────────────────────────────
def geometrik_oku(pdf_bytes: bytes, banka: str = "") -> Dict[str, Any]:
    """Ekstreyi sütun koordinatlarından okur.

    Dönen sözlük:
      basarili        : bool — başlık bulunup en az bir satır okundu mu
      neden           : str  — başarısızsa GEREKÇE (boş liste ≠ hata doktrini)
      satirlar        : List[Dict] — metin okuyucularıyla AYNI şekil + ek alanlar
      tutarsiz        : List[Dict] — tarihi var, Tutar hücresi BOŞ (raporlanır)
      tarihsiz_tutarli: List[Dict] — tutarı var, tarihi yok (devir/faiz satırları)
      basliksiz_sayfa : List[int]  — başlık bulunamayan sayfa numaraları
      sutun_bandi     : Dict — kurulan bantlar (denetim için görünür)
    """
    tani: Dict[str, Any] = {
        "basarili": False,
        "neden": "",
        "satirlar": [],
        "tutarsiz": [],
        "tarihsiz_tutarli": [],
        "basliksiz_sayfa": [],
        "sutun_bandi": {},
        "sayfa_sayisi": 0,
    }
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            tani["sayfa_sayisi"] = len(pdf.pages)
            if not banka:
                ilk = pdf.pages[0].extract_text() or ""
                banka = _banka_tespit(ilk)
            # ⛔ AXESS GEOMETRİK OKUNAMAZ — bu bir eksiklik değil, PDF'in yapısı.
            # Axess ekstresi gömülü fontu CID eşlemesi olmadan gönderiyor;
            # pdfplumber harfleri '(cid:133)' olarak veriyor, sütun başlığı
            # ("Tutar", "Tarih") hiçbir zaman eşleşmiyor. Metin yolu bunu
            # ekstre_parser._axess_decode ile çözüyor (pymupdf + cp037 çözümü).
            # Boş liste dönüp "0 işlem" demek SAHTE YEŞİL olurdu; gerekçeyle
            # başarısız dönülür ve çağıran metin okuyucusuna düşer.
            if banka == "Axess" or _cid_bozuk(pdf):
                tani["neden"] = (
                    "Axess/CID kodlaması — PDF harfleri (cid:NNN) olarak geliyor, "
                    "sütun başlığı eşleşemez; metin okuyucusu (cp037 çözümü) kullanılmalı"
                )
                return tani
            odeme_isareti = _ODEME_ISARETI.get(banka, "+")
            bantlar: Optional[List[Tuple[str, float, float]]] = None
            tutar_sag_hiza: Optional[float] = None

            for sayfa_no, sayfa in enumerate(pdf.pages, start=1):
                try:
                    kelimeler = sayfa.extract_words(keep_blank_chars=False)
                except Exception:
                    kelimeler = []
                if not kelimeler:
                    tani["basliksiz_sayfa"].append(sayfa_no)
                    continue
                satirlar = _satirlara_bol(kelimeler)

                for satir in satirlar:
                    # Bu satır YENİ bir başlık mı? (her sayfada tekrarlar)
                    yeni = _baslik_coz(satir) if len(satir) <= 16 else None
                    if yeni:
                        bantlar = _bantlar_kur(yeni, float(sayfa.width))
                        # Sayısal sütunlar sağa dayalıdır → başlığın sağ kenarı
                        # doğru sayıyı seçmenin çıpasıdır (bkz. _tutar_sec).
                        tutar_sag_hiza = yeni["tutar"][1]
                        tani["sutun_bandi"][f"sayfa{sayfa_no}"] = [
                            {"kavram": k, "sol": round(s, 1), "sag": round(g, 1)}
                            for k, s, g in bantlar
                        ]
                        continue
                    if bantlar is None:
                        continue  # başlık daha görülmedi → tablo başlamadı

                    hucre = _hucrelere_dagit(satir, bantlar)
                    tarih = _tarih_coz(_metin(hucre, "tarih"))
                    tutar_token = _tutar_sec(hucre.get("tutar", []), tutar_sag_hiza, satir)

                    if tarih and tutar_token:
                        tani["satirlar"].append(
                            _satir_kur(hucre, tarih, tutar_token, banka, odeme_isareti)
                        )
                    elif tarih and not tutar_token:
                        # ⚠️ SESSİZ ELEME YASAK — kusur 3 tam buradaydı
                        tani["tutarsiz"].append({
                            "sayfa": sayfa_no,
                            "tarih": tarih,
                            "aciklama": _aciklama_temizle(hucre, "aciklama"),
                            "odul_hucresi": _metin(hucre, "odul"),
                            "neden": "Tutar hücresi boş — ödül/kampanya satırı olabilir",
                        })
                    elif tutar_token and not tarih:
                        # Devir / dönem faizi gibi tarihsiz ama tutarlı satırlar.
                        # Bunlar ekstre BAŞLIK bloğundan (ekstre_parser) gelir;
                        # burada görünür kalsın diye kaydedilir, işlem sayılmaz.
                        coz = _tutar_coz(tutar_token)
                        tani["tarihsiz_tutarli"].append({
                            "sayfa": sayfa_no,
                            "aciklama": _aciklama_temizle(hucre, "aciklama"),
                            "tutar": coz[0] if coz else None,
                        })

            if bantlar is None:
                tani["neden"] = (
                    "Hiçbir sayfada sütun başlığı bulunamadı "
                    "(zorunlu kavramlar: tarih + tutar)"
                )
                return tani
            if not tani["satirlar"]:
                tani["neden"] = "Başlık bulundu ama tarih+tutar taşıyan satır yok"
                return tani
            tani["basarili"] = True
            return tani
    except Exception as e:  # noqa: BLE001 — okuyucu çökerse çağıran metne düşer
        tani["neden"] = f"Geometrik okuma hatası: {type(e).__name__}: {e}"
        return tani


def _tutar_sec(kelimeler: List[Dict], sag_hiza: Optional[float] = None,
               satir: Optional[List[Dict]] = None) -> Optional[str]:
    """Tutar hücresindeki parasal token'ı seçer.

    Hücreye 'TL' eki ya da 'bosluk' çöpü de düşebilir; yalnız KURUŞU OLAN token
    aday sayılır (puan/taksit sayısı kuruşsuzdur — ikinci savunma hattı).

    ⚠️ AYRIK İŞARET (2026-08-17, Enpara vakası): bazı ekstrelerde eksi işareti
    sayıdan AYRI bir kelime olarak gelir:
        '-'@503-506  '14.050,00'@508-548  'TL'@551-561
    İşaret ayrı kaldığı için token '14.050,00' okunuyor, işaretsiz sanılıyor ve
    ÖDEME satırı HARCAMA yazılıyordu — Enpara ekstresinde 3 ödeme (≈45 K ₺)
    borç tarafına geçmişti. Bu yüzden ayrık işaret sayıya YAPIŞTIRILIR.
    """
    adaylar = [w for w in kelimeler if _SAYI.match(w["text"].strip())]
    if not adaylar:
        return None

    # ⚠️ TAŞAN AÇIKLAMA TUZAĞI (2026-08-17, Ziraat vakası): sütun sınırı iki
    # başlığın ORTA noktasıdır, ama bir sütunun İÇERİĞİ başlığından çok daha
    # geniş olabilir ve komşunun bandına taşar. Ziraat "Sonradan Taksit"
    # satırında açıklama şöyle yazılır:
    #     "... 1. Taksit  9.810,38 TL İşlemin 1/4 Taksidi   2.452,60"
    #                     └ işlemin TOPLAMI (açıklama içinde)   └ GERÇEK tutar
    # 9.810,38@270-298 orta noktayı (276) geçtiği için tutar hücresine düşüyor
    # ve ilk-eşleşen kuralı onu seçiyordu → 78 satırda 761.680 ₺ okundu, oysa
    # ekstrenin dönem borcu 268.443 ₺. Yani borç ~3 KAT şişiyordu.
    #
    # ÇÖZÜM: sayısal sütunlar SAĞA DAYALIDIR — değerin sağ kenarı başlığın sağ
    # kenarıyla hizalanır. Bu yüzden aday, sağ kenarı sütunun sağ hizasına EN
    # YAKIN olan sayıdır. Ziraat'te 2.452,60@…-458 (başlık sağı 460) kazanır,
    # 9.810,38@…-298 elenir.
    if sag_hiza is not None:
        adaylar.sort(key=lambda w: abs(w["x1"] - sag_hiza))
    secilen = adaylar[0]

    # Ayrık işaret: sayıdan hemen önce gelen tek başına '-' / '+'.
    # ⚠️ Arama HÜCREDE DEĞİL SATIRDA yapılır: işaret sayıdan ~5 punto solda
    # durur ve bu, komşu sütunun bandına düşecek kadar uzaktır. Enpara'da
    # Taksit başlığı 458-486, Tutar başlığı 536-561 → sınır 511; '-'@503
    # TAKSİT hücresine, '14.050,00'@508 TUTAR hücresine düşer. Hücreye bakan
    # arama işareti bulamaz, ödeme HARCAMA yazılırdı (3 ödeme ≈ 30 K ₺ ters
    # yöne). Geometri sütunu verir, işaret satırın kendisinden okunur.
    t = secilen["text"].strip()
    if not t.startswith(("+", "-")) and not t.endswith(("+", "-")):
        for w in (satir or kelimeler):
            if w["text"].strip() in _ISARETLER and 0 <= secilen["x0"] - w["x1"] <= 6.0:
                return ("+" if w["text"].strip() == "+" else "-") + t
    return t


_ISARETLER = {"-", "+", "−", "–"}


def _satir_kur(hucre: Dict[str, List[Dict]], tarih: str, tutar_token: str,
               banka: str, odeme_isareti: str) -> Dict[str, Any]:
    tutar, isaret = _tutar_coz(tutar_token)  # type: ignore[misc]
    aciklama = _aciklama_temizle(hucre, "aciklama")
    taksit = _taksit_coz(_metin(hucre, "taksit"), aciklama)

    ucret_mi = bool(_UCRET_METNI.search(aciklama))
    isaret_odeme = bool(isaret) and isaret == odeme_isareti
    metin_odeme = bool(_ODEME_METNI.search(aciklama))
    odeme_mi = (isaret_odeme or metin_odeme) and not ucret_mi

    odul = None
    for w in hucre.get("odul", []):
        p = w["text"].strip()
        if _SAYI_GEVSEK.match(p):
            c = _tutar_coz(p)
            odul = c[0] if c else None
            break

    return {
        "tarih": tarih,
        "aciklama": aciklama,
        "tutar": tutar,
        "banka": banka,
        "odeme_mi": odeme_mi,
        "ucret_mi": ucret_mi,
        # ── ham hücreler (duyu doktrini: topla, yorumu sonra aç) ──
        "odul_tutar": odul,
        "taksit_no": taksit["taksit_no"],
        "taksit_sayisi": taksit["taksit_sayisi"],
        "taksit_toplam": taksit["taksit_toplam"],
        "doviz_hucresi": _metin(hucre, "doviz") or None,
        "ham_tutar_token": tutar_token,
        "kaynak": "geometrik",
    }


def _cid_bozuk(pdf) -> bool:
    """İlk sayfa metninin büyük kısmı '(cid:NNN)' ise font eşlemesi yok demektir."""
    try:
        t = pdf.pages[0].extract_text() or ""
    except Exception:
        return False
    if not t:
        return False
    cid_karakter = sum(len(m) for m in re.findall(r"\(cid:\d+\)", t))
    return cid_karakter > len(t) * 0.25


def _banka_tespit(metin: str) -> str:
    t = tr_kucuk(metin[:1200])
    if "enpara" in t:
        return "Enpara"
    if "worldpuan" in t or "yapı kredi" in t or "yapi kredi" in t:
        return "Yapı Kredi"
    if "garanti" in t or "bonus trink" in t:
        return "Garanti BBVA"
    if "bankkart" in t or "ziraat" in t:
        return "Ziraat"
    if "axess" in t or "akbank" in t:
        return "Axess"
    return "Bilinmeyen"


# ─── Çapa karşılaştırması (karar main.py'de; burada sadece ölçüm) ────────────
def toplam_ozet(satirlar: List[Dict]) -> Dict[str, float]:
    """Okunan satırların harcama/ödeme toplamı — okuma denetimi çapası için."""
    harcama = sum(s["tutar"] for s in satirlar if not s.get("odeme_mi"))
    odeme = sum(s["tutar"] for s in satirlar if s.get("odeme_mi"))
    return {
        "harcama_toplami": round(harcama, 2),
        "odeme_toplami": round(odeme, 2),
        "satir_sayisi": len(satirlar),
    }
