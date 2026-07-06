"""
EVVEL BEYNİ v0.1 — L3 DİL/SENTEZ KATMANI (2026-07-06, Claude + Codex çapraz tasarım)

SINIR CÜMLESİ (Codex — değişmez): "EVVEL BEYNİ, ERP'de zaten üretilmiş salt-okur görünümleri
dilsel olarak birleştiren GÖZLEM katmanıdır; karar vermez, alarm kapatmaz, kişi/niyet atfetmez,
operasyon başlatmaz."

Mimari (Codex kritikli):
- Bağlam = ÇEKİRDEK bloklar (özet+sağlık+son olaylar+finans) + soruya göre SEÇİCİ bloklar
  (anahtar-kelime yönlendirme; eşleşmezse fallback=geniş). Embedding/vektör DB YOK (v0.1 sınırı).
- Bloklar KİMLİKLİ [B1]..[Bn]; cevapta her iddia blok referansı taşımak ZORUNDA.
- Çift post-check: (1) rakam — cevaptaki 2+ haneli sayı bağlamda yoksa RED (WA3 deseni),
  (2) referans — hiç [B#] yoksa RED. Red edilen cevap arşive red_nedeni ile yazılır,
  kullanıcıya dürüst 'doğrulanamadı' döner.
- OTORİTE İLLÜZYONU önlemi: her cevap başında sabit 'GÖZLEM — KARAR DEĞİL' etiketi + sonda
  sabit dipnot; CTA dili (yapın/kapatın/cezalandırın) system-prompt'ta yasak.
- KİMLİKSİZ: bağlam kimliksiz görünümlerden derlenir + prompt isim üretmeyi yasaklar.
- beyin_gunluk = Katman-4 arşivi (soru, bağlam izleri, cevap, model, red_nedeni).
  Beğeni/öğretmen verisi v2 konusu — v0.1 yalnız kalite telemetrisi.
- Gece sentez WhatsApp'a GİRMEZ (çift hakikat anlatısı olmasın) — yalnız arşiv + panel.
- ANTHROPIC_API_KEY yoksa sessizce devre dışı (503 nazik mesaj).

Kaldırmak: main.py'den router + scheduler kancasını çıkar. Tablo zararsız kalır.
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import List, Optional, Tuple

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/beyin", tags=["evvel-beyni"])

_ETIKET = "🔍 GÖZLEM — KARAR DEĞİL"
_DIPNOT = ("— Bu metin yalnız mevcut kayıtların dilsel özetidir; işlem, itham veya onay yerine "
           "geçmez. Değerlendirme ve karar insanındır.")

_SYSTEM = (
    "Sen EVVEL Beyni'sin: 4 şubeli kahve zincirinin denetim DUYULARININ dilsel sentez katmanı. "
    "SINIRLARIN (ihlal edilemez): (1) YALNIZ sana verilen bağlam bloklarındaki bilgiyi kullan — "
    "bağlamda olmayan hiçbir rakam/olay üretme. (2) Her iddianın sonuna dayandığı blok "
    "referansını köşeli parantezle yaz: [B1], [B3] gibi. (3) HÜKÜM VERME: kimseyi suçlama, "
    "kimseyi aklama, hiçbir alarmı 'normal' deyip kapatma — sadece gözlemi anlat "
    "('görülüyor', 'dikkat çekiyor', 'kontrol edilmeli' dili; 'yapın/kapatın/cezalandırın' "
    "YASAK). (4) İNSAN İSMİ ÜRETME — şube/tedarikçi/kalem seviyesinde konuş. "
    "(5) Kısa ve net Türkçe yaz; bilmediğini 'bu bağlamda görünmüyor' diye söyle. "
    "(6) RAKAM KURALI: her sayıyı bağlamda yazıldığı HALİYLE AYNEN kopyala — asla yuvarlama, "
    "asla topla/birleştirme, asla 'yaklaşık X bin' deme (yuvarlanmış sayı otomatik doğrulamadan "
    "geçemez ve cevabın tamamı reddedilir)."
)


def _ensure(cur) -> None:
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS beyin_gunluk (
            id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            tip             TEXT NOT NULL,          -- soru | gece_sentez
            soru            TEXT,
            baglam_bloklari JSONB,                  -- [{id, baslik}] izleri
            cevap           TEXT,
            model           TEXT,
            red_nedeni      TEXT,                   -- NULL=geçti; dolu=post-check reddetti
            olusturma       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    cur.execute("CREATE INDEX IF NOT EXISTS idx_beyin_gunluk ON beyin_gunluk (tip, olusturma DESC)")


# ── BAĞLAM DERLEYİCİ ─────────────────────────────────────────────────────────
def _j(v) -> str:
    return json.dumps(v, ensure_ascii=False, default=str)


def _blok_derle(soru: str) -> List[Tuple[str, str, str]]:
    """[(blok_id, başlık, metin)] — çekirdek + soruya göre seçici (fallback: geniş).
    Tüm kaynaklar SALT-OKUR mevcut fonksiyonlar; hata-yutar (bir blok çökse diğerleri yaşar)."""
    s = (soru or "").lower()
    bloklar: List[Tuple[str, str, str]] = []

    def ekle(bid: str, baslik: str, uretici) -> None:
        try:
            bloklar.append((bid, baslik, uretici()[:4000]))
        except Exception as e:  # noqa: BLE001
            logger.warning("beyin blok atlandi %s: %s", bid, str(e)[:100])

    # ÇEKİRDEK (her soruda)
    def _b1():
        from duyu_omurga import duyu_ozet
        return _j(duyu_ozet(gun=30))
    ekle("B1", "Duyu omurga özeti (30 gün)", _b1)

    def _b2():
        from duyu_omurga import duyu_saglik
        return _j(duyu_saglik())
    ekle("B2", "Duyu sağlık (proprioception)", _b2)

    def _b3():
        from duyu_omurga import duyu_olaylar
        r = duyu_olaylar(olay_tipi=None, duyu=None, limit=15)
        return _j([{k: o.get(k) for k in ("olay_tipi", "signal_name", "entity_scope",
                                          "entity_id", "occurred_at", "payload_json")}
                   for o in r.get("olaylar", [])])
    ekle("B3", "Son 15 omurga olayı", _b3)

    def _b4():
        from main import panel
        p = panel()
        alanlar = ("kasa", "serbest_nakit", "bu_ay_net", "bu_ay_nakit_giris", "bu_ay_nakit_cikis",
                   "bu_ay_sadece_ciro", "bu_ay_anlik_gider", "genel_nakit_toplam",
                   "borc_taksit_bekleyen", "bu_ay_finansman_maliyeti", "personel_gercek")
        return _j({k: p.get(k) for k in alanlar if k in p})
    ekle("B4", "Finans panel özeti (bu ay)", _b4)

    # SEÇİCİ (anahtar kelime → blok); hiçbiri eşleşmezse HEPSİ eklenir (fallback=geniş)
    secici = [
        ("B5", "Kapanış-fark şube profili (30 gün)",
         ("fark", "kapanış", "kapanis", "kasa fark", "açılış", "acilis"),
         lambda: _j(__import__("duyu_gorunumler").kapanis_fark_profili(gun=30))),
        ("B6", "Açık teslimat + tedarikçi ritmi",
         ("teslimat", "fatura", "tedarik", "irsaliye", "belge"),
         lambda: _j(__import__("belge_talep_api").acik_teslimat_ozet())),
        ("B7", "Vergi-nakit takvimi",
         ("kdv", "vergi", "stopaj", "muhtasar", "beyanname"),
         lambda: _j(__import__("duyu_gorunumler").vergi_nakit_takvimi())),
        ("B8", "Ödeme mutabakatı (60 gün)",
         ("ödeme", "odeme", "bakiye", "mutabakat", "cari"),
         lambda: _j({k: (v if not isinstance(v, list) else v[:6])
                     for k, v in __import__("duyu_gorunumler").odeme_mutabakat(gun=60).items()})),
    ]
    # Dörtgen: şube adı geçiyorsa o şube (yoksa stok anahtarında tüm şubeler kısa özet)
    def _dortgen_blok(sube_id: str, sube_ad: str):
        def _f():
            from dortgen_duyu import tuketim_dortgeni
            d = tuketim_dortgeni(sube_id=sube_id, gun=7)
            d["kalemler"] = (d.get("kalemler") or [])[:12]
            return _j(d)
        return _f

    try:
        with db() as (_, cur):
            cur.execute("SELECT id, ad FROM subeler WHERE aktif=TRUE")
            subeler = [dict(r) for r in (cur.fetchall() or [])]
    except Exception:  # noqa: BLE001
        subeler = []
    stok_anahtar = any(k in s for k in ("stok", "dörtgen", "dortgen", "bardak", "tüketim",
                                        "tuketim", "sayım", "sayim", "kullanım", "kullanim"))
    hedef_subeler = [sb for sb in subeler
                     if str(sb.get("ad") or "").lower() and str(sb["ad"]).lower() in s]
    if hedef_subeler or stok_anahtar:
        for i, sb in enumerate(hedef_subeler or subeler[:4]):
            ekle(f"B9.{i+1}", f"Tüketim dörtgeni — {sb['ad']} (7 gün)",
                 _dortgen_blok(str(sb["id"]), str(sb["ad"])))

    eslesen_var = bool(hedef_subeler or stok_anahtar)
    for bid, baslik, anahtarlar, uretici in secici:
        if any(a in s for a in anahtarlar):
            eslesen_var = True
            ekle(bid, baslik, uretici)
    if not eslesen_var:  # fallback: geniş bağlam (Codex: boş dönme)
        for bid, baslik, _a, uretici in secici:
            ekle(bid, baslik, uretici)

    return bloklar


# ── LLM + ÇİFT POST-CHECK ────────────────────────────────────────────────────
def _rakamlar(metin: str) -> set:
    return {re.sub(r"[^\d]", "", m) for m in re.findall(r"\d[\d.,]*", metin or "")}


def llm_mevcut() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("OPENAI_API_KEY"))


def _llm_cagir(system: str, kullanici: str, max_tokens: int = 900) -> Tuple[str, str]:
    """(cevap, model) — whatsapp_bildirim ile aynı ikili desen: önce Anthropic, yoksa OpenAI."""
    akey = os.getenv("ANTHROPIC_API_KEY")
    if akey:
        try:
            import anthropic
            client = anthropic.Anthropic(api_key=akey)
            model = os.getenv("ANTHROPIC_BEYIN_MODEL", "claude-3-5-haiku-20241022")
            resp = client.messages.create(
                model=model, max_tokens=max_tokens, system=system,
                messages=[{"role": "user", "content": kullanici}],
            )
            metin = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text").strip()
            if metin:
                return metin, model
        except Exception as e:  # noqa: BLE001
            logger.warning("beyin LLM hatasi (Anthropic): %s", str(e)[:150])
    okey = os.getenv("OPENAI_API_KEY")
    if okey:
        try:
            from openai import OpenAI
            client = OpenAI(api_key=okey)
            model = os.getenv("OPENAI_BEYIN_MODEL", "gpt-4o-mini")
            resp = client.chat.completions.create(
                model=model, max_tokens=max_tokens,
                messages=[{"role": "system", "content": system},
                          {"role": "user", "content": kullanici}],
            )
            metin = (resp.choices[0].message.content or "").strip()
            if metin:
                return metin, model
        except Exception as e:  # noqa: BLE001
            logger.warning("beyin LLM hatasi (OpenAI): %s", str(e)[:150])
    return "", ""


def _post_check(cevap: str, baglam_metni: str) -> Optional[str]:
    """None=geçti; str=red nedeni. (1) rakam bağlamda olmalı, (2) en az bir [B#] referansı."""
    if not re.search(r"\[B\d", cevap):
        return "blok referansı yok (iddia kaynaksız)"
    kaynak = _rakamlar(baglam_metni)
    for m in _rakamlar(cevap):
        if len(m) >= 2 and m not in kaynak:
            return f"bağlamda olmayan rakam: {m}"
    return None


def _sor_calistir(soru: str, tip: str = "soru") -> dict:
    bloklar = _blok_derle(soru)
    if not bloklar:
        raise HTTPException(503, "Bağlam derlenemedi")
    baglam_metni = "\n\n".join(f"[{bid}] {baslik}:\n{metin}" for bid, baslik, metin in bloklar)
    kullanici = (
        f"BAĞLAM BLOKLARI (tek bilgi kaynağın):\n{baglam_metni}\n\n"
        f"SORU: {soru}\n\n"
        "Cevabını yalnız bu bloklara dayandır; her iddiaya [B#] referansı ekle."
    )
    cevap, model = _llm_cagir(_SYSTEM, kullanici)
    red = None
    if not cevap:
        red = "LLM yanıtı alınamadı (anahtar yok / hata)"
    else:
        red = _post_check(cevap, baglam_metni)
    izler = [{"id": bid, "baslik": baslik} for bid, baslik, _ in bloklar]
    try:
        with db() as (_, cur):
            _ensure(cur)
            cur.execute(
                """INSERT INTO beyin_gunluk (tip, soru, baglam_bloklari, cevap, model, red_nedeni)
                   VALUES (%s,%s,%s::jsonb,%s,%s,%s)""",
                (tip, soru, _j(izler), cevap or None, model or None, red),
            )
    except Exception as e:  # noqa: BLE001
        logger.warning("beyin_gunluk arsiv hatasi: %s", str(e)[:120])
    if red:
        return {"ok": False, "etiket": _ETIKET, "red_nedeni": red,
                "cevap": "Bu soruya güvenli cevap üretilemedi (doğrulama başarısız: "
                         f"{red}). Ham görünümlere Duyu Paneli'nden bakabilirsin.",
                "bloklar": izler, "dipnot": _DIPNOT}
    return {"ok": True, "etiket": _ETIKET, "cevap": cevap, "bloklar": izler,
            "model": model, "dipnot": _DIPNOT}


class SorBody(BaseModel):
    soru: str


@router.post("/sor")
def beyin_sor(body: SorBody):
    """EVVEL Beyni'ne sor — salt-okur gözlem sentezi. Karar/işlem YAPMAZ."""
    soru = (body.soru or "").strip()
    if not soru or len(soru) < 3:
        raise HTTPException(400, "Soru boş olamaz")
    if not llm_mevcut():
        raise HTTPException(503, "Beyin şu an devre dışı (LLM anahtarı tanımsız)")
    return _sor_calistir(soru[:500], tip="soru")


@router.get("/gunluk")
def beyin_gunluk_listesi(limit: int = 20):
    """Beyin arşivi (Katman-4) — son sorular/sentezler. Salt-okur."""
    with db() as (_, cur):
        _ensure(cur)
        cur.execute(
            """SELECT tip, soru, cevap, model, red_nedeni, olusturma::text
               FROM beyin_gunluk ORDER BY olusturma DESC LIMIT %s""",
            (max(1, min(100, limit)),),
        )
        rows = [dict(r) for r in (cur.fetchall() or [])]
    return {"toplam": len(rows), "kayitlar": rows}


def gece_sentez() -> None:
    """GECE ÖZ-ANLATI: çekirdek bağlam → 5-6 satır gözlem anlatısı → arşiv.
    WhatsApp'a GİRMEZ (çift hakikat anlatısı olmasın — Codex). Hata-yutar."""
    try:
        if not llm_mevcut():
            return
        _sor_calistir(
            "Bugünün duyu verilerinden 5-6 satırlık bir günlük gözlem anlatısı yaz: "
            "en dikkat çeken 2-3 gözlem + duyu sağlığı durumu. Hüküm yok, gözlem dili.",
            tip="gece_sentez",
        )
        try:
            from duyu_omurga import duyu_nabiz_yaz
            duyu_nabiz_yaz("evvel_beyni", taranan=1, uretilen=1, not_metin="gece sentez")
        except Exception:  # noqa: BLE001
            pass
    except Exception as e:  # noqa: BLE001
        logger.warning("beyin gece sentez yutuldu: %s", str(e)[:150])
