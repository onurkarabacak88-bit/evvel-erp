"""
FAZ 4 ÖN-KURULUM — MOTOR UYANIŞ KAPISI (UYUR MOD) (2026-07-06, Claude+Codex çapraz)

Motor (truth_motor) BİR GÜN omurgayı okuyacak; isme ancak ≥2-3 BAĞIMSIZ duyu aynı yere
işaret ederse yaklaşacak. Bu modül o kapıyı ŞİMDİDEN, UYUR halde kurar:
  - Motor bu modülü ÇAĞIRMAZ (tek satır import yok) — sadece insan önizler.
  - Hiçbir şey alarm üretmez/kapatmaz (beraat yasağı).
  - Veri-önce bozulmaz: kapı okur, karar vermez.

CODEX'İN 4 DÜZELTMESİ (2026-07-06 danışma, 215K token):
  1. OLGUNLUK BEKÇİSİ: occurred≠observed dünyasında taze pencere OYNAR (geç kayıt
     paketi sonradan değiştirir). Kural: pencere bitişi ≥ D+2 değilse paket
     "olgunlaşmamış" damgalı — insana çapa atmasın.
  2. BAĞIMSIZLIK = YAPRAK SOYAĞACI: üretici adı değil HAM KAYNAK ailesi sayılır;
     sinaps/meta olayları kanıt SAYILMAZ (kompozitler alt üreticilere açılır);
     iki sinyal aynı ham tabloda dipleniyorsa TEK ailedir.
  3. HAZIRLIK KRİTERLERİ SERTLEŞTİRİLDİ: olgun veri yaşı, güvenilen-aile canlılığı,
     sonuç-çeşitli etiketler, şube-DİLİM kapsaması, kararlı paket örnekleri,
     arındırma haritası, + KÖPRÜ KAPSAMA YÜZDESİ (öğretmen borusunun sağlığı).
  4. Uyur kapı veri-önce'yi bozmaz — bekçisiz ve soyağacısız kurulursa bozar.

İçerik: (a) etiket köprüsü (onay kuyruğu insan kararları → duyu_etiket, gece),
(b) operasyon ritmi duyusu (geç açılış/kapanış + şube-dilim kesiti — Codex'in
"branch-shift" kapsama ölçüsünün veri kaynağı), (c) kanit_paketi tek okuma kapısı,
(d) uyanış-hazırlık ölçer (7 kriter), (e) arındırma haritası (hüküm→fenomen dili).
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

from fastapi import APIRouter, Query

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/duyu", tags=["duyu-uyanis"])

OLGUNLUK_GUN = 2  # Codex bekçisi: pencere bitişi bugünden en az bu kadar geride olmalı


# ── (a) ETİKET KÖPRÜSÜ: insan kararları → öğretmen defteri ──────────────────
def gece_etiket_koprusu() -> None:
    """GECE: KARARA BAĞLANMIŞ TÜM onay kuyruğu kayıtları → duyu_etiket.
    Bilinçli tüm-tarih taraması: tablo küçük, yazıcı idempotent (UNIQUE(kaynak,
    iliskili_ref)) — köprü her gece kendi kendini onarır, tarihsel karar kaçmaz.
    Kimlik taşınmaz (açıklama serbest metni BİLEREK kopyalanmaz — isim içerebilir)."""
    from duyu_omurga import duyu_etiket_yaz, duyu_nabiz_yaz
    try:
        with db() as (_, cur):
            cur.execute(
                """
                SELECT id, islem_turu, kaynak_tablo, tutar, tarih::text AS tarih, durum
                FROM onay_kuyrugu
                WHERE durum IN ('onaylandi', 'reddedildi')
                """
            )
            kararlar = [dict(r) for r in (cur.fetchall() or [])]
        for k in kararlar:
            duyu_etiket_yaz(
                kaynak="onay" if k["durum"] == "onaylandi" else "red",
                iliskili_ref=str(k["id"]),
                insan_karari=k["durum"],
                detay={"islem_turu": k.get("islem_turu"), "kaynak_tablo": k.get("kaynak_tablo"),
                       "tutar": float(k["tutar"]) if k.get("tutar") is not None else None,
                       "tarih": k.get("tarih")},
            )
        duyu_nabiz_yaz("etiket_koprusu", taranan=len(kararlar), uretilen=len(kararlar))
    except Exception as e:  # noqa: BLE001
        logger.warning("gece etiket koprusu yutuldu: %s", str(e)[:120])
        duyu_nabiz_yaz("etiket_koprusu", durum="hata", yutulan_hata=1, not_metin=str(e)[:200])


# ── (b) OPERASYON RİTMİ: geç açılış/kapanış + şube-DİLİM kesiti ─────────────
def gece_operasyon_ritmi() -> None:
    """GECE: dünün şube×slot (ACILIS/KONTROL/CIKIS/KAPANIS) cevap gecikmeleri → omurga.
    Sv0 HAM: zamanında olan da yazılır (dilim kapsaması buradan sayılır — Codex kriteri).
    Kimliksiz: dilim bir kişi değil, günün bir parçasıdır."""
    from duyu_omurga import duyu_nabiz_yaz, duyu_olay_yaz
    try:
        dun = date.today() - timedelta(days=1)
        with db() as (_, cur):
            cur.execute(
                """
                SELECT e.sube_id, s.ad AS sube_ad, e.tip, e.sira_no, e.durum,
                       e.son_teslim_ts::text AS planlanan,
                       e.cevap_ts::text AS cevap,
                       CASE WHEN e.cevap_ts IS NOT NULL THEN
                           ROUND((EXTRACT(EPOCH FROM (e.cevap_ts - e.son_teslim_ts)) / 60.0)::numeric, 1)
                       END AS gecikme_dk
                FROM sube_operasyon_event e JOIN subeler s ON s.id = e.sube_id
                WHERE e.tarih = %s AND e.durum <> 'latent'
                """,
                (str(dun),),
            )
            slotlar = [dict(r) for r in (cur.fetchall() or [])]
        for sl in slotlar:
            duyu_olay_yaz(
                "operasyon_ritmi", "operasyon.ritim.dilim_kesiti",
                f"{sl['sube_id']}_{dun}_{sl['tip']}_{sl['sira_no']}",
                entity_scope="sube", entity_id=str(sl["sube_id"]), occurred_at=str(dun),
                signal_name="Şube-dilim cevap ritmi",
                payload={"sube_ad": sl.get("sube_ad"), "tip": sl.get("tip"),
                         "sira_no": sl.get("sira_no"), "durum": sl.get("durum"),
                         "gecikme_dk": float(sl["gecikme_dk"]) if sl.get("gecikme_dk") is not None else None,
                         "cevapsiz": sl.get("cevap") is None},
            )
        duyu_nabiz_yaz("operasyon_ritmi", taranan=len(slotlar), uretilen=len(slotlar))
    except Exception as e:  # noqa: BLE001
        logger.warning("gece operasyon ritmi yutuldu: %s", str(e)[:120])
        duyu_nabiz_yaz("operasyon_ritmi", durum="hata", yutulan_hata=1, not_metin=str(e)[:200])


def gece_uyanis_calistir() -> None:
    """Tek giriş — köprü + ritim; her biri kendi hatasını yutar."""
    gece_etiket_koprusu()
    gece_operasyon_ritmi()


@router.post("/uyanis-kopru-calistir")
def uyanis_kopru_calistir():
    """Elle tetik: etiket köprüsünü ŞİMDİ çalıştır (idempotent — çift kayıt üretmez).
    İlk kurulumda tarihsel kararların geceyi beklemeden köprülenmesi için."""
    gece_etiket_koprusu()
    with db() as (_, cur):
        cur.execute("SELECT COUNT(*)::int AS n FROM duyu_etiket")
        n = int(dict(cur.fetchone() or {}).get("n") or 0)
    return {"ok": True, "etiket_toplam": n}


# ── (e) ARINDIRMA HARİTASI: motorun hüküm dili → fenomen dili ────────────────
# Motor uyanış turunda tanı adları bu haritayla arındırılacak. Harita ŞİMDİ yazıldı ki
# uyanış günü sözlük tartışması değil kod işi olsun. (Hüküm sözcüğü fenomende YASAK.)
ARINDIRMA_HARITASI = {
    "ZIMMET_NAKIT_CEPTE":       "kasa.vardiya.nakit_eksik_yonlu_fark",
    "SABAH_ZIMMET_SUPHE":       "kasa.vardiya.sabah_eksik_egilim",
    "AKSAM_ZIMMET_SINYALI":     "kasa.vardiya.aksam_eksik_egilim",
    "AKSAM_ZIMMET_POZISYON":    "kasa.vardiya.aksam_eksik_egilim",
    "AKSAM_KASAYI_SISIRDI":     "kasa.vardiya.fazla_yonlu_fark",
    "VARDIYA_KASA_ACIK":        "kasa.vardiya.eksik_fark",
    "VARDIYA_KASA_FAZLA":       "kasa.vardiya.fazla_fark",
    "ACIKLANAMAZ_DEVAM":        "kasa.fark.suren_fark",
    "EVO_DESTEKLI_HIRSIZLIK":   "kasa.satis.evo_kasa_uyumsuz",
    "POS_BYPASS":               "satis.islem.pos_kaydi_yok",
    "POS_FANTOM_SATIS":         "satis.islem.kasa_karsiligi_yok",
    "SWEETHEARTING_SINYAL":     "satis.islem.iskonto_yogunlugu",
    "SWEETHEARTING_ZIMMET":     "satis.islem.iskonto_kasa_birlikteligi",
    "ZIMMET_IPTAL":             "satis.iptal.iptal_yogunlugu",
    "ZIMMET_IPTAL_MANIPULASYON": "satis.iptal.iptal_kasa_birlikteligi",
    "SAHTE_FIRE_KAYDI":         "stok.fire.fire_satis_uyumsuz",
    "STOK_KACAGI_BEYANSIZ":     "stok.kalem.beyansiz_dusus",
    "AKSAM_BARDAK_SISIRDI":     "stok.bardak.kullanim_satis_uyumsuz",
}


# ── (c) KANIT PAKETİ: tek okuma kapısı (UYUR — motor çağırmıyor) ─────────────
def _aile_haritasi() -> dict:
    from duyu_omurga import _DUYU_REGISTRY
    return {ad: (m.get("kaynak_aile") or "bilinmiyor") for ad, m in _DUYU_REGISTRY.items()}


def _kanit_duyulari() -> set:
    """Kanıt sayılan duyular (registry kanit=True). Denetim P2-5: rutin günlük kesitler
    bağımsızlık sayacını doyuruyordu — sadece işaretli duyular + patern-sınıfı olaylar sayılır."""
    from duyu_omurga import _DUYU_REGISTRY
    return {ad for ad, m in _DUYU_REGISTRY.items() if m.get("kanit")}


def kanit_paketi(entity_scope: str, entity_id: str, gun_bas: date, gun_bit: date) -> dict:
    """Bir odak (şube/kalem/tedarikçi × pencere) için BAĞIMSIZ kanıt paketi.
    Codex kuralları: (1) pencere D+2'den tazeyse 'olgunlaşmamış' damgası;
    (2) bağımsızlık = yaprak ham-kaynak ailesi; sinaps/meta SAYILMAZ, kompozitler
    payload'daki kaynak üreticilere AÇILIR; (3) hüküm yok — paket sayar, yorumlamaz."""
    aileler_map = _aile_haritasi()
    kanit_seti = _kanit_duyulari()
    olgun = gun_bit <= date.today() - timedelta(days=OLGUNLUK_GUN)
    with db() as (_, cur):
        cur.execute(
            """
            SELECT event_id, duyu, olay_tipi, signal_name, occurred_at::text,
                   confidence, evidence_class, payload_json
            FROM duyu_olay
            WHERE entity_scope = %s AND entity_id = %s
              AND occurred_at::date BETWEEN %s AND %s
            ORDER BY occurred_at
            """,
            (entity_scope, str(entity_id), str(gun_bas), str(gun_bit)),
        )
        olaylar = [dict(r) for r in (cur.fetchall() or [])]
    # Yaprak soyağacına aç + KANIT SÜZGECİ (denetim P2-5): rutin kesit olayları sayılmaz;
    # bir olay ancak (duyusu kanit=True) VEYA (evidence_class='patern') ise kanıttır.
    # Kompozit → payload'daki kaynak duyulara açılır; meta aileler her durumda dışarı.
    yaprak_duyular = set()
    for o in olaylar:
        d = str(o.get("duyu") or "")
        if d == "sinaps_kompozit":
            pj = o.get("payload_json") or {}
            for kd in pj.get("duyular") or []:
                if str(kd) in kanit_seti:
                    yaprak_duyular.add(str(kd))
        elif d in kanit_seti or str(o.get("evidence_class") or "") == "patern":
            yaprak_duyular.add(d)
    aileler = sorted({aileler_map.get(d, "bilinmiyor") for d in yaprak_duyular}
                     - {"meta", "bilinmiyor", "iletisim"})
    # Y5 ALTYAPISI (2026-07-07, Codex mutlak kuralı): sarmal-bilinçli SUNUM —
    # açıklama bağı OLAN olaylar 'aciklanmis' etiketi alır ve dikkat sırasında GERİYE
    # düşer; açıklanmamışlar öne. bagimsiz_aile_n'e ve pakete ASLA dokunulmaz —
    # hiçbir olay çıkarılmaz, hiçbir sayı düşürülmez (matematiğe indirgenmiş beraat yasak).
    aciklayan_kural: dict = {}  # event_id → kural_id
    olay_ids = [o["event_id"] for o in olaylar]
    if olay_ids:
        with db() as (_, cur):
            cur.execute(
                """
                SELECT payload_json->'aciklanan'->>'event_id' AS ref,
                       payload_json->>'kural_id' AS kural_id
                FROM duyu_olay
                WHERE duyu = 'sinaps_sarmal'
                  AND payload_json->'aciklanan'->>'event_id' = ANY(%s)
                """,
                (olay_ids,),
            )
            for r in cur.fetchall() or []:
                d = dict(r)
                aciklayan_kural[str(d["ref"])] = str(d.get("kural_id") or "")
    # Y4 ağırlıkları (öğrenme AÇIK; n>=eşik kurallar uygulanabilir) — fail-safe boş dict
    try:
        from duyu_yavru import kural_agirliklari
        agirliklar = kural_agirliklari()
    except Exception:  # noqa: BLE001
        agirliklar = {}
    olay_liste = []
    for o in olaylar:
        eid = o["event_id"]
        kural_id = aciklayan_kural.get(eid)
        ag = agirliklar.get(kural_id or "") or {}
        # açıklama gücü: kural henüz öğrenilmemişse (n<eşik) None — nötr açıklama
        guc = ag.get("posterior") if ag.get("uygulanabilir") else None
        olay_liste.append({**{k: o.get(k) for k in ("event_id", "duyu", "olay_tipi",
                                                    "signal_name", "occurred_at", "confidence")},
                           "aciklama_durumu": "aciklanmis" if kural_id else "aciklanmamis",
                           "aciklayan_kural": kural_id,
                           "aciklama_gucu": guc})
    # Dikkat sırası: açıklanmamışlar ÖNDE; açıklanmışlar arasında ZAYIF kuralın
    # açıklaması öne yakın (zayıf açıklama ≈ neredeyse açıklanmamış), güçlü geriye.
    # SADECE sunum — sayıma/kapıya etkisi yok.
    olay_liste.sort(key=lambda o: (o["aciklama_durumu"] == "aciklanmis",
                                   o.get("aciklama_gucu") if o.get("aciklama_gucu") is not None else 0.5,
                                   str(o.get("occurred_at") or "")))
    return {
        "odak": {"scope": entity_scope, "entity_id": entity_id,
                 "pencere": [str(gun_bas), str(gun_bit)]},
        "olgun": olgun,
        "bagimsiz_aile_n": len(aileler),
        "aileler": aileler,
        "olay_n": len(olaylar),
        "aciklanmamis_n": sum(1 for o in olay_liste if o["aciklama_durumu"] == "aciklanmamis"),
        "olaylar": olay_liste[:20],
        "dikkat_sirasi_notu": "Açıklanmamış olaylar ÖNDE; açıklama bağı olanlar geride "
                              "ama SAYIMDA — hiçbir olay paketten düşmez.",
        "not": ("PAKET OLGUNLAŞMAMIŞ — geç kayıtlar sayıyı değiştirebilir; çapa atma."
                if not olgun else
                "Paket olgun (D+%d bekçisi geçti). Sayı hüküm değildir; motor UYUYOR — "
                "bu önizleme insan içindir." % OLGUNLUK_GUN),
    }


@router.get("/kanit-paketi")
def kanit_paketi_endpoint(
    scope: str = Query("sube"),
    entity_id: str = Query(...),
    gun: int = Query(7, ge=1, le=30),
    bitis: str | None = Query(None, description="YYYY-MM-DD; boş=olgun son gün (D-2)"),
):
    """İNSAN ÖNİZLEMESİ — motor bu ucu çağırmaz. Varsayılan pencere OLGUN biter (D-2)."""
    if bitis:
        gun_bit = date.fromisoformat(bitis)
    else:
        gun_bit = date.today() - timedelta(days=OLGUNLUK_GUN)
    gun_bas = gun_bit - timedelta(days=gun - 1)
    return kanit_paketi(scope, entity_id, gun_bas, gun_bit)


# ── (d) UYANIŞ-HAZIRLIK ÖLÇER: 7 kriter (Codex revizyonlu) ──────────────────
@router.get("/uyanis-hazirlik")
def uyanis_hazirlik():
    """Motor uyanışına hazırlık karnesi. Kriterler geçene kadar motor UYUR.
    Hüküm yok: bu bir takvim değil termometre — 'hazır değil' de dürüst bir cevaptır."""
    kriterler = []
    olgun_sinir = date.today() - timedelta(days=OLGUNLUK_GUN)
    with db() as (_, cur):
        # K1: OLGUN veri yaşı ≥60 gün (meta hariç, olgunlaşmış en eski olay)
        cur.execute(
            """
            SELECT MIN(occurred_at::date)::text AS ilk
            FROM duyu_olay WHERE occurred_at::date <= %s
              AND duyu NOT IN ('duyu_saglik','evvel_beyni','sinaps_kase','sinaps_zincir','sinaps_kompozit')
            """,
            (str(olgun_sinir),),
        )
        ilk = dict(cur.fetchone() or {}).get("ilk")
        yas = (date.today() - date.fromisoformat(ilk)).days if ilk else 0
        kriterler.append({"kriter": "olgun_veri_yasi", "hedef": ">=60 gün",
                          "durum": f"{yas} gün", "gecti": yas >= 60})

        # K3: etiket çeşitliliği — ≥50 etiket VE hem onay hem red VE ≥3 işlem türü
        cur.execute(
            """
            SELECT COUNT(*)::int AS n,
                   COUNT(DISTINCT kaynak)::int AS kaynak_n,
                   COUNT(DISTINCT detay_json->>'islem_turu')::int AS tur_n
            FROM duyu_etiket
            """
        )
        et = dict(cur.fetchone() or {})
        et_ok = int(et.get("n") or 0) >= 50 and int(et.get("kaynak_n") or 0) >= 2 and int(et.get("tur_n") or 0) >= 3
        kriterler.append({"kriter": "etiket_cesitliligi",
                          "hedef": ">=50 etiket + onay&red + >=3 işlem türü",
                          "durum": f"{et.get('n')} etiket, {et.get('kaynak_n')} kaynak, {et.get('tur_n')} tür",
                          "gecti": et_ok})

        # K4: şube-DİLİM kapsaması ≥30 kesit (operasyon_ritmi olayları)
        cur.execute(
            "SELECT COUNT(*)::int AS n FROM duyu_olay "
            "WHERE duyu = 'operasyon_ritmi' AND occurred_at::date <= %s",
            (str(olgun_sinir),),
        )
        dilim_n = int(dict(cur.fetchone() or {}).get("n") or 0)
        kriterler.append({"kriter": "dilim_kapsamasi", "hedef": ">=30 olgun şube-dilim kesiti",
                          "durum": f"{dilim_n} kesit", "gecti": dilim_n >= 30})

        # K6: kararlı paket örnekleri — OLGUN pencerelerde ≥2 bağımsız aileli şube-gün ≥10.
        # Denetim P2-5: yalnız KANIT olayları sayılır (kanit=True duyular + patern sınıfı);
        # rutin kesitler sayılsaydı her şube-gün otomatik ≥2 aile olurdu.
        cur.execute(
            """
            SELECT entity_id, occurred_at::date::text AS gun,
                   ARRAY_AGG(DISTINCT duyu) AS duyular
            FROM duyu_olay
            WHERE entity_scope = 'sube' AND occurred_at::date <= %s
              AND duyu <> 'sinaps_kompozit'
              AND (duyu = ANY(%s) OR evidence_class = 'patern')
            GROUP BY entity_id, occurred_at::date
            """,
            (str(olgun_sinir), sorted(_kanit_duyulari())),
        )
        aileler_map = _aile_haritasi()
        paket_n = 0
        for r in cur.fetchall() or []:
            ailes = {aileler_map.get(str(d), "bilinmiyor") for d in (dict(r).get("duyular") or [])}
            if len(ailes - {"meta", "bilinmiyor", "iletisim"}) >= 2:
                paket_n += 1
        kriterler.append({"kriter": "kararli_paket_ornekleri",
                          "hedef": ">=10 olgun ≥2-aileli şube-gün paketi",
                          "durum": f"{paket_n} paket", "gecti": paket_n >= 10})

        # K7: köprü kapsaması — son 30 günde karara bağlananların %90'ı etikette mi?
        cur.execute(
            """
            SELECT COUNT(*)::int AS karar_n,
                   COUNT(e.etiket_id)::int AS koprulu_n
            FROM onay_kuyrugu ok
            LEFT JOIN duyu_etiket e
                   ON e.iliskili_ref = ok.id AND e.kaynak IN ('onay','red')
            WHERE ok.durum IN ('onaylandi','reddedildi')
              AND COALESCE(ok.onay_tarihi, ok.olusturma) >= NOW() - INTERVAL '30 days'
            """
        )
        kp = dict(cur.fetchone() or {})
        karar_n = int(kp.get("karar_n") or 0)
        oran = (int(kp.get("koprulu_n") or 0) / karar_n) if karar_n else 0.0
        kriterler.append({"kriter": "kopru_kapsamasi", "hedef": ">=%90 (öğretmen borusu sağlığı)",
                          "durum": f"%{round(oran*100)} ({kp.get('koprulu_n')}/{karar_n})",
                          "gecti": karar_n > 0 and oran >= 0.9})

    # K2: güvenilen-aile canlılığı — sağlık raporundan, aile bazında (meta hariç)
    try:
        from duyu_omurga import duyu_saglik
        aileler_map = _aile_haritasi()
        aile_durum: dict = {}
        for u in duyu_saglik().get("ureticiler") or []:
            aile = aileler_map.get(str(u.get("duyu")), "bilinmiyor")
            if aile in ("meta", "bilinmiyor"):
                continue
            aile_durum.setdefault(aile, []).append(str(u.get("rozet")))
        kotu = [a for a, rozetler in aile_durum.items()
                if rozetler and all(r in ("kopuk_supheli", "sorunlu") for r in rozetler)]
        canli_ok = bool(aile_durum) and not kotu
        kriterler.append({"kriter": "aile_canliligi",
                          "hedef": "hiçbir güvenilen aile tümden kopuk olmayacak",
                          "durum": ("tüm aileler izlenebilir" if canli_ok else f"kopuk aile: {kotu or 'veri yok'}"),
                          "gecti": canli_ok})
    except Exception as e:  # noqa: BLE001
        kriterler.append({"kriter": "aile_canliligi", "hedef": "-",
                          "durum": f"ölçülemedi: {str(e)[:60]}", "gecti": False})

    # K5: arındırma haritası hazır (≥10 hüküm-adı fenomen diline çevrildi)
    kriterler.append({"kriter": "arindirma_haritasi", "hedef": ">=10 tanı adı eşlendi",
                      "durum": f"{len(ARINDIRMA_HARITASI)} eşleme hazır",
                      "gecti": len(ARINDIRMA_HARITASI) >= 10})

    gecen = sum(1 for k in kriterler if k["gecti"])
    return {
        "durum": f"{gecen}/{len(kriterler)} kriter geçti",
        "motor": "UYUYOR — tüm kriterler geçene VE insan onayına kadar uyanmaz",
        "olgunluk_bekcisi_gun": OLGUNLUK_GUN,
        "kriterler": kriterler,
        "not": "Bu bir takvim değil termometre: kriterler veri biriktikçe kendiliğinden "
               "yeşerir. Uyanış günü motor omurgayı SADECE OKUR; isme yaklaşmak ≥2-3 "
               "bağımsız YAPRAK ailesi ister; hiçbir duyu verisi alarm kapatamaz.",
    }
