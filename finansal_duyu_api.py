"""
FİNANSAL DUYU — İZOLE altyapı (Akıllı Denetim'in finans duyusu).

FELSEFE (bkz. memory feedback_duyu_ham_veri_once + feedback_duyu_mimari_disiplin):
  "Duyu duysun, beyin çalışmasın." Bu modül SADECE ham gözlem toplar — eşik
  UYGULAMAZ, alarm ÜRETMEZ, yorum YAPMAZ. Beyin (çağrışım/lift analizi) SONRA,
  AYRI kurulur ve bu gözlemleri + türevlerini okur.

İZOLASYON (kullanıcı direktifi 2026-06-18):
  - Kendi tablolarına yazar (kasa_capa, kasa_mutabakat_kaydi, finansal_gozlem).
  - Kritik tablolardan SADECE OKUR (kasa_hareketleri, odeme_plani) — hiçbirini değiştirmez (tek-yön).
  - Tüm uçlar/yazımlar hata-yutar (savepoint + try) — ana akışı ve beyni ASLA bozmaz.
  - main.py'ye try/except ile takılır; modül patlasa bile uygulama ayakta kalır.

ÇAPA MİMARİSİ (korunan asıl şey): "fiili beyan" çapanın sadece BİR türü.
  kaynak_tipi: manuel_beyan | banka | pos | kart_ekstre | tedarikci_cari
  Yeni çapa = yeni kaynak_tipi; tablo/motor/gözlem AYNI kalır (kilitlenmez).
  Beyan mutlak gerçek DEĞİL → güven + kim + yöntem + gecerli_an (as-of) saklanır.

DUYULAR (namespace'li hipotez_turu — god-object'i önler; her biri AYRI fenomen):
  FIN_KASA_MUTABAKAT  defter(as-of) ↔ çapa farkı  → girilmemiş ödeme/gelir sinyali
  FIN_GECIKMIS_ODEME  vade geçti, plan hâlâ bekliyor
  FIN_KART_ODEME_GIRILMEMIS  ekstre son ödeme geçti + kayıtlı ödeme yok + kart hâlâ
                             kullanılıyor → ödeme yapılmış ama deftere girilmemiş
  (sonraki: FIN_PLAN_DESYNC, FIN_PLANSIZ_CIKIS, FIN_MUKERRER_PLAN — aynı omurgaya eklenir)

ŞİDDET (kritik: veri kaybolmasın): ham_tutar + ham_oran + yas_gun AYRI saklanır;
  normalizasyonu BEYİN sonra yapar. sonuc_anomali Faz 1'de hep FALSE (beyin doldurur).
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import date, datetime, timezone, timedelta
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db
from finans_core import kasa_bakiyesi_tarihte, kesim_tarihi_hesapla

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/finansal-duyu", tags=["finansal-duyu"])

_TOL = 1.0  # ₺ — denk sayma toleransı (kuruş yuvarlama gürültüsü)
KAYNAK_TIPLERI = ("manuel_beyan", "banka", "pos", "kart_ekstre", "tedarikci_cari")
GUVEN_SEVIYELERI = ("dusuk", "orta", "yuksek")


def _bugun() -> date:
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Europe/Istanbul")).date()
    except Exception:
        return date.today()


def _ensure_tablolar(cur) -> None:
    """Modülün KENDİ tabloları — lazy ensure, idempotent, izole."""
    # 1) ÇAPA — bir "gerçeklik okuması" (pluggable kaynak)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS kasa_capa (
            id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            kaynak_tipi  TEXT NOT NULL DEFAULT 'manuel_beyan',
            hedef        TEXT NOT NULL DEFAULT 'kasa',     -- kasa | banka:X | kart:Y | cari:Z
            bakiye_tutar NUMERIC(14,2) NOT NULL,
            guven        TEXT NOT NULL DEFAULT 'orta',      -- dusuk|orta|yuksek
            beyan_eden   TEXT,
            yontem       TEXT,                              -- el|banka_ekrani|api
            gecerli_an   TIMESTAMPTZ NOT NULL DEFAULT NOW(),-- bakiye HANGİ ana ait (as-of)
            detay_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
            olusturma    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_kasa_capa_hedef ON kasa_capa (hedef, gecerli_an DESC)")

    # 2) MUTABAKAT KAYDI — türetilmiş kayıt (Katman 3): defter ↔ çapa
    cur.execute("""
        CREATE TABLE IF NOT EXISTS kasa_mutabakat_kaydi (
            id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            capa_id       TEXT,
            hedef         TEXT NOT NULL DEFAULT 'kasa',
            defter_bakiye NUMERIC(14,2) NOT NULL,
            capa_bakiye   NUMERIC(14,2) NOT NULL,
            fark          NUMERIC(14,2) NOT NULL,           -- defter - capa
            yon           TEXT NOT NULL,                    -- defter_fazla|defter_eksik|denk
            as_of         TIMESTAMPTZ NOT NULL,
            olusturma     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_kasa_mut_hedef ON kasa_mutabakat_kaydi (hedef, olusturma DESC)")

    # 3) GÖZLEM — denetim gözlemi (Katman 4): İZOLE finans omurgası, namespace'li.
    #    denetim_hipotez_gozlem ile aynı disiplin; merkez-düzey (sube_id nullable).
    #    Beyin SONRA bunu (ve türevlerini) okur. ham_tutar/ham_oran/yas_gun AYRI sütun
    #    (veri kaybolmasın). sonuc_anomali=FALSE başlar (beyin doldurur).
    cur.execute("""
        CREATE TABLE IF NOT EXISTS finansal_gozlem (
            id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            hipotez_turu  TEXT NOT NULL,                    -- FIN_KASA_MUTABAKAT | FIN_GECIKMIS_ODEME | ...
            hedef         TEXT,                             -- kasa | borc_envanteri:id | ...
            sube_id       TEXT,                             -- merkez ise NULL
            tarih         DATE NOT NULL,
            kosul_var     BOOLEAN NOT NULL,                 -- olay gerçekleşti mi?
            ham_tutar     DOUBLE PRECISION,                 -- birincil büyüklük (EŞİK YOK)
            ham_oran      DOUBLE PRECISION,                 -- normalize (fark/beklenen) — beyin için
            yas_gun       INTEGER,                          -- gecikme/bayatlık (gün)
            sonuc_anomali BOOLEAN NOT NULL DEFAULT FALSE,   -- BEYİN sonra doldurur
            sonuc_tani    TEXT,
            detay_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
            referans_id   TEXT UNIQUE,                      -- OLAY-bazlı idempotent (recompute değil)
            olusturma     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_fin_gozlem_tur ON finansal_gozlem (hipotez_turu, tarih DESC)")


def _gozlem_yaz(cur, *, hipotez_turu: str, tarih: str, kosul_var: bool,
                referans_id: str, hedef: Optional[str] = None, sube_id: Optional[str] = None,
                ham_tutar: Optional[float] = None, ham_oran: Optional[float] = None,
                yas_gun: Optional[int] = None, detay: Optional[Dict[str, Any]] = None) -> bool:
    """Ham gözlem yaz — OLAY-bazlı idempotent, hata-yutar (ana akışı bozmaz).
    Returns: yeni satır yazıldıysa True (zaten varsa/hata olursa False)."""
    try:
        cur.execute("SAVEPOINT sp_fin_gozlem")
        cur.execute("SELECT 1 FROM finansal_gozlem WHERE referans_id=%s", (referans_id,))
        if cur.fetchone():
            cur.execute("RELEASE SAVEPOINT sp_fin_gozlem")
            return False
        cur.execute("""
            INSERT INTO finansal_gozlem
                (hipotez_turu, hedef, sube_id, tarih, kosul_var, ham_tutar, ham_oran,
                 yas_gun, detay_json, referans_id)
            VALUES (%s,%s,%s,%s::date,%s,%s,%s,%s,%s::jsonb,%s)
        """, (hipotez_turu, hedef, sube_id, tarih, bool(kosul_var), ham_tutar, ham_oran,
              yas_gun, json.dumps(detay or {}, ensure_ascii=False, default=str), referans_id))
        cur.execute("RELEASE SAVEPOINT sp_fin_gozlem")
        # DUYU OMURGASI kancası (FAZ 1+, 2026-07-06): her yeni finansal gözlem Katman-2
        # olaya da düşer (fenomen dili; hata-yutar — kendi bağlantısını açar).
        try:
            from duyu_omurga import duyu_olay_yaz
            _tip_map = {"FIN_KASA_MUTABAKAT": "finans.kasa.mutabakat_gozlemi",
                        "FIN_GECIKMIS_ODEME": "finans.odeme.gecikme",
                        "FIN_KART_ODEME_GIRILMEMIS": "finans.kart.odeme_girilmemis"}
            duyu_olay_yaz(
                "finansal_duyu", _tip_map.get(hipotez_turu, f"finans.genel.{hipotez_turu.lower()}"),
                referans_id, entity_scope="sube" if sube_id else "genel", entity_id=sube_id,
                occurred_at=tarih, signal_name=hipotez_turu, evidence_class="mutabakat",
                payload={"kosul_var": bool(kosul_var), "ham_tutar": ham_tutar, "yas_gun": yas_gun},
            )
        except Exception:  # noqa: BLE001
            pass
        return True
    except Exception as e:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_fin_gozlem")
            cur.execute("RELEASE SAVEPOINT sp_fin_gozlem")
        except Exception:
            pass
        logger.warning("finansal_gozlem yazılamadı ref=%s: %s", referans_id, e)
        return False


def _as_of_date(gecerli_an) -> date:
    if isinstance(gecerli_an, datetime):
        return gecerli_an.date()
    if isinstance(gecerli_an, date):
        return gecerli_an
    try:
        return datetime.fromisoformat(str(gecerli_an).replace("Z", "+00:00")).date()
    except Exception:
        return _bugun()


# ── Çapa girişi + mutabakat (FIN_KASA_MUTABAKAT) ────────────────────────────
class CapaBody(BaseModel):
    bakiye_tutar: float
    kaynak_tipi: str = "manuel_beyan"
    hedef: str = "kasa"
    guven: str = "orta"
    beyan_eden: Optional[str] = None
    yontem: Optional[str] = "el"
    gecerli_an: Optional[str] = None   # ISO; boşsa şimdi


@router.post("/kasa-capa")
def kasa_capa_ekle(body: CapaBody):
    """Bir 'gerçeklik okuması' (çapa) kaydet → defter(as-of) ile mutabakat → ham gözlem.
    Beyan mutlak gerçek değil; fark = gözlemdir. Alarm YOK (duyu)."""
    kaynak = body.kaynak_tipi if body.kaynak_tipi in KAYNAK_TIPLERI else "manuel_beyan"
    guven = body.guven if body.guven in GUVEN_SEVIYELERI else "orta"
    hedef = (body.hedef or "kasa").strip() or "kasa"
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        gecerli_an = body.gecerli_an or datetime.now(timezone.utc).isoformat()
        as_of = _as_of_date(gecerli_an)

        capa_id = str(uuid.uuid4())
        cur.execute("""
            INSERT INTO kasa_capa (id, kaynak_tipi, hedef, bakiye_tutar, guven, beyan_eden, yontem, gecerli_an)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
        """, (capa_id, kaynak, hedef, body.bakiye_tutar, guven, body.beyan_eden, body.yontem, gecerli_an))

        # Mutabakat: SADECE 'kasa' hedefi için defter karşılığı var (banka/kart/cari sonra)
        sonuc: Dict[str, Any] = {"capa_id": capa_id, "hedef": hedef, "mutabakat": None}
        if hedef == "kasa":
            defter = kasa_bakiyesi_tarihte(cur, as_of)
            capa = float(body.bakiye_tutar)
            fark = round(defter - capa, 2)
            yon = "denk" if abs(fark) <= _TOL else ("defter_fazla" if fark > 0 else "defter_eksik")
            cur.execute("""
                INSERT INTO kasa_mutabakat_kaydi (capa_id, hedef, defter_bakiye, capa_bakiye, fark, yon, as_of)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
            """, (capa_id, hedef, defter, capa, fark, yon, gecerli_an))

            yas = (_bugun() - as_of).days
            _gozlem_yaz(
                cur, hipotez_turu="FIN_KASA_MUTABAKAT", hedef=hedef, tarih=as_of.isoformat(),
                kosul_var=(abs(fark) > _TOL), referans_id=f"fin:kasa_mut:{capa_id}",
                ham_tutar=fark, ham_oran=(fark / max(abs(capa), 1.0)), yas_gun=yas,
                detay={"defter": defter, "capa": capa, "yon": yon, "kaynak_tipi": kaynak,
                       "guven": guven, "beyan_eden": body.beyan_eden},
            )
            sonuc["mutabakat"] = {"defter": defter, "capa": capa, "fark": fark, "yon": yon,
                                  "yorum": _yon_yorum(yon)}
        return sonuc


def _yon_yorum(yon: str) -> str:
    return {
        "defter_fazla": "Defter çapadan FAZLA → girilmemiş ÖDEME/çıkış şüphesi",
        "defter_eksik": "Defter çapadan EKSİK → girilmemiş GELİR/giriş şüphesi",
        "denk": "Denk — açıklanması gereken fark yok",
    }.get(yon, yon)


@router.get("/kasa-capa")
def kasa_capa_listele(limit: int = 20):
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute("SELECT * FROM kasa_capa ORDER BY gecerli_an DESC LIMIT %s", (max(1, min(limit, 200)),))
        return [dict(r) for r in cur.fetchall()]


@router.get("/mutabakat-durum")
def mutabakat_durum():
    """Anlık tablo: defter (şimdi), son çapa, son mutabakat farkı. Salt-okur."""
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        defter_simdi = kasa_bakiyesi_tarihte(cur, _bugun())
        cur.execute("SELECT * FROM kasa_capa WHERE hedef='kasa' ORDER BY gecerli_an DESC LIMIT 1")
        son_capa = cur.fetchone()
        cur.execute("SELECT * FROM kasa_mutabakat_kaydi WHERE hedef='kasa' ORDER BY olusturma DESC LIMIT 1")
        son_mut = cur.fetchone()
        return {
            "defter_simdi": defter_simdi,
            "son_capa": dict(son_capa) if son_capa else None,
            "son_mutabakat": dict(son_mut) if son_mut else None,
            "capa_yok": son_capa is None,
        }


def _kart_odeme_girilmemis_tara(cur, bugun: date) -> int:
    """🔴 FIN_KART_ODEME_GIRILMEMIS — "ödedim ama deftere girmedim" duyusu.

    OPET 114.846 ₺ VAKASI (2026-08-14): kartın ekstresi kesildi, son ödeme tarihi
    geçti, sistemde ödeme kaydı YOK — ama kart kesimden sonra harcanmaya devam
    ediyor. Banka bloke etmediğine göre ödeme gerçekte YAPILMIŞ, yalnız deftere
    girilmemiş. Sonuç: sahte gecikme, şişik borç, boşuna limit hatası.

    ÜÇ SİNYALİN KESİŞİMİ (üçü birden olmadan hüküm yok):
      (a) son ödeme tarihi geçmiş,
      (b) [kesim, sonraki kesim) penceresinde ODEME kaydı yok,
      (c) kesimden SONRA en az 1 aktif harcama var (kart yaşıyor).
    (c) olmadan şüphe zayıftır: kart terk edilmiş ya da banka bloke etmiş olabilir.

    ⚠️ Pencere tanımı kasa_service kart planı yazıcısıyla AYNI: [kesim, sonraki_kesim).
    İki yer farklı pencere kullanırsa biri "ödendi" derken diğeri "ödenmedi" der.
    ÖNERİ-ONLY + SALT-OKUR: hiçbir kayıt değiştirilmez, yalnız gözlem yazılır.
    """
    yazilan = 0
    cur.execute("SELECT id, kart_adi, banka, kesim_gunu FROM kartlar WHERE aktif=TRUE")
    for k in (cur.fetchall() or []):
        kart = dict(k)
        try:
            # Son KESİLMİŞ ekstre dönemi. Satır yoksa kart ATLANIR — ekstre
            # görülmeden "ödenmedi" demek hüküm uydurmaktır (dürüstlük kuralı).
            cur.execute("""
                SELECT donem::text AS donem, kesim_tarihi, son_odeme_tarihi,
                       COALESCE(donem_borcu,0)::float  AS donem_borcu,
                       COALESCE(asgari_tutar,0)::float AS asgari_tutar
                  FROM kart_ekstre_donem
                 WHERE kart_id=%s AND kesim_tarihi IS NOT NULL
                   AND son_odeme_tarihi IS NOT NULL
                 ORDER BY donem DESC LIMIT 1
            """, (kart["id"],))
            ek = cur.fetchone()
            if not ek:
                continue
            ek = dict(ek)
            kt, sot = ek["kesim_tarihi"], ek["son_odeme_tarihi"]
            if not isinstance(kt, date) or not isinstance(sot, date):
                continue
            # (a) son ödeme tarihi geçti mi?
            if bugun <= sot:
                continue
            # Pencere üst sınırı: bir sonraki kesim (kasa_service ile aynı tanım)
            _sy, _sa = (kt.year + 1, 1) if kt.month == 12 else (kt.year, kt.month + 1)
            sonraki_kesim = kesim_tarihi_hesapla(_sy, _sa, int(kart["kesim_gunu"] or 1))
            # (b) pencerede ödeme var mı?
            cur.execute("""
                SELECT 1 FROM kart_hareketleri
                 WHERE kart_id=%s AND islem_turu='ODEME' AND COALESCE(durum,'aktif')='aktif'
                   AND tarih >= %s::date AND tarih < %s::date
                 LIMIT 1
            """, (kart["id"], kt, sonraki_kesim))
            if cur.fetchone():
                continue
            # (c) kesimden sonra kart kullanılmaya devam ediyor mu?
            cur.execute("""
                SELECT COUNT(*) AS adet FROM kart_hareketleri
                 WHERE kart_id=%s AND islem_turu='HARCAMA' AND COALESCE(durum,'aktif')='aktif'
                   AND tarih > %s::date
            """, (kart["id"], kt))
            harcama_adet = int((cur.fetchone() or {}).get("adet") or 0)
            if harcama_adet < 1:
                continue

            ad = kart.get("kart_adi") or kart.get("banka") or "Kart"
            donem_kisa = str(ek["donem"])[:7]
            mesaj = (
                f"{ad} kartının {donem_kisa} dönemi son ödeme tarihi ({sot}) geçti, "
                f"kayıtlı ödeme yok ama kart kullanılmaya devam ediyor "
                f"({harcama_adet} harcama). Ödeme yapılmış olup deftere girilmemiş "
                f"olabilir. Öneri: karta ödemeyi kaydedin."
            )
            if _gozlem_yaz(
                cur, hipotez_turu="FIN_KART_ODEME_GIRILMEMIS",
                hedef=f"kartlar:{kart['id']}",
                tarih=str(sot), kosul_var=True,
                referans_id=f"fin:kartodeme:{kart['id']}:{donem_kisa}",
                ham_tutar=ek["donem_borcu"],
                yas_gun=(bugun - sot).days,
                detay={
                    "kart_adi": ad, "banka": kart.get("banka"), "donem": donem_kisa,
                    "kesim_tarihi": str(kt), "son_odeme_tarihi": str(sot),
                    "pencere_sonu": str(sonraki_kesim),
                    "donem_borcu": ek["donem_borcu"], "asgari_tutar": ek["asgari_tutar"],
                    "kesim_sonrasi_harcama_adet": harcama_adet,
                    "mesaj": mesaj,
                },
            ):
                yazilan += 1
        except Exception as e:  # noqa: BLE001 — tek kart bütün taramayı düşürmesin
            logger.warning("FIN_KART_ODEME_GIRILMEMIS kart=%s atlandı: %s", kart.get("id"), e)
            continue
    return yazilan


# ── Tarama: gecikmiş ödeme duyusu (FIN_GECIKMIS_ODEME) ──────────────────────
@router.post("/tarama")
def tarama():
    """Mevcut durumu tara, ham gözlemleri yaz. Kaynak tablolardan SADECE OKUR.
    Faz 1: FIN_GECIKMIS_ODEME (vade geçmiş, hâlâ bekleyen plan). Alarm YOK.
    Faz 1b: FIN_KART_ODEME_GIRILMEMIS (ekstre ödendi ama girilmedi şüphesi)."""
    bugun = _bugun()
    yazilan = {"FIN_GECIKMIS_ODEME": 0, "FIN_KART_ODEME_GIRILMEMIS": 0}
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute("""
            SELECT id, kaynak_tablo, kaynak_id, tarih, odenecek_tutar, aciklama
            FROM odeme_plani
            WHERE durum='bekliyor' AND tarih < %s::date
            ORDER BY tarih ASC
        """, (bugun,))
        for r in cur.fetchall():
            op = dict(r)
            yas = (bugun - op["tarih"]).days if op.get("tarih") else None
            tutar = float(op["odenecek_tutar"]) if op.get("odenecek_tutar") is not None else None
            if _gozlem_yaz(
                cur, hipotez_turu="FIN_GECIKMIS_ODEME",
                hedef=f"{op.get('kaynak_tablo') or '?'}:{op.get('kaynak_id') or op['id']}",
                tarih=str(op["tarih"]), kosul_var=True,
                referans_id=f"fin:gecikme:{op['id']}",
                ham_tutar=tutar, yas_gun=yas,
                detay={"aciklama": op.get("aciklama"), "plan_id": op["id"]},
            ):
                yazilan["FIN_GECIKMIS_ODEME"] += 1
        yazilan["FIN_KART_ODEME_GIRILMEMIS"] = _kart_odeme_girilmemis_tara(cur, bugun)
    return {"yazilan": yazilan}


@router.get("/gozlem")
def gozlem_listele(hipotez_turu: Optional[str] = None, limit: int = 50):
    """Toplanan ham gözlemler — beyin SONRA bunu okuyacak. Salt-okur."""
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        if hipotez_turu:
            cur.execute("SELECT * FROM finansal_gozlem WHERE hipotez_turu=%s ORDER BY olusturma DESC LIMIT %s",
                        (hipotez_turu, max(1, min(limit, 500))))
        else:
            cur.execute("SELECT * FROM finansal_gozlem ORDER BY olusturma DESC LIMIT %s",
                        (max(1, min(limit, 500)),))
        return [dict(r) for r in cur.fetchall()]
