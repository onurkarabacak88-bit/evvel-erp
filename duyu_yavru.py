"""
YAVRU ÖRME MOTORU — Y1+Y2 (2026-07-07, Claude+Codex çaprazlı; master plan §18)

"Şu söylerse bu da bundandır" bağları artık KODDAN AYRIŞMIŞ bildirimsel kural
kütüphanesinde yaşar. İki yavru türü:
  T1 AÇIKLAYICI: ebeveyn olay çocuk sinyali AÇIKLAR — bağ iliştirir, ASLA kapatmaz.
  T2 BEKLENTİ: ebeveyn olay çocuğu DOĞURMALIYDI — pencere dolunca çocuk yoksa YOKLUK
     sinyali (cocuk_gelmedi). CODEX DİLİ (anayasa): kapanan şey SORUN değil BEKLENEN
     ZİNCİRDİR; durum yalnız cocuk_geldi/cocuk_gelmedi olur, ebeveyn asla "temiz" olmaz.

Kural alanları (Codex'in 3 zorunlu eki dahil): kural_id, surum, gecerli_bas, tur,
yasam_dongusu, ebeveyn, cocuk, eslesme, pencere_gun, pencere_capasi, aciklama, aktif.
Kural ekleme YALNIZ İNSAN ONAYIYLA (bu dosyaya commit = onay izi).
bagimsizlik_etkisi=asla: hiçbir yavru bağı kanıt-kapısı aile sayısına dokunamaz
(T1 olayları sinaps_sarmal/meta, T2 olayları yavru_beklenti/meta — ikisi de dışlanmış aile).
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

from fastapi import APIRouter, Query

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/duyu", tags=["duyu-yavru"])


# ── KURAL KÜTÜPHANESİ (bildirimsel — insan onayıyla büyür) ───────────────────
KURAL_KUTUPHANESI = [
    {"kural_id": "R1_fiyat_zimni", "surum": 1, "gecerli_bas": "2026-07-06", "tur": "T1",
     "yasam_dongusu": "duragan_bag", "pencere_gun": 2, "pencere_capasi": "occurred_at",
     "ebeveyn": "menu_fiyat_izi/fiyat.menu.degisim",
     "cocuk": "adet_tutar/finans.satis.zimni_fiyat_kesiti", "eslesme": "urun_ad",
     "aciklama": "Menü fiyatı değişti → zımni fiyat sapması ondandır", "aktif": True},
    {"kural_id": "R2_gec_kapanis", "surum": 1, "gecerli_bas": "2026-07-06", "tur": "T1",
     "yasam_dongusu": "duragan_bag", "pencere_gun": 0, "pencere_capasi": "occurred_at",
     "ebeveyn": "operasyon_ritmi/operasyon.ritim.dilim_kesiti(KAPANIS,gecikme>30)",
     "cocuk": "kapanis_sonrasi/operasyon.kayit.kapanis_sonrasi_ciro", "eslesme": "sube_gun",
     "aciklama": "Kapanış 30+ dk gecikti → kapanış-sonrası kayıt ondandır", "aktif": True},
    {"kural_id": "R3_sayim_duzeltme", "surum": 1, "gecerli_bas": "2026-07-06", "tur": "T1",
     "yasam_dongusu": "duragan_bag", "pencere_gun": 2, "pencere_capasi": "occurred_at",
     "ebeveyn": "stok_sayim/*", "cocuk": "sayim_cevresi/stok.duzeltme.sayim_cevresi_kesiti",
     "eslesme": "sube_gun", "aciklama": "Sayım/kalibrasyon vardı → düzeltmeler ondandır",
     "aktif": True},
    {"kural_id": "R4_fire_kase", "surum": 1, "gecerli_bas": "2026-07-07", "tur": "T1",
     "yasam_dongusu": "duragan_bag", "pencere_gun": 7, "pencere_capasi": "occurred_at",
     "ebeveyn": "iade_fire/stok.fire.bildirim_kesiti",
     "cocuk": "sinaps_kase/stok.kalem.dortgen_sayim_birlikteligi", "eslesme": "sube",
     "aciklama": "Fire bildirimi var → dörtgen-sayım eksiği kısmen ondandır", "aktif": True},
    {"kural_id": "R5_mudahale_kart", "surum": 1, "gecerli_bas": "2026-07-07", "tur": "T1",
     "yasam_dongusu": "duragan_bag", "pencere_gun": 0, "pencere_capasi": "occurred_at",
     "ebeveyn": "mudahale_izi/operasyon.kayit.geriye_donuk_mudahale",
     "cocuk": "k1_mutabakat/kasa.kart.defter_farki(furya>=3)", "eslesme": "gun",
     "aciklama": "Toplu geriye-dönük müdahale günü → kart fark furyası ondandır "
                 "(K1 onarımı örneği)", "aktif": True},
    {"kural_id": "R6_gec_acilis_fark", "surum": 1, "gecerli_bas": "2026-07-07", "tur": "T1",
     "yasam_dongusu": "duragan_bag", "pencere_gun": 0, "pencere_capasi": "occurred_at",
     "ebeveyn": "operasyon_ritmi/operasyon.ritim.dilim_kesiti(ACILIS,gecikme>30)",
     "cocuk": "sube_operasyon_uyari/ACILIS_KASA_FARK", "eslesme": "sube_gun",
     "aciklama": "Açılış 30+ dk gecikti → açılış kasa farkı ona eşlik ediyor", "aktif": True},
    {"kural_id": "R7_fiyat_sessiz", "surum": 1, "gecerli_bas": "2026-07-07", "tur": "T1",
     "yasam_dongusu": "duragan_bag", "pencere_gun": 7, "pencere_capasi": "occurred_at",
     "ebeveyn": "menu_fiyat_izi/fiyat.menu.degisim",
     "cocuk": "urun_sessiz/satis.urun.sessiz_sifirlanma", "eslesme": "urun_ad",
     "aciklama": "Fiyatı değişen ürün sustu → fiyat şoku olabilir", "aktif": True},
    {"kural_id": "R8_avans_kasa_izi", "surum": 1, "gecerli_bas": "2026-07-07", "tur": "T2",
     "yasam_dongusu": "beklenti_acik_kapali", "pencere_gun": 1, "pencere_capasi": "occurred_at",
     "ebeveyn": "avans/finans.sube.avans_cikisi",
     "cocuk": "kasa_hareketleri/PERSONEL_AVANS satırı", "eslesme": "kaynak_id",
     "aciklama": "Avans teslim edildi → kasa defterinde PERSONEL_AVANS izi DOĞMALI; "
                 "yoksa yokluk sinyaldir (kasa izi tek gerçek)", "aktif": True},
    {"kural_id": "R9_iletim_toparlanma", "surum": 1, "gecerli_bas": "2026-07-07", "tur": "T2",
     "yasam_dongusu": "beklenti_acik_kapali", "pencere_gun": 2, "pencere_capasi": "occurred_at",
     "ebeveyn": "bildirim_iletim/iletisim.mesaj.gonderim_hatasi",
     "cocuk": "duyu_nabiz/bildirim_iletim basari", "eslesme": "kanal",
     "aciklama": "Ses kısıldı → 2 gün içinde başarılı gönderim DOĞMALI; "
                 "yoksa sistemin sesi hâlâ kısık", "aktif": True},
]


def _olaylar(cur, duyu: str, tip: str | None, bas: date, bit: date) -> list:
    if tip:
        cur.execute(
            """SELECT event_id, duyu, olay_tipi, entity_scope, entity_id,
                      occurred_at::text, payload_json
               FROM duyu_olay
               WHERE duyu = %s AND olay_tipi = %s AND occurred_at::date BETWEEN %s AND %s""",
            (duyu, tip, str(bas), str(bit)))
    else:
        cur.execute(
            """SELECT event_id, duyu, olay_tipi, entity_scope, entity_id,
                      occurred_at::text, payload_json
               FROM duyu_olay
               WHERE duyu = %s AND occurred_at::date BETWEEN %s AND %s""",
            (duyu, str(bas), str(bit)))
    return [dict(r) for r in (cur.fetchall() or [])]


def _t1_bag_yaz(kural: dict, aciklanan: dict, aciklayan: dict | None, ekstra: dict | None = None):
    """T1 bağı → sinaps_sarmal olayı (kural_id+sürüm damgalı; idempotent)."""
    from duyu_omurga import duyu_olay_yaz
    duyu_olay_yaz(
        "sinaps_sarmal", "meta.aciklama.baglanti_adayi",
        f"{kural['kural_id']}v{kural['surum']}_{aciklanan['event_id']}",
        entity_scope=aciklanan.get("entity_scope") or "genel",
        entity_id=aciklanan.get("entity_id"),
        occurred_at=str(aciklanan.get("occurred_at") or "")[:10] or None,
        signal_name=f"Yavru bağı: {kural['kural_id']}",
        evidence_class="oneri", assertion_level="korele", confidence=0.5,
        payload={"kural_id": kural["kural_id"], "surum": kural["surum"],
                 "aciklama": kural["aciklama"],
                 "aciklanan": {"event_id": aciklanan["event_id"], "duyu": aciklanan["duyu"]},
                 "aciklayan": ({"event_id": aciklayan["event_id"], "duyu": aciklayan["duyu"]}
                               if aciklayan else None),
                 **(ekstra or {}),
                 "not": "Bağ öneridir — sinyali KAPATMAZ; ikisi de kayıtta."},
    )


def _t2_durum_yaz(kural: dict, ebeveyn: dict, cocuk_geldi: bool, detay: dict | None = None):
    """T2 durumu → yavru_beklenti olayı. CODEX DİLİ: cocuk_geldi = zincir tamamlandı
    (ebeveyn AKLANMADI); cocuk_gelmedi = yokluk sinyali."""
    from duyu_omurga import duyu_olay_yaz
    tip = "yavru.beklenti.cocuk_geldi" if cocuk_geldi else "yavru.beklenti.cocuk_gelmedi"
    duyu_olay_yaz(
        "yavru_beklenti", tip,
        f"{kural['kural_id']}v{kural['surum']}_{ebeveyn['event_id']}",
        entity_scope=ebeveyn.get("entity_scope") or "genel",
        entity_id=ebeveyn.get("entity_id"),
        occurred_at=str(ebeveyn.get("occurred_at") or "")[:10] or None,
        signal_name=("Beklenen zincir tamamlandı" if cocuk_geldi
                     else "Beklenen çocuk DOĞMADI (yokluk sinyali)"),
        evidence_class="gozlem" if cocuk_geldi else "patern",
        assertion_level="korele", confidence=1.0 if cocuk_geldi else 0.7,
        payload={"kural_id": kural["kural_id"], "surum": kural["surum"],
                 "aciklama": kural["aciklama"],
                 "ebeveyn_event_id": ebeveyn["event_id"], **(detay or {}),
                 "not": "Zincir durumu — ebeveyn olay 'temiz' İLAN EDİLMEZ."},
    )


# ── EŞLEŞTİRİCİLER (kural başına; kütüphane metadata + küçük kod) ────────────
def _r1_r7_fiyat(cur, kural, dun):
    """R1/R7: fiyat değişimi (son pencere) × dünkü zımni sapma / ürün sessizliği."""
    fiyatlar = _olaylar(cur, "menu_fiyat_izi", "fiyat.menu.degisim",
                        dun - timedelta(days=kural["pencere_gun"]), dun)
    if not fiyatlar:
        return 0
    fiyat_ad = {str(f.get("entity_id") or "").lower(): f for f in fiyatlar}
    n = 0
    if kural["kural_id"] == "R1_fiyat_zimni":
        for ac in _olaylar(cur, "adet_tutar", "finans.satis.zimni_fiyat_kesiti", dun, dun):
            for s in (ac.get("payload_json") or {}).get("sapma_adaylari") or []:
                f = fiyat_ad.get(str(s.get("ad") or "").lower())
                if f:
                    _t1_bag_yaz(kural, ac, f, {"urun": s.get("ad")})
                    n += 1
                    break
    else:  # R7
        for ac in _olaylar(cur, "urun_sessiz", "satis.urun.sessiz_sifirlanma", dun, dun):
            urun = str((ac.get("payload_json") or {}).get("urun") or ac.get("entity_id") or "").lower()
            f = fiyat_ad.get(urun)
            if f:
                _t1_bag_yaz(kural, ac, f)
                n += 1
    return n


def _r2_r6_ritim(cur, kural, dun):
    """R2/R6: geç KAPANIS/ACILIS (>30dk) × kapanış-sonrası kayıt / açılış kasa farkı."""
    tip_ad = "KAPANIS" if kural["kural_id"] == "R2_gec_kapanis" else "ACILIS"
    gecikenler = {}
    for o in _olaylar(cur, "operasyon_ritmi", "operasyon.ritim.dilim_kesiti", dun, dun):
        pj = o.get("payload_json") or {}
        if pj.get("tip") == tip_ad and float(pj.get("gecikme_dk") or 0) > 30:
            gecikenler[str(o.get("entity_id"))] = o
    if not gecikenler:
        return 0
    n = 0
    if kural["kural_id"] == "R2_gec_kapanis":
        for ac in _olaylar(cur, "kapanis_sonrasi", "operasyon.kayit.kapanis_sonrasi_ciro", dun, dun):
            e = gecikenler.get(str(ac.get("entity_id")))
            if e:
                _t1_bag_yaz(kural, ac, e)
                n += 1
    else:  # R6 — çocuk omurgada değil: sube_operasyon_uyari'dan okunur
        for sube_id, e in gecikenler.items():
            cur.execute(
                """SELECT ROUND(COALESCE(fark_tl,0)::numeric,2) AS fark FROM sube_operasyon_uyari
                   WHERE sube_id::text = %s AND tarih = %s AND tip = 'ACILIS_KASA_FARK'
                     AND ABS(COALESCE(fark_tl,0)) > 0 LIMIT 1""",
                (sube_id, str(dun)))
            row = cur.fetchone()
            if row:
                sahte_cocuk = {"event_id": f"uyari_{sube_id}_{dun}", "duyu": "sube_operasyon_uyari",
                               "entity_scope": "sube", "entity_id": sube_id,
                               "occurred_at": str(dun)}
                _t1_bag_yaz(kural, sahte_cocuk, e, {"acilis_fark_tl": float(dict(row)["fark"])})
                n += 1
    return n


def _r3_sayim(cur, kural, dun):
    sayimlar = _olaylar(cur, "stok_sayim", None, dun - timedelta(days=kural["pencere_gun"]), dun)
    sayim_sube = {str(s.get("entity_id")): s for s in sayimlar if s.get("entity_id")}
    n = 0
    for ac in _olaylar(cur, "sayim_cevresi", "stok.duzeltme.sayim_cevresi_kesiti", dun, dun):
        e = sayim_sube.get(str(ac.get("entity_id")))
        if e:
            _t1_bag_yaz(kural, ac, e)
            n += 1
    return n


def _r4_fire(cur, kural, dun):
    fireler = _olaylar(cur, "iade_fire", "stok.fire.bildirim_kesiti",
                       dun - timedelta(days=kural["pencere_gun"]), dun)
    fire_sube = {str(f.get("entity_id")): f for f in fireler}
    n = 0
    for ac in _olaylar(cur, "sinaps_kase", "stok.kalem.dortgen_sayim_birlikteligi", dun, dun):
        sube_id = str((ac.get("payload_json") or {}).get("sube_id") or "")
        e = fire_sube.get(sube_id)
        if e:
            _t1_bag_yaz(kural, ac, e)
            n += 1
    return n


def _r5_mudahale(cur, kural, dun):
    mudahaleler = _olaylar(cur, "mudahale_izi", "operasyon.kayit.geriye_donuk_mudahale", dun, dun)
    if not mudahaleler:
        return 0
    farklar = _olaylar(cur, "k1_mutabakat", "kasa.kart.defter_farki", dun, dun)
    if len(farklar) < 3:  # furya eşiği kural metninde
        return 0
    for ac in farklar:
        _t1_bag_yaz(kural, ac, mudahaleler[0], {"ayni_gun_fark_n": len(farklar)})
    return len(farklar)


def _r8_avans(cur, kural, dun):
    """T2: avans çıkışı (D-1) → kasa PERSONEL_AVANS izi DOĞMALI (kasa izi tek gerçek)."""
    n = 0
    for e in _olaylar(cur, "avans", "finans.sube.avans_cikisi", dun, dun):
        # source_ref formatı "aid:teslim" — event tablosunda source_ref yok elimizde,
        # payload'a bak; yoksa avans id'yi kasa kaynak_id LIKE ile arayamayız → gün+tür kaba
        aid = str((e.get("payload_json") or {}).get("avans_id") or "").strip()
        if aid:
            cur.execute(
                "SELECT 1 FROM kasa_hareketleri WHERE ref_type='PERSONEL_AVANS' "
                "AND kaynak_id = %s LIMIT 1", (aid,))
        else:
            cur.execute(
                "SELECT 1 FROM kasa_hareketleri WHERE ref_type='PERSONEL_AVANS' "
                "AND tarih = %s LIMIT 1", (str(dun),))
        geldi = cur.fetchone() is not None
        _t2_durum_yaz(kural, e, geldi, {"avans_id": aid or None, "eslesme_duzeyi":
                                        "id" if aid else "gun_kaba"})
        n += 1
    return n


def _r9_iletim(cur, kural, dun):
    """T2: gönderim hatası (D-pencere) → sonrasında başarılı nabız DOĞMALI."""
    hedef = dun - timedelta(days=kural["pencere_gun"])
    n = 0
    for e in _olaylar(cur, "bildirim_iletim", "iletisim.mesaj.gonderim_hatasi", hedef, hedef):
        cur.execute(
            """SELECT 1 FROM duyu_nabiz WHERE duyu='bildirim_iletim' AND durum='basari'
               AND run_ts::date > %s LIMIT 1""",
            (str(hedef),))
        geldi = cur.fetchone() is not None
        _t2_durum_yaz(kural, e, geldi)
        n += 1
    return n


_ESLESTIRICILER = {
    "R1_fiyat_zimni": _r1_r7_fiyat, "R2_gec_kapanis": _r2_r6_ritim,
    "R3_sayim_duzeltme": _r3_sayim, "R4_fire_kase": _r4_fire,
    "R5_mudahale_kart": _r5_mudahale, "R6_gec_acilis_fark": _r2_r6_ritim,
    "R7_fiyat_sessiz": _r1_r7_fiyat, "R8_avans_kasa_izi": _r8_avans,
    "R9_iletim_toparlanma": _r9_iletim,
}


def gece_yavru_calistir() -> None:
    """GECE: tüm aktif kurallar dün için koşar. Her kural kendi hatasını yutar;
    T1 bağları sinaps_sarmal, T2 durumları yavru_beklenti nabzına yazılır."""
    from duyu_omurga import duyu_nabiz_yaz
    dun = date.today() - timedelta(days=1)
    t1_n, t2_n, hata_n = 0, 0, 0
    for kural in KURAL_KUTUPHANESI:
        if not kural.get("aktif"):
            continue
        esle = _ESLESTIRICILER.get(kural["kural_id"])
        if not esle:
            continue
        try:
            with db() as (_, cur):
                uret = esle(cur, kural, dun)
            if kural["tur"] == "T1":
                t1_n += uret
            else:
                t2_n += uret
        except Exception as e:  # noqa: BLE001
            hata_n += 1
            logger.warning("yavru kural %s yutuldu: %s", kural["kural_id"], str(e)[:100])
    duyu_nabiz_yaz("sinaps_sarmal", taranan=sum(1 for k in KURAL_KUTUPHANESI if k.get("aktif")),
                   uretilen=t1_n, yutulan_hata=hata_n)
    duyu_nabiz_yaz("yavru_beklenti", taranan=2, uretilen=t2_n)


# ── SALT-OKUR UÇ ─────────────────────────────────────────────────────────────
@router.get("/yavru-kurallari")
def yavru_kurallari(gun: int = Query(7, ge=1, le=30)):
    """Kural kütüphanesi + son bağlar/beklenti durumları. Hüküm yok."""
    bas = date.today() - timedelta(days=gun - 1)
    with db() as (_, cur):
        cur.execute(
            """SELECT duyu, olay_tipi, signal_name, entity_id, occurred_at::text,
                      confidence, payload_json
               FROM duyu_olay
               WHERE duyu IN ('sinaps_sarmal','yavru_beklenti') AND observed_at >= %s
               ORDER BY observed_at DESC LIMIT 60""",
            (str(bas),))
        baglar = [dict(r) for r in (cur.fetchall() or [])]
    return {
        "kural_n": len(KURAL_KUTUPHANESI),
        "kurallar": [{k: v for k, v in kural.items()} for kural in KURAL_KUTUPHANESI],
        "son_baglar": baglar,
        "not": "T1 bağı sinyali KAPATMAZ; T2 'cocuk_geldi' zincir bilgisidir, aklama "
               "değildir. Kural ekleme yalnız insan onayıyla (kod commit'i).",
    }
