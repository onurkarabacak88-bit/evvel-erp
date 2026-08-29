"""
Sipariş sevkiyat kalem durumu — operasyon merkezi ve depo şube paneli ortak iş mantığı.

Operasyonun yönlendirdiği hedef depo şubesi (ör. Tema, Zafer), bu sipariş için
«merkez depo» ile aynı roldedir: çıkış stoğu ``sube_depo_stok`` üzerinden,
operasyon_defter kaydı ise ``defter_sube_id`` = hedef şube ile tutulur (tüm zincir
aynı çıkış deposunda izlenir).
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException

from kasa_service import audit
from operasyon_defter import operasyon_defter_ekle
from operasyon_stok_motor import depo_kalem_kodu_resolve, sevk_cikti_kaydet as _disiplin_sevk_cikti
from tr_saat import dt_now_tr
from sevkiyat_helpers import (
    sevkiyat_durumu_coz,
    sevkiyat_durumu_sql_expr,
    sevkiyat_durumu_guncelle_params,
    SD_NOALIAS,
)


def sevkiyat_kalem_durumlari_normalize(items: Any) -> Tuple[List[Dict[str, Any]], bool, bool]:
    """Kalem satırlarını JSONB ile uyumlu dict listesine çevirir; bekleyen/kısmi bayrakları döner."""
    bekleyen_var = False
    kismi_var = False
    durumlar: List[Dict[str, Any]] = []
    for it in items or []:
        if hasattr(it, "model_dump"):
            raw = it.model_dump()
        elif isinstance(it, dict):
            raw = it
        else:
            raw = dict(it)
        dd = (raw.get("durum") or raw.get("sevkiyat_durum") or "").strip().lower()
        if dd.startswith("tahsis"):
            dd = "bekliyor"
        # ── 🔀 KISMİ YÖNLENDİRME DURUMLARI (2026-08-29) ─────────────────────
        # Merkez kısmi depo yönlendirmesi yapınca `kalem_durumlari` bu talebe
        # ait AMA bu sevkiyata DAHİL OLMAYAN kalemleri de taşıyor:
        #   depoya_yonlendirilmedi · toptanciya_gitti · merkez_iptal
        # Depo ekranı kayıtları olduğu gibi geri gönderdiği için bu değerler
        # buraya ulaşıyor ve 400 üretiyordu → BÖLÜNMÜŞ SİPARİŞ SEVK EDİLEMİYOR,
        # dolayısıyla şube kabulü ve stok güncellemesi de hiç olmuyordu.
        # ⚠️ "Bilinmeyeni sessizce yok say" YAPILMIYOR: yalnız bu ÜÇ bilinen
        #    değer sevk-dışı ('yok', 0 adet) sayılır; başka bir değer hâlâ 400
        #    alır — gerçek bozuk girdi gizlenmesin.
        if dd in ("depoya_yonlendirilmedi", "toptanciya_gitti", "merkez_iptal"):
            raw = dict(raw)
            raw["_sevk_disi_sebep"] = dd
            dd = "yok"
        if dd not in ("bekliyor", "var", "yok", "kismi"):
            raise HTTPException(400, "kalem durumları: bekliyor | var | yok | kismi")
        ist = max(0, int(raw.get("istenen_adet") or 0))
        g_adet = max(0, int(raw.get("gonderilen_adet") or 0))
        if dd == "var" and g_adet <= 0 and ist > 0:
            g_adet = ist
        if dd == "yok":
            g_adet = 0
        if ist > 0 and g_adet > ist and dd in ("var", "kismi"):
            g_adet = ist
        if dd == "kismi" and g_adet <= 0:
            raise HTTPException(400, "kısmi için gonderilen_adet > 0 olmalı")
        if dd == "bekliyor":
            bekleyen_var = True
        if dd == "kismi":
            kismi_var = True
        notu = raw.get("notu") or raw.get("not_aciklama") or raw.get("not")
        row_out: Dict[str, Any] = {
            "urun_id": (str(raw.get("urun_id") or "").strip()) or None,
            "urun_ad": (str(raw.get("urun_ad") or "").strip()) or None,
            "istenen_adet": ist,
            "durum": dd,
            "gonderilen_adet": g_adet,
            "not": (str(notu).strip() if notu else None) or None,
        }
        kk = str(raw.get("kalem_kodu") or "").strip()
        if kk:
            row_out["kalem_kodu"] = kk
        # 🔀 Sevk dışı sebebi KAYITTA KALIR: rapor "depoda yok" ile "bu
        # sevkiyata dahil değil"i ayırabilsin ve kalem_durumlari'na yazılınca
        # bir sonraki açılışta ekran da sebebi bilsin. Taşınmazsa bilgi
        # normalleştiricide ölürdü.
        if raw.get("_sevk_disi_sebep"):
            row_out["_sevk_disi_sebep"] = str(raw.get("_sevk_disi_sebep")).strip()
            row_out["depo_disi"] = True
        # Tahsis alanları korunur (merkez_tahsis + sevkiyat aynı JSON'da)
        if raw.get("talep_adet") is not None:
            row_out["talep_adet"] = max(0, int(raw.get("talep_adet") or 0))
        if raw.get("tahsis_adet") is not None:
            row_out["tahsis_adet"] = max(0, int(raw.get("tahsis_adet") or 0))
        if raw.get("tahsis_durum"):
            row_out["tahsis_durum"] = str(raw.get("tahsis_durum") or "").strip()
        durumlar.append(row_out)
    return durumlar, bekleyen_var, kismi_var


def _sevk_satirlari_var_mi(durumlar: List[Dict[str, Any]]) -> bool:
    """var/kısmi + gonderilen_adet>0 — fiziksel sevk gerektirir."""
    for d in durumlar or []:
        if not isinstance(d, dict):
            continue
        dur = str(d.get("durum") or "").strip().lower()
        gon = max(0, int(d.get("gonderilen_adet") or 0))
        if dur in ("var", "kismi") and gon > 0:
            return True
    return False


def hesapla_yeni_sevkiyat_durumu(
    durumlar: List[Dict[str, Any]],
    bekleyen_var: bool,
    kismi_var: bool,
    gonderildi: bool,
) -> str:
    if bool(gonderildi):
        # «Yola Çıkar» basıldı: araç yola çıktı. Stok çıkışı _disiplin_sevk_cikti ile zaten
        # yapıldı. Bekleyen/kısmi kalemler bu sevkiyata dahil edilmedi — ama sevkiyat fiilen
        # gerçekleşti. bekleyen_var / kismi_var bu durumda «gonderildi» statüsünü engellemez.
        return "gonderildi"
    # Taslak kayıt: asla «gonderildi» durumuna geçmez (stok_yolda olmadan yolda sanılmasın)
    if kismi_var:
        return "kismi_hazirlandi"
    return "depoda_hazirlaniyor"


def _sevk_kalem_satir(cur: Any, d: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Depo çıkışı için canonical kalem_kodu + sevk adedi."""
    urun_id = str(d.get("urun_id") or "").strip()
    urun_ad = str(d.get("urun_ad") or "").strip()
    kk = str(d.get("kalem_kodu") or "").strip()
    if urun_id:
        kk = depo_kalem_kodu_resolve(cur, urun_id, urun_ad) or kk or urun_id
    elif not kk:
        kk = urun_ad
    if not kk:
        return None
    try:
        sevk_adet = max(0, int(d.get("gonderilen_adet") or 0))
    except (TypeError, ValueError):
        sevk_adet = 0
    if sevk_adet <= 0:
        return None
    try:
        _ist = max(0, int(d.get("istenen_adet") or 0))
    except (TypeError, ValueError):
        _ist = 0
    return {
        "kalem_kodu": kk,
        "kalem_adi": urun_ad or kk,
        "sevk_adet": sevk_adet,
        "urun_id": urun_id or None,
        # ⚠️ TASINMAYAN ALAN (canli test, 2026-08-30): cift sevk freninin
        # yeni kurali "toplam sevk ISTENEN adedi asamaz" diyor ama bu sozluk
        # `istenen_adet` TASIMIYORDU. Fren onu 0 goruyor ve her ikinci partiyi
        # reddediyordu — mesru kismi sevk (2+2 <= 6) bile engelleniyordu.
        # Testte yakalandi: mesaj "zaten 2 yolda, simdi 2 daha" diyordu ama
        # "istenen 6" yazmiyordu; eksik alanin imzasi buydu.
        "istenen_adet": _ist,
    }


def build_depo_sevkiyat_rapor(
    durumlar: List[Dict[str, Any]],
    *,
    personel_ad: Optional[str] = None,
) -> Tuple[str, bool]:
    """
    Operasyon / şube panelleri için okunaklı satır satır rapor.
    Dönüş: (metin, eksik_veya_kismi_uyari) — yok / kismi / bekleyen kalem varsa True.
    """
    satirlar: List[str] = []
    uyari = False
    for d in durumlar or []:
        if not isinstance(d, dict):
            continue
        ad = (d.get("urun_ad") or d.get("urun_id") or "Ürün").strip() or "Ürün"
        ist = int(d.get("istenen_adet") or 0)
        gon = int(d.get("gonderilen_adet") or 0)
        dur = (d.get("durum") or "").strip().lower()
        # Tahsis notu: merkez ne kadar tahsis etti?
        tahsis_notu = ""
        tahsis_adet = int(d.get("tahsis_adet") or 0)
        if tahsis_adet > 0 and tahsis_adet < ist:
            tahsis_notu = f" [tahsis: {tahsis_adet}/{ist}]"
        # ⚠️ "DEPODA YOK" ≠ "BU SEVKİYATA DAHİL DEĞİL" (2026-08-29)
        # Kısmi yönlendirmede seçilmeyen kalemler 'yok'a eşleniyor (sevk
        # motoru başka değer kabul etmiyor). Rapor bunu ayırmazsa "depoda yok"
        # yazıyor ve ŞUBEYE GİDİYOR: canlı denemede TEMA'da 10 adet Bahçe Nane
        # varken rapor "depoda yok" dedi. Şube deponun boş olduğunu sanır,
        # gereksiz toptancı siparişi verir. Sebep `_sevk_disi_sebep`te duruyor.
        _sd = (d.get("_sevk_disi_sebep") or "").strip().lower()
        if _sd:
            _neden = {
                "depoya_yonlendirilmedi": "merkez bu kalemi bu depoya yönlendirmedi",
                "toptanciya_gitti": "toptancıya yollandı",
                "merkez_iptal": "merkez iptal etti",
            }.get(_sd, "bu sevkiyata dahil değil")
            # ⚠️ `uyari` KURULMAZ: bu bir eksiklik değil, bilinçli bir karar.
            satirlar.append(
                f"• {ad}: istenen {ist} adet — bu sevkiyata dahil değil ({_neden})."
                f"{tahsis_notu}"
            )
        elif dur == "yok":
            uyari = True
            satirlar.append(f"• {ad}: istenen {ist} adet — depoda yok, 0 gönderildi.{tahsis_notu}")
        elif dur == "kismi":
            uyari = True
            satirlar.append(f"• {ad}: istenen {ist} adet — kısmi, {gon} adet gönderildi.{tahsis_notu}")
        elif dur == "var":
            satirlar.append(f"• {ad}: istenen {ist} adet — tamam, {gon} adet gönderildi.{tahsis_notu}")
        elif dur == "bekliyor":
            uyari = True
            satirlar.append(f"• {ad}: istenen {ist} adet — depo hazırlığı beklemede.{tahsis_notu}")
        else:
            satirlar.append(f"• {ad}: istenen {ist} adet — durum: {dur or '—'}.{tahsis_notu}")
    saat = dt_now_tr().strftime("%d.%m.%Y %H:%M")
    imza = (personel_ad or "").strip() or "—"
    bas = f"Depo sevkiyat özeti ({saat}) — onay: {imza}\n"
    if not satirlar:
        return (bas + "Kalem yok.", False)
    return (bas + "\n".join(satirlar), uyari)


def _kaynak_depo_aktif_uyumsuzluk_sayisi(cur: Any, kaynak_depo_sube_id: str, haric_talep_id: str) -> int:
    """Çözülmemiş kabul uyumsuzluğu olan sevkiyat satırlarını sayar."""
    cur.execute(
        """
        SELECT COUNT(*)
        FROM stok_yolda y
        JOIN siparis_talep t ON t.id = y.siparis_talep_id
        WHERE COALESCE(t.hedef_depo_sube_id, t.sevkiyat_sube_id) = %s
          AND t.id <> %s
          AND (
            y.durum = 'kabul_uyusmazlik'
            OR (
              y.durum IN ('kabul_edildi', 'yolda')
              AND y.kabul_ts IS NOT NULL
              AND COALESCE(y.sevk_adet, 0) <> COALESCE(y.kabul_adet, 0)
            )
          )
        """,
        (kaynak_depo_sube_id, haric_talep_id),
    )
    rr = cur.fetchone()
    try:
        return int(list(rr.values())[0] or 0) if rr else 0
    except Exception:
        return 0


def siparis_sevkiyat_kalem_guncelle_execute(
    cur: Any,
    *,
    talep_id: str,
    hedef_depo_sube_id: str,
    durumlar: List[Dict[str, Any]],
    bekleyen_var: bool,
    kismi_var: bool,
    notu: Optional[str],
    personel_ad: Optional[str],
    gonderildi: bool,
    defter_sube_id: str,
    beklenen_surum: Optional[int] = None,
) -> Dict[str, Any]:
    """FOR UPDATE ile talebi kilitleyip kalem_durumlari ve sevkiyat alanlarını günceller.

    🔒 `beklenen_surum`: ekranın OKUDUĞU `kalem_surum`. Yazma anında kayıttaki
    sürüm bundan farklıysa ekran BAYATTIR ve yazma reddedilir. None gelirse
    (henüz güncellenmemiş istemci) kontrol atlanır — geriye uyum.
    """
    tid = (talep_id or "").strip()
    sevk_sid = (hedef_depo_sube_id or "").strip()
    if not tid or not sevk_sid:
        raise HTTPException(400, "talep_id ve hedef_depo_sube_id zorunlu")

    sevk_var = _sevk_satirlari_var_mi(durumlar)
    if bool(gonderildi):
        if not sevk_var:
            raise HTTPException(
                400,
                "Yola çıkarmak için en az bir kalemde «var/kısmi» ve gönderilen adet girin.",
            )
    elif sevk_var:
        raise HTTPException(
            400,
            "Gönderilen adet girilmiş kalemler var — «Yola çıkar» ile sevk edin. "
            "Hazırlık kaydı yalnızca bekliyor / yok / not içindir.",
        )

    yeni_durum = hesapla_yeni_sevkiyat_durumu(durumlar, bekleyen_var, kismi_var, gonderildi)
    # Tek noktadan canonical → legacy çifti üret
    _sevk_durum_yeni, _sevk_durum_eski = sevkiyat_durumu_guncelle_params(yeni_durum)
    eski_durum_karsilik = _sevk_durum_eski

    cur.execute(
        f"""
        SELECT id, sube_id, COALESCE(hedef_depo_sube_id, sevkiyat_sube_id) AS hedef_depo_sube_id,
               {SD_NOALIAS} AS sevkiyat_durumu,
               durum, COALESCE(kalem_surum, 0) AS kalem_surum
        FROM siparis_talep
        WHERE id=%s
        FOR UPDATE
        """,
        (tid,),
    )
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Sipariş talebi bulunamadı")
    row = dict(r)
    # ══════════════════════════════════════════════════════════════════════
    # 🔒 BAYAT PENCERE KİLİDİ (Fable denetimi, 2026-08-30)
    # ══════════════════════════════════════════════════════════════════════
    # `kalem_durumlari` her yazmada TÜM DİZİ olarak eziliyor. Depo ekranı
    # modalı açtığı andaki diziyi hafızasında tutuyor; bu arada merkez bir
    # kalemi toptancıya yollarsa, depocunun kaydı o kalemi "bekliyor"a GERİ
    # EZİYOR ve depo onu da sevk ediyordu → aynı mal iki kanaldan, fatura
    # ikileniyordu.
    # Kontrol FOR UPDATE'ten SONRA: iki istek aynı anda gelirse biri bekler,
    # sonra sürümü değişmiş bulur ve reddedilir. Sayının kendisinde değil,
    # KİLİTLİ OKUMADA korunuyoruz.
    if beklenen_surum is not None:
        _mevcut_surum = int(row.get("kalem_surum") or 0)
        if int(beklenen_surum) != _mevcut_surum:
            raise HTTPException(
                409,
                "Bu sipariş siz ekranı açtıktan sonra değişti (merkez bir kalemi "
                "başka yere yönlendirmiş olabilir). Kaydınız ALINMADI — ekranı "
                "yenileyip tekrar deneyin.",
            )
    if str(row.get("hedef_depo_sube_id") or "") != sevk_sid:
        raise HTTPException(409, "Talep farklı sevkiyat şubesine atanmış")
    mevcut_durum = str(row.get("durum") or "")
    if mevcut_durum == "teslim_edildi":
        raise HTTPException(409, "Talep zaten teslim edildi")
    # ── UYUMSUZLUK = SİNYAL, KAPI DEĞİL (sahip kararı 2026-07-29) ──────────────
    # Eski davranış: depoda TEK çözülmemiş kabul uyumsuzluğu varken TÜM yeni
    # sevkiyatlar 409 ile kilitleniyordu → şube işleyişi duruyordu. Sahip:
    # "uyumsuzluklar şube panelin çalışmasına engel olmasın." Sert blok kalktı;
    # uyumsuzluk sayısı UYARI olarak rapora ve yanıta işlenir — kanban risk
    # şeridi + duyu/bağ katmanı zaten takipte, uzlaştırma yine insanın işi.
    uyumsuz_sayi = 0
    if bool(gonderildi):
        uyumsuz_sayi = _kaynak_depo_aktif_uyumsuzluk_sayisi(cur, sevk_sid, tid)

    rapor_metni, rapor_uyari = build_depo_sevkiyat_rapor(durumlar, personel_ad=personel_ad)
    if uyumsuz_sayi > 0:
        rapor_metni += (
            f"\n⚠ Not: bu depoda {uyumsuz_sayi} çözülmemiş kabul uyumsuzluğu var — "
            "sevk ENGELLENMEDİ; uzlaştırma Operasyon Merkezi ▸ Sevkiyat "
            "uyumsuzluklarında bekliyor."
        )
        rapor_uyari = True

    sevk_kalemleri: List[Dict[str, Any]] = []
    if bool(gonderildi):
        for d in durumlar:
            if str(d.get("durum") or "").strip().lower() not in ("var", "kismi"):
                continue
            satir = _sevk_kalem_satir(cur, d)
            if satir:
                sevk_kalemleri.append(satir)
        if not sevk_kalemleri:
            raise HTTPException(
                400,
                "Yola çıkarmak için en az bir kalemde «var/kısmi» ve gönderilen adet girin.",
            )
        try:
            _disiplin_sevk_cikti(
                cur,
                tid,
                sevk_kalemleri,
                None,
                personel_ad,
            )
        except ValueError as exc:
            # ⚠️ HEPSİ 404 DEĞİL (canlı test, 2026-08-30): çift sevk freni
            # devreye girdiğinde de 404 dönüyordu. 404 "bulunamadı" demektir;
            # oysa kayıt VAR, işlem ÇAKIŞIYOR. Yanlış kod istemciyi yanlış
            # yola sokar (ekran "sipariş silinmiş" sanabilir).
            # Çakışma/kural ihlali → 409, gerçek bulunamama → 404.
            _m = str(exc).strip() or "Sevkiyat çıkışı yapılamadı"
            _kod = 404 if "bulunamad" in _m.lower() else 409
            raise HTTPException(_kod, _m) from exc
        yeni_durum = hesapla_yeni_sevkiyat_durumu(durumlar, bekleyen_var, kismi_var, gonderildi)
        _sevk_durum_yeni, _sevk_durum_eski = sevkiyat_durumu_guncelle_params(yeni_durum)
        eski_durum_karsilik = _sevk_durum_eski
        # «Yola Çıkar»: wizard'da dokunulmayan «bekliyor» kalemleri bu sevkiyata dahil edilmedi.
        # Bunları «yok» olarak kapat — depo_hazirlik_talepleri sorgusunun tekrar eşleşmemesi için.
        durumlar = [
            {**d, "durum": "yok", "gonderilen_adet": 0}
            if str(d.get("durum") or "").strip().lower() == "bekliyor"
            else d
            for d in durumlar
        ]

    talep_durum = "gonderildi" if yeni_durum == "gonderildi" else "hazirlaniyor"

    cur.execute(
        """
        UPDATE siparis_talep
        SET sevkiyat_durumu=%s,
            sevkiyat_durum=%s,
            durum=%s,
            kalem_durumlari=%s::jsonb,
            -- 🔒 Bayat pencere kilidi
            kalem_surum = COALESCE(kalem_surum, 0) + 1,
            sevkiyat_notu=COALESCE(%s, sevkiyat_notu),
            sevkiyat_notlari=COALESCE(%s, sevkiyat_notlari),
            sevkiyat_personel_ad=COALESCE(%s, sevkiyat_personel_ad),
            depo_sevkiyat_rapor_metni=%s,
            depo_sevkiyat_rapor_ts=NOW(),
            depo_sevkiyat_rapor_uyari=%s,
            sevkiyat_ts=NOW()
        WHERE id=%s
        """,
        (
            _sevk_durum_yeni,
            _sevk_durum_eski,
            talep_durum,
            json.dumps(durumlar, ensure_ascii=False),
            notu,
            notu,
            personel_ad,
            rapor_metni,
            rapor_uyari,
            tid,
        ),
    )
    saat = dt_now_tr().strftime("%H:%M:%S")
    defter_aciklama = (
        f"Sipariş sevkiyat güncellendi — talep={tid} sevkiyat_sube={sevk_sid} durum={yeni_durum}"
        + (f" | Rapor: {(rapor_metni or '')[:380]}" if rapor_metni else "")
    )
    operasyon_defter_ekle(
        cur,
        defter_sube_id,
        "SIPARIS_SEVKIYAT_TAMAM" if bool(gonderildi) else "OPS_SIPARIS_SEVKIYAT_GUNCELLE",
        defter_aciklama,
        bildirim_saati=saat,
    )
    talep_sube_id = str(row.get("sube_id") or "").strip()
    if bool(gonderildi) and talep_sube_id and talep_sube_id != defter_sube_id:
        operasyon_defter_ekle(
            cur,
            talep_sube_id,
            "SIPARIS_SEVKIYATA_GONDERILDI",
            f"Siparişiniz hazırlanıp gönderildi — depo şube: {sevk_sid} · talep={tid}"
            + (f" | {(rapor_metni or '')[:200]}" if rapor_metni else ""),
            bildirim_saati=saat,
        )
    audit(cur, "siparis_talep", tid, "OPS_SIPARIS_SEVKIYAT_GUNCELLE")
    return {
        "success": True,
        "talep_id": tid,
        "sevkiyat_durumu": yeni_durum,
        "sevkiyat_durum": eski_durum_karsilik,
        "depo_sevkiyat_rapor_metni": rapor_metni,
        "depo_sevkiyat_rapor_uyari": rapor_uyari,
        # Sinyal (kapı değil): depoda çözülmemiş kabul uyumsuzluğu sayısı —
        # sevk engellenmez, arayüz uyarı gösterebilir.
        "uyumsuzluk_uyarisi": uyumsuz_sayi,
    }
