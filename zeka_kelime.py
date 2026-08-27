"""
KELİME DEFTERİ — sistem SAHİBİN DİLİNİ kendi verisinden öğrenir (2026-08-27)

════════════════════════════════════════════════════════════════════════════
NE DEĞİL
════════════════════════════════════════════════════════════════════════════
Bu bir dil modeli DEĞİLDİR. Kelime "anlamı" öğrenmez, gramer bilmez, cümle
üretmez. Öğrendiği tek şey şu eşleme:

    sahibin kullandığı kelime  ↔  o soruyu gerçekten cevaplayan pencere

Yani sözlük değil, HARİTA. "Kaçak" dediğinizde hangi duyuya bakılacağını,
"devir" dediğinizde hangi pencerenin açılacağını öğrenir.

════════════════════════════════════════════════════════════════════════════
NEDEN GEREKLİ
════════════════════════════════════════════════════════════════════════════
Bugünkü seçici 42 pencereyi ELDE YAZILMIŞ anahtar kelimelerle buluyor.
Kodun kendi yorumu sınırını kabul ediyor: "Embedding/vektör DB YOK (v0.1)".
Anahtar tutmazsa yedek davranış 51 pencereyi BİRDEN yüklüyor — yavaş,
pahalı, gürültülü. Sahibin kendi kelimeleri (şube lakapları, işletme argosu,
"kaçak/fire/devir" gibi ev dili) o listede yok ve elle yazılmakla bitmez.

Defter bu boşluğu SAHİBİN KENDİ SORULARIYLA doldurur.

════════════════════════════════════════════════════════════════════════════
ÖĞRENME SİNYALİ — ve neden bu seçildi
════════════════════════════════════════════════════════════════════════════
Öğrenmenin kanıtı CEVABIN KENDİ ATIFLARIDIR. Beyin her cümlenin sonuna
[B#] koymak ZORUNDA (post-check bunu doğruluyor). Yani bir cevap [B5]
diyorsa, o cevabı gerçekten B5 taşımıştır.

    sahip 👍 verdi  →  cevaptaki [B#]'ler  ↔  sorunun kelimeleri  bağlanır

⚠️ 👎 CEZALANDIRMAZ (Codex dersi: "kanıt gücü simetrik değildir").
Sahip bir cevabı üslubu, uzunluğu ya da o an canı istemediği için de
beğenmemiş olabilir; bu, PENCERE SEÇİMİNİN yanlış olduğunu KANITLAMAZ.
Onay güçlü kanıttır, red zayıf. 👎 yalnız ağırlığı bir tık düşürür ve
ASLA negatife indirmez — yanlış öğrenmemek için doğru öğrenmeyi silmeyiz.

⚠️ KİMLİK FİREWALL: soru metni SAKLANMAZ, yalnız kelime KÖKLERİ saklanır ve
kişi adı olabilecek kökler kara listeyle elenir. Defter bir arama geçmişi
değildir.

⚠️ ÖNERİ-ONLY: defter seçiciyi GENİŞLETİR, asla DARALTMAZ. Elle yazılmış
anahtarlar her zaman geçerlidir; defter yalnız "şunlara da bak" der. Yani
kötü bir öğrenme cevabı bozamaz, en fazla fazladan pencere açar.
"""
from __future__ import annotations

import logging
import re
from typing import Dict, List, Optional, Set, Tuple

from database import db

logger = logging.getLogger("evvel-erp")

# Öğrenmeye değmeyen kelimeler (soru kalıbı, bağlaç, zamir)
_DURDURMA: Set[str] = {
    "nedir", "ne", "neden", "nasil", "nasıl", "kac", "kaç", "kim", "hangi",
    "var", "yok", "mi", "mu", "mı", "musun", "midir", "oldu", "olur", "olan",
    "icin", "için", "ile", "ama", "veya", "ve", "bu", "su", "şu", "bir",
    "bana", "beni", "benim", "sen", "sana", "soyle", "söyle", "goster",
    "göster", "anlat", "bak", "bakar", "misin", "lutfen", "lütfen",
    "durum", "durumu", "bugun", "bugün", "dun", "dün", "simdi", "şimdi",
    # Canlı testte yakalandı: "nerede" → sertleştirme sonrası "neret" gibi
    # anlamsız bir kök üretiyordu. Soru zarfları öğrenmeye değmez.
    "nerede", "nereye", "nereden", "nedeni", "niye", "niçin", "nicin",
    "kadar", "sonra", "once", "önce", "gore", "göre", "yine", "hala", "hâlâ",
}

# Kişi adı riski: 3+ harfli ve sözlükte olmayan özel adlar. Tam çözüm yok;
# bu yüzden ek olarak PII filtresi soru girişinde zaten çalışıyor. Burada
# kaba bir emniyet: sık Türkçe ad ekleri/adları elenir.
_AD_RISKI = re.compile(
    r"^(mehmet|ahmet|ali|ayse|ayşe|fatma|mustafa|huseyin|hüseyin|hasan|"
    r"murat|emre|burak|sila|sıla|merve|elif|zeynep|kerem|onur|serkan)$",
    re.IGNORECASE,
)

# Her soruya koşulsuz eklenen çekirdek + içeriksiz meta pencereler.
# Bunları öğrenmek defteri gürültüyle doldurur (bkz. `ogren` içindeki not).
_OGRETILMEZ = {"B0", "BK", "B1", "B2", "B3", "B4", "B42", "B44"}

_TABLO_HAZIR = False


def _ensure(cur) -> None:
    global _TABLO_HAZIR
    if _TABLO_HAZIR:
        return
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS beyin_kelime_defteri (
            kelime      TEXT NOT NULL,
            blok_id     TEXT NOT NULL,
            agirlik     INTEGER NOT NULL DEFAULT 1,
            kaynak      TEXT NOT NULL DEFAULT 'gozlem',
            ilk_gorulme TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            son_gorulme TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (kelime, blok_id)
        )
        """
    )
    _TABLO_HAZIR = True


def kokler(metin: str) -> List[str]:
    """Soru → öğrenmeye değer kelime kökleri.
    ⚠️ Kaba kök: Türkçe ekleri tam ayırmak için morfoloji gerekir; burada
    5 harflik ön-kesme kullanılıyor. 'kaçak/kaçağı/kaçaktan' → 'kaçak'.
    Kaba olması sorun değil: defter seçiciyi GENİŞLETİYOR, daraltmıyor.

    ⚠️ BİLİNEN SINIR — ÜNLÜ DÜŞMESİ: "devir"→"devri", "akıl"→"aklı",
    "burun"→"burnu". Bunlar ayrı kök olarak kaydolur. Düzeltmek gerçek bir
    Türkçe kök çözümleyici ister; şimdilik kabul ediliyor çünkü sonucu bir
    EKSİK öneridir, YANLIŞ öneri değil — kelime kendi kaydını zamanla kurar.
    Ünsüz yumuşaması (k↔ğ, p↔b, ç↔c, t↔d) ise ÇÖZÜLDÜ (bkz. _sertlestir)."""
    ham = re.findall(r"[0-9a-zA-ZçğıöşüÇĞİıÖŞÜ]+", (metin or "").lower())
    cikti: List[str] = []
    for k in ham:
        if len(k) < 3 or k in _DURDURMA or _AD_RISKI.match(k):
            continue
        cikti.append(_sertlestir(k[:5] if len(k) > 5 else k))
    # tekilleştir, sırayı koru
    return list(dict.fromkeys(cikti))[:12]


# ⚠️ TÜRKÇE ÜNSÜZ YUMUŞAMASI — kaba kökün en büyük tuzağı (canlı testte
# yakalandı): "kaçak" → kacak ama "kaçağı" → kacag. Aynı kelime, iki farklı
# kök → defter ikisini AYRI sanır ve öğrendiğini bulamaz.
# Ek aldığında son ünsüz yumuşar (k→ğ, p→b, ç→c, t→d); kökü SERTE çevirerek
# ikisini aynı kutuya koyuyoruz.
_YUMUSAK = {"ğ": "k", "b": "p", "c": "ç", "d": "t", "g": "k"}


def _sertlestir(kok: str) -> str:
    if len(kok) >= 3 and kok[-1] in _YUMUSAK:
        return kok[:-1] + _YUMUSAK[kok[-1]]
    return kok


def atiflar(cevap: str) -> List[str]:
    """Cevabın kendi [B#] atıfları — hangi pencere GERÇEKTEN taşıdı.
    ⚠️ Öğrenmenin kanıtı budur: tahmin değil, cevabın kendi beyanı."""
    return list(dict.fromkeys(
        m.upper() for m in re.findall(r"\[(B\d+(?:\.\d+)?)\]", cevap or "")
    ))


def ogren(soru: str, cevap: str, olumlu: bool = True) -> Dict[str, int]:
    """👍/👎 sonrası defteri güncelle. Dönüş: {'kelime': n, 'bag': n}.
    ⚠️ Hata-yutar: defter çökse beyin çalışmaya devam eder (izole toplayıcı)."""
    ks = kokler(soru)
    bs = atiflar(cevap)
    if not ks or not bs:
        return {"kelime": 0, "bag": 0}
    # ⚠️ ÇEKİRDEK PENCERELER ÖĞRETİLMEZ (2026-08-27, canlı ölçüm dersi):
    # B1/B2/B3/B4/B42/B44 HER SORUYA koşulsuz eklenir. Onları öğrenmek
    # hiçbir şey öğretmez — zaten gelecekler. Ama öğretilirlerse HER kelime
    # onlara bağlanır, ağırlıkları hızla tavan yapar ve defter "her kelime
    # her şeyi açar" hâline gelir; yani düzeltmeye çalıştığımız
    # fallback-hepsini-yükle sorununu defter üzerinden geri getirirdik.
    # İlk canlı testte tam bu görüldü: "tema" kelimesi B44 (bugünün takvimi)
    # ile öğrenilmişti — anlamsız ama en sık tekrarlayacak bağ.
    # B0 (sohbet geçmişi) ve BK (katalog) da içerik taşımaz.
    bs = [b for b in bs if b not in _OGRETILMEZ]
    if not bs:
        return {"kelime": 0, "bag": 0}
    n = 0
    try:
        with db() as (conn, cur):
            _ensure(cur)
            for k in ks:
                for b in bs:
                    if olumlu:
                        cur.execute(
                            """INSERT INTO beyin_kelime_defteri (kelime, blok_id, agirlik)
                               VALUES (%s,%s,1)
                               ON CONFLICT (kelime, blok_id) DO UPDATE
                                 SET agirlik = LEAST(beyin_kelime_defteri.agirlik + 1, 20),
                                     son_gorulme = NOW()""",
                            (k, b),
                        )
                    else:
                        # ⚠️ ASLA SİLMEZ, ASLA NEGATİFE İNMEZ (kanıt gücü
                        # simetrik değildir): red zayıf sinyaldir.
                        cur.execute(
                            """UPDATE beyin_kelime_defteri
                                 SET agirlik = GREATEST(agirlik - 1, 1), son_gorulme = NOW()
                               WHERE kelime=%s AND blok_id=%s""",
                            (k, b),
                        )
                    n += 1
            conn.commit()
    except Exception as e:  # noqa: BLE001
        logger.warning("kelime defteri ogrenme yutuldu: %s", str(e)[:140])
        return {"kelime": 0, "bag": 0}
    return {"kelime": len(ks), "bag": n}


def onerilen_bloklar(soru: str, esik: int = 2) -> List[str]:
    """Sorunun köklerine göre ÖĞRENİLMİŞ pencereler.
    ⚠️ `esik`: bir bağ en az bu kadar kez onaylanmadan seçiciyi etkilemez —
    tek bir 👍 kalıcı davranış değiştirmemeli (Codex: tek eşik yerine kademe).
    ⚠️ Hata-yutar: defter okunamazsa BOŞ döner ve seçici eski hâliyle çalışır
    (öğrenme bir EK'tir, bağımlılık değil)."""
    ks = kokler(soru)
    if not ks:
        return []
    try:
        with db() as (_, cur):
            _ensure(cur)
            cur.execute(
                """SELECT blok_id, SUM(agirlik)::int AS puan
                     FROM beyin_kelime_defteri
                    WHERE kelime = ANY(%s) AND agirlik >= %s
                    GROUP BY blok_id
                    ORDER BY puan DESC
                    LIMIT 6""",
                (ks, esik),
            )
            return [str(dict(r)["blok_id"]) for r in (cur.fetchall() or [])]
    except Exception as e:  # noqa: BLE001
        logger.warning("kelime defteri okuma yutuldu: %s", str(e)[:140])
        return []


def defter_ozet(limit: int = 60) -> Dict:
    """Salt-okur: sistem NE ÖĞRENDİ. (kanıt görünür — öğrenme gizli olmaz)"""
    try:
        with db() as (_, cur):
            _ensure(cur)
            cur.execute(
                """SELECT kelime, blok_id, agirlik, kaynak,
                          son_gorulme::text AS son_gorulme
                     FROM beyin_kelime_defteri
                    ORDER BY agirlik DESC, son_gorulme DESC LIMIT %s""",
                (max(1, min(300, limit)),),
            )
            satirlar = [dict(r) for r in (cur.fetchall() or [])]
            cur.execute("SELECT COUNT(*)::int AS n FROM beyin_kelime_defteri")
            toplam = int(dict(cur.fetchone() or {}).get("n") or 0)
            cur.execute(
                "SELECT COUNT(DISTINCT kelime)::int AS n FROM beyin_kelime_defteri")
            kelime_n = int(dict(cur.fetchone() or {}).get("n") or 0)
        return {
            "toplam_bag": toplam, "kelime_sayisi": kelime_n, "satirlar": satirlar,
            "not": ("Sistem sahibin kelimelerini KENDİ verisinden öğrenir: "
                    "👍 verilen cevabın [B#] atıfları, sorunun kelimeleriyle "
                    "eşleşir. Bu bir sözlük değil HARİTA'dır — kelimenin anlamını "
                    "değil, hangi pencereyi açacağını öğrenir. 👎 ceza vermez "
                    "(kanıt gücü simetrik değildir)."),
        }
    except Exception as e:  # noqa: BLE001
        return {"__hata__": str(e)[:200]}


def temizle_ogretilmez() -> Dict:
    """Kural dışı (çekirdek/meta) pencere bağlarını defterden sil.
    ⚠️ Kuralı değiştirip geçmişi bırakmak, kuralı yarım değiştirmektir."""
    try:
        with db() as (conn, cur):
            _ensure(cur)
            cur.execute(
                "DELETE FROM beyin_kelime_defteri WHERE blok_id = ANY(%s)",
                (sorted(_OGRETILMEZ),),
            )
            silinen = cur.rowcount or 0
            conn.commit()
            cur.execute("SELECT COUNT(*)::int AS n FROM beyin_kelime_defteri")
            kalan = int(dict(cur.fetchone() or {}).get("n") or 0)
        return {"ok": True, "silinen": silinen, "kalan": kalan,
                "kural": sorted(_OGRETILMEZ)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "hata": str(e)[:200]}
