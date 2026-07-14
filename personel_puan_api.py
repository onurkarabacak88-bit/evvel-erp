"""
PERSONEL PUAN DEFTERİ (Faz 1) — İZOLE.

Sahip talebi (2026-07-14): "davranışlardan olumlu/olumsuz puanlama — en fazla
pasta satan, extra shot satan artı; mesaiye geç kalan eksi; sen de kurgula."

Codex ikinci görüşü (session 019f5f5f) tasarıma İŞLENDİ:
- #1 RİSK YANLIŞ ATIF: yalnız KİŞİ-BAĞLI kesin olaylar puanlanır; şube-gün
  satışı vardiyadakilere PAY EDİLMEZ. Satış (+) kuralları (pasta/extra shot)
  Evo POS'ta kasiyer alanı doğrulanana dek TOHUM (aktif=FALSE) durur.
- #2 VARDİYA ADALETİ: lig tablosu puan/vardiya ORANI ile sunulur; açılışçı/
  kapanışçı maruziyeti farklıdır — ham toplam tek başına kıyas değildir.
- GRACE BANDI: ≤5 dk gecikme CEZASIZ; 6-15 dk hafif; >15 dk normal; ayda 3+
  tekrar deseni ayrıca eskalasyon (tek olay değil, DESEN cezalandırılır).
- POZİTİF AĞIRLIK: kazanma fırsatları > ceza fırsatları; aylık eksi toplamı
  kişi başına TABANLA kırpılır (tek kötü gün ayı mahvetmez); temiz-seri bonusu.
- NEGATİFLER PUBLIC LİGDE GÖRÜNMEZ — yalnız yönetici görünümünde.
- AVANS VERİSİ PUANA ASLA GİRMEZ (refah/İK verisidir, performans değil).
- KASA FARKI = nötr "fark günü" etiketi; ZİMMET HÜKMÜ DEĞİLDİR (takım/devir
  bağlamı olabilir — mevcut backlog kuralı). Açılış farkı ÇAPRAZ-GÜN kuralıyla
  ÖNCEKİ günün kapanışçısına yazılır (sabah sayımı dünkü kapanışı ölçer).

ANAYASA: öneri-only (puan MAAŞA OTOMATİK BAĞLANMAZ; hüküm insanın), izole
append-only tablo + hata-yutar gece motoru + salt-okur uçlar; kurallar KOD
değil VERİ (personel_puan_kural) — Yavru Örme bildirimsel kural deseni.
Kimlik notu: puanlar GERÇEKLEŞEN OLAY sayımlarıdır (olay-gerçeği istisnası);
kişilik yargısı üretilmez, cümleler olay diliyle kurulur.

Kaldırmak: main.py'den router + gece kancası çıkar. Tablolar zararsız kalır.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/puan", tags=["personel-puan"])

GRACE_DK = 5          # bu dakikaya kadar gecikme CEZASIZ (Codex: threshold cliff)
HAFIF_DK = 15         # 6-15 dk = hafif
AYLIK_EKSI_TABAN = -15  # aylık eksi toplamı kişi başına bundan aşağı KIRPILIR

# Bildirimsel kural seti — VERİ (aktif=FALSE olanlar TOHUM: veri bağı doğrulanınca açılır)
_KURAL_TOHUM = [
    # kod, ad, puan, kategori, otomatik, aktif, aciklama
    ("ACILIS_ZAMANINDA", "Açılışı zamanında yaptı", 1, "olumlu", True, True,
     "Planlı açılış saatine (≤5 dk tolerans) şube açılış olayı yetişti — açılış slotundaki kişiye"),
    ("FATURA_FOTO", "Fatura fotoğrafı yükledi", 1, "olumlu", True, True,
     "O gün en az bir tedarikçi faturası yükledi (gün başına 1 kez)"),
    ("TEMIZ_HAFTA", "Temiz hafta serisi", 5, "olumlu", True, True,
     "Son 7 günde ≥3 vardiya çalıştı ve hiç olumsuz olay kaydı yok (haftada 1 kez)"),
    ("ELLE_TAKDIR", "Yönetici takdiri", 5, "olumlu", False, True,
     "Elle girilir; açıklama ZORUNLU (örn. müşteri övgüsü, olağanüstü katkı)"),
    ("GEC_KALMA_HAFIF", "Açılış gecikmesi (hafif)", -1, "olumsuz", True, True,
     "Açılış 6-15 dk gecikti — açılış slotundaki kişiye (≤5 dk cezasız)"),
    ("GEC_KALMA", "Açılış gecikmesi", -3, "olumsuz", True, True,
     "Açılış 15 dk'dan fazla gecikti — açılış slotundaki kişiye"),
    ("GEC_KALMA_TEKRAR", "Gecikme deseni (ayda 3+)", -2, "olumsuz", True, True,
     "Aynı ay içinde 3. ve sonraki gecikmelerde EK eskalasyon (desen cezası)"),
    ("KASA_FARK_GUNU", "Kasa fark günü (nötr)", -2, "olumsuz", True, True,
     "Kapanışında kasa fark uyarısı doğdu — ZİMMET HÜKMÜ DEĞİLDİR; takım/devir "
     "bağlamı olabilir. Açılış farkı önceki günün kapanışçısına yazılır (çapraz-gün)"),
    ("ELLE_UYARI", "Yönetici uyarısı", -5, "olumsuz", False, True,
     "Elle girilir; açıklama ZORUNLU"),
    # ── TOHUM (aktif=FALSE): veri bağı doğrulanınca açılır ──
    ("SATIS_PASTA_LIDERI", "Ay pasta satış lideri", 10, "olumlu", True, False,
     "TOHUM: Evo POS'ta kasiyer alanı doğrulanınca açılır — şube-gün payı YAPILMAZ"),
    ("SATIS_EXTRA_SHOT", "Extra shot / upsell lideri", 8, "olumlu", True, False,
     "TOHUM: Evo kasiyer alanı şart; ayrıca upsell baskısı riski izlenir (Codex)"),
    ("MUHUR_TAM", "Kapanış mührü 5 adım tam", 2, "olumlu", True, False,
     "TOHUM: mühür olayı kişi bağı doğrulanınca açılır"),
    ("SAYIM_ZAMANINDA", "Sayım görevini zamanında yaptı", 3, "olumlu", True, False,
     "TOHUM: stok sayım görev-kişi bağı doğrulanınca açılır"),
]


def _ensure(cur) -> None:
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS personel_puan_kural (
            kod       TEXT PRIMARY KEY,
            ad        TEXT NOT NULL,
            puan      INT NOT NULL,
            kategori  TEXT NOT NULL,          -- olumlu | olumsuz
            otomatik  BOOLEAN NOT NULL DEFAULT TRUE,
            aktif     BOOLEAN NOT NULL DEFAULT TRUE,
            aciklama  TEXT
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS personel_puan_olay (
            id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            personel_id  TEXT NOT NULL,
            personel_ad  TEXT,                -- snapshot
            sube_ad      TEXT,                -- snapshot (bağlam)
            tarih        DATE NOT NULL,
            kural_kodu   TEXT NOT NULL,
            puan         INT NOT NULL,
            detay        JSONB,
            kaynak       TEXT NOT NULL DEFAULT 'gece',   -- gece | elle
            olusturan    TEXT,                -- elle girişte kim
            olusturma    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    # GECE üretimi idempotent: kişi+gün+kural tekil (yalnız otomatik kayıtlar);
    # elle kayıtlar serbest (aynı gün iki takdir mümkün)
    cur.execute(
        """CREATE UNIQUE INDEX IF NOT EXISTS idx_ppo_gece_tekil
           ON personel_puan_olay (personel_id, tarih, kural_kodu)
           WHERE kaynak = 'gece'"""
    )
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ppo_ay "
                "ON personel_puan_olay (tarih, personel_id)")
    for kod, ad, puan, kat, oto, aktif, acik in _KURAL_TOHUM:
        cur.execute(
            """INSERT INTO personel_puan_kural (kod, ad, puan, kategori, otomatik, aktif, aciklama)
               VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (kod) DO NOTHING""",
            (kod, ad, puan, kat, oto, aktif, acik))


def _kural_map(cur) -> dict:
    cur.execute("SELECT kod, puan, aktif FROM personel_puan_kural")
    return {r["kod"]: dict(r) for r in cur.fetchall() or []}


def _olay_yaz(cur, kurallar: dict, kod: str, personel_id: str, personel_ad: str,
              sube_ad: Optional[str], tarih: str, detay: dict) -> bool:
    k = kurallar.get(kod)
    if not k or not k["aktif"]:
        return False
    cur.execute(
        """INSERT INTO personel_puan_olay
               (personel_id, personel_ad, sube_ad, tarih, kural_kodu, puan, detay, kaynak)
           VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,'gece')
           ON CONFLICT DO NOTHING RETURNING id""",
        (str(personel_id), personel_ad, sube_ad, tarih, kod, int(k["puan"]),
         __import__("json").dumps(detay, ensure_ascii=False)))
    return bool(cur.fetchone())


def gece_personel_puan_tara(hedef_gun: Optional[str] = None) -> dict:
    """GECE motoru — DÜNÜ tarar (hata-yutar; gece zinciri yaşar). İdempotent."""
    try:
        return _tara(hedef_gun)
    except Exception as e:  # noqa: BLE001
        logger.warning("personel puan tarama hatasi (yutuldu): %s", str(e)[:200])
        return {"ok": False, "hata": str(e)[:200]}


def _tara(hedef_gun: Optional[str] = None) -> dict:
    gun = hedef_gun or (date.today() - timedelta(days=1)).isoformat()
    yeni = {"olumlu": 0, "olumsuz": 0}
    with db() as (conn, cur):
        _ensure(cur)
        kurallar = _kural_map(cur)

        # ── AÇILIŞ KİŞİLERİ (plan) + GERÇEKLEŞEN AÇILIŞ (olay) ──
        # Takvim kuralıyla AYNI (vardiya_takvimi): tip='acilis' işaretli slot;
        # şube-günde İŞARETLİ YOKSA en erken başlayan(lar) açılışçıdır.
        cur.execute(
            """SELECT va.personel_id, p.ad_soyad, va.baslangic_saat::text AS plan_bas,
                      COALESCE(s.ad,'?') AS sube_ad, vs.sube_id,
                      COALESCE(vs.tip,'normal') AS slot_tip
               FROM vardiya_atama va
               JOIN vardiya_slot vs ON vs.id = va.slot_id
               LEFT JOIN subeler s ON s.id = vs.sube_id
               JOIN personel p ON p.id = va.personel_id
               WHERE va.tarih = %s::date AND va.durum <> 'iptal'""", (gun,))
        tum_atamalar = [dict(r) for r in cur.fetchall() or []]
        _sube_grup: dict = {}
        for r in tum_atamalar:
            _sube_grup.setdefault(str(r.get("sube_id")), []).append(r)
        acilis_plan = []
        for rows in _sube_grup.values():
            isaretli = [r for r in rows if r["slot_tip"] == "acilis"]
            if isaretli:
                acilis_plan.extend(isaretli)
            elif rows:
                en_erken = min(r["plan_bas"] for r in rows)
                acilis_plan.extend([r for r in rows if r["plan_bas"] == en_erken])
        cur.execute(
            """SELECT sube_id, MIN(cevap_ts) AS ts FROM sube_operasyon_event
               WHERE tip='ACILIS' AND tarih = %s::date AND cevap_ts IS NOT NULL
               GROUP BY sube_id""", (gun,))
        acilis_event = {str(r["sube_id"]): r["ts"] for r in cur.fetchall() or []}
        for a in acilis_plan:
            ts = acilis_event.get(str(a.get("sube_id")))
            if ts is None:
                continue  # olay yoksa hüküm yok (veri eksikliği ceza DEĞİL)
            try:
                ph, pm = str(a["plan_bas"])[:5].split(":")
                plan_dk = int(ph) * 60 + int(pm)
                fiili_dk = ts.hour * 60 + ts.minute
            except Exception:  # noqa: BLE001
                continue
            gec = fiili_dk - plan_dk
            detay = {"plan": str(a["plan_bas"])[:5], "fiili": ts.strftime("%H:%M"),
                     "gecikme_dk": gec}
            if gec <= GRACE_DK:
                if _olay_yaz(cur, kurallar, "ACILIS_ZAMANINDA", a["personel_id"],
                             a["ad_soyad"], a["sube_ad"], gun, detay):
                    yeni["olumlu"] += 1
            elif gec <= HAFIF_DK:
                if _olay_yaz(cur, kurallar, "GEC_KALMA_HAFIF", a["personel_id"],
                             a["ad_soyad"], a["sube_ad"], gun, detay):
                    yeni["olumsuz"] += 1
            else:
                if _olay_yaz(cur, kurallar, "GEC_KALMA", a["personel_id"],
                             a["ad_soyad"], a["sube_ad"], gun, detay):
                    yeni["olumsuz"] += 1
            # DESEN eskalasyonu: bu ay 3. + gecikme (hafif dahil) — ek kayıt
            if gec > GRACE_DK:
                cur.execute(
                    """SELECT COUNT(*)::int AS c FROM personel_puan_olay
                       WHERE personel_id=%s AND kural_kodu IN ('GEC_KALMA_HAFIF','GEC_KALMA')
                         AND DATE_TRUNC('month', tarih)=DATE_TRUNC('month', %s::date)""",
                    (str(a["personel_id"]), gun))
                if int((cur.fetchone() or {"c": 0})["c"]) >= 3:
                    if _olay_yaz(cur, kurallar, "GEC_KALMA_TEKRAR", a["personel_id"],
                                 a["ad_soyad"], a["sube_ad"], gun,
                                 {**detay, "not": "ayda 3+ gecikme deseni"}):
                        yeni["olumsuz"] += 1

        # ── KASA FARK GÜNÜ (nötr; ÇAPRAZ-GÜN kuralı) ──
        # KAPANIS_KASA_FARK(gun) → o günün kapanışçısı; ACILIS_KASA_FARK(gun)
        # → ÖNCEKİ günün kapanışçısı (sabah sayımı dünkü kapanışı ölçer).
        def _kapanis_kisileri(g: str) -> list:
            # Takvim kuralıyla AYNI: tip='kapanis'; işaretli yoksa EN GEÇ biten(ler)
            cur.execute(
                """SELECT va.personel_id, p.ad_soyad, COALESCE(s.ad,'?') AS sube_ad,
                          vs.sube_id, COALESCE(vs.tip,'normal') AS slot_tip,
                          va.bitis_saat::text AS bitis
                   FROM vardiya_atama va
                   JOIN vardiya_slot vs ON vs.id = va.slot_id
                   LEFT JOIN subeler s ON s.id = vs.sube_id
                   JOIN personel p ON p.id = va.personel_id
                   WHERE va.tarih = %s::date AND va.durum <> 'iptal'""", (g,))
            rows_g = [dict(r) for r in cur.fetchall() or []]
            grup: dict = {}
            for r in rows_g:
                grup.setdefault(str(r.get("sube_id")), []).append(r)
            secilen = []
            for rows in grup.values():
                isaretli = [r for r in rows if r["slot_tip"] == "kapanis"]
                if isaretli:
                    secilen.extend(isaretli)
                elif rows:
                    en_gec = max(r["bitis"] for r in rows)
                    secilen.extend([r for r in rows if r["bitis"] == en_gec])
            return secilen

        cur.execute(
            """SELECT tip, sube_id::text AS sube_id, COALESCE(fark_tl,0)::float AS fark
               FROM sube_operasyon_uyari
               WHERE tip IN ('KAPANIS_KASA_FARK','ACILIS_KASA_FARK')
                 AND tarih = %s::date""", (gun,))
        farklar = [dict(r) for r in cur.fetchall() or []]
        onceki_gun = (date.fromisoformat(gun) - timedelta(days=1)).isoformat()
        kapanis_bugun = _kapanis_kisileri(gun)
        kapanis_dun = _kapanis_kisileri(onceki_gun)
        for f in farklar:
            hedef_tarih = gun if f["tip"] == "KAPANIS_KASA_FARK" else onceki_gun
            adaylar = kapanis_bugun if f["tip"] == "KAPANIS_KASA_FARK" else kapanis_dun
            for kp in adaylar:
                if str(kp.get("sube_id")) != str(f["sube_id"]):
                    continue
                if _olay_yaz(cur, kurallar, "KASA_FARK_GUNU", kp["personel_id"],
                             kp["ad_soyad"], kp["sube_ad"], hedef_tarih,
                             {"fark_tl": f["fark"], "uyari_tipi": f["tip"],
                              "not": "nötr fark günü — zimmet hükmü DEĞİLDİR; "
                                     "takım/devir bağlamı olabilir"}):
                    yeni["olumsuz"] += 1

        # ── FATURA FOTO (+) — kişi bağı kesin (yukleyen_personel_id) ──
        cur.execute(
            """SELECT DISTINCT f.yukleyen_personel_id AS pid, p.ad_soyad
               FROM tedarikci_fatura f JOIN personel p ON p.id = f.yukleyen_personel_id
               WHERE f.yukleyen_personel_id IS NOT NULL
                 AND f.olusturma::date = %s::date""", (gun,))
        for r in [dict(x) for x in cur.fetchall() or []]:
            if _olay_yaz(cur, kurallar, "FATURA_FOTO", r["pid"], r["ad_soyad"],
                         None, gun, {"not": "fatura belge yüklemesi"}):
                yeni["olumlu"] += 1

        # ── TEMİZ HAFTA (+) — haftada 1, pazartesi günü değerlendirilir ──
        g = date.fromisoformat(gun)
        if g.weekday() == 0:  # pazartesi → geçen haftayı değerlendir
            hafta_bas = (g - timedelta(days=7)).isoformat()
            hafta_son = (g - timedelta(days=1)).isoformat()
            cur.execute(
                """SELECT va.personel_id, MAX(p.ad_soyad) AS ad_soyad,
                          COUNT(DISTINCT va.tarih)::int AS vardiya
                   FROM vardiya_atama va JOIN personel p ON p.id = va.personel_id
                   WHERE va.tarih BETWEEN %s::date AND %s::date AND va.durum <> 'iptal'
                   GROUP BY va.personel_id HAVING COUNT(DISTINCT va.tarih) >= 3""",
                (hafta_bas, hafta_son))
            for r in [dict(x) for x in cur.fetchall() or []]:
                cur.execute(
                    """SELECT 1 FROM personel_puan_olay
                       WHERE personel_id=%s AND puan < 0
                         AND tarih BETWEEN %s::date AND %s::date LIMIT 1""",
                    (str(r["personel_id"]), hafta_bas, hafta_son))
                if cur.fetchone():
                    continue
                if _olay_yaz(cur, kurallar, "TEMIZ_HAFTA", r["personel_id"],
                             r["ad_soyad"], None, hafta_bas,
                             {"vardiya": r["vardiya"],
                              "hafta": f"{hafta_bas}..{hafta_son}"}):
                    yeni["olumlu"] += 1
        conn.commit()
    return {"ok": True, "gun": gun, "yeni": yeni}


@router.post("/tara")
def puan_tara_uc(gun: str = ""):
    """Elle tetik — gece motorunun aynısı (gun=YYYY-MM-DD verilebilir)."""
    return gece_personel_puan_tara((gun or "").strip() or None)


class ElleOlay(BaseModel):
    personel_id: str
    kural_kodu: str            # ELLE_TAKDIR | ELLE_UYARI
    aciklama: str
    olusturan: Optional[str] = None
    tarih: Optional[str] = None


@router.post("/olay")
def elle_olay(body: ElleOlay):
    """Yönetici takdir/uyarı kanalı — açıklama ZORUNLU (Codex: manuel giriş
    bias vektörüdür; kategori+not+iz kaydı şart)."""
    kod = (body.kural_kodu or "").strip().upper()
    if kod not in ("ELLE_TAKDIR", "ELLE_UYARI"):
        raise HTTPException(400, "kural_kodu: ELLE_TAKDIR | ELLE_UYARI")
    acik = (body.aciklama or "").strip()
    if len(acik) < 5:
        raise HTTPException(400, "Açıklama zorunlu (en az 5 karakter) — "
                                 "takdir/uyarı kanıtsız olmaz")
    with db() as (_, cur):
        _ensure(cur)
        cur.execute("SELECT ad_soyad FROM personel WHERE id=%s", (body.personel_id,))
        p = cur.fetchone()
        if not p:
            raise HTTPException(404, "Personel bulunamadı")
        k = _kural_map(cur).get(kod)
        cur.execute(
            """INSERT INTO personel_puan_olay
                   (personel_id, personel_ad, tarih, kural_kodu, puan, detay,
                    kaynak, olusturan)
               VALUES (%s,%s,%s,%s,%s,%s::jsonb,'elle',%s) RETURNING id""",
            (body.personel_id, dict(p)["ad_soyad"],
             (body.tarih or date.today().isoformat()), kod, int(k["puan"]),
             __import__("json").dumps({"aciklama": acik}, ensure_ascii=False),
             (body.olusturan or "yonetici")))
        oid = dict(cur.fetchone())["id"]
    return {"ok": True, "id": oid, "puan": int(k["puan"])}


@router.get("/lig")
def puan_lig(ay: str = ""):
    """Aylık lig — puan/vardiya ORANLI (Codex: vardiya-tipi adaleti). Eksi
    toplam kişi başına TABANLA kırpılır (tek kötü gün ayı mahvetmez).
    PUBLIC gösterimde yalnız pozitif+rozet kullanılmalı; eksiler yönetici
    görünümüdür. Puan maaşa OTOMATİK bağlanmaz — hüküm insanın."""
    hedef = (ay or "").strip()[:7] or date.today().strftime("%Y-%m")
    with db() as (_, cur):
        _ensure(cur)
        cur.execute(
            """SELECT personel_id, MAX(personel_ad) AS ad,
                      SUM(CASE WHEN puan > 0 THEN puan ELSE 0 END)::int AS arti,
                      SUM(CASE WHEN puan < 0 THEN puan ELSE 0 END)::int AS eksi_ham,
                      COUNT(*) FILTER (WHERE kural_kodu='TEMIZ_HAFTA')::int AS temiz_hafta,
                      COUNT(*) FILTER (WHERE puan < 0)::int AS olumsuz_olay
               FROM personel_puan_olay
               WHERE TO_CHAR(tarih,'YYYY-MM') = %s
               GROUP BY personel_id""", (hedef,))
        satirlar = [dict(r) for r in cur.fetchall() or []]
        cur.execute(
            """SELECT personel_id, COUNT(DISTINCT tarih)::int AS vardiya
               FROM vardiya_atama
               WHERE TO_CHAR(tarih,'YYYY-MM') = %s AND durum <> 'iptal'
               GROUP BY personel_id""", (hedef,))
        vardiyalar = {str(r["personel_id"]): int(r["vardiya"])
                      for r in cur.fetchall() or []}
        cur.execute(
            """SELECT personel_id, personel_ad, tarih::text AS tarih, kural_kodu,
                      puan, detay, kaynak, olusturan
               FROM personel_puan_olay
               WHERE TO_CHAR(tarih,'YYYY-MM') = %s
               ORDER BY tarih DESC, olusturma DESC LIMIT 200""", (hedef,))
        olaylar = [dict(r) for r in cur.fetchall() or []]
    for s in satirlar:
        s["eksi"] = max(int(s["eksi_ham"]), AYLIK_EKSI_TABAN)  # taban kırpma
        s["net"] = s["arti"] + s["eksi"]
        v = vardiyalar.get(str(s["personel_id"]), 0)
        s["vardiya"] = v
        s["puan_per_vardiya"] = round(s["net"] / v, 2) if v > 0 else None
    satirlar.sort(key=lambda x: -(x["puan_per_vardiya"]
                                  if x["puan_per_vardiya"] is not None else x["net"]))
    return {
        "ay": hedef, "lig": satirlar, "olaylar": olaylar,
        "kurallar_notu": {
            "grace_dk": GRACE_DK, "aylik_eksi_taban": AYLIK_EKSI_TABAN,
        },
        "not": ("OLAY SAYIMLARIDIR — kişilik yargısı değil; hüküm insanın. "
                "Sıralama puan/vardiya oranıyla (vardiya-tipi adaleti). Eksi "
                f"toplam kişi başına {AYLIK_EKSI_TABAN} tabanında kırpılır. "
                "Public gösterimde yalnız artı+rozet kullanın; eksiler yönetici "
                "görünümüdür. Kasa fark günü zimmet hükmü DEĞİLDİR. Puan maaşa "
                "otomatik bağlanmaz. Avans verisi puana girmez."),
    }


@router.get("/kurallar")
def puan_kurallar():
    with db() as (_, cur):
        _ensure(cur)
        cur.execute("SELECT * FROM personel_puan_kural ORDER BY kategori, kod")
        return {"kurallar": [dict(r) for r in cur.fetchall() or []]}


def puan_ozet() -> dict:
    """Beyin (B51) + bağ için hafif özet — bu ayın ligi (ilk 8) + olay sayıları."""
    lig = puan_lig("")
    return {
        "ay": lig["ay"],
        "ilk8": [{k: s[k] for k in ("ad", "arti", "eksi", "net", "vardiya",
                                    "puan_per_vardiya", "temiz_hafta")}
                 for s in (lig["lig"] or [])[:8]],
        "toplam_kisi": len(lig["lig"] or []),
        "not": lig["not"],
    }
