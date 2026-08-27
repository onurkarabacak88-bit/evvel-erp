"""
DETERMİNİSTİK BESTECİ — beynin sesi kesildiğinde konuşan katman (2026-08-27)

════════════════════════════════════════════════════════════════════════════
NEDEN VAR
════════════════════════════════════════════════════════════════════════════
Sistemin konuşma zinciri dört katmanlı:
    1) ALGI      duyular dünyayı okur          (2.966 olay · 41 tip · 31 alan)
    2) AKIL      kod çapraz okur, çelişki bulur (bağ defteri · 80 cümle)
    3) GETİRME   soruya göre pencere seçer      (_blok_derle · 42 anahtar)
    4) SÖZ       cümleye döker                  ← BURASI LLM'e bağlıydı

27 Ağustos 2026: Gemini ücretsiz katman kotası doldu (429). Katman 4 öldü ve
sistemin TAMAMI sustu — oysa 1, 2 ve 3 kusursuz çalışıyordu. Sahibin gördüğü
şey "güvenli cevap üretilemedi" oldu; yani ELDE OLAN cevap, kelimeye
dökecek organ yok diye çöpe gitti.

⚠️ BU MODÜL LLM'İN YERİNE GEÇMEZ, ONUN YOKLUĞUNDA KONUŞUR.
LLM varken o konuşur (daha akıcı); yokken burası konuşur (daha kuru ama
DOĞRU). Böylece sistemin sesi bir dış hesaba bağlı olmaktan çıkar.

════════════════════════════════════════════════════════════════════════════
NASIL ÇALIŞIR — ve neden uyduramaz
════════════════════════════════════════════════════════════════════════════
Besteci HİÇBİR ŞEY ÜRETMEZ; yalnız SEÇER ve DİZER:
  · Cümleler ya bağ defterinden gelir (kod zaten Türkçe yazmış)
  · Ya da pencerelerin içindeki SAYILAR etiketiyle birlikte yazılır
  · Her satır [B#] referansı taşır — kaynaksız cümle kurulamaz
Uydurma imkânsızdır çünkü üreten şey bir şablondur, bir model değil.

⚠️ DÜRÜSTLÜK: eldeki bloklar soruyu karşılamıyorsa besteci CEVAP UYDURMAZ —
"bu soruya kayıtlardan cevap bulamadım, şu pencerelere baktım" der. Boş
cevap, yanlış cevaptan iyidir (HATA ≠ BOŞ).

⚠️ SINIRINI KENDİ SÖYLER: cevabın başında hangi organın konuştuğu yazar.
Sahip, akıcı olmayan bir cevabı "sistem bozuk" sanmasın diye.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Tuple

# ── Türkçe sayı biçimi (1.797.603,44) ───────────────────────────────────────
def _tr_sayi(v: Any, ondalik: int = 0) -> str:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    s = f"{f:,.{ondalik}f}"
    return s.replace(",", "\x00").replace(".", ",").replace("\x00", ".")


def _para(v: Any) -> str:
    return f"{_tr_sayi(v, 0)} ₺"


# ── Anahtar → okunur etiket. Ham alan adı sahibin dili değildir. ────────────
# ⚠️ Burada OLMAYAN alan gizlenmez; ham adıyla yazılır (boş alanı doldur:
#    çeviremediğimiz şeyi saklamak, olmayan şey gibi göstermek olur).
_ETIKET = {
    "kasa": "kasa", "serbest_nakit": "serbest nakit", "yuk_7": "7 günlük yük",
    "yuk_30": "30 günlük yük", "kac_gun_dayanir": "kaç gün dayanır",
    "bu_ay_ciro": "bu ay ciro", "bu_ay_nakit": "bu ay nakit",
    "bu_ay_pos": "bu ay POS", "bu_ay_online": "bu ay online",
    "eksik_gun_adet": "ciro girilmemiş gün", "eksik_adet": "şube-günü",
    "toplam_olay": "duyu olayı", "etiket_sayisi": "insan etiketi",
    "anomali_sayisi": "anomali", "toplam_karar": "motor kararı",
    "acik_kalem": "açık kalem", "toplam_tutar": "toplam tutar",
    "gecikmis": "gecikmiş", "bekleyen": "bekleyen", "tutar": "tutar",
    "adet": "adet", "gun": "gün", "sube_adi": "şube", "tarih": "tarih",
}

# Sayı olarak yazılmayacak (kimlik/teknik) alanlar — gürültü yapar
_ATLA = re.compile(
    r"(_id$|^id$|uuid|hash|_ts$|_at$|json$|ref$|kod$|slug|url|token)", re.IGNORECASE
)

# Para birimi ipucu taşıyan alan adları
_PARA_IPUCU = re.compile(
    r"(tutar|tl$|_tl|nakit|kasa|ciro|borc|borç|odenen|ödenen|yuk_|gider|maliyet|bakiye|limit)",
    re.IGNORECASE,
)


def _sayilari_topla(nesne: Any, yol: str = "", derinlik: int = 0,
                    limit: int = 14) -> List[Tuple[str, Any]]:
    """Bloktaki ANLAMLI sayıları (etiket, değer) olarak toplar.
    ⚠️ Sadece SAYI toplanır: metin alanları burada işlenmez, çünkü onları
    cümleye çevirmek yorum yapmak olur — besteci yorum yapmaz, aktarır."""
    if derinlik > 3 or len(yol) > 120:
        return []
    cikti: List[Tuple[str, Any]] = []
    if isinstance(nesne, dict):
        for k, v in nesne.items():
            if _ATLA.search(str(k)):
                continue
            alt = f"{yol} {k}".strip()
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                cikti.append((alt, v))
            elif isinstance(v, (dict, list)):
                cikti.extend(_sayilari_topla(v, alt, derinlik + 1, limit))
            if len(cikti) >= limit:
                break
    elif isinstance(nesne, list):
        # Listelerde yalnız UZUNLUK anlamlıdır; içerik tek tek dökülmez
        # (30 satırlık listeyi cümleye çevirmek gürültüdür).
        if nesne and yol:
            cikti.append((f"{yol} (kayıt sayısı)", len(nesne)))
    return cikti[:limit]


def _oku(metin: str) -> Any:
    try:
        return json.loads(metin)
    except Exception:  # noqa: BLE001
        return None


def _etiketle(yol: str) -> str:
    parcalar = [p for p in re.split(r"[\s_.]+", yol) if p]
    son = parcalar[-1] if parcalar else yol
    if yol in _ETIKET:
        return _ETIKET[yol]
    if son in _ETIKET:
        onek = " ".join(parcalar[:-1])
        return f"{onek} {_ETIKET[son]}".strip()
    return yol.replace("_", " ")


# ── Soru → kelime kökleri (Türkçe ekleri kabaca atarak) ────────────────────
def _kokler(soru: str) -> List[str]:
    # ⚠️ Türkçe küçültme tuzağı: `.lower()` "I" harfini "i" yapar ama
    # Türkçede "I"→"ı"dır. Kök eşleşmesi kaba olduğu için bu fark burada
    # zarar vermiyor; yine de sınıf hem büyük hem küçük harfleri kapsar.
    ham = re.findall(r"[0-9a-zA-ZçğıöşüÇĞİıÖŞÜ]+", (soru or "").lower())
    kokler = []
    for k in ham:
        if len(k) < 3:
            continue
        # Kaba kök: 5+ harfli kelimelerin son 2 harfi ek olabilir
        kokler.append(k[:5] if len(k) > 5 else k)
    return kokler


def _bag_cumleleri(soru: str, en_fazla: int = 6) -> List[str]:
    """Bağ defterinden soruya EN YAKIN cümleler.
    ⚠️ Bunlar zaten kodun yazdığı doğal Türkçe cümlelerdir — besteci onları
    yeniden yazmaz, SEÇER. En büyük kalite kaldıracı burasıdır."""
    try:
        from duyu_gorunumler import bag_defteri_oku
        defter = bag_defteri_oku() or {}
    except Exception:  # noqa: BLE001
        return []
    baglar = defter.get("baglar") or []
    if not isinstance(baglar, list) or not baglar:
        return []
    kokler = set(_kokler(soru))
    if not kokler:
        return []
    puanli = []
    GUVEN_SIRA = {"hesap": 0, "gozlem": 1, "orta": 2}
    for b in baglar:
        if not isinstance(b, dict):
            continue
        cumle = str(b.get("cumle") or "")
        if not cumle:
            continue
        havuz = set(_kokler(cumle)) | set(
            _kokler(" ".join(str(a) for a in (b.get("alanlar") or [])))
        )
        ortak = len(kokler & havuz)
        if ortak <= 0:
            continue
        puanli.append((-ortak, GUVEN_SIRA.get(str(b.get("guven")), 9), cumle))
    puanli.sort()
    return [c for _, _, c in puanli[:en_fazla]]


def bestele(soru: str, bloklar: List[Tuple[str, str, str]],
            sebep: Optional[str] = None) -> Dict[str, Any]:
    """Bloklardan deterministik Türkçe cevap kur.

    bloklar: [(blok_id, baslik, metin_json)]
    dönüş:   {"cevap": str, "kaynaklar": [blok_id], "yontem": "besteci"}

    ⚠️ ÜÇ KURAL (ihlal edilirse besteci LLM'in kötü taklidi olur):
      1) Sayı bloklarda YOKSA yazılmaz.
      2) Her bölüm [B#] taşır.
      3) Cevap yetersizse YETERSİZ olduğu söylenir; doldurma yapılmaz.
    """
    satirlar: List[str] = []
    kaynaklar: List[str] = []

    # ── 1) Kodun hazır yazdığı yorum cümleleri (en yüksek kalite) ──────────
    bag = _bag_cumleleri(soru)
    if bag:
        satirlar.append("Sistemin kendi çapraz okumasından:")
        for c in bag:
            satirlar.append(f"  • {c} [B42]")
        kaynaklar.append("B42")

    # ── 2) Seçilen pencerelerden anahtar rakamlar ─────────────────────────
    sayi_bolumu: List[str] = []
    for bid, baslik, metin in bloklar:
        if bid in ("B0", "BK"):        # sohbet geçmişi / katalog: rakam taşımaz
            continue
        veri = _oku(metin)
        if veri is None:
            continue
        bulunan = _sayilari_topla(veri)
        if not bulunan:
            continue
        parca = []
        for yol, deger in bulunan[:6]:
            etiket = _etiketle(yol)
            if _PARA_IPUCU.search(yol):
                parca.append(f"{etiket} {_para(deger)}")
            else:
                parca.append(f"{etiket} {_tr_sayi(deger, 0 if float(deger) == int(float(deger)) else 1)}")
        if parca:
            sayi_bolumu.append(f"  • {baslik}: " + " · ".join(parca) + f" [{bid}]")
            kaynaklar.append(bid)
    if sayi_bolumu:
        satirlar.append("")
        satirlar.append("Kayıtlardan okunan rakamlar:")
        satirlar.extend(sayi_bolumu[:8])

    # ── 3) Hiçbir şey bulunamadıysa DÜRÜSTÇE söyle ────────────────────────
    if not satirlar:
        bakilan = ", ".join(b[0] for b in bloklar[:8]) or "hiçbiri"
        return {
            "cevap": (
                "Bu soruya kayıtlardan cevap kuramadım. "
                f"Baktığım pencereler: {bakilan}. "
                "Sorunun içinde bir şube adı, bir kalem adı ya da bir dönem "
                "geçerse doğru pencereyi bulabilirim."
            ),
            "kaynaklar": [b[0] for b in bloklar[:8]],
            "yontem": "besteci",
            "yeterli": False,
        }

    # ── 4) Sınırını kendi söyler ──────────────────────────────────────────
    bas = ("🔧 Bu cevabı sistemin KENDİ motoru kurdu (dil modeli kullanılmadı"
           + (f"; sebep: {sebep}" if sebep else "")
           + "). Rakamlar kayıtlardan aynen alınmıştır; yorum sizindir.")
    son = ("Not: bu mod kuru konuşur — akıcı anlatım dil modeli açıkken gelir. "
           "Rakamların doğruluğu iki modda da aynıdır.")
    return {
        "cevap": bas + "\n\n" + "\n".join(satirlar) + "\n\n" + son,
        "kaynaklar": list(dict.fromkeys(kaynaklar)),
        "yontem": "besteci",
        "yeterli": True,
    }
