"""
TEDARİKÇİ ZİNCİRİ — kimlik kararı + birleşik zaman çizgisi (ATALAY pilotu).

SORUN (canlı): aynı gerçek tedarikçi sistemde birden çok adla duruyor
("MEHMET ATALAY", "ATALAY KAHVE", resmi ünvan…). Faturalar bir ada, ödemeler
başka ada, açılış devri üçüncü ada yazılınca hiçbir ekran "bu tedarikçiyle
ilişkim ne durumda?" sorusunu cevaplayamıyor.

═══ DEMİR KURALLAR (Codex konsültasyonu — çiğnenemez) ═══
1. BİRLEŞTİRME ≠ MAHSUP. Bu dosyadaki HİÇBİR uç bakiye kapatmaz, netleştirmez,
   ödeme eşleştirmez. Kimlik kararı yalnız "bunlar aynı kişi" der; paranın
   ne olduğu ayrı bir karardır ve burada VERİLMEZ.
2. KİMLİK KARARI APPEND-ONLY. Karar tablosuna yalnız satır EKLENİR; hiçbir
   satır güncellenmez/silinmez. Geri alma = ters karar ('ayir') yazmak.
   Okuma tarafı zaman sıralı çözer (en son karar geçerli).
3. ESKİ KAYITLARA DOKUNULMAZ. tedarikci_fatura / vadeli_alimlar / cari_odeme
   satırlarının adları DEĞİŞTİRİLMEZ — kimlik bir YORUM katmanıdır, veri değil.
   (Ad rewrite'ı geçmişi yeniden yazar ve denetim izini yok eder.)
4. FUZZY YOK. Zaman çizgisi yalnız KESİN bağlardan kurulur; benzerlik tahmini
   yalnız ÖNERİ ucunda ve kanıtıyla birlikte görünür — hüküm insanındır.

İZOLASYON: kendi tablosu (tedarikci_kimlik_karar), diğer tablolardan SALT-OKUR,
hata-yutar; main.py'ye try/except ile takılır.
"""
from __future__ import annotations

import logging
import re
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/tedarikci-zinciri", tags=["tedarikci-zinciri"])

# 🔴 SERİ KANITI SIKI FORMATLI (Codex P2): eskiden yalnız baştaki harf bloğu
# (^[A-Z]{2,4}) alınıyordu → "ABC-2026" / "AB12" gibi EV-YAPIMI numaralar da
# "seri" sayılıp alakasız iki tedarikçiyi 'aynı mükellef' diye gruplayabiliyordu.
# Kanıt ancak GERÇEK e-fatura numarası formatına uyarsa geçerlidir:
#   3 HARF + 13 HANE (yıl ile başlar) — NPE2026000000326
# Seri, GİB tarafından mükellefe tahsis edilir; bu format dışındaki numara
# mükellef kimliği taşımaz, dolayısıyla kanıt değildir.
_SERI_RE = re.compile(r"^([A-Z]{3})20\d{11}$")
# Seri öneki KANIT sayılmayanlar: jenerik/sistem üretimi olabilecek kısaltmalar.
_JENERIK_SERI = {"FAT", "EFT", "INV", "TES"}


def _ensure(cur) -> None:
    """Modülün KENDİ tablosu — lazy, idempotent. APPEND-ONLY (UPDATE/DELETE yok)."""
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tedarikci_kimlik_karar (
            id            TEXT PRIMARY KEY,
            karar_zamani  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            kanonik_ad    TEXT NOT NULL,
            alias_ad      TEXT NOT NULL,
            karar         TEXT NOT NULL,          -- 'birlestir' | 'ayir'
            kanit_ozet    TEXT,
            gerekce       TEXT,
            karar_veren   TEXT,
            aktif         BOOLEAN NOT NULL DEFAULT TRUE
        )
    """)
    cur.execute("""CREATE INDEX IF NOT EXISTS idx_tkk_alias
                   ON tedarikci_kimlik_karar (UPPER(alias_ad), karar_zamani DESC)""")
    cur.execute("""CREATE INDEX IF NOT EXISTS idx_tkk_kanonik
                   ON tedarikci_kimlik_karar (UPPER(kanonik_ad), karar_zamani DESC)""")


def _ad(s) -> str:
    return (s or "").strip()


def _U(s) -> str:
    return _ad(s).upper()


def _guncel_kararlar(cur) -> Dict[str, str]:
    """alias(UPPER) → kanonik_ad — YALNIZ en son karar geçerli.

    Append-only defteri zaman sıralı okuyup son sözü alırız: aynı alias için
    önce 'birlestir' sonra 'ayir' yazılmışsa alias BAĞIMSIZDIR (ayrılma kazanır).
    Satır güncellemediğimiz için geçmiş kararlar defterde durur — denetlenebilir.
    """
    cur.execute("""
        SELECT DISTINCT ON (UPPER(alias_ad))
               alias_ad, kanonik_ad, karar
          FROM tedarikci_kimlik_karar
         WHERE aktif = TRUE
         ORDER BY UPPER(alias_ad), karar_zamani DESC
    """)
    harita: Dict[str, str] = {}
    for r in (cur.fetchall() or []):
        if (r["karar"] or "") == "birlestir":
            harita[_U(r["alias_ad"])] = _ad(r["kanonik_ad"])
    return harita


def _aliaslari_coz(cur, ad: str) -> List[str]:
    """Verilen ad için TÜM alias'lar (kendisi dahil) — kimlik kararlarından.

    İki yön: ad bir alias ise kanoniğe çıkılır; kanonik ise ona bağlı tüm
    alias'lar toplanır. Karar yoksa yalnız kendisi döner (dürüst).
    """
    harita = _guncel_kararlar(cur)
    kanonik = harita.get(_U(ad), _ad(ad))
    adlar = {_U(kanonik): kanonik, _U(ad): _ad(ad)}
    for alias_u, kan in harita.items():
        if _U(kan) == _U(kanonik):
            adlar.setdefault(alias_u, alias_u)
    return list(adlar.values())


# ═══════════════════ T2: KİMLİK ÖNERİLERİ (öneri-only) ═══════════════════
@router.get("/kimlik-oneriler")
def kimlik_oneriler(limit: int = 50):
    """🔎 "Bunlar aynı tedarikçi olabilir mi?" — KANIT tabanlı öneri, hüküm YOK.

    Birincil kanıt: ORTAK FATURA SERİSİ. e-Fatura seri öneki (NPE/NPA…) bir
    MÜKELLEFE tahsis edilir; aynı önek iki farklı adda geçiyorsa büyük olasılıkla
    aynı mükelleftir. Bu bir tahmin değil, belge üzerindeki nesnel iz.

    İkincil (zayıf) kanıt: mevcut tedarikci_eslestirme haritası — YENİDEN
    KURULMAZ, fatura_api'deki resolver çağrılır (tek kaynak).

    Zaten karar verilmiş gruplar listeden düşer (sahip aynı soruyu iki kez görmez).
    Hardcode isim YOK — mantık tümüyle genel.
    """
    with db() as (conn, cur):
        _ensure(cur)
        karar_haritasi = _guncel_kararlar(cur)
        cur.execute("""
            SELECT COALESCE(tedarikci_ad,'') AS ad, COALESCE(fatura_no,'') AS fno,
                   COALESCE(fatura_tarih, olusturma::date)::text AS tarih,
                   COALESCE(toplam_tutar,0)::float AS tutar
              FROM tedarikci_fatura
             WHERE COALESCE(durum,'') <> 'kopya'
               AND COALESCE(fatura_no,'') <> '' AND COALESCE(tedarikci_ad,'') <> ''
        """)
        satirlar = [dict(r) for r in (cur.fetchall() or [])]

    # seri öneki → {ad: [örnek faturalar]}
    seriler: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}
    for r in satirlar:
        # fullmatch semantiği: regex sonu $ ile bağlı — biçime uymayan numara
        # (FAT123, ABC-2026, ev-yapımı önek) kanıt üretmez, sessizce atlanır.
        m = _SERI_RE.match(_U(r["fno"]))
        if not m:
            continue
        onek = m.group(1)
        if onek in _JENERIK_SERI:
            continue
        seriler.setdefault(onek, {}).setdefault(_ad(r["ad"]), []).append(r)

    # Zayıf kanıt katmanı — mevcut resolver (yeniden kurulmadı, çağrıldı)
    try:
        from fatura_api import tedarikci_eslestirme_haritasi
        _harita = tedarikci_eslestirme_haritasi() or {}
    except Exception as e:  # noqa: BLE001 — harita gelmezse öneri seri kanıtıyla sürer
        logger.warning("eslestirme haritasi okunamadi (yutuldu): %s", str(e)[:120])
        _harita = {}

    oneriler = []
    for onek, adlar in sorted(seriler.items()):
        if len(adlar) < 2:
            continue          # tek ad → ortaklık yok, öneri yok
        grup = sorted(adlar.keys())
        # Karar verilmiş mi? Grubun TAMAMI aynı kanoniğe bağlanmışsa düşür.
        # 🔴 DÜŞÜRME DELİĞİ (2026-08-15, canlıda yakalandı): filtre her üyenin
        # defterde ALIAS anahtarı olmasını arıyordu. Ama kanonik üye kendisi alias
        # DEĞİLDİR (kimse "MEHMET ATALAY → MEHMET ATALAY" yazmaz) → .get() None
        # dönüyor, grup "kararsız" sayılıyor ve karar verilmiş NPE/FEZ grupları
        # önerilerde kalmaya devam ediyordu (sahip aynı soruyu tekrar görüyor).
        # DOĞRUSU: her üyeyi ÇÖZ — alias bağı varsa onu kullan, yoksa üye zaten
        # kendi kanoniğidir. Tüm üyeler AYNI kanoniğe çözülüyorsa grup kapanmıştır.
        # Karar yoksa herkes kendine çözülür → N farklı değer → grup KALIR (doğru).
        # 'ayir' sonrası bağ düştüğü için grup kendiliğinden geri gelir (doğru).
        kanonikler = {_U(karar_haritasi.get(_U(a), a)) for a in grup}
        if len(kanonikler) == 1:
            continue
        ornekler = []
        for a in grup:
            for f in sorted(adlar[a], key=lambda x: str(x["tarih"]), reverse=True)[:1]:
                ornekler.append({"ad": a, "fatura_no": f["fno"],
                                 "tarih": f["tarih"], "tutar": f["tutar"]})
        # Mevcut haritanın bu adlar için söylediği (varsa) — ikincil kanıt
        harita_kanit = sorted({(_harita.get(_U(a)) or {}).get("kisa")
                               for a in grup if (_harita.get(_U(a)) or {}).get("kisa")})
        oneriler.append({
            "oneri_grubu": grup,
            "seri_onek": onek,
            "kanit": f"ortak fatura serisi {onek} — e-fatura seri deseni doğrulandı, aynı mükellef",
            "kanit_sinifi": "fatura_serisi",
            "ornek_faturalar": ornekler[:3],
            "fatura_adet": sum(len(v) for v in adlar.values()),
            **({"mevcut_harita_kanit":
                f"eşleştirme haritası bu adları '{harita_kanit[0]}' altında topluyor"}
               if len(harita_kanit) == 1 else {}),
        })

    oneriler.sort(key=lambda x: -x["fatura_adet"])
    return {
        "oneri_adet": len(oneriler),
        "oneriler": oneriler[:max(1, min(limit, 200))],
        "not": "ÖNERİ-ONLY: hiçbir kayıt birleştirilmedi. Kanıt = fatura serisi "
               "(e-fatura serisi mükellefe tahsis edilir). Karar sahibindir; "
               "onaylanan karar defterine APPEND edilir, eski kayıtlar DEĞİŞMEZ. "
               "⚠️ Birleştirme kimlik kararıdır — bakiye MAHSUP ETMEZ.",
    }


# ═══════════════════ T3: KARAR YAZMA + DEFTER ═══════════════════
class KimlikKarar(BaseModel):
    kanonik_ad: str
    aliaslar: List[str]
    karar: str = "birlestir"           # 'birlestir' | 'ayir'
    gerekce: Optional[str] = None
    kanit_ozet: Optional[str] = None
    karar_veren: Optional[str] = None


@router.post("/kimlik-karar")
def kimlik_karar_yaz(body: KimlikKarar):
    """✍️ Kimlik kararını deftere APPEND et. Bakiye/ödeme DOKUNULMAZ.

    Geri alma ayrı uç istemez: aynı alias için karar='ayir' POST'lamak yeterli —
    okuma tarafı en son kararı geçerli sayar, önceki satır defterde kalır.
    """
    karar = (body.karar or "").strip().lower()
    if karar not in ("birlestir", "ayir"):
        raise HTTPException(400, "karar yalnız 'birlestir' veya 'ayir' olabilir.")
    kanonik = _ad(body.kanonik_ad)
    if not kanonik:
        raise HTTPException(400, "kanonik_ad zorunlu.")
    aliaslar = [_ad(a) for a in (body.aliaslar or []) if _ad(a)]
    if not aliaslar:
        raise HTTPException(400, "En az bir alias gerekli.")

    yazilan, atlanan = [], []
    with db() as (conn, cur):
        _ensure(cur)
        mevcut = _guncel_kararlar(cur)
        for alias in aliaslar:
            # Kanonik kendine alias yazılmaz (anlamsız döngü).
            if _U(alias) == _U(kanonik) and karar == "birlestir":
                atlanan.append({"alias": alias, "neden": "kanonik kendisi"})
                continue
            # İDEMPOTENT: aynı aktif karar zaten varsa NO-OP (409 değil — sahip
            # aynı düğmeye iki kez bassa hata görmesin, defter de şişmesin).
            simdiki = mevcut.get(_U(alias))
            if karar == "birlestir" and simdiki and _U(simdiki) == _U(kanonik):
                atlanan.append({"alias": alias, "neden": "zaten bağlı (no-op)"})
                continue
            if karar == "ayir" and not simdiki:
                atlanan.append({"alias": alias, "neden": "zaten bağımsız (no-op)"})
                continue
            cur.execute("""
                INSERT INTO tedarikci_kimlik_karar
                    (id, kanonik_ad, alias_ad, karar, kanit_ozet, gerekce, karar_veren)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
            """, (str(uuid.uuid4()), kanonik, alias, karar,
                  _ad(body.kanit_ozet) or None, _ad(body.gerekce) or None,
                  _ad(body.karar_veren) or "sahip"))
            yazilan.append(alias)
        conn.commit()
    return {
        "ok": True, "kanonik_ad": kanonik, "karar": karar,
        "yazilan": yazilan, "atlanan": atlanan,
        "not": "Kimlik kararı deftere eklendi (append-only). Hiçbir bakiye "
               "kapatılmadı, hiçbir eski kayıt değiştirilmedi. "
               "Geri almak için aynı alias'lara karar='ayir' gönderin.",
    }


@router.get("/kimlik-defteri")
def kimlik_defteri(ad: Optional[str] = None, limit: int = 200):
    """📜 Karar geçmişi — append-only defterin kendisi (denetim izi)."""
    with db() as (conn, cur):
        _ensure(cur)
        if ad:
            cur.execute("""
                SELECT id, karar_zamani::text AS karar_zamani, kanonik_ad, alias_ad,
                       karar, kanit_ozet, gerekce, karar_veren, aktif
                  FROM tedarikci_kimlik_karar
                 WHERE UPPER(kanonik_ad)=%s OR UPPER(alias_ad)=%s
                 ORDER BY karar_zamani DESC LIMIT %s
            """, (_U(ad), _U(ad), max(1, min(limit, 500))))
        else:
            cur.execute("""
                SELECT id, karar_zamani::text AS karar_zamani, kanonik_ad, alias_ad,
                       karar, kanit_ozet, gerekce, karar_veren, aktif
                  FROM tedarikci_kimlik_karar
                 ORDER BY karar_zamani DESC LIMIT %s
            """, (max(1, min(limit, 500)),))
        kayitlar = [dict(r) for r in (cur.fetchall() or [])]
        guncel = _guncel_kararlar(cur)
    return {"kayit_adet": len(kayitlar), "kararlar": kayitlar,
            "guncel_baglar": guncel,
            "not": "Append-only: satırlar hiç güncellenmez/silinmez. Aynı alias "
                   "için en SON karar geçerlidir; öncekiler iz olarak durur."}


# ═══════════════════ T4 — KURULMADI (yerleşim hükmü, 2026-08-15) ═══════════
# "Tedarikçi zaman çizgisi" ucu BİLEREK yazılmadı: istenen tam görünüm ZATEN VAR
# → BelgeModulu gorunum='cari' (Cari Ekstre): Borç/Alacak/Bakiye çift kolon
# defteri, açık/beyan/devir/hacim KPI'ları, kaynak belgeler, tedarikçi seçimi.
# İkinci bir zincir ucu kurmak İKİ HESAP KAYNAĞI doğururdu; ikisi kaçınılmaz
# olarak ayrışır ve sahip hangisinin doğru olduğunu bilemez.
#
# Bunun yerine KİMLİK KARARI mevcut kaynağa besleniyor:
#   fatura_api.tedarikci_eslestirme_haritasi() → karar defteri katmanı
# Böylece Cari Ekstre, cari-ozet ve cari-ode kimlik kararından OTOMATİK
# birleşik okur — tek hesap kaynağı, sıfır kopya.
