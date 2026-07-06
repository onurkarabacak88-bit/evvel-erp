"""
5-YZ TAMAMLAMA TURU — ÖRÜNTÜ DUYULARI (2026-07-06)

Dış danışma turunda (GPT+Gemini+Grok+DeepSeek) önerilip henüz kurulmamış, verisi HAZIR
4 duyu. Hepsi Sv0/aday dili — kaydeder, hüküm vermez:

  1) SAYIM-ÇEVRESİ DÜZELTME [Grok]: sayım oturumunun ±24 saatine sıkışan MANUEL stok
     düzeltmeleri (gorev_id NULL). Sayım öncesi "hizalama" düzeltmesi meşru olabilir;
     örüntüsü "sayıma hazırlanan stok" işaretidir.
  2) FATURA ÖRÜNTÜSÜ [Gemini]: tedarikçi bazında yuvarlak-tutar sıklığı + mükerrer-yakın
     fatura çiftleri (aynı tedarikçi, ~aynı tutar, ≤3 gün ara). Hayali-fatura klasiği.
  3) TERS ZİNCİR [Grok "sahte fatura döngüsü"]: fatura VAR ama 7+ gündür teslimat/kabul
     izi YOK (açık-teslimat duyusunun tam tersi yönü). Sipariş referanssız faturalar
     ayrıca sayılır (doğrudan alım meşru — sadece görünür olur).
  4) ÜRÜN SESSİZ SIFIRLANMASI [GPT]: dün düzenli satan ürün bugün 0/yok (bulunurluk
     kaybı, menü kaybı, POS tuş kaybı). Evo cok_satilan top-liste kesiği nedeniyle
     "listeden düşmüş" olabilir — payload bunu dürüstçe söyler.

Sözleşme: izole modül · omurgaya idempotent olay · hata-yutar gece yazıcılar + nabız ·
salt-okur uç · kimlik yok. Kaldırmak: main.py'den router + gece çağrısını çıkar.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, timedelta

from fastapi import APIRouter, Query

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/duyu", tags=["duyu-oruntu"])


# ── 1) SAYIM-ÇEVRESİ MANUEL DÜZELTME ─────────────────────────────────────────
def _sayim_cevresi_hesapla(cur, gun: date) -> list:
    cur.execute(
        """
        SELECT ed.sube_id, s.ad AS sube_ad,
               COUNT(*)::int AS manuel_n,
               COUNT(*) FILTER (WHERE EXISTS (
                   SELECT 1 FROM stok_sayim_gorev sg
                   WHERE sg.sube_id = ed.sube_id
                     AND COALESCE(sg.ilk_giris_ts, sg.olusturma) - INTERVAL '24 hours' <= ed.olusturma
                     AND COALESCE(sg.onay_ts, sg.tamamlama_ts, sg.olusturma) + INTERVAL '24 hours' >= ed.olusturma
               ))::int AS sayim_yakini_n,
               COALESCE(SUM(ABS(ed.delta)), 0)::int AS toplam_mutlak_delta
        FROM envanter_duzeltme ed JOIN subeler s ON s.id = ed.sube_id
        WHERE ed.olusturma::date = %s AND ed.gorev_id IS NULL
        GROUP BY ed.sube_id, s.ad
        """,
        (str(gun),),
    )
    return [dict(r) for r in (cur.fetchall() or [])]


def gece_sayim_cevresi() -> None:
    from duyu_omurga import duyu_nabiz_yaz, duyu_olay_yaz
    try:
        dun = date.today() - timedelta(days=1)
        with db() as (_, cur):
            satirlar = _sayim_cevresi_hesapla(cur, dun)
        uretilen = 0
        for s in satirlar:
            duyu_olay_yaz(
                "sayim_cevresi", "stok.duzeltme.sayim_cevresi_kesiti",
                f"{s['sube_id']}_{dun}",
                entity_scope="sube", entity_id=str(s["sube_id"]), occurred_at=str(dun),
                signal_name="Manuel düzeltme × sayım yakınlığı",
                confidence=0.7 if int(s["sayim_yakini_n"]) > 0 else 1.0,
                payload={k: s[k] for k in ("sube_ad", "manuel_n", "sayim_yakini_n",
                                           "toplam_mutlak_delta")},
            )
            uretilen += 1
        duyu_nabiz_yaz("sayim_cevresi", taranan=len(satirlar), uretilen=uretilen)
    except Exception as e:  # noqa: BLE001
        logger.warning("gece sayim-cevresi yutuldu: %s", str(e)[:120])
        duyu_nabiz_yaz("sayim_cevresi", durum="hata", yutulan_hata=1, not_metin=str(e)[:200])


# ── 2) FATURA ÖRÜNTÜSÜ: yuvarlak tutar + mükerrer-yakın ──────────────────────
def _fatura_oruntu_hesapla(cur, gun: date) -> list:
    """Dün yüklenen faturalar: yuvarlaklık + son 30 güne karşı mükerrer-yakınlık."""
    cur.execute(
        """
        SELECT f.id, f.tedarikci_ad, f.toplam_tutar, f.fatura_tarih::text AS fatura_tarih,
               f.fatura_no,
               (f.toplam_tutar >= 100 AND MOD(f.toplam_tutar::numeric, 100) = 0) AS yuvarlak,
               EXISTS (
                   SELECT 1 FROM tedarikci_fatura f2
                   WHERE f2.id <> f.id AND f2.tedarikci_ad = f.tedarikci_ad
                     AND f2.olusturma >= NOW() - INTERVAL '30 days'
                     AND ABS(COALESCE(f2.toplam_tutar,0) - COALESCE(f.toplam_tutar,0)) < 1
                     AND ABS(f2.fatura_tarih - f.fatura_tarih) <= 3
               ) AS mukerrer_yakin
        FROM tedarikci_fatura f
        WHERE f.olusturma::date = %s AND COALESCE(f.toplam_tutar, 0) > 0
        """,
        (str(gun),),
    )
    gruplar = defaultdict(lambda: {"fatura_n": 0, "yuvarlak_n": 0,
                                   "mukerrer_aday_n": 0, "ornekler": []})
    for r in cur.fetchall() or []:
        d = dict(r)
        ted = str(d.get("tedarikci_ad") or "—").strip()
        g = gruplar[ted]
        g["fatura_n"] += 1
        if d.get("yuvarlak"):
            g["yuvarlak_n"] += 1
        if d.get("mukerrer_yakin"):
            g["mukerrer_aday_n"] += 1
            if len(g["ornekler"]) < 4:
                g["ornekler"].append({"tutar": float(d.get("toplam_tutar") or 0),
                                      "tarih": d.get("fatura_tarih"),
                                      "fatura_no": d.get("fatura_no")})
    return [{"tedarikci_ad": t, **v} for t, v in gruplar.items()]


def gece_fatura_oruntu() -> None:
    from duyu_omurga import duyu_nabiz_yaz, duyu_olay_yaz
    try:
        dun = date.today() - timedelta(days=1)
        with db() as (_, cur):
            kesitler = _fatura_oruntu_hesapla(cur, dun)
        for k in kesitler:
            duyu_olay_yaz(
                "fatura_oruntu", "belge.fatura.oruntu_kesiti",
                f"{k['tedarikci_ad']}_{dun}",
                entity_scope="tedarikci", entity_id=k["tedarikci_ad"], occurred_at=str(dun),
                signal_name="Fatura tutar/tarih örüntüsü",
                confidence=0.5 if k["mukerrer_aday_n"] > 0 else 1.0,
                payload=k,
            )
        duyu_nabiz_yaz("fatura_oruntu", taranan=len(kesitler), uretilen=len(kesitler))
    except Exception as e:  # noqa: BLE001
        logger.warning("gece fatura-oruntu yutuldu: %s", str(e)[:120])
        duyu_nabiz_yaz("fatura_oruntu", durum="hata", yutulan_hata=1, not_metin=str(e)[:200])


# ── 3) TERS ZİNCİR: fatura var, teslimat/kabul izi yok ───────────────────────
def _ters_zincir_hesapla(cur) -> list:
    """7+ gün önce yüklenmiş, sipariş referanslı ama teslim/kabul izi OLMAYAN faturalar
    + referanssız fatura sayısı (bilgi — doğrudan alım meşru olabilir)."""
    cur.execute(
        """
        SELECT f.id, f.tedarikci_ad, f.toplam_tutar, f.fatura_tarih::text AS fatura_tarih,
               f.siparis_talep_id,
               EXTRACT(DAY FROM (NOW() - f.olusturma))::int AS yas_gun,
               CASE
                 WHEN f.siparis_talep_id IS NULL THEN 'referanssiz'
                 WHEN NOT EXISTS (SELECT 1 FROM toptanci_siparis ts
                                  WHERE ts.talep_id = f.siparis_talep_id
                                    AND ts.teslim_ts IS NOT NULL)
                  AND NOT EXISTS (SELECT 1 FROM stok_yolda sy
                                  WHERE sy.siparis_talep_id = f.siparis_talep_id
                                    AND sy.kabul_ts IS NOT NULL)
                 THEN 'teslim_izi_yok'
                 ELSE 'izli'
               END AS zincir
        FROM tedarikci_fatura f
        WHERE f.olusturma <= NOW() - INTERVAL '7 days'
          AND f.olusturma >= NOW() - INTERVAL '90 days'
          AND COALESCE(f.durum, '') NOT IN ('kapandi', 'iptal')
        """
    )
    return [dict(r) for r in (cur.fetchall() or [])]


def gece_ters_zincir() -> None:
    from duyu_omurga import duyu_nabiz_yaz, duyu_olay_yaz
    try:
        with db() as (_, cur):
            satirlar = _ters_zincir_hesapla(cur)
        uretilen = 0
        for s in satirlar:
            if s.get("zincir") != "teslim_izi_yok":
                continue
            # source_ref=fatura id → fatura başına ömür boyu TEK olay (yaşlanma izi
            # açık-teslimat tarafında; burada doğum kaydı yeter)
            duyu_olay_yaz(
                "ters_zincir", "belge.fatura.teslimat_izi_yok",
                str(s["id"]),
                entity_scope="tedarikci", entity_id=str(s.get("tedarikci_ad") or "—"),
                occurred_at=s.get("fatura_tarih"),
                signal_name="Fatura var, teslimat izi yok (aday)",
                evidence_class="patern", assertion_level="korele", confidence=0.5,
                payload={"tutar": float(s.get("toplam_tutar") or 0),
                         "yas_gun": int(s.get("yas_gun") or 0),
                         "siparis_talep_id": s.get("siparis_talep_id")},
            )
            uretilen += 1
        duyu_nabiz_yaz("ters_zincir", taranan=len(satirlar), uretilen=uretilen)
    except Exception as e:  # noqa: BLE001
        logger.warning("gece ters-zincir yutuldu: %s", str(e)[:120])
        duyu_nabiz_yaz("ters_zincir", durum="hata", yutulan_hata=1, not_metin=str(e)[:200])


# ── 4) ÜRÜN SESSİZ SIFIRLANMASI (Evo günlük adet geçmişinden) ────────────────
def _sessiz_sifirlanma_hesapla(gun: date, taban_gun: int = 7, taban_esik: float = 5.0) -> list:
    """Önceki taban_gun günde ort. adet ≥ taban_esik olan ürün, hedef günde 0/yok ise aday.
    cok_satilan TOP-LİSTE kesiği: yokluk 'liste dışına düştü' de olabilir — payload söyler."""
    with db() as (_, cur):
        cur.execute(
            """
            SELECT bastar::text AS gun, veri_json
            FROM evo_rapor_cache
            WHERE anahtar = 'sube-grup-detay' AND bastar = bittar
              AND bastar BETWEEN %s AND %s
            """,
            (str(gun - timedelta(days=taban_gun)), str(gun)),
        )
        gunler = {dict(r)["gun"]: dict(r)["veri_json"] for r in (cur.fetchall() or [])}
    if str(gun) not in gunler:
        return []  # hedef günün Evo verisi yok — ölçülemez (sıfır değil)
    # şube→ürün→gün adet haritası
    seri: dict = defaultdict(dict)
    kod_haritasi: dict = {}  # (sube, ad) → stok_kodu (denetim P3-14: kalıcı kimlik)
    for g, vj in gunler.items():
        for sube_ad, sd in (vj.get("subeler") or {}).items():
            for u in sd.get("cok_satilan") or []:
                ad = str(u.get("ad") or "").strip()
                if ad:
                    try:
                        seri[(sube_ad, ad)][g] = float(u.get("adet") or 0)
                    except (TypeError, ValueError):
                        pass
                    kod = str(u.get("stok_kodu") or "").strip()
                    if kod:
                        kod_haritasi[(sube_ad, ad)] = kod
    adaylar = []
    for (sube_ad, urun), gunluk in seri.items():
        gecmis = [v for g, v in gunluk.items() if g != str(gun)]
        if len(gecmis) < 3:
            continue  # taban kurulamadı
        taban = sum(gecmis) / len(gecmis)
        bugun_adet = gunluk.get(str(gun))  # None = listede yok
        if taban >= taban_esik and (bugun_adet is None or bugun_adet == 0):
            adaylar.append({
                "sube_ad": sube_ad, "urun": urun,
                "stok_kodu": kod_haritasi.get((sube_ad, urun)),  # kalem kimliği (varsa)
                "taban_ort": round(taban, 1), "taban_gun_n": len(gecmis),
                "hedef_gun_adet": bugun_adet,
                "liste_kesigi_olabilir": bugun_adet is None,
            })
    return adaylar


def gece_sessiz_sifirlanma() -> None:
    from duyu_omurga import duyu_nabiz_yaz, duyu_olay_yaz
    try:
        dun = date.today() - timedelta(days=1)
        adaylar = _sessiz_sifirlanma_hesapla(dun)
        for a in adaylar:
            duyu_olay_yaz(
                "urun_sessiz", "satis.urun.sessiz_sifirlanma",
                f"{a['sube_ad']}_{a.get('stok_kodu') or a['urun']}_{dun}",
                # kalem kimliği: stok_kodu varsa o (ad değişimi kimlik doğurmasın —
                # dörtgen/kase ile aynı dil), yoksa ad
                entity_scope="kalem", entity_id=str(a.get("stok_kodu") or a["urun"]),
                occurred_at=str(dun),
                signal_name="Düzenli satan ürün sustu (aday)",
                confidence=0.5, evidence_class="patern",
                payload=a,
            )
        duyu_nabiz_yaz("urun_sessiz", taranan=1, uretilen=len(adaylar))
    except Exception as e:  # noqa: BLE001
        logger.warning("gece sessiz-sifirlanma yutuldu: %s", str(e)[:120])
        duyu_nabiz_yaz("urun_sessiz", durum="hata", yutulan_hata=1, not_metin=str(e)[:200])


def gece_oruntu_calistir() -> None:
    """Tek giriş — dört duyu sırayla; her biri kendi hatasını yutar."""
    gece_sayim_cevresi()
    gece_fatura_oruntu()
    gece_ters_zincir()
    gece_sessiz_sifirlanma()


# ── SALT-OKUR UÇ ─────────────────────────────────────────────────────────────
@router.get("/oruntu-duyular")
def oruntu_duyular(gun: int = Query(1, ge=1, le=7)):
    """Dört örüntü duyusunun canlı kesiti (hedef gün = bugün-gun). ADAY dili."""
    hedef = date.today() - timedelta(days=gun)
    with db() as (_, cur):
        sayim = _sayim_cevresi_hesapla(cur, hedef)
        fatura = _fatura_oruntu_hesapla(cur, hedef)
        zincir = [s for s in _ters_zincir_hesapla(cur) if s.get("zincir") != "izli"]
    try:
        sessiz = _sessiz_sifirlanma_hesapla(hedef)
    except Exception as e:  # noqa: BLE001
        sessiz = []
        logger.warning("oruntu sessiz hesap atlandi: %s", str(e)[:100])
    return {
        "hedef_gun": str(hedef),
        "sayim_cevresi": sayim,
        "fatura_oruntu": fatura,
        "ters_zincir": zincir[:20],
        "sessiz_sifirlanma": sessiz[:20],
        "not": "Sv0/aday — hüküm yok. Sayım-çevresi düzeltme meşru olabilir; yuvarlak "
               "tutar tesadüf olabilir; referanssız fatura doğrudan alım olabilir; "
               "susan ürün liste-kesiği olabilir. Örüntüyü İNSAN okur.",
    }
