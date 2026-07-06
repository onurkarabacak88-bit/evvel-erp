"""
FAZ 3 — DUYULAR-ARASI SİNAPSLAR (2026-07-06, 5-YZ birleşik karar: 3 onaylı sinaps)

Duyular birbirine bağlanır — beyin buradan doğar. Üç sinaps, hepsi GECE BATCH
(MQ yok, cursor'lu okuma), hepsi ADAY dilinde (confidence<1), hiçbiri alarm/karar üretmez:

  S1) KUTSAL KÂSE — Dörtgen × Sayım × Fire/İade: bir kalemde köşeler aynı yöne işaret
      ediyor VE kayıtlı masum açıklama (fire bildirimi) YOKSA "buraya bak" adayı.
  S2) TEDARİK ZİNCİRİ — Teslimat → Belge → Ödeme: uzun süre açık teslimat + ödeme izi
      yokluğu birlikteliği tedarikçi dilinde kesit olarak yazılır.
  S3) ÇAKIŞMA KOMPOZİTİ — omurga üzerinde cursor'lu okuyucu: aynı şube-günde ≥2 FARKLI
      duyu ses çıkardıysa kompozit olay ("çakışma HATA değil ÜRÜN"). Eşik YOK, skor YOK —
      sadece birliktelik kaydı + kaynak olay referansları.

Anayasa: beraat yasağı (hiçbir sinaps alarm KAPATMAZ) · isme dokunma yok (entity_scope
şube/kalem/tedarikçi) · skor değil isimli sinyal · davranış≠niyet. Kaldırmak: main.py'den
router + gece çağrısını çıkar; omurga verisi yerinde kalır.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, timedelta

from fastapi import APIRouter, Query

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/duyu", tags=["duyu-sinaps"])


# ── S1) KUTSAL KÂSE: Dörtgen × Sayım × Fire ─────────────────────────────────
def _kutsal_kase_hesapla(gun_pencere: int = 7) -> list:
    """Şube×kalem: sayım EKSİK + köşe uyumsuzluğu + fire bildirimi yokluğu birlikteliği.
    Yorum YOK — üç işaretin aynı kaleme düştüğü yerler aday listelenir."""
    from dortgen_duyu import tuketim_dortgeni
    adaylar = []
    with db() as (_, cur):
        cur.execute("SELECT id, ad FROM subeler WHERE aktif = TRUE")
        subeler = [dict(r) for r in (cur.fetchall() or [])]
        # Pencere içinde fire/iade bildirimi olan şubeler (masum açıklama var mı?)
        bas = date.today() - timedelta(days=gun_pencere)
        cur.execute(
            "SELECT DISTINCT sube_id FROM sube_fire_bildirim WHERE tarih >= %s",
            (str(bas),),
        )
        fire_olan = {str(dict(r)["sube_id"]) for r in (cur.fetchall() or [])}
    for sb in subeler:
        try:
            d = tuketim_dortgeni(sube_id=str(sb["id"]), gun=gun_pencere)
        except Exception as e:  # noqa: BLE001
            logger.warning("kutsal kase dortgen atlandi %s: %s", sb.get("ad"), str(e)[:80])
            continue
        for k in d.get("kalemler") or []:
            sayim = k.get("sayim_delta")
            kullanim = k.get("kullanim")
            satis = k.get("satis")
            # Üçlü birliktelik: sayım eksik + satış kullanımı belirgin aşıyor
            # (None=veri-yok≠sıfır — köşesi boş kalem değerlendirilmez)
            if sayim is None or satis is None or kullanim is None:
                continue
            if float(sayim) < 0 and float(satis) > float(kullanim) * 1.2 and float(kullanim) > 0:
                adaylar.append({
                    "sube_id": str(sb["id"]), "sube_ad": sb["ad"],
                    "kalem_kodu": k.get("kalem_kodu"), "kalem_adi": k.get("kalem_adi"),
                    "giren": k.get("giren"), "kullanim": kullanim, "satis": satis,
                    "sayim_delta": sayim,
                    "fire_bildirimi_var": str(sb["id"]) in fire_olan,
                })
    return adaylar


def gece_kutsal_kase() -> None:
    """GECE: üçlü birliktelik adayları → omurga (aday dili, confidence=0.5)."""
    from duyu_omurga import duyu_nabiz_yaz, duyu_olay_yaz
    try:
        adaylar = _kutsal_kase_hesapla(7)
        dun = date.today() - timedelta(days=1)
        for a in adaylar:
            duyu_olay_yaz(
                "sinaps_kase", "stok.kalem.dortgen_sayim_birlikteligi",
                f"{a['sube_id']}_{a['kalem_kodu']}_{dun}",
                entity_scope="kalem", entity_id=str(a.get("kalem_kodu") or ""),
                occurred_at=str(dun), signal_name="Dörtgen-sayım-fire birlikteliği (aday)",
                evidence_class="patern", assertion_level="korele", confidence=0.5,
                payload=a,
            )
        duyu_nabiz_yaz("sinaps_kase", taranan=1, uretilen=len(adaylar))
    except Exception as e:  # noqa: BLE001
        logger.warning("gece kutsal kase yutuldu: %s", str(e)[:120])
        duyu_nabiz_yaz("sinaps_kase", durum="hata", yutulan_hata=1, not_metin=str(e)[:200])


# ── S2) TEDARİK ZİNCİRİ: Teslimat → Belge → Ödeme ───────────────────────────
def _zincir_hesapla() -> list:
    """Tedarikçi dilinde zincir kesiti: açık teslimat yaşı × ödeme izi birlikteliği.
    'Teslim aldık + belge yok + ödeme izi de yok' = zincirin EN kör noktası (aday)."""
    kesitler = []
    try:
        from belge_talep_api import acik_teslimat_ozet
        acik = acik_teslimat_ozet()
    except Exception as e:  # noqa: BLE001
        logger.warning("zincir acik-teslimat okunamadi: %s", str(e)[:80])
        return []
    try:
        from duyu_gorunumler import odeme_mutabakat
        mut = odeme_mutabakat(gun=60)
        odeme_izli = {str(x.get("tedarikci_ad") or "").strip().lower()
                      for x in (mut.get("eslesen") or []) + (mut.get("odeme_var_dusus_gorulmedi") or [])}
    except Exception:  # noqa: BLE001
        odeme_izli = set()
    ted_gruplar = defaultdict(list)
    for t in acik.get("acik_teslimatlar") or []:
        ted_gruplar[str(t.get("tedarikci_ad") or "—").strip()].append(t)
    for ted, teslimatlar in ted_gruplar.items():
        max_yas = max(int(t.get("yas_gun") or 0) for t in teslimatlar)
        kesitler.append({
            "tedarikci_ad": ted,
            "acik_teslimat_n": len(teslimatlar),
            "max_yas_gun": max_yas,
            "odeme_izi_var": ted.lower() in odeme_izli,
            # zincir_kor = belge de yok ödeme izi de yok + 7 günden yaşlı
            "zincir_kor": (ted.lower() not in odeme_izli) and max_yas > 7,
        })
    return kesitler


def gece_zincir() -> None:
    """GECE: tedarikçi zincir kesitleri → omurga (yalnız kör noktalar olay olur)."""
    from duyu_omurga import duyu_nabiz_yaz, duyu_olay_yaz
    try:
        kesitler = _zincir_hesapla()
        dun = date.today() - timedelta(days=1)
        uretilen = 0
        for k in kesitler:
            if not k.get("zincir_kor"):
                continue
            duyu_olay_yaz(
                "sinaps_zincir", "tedarik.zincir.belge_odeme_yoklugu",
                f"{k['tedarikci_ad']}_{dun}",
                entity_scope="tedarikci", entity_id=k["tedarikci_ad"],
                occurred_at=str(dun), signal_name="Teslimat açık + ödeme izi yok (aday)",
                evidence_class="patern", assertion_level="korele", confidence=0.5,
                payload=k,
            )
            uretilen += 1
        duyu_nabiz_yaz("sinaps_zincir", taranan=len(kesitler), uretilen=uretilen)
    except Exception as e:  # noqa: BLE001
        logger.warning("gece zincir yutuldu: %s", str(e)[:120])
        duyu_nabiz_yaz("sinaps_zincir", durum="hata", yutulan_hata=1, not_metin=str(e)[:200])


# ── S3) ÇAKIŞMA KOMPOZİTİ: omurga üstünde cursor'lu okuyucu ─────────────────
_KOMPOZIT_OKUYUCU = "sinaps_kompozit"
# Kompozitin kendi ürettikleri ve rutin kesit üreticileri sayılmaz (her gün ses çıkarırlar —
# çakışma bilgisi taşımazlar; İSTİSNAİ duyuların birlikteliği aranır)
_KOMPOZIT_DISI_DUYULAR = frozenset({
    "sinaps_kompozit", "sinaps_kase", "sinaps_zincir", "sinaps_sarmal",
    "vardiya_plan_gercek", "menu_fiyat_izi", "bildirim_iletim",
    "rapor_izi", "motor_bulgu_izi", "soz_aksiyon",
    "odeme_karmasi", "aciklama_yogunlugu", "adet_tutar", "duyu_saglik", "evvel_beyni",
    # Denetim P2-4 (2026-07-06): rutin şube-gün kesit üreticileri — her gün ses çıkarır,
    # sayılırsa kompozit "her-olay dedektörüne" yozlaşır
    "operasyon_ritmi", "iade_fire", "sayim_cevresi", "kapanis_sonrasi", "etiket_koprusu",
})


def gece_kompozit() -> None:
    """GECE: cursor'dan yeni olayları oku; aynı ŞUBE-GÜNDE ≥2 FARKLI istisnai duyu ses
    çıkardıysa kompozit olay yaz. Eşik yok, skor yok — birliktelik + kaynak referansları.
    At-least-once + idempotent source_ref: tekrar okuma çift olay üretmez."""
    from duyu_omurga import cursor_ile_oku, cursor_ilerlet, duyu_nabiz_yaz, duyu_olay_yaz
    try:
        with db() as (_, cur):
            olaylar = cursor_ile_oku(cur, _KOMPOZIT_OKUYUCU, limit=800)
        if not olaylar:
            duyu_nabiz_yaz("sinaps_kompozit", taranan=0, uretilen=0)
            return
        gruplar = defaultdict(list)
        for o in olaylar:
            if o.get("duyu") in _KOMPOZIT_DISI_DUYULAR:
                continue
            if o.get("entity_scope") != "sube" or not o.get("entity_id"):
                continue
            gun = str(o.get("occurred_at") or "")[:10]
            if gun:
                gruplar[(str(o["entity_id"]), gun)].append(o)
        uretilen = 0
        for (sube_id, gun), grup in gruplar.items():
            duyular = sorted({str(g.get("duyu")) for g in grup})
            if len(duyular) < 2:
                continue
            duyu_olay_yaz(
                # taksonomi düzeltmesi (denetim P3): kompozit alan-üstü — alan=operasyon
                "sinaps_kompozit", "operasyon.sube.coklu_duyu_birlikteligi",
                f"{sube_id}_{gun}",
                entity_scope="sube", entity_id=sube_id, occurred_at=gun,
                signal_name="Aynı şube-günde çoklu duyu sesi (aday)",
                evidence_class="patern", assertion_level="korele",
                confidence=0.5,
                payload={
                    "duyular": duyular, "olay_n": len(grup),
                    "kaynak_olaylar": [{"event_id": g.get("event_id"),
                                        "duyu": g.get("duyu"),
                                        "olay_tipi": g.get("olay_tipi")} for g in grup[:12]],
                },
            )
            uretilen += 1
        with db() as (_, cur):
            cursor_ilerlet(cur, _KOMPOZIT_OKUYUCU, olaylar[-1])
        duyu_nabiz_yaz("sinaps_kompozit", taranan=len(olaylar), uretilen=uretilen)
    except Exception as e:  # noqa: BLE001
        logger.warning("gece kompozit yutuldu: %s", str(e)[:120])
        duyu_nabiz_yaz("sinaps_kompozit", durum="hata", yutulan_hata=1, not_metin=str(e)[:200])


# ── S4) AÇIKLAMA SARMALI: "şu söylerse bu da bundandır" ─────────────────────
# Kullanıcı kurgusu (2026-07-06): bir duyunun sinyali başka bir duyunun olayıyla
# AÇIKLANABİLİR — yavru ilişkisi. BERAAT YASAĞI KORUNUR: sarmal bağ sinyali KAPATMAZ,
# yanına "muhtemel açıklama" iliştirir; ikisi de kayıtta kalır, insan değerlendirir.
_SARMAL_KURALLARI = (
    # (kural adı, açıklanan duyu+tip, açıklayan duyu+tip, eşleşme anahtarı)
    # R1: menü fiyatı değişti → zımni fiyat sapması ondandır (kalem adı eşleşmesi)
    ("fiyat_degisimi_sapmayi_aciklar",
     ("adet_tutar", "finans.satis.zimni_fiyat_kesiti"),
     ("menu_fiyat_izi", "fiyat.menu.degisim"), "urun_ad"),
    # R2: kapanış geç yapıldı → kapanış-sonrası kayıt ondandır (şube-gün eşleşmesi)
    ("gec_kapanis_sonrasini_aciklar",
     ("kapanis_sonrasi", "operasyon.kayit.kapanis_sonrasi_ciro"),
     ("operasyon_ritmi", "operasyon.ritim.dilim_kesiti"), "sube_gun"),
    # R3: sayım/kalibrasyon vardı → sayım-çevresi düzeltmeler ondandır (şube-gün)
    ("sayim_duzeltmeyi_aciklar",
     ("sayim_cevresi", "stok.duzeltme.sayim_cevresi_kesiti"),
     ("stok_sayim", None), "sube_gun"),
)


def gece_sarmal() -> None:
    """GECE: dünün ADAY sinyalleri × açıklayıcı olaylar → meta.aciklama.baglanti_adayi.
    Bağ öneri dilindedir (evidence=oneri, confidence=0.5); hiçbir şeyi kapatmaz."""
    from duyu_omurga import duyu_nabiz_yaz, duyu_olay_yaz
    try:
        dun = date.today() - timedelta(days=1)
        with db() as (_, cur):
            cur.execute(
                """
                SELECT event_id, duyu, olay_tipi, entity_scope, entity_id,
                       occurred_at::text, payload_json
                FROM duyu_olay
                WHERE occurred_at::date BETWEEN %s AND %s
                """,
                (str(dun - timedelta(days=2)), str(dun)),  # açıklayan 2 gün geriden gelebilir
            )
            olaylar = [dict(r) for r in (cur.fetchall() or [])]
        uretilen, taranan = 0, 0
        for kural, (ac_duyu, ac_tip), (ay_duyu, ay_tip), anahtar in _SARMAL_KURALLARI:
            aciklananlar = [o for o in olaylar if o["duyu"] == ac_duyu
                            and (ac_tip is None or o["olay_tipi"] == ac_tip)
                            and str(o.get("occurred_at") or "")[:10] == str(dun)]
            aciklayanlar = [o for o in olaylar if o["duyu"] == ay_duyu
                            and (ay_tip is None or o["olay_tipi"] == ay_tip)]
            taranan += len(aciklananlar)
            for ac in aciklananlar:
                es = None
                if anahtar == "sube_gun":
                    # R2 inceliği: geç kapanış ancak GERÇEKTEN gecikmişse açıklayıcıdır
                    es = next((ay for ay in aciklayanlar
                               if ay.get("entity_id") == ac.get("entity_id")
                               and str(ay.get("occurred_at") or "")[:10] == str(dun)
                               and (kural != "gec_kapanis_sonrasini_aciklar"
                                    or ((ay.get("payload_json") or {}).get("tip") == "KAPANIS"
                                        and float((ay.get("payload_json") or {}).get("gecikme_dk") or 0) > 30))),
                              None)
                elif anahtar == "urun_ad":
                    sapmalar = (ac.get("payload_json") or {}).get("sapma_adaylari") or []
                    sapan_adlar = {str(s.get("ad") or "").lower() for s in sapmalar}
                    es = next((ay for ay in aciklayanlar
                               if str(ay.get("entity_id") or "").lower() in sapan_adlar), None)
                    if not sapmalar:
                        continue  # sapma yoksa açıklanacak şey de yok
                if es is None:
                    continue
                duyu_olay_yaz(
                    "sinaps_sarmal", "meta.aciklama.baglanti_adayi",
                    f"{kural}_{ac['event_id']}",
                    entity_scope=ac.get("entity_scope") or "genel",
                    entity_id=ac.get("entity_id"), occurred_at=str(dun),
                    signal_name="Muhtemel açıklama bağı (yavru ilişki)",
                    evidence_class="oneri", assertion_level="korele", confidence=0.5,
                    payload={
                        "kural": kural,
                        "aciklanan": {"event_id": ac["event_id"], "duyu": ac["duyu"],
                                      "olay_tipi": ac["olay_tipi"]},
                        "aciklayan": {"event_id": es["event_id"], "duyu": es["duyu"],
                                      "olay_tipi": es["olay_tipi"]},
                        "not": "Bağ öneridir — sinyali KAPATMAZ; ikisi de kayıtta.",
                    },
                )
                uretilen += 1
        duyu_nabiz_yaz("sinaps_sarmal", taranan=taranan, uretilen=uretilen)
    except Exception as e:  # noqa: BLE001
        logger.warning("gece sarmal yutuldu: %s", str(e)[:120])
        duyu_nabiz_yaz("sinaps_sarmal", durum="hata", yutulan_hata=1, not_metin=str(e)[:200])


def gece_sinaps_calistir() -> None:
    """Tek giriş — sinapslar sırayla; kompozit ve sarmal SONDA (o gece doğan olayları görsün)."""
    gece_kutsal_kase()
    gece_zincir()
    gece_kompozit()
    gece_sarmal()


# ── SALT-OKUR UÇ ─────────────────────────────────────────────────────────────
@router.get("/sinapsler")
def sinapsler(gun: int = Query(14, ge=3, le=60)):
    """Sinaps olaylarının son N günü + S1/S2 canlı kesiti. ADAY dili — hüküm yok."""
    bas = date.today() - timedelta(days=gun - 1)
    with db() as (_, cur):
        cur.execute(
            """
            SELECT duyu, olay_tipi, signal_name, entity_scope, entity_id,
                   occurred_at::text, confidence, payload_json
            FROM duyu_olay
            WHERE duyu IN ('sinaps_kase','sinaps_zincir','sinaps_kompozit','sinaps_sarmal')
              AND observed_at >= %s
            ORDER BY observed_at DESC LIMIT 100
            """,
            (str(bas),),
        )
        olaylar = [dict(r) for r in (cur.fetchall() or [])]
    # Denetim P1-1 (2026-07-06): Kâse CANLI hesabı bu uçtan KALDIRILDI — 4 şube × 7 gün
    # dörtgen = 100+ canlı Evo çağrısı panel açılışını kilitliyordu. Kâse adayları artık
    # gece yazılan omurga olaylarından okunur; zincir hesabı yerel SQL (ucuz), kalır.
    kase_omurgadan = [o for o in olaylar if o.get("duyu") == "sinaps_kase"]
    kase_canli = [dict(o.get("payload_json") or {}) for o in kase_omurgadan[:10]]
    try:
        zincir_canli = _zincir_hesapla()
    except Exception:  # noqa: BLE001
        zincir_canli = []
    return {
        "kesit": {"bas": str(bas), "gun": gun},
        "sinaps_olaylari": olaylar,
        "kase_canli": kase_canli,
        "zincir_canli": zincir_canli,
        "not": "Sinapslar duyuları BİRBİRİNE bağlar: birliktelik kaydeder, hüküm vermez, "
               "alarm kapatmaz. confidence=0.5 = ADAY; değerlendirme insanındır. "
               "Kâse adayları gece taramasından gelir (canlı Evo çağrısı yapılmaz).",
    }
