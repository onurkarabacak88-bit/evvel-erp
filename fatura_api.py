"""
Tedarikçi Fatura Okuma Modülü — İZOLE.

Tasarım ilkesi (bkz. memory project_fatura_okuma_modulu + feedback_cozum_felsefesi
"Öneri-Only / Proposed State"):
  - Bu modül sistemin GERÇEKLERİNİ (stok maliyeti, ürün fiyatı) ASLA doğrudan
    değiştirmez. Yalnızca KENDİ tablolarına yazar (öneri/ham veri).
  - FAIL CLOSED + ASENKRON: şube OCR beklemez. Foto yüklenince kabul anında biter;
    OCR arka planda çalışır, sonuç inceleme ekranına düşer. OCR çökse manuel devam.
  - Kill switch: FATURA_MODUL env=0 → tamamen kapanır (kritik akış etkilenmez).
  - Kritik tablolara SERT FK yok; sadece yumuşak id referansı (sube_id, siparis_talep_id).

Faz 1 (bu dosya): foto upload → asenkron vision OCR → ham JSON + kalemler. Öneri-only.
Faz 2+: ürün eşleştirme hafızası, üç-yönlü uzlaşma, fiyat onayı (Price Approval Service).
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
import threading
import uuid
from datetime import date, timedelta
from typing import Any, Dict, List, Optional

import io

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/fatura", tags=["fatura-okuma"])


def fatura_modul_aktif() -> bool:
    """Kill switch — FATURA_MODUL=0 ise modül pasif (kritik akış etkilenmez)."""
    return os.getenv("FATURA_MODUL", "1").strip() not in ("0", "false", "False", "")


_TABLOLAR_HAZIR = False


def _ensure_tablolar(cur) -> None:
    """Modülün KENDİ tabloları (izole). İlk kullanımda lazy oluşturulur."""
    global _TABLOLAR_HAZIR
    if _TABLOLAR_HAZIR:
        return
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tedarikci_fatura (
            id                  TEXT PRIMARY KEY,
            sube_id             TEXT,
            siparis_talep_id    TEXT,
            tedarikci_ad        TEXT,
            fatura_tarih        DATE,
            toplam_tutar        DOUBLE PRECISION,
            foto                BYTEA,
            foto_mime           TEXT,
            durum               TEXT NOT NULL DEFAULT 'ocr_bekliyor',
            ocr_json            JSONB,
            ocr_hata            TEXT,
            yukleyen_personel_id TEXT,
            olusturma           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            inceleme_ts         TIMESTAMPTZ,
            inceleyen           TEXT
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tf_sube_durum ON tedarikci_fatura (sube_id, durum, olusturma DESC)")
    # PDF e-fatura kaynağı: foto yerine doğrudan metin (vision OCR'sız). Maliyet'ten
    # toplu PDF yüklemede her fatura sayfasının metni burada tutulur; arka plan işçisi
    # bunu LLM'e verir (foto varsa vision, metin varsa text yolu — aynı JSON şeması).
    cur.execute("ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS kaynak_metin TEXT")
    cur.execute("ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS kaynak_tip TEXT")  # 'foto' | 'pdf'
    cur.execute("ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS fatura_no TEXT")    # e-fatura no (PDF'te tekil)
    # Akıllı Denetim "yürüyen bakiye zinciri" duyusu için HAM veri (alarm YOK, sadece
    # birikim): tedarikçinin kendi cari defteri. Boşluk: önceki[N+1] > dahil[N].
    # İlke: duyu üretmeden önce ham veriyi topla (bkz. project_tedarik_belge_denetim_duyulari).
    cur.execute("ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS onceki_bakiye DOUBLE PRECISION")
    cur.execute("ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS bakiye_dahil DOUBLE PRECISION")
    cur.execute("ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS tedarikci_vkn TEXT")  # cari-seviye gruplama için
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tedarikci_fatura_kalem (
            id              TEXT PRIMARY KEY,
            fatura_id       TEXT NOT NULL,
            sira            INT,
            ocr_ad          TEXT,
            adet            DOUBLE PRECISION,
            birim           TEXT,
            birim_fiyat     DOUBLE PRECISION,
            satir_toplam    DOUBLE PRECISION,
            eslesen_stok_kodu TEXT,   -- ÖNERİ (nullable), eşleştirme Faz 2
            eslesme_guven   DOUBLE PRECISION,
            olusturma       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tfk_fatura ON tedarikci_fatura_kalem (fatura_id)")
    # Köprü: e-faturadaki ürün kodu (alias anahtarı için) — onay adımında kullanılır
    cur.execute("ALTER TABLE tedarikci_fatura_kalem ADD COLUMN IF NOT EXISTS ocr_urun_kodu TEXT")
    # İNSAN ONAYI işareti — onaylanan kalem tekrar onay istemesin (mükerrer fiyat kaydı önlenir).
    # eslesme_guven=1.0 OCR alias'tan da gelebildiği için ayrı, net bayrak tutulur.
    cur.execute("ALTER TABLE tedarikci_fatura_kalem ADD COLUMN IF NOT EXISTS onaylandi BOOLEAN NOT NULL DEFAULT FALSE")
    # Fiyat geçmişi — GERÇEK fiyat değil; modülün kendi takip kaydı. Kritik maliyete
    # ancak ayrı Price Approval Service + insan onayı ile bağlanır (Faz 3).
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tedarikci_urun_fiyat_gecmis (
            id              TEXT PRIMARY KEY,
            tedarikci_ad    TEXT,
            stok_kodu       TEXT,
            urun_ad         TEXT,
            birim_fiyat     DOUBLE PRECISION,
            fatura_id       TEXT,
            onaylayan       TEXT,
            gecerlilik_ts   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tufg_ted_stok ON tedarikci_urun_fiyat_gecmis (tedarikci_ad, stok_kodu, gecerlilik_ts DESC)")
    # BM-1 (2026-07-10): belge kimliği + GİB damgası kolonları
    cur.execute("ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS parmak_izi TEXT")
    cur.execute("ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS ettn TEXT")
    cur.execute("ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS gib_dogrulama TEXT")
    cur.execute("ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS gib_dogrulama_ts TIMESTAMPTZ")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tf_parmak ON tedarikci_fatura (parmak_izi)")
    # MÜKERRER FRENİ katman-1 (2026-07-23, sahip: 'aynı belge iki yerden ekleniyor'):
    # dosya içeriği sha256'sı — birebir aynı dosya ikinci kanaldan gelirse ANINDA yakalanır
    cur.execute("ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS dosya_hash TEXT")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tf_dosya_hash ON tedarikci_fatura (dosya_hash)")
    # BELGE SINIFI (2026-08-08, sahip: "ürüne gelen faturayla elektrik faturası
    # arasında fark var — sistem bunun farkında mı?"). Farkı vardı ama sadece
    # EKRANDA: tedarikci_sinif() her okumada yeniden hesaplanıyor, hiçbir yere
    # yazılmıyordu. Kimlik artık KAYNAKTA damgalanır; heuristik emniyet ağı olur.
    #   'mal'    → stoka giren ürün faturası (teslimatla eşleşir, COGS'a yazılır)
    #   'hizmet' → abonelik/gider faturası (elektrik, su, telekom — stok YOK)
    cur.execute("ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS belge_sinifi TEXT")
    cur.execute("ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS sinif_kaynak TEXT")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tf_belge_sinifi ON tedarikci_fatura (belge_sinifi)")
    # BM-8: tam metin arama (simple config — Türkçe ekleri ILIKE yedeğiyle telafi)
    cur.execute("""CREATE INDEX IF NOT EXISTS idx_tf_fts ON tedarikci_fatura
                   USING GIN (to_tsvector('simple',
                       COALESCE(tedarikci_ad,'') || ' ' || COALESCE(fatura_no,'') || ' ' ||
                       COALESCE(kaynak_metin,'')))""")
    _TABLOLAR_HAZIR = True


# ── Saklama politikası (BM-0a, 2026-07-10): VUK 5 yıl / TTK 10 yıl belge saklama
# yükümlülüğü — 6 aylık silme YASAL RİSKti. 120 aya çekildi; kalıcı çözüm BM-0b
# (obje depoya taşıma, DB'de yalnız künye+hash). Hacim ~0.5GB/yıl — taşınabilir.
FATURA_FOTO_SAKLAMA_AY = 120


def fatura_foto_temizle(cur) -> int:
    """6 aydan eski faturaların foto BYTEA'sını siler (DB şişmesin). Kayıt + OCR
    sonucu + kalemler KALIR (denetim izi sürer); sadece ağır görüntü düşer.
    Dönüş: temizlenen fatura sayısı."""
    try:
        _ensure_tablolar(cur)
        cur.execute(
            """
            UPDATE tedarikci_fatura
            SET foto = NULL
            WHERE foto IS NOT NULL
              AND olusturma < NOW() - (%s * INTERVAL '1 month')
            """,
            (int(FATURA_FOTO_SAKLAMA_AY),),
        )
        return cur.rowcount or 0
    except Exception:
        return 0


# ── OCR (asenkron, arka plan) ────────────────────────────────────────────────

_OCR_PROMPT = (
    "Bu, basılı bir Türk e-FATURASI fotoğrafıdır (bilgisayar çıktısı, düzenli tablo).\n"
    "ÖNEMLİ — TEDARİKÇİ KİM: Faturayı DÜZENLEYEN/satan firma EN ÜSTTEKİ başlıktır "
    "(logo/ünvan + VKN + 'e-Fatura'). 'SAYIN' satırından sonra gelen firma ALICIdır "
    "(müşteri) — onu tedarikçi SANMA. tedarikci alanına EN ÜSTTEKİ düzenleyen firmayı yaz.\n"
    "Kalem TABLOSUNDAKİ HER SATIRI oku. 'Ürün Kodu'/'Mal Hizmet Kodu' kolonundaki kodu "
    "(örn. ST00558, STK0590) MUTLAKA al — bu en kritik alan.\n"
    "SADECE şu JSON'u döndür, başka metin yazma:\n"
    '{"tedarikci": "<EN ÜSTTEKİ düzenleyen firma ünvanı>", '
    '"fatura_no": "<fatura no>", "fatura_tarih": "YYYY-MM-DD veya null", '
    '"toplam_tutar": <Ödenecek/Genel Toplam sayı veya null>, "kalemler": [{'
    '"urun_kodu": "<Ürün Kodu, örn ST00558; yoksa null>", '
    '"ad": "<malzeme/hizmet açıklaması>", "adet": <miktar sayı>, '
    '"birim": "<Adet/kg/lt>", "birim_fiyat": <Birim Fiyatı sayı>, '
    '"satir_toplam": <satır KDV hariç tutar sayı>}]}\n'
    "Sayı biçimi: Türkçe 1.234,56 → 1234.56 (nokta=ondalık). Tarih gün-ay-yıl ise "
    "YYYY-MM-DD'ye çevir. Her ürün satırını ekle; sadece okunamayan TEK alanı null bırak."
)


def _vision_ocr(foto: bytes, mime: str) -> Dict[str, Any]:
    """Vision model ile faturadan yapılandırılmış JSON çıkarır. Hata → exception."""
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY yok")
    from openai import OpenAI
    # LLM_BASE_URL doluysa OpenAI-uyumlu başka sağlayıcı (örn. Gemini ücretsiz
    # katman: generativelanguage.googleapis.com/v1beta/openai/) kullanılır
    client = OpenAI(api_key=api_key,
                    base_url=(os.getenv("LLM_BASE_URL") or "").strip() or None)
    b64 = base64.b64encode(foto).decode("ascii")
    resp = client.chat.completions.create(
        model=os.getenv("OPENAI_FATURA_MODEL", "gpt-4o"),  # fatura kritik → tam model
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": _OCR_PROMPT},
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
            ],
        }],
        max_tokens=int(os.getenv('OCR_MAX_TOKENS', '4000')),
    )
    metin = (resp.choices[0].message.content or "").strip()
    return _json_govde_coz(metin)


def _kesik_json_kurtar(s: str):
    """Yarıda kesilmiş JSON'dan son TAM yapıyı kurtarır (None = kurtarılamadı).

    LLM token sınırına takılınca cevap ortada biter ('Unterminated string').
    Açık string kapatılır, son tam kalemden sonrası atılır, açık kalan
    dizi/nesneler kapatılır. Tedarikçi + tutar genelde başta olduğu için
    kurtulur; eksik kalemler gece yeniden okumada tamamlanır.
    """
    if not s or "{" not in s:
        return None
    govde = s
    if govde.count('"') % 2 == 1:          # açık string → son tırnağa kadar geri sar
        govde = govde[:govde.rfind('"')]
    for kes in (govde.rfind("},"), govde.rfind("}"), govde.rfind("]")):
        if kes <= 0:
            continue
        aday = govde[:kes + 1]
        acik_kume = aday.count("{") - aday.count("}")
        acik_dizi = aday.count("[") - aday.count("]")
        if acik_kume < 0 or acik_dizi < 0:
            continue
        kapali = aday.rstrip().rstrip(",") + ("]" * acik_dizi) + ("}" * acik_kume)
        try:
            j = json.loads(kapali)
            if isinstance(j, dict):
                return j
        except json.JSONDecodeError:
            continue
    return None


def _json_govde_coz(metin: str) -> Dict[str, Any]:
    """LLM yanıtından JSON nesnesini güvenle çıkarır. Boş/bozuk yanıt → net hata
    (eski 'Expecting value: line 1 column 1' karmaşası yerine). ```json çitlerini
    ve süslü-parantez gövdesini ayıklar."""
    s = (metin or "").strip()
    if not s:
        raise RuntimeError("LLM boş yanıt döndü (fatura okunamadı)")
    if "```" in s:
        # ```json ... ``` ya da ``` ... ``` çitini soy
        parca = s.split("```")
        if len(parca) >= 2:
            s = parca[1]
            if s.lstrip().lower().startswith("json"):
                s = s.lstrip()[4:]
    s = s.strip()
    # İlk { ... son } gövdesini al (model baş/sona açıklama eklerse)
    if not s.startswith("{"):
        a = s.find("{"); b = s.rfind("}")
        if a != -1 and b != -1 and b > a:
            s = s[a:b + 1]
    try:
        j = json.loads(s)
    except json.JSONDecodeError:
        # 🔧 JSON ONARIMI (2026-08-08, sahip: "ileride de yaşamamak için önlem al").
        # Canlı hata: "Expecting property name enclosed in double quotes: line 11".
        # LLM'ler JSON üretirken üç yaygın kusur yapar; hepsi ONARILABİLİR:
        #   1. trailing comma  → {"a":1,}  /  [1,2,]
        #   2. tek tırnaklı anahtar/değer → {'a': 'b'}
        #   3. kaçmamış kontrol karakteri (satır sonu) metin içinde
        # Onarım BAŞARISIZ olursa özgün hata yükselir — sessizce boş dönmeyiz.
        d = re.sub(r",\s*([}\]])", r"\1", s)                    # 1
        d = re.sub(r"'([^'\"\n]{1,60})'\s*:", r'"\1":', d)      # 2a anahtar
        d = re.sub(r":\s*'([^'\n]{0,300})'", r': "\1"', d)      # 2b değer
        d = "".join(ch for ch in d if ch >= " " or ch in "\n\t")  # 3
        try:
            j = json.loads(d)
        except json.JSONDecodeError:
            # 4. KESİK CEVAP (canlı: "Unterminated string at line 3") — model
            # token sınırına takılıp yarıda kesilmiş. Son TAM yapıya kadar
            # kurtarırız: tedarikçi/tutar başta olduğu için kurtulur, eksik
            # kalemler gece yeniden okumada tamamlanır.
            j = _kesik_json_kurtar(d)
            if j is None:
                raise
            logger.warning("fatura JSON KESİK geldi — son tam yapıya kadar kurtarıldı "
                           "(token sınırı; eksik kalemler gece tamamlanacak)")
            j["_kismi_okuma"] = True
            return j
        logger.info("fatura JSON onarımıyla ayrıştırıldı (LLM bozuk JSON döndürmüştü)")
    return j if isinstance(j, dict) else {}


# ── ⏳ GEÇİCİ vs KALICI HATA (2026-08-08): kota/ağ hatası GEÇİCİDİR — fatura
# "okunamadı" diye rafa kalkmamalı, gece yeniden denenmelidir. Görsel bozuksa
# tekrar denemek boşuna; o KALICIDIR.
_GECICI_HATA_IZLERI = (
    "429", "quota", "rate limit", "rate_limit", "timeout", "timed out",
    "temporarily", "unavailable", "503", "502", "504", "connection",
    "overloaded", "try again",
)


def hata_gecici_mi(mesaj: str) -> bool:
    m = (mesaj or "").lower()
    return any(k in m for k in _GECICI_HATA_IZLERI)


_OCR_PROMPT_PDF = (
    "Aşağıda bir Türk e-FATURASININ DÜZ METNİ var (PDF'ten çıkarıldı). "
    "TEK bir faturadır.\n"
    "TEDARİKÇİ KİM: Faturayı DÜZENLEYEN/satan firma genelde alt blokta 'e-Fatura' ve "
    "VKN ile yer alır; 'SAYIN' satırından sonraki firma ALICIdır (müşteri) — onu "
    "tedarikçi SANMA. tedarikci alanına faturayı KESEN (satan) firmayı yaz.\n"
    "Kalem tablosundaki HER ürün satırını oku. Ürün/Stok Kodu (örn. STK1006, ST00096) "
    "MUTLAKA al — en kritik alan. Ürün adı birden çok satıra bölünmüş olabilir, BİRLEŞTİR.\n"
    "SADECE şu JSON'u döndür, başka metin yazma:\n"
    '{"tedarikci": "<satan firma ünvanı>", '
    '"fatura_no": "<Fatura No>", "fatura_tarih": "YYYY-MM-DD veya null", '
    '"toplam_tutar": <Ödenecek Tutar sayı veya null>, "kalemler": [{'
    '"urun_kodu": "<Stok Kodu, örn STK1006; yoksa null>", '
    '"ad": "<ürün açıklaması, çok satırlıysa birleşik>", "adet": <miktar sayı>, '
    '"birim": "<Adet/kg/lt>", "birim_fiyat": <Birim Fiyatı sayı>, '
    '"satir_toplam": <Mal Hizmet Tutarı, KDV hariç sayı>}]}\n'
    "Sayı biçimi: Türkçe 1.234,56 → 1234.56 (nokta=ondalık). Tarih gün-ay-yıl ise "
    "YYYY-MM-DD'ye çevir. Her ürün satırını ekle."
)


def _text_ocr(metin: str) -> Dict[str, Any]:
    """PDF e-fatura DÜZ METNİNDEN yapılandırılmış JSON çıkarır (vision YOK → 'Expecting
    value' hatası olmaz). Tek deneme başarısızsa bir kez daha dener, sonra exception."""
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY yok")
    from openai import OpenAI
    # LLM_BASE_URL doluysa OpenAI-uyumlu başka sağlayıcı (örn. Gemini ücretsiz
    # katman: generativelanguage.googleapis.com/v1beta/openai/) kullanılır
    client = OpenAI(api_key=api_key,
                    base_url=(os.getenv("LLM_BASE_URL") or "").strip() or None)
    govde = (metin or "").strip()[:12000]  # uzun faturada bağlamı sınırla
    son_hata: Optional[Exception] = None
    # ⏳ 3 deneme + ARTAN BEKLEME (2026-08-08): eski sürüm 2 denemeyi ART ARDA
    # yapıyordu; kota (429) hatasında beklemeden tekrar denemek aynı hatayı
    # alır — canlıda bir fatura tam da bu yüzden "okunamadı" kalmıştı.
    for _deneme in range(3):
        try:
            resp = client.chat.completions.create(
                model=os.getenv("OPENAI_FATURA_MODEL", "gpt-4o"),
                messages=[{"role": "user", "content": f"{_OCR_PROMPT_PDF}\n\n--- FATURA METNİ ---\n{govde}"}],
                temperature=0,
                max_tokens=int(os.getenv('OCR_MAX_TOKENS', '4000')),
            )
            return _json_govde_coz(resp.choices[0].message.content or "")
        except Exception as e:  # JSON/ağ/kota hatası
            son_hata = e
            if _deneme < 2 and hata_gecici_mi(str(e)):
                import time as _t
                _t.sleep(2 * (_deneme + 1))   # 2sn, 4sn — kota penceresi açılsın
                continue
            if _deneme < 2:
                continue                       # kalıcı görünüyor ama bir şans daha
    raise RuntimeError(f"Fatura metni JSON'a çevrilemedi: {son_hata}")


def _fatura_json_db_yaz(cur, fatura_id: str, j: Dict[str, Any]) -> int:
    """OCR/text JSON sonucunu tedarikci_fatura + _kalem'e yazar (foto & PDF ortak yol).
    Commit ETMEZ — çağıran commit'ler. Dönüş: yazılan kalem sayısı."""
    kalemler = j.get("kalemler") if isinstance(j.get("kalemler"), list) else []
    # Tarih ve fatura_no PDF'te regex ile zaten kesin yazıldıysa KORU (LLM ezmesin);
    # foto yolunda bunlar NULL → COALESCE LLM değerini kullanır.
    cur.execute(
        """
        UPDATE tedarikci_fatura
        SET tedarikci_ad=COALESCE(%s, tedarikci_ad),
            fatura_tarih=COALESCE(fatura_tarih, %s),
            toplam_tutar=%s,
            fatura_no=COALESCE(fatura_no, %s),
            ocr_json=%s::jsonb, durum='ocr_tamam', ocr_hata=NULL
        WHERE id=%s
        """,
        (
            (str(j.get("tedarikci") or "").strip() or None),
            (str(j.get("fatura_tarih")) if j.get("fatura_tarih") else None),
            _sayi(j.get("toplam_tutar")),
            (str(j.get("fatura_no") or "").strip() or None),
            json.dumps(j, ensure_ascii=False),
            fatura_id,
        ),
    )
    # 🏷 BELGE SINIFI — kimlik KAYNAKTA damgalanır (2026-08-08, sahip: "ürüne
    # gelen faturayla elektrik faturası arasında fark var"). Tedarikçi adı ancak
    # BURADA belli olur (yükleme anında NULL), o yüzden damga tam bu noktada.
    # Foto ve PDF ortak yol → tek damga noktası.
    # Kalem adları JSON'dan okunur — DB'ye henüz yazılmamış olabilir (aynı
    # fonksiyonda aşağıda yazılıyor), ama içerik kanıtı elimizde hazır.
    _ted = (str(j.get("tedarikci") or "").strip() or None)
    if _ted:
        _kalem_adlari = [k.get("ad") or k.get("urun_ad") or k.get("aciklama")
                         for k in kalemler if isinstance(k, dict)]
        belge_sinifi_coz(cur, fatura_id, _ted, _kalem_adlari)
    # 📑 KOPYA KAPANIŞI (sahip 2026-07-18: "personel foto çekiyor, okunamayınca
    # toptancıdan PDF istiyoruz, PDF gelince aynı fatura İKİ kayıt oluyor").
    # Foto sonradan okununca aynı fatura_no başka satırda zaten varsa BU satır
    # 'kopya' olur: cari/kapsama/mükerrer hesaplarına GİRMEZ, foto yasal arşiv
    # yedeği olarak kalır (silinmez). Karşılaştırma normalize no üstünden.
    _kopya_no = (str(j.get("fatura_no") or "").strip())
    if len(_kopya_no) >= 8:
        try:
            cur.execute(
                """SELECT id FROM tedarikci_fatura
                   WHERE id <> %s AND COALESCE(durum,'') <> 'kopya'
                     AND UPPER(REGEXP_REPLACE(COALESCE(fatura_no,''),
                                              '[^A-Za-z0-9]','','g'))
                         = UPPER(REGEXP_REPLACE(%s,'[^A-Za-z0-9]','','g'))
                   -- ASIL SEÇİMİ FIX (2026-07-25, ATALAY NPE...432 vakası): asıl,
                   -- SAĞLIKLI nüsha olmalı — eskiden salt olusturma sırası, OCR
                   -- hatalı/tutarsız kaydı asıl bırakıp okunmuşları kopyalıyordu
                   -- → borç kuyruğu hiç doğmuyordu.
                   ORDER BY (CASE WHEN durum IN ('ocr_tamam','okundu')
                                   AND COALESCE(toplam_tutar,0) > 0 THEN 0 ELSE 1 END),
                            olusturma LIMIT 1""", (fatura_id, _kopya_no))
            _asil = cur.fetchone()
            if _asil:
                cur.execute(
                    """UPDATE tedarikci_fatura SET durum='kopya',
                           ocr_hata='aynı faturanın ikinci nüshası (foto+PDF) — asıl: '
                                    || %s
                       WHERE id=%s""", (str(dict(_asil)["id"]), fatura_id))
                cur.execute("DELETE FROM tedarikci_fatura_kalem WHERE fatura_id=%s",
                            (fatura_id,))
                return 0
        except Exception:  # noqa: BLE001
            pass
    # 📑 NO'SUZ MÜKERRER (2026-07-25, APS/RedBull vakası): OCR fatura no'yu
    # OKUYAMADIYSA no-bazlı kopya kapanışı çalışamaz → aynı tedarikçi + AYNI
    # kuruş tutar + no'lu SAĞLIKLI kayıt varsa bu no'suz kayıt onun zayıf
    # nüshasıdır → kopya. (Aynı gün aynı tutarlı iki GERÇEK fatura ikisi de
    # no'lu gelir — bu dal yalnız no'suz kaydı kapatır, riski dar.)
    _tut = _sayi(j.get("toplam_tutar"))
    _ted = (str(j.get("tedarikci") or "").strip())
    if len(_kopya_no) < 8 and _tut and _tut > 0 and len(_ted) >= 3:
        try:
            cur.execute(
                """SELECT id FROM tedarikci_fatura
                   WHERE id <> %s AND COALESCE(durum,'') <> 'kopya'
                     AND LENGTH(COALESCE(fatura_no,'')) >= 8
                     AND ABS(COALESCE(toplam_tutar,0) - %s) < 0.01
                     AND UPPER(REGEXP_REPLACE(COALESCE(tedarikci_ad,''),'[^A-Za-zÇĞİÖŞÜçğıöşü0-9]','','g'))
                         LIKE UPPER(REGEXP_REPLACE(%s,'[^A-Za-zÇĞİÖŞÜçğıöşü0-9]','','g')) || '%%'
                   ORDER BY olusturma LIMIT 1""",
                (fatura_id, _tut, _ted[:20]))
            _asil2 = cur.fetchone()
            if _asil2:
                cur.execute(
                    """UPDATE tedarikci_fatura SET durum='kopya',
                           ocr_hata='no''suz nüsha — aynı tedarikçi+tutar, asıl: ' || %s
                       WHERE id=%s""", (str(dict(_asil2)["id"]), fatura_id))
                cur.execute("DELETE FROM tedarikci_fatura_kalem WHERE fatura_id=%s",
                            (fatura_id,))
                return 0
        except Exception:  # noqa: BLE001
            pass
    # 🔐 PARMAK İZİ ANINDA (2026-07-23): gece backfill'i bekleme — OCR biter bitmez
    # kimlik damgalanır ki mükerrer taraması/duyusu aynı gün çalışsın (katman-2)
    try:
        cur.execute(
            """SELECT tedarikci_vkn, fatura_no, fatura_tarih, toplam_tutar, tedarikci_ad
               FROM tedarikci_fatura WHERE id=%s""", (fatura_id,))
        _fr = dict(cur.fetchone() or {})
        if _fr:
            cur.execute(
                "UPDATE tedarikci_fatura SET parmak_izi=%s WHERE id=%s",
                (_belge_parmak_izi(_fr.get("tedarikci_vkn"), _fr.get("fatura_no"),
                                   _fr.get("fatura_tarih"), _fr.get("toplam_tutar"),
                                   _fr.get("tedarikci_ad")), fatura_id))
    except Exception:  # noqa: BLE001
        pass
    # DUYU OMURGASI kancası (2026-07-06): fatura işlendi = Katman-2 olay (hata-yutar,
    # source_ref=fatura_id idempotent — yeniden-OCR çift olay üretmez).
    try:
        from duyu_omurga import duyu_olay_yaz
        duyu_olay_yaz(
            "fatura_ocr", "tedarik.belge.fatura_islendi", str(fatura_id),
            entity_scope="tedarikci",
            entity_id=(str(j.get("tedarikci") or "").strip() or None),
            occurred_at=(str(j.get("fatura_tarih")) if j.get("fatura_tarih") else None),
            signal_name="Fatura OCR tamamlandı",
            payload={"toplam_tutar": _sayi(j.get("toplam_tutar")), "kalem_sayisi": len(kalemler)},
        )
    except Exception:  # noqa: BLE001
        pass
    # Eski kalemleri temizle (yeniden işleme/tekrar deneme idempotent olsun)
    cur.execute("DELETE FROM tedarikci_fatura_kalem WHERE fatura_id=%s", (fatura_id,))
    for i, k in enumerate(kalemler):
        if not isinstance(k, dict):
            continue
        _ad = (str(k.get("ad") or "").strip() or None)
        _kod = (str(k.get("urun_kodu") or "").strip() or None)
        # ── KÖPRÜ: mevcut alias hafızasından eşleşen stok kalemini öner ──
        _anahtar = _fatura_anahtar_ocr(_kod, _ad)
        _es = _alias_eslesme(cur, _anahtar)
        _eslesen = _es.get("kalem_kodu") if _es else None
        cur.execute(
            """
            INSERT INTO tedarikci_fatura_kalem
                (id, fatura_id, sira, ocr_ad, ocr_urun_kodu, adet, birim,
                 birim_fiyat, satir_toplam, eslesen_stok_kodu, eslesme_guven)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                str(uuid.uuid4()), fatura_id, i, _ad, _kod,
                _sayi(k.get("adet")), (str(k.get("birim") or "").strip() or None),
                _sayi(k.get("birim_fiyat")), _sayi(k.get("satir_toplam")),
                _eslesen, (1.0 if _eslesen else None),
            ),
        )
    return len(kalemler)


def _pdf_metin_sayfalar(pdf_bytes: bytes) -> List[str]:
    """PDF'in her sayfasının düz metnini döndürür (pdfplumber, yedeği pymupdf)."""
    try:
        import pdfplumber  # type: ignore
        out: List[str] = []
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for p in pdf.pages:
                out.append(p.extract_text() or "")
        return out
    except Exception:
        import fitz  # type: ignore  # pymupdf
        d = fitz.open(stream=pdf_bytes, filetype="pdf")
        return [d[i].get_text() or "" for i in range(d.page_count)]


def _pdf_faturalara_bol(pdf_bytes: bytes) -> List[Dict[str, Any]]:
    """Çok-sayfalı e-fatura PDF'ini AYRI faturalara böler. Her 'Fatura No:' içeren
    sayfa yeni fatura başlatır; 'Fatura No' içermeyen sayfa önceki faturanın DEVAMIDIR
    (metni ona eklenir). Dönüş: [{fatura_no, metin}]."""
    sayfalar = _pdf_metin_sayfalar(pdf_bytes)
    faturalar: List[Dict[str, Any]] = []
    for metin in sayfalar:
        # "Fatura No", "Fatura Numarası", "Fatura No." gibi varyasyonlar; no'da ./- olabilir
        m = re.search(r"Fatura\s*(?:No|Numaras[ıi]|No\.)\s*:?\s*([A-Z0-9./\-]+)", metin or "", re.IGNORECASE)
        if m:
            _bak = _fatura_bakiye_regex(metin or "")
            faturalar.append({
                "fatura_no": m.group(1),
                "fatura_tarih": _fatura_tarih_regex(metin or ""),  # DETERMINISTIK (LLM'e güvenme)
                "onceki_bakiye": _bak["onceki_bakiye"],
                "bakiye_dahil": _bak["bakiye_dahil"],
                "metin": metin or "",
            })
        elif faturalar:
            # Fatura No yok → önceki faturanın devam sayfası
            faturalar[-1]["metin"] += "\n" + (metin or "")
            if not faturalar[-1].get("fatura_tarih"):
                faturalar[-1]["fatura_tarih"] = _fatura_tarih_regex(metin or "")
        # İlk sayfa Fatura No içermiyorsa (kapak vb.) atlanır
    # FALLBACK: hiç "Fatura No" etiketi yakalanmadı ama PDF'te METİN var
    # (farklı tedarikçi formatı, ör. DYK) → tüm metni TEK fatura olarak ele al.
    # Kullanıcı zaten kalemleri tek tek görüp onaylıyor; fatura_no=None (mükerrer
    # kontrolü atlanır, gerekirse elle silinir). Böylece etiketi standart olmayan
    # faturalar da "fatura bulunamadı" ile reddedilmez.
    if not faturalar:
        birlesik = "\n".join(s for s in sayfalar if s).strip()
        if birlesik:
            _bak = _fatura_bakiye_regex(birlesik)
            faturalar.append({
                "fatura_no": None,
                "fatura_tarih": _fatura_tarih_regex(birlesik),
                "onceki_bakiye": _bak["onceki_bakiye"],
                "bakiye_dahil": _bak["bakiye_dahil"],
                "metin": birlesik,
            })
    return faturalar


def _fatura_tarih_regex(metin: str) -> Optional[str]:
    """e-fatura metninden 'Fatura Tarihi: DD-MM-YYYY' (veya DD.MM.YYYY / DD/MM/YYYY)
    → 'YYYY-MM-DD'. Tarih kritik (zam yönü) → LLM'e değil regex'e güvenilir."""
    m = re.search(r"Fatura\s*Tarihi\s*:?\s*(\d{2})[-./](\d{2})[-./](\d{4})", metin or "", re.IGNORECASE)
    if not m:
        return None
    gun, ay, yil = m.group(1), m.group(2), m.group(3)
    return f"{yil}-{ay}-{gun}"


def _para_coz(s: Any) -> Optional[float]:
    """TR/EN karışık para biçimini güvenle çöz: '1.260,00'→1260.0, '116396.62'→116396.62,
    '1,260.00'→1260.0. Hem nokta-binlik+virgül-ondalık hem tersini kaldırır."""
    s = re.sub(r"[^\d.,-]", "", str(s or "").strip())
    if not s:
        return None
    if "," in s and "." in s:
        # son görülen ayraç = ondalık ayracı
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        s = s.replace(",", ".")  # tek virgül → TR ondalık
    try:
        return float(s)
    except ValueError:
        return None


def _fatura_bakiye_regex(metin: str) -> Dict[str, Optional[float]]:
    """e-fatura metninden cari bakiye alanları (yürüyen bakiye zinciri HAM verisi).
    'Önceki Bakiye : X' ve 'Bu Fatura Dahil Bakiye : Y'. Deterministik — LLM'e güvenme."""
    t = metin or ""
    onc = re.search(r"Önceki\s*Bakiye\s*:?\s*([\d.,]+)", t, re.IGNORECASE)
    dah = re.search(r"Bu\s*Fatura\s*Dahil\s*Bakiye\s*:?\s*([\d.,]+)", t, re.IGNORECASE)
    return {
        "onceki_bakiye": _para_coz(onc.group(1)) if onc else None,
        "bakiye_dahil": _para_coz(dah.group(1)) if dah else None,
    }


# OCR eşzamanlılık freni (mimari denetim 2026-07-15): 50 foto aynı anda
# kuyruklanınca 50 thread × db() 15'lik pool'u zehirliyor + 50 paralel LLM
# çağrısı 429 kotayı kendisi tetikliyordu. Aynı anda en çok 3 OCR koşar.
import threading as _thr
_OCR_FRENI = _thr.BoundedSemaphore(3)


def _fatura_vade_regex(metin: str) -> Optional[str]:
    """PDF metnindeki 'Vade Tarihi: DD-MM-YYYY' → ISO (deterministik)."""
    m = re.search(r"Vade\s*Tarihi\s*:?\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{4})",
                  metin or "", re.IGNORECASE)
    if not m:
        return None
    g, a, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    try:
        from datetime import date as _d
        return _d(y, a, g).isoformat()
    except Exception:  # noqa: BLE001
        return None


# ── FAZ A: FATURA → ÖDEME KUYRUĞU MOTORU (2026-07-18, sahip 'A VE B KUR';
# Codex çaprazlı AP-2 sentezi). ALTIN İLKE: borç faturadan BİR KEZ doğar
# (cari), kuyruk yalnız NE ZAMAN/NASIL ödeneceğini yönetir. Bu motor okunan
# faturayı main.vadeli_ekle (TEK YAZICI — birleştirme frenleri + odeme_plani
# üretimi orada) üzerinden kuyruğa bağlar. İdempotency: tedarikci_fatura.
# kuyruk_vadeli_id (lazy kolon) — bir fatura kuyruğa EN FAZLA bir kez girer.
def _fatura_kuyruk_uret(fatura_id: str) -> str:
    from datetime import date as _d, timedelta as _td
    try:
        with db() as (conn, cur):
            cur.execute("ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS "
                        "kuyruk_vadeli_id TEXT")
            cur.execute(
                """SELECT tedarikci_ad, COALESCE(toplam_tutar,0)::float AS tutar,
                          fatura_tarih::text AS ftarih, fatura_no, durum,
                          kaynak_metin, kuyruk_vadeli_id
                   FROM tedarikci_fatura WHERE id=%s""", (fatura_id,))
            r = cur.fetchone()
            if not r:
                return "yok"
            f = dict(r)
            # FRENLER (Codex): kopya/negatif(alacak dekontu)/kimliksiz/arşiv girmez
            if f.get("kuyruk_vadeli_id"):
                return "zaten_bagli"
            # 'okundu' = anında kod okuma yolu (19e4f62) — o da kuyruğa girebilir
            # (2026-07-19 mutabakat dersi: sadece ocr_tamam kabul edilince kod-yolu
            # faturaları retro taramadan sonsuza dek kaçıyordu).
            if f.get("durum") not in ("ocr_tamam", "okundu"):
                return "atlandi_okunmamis"
            if (f.get("tutar") or 0) <= 0:
                return "atlandi_negatif_veya_sifir"
            ted = (f.get("tedarikci_ad") or "").strip()
            if len(ted) < 3:
                return "atlandi_kimliksiz"
            ftarih = (f.get("ftarih") or "")[:10]
            if ftarih and ftarih < EVVEL_SISTEM_BASLANGIC:
                cur.execute("UPDATE tedarikci_fatura SET kuyruk_vadeli_id='(arsiv)' "
                            "WHERE id=%s", (fatura_id,))
                return "atlandi_arsiv"
            # ÖDEME İZİ FRENİ: zaten ödenmişse kuyruğa GİRMEZ (3 kanal,
            # tutar ±max(5,%2), tarih fatura −10g..+90g)
            #
            # ⚠️ 2026-08-08 DÜZELTMESİ (sahip: "ödeme yapılınca düşüyor mu,
            # kapatabiliyor mu?"). Fren eskiden YALNIZ tutar+tarih bakıyordu —
            # kime ödendiğine bakmıyordu. Canlı sonuçları:
            #   · "3 aylık halkbank kredi ödemesi" 34.850 → FEZ 35.148 faturasını
            #   · "halı yıkama" 1.100 → AGİT SEFA'nın ÜÇ faturasını birden
            #   · "talha avans" 1.500 → Napolés 1.515 faturasını
            #   · "etliekmek ve malzemeleri" 500 → DORUK AJANS 498 faturasını
            # kapatmış sayıyordu. Toplam 81.264 ₺ borç görünmez olmuştu.
            # Artık TEDARİKÇİ ADI da şart: iz metni tedarikçiyle eşleşmezse
            # fatura kuyruğa GİRER (borç görünür kalır — güvenli taraf).
            tut = float(f["tutar"])
            cur.execute(
                """SELECT * FROM (
                     SELECT 'vadeli_alimlar' AS kanal, id::text AS iz_id,
                            vade_tarihi AS t, tutar,
                            COALESCE(aciklama,'') || ' ' || COALESCE(tedarikci,'') AS metin
                     FROM vadeli_alimlar WHERE durum='odendi'
                     UNION ALL
                     SELECT 'anlik_giderler', id::text, tarih, tutar,
                            COALESCE(aciklama,'') || ' ' || COALESCE(tedarikci,'')
                     FROM anlik_giderler WHERE durum='aktif' AND kaynak_id IS NULL
                     UNION ALL
                     SELECT 'kart_hareketleri', id::text, tarih, tutar,
                            COALESCE(aciklama,'')
                     FROM kart_hareketleri
                     WHERE islem_turu='HARCAMA' AND durum='aktif'
                       AND kaynak_id IS NULL
                       AND COALESCE(harcama_tipi,'belirsiz') <> 'sahsi') x
                   WHERE ABS(x.tutar - %s) <= GREATEST(5, %s * 0.02)
                     AND x.t BETWEEN %s::date - 10 AND %s::date + 90
                   LIMIT 20""",
                (tut, tut, ftarih or str(_d.today()), ftarih or str(_d.today())))
            _izler = [dict(x) for x in (cur.fetchall() or [])]
            _eslesen = next((i for i in _izler
                             if _odeme_eslesir(ted, i.get("metin") or "")), None)
            if _eslesen:
                # 🔗 BAĞI KAYDET (2026-08-08): eskiden yalnız '(odenmis)' damgası
                # basılıyordu, HANGİ ödemeyle eşleştiği yazılmıyordu. Sonuç: fatura
                # ile ödeme arasındaki zincir kopuyor, vergi tarafında "belgesiz"
                # görünüyordu (DYK'nın 147.176 ₺ bardak alımı böyleydi).
                cur.execute(
                    "ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS odeme_iz_tablo TEXT")
                cur.execute(
                    "ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS odeme_iz_id TEXT")
                cur.execute(
                    """UPDATE tedarikci_fatura
                         SET kuyruk_vadeli_id='(odenmis)',
                             odeme_iz_tablo=%s, odeme_iz_id=%s
                       WHERE id=%s""",
                    (_eslesen.get("kanal"), str(_eslesen.get("iz_id") or ""), fatura_id))
                return "zaten_odenmis"
            # VADE ÖNCELİĞİ: PDF'teki Vade Tarihi > fatura tarihi+7g > bugün+7g
            vade = _fatura_vade_regex(f.get("kaynak_metin") or "")
            if not vade:
                try:
                    vade = (_d.fromisoformat(ftarih) + _td(days=7)).isoformat()
                except Exception:  # noqa: BLE001
                    vade = (_d.today() + _td(days=7)).isoformat()
        # TEK YAZICI: main.vadeli_ekle (birleştirme frenleri + odeme_plani orada).
        # Aynı tedarikçide TEK açık söz varsa otomatik ÜSTÜNE BİRLEŞİR (Codex:
        # commitment faturaya linklenince birleşir); birden çoksa/benzer kayıt
        # uyarısı dönerse İNSAN konusu — motor zorlamaz, kalıcı işaretler.
        from main import vadeli_ekle, VadeliAlim
        g = VadeliAlim(
            aciklama=f"Fatura {f.get('fatura_no') or fatura_id[:8]} ({ted})",
            tutar=round(tut, 2), vade_tarihi=_d.fromisoformat(vade), tedarikci=ted)
        sonuc = vadeli_ekle(g)
        with db() as (conn, cur):
            if isinstance(sonuc, dict) and sonuc.get("id"):
                cur.execute("UPDATE tedarikci_fatura SET kuyruk_vadeli_id=%s "
                            "WHERE id=%s", (str(sonuc["id"]), fatura_id))
                logger.info("fatura kuyruğa bağlandı: %s → vadeli %s (%.2f, vade %s)",
                            fatura_id, sonuc["id"], tut, vade)
                return "uretildi"
            cur.execute("UPDATE tedarikci_fatura SET kuyruk_vadeli_id='(insan)' "
                        "WHERE id=%s", (fatura_id,))
            return "atlandi_insan_karari"
    except Exception as e:  # noqa: BLE001 — kuyruk üretimi çökse fatura akışı yaşar
        logger.warning("fatura kuyruk uretimi hatasi %s: %s", fatura_id, str(e)[:150])
        return "hata"


@router.post("/kuyruk-tara")
def fatura_kuyruk_tara(gun: int = 30):
    """Retro + gece taraması: okunmuş ama kuyruğa bağlanmamış faturaları
    ödeme kuyruğuna bağlar (idempotent — kuyruk_vadeli_id boş olanlar)."""
    g = max(1, min(int(gun or 30), 90))
    with db() as (_, cur):
        cur.execute("ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS "
                    "kuyruk_vadeli_id TEXT")
        # DAMGA HİJYENİ (2026-07-19 mutabakat dersi): damga silinmiş/iptal bir
        # vadeli kaydına işaret ediyorsa fatura sonsuza dek "zaten bağlı" kalıyordu.
        # Ölü damgayı sıfırla ki fatura yeniden kuyruğa girebilsin. Sentineller
        # ('(arsiv)','(odenmis)','(insan)') ve YAŞAYAN kayıtlar (bekliyor/odendi)
        # DOKUNULMAZ — ödenmiş söze bağlı fatura tekrar kuyruğa GİRMEZ.
        cur.execute(
            """UPDATE tedarikci_fatura tf SET kuyruk_vadeli_id=NULL
               WHERE tf.kuyruk_vadeli_id IS NOT NULL
                 AND tf.kuyruk_vadeli_id NOT LIKE '(%%'
                 AND NOT EXISTS (
                       SELECT 1 FROM vadeli_alimlar va
                       WHERE va.id = tf.kuyruk_vadeli_id
                         AND COALESCE(va.durum,'') <> 'iptal')""")
        temizlenen = cur.rowcount or 0
        cur.execute(
            """SELECT id FROM tedarikci_fatura
               WHERE durum IN ('ocr_tamam','okundu') AND kuyruk_vadeli_id IS NULL
                 AND COALESCE(fatura_tarih, olusturma::date)
                     >= CURRENT_DATE - %s
               ORDER BY olusturma DESC LIMIT 100""", (g,))
        idler = [r["id"] for r in cur.fetchall() or []]
    ozet: Dict[str, int] = {}
    for fid in idler:
        s = _fatura_kuyruk_uret(fid)
        ozet[s] = ozet.get(s, 0) + 1
    return {"taranan": len(idler), "ozet": ozet, "damga_temizlenen": temizlenen}


def gece_fatura_kuyruk_tara() -> dict:
    """Gece zinciri halkası — hata-yutar."""
    try:
        return fatura_kuyruk_tara(gun=30)
    except Exception as e:  # noqa: BLE001
        logger.warning("gece fatura kuyruk tarama hatasi (yutuldu): %s", str(e)[:150])
        return {"ok": False}


@router.post("/ocr-takilanlari-dene")
def ocr_takilanlari_dene(limit: int = 20) -> dict:
    """🔄 OCR'ı geçici hatayla takılmış faturaları YENİDEN dener.

    Sahip (2026-08-08): "bunun için ileride de yaşamamak için önlemlerini al."
    Kota (429) / ağ hatası faturanın okunamaz olduğunu göstermez. Yükleme anında
    geçici hata alan fatura artık 'ocr_bekliyor' durumunda kuyrukta kalır; bu iş
    onu gece yeniden dener. 5 denemeden sonra kalıcı 'ocr_hata' olur ve insana
    kalır — sonsuz döngü yok.

    Foto/PDF'i olmayan kayda dokunmaz (denenecek bir şey yok).
    """
    denenen, atlanan = [], 0
    try:
        with db() as (conn, cur):
            cur.execute("ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS "
                        "ocr_deneme INT DEFAULT 0")
            conn.commit()
            cur.execute(
                """SELECT id, COALESCE(ocr_deneme,0) AS n
                   FROM tedarikci_fatura
                   WHERE durum IN ('ocr_bekliyor','ocr_hata')
                     AND COALESCE(ocr_deneme,0) < 5
                     AND (foto IS NOT NULL OR COALESCE(kaynak_metin,'') <> '')
                     AND COALESCE(durum,'') <> 'kopya'
                   ORDER BY olusturma DESC LIMIT %s""", (limit,))
            hedef = [dict(r) for r in (cur.fetchall() or [])]
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "hata": str(e)[:150]}
    for f in hedef:
        try:
            _ocr_calistir_icerik(f["id"])      # kendi hata yönetimi + sayaç içinde
            denenen.append(f["id"])
        except Exception:  # noqa: BLE001
            atlanan += 1
    # Sonuç: kaç tanesi gerçekten okundu?
    okunan = 0
    try:
        with db() as (_c, cur):
            if denenen:
                cur.execute("""SELECT COUNT(*)::int AS n FROM tedarikci_fatura
                               WHERE id = ANY(%s) AND durum IN ('ocr_tamam','okundu')""",
                            (denenen,))
                okunan = int((cur.fetchone() or {}).get("n") or 0)
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "denenen": len(denenen), "okunan": okunan,
            "atlanan": atlanan,
            "not": "Geçici hatalı faturalar yeniden denendi. 5 denemeyi aşan "
                   "kayıtlar kalıcı 'ocr_hata' olarak insana bırakılır."}


def gece_ocr_takilanlari() -> dict:
    """Gece zinciri halkası — hata-yutar."""
    try:
        return ocr_takilanlari_dene(limit=20)
    except Exception as e:  # noqa: BLE001
        logger.warning("gece ocr retry hatasi (yutuldu): %s", str(e)[:150])
        return {"ok": False}


# ── 💊 AP SELF-HEAL — hayalet söz kapama (2026-07-19, APS/Redbull dersi;
# emsal: main.borc_plan_mutabakat 5c59c77). KASA İZİ = TEK GERÇEK: tedarikçinin
# carisi kapanmış (fatura−ödeme≈0) ama kuyrukta 'bekliyor' söz duruyorsa VE söz
# tutarına ±%2 uyan gerçek bir ödeme izi varsa, söz YENİ KASA HAREKETİ YAZILMADAN
# 'odendi' işaretlenir (iz referansı notta). Tipik vaka: ödeme önce (17.06 vadeli
# alım), fatura 23 gün sonra okundu → fren penceresi (−10g) izi göremedi, hayalet
# söz doğdu, vadesi geçti, kokpit 'gecikmiş çıkış' diye şişirdi.
@router.post("/ap-selfheal")
def ap_selfheal() -> dict:
    kapatilan, incelenen = [], 0
    try:
        oz = cari_ozet()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "hata": f"cari_ozet: {str(e)[:120]}"}
    cari_map = {}
    for t in oz.get("tedarikciler", []):
        ad = (t.get("tedarikci") or "").strip().upper()
        if ad:
            cari_map[ad] = float(t.get("hesaplanan_acik") or 0)
    with db() as (conn, cur):
        cur.execute("""SELECT id, tedarikci, aciklama, tutar::float AS tutar,
                              vade_tarihi FROM vadeli_alimlar
                       WHERE durum='bekliyor'""")
        sozler = [dict(r) for r in cur.fetchall() or []]
        for s in sozler:
            # AD EŞLEŞMESİ MUHAFAZAKÂR: birebir (büyük/küçük duyarsız) eşleşme
            # yoksa DOKUNMA — 'fez'/'ATALAY KAHVE' gibi elle kısaltılmış adlar
            # insan konusu kalır, motor zorlamaz.
            ad = (s.get("tedarikci") or "").strip().upper()
            if not ad or ad not in cari_map:
                continue
            incelenen += 1
            tut = float(s["tutar"] or 0)
            esik = max(5.0, tut * 0.02)
            if tut <= 0 or cari_map[ad] > esik:
                continue  # cari hâlâ açık — söz gerçek borcu takip ediyor
            # ÖDEME İZİ: 3 kanal (fren sorgusuyla aynı), söz tutarına ±%2,
            # vade −180g..+35g. Sözün kendisi 'bekliyor' olduğundan vadeli
            # kanalının durum='odendi' filtresi kendini dışlar.
            cur.execute(
                """SELECT x.t, x.tutar FROM (
                     SELECT vade_tarihi AS t, tutar FROM vadeli_alimlar
                     WHERE durum='odendi'
                     UNION ALL
                     SELECT tarih, tutar FROM anlik_giderler
                     WHERE durum='aktif' AND kaynak_id IS NULL
                     UNION ALL
                     SELECT tarih, tutar FROM kart_hareketleri
                     WHERE islem_turu='HARCAMA' AND durum='aktif'
                       AND kaynak_id IS NULL
                       AND COALESCE(harcama_tipi,'belirsiz') <> 'sahsi') x
                   WHERE ABS(x.tutar - %s) <= GREATEST(5, %s * 0.02)
                     AND x.t BETWEEN %s::date - 180 AND %s::date + 35
                   ORDER BY x.t DESC LIMIT 1""",
                (tut, tut, str(s["vade_tarihi"]), str(s["vade_tarihi"])))
            iz = cur.fetchone()
            if not iz:
                continue
            # 🛑 DÖNEM FRENİ (2026-07-19 APS/Redbull dersi — sahip: 'bundan önce
            # de bir fatura vardı, en son gelen fatura borç'): iz tarihi, söze
            # bağlı FATURANIN tarihinden ESKİYSE kapatma — o ödeme muhtemelen
            # sisteme yüklenmemiş ÖNCEKİ faturanın parasıdır (sürekli tedarikçi
            # döngüsü). Belirsizlik = insan konusu, motor zorlamaz.
            cur.execute(
                """SELECT MIN(COALESCE(fatura_tarih, olusturma::date)) AS ftarih
                   FROM tedarikci_fatura WHERE kuyruk_vadeli_id = %s""",
                (str(s["id"]),))
            fk = cur.fetchone()
            if fk and fk.get("ftarih") and str(iz["t"]) < str(fk["ftarih"]):
                logger.info("ap self-heal atlandi (donem freni): soz %s iz %s < fatura %s",
                            s["id"], iz["t"], fk["ftarih"])
                continue
            iz_not = f" [self-heal {date.today().isoformat()}: kasa izi {iz['t']} {float(iz['tutar']):.2f}, cari kapalı]"
            cur.execute(
                """UPDATE vadeli_alimlar
                   SET durum='odendi',
                       aciklama = COALESCE(aciklama,'') || %s
                   WHERE id=%s AND durum='bekliyor'""", (iz_not, s["id"]))
            cur.execute(
                """UPDATE odeme_plani
                   SET durum='odendi',
                       odenen_tutar = COALESCE(odenen_tutar, odenecek_tutar),
                       aciklama = COALESCE(aciklama,'') || %s
                   WHERE kaynak_tablo='vadeli_alimlar' AND kaynak_id=%s
                     AND durum IN ('bekliyor','onay_bekliyor')""", (iz_not, str(s["id"])))
            kapatilan.append({"id": s["id"], "tedarikci": s.get("tedarikci"),
                              "tutar": tut, "iz_tarih": str(iz["t"]),
                              "iz_tutar": float(iz["tutar"])})
            logger.info("ap self-heal: soz kapatildi %s (%s %.2f, iz %s)",
                        s["id"], s.get("tedarikci"), tut, iz["t"])
    # Şeffaflık: her kapama duyu olayı (hata-yutar; source_ref=soz id idempotent)
    for k in kapatilan:
        try:
            from duyu_omurga import duyu_olay_yaz
            duyu_olay_yaz(
                "ap_selfheal", "finans.ap.selfheal_soz_kapandi", str(k["id"]),
                entity_scope="tedarikci", entity_id=str(k["tedarikci"] or "")[:60],
                signal_name="Hayalet söz kasa iziyle kapandı",
                payload=k)
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True, "incelenen": incelenen,
            "kapatilan_adet": len(kapatilan), "kapatilan": kapatilan}


@router.post("/soz-yeniden-ac/{vadeli_id}")
def soz_yeniden_ac(vadeli_id: str, neden: str = ""):
    """🔓 BAKIM: yanlış kapanmış ödeme sözünü geri açar (sahip kararıyla).
    İlk vaka 2026-07-19 APS/Redbull: self-heal, sisteme yüklenmemiş Haziran
    faturasının ödemesini yeni R37 faturasının sözüne sayıp kapatmıştı —
    sahip: 'en son gelen fatura borç'. Kasa hareketi YAZMAZ/SİLMEZ."""
    n = f" [yeniden açıldı {date.today().isoformat()}: {(neden or 'sahip kararı')[:80]}]"
    with db() as (conn, cur):
        cur.execute(
            """UPDATE vadeli_alimlar
               SET durum='bekliyor', aciklama = COALESCE(aciklama,'') || %s
               WHERE id=%s AND durum='odendi'""", (n, vadeli_id))
        acilan = cur.rowcount or 0
        cur.execute(
            """UPDATE odeme_plani
               SET durum='bekliyor', odenen_tutar=NULL,
                   aciklama = COALESCE(aciklama,'') || %s
               WHERE kaynak_tablo='vadeli_alimlar' AND kaynak_id=%s
                 AND durum='odendi'""", (n, str(vadeli_id)))
        plan_acilan = cur.rowcount or 0
    if not acilan:
        raise HTTPException(404, "Söz bulunamadı ya da zaten bekliyor")
    logger.info("soz yeniden acildi: %s (%s)", vadeli_id, neden[:60])
    return {"ok": True, "acilan": acilan, "plan_acilan": plan_acilan}


def gece_ap_selfheal() -> dict:
    """Gece zinciri halkası — hata-yutar. ap_mutabakat'tan ÖNCE koşmalı ki
    mutabakat raporu temiz tabloyu görsün."""
    try:
        return ap_selfheal()
    except Exception as e:  # noqa: BLE001
        logger.warning("gece ap selfheal hatasi (yutuldu): %s", str(e)[:150])
        return {"ok": False}


def _pdf_regex_yedek(metin: str) -> Optional[Dict[str, Any]]:
    """LLM'SİZ DETERMİNİSTİK e-fatura okuma (2026-07-18, sahip: 'yapay zekâ
    desteği olmadan PDF okuyamıyor mu?'). Standart GİB e-fatura düz metninden
    KODLA çıkarır: Ödenecek Tutar (+ yedek kalıplar), satıcı ünvanı (SAYIN
    bloğundan ÖNCEKİ ilk anlamlı satır), VKN. Kalemler LLM işidir — kota
    dönünce gece zenginleştirilir (ocr-yeniden-dene regex_yedek kayıtlarını
    da kapsar). Tutar bulunamazsa None → normal hata akışı sürer."""
    t = metin or ""

    def _tr_sayi(s: str) -> Optional[float]:
        try:
            return round(float(s.strip().replace(".", "").replace(",", ".")), 2)
        except Exception:  # noqa: BLE001
            return None

    tutar = None
    # 'Ödenecek Tutar' — bozuk kodlamada 'Ö' kaybolabilir, kuyruktan yakalanır
    for kalip in (r"denecek\s*Tutar[^0-9]{0,10}([\d.,]+)\s*.?TL",
                  r"Vergiler\s*Dahil\s*Toplam\s*Tutar[^0-9]{0,10}([\d.,]+)\s*.?TL",
                  r"Toplam\s*Tutar[^0-9]{0,10}([\d.,]+)\s*.?TL"):
        m = re.search(kalip, t, re.IGNORECASE)
        if m:
            tutar = _tr_sayi(m.group(1))
            if tutar:
                break
    if not tutar or tutar <= 0:
        return None
    ted = None
    bas = t.split("SAYIN")[0] if "SAYIN" in t else t[:400]
    for satir in bas.splitlines():
        s = satir.strip()
        # Ünvan satırı: etiket değil (':' içermez), en az iki kelime, anahtar
        # kelime kirliliği yok (ESH dersi: 'Düzenleme Saati:' yakalanıyordu)
        if len(s) >= 8 and ":" not in s and len(s.split()) >= 2 and \
           re.search(r"[A-Za-zÇĞİÖŞÜçğıöşü]{4}", s) and \
           not re.search(r"fatura|tarih|senaryo|zelle|tipi|ettn|sayfa|d.zenleme"
                         r"|mersis|sicil|posta|web|sitesi",
                         s, re.IGNORECASE):
            ted = s[:80]
            break
    m_vkn = re.search(r"VKN\s*:?\s*(\d{10})", t)
    return {"toplam_tutar": tutar, "tedarikci": ted,
            "tedarikci_vkn": (m_vkn.group(1) if m_vkn else None),
            "kalemler": [], "yontem": "regex_yedek"}


def _tr_tutar(s: str) -> Optional[float]:
    """'1.360,8000 TL' → 1360.8 (TR sayı biçimi, TL/boşluk toleranslı)."""
    m = re.search(r"([\d.]+,\d+|[\d.]+)", str(s or ""))
    if not m:
        return None
    try:
        return round(float(m.group(1).replace(".", "").replace(",", ".")), 4)
    except Exception:  # noqa: BLE001
        return None


def _pdf_kod_kalemler(pdf_bytes: bytes, fatura_no: Optional[str] = None) -> List[Dict[str, Any]]:
    """KOD-BİRİNCİL kalem çıkarımı (2026-07-18, sahip: 'PDF okumasını kendi
    yapsın, yapamadığını yapay zekâdan destek alsın'). pdfplumber TABLO yapısını
    ayıklar: başlığında Sıra+Miktar geçen tablo = kalem tablosu; her satırda
    sıra(no int) / kod / ad / '3 Adet' miktar / birim fiyat / satır toplam.
    GÜVEN KAPISI: satırların ≥%80'inde adet×birim_fiyat ≈ satır_toplam (±%2)
    tutmalı — tutmuyorsa [] döner ve LLM devralır (yanlış kalem yazılmaz).
    Çok faturalı PDF'te fatura_no verilirse yalnız o numaranın sayfaları okunur."""
    try:
        import pdfplumber  # type: ignore
    except Exception:  # noqa: BLE001
        return []
    kalemler: List[Dict[str, Any]] = []
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for sayfa in pdf.pages:
                if fatura_no:
                    _pt = (sayfa.extract_text() or "")
                    if fatura_no not in _pt.replace(" ", ""):
                        continue
                for tablo in sayfa.extract_tables() or []:
                    if not tablo or len(tablo) < 2:
                        continue
                    baslik = [str(h or "").lower().replace("\n", " ") for h in tablo[0]]
                    b_metin = " ".join(baslik)
                    if "miktar" not in b_metin or not any(
                            ("s" in h and "ra" in h and "no" in h) or h.startswith("sıra")
                            for h in baslik):
                        continue

                    def _kolon(anahtar, yasak=None):
                        for i, h in enumerate(baslik):
                            if anahtar in h and not (yasak and yasak in h):
                                return i
                        return None
                    i_kod = _kolon("kod")
                    i_ad = next((i for i, h in enumerate(baslik)
                                 if ("mal" in h or "hizmet" in h) and "kod" not in h
                                 and "tut" not in h), None)
                    i_mik = _kolon("miktar")
                    i_bf = _kolon("birim")
                    for row in tablo[1:]:
                        hucre = [str(c or "").strip() for c in row]
                        if not hucre or not re.fullmatch(r"\d{1,3}", hucre[0] or ""):
                            continue  # toplam/altbilgi satırı
                        mik_s = hucre[i_mik] if (i_mik is not None and i_mik < len(hucre)) else ""
                        m_mik = re.search(r"([\d.,]+)\s*([A-Za-zÇĞİÖŞÜçğıöşü]*)", mik_s)
                        adet = _tr_tutar(m_mik.group(1)) if m_mik else None
                        birim = (m_mik.group(2) or "Adet") if m_mik else "Adet"
                        bf = _tr_tutar(hucre[i_bf]) if (i_bf is not None and i_bf < len(hucre)) else None
                        # satır toplamı = sağdan ilk TL'li dolu hücre (kolon kayması toleransı)
                        st = None
                        for c in reversed(hucre):
                            if "TL" in c and _tr_tutar(c):
                                st = _tr_tutar(c)
                                break
                        ad = hucre[i_ad].replace("\n", " ")[:120] if (i_ad is not None and i_ad < len(hucre)) else ""
                        kod = hucre[i_kod][:30] if (i_kod is not None and i_kod < len(hucre) and hucre[i_kod]) else None
                        if adet and st:
                            kalemler.append({"ad": ad or None, "urun_kodu": kod,
                                             "adet": adet, "birim": birim,
                                             "birim_fiyat": bf, "satir_toplam": st})
    except Exception as e:  # noqa: BLE001
        logger.warning("pdf kod kalem parse hatasi: %s", str(e)[:120])
        return []
    if not kalemler:
        return []
    # GÜVEN KAPISI — satır içi tutarlılık
    uygun = sum(1 for k in kalemler
                if k.get("birim_fiyat") and
                abs(k["adet"] * k["birim_fiyat"] - k["satir_toplam"])
                <= max(0.5, k["satir_toplam"] * 0.02))
    if uygun < max(1, int(len(kalemler) * 0.8)):
        logger.info("pdf kod kalemler guven kapisini gecemedi (%d/%d) — LLM devralacak",
                    uygun, len(kalemler))
        return []
    return kalemler


def _ocr_calistir(fatura_id: str) -> None:
    """Arka plan iş parçacığı — kendi DB bağlantısı. Hiçbir hata fırlatmaz.
    _OCR_FRENI: aynı anda en çok 3 OCR (pool + LLM kota koruması)."""
    with _OCR_FRENI:
        _ocr_calistir_icerik(fatura_id)


def _ocr_calistir_icerik(fatura_id: str) -> None:
    kaynak_metin = ""
    try:
        with db() as (conn, cur):
            _ensure_tablolar(cur)
            cur.execute(
                "SELECT foto, foto_mime, kaynak_metin, fatura_no FROM tedarikci_fatura WHERE id=%s",
                (fatura_id,),
            )
            r = cur.fetchone()
            if not r:
                return
            d = dict(r)
            foto = bytes(d.get("foto") or b"")
            mime = d.get("foto_mime") or "image/jpeg"
            kaynak_metin = (d.get("kaynak_metin") or "").strip()
            _fno = (d.get("fatura_no") or "").strip() or None

        # PDF yolu — KOD BİRİNCİL (sahip 2026-07-18: 'PDF okumasını kendi
        # yapsın, yapamadığını yapay zekâdan destek alsın'): kimlik+tutar regex,
        # kalemler tablo parser'ı. İkisi de doluysa LLM HİÇ ÇAĞRILMAZ
        # (determinizm + kota tasarrufu). Kod yetmezse LLM devralır; LLM de
        # patlarsa kod ne bulduysa onunla işlenir (aşağıdaki yedek dal).
        if kaynak_metin:
            j_kod = _pdf_regex_yedek(kaynak_metin)
            kalemler_kod = _pdf_kod_kalemler(foto, _fno) if foto else []
            if j_kod and kalemler_kod:
                j = {**j_kod, "kalemler": kalemler_kod, "yontem": "kod_tam"}
                logger.info("fatura KOD ile tam okundu (LLM'siz): %s (%d kalem)",
                            fatura_id, len(kalemler_kod))
            else:
                j = _text_ocr(kaynak_metin)
        elif foto:
            j = _vision_ocr(foto, mime)
        else:
            raise RuntimeError("kaynak yok (ne foto ne metin)")

        with db() as (conn, cur):
            _ensure_tablolar(cur)
            kalem_say = _fatura_json_db_yaz(cur, fatura_id, j)
            conn.commit()
        logger.info("fatura OCR tamam: %s (%d kalem)", fatura_id, kalem_say)
        # FAZ A: okunan fatura ödeme kuyruğuna bağlanır (hata-yutar, idempotent)
        _fatura_kuyruk_uret(fatura_id)
    except Exception as e:
        logger.warning("fatura OCR hata %s: %s", fatura_id, e)
        # 🔧 LLM'SİZ YEDEK: PDF metni varsa tutar/tedarikçi KODLA çıkarılır —
        # kota/anahtar yokken bile fatura işlenir (kalemler gece tamamlanır)
        try:
            if kaynak_metin:
                y = _pdf_regex_yedek(kaynak_metin)
                if y:
                    with db() as (conn, cur):
                        _ensure_tablolar(cur)
                        _fatura_json_db_yaz(cur, fatura_id, y)
                        cur.execute(
                            "UPDATE tedarikci_fatura SET ocr_hata=%s WHERE id=%s",
                            (f"LLM'siz yedek okudu; kalemler gece tamamlanacak "
                             f"({str(e)[:100]})", fatura_id))
                        conn.commit()
                    logger.info("fatura regex-yedek okundu: %s (%.2f TL)",
                                fatura_id, y["toplam_tutar"])
                    return
        except Exception as e2:  # noqa: BLE001
            logger.warning("regex yedek de olmadi %s: %s", fatura_id, e2)
        try:
            with db() as (conn, cur):
                # ⏳ GEÇİCİ HATA RAFA KALDIRILMAZ (2026-08-08, sahip: "ileride de
                # yaşamamak için önlem al"). Kota/ağ hatası faturanın okunamaz
                # olduğunu göstermez — sistem sonra tekrar denemelidir. Canlıda
                # bir fatura "429 quota" ile 'ocr_hata' damgalanıp rafa kalkmıştı.
                # Deneme sayacı sonsuz döngüyü keser: 5 denemeden sonra kalıcı.
                cur.execute("ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS "
                            "ocr_deneme INT DEFAULT 0")
                cur.execute("SELECT COALESCE(ocr_deneme,0) AS n FROM tedarikci_fatura "
                            "WHERE id=%s", (fatura_id,))
                _n = int((cur.fetchone() or {}).get("n") or 0) + 1
                _gecici = hata_gecici_mi(str(e)) and _n < 5
                cur.execute(
                    """UPDATE tedarikci_fatura
                         SET durum=%s, ocr_hata=%s, ocr_deneme=%s
                       WHERE id=%s""",
                    ("ocr_bekliyor" if _gecici else "ocr_hata",
                     (f"[geçici, deneme {_n}/5] " if _gecici else "") + str(e)[:480],
                     _n, fatura_id),
                )
                conn.commit()
                if _gecici:
                    logger.info("fatura %s geçici hata (%d/5) — kuyrukta kalıyor, "
                                "gece yeniden denenecek", fatura_id, _n)
        except Exception:
            pass


def _sayi(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        return None


def _fatura_anahtar_ocr(urun_kodu: Optional[str], ad: Optional[str]) -> str:
    """operasyon_merkez_api._fatura_anahtar ile AYNI mantık (inline — izolasyon).
    Ürün kodu varsa kod:<kod>, yoksa normalize açıklama. Mevcut alias hafızasına
    (fatura_kalem_eslestirme) köprü için anahtar tutarlı olmalı."""
    kod = (urun_kodu or "").strip()
    if kod:
        return f"kod:{kod.lower()}"
    a = re.sub(r"\s+", " ", (ad or "")).strip().lower()
    a = re.sub(r"[^a-zçğıöşü0-9 ]", "", a)
    return a[:120]


def _alias_eslesme(cur, anahtar: str) -> Optional[Dict[str, Any]]:
    """Mevcut öğrenen eşleştirme hafızasından (fatura_kalem_eslestirme) öneri.
    Tablo yoksa/hata → None (best-effort, OCR'ı bozmaz)."""
    if not anahtar:
        return None
    try:
        cur.execute("SAVEPOINT sp_alias")
        cur.execute(
            "SELECT kalem_kodu, kalem_adi FROM fatura_kalem_eslestirme WHERE anahtar=%s",
            (anahtar,),
        )
        r = cur.fetchone()
        cur.execute("RELEASE SAVEPOINT sp_alias")
        return dict(r) if r else None
    except Exception:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_alias")
            cur.execute("RELEASE SAVEPOINT sp_alias")
        except Exception:
            pass
        return None


def _son_alis_fiyat(cur, kalem_kodu: str, ref_tarih: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Fiyat geçmişinden (urun_alis_fiyat) bilinen birim maliyet — zam karşılaştırması.
    ref_tarih verilirse SADECE o tarihten ÖNCEKİ fiyatları dikkate alır (tarih
    eşleştirmesi): eski faturayı yeni faturadan sonra onaylasan bile 'önceki fiyat'
    kronolojik doğru çıkar. Best-effort."""
    if not kalem_kodu:
        return None
    try:
        cur.execute("SAVEPOINT sp_fiyat")
        if ref_tarih:
            cur.execute(
                """SELECT birim_maliyet_tl, gecerli_baslangic::text AS tarih
                   FROM urun_alis_fiyat
                   WHERE kalem_kodu=%s AND gecerli_baslangic < %s::date
                   ORDER BY gecerli_baslangic DESC LIMIT 1""",
                (kalem_kodu, ref_tarih),
            )
        else:
            cur.execute(
                """SELECT birim_maliyet_tl, gecerli_baslangic::text AS tarih
                   FROM urun_alis_fiyat WHERE kalem_kodu=%s
                   ORDER BY gecerli_baslangic DESC LIMIT 1""",
                (kalem_kodu,),
            )
        r = cur.fetchone()
        cur.execute("RELEASE SAVEPOINT sp_fiyat")
        return dict(r) if r else None
    except Exception:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_fiyat")
            cur.execute("RELEASE SAVEPOINT sp_fiyat")
        except Exception:
            pass
        return None


# ── Endpoint'ler ─────────────────────────────────────────────────────────────

@router.post("/yukle")
async def fatura_yukle(
    foto: UploadFile = File(...),
    sube_id: str = Form(...),
    siparis_talep_id: Optional[str] = Form(None),
    personel_id: Optional[str] = Form(None),
):
    """Fatura fotoğrafı yükle. ANINDA döner (durum=ocr_bekliyor); OCR arka planda.
    Şube bu çağrıyı beklemez — kabul akışı kesintisiz devam eder."""
    if not fatura_modul_aktif():
        raise HTTPException(503, "Fatura modülü kapalı (FATURA_MODUL=0).")
    raw = await foto.read()
    if not raw:
        raise HTTPException(400, "Boş dosya")
    mime = foto.content_type or "image/jpeg"
    fid = str(uuid.uuid4())
    uyari = None
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        # 🛑 MÜKERRER FRENİ katman-1: birebir aynı dosya daha önce yüklendiyse KAYDETME
        dh, es = dosya_hash_kontrol(cur, raw)
        if es:
            raise HTTPException(409,
                f"Bu belge zaten yüklü — {es.get('tedarikci_ad') or 'tedarikçi'} "
                f"({(es.get('tarih') or es.get('yuklenme') or '')[:10]}). "
                f"Aynı kağıdı ikinci kez fotoğraflamana gerek yok.")
        # ⚠️ katman-3: aynı teslimata İKİNCİ belge (engel değil — kısmi teslimatta 2 fatura
        # meşru olabilir; uyar + duyu izi bırak, hüküm insanın)
        if siparis_talep_id:
            cur.execute(
                """SELECT COUNT(*)::int AS n FROM tedarikci_fatura
                   WHERE siparis_talep_id=%s AND COALESCE(durum,'') <> 'kopya'""",
                (siparis_talep_id,))
            n_var = int((cur.fetchone() or {"n": 0})["n"])
            if n_var > 0:
                uyari = f"Bu teslimata daha önce {n_var} belge yüklendi — aynı kağıt olmasın?"
                try:
                    from duyu_omurga import duyu_olay_yaz
                    duyu_olay_yaz(
                        "belge_kimlik", "belge.teslimat.ikinci_belge",
                        f"{siparis_talep_id}_{n_var + 1}",
                        entity_scope="teslimat", entity_id=str(siparis_talep_id),
                        signal_name="Aynı teslimata birden çok belge",
                        payload={"onceki_adet": n_var})
                except Exception:  # noqa: BLE001
                    pass
        cur.execute(
            """
            INSERT INTO tedarikci_fatura
                (id, sube_id, siparis_talep_id, foto, foto_mime, durum, yukleyen_personel_id, dosya_hash)
            VALUES (%s, %s, %s, %s, %s, 'ocr_bekliyor', %s, %s)
            """,
            (fid, sube_id.strip(), (siparis_talep_id or None), raw, mime, (personel_id or None), dh),
        )
        conn.commit()
    # Asenkron OCR — şubeyi bekletmeden
    threading.Thread(target=_ocr_calistir, args=(fid,), daemon=True).start()
    return {"fatura_id": fid, "durum": "ocr_bekliyor", "uyari": uyari}


@router.post("/yukle-pdf")
async def fatura_yukle_pdf(
    pdf: UploadFile = File(...),
    sube_id: Optional[str] = Form(None),
    personel_id: Optional[str] = Form(None),
):
    """Maliyet ekranından TOPLU e-fatura PDF'i yükle. Çok-sayfalı PDF AYRI faturalara
    bölünür; her fatura metni arka planda LLM ile JSON'a çevrilir (vision YOK → 'Expecting
    value' hatası olmaz). Aynı Fatura No daha önce yüklendiyse ATLANIR (idempotent).
    ANINDA döner; ayrıştırma arka planda. Tarih sıralaması fatura tarihinden otomatik."""
    if not fatura_modul_aktif():
        raise HTTPException(503, "Fatura modülü kapalı (FATURA_MODUL=0).")
    raw = await pdf.read()
    if not raw:
        raise HTTPException(400, "Boş dosya")
    ad = (pdf.filename or "").lower()
    if not (ad.endswith(".pdf") or (pdf.content_type or "").lower() == "application/pdf"):
        raise HTTPException(400, "Sadece PDF yüklenebilir (foto için şube paneli).")
    try:
        faturalar = _pdf_faturalara_bol(raw)
    except Exception as e:
        raise HTTPException(400, f"PDF okunamadı: {str(e)[:160]}")
    if not faturalar:
        raise HTTPException(
            422,
            "PDF'te metin bulunamadı — bu bir taranmış/fotoğraf PDF'i olabilir "
            "(içinde seçilebilir yazı yok). Tedarikçinin gönderdiği gerçek e-fatura "
            "PDF'ini yükleyin; telefonla çekilmiş fatura için şube panelinden 'foto' "
            "olarak gönderin (Maliyet PDF yolu vision/OCR kullanmaz).",
        )

    yeni_idler: List[str] = []
    kod_tam_idler: List[str] = []
    aninda_okunan = 0
    atlanan = 0
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        # 🛑 MÜKERRER FRENİ katman-1: birebir aynı PDF dosyası daha önce yüklendiyse dur
        dh, es = dosya_hash_kontrol(cur, raw)
        if es:
            raise HTTPException(409,
                f"Bu PDF zaten yüklü — {es.get('tedarikci_ad') or 'kayıt'} "
                f"({(es.get('tarih') or es.get('yuklenme') or '')[:10]}).")
        for f in faturalar:
            fno = (f.get("fatura_no") or "").strip() or None
            metin = (f.get("metin") or "").strip()
            if not metin:
                continue
            # Idempotent: aynı fatura_no + AYNI TARİH varsa atla (denetim P2-8:
            # yalnız-no kontrolü, basit seri no kullanan FARKLI tedarikçilerin
            # aynı numaralı faturasını sessizce yutuyordu)
            if fno:
                cur.execute(
                    """SELECT 1 FROM tedarikci_fatura
                       WHERE fatura_no=%s
                         AND fatura_tarih IS NOT DISTINCT FROM %s::date LIMIT 1""",
                    (fno, (f.get("fatura_tarih") or None)))
                if cur.fetchone():
                    atlanan += 1
                    continue
            ftarih = (f.get("fatura_tarih") or None)  # regex'ten — kesin
            fid = str(uuid.uuid4())
            # ORİJİNAL PDF de saklanır (sahip şikayeti 2026-07-14: 'gör' deyince
            # 'saklanmıyor' diyordu — PDF yolunda dosya hiç kaydedilmiyormuş;
            # VUK/TTK saklama BELGEYİ ister, yalnız metni değil). Bölünmüş çoklu
            # faturada aynı kaynak PDF her faturaya damgalanır — 'gör' hep açılır.
            cur.execute(
                """
                INSERT INTO tedarikci_fatura
                    (id, sube_id, fatura_no, fatura_tarih, onceki_bakiye, bakiye_dahil,
                     kaynak_metin, kaynak_tip, durum, yukleyen_personel_id,
                     foto, foto_mime)
                VALUES (%s, %s, %s, %s, %s, %s, %s, 'pdf', 'ocr_bekliyor', %s,
                        %s, 'application/pdf')
                """,
                (fid, (sube_id or None), fno, ftarih,
                 f.get("onceki_bakiye"), f.get("bakiye_dahil"), metin, (personel_id or None),
                 raw),
            )
            cur.execute("UPDATE tedarikci_fatura SET dosya_hash=%s WHERE id=%s", (dh, fid))
            yeni_idler.append(fid)
            # ⚡ ANINDA KOD OKUMA (sahip 2026-07-18: 'yeni PDF yükledim ama
            # sıraya aldı — ilk kod çalışmalıydı'): kimlik+tutar+kalemler KODLA
            # yükleme ANINDA çıkarılır (milisaniyeler) — LLM kuyruğunu beklemez.
            # kod_tam ise LLM'e HİÇ gitmez; yalnız-tutar okunduysa (kalemler
            # çıkmadıysa) kayıt yine anında işlenir, kalemler arka planda/gece
            # LLM ile zenginleşir.
            try:
                y = _pdf_regex_yedek(metin)
                if y:
                    kl = _pdf_kod_kalemler(raw, fno)
                    if kl:
                        y = {**y, "kalemler": kl, "yontem": "kod_tam"}
                        kod_tam_idler.append(fid)
                    _fatura_json_db_yaz(cur, fid, y)
                    aninda_okunan += 1
            except Exception as _e:  # noqa: BLE001
                logger.warning("aninda kod okuma olmadi (kuyruga birakildi) %s: %s",
                               fid, str(_e)[:100])
        conn.commit()

    # FAZ A: anında okunanlar ödeme kuyruğuna bağlanır (idempotent, hata-yutar)
    for fid in yeni_idler:
        try:
            with db() as (_c2, _k2):
                _k2.execute("SELECT durum FROM tedarikci_fatura WHERE id=%s", (fid,))
                _rr = _k2.fetchone()
            if _rr and dict(_rr).get("durum") == "ocr_tamam":
                _fatura_kuyruk_uret(fid)
        except Exception:  # noqa: BLE001
            pass
    # Asenkron ayrıştırma — yalnız kodun TAM okuyamadıkları (kalem zenginleştirme
    # / bozuk düzen LLM'e gider); kod_tam kayıtlar kuyruğa hiç girmez
    for fid in yeni_idler:
        if fid not in kod_tam_idler:
            threading.Thread(target=_ocr_calistir, args=(fid,), daemon=True).start()

    return {
        "toplam_fatura": len(faturalar),
        "yuklenen": len(yeni_idler),
        "aninda_okunan": aninda_okunan,
        "kod_tam": len(kod_tam_idler),
        "atlanan_mevcut": atlanan,
        "durum": ("okundu" if aninda_okunan == len(yeni_idler) and yeni_idler
                  else "ocr_bekliyor"),
    }


@router.delete("/{fatura_id}")
def fatura_sil(fatura_id: str):
    """Bir faturayı (ve kalemlerini) siler. Yanlış okunan/mükerrer faturayı temizlemek
    için. Onaylanmış FİYAT geçmişine dokunmaz (o ayrı, insan onaylı kayıt)."""
    if not fatura_modul_aktif():
        raise HTTPException(503, "Fatura modülü kapalı.")
    fid = (fatura_id or "").strip()
    if not fid:
        raise HTTPException(400, "fatura_id zorunlu")
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute("DELETE FROM tedarikci_fatura_kalem WHERE fatura_id=%s", (fid,))
        cur.execute("DELETE FROM tedarikci_fatura WHERE id=%s", (fid,))
        n = cur.rowcount or 0
        conn.commit()
    if not n:
        raise HTTPException(404, "Fatura bulunamadı")
    return {"ok": True, "silinen": fid}


def dosya_hash_kontrol(cur, raw: bytes):
    """MÜKERRER FRENİ katman-1: dosya sha256 + aktif (kopya-olmayan) eş kayıt araması.
    Dönüş: (hash, eş_kayıt_dict|None). İki yükleme kanalı da (şube foto + belge-iste)
    bunu çağırır — birebir aynı dosya ikinci kez KAYDEDİLMEDEN yakalanır."""
    import hashlib as _h
    dh = _h.sha256(raw).hexdigest()
    cur.execute(
        """SELECT id, tedarikci_ad, fatura_tarih::text AS tarih, olusturma::text AS yuklenme
           FROM tedarikci_fatura
           WHERE dosya_hash=%s AND COALESCE(durum,'') <> 'kopya' LIMIT 1""", (dh,))
    r = cur.fetchone()
    return dh, (dict(r) if r else None)


def _belge_parmak_izi(vkn, fno, tarih, tutar, ted_ad) -> str:
    """BM-1 belge kimliği: VKN+fatura_no+tarih+tutar (+normalize tedarikçi adı yedeği).
    Codex notu: fatura_no tek başına yetmez — bileşik kimlik."""
    import hashlib as _h
    tn = (str(ted_ad or "").strip().upper()
          .replace("İ", "I").replace("Ş", "S").replace("Ğ", "G")
          .replace("Ü", "U").replace("Ö", "O").replace("Ç", "C"))[:40]
    ham = f"{(vkn or '').strip()}|{(fno or '').strip().upper()}|{str(tarih or '')[:10]}|"           f"{round(float(tutar or 0), 2)}|{tn}"
    return _h.sha256(ham.encode("utf-8")).hexdigest()[:32]


def gece_belge_kimlik() -> dict:
    """BM-1: (1) parmak izi backfill, (2) MÜKERRER adayları (aynı kimlik >1 kayıt),
    (3) İADE adayları (negatif tutar ↔ eş pozitif) → duyu olayları. Öneri-only."""
    ozet = {"backfill": 0, "mukerrer": [], "iade": []}
    try:
        from duyu_omurga import duyu_olay_yaz
        with db() as (conn, cur):
            _ensure_tablolar(cur)
            cur.execute(
                """SELECT id, tedarikci_vkn, fatura_no, fatura_tarih, toplam_tutar, tedarikci_ad
                   FROM tedarikci_fatura WHERE parmak_izi IS NULL LIMIT 500""")
            for r in [dict(x) for x in cur.fetchall() or []]:
                pi = _belge_parmak_izi(r.get("tedarikci_vkn"), r.get("fatura_no"),
                                       r.get("fatura_tarih"), r.get("toplam_tutar"),
                                       r.get("tedarikci_ad"))
                cur.execute("UPDATE tedarikci_fatura SET parmak_izi=%s WHERE id=%s",
                            (pi, r["id"]))
                ozet["backfill"] += 1
            # mükerrer: aynı kimlik, tutar>0, birden çok kayıt
            cur.execute(
                """SELECT parmak_izi, COUNT(*)::int AS n,
                          MIN(tedarikci_ad) AS ted, MIN(fatura_tarih)::text AS t,
                          MIN(COALESCE(toplam_tutar,0))::float AS tutar
                   FROM tedarikci_fatura
                   WHERE parmak_izi IS NOT NULL AND COALESCE(toplam_tutar,0) > 0
                     AND COALESCE(durum,'') <> 'kopya'
                   GROUP BY parmak_izi HAVING COUNT(*) > 1""")
            for r in [dict(x) for x in cur.fetchall() or []]:
                ozet["mukerrer"].append({"tedarikci": r["ted"], "tarih": r["t"],
                                         "tutar": r["tutar"], "adet": r["n"]})
                duyu_olay_yaz("belge_kimlik", "belge.fatura.mukerrer_aday",
                              f"{r['parmak_izi']}",
                              entity_scope="belge", entity_id=str(r["ted"] or "")[:40],
                              signal_name="Mükerrer fatura adayı (aynı kimlik)",
                              payload=r)
            # İKİZ mükerrer (ATALAY vakası 2026-07-14): eski OCR tarihi/numarayı
            # yanlış okuyunca parmak izi farklılaşıyor — AYNI tutar + fatura_no
            # KUYRUĞU aynı (son 6+ hane) + FARKLI tarih = güçlü mükerrer adayı
            # ('NPE025...413' vs 'NPE2026...413', 2.272,50). Öneri-only.
            cur.execute(
                """SELECT a.id AS id1, b.id AS id2,
                          a.tedarikci_ad AS ted, b.tedarikci_ad AS tedb,
                          a.fatura_no AS no1, b.fatura_no AS no2,
                          a.fatura_tarih::text AS t1, b.fatura_tarih::text AS t2,
                          a.toplam_tutar::float AS tutar
                   FROM tedarikci_fatura a
                   JOIN tedarikci_fatura b
                     ON a.id < b.id
                    AND COALESCE(a.durum,'') <> 'kopya'
                    AND COALESCE(b.durum,'') <> 'kopya'
                    AND COALESCE(a.toplam_tutar,0) > 0
                    AND ABS(COALESCE(a.toplam_tutar,0) - COALESCE(b.toplam_tutar,0)) <= 0.01
                    AND LENGTH(COALESCE(a.fatura_no,'')) >= 6
                    AND LENGTH(COALESCE(b.fatura_no,'')) >= 6
                    AND RIGHT(a.fatura_no, 6) = RIGHT(b.fatura_no, 6)
                    AND a.fatura_no <> b.fatura_no
                   LIMIT 25""")
            for r in [dict(x) for x in cur.fetchall() or []]:
                # Denetim P2-4: farklı tedarikçilerin '...000123' biten faturaları
                # yanlış-pozitif olmasın — kanonik ad eşit/alt-küme şartı.
                _ka = set(_cari_kanonik(None, r.get("ted")).split())
                _kb = set(_cari_kanonik(None, r.get("tedb")).split())
                if not _ka or not _kb or not (_ka <= _kb or _kb <= _ka):
                    continue
                r["tip"] = "ikiz_no_kuyrugu"
                ozet["mukerrer"].append({"tedarikci": r["ted"], "tarih": r["t1"],
                                         "tutar": r["tutar"], "adet": 2,
                                         "tip": "ikiz", "no1": r["no1"], "no2": r["no2"],
                                         "t2": r["t2"], "id1": r["id1"], "id2": r["id2"]})
                duyu_olay_yaz("belge_kimlik", "belge.fatura.mukerrer_aday",
                              f"ikiz_{r['id1']}_{r['id2']}",
                              entity_scope="belge", entity_id=str(r["ted"] or "")[:40],
                              signal_name="İkiz fatura adayı (aynı tutar + no kuyruğu, farklı tarih)",
                              payload=r)
            # İKİZ-2 (tarih uçurumu): AYNI tedarikçi (KANONİK — ham ad yazımları
            # farklı olabilir: 'MEHMET ATALAY' vs 'Napolés ... Mehmet Atalay') +
            # kuruşuna AYNI tutar + tarih farkı > 300 gün — OCR yılı yanlış
            # okuyunca no kuyruğu da bozuluyor (NP-2023...266 vs NPA2026...026).
            _gorulen_cift = {(m.get("id1"), m.get("id2")) for m in ozet["mukerrer"]
                             if m.get("id1")}
            cur.execute(
                """SELECT a.id AS id1, b.id AS id2,
                          a.tedarikci_ad AS ted, b.tedarikci_ad AS ted2,
                          a.fatura_no AS no1, b.fatura_no AS no2,
                          a.fatura_tarih::text AS t1, b.fatura_tarih::text AS t2,
                          a.toplam_tutar::float AS tutar
                   FROM tedarikci_fatura a
                   JOIN tedarikci_fatura b
                     ON a.id < b.id
                    AND COALESCE(a.durum,'') <> 'kopya'
                    AND COALESCE(b.durum,'') <> 'kopya'
                    AND COALESCE(a.toplam_tutar,0) > 0
                    AND ABS(COALESCE(a.toplam_tutar,0) - COALESCE(b.toplam_tutar,0)) <= 0.01
                    AND a.fatura_tarih IS NOT NULL AND b.fatura_tarih IS NOT NULL
                    AND ABS(a.fatura_tarih - b.fatura_tarih) > 300
                   LIMIT 60""")
            for r in [dict(x) for x in cur.fetchall() or []]:
                if (r["id1"], r["id2"]) in _gorulen_cift:
                    continue  # İKİZ-1 zaten raporladı — çift rapor yok
                # Kanonik ad eşleşmesi: eşit ya da biri diğerinin alt kümesi
                k1 = set(_cari_kanonik(None, r.get("ted")).split())
                k2 = set(_cari_kanonik(None, r.get("ted2")).split())
                if not k1 or not k2 or not (k1 <= k2 or k2 <= k1):
                    continue
                ozet["mukerrer"].append({"tedarikci": r["ted"], "tarih": r["t1"],
                                         "tutar": r["tutar"], "adet": 2,
                                         "tip": "ikiz_tarih", "no1": r["no1"],
                                         "no2": r["no2"], "t2": r["t2"],
                                         "id1": r["id1"], "id2": r["id2"]})
                duyu_olay_yaz("belge_kimlik", "belge.fatura.mukerrer_aday",
                              f"ikizt_{r['id1']}_{r['id2']}",
                              entity_scope="belge", entity_id=str(r["ted"] or "")[:40],
                              signal_name="İkiz fatura adayı (aynı tutar, tarih uçurumu — OCR yıl hatası olabilir)",
                              payload=r)
            # iade: negatif tutarlı belge ↔ aynı tedarikçi eş pozitif (±30g)
            cur.execute(
                """SELECT n.id, n.tedarikci_ad, n.fatura_tarih::text AS t,
                          n.toplam_tutar::float AS tutar
                   FROM tedarikci_fatura n
                   WHERE COALESCE(n.toplam_tutar,0) < 0
                     AND EXISTS (SELECT 1 FROM tedarikci_fatura p
                                 WHERE p.tedarikci_ad = n.tedarikci_ad
                                   AND ABS(COALESCE(p.toplam_tutar,0) + n.toplam_tutar) <= 1
                                   AND ABS(p.fatura_tarih - n.fatura_tarih) <= 30)""")
            for r in [dict(x) for x in cur.fetchall() or []]:
                ozet["iade"].append(r)
                duyu_olay_yaz("belge_kimlik", "belge.fatura.iade_aday",
                              f"iade_{r['id']}",
                              entity_scope="belge", entity_id=str(r["tedarikci_ad"] or "")[:40],
                              signal_name="İade/ters belge adayı",
                              payload=r)
            conn.commit()
    except Exception as e:  # noqa: BLE001
        logger.warning("gece belge kimlik: %s", str(e)[:120])
    return ozet


@router.post("/kimlik-tara")
def belge_kimlik_tara_uc():
    """BM-1 elle tetik: parmak izi backfill + mükerrer/iade tarama."""
    return gece_belge_kimlik()


@router.post("/{fatura_id}/gib-damga")
def fatura_gib_damga(fatura_id: str, body: dict):
    """BM-1 GİB doğrulaması İNSAN-DAMGALI (otomatik sorgu YOK — portal interaktif):
    kullanıcı e-Arşiv sorgulama sayfasında kontrol eder, sonucu buraya damgalar."""
    sonuc = str((body or {}).get("sonuc") or "").strip()
    if sonuc not in ("dogrulandi", "supheli", "bulunamadi"):
        raise HTTPException(400, "sonuc: dogrulandi | supheli | bulunamadi")
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """UPDATE tedarikci_fatura
               SET gib_dogrulama=%s, gib_dogrulama_ts=NOW() WHERE id=%s RETURNING id""",
            (sonuc, fatura_id))
        if not cur.fetchone():
            raise HTTPException(404, "Fatura bulunamadı")
        conn.commit()
    return {"ok": True, "id": fatura_id, "gib_dogrulama": sonuc,
            "sorgu_sayfasi": "https://ebelge.gib.gov.tr/earsivsorgula.html"}


@router.get("/ara")
def fatura_ara(q: str, limit: int = 30):
    """BM-8 TAM METİN ARAMA: tedarikçi adı + fatura no + belge içeriği (kaynak_metin)
    + kalem adları. GIN indeksli tsquery + ILIKE yedeği (Türkçe ekleri için)."""
    q = (q or "").strip()
    if len(q) < 2:
        raise HTTPException(400, "q en az 2 karakter")
    lim = max(1, min(100, int(limit or 30)))
    with db() as (_, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """SELECT DISTINCT f.id, f.tedarikci_ad, f.fatura_no,
                      f.fatura_tarih::text AS tarih,
                      COALESCE(f.toplam_tutar,0)::float AS tutar, f.durum,
                      f.gib_dogrulama
               FROM tedarikci_fatura f
               LEFT JOIN tedarikci_fatura_kalem k ON k.fatura_id = f.id
               WHERE to_tsvector('simple',
                       COALESCE(f.tedarikci_ad,'') || ' ' || COALESCE(f.fatura_no,'') || ' ' ||
                       COALESCE(f.kaynak_metin,'')) @@ websearch_to_tsquery('simple', %s)
                  OR f.tedarikci_ad ILIKE %s OR f.fatura_no ILIKE %s
                  OR k.ocr_ad ILIKE %s
               ORDER BY tarih DESC NULLS LAST LIMIT %s""",
            (q, f"%{q}%", f"%{q}%", f"%{q}%", lim))
        sonuclar = [dict(r) for r in cur.fetchall() or []]
    for s in sonuclar:
        s["goruntule"] = f"/api/fatura/{s['id']}/foto"
    return {"q": q, "adet": len(sonuclar), "sonuclar": sonuclar}


def belge_merkezi_ozet(ay: str = ""):
    """🧾 BELGE MERKEZİ (2026-07-10, sahip: 'faturaları toptancı toptancı, ay ay,
    gün gün görebildiğim; işletme harcamalarından faturası OLMAYANLARI direkt
    gördüğüm mekanizma'): tek özet — (1) toptancı bazlı fatura arşivi, (2) gün gün
    kırılım, (3) faturasız işletme kart harcamaları, (4) belge kapsama oranı.
    Salt-okur; PDF/foto erişimi /api/fatura/{id}/foto."""
    from datetime import date as _d
    hedef = (ay or "").strip()[:7] or _d.today().strftime("%Y-%m")
    with db() as (_, cur):
        cur.execute(
            """SELECT COALESCE(NULLIF(TRIM(tedarikci_ad),''),'(tedarikçi belirsiz)') AS toptanci,
                      COUNT(*)::int AS adet,
                      ROUND(COALESCE(SUM(toplam_tutar),0)::numeric,2) AS toplam,
                      MAX(fatura_tarih)::text AS son_fatura
               FROM tedarikci_fatura
               WHERE TO_CHAR(COALESCE(fatura_tarih, olusturma::date),'YYYY-MM') = %s
                 AND COALESCE(durum,'') <> 'kopya'
               GROUP BY 1 ORDER BY toplam DESC""", (hedef,))
        toptancilar = [dict(r) for r in cur.fetchall() or []]
        for t in toptancilar:
            t["toplam"] = float(t["toplam"])
        cur.execute(
            """SELECT id, tedarikci_ad, fatura_tarih::text AS tarih,
                      COALESCE(toplam_tutar,0)::float AS tutar, durum
               FROM tedarikci_fatura
               WHERE TO_CHAR(COALESCE(fatura_tarih, olusturma::date),'YYYY-MM') = %s
                 AND COALESCE(durum,'') <> 'kopya'
               ORDER BY fatura_tarih DESC NULLS LAST LIMIT 200""", (hedef,))
        faturalar = [dict(r) for r in cur.fetchall() or []]
        for x in faturalar:
            x["goruntule"] = f"/api/fatura/{x['id']}/foto"
        cur.execute(
            """SELECT h.id, h.tarih::text AS tarih, k.kart_adi,
                      ROUND(h.tutar::numeric,2) AS tutar,
                      LEFT(COALESCE(h.aciklama,''),50) AS aciklama,
                      COALESCE(h.harcama_tipi,'belirsiz') AS tip
               FROM kart_hareketleri h JOIN kartlar k ON k.id = h.kart_id
               WHERE h.islem_turu='HARCAMA' AND h.durum='aktif'
                 AND COALESCE(h.harcama_tipi,'belirsiz') <> 'sahsi'
                 AND TO_CHAR(h.tarih,'YYYY-MM') = %s
               ORDER BY h.tutar DESC LIMIT 300""", (hedef,))
        harcamalar = [dict(r) for r in cur.fetchall() or []]
    # eşleştirme: tutar ±%2 / ±5 TL, tarih ±45 gün, fatura tek kullanım.
    # (Tarih penceresi 5→45 gün, sahip 2026-07-18: DYK bardak faturası 01.07
    # kesildi, kart ödemesi 14.07 — 13 gün farkla 'faturasız' görünüyordu;
    # vadeli/kartlı alımda fatura ödemeden HAFTALAR önce kesilir. Tutar %2 +
    # tek-kullanım guard'ı yanlış eşleşmeyi frenler.)
    kullanildi: set = set()
    faturasiz, eslesen_tutar = [], 0.0
    kurumsal, kurumsal_tutar = [], 0.0  # MEPAŞ vb: belgesi KURUMDA hazır, arşive inmemiş
    belgesiz, belgesiz_tutar = [], 0.0  # 🚫 belge beklenmez (personel/elden/öğrenilen)
    try:
        with db() as (_, cur):
            _istisnalar = _belge_istisna_kaliplari(cur)
    except Exception:  # noqa: BLE001
        _istisnalar = []
    for h in harcamalar:
        tut = float(h["tutar"])
        aday = None
        for x in faturalar:
            if x["id"] in kullanildi or float(x.get("tutar") or 0) <= 0:
                continue
            if abs(float(x["tutar"]) - tut) > max(5.0, tut * 0.02):
                continue
            try:
                gf = abs((_d.fromisoformat(h["tarih"][:10])
                          - _d.fromisoformat(str(x["tarih"])[:10])).days)
            except Exception:  # noqa: BLE001
                continue
            if gf <= 45:
                aday = x
                break
        if aday:
            kullanildi.add(aday["id"])
            eslesen_tutar += tut
            continue
        satir = {"tarih": h["tarih"], "kart": h["kart_adi"],
                 "tutar": tut, "aciklama": h["aciklama"], "tip": h["tip"]}
        if kurumsal_fatura_mu(h.get("aciklama") or ""):
            satir["tip"] = "kurumsal"
            kurumsal.append(satir)
            kurumsal_tutar += tut
        elif belge_beklenmez_mi(h.get("aciklama") or "", _istisnalar):
            satir["tip"] = "belgesiz"
            belgesiz.append(satir)
            belgesiz_tutar += tut
        else:
            faturasiz.append(satir)
    # gün gün: fatura + faturasız harcama kırılımı
    gunler: dict = {}
    for x in faturalar:
        g = str(x.get("tarih") or "")[:10]
        if g:
            d0 = gunler.setdefault(g, {"gun": g, "fatura_adet": 0, "fatura_toplam": 0.0,
                                       "faturasiz_harcama": 0.0})
            d0["fatura_adet"] += 1
            d0["fatura_toplam"] = round(d0["fatura_toplam"] + float(x.get("tutar") or 0), 2)
    for h in faturasiz:
        g = h["tarih"][:10]
        d0 = gunler.setdefault(g, {"gun": g, "fatura_adet": 0, "fatura_toplam": 0.0,
                                   "faturasiz_harcama": 0.0})
        d0["faturasiz_harcama"] = round(d0["faturasiz_harcama"] + h["tutar"], 2)
    toplam_harcama = round(sum(float(h["tutar"]) for h in harcamalar), 2)
    # BM-4: Fatura İstek özeti — hata-yutar (motor yoksa Belge Merkezi yaşar);
    # hem UI hem beyin B47 bu tek uçtan besleniyor.
    fatura_istekleri = None
    try:
        from fatura_istek_api import fatura_istek_ozet
        fatura_istekleri = fatura_istek_ozet()
    except Exception:  # noqa: BLE001
        pass
    # BM-3: KDV kanıt sınıflaması (belge-kanıt seviyesi) — hata-yutar
    kdv_kanit = None
    try:
        kdv_kanit = kdv_kanit_ozet(hedef)
    except Exception:  # noqa: BLE001
        pass
    # İŞLENEMEYEN FOTO sayacı (SÜTAŞ vakası): ocr_hata/bekleyen fotolar GÖRÜNÜR
    # olsun — sessiz birikme bir daha yaşanmasın
    islenemeyen = None
    try:
        with db() as (_, cur):
            cur.execute(
                """SELECT f.id, f.olusturma::date::text AS tarih, f.durum,
                          LEFT(COALESCE(f.ocr_hata,''),160) AS hata,
                          COALESCE(s.ad, '') AS sube,
                          COALESCE(p.ad_soyad, '') AS yukleyen
                   FROM tedarikci_fatura f
                   LEFT JOIN personel p ON p.id = f.yukleyen_personel_id
                   LEFT JOIN subeler s ON s.id::text = f.sube_id::text
                   WHERE f.durum IN ('ocr_hata','ocr_bekliyor') AND f.foto IS NOT NULL
                   ORDER BY f.olusturma DESC LIMIT 40""")
            takili = [dict(r) for r in cur.fetchall() or []]
        # Hata SINIFLAMASI (sahip 2026-07-18: 'bazılarında çekim hatası var'):
        # kota/anahtar = SİSTEM sorunu (yeniden dene çözer, foto suçsuz);
        # okunamadı = ÇEKİM sorunu (bulanık/kesik — yeniden çekilmeli).
        for r in takili:
            h = (r.get("hata") or "").lower()
            if not h:
                r["hata_tipi"] = "bekliyor"
            elif "429" in h or "quota" in h or "rate" in h or "api" in h and "key" in h:
                r["hata_tipi"] = "kota"
            else:
                r["hata_tipi"] = "okunamadi"
            r["goruntule"] = f"/api/fatura/{r['id']}/foto"
        islenemeyen = {"adet": len(takili),
                       "son_hata": (takili[0].get("hata") or None) if takili else None,
                       "fotolar": takili}
    except Exception:  # noqa: BLE001
        pass
    # BM-0b görünürlüğü: arşiv depo boyutu (BYTEA) — obje depoya geçiş eşiği izlenir
    arsiv_depo = None
    try:
        with db() as (_, cur):
            cur.execute(
                """SELECT COUNT(*)::int AS adet,
                          ROUND(COALESCE(SUM(OCTET_LENGTH(foto)),0) / 1048576.0, 1) AS mb
                   FROM tedarikci_fatura WHERE foto IS NOT NULL""")
            r0 = dict(cur.fetchone() or {})
        arsiv_depo = {"dosyali_adet": int(r0.get("adet") or 0),
                      "toplam_mb": float(r0.get("mb") or 0),
                      "not": "≈500 MB üstünde obje depoya taşıma (BM-0b) gündeme alınmalı"}
    except Exception:  # noqa: BLE001
        pass
    return {
        "ay": hedef,
        "kapsama": {
            "isletme_kart_harcamasi": toplam_harcama,
            "faturali_eslesen": round(eslesen_tutar, 2),
            # Kurumsal otomatik (MEPAŞ vb): belgesi kurumda hazır — riskli
            # faturasızdan AYRI sayılır (sahip konumlandırması 2026-07-14)
            "kurumsal_otomatik": round(kurumsal_tutar, 2),
            # 🚫 belge beklenmez (personel/elden/öğrenilen istisna) — riskli değil
            "belge_beklenmez": round(belgesiz_tutar, 2),
            "faturasiz": round(toplam_harcama - eslesen_tutar - kurumsal_tutar
                               - belgesiz_tutar, 2),
            "oran_yuzde": (round(eslesen_tutar / toplam_harcama * 100, 1)
                           if toplam_harcama > 0 else None),
            # ── DOĞRU TABAN (2026-08-07 denetimi) ────────────────────────────
            # oran_yuzde PAYDAYA TÜM harcamayı koyar; içinde belgesi zaten
            # beklenmeyen kalemler de vardır (kurumsal otomatik talimat = fatura
            # kurumda hazır; belge_beklenmez = personel/elden istisnası).
            # Canlı vaka: Ağustos'ta 3.903 ₺ harcamanın TAMAMI otomatik talimat
            # (4 şubenin internet faturası), faturasız riskli kalem 0 ₺ — ama
            # ekran "kapsama %0" kırmızısı basıyordu. Panik yaratan yanlış sinyal.
            # Aşağıdaki alan yalnız BELGE BEKLENEN tabana bakar; taban 0 ise
            # oran YOK'tur (None) — "%0" demek yanlış olur.
            "belge_bekleyen_taban": round(toplam_harcama - kurumsal_tutar - belgesiz_tutar, 2),
            "oran_riskli_yuzde": (
                round(eslesen_tutar / (toplam_harcama - kurumsal_tutar - belgesiz_tutar) * 100, 1)
                if (toplam_harcama - kurumsal_tutar - belgesiz_tutar) > 0 else None
            ),
        },
        "toptancilar": toptancilar,
        "gun_gun": sorted(gunler.values(), key=lambda x: x["gun"], reverse=True),
        "faturasiz_harcamalar": faturasiz[:40],
        "kurumsal_harcamalar": kurumsal[:40],
        "belgesiz_harcamalar": belgesiz[:40],
        "fatura_arsivi": faturalar[:60],
        "fatura_istekleri": fatura_istekleri,
        "kdv_kanit": kdv_kanit,
        "arsiv_depo": arsiv_depo,
        "islenemeyen_foto": islenemeyen,
        "not": "ADAY eşleştirme (±%2 tutar, ±5 gün) — hüküm değil. Faturasız satır = "
               "belge isteme adayı (KDV indirimi + gider kanıtı). PDF/foto: goruntule "
               "linki. Nakit işletme giderleri (anlık gider) bu sürümde kapsam dışı — "
               "kart harcamaları izlenir.",
    }


@router.get("/belge-merkezi")
def belge_merkezi_uc(ay: str = ""):
    """UI + beyin için birleşik Belge Merkezi özeti."""
    return belge_merkezi_ozet(ay)


# ── TEDARİKÇİ MERKEZİ (2026-07-14, sahip: 'hepsini tek merkez halinde kurgulayalım')
# Codex mimari kararları (session 019f5f5f devamı): ana obje=Tedarikçi-360, iniş=
# Genel Bakış; GECİKMİŞ tutar her zaman toplam açıktan GÜRÜLTÜLÜ; yaşlandırma VADE
# tarihine göre (Cari/1-7/8-30/31-60/61+ gecikme); faturasız harcama aging'e
# KARIŞMAZ (ayrı risk KPI); fatura_istek(ödeme-temelli) ile belge_talep(teslimat-
# temelli) AYNI KUYRUĞA SOKULMAZ — tek sekmede iki alt-durum; ödeme akışı
# TAŞINMAZ (deep-link); SALT-OKUR agregat + aksiyonlar mevcut akışlara link.

@router.get("/tedarikci-merkez")
def tedarikci_merkez():
    from datetime import date as _d
    bugun = _d.today()
    # 1) Vadeli borçlar — VADE tarihli yaşlandırma (Codex: due-date aging)
    with db() as (_, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """SELECT id, COALESCE(TRIM(tedarikci),'') AS tedarikci,
                      tutar::float AS tutar, vade_tarihi::text AS vade,
                      LEFT(COALESCE(aciklama,''),50) AS aciklama
               FROM vadeli_alimlar WHERE durum='bekliyor' ORDER BY vade_tarihi""")
        vadeler = [dict(r) for r in cur.fetchall() or []]
    kovalar = {"cari": 0.0, "g1_7": 0.0, "g8_30": 0.0, "g31_60": 0.0, "g61_plus": 0.0}
    gecikmisler, bu_hafta = [], []
    for v in vadeler:
        try:
            gec = (bugun - _d.fromisoformat(v["vade"])).days
        except Exception:  # noqa: BLE001
            gec = 0
        v["gecikme_gun"] = gec
        if gec <= 0:
            kovalar["cari"] += v["tutar"]
            if -7 <= gec <= 0:
                bu_hafta.append(v)
        elif gec <= 7:
            kovalar["g1_7"] += v["tutar"]; gecikmisler.append(v)
        elif gec <= 30:
            kovalar["g8_30"] += v["tutar"]; gecikmisler.append(v)
        elif gec <= 60:
            kovalar["g31_60"] += v["tutar"]; gecikmisler.append(v)
        else:
            kovalar["g61_plus"] += v["tutar"]; gecikmisler.append(v)
    kovalar = {k: round(x, 2) for k, x in kovalar.items()}
    gecikmis_toplam = round(sum(v["tutar"] for v in gecikmisler), 2)
    gecikmisler.sort(key=lambda v: -v["gecikme_gun"])

    # 2) Cari (Tedarikçi-360 listesi) + 3) belge açığı iki alt-durumu — hata-yutar
    cari = {}
    try:
        cari = cari_ozet()
    except Exception:  # noqa: BLE001
        pass
    odeme_temelli = None
    try:
        from fatura_istek_api import fatura_istek_ozet
        odeme_temelli = fatura_istek_ozet()
    except Exception:  # noqa: BLE001
        pass
    teslimat_temelli = None
    try:
        with db() as (_, cur):
            cur.execute("""SELECT COUNT(*)::int AS adet,
                                  COALESCE(MAX(GREATEST(0, CURRENT_DATE -
                                      COALESCE(teslim_tarihi, olusturma::date))),0)::int AS en_yasli_gun
                           FROM belge_talep WHERE durum='bekliyor'""")
            r0 = dict(cur.fetchone() or {})
        teslimat_temelli = {"bekleyen": int(r0.get("adet") or 0),
                           "en_yasli_gun": int(r0.get("en_yasli_gun") or 0)}
    except Exception:  # noqa: BLE001
        pass
    islenemeyen = None
    try:
        with db() as (_, cur):
            cur.execute("""SELECT COUNT(*)::int AS a FROM tedarikci_fatura
                           WHERE durum IN ('ocr_hata','ocr_bekliyor') AND foto IS NOT NULL""")
            islenemeyen = int(dict(cur.fetchone() or {"a": 0})["a"])
    except Exception:  # noqa: BLE001
        pass

    return {
        "kpi": {
            "toplam_hesaplanan_acik": cari.get("toplam_hesaplanan_acik"),
            "gecikmis_vade_toplam": gecikmis_toplam,          # her zaman en gürültülü
            "vadesi_gelmemis": kovalar["cari"],
            "bu_hafta_vade_toplam": round(sum(v["tutar"] for v in bu_hafta), 2),
            "faturasiz_risk": (odeme_temelli or {}).get("acik_toplam"),  # aging'e KARIŞMAZ
            "islenemeyen_foto": islenemeyen,
        },
        "vade_yaslandirma": kovalar,
        "gecikmis_vadeler": gecikmisler[:20],
        "bu_hafta_vadeler": bu_hafta[:20],
        "tedarikciler": cari.get("tedarikciler") or [],
        "belge_acigi": {
            "odeme_temelli": odeme_temelli,       # fatura_istek (≥eşik, wa.me/e-arşiv)
            "teslimat_temelli": teslimat_temelli, # belge_talep (Açık Teslimat, cep)
        },
        "not": ("SALT-OKUR komuta merkezi — aksiyonlar mevcut akışlara link (ödeme "
                "akışı taşınmadı). Yaşlandırma VADE tarihine göre; faturasız kart "
                "harcaması yaşlandırmaya karışmaz (ayrı risk). İki kovalama evreni "
                "ayrı alt-durumdur: ödeme-temelli (fatura istek) / teslimat-temelli "
                "(açık teslimat)."),
    }


class KopyaYapBody(BaseModel):
    asil_id: Optional[str] = None
    neden: str = ""


@router.post("/{fatura_id}/kopya-yap")
def fatura_kopya_yap(fatura_id: str, body: KopyaYapBody):
    """ONARIM UCU (2026-07-25, ATALAY/APS vakaları): kaydı elle 'kopya' işaretle —
    çift borç tekilleşir. Foto/PDF silinmez (yasal arşiv), yalnız cari/kuyruk
    hesaplarından çıkar. neden zorunlu (iz kalsın)."""
    neden = (body.neden or "").strip()
    if not neden:
        raise HTTPException(400, "neden zorunlu — örn. 'aynı faturanın no'suz nüshası'")
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """UPDATE tedarikci_fatura SET durum='kopya',
                   ocr_hata='elle kopya işareti: ' || %s || COALESCE(' — asıl: ' || %s, '')
               WHERE id=%s AND COALESCE(durum,'') <> 'kopya' RETURNING id""",
            (neden[:160], (body.asil_id or None), fatura_id))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Kayıt bulunamadı ya da zaten kopya")
        cur.execute("DELETE FROM tedarikci_fatura_kalem WHERE fatura_id=%s", (fatura_id,))
    return {"ok": True, "kopya": fatura_id}


@router.post("/{fatura_id}/kopya-geri-al")
def fatura_kopya_geri_al(fatura_id: str):
    """ONARIM UCU: yanlış kopyalanan sağlıklı nüshayı asıla döndür (durum ocr_tamam'a
    döner; kalemler yeniden okunması için OCR tekrar tetiklenebilir)."""
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """UPDATE tedarikci_fatura SET durum='ocr_tamam', ocr_hata=NULL
               WHERE id=%s AND durum='kopya' RETURNING id, ocr_json IS NOT NULL AS js""",
            (fatura_id,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Kayıt bulunamadı ya da kopya değil")
    return {"ok": True, "asil": fatura_id,
            "not": "Kalemleri yoksa 'ocr-yeniden-dene' ile yeniden okutulabilir."}


@router.post("/ocr-yeniden-dene")
def ocr_yeniden_dene(limit: int = 25):
    """SÜTAŞ vakası (2026-07-14): personelin yüklediği 50 foto OCR'da sessizce
    'ocr_hata'ya düşmüş (LLM anahtarı/kota kesintisi) ve hiçbir ekranda
    görünmüyordu. Bu uç hatalı/bekleyen fotoğrafları OCR kuyruğuna GERİ alır
    (asenkron); son hata metinlerini de döner ki kök neden görünsün."""
    import threading
    lim = max(1, min(100, int(limit or 25)))
    with db() as (_, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """SELECT id, ocr_hata FROM tedarikci_fatura
               WHERE (durum IN ('ocr_hata','ocr_bekliyor') AND foto IS NOT NULL)
                  OR (durum='ocr_tamam' AND ocr_json->>'yontem'='regex_yedek')
               ORDER BY olusturma DESC LIMIT %s""", (lim,))
        rows = [dict(r) for r in cur.fetchall() or []]
    hatalar = sorted({(r.get("ocr_hata") or "")[:160] for r in rows if r.get("ocr_hata")})
    for r in rows:
        threading.Thread(target=_ocr_calistir, args=(r["id"],), daemon=True).start()
    return {"ok": True, "kuyruga_alinan": len(rows), "son_hatalar": hatalar[:3],
            "not": "OCR asenkron çalışır — 1-2 dk sonra Belge Merkezi'ni yenileyin. "
                   "Hata sürerse son_hatalar kök nedeni söyler (örn. LLM kota)."}


# ── BM-5: TEDARİKÇİ CARİ EKSTRE (2026-07-10) ────────────────────────────────
# Kanonik kimlik = VKN (öncelik), yoksa normalize ad (fizibilite şartı #2).
# CARİ GERÇEK = fatura üstü bakiye zinciri (onceki_bakiye/bakiye_dahil =
# TEDARİKÇİNİN BEYANI — bizim hesap değil, '≈ beyan' diye sunulur).
# Ödeme tarafı ayrı kasa izi YOK — 3 kanal aday-eşleştirme (fatura_istek ile
# aynı evren): salt-okur, öneri-only.

def _cari_kanonik(vkn, ad) -> str:
    """VKN öncelik; yoksa JENERİK-filtreli anlamlı token dizisi (canlı test dersi:
    'SAN. VE TİC.' ↔ 'SANAYİ VE TİCARET' yazım farkı aynı tedarikçiyi iki satıra
    bölüyor, ödeme izi ÇİFT düşülüyordu)."""
    v = (vkn or "").strip()
    if v:
        return v
    tokenlar = [w.strip(".,()") for w in _cari_katla(ad).split()
                if len(w.strip(".,()")) >= 3 and w.strip(".,()") not in _JENERIK]
    return " ".join(tokenlar) or _cari_katla(ad).strip()


# Marka-token eşleştirme (canlı test dersi 2026-07-13: fatura üstü UZUN ünvan
# 'SÜTAŞ SÜT ÜRÜNLERİ A.Ş.' ödeme metnindeki KISA adla 'sütaş süt alımı'
# eşleşmiyordu — tüm tedarikçiler yanlışça 'iz yok' görünüyordu).
# İlk anlamlı kelime = marka; jenerik kelimeler marka sayılmaz.
# KURUMSAL OTOMATİK FATURA sınıfı (sahip, 2026-07-14: "MEPAŞ faturaları kartta
# otomatik ödemede; ekstre yükleyince sistem 'faturası yok' algılıyor — bunları
# nasıl konumlandırmalıyız?"). Bunlar FATURASIZ değil: kurum e-arşiv faturası
# KESİYOR, sadece PDF arşive inmemiş. Kovalama yolu WhatsApp DEĞİL — kurum
# sitesi / GİB e-arşivden indirip Belge Merkezi'ne yüklemek. Kalıp listesi dar
# tutulur (elektrik/su/doğalgaz/telekom kurumları); eşleşme ADAY etiketi, hüküm değil.
_KURUMSAL_KALIPLAR = (
    "mepas", "mepaş", "medas", "medaş", "tedas", "tedaş", "bedas", "bedaş",
    "ayedas", "ayedaş", "enerjisa", "aydem", "gediz elektrik", "toroslar",
    "elektrik", "koski", "koskİ", "iski", "aski", "su idaresi", "su fatura",
    "dogalgaz", "doğalgaz", "igdas", "igdaş", "enerya", "aksa dogalgaz",
    "turk telekom", "türk telekom", "turkcell", "vodafone", "superonline",
    "turknet", "türknet", "ttnet", "internet fatura", "gsm fatura",
)


def kurumsal_fatura_mu(metin: str) -> bool:
    m = _cari_katla(metin)
    if any(_cari_katla(k) in m for k in _KURUMSAL_KALIPLAR):
        return True
    # TEK-KELİME kurum sınıfları (sahip 2026-07-18: 'GAZZE SU', 'ALSANCAK
    # İNTERNET' kurumsal algılanmıyordu — elektrik algılanıyordu çünkü kalıp
    # alt-dize; 'su' alt-dize olarak riskli ('suat' vb) → TOKEN bazlı arama).
    tokenlar = {w.strip(".,():;0123456789") for w in m.split()}
    return bool(tokenlar & {"su", "internet", "wifi", "fiber"})


# 🚫 BELGE BEKLENMEZ sınıfı (sahip 2026-07-15: "bazı ödemeler faturasız ya da
# personele elden verilmiş para — nasıl ayırt edeceğiz?"): personele ödeme /
# elden para / prim-bahşiş türü çıkışlar TEDARİKÇİ alımı değildir — fatura
# kovalanmaz, kapsama oranını kirletmez. İki kaynak: (1) sabit kalıplar,
# (2) ÖĞRENEN istisna defteri (belge_istisna_kalip) — sahip Fatura İstek'te
# '🚫 belge beklenmez' deyince kalıp kaydedilir, bir daha aday olmaz.
_BELGESIZ_KALIPLAR = (
    "personel", "avans", "maas", "maaş", "prim", "ikramiye", "bahsis", "bahşiş",
    "harclik", "harçlık", "elden", "yol parasi", "yol ücreti", "yemek parasi",
    "kasa devir", "kasa transfer",
    # 2026-07-15 (sahip: 'kartlar için vade gibi algılıyor, fatura bekliyor'):
    # banka/faiz/kart ödemeleri fatura ÜRETMEZ — belgesi dekont/ekstredir
    "banka", "hesap faizi", "eksi hesap", "faiz", "kredi karti", "kart odeme",
    "kart borcu", "ekstre", "asgari odeme", "altin alimi", "altın alımı",
    "hisse senedi", "doviz alimi", "döviz alımı",  # yatırım — fatura üretmez
)


def _belge_istisna_kaliplari(cur) -> list:
    """Öğrenen istisna defteri — sahip onayıyla birikir (kural=VERİ deseni)."""
    try:
        cur.execute("""CREATE TABLE IF NOT EXISTS belge_istisna_kalip (
                           id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                           kalip TEXT NOT NULL UNIQUE,
                           not_metin TEXT,
                           olusturma TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
        cur.execute("SELECT kalip FROM belge_istisna_kalip")
        return [r["kalip"] for r in cur.fetchall() or []]
    except Exception:  # noqa: BLE001
        return []


def belge_beklenmez_mi(metin: str, ogrenilen: list = None) -> bool:
    m = _cari_katla(metin)
    if any(_cari_katla(k) in m for k in _BELGESIZ_KALIPLAR):
        return True
    for k in (ogrenilen or []):
        kk = _cari_katla(k)
        if len(kk) >= 3 and kk in m:
            return True
    return False


# Sahip düzeltmesi (2026-07-13): "sistem Haziran'dan beri kullanılıyor — Haziran
# öncesi fatura/ödemeyi dahil EDEMEZSİN". Cari penceresi sistem başlangıcından
# önceye TAŞMAZ; öncesi borçlar yalnız tedarikçi BEYANINDA görünür.
EVVEL_SISTEM_BASLANGIC = "2026-06-01"  # gorev_api.SISTEM_BASLANGIC ile aynı kural


def _cari_pencere_kesiti(gun: int = 180) -> str:
    from datetime import date as _d, timedelta as _td
    kesit = (_d.today() - _td(days=gun)).isoformat()
    return max(kesit, EVVEL_SISTEM_BASLANGIC)


# 📜 AÇILIŞ DEVRİ (sahip 2026-07-18, DYK vakası: "fatura öncesinde de ödeme
# yapılmıştı ama sistem o dönemde yoktu — önceki ödemeyi görmedi"): pencere
# sistem başlangıcı öncesine taşmadığından, öncesinin GERÇEĞİ tek satırlık
# sahip beyanıyla temsil edilir (dünya pratiği: açılış fişi / opening balance).
# tutar > 0 = başlangıç itibarıyla tedarikçiye BORÇ; tutar < 0 = AVANS/alacak.
# Kural=VERİ deseni: tablo, kod değil. Kasa-izi istisnası BİLİNÇLİ: sistem
# öncesi ödemenin izi olamaz — bu yüzden beyan açıkça 'sahip beyanı' etiketlidir.
def _cari_devirler(cur) -> list:
    try:
        cur.execute("""CREATE TABLE IF NOT EXISTS cari_devir (
                           id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                           tedarikci TEXT NOT NULL UNIQUE,
                           tutar NUMERIC(14,2) NOT NULL,
                           aciklama TEXT,
                           olusturma TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
        # 📜 AÇILIŞ DEVRİ SİLİNMEZ (2026-08-08, Codex denetimi): devir bir
        # BİLANÇO GERÇEĞİDİR (sahip beyanı) — fiziksel DELETE hem sahip
        # doktrinine ("hiçbir kayıt silinmez") hem muhasebe ilkesine aykırıydı.
        # Artık iptal damgası: kayıt yerinde durur, hesaba girmez, geri alınabilir.
        cur.execute("ALTER TABLE cari_devir ADD COLUMN IF NOT EXISTS aktif BOOLEAN DEFAULT TRUE")
        cur.execute("ALTER TABLE cari_devir ADD COLUMN IF NOT EXISTS iptal_ts TIMESTAMPTZ")
        cur.execute("ALTER TABLE cari_devir ADD COLUMN IF NOT EXISTS iptal_neden TEXT")
        cur.execute("""SELECT id, tedarikci, tutar::float AS tutar,
                              COALESCE(aciklama,'') AS aciklama
                       FROM cari_devir
                       WHERE COALESCE(aktif, TRUE)""")
        return [dict(r) for r in cur.fetchall() or []]
    except Exception:  # noqa: BLE001
        return []


def _cari_katla(s: str) -> str:
    """TR harf katlaması (beyin _tr_katla dersi: 'HİZMETLERİ'.lower() noktalı
    i̇ üretir, ASCII karşılaştırma ıskalar) — tüm cari eşleştirmeleri bundan geçer."""
    ceviri = str.maketrans("İIıŞşĞğÜüÖöÇç", "iiissgguuoocc")
    return (s or "").translate(ceviri).lower()


# Katlanmış (ASCII) biçimde tutulur — _cari_katla sonrası karşılaştırılır
_JENERIK = {"gida", "kahve", "market", "grup", "ltd", "sti", "san", "tic",
            "sanayi", "ticaret", "urunleri", "sut", "ith", "ihr", "ithalat",
            "ihracat", "a.s", "ve", "limited", "sirketi", "anonim",
            "hizmetleri", "hizmet"}
# 🌍 COĞRAFİ GÜRÜLTÜ (2026-08-08, canlı ders): kart ekstresi satırları şehir
# adıyla biter — "TOTAL ALTANLAR AKY KONYA TR", "EVA MUTFAK KONYA TR". Tedarikçi
# adı da şehirle başlıyorsa ("KONYA SUKİ ENERJİ...") marka tokeni "konya" olur ve
# ekstredeki HER satıra yapışır: 39 alakasız iz / 198.490 ₺ sahte eşleşme.
# Şehir adı kimlik değil, adres bilgisidir — marka tokeni olamaz.
_COGRAFI = {
    "konya", "istanbul", "ankara", "izmir", "antalya", "bursa", "adana",
    "mersin", "kayseri", "gaziantep", "denizli", "eskisehir", "samsun",
    "trabzon", "malatya", "erzurum", "diyarbakir", "sakarya", "kocaeli",
    "manisa", "aydin", "mugla", "balikesir", "tekirdag", "hatay", "sivas",
    "afyon", "corum", "isparta", "elazig", "tokat", "kutahya", "kirikkale",
    "karaman", "aksaray", "nigde", "nevsehir", "usak", "yozgat", "amasya",
    "turkiye", "turkey", "merkez", "sube", "cadde", "mahalle",
}
_JENERIK = _JENERIK | _COGRAFI


def _marka_token(ad: str) -> str:
    for w in _cari_katla(ad).split():
        w = w.strip(".,()")
        if len(w) >= 3 and w not in _JENERIK:
            return w
    return ""


# Yaygın Türkçe kişi adları — kişi-adlı tedarikçide (MEHMET ATALAY) tek kelime
# eşleşmesi başka Mehmet'lere de yapışır (birim test dersi) → soyadı da aranır.
_KISI_ADLARI = {"mehmet", "ahmet", "ali", "mustafa", "hasan", "huseyin",
                "ibrahim", "ismail", "osman", "yusuf", "murat", "omer",
                "halil", "suleyman", "ramazan", "recep", "salih",
                "fatma", "ayse", "emine", "hatice", "zeynep", "ersin",
                "emre", "onur", "fethi", "kemal", "kadir", "adem", "yaren"}


def _odeme_eslesir(ad: str, metin: str) -> bool:
    """Ödeme metni bu tedarikçiye mi? Marka tokeni aranır; token kişi adıysa
    ikinci kelime (soyadı) da ZORUNLU. Aday eşleşmedir — kesin mutabakat değil."""
    m = _cari_katla(metin)
    kelimeler = [w.strip(".,()") for w in _cari_katla(ad).split()
                 if len(w.strip(".,()")) >= 3 and w.strip(".,()") not in _JENERIK]
    if not kelimeler:
        return False
    t1 = kelimeler[0]
    if t1 not in m:
        return False
    if t1 in _KISI_ADLARI:
        return len(kelimeler) >= 2 and kelimeler[1] in m
    return True


def _cari_zincir(faturalar: list) -> list:
    """Kronolojik faturalarda zincir farkı: onceki_bakiye(N) − bakiye_dahil(N-1).
    Negatif → arada ÖDEME görülmüş; pozitif → belge-dışı borç artışı (yönlü ölçüm,
    Çapraz Hipotez deseni). None bakiyeli satırlar zinciri koparmaz, atlanır."""
    onceki_dahil = None
    for f in faturalar:
        f["zincir_fark"] = None
        if f.get("onceki_bakiye") is not None and onceki_dahil is not None:
            f["zincir_fark"] = round(float(f["onceki_bakiye"]) - onceki_dahil, 2)
        if f.get("bakiye_dahil") is not None:
            onceki_dahil = float(f["bakiye_dahil"])
    return faturalar


# ── 🏷 TEDARİKÇİ SINIFI (2026-07-19, sahip: 'elektrik faturasını tedarikçi
# alanında bulunduramayız'): mal tedarikçisi (kahve/gıda/ambalaj) ≠ hizmet
# sağlayıcı (elektrik/uydu/telekom). Deterministik anahtar kelime — Ödeme
# Merkezi'nde hizmetçiler ⚡ Giderler sekmesine düşer. Yanlış sınıf görürsek
# liste büyür (kod=veri, tek merkez burası).
_HIZMET_KELIMELERI = (
    "ENERJ", "ELEKTRİK", "ELEKTRIK", "DOĞALGAZ", "DOGALGAZ", "TELEKOM",
    "UYDU", "İLETİŞİM", "ILETISIM", "INTERNET", "İNTERNET", "GSM",
    "TURKCELL", "VODAFONE", "SİGORTA", "SIGORTA", "MUHASEBE", "MALİ MÜŞAVİR",
)
# MAL kanıtı hizmet kelimesini EZER: 'APS GIDA ENERJİ KİMYA TARIM' bir Red Bull
# distribütörü — adında ENERJİ geçiyor diye elektrik şirketi sayılmaz (2026-07-19
# canlı yanlış-poz dersi; D-MARKET 'ELEKTRONİK' de ELEKTR'e takılıyordu → tam
# kelimeye çevrildi, ELEKTRONİK artık eşleşmez).
_MAL_KANITI = ("GIDA", "GİDA", "MARKET", "GROSMARKET", "AMBALAJ", "KAHVE",
               "COFFEE", "SÜT", "SUT ", "TARIM", "MAĞAZACILIK", "MAGAZACILIK")


def tedarikci_sinif(ad: str) -> str:
    """'hizmet' (fatura sağlayıcı — Giderler alanı) | 'mal' (ürün tedarikçisi).

    İKİ LİSTE BİRLEŞTİ (2026-08-08): _HIZMET_KELIMELERI (Ödeme Merkezi sekmesi)
    ve _KURUMSAL_KALIPLAR (fatura istek kanalı) ayrı ayrı bakılıyordu; MEPAŞ/
    AYDEM/İSKİ ilkinde yoktu, ikincisinde vardı. Artık tek karar noktası.
    MAL kanıtı ikisini de ezer.
    """
    u = (ad or "").upper()
    if any(k in u for k in _MAL_KANITI):
        return "mal"
    if any(k in u for k in _HIZMET_KELIMELERI):
        return "hizmet"
    try:
        return "hizmet" if kurumsal_fatura_mu(ad) else "mal"
    except Exception:  # noqa: BLE001
        return "mal"


# ── 🔬 KALEM KANITI — İÇERİK, ADI EZER (2026-08-08).
# Canlı ders: "KONYA SUKİ ENERJİ YATIRIM SANAYİ VE TİCARET A.Ş." adına bakıp
# elektrik şirketi sandık; faturanın kalemleri "0,5 L PET SU (12 ADET/KOLİ)"
# çıktı — bu bir SU TEDARİKÇİSİ, mal satıyor. Ad bir TAHMİN, kalem bir KANIT.
# Gider faturasının kalemi tüketim/abonelik dilinde konuşur; mal faturasınınki
# ürün adı + adet + birim fiyat.
_HIZMET_KALEM_KANITI = (
    "KWH", "KW/H", "TÜKETİM BEDEL", "TUKETIM BEDEL", "ABONE", "SAYAÇ", "SAYAC",
    "ENDEKS", "DAĞITIM BEDEL", "DAGITIM BEDEL", "ENERJİ BEDEL", "ENERJI BEDEL",
    "GÜÇ BEDEL", "GUC BEDEL", "İLETİM BEDEL", "ILETIM BEDEL", "KAYIP KAÇAK",
    "M3 SU", "ATIK SU", "SABİT ÜCRET", "SABIT UCRET", "PAKET ÜCRET",
    "ABONELİK", "ABONELIK", "TRT PAY", "ELEKTRİK TÜKETİM", "DOĞALGAZ TÜKETİM",
)


def kalem_sinif_kaniti(kalem_adlari) -> Optional[str]:
    """Kalemlerden sınıf kanıtı: 'hizmet' | 'mal' | None (kanıt yok).

    Kanıt varsa ad heuristiğini EZER — içerik tahminden güçlüdür.
    """
    adlar = [str(a or "").upper() for a in (kalem_adlari or []) if str(a or "").strip()]
    if not adlar:
        return None
    birlesik = " | ".join(adlar)
    if any(k in birlesik for k in _HIZMET_KALEM_KANITI):
        return "hizmet"
    # Ürün satırı var, tüketim dili yok → mal faturası
    return "mal"


def belge_sinifi_coz(cur, fatura_id: str, tedarikci_ad: str, kalem_adlari=None) -> str:
    """Faturanın sınıfını KAYNAKTA damgalar ve döndürür.

    Sahip sorusu (2026-08-08): "ürüne gelen faturayla elektrik faturası arasında
    fark var — sistem bunun farkında mı?" Farkı vardı ama sadece EKRANDA:
    tedarikci_sinif() her okumada yeniden hesaplanıyor, hiçbir yere yazılmıyordu.
    Sonuç: elektrik faturası mal faturasıyla aynı yola giriyor, teslimat
    eşleştirmesine aday olabiliyordu.

    Elle düzeltilmiş sınıf (sinif_kaynak='elle') KORUNUR — heuristik onu ezmez.
    """
    try:
        cur.execute("SELECT belge_sinifi, sinif_kaynak FROM tedarikci_fatura WHERE id=%s", (fatura_id,))
        r = cur.fetchone()
        if r and (r.get("sinif_kaynak") or "") == "elle" and r.get("belge_sinifi"):
            return r["belge_sinifi"]
        kanit = kalem_sinif_kaniti(kalem_adlari)
        s = kanit or tedarikci_sinif(tedarikci_ad)
        kaynak = "kalem_kaniti" if kanit else "ad_heuristik"
        cur.execute(
            "UPDATE tedarikci_fatura SET belge_sinifi=%s, sinif_kaynak=%s WHERE id=%s",
            (s, kaynak, fatura_id),
        )
        return s
    except Exception as e:  # noqa: BLE001 — damga başarısız olsa da fatura kaydı yaşar
        logger.warning("belge_sinifi_coz atlandı (%s): %s", fatura_id, e)
        return tedarikci_sinif(tedarikci_ad)


@router.get("/belge-sinifi-ozet")
def belge_sinifi_ozet():
    """Mal faturası ≠ gider faturası — kaç belge hangi sınıfta, kaçı damgasız."""
    with db() as (_c, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """SELECT COALESCE(belge_sinifi,'damgasiz') AS sinif,
                      COALESCE(sinif_kaynak,'-')       AS kaynak,
                      COUNT(*)::int                    AS adet,
                      COALESCE(SUM(toplam_tutar),0)::float AS tutar
               FROM tedarikci_fatura
               WHERE COALESCE(durum,'') <> 'kopya'
               GROUP BY 1,2 ORDER BY 3 DESC"""
        )
        satir = [dict(r) for r in (cur.fetchall() or [])]
        cur.execute(
            """SELECT tedarikci_ad, COUNT(*)::int AS adet,
                      COALESCE(SUM(toplam_tutar),0)::float AS tutar
               FROM tedarikci_fatura
               WHERE belge_sinifi='hizmet' AND COALESCE(durum,'') <> 'kopya'
               GROUP BY 1 ORDER BY 3 DESC LIMIT 25"""
        )
        hizmetciler = [dict(r) for r in (cur.fetchall() or [])]
    return {
        "kirilim": satir, "hizmet_saglayicilar": hizmetciler,
        "not": "'damgasiz' = sınıf henüz çözülmemiş (eski kayıt). "
               "POST /api/fatura/belge-sinifi-tazele ile doldurulur. "
               "Elle düzeltme: POST /api/fatura/{id}/belge-sinifi?sinif=hizmet",
    }


def _ensure_eslesme_karar_defteri(cur) -> None:
    """📒 EŞLEŞME KARAR DEFTERİ — append-only (2026-08-08, Codex denetimi).

    Kart izi onayı KALICI MUHASEBE ETKİSİ yaratıyor (o çekim artık şu tedarikçinin
    borcundan düşüyor) ama kim/ne zaman/neyi/neden bağladığının kaydı yoktu ve
    damga serbestçe üzerine yazılabiliyordu. Yasal iz açısından zayıftı.

    KURAL: bu tabloya YALNIZ EKLENİR. Düzeltme yeni satırla yapılır (supersedes
    ile önceki karara işaret eder); hiçbir satır UPDATE/DELETE edilmez.
    kart_hareketleri.cari_tedarikci artık SON ETKİN KARARIN ÖNBELLEĞİDİR —
    gerçek burada durur.
    """
    try:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS cari_eslesme_karar (
                id            TEXT PRIMARY KEY,
                hareket_id    TEXT NOT NULL,
                onceki_deger  TEXT,
                yeni_deger    TEXT NOT NULL,
                karar         TEXT NOT NULL,      -- bagla | reddet | geri_al
                guven         NUMERIC(5,4),
                dayanak       TEXT,
                aktor         TEXT NOT NULL DEFAULT 'sahip',
                supersedes    TEXT,
                tutar         NUMERIC(14,2),
                hareket_tarih DATE,
                ts            TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )""")
        cur.execute("CREATE INDEX IF NOT EXISTS ix_eslesme_karar_hareket "
                    "ON cari_eslesme_karar (hareket_id, ts DESC)")
        cur.execute("CREATE INDEX IF NOT EXISTS ix_eslesme_karar_ted "
                    "ON cari_eslesme_karar (yeni_deger, ts DESC)")
    except Exception:  # noqa: BLE001
        pass


def _karar_yaz(cur, hareket_id, onceki, yeni, karar, aktor="sahip",
               guven=None, dayanak=None, tutar=None, hareket_tarih=None) -> str:
    """Deftere BİR satır ekler (asla güncellemez). Dönüş: karar id'si."""
    kid = str(uuid.uuid4())
    try:
        # Aynı harekete ait son karar → supersedes zinciri kurulur
        cur.execute("""SELECT id FROM cari_eslesme_karar
                       WHERE hareket_id=%s ORDER BY ts DESC LIMIT 1""", (hareket_id,))
        r = cur.fetchone()
        cur.execute(
            """INSERT INTO cari_eslesme_karar
                 (id, hareket_id, onceki_deger, yeni_deger, karar, guven,
                  dayanak, aktor, supersedes, tutar, hareket_tarih)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (kid, str(hareket_id), onceki, yeni, karar, guven, dayanak, aktor,
             (r["id"] if r else None), tutar, hareket_tarih))
    except Exception as e:  # noqa: BLE001 — defter yazılamazsa işlem sürsün, ama LOGLA
        logger.warning("eşleşme karar defteri yazılamadı (%s): %s", hareket_id, str(e)[:140])
    return kid


def _ensure_kart_izi_tablolar(cur) -> None:
    """Kart hareketine CARİ DAMGASI — 'bu çekim şu tedarikçinin borcuna sayılır'.

    TASARIM KARARI (2026-08-08): onay ayrı bir ödeme kaydı YARATMAZ, mevcut kart
    hareketini damgalar. Sebep: cari_ekstre kart kanalını zaten tarıyor; ikinci
    bir kayıt açsaydık aynı para hem kart satırından hem ödeme kaydından
    düşülürdü (çift sayım). Tek satır, tek gerçek.
      · cari_tedarikci NULL  → ad eşleşmesiyle bulunan ADAY (bakiyeden tahminen düşer)
      · cari_tedarikci dolu  → sahip ONAYLADI (kesin), ad eşleşmesi aranmaz
      · cari_tedarikci='(ilgisiz)' → sahip REDDETTİ, bir daha aday gösterilmez
    """
    try:
        cur.execute("ALTER TABLE kart_hareketleri ADD COLUMN IF NOT EXISTS cari_tedarikci TEXT")
        cur.execute("ALTER TABLE kart_hareketleri ADD COLUMN IF NOT EXISTS cari_onay_ts TIMESTAMPTZ")
        cur.execute("""CREATE INDEX IF NOT EXISTS ix_kh_cari_ted
                       ON kart_hareketleri (cari_tedarikci)
                       WHERE cari_tedarikci IS NOT NULL""")
    except Exception:  # noqa: BLE001
        pass


# ── 🧾 KDV ORANLARI (2026): kategori bazlı tahmin. Fatura geldiğinde gerçek
# oran kalemden okunur; buradaki oran YALNIZ faturasız/eşleşmemiş harcamanın
# vergi etkisini KABACA ölçmek içindir (sahip: "ödenecek vergiyi daha net
# belirlemiş oluruz").
_KDV_KATEGORI = {
    "Market": 0.10, "Yemek & Restoran": 0.10, "Gıda": 0.10,
    "Faturalar": 0.20, "Yakıt & EV Şarj": 0.20, "Online Alışveriş": 0.20,
    "Streaming": 0.20, "Ev & Dekorasyon": 0.20, "Vergi & SGK": 0.0,
    "Ödeme": 0.0,
}
_KDV_VARSAYILAN = 0.20

# ⚖️ VERGİ/SGK ÖDEMELERİ — gider DEĞİL, KDV'si YOK (2026-08-08 canlı ders:
# "42252-MEVLANA VERGİ DAİRESİ" 2×23.473 ₺ "Ev & Dekorasyon" kategorisinde
# duruyordu ve %20 KDV hesaplanıyordu — ikisi de yanlış). Verginin kendisi
# matrahtan düşülmez; SGK primi düşülür ama KDV'si yoktur.
_VERGI_SGK_KALIP = ("VERGI DAIRE", "VERGİ DAİRE", "VERGI DAIRESI", "MALIYE",
                    "MALİYE", "SGK", "SOSYAL GUVENLIK", "SOSYAL GÜVENLİK",
                    "GIB ", "GİB ", "MUHTASAR", "DAMGA VERGI", "STOPAJ")
# 🌐 YURTDIŞI HİZMET — KDV sorumlu sıfatıyla (KDV-2) beyan edilir; normal
# indirim gibi işlenemez. Kart ekstresinde ülke kodu satırın SONUNDADIR.
# ⚠️ Ülke kodu metin İÇİNDE aranmaz: ilk sürümde " SE" kalıbı "AGİT SEFA"
# içinde eşleşip cari borç ödemesini yurtdışı hizmet saymıştı (canlı ders).
_YURTDISI_ULKE_SONEK = (" US", " SE", " NL", " IE", " GB", " DE", " LU",
                        " FR", " IT", " ES", " CH", " SG", " CAUS")
# Bunlar metin içinde aranabilir — şehir/marka adı yanlış eşleşme üretmez
_YURTDISI_ICERIK = ("RAILWAY.COM", "STOCKHOLM", "DUBLIN", "AMSTERDAM",
                    "SAN FRANCISCO", "LUXEMBOURG", "SINGAPORE")


def _harcama_vergi_sinifi(aciklama: str, kategori: str) -> Optional[str]:
    """'vergi_sgk' | 'yurtdisi' | None (normal işletme gideri)."""
    u = (aciklama or "").upper().strip()
    if any(k in u for k in _VERGI_SGK_KALIP) or (kategori or "") == "Vergi & SGK":
        return "vergi_sgk"
    if any(u.endswith(k) for k in _YURTDISI_ULKE_SONEK):
        return "yurtdisi"
    if any(k in u for k in _YURTDISI_ICERIK):
        return "yurtdisi"
    return None


@router.post("/odeme-iz-bagi-tazele")
def odeme_iz_bagi_tazele(kuru: int = 1):
    """🔗 '(odenmis)' damgalı faturaların HANGİ ödemeyle eşleştiğini geriye dönük yazar.

    Eski motor damgayı basıyor ama bağı kaydetmiyordu; zincir kopuk kaldığı için
    vergi tarafında bu harcamalar "belgesiz" görünüyordu. Bu uç aynı eşleştirmeyi
    (tedarikçi adı + tutar ±%2 + tarih −10/+90) tekrar kurar ve bağı yazar.

    kuru=1 → ne bulunacağını gösterir, yazmaz.
    """
    yazilacak, bulunamayan = [], []
    with db() as (conn, cur):
        cur.execute("ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS odeme_iz_tablo TEXT")
        cur.execute("ALTER TABLE tedarikci_fatura ADD COLUMN IF NOT EXISTS odeme_iz_id TEXT")
        conn.commit()
        cur.execute(
            """SELECT id, tedarikci_ad, fatura_no, fatura_tarih::text AS ftarih,
                      COALESCE(toplam_tutar,0)::float AS tutar
               FROM tedarikci_fatura
               WHERE kuyruk_vadeli_id='(odenmis)'
                 AND (odeme_iz_id IS NULL OR odeme_iz_id='')
                 AND COALESCE(durum,'') <> 'kopya'"""
        )
        hedef = [dict(r) for r in (cur.fetchall() or [])]
        for f in hedef:
            tut = float(f.get("tutar") or 0)
            ftarih = (f.get("ftarih") or "")[:10] or date.today().isoformat()
            ted = (f.get("tedarikci_ad") or "").strip()
            cur.execute(
                """SELECT * FROM (
                     SELECT 'vadeli_alimlar' AS kanal, id::text AS iz_id, vade_tarihi AS t,
                            tutar, COALESCE(aciklama,'')||' '||COALESCE(tedarikci,'') AS metin
                     FROM vadeli_alimlar WHERE durum='odendi'
                     UNION ALL
                     SELECT 'anlik_giderler', id::text, tarih, tutar,
                            COALESCE(aciklama,'')||' '||COALESCE(tedarikci,'')
                     FROM anlik_giderler WHERE durum='aktif'
                     UNION ALL
                     SELECT 'kart_hareketleri', id::text, tarih, tutar, COALESCE(aciklama,'')
                     FROM kart_hareketleri
                     WHERE islem_turu='HARCAMA' AND durum='aktif'
                       AND COALESCE(harcama_tipi,'belirsiz') <> 'sahsi') x
                   WHERE ABS(x.tutar - %s) <= GREATEST(5, %s * 0.02)
                     AND x.t BETWEEN %s::date - 10 AND %s::date + 90
                   ORDER BY x.t LIMIT 20""",
                (tut, tut, ftarih, ftarih))
            izler = [dict(x) for x in (cur.fetchall() or [])]
            es = next((i for i in izler if _odeme_eslesir(ted, i.get("metin") or "")), None)
            if not es:
                bulunamayan.append({"fatura_id": f["id"], "tedarikci": ted,
                                    "tutar": tut, "tarih": f.get("ftarih"),
                                    "neden": "Tedarikçiyle eşleşen ödeme izi bulunamadı — "
                                             "damga şüpheli (odenmis-sayilan-denetimi'ne bak)"})
                continue
            kayit = {"fatura_id": f["id"], "tedarikci": ted, "tutar": tut,
                     "fatura_no": f.get("fatura_no"),
                     "iz_kanal": es["kanal"], "iz_id": str(es["iz_id"]),
                     "iz_tarih": str(es["t"]), "iz_tutar": float(es["tutar"] or 0),
                     "iz_metin": (es.get("metin") or "")[:70]}
            yazilacak.append(kayit)
            if not kuru:
                cur.execute(
                    "UPDATE tedarikci_fatura SET odeme_iz_tablo=%s, odeme_iz_id=%s WHERE id=%s",
                    (es["kanal"], str(es["iz_id"]), f["id"]))
        if not kuru:
            conn.commit()
    return {
        "kuru_calistirma": bool(kuru),
        "bagsiz_damgali_fatura": len(hedef),
        "bag_kurulabilir": len(yazilacak),
        "iz_bulunamayan": len(bulunamayan),
        "baglanacak_tutar": round(sum(y["tutar"] for y in yazilacak), 2),
        "baglar": yazilacak[:40], "bulunamayanlar": bulunamayan[:20],
        "not": "Bu bağ vergi tarafında 'belgeli' saymanın EN GÜÇLÜ kanıtıdır: "
               "harcamanın faturası kayıtlı demektir. Uygulamak için ?kuru=0.",
    }


@router.get("/kart-vergi-etkisi")
def kart_vergi_etkisi(gun: int = 365, kurumlar_orani: float = 0.25):
    """🧾 İşletme kart harcamalarının VERGİ etkisi — faturası var mı, yok mu?

    Sahip (2026-08-08): "kart harcamalarında işletme mi şahsi mi diye
    ayrıştırıyoruz; işletme için olanların faturaları var mı yok mu diye
    sorulmalı. Fatura varsa vergiden düşümde gider olarak sayılmalı ki ödenecek
    vergiyi daha net belirlemiş oluruz — hem KDV hem gelir vergisinden düşüm."

    ÜÇ KOVA:
      · belgeli    → KDV indirilebilir + matrahtan düşer (çifte tasarruf)
      · belgesiz   → hiçbiri; para çıkmış ama vergi avantajı KAYIP
      · belirsiz   → işletme mi şahsi mi ayrılmamış; önce o karar verilmeli

    Tasarruf = KDV indirimi + (KDV hariç tutar × kurumlar/gelir vergisi oranı).
    Oranlar TAHMİNDİR (kategori bazlı); kesin rakam faturanın kendi KDV'sidir.
    """
    bugun = date.today()
    with db() as (_c, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """SELECT h.id, h.tarih::text AS tarih,
                      ABS(COALESCE(h.tutar,0))::float AS tutar,
                      COALESCE(h.aciklama,'') AS aciklama,
                      COALESCE(h.harcama_tipi,'belirsiz') AS tip,
                      COALESCE(h.kategori,'') AS kategori,
                      COALESCE(h.kaynak_tablo,'') AS kaynak_tablo, h.kaynak_id
               FROM kart_hareketleri h
               WHERE h.islem_turu='HARCAMA' AND COALESCE(h.durum,'aktif')='aktif'
                 AND h.tarih >= %s
               ORDER BY h.tarih DESC""",
            (bugun - timedelta(days=gun),))
        hareketler = [dict(r) for r in (cur.fetchall() or [])]
        # ── BELGE TESPİTİ ÜÇ KANALDAN (2026-08-08 ders: tek kanala bakınca
        # "belgeli=0" çıkıyordu — oysa DYK'nın 147.176 ₺'lik bardak alımının
        # faturası sistemde vardı. Kart satırı faturaya DOĞRUDAN bağlı değil;
        # zincir kart → vadeli_alim → tedarikci_fatura.kuyruk_vadeli_id).
        belge = {}
        try:  # 1) fatura istek kuyruğu — belge kovalama sonucu
            cur.execute(
                """SELECT kaynak_id, durum, eslesen_fatura_id, tur
                   FROM fatura_istek WHERE kaynak_tip='kart'""")
            belge = {str(r["kaynak_id"]): {**dict(r), "kanal": "fatura_istek"}
                     for r in (cur.fetchall() or [])}
        except Exception as e:  # noqa: BLE001
            logger.warning("fatura_istek okunamadi: %s", str(e)[:120])
        # 2) ZİNCİR: kart → vadeli_alim → fatura
        vadeli_faturali = set()
        try:
            cur.execute(
                """SELECT DISTINCT kuyruk_vadeli_id FROM tedarikci_fatura
                   WHERE kuyruk_vadeli_id IS NOT NULL
                     AND kuyruk_vadeli_id NOT IN ('(arsiv)','(odenmis)')""")
            vadeli_faturali = {str(r["kuyruk_vadeli_id"]) for r in (cur.fetchall() or [])}
        except Exception:  # noqa: BLE001
            pass
        # 3) Anlık giderde fiş kaydı (şube fişi gönderilmiş mi)
        fisli = set()
        try:
            cur.execute(
                """SELECT id FROM anlik_giderler
                   WHERE COALESCE(fis_gonderildi,FALSE) = TRUE""")
            fisli = {str(r["id"]) for r in (cur.fetchall() or [])}
        except Exception:  # noqa: BLE001
            pass
        # 4) DOĞRUDAN BAĞ: fatura hangi ödeme iziyle eşleşti (odeme_iz_tablo/id).
        # En güçlü kanıt — "bu harcamanın faturası şu" demek. Diğer kanallar
        # dolaylıydı; bu bağ kurulunca zincir kopukluğu kalmaz.
        iz_bagi: Dict[str, set] = {"kart_hareketleri": set(), "vadeli_alimlar": set(),
                                   "anlik_giderler": set()}
        try:
            cur.execute(
                """SELECT odeme_iz_tablo, odeme_iz_id FROM tedarikci_fatura
                   WHERE odeme_iz_id IS NOT NULL AND odeme_iz_id <> ''""")
            for r in (cur.fetchall() or []):
                iz_bagi.setdefault(r["odeme_iz_tablo"], set()).add(str(r["odeme_iz_id"]))
        except Exception as e:  # noqa: BLE001 — kolon henüz yoksa sessiz geç
            logger.info("odeme_iz bagi okunamadi (kolon yeni olabilir): %s", str(e)[:90])

    kova = {k: {"adet": 0, "tutar": 0.0, "kdv": 0.0, "matrah": 0.0}
            for k in ("belgeli", "belgesiz", "belirsiz", "sahsi",
                      "vergi_sgk", "yurtdisi")}
    belgesiz_liste, belirsiz_liste, ozel_liste = [], [], []
    for h in hareketler:
        tut = round(float(h["tutar"] or 0), 2)
        tip = h["tip"]
        # ÖZEL SINIFLAR önce: vergi ödemesi gider değil, yurtdışı KDV-2
        ozel = _harcama_vergi_sinifi(h.get("aciklama") or "", h.get("kategori") or "")
        if ozel and tip != "sahsi":
            kova[ozel]["adet"] += 1
            kova[ozel]["tutar"] = round(kova[ozel]["tutar"] + tut, 2)
            ozel_liste.append({
                "hareket_id": str(h["id"]), "tarih": h["tarih"], "tutar": tut,
                "aciklama": (h.get("aciklama") or "")[:70], "sinif": ozel,
                "ne_demek": ("Verginin kendisi — matrahtan düşülmez, KDV'si yok"
                             if ozel == "vergi_sgk"
                             else "Yurtdışı hizmet — KDV sorumlu sıfatıyla (KDV-2) beyan edilir")})
            continue
        oran = _KDV_KATEGORI.get(h.get("kategori") or "", _KDV_VARSAYILAN)
        matrah = round(tut / (1 + oran), 2) if oran else tut
        kdv = round(tut - matrah, 2)
        b = belge.get(str(h["id"]))
        kt, ki = h.get("kaynak_tablo") or "", str(h.get("kaynak_id") or "")
        dayanak = None
        if str(h["id"]) in iz_bagi.get("kart_hareketleri", set()):
            dayanak = "doğrudan bağ: bu kart çekiminin faturası kayıtlı"
        elif kt and ki and ki in iz_bagi.get(kt, set()):
            dayanak = f"doğrudan bağ: {kt} kaydının faturası kayıtlı"
        elif b and (b.get("durum") in ("fatura_geldi", "kapandi") or b.get("eslesen_fatura_id")):
            dayanak = "fatura_istek kuyruğu kapandı"
        elif kt == "vadeli_alimlar" and ki in vadeli_faturali:
            dayanak = "zincir: kart → vadeli alım → fatura"
        elif kt == "anlik_giderler" and ki in fisli:
            dayanak = "anlık giderin fişi gönderilmiş"
        belgeli = dayanak is not None
        if tip == "sahsi":
            k = "sahsi"
        elif tip == "belirsiz":
            k = "belirsiz"
        else:
            k = "belgeli" if belgeli else "belgesiz"
        kova[k]["adet"] += 1
        kova[k]["tutar"] = round(kova[k]["tutar"] + tut, 2)
        kova[k]["kdv"] = round(kova[k]["kdv"] + kdv, 2)
        kova[k]["matrah"] = round(kova[k]["matrah"] + matrah, 2)
        kalem = {"hareket_id": str(h["id"]), "tarih": h["tarih"], "tutar": tut,
                 "aciklama": (h.get("aciklama") or "")[:70],
                 "kategori": h.get("kategori") or "-",
                 "kdv_tahmini": kdv, "istek_durumu": (b or {}).get("durum", "istek yok"),
                 "belge_dayanagi": dayanak, "kaynak": kt or "elle/ekstre"}
        if k == "belgesiz":
            belgesiz_liste.append(kalem)
        elif k == "belirsiz":
            # ÖNERİ: sistem kaydından doğmuş bir kart satırı (vadeli alım, anlık
            # gider, sabit gider) tanım gereği İŞLETME harcamasıdır — o kayıt
            # zaten işletme defterinde. Sahip tek tıkla onaylayabilsin diye
            # öneriyi burada üretiyoruz (hüküm yok, öneri-only).
            # ⚠️ 'ekstre_import' bir SİSTEM KAYDI DEĞİL — bankadan inen ham
            # satırdır. İlk sürümde onu da işletme sayıp LCWAIKIKI'ye "işletme"
            # önerisi çıkarıyordu (canlı ders). Yalnız işletme defterinde
            # karşılığı olan kaynaklar öneri üretir.
            _sistem_kaynagi = kt in ("vadeli_alimlar", "anlik_giderler", "sabit_giderler")
            kalem["oneri"] = "isletme" if _sistem_kaynagi else None
            kalem["oneri_gerekce"] = (
                f"{kt} kaydından doğmuş — işletme defterinde zaten var"
                if _sistem_kaynagi else "Ham banka satırı — sahip karar vermeli")
            belirsiz_liste.append(kalem)

    def _tasarruf(k):
        return round(kova[k]["kdv"] + kova[k]["matrah"] * kurumlar_orani, 2)

    kayip = _tasarruf("belgesiz")
    return {
        "pencere_gun": gun, "kurumlar_orani": kurumlar_orani,
        "kovalar": {
            "belgeli": {**kova["belgeli"], "vergi_tasarrufu": _tasarruf("belgeli"),
                        "ne_demek": "KDV indirilebilir + matrahtan düşülebilir"},
            "belgesiz": {**kova["belgesiz"], "kayip_tasarruf": kayip,
                         "ne_demek": "Para çıktı ama belge yok — vergi avantajı KAYIP"},
            "belirsiz": {**kova["belirsiz"],
                         "ne_demek": "İşletme mi şahsi mi ayrılmamış — önce bu karar"},
            "sahsi": {**kova["sahsi"], "ne_demek": "Şahsi — vergiye konu değil"},
            "vergi_sgk": {**kova["vergi_sgk"],
                          "ne_demek": "Vergi/SGK ödemesi — verginin kendisi matrahtan "
                                      "düşülmez, KDV'si yoktur (gider listesine girmemeli)"},
            "yurtdisi": {**kova["yurtdisi"],
                         "ne_demek": "Yurtdışı hizmet — KDV-2 sorumlu sıfatıyla beyan; "
                                     "normal indirim gibi işlenemez"},
        },
        "ozel_sinif_harcamalari": sorted(ozel_liste, key=lambda x: -x["tutar"])[:30],
        "ozet_cumle": (
            f"İşletme harcamalarının {kova['belgeli']['tutar']:,.2f} ₺'si belgeli, "
            f"{kova['belgesiz']['tutar']:,.2f} ₺'si belgesiz. Belgesizler yüzünden "
            f"yaklaşık {kayip:,.2f} ₺ vergi avantajı kullanılamıyor "
            f"({kova['belgesiz']['kdv']:,.2f} ₺ KDV indirimi + "
            f"{round(kova['belgesiz']['matrah'] * kurumlar_orani, 2):,.2f} ₺ gider yazımı)."
        ).replace(",", "@").replace(".", ",").replace("@", "."),
        "belgesiz_harcamalar": sorted(belgesiz_liste, key=lambda x: -x["tutar"])[:50],
        "belirsiz_harcamalar": sorted(belirsiz_liste, key=lambda x: -x["tutar"])[:30],
        "not": "KDV oranları KATEGORİ TAHMİNİDİR (Market/Yemek %10, diğer %20); kesin "
               "rakam faturanın kendi KDV'sidir. Belge durumu fatura_istek kuyruğundan "
               "okunur — belge gelince kova kendiliğinden 'belgeli'ye geçer.",
    }


# ── 🎯 EŞLEŞME GÜVEN SKORU (2026-08-08, Codex önerisi + sahip onayı)
# Otomatik bağlama ancak ÖLÇÜLEBİLİR bir güvenle yapılabilir. Skor 0..1 ve her
# bileşenin katkısı cevapta yazılır — "neden %92?" sorusu cevapsız kalmaz.
#   ≥ 0.95  → sistem kendi bağlar (aktör='sistem', geri alınabilir, deftere yazılır)
#   0.70–0.95 → aday listesi, SAHİP onaylar
#   < 0.70  → dokunma
GUVEN_OTOMATIK = 0.95
# ⚠️ ADAY EŞİĞİ 0.55 (2026-08-08 kalibrasyon dersi): 0.70 iken ÖĞRENME
# KİLİTLENMESİ vardı — ilk kez görülen kalıp %60 alıyor, aday eşiği %70 →
# sahip hiç aday görmez → hiç onaylamaz → sistem hiç öğrenemez → hiçbir şey
# otomatikleşemez. Eşik düşünce döngü kapanıyor: sahip ilk seferinde onaylar,
# sistem öğrenir, sonrakini kendi bağlar.
GUVEN_ADAY = 0.55


def _eslesme_guven(cur, tedarikci: str, hareket: dict, acik_bakiye: float,
                   aday_tedarikci_sayisi: int) -> dict:
    """Bir (tedarikçi, kart satırı) çiftinin eşleşme güveni + dökümü."""
    p = {}
    ted_kel = [w for w in _cari_katla(tedarikci).split()
               if len(w) > 2 and w not in _JENERIK]
    metin = _cari_katla(hareket.get("aciklama") or "")

    # 1) AD KALİTESİ (0–0.35): marka tokeni geçiyor mu?
    # ⚠️ KALİBRASYON (2026-08-08): ilk sürüm kelime SAYISIYLA puanlıyordu
    # (0.22 × ortak). Türk tedarikçi markaları genelde TEK kelimedir (FEZ,
    # ATALAY, SÜTAŞ) → "FEZ KAHWE" ↔ "FEZ KAHVE GIDA ITHALAT KONYA TR" gibi
    # neredeyse birebir eşleşme %82'de kalıp asla otomatiğe ulaşamıyordu.
    # Artık marka tokeni geçiyorsa tabandan yüksek puan, ek kelimeler bonus.
    ortak = [w for w in ted_kel if w in metin]
    p["ad"] = round(min(0.35, 0.30 + 0.05 * (len(ortak) - 1)), 4) if ortak else 0.0

    # 2) ÖĞRENME (0–0.35): karar defterinde AYNI açıklama kalıbı daha önce bu
    #    tedarikçiye onaylandı mı? Sahibin geçmiş kararı EN GÜÇLÜ sinyaldir.
    #    Bu bileşen olmadan tavan %65'tir → sistem İLK KEZ gördüğü bir kalıbı
    #    ASLA otomatik bağlamaz; önce sahip onaylar, sistem öğrenir, sonrakini
    #    kendi bağlar. Otomasyon sahibin kararından türer, tahminden değil.
    p["ogrenme"] = 0.0
    try:
        _kalip = " ".join(metin.split()[:3])
        if len(_kalip) >= 5:
            cur.execute(
                """SELECT COUNT(*)::int AS n FROM cari_eslesme_karar k
                   JOIN kart_hareketleri h ON h.id = k.hareket_id
                   WHERE k.karar='bagla' AND k.aktor <> 'sistem'
                     AND LOWER(k.yeni_deger)=LOWER(%s)
                     AND LOWER(COALESCE(h.aciklama,'')) LIKE %s""",
                (tedarikci, f"%{_kalip}%"))
            if int((cur.fetchone() or {}).get("n") or 0) > 0:
                p["ogrenme"] = 0.35
    except Exception:  # noqa: BLE001
        pass

    # 3) KANAL SAFLIĞI (0–0.10): ham ekstre satırı + şahsi değil
    p["kanal"] = 0.10 if (hareket.get("kaynak") in ("ekstre_import", "elle")) else 0.0

    # 4) BAKİYE MANTIĞI (0–0.10): ödeme açık bakiyenin makul bir parçası mı?
    tut = float(hareket.get("tutar") or 0)
    if acik_bakiye > 0 and 0 < tut <= acik_bakiye * 1.05:
        p["bakiye"] = 0.10
    elif acik_bakiye > 0 and tut <= acik_bakiye * 1.5:
        p["bakiye"] = 0.05
    else:
        p["bakiye"] = 0.0

    # 5) TEKİLLİK (0–0.10): bu satır tek bir tedarikçiye mi aday?
    p["tekillik"] = 0.10 if aday_tedarikci_sayisi <= 1 else 0.0

    skor = round(min(1.0, sum(p.values())), 4)
    return {
        "guven": skor, "dokum": p,
        "karar": ("otomatik" if skor >= GUVEN_OTOMATIK
                  else "aday" if skor >= GUVEN_ADAY else "yok"),
        "gerekce": (f"ad:{len(ortak)} ortak · "
                    f"{'geçmişte onaylanmış kalıp · ' if p['ogrenme'] > 0 else ''}"
                    f"{'tek aday' if p['tekillik'] > 0 else 'çok aday'}"),
    }


@router.get("/kart-borc-izi")
def kart_borc_izi(gun: int = 365, min_bakiye: float = 100.0):
    """💳 Bekleyen borçların KART EKSTRESİNDEKİ izlerini arar — KISMİ ödeme mantığı.

    Sahip (2026-08-08): "kart ekstrelerinde bekleyen borçların izleri ara, illa
    aynı tutar kartta ödenmeyebilir — 50.000 kart çekilmiş olabilir; kısmi ödeme
    mantığı: borcu biriktirecek, ödemeyi bulup borçtan düşecek."

    ESKİ MANTIKTAN FARKI: tutar eşleşmesi ARAMAZ. Tedarikçiye giden her kart
    çekimi, tutarı ne olursa olsun, o tedarikçinin cari bakiyesinden düşme
    ADAYIDIR. 120.000 ₺ borca 50.000 ₺ kart çekimi → 70.000 ₺ devreder.

    ÇİFT SAYIM FRENİ: sistem üretimi satırlar (kaynak_id dolu — "Anlık gider:",
    "Vadeli alım:") HARİÇ; onlar zaten kendi kanallarından cari ekstrede
    sayılıyor. Yalnız HAM ekstre satırları (banka POS metni) aday olur.

    HÜKÜM YOK: hiçbir borç kendiliğinden düşmez — POST /kart-izi-onayla ile
    sahip onaylar (sahip kararı 2026-08-08: "öner, ben onaylayayım").
    """
    ozet = cari_ozet()
    borclular = [t for t in (ozet.get("tedarikciler") or [])
                 if float(t.get("hesaplanan_acik") or 0) >= min_bakiye]
    bugun = date.today()
    sonuc = []
    with db() as (_c, cur):
        _ensure_kart_izi_tablolar(cur)
        # cari_ekstre'nin kart kanalıyla AYNI süzgeç (2026-08-03 FEZ dersi:
        # banka ekstresi importu kaynak_id'yi DOLU yazar — IS NULL şartı tüm
        # banka ödemelerini gizliyordu). Aynı satır kümesi taranmazsa bu ekran
        # ile cari bakiye birbirini tutmaz.
        cur.execute(
            """SELECT h.id, h.tarih::text AS tarih, ABS(COALESCE(h.tutar,0))::float AS tutar,
                      COALESCE(h.aciklama,'') AS aciklama, h.kart_id,
                      h.cari_tedarikci, COALESCE(h.kaynak_tablo,'') AS kaynak_tablo,
                      COALESCE(k.banka,'') AS banka, COALESCE(k.kart_adi,'') AS kart_adi
               FROM kart_hareketleri h
               LEFT JOIN kartlar k ON k.id = h.kart_id
               WHERE h.islem_turu='HARCAMA' AND COALESCE(h.durum,'aktif')='aktif'
                 AND (h.kaynak_id IS NULL OR COALESCE(h.kaynak_tablo,'') = 'ekstre_import')
                 AND COALESCE(h.harcama_tipi,'belirsiz') <> 'sahsi'
                 AND h.tarih >= %s
               ORDER BY h.tarih DESC""",
            (bugun - timedelta(days=gun),),
        )
        _ham = [dict(r) for r in (cur.fetchall() or [])]
    # ⛔ DEVİR ÇİZGİSİ (2026-08-08 canlı ders): sistem başlangıcından ÖNCEKİ kart
    # çekimleri açılış devrine ZATEN dahildir (devir = sahip beyanı, o günkü
    # bakiye). Aday göstermek çift düşme olur: FEZ'in 16.05 tarihli 50.000 ₺
    # çekimi 82.341,59 ₺'lik devrin içinde eriyip gitmiş durumda.
    hareketler = [h for h in _ham if (h.get("tarih") or "") >= EVVEL_SISTEM_BASLANGIC]
    devir_oncesi = [h for h in _ham if (h.get("tarih") or "") < EVVEL_SISTEM_BASLANGIC]

    izsiz = []
    for t in borclular:
        ted = t.get("tedarikci") or ""
        acik = round(float(t.get("hesaplanan_acik") or 0), 2)
        aday, onayli = [], []
        for h in hareketler:
            damga = (h.get("cari_tedarikci") or "").strip()
            if damga == "(ilgisiz)":
                continue                                    # sahip reddetti
            if damga:
                if _cari_katla(damga) == _cari_katla(ted):  # sahip onayladı
                    onayli.append(h)
                continue                                    # başka tedarikçiye damgalı
            if _odeme_eslesir(ted, h.get("aciklama") or ""):
                aday.append(h)

        def _kalem(h, kesin):
            return {"hareket_id": str(h["id"]), "tarih": h["tarih"],
                    "tutar": round(float(h["tutar"] or 0), 2),
                    "aciklama": (h.get("aciklama") or "")[:80],
                    "kart": f"{h.get('banka','')} {h.get('kart_adi','')}".strip(),
                    "kaynak": h.get("kaynak_tablo") or "elle",
                    "durum": "onaylı" if kesin else "aday"}

        if not aday and not onayli:
            izsiz.append({"tedarikci": ted, "acik_bakiye": acik,
                          "ne_demek": "Borç var ama kartta hiçbir iz yok — nakitten "
                                      "ödenmiş, henüz ödenmemiş ya da kart açıklaması "
                                      "tedarikçi adını taşımıyor olabilir"})
            continue
        aday_tl = round(sum(float(h["tutar"] or 0) for h in aday), 2)
        onay_tl = round(sum(float(h["tutar"] or 0) for h in onayli), 2)
        sonuc.append({
            "tedarikci": ted,
            "acik_bakiye": acik,
            "onayli_iz_adet": len(onayli), "onayli_iz_toplam": onay_tl,
            "aday_iz_adet": len(aday), "aday_iz_toplam": aday_tl,
            "kart_izi_toplam": round(onay_tl + aday_tl, 2),
            "kalan_olur": round(acik - aday_tl, 2),
            "izler": ([_kalem(h, True) for h in onayli]
                      + [_kalem(h, False) for h in aday])[:25],
            "ne_demek": (f"Kartta {aday_tl:,.2f} ₺ aday iz var; onaylanırsa borç "
                         f"{acik:,.2f} → {round(acik - aday_tl, 2):,.2f} ₺ olur. "
                         f"Kısmi ödeme normaldir — kalan devreder."
                         ).replace(",", "@").replace(".", ",").replace("@", "."),
        })
    sonuc.sort(key=lambda x: -x["kart_izi_toplam"])
    return {
        "pencere_gun": gun,
        "borclu_tedarikci": len(borclular),
        "iz_bulunan": len(sonuc),
        "iz_bulunamayan": izsiz,
        "toplam_aday_iz": round(sum(s["aday_iz_toplam"] for s in sonuc), 2),
        "toplam_onayli_iz": round(sum(s["onayli_iz_toplam"] for s in sonuc), 2),
        "taranan_kart_hareketi": len(hareketler),
        "devir_oncesi_haric": {
            "adet": len(devir_oncesi),
            "tutar": round(sum(float(h["tutar"] or 0) for h in devir_oncesi), 2),
            "neden": f"{EVVEL_SISTEM_BASLANGIC} öncesi çekimler açılış devrine zaten "
                     f"dahil — aday gösterilirse borç ikinci kez düşerdi",
        },
        "satirlar": sonuc,
        "not": "TUTAR EŞLEŞMESİ ARANMAZ — 50.000 ₺ kart çekimi 120.000 ₺ borcun bir "
               "kısmını kapatır, kalanı devreder (kısmi ödeme doğaldır). Onay kart "
               "hareketini DAMGALAR, yeni ödeme kaydı açmaz — çift sayım imkânsız. "
               "Onay: POST /api/fatura/kart-izi-onayla · Ret: sinif='(ilgisiz)'",
    }


@router.post("/kart-izi-otomatik-tara")
def kart_izi_otomatik_tara(gun: int = 400, uygula: int = 0) -> dict:
    """🔄 Açık borçları kart ekstresindeki izlerle EŞLEŞTİRİR — güven skorlu.

    Sahip (2026-08-08): "kart ekstresi yüklendiğinde tekrar ödeme izlerini
    araştırıp sistemde var mı kontrol etmesi, yoksa ödenmiş borç kabul edip
    cariden düşmesi lazım."

    KRİTİK AYRIM (Codex): otomatik "KAPATMA" değil, otomatik "BAĞLAMA".
    Sistem yeni ödeme kaydı AÇMAZ; yalnız "bu çekim şu tedarikçiye ait" der.
    Borçtan düşme zaten cari okumasıyla kendiliğinden olur. Bu yüzden yanlış
    bağ para yaratmaz/yok etmez — geri alınabilir bir yorum düzeltmesidir.

    uygula=0 → yalnız rapor (ne olurdu). uygula=1 → ≥%95 güvenler bağlanır,
    %70–95 arası sahip onayına bırakılır, altı hiç dokunulmaz.
    """
    ozet = cari_ozet()
    borclular = [t for t in (ozet.get("tedarikciler") or [])
                 if float(t.get("hesaplanan_acik") or 0) >= 100]
    bugun = date.today()
    otomatik, aday, atlanan = [], [], 0
    with db() as (conn, cur):
        _ensure_kart_izi_tablolar(cur)
        _ensure_eslesme_karar_defteri(cur)
        cur.execute(
            """SELECT h.id, h.tarih::text AS tarih,
                      ABS(COALESCE(h.tutar,0))::float AS tutar,
                      COALESCE(h.aciklama,'') AS aciklama,
                      COALESCE(h.kaynak_tablo,'elle') AS kaynak, h.cari_tedarikci
               FROM kart_hareketleri h
               WHERE h.islem_turu='HARCAMA' AND COALESCE(h.durum,'aktif')='aktif'
                 AND (h.kaynak_id IS NULL OR COALESCE(h.kaynak_tablo,'')='ekstre_import')
                 AND COALESCE(h.harcama_tipi,'belirsiz') <> 'sahsi'
                 AND h.cari_tedarikci IS NULL
                 AND h.tarih >= %s AND h.tarih >= %s::date
               ORDER BY h.tarih DESC""",
            (bugun - timedelta(days=gun), EVVEL_SISTEM_BASLANGIC))
        hareketler = [dict(r) for r in (cur.fetchall() or [])]

        # Önce her satırın KAÇ tedarikçiye aday olduğunu say (tekillik bileşeni)
        aday_sayac: Dict[str, int] = {}
        for h in hareketler:
            for t in borclular:
                if _odeme_eslesir(t.get("tedarikci") or "", h["aciklama"]):
                    aday_sayac[h["id"]] = aday_sayac.get(h["id"], 0) + 1

        for h in hareketler:
            if h["id"] not in aday_sayac:
                continue
            en_iyi = None
            for t in borclular:
                ted = t.get("tedarikci") or ""
                if not _odeme_eslesir(ted, h["aciklama"]):
                    continue
                g = _eslesme_guven(cur, ted, h, float(t.get("hesaplanan_acik") or 0),
                                   aday_sayac.get(h["id"], 1))
                if not en_iyi or g["guven"] > en_iyi["g"]["guven"]:
                    en_iyi = {"ted": ted, "g": g, "acik": float(t.get("hesaplanan_acik") or 0)}
            if not en_iyi:
                continue
            kayit = {"hareket_id": h["id"], "tarih": h["tarih"], "tutar": h["tutar"],
                     "aciklama": h["aciklama"][:70], "tedarikci": en_iyi["ted"],
                     "acik_bakiye": en_iyi["acik"], **en_iyi["g"]}
            if en_iyi["g"]["karar"] == "otomatik":
                otomatik.append(kayit)
                if uygula:
                    cur.execute(
                        """UPDATE kart_hareketleri
                             SET cari_tedarikci=%s, cari_onay_ts=NOW() WHERE id=%s""",
                        (en_iyi["ted"], h["id"]))
                    _karar_yaz(cur, h["id"], None, en_iyi["ted"], "bagla",
                               aktor="sistem", guven=en_iyi["g"]["guven"],
                               dayanak=f"otomatik eşleşme — {en_iyi['g']['gerekce']}",
                               tutar=h["tutar"], hareket_tarih=h["tarih"])
            elif en_iyi["g"]["karar"] == "aday":
                aday.append(kayit)
            else:
                atlanan += 1
        if uygula:
            conn.commit()
    return {
        "uygulandi": bool(uygula), "pencere_gun": gun,
        "taranan_hareket": len(hareketler), "borclu_tedarikci": len(borclular),
        "otomatik_baglanan": len(otomatik),
        "otomatik_tutar": round(sum(x["tutar"] for x in otomatik), 2),
        "sahip_onayi_bekleyen": len(aday),
        "aday_tutar": round(sum(x["tutar"] for x in aday), 2),
        "guven_altinda_atlanan": atlanan,
        "otomatik": otomatik[:40], "adaylar": sorted(aday, key=lambda x: -x["guven"])[:40],
        "esikler": {"otomatik": GUVEN_OTOMATIK, "aday": GUVEN_ADAY},
        "not": ("Otomatik BAĞLAMA yapılır, KAPATMA değil — yeni ödeme kaydı açılmaz, "
                "borçtan düşme cari okumasıyla olur. Her bağ deftere yazılır "
                "(aktör='sistem') ve POST /kart-izi-geri-al ile geri alınabilir."),
    }


def gece_kart_izi_tara() -> dict:
    """Gece zinciri halkası — hata-yutar. Yalnız RAPOR üretir (uygula=0):
    otomatik bağlama sahip tetiklemesiyle ya da ekstre importu sonrası olur."""
    try:
        return kart_izi_otomatik_tara(gun=400, uygula=0)
    except Exception as e:  # noqa: BLE001
        logger.warning("gece kart izi tarama hatasi (yutuldu): %s", str(e)[:150])
        return {"ok": False}


class KartIziOnayModel(BaseModel):
    tedarikci: str               # '(ilgisiz)' → bu çekim hiçbir cariye ait değil
    hareket_idler: list          # damgalanacak kart hareketi id'leri
    aktor: Optional[str] = "sahip"    # kim karar verdi (sahip | sistem | gece)
    dayanak: Optional[str] = None     # neden bağlandı (deftere yazılır)


@router.post("/kart-izi-onayla")
def kart_izi_onayla(body: KartIziOnayModel):
    """Kart çekimini tedarikçiye DAMGALAR — para yazmaz, yeni kayıt açmaz.

    Para zaten kart ekstresinde çıkmış. Bu işlem yalnız "bu çekim şu tedarikçinin
    borcuna sayılır" bilgisini kalıcılaştırır. Cari bakiye bu satırı zaten
    okuyordu (ad eşleşmesiyle, tahminen) — damga onu KESİN yapar ve ad eşleşmesi
    tutmayan çekimleri de bağlamaya izin verir.

    tedarikci='(ilgisiz)' → sahip "bu bizim toptancı ödememiz değil" dedi;
    satır bir daha aday gösterilmez ve cari bakiyeden düşmez.
    """
    ted = (body.tedarikci or "").strip()
    idler = [str(x) for x in (body.hareket_idler or []) if str(x).strip()]
    if len(ted) < 3:
        raise HTTPException(400, "tedarikci en az 3 karakter")
    if not idler:
        raise HTTPException(400, "en az bir hareket_id gerekli")

    with db() as (conn, cur):
        _ensure_kart_izi_tablolar(cur)
        _ensure_eslesme_karar_defteri(cur)
        # 🔒 KONTRAT SIKILDI (Codex denetimi): uç TÜM harcama satırlarına açıktı.
        # Cari okuması yalnız ham/ekstre satırlarını sayıyor; sistem üretimi bir
        # satırı (vadeli alım, anlık gider) damgalamak sessizce etkisiz kalır ya
        # da ileride çift sayım üretir. Artık yalnız HAM satır damgalanabilir.
        cur.execute(
            """SELECT id, COALESCE(cari_tedarikci,'') AS onceki,
                      tarih::text AS tarih, ABS(COALESCE(tutar,0))::float AS tutar,
                      LEFT(COALESCE(aciklama,''),70) AS aciklama
               FROM kart_hareketleri
               WHERE id = ANY(%s) AND islem_turu='HARCAMA'
                 AND (kaynak_id IS NULL OR COALESCE(kaynak_tablo,'')='ekstre_import')""",
            (idler,))
        uygun = [dict(r) for r in (cur.fetchall() or [])]
        uygun_idler = [u["id"] for u in uygun]
        reddedilen = [i for i in idler if i not in {str(x) for x in uygun_idler}]
        cur.execute(
            """UPDATE kart_hareketleri
                 SET cari_tedarikci=%s, cari_onay_ts=NOW()
               WHERE id = ANY(%s)
               RETURNING id, tarih::text AS tarih,
                         ABS(COALESCE(tutar,0))::float AS tutar,
                         LEFT(COALESCE(aciklama,''),70) AS aciklama""",
            (ted, uygun_idler))
        damgalanan = [dict(r) for r in (cur.fetchall() or [])]
        # 📒 Her damga deftere ayrı satır olarak yazılır (append-only)
        for u in uygun:
            _karar_yaz(cur, u["id"], (u.get("onceki") or None), ted,
                       ("reddet" if ted == "(ilgisiz)" else "bagla"),
                       aktor=(body.aktor or "sahip"),
                       dayanak=(body.dayanak or None),
                       tutar=u.get("tutar"), hareket_tarih=u.get("tarih"))
        conn.commit()

    toplam = round(sum(float(d["tutar"] or 0) for d in damgalanan), 2)
    if ted == "(ilgisiz)":
        return {"ok": True, "islem": "reddedildi", "damgalanan": len(damgalanan),
                "tutar": toplam, "satirlar": damgalanan,
                "not": "Bu çekimler artık hiçbir tedarikçiye aday gösterilmez."}

    # FIFO tahsis — YORUM katmanı: bu para hangi faturaları kapattı?
    # Bakiye zaten doğru; tahsis yalnız yaşlandırma/raporlama içindir.
    tahsisler, kalan = [], toplam
    try:
        acik = cari_odenecekler(tedarikci=ted)["acik_faturalar"]
        with db() as (conn, cur):
            _ensure_cari_odeme_tablolar(cur)
            for a in acik:
                if kalan <= 0.01:
                    break
                pay = round(min(float(a["kalan"]), kalan), 2)
                cur.execute(
                    """INSERT INTO cari_odeme_tahsis
                         (id, odeme_id, fatura_id, fatura_no, fatura_tarih, kapatilan, otomatik)
                       VALUES (%s,%s,%s,%s,%s,%s,TRUE)""",
                    (str(uuid.uuid4()), (damgalanan[0]["id"] if damgalanan else None),
                     a["fatura_id"], a.get("fatura_no"), a.get("tarih"), pay))
                tahsisler.append({"fatura_no": a.get("fatura_no"), "tarih": a.get("tarih"),
                                  "kapatilan": pay})
                kalan = round(kalan - pay, 2)
            conn.commit()
    except Exception as e:  # noqa: BLE001 — tahsis YORUM; başarısızlığı bakiyeyi bozmaz
        logger.warning("kart izi tahsis atlandi (%s): %s", ted, str(e)[:120])

    return {
        "ok": True, "tedarikci": ted,
        "damgalanan": len(damgalanan), "toplam_dusen": toplam,
        "satirlar": damgalanan,
        "kapatilan_fatura": tahsisler,
        "artan": round(kalan, 2),
        "uygun_olmayan": len(reddedilen),
        "uygun_olmayan_not": ("Sistem üretimi satırlar (vadeli alım / anlık gider) "
                              "damgalanamaz — cari onları zaten kendi kanalından "
                              "sayıyor" if reddedilen else None),
        "not": ("Para YAZILMADI — zaten kart ekstresinde çıkmıştı; damga onu borçla "
                "ilişkilendirir. Artan tutar cari bakiyede alacak olarak kalır "
                "(sonraki faturalara mahsup edilir)."),
    }


@router.get("/eslesme-karar-defteri")
def eslesme_karar_defteri(hareket_id: str = "", tedarikci: str = "", limit: int = 100):
    """📒 Kim, ne zaman, hangi çekimi hangi tedarikçiye bağladı — append-only iz.

    Codex denetimi (2026-08-08): kart izi onayı kalıcı muhasebe etkisi yaratıyor
    ama denetim kaydı yoktu. Artık her karar deftere yazılıyor ve buradan
    okunabiliyor. Satırlar ASLA güncellenmez; düzeltme yeni satırdır (supersedes).
    """
    kos, par = ["1=1"], []
    if hareket_id.strip():
        kos.append("k.hareket_id=%s"); par.append(hareket_id.strip())
    if tedarikci.strip():
        kos.append("(k.yeni_deger ILIKE %s OR k.onceki_deger ILIKE %s)")
        par += [f"%{tedarikci.strip()}%"] * 2
    par.append(max(1, min(limit, 500)))
    with db() as (_c, cur):
        _ensure_eslesme_karar_defteri(cur)
        cur.execute(
            f"""SELECT k.id, k.hareket_id, k.onceki_deger, k.yeni_deger, k.karar,
                       k.guven, k.dayanak, k.aktor, k.supersedes,
                       k.tutar::float AS tutar, k.hareket_tarih::text AS hareket_tarih,
                       k.ts::text AS ts,
                       LEFT(COALESCE(h.aciklama,''),60) AS hareket_aciklama
                FROM cari_eslesme_karar k
                LEFT JOIN kart_hareketleri h ON h.id = k.hareket_id
                WHERE {' AND '.join(kos)}
                ORDER BY k.ts DESC LIMIT %s""",  # noqa: S608 — kos sabit parça
            tuple(par))
        satirlar = [dict(r) for r in (cur.fetchall() or [])]
        cur.execute("""SELECT COUNT(*)::int AS toplam,
                              COUNT(DISTINCT hareket_id)::int AS hareket,
                              COUNT(*) FILTER (WHERE karar='bagla')::int AS bagla,
                              COUNT(*) FILTER (WHERE karar='reddet')::int AS reddet,
                              COUNT(*) FILTER (WHERE karar='geri_al')::int AS geri_al
                       FROM cari_eslesme_karar""")
        ozet = dict(cur.fetchone() or {})
    return {"ozet": ozet, "kayitlar": satirlar,
            "not": "Append-only defter — satır güncellenmez/silinmez. Bir hareketin "
                   "güncel durumu en son ts'li satırdır; 'supersedes' zinciri "
                   "geçmişi gösterir."}


@router.post("/kart-izi-geri-al")
def kart_izi_geri_al(body: KartIziOnayModel):
    """Bir eşleşme kararını GERİ ALIR — damgayı kaldırır, deftere iz bırakır.

    Karar silinmez: deftere 'geri_al' kararı YENİ SATIR olarak eklenir ve önceki
    kararı supersedes eder. Damga (kart_hareketleri.cari_tedarikci) temizlenir;
    satır yeniden aday havuzuna döner.
    """
    idler = [str(x) for x in (body.hareket_idler or []) if str(x).strip()]
    if not idler:
        raise HTTPException(400, "en az bir hareket_id gerekli")
    with db() as (conn, cur):
        _ensure_kart_izi_tablolar(cur)
        _ensure_eslesme_karar_defteri(cur)
        cur.execute(
            """SELECT id, COALESCE(cari_tedarikci,'') AS onceki,
                      tarih::text AS tarih, ABS(COALESCE(tutar,0))::float AS tutar
               FROM kart_hareketleri
               WHERE id = ANY(%s) AND cari_tedarikci IS NOT NULL""", (idler,))
        hedef = [dict(r) for r in (cur.fetchall() or [])]
        if not hedef:
            raise HTTPException(404, "Damgalı hareket bulunamadı")
        cur.execute(
            """UPDATE kart_hareketleri
                 SET cari_tedarikci=NULL, cari_onay_ts=NULL
               WHERE id = ANY(%s)""", ([h["id"] for h in hedef],))
        for h in hedef:
            _karar_yaz(cur, h["id"], h.get("onceki"), "(geri alındı)", "geri_al",
                       aktor=(body.aktor or "sahip"),
                       dayanak=(body.dayanak or "sahip kararı geri aldı"),
                       tutar=h.get("tutar"), hareket_tarih=h.get("tarih"))
        conn.commit()
    return {"ok": True, "geri_alinan": len(hedef),
            "tutar": round(sum(h["tutar"] for h in hedef), 2),
            "not": "Damga kaldırıldı, satırlar yeniden aday havuzunda. Karar "
                   "SİLİNMEDİ — deftere 'geri_al' satırı eklendi."}


@router.get("/mukerrer-fatura-denetimi")
def mukerrer_fatura_denetimi():
    """🔁 Aynı belge birden çok kez mi yüklenmiş? Ayrım FATURA NUMARASIYLA.

    Sahip (2026-08-08): "eshim 2 fatura ama diğeri aynı fatura — fatura
    numaralarını da kodlarsan ayrıştırsın."

    Aynı tutar + aynı tarih MÜKERRER DEMEK DEĞİLDİR: AGİT SEFA'nın 6916/6917/
    6918 numaralı üç faturası aynı gün aynı tutarda ama üç ayrı belge (üç
    şubeye kesilmiş). Mükerrerlik ancak NUMARA aynıysa vardır.

    İki liste döner:
      · mukerrer   — numara aynı, birden çok kayıt (borç fazladan sayılıyor)
      · kardes     — tutar+tarih aynı ama numara farklı (mükerrer DEĞİL, bilgi)
    """
    with db() as (_c, cur):
        _ensure_tablolar(cur)
        # Numara aynı → gerçek mükerrer ('kopya' zaten işaretliyse ayrı gösterilir
        cur.execute(
            """SELECT UPPER(REGEXP_REPLACE(COALESCE(fatura_no,''),'[^A-Za-z0-9]','','g')) AS n,
                      COUNT(*)::int AS adet,
                      COUNT(*) FILTER (WHERE COALESCE(durum,'')='kopya')::int AS kopya_isaretli,
                      MIN(tedarikci_ad) AS tedarikci,
                      MAX(COALESCE(toplam_tutar,0))::float AS tutar,
                      MIN(fatura_tarih)::text AS tarih,
                      ARRAY_AGG(id::text) AS idler
               FROM tedarikci_fatura
               WHERE LENGTH(REGEXP_REPLACE(COALESCE(fatura_no,''),'[^A-Za-z0-9]','','g')) >= 8
               GROUP BY 1 HAVING COUNT(*) > 1
               ORDER BY MAX(COALESCE(toplam_tutar,0)) DESC"""
        )
        mukerrer = [dict(r) for r in (cur.fetchall() or [])]
        # Tutar+tarih aynı, numara FARKLI → kardeş faturalar (mükerrer değil)
        cur.execute(
            """SELECT tedarikci_ad, fatura_tarih::text AS tarih,
                      COALESCE(toplam_tutar,0)::float AS tutar,
                      COUNT(*)::int AS adet,
                      COUNT(DISTINCT UPPER(REGEXP_REPLACE(COALESCE(fatura_no,''),
                            '[^A-Za-z0-9]','','g')))::int AS farkli_no,
                      ARRAY_AGG(fatura_no) AS nolar
               FROM tedarikci_fatura
               WHERE COALESCE(durum,'') <> 'kopya' AND COALESCE(toplam_tutar,0) > 0
               GROUP BY 1,2,3 HAVING COUNT(*) > 1
               ORDER BY COALESCE(toplam_tutar,0) * COUNT(*) DESC LIMIT 40"""
        )
        kardes = [dict(r) for r in (cur.fetchall() or [])]
    gercek_mukerrer = [m for m in mukerrer if m["adet"] - m["kopya_isaretli"] > 1]
    return {
        "mukerrer_numara_grubu": len(mukerrer),
        "isaretlenmemis_mukerrer": len(gercek_mukerrer),
        "fazla_sayilan_tutar": round(sum(m["tutar"] * (m["adet"] - m["kopya_isaretli"] - 1)
                                         for m in gercek_mukerrer), 2),
        "mukerrer": mukerrer[:40],
        "kardes_faturalar": [{**k, "yorum": ("✅ Ayrı faturalar — numaraları farklı"
                                             if k["farkli_no"] == k["adet"]
                                             else "⚠️ Bazı numaralar aynı — incelenmeli")}
                             for k in kardes],
        "not": "Mükerrerlik ölçüsü NUMARADIR. 'kardes_faturalar' aynı tutar+tarihli ama "
               "numaraları farklı belgelerdir — bunlar ayrı borçtur, birleştirilmez.",
    }


@router.post("/odenmis-damga-temizle")
def odenmis_damga_temizle(kuru: int = 1):
    """Yanlış '(odenmis)' damgalarını kaldırır ve faturayı borç kuyruğuna alır.

    kuru=1 (varsayılan) → hiçbir şey yazmaz, ne olacağını gösterir.
    kuru=0              → damgayı siler ve motoru YENİDEN çalıştırır (düzeltilmiş
                          fren artık tedarikçi adını da şart koşar, yani gerçekten
                          ödenmişse yeniden aynı damgayı basar).

    Yalnız denetimin riskli bulduğu satırlara dokunur (iz_baska_tedarikci /
    iz_paylasimli / iz_bulunamadi). 'iz_uyusuyor' olanlara DOKUNMAZ.
    """
    denetim = odenmis_sayilan_denetimi()
    hedef = [s for s in denetim["satirlar"]
             if s["hal"] in ("iz_baska_tedarikci", "iz_tekil_degil", "iz_bulunamadi")]
    if kuru:
        return {
            "kuru_calistirma": True, "etkilenecek": len(hedef),
            "borca_donecek_tutar": round(sum(s["tutar"] for s in hedef), 2),
            "satirlar": [{"tedarikci": s["tedarikci"], "tarih": s["tarih"],
                          "tutar": s["tutar"], "hal": s["hal"]} for s in hedef],
            "not": "Hiçbir şey yazılmadı. Uygulamak için ?kuru=0 ile çağır.",
        }
    sonuclar = []
    for s in hedef:
        try:
            with db() as (conn, cur):
                cur.execute("UPDATE tedarikci_fatura SET kuyruk_vadeli_id=NULL WHERE id=%s",
                            (s["fatura_id"],))
                conn.commit()
            durum = _fatura_kuyruk_uret(s["fatura_id"])
        except Exception as e:  # noqa: BLE001
            durum = f"hata: {str(e)[:80]}"
        sonuclar.append({"tedarikci": s["tedarikci"], "tutar": s["tutar"],
                         "onceki_hal": s["hal"], "yeni_durum": durum})
    return {
        "kuru_calistirma": False, "islenen": len(sonuclar),
        "sonuclar": sonuclar,
        "not": "Damga silindi, motor düzeltilmiş frenle yeniden çalıştı. "
               "'zaten_odenmis' dönenlerde iz gerçekten tedarikçiyle eşleşmiş demektir.",
    }


@router.get("/odenmis-sayilan-denetimi")
def odenmis_sayilan_denetimi():
    """🔍 'Ödenmiş' sayılıp borç listesinden düşen faturaların izi DOĞRU MU?

    Sahip sorusu (2026-08-08): "ödeme yapılınca düşüyor mu, kapatabiliyor mu?"
    Motor bir faturayı kuyruğa almazken '(odenmis)' damgası basıyor. O fren
    yalnız TUTAR + TARİH bakıyor — TEDARİKÇİYE BAKMIYOR. Sonuç:
      · Aynı tutarlı 3 fatura (AGİT SEFA 1.101 ₺ ×3) tek ödemeyle kapanabilir
      · Başka bir tedarikçiye yapılan ödeme bu faturayı kapatabilir
    Bu uç her damgayı yeniden sınar ve izin tedarikçiyle uyuşup uyuşmadığını
    söyler. HÜKÜM YOK — damgayı kaldırmaz, listeler.
    """
    sonuc, ozet = [], {"iz_uyusuyor": 0, "iz_baska_tedarikci": 0,
                       "iz_bulunamadi": 0, "iz_tekil_degil": 0, "mukerrer_kayit": 0}
    with db() as (_c, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """SELECT id, tedarikci_ad, fatura_no, fatura_tarih::text AS ftarih,
                      COALESCE(toplam_tutar,0)::float AS tutar
               FROM tedarikci_fatura
               WHERE kuyruk_vadeli_id = '(odenmis)' AND COALESCE(durum,'') <> 'kopya'
               ORDER BY fatura_tarih DESC NULLS LAST"""
        )
        faturalar = [dict(r) for r in (cur.fetchall() or [])]

        # ── AYRIŞTIRMA: FATURA NUMARASI (sahip 2026-08-08: "eshim 2 fatura ama
        # diğeri aynı fatura — fatura numaralarını da kodlarsan ayrıştırsın").
        # Aynı tutar+tarih MÜKERRER DEMEK DEĞİL. Kanıt numaradadır:
        #   · Numaralar FARKLI  → ayrı faturalar (AGİT 6916/6917/6918 ardışık,
        #     aynı gün üç şubeye kesilmiş) → her biri ayrı borç
        #   · Numara AYNI       → mükerrer kayıt → borç bir kez sayılır
        # Not: tek bir ödeme izi bu ayrı faturaların HEPSİNİ birden kapatamaz —
        # o ayrı bir kusur ("iz_tekil_degil"), mükerrerlik değil.
        def _no_norm(s):
            return re.sub(r"[^A-Za-z0-9]", "", str(s or "")).upper()

        imza_sayac: Dict[str, int] = {}      # tutar+tarih (iz paylaşımı ölçüsü)
        no_sayac: Dict[str, int] = {}        # normalize fatura no (mükerrerlik ölçüsü)
        for f in faturalar:
            imza = f"{round(float(f['tutar'] or 0), 2)}|{(f.get('ftarih') or '')[:10]}"
            imza_sayac[imza] = imza_sayac.get(imza, 0) + 1
            n = _no_norm(f.get("fatura_no"))
            if len(n) >= 8:
                no_sayac[n] = no_sayac.get(n, 0) + 1

        for f in faturalar:
            tut = float(f.get("tutar") or 0)
            ftarih = (f.get("ftarih") or "")[:10] or date.today().isoformat()
            ted = (f.get("tedarikci_ad") or "").strip()
            # Motorun bulduğu izlerin AYNISI — ama bu kez açıklamasıyla
            cur.execute(
                """SELECT * FROM (
                     SELECT 'vadeli' AS kanal, vade_tarihi AS t, tutar,
                            COALESCE(aciklama,'') || ' ' || COALESCE(tedarikci,'') AS metin
                     FROM vadeli_alimlar WHERE durum='odendi'
                     UNION ALL
                     SELECT 'anlik_gider', tarih, tutar,
                            COALESCE(aciklama,'') || ' ' || COALESCE(tedarikci,'')
                     FROM anlik_giderler WHERE durum='aktif' AND kaynak_id IS NULL
                     UNION ALL
                     SELECT 'kart', tarih, tutar, COALESCE(aciklama,'')
                     FROM kart_hareketleri
                     WHERE islem_turu='HARCAMA' AND durum='aktif' AND kaynak_id IS NULL
                       AND COALESCE(harcama_tipi,'belirsiz') <> 'sahsi') x
                   WHERE ABS(x.tutar - %s) <= GREATEST(5, %s * 0.02)
                     AND x.t BETWEEN %s::date - 10 AND %s::date + 90
                   ORDER BY x.t LIMIT 5""",
                (tut, tut, ftarih, ftarih),
            )
            izler = [dict(r) for r in (cur.fetchall() or [])]
            uyusan = [i for i in izler if ted and _odeme_eslesir(ted, i.get("metin") or "")]
            imza = f"{round(tut, 2)}|{ftarih}"
            _no = _no_norm(f.get("fatura_no"))
            kardes = imza_sayac.get(imza, 1)          # aynı tutar+tarihli fatura sayısı
            mukerrer = no_sayac.get(_no, 0) if len(_no) >= 8 else 0

            if not izler:
                hal, ne = "iz_bulunamadi", "Damga var ama iz yok — borç listesine GERİ ALINMALI"
            elif uyusan:
                hal = "iz_uyusuyor"
                ne = "İz bu tedarikçiye ait görünüyor — damga makul"
            else:
                hal = "iz_baska_tedarikci"
                ne = ("İz BAŞKA bir ödemeye ait olabilir (tedarikçi adı eşleşmiyor) — "
                      "borç yanlışlıkla kapanmış olabilir")
            # Numara AYNI ise gerçek mükerrerlik (borç bir kez sayılmalı)
            if mukerrer > 1:
                hal = "mukerrer_kayit"
                ne = (f"🔁 Aynı fatura numarası ({f.get('fatura_no')}) {mukerrer} kayıtta — "
                      f"aynı belge birden çok yüklenmiş; fazlası 'kopya' işaretlenmeli")
            # Numaralar FARKLI ama tek iz hepsini kapatmış → mükerrerlik DEĞİL,
            # izin tekil tüketilmemesi kusuru
            elif kardes > 1 and hal != "iz_bulunamadi":
                hal = "iz_tekil_degil"
                ne = (f"⚠️ Aynı tutar+tarihte {kardes} AYRI fatura var (numaraları farklı) — "
                      f"tek ödeme izi hepsini birden kapatamaz; en fazla birini kapatır")
            ozet[hal] = ozet.get(hal, 0) + 1
            sonuc.append({
                "fatura_id": f["id"], "tedarikci": ted, "fatura_no": f.get("fatura_no"),
                "tarih": f.get("ftarih"), "tutar": round(tut, 2),
                "hal": hal, "ne_demek": ne,
                "ayni_imzali_fatura": kardes,        # aynı tutar+tarih (ayrı olabilir)
                "ayni_numarali_kayit": mukerrer,     # aynı fatura no (gerçek mükerrer)
                "bulunan_iz": [{"kanal": i["kanal"], "tarih": str(i["t"]),
                                "tutar": float(i["tutar"] or 0),
                                "metin": (i.get("metin") or "")[:70]} for i in izler[:3]],
            })
    riskli = round(sum(s["tutar"] for s in sonuc
                       if s["hal"] in ("iz_baska_tedarikci", "iz_bulunamadi",
                                       "iz_tekil_degil")), 2)
    return {
        "damgali_fatura": len(sonuc), "ozet": ozet,
        "riskli_tutar": riskli,
        "mukerrer_tutar": round(sum(s["tutar"] for s in sonuc
                                    if s["hal"] == "mukerrer_kayit"), 2),
        "satirlar": sonuc,
        "not": "Hüküm YOK — damga kaldırılmadı. AYRIM FATURA NUMARASIYLA yapılır: "
               "aynı tutar+tarih mükerrer demek değil (ardışık numaralı ayrı faturalar "
               "aynı gün kesilebilir); mükerrerlik ancak NUMARA aynıysa vardır. "
               "'iz_tekil_degil' = tek ödeme birden çok ayrı faturayı kapatmış. "
               "'mukerrer_kayit' = aynı belge birden çok yüklenmiş.",
    }


@router.get("/kuyruk-bosluk-teshisi")
def kuyruk_bosluk_teshisi():
    """🕳 'Bu fatura neden borç listemde yok?' — fatura fatura sebep.

    Röntgen 26 faturanın (718.623 ₺) kuyruğa hiç girmediğini gösterdi. Motor
    atlarken bazı hallerde kolonu damgalamıyor (okunmamış/kimliksiz/sıfır) —
    o yüzden 'neden' kayıtta yok. Bu uç sebebi KURU ÇALIŞTIRMA ile üretir:
    hiçbir şey yazmaz, sadece motorun aynı frenlerini sırayla dener.
    """
    sebep_sayac: Dict[str, Dict[str, Any]] = {}
    satirlar = []
    with db() as (_c, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """SELECT id, tedarikci_ad, fatura_no, fatura_tarih::text AS ftarih,
                      COALESCE(toplam_tutar,0)::float AS tutar, durum,
                      kuyruk_vadeli_id, belge_sinifi
               FROM tedarikci_fatura
               WHERE COALESCE(durum,'') <> 'kopya'
               ORDER BY COALESCE(fatura_tarih, olusturma::date) DESC"""
        )
        for r in (cur.fetchall() or []):
            f = dict(r)
            kv = f.get("kuyruk_vadeli_id")
            # Motorun fren sırası — aynısı, ama hüküm yazmadan
            if kv == "(arsiv)":
                sebep = "arsiv_sistem_oncesi"
            elif kv == "(odenmis)":
                sebep = "zaten_odenmis_sayildi"
            elif kv:
                sebep = "borca_donmus"
            elif (f.get("durum") or "") not in ("ocr_tamam", "okundu"):
                sebep = "okunmamis"           # OCR bitmemiş / hata almış
            elif (f.get("tutar") or 0) <= 0:
                sebep = "tutar_sifir_veya_negatif"
            elif len((f.get("tedarikci_ad") or "").strip()) < 3:
                sebep = "tedarikci_kimliksiz"
            elif (f.get("ftarih") or "")[:10] and (f["ftarih"] or "")[:10] < EVVEL_SISTEM_BASLANGIC:
                sebep = "arsiv_damgalanmamis"  # tarih eski ama damga basılmamış
            else:
                sebep = "motor_hic_calismamis"  # tüm frenleri geçiyor ama kuyrukta yok
            b = sebep_sayac.setdefault(sebep, {"adet": 0, "tutar": 0.0})
            b["adet"] += 1
            b["tutar"] = round(b["tutar"] + float(f.get("tutar") or 0), 2)
            if sebep not in ("borca_donmus", "arsiv_sistem_oncesi"):
                satirlar.append({
                    "fatura_id": f["id"], "tedarikci": f.get("tedarikci_ad"),
                    "fatura_no": f.get("fatura_no"), "tarih": f.get("ftarih"),
                    "tutar": f.get("tutar"), "durum": f.get("durum"),
                    "sebep": sebep,
                })
    aciklama = {
        "borca_donmus": "✅ Kuyrukta — borç listesinde görünüyor",
        "arsiv_sistem_oncesi": "📜 Sistem başlangıcı öncesi — açılış devrine dahil",
        "arsiv_damgalanmamis": "📜 Tarihi eski ama damgası yok — devre dahil mi belirsiz",
        "zaten_odenmis_sayildi": "💸 Ödeme izi bulundu, kuyruğa alınmadı — İZ DOĞRU MU?",
        "okunmamis": "⏳ OCR bitmemiş/hata — tutar bilinmediği için borç yazılamadı",
        "tutar_sifir_veya_negatif": "0️⃣ Tutar okunamamış ya da alacak dekontu",
        "tedarikci_kimliksiz": "❓ Tedarikçi adı çıkmamış — kime borç belli değil",
        "motor_hic_calismamis": "⚠️ Tüm frenleri geçiyor ama kuyrukta yok — motor bu "
                                "faturaya hiç çalışmamış (retro tarama gerekir)",
    }
    return {
        "kirilim": [{"sebep": k, "adet": v["adet"], "tutar": v["tutar"],
                     "aciklama": aciklama.get(k, k)}
                    for k, v in sorted(sebep_sayac.items(), key=lambda x: -x[1]["tutar"])],
        "borc_disi_toplam": round(sum(v["tutar"] for k, v in sebep_sayac.items()
                                      if k not in ("borca_donmus", "arsiv_sistem_oncesi")), 2),
        "satirlar": satirlar[:80],
        "not": "Kuru çalıştırma — hiçbir şey yazılmadı. 'motor_hic_calismamis' "
               "satırları POST /api/fatura/kuyruk-retro-tarama ile kuyruğa alınabilir.",
    }


@router.post("/temizlik/mukerrer-fatura")
def temizlik_mukerrer_fatura(kuru: int = 1):
    """Aynı fatura numarasından birden çok AKTİF kayıt varsa fazlasını 'kopya' yapar.

    En eski kayıt (ilk yüklenen) ASIL sayılır; sonrakiler kopya işaretlenir.
    Kopya kaydı SİLİNMEZ — yasal arşiv olarak durur, sadece cari/kapsama/borç
    hesaplarına girmez (mevcut 'kopya' davranışı).
    """
    islem = []
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """SELECT UPPER(REGEXP_REPLACE(COALESCE(fatura_no,''),'[^A-Za-z0-9]','','g')) AS n,
                      ARRAY_AGG(id::text ORDER BY olusturma) AS idler,
                      ARRAY_AGG(COALESCE(tedarikci_ad,'') ORDER BY olusturma) AS adlar,
                      MAX(COALESCE(toplam_tutar,0))::float AS tutar,
                      COUNT(*)::int AS adet
               FROM tedarikci_fatura
               WHERE LENGTH(REGEXP_REPLACE(COALESCE(fatura_no,''),'[^A-Za-z0-9]','','g')) >= 8
                 AND COALESCE(durum,'') <> 'kopya'
               GROUP BY 1 HAVING COUNT(*) > 1"""
        )
        for r in (cur.fetchall() or []):
            idler = list(r["idler"] or [])
            asil, fazlalar = idler[0], idler[1:]
            islem.append({"fatura_no": r["n"], "tedarikci": (r["adlar"] or [""])[0],
                          "tutar": r["tutar"], "toplam_kayit": r["adet"],
                          "asil_kalan": asil, "kopya_yapilacak": fazlalar,
                          "fazla_sayilan": round(float(r["tutar"] or 0) * len(fazlalar), 2)})
            if not kuru and fazlalar:
                cur.execute(
                    "UPDATE tedarikci_fatura SET durum='kopya' WHERE id = ANY(%s)", (fazlalar,))
        if not kuru:
            conn.commit()
    return {"kuru_calistirma": bool(kuru), "grup": len(islem),
            "kopya_yapilacak_satir": sum(len(i["kopya_yapilacak"]) for i in islem),
            "fazla_sayilan_toplam": round(sum(i["fazla_sayilan"] for i in islem), 2),
            "islemler": islem,
            "not": "En eski kayıt asıl kalır. Kopya SİLİNMEZ — arşivde durur, "
                   "hesaplara girmez. Uygulamak için ?kuru=0"}


@router.post("/temizlik/belirsiz-harcama")
def temizlik_belirsiz_harcama(kuru: int = 1):
    """Sistem kaydından doğmuş 'belirsiz' kart harcamalarını 'isletme' damgalar.

    Bir kart satırı vadeli alım / anlık gider / sabit gider kaydından doğmuşsa
    tanım gereği İŞLETME harcamasıdır — o kayıt zaten işletme defterinde.
    Ham banka satırlarına (ekstre_import) DOKUNULMAZ; onlar sahip kararıdır.
    """
    hedef = []
    with db() as (conn, cur):
        cur.execute(
            """SELECT id, tarih::text AS tarih, ABS(COALESCE(tutar,0))::float AS tutar,
                      LEFT(COALESCE(aciklama,''),70) AS aciklama, kaynak_tablo
               FROM kart_hareketleri
               WHERE islem_turu='HARCAMA' AND COALESCE(durum,'aktif')='aktif'
                 AND COALESCE(harcama_tipi,'belirsiz')='belirsiz'
                 AND COALESCE(kaynak_tablo,'') IN
                     ('vadeli_alimlar','anlik_giderler','sabit_giderler')
               ORDER BY ABS(COALESCE(tutar,0)) DESC"""
        )
        hedef = [dict(r) for r in (cur.fetchall() or [])]
        if not kuru and hedef:
            cur.execute("UPDATE kart_hareketleri SET harcama_tipi='isletme' WHERE id = ANY(%s)",
                        ([h["id"] for h in hedef],))
            conn.commit()
    return {"kuru_calistirma": bool(kuru), "damgalanacak": len(hedef),
            "tutar": round(sum(h["tutar"] for h in hedef), 2),
            "satirlar": hedef[:40],
            "not": "Yalnız sistem kaydından doğmuş satırlar. Ham banka satırları "
                   "(ekstre_import) sahip kararına bırakıldı. Uygulamak için ?kuru=0"}


@router.post("/temizlik/mukerrer-plan")
def temizlik_mukerrer_plan(kuru: int = 1):
    """Aynı gün + aynı tutar + aynı açıklamalı FAZLA ödeme planı satırlarını iptal eder.

    ⚠️ EN RİSKLİ TEMİZLİK — bu yüzden önce PARA İZİ kontrol edilir: fazla satırın
    kasa/kart hareketi varsa DOKUNULMAZ (gerçekten iki ayrı ödeme olabilir),
    yalnız para izi OLMAYAN fazlalar iptal edilir. İptal = durum='iptal';
    satır silinmez, denetim izi korunur.
    """
    # ── ASIL SEÇİMİ: "gerçekten ödenmiş olan" satır korunur ────────────────────
    # Bir plan satırı odeme_yap'tan geçtiyse arkasında ÖDEME İZİ bırakır:
    #   · kart_hareketleri.id = 'odm_<plan_id>'  (kart ODEME kaydı)
    #   · kasa_hareketleri.kaynak_id / ref_id = plan_id  (nakit)
    # İzi OLAN satır asıldır — dokunulmaz. İzi olmayan fazlalar, ekstre birden
    # çok kez işlendiği için doğmuş kayıt kirliliğidir (üç ayrı üretici var:
    # kasa_service "Kart ekstre:", manuel giriş "Kart ekstresi (manuel):",
    # otomatik "Kart:"). Grupta HİÇ izli satır yoksa en eskisi korunur —
    # "ödendi" bilgisi tümden kaybolmasın.
    guvenli, riskli = [], []
    with db() as (conn, cur):
        # ÖNCE ÖDENMEMİŞLER: aynı gruptaki satırlardan 'odendi' olan ASIL kabul
        # edilir (para o satırdan çıkmış olabilir), fazlalar bekleyenlerden seçilir.
        cur.execute(
            """SELECT aciklama, odenecek_tutar::float AS tutar, tarih::text AS tarih,
                      ARRAY_AGG(id::text ORDER BY
                                CASE WHEN durum='odendi' THEN 0 ELSE 1 END, olusturma) AS idler,
                      ARRAY_AGG(durum ORDER BY
                                CASE WHEN durum='odendi' THEN 0 ELSE 1 END, olusturma) AS durumlar,
                      COUNT(*)::int AS adet
               FROM odeme_plani
               WHERE COALESCE(durum,'') <> 'iptal'
               GROUP BY 1,2,3 HAVING COUNT(*) > 1"""
        )
        gruplar = [dict(r) for r in (cur.fetchall() or [])]
        def _plan_izi(pid_):
            """Bu plan satırının ARKASINDA gerçek para hareketi var mı? (plan-spesifik)
            kasa.kaynak_id · kasa.ref_id · kart 'odm_<plan_id>' — üçü de plan
            kimliğine bağlıdır, grup içindeki satırları birbirinden AYIRT EDER."""
            cur.execute(
                """SELECT COUNT(*)::int AS n FROM (
                     SELECT 1 FROM kasa_hareketleri
                     WHERE COALESCE(durum,'aktif')='aktif'
                       AND ((kaynak_tablo='odeme_plani' AND kaynak_id=%s) OR ref_id=%s)
                     UNION ALL
                     SELECT 1 FROM kart_hareketleri
                     WHERE COALESCE(durum,'aktif')='aktif'
                       AND ((kaynak_tablo='odeme_plani' AND kaynak_id=%s) OR id=%s)) x""",
                (pid_, pid_, pid_, f"odm_{pid_}"))
            return int((cur.fetchone() or {}).get("n") or 0)

        for g in gruplar:
            idler = list(g["idler"] or [])
            durumlar = list(g["durumlar"] or [])
            g["durum_dagilimi"] = {d: durumlar.count(d) for d in set(durumlar)}
            _durum_h = dict(zip(idler, durumlar))
            # HER satırda iz ara — sadece "fazlalarda" değil. İzi olan satır
            # gerçekten ödenmiştir ve ASILDIR; izsizler ekstre birden çok kez
            # işlendiği için doğmuş kayıt kirliliğidir.
            izli = [i for i in idler if _plan_izi(i) > 0]
            izsiz = [i for i in idler if i not in izli]
            if izli:
                korunan, adaylar = izli, izsiz
                gerekce = f"{len(izli)} satırın para izi var — onlar asıl, izsizler mükerrer"
            else:
                # Grupta hiç izli satır yok: en eski korunur ki "ödendi" bilgisi
                # tümden kaybolmasın; gerisi kayıt kirliliği sayılır.
                korunan, adaylar = idler[:1], idler[1:]
                gerekce = "Hiçbirinin izi yok — en eski satır korunur, fazlalar temizlenir"
            g["korunan"] = korunan
            for fid in adaylar:
                guvenli.append({
                    "plan_id": fid, "asil_kalan": korunan[0] if korunan else None,
                    "tarih": g["tarih"], "tutar": g["tutar"],
                    "aciklama": (g["aciklama"] or "")[:60],
                    "para_izi": 0, "durum": _durum_h.get(fid, "?"),
                    "grup_durumlari": g.get("durum_dagilimi"),
                    "grup_toplam_satir": len(idler), "korunan_satir": len(korunan),
                    "gerekce": gerekce,
                })
            for fid in korunan:
                riskli.append({
                    "plan_id": fid, "tarih": g["tarih"], "tutar": g["tutar"],
                    "aciklama": (g["aciklama"] or "")[:60],
                    "para_izi": 1 if fid in izli else 0,
                    "durum": _durum_h.get(fid, "?"),
                    "neden": ("Para izi VAR — gerçek ödeme, korunur" if fid in izli
                              else "İz yok ama grubun en eskisi — 'ödendi' bilgisi korunsun diye tutuldu"),
                })
        if not kuru and guvenli:
            # İPTAL + DENETİM NOTU: satır silinmez, hangi kayda mükerrer olduğu
            # açıklamaya yazılır — geri dönüp bakılabilsin.
            for x in guvenli:
                cur.execute(
                    """UPDATE odeme_plani
                         SET durum='iptal',
                             aciklama = LEFT(COALESCE(aciklama,'') ||
                                        ' [MÜKERRER — asıl: ' || COALESCE(%s,'?') || ']', 400)
                       WHERE id=%s""",
                    (x.get("asil_kalan"), x["plan_id"]))
            conn.commit()
    return {
        "kuru_calistirma": bool(kuru),
        "grup": len(gruplar),
        "iptal_edilecek": len(guvenli),
        "iptal_tutari": round(sum(g["tutar"] for g in guvenli), 2),
        "dokunulmayan_riskli": len(riskli),
        "riskli_tutar": round(sum(r["tutar"] for r in riskli), 2),
        "guvenli": guvenli[:40], "riskli": riskli[:40],
        "not": "Para izi OLAN fazla satırlara dokunulmaz — iki gerçek ödeme olabilir. "
               "İptal edilen satır silinmez, durum='iptal' olur. Uygulamak için ?kuru=0",
    }


@router.get("/kasa-izi-genis-arama")
def kasa_izi_genis_arama():
    """🔎 'Ödendi' damgalı ama izsiz görünen satırların izini HER ANAHTARLA arar.

    Sahip (2026-08-08): "kasa izi bulamıyor olman — kira ödemelerinde kasa izi
    bırakıp bırakmadıklarını kontrol et!"

    Dar arama (kaynak_tablo='odeme_plani') iz bulamadı. Ama ödeme kasaya BAŞKA
    anahtarla da yazılmış olabilir. Bu uç 5 yolu ayrı ayrı dener ve HANGİ yolun
    tuttuğunu söyler — hüküm yok, sadece gerçek.

    Yollar:
      A) kasa.kaynak_tablo='odeme_plani' AND kaynak_id=plan_id
      B) kasa.ref_id = plan_id
      C) kasa.kaynak_tablo=plan.kaynak_tablo AND kaynak_id=plan.kaynak_id
         (sabit_giderler + gider_id — 2026-07-05 FIX O1 deseni)
      D) kart.kaynak/'odm_' anahtarları
      E) SERBEST: aynı ay + aynı tutar (±5 ₺) herhangi bir kasa çıkışı
    """
    sonuc, ozet = [], {"A": 0, "B": 0, "C": 0, "D": 0, "D2": 0, "E": 0, "HIC": 0}
    with db() as (_c, cur):
        cur.execute(
            """SELECT id, LEFT(COALESCE(aciklama,''),56) AS aciklama, tarih::text AS tarih,
                      odenecek_tutar::float AS borc, COALESCE(kaynak_tablo,'') AS kt,
                      kaynak_id AS ki
               FROM odeme_plani
               WHERE durum='odendi' AND COALESCE(odenen_tutar,0) <= 0.01
                 AND COALESCE(aciklama,'') NOT ILIKE '%%kart%%'
               ORDER BY odenecek_tutar DESC"""
        )
        for r in (cur.fetchall() or []):
            p = dict(r)
            pid, borc = str(p["id"]), float(p["borc"] or 0)
            bulgu = {"yol": None, "tutar": 0.0, "detay": None}

            def _tek(sql, params, yol, aciklama):
                if bulgu["yol"]:
                    return
                cur.execute(sql, params)
                row = cur.fetchone()
                if row and float(row.get("t") or 0) > 0.01:
                    bulgu.update({"yol": yol, "tutar": round(float(row["t"]), 2),
                                  "detay": aciklama})

            _tek("""SELECT COALESCE(SUM(ABS(tutar)),0)::float AS t FROM kasa_hareketleri
                    WHERE kaynak_tablo='odeme_plani' AND kaynak_id=%s
                      AND COALESCE(durum,'aktif')='aktif'""",
                 (pid,), "A", "kasa: kaynak_tablo=odeme_plani")
            _tek("""SELECT COALESCE(SUM(ABS(tutar)),0)::float AS t FROM kasa_hareketleri
                    WHERE ref_id=%s AND COALESCE(durum,'aktif')='aktif'""",
                 (pid,), "B", "kasa: ref_id=plan_id")
            if p["kt"] and p["ki"]:
                _tek("""SELECT COALESCE(SUM(ABS(tutar)),0)::float AS t FROM kasa_hareketleri
                        WHERE kaynak_tablo=%s AND kaynak_id=%s
                          AND COALESCE(durum,'aktif')='aktif'
                          AND DATE_TRUNC('month',tarih)=DATE_TRUNC('month',%s::date)""",
                     (p["kt"], str(p["ki"]), p["tarih"]), "C",
                     f"kasa: kaynak_tablo={p['kt']} (aynı ay)")
            _tek("""SELECT COALESCE(SUM(ABS(tutar)),0)::float AS t FROM kart_hareketleri
                    WHERE COALESCE(durum,'aktif')='aktif'
                      AND ((kaynak_tablo='odeme_plani' AND kaynak_id=%s) OR id=%s)""",
                 (pid, f"odm_{pid}"), "D", "kart hareketi (plan anahtarı)")
            # D2 — C yolunun KART karşılığı: sabit gider kartla çekilmiş olabilir.
            # "⚠️ LİMİT YETERSİZ — Manuel Öde" planı açılıyor ama aynı gider aynı ay
            # karttan çekilebiliyor (limit açılınca / otomatik talimat) → plan satırı
            # boşta kalıyor. Bu yol olmayınca 5 satır "hiç ödenmemiş" görünüyordu.
            if p["ki"]:
                # ⚠️ TABLO ADI ŞART DEĞİL, KİMLİK ŞART (2026-08-08 canlı ders):
                # aynı sabit gider kart tarafında bazen 'sabit_giderler', bazen
                # 'fatura_giderleri' etiketiyle yazılıyor — kaynak_id ise AYNI.
                # Tablo adını şart koşan sorgu 4 internet + 1 elektrik faturasını
                # "hiç ödenmemiş" gösteriyordu; hepsi karttan çekilmişti.
                _tek("""SELECT COALESCE(SUM(ABS(tutar)),0)::float AS t FROM kart_hareketleri
                        WHERE kaynak_id=%s
                          AND islem_turu='HARCAMA' AND COALESCE(durum,'aktif')='aktif'
                          AND DATE_TRUNC('month',tarih)=DATE_TRUNC('month',%s::date)""",
                     (str(p["ki"]), p["tarih"]), "D2",
                     "kart: aynı gider kimliğinden çekilmiş (aynı ay, tablo adı farklı olabilir)")
            _tek("""SELECT COALESCE(SUM(ABS(tutar)),0)::float AS t FROM kasa_hareketleri
                    WHERE COALESCE(durum,'aktif')='aktif' AND kasa_etkisi=TRUE
                      AND ABS(ABS(tutar) - %s) <= GREATEST(5, %s*0.01)
                      AND DATE_TRUNC('month',tarih)=DATE_TRUNC('month',%s::date)""",
                 (borc, borc, p["tarih"]), "E",
                 "SERBEST: aynı ay + aynı tutar kasa çıkışı (kesin değil)")

            yol = bulgu["yol"] or "HIC"
            ozet[yol] = ozet.get(yol, 0) + 1
            sonuc.append({
                "plan_id": pid, "aciklama": p["aciklama"], "tarih": p["tarih"],
                "borc": round(borc, 2), "kaynak_tablo": p["kt"],
                "bulundu_yol": yol, "bulunan_tutar": bulgu["tutar"],
                "detay": bulgu["detay"] or "Hiçbir anahtarla kasa/kart izi bulunamadı",
            })
    kesin = [s for s in sonuc if s["bulundu_yol"] in ("A", "B", "C", "D", "D2")]
    serbest = [s for s in sonuc if s["bulundu_yol"] == "E"]
    hic = [s for s in sonuc if s["bulundu_yol"] == "HIC"]
    return {
        "incelenen": len(sonuc), "yol_dagilimi": ozet,
        "kesin_iz_bulundu": {"adet": len(kesin),
                             "tutar": round(sum(s["borc"] for s in kesin), 2)},
        "serbest_eslesme": {"adet": len(serbest),
                            "tutar": round(sum(s["borc"] for s in serbest), 2),
                            "uyari": "Aynı ay + aynı tutar — KESİN DEĞİL, sahip doğrulamalı"},
        "hic_iz_yok": {"adet": len(hic), "tutar": round(sum(s["borc"] for s in hic), 2),
                       "ne_demek": "Bu satırlar için ödeme yapıldığına dair HİÇBİR kayıt yok"},
        "satirlar": sonuc,
        "not": "Hüküm YOK. 'C' yolu tutarsa ödeme kasaya kaynak tablosuyla yazılmış "
               "demektir (FIX O1 deseni) — dar arama onu kaçırıyordu.",
    }


@router.post("/temizlik/eski-fatura-arsivle")
def temizlik_eski_fatura_arsivle(esik: str = "2026-07-01", kuru: int = 1):
    """📜 Eşikten ÖNCEKİ faturaları arşive alır — sistem borç olarak GÖRMESİN.

    Sahip (2026-08-08): "faturalar temmuzdan önceyse izini kaybet, sistem
    görmesin!"

    'İZİNİ KAYBET' = ARŞİV DAMGASI, silme DEĞİL. Belge VUK 5 yıl / TTK 10 yıl
    saklanmak zorunda; kayıt yerinde durur, 'gör' dendiğinde açılır. Damga
    yalnız şunu söyler: bu fatura borç kuyruğuna GİRMEZ, ödeme planı ÜRETMEZ,
    "neden borç listemde yok?" listesinde belirsiz olarak DURMAZ.

    Bu faturaların borcu zaten AÇILIŞ DEVRİNDE sayılıdır (sahip beyanı) —
    kuyruğa da alınsalardı aynı borç İKİ KEZ görünürdü.

    ⚠️ Cari ekstre penceresi ayrı bir eşiktir (EVVEL_SISTEM_BASLANGIC); bu uç
    ONA DOKUNMAZ. Yani fatura cari hareket defterinde görünmeye devam edebilir;
    değişen şey borç kuyruğudur.
    """
    try:
        _e = date.fromisoformat(esik[:10])
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "esik formatı YYYY-AA-GG olmalı")
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """SELECT id, tedarikci_ad, fatura_no, fatura_tarih::text AS ftarih,
                      COALESCE(toplam_tutar,0)::float AS tutar,
                      COALESCE(kuyruk_vadeli_id,'') AS kv
               FROM tedarikci_fatura
               WHERE COALESCE(durum,'') <> 'kopya'
                 AND COALESCE(fatura_tarih, olusturma::date) < %s
               ORDER BY fatura_tarih DESC NULLS LAST""", (_e,))
        tum = [dict(r) for r in (cur.fetchall() or [])]
        # Zaten arşivli / kuyruğa bağlı olanlara dokunma
        hedef = [f for f in tum if f["kv"] == ""]
        bagli = [f for f in tum if f["kv"] not in ("", "(arsiv)")]
        if not kuru and hedef:
            cur.execute(
                "UPDATE tedarikci_fatura SET kuyruk_vadeli_id='(arsiv)' WHERE id = ANY(%s)",
                ([f["id"] for f in hedef],))
            conn.commit()
    return {
        "kuru_calistirma": bool(kuru), "esik": str(_e),
        "esik_oncesi_fatura": len(tum),
        "arsivlenecek": len(hedef),
        "arsivlenecek_tutar": round(sum(f["tutar"] for f in hedef), 2),
        "zaten_kuyrukta_dokunulmaz": len(bagli),
        "kuyruktaki_tutar": round(sum(f["tutar"] for f in bagli), 2),
        "ornekler": [{"tedarikci": f.get("tedarikci_ad"), "tarih": f.get("ftarih"),
                      "tutar": f["tutar"], "fatura_no": f.get("fatura_no")}
                     for f in hedef[:25]],
        "not": "Damga = borç kuyruğundan çıkarma. Belge SİLİNMEZ, arşivde durur "
               "(VUK 5 yıl / TTK 10 yıl). Borcu açılış devrinde zaten sayılı. "
               "Kuyruğa bağlı faturalara DOKUNULMAZ. Uygulamak için ?kuru=0",
    }


@router.post("/temizlik/kuyruk-retro-tarama")
def temizlik_kuyruk_retro(kuru: int = 1, limit: int = 300):
    """🔄 Motorun HİÇ dokunmadığı faturaları kuyruk motorundan geçirir.

    `_fatura_kuyruk_uret` yalnız YENİ fatura yüklendiğinde çağrılıyor. Sisteme
    eski tarihli girilmiş / OCR'ı sonradan tamamlanmış faturalara motor hiç
    çalışmamış: canlıda 16 fatura (592.907 ₺) "tarihi eski ama damgası yok"
    durumunda kalmıştı — devre dahil mi belirsiz.

    Motor kendi frenlerini uygular: sistem-öncesi tarihli olanlar '(arsiv)'
    damgalanır (borç ÜRETMEZ, açılış devrinde zaten sayılı), pencere içindekiler
    borç kuyruğuna girer, okunmamış/kimliksiz olanlar dokunulmadan kalır.

    kuru=1 → ne olacağını gösterir, hiçbir şey yazmaz.
    """
    hedef, sonuc = [], {}
    with db() as (_c, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """SELECT id, tedarikci_ad, fatura_tarih::text AS ftarih,
                      COALESCE(toplam_tutar,0)::float AS tutar, durum
               FROM tedarikci_fatura
               WHERE kuyruk_vadeli_id IS NULL
                 AND COALESCE(durum,'') <> 'kopya'
               ORDER BY COALESCE(fatura_tarih, olusturma::date) DESC
               LIMIT %s""", (limit,))
        hedef = [dict(r) for r in (cur.fetchall() or [])]
    if kuru:
        # Kuru çalıştırmada motoru ÇAĞIRMA — sadece ne olacağını tahmin et
        for f in hedef:
            ft = (f.get("ftarih") or "")[:10]
            if (f.get("durum") or "") not in ("ocr_tamam", "okundu"):
                b = "dokunulmaz_okunmamis"
            elif (f.get("tutar") or 0) <= 0:
                b = "dokunulmaz_tutarsiz"
            elif len((f.get("tedarikci_ad") or "").strip()) < 3:
                b = "dokunulmaz_kimliksiz"
            elif ft and ft < EVVEL_SISTEM_BASLANGIC:
                b = "arsiv_damgalanacak"
            else:
                b = "kuyruga_girecek"
            sonuc[b] = sonuc.get(b, {"adet": 0, "tutar": 0.0})
            sonuc[b]["adet"] += 1
            sonuc[b]["tutar"] = round(sonuc[b]["tutar"] + float(f.get("tutar") or 0), 2)
        return {"kuru_calistirma": True, "incelenen": len(hedef), "tahmin": sonuc,
                "not": "Motor ÇAĞRILMADI. 'arsiv_damgalanacak' borç ÜRETMEZ — "
                       "yalnız damga basılır (açılış devrinde zaten sayılı). "
                       "Uygulamak için ?kuru=0"}
    for f in hedef:
        try:
            d = _fatura_kuyruk_uret(f["id"])
        except Exception as e:  # noqa: BLE001 — biri patlarsa diğerleri sürsün
            d = f"hata: {str(e)[:70]}"
        s = sonuc.setdefault(d, {"adet": 0, "tutar": 0.0})
        s["adet"] += 1
        s["tutar"] = round(s["tutar"] + float(f.get("tutar") or 0), 2)
    return {"kuru_calistirma": False, "islenen": len(hedef), "sonuc": sonuc,
            "not": "Motor kendi frenleriyle çalıştı. 'atlandi_arsiv' = damga basıldı, "
                   "borç üretilmedi; 'uretildi' = borç kuyruğuna girdi."}


@router.post("/temizlik/kart-donem-tekillestir")
def temizlik_kart_donem(kuru: int = 1):
    """💳 Aynı kart + aynı DÖNEM için tek plan satırı bırakır (kök neden kapatma).

    Sahip (2026-08-08): "kök nedeni kapat". Kod tarafında tek yazıcı kuruldu,
    DB emniyet ağı (partial unique index) hazır — ama GEÇMİŞTEKİ ihlaller
    temizlenmeden index kurulamıyor.

    Bir kart ekstresi dönemi (kart_id + referans_ay) için tek plan olmalıdır.
    HANGİSİ KALIR:
      1. 'odendi' satır varsa O kalır — para çıkmış, bilgisi kaybolmamalı
      2. Hepsi bekliyorsa EN YENİSİ kalır — güncel ekstre odur
    Diğerleri 'iptal' + açıklamaya denetim notu. Hiçbir satır SİLİNMEZ.
    Uygulama sonrası tekillik indeksi kurulmayı dener.
    """
    islem, korunan_ozet = [], []
    with db() as (conn, cur):
        cur.execute(
            """SELECT kart_id, referans_ay::text AS donem,
                      ARRAY_AGG(id::text ORDER BY
                          CASE WHEN durum='odendi' THEN 0 ELSE 1 END, olusturma DESC) AS idler,
                      ARRAY_AGG(durum ORDER BY
                          CASE WHEN durum='odendi' THEN 0 ELSE 1 END, olusturma DESC) AS durumlar,
                      ARRAY_AGG(COALESCE(odenecek_tutar,0)::float ORDER BY
                          CASE WHEN durum='odendi' THEN 0 ELSE 1 END, olusturma DESC) AS tutarlar,
                      ARRAY_AGG(LEFT(COALESCE(aciklama,''),44) ORDER BY
                          CASE WHEN durum='odendi' THEN 0 ELSE 1 END, olusturma DESC) AS aciklamalar
               FROM odeme_plani
               WHERE kart_id IS NOT NULL AND referans_ay IS NOT NULL
                 AND kaynak_tablo IS NULL          -- YALNIZ kart EKSTRESİ planları
                 AND COALESCE(durum,'') <> 'iptal'
               GROUP BY 1,2 HAVING COUNT(*) > 1
               ORDER BY 2"""
        )
        for r in (cur.fetchall() or []):
            g = dict(r)
            idler = list(g["idler"] or [])
            durumlar = list(g["durumlar"] or [])
            tutarlar = list(g["tutarlar"] or [])
            aciklamalar = list(g["aciklamalar"] or [])
            # Sıralama zaten 'odendi' önce, sonra en yeni → ilk eleman ASIL
            asil = idler[0]
            gerekce = ("'odendi' satır korundu (para çıkmış)" if durumlar[0] == "odendi"
                       else "hepsi bekliyor — en yeni (güncel ekstre) korundu")
            korunan_ozet.append({"kart_id": str(g["kart_id"]), "donem": g["donem"],
                                 "korunan": asil, "durum": durumlar[0],
                                 "tutar": tutarlar[0], "aciklama": aciklamalar[0],
                                 "gerekce": gerekce, "grup_satir": len(idler)})
            for i, fid in enumerate(idler[1:], start=1):
                islem.append({"plan_id": fid, "kart_id": str(g["kart_id"]),
                              "donem": g["donem"], "durum": durumlar[i],
                              "tutar": tutarlar[i], "aciklama": aciklamalar[i],
                              "asil_kalan": asil})
                if not kuru:
                    cur.execute(
                        """UPDATE odeme_plani
                             SET durum='iptal',
                                 aciklama = LEFT(COALESCE(aciklama,'') ||
                                     ' [DÖNEM MÜKERRERİ — asıl: ' || %s || ']', 400)
                           WHERE id=%s""", (asil, fid))
        index_sonuc = None
        if not kuru:
            conn.commit()
            try:
                cur.execute("SAVEPOINT sp_uniq_kur")
                cur.execute("""
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_odeme_plani_kart_donem
                    ON odeme_plani (kart_id, referans_ay)
                    WHERE kart_id IS NOT NULL AND referans_ay IS NOT NULL
                      AND kaynak_tablo IS NULL AND durum <> 'iptal'""")
                cur.execute("RELEASE SAVEPOINT sp_uniq_kur")
                conn.commit()
                index_sonuc = "✅ Tekillik indeksi kuruldu — bundan sonra mükerrer dönem AÇILAMAZ"
            except Exception as e:  # noqa: BLE001
                cur.execute("ROLLBACK TO SAVEPOINT sp_uniq_kur")
                index_sonuc = f"⚠️ İndeks kurulamadı: {str(e)[:140]}"
    return {
        "kuru_calistirma": bool(kuru),
        "ihlal_grubu": len(korunan_ozet),
        "iptal_edilecek": len(islem),
        "iptal_tutari": round(sum(x["tutar"] for x in islem), 2),
        "korunanlar": korunan_ozet[:30],
        "iptal_edilecekler": islem[:40],
        "index_sonuc": index_sonuc,
        "not": "Dönem kimliği = (kart_id, referans_ay). 'odendi' satır her zaman "
               "korunur; hepsi bekliyorsa en yeni ekstre kalır. Satır SİLİNMEZ, "
               "'iptal' + denetim notu. Uygulamak için ?kuru=0",
    }


@router.post("/temizlik/odenen-tutar-tamamla")
def temizlik_odenen_tutar(kuru: int = 1):
    """'odendi' damgalı ama odenen_tutar boş satırlarda tutarı KASA İZİNDEN tamamlar.

    Kira/fatura gibi satırlarda ödeme yapılmış ama odenen_tutar yazılmamış
    (eski akış). Tutarı UYDURMAZ: yalnız gerçek kasa/kart hareketi bulunan
    satırlarda, o hareketin tutarını yazar. İz yoksa DOKUNMAZ — o satır
    "ödendi mi gerçekten?" sorusuyla listede kalır.
    """
    yazilacak, izsiz = [], []
    with db() as (conn, cur):
        cur.execute(
            """SELECT id, LEFT(COALESCE(aciklama,''),60) AS aciklama, tarih::text AS tarih,
                      odenecek_tutar::float AS borc, COALESCE(kaynak_tablo,'') AS kt,
                      kaynak_id AS ki
               FROM odeme_plani
               WHERE durum='odendi' AND COALESCE(odenen_tutar,0) <= 0.01
                 AND COALESCE(aciklama,'') NOT ILIKE '%%kart%%'"""
        )
        for r in (cur.fetchall() or []):
            p = dict(r)
            # ── İZ ARAMASI DÖRT ANAHTARDAN (2026-08-08, sahip uyarısı: "kasa izi
            # bulamıyor olman — kira ödemelerinde kasa izi bırakıp bırakmadıklarını
            # kontrol et!"). Dar arama 14 satırı (225.284 ₺) kaçırıyordu: ödeme
            # kasaya KAYNAK TABLOSUYLA yazılıyor (sabit_giderler + gider_id,
            # 2026-07-05 FIX O1 deseni), 'odeme_plani' ile değil.
            cur.execute(
                """SELECT COALESCE(SUM(ABS(tutar)),0)::float AS t FROM (
                     SELECT tutar FROM kasa_hareketleri
                     WHERE COALESCE(durum,'aktif')='aktif'
                       AND ((kaynak_tablo='odeme_plani' AND kaynak_id=%s) OR ref_id=%s)
                     UNION ALL
                     SELECT tutar FROM kart_hareketleri
                     WHERE COALESCE(durum,'aktif')='aktif'
                       AND ((kaynak_tablo='odeme_plani' AND kaynak_id=%s) OR id=%s)) x""",
                (p["id"], p["id"], p["id"], f"odm_{p['id']}"))
            iz_tutar = round(float((cur.fetchone() or {}).get("t") or 0), 2)
            kaynak_yolu = "plan anahtarı"
            if iz_tutar <= 0.01 and p["kt"] and p["ki"]:
                cur.execute(
                    """SELECT COALESCE(SUM(ABS(tutar)),0)::float AS t FROM kasa_hareketleri
                       WHERE kaynak_tablo=%s AND kaynak_id=%s
                         AND COALESCE(durum,'aktif')='aktif'
                         AND DATE_TRUNC('month',tarih)=DATE_TRUNC('month',%s::date)""",
                    (p["kt"], str(p["ki"]), p["tarih"]))
                iz_tutar = round(float((cur.fetchone() or {}).get("t") or 0), 2)
                kaynak_yolu = f"kaynak tablosu ({p['kt']}, aynı ay)"
            if iz_tutar <= 0.01 and p["ki"]:
                # KART yolu — tablo adı şart değil, gider KİMLİĞİ şart
                # (sabit_giderler ↔ fatura_giderleri etiket ikiliği, 2026-08-08)
                cur.execute(
                    """SELECT COALESCE(SUM(ABS(tutar)),0)::float AS t FROM kart_hareketleri
                       WHERE kaynak_id=%s AND islem_turu='HARCAMA'
                         AND COALESCE(durum,'aktif')='aktif'
                         AND DATE_TRUNC('month',tarih)=DATE_TRUNC('month',%s::date)""",
                    (str(p["ki"]), p["tarih"]))
                iz_tutar = round(float((cur.fetchone() or {}).get("t") or 0), 2)
                kaynak_yolu = "kart (aynı gider kimliği, aynı ay)"
            if iz_tutar > 0.01:
                # ⚠️ TAVAN: aynı ay içinde aynı kaynağa birden çok ödeme olabilir
                # (POS DONANIM aynı ay 2 kez). Borçtan fazlasını YAZMA.
                yazilacak_tutar = round(min(iz_tutar, float(p["borc"] or 0)), 2)
                yazilacak.append({**p, "kasa_izi": iz_tutar,
                                  "yazilan": yazilacak_tutar, "yol": kaynak_yolu,
                                  "tavana_takildi": iz_tutar > float(p["borc"] or 0) + 0.01})
                if not kuru:
                    cur.execute("UPDATE odeme_plani SET odenen_tutar=%s WHERE id=%s",
                                (yazilacak_tutar, p["id"]))
            else:
                izsiz.append({**p, "soru": "Ödendi damgalı ama ne kasa ne kart izi var — "
                                           "gerçekten ödendi mi?"})
        if not kuru:
            conn.commit()
    return {"kuru_calistirma": bool(kuru),
            "tutar_yazilacak": len(yazilacak),
            "yazilacak_toplam": round(sum(y["yazilan"] for y in yazilacak), 2),
            "tavana_takilan": sum(1 for y in yazilacak if y.get("tavana_takildi")),
            "iz_bulunamayan": len(izsiz),
            "izsiz_tutar": round(sum(i["borc"] for i in izsiz), 2),
            "yazilacaklar": yazilacak[:30], "izsizler": izsiz[:30],
            "not": "Tutar UYDURULMAZ — yalnız gerçek kasa/kart izinden yazılır ve "
                   "borç tutarını AŞAMAZ. İz araması 4 anahtardan yapılır (plan "
                   "anahtarı + kaynak tablosu). İzi olmayanlar sahip incelemesine "
                   "bırakılır. Uygulamak için ?kuru=0"}


@router.get("/para-zinciri-rontgen")
def para_zinciri_rontgen():
    """🩻 FATURA → BORÇ → ÖDEME → CARİ zinciri canlıda GERÇEKTE ne yapıyor?

    Sahip sorusu (2026-08-08): "bu faturalar vadeli borçlarda birikiyor mu,
    ödeme yapılınca düşüyor mu, kartla ödenmişse kapatabiliyor mu, bazen borcun
    bir kısmını bırakırız — bunlar nasıl kurulacak?"

    Bu uç HÜKÜM VERMEZ, ham veri toplar (duyu ilkesi). Her ölçüm bağımsız
    try içinde — biri patlarsa diğerleri yaşar.
    """
    r: Dict[str, Any] = {"olculdu": date.today().isoformat()}

    def _sor(ad, sql, tekil=True):
        try:
            with db() as (_c, cur):
                _ensure_cari_odeme_tablolar(cur)
                cur.execute(sql)
                v = cur.fetchall() or []
                r[ad] = (dict(v[0]) if v else {}) if tekil else [dict(x) for x in v]
        except Exception as e:  # noqa: BLE001
            r[ad] = {"hata": str(e)[:160]}

    # 1) FIFO cari ödeme motoru HİÇ kullanıldı mı?
    _sor("cari_odeme_kullanimi", """
        SELECT COUNT(*)::int AS odeme_adet,
               COALESCE(SUM(tutar),0)::float AS odeme_toplam,
               COUNT(*) FILTER (WHERE belgesiz)::int AS belgesiz_adet,
               MIN(tarih)::text AS ilk, MAX(tarih)::text AS son
        FROM cari_odeme""")
    _sor("tahsis_defteri", """
        SELECT COUNT(*)::int AS satir,
               COUNT(DISTINCT odeme_id)::int AS odeme,
               COUNT(DISTINCT fatura_id)::int AS kapatilan_fatura,
               COALESCE(SUM(kapatilan),0)::float AS kapatilan_toplam,
               COUNT(*) FILTER (WHERE NOT otomatik)::int AS elle_dagitim
        FROM cari_odeme_tahsis""")

    # 2) Vadeli alım kuyruğu — KISMİ ödeme kolonu YOK, sadece durum var
    _sor("vadeli_alimlar", """
        SELECT durum, COUNT(*)::int AS adet, COALESCE(SUM(tutar),0)::float AS toplam
        FROM vadeli_alimlar GROUP BY durum ORDER BY 3 DESC""", tekil=False)

    # 3) Ödeme planı — kısmi ödeme GERÇEKTEN kullanılıyor mu?
    _sor("odeme_plani_kismi", """
        SELECT COUNT(*)::int AS toplam_satir,
               COUNT(*) FILTER (WHERE durum='odendi')::int AS odendi,
               COUNT(*) FILTER (WHERE durum='odendi'
                    AND COALESCE(odenen_tutar,0) < odenecek_tutar - 0.01)::int AS eksik_odenmis,
               COUNT(*) FILTER (WHERE durum='bekliyor'
                    AND COALESCE(odenen_tutar,0) > 0.01)::int AS kismi_odenmis_bekliyor,
               COALESCE(SUM(odenecek_tutar) FILTER (WHERE durum='bekliyor'),0)::float AS bekleyen_tutar,
               COALESCE(SUM(COALESCE(odenen_tutar,0)) FILTER (WHERE durum='bekliyor'),0)::float AS bekleyende_odenmis
        FROM odeme_plani""")

    # 3b) KAYIP BORÇ: 'odendi' damgalı ama ödenen < ödenecek olan satırlar.
    # Eski odeme_yap kısmi ödemeyi tam ödeme sayıp planı kapatıyordu (2026-08-08
    # düzeltildi). Bu satırlardaki fark, kuyruktan sessizce düşmüş borçtur.
    # ⚠️ KART EKSTRESİ AYRI TUTULUR: kart ekstresinde ASGARİ ödeme yapmak
    # normaldir — kalan borç kaybolmaz, KARTA DEVREDER ve faiz işler (kart borcu
    # kendi mekanizmasında takip edilir). Bunları "kayıp" saymak yanlış alarm
    # üretir (ilk ölçümde 7,6 M ₺ çıkmıştı, çoğu asgari ödemeydi).
    _sor("kayip_borc_eski_kismi", """
        SELECT
          COUNT(*) FILTER (WHERE NOT kart)::int AS satir,
          COALESCE(SUM(fark) FILTER (WHERE NOT kart),0)::float AS kayip_tutar,
          COALESCE(SUM(borc) FILTER (WHERE NOT kart),0)::float AS toplam_borc,
          COALESCE(SUM(odenen) FILTER (WHERE NOT kart),0)::float AS toplam_odenen,
          COUNT(*) FILTER (WHERE kart)::int AS kart_satir,
          COALESCE(SUM(fark) FILTER (WHERE kart),0)::float AS kart_devreden
        FROM (
          SELECT odenecek_tutar::float AS borc,
                 COALESCE(odenen_tutar,0)::float AS odenen,
                 (odenecek_tutar - COALESCE(odenen_tutar,0))::float AS fark,
                 (COALESCE(aciklama,'') ILIKE '%%kart%%'
                  OR COALESCE(kaynak_tablo,'') IN ('kartlar','kart_hareketleri')) AS kart
          FROM odeme_plani
          WHERE durum='odendi' AND COALESCE(odenen_tutar,0) < odenecek_tutar - 0.01
        ) x""")
    # Mükerrer plan satırı: aynı açıklama + aynı tutar + AYNI GÜN.
    # ⚠️ Tarih şartı kritik: "KOC FINANS ARAC" 28.06/01.07/01.08 tekrarı aylık
    # TAKSİTTİR, mükerrer değil. Aynı gün tekrar ise gerçek mükerrerlik
    # (canlıda "EN PARA" aynı gün 6 kez — ekstre birden çok kez işlenmiş).
    _sor("mukerrer_plan_satiri", """
        SELECT LEFT(COALESCE(aciklama,'?'),46) AS aciklama,
               odenecek_tutar::float AS tutar, tarih::text AS tarih,
               COALESCE(kaynak_id::text,'-') AS kaynak_id,
               COUNT(*)::int AS adet,
               (MAX(odenecek_tutar) * (COUNT(*) - 1))::float AS fazla_sayilan
        FROM odeme_plani
        WHERE COALESCE(durum,'') <> 'iptal'
        GROUP BY 1,2,3,4 HAVING COUNT(*) > 1
        ORDER BY MAX(odenecek_tutar) * (COUNT(*) - 1) DESC LIMIT 25""", tekil=False)
    # 🔁 Mükerrer SABİT GİDER TANIMI: aynı ad+tutar birden çok kayıt olarak
    # tanımlıysa motor her biri için ayrı plan üretir (kaynak_id farklı olduğu
    # için koruma devreye girmez) — POS DONANIM 4 plan satırının sebebi bu olabilir.
    _sor("mukerrer_sabit_gider", """
        SELECT gider_adi, tutar::float AS tutar,
               COALESCE(sube_id::text,'(şubesiz)') AS sube_id,
               COUNT(*)::int AS adet,
               COUNT(*) FILTER (WHERE aktif)::int AS aktif_adet,
               ARRAY_AGG(id::text) AS idler,
               ARRAY_AGG(COALESCE(odeme_yontemi,'-')) AS yontemler
        FROM sabit_giderler
        GROUP BY 1,2,3 HAVING COUNT(*) > 1
        ORDER BY MAX(tutar) * COUNT(*) DESC LIMIT 20""", tekil=False)

    # 💳 Kart planı tekillik freni kuruldu mu? (2026-08-08 kök neden kapatma)
    _sor("kart_plan_tekillik_freni", """
        SELECT
          EXISTS (SELECT 1 FROM pg_indexes
                  WHERE indexname='ux_odeme_plani_kart_donem') AS index_kurulu,
          (SELECT COUNT(*)::int FROM (
             SELECT kart_id, referans_ay FROM odeme_plani
             WHERE kart_id IS NOT NULL AND referans_ay IS NOT NULL
               AND kaynak_tablo IS NULL AND COALESCE(durum,'') <> 'iptal'
             GROUP BY 1,2 HAVING COUNT(*) > 1) x) AS ihlal_grubu,
          (SELECT COUNT(*)::int FROM odeme_plani
           WHERE kart_id IS NOT NULL AND referans_ay IS NULL) AS referanssiz_kart_plani""")
    _sor("mukerrer_plan_ozet", """
        SELECT COUNT(*)::int AS grup,
               COALESCE(SUM(fazla),0)::float AS fazla_sayilan_toplam,
               COALESCE(SUM(adet - 1),0)::int AS silinebilir_satir
        FROM (
          SELECT MAX(odenecek_tutar) * (COUNT(*) - 1) AS fazla, COUNT(*) AS adet
          FROM odeme_plani WHERE COALESCE(durum,'') <> 'iptal'
          GROUP BY aciklama, odenecek_tutar, tarih, kaynak_id HAVING COUNT(*) > 1
        ) x""")
    _sor("kayip_borc_dokumu", """
        SELECT LEFT(COALESCE(aciklama,'?'),52) AS aciklama, tarih::text AS tarih,
               odenecek_tutar::float AS borc,
               COALESCE(odenen_tutar,0)::float AS odenen,
               (odenecek_tutar - COALESCE(odenen_tutar,0))::float AS eksik,
               COALESCE(kaynak_tablo,'-') AS kaynak
        FROM odeme_plani
        WHERE durum='odendi' AND COALESCE(odenen_tutar,0) < odenecek_tutar - 0.01
          AND COALESCE(aciklama,'') NOT ILIKE '%%kart%%'
          AND COALESCE(kaynak_tablo,'') NOT IN ('kartlar','kart_hareketleri')
        ORDER BY (odenecek_tutar - COALESCE(odenen_tutar,0)) DESC LIMIT 25""", tekil=False)

    # 4) Fatura ↔ borç kuyruğu bağı: kaç fatura borca dönüşmüş?
    _sor("fatura_kuyruk_bagi", """
        SELECT COUNT(*)::int AS fatura,
               COUNT(*) FILTER (WHERE kuyruk_vadeli_id IS NOT NULL
                                AND kuyruk_vadeli_id <> '(arsiv)')::int AS borca_donmus,
               COUNT(*) FILTER (WHERE kuyruk_vadeli_id = '(arsiv)')::int AS arsiv,
               COUNT(*) FILTER (WHERE kuyruk_vadeli_id IS NULL)::int AS kuyruga_hic_girmemis,
               COALESCE(SUM(toplam_tutar) FILTER (WHERE kuyruk_vadeli_id IS NULL),0)::float
                   AS kuyruksuz_tutar
        FROM tedarikci_fatura WHERE COALESCE(durum,'') <> 'kopya'""")

    # 5) Kart hareketlerinde tedarikçiye giden ödemeler (ekstre dahil)
    _sor("kart_odeme_izi", """
        SELECT COUNT(*)::int AS harcama_adet,
               COALESCE(SUM(ABS(tutar)),0)::float AS harcama_toplam,
               COUNT(*) FILTER (WHERE COALESCE(kaynak_tablo,'')='ekstre_import')::int AS ekstreden,
               MIN(tarih)::text AS ilk, MAX(tarih)::text AS son
        FROM kart_hareketleri WHERE islem_turu='HARCAMA'""")

    r["okuma"] = {
        "soru_1_birikiyor_mu": "vadeli_alimlar + fatura_kuyruk_bagi bloklarına bak",
        "soru_2_odeyince_dusuyor_mu": "cari_odeme_kullanimi.odeme_adet=0 ise FIFO motoru hiç "
                                      "çalışmamış; borç 'ödeme izi ARAMASI' ile tahminen düşüyor",
        "soru_3_kismi_odeme": "vadeli_alimlar'da kısmi kolon YOK (bekliyor|odendi). "
                              "odeme_plani.odenen_tutar var — kismi_odenmis_bekliyor bunu ölçer",
        "soru_4_kart_kapatma": "kart_odeme_izi harcamaları görüyor ama tahsis_defteri boşsa "
                               "hiçbir faturaya BAĞLANMAMIŞ demektir",
    }
    return r


@router.get("/hizmet-fatura-cift-sayim")
def hizmet_fatura_cift_sayim():
    """⚠️ ÇİFT SAYIM RİSKİ: aynı gider hem sabit gider planında hem borç kuyruğunda.

    Elektrik/su/telekom zaten `sabit_giderler`'de aylık plan olarak duruyor.
    Aynı faturanın PDF'i yüklenince `vadeli_alimlar`+`odeme_plani` kuyruğuna da
    düşüyordu — aynı borç İKİ KEZ. Bu uç hüküm vermez, ÇAKIŞANI listeler.
    """
    with db() as (_c, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """SELECT id, tedarikci_ad, fatura_tarih::text AS tarih,
                      COALESCE(toplam_tutar,0)::float AS tutar,
                      kuyruk_vadeli_id, belge_sinifi
               FROM tedarikci_fatura
               WHERE belge_sinifi='hizmet' AND COALESCE(durum,'') <> 'kopya'
               ORDER BY fatura_tarih DESC NULLS LAST"""
        )
        hizmet = [dict(r) for r in (cur.fetchall() or [])]
        cur.execute(
            """SELECT id, gider_adi, kategori, tutar::float AS tutar, periyot, aktif
               FROM sabit_giderler WHERE aktif = TRUE"""
        )
        sabitler = [dict(r) for r in (cur.fetchall() or [])]

    def _kel(s):
        return set(w for w in _cari_katla(s or "").split() if len(w) > 2)

    cakisan = []
    for f in hizmet:
        kuyrukta = bool(f.get("kuyruk_vadeli_id")) and f["kuyruk_vadeli_id"] != "(arsiv)"
        if not kuyrukta:
            continue  # kuyruğa girmemiş → çift sayım yok
        fk = _kel(f.get("tedarikci_ad"))
        for s in sabitler:
            ortak = fk & (_kel(s.get("gider_adi")) | _kel(s.get("kategori")))
            if ortak:
                cakisan.append({
                    "fatura_id": f["id"], "tedarikci": f.get("tedarikci_ad"),
                    "fatura_tarih": f.get("tarih"), "fatura_tl": f.get("tutar"),
                    "sabit_gider_id": s["id"], "sabit_gider_adi": s.get("gider_adi"),
                    "sabit_tutar": s.get("tutar"), "periyot": s.get("periyot"),
                    "ortak_kelime": sorted(ortak),
                    "risk": "Aynı gider hem aylık sabit planda hem borç kuyruğunda olabilir",
                    "ne_yapmali": "Doğruysa birini kapat — fatura kuyruk kaydını iptal et "
                                  "VEYA sabit gider satırını o ay için pasifle",
                })
    return {
        "hizmet_fatura_adet": len(hizmet),
        "kuyruga_dusen": sum(1 for f in hizmet
                             if f.get("kuyruk_vadeli_id") and f["kuyruk_vadeli_id"] != "(arsiv)"),
        "aktif_sabit_gider": len(sabitler),
        "cakisan_adet": len(cakisan), "cakisan": cakisan,
        "not": "Hüküm YOK — liste sahibin kararı içindir. Çakışma yoksa gider "
               "faturaları tek kanaldan sayılıyor demektir.",
    }


@router.post("/belge-sinifi-tazele")
def belge_sinifi_tazele(sadece_bos: int = 1, limit: int = 2000):
    """Geçmiş faturaları sınıflandırır. sadece_bos=0 ise elle olmayanları da tazeler."""
    kos = "belge_sinifi IS NULL" if sadece_bos else "COALESCE(sinif_kaynak,'') <> 'elle'"
    guncel, degisen = 0, []
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute(
            f"""SELECT id, tedarikci_ad, belge_sinifi FROM tedarikci_fatura
                WHERE {kos} AND COALESCE(tedarikci_ad,'') <> '' LIMIT %s""",  # noqa: S608
            (limit,),
        )
        for r in (cur.fetchall() or []):
            # İÇERİK ADI EZER: kalemler varsa kanıt onlardan gelir (KONYA SUK dersi)
            cur.execute(
                "SELECT ocr_ad FROM tedarikci_fatura_kalem WHERE fatura_id=%s LIMIT 50",
                (r["id"],),
            )
            adlar = [k["ocr_ad"] for k in (cur.fetchall() or [])]
            kanit = kalem_sinif_kaniti(adlar)
            yeni = kanit or tedarikci_sinif(r["tedarikci_ad"])
            kaynak = "kalem_kaniti" if kanit else "ad_heuristik"
            if yeni != (r.get("belge_sinifi") or None):
                degisen.append({"id": r["id"], "tedarikci": r["tedarikci_ad"],
                                "eski": r.get("belge_sinifi"), "yeni": yeni,
                                "dayanak": kaynak,
                                "ornek_kalem": (adlar[0] if adlar else None)})
            cur.execute(
                "UPDATE tedarikci_fatura SET belge_sinifi=%s, sinif_kaynak=%s WHERE id=%s",
                (yeni, kaynak, r["id"]),
            )
            guncel += 1
        conn.commit()
    return {"islenen": guncel, "degisen_adet": len(degisen), "degisen": degisen[:50],
            "not": "Elle düzeltilmiş kayıtlar (sinif_kaynak='elle') korunur."}


@router.post("/{fatura_id}/belge-sinifi")
def belge_sinifi_elle(fatura_id: str, sinif: str):
    """Sahip düzeltmesi — heuristik yanıldıysa. Bu damga bir daha ezilmez."""
    s = (sinif or "").strip().lower()
    if s not in ("mal", "hizmet"):
        raise HTTPException(400, "sinif 'mal' veya 'hizmet' olmalı")
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute(
            "UPDATE tedarikci_fatura SET belge_sinifi=%s, sinif_kaynak='elle' WHERE id=%s RETURNING tedarikci_ad",
            (s, fatura_id),
        )
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "fatura bulunamadı")
        conn.commit()
    return {"ok": True, "fatura_id": fatura_id, "sinif": s, "tedarikci": r["tedarikci_ad"],
            "not": "Elle damga — heuristik bir daha ezmez."}


# ── 🔗 TEDARİKÇİ EŞLEŞTİRME — KANONİK KAYIT (2026-07-19, sahip onaylı tur:
# 'tedarikçi listesindeki isimlerle fatura isimlerinin eşleştirmesini bir kere
# yapmalıyız'). Fatura ünvanı → kayıtlı kısa ad + sınıf. İlke: kanonik kimlik
# KAYNAKTA damgalanır, zincirde tahminle düşürülmez. sinif='gecici' = internetten
# kartla tek seferlik alım (ödemesi kart ekstresinde — cari takip edilmez).
_ESLESTIRME_SEED = [
    # (fatura resmi ünvanı, kayıtlı kısa ad, sınıf override)
    ("MEHMET ATALAY", "ATALAY KAHVE", None),
    ("Napolés Coffee & Roastery", "ATALAY KAHVE", None),          # sahip: 'Napolés de atalay'
    ("FEZ KAHVE GIDA İTHALAT İHRACAT SANAYİ VE TİCARET LİMİTED ŞİRKETİ", "FEZ", None),
    ("SÜTAŞ SÜT ÜRÜNLERİ A.Ş.", "SÜTAŞ", None),
    ("DYK GRUP AMBALAJ HİZMETLERİ SAN. VE TİC. LİMİTED ŞİRKETİ", "DYK GRUP", None),
    ("DYN GRUP AMBALAJ HİZMETLERİ SANAYİ VE TİCARET LİMİTED ŞİRKETİ", "DYK GRUP", None),  # sahip: 'aynı firma' (OCR yazım farkı)
    ("METRO GROSMARKET B.KÖY ALIS.HIZ.TIC.LTD.STI.", "METRO", None),
    ("HASAN ERKAN", "PASTA", None),                                # sahip: 'hasan erkan pasta'
    ("APS GIDA ENERJİ KİMYA TARIM SAN. VE TİC. A.Ş.", "redbull", None),  # sahip: 'redbull doğru'
    # sahip onayı 2026-07-19 'EVET': 'hüseyin makina' = ESHİM (makine tamircisi
    # Hüseyin Kara — 40.800 söz bu adla girilmişti). İki yazım tek ESHİM başlığında.
    ("ESHİM TEKNİK SERVİS HÜSEYİN KARA", "ESHİM", "hizmet"),
    ("hüseyin makina", "ESHİM", "hizmet"),
    ("ASSA SANAL MAĞAZACILIK LİMİTED ŞİRKETİ", None, "gecici"),    # internetten kartla
    ("D-MARKET ELEKTRONİK HİZMETLER VE TİCARET A.Ş.", None, "gecici"),
]


def _eslestirme_ensure(cur) -> None:
    cur.execute(
        """CREATE TABLE IF NOT EXISTS tedarikci_eslestirme (
               resmi_ad TEXT PRIMARY KEY,
               kisa_ad TEXT,
               sinif TEXT,
               kaynak TEXT,
               olusturma TIMESTAMPTZ DEFAULT NOW())""")
    for resmi, kisa, sinif in _ESLESTIRME_SEED:
        cur.execute(
            """INSERT INTO tedarikci_eslestirme (resmi_ad, kisa_ad, sinif, kaynak)
               VALUES (%s, %s, %s, 'sahip_onay_2026-07-19')
               ON CONFLICT (resmi_ad) DO NOTHING""", (resmi, kisa, sinif))
    # 🔧 tek-seferlik göç (sahip 'EVET' 2026-07-19): eski kayıtlarda ESHİM/hüseyin
    # makina kisa_ad'sız durur (seed DO NOTHING güncellemez) — kimlik birleştirme
    # burada tamamlanır; idempotent (kisa_ad dolunca koşul boşa düşer).
    cur.execute(
        """UPDATE tedarikci_eslestirme SET kisa_ad='ESHİM'
           WHERE resmi_ad IN ('ESHİM TEKNİK SERVİS HÜSEYİN KARA', 'hüseyin makina')
             AND (kisa_ad IS NULL OR kisa_ad='')""")


def tedarikci_eslestirme_haritasi() -> dict:
    """UPPER(ad) → {'kisa': kayıtlı ad|None, 'sinif': override|None}.
    Hem resmi ünvan hem kısa ad anahtarlanır ('fez' sözü de 'FEZ KAHVE…' faturası
    da aynı kimliğe çözülür). Hata-yutar: harita gelmezse davranış eskisi gibi."""
    try:
        with db() as (_, cur):
            _eslestirme_ensure(cur)
            cur.execute("SELECT resmi_ad, kisa_ad, sinif FROM tedarikci_eslestirme")
            rows = [dict(r) for r in cur.fetchall() or []]
    except Exception as e:  # noqa: BLE001
        logger.warning("eslestirme haritasi hatasi (yutuldu): %s", str(e)[:100])
        return {}
    h: dict = {}
    for r in rows:
        deger = {"kisa": (r.get("kisa_ad") or "").strip() or None,
                 "sinif": (r.get("sinif") or "").strip() or None}
        h[(r["resmi_ad"] or "").strip().upper()] = deger
        if deger["kisa"]:
            h.setdefault(deger["kisa"].upper(), deger)
    return h


def cari_ozet() -> dict:
    """Tüm tedarikçilerin cari özeti — beyin (B48) + bağ + UI. Salt-okur.
    Pencere sistem başlangıcından önceye taşmaz (Haziran 2026 öncesi veri yok)."""
    kesit_6ay = _cari_pencere_kesiti(180)
    with db() as (_, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """SELECT tedarikci_vkn, tedarikci_ad,
                      COALESCE(fatura_tarih, olusturma::date)::text AS tarih,
                      COALESCE(toplam_tutar,0)::float AS tutar,
                      onceki_bakiye, bakiye_dahil
               FROM tedarikci_fatura
               WHERE (COALESCE(TRIM(tedarikci_ad),'') <> ''
                  OR COALESCE(TRIM(tedarikci_vkn),'') <> '')
                 AND COALESCE(durum,'') <> 'kopya'
               ORDER BY COALESCE(fatura_tarih, olusturma::date), olusturma""")
        satirlar = [dict(r) for r in cur.fetchall() or []]
        cur.execute(
            """SELECT COALESCE(TRIM(tedarikci),'') AS tedarikci,
                      tutar::float AS tutar, vade_tarihi::text AS vade,
                      COALESCE(aciklama,'') AS aciklama
               FROM vadeli_alimlar WHERE durum='bekliyor'
               ORDER BY vade_tarihi""")
        vadeler = [dict(r) for r in cur.fetchall() or []]
        # BİZİM TARAF ödeme izleri (3 kanal, türetilmişler hariç) — kasa izi
        # felsefesi: iz varsa borçtan düşer, iz yoksa borç BİRİKİR (cari artar).
        # Pencere = fatura penceresiyle AYNI kesit (sistem başlangıcı korumalı).
        cur.execute(
            """SELECT tarih::text AS tarih, tutar::float AS tutar, metin FROM (
                 SELECT vade_tarihi AS tarih, tutar,
                        COALESCE(tedarikci,'') || ' ' || COALESCE(aciklama,'') AS metin
                 FROM vadeli_alimlar
                 WHERE durum='odendi' AND vade_tarihi >= %s::date
                 UNION ALL
                 SELECT tarih, tutar,
                        COALESCE(tedarikci,'') || ' ' || COALESCE(aciklama,'')
                 FROM anlik_giderler
                 WHERE durum='aktif' AND kaynak_id IS NULL AND tarih >= %s::date
                 UNION ALL
                 SELECT tarih, tutar, COALESCE(aciklama,'')
                 FROM kart_hareketleri
                 WHERE islem_turu='HARCAMA' AND durum='aktif'
                   -- ekstre_import istisnası — cari_ekstre kanal-3 ile AYNI
                   -- (FEZ vakası 2026-08-03; iki uç aynı eşleşme evreni kuralı)
                   AND (kaynak_id IS NULL OR COALESCE(kaynak_tablo,'') = 'ekstre_import')
                   AND COALESCE(harcama_tipi,'belirsiz') <> 'sahsi'
                   AND tarih >= %s::date) x""",
            (kesit_6ay, kesit_6ay, kesit_6ay))
        odeme_izleri = [dict(r) for r in cur.fetchall() or []]
        devirler = _cari_devirler(cur)  # 📜 sistem-öncesi açılış beyanları

    # 🔗 EŞDEĞER AD KÜMESİ (AP temizlik turu 2026-08-03): vade/ödeme/devir
    # eşleşmesi HAM fatura ünvanıyla yapılıyordu; kanonik harita yalnız en
    # sondaki satır-birleştirmede devreye giriyordu. Sonuç: ekstre ile cari_ozet
    # AYNI tedarikçiye FARKLI sayı söylüyordu —
    #   ATALAY: 100.000 ödeme izi "ATALAY KAHVE ..." metniyle; grup adı
    #   "MEHMET ATALAY" olduğu için iz atanmıyordu (açık 100K şişik).
    #   ESHİM: 40.800 söz ted="hüseyin makina"; grup ünvanı eşleşmeyince
    #   kuyruk 0 görünüyordu (ap-mutabakat sahte kuyruk_eksik).
    # Çözüm ekstredeki _es_adlar deseninin aynısı: grubun adı + haritadaki
    # kisa'sı + o kisa'ya bağlı tüm resmi adlar tek eşleşme evreni olur.
    _harita_es = tedarikci_eslestirme_haritasi()

    def _es_adlari(ad: str) -> list:
        adlar = [ad]
        kisa = (_harita_es.get((ad or "").strip().upper()) or {}).get("kisa")
        if kisa:
            if kisa.upper() != (ad or "").strip().upper():
                adlar.append(kisa)
            for hk, hv in _harita_es.items():
                if hv.get("kisa") == kisa and hk not in {a.upper() for a in adlar}:
                    adlar.append(hk)
        return adlar

    gruplar: dict = {}
    for s in satirlar:
        k = _cari_kanonik(s.get("tedarikci_vkn"), s.get("tedarikci_ad"))
        if not k:
            continue
        g = gruplar.setdefault(k, {"tedarikci": (s.get("tedarikci_ad") or "").strip(),
                                   "vkn": (s.get("tedarikci_vkn") or "").strip() or None,
                                   "faturalar": []})
        if (s.get("tedarikci_vkn") or "").strip():
            g["vkn"] = s["tedarikci_vkn"].strip()
        g["faturalar"].append(s)

    # ALT-KÜME BİRLEŞTİRME (ATALAY vakası 2026-07-14: 'MEHMET ATALAY' ile
    # 'Napolés Coffee & Roastery Mehmet Atalay' AYNI tedarikçinin iki yazımı —
    # şahıs adı vs dükkân ünvanı). Kısa anahtarın token seti uzunun ALT KÜMESİYSE
    # tek satırda birleşir (çok faturalı grubun adı görünür). VKN'li gruplar
    # birleşmez (kanonik kimlik zaten kesin). Aday birleştirmedir, '≈' evreninde.
    # Denetim P2-6 guard'ları: (a) tek tokenlik KİŞİ ADI anahtar ('hasan')
    # birleşmeye girmez — iki farklı Hasan'ı yapıştırabilir; (b) kısa anahtarın
    # BİRDEN ÇOK üst kümesi varsa belirsizlik = BİRLEŞMEME (yanlış kişiye
    # yapışmaktansa iki satır kalsın).
    anahtarlar = sorted([k for k in gruplar if not gruplar[k].get("vkn")],
                        key=lambda k: len(k.split()))
    for i, kisa in enumerate(anahtarlar):
        ks = set(kisa.split())
        if not ks or kisa not in gruplar:
            continue
        if len(ks) == 1 and next(iter(ks)) in _KISI_ADLARI:
            continue
        adaylar_ust = [u for u in anahtarlar[i + 1:]
                       if u in gruplar and len(u.split()) > len(ks)
                       and ks.issubset(set(u.split()))]
        if len(adaylar_ust) != 1:
            continue  # 0 = eş yok; 2+ = belirsiz, birleştirme yapılmaz
        uzun = adaylar_ust[0]
        hedef, kaynak = (kisa, uzun) \
            if len(gruplar[kisa]["faturalar"]) >= len(gruplar[uzun]["faturalar"]) \
            else (uzun, kisa)
        gruplar[hedef]["faturalar"].extend(gruplar[kaynak]["faturalar"])
        gruplar[hedef]["faturalar"].sort(key=lambda f: (str(f["tarih"])))
        del gruplar[kaynak]

    ozet = []
    for g in gruplar.values():
        fl = _cari_zincir(g["faturalar"])
        son6 = [f for f in fl if f["tarih"] >= kesit_6ay]
        beyan, beyan_tarih = None, None
        for f in reversed(fl):
            if f.get("bakiye_dahil") is not None:
                beyan, beyan_tarih = round(float(f["bakiye_dahil"]), 2), f["tarih"]
                break
        # VADE SÖZÜ eşleşmesi (ATALAY vakası 2026-07-14: 'ATALAY KAHVE' sözü
        # 'MEHMET ATALAY' cari satırına bağlanmıyordu) — marka-token eşleşmesi;
        # her vade TEK gruba atanır (çift sayım yok, ilk eşleşen alır).
        g_adlar = _es_adlari(g["tedarikci"])
        v_top, v_yakin = 0.0, None
        for v in vadeler:
            if v.get("_atandi"):
                continue
            vt_metin = f"{v['tedarikci']} {v.get('aciklama') or ''}"
            if any(_odeme_eslesir(a, vt_metin) for a in g_adlar) or \
               any(_odeme_eslesir(v["tedarikci"], a) for a in g_adlar):
                v["_atandi"] = True
                v_top = round(v_top + v["tutar"], 2)
                v_yakin = v_yakin or v["vade"]
        kopuk = [f["zincir_fark"] for f in fl if f.get("zincir_fark") not in (None, 0.0)]
        # BİZİM TARAF HESABI: fatura(+) − ödeme izi(−). Ödeme izi = tedarikçi adı
        # ödeme metninde geçen kayıtlar (aday eşleşme). İz YOKSA açık BÜYÜR.
        # Denetim P2-5: her ödeme izi TEK gruba düşer (vadelerdeki _atandi
        # deseni) — 'MEHMET ATALAY KAHVE' metni iki gruba birden düşmesin.
        odeme_top = 0.0
        for o in odeme_izleri:
            if o.get("_atandi"):
                continue
            if any(_odeme_eslesir(a, o.get("metin")) for a in g_adlar):
                o["_atandi"] = True
                odeme_top = round(odeme_top + float(o["tutar"] or 0), 2)
        fat_top = round(sum(f["tutar"] for f in son6), 2)
        # 📜 AÇILIŞ DEVRİ (tek-atama): sahip beyanı pencere-öncesi gerçeği taşır;
        # açık = devir + pencere içi fatura − ödeme izi. Devir yalnız TEK gruba.
        devir_top = 0.0
        for dv in devirler:
            if dv.get("_atandi"):
                continue
            if any(_odeme_eslesir(a, dv["tedarikci"]) for a in g_adlar) or \
               any(_odeme_eslesir(dv["tedarikci"], a) for a in g_adlar):
                dv["_atandi"] = True
                devir_top = round(devir_top + float(dv["tutar"] or 0), 2)
        hesaplanan_acik = round(devir_top + fat_top - odeme_top, 2)
        ozet.append({
            "tedarikci": g["tedarikci"], "vkn": g["vkn"],
            "devir": devir_top,
            "fatura_adet_6ay": len(son6),
            "fatura_toplam_6ay": fat_top,
            "odeme_izi_toplam_6ay": odeme_top,
            "hesaplanan_acik": hesaplanan_acik,
            "odeme_izi_var": odeme_top > 0,
            "son_fatura": fl[-1]["tarih"] if fl else None,
            "beyan_bakiye": beyan, "beyan_tarihi": beyan_tarih,
            "beyan_hesap_farki": (round(beyan - hesaplanan_acik, 2)
                                  if beyan is not None else None),
            "bekleyen_vade_toplam": v_top, "en_yakin_vade": v_yakin,
            "zincir_hareket_adet": len(kopuk),
            "son_zincir_fark": kopuk[-1] if kopuk else None,
        })
    # Faturasız tedarikçide kalan devir beyanı da satır olur (borç kaybolmasın)
    for dv in devirler:
        if dv.get("_atandi") or not float(dv.get("tutar") or 0):
            continue
        ozet.append({
            "tedarikci": dv["tedarikci"], "vkn": None,
            "devir": round(float(dv["tutar"]), 2),
            "fatura_adet_6ay": 0, "fatura_toplam_6ay": 0.0,
            "odeme_izi_toplam_6ay": 0.0,
            "hesaplanan_acik": round(float(dv["tutar"]), 2),
            "odeme_izi_var": False, "son_fatura": None,
            "beyan_bakiye": None, "beyan_tarihi": None,
            "beyan_hesap_farki": None,
            "bekleyen_vade_toplam": 0.0, "en_yakin_vade": None,
            "zincir_hareket_adet": 0, "son_zincir_fark": None,
        })
    # 🔗 KANONİK BİRLEŞTİRME: aynı kayıtlı ada bağlı fatura ünvanları TEK cari
    # satırında toplanır (ATALAY KAHVE = MEHMET ATALAY + Napolés). Sınıf:
    # eşleştirme override > kelime heuristiği.
    harita = tedarikci_eslestirme_haritasi()
    birlesik: dict = {}
    yeni_ozet = []
    for x in ozet:
        e = harita.get((x.get("tedarikci") or "").strip().upper()) or {}
        x["sinif"] = e.get("sinif") or tedarikci_sinif(x.get("tedarikci") or "")
        kisa = e.get("kisa")
        if not kisa:
            yeni_ozet.append(x)
            continue
        hedef = birlesik.get(kisa)
        if hedef is None:
            x["kayitli_ad"] = kisa
            x["resmi_adlar"] = [x["tedarikci"]]
            x["tedarikci"] = kisa
            birlesik[kisa] = x
            yeni_ozet.append(x)
            continue
        for alan in ("devir", "fatura_adet_6ay", "fatura_toplam_6ay",
                     "odeme_izi_toplam_6ay", "hesaplanan_acik",
                     "bekleyen_vade_toplam", "zincir_hareket_adet"):
            hedef[alan] = round((hedef.get(alan) or 0) + (x.get(alan) or 0), 2)
        hedef["resmi_adlar"].append(x["tedarikci"])
        hedef["odeme_izi_var"] = bool(hedef.get("odeme_izi_var") or x.get("odeme_izi_var"))
        if x.get("son_fatura") and (not hedef.get("son_fatura") or str(x["son_fatura"]) > str(hedef["son_fatura"])):
            hedef["son_fatura"] = x["son_fatura"]
        if x.get("en_yakin_vade") and (not hedef.get("en_yakin_vade") or str(x["en_yakin_vade"]) < str(hedef["en_yakin_vade"])):
            hedef["en_yakin_vade"] = x["en_yakin_vade"]
        if x.get("beyan_bakiye") is not None and hedef.get("beyan_bakiye") is None:
            hedef["beyan_bakiye"] = x["beyan_bakiye"]
            hedef["beyan_tarihi"] = x.get("beyan_tarihi")
    ozet = yeni_ozet
    ozet.sort(key=lambda x: -(max(abs(x["beyan_bakiye"] or 0),
                                  abs(x["hesaplanan_acik"])) + x["bekleyen_vade_toplam"]))
    return {
        "tedarikciler": ozet[:20],
        "toplam_beyan_bakiye": round(sum(x["beyan_bakiye"] or 0 for x in ozet), 2),
        "toplam_hesaplanan_acik": round(sum(max(0.0, x["hesaplanan_acik"])
                                            for x in ozet), 2),
        "toplam_bekleyen_vade": round(sum(x["bekleyen_vade_toplam"] for x in ozet), 2),
        "pencere_baslangic": kesit_6ay,
        "not": ("İKİ GÖZ: beyan_bakiye = TEDARİKÇİNİN fatura üstü beyanı (≈); "
                "hesaplanan_acik = BİZİM taraf ≈ açılış devri + pencere içi fatura "
                "toplamı − ödeme izi (3 kanal aday eşleşme). PENCERE Haziran 2026 "
                "(sistem başlangıcı) öncesine TAŞMAZ — öncesinin gerçeği tek "
                "satırlık AÇILIŞ DEVRİ beyanıyla (sahip girer) taşınır. Ödeme izi YOKSA açık "
                "BÜYÜR (iz varsa düşer, iz yoksa borç kalır). Negatif açık = fazla/"
                "peşin ödeme ya da penceredeki faturası henüz yüklenmemiş ödeme. "
                "beyan_hesap_farki büyükse eksik fatura / eksik ödeme kaydı / "
                "sistem-öncesi bakiye incelenir — hüküm insanın."),
    }


@router.get("/cari-ozet")
def cari_ozet_uc():
    return cari_ozet()


# ── FAZ D: AP MUTABAKAT DUYUSU (2026-07-18, sahip 'FAZ D'; Codex çift-koşu) ──
# Vadeli Alımlar'ı tamamen kaldırmadan ÖNCEKİ güvenlik ağı: her gece
# "tedarikçi CARİ açığı (fatura − ödeme izi + devir) ↔ ÖDEME KUYRUĞU (bekleyen
# vade sözü)" tutuyor mu? İki taraf da AYNI borcu ölçer; sapma = kuyruğa
# girmemiş fatura / kapanmamış söz / çift kayıt sinyali. SALT-OKUR, öneri-only,
# hata-yutar. Uyumsuz tedarikçi başına duyu olayı (Sv0 — alarm değil, gözlem).
def ap_mutabakat() -> dict:
    oz = cari_ozet()
    satirlar, uyumsuz = [], 0
    for t in oz.get("tedarikciler", []):
        acik = round(max(0.0, float(t.get("hesaplanan_acik") or 0)), 2)
        kuyruk = round(float(t.get("bekleyen_vade_toplam") or 0), 2)
        # cari açık VAR ama kuyruk YOK → fatura kuyruğa bağlanmamış (asıl risk);
        # kuyruk VAR ama açık YOK → söz fazlası/ödenmiş fatura kalmış
        fark = round(kuyruk - acik, 2)
        esik = max(500.0, acik * 0.05)
        uyumlu = abs(fark) <= esik
        if not uyumlu:
            uyumsuz += 1
        satirlar.append({
            "tedarikci": t.get("tedarikci"), "cari_acik": acik,
            "kuyruk_toplam": kuyruk, "fark": fark, "uyumlu": uyumlu,
            "yon": ("kuyruk_eksik" if fark < -esik else
                    "kuyruk_fazla" if fark > esik else "uyumlu"),
        })
    satirlar.sort(key=lambda x: -abs(x["fark"]))
    # UYUMSUZ olanlar için duyu olayı (hata-yutar; source_ref=tedarikçi → idempotent)
    for s in satirlar:
        if s["uyumlu"]:
            continue
        try:
            from duyu_omurga import duyu_olay_yaz
            duyu_olay_yaz(
                "ap_mutabakat", "finans.ap.kuyruk_cari_farki",
                str(s["tedarikci"] or "")[:60],
                entity_scope="tedarikci", entity_id=str(s["tedarikci"] or "")[:60],
                signal_name="Ödeme kuyruğu ≠ cari borç",
                payload={"cari_acik": s["cari_acik"], "kuyruk": s["kuyruk_toplam"],
                         "fark": s["fark"], "yon": s["yon"]})
        except Exception:  # noqa: BLE001
            pass
    # NEDEN DÖKÜMÜ (2026-07-19, sahip 'farklı konuşuyor'): uyumsuz tedarikçide
    # her faturanın kuyruk damgası + açık sözler — sağlık şeridi açılırında
    # "neden farklı" görünsün, tahmin değil veri konuşsun. SALT-OKUR.
    try:
        with db() as (_, cur):
            for s in satirlar[:30]:
                if s["uyumlu"]:
                    continue
                ad = (s.get("tedarikci") or "").strip()
                if not ad:
                    continue
                cur.execute(
                    """SELECT fatura_no, COALESCE(toplam_tutar,0)::float AS tutar,
                              fatura_tarih::text AS tarih, durum, kuyruk_vadeli_id
                       FROM tedarikci_fatura
                       WHERE UPPER(TRIM(tedarikci_ad)) = UPPER(%s)
                         AND COALESCE(toplam_tutar,0) > 0
                       ORDER BY fatura_tarih DESC NULLS LAST LIMIT 8""", (ad,))
                fx = []
                for r in cur.fetchall() or []:
                    f = dict(r)
                    d = f.pop("kuyruk_vadeli_id", None)
                    f["kuyruk_damga"] = (
                        "bagli" if d and not str(d).startswith("(")
                        else (str(d).strip("()") if d else "damgasiz"))
                    fx.append(f)
                cur.execute(
                    """SELECT id, COALESCE(aciklama,'') AS aciklama,
                              tutar::float AS tutar, vade_tarihi::text AS vade
                       FROM vadeli_alimlar
                       WHERE UPPER(TRIM(tedarikci)) = UPPER(%s)
                         AND durum='bekliyor' LIMIT 5""", (ad,))
                s["detay"] = {"faturalar": fx,
                              "acik_sozler": [dict(r) for r in cur.fetchall() or []]}
    except Exception as e:  # noqa: BLE001 — döküm süsü, rapor çekirdeğini bozamaz
        logger.warning("ap mutabakat detay hatasi (yutuldu): %s", str(e)[:120])
    return {
        "tedarikciler": satirlar[:30],
        "uyumsuz_adet": uyumsuz,
        "toplam_cari_acik": round(sum(s["cari_acik"] for s in satirlar), 2),
        "toplam_kuyruk": round(sum(s["kuyruk_toplam"] for s in satirlar), 2),
        "saglikli": uyumsuz == 0,
        "not": ("Cari açık (fatura−ödeme izi+devir) ile ödeme kuyruğu (bekleyen "
                "vade sözü) aynı borcu ölçer; sapma = kuyruğa bağlanmamış fatura / "
                "kapanmamış söz / çift kayıt. Vadeli Alımlar tam kaldırılmadan önce "
                "bu satır GÜN GÜN 'sağlıklı' çıkmalı (Faz D çift-koşu). Öneri-only."),
    }


@router.get("/ap-mutabakat")
def ap_mutabakat_uc():
    return ap_mutabakat()


def gece_ap_mutabakat() -> dict:
    """Gece zinciri halkası — hata-yutar."""
    try:
        return ap_mutabakat()
    except Exception as e:  # noqa: BLE001
        logger.warning("gece ap mutabakat hatasi (yutuldu): %s", str(e)[:150])
        return {"ok": False}


# ── 📜 AÇILIŞ DEVRİ UÇLARI (sahip beyanı — tek yazıcı burası) ────────────────
class CariDevirBody(BaseModel):
    tedarikci: str
    tutar: float          # >0 = başlangıçta tedarikçiye borç, <0 = avans/alacak
    aciklama: Optional[str] = None


@router.get("/cari-devir")
def cari_devir_liste():
    with db() as (_, cur):
        return {"devirler": _cari_devirler(cur)}


@router.post("/cari-devir")
def cari_devir_kaydet(body: CariDevirBody):
    ad = (body.tedarikci or "").strip()
    if len(ad) < 3:
        raise HTTPException(400, "tedarikci en az 3 karakter")
    if abs(body.tutar) > 10_000_000:
        raise HTTPException(400, "tutar makul aralık dışında")
    with db() as (conn, cur):
        _cari_devirler(cur)  # tablo garanti
        cur.execute(
            # ⚠️ aktif=TRUE ŞART (2026-08-08): iptal edilmiş bir devir varken aynı
            # tedarikçiye yeni devir girilirse ON CONFLICT satırı günceller ama
            # aktif=FALSE kalırdı → sahip devri girer, ekranda GÖRÜNMEZ. Soft-delete
            # eklerken doğan tuzak; yeniden beyan devri diriltir.
            """INSERT INTO cari_devir (tedarikci, tutar, aciklama)
               VALUES (%s,%s,%s)
               ON CONFLICT (tedarikci)
               DO UPDATE SET tutar=EXCLUDED.tutar, aciklama=EXCLUDED.aciklama,
                             aktif=TRUE, iptal_ts=NULL, iptal_neden=NULL""",
            (ad, round(body.tutar, 2), (body.aciklama or "").strip() or None))
        conn.commit()
    return {"ok": True, "tedarikci": ad, "tutar": round(body.tutar, 2)}


@router.delete("/cari-devir/{devir_id}")
def cari_devir_sil(devir_id: str, neden: str = ""):
    """📜 Açılış devrini İPTAL eder — SİLMEZ (2026-08-08, Codex denetimi).

    Devir bir BİLANÇO GERÇEĞİDİR: sahip "bu tedarikçiye şu kadar borcum vardı"
    diye beyan etmiştir ve cari bakiye bunun üstüne kurulur. Fiziksel DELETE
    hem sahip doktrinine ("hiçbir kayıt silinmez") hem muhasebe ilkesine
    aykırıydı — beyanın izi kaybolur, bakiye sessizce değişir, denetimde
    "bu rakam neden değişti?" sorusu cevapsız kalırdı.

    Artık: kayıt yerinde durur, aktif=FALSE olur, hesaba girmez.
    Geri almak için POST /cari-devir/{id}/geri-al.
    """
    with db() as (conn, cur):
        _cari_devirler(cur)          # kolonları garanti eder
        cur.execute(
            """UPDATE cari_devir
                 SET aktif=FALSE, iptal_ts=NOW(),
                     iptal_neden=NULLIF(%s,'')
               WHERE (id=%s OR tedarikci=%s) AND COALESCE(aktif,TRUE)
               RETURNING id, tedarikci, tutar::float AS tutar""",
            ((neden or "").strip()[:200], devir_id, devir_id))
        iptal = [dict(r) for r in (cur.fetchall() or [])]
        conn.commit()
    return {"ok": True, "iptal_edilen": len(iptal), "kayitlar": iptal,
            "not": "Kayıt SİLİNMEDİ — iptal damgası kondu, cari hesaba girmiyor. "
                   "Geri almak için POST /api/fatura/cari-devir/{id}/geri-al"}


@router.post("/cari-devir/{devir_id}/geri-al")
def cari_devir_geri_al(devir_id: str):
    """İptal edilmiş açılış devrini yeniden yürürlüğe alır."""
    with db() as (conn, cur):
        _cari_devirler(cur)
        cur.execute(
            """UPDATE cari_devir
                 SET aktif=TRUE, iptal_ts=NULL, iptal_neden=NULL
               WHERE (id=%s OR tedarikci=%s) AND COALESCE(aktif,TRUE)=FALSE
               RETURNING id, tedarikci, tutar::float AS tutar""",
            (devir_id, devir_id))
        geri = [dict(r) for r in (cur.fetchall() or [])]
        conn.commit()
    if not geri:
        raise HTTPException(404, "İptal edilmiş devir bulunamadı")
    return {"ok": True, "geri_alinan": geri}


@router.get("/cari-devir-iptaller")
def cari_devir_iptaller():
    """İptal edilmiş açılış devirleri — kayıt silinmediği için görülebilir."""
    with db() as (_c, cur):
        _cari_devirler(cur)
        cur.execute(
            """SELECT id, tedarikci, tutar::float AS tutar,
                      COALESCE(aciklama,'') AS aciklama,
                      iptal_ts::text AS iptal_ts,
                      COALESCE(iptal_neden,'-') AS iptal_neden
               FROM cari_devir WHERE COALESCE(aktif,TRUE)=FALSE
               ORDER BY iptal_ts DESC""")
        return {"iptaller": [dict(r) for r in (cur.fetchall() or [])]}


@router.get("/cari-ekstre")
def cari_ekstre(tedarikci: str = ""):
    """Tek tedarikçinin ekstresi: fatura zinciri + zincir farkları + bekleyen
    vadeler + ödeme ADAYLARI (3 kanal metin eşleşmesi — öneri-only)."""
    ara = (tedarikci or "").strip()
    if len(ara) < 3:
        raise HTTPException(400, "tedarikci parametresi (ad veya VKN) en az 3 karakter")
    # 🔗 KANONİK EŞDEĞERLER (2026-07-19, sahip: 'sürekli çalıştığımız tedarikçiler
    # tek tek başlıklar altında'): 'ATALAY KAHVE' sorgusu MEHMET ATALAY + Napolés
    # faturalarını da getirir — eşleştirme tablosu konuşur, tahmin değil.
    _harita = tedarikci_eslestirme_haritasi()
    _kisa = (_harita.get(ara.upper()) or {}).get("kisa")
    _es_adlar = [ara]
    if _kisa:
        if _kisa.upper() != ara.upper():
            _es_adlar.append(_kisa)
        for _hk, _hv in _harita.items():
            if _hv.get("kisa") == _kisa and _hk not in {a.upper() for a in _es_adlar}:
                _es_adlar.append(_hk)
    _es_upper = {a.upper() for a in _es_adlar}

    def _es_es(metin) -> bool:
        return any(_odeme_eslesir(a, metin) for a in _es_adlar)

    with db() as (_, cur):
        _ensure_tablolar(cur)
        # DENETİM P1-1: fatura seti artık KANONİK eşleşmeyle — cari-ozet birleşik
        # satırının adıyla gelen istek diğer yazımın ('SÜTAŞ A.Ş.' vs uzun ünvan)
        # faturalarını da görsün. SQL geniş çeker, Python kanonik süzer.
        cur.execute(
            """SELECT id, fatura_no, COALESCE(fatura_tarih, olusturma::date)::text AS tarih,
                      COALESCE(toplam_tutar,0)::float AS tutar,
                      onceki_bakiye, bakiye_dahil, tedarikci_ad, tedarikci_vkn
               FROM tedarikci_fatura
               WHERE COALESCE(durum,'') <> 'kopya'
               ORDER BY COALESCE(fatura_tarih, olusturma::date), olusturma""")
        _ara_tok = set(_cari_kanonik(None, ara).split())
        _tum = [dict(r) for r in cur.fetchall() or []]
        _sec = []
        for r in _tum:
            if (r.get("tedarikci_vkn") or "").strip() == ara:
                _sec.append(r); continue
            ad = (r.get("tedarikci_ad") or "")
            if ad.strip().upper() in _es_upper:  # 🔗 eşleştirme tablosu eşdeğeri
                _sec.append(r); continue
            if ara.lower() in ad.lower():
                _sec.append(r); continue
            ft = set(_cari_kanonik(None, ad).split())
            if _ara_tok and ft and (_ara_tok <= ft or ft <= _ara_tok):
                _sec.append(r)
        faturalar = _cari_zincir(_sec)
        # DENETİM P1-3: kişi-adlı tedarikçide ('MEHMET ATALAY') tek token
        # ('mehmet') başka kişilerin kayıtlarını topluyordu — SQL geniş, Python
        # _odeme_eslesir (soyadı-zorunlu) süzer. P1-2: LIMIT 60 + alt-sınırsız
        # geçmiş kesiliyordu — pencere sistem başlangıcı, toplam TAM sayılır.
        cur.execute(
            """SELECT tutar::float AS tutar, vade_tarihi::text AS vade,
                      COALESCE(tedarikci,'') AS ted, aciklama
               FROM vadeli_alimlar WHERE durum='bekliyor' ORDER BY vade_tarihi""")
        bekleyen_vadeler = [
            {"tutar": r["tutar"], "vade": r["vade"], "aciklama": r["aciklama"]}
            for r in (dict(x) for x in cur.fetchall() or [])
            if _es_es(f"{r['ted']} {r['aciklama'] or ''}")
            or any(_odeme_eslesir(r["ted"], a) for a in _es_adlar)]  # ters yön: 'ATALAY KAHVE' sözü ↔ 'MEHMET ATALAY'
        _ensure_kart_izi_tablolar(cur)   # cari_tedarikci damga kolonu garanti
        cur.execute(
            """SELECT kanal, tarih, tutar, aciklama, damga FROM (
                 SELECT 'vadeli_alim' AS kanal, vade_tarihi::text AS tarih,
                        tutar::float AS tutar,
                        LEFT(COALESCE(tedarikci,'') || ' ' || COALESCE(aciklama,''),80) AS aciklama,
                        NULL::text AS damga
                 FROM vadeli_alimlar
                 WHERE durum='odendi' AND vade_tarihi >= %s::date
                 UNION ALL
                 SELECT 'anlik_gider', tarih::text, tutar::float,
                        LEFT(COALESCE(tedarikci,'') || ' ' || COALESCE(aciklama,''),80),
                        NULL::text
                 FROM anlik_giderler
                 WHERE durum='aktif' AND kaynak_id IS NULL AND tarih >= %s::date
                 UNION ALL
                 SELECT 'kart', h.tarih::text, h.tutar::float, LEFT(COALESCE(h.aciklama,''),80),
                        h.cari_tedarikci
                 FROM kart_hareketleri h
                 WHERE h.islem_turu='HARCAMA' AND h.durum='aktif'
                   -- 🐞 FIX (2026-08-03, FEZ vakası): banka-ekstresi importu
                   -- kaynak_id DOLU yazar (id=eks_*) — IS NULL şartı TÜM banka
                   -- ödemelerini cariden gizliyordu (FEZ 25.06 100K, DYK 76.700
                   -- görünmüyordu). ekstre_import istisnası eklendi; eşlenik
                   -- agk_ anlık gideri kanal-2'de zaten elendiği için çift
                   -- düşmez (tek kanal: kart satırı).
                   AND (h.kaynak_id IS NULL OR COALESCE(h.kaynak_tablo,'') = 'ekstre_import')
                   AND COALESCE(h.harcama_tipi,'belirsiz') <> 'sahsi'
                   AND h.tarih >= %s::date) x
               ORDER BY tarih""",
            (EVVEL_SISTEM_BASLANGIC, EVVEL_SISTEM_BASLANGIC, EVVEL_SISTEM_BASLANGIC))
        # DAMGA ÖNCELİĞİ (2026-08-08): sahip bir kart çekimini bir tedarikçiye
        # bağladıysa ad eşleşmesi ARANMAZ — damga konuşur. '(ilgisiz)' damgası
        # satırı tümden eler (sahip "bu bizim toptancı ödememiz değil" dedi).
        # Damgasız satırlar eski davranışla, ad eşleşmesiyle aday kalır.
        def _odeme_dahil(r) -> bool:
            d = (r.get("damga") or "").strip()
            if d == "(ilgisiz)":
                return False
            if d:
                return _cari_katla(d) in {_cari_katla(a) for a in _es_adlar}
            return _es_es(r.get("aciklama"))

        odeme_adaylari = [r for r in (dict(x) for x in cur.fetchall() or [])
                          if _odeme_dahil(r)]
        _devirler = _cari_devirler(cur)
    # 📜 açılış devri — bu tedarikçiye eşleşen sahip beyanı (çift yön eşleşme)
    devir, devir_not = 0.0, None
    for dv in _devirler:
        if _es_es(dv["tedarikci"]) or any(_odeme_eslesir(dv["tedarikci"], a) for a in _es_adlar):
            devir = round(devir + float(dv["tutar"] or 0), 2)
            devir_not = dv.get("aciklama") or devir_not
    for f in faturalar:
        f["goruntule"] = f"/api/fatura/{f['id']}/foto"
    beyan = next((f["bakiye_dahil"] for f in reversed(faturalar)
                  if f.get("bakiye_dahil") is not None), None)
    # AY AY MUTABAKAT (sahip 2026-07-14: "her toptancıyı ay ay ödeme ve gelen
    # faturalarını görsek, detaya bak deyince fatura PDF görebilsek"):
    # aynı veriden ay kırılımı — KOD hesaplar, UI yalnız gösterir.
    aylik: dict = {}
    for f in faturalar:
        ay_k = str(f["tarih"])[:7]
        a = aylik.setdefault(ay_k, {"ay": ay_k, "fatura_adet": 0, "fatura_toplam": 0.0,
                                    "odeme_adet": 0, "odeme_toplam": 0.0})
        a["fatura_adet"] += 1
        a["fatura_toplam"] = round(a["fatura_toplam"] + float(f["tutar"] or 0), 2)
    for o in odeme_adaylari:
        ay_k = str(o["tarih"])[:7]
        a = aylik.setdefault(ay_k, {"ay": ay_k, "fatura_adet": 0, "fatura_toplam": 0.0,
                                    "odeme_adet": 0, "odeme_toplam": 0.0})
        a["odeme_adet"] += 1
        a["odeme_toplam"] = round(a["odeme_toplam"] + float(o["tutar"] or 0), 2)
    for a in aylik.values():
        a["fark"] = round(a["fatura_toplam"] - a["odeme_toplam"], 2)
        a["sistem_oncesi"] = a["ay"] < EVVEL_SISTEM_BASLANGIC[:7]  # arşiv, hesaba girmez
    aylik_liste = sorted(aylik.values(), key=lambda x: x["ay"], reverse=True)

    # YÜRÜYEN BAKİYE EKSTRESİ (sahip 2026-07-14: "159.000 olmuş, 59.000 ödemişim
    # 100.000 kalmış, yeni faturalar gelmiş — sırayla görebilmeliyim; elle giriş
    # yapılsa bile fatura gelince AYNI borç işlenmeli; ödeme illa fatura tutarı
    # kadar olmayacak"): balance-forward deseni — borç YALNIZ faturadan doğar
    # (elle vadeli alım kaydı borcu İKİNCİ kez yaratmaz; o vade takibi + ödeme
    # izidir), ödeme bakiyeden düşer (kısmi/toplu ödeme doğal desteklenir).
    hareketler = []
    for f in faturalar:
        if str(f["tarih"]) >= EVVEL_SISTEM_BASLANGIC:
            hareketler.append({"tip": "fatura", "tarih": str(f["tarih"]),
                               "tutar": round(float(f["tutar"] or 0), 2),
                               "aciklama": f.get("fatura_no") or "fatura",
                               "goruntule": f.get("goruntule")})
    for o in odeme_adaylari:
        if str(o["tarih"]) >= EVVEL_SISTEM_BASLANGIC:
            hareketler.append({"tip": "odeme", "tarih": str(o["tarih"]),
                               "tutar": round(float(o["tutar"] or 0), 2),
                               "aciklama": f"{o.get('kanal')}: {(o.get('aciklama') or '')[:40]}"})
    # Aynı günde fatura önce işlenir (bakiye sezgisel yürüsün)
    hareketler.sort(key=lambda h: (h["tarih"], 0 if h["tip"] == "fatura" else 1))
    # 📜 Ekstre DEVİRLE başlar (Codex teyitli dünya pratiği: açılış fişi) —
    # negatif devir = avans/alacağımız, pozitif = kalan borcumuz.
    if devir:
        hareketler.insert(0, {
            "tip": "devir", "tarih": EVVEL_SISTEM_BASLANGIC,
            "tutar": devir,
            "aciklama": f"📜 sistem öncesi devir (sahip beyanı"
                        f"{': ' + devir_not[:40] if devir_not else ''})"})
    bakiye = 0.0
    for h in hareketler:
        bakiye = round(bakiye + (-h["tutar"] if h["tip"] == "odeme" else h["tutar"]), 2)
        h["bakiye"] = bakiye

    # BİZİM TARAF HESABI: fatura(+) − ödeme izi(−); iz yoksa açık büyür.
    # Pencere sistem başlangıcından önceye TAŞMAZ (Haziran 2026 öncesi veri yok).
    _kesit = _cari_pencere_kesiti(180)
    fatura_toplam = round(sum(f["tutar"] for f in faturalar
                              if str(f["tarih"]) >= _kesit), 2)
    odeme_toplam = round(sum(o["tutar"] for o in odeme_adaylari
                             if str(o["tarih"]) >= _kesit), 2)
    return {
        "arama": ara,
        "fatura_adet": len(faturalar),
        "faturalar": faturalar[-60:],
        "beyan_bakiye": (round(float(beyan), 2) if beyan is not None else None),
        "devir": devir, "devir_not": devir_not,
        "fatura_toplam_6ay": fatura_toplam,
        "odeme_izi_toplam_6ay": odeme_toplam,
        "hesaplanan_acik": round(devir + fatura_toplam - odeme_toplam, 2),
        "aylik": aylik_liste,
        "hareketler": hareketler[-80:],
        "yuruyen_bakiye": (hareketler[-1]["bakiye"] if hareketler else 0.0),
        "bekleyen_vadeler": bekleyen_vadeler,
        "bekleyen_vade_toplam": round(sum(v["tutar"] for v in bekleyen_vadeler), 2),
        "odeme_adaylari": odeme_adaylari,
        "not": ("Beyan bakiye = tedarikçinin fatura üstü beyanı (≈). Ödeme adayları "
                "metin eşleşmesidir — kesin mutabakat değil (öneri-only). VKN'siz "
                "tedarikçilerde ad yazım farkı ayrı satır açabilir — kanonik çözüm "
                "VKN (fatura OCR'ı doldurdukça birleşir)."),
    }


# ── BM-2: 5'Lİ MUTABAKAT ZİNCİRİ (2026-07-10, belge-seviyesi v1) ────────────
# SİPARİŞ → TESLİM → BELGE TALEBİ → FATURA → ÖDEME İZİ halkaları. Satır-bazlı
# varyans BİLİNÇLİ ertelendi (fizibilite: kanonik ürün kimliği + birim dönüşümü
# önkoşul; N2 bulgusu: sipariş fiyatı siparişe yazılmıyor). Salt-okur, öneri-only.
# Sahip kararı (2026-07-18): zincir YALNIZ 15 Temmuz 2026 SONRASI siparişlerde
# çalışır — öncesinde teslim-al/belge disiplini oturmamıştı, 'teslim alınmadı /
# fatura yok' uyarıları eski dönem için normaldi ve gürültü üretiyordu.
MUTABAKAT_BASLANGIC = "2026-07-15"


def mutabakat_zinciri() -> dict:
    from datetime import date as _d
    with db() as (_, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """SELECT ts.id, ts.talep_id, ts.tedarikci_ad,
                      ts.olusturma::date::text AS siparis_tarihi,
                      ts.durum, (ts.teslim_ts IS NOT NULL) AS teslim_var,
                      bt.durum AS belge_durum, bt.kapanis_tipi, bt.fatura_id
               FROM toptanci_siparis ts
               LEFT JOIN belge_talep bt ON bt.ts_id = ts.id
               WHERE ts.olusturma >= GREATEST(CURRENT_DATE - 60, %s::date)
                 AND COALESCE(ts.durum,'') NOT IN ('iptal','iptal_edildi')
               ORDER BY ts.olusturma DESC""", (MUTABAKAT_BASLANGIC,))
        siparisler = [dict(r) for r in cur.fetchall() or []]
        cur.execute(
            """SELECT siparis_talep_id, id, COALESCE(toplam_tutar,0)::float AS tutar,
                      COALESCE(fatura_tarih, olusturma::date)::text AS tarih
               FROM tedarikci_fatura
               WHERE siparis_talep_id IS NOT NULL
                 AND COALESCE(durum,'') <> 'kopya'
                 AND olusturma >= CURRENT_DATE - 75""")
        fatura_map: dict = {}
        for r in cur.fetchall() or []:
            fatura_map.setdefault(r["siparis_talep_id"], []).append(dict(r))
        # Ödeme izi penceresi (3 kanal, türetilmişler hariç) — tek sorgu
        cur.execute(
            """SELECT tarih::text AS tarih, tutar::float AS tutar FROM (
                 SELECT vade_tarihi AS tarih, tutar FROM vadeli_alimlar
                 WHERE durum='odendi' AND vade_tarihi >= CURRENT_DATE - 75
                 UNION ALL
                 SELECT tarih, tutar FROM anlik_giderler
                 WHERE durum='aktif' AND kaynak_id IS NULL
                   AND tarih >= CURRENT_DATE - 75
                 UNION ALL
                 SELECT tarih, tutar FROM kart_hareketleri
                 WHERE islem_turu='HARCAMA' AND durum='aktif' AND kaynak_id IS NULL
                   AND tarih >= CURRENT_DATE - 75) x""")
        odemeler = [dict(r) for r in cur.fetchall() or []]

    def _odeme_izi(tutar: float, tarih: str) -> bool:
        for o in odemeler:
            if abs(o["tutar"] - tutar) > max(5.0, tutar * 0.02):
                continue
            try:
                gf = abs((_d.fromisoformat(str(tarih)[:10])
                          - _d.fromisoformat(str(o["tarih"])[:10])).days)
            except Exception:  # noqa: BLE001
                continue
            if gf <= 10:
                return True
        return False

    zincirler, sayac = [], {"tam": 0, "teslim_yok": 0, "belge_acik": 0,
                            "fatura_yok": 0, "odeme_izi_yok": 0}
    for s in siparisler:
        halka = {"siparis": True, "teslim": bool(s["teslim_var"] or s["belge_durum"]),
                 "belge": s.get("belge_durum") in ("pdf_geldi", "kapandi"),
                 "fatura": False, "odeme_izi": None}
        fl = fatura_map.get(s.get("talep_id")) or []
        if s.get("fatura_id") or fl:
            halka["fatura"] = True
            f0 = fl[0] if fl else None
            if f0 and f0["tutar"] > 0:
                halka["odeme_izi"] = _odeme_izi(f0["tutar"], f0["tarih"])
        if not halka["teslim"]:
            eksik = "teslim_yok"
        elif not halka["fatura"] and s.get("belge_durum") == "bekliyor":
            eksik = "belge_acik"
        elif not halka["fatura"]:
            eksik = "fatura_yok"
        elif halka["odeme_izi"] is False:
            eksik = "odeme_izi_yok"
        else:
            eksik = None
            sayac["tam"] += 1
        if eksik:
            sayac[eksik] += 1
        zincirler.append({**{k: s.get(k) for k in
                             ("id", "tedarikci_ad", "siparis_tarihi")},
                          "halkalar": halka, "eksik": eksik})
    return {
        "pencere_gun": 60, "baslangic": MUTABAKAT_BASLANGIC,
        "siparis_adet": len(siparisler), "sayac": sayac,
        "eksik_zincirler": [z for z in zincirler if z["eksik"]][:25],
        "not": ("Belge-SEVİYESİ zincir (v1): sipariş→teslim→belge→fatura→ödeme izi. "
                "YALNIZ 15.07.2026 sonrası siparişler denetlenir (sahip kararı — "
                "öncesinde teslim-al/belge disiplini yoktu, uyarılar normaldi). "
                "Ödeme izi = tutar/tarih aday eşleşmesi (kesin mutabakat değil; "
                "kısmi ödeme/çok-fatura-tek-ödeme izi düşürebilir). Satır-bazlı "
                "varyans, kanonik ürün kimliği kurulunca (öneri-only)."),
    }


@router.get("/mutabakat-zinciri")
def mutabakat_zinciri_uc():
    return mutabakat_zinciri()


# ── BM-3: KDV KANIT SINIFLAMASI (2026-07-10, belge-kanıt seviyesi v1) ───────
# BİLİNÇLİ DAR KAPSAM (fizibilite: KDV/istisna/tevkifat kural seti olmadan
# 'yanlış güven' üretme): KDV TUTARI HESAPLANMAZ; yalnız belge-kanıt gücü
# sınıflanır. Hüküm muhasebecinin.

def kdv_kanit_ozet(ay: str = "") -> dict:
    from datetime import date as _d
    hedef = (ay or "").strip()[:7] or _d.today().strftime("%Y-%m")
    with db() as (_, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """SELECT COALESCE(toplam_tutar,0)::float AS tutar,
                      NULLIF(TRIM(COALESCE(fatura_no,'')),'') AS fno,
                      NULLIF(TRIM(COALESCE(tedarikci_vkn,'')),'') AS vkn,
                      gib_dogrulama
               FROM tedarikci_fatura
               WHERE TO_CHAR(COALESCE(fatura_tarih, olusturma::date),'YYYY-MM') = %s
                 AND COALESCE(durum,'') <> 'kopya'""",
            (hedef,))
        rows = [dict(r) for r in cur.fetchall() or []]
    saglam, inceleme, supheli = [], [], []
    for r in rows:
        if r.get("gib_dogrulama") == "supheli":
            supheli.append(r)
        elif r["fno"] and (r["vkn"] or r.get("gib_dogrulama") == "dogrulandi"):
            saglam.append(r)
        else:
            inceleme.append(r)
    def _t(liste):
        return round(sum(x["tutar"] for x in liste), 2)
    return {
        "ay": hedef,
        "indirime_aday": {"adet": len(saglam), "toplam": _t(saglam)},
        "inceleme": {"adet": len(inceleme), "toplam": _t(inceleme)},
        "supheli": {"adet": len(supheli), "toplam": _t(supheli)},
        "not": ("BELGE-KANIT sınıflaması (v1): 'indirime aday' = fatura no + "
                "(VKN veya GİB damgası ✓); 'inceleme' = no/VKN eksik; 'şüpheli' = "
                "GİB damgası şüpheli. KDV TUTARI HESAPLANMAZ — hüküm muhasebecinin. "
                "Eksikleri kapatmanın yolu: fatura onay ekranında no/VKN tamamla + "
                "GİB damgala."),
    }


@router.get("/kdv-kanit")
def kdv_kanit_uc(ay: str = ""):
    return kdv_kanit_ozet(ay)


# ── BM-6: SATIR FİYAT BANDI (2026-07-10) ────────────────────────────────────
# Onaylı fatura kalemlerinden ürün başına fiyat bandı (medyan + aralık) çıkar;
# SON fiyat bandın ±%10 dışındaysa ve/veya maliyet kartındaki (urun_alis_fiyat)
# fiyattan saparsa ADAY olarak gösterir. Fizibilite şartı: birim dönüşümü YOK —
# yalnız AYNI BİRİM kıyaslanır (gramaj/koli master-data işi, heuristik yasak).
# Öneri-only: hiçbir fiyat kaydını DEĞİŞTİRMEZ.

def fiyat_bandi_ozet() -> dict:
    from statistics import median
    with db() as (_, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """SELECT k.eslesen_stok_kodu AS kod,
                      COALESCE(NULLIF(TRIM(k.ocr_ad),''),'?') AS ad,
                      LOWER(COALESCE(NULLIF(TRIM(k.birim),''),'adet')) AS birim,
                      COALESCE(f.fatura_tarih, f.olusturma::date)::text AS tarih,
                      k.birim_fiyat::float AS fiyat, f.tedarikci_ad AS tedarikci
               FROM tedarikci_fatura_kalem k
               JOIN tedarikci_fatura f ON f.id = k.fatura_id
               WHERE k.eslesen_stok_kodu IS NOT NULL AND k.birim_fiyat > 0
                 AND COALESCE(f.fatura_tarih, f.olusturma::date) >= CURRENT_DATE - 180
               ORDER BY COALESCE(f.fatura_tarih, f.olusturma::date)""")
        satirlar = [dict(r) for r in cur.fetchall() or []]
        cur.execute(
            """SELECT DISTINCT ON (kalem_kodu) kalem_kodu, birim,
                      birim_maliyet_tl::float AS kart_fiyat
               FROM urun_alis_fiyat
               WHERE gecerli_bitis IS NULL OR gecerli_bitis >= CURRENT_DATE
               ORDER BY kalem_kodu, gecerli_baslangic DESC""")
        kartlar = {(r["kalem_kodu"], (r["birim"] or "adet").lower()): float(r["kart_fiyat"])
                   for r in cur.fetchall() or []}

    gruplar: dict = {}
    for s in satirlar:
        gruplar.setdefault((s["kod"], s["birim"]), []).append(s)
    bantlar, band_disi = [], []
    for (kod, birim), gl in gruplar.items():
        if len(gl) < 3:
            continue  # 3 gözlem altı band kurulamaz (yanlış güven üretme)
        fiyatlar = [g["fiyat"] for g in gl]
        med = round(median(fiyatlar), 4)
        son = gl[-1]
        sapma = round((son["fiyat"] - med) / med * 100, 1) if med > 0 else None
        kart = kartlar.get((kod, birim))
        kart_sapma = (round((son["fiyat"] - kart) / kart * 100, 1)
                      if kart and kart > 0 else None)
        b = {"kod": kod, "ad": son["ad"], "birim": birim, "gozlem": len(gl),
             "medyan": med, "aralik": [round(min(fiyatlar), 4), round(max(fiyatlar), 4)],
             "son_fiyat": son["fiyat"], "son_tarih": son["tarih"],
             "son_tedarikci": son.get("tedarikci"),
             "sapma_yuzde": sapma, "kart_fiyat": kart, "kart_sapma_yuzde": kart_sapma}
        bantlar.append(b)
        if (sapma is not None and abs(sapma) >= 10) or \
           (kart_sapma is not None and abs(kart_sapma) >= 10):
            band_disi.append(b)
    band_disi.sort(key=lambda x: -abs(x.get("sapma_yuzde") or 0))
    return {
        "urun_adet": len(bantlar),
        "band_disi_adet": len(band_disi),
        "band_disi": band_disi[:20],
        "bantlar": sorted(bantlar, key=lambda x: -abs(x.get("sapma_yuzde") or 0))[:40],
        "not": ("Band = onaylı fatura kalemlerinin 180 günlük medyanı (≥3 gözlem, AYNI "
                "birim). Sapma ≥%10 ADAY — fiyat kaydı DEĞİŞTİRİLMEZ, maliyet kartı "
                "güncellemesi insan onayıyla (Price Approval). Birim dönüşümü yapılmaz."),
    }


@router.get("/fiyat-bandi")
def fiyat_bandi_uc():
    return fiyat_bandi_ozet()


def gece_fiyat_bandi_izleme() -> dict:
    """GECE: band dışı ürünler omurgaya olay olarak yazılır (gün-idempotent).
    Hata-yutar — gece zinciri yaşar."""
    try:
        o = fiyat_bandi_ozet()
        try:
            from duyu_omurga import duyu_olay_yaz
            for b in (o.get("band_disi") or [])[:10]:
                duyu_olay_yaz(
                    "belge", "belge.fiyat.band_disi",
                    f"{b['kod']}|{b['son_tarih']}",
                    entity_scope="urun", entity_id=b["kod"],
                    signal_name="Fiyat bandı dışı alım",
                    payload={"ad": b["ad"], "birim": b["birim"],
                             "medyan": b["medyan"], "son_fiyat": b["son_fiyat"],
                             "sapma_yuzde": b["sapma_yuzde"],
                             "kart_sapma_yuzde": b["kart_sapma_yuzde"],
                             "tedarikci": b.get("son_tedarikci")})
        except Exception:  # noqa: BLE001
            pass
        return {"ok": True, "band_disi": o.get("band_disi_adet", 0)}
    except Exception as e:  # noqa: BLE001
        logger.warning("fiyat bandi izleme hatasi (yutuldu): %s", str(e)[:200])
        return {"ok": False, "hata": str(e)[:200]}


@router.get("/bekleyen")
def fatura_bekleyen(sube_id: Optional[str] = None, limit: int = 50):
    """İncelenmeyi bekleyen faturalar (OCR tamam ama insan onayı yok)."""
    if not fatura_modul_aktif():
        return {"satirlar": []}
    lim = max(1, min(200, int(limit or 50)))
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        kosul = "durum IN ('ocr_tamam','ocr_hata','ocr_bekliyor')"
        params: List[Any] = []
        if sube_id:
            kosul += " AND sube_id=%s"
            params.append(sube_id.strip())
        cur.execute(
            f"""
            SELECT id, sube_id, tedarikci_ad, fatura_tarih, toplam_tutar, durum,
                   ocr_hata, olusturma
            FROM tedarikci_fatura
            WHERE {kosul}
            ORDER BY olusturma DESC
            LIMIT %s
            """,
            tuple(params + [lim]),
        )
        rows = [dict(r) for r in (cur.fetchall() or [])]
    for r in rows:
        r["fatura_tarih"] = str(r.get("fatura_tarih") or "")
        r["olusturma"] = str(r.get("olusturma") or "")
    return {"satirlar": rows, "toplam": len(rows)}


_CEK_HTML = """<!doctype html><html lang="tr"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<title>Fatura Çek</title>
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;background:#0f172a;color:#e2e8f0;font-family:-apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:560px;margin:0 auto;padding:16px;min-height:100vh;display:flex;flex-direction:column;gap:14px}
  h1{font-size:18px;margin:4px 0 0}
  .sub{font-size:13px;color:#94a3b8;margin-bottom:4px}
  video,canvas,img.snap{width:100%;border-radius:14px;background:#000;aspect-ratio:3/4;object-fit:cover}
  .btn{border:0;border-radius:14px;padding:18px;font-size:18px;font-weight:700;cursor:pointer;width:100%}
  .btn-acik{background:#3b82f6;color:#fff}
  .btn-cek{background:#22c55e;color:#06281a}
  .btn-yukle{background:#22c55e;color:#06281a}
  .btn-tekrar{background:#334155;color:#e2e8f0}
  .row{display:flex;gap:10px}
  .row .btn{flex:1}
  .hata{background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.5);border-radius:12px;padding:12px;font-size:14px}
  .ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.4);border-radius:12px;padding:12px}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
  th,td{text-align:left;padding:6px 4px;border-bottom:1px solid #1e293b}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  .durum{font-size:14px;color:#cbd5e1;display:flex;align-items:center;gap:8px}
  .spin{width:16px;height:16px;border:2px solid #475569;border-top-color:#22c55e;border-radius:50%;animation:s 1s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
  .gizle{display:none}
</style></head><body><div class="wrap">
  <div><h1>📄 Fatura Çek</h1><div class="sub" id="subeAd"></div></div>
  <div id="hata" class="hata gizle"></div>

  <div id="adimKamera">
    <video id="vid" autoplay playsinline muted></video>
    <div style="height:10px"></div>
    <button id="btnAc" class="btn btn-acik">📷 Kamerayı Aç</button>
    <button id="btnCek" class="btn btn-cek gizle">⚪ Çek</button>
  </div>

  <div id="adimOnizle" class="gizle">
    <img id="snap" class="snap"/>
    <div id="cozunurluk" class="sub" style="text-align:center;margin-top:6px"></div>
    <div style="height:10px"></div>
    <div class="row">
      <button id="btnTekrar" class="btn btn-tekrar">↺ Tekrar Çek</button>
      <button id="btnYukle" class="btn btn-yukle">⬆ Yükle</button>
    </div>
  </div>

  <div id="adimSonuc" class="gizle">
    <div id="durumKutu" class="durum"><span class="spin"></span><span id="durumYazi">OCR bekleniyor…</span></div>
    <div id="sonucKutu"></div>
    <div style="height:8px"></div>
    <button id="btnYeni" class="btn btn-acik">＋ Yeni Fatura</button>
  </div>

  <canvas id="cv" class="gizle"></canvas>
</div>
<script>
const qp=new URLSearchParams(location.search);
const SUBE=qp.get('sube_id')||'';
const TALEP=qp.get('siparis_talep_id')||'';
document.getElementById('subeAd').textContent = SUBE ? ('Şube: '+SUBE) : 'Şube belirtilmedi (sube_id parametresi gerekli)';
let stream=null, blob=null;
const $=id=>document.getElementById(id);
function hata(m){const h=$('hata');h.textContent=m;h.classList.remove('gizle');}
function temizHata(){$('hata').classList.add('gizle');}
function goster(id){['adimKamera','adimOnizle','adimSonuc'].forEach(a=>$(a).classList.toggle('gizle',a!==id));}

async function _kameraAc(constraints){
  return await navigator.mediaDevices.getUserMedia(constraints);
}
$('btnAc').onclick=async()=>{
  temizHata();
  // Fatura yazısı net olsun diye YÜKSEK çözünürlük iste; cihaz reddederse sade isteğe düş.
  const hi={video:{facingMode:{ideal:'environment'},width:{ideal:3840},height:{ideal:2160}},audio:false};
  const lo={video:{facingMode:{ideal:'environment'}},audio:false};
  try{
    try{ stream=await _kameraAc(hi); }
    catch(_){ stream=await _kameraAc(lo); }
    $('vid').srcObject=stream;
    $('btnAc').classList.add('gizle');$('btnCek').classList.remove('gizle');
  }catch(e){hata('Kamera açılamadı: '+(e.message||e)+' (HTTPS ve kamera izni gerekli)');}
};
$('btnCek').onclick=()=>{
  const v=$('vid'),cv=$('cv');
  cv.width=v.videoWidth||1080;cv.height=v.videoHeight||1440;
  cv.getContext('2d').drawImage(v,0,0,cv.width,cv.height);
  // Yoğun fatura metni için JPEG kalitesi yüksek (0.92).
  cv.toBlob(b=>{
    blob=b;$('snap').src=URL.createObjectURL(b);
    var info=$('cozunurluk');
    if(info){
      var dusuk=(cv.width<1280);
      var kb=b?Math.round(b.size/1024):0;
      info.innerHTML='Çözünürlük: <b>'+cv.width+'×'+cv.height+'</b> · '+kb+' KB '
        +(dusuk?'<span style="color:#f59e0b">⚠ düşük — daha yakın çek, ışığı artır</span>':'<span style="color:#22c55e">✓ net</span>');
    }
    goster('adimOnizle');
  },'image/jpeg',0.92);
};
$('btnTekrar').onclick=()=>goster('adimKamera');
$('btnYukle').onclick=async()=>{
  if(!blob){hata('Önce fotoğraf çek');return;}
  if(!SUBE){hata('sube_id parametresi eksik — şube panelinden açın');return;}
  temizHata();$('btnYukle').disabled=true;$('btnYukle').textContent='Yükleniyor…';
  try{
    const fd=new FormData();
    fd.append('foto',blob,'fatura.jpg');fd.append('sube_id',SUBE);
    if(TALEP)fd.append('siparis_talep_id',TALEP);
    const r=await fetch('/api/fatura/yukle',{method:'POST',body:fd});
    const d=await r.json();
    if(!r.ok)throw new Error(d.detail||'yükleme hatası');
    // kamerayı kapat
    if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}
    goster('adimSonuc');pollOCR(d.fatura_id);
  }catch(e){hata('Yükleme hatası: '+(e.message||e));}
  $('btnYukle').disabled=false;$('btnYukle').textContent='⬆ Yükle';
};
async function pollOCR(fid){
  for(let i=0;i<30;i++){
    await new Promise(r=>setTimeout(r,2000));
    let d;try{d=await (await fetch('/api/fatura/'+fid)).json();}catch(e){continue;}
    const f=d.fatura||{};
    if(f.durum==='ocr_tamam'){renderSonuc(f,d.kalemler||[]);return;}
    if(f.durum==='ocr_hata'){
      $('durumKutu').innerHTML='';
      $('sonucKutu').innerHTML='<div class="hata">OCR okunamadı: '+(f.ocr_hata||'bilinmeyen')+'. Fatura kaydedildi, merkez manuel inceleyebilir.</div>';
      return;
    }
  }
  $('durumKutu').innerHTML='';
  $('sonucKutu').innerHTML='<div class="ok">Fatura yüklendi. OCR arka planda devam ediyor — sonuç merkez inceleme ekranına düşecek.</div>';
}
function renderSonuc(f,kalemler){
  $('durumKutu').innerHTML='';
  let h='<div class="ok"><b>'+(f.tedarikci_ad||'(tedarikçi okunamadı)')+'</b>';
  if(f.fatura_tarih)h+=' · '+f.fatura_tarih;
  if(f.toplam_tutar!=null)h+=' · Toplam '+f.toplam_tutar+'₺';
  h+='</div>';
  if(kalemler.length){
    h+='<table><tr><th>Ürün</th><th class="num">Adet</th><th class="num">B.Fiyat</th><th class="num">Tutar</th></tr>';
    kalemler.forEach(k=>{h+='<tr><td>'+(k.ocr_ad||'-')+'</td><td class="num">'+(k.adet??'-')+'</td><td class="num">'+(k.birim_fiyat??'-')+'</td><td class="num">'+(k.satir_toplam??'-')+'</td></tr>';});
    h+='</table>';
  }
  h+='<div class="sub" style="margin-top:10px">✅ Yüklendi. Merkez onayına düştü — fiyatlar onaysız hiçbir yere yazılmaz.</div>';
  $('sonucKutu').innerHTML=h;
}
$('btnYeni').onclick=()=>{blob=null;temizHata();$('sonucKutu').innerHTML='';$('durumKutu').innerHTML='<span class="spin"></span><span id="durumYazi">OCR bekleniyor…</span>';goster('adimKamera');};
</script></body></html>"""


@router.get("/qr")
def fatura_qr(sube_id: str, siparis_talep_id: Optional[str] = None):
    """Panel PC'de çalışıyor → fatura TELEFON kamerasıyla çekilmeli. Bu QR'ı PC'de
    gösterir; personel telefonuyla okutunca /cek sayfası TELEFONDA açılır (telefon
    kamerası). Mutlak URL gerekir (telefon erişebilsin) → APP_URL env."""
    if not fatura_modul_aktif():
        raise HTTPException(503, "Fatura modülü kapalı.")
    try:
        import qrcode
    except ImportError:
        raise HTTPException(500, "qrcode kütüphanesi yok")
    base = os.getenv("APP_URL", "https://evvel-erp-production.up.railway.app").rstrip("/")
    url = f"{base}/api/fatura/cek?sube_id={sube_id}"
    if siparis_talep_id:
        url += f"&siparis_talep_id={siparis_talep_id}"
    # box_size büyük + border (sessiz alan) geniş → telefon kamerası kolay okur.
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=16, border=4)
    qr.add_data(url)
    qr.make(fit=True)
    # PIL ile çiz (gorev_api QR deseni — production'da PIL var, PyPNG yok)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return StreamingResponse(buf, media_type="image/png")


@router.get("/cek", response_class=HTMLResponse)
def fatura_cek_sayfasi():
    """Personel telefonu için CANLI KAMERA fatura çekme sayfası (galeri yok).
    Şube paneli ?sube_id=...&siparis_talep_id=... ile açar. İzole, kendi içinde yeterli."""
    if not fatura_modul_aktif():
        return HTMLResponse("<h3 style='font-family:sans-serif'>Fatura modülü kapalı.</h3>", status_code=503)
    return HTMLResponse(_CEK_HTML)


@router.get("/{fatura_id}/foto")
def fatura_foto(fatura_id: str):
    """Saklanan fatura belgesi (foto/PDF). Dosya yoksa ama PDF METNİ varsa metin
    kopyası HTML olarak gösterilir (sahip şikayeti 2026-07-14: eski PDF yüklemeleri
    dosyayı saklamıyordu — 'gör' boş dönmesin, elde ne varsa göstersin)."""
    if not fatura_modul_aktif():
        raise HTTPException(503, "Fatura modülü kapalı.")
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute("""SELECT foto, foto_mime, kaynak_metin, tedarikci_ad, fatura_no,
                              fatura_tarih::text AS tarih
                       FROM tedarikci_fatura WHERE id=%s""", (fatura_id,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Fatura bulunamadı")
        d = dict(r)
        foto = d.get("foto")
        if foto:
            mime = d.get("foto_mime") or "image/jpeg"
            return StreamingResponse(io.BytesIO(bytes(foto)), media_type=mime)
    metin = (d.get("kaynak_metin") or "").strip()
    if metin:
        from fastapi.responses import HTMLResponse
        import html as _html
        return HTMLResponse(
            "<html><head><meta charset='utf-8'><title>Fatura metin kopyası</title></head>"
            "<body style='font-family:monospace;background:#111;color:#eee;padding:20px'>"
            f"<h3>🧾 {_html.escape(d.get('tedarikci_ad') or '')} · "
            f"{_html.escape(d.get('fatura_no') or 'no yok')} · "
            f"{_html.escape(d.get('tarih') or '')}</h3>"
            "<p style='color:#f59e0b'>⚠ Orijinal PDF bu kayıtta saklanmamış (eski "
            "yükleme) — aşağıdaki METİN KOPYASI gösteriliyor. Yeni yüklemelerde "
            "orijinal PDF de saklanır.</p><pre style='white-space:pre-wrap'>"
            + _html.escape(metin) + "</pre></body></html>")
    raise HTTPException(410, "Bu kayıtta belge dosyası yok (eski yükleme dosya "
                             "saklamıyordu ya da saklama süresi doldu).")


@router.get("/{fatura_id}")
def fatura_detay(fatura_id: str):
    """Tek fatura: başlık + OCR kalemleri (öneri-only)."""
    if not fatura_modul_aktif():
        raise HTTPException(503, "Fatura modülü kapalı.")
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """
            SELECT id, sube_id, siparis_talep_id, tedarikci_ad, fatura_tarih,
                   toplam_tutar, durum, ocr_hata, olusturma,
                   fatura_no, onceki_bakiye, bakiye_dahil
            FROM tedarikci_fatura WHERE id=%s
            """,
            (fatura_id,),
        )
        h = cur.fetchone()
        if not h:
            raise HTTPException(404, "Fatura bulunamadı")
        h = dict(h)
        cur.execute(
            """
            SELECT id, sira, ocr_ad, ocr_urun_kodu, adet, birim, birim_fiyat, satir_toplam,
                   eslesen_stok_kodu, eslesme_guven, onaylandi
            FROM tedarikci_fatura_kalem WHERE fatura_id=%s ORDER BY sira
            """,
            (fatura_id,),
        )
        kalemler = [dict(r) for r in (cur.fetchall() or [])]
        # ── KÖPRÜ: eşleşen kalemler için son bilinen fiyat + değişim (zam) ──
        _ref_tarih = str(h.get("fatura_tarih") or "").strip() or None  # tarih eşleştirmesi
        for k in kalemler:
            kod = k.get("eslesen_stok_kodu")
            son = _son_alis_fiyat(cur, kod, _ref_tarih) if kod else None
            if son:
                k["onceki_fiyat"] = float(son.get("birim_maliyet_tl") or 0)
                k["onceki_tarih"] = son.get("tarih")
                yeni = k.get("birim_fiyat")
                if yeni is not None and k["onceki_fiyat"]:
                    k["fiyat_degisim"] = round(float(yeni) - k["onceki_fiyat"], 4)
                    k["fiyat_degisim_yuzde"] = round(
                        (float(yeni) - k["onceki_fiyat"]) / k["onceki_fiyat"] * 100, 1
                    )
            else:
                k["onceki_fiyat"] = None
                k["onceki_tarih"] = None
        # ── Bağlı sipariş (N2) kalemleri: insan "fatura ne diyor vs ne ısmarladık"
        # karşılaştırsın. SALT GÖRÜNÜM — stoğa yazma yok, fuzzy eşleştirme yok. ──
        siparis_kalemler: List[Dict[str, Any]] = []
        _stid = str(h.get("siparis_talep_id") or "").strip()
        if _stid:
            try:
                cur.execute(
                    "SELECT kalemler FROM toptanci_siparis WHERE talep_id=%s AND durum <> 'iptal'",
                    (_stid,),
                )
                _agg: Dict[str, Dict[str, Any]] = {}
                _sira: List[str] = []
                for _row in cur.fetchall() or []:
                    _kl = dict(_row).get("kalemler") or []
                    if isinstance(_kl, str):
                        try:
                            _kl = json.loads(_kl)
                        except Exception:
                            _kl = []
                    for _k in _kl:
                        _ad = str((_k or {}).get("urun_ad") or "").strip()
                        if not _ad:
                            continue
                        _key = _ad.lower()
                        if _key not in _agg:
                            _agg[_key] = {"urun_ad": _ad, "adet": 0}
                            _sira.append(_key)
                        _agg[_key]["adet"] += int((_k or {}).get("adet") or 0)
                siparis_kalemler = [_agg[k] for k in _sira]
            except Exception:
                siparis_kalemler = []
    h["fatura_tarih"] = str(h.get("fatura_tarih") or "")
    h["olusturma"] = str(h.get("olusturma") or "")
    return {"fatura": h, "kalemler": kalemler, "siparis_kalemler": siparis_kalemler}


class FaturaKalemOnayBody(BaseModel):
    kalem_kodu: str               # eşleştirilen STOK kalemi (insan seçer)
    kalem_adi: Optional[str] = None
    birim: str = "adet"
    birim_maliyet_tl: float
    tedarikci: Optional[str] = None
    gecerli_baslangic: Optional[str] = None
    guncel_yap: bool = False      # TRUE → fatura tarihi yerine BUGÜNden kaydet (güncel fiyat olsun)


@router.post("/kalem/{kalem_id}/onayla")
def fatura_kalem_onayla(kalem_id: str, body: FaturaKalemOnayBody):
    """Foto faturasının bir kalemini bir STOK kalemiyle eşleştirip ONAYLAR.

    PDF onayıyla BİREBİR AYNI paylaşımlı servisi kullanır → TEK BEYİN:
      - `_kaydet_alis_fiyati`  → urun_alis_fiyat (fiyat geçmişi) + canlı maliyet
      - `fatura_kalem_eslestirme` upsert → alias ÖĞREN (sonraki PDF/foto otomatik eşleşir)
    Öneri-only ilkesi: gerçeği yazan İNSAN ONAYLI bu adımdır; OCR sadece önerdi.
    """
    if not fatura_modul_aktif():
        raise HTTPException(503, "Fatura modülü kapalı.")
    kalem = (body.kalem_kodu or "").strip()
    if not kalem:
        raise HTTPException(400, "kalem_kodu zorunlu")
    if body.birim_maliyet_tl < 0:
        raise HTTPException(400, "birim_maliyet_tl negatif olamaz")
    # Mevcut paylaşımlı servis (PDF ile AYNI kod) — lazy import (yük sırası güvenli)
    from operasyon_merkez_api import (
        _kaydet_alis_fiyati, _fatura_anahtar, _ensure_maliyet_tablolari,
    )
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        _ensure_maliyet_tablolari(cur)
        cur.execute(
            """
            SELECT k.ocr_ad, k.ocr_urun_kodu, f.fatura_tarih::text AS fatura_tarih
            FROM tedarikci_fatura_kalem k
            JOIN tedarikci_fatura f ON f.id = k.fatura_id
            WHERE k.id=%s
            """,
            (kalem_id,),
        )
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Kalem bulunamadı")
        r = dict(r)
        # Fiyatın geçerlilik başlangıcı = FATURA TARİHİ (sistem otomatik eşleştirir);
        # frontend açıkça verirse onu kullan, yoksa fatura tarihi, o da yoksa bugün.
        bas = body.gecerli_baslangic or (r.get("fatura_tarih") or None) or str(date.today())
        # "Güncel fiyat yap": fatura eski tarihli olsa bile BUGÜNden kaydet → güncel fiyat olur
        if body.guncel_yap:
            bas = str(date.today())
        ocr_ad = r.get("ocr_ad") or ""
        anahtar = _fatura_anahtar({"urun_kodu": r.get("ocr_urun_kodu"), "aciklama": ocr_ad})
        # 1) Fiyatı kaydet (PDF ile aynı servis) → urun_alis_fiyat + canlı maliyet
        fiyat_id = _kaydet_alis_fiyati(
            cur, kalem, body.kalem_adi, body.birim, body.birim_maliyet_tl, bas,
            body.tedarikci, f"Foto fatura onaylandı: {ocr_ad}",
        )
        # 2) Alias öğren (PDF ile aynı upsert)
        if anahtar:
            cur.execute(
                """
                INSERT INTO fatura_kalem_eslestirme (anahtar, kalem_kodu, kalem_adi, adet, guncelleme)
                VALUES (%s, %s, %s, 1, NOW())
                ON CONFLICT (anahtar) DO UPDATE
                    SET kalem_kodu = EXCLUDED.kalem_kodu,
                        kalem_adi  = EXCLUDED.kalem_adi,
                        adet       = fatura_kalem_eslestirme.adet + 1,
                        guncelleme = NOW()
                """,
                (anahtar, kalem, body.kalem_adi or kalem),
            )
        # 3) Bu satırı eşleşmiş + İNSAN ONAYLI işaretle (tekrar onay istemesin)
        cur.execute(
            "UPDATE tedarikci_fatura_kalem SET eslesen_stok_kodu=%s, eslesme_guven=1.0, onaylandi=TRUE WHERE id=%s",
            (kalem, kalem_id),
        )
        # Bu kayıt GÜNCEL fiyat mı oldu? (bas'tan daha yeni tarihli bir fiyat yoksa = güncel)
        cur.execute(
            "SELECT 1 FROM urun_alis_fiyat WHERE kalem_kodu=%s AND gecerli_baslangic > %s LIMIT 1",
            (kalem, bas),
        )
        guncel_oldu = cur.fetchone() is None
        conn.commit()
    return {"success": True, "fiyat_id": fiyat_id, "kalem_kodu": kalem, "anahtar": anahtar,
            "guncel_oldu": guncel_oldu, "gecerli_baslangic": bas,
            "mesaj": ("✅ Güncel fiyat oldu" if guncel_oldu
                      else f"⏳ {bas} tarihli geçmiş kayıt — daha yeni fiyat var, güncel maliyet değişmedi. "
                           "Güncel yapmak için 'güncel fiyat yap' ile onayla.")}


# ═══════════════════════════════════════════════════════════════════════════
# CARİ HESABA ÖDEME — "alım ≠ ödeme" (sahip kararı 2026-07-31)
#
# SORUN: sistemde tedarikçi cari hesabına DOĞRUDAN ödeme yapacak uç yoktu; cari
# yalnız OKUNUYORDU. Beş "öde" ucunun hepsi bir ALIM/PLAN kaydına asılıydı, bu
# yüzden "eski borçtan 20.000 verdim" demek için kullanıcı zorunlu olarak bir
# alım kaydına iliştiriyor, o kayıt da doğal olarak BELGESİNİ soruyordu.
# Ödemenin kendi kimliği yoktu; ödemeler cari ekstrede METİN EŞLEŞMESİYLE
# TAHMİN ediliyordu (öneri-only).
#
# MODEL: Alım borç DOĞURUR (kanıtı fatura) · Ödeme borcu KAPATIR (kanıtı KASA İZİ).
#
# ⚠️ PARALEL PARA YOLU AÇILMADI: para yazma işi mevcut tek yazıcıya —
# `odeme_plani` + main.odeme_yap — DELEGE edilir. Buradaki kod yalnız
# (a) plan satırı doğurur, (b) FIFO tahsis defterine yazar. Kasa/kart/çift-ödeme
# guard'ları olduğu gibi mevcut akışta kalır.
#
# Sahip kararları: FIFO + elle müdahale · belge eksiği ödemeyi DURDURMAZ
# (ayrı sinyal) · Ödeme Merkezi tek kapı.
# ═══════════════════════════════════════════════════════════════════════════

def _ensure_cari_odeme_tablolar(cur) -> None:
    """Cari ödeme + FIFO tahsis defteri (append-only). Hata-yutar, idempotent."""
    try:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS cari_odeme (
                id UUID PRIMARY KEY,
                tedarikci_ad TEXT NOT NULL,
                tutar NUMERIC NOT NULL,
                tarih DATE NOT NULL,
                odeme_yontemi TEXT DEFAULT 'nakit',
                kart_id UUID,
                aciklama TEXT,
                plan_id UUID,
                belgesiz BOOLEAN DEFAULT FALSE,
                olusturma TIMESTAMP DEFAULT NOW()
            )""")
        # Tahsis defteri: bu ödemenin HANGİ faturayı ne kadar kapattığı.
        # APPEND-ONLY — düzeltme ters kayıtla yapılır, satır silinmez.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS cari_odeme_tahsis (
                id UUID PRIMARY KEY,
                odeme_id UUID NOT NULL,
                fatura_id UUID,
                fatura_no TEXT,
                fatura_tarih DATE,
                kapatilan NUMERIC NOT NULL,
                otomatik BOOLEAN DEFAULT TRUE,
                olusturma TIMESTAMP DEFAULT NOW()
            )""")
        cur.execute("CREATE INDEX IF NOT EXISTS ix_cari_odeme_ted ON cari_odeme (tedarikci_ad)")
        cur.execute("CREATE INDEX IF NOT EXISTS ix_cari_tahsis_odeme ON cari_odeme_tahsis (odeme_id)")
        cur.execute("CREATE INDEX IF NOT EXISTS ix_cari_tahsis_fatura ON cari_odeme_tahsis (fatura_id)")
    except Exception:
        pass


def _cari_kapatilan_toplam(cur, fatura_ids: list) -> dict:
    """Fatura başına DAHA ÖNCE kapatılmış tutar (tahsis defterinden)."""
    if not fatura_ids:
        return {}
    try:
        cur.execute(
            "SELECT fatura_id, COALESCE(SUM(kapatilan),0)::float AS k "
            "FROM cari_odeme_tahsis WHERE fatura_id = ANY(%s) GROUP BY fatura_id",
            (fatura_ids,))
        return {str(r["fatura_id"]): float(r["k"]) for r in cur.fetchall() or []}
    except Exception:
        return {}


class CariOdemeModel(BaseModel):
    tedarikci: str
    tutar: float
    tarih: Optional[str] = None
    odeme_yontemi: str = "nakit"          # 'nakit' | 'kart'
    kart_id: Optional[str] = None
    aciklama: Optional[str] = None
    # Elle dağıtım: [{fatura_id, tutar}] — boşsa FIFO (en eskiden kapat)
    tahsis: Optional[list] = None


@router.get("/cari-odenecekler")
def cari_odenecekler(tedarikci: str = ""):
    """Bu tedarikçinin AÇIK faturaları — FIFO sırasıyla (en eski önce).
    Ödeme ekranı 'bu para hangi faturaları kapatacak' önizlemesini bundan kurar."""
    ara = (tedarikci or "").strip()
    if len(ara) < 3:
        raise HTTPException(400, "tedarikci parametresi en az 3 karakter")
    ekstre = cari_ekstre(tedarikci=ara)
    faturalar = ekstre.get("faturalar") or []
    with db() as (_, cur):
        _ensure_cari_odeme_tablolar(cur)
        ids = [f["id"] for f in faturalar if f.get("id")]
        kapatilan = _cari_kapatilan_toplam(cur, ids)
    acik = []
    for f in faturalar:
        tut = float(f.get("tutar") or 0)
        kap = float(kapatilan.get(str(f.get("id")), 0))
        kalan = round(tut - kap, 2)
        if kalan > 0.01:
            acik.append({
                "fatura_id": f.get("id"), "fatura_no": f.get("fatura_no"),
                "tarih": f.get("tarih"), "tutar": tut,
                "kapatilan": kap, "kalan": kalan,
            })
    acik.sort(key=lambda x: (x["tarih"] or "", x["fatura_no"] or ""))
    return {
        "tedarikci": ara,
        "acik_faturalar": acik,
        "acik_toplam": round(sum(a["kalan"] for a in acik), 2),
        "not": "FIFO: ödeme en eski faturadan kapatır. Elle dağıtım için tahsis listesi gönderin.",
    }


@router.post("/cari-ode")
def cari_ode(body: CariOdemeModel):
    """TEDARİKÇİ CARİ HESABINA ÖDEME — borcu kapatan olay.

    Akış:
      1. Açık faturalar FIFO sıraya dizilir (ya da elle tahsis alınır)
      2. `odeme_plani` satırı doğar (kaynak_tablo='cari_odeme')
      3. PARA YAZMA mevcut tek yazıcıya delege edilir → main.odeme_yap
         (kasa izi · çift-ödeme guard · kart limiti orada)
      4. Tahsis defterine append-only yazılır
    Belge YOKLUĞU ödemeyi DURDURMAZ — `belgesiz` bayrağı ile işaretlenir,
    Belge Merkezi bunu açık iş olarak kovalar (sahip kararı).
    """
    ted = (body.tedarikci or "").strip()
    tutar = round(float(body.tutar or 0), 2)
    if len(ted) < 3:
        raise HTTPException(400, "Tedarikçi adı en az 3 karakter olmalı")
    if tutar <= 0:
        raise HTTPException(400, "Ödeme tutarı sıfırdan büyük olmalı")
    if body.odeme_yontemi == "kart" and not body.kart_id:
        raise HTTPException(400, "Kart ödemesinde kart seçimi zorunlu")

    tarih = (body.tarih or date.today().isoformat())[:10]
    acik = cari_odenecekler(tedarikci=ted)["acik_faturalar"]

    # ── TAHSİS: elle mi, FIFO mu ──────────────────────────────────────────
    kalanlar = {str(a["fatura_id"]): a for a in acik if a.get("fatura_id")}
    dagitim, kalan_para = [], tutar
    if body.tahsis:
        for t in body.tahsis:
            fid = str(t.get("fatura_id") or "")
            pay = round(float(t.get("tutar") or 0), 2)
            a = kalanlar.get(fid)
            if not a or pay <= 0:
                continue
            pay = min(pay, a["kalan"], kalan_para)
            if pay <= 0:
                continue
            dagitim.append({**a, "kapatilan": pay, "otomatik": False})
            kalan_para = round(kalan_para - pay, 2)
    else:
        for a in acik:                       # zaten FIFO sıralı (en eski önce)
            if kalan_para <= 0.01:
                break
            pay = min(a["kalan"], kalan_para)
            dagitim.append({**a, "kapatilan": pay, "otomatik": True})
            kalan_para = round(kalan_para - pay, 2)

    # ── 1) Ödeme kaydı + plan satırı ──────────────────────────────────────
    oid = str(uuid.uuid4())
    pid = str(uuid.uuid4())
    belgesiz = len(acik) == 0            # kapatacak fatura yok → belgesiz ödeme
    with db() as (conn, cur):
        _ensure_cari_odeme_tablolar(cur)
        cur.execute(
            """INSERT INTO odeme_plani
                 (id, kart_id, tarih, referans_ay, odenecek_tutar, asgari_tutar,
                  aciklama, durum, kaynak_tablo, kaynak_id)
               VALUES (%s, NULL, %s, DATE_TRUNC('month', %s::date), %s, %s, %s,
                       'bekliyor', 'cari_odeme', %s)""",
            (pid, tarih, tarih, tutar, tutar,
             f"Cari ödeme: {ted}" + (f" — {body.aciklama}" if body.aciklama else ""), oid))
        cur.execute(
            """INSERT INTO cari_odeme
                 (id, tedarikci_ad, tutar, tarih, odeme_yontemi, kart_id,
                  aciklama, plan_id, belgesiz)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (oid, ted, tutar, tarih, body.odeme_yontemi,
             body.kart_id, body.aciklama, pid, belgesiz))
        conn.commit()

    # ── 2) PARA YAZMA: mevcut tek yazıcıya delege ─────────────────────────
    from main import odeme_yap, VadeliOdeModel as _VOM
    try:
        odeme_yap(pid, tutar, _VOM(odeme_yontemi=body.odeme_yontemi, kart_id=body.kart_id))
    except HTTPException:
        # Para yazılamadıysa ödeme kaydı da kalmasın (yetim kayıt üretme)
        with db() as (conn2, cur2):
            cur2.execute("DELETE FROM cari_odeme WHERE id=%s", (oid,))
            cur2.execute("DELETE FROM odeme_plani WHERE id=%s AND durum='bekliyor'", (pid,))
            conn2.commit()
        raise

    # ── 3) Tahsis defteri (append-only) ───────────────────────────────────
    with db() as (conn, cur):
        for d in dagitim:
            cur.execute(
                """INSERT INTO cari_odeme_tahsis
                     (id, odeme_id, fatura_id, fatura_no, fatura_tarih, kapatilan, otomatik)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                (str(uuid.uuid4()), oid, d.get("fatura_id"), d.get("fatura_no"),
                 d.get("tarih"), d["kapatilan"], d.get("otomatik", True)))
        conn.commit()

    return {
        "ok": True,
        "odeme_id": oid,
        "plan_id": pid,
        "tedarikci": ted,
        "tutar": tutar,
        "kapatilan_faturalar": [
            {"fatura_no": d.get("fatura_no"), "tarih": d.get("tarih"),
             "kapatilan": d["kapatilan"], "tam_kapandi": d["kapatilan"] >= d["kalan"] - 0.01}
            for d in dagitim
        ],
        "avans_kalan": round(kalan_para, 2),   # borçtan fazla ödendiyse avans
        "belgesiz": belgesiz,
        "mesaj": (
            f"✓ {ted} — {tutar:,.0f} ₺ ödendi, {len(dagitim)} fatura kapatıldı"
            if dagitim else
            f"✓ {ted} — {tutar:,.0f} ₺ ödendi (kapatacak açık fatura yok, avans/belgesiz)"
        ),
    }
