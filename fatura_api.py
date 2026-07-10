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
    client = OpenAI(api_key=api_key)
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
    client = OpenAI(api_key=api_key)
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


def _ocr_calistir(fatura_id: str) -> None:
    """Arka plan iş parçacığı — kendi DB bağlantısı. Hiçbir hata fırlatmaz."""
    try:
        with db() as (conn, cur):
            _ensure_tablolar(cur)
            cur.execute(
                "SELECT foto, foto_mime, kaynak_metin FROM tedarikci_fatura WHERE id=%s",
                (fatura_id,),
            )
            r = cur.fetchone()
            if not r:
                return
            d = dict(r)
            foto = bytes(d.get("foto") or b"")
            mime = d.get("foto_mime") or "image/jpeg"
            kaynak_metin = (d.get("kaynak_metin") or "").strip()

        # Kaynak: PDF metni varsa text yolu (vision YOK), yoksa foto vision OCR.
        if kaynak_metin:
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
    except Exception as e:
        logger.warning("fatura OCR hata %s: %s", fatura_id, e)
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
    atlanan = 0
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        for f in faturalar:
            fno = (f.get("fatura_no") or "").strip() or None
            metin = (f.get("metin") or "").strip()
            if not metin:
                continue
            # Idempotent: aynı fatura_no zaten varsa atla (tekrar yükleme korunağı)
            if fno:
                cur.execute("SELECT 1 FROM tedarikci_fatura WHERE fatura_no=%s LIMIT 1", (fno,))
                if cur.fetchone():
                    atlanan += 1
                    continue
            ftarih = (f.get("fatura_tarih") or None)  # regex'ten — kesin
            fid = str(uuid.uuid4())
            cur.execute(
                """
                INSERT INTO tedarikci_fatura
                    (id, sube_id, fatura_no, fatura_tarih, onceki_bakiye, bakiye_dahil,
                     kaynak_metin, kaynak_tip, durum, yukleyen_personel_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s, 'pdf', 'ocr_bekliyor', %s)
                """,
                (fid, (sube_id or None), fno, ftarih,
                 f.get("onceki_bakiye"), f.get("bakiye_dahil"), metin, (personel_id or None)),
            )
            yeni_idler.append(fid)
        conn.commit()

    # Asenkron ayrıştırma — her fatura ayrı (biri patlasa diğerleri devam)
    for fid in yeni_idler:
        threading.Thread(target=_ocr_calistir, args=(fid,), daemon=True).start()

    return {
        "toplam_fatura": len(faturalar),
        "yuklenen": len(yeni_idler),
        "atlanan_mevcut": atlanan,
        "durum": "ocr_bekliyor",
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
                   GROUP BY parmak_izi HAVING COUNT(*) > 1""")
            for r in [dict(x) for x in cur.fetchall() or []]:
                ozet["mukerrer"].append({"tedarikci": r["ted"], "tarih": r["t"],
                                         "tutar": r["tutar"], "adet": r["n"]})
                duyu_olay_yaz("belge_kimlik", "belge.fatura.mukerrer_aday",
                              f"{r['parmak_izi']}",
                              entity_scope="belge", entity_id=str(r["ted"] or "")[:40],
                              signal_name="Mükerrer fatura adayı (aynı kimlik)",
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
               GROUP BY 1 ORDER BY toplam DESC""", (hedef,))
        toptancilar = [dict(r) for r in cur.fetchall() or []]
        for t in toptancilar:
            t["toplam"] = float(t["toplam"])
        cur.execute(
            """SELECT id, tedarikci_ad, fatura_tarih::text AS tarih,
                      COALESCE(toplam_tutar,0)::float AS tutar, durum
               FROM tedarikci_fatura
               WHERE TO_CHAR(COALESCE(fatura_tarih, olusturma::date),'YYYY-MM') = %s
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
    # eşleştirme (K2-D kuralı: tutar ±%2 / ±5 TL, tarih ±5 gün, fatura tek kullanım)
    kullanildi: set = set()
    faturasiz, eslesen_tutar = [], 0.0
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
            if gf <= 5:
                aday = x
                break
        if aday:
            kullanildi.add(aday["id"])
            eslesen_tutar += tut
        else:
            faturasiz.append({"tarih": h["tarih"], "kart": h["kart_adi"],
                              "tutar": tut, "aciklama": h["aciklama"], "tip": h["tip"]})
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
    return {
        "ay": hedef,
        "kapsama": {
            "isletme_kart_harcamasi": toplam_harcama,
            "faturali_eslesen": round(eslesen_tutar, 2),
            "faturasiz": round(toplam_harcama - eslesen_tutar, 2),
            "oran_yuzde": (round(eslesen_tutar / toplam_harcama * 100, 1)
                           if toplam_harcama > 0 else None),
        },
        "toptancilar": toptancilar,
        "gun_gun": sorted(gunler.values(), key=lambda x: x["gun"], reverse=True),
        "faturasiz_harcamalar": faturasiz[:40],
        "fatura_arsivi": faturalar[:60],
        "fatura_istekleri": fatura_istekleri,
        "not": "ADAY eşleştirme (±%2 tutar, ±5 gün) — hüküm değil. Faturasız satır = "
               "belge isteme adayı (KDV indirimi + gider kanıtı). PDF/foto: goruntule "
               "linki. Nakit işletme giderleri (anlık gider) bu sürümde kapsam dışı — "
               "kart harcamaları izlenir.",
    }


@router.get("/belge-merkezi")
def belge_merkezi_uc(ay: str = ""):
    """UI + beyin için birleşik Belge Merkezi özeti."""
    return belge_merkezi_ozet(ay)


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
    """Saklanan fatura fotoğrafı = 'ürün geldi' kanıtı. 6 ay sonra temizlenmişse 410."""
    if not fatura_modul_aktif():
        raise HTTPException(503, "Fatura modülü kapalı.")
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute("SELECT foto, foto_mime FROM tedarikci_fatura WHERE id=%s", (fatura_id,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Fatura bulunamadı")
        d = dict(r)
        foto = d.get("foto")
        if not foto:
            raise HTTPException(410, "Fatura fotoğrafı artık saklanmıyor (6 aylık saklama süresi doldu).")
        mime = d.get("foto_mime") or "image/jpeg"
        data = bytes(foto)
    return StreamingResponse(io.BytesIO(data), media_type=mime)


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
