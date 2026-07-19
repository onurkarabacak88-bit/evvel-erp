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
from datetime import date
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
        max_tokens=1500,
    )
    metin = (resp.choices[0].message.content or "").strip()
    return _json_govde_coz(metin)


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
    j = json.loads(s)
    return j if isinstance(j, dict) else {}


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
    for _deneme in range(2):
        try:
            resp = client.chat.completions.create(
                model=os.getenv("OPENAI_FATURA_MODEL", "gpt-4o"),
                messages=[{"role": "user", "content": f"{_OCR_PROMPT_PDF}\n\n--- FATURA METNİ ---\n{govde}"}],
                temperature=0,
                max_tokens=1500,
            )
            return _json_govde_coz(resp.choices[0].message.content or "")
        except Exception as e:  # JSON/ağ hatası → tek tekrar
            son_hata = e
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
                   ORDER BY olusturma LIMIT 1""", (fatura_id, _kopya_no))
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
            tut = float(f["tutar"])
            cur.execute(
                """SELECT 1 FROM (
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
                     AND x.t BETWEEN %s::date - 10 AND %s::date + 90
                   LIMIT 1""",
                (tut, tut, ftarih or str(_d.today()), ftarih or str(_d.today())))
            if cur.fetchone():
                cur.execute("UPDATE tedarikci_fatura SET kuyruk_vadeli_id='(odenmis)' "
                            "WHERE id=%s", (fatura_id,))
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
                cur.execute(
                    "UPDATE tedarikci_fatura SET durum='ocr_hata', ocr_hata=%s WHERE id=%s",
                    (str(e)[:500], fatura_id),
                )
                conn.commit()
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
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """
            INSERT INTO tedarikci_fatura
                (id, sube_id, siparis_talep_id, foto, foto_mime, durum, yukleyen_personel_id)
            VALUES (%s, %s, %s, %s, %s, 'ocr_bekliyor', %s)
            """,
            (fid, sube_id.strip(), (siparis_talep_id or None), raw, mime, (personel_id or None)),
        )
        conn.commit()
    # Asenkron OCR — şubeyi bekletmeden
    threading.Thread(target=_ocr_calistir, args=(fid,), daemon=True).start()
    return {"fatura_id": fid, "durum": "ocr_bekliyor"}


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
        cur.execute("""SELECT id, tedarikci, tutar::float AS tutar,
                              COALESCE(aciklama,'') AS aciklama
                       FROM cari_devir""")
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
    """'hizmet' (fatura sağlayıcı — Giderler alanı) | 'mal' (ürün tedarikçisi)."""
    u = (ad or "").upper()
    if any(k in u for k in _MAL_KANITI):
        return "mal"
    return "hizmet" if any(k in u for k in _HIZMET_KELIMELERI) else "mal"


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
    ("ESHİM TEKNİK SERVİS HÜSEYİN KARA", None, "hizmet"),          # makine tamircisi
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
                 WHERE islem_turu='HARCAMA' AND durum='aktif' AND kaynak_id IS NULL
                   AND COALESCE(harcama_tipi,'belirsiz') <> 'sahsi'
                   AND tarih >= %s::date) x""",
            (kesit_6ay, kesit_6ay, kesit_6ay))
        odeme_izleri = [dict(r) for r in cur.fetchall() or []]
        devirler = _cari_devirler(cur)  # 📜 sistem-öncesi açılış beyanları

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
        v_top, v_yakin = 0.0, None
        for v in vadeler:
            if v.get("_atandi"):
                continue
            vt_metin = f"{v['tedarikci']} {v.get('aciklama') or ''}"
            if _odeme_eslesir(g["tedarikci"], vt_metin) or \
               _odeme_eslesir(v["tedarikci"], g["tedarikci"]):
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
            if _odeme_eslesir(g["tedarikci"], o.get("metin")):
                o["_atandi"] = True
                odeme_top = round(odeme_top + float(o["tutar"] or 0), 2)
        fat_top = round(sum(f["tutar"] for f in son6), 2)
        # 📜 AÇILIŞ DEVRİ (tek-atama): sahip beyanı pencere-öncesi gerçeği taşır;
        # açık = devir + pencere içi fatura − ödeme izi. Devir yalnız TEK gruba.
        devir_top = 0.0
        for dv in devirler:
            if dv.get("_atandi"):
                continue
            if _odeme_eslesir(g["tedarikci"], dv["tedarikci"]) or \
               _odeme_eslesir(dv["tedarikci"], g["tedarikci"]):
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
            """INSERT INTO cari_devir (tedarikci, tutar, aciklama)
               VALUES (%s,%s,%s)
               ON CONFLICT (tedarikci)
               DO UPDATE SET tutar=EXCLUDED.tutar, aciklama=EXCLUDED.aciklama""",
            (ad, round(body.tutar, 2), (body.aciklama or "").strip() or None))
        conn.commit()
    return {"ok": True, "tedarikci": ad, "tutar": round(body.tutar, 2)}


@router.delete("/cari-devir/{devir_id}")
def cari_devir_sil(devir_id: str):
    with db() as (conn, cur):
        _cari_devirler(cur)
        cur.execute("DELETE FROM cari_devir WHERE id=%s OR tedarikci=%s",
                    (devir_id, devir_id))
        silinen = cur.rowcount
        conn.commit()
    return {"ok": True, "silinen": silinen}


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
        cur.execute(
            """SELECT kanal, tarih, tutar, aciklama FROM (
                 SELECT 'vadeli_alim' AS kanal, vade_tarihi::text AS tarih,
                        tutar::float AS tutar,
                        LEFT(COALESCE(tedarikci,'') || ' ' || COALESCE(aciklama,''),80) AS aciklama
                 FROM vadeli_alimlar
                 WHERE durum='odendi' AND vade_tarihi >= %s::date
                 UNION ALL
                 SELECT 'anlik_gider', tarih::text, tutar::float,
                        LEFT(COALESCE(tedarikci,'') || ' ' || COALESCE(aciklama,''),80)
                 FROM anlik_giderler
                 WHERE durum='aktif' AND kaynak_id IS NULL AND tarih >= %s::date
                 UNION ALL
                 SELECT 'kart', h.tarih::text, h.tutar::float, LEFT(COALESCE(h.aciklama,''),80)
                 FROM kart_hareketleri h
                 WHERE h.islem_turu='HARCAMA' AND h.durum='aktif'
                   AND h.kaynak_id IS NULL
                   AND COALESCE(h.harcama_tipi,'belirsiz') <> 'sahsi'
                   AND h.tarih >= %s::date) x
               ORDER BY tarih""",
            (EVVEL_SISTEM_BASLANGIC, EVVEL_SISTEM_BASLANGIC, EVVEL_SISTEM_BASLANGIC))
        odeme_adaylari = [r for r in (dict(x) for x in cur.fetchall() or [])
                          if _es_es(r.get("aciklama"))]
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
