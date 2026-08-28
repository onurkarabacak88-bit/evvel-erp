"""
Sipariş Kontrol Kulesi — merkez operasyon görünürlüğü (pipeline + ürün geçmişi).
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

from sevkiyat_helpers import (
    SD_ST,
    sevkiyat_durumu_coz,
    sevkiyat_durumu_guncelle_params,
)

# Pipeline aşamaları (UI sütun / filtre anahtarları)
ASAMA_BEKLIYOR = "bekliyor"
ASAMA_DEPODA = "depoda"
ASAMA_YOLDA = "yolda"
ASAMA_TOPTANCI_BEKLIYOR = "toptanci_bekliyor"
ASAMA_UYUMSUZLUK = "uyumsuzluk"
ASAMA_TAMAMLANDI = "tamamlandi"
ASAMA_IPTAL = "iptal"
ASAMA_GONDERILMEDI = "gonderilmedi"

ASAMA_LABEL = {
    ASAMA_BEKLIYOR: "Merkez kuyruğu",
    ASAMA_DEPODA: "Depoda hazırlanıyor",
    ASAMA_YOLDA: "Yolda / kabul bekliyor",
    ASAMA_TOPTANCI_BEKLIYOR: "Toptancıdan bekleniyor",
    ASAMA_UYUMSUZLUK: "Kabul uyumsuzluğu",
    ASAMA_TAMAMLANDI: "Tamamlandı",
    ASAMA_IPTAL: "İptal",
    ASAMA_GONDERILMEDI: "Gönderilmedi",
}

ACIK_ASAMALAR = (
    ASAMA_BEKLIYOR,
    ASAMA_DEPODA,
    ASAMA_YOLDA,
    ASAMA_TOPTANCI_BEKLIYOR,
    ASAMA_UYUMSUZLUK,
)


def _kabul_durum_ozet(yolda: List[Dict[str, Any]]) -> Optional[str]:
    if not yolda:
        return None
    durumlar = [str(y.get("durum") or "").lower() for y in yolda]
    if any(d == "kabul_uyusmazlik" for d in durumlar):
        return "kabul_uyusmazlik"
    if all(d in ("kabul_edildi", "uzlasildi") for d in durumlar):
        return "kabul_tam"
    if any(d == "kabul_edildi" for d in durumlar):
        return "kabul_kismi"
    if any(d == "yolda" for d in durumlar):
        return "yolda"
    return None


def siparis_asama_hesapla(
    durum: Optional[str],
    sevkiyat_durumu: Optional[str],
    kabul_durum: Optional[str],
) -> str:
    d = (durum or "").strip().lower()
    sd = sevkiyat_durumu_coz(sevkiyat_durumu)

    if d == "iptal":
        return ASAMA_IPTAL
    if d == "gonderilmedi":
        return ASAMA_GONDERILMEDI
    # Toptancı kabulünde uyuşmazlık durum=kabul_uyusmazlik olarak gelir
    # (toptancıda stok_yolda yok, kabul_durum None) — bunu da yakala.
    if d == "kabul_uyusmazlik" or kabul_durum == "kabul_uyusmazlik":
        return ASAMA_UYUMSUZLUK
    if d == "teslim_edildi" or kabul_durum == "kabul_tam":
        return ASAMA_TAMAMLANDI
    if d == "bekliyor":
        return ASAMA_BEKLIYOR
    # Toptancıya yönlendirildi AMA henüz teslim alınmadı (durum hâlâ 'gonderildi')
    # → "tamamlandı" DEĞİL, açık bir "Toptancıdan bekleniyor" aşaması. Sadece
    # şube fiilen teslim alınca (durum=teslim_edildi, yukarıda) tamamlanır.
    if sd == "toptanciya_yonlendirildi":
        return ASAMA_TOPTANCI_BEKLIYOR
    if d == "gonderildi":
        return ASAMA_YOLDA
    if d == "hazirlaniyor":
        if sd == "gonderildi":
            return ASAMA_YOLDA
        return ASAMA_DEPODA
    if kabul_durum in ("yolda", "kabul_kismi"):
        return ASAMA_YOLDA
    return ASAMA_DEPODA if d else ASAMA_BEKLIYOR


def _asama_metni(asama: str, sevkiyat_durumu: Optional[str]) -> str:
    if asama == ASAMA_BEKLIYOR:
        return "Merkezde sırada — depo yönlendirmesi bekleniyor"
    if asama == ASAMA_DEPODA:
        sd = sevkiyat_durumu_coz(sevkiyat_durumu)
        if sd == "kismi_hazirlandi":
            return "Depoda kısmi hazırlandı"
        if sd in ("depoda_hazirlaniyor", "hazirlaniyor"):
            return "Depoda hazırlanıyor"
        return "Depo / sevkiyat işleniyor"
    if asama == ASAMA_YOLDA:
        return "Depodan çıktı — talep şubesinde kabul bekleniyor"
    if asama == ASAMA_TOPTANCI_BEKLIYOR:
        return "Toptancıya yönlendirildi — şube teslim alımı bekleniyor"
    if asama == ASAMA_UYUMSUZLUK:
        return "Kabul uyumsuzluğu — merkez müdahalesi gerekli"
    if asama == ASAMA_TAMAMLANDI:
        if sevkiyat_durumu_coz(sevkiyat_durumu) == "toptanciya_yonlendirildi":
            return "Toptancıdan teslim alındı (tamamlandı)"
        return "Teslim alındı (tamamlandı)"
    if asama == ASAMA_IPTAL:
        return "İptal edildi"
    if asama == ASAMA_GONDERILMEDI:
        return "Gönderilmedi olarak işaretlendi"
    return ASAMA_LABEL.get(asama, asama)


def _json_list(raw: Any) -> List[Any]:
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str):
        try:
            v = json.loads(raw)
            return v if isinstance(v, list) else []
        except Exception:
            return []
    return []


def _yolda_satirlari(cur: Any, talep_id: str) -> List[Dict[str, Any]]:
    cur.execute(
        """
        SELECT kalem_kodu, kalem_adi, sevk_adet, kabul_adet, kabul_ts, durum, sevk_ts
        FROM stok_yolda WHERE siparis_talep_id=%s
        ORDER BY kalem_adi NULLS LAST, kalem_kodu
        """,
        (talep_id,),
    )
    out = []
    for y in cur.fetchall() or []:
        out.append({
            "kalem_kodu": y.get("kalem_kodu"),
            "kalem_adi": y.get("kalem_adi"),
            "sevk_adet": int(y.get("sevk_adet") or 0),
            "kabul_adet": int(y.get("kabul_adet") or 0),
            "durum": y.get("durum"),
            "kabul_ts": str(y.get("kabul_ts") or ""),
            "sevk_ts": str(y.get("sevk_ts") or ""),
        })
    return out


def _yolda_toplu(cur: Any, talep_ids: List[str]) -> Dict[str, List[Dict[str, Any]]]:
    """N+1 yerine: tüm talep id'lerinin stok_yolda satırlarını TEK sorguda çekip
    talep_id → satır listesi haritası döner. _yolda_satirlari ile birebir aynı
    satır şekli (sadece toplu)."""
    out: Dict[str, List[Dict[str, Any]]] = {}
    ids = [t for t in {str(x) for x in talep_ids if x}]
    if not ids:
        return out
    cur.execute(
        """
        SELECT siparis_talep_id, kalem_kodu, kalem_adi, sevk_adet, kabul_adet, kabul_ts, durum, sevk_ts
        FROM stok_yolda WHERE siparis_talep_id = ANY(%s)
        ORDER BY kalem_adi NULLS LAST, kalem_kodu
        """,
        (ids,),
    )
    for y in cur.fetchall() or []:
        tid = str(y.get("siparis_talep_id") or "")
        out.setdefault(tid, []).append({
            "kalem_kodu": y.get("kalem_kodu"),
            "kalem_adi": y.get("kalem_adi"),
            "sevk_adet": int(y.get("sevk_adet") or 0),
            "kabul_adet": int(y.get("kabul_adet") or 0),
            "durum": y.get("durum"),
            "kabul_ts": str(y.get("kabul_ts") or ""),
            "sevk_ts": str(y.get("sevk_ts") or ""),
        })
    return out


def _satir_zenginlestir(cur: Any, row: Dict[str, Any],
                        yolda: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    tid = str(row.get("id") or "")
    kalemler = _json_list(row.get("kalemler"))
    kalem_durumlari = _json_list(row.get("kalem_durumlari"))
    if yolda is None:
        yolda = _yolda_satirlari(cur, tid)
    kabul_durum = _kabul_durum_ozet(yolda)
    sd = sevkiyat_durumu_coz(row.get("sevkiyat_durumu"), row.get("sevkiyat_durum"))
    asama = siparis_asama_hesapla(row.get("durum"), sd, kabul_durum)

    kalem_sayisi = sum(
        max(0, int((it or {}).get("adet") or 0))
        for it in kalemler
        if isinstance(it, dict)
    )

    return {
        "id": tid,
        "sube_id": row.get("sube_id"),
        "sube_adi": row.get("sube_adi"),
        "tarih": str(row.get("tarih") or ""),
        "olusturma": str(row.get("olusturma") or ""),
        "durum": row.get("durum"),
        "sevkiyat_durumu": sd,
        "asama": asama,
        "asama_metni": _asama_metni(asama, sd),
        "hedef_depo_sube_id": row.get("hedef_depo_sube_id"),
        "hedef_depo_sube_adi": row.get("hedef_depo_sube_adi"),
        "personel_ad": row.get("personel_ad"),
        "not_aciklama": row.get("not_aciklama"),
        "operasyon_yonlendirme_talimati": row.get("operasyon_yonlendirme_talimati"),
        "tahsis_ts": str(row.get("tahsis_ts") or ""),
        "tahsis_yapan_ad": row.get("tahsis_yapan_ad"),
        "tahsis_durum": row.get("tahsis_durum"),
        "sevkiyat_ts": str(row.get("sevkiyat_ts") or ""),
        "sevkiyat_personel_ad": row.get("sevkiyat_personel_ad"),
        "kabul_ts": str(row.get("kabul_ts") or ""),
        "kabul_personel_ad": row.get("kabul_personel_ad"),
        "kabul_personel_tel": row.get("kabul_personel_tel"),
        "sevk_personel_tel": row.get("sevk_personel_tel"),
        "kabul_durum": kabul_durum,
        "kalemler": kalemler,
        "kalem_durumlari": kalem_durumlari,
        "yolda": yolda,
        "kalem_sayisi": kalem_sayisi,
        "son_olay": row.get("son_olay"),
        "son_olay_ts": str(row.get("son_olay_ts") or ""),
    }


def siparis_kontrol_kulesi_yukle(
    cur: Any,
    *,
    gun: int = 30,
    asama: Optional[str] = None,
    sube_arama: Optional[str] = None,
    depo_sube_id: Optional[str] = None,
    talep_arama: Optional[str] = None,
    sadece_acik: bool = True,
    limit: int = 500,
) -> Dict[str, Any]:
    gun_i = max(1, min(365, int(gun or 30)))
    lim = max(1, min(1000, int(limit or 500)))

    kosullar = ["st.tarih >= CURRENT_DATE - (%s * INTERVAL '1 day')"]
    params: List[Any] = [gun_i]

    if sube_arama:
        like = f"%{sube_arama.strip()}%"
        kosullar.append("(LOWER(s.ad) LIKE LOWER(%s) OR st.sube_id = %s)")
        params.extend([like, sube_arama.strip()])

    if depo_sube_id:
        kosullar.append("COALESCE(st.hedef_depo_sube_id, st.sevkiyat_sube_id) = %s")
        params.append(depo_sube_id.strip())

    if talep_arama:
        t = talep_arama.strip()
        kosullar.append("(st.id::text ILIKE %s OR st.id::text = %s)")
        params.extend([f"%{t}%", t])

    if sadece_acik:
        kosullar.append("st.durum NOT IN ('teslim_edildi', 'iptal', 'gonderilmedi')")

    where = " AND ".join(kosullar)

    # Özet: dönem içi tüm eşleşen kayıtlar
    cur.execute(
        f"""
        SELECT st.id, st.durum, st.sevkiyat_durumu, st.sevkiyat_durum
        FROM siparis_talep st
        JOIN subeler s ON s.id = st.sube_id
        WHERE {where}
        """,
        tuple(params),
    )
    ozet_rows = [dict(r) for r in (cur.fetchall() or [])]
    ozet_yolda = _yolda_toplu(cur, [r.get("id") for r in ozet_rows])
    ozet: Dict[str, int] = {k: 0 for k in ASAMA_LABEL}
    for r in ozet_rows:
        yolda = ozet_yolda.get(str(r.get("id") or ""), [])
        kd = _kabul_durum_ozet(yolda)
        sd = sevkiyat_durumu_coz(r.get("sevkiyat_durumu"), r.get("sevkiyat_durum"))
        a = siparis_asama_hesapla(r.get("durum"), sd, kd)
        ozet[a] = ozet.get(a, 0) + 1

    cur.execute(
        f"""
        SELECT
            st.id, st.sube_id, s.ad AS sube_adi,
            st.tarih, st.durum, st.olusturma,
            st.personel_id, st.personel_ad,
            st.not_aciklama, st.kalemler, st.kalem_durumlari,
            st.tahsis_durum, st.tahsis_ts, st.tahsis_yapan_ad,
            st.sevkiyat_ts, st.sevkiyat_personel_ad,
            st.kabul_ts, st.kabul_personel_ad, st.kabul_durum AS kabul_durum_db,
            pk.telefon AS kabul_personel_tel,
            -- ══════════════════════════════════════════════════════════════
            -- 🔴 MÜKERRER SİPARİŞ KARTI — 2026-08-27, canlı kanıt
            -- ══════════════════════════════════════════════════════════════
            -- Buradan önce `LEFT JOIN personel ps ON ps.ad_soyad =
            -- st.sevkiyat_personel_ad` vardı: personel ADA göre bağlanıyordu.
            -- Sistemde çıkıp geri gelen personelin İKİ kaydı olur (kasıtlı;
            -- dönemler kişi kimliğiyle bağlanır, kayıtlar birleştirilmez).
            -- Aynı adda iki kayıt olunca JOIN sipariş satırını İKİZLİYORDU.
            -- Canlı kanıt: SILA AKBAY'ın 2 personel kaydı var (25 personel
            -- içinde tek ikiz ad); onun sevk ettiği 2 sipariş kule listesinde
            -- iki kez görünüyordu. Ekran "5 kabul uyumsuzluğu" derken aynı
            -- ucun kendi özeti "3" diyordu — çelişki TEK YANITIN içindeydi.
            -- Sahip için bedeli: olmayan iki işi kovalamak.
            -- ⚠️ Bağ tamamen KALDIRILDI, skaler alt sorguya çevrildi: alt sorgu
            -- LIMIT 1 ile TEK değer döner, satır sayısını asla değiştiremez.
            -- Aktif kayıt önce gelir (telefon en güncel olan kayıttan alınır).
            (SELECT p2.telefon FROM personel p2
              WHERE p2.ad_soyad = st.sevkiyat_personel_ad
              ORDER BY p2.aktif DESC NULLS LAST, p2.id
              LIMIT 1) AS sevk_personel_tel,
            st.sevkiyat_durumu, st.sevkiyat_durum,
            COALESCE(st.hedef_depo_sube_id, st.sevkiyat_sube_id) AS hedef_depo_sube_id,
            dep.ad AS hedef_depo_sube_adi,
            NULLIF(TRIM(st.operasyon_yonlendirme_talimati), '') AS operasyon_yonlendirme_talimati,
            (SELECT etiket FROM operasyon_defter
             WHERE ref_event_id=st.id ORDER BY olay_ts DESC LIMIT 1) AS son_olay,
            (SELECT olay_ts FROM operasyon_defter
             WHERE ref_event_id=st.id ORDER BY olay_ts DESC LIMIT 1) AS son_olay_ts
        FROM siparis_talep st
        JOIN subeler s ON s.id = st.sube_id
        LEFT JOIN subeler dep ON dep.id = COALESCE(st.hedef_depo_sube_id, st.sevkiyat_sube_id)
        LEFT JOIN personel pk ON pk.id = st.kabul_personel_id
        -- (ps bağı kaldırıldı — yukarıdaki skaler alt sorguya taşındı.
        --  pk KİMLİK üzerinden bağlanır, ikizlenme üretemez.)
        WHERE {where}
        ORDER BY
            CASE st.durum
                WHEN 'bekliyor' THEN 0
                WHEN 'hazirlaniyor' THEN 1
                WHEN 'gonderildi' THEN 2
                ELSE 3
            END,
            st.olusturma DESC NULLS LAST
        LIMIT %s
        """,
        tuple(params + [lim]),
    )

    detay_rows = [dict(r) for r in (cur.fetchall() or [])]
    detay_yolda = _yolda_toplu(cur, [r.get("id") for r in detay_rows])

    # Toptancıya dağıtılan kalemler (toplu) → kalan_kalemler hesabı için.
    # kalan = N1 (talep.kalemler) − dağıtılan (toptanci_siparis). Kısmi gönderimde
    # gönderilen kalemler tekrar listede ÇIKMASIN (çift gönderim önlenir).
    _detay_ids = [r.get("id") for r in detay_rows if r.get("id")]
    _dagitilan: Dict[str, Dict[str, int]] = {}
    # 🔀 KALEM HEDEFİ (sahip isteği, 2026-08-28): "listede o kalemin yanında
    # yönlendirilen toptancı ya da depo yazmalı". Dağıtım haritası bugüne dek
    # yalnız ADET topluyordu; TEDARİKÇİ ADI atılıyordu. Ekran "yollandı"
    # diyebiliyor ama "KİME" diyemiyordu. Ad + durum + zaman burada toplanır.
    _kalem_hedef: Dict[str, Dict[str, Dict[str, Any]]] = {}
    _dagitim_okunamadi = False
    if _detay_ids:
        try:
            cur.execute(
                "SELECT talep_id, kalemler, tedarikci_ad, durum, olusturma "
                "FROM toptanci_siparis "
                "WHERE talep_id = ANY(%s) AND durum <> 'iptal' "
                "ORDER BY olusturma ASC NULLS LAST",
                (_detay_ids,),
            )
            for _dr in cur.fetchall() or []:
                _d = dict(_dr)
                _dtid = str(_d.get("talep_id") or "")
                _dkl = _d.get("kalemler") or []
                if isinstance(_dkl, str):
                    try:
                        _dkl = json.loads(_dkl)
                    except Exception:
                        _dkl = []
                _m = _dagitilan.setdefault(_dtid, {})
                _h = _kalem_hedef.setdefault(_dtid, {})
                _ted = str(_d.get("tedarikci_ad") or "").strip() or "toptancı"
                for _dk in _dkl:
                    _dad = str((_dk or {}).get("urun_ad") or "").strip().lower()
                    if not _dad:
                        continue
                    _m[_dad] = _m.get(_dad, 0) + int((_dk or {}).get("adet") or 0)
                    # Aynı kalem iki tedarikçiye çıkmışsa adlar BİRLEŞTİRİLİR;
                    # biri yutulursa ekran eksik hedef gösterir.
                    _mevcut = _h.get(_dad)
                    if _mevcut and _mevcut.get("tip") == "toptanci":
                        _adlar = _mevcut.get("adlar") or []
                        if _ted not in _adlar:
                            _adlar.append(_ted)
                        _mevcut["adlar"] = _adlar
                        _mevcut["ad"] = " + ".join(_adlar)
                        _mevcut["adet"] = int(_mevcut.get("adet") or 0) + int((_dk or {}).get("adet") or 0)
                    else:
                        _h[_dad] = {
                            "tip": "toptanci",
                            "ad": _ted,
                            "adlar": [_ted],
                            "adet": int((_dk or {}).get("adet") or 0),
                            "durum": str(_d.get("durum") or "") or None,
                        }
        except Exception:
            _dagitilan = {}
            _kalem_hedef = {}
            # ⚠️ SESSİZ SAKİNLİK (Fable denetimi, 2026-08-28): bu sorgu
            # düşerse `kalan_kalemler` TÜM kalemlere döner — çift gönderim
            # freni ve hedef etiketleri sessizce kaybolur, ekran hiçbir şey
            # olmamış gibi görünür. Artık bayrakla dışarı çıkar: ekran
            # "fren okunamadı" diyebilir, kullanıcı körlemesine göndermez.
            _dagitim_okunamadi = True
            logger.warning(
                "kule: toptanci_siparis dagitim sorgusu dustu — "
                "cift gonderim freni bu yanitta CALISMIYOR"
            )

    satirlar: List[Dict[str, Any]] = []
    for r in detay_rows:
        z = _satir_zenginlestir(cur, r, yolda=detay_yolda.get(str(r.get("id") or ""), []))
        # kalan_kalemler: hiç gönderilmemiş ÜRÜNLER (kalem bazında coverage).
        # Bir ürün herhangi bir tedarikçiye gittiyse listede ÇIKMAZ (miktar farkı
        # değil; merkez miktarı override edebilir = nihai karar). Gönderilmemiş
        # ürünler tam miktarıyla kalır → split modalı sadece bunları gösterir.
        _disp = _dagitilan.get(str(r.get("id") or ""), {})
        # GÖNDERİLMİŞ ürün adları = toptancıya dağıtılan + DEPODAN sevk edilen
        # (stok_yolda, sevk_adet>0). Her iki yolla gönderilen ürün kalan listesinde
        # ÇIKMAZ → çift gönderim önlenir. (Önceden yalnız toptancı düşülüyordu;
        # depo sevki eklendi — kısmi depo sevkinde gönderilen kalem kuyrukta kalmıyor.)
        _gonderilmis: set = set(_disp.keys())
        _hedef_map = _kalem_hedef.get(str(r.get("id") or ""), {})
        _depo_ad = str(r.get("hedef_depo_sube_adi") or "").strip() or "depo"

        # ── 🏭 DEPOYA YÖNLENDİRİLMİŞ KALEMLER (kısmi bölme, 2026-08-29) ──────
        # Kısmi depo yönlendirmesinden sonra `kalem_durumlari` her kalemin
        # akıbetini taşıyor: seçilmeyenler `depo_disi: true`. Kule bunu
        # OKUMUYORDU, sonuç üç kusur:
        #   · depoya giden kalem hâlâ "kalan" görünüyor → modal onu TEKRAR
        #     gönderebiliyordu (toptancı tarafında kapattığımız çift gönderim
        #     freni depo tarafında yoktu)
        #   · kalemin yanında hedefi yazmıyordu (yalnız toptancı + stok_yolda
        #     okunuyordu; henüz sevk EDİLMEMİŞ depo ataması görünmüyordu)
        #   · yönlendirilmemiş kalemler hiçbir yerde sayılmıyordu
        # ⚠️ Yalnız hedef depo ATANMIŞSA anlamlı: `kalem_durumlari` başka
        #    akışlarca da (merkez tahsis) doldurulabiliyor.
        _depoya_gitmis: set = set()
        if str(r.get("hedef_depo_sube_id") or "").strip():
            _kd_raw = z.get("kalem_durumlari") or []
            if isinstance(_kd_raw, str):
                try:
                    _kd_raw = json.loads(_kd_raw)
                except Exception:
                    _kd_raw = []
            for _e in (_kd_raw if isinstance(_kd_raw, list) else []):
                if not isinstance(_e, dict) or _e.get("depo_disi"):
                    continue
                if str(_e.get("durum") or "") == "merkez_iptal":
                    continue
                _en = str(_e.get("urun_ad") or "").strip().lower()
                if _en:
                    _depoya_gitmis.add(_en)
                    # Hedef etiketi: henüz SEVK EDİLMEDİ, depoda hazırlanıyor.
                    if _en not in _hedef_map:
                        _hedef_map[_en] = {
                            "tip": "depo", "ad": _depo_ad,
                            "adet": int(_e.get("istenen_adet") or 0),
                            "durum": "hazirlaniyor",
                        }
        _gonderilmis |= _depoya_gitmis
        for _y in (z.get("yolda") or []):
            if int((_y or {}).get("sevk_adet") or 0) > 0:
                _yad = str((_y or {}).get("kalem_adi") or "").strip().lower()
                if _yad:
                    _gonderilmis.add(_yad)
                    # Depodan çıkmış kalem: hedefi DEPO. Toptancı kaydı varsa
                    # üzerine YAZILMAZ — kalem iki kanaldan da çıkmışsa ikisi de
                    # görünmeli (mükerrer gönderim ancak böyle fark edilir).
                    _v = _hedef_map.get(_yad)
                    if _v and _v.get("tip") == "toptanci":
                        _v["tip"] = "karma"
                        _v["ad"] = f"{_v.get('ad') or 'toptancı'} + {_depo_ad}"
                    elif not _v:
                        _hedef_map[_yad] = {
                            "tip": "depo", "ad": _depo_ad,
                            "adet": int((_y or {}).get("sevk_adet") or 0),
                            "durum": str((_y or {}).get("durum") or "") or None,
                        }
        # Her kaleme kendi hedefini yapıştır (ad-anahtarlı; kimlik çatlağı
        # riski kule genelinde zaten ad üzerinden — burada YENİ risk açılmıyor).
        z["kalemler"] = [
            (dict(_it, yonlendirme=_hedef_map.get(str(_it.get("urun_ad") or "").strip().lower()))
             if isinstance(_it, dict) else _it)
            for _it in (z.get("kalemler") or [])
        ]
        # ⛔ MERKEZ İPTALİ = KALAN DEĞİLDİR (Codex + Fable denetimi, 2026-08-28)
        # `kalem-iptal` ucu kalemi `iptal: true` işaretliyordu ama kalan hesabı
        # bu bayrağı GÖRMÜYORDU. Sonuç: merkezin "göndermiyorum" dediği kalem
        # yönlendirme modalında listeleniyor, üstelik VARSAYILAN SEÇİLİ
        # geliyordu — bir tık sonra toptancıya gerçekten yollanabiliyordu.
        # İptal edilen kalem listede DURUR (soluk), ama GÖNDERİLECEKLER
        # arasında olmaz.
        _kalan: List[Dict[str, Any]] = [
            dict(_it)
            for _it in (z.get("kalemler") or [])
            if isinstance(_it, dict)
            and not _it.get("iptal")
            and (not _gonderilmis
                 or str(_it.get("urun_ad") or "").strip().lower() not in _gonderilmis)
        ]
        z["kalan_kalemler"] = _kalan
        # İptal edilen kalem sayısı AYRICA raporlanır: liste sessizce kısalırsa
        # sahip siparişin küçüldüğünü sanır (sessiz eleme yasak).
        z["iptal_kalem_adlari"] = [
            str((_it or {}).get("urun_ad") or "")
            for _it in (z.get("kalemler") or [])
            if isinstance(_it, dict) and _it.get("iptal")
        ]

        # ── KISMİ TOPTANCI etiketi: bazı kalemler toptancıya yollandı AMA hepsi değil.
        # Sipariş takip aksi halde yanıltıcı "bekliyor" gösterir (yollanan kalem görünmez).
        _disp_set = set(_disp.keys())
        z["dagitilan_kalem_adlari"] = [
            str((_it or {}).get("urun_ad") or "")
            for _it in (z.get("kalemler") or [])
            if isinstance(_it, dict)
            and str((_it or {}).get("urun_ad") or "").strip().lower() in _disp_set
        ]
        z["kismi_toptanci"] = bool(_disp_set) and len(z["kalan_kalemler"]) > 0
        # ── SAYILAR İPTALİ AYIRIR ─────────────────────────────────────────
        # `kalem_sayisi` (toplam adet) ve kalem çeşidi bugüne dek iptal edilen
        # kalemi de sayıyordu: iptal sonrası ekran "31 kalem devam ediyor"
        # derken kuyruk hâlâ "32 kalem" diyordu — aynı ekranda iki gerçek.
        # ⚠️ Ham sayılar DEĞİŞTİRİLMEZ (geçmiş kayıt bozulmaz); aktif sayılar
        #    AYRI alanlarda verilir, ekran hangisini kullanacağını seçer.
        _aktif = [
            _it for _it in (z.get("kalemler") or [])
            if isinstance(_it, dict) and not _it.get("iptal")
        ]
        z["aktif_kalem_cesidi"] = len(_aktif)
        z["aktif_kalem_adedi"] = sum(
            int((_it or {}).get("adet") or 0) for _it in _aktif
        )
        z["iptal_kalem_sayisi"] = len(z["iptal_kalem_adlari"])
        # 🧭 HENÜZ HİÇBİR YERE YÖNLENDİRİLMEMİŞ kalemler (2026-08-29)
        # Sahip: "siparişin sadece yönlendirdiklerim giderken gelen sipariş
        # HÂLÂ AÇIKTA KALMALI." Kısmi yönlendirmeden sonra talebin `asama`sı
        # 'depoda' oluyor ve sipariş merkez kuyruğundan düşüyordu — kalan
        # kalemler görünmez kalıyordu (sessiz eleme). Bu sayı kuyruğun
        # "iş bitmedi" demesini sağlar.
        z["yonlendirilmemis_kalem_sayisi"] = len(z["kalan_kalemler"])
        z["yonlendirilmemis_kalem_adlari"] = [
            str((_it or {}).get("urun_ad") or "") for _it in z["kalan_kalemler"]
        ]
        # Fren okunamadıysa satır bunu TAŞIR — ekran körlemesine göndermesin.
        if _dagitim_okunamadi:
            z["dagitim_okunamadi"] = True

        # ── SELF-HEAL: tüm ürünleri dağıtılmış ama hâlâ 'bekliyor' kalmış talep
        # (eski hatalı/miktar-bazlı gönderimden kalma) → 'gonderildi'ye çek. Böylece
        # kuyrukta hayalet "0 kalem" sipariş asılı kalmaz. Sadece dağıtım VARSA ve
        # kalan YOKSA çalışır → açık (gerçekten kısmi) talepleri etkilemez.
        if _disp and not z["kalan_kalemler"] and str(z.get("durum") or "") == "bekliyor":
            try:
                cur.execute(
                    """
                    UPDATE siparis_talep
                    SET durum='gonderildi',
                        sevkiyat_durumu='toptanciya_yonlendirildi',
                        sevkiyat_durum='toptanciya_yonlendirildi',
                        sevkiyat_ts=COALESCE(sevkiyat_ts, NOW())
                    WHERE id=%s AND durum='bekliyor'
                    """,
                    (str(r.get("id") or ""),),
                )
                z["durum"] = "gonderildi"
                z["sevkiyat_durumu"] = "toptanciya_yonlendirildi"
                z["asama"] = siparis_asama_hesapla(
                    "gonderildi", "toptanciya_yonlendirildi", z.get("kabul_durum")
                )
                z["asama_metni"] = _asama_metni(z["asama"], "toptanciya_yonlendirildi")
            except Exception:
                # Sessiz kalmaz: self-heal bir talebin AŞAMASINI değiştiriyor.
                # Düşerse talep kuyrukta "hayalet" kalır ve kimse nedenini
                # bilmez. (2026-08-29)
                logger.warning(
                    "kule self-heal basarisiz — talep %s 'bekliyor' kaldi",
                    str(r.get("id") or "?"),
                )

        if asama and z["asama"] != asama:
            continue
        satirlar.append(z)

    acik_toplam = sum(ozet.get(a, 0) for a in ACIK_ASAMALAR)

    return {
        "gun": gun_i,
        "asama_filtre": asama,
        "sadece_acik": sadece_acik,
        "toplam": len(satirlar),
        "acik_toplam": acik_toplam,
        "ozet": ozet,
        "satirlar": satirlar,
    }


def siparis_urun_gecmis(
    cur: Any,
    *,
    urun_arama: str,
    gun: int = 90,
    sube_id: Optional[str] = None,
    limit: int = 80,
) -> Dict[str, Any]:
    q = (urun_arama or "").strip()
    if len(q) < 2:
        return {"urun_arama": q, "satirlar": [], "toplam": 0, "gun": gun}

    gun_i = max(1, min(730, int(gun or 90)))
    lim = max(1, min(300, int(limit or 80)))
    like = f"%{q.lower()}%"

    kosul = """
        st.tarih >= CURRENT_DATE - (%s * INTERVAL '1 day')
        AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(st.kalemler, '[]'::jsonb)) elem
            WHERE LOWER(COALESCE(elem->>'urun_ad', elem->>'kalem_adi', '')) LIKE %s
               OR LOWER(COALESCE(elem->>'kalem_kodu', elem->>'urun_id', '')) LIKE %s
               OR elem->>'urun_id' = %s
        )
    """
    params: List[Any] = [gun_i, like, like, q]

    if sube_id:
        kosul += " AND st.sube_id = %s"
        params.append(sube_id.strip())

    cur.execute(
        f"""
        SELECT
            st.id, st.sube_id, s.ad AS sube_adi,
            st.tarih, st.durum, st.olusturma, st.kalemler,
            st.sevkiyat_durumu, st.sevkiyat_durum,
            COALESCE(st.hedef_depo_sube_id, st.sevkiyat_sube_id) AS hedef_depo_sube_id,
            dep.ad AS hedef_depo_sube_adi
        FROM siparis_talep st
        JOIN subeler s ON s.id = st.sube_id
        LEFT JOIN subeler dep ON dep.id = COALESCE(st.hedef_depo_sube_id, st.sevkiyat_sube_id)
        WHERE {kosul}
        ORDER BY st.tarih DESC, st.olusturma DESC
        LIMIT %s
        """,
        tuple(params + [lim]),
    )

    gecmis_rows = [dict(r) for r in (cur.fetchall() or [])]
    gecmis_yolda = _yolda_toplu(cur, [r.get("id") for r in gecmis_rows])
    satirlar = []
    for row in gecmis_rows:
        kalemler = _json_list(row.get("kalemler"))
        eslesen = []
        for it in kalemler:
            if not isinstance(it, dict):
                continue
            ad = str(it.get("urun_ad") or it.get("kalem_adi") or "").lower()
            kod = str(it.get("kalem_kodu") or it.get("urun_id") or "").lower()
            if q.lower() in ad or q.lower() in kod or str(it.get("urun_id") or "") == q:
                eslesen.append({
                    "urun_ad": it.get("urun_ad") or it.get("kalem_adi"),
                    "kalem_kodu": it.get("kalem_kodu") or it.get("urun_id"),
                    "adet": int(it.get("adet") or 0),
                })
        if not eslesen:
            continue
        yolda = gecmis_yolda.get(str(row.get("id") or ""), [])
        kabul_durum = _kabul_durum_ozet(yolda)
        sd = sevkiyat_durumu_coz(row.get("sevkiyat_durumu"), row.get("sevkiyat_durum"))
        asama = siparis_asama_hesapla(row.get("durum"), sd, kabul_durum)
        satirlar.append({
            "talep_id": row.get("id"),
            "sube_id": row.get("sube_id"),
            "sube_adi": row.get("sube_adi"),
            "tarih": str(row.get("tarih") or ""),
            "olusturma": str(row.get("olusturma") or ""),
            "durum": row.get("durum"),
            "asama": asama,
            "asama_metni": _asama_metni(asama, sd),
            "hedef_depo_sube_adi": row.get("hedef_depo_sube_adi"),
            "eslesen_kalemler": eslesen,
        })

    return {
        "urun_arama": q,
        "gun": gun_i,
        "toplam": len(satirlar),
        "satirlar": satirlar,
    }


# ════════════════════════════════════════════════════════════════════════════
#  KAYIT KATMANI — SİPARİŞ DAVRANIŞ PROFİLİ (Katman 3, türetilmiş)
# ────────────────────────────────────────────────────────────────────────────
#  Tedarik zinciri + sipariş-davranışı denetiminin en düşük riskli İLK TAŞI.
#  Saf veri toplama (öğrenme defteri deseni): şube başına sipariş SIKLIĞINI
#  günlük kaydeder. Hipotez/eşik/suçlama YOK — sadece birikim. Prediction Brain
#  ve ileride "deposunda olduğu halde sürekli istemesi" denetimini besler.
#  Ürün eşleştirme labirentine (kalem_kodu) GİRMEZ — şube seviyesi sıklık.
# ════════════════════════════════════════════════════════════════════════════

def _sdg_scalar(cur: Any, sql: str, params: tuple) -> int:
    """Tek savepoint'li skaler sorgu — hata olursa 0 döner (ana transaction zehirlenmez)."""
    try:
        cur.execute("SAVEPOINT sp_sdg_q")
        cur.execute(sql, params)
        r = cur.fetchone()
        cur.execute("RELEASE SAVEPOINT sp_sdg_q")
        if not r:
            return 0
        v = dict(r) if not isinstance(r, dict) else r
        return int(list(v.values())[0] or 0)
    except Exception:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_sdg_q")
            cur.execute("RELEASE SAVEPOINT sp_sdg_q")
        except Exception:
            pass
        return 0


def siparis_davranis_gunluk_gozlemle(cur: Any, pencere_gun: int = 7) -> Dict[str, Any]:
    """Her aktif şube için son `pencere_gun` sipariş davranışını günlük profile yazar.
    SALT OKUMA (mevcut tablolar) + sadece sube_siparis_davranis_gunluk'a upsert.
    Idempotent: UNIQUE(sube_id, tarih) → aynı gün tekrar çalışırsa günceller.

    Tüketim dörtgeni (kural #12) ŞUBE SEVİYESİ bağlamı detay_json'a eklenir —
    saf gözlem, hipotez/eşik/skor YOK, isme dokunmaz (kural #15):
      - kullanim_olay: URUN_AC olay sayısı (depodan açılan)
      - sayim_anomali: stok anomalisi olan (tarih,boyut) sayısı
      (satış legi sonraki taşta — temiz ciro kaynağı netleşince)
    """
    pencere = max(1, min(90, int(pencere_gun or 7)))
    try:
        cur.execute("SELECT id::text AS id, ad FROM subeler WHERE aktif = TRUE")
        subeler = [dict(r) for r in (cur.fetchall() or [])]
    except Exception:
        return {"yazilan": 0, "pencere_gun": pencere}

    yazilan = 0
    for s in subeler:
        sid = str(s.get("id") or "")
        if not sid:
            continue

        _say = _sdg_scalar(
            cur,
            """
            SELECT COUNT(*) FROM siparis_talep
            WHERE sube_id = %s AND tarih >= CURRENT_DATE - (%s * INTERVAL '1 day')
              AND COALESCE(durum, '') <> 'iptal'
            """,
            (sid, pencere),
        )
        _gun = _sdg_scalar(
            cur,
            """
            SELECT COUNT(DISTINCT tarih) FROM siparis_talep
            WHERE sube_id = %s AND tarih >= CURRENT_DATE - (%s * INTERVAL '1 day')
              AND COALESCE(durum, '') <> 'iptal'
            """,
            (sid, pencere),
        )
        # ── Tüketim dörtgeni — şube seviyesi bağlam (saf gözlem) ──
        _kullanim = _sdg_scalar(
            cur,
            """
            SELECT COUNT(*) FROM operasyon_defter
            WHERE sube_id = %s AND etiket = 'URUN_AC'
              AND tarih >= CURRENT_DATE - (%s * INTERVAL '1 day')
            """,
            (sid, pencere),
        )
        _sayim = _sdg_scalar(
            cur,
            """
            SELECT COUNT(DISTINCT (tarih, boyut)) FROM truth_motor_kararlar
            WHERE sube_id = %s AND tarih >= CURRENT_DATE - (%s * INTERVAL '1 day')
              AND boyut <> 'kasa'
              AND tani NOT IN ('UYUMLU', 'YETERSIZ_VERI', 'NORMAL')
            """,
            (sid, pencere),
        )
        detay = {
            "kullanim_olay": _kullanim,
            "sayim_anomali": _sayim,
            "pencere_gun": pencere,
        }

        try:
            cur.execute("SAVEPOINT sp_sdg")
            cur.execute(
                """
                INSERT INTO sube_siparis_davranis_gunluk
                    (id, sube_id, tarih, pencere_gun, siparis_sayisi, aktif_gun, detay_json)
                VALUES (%s, %s, CURRENT_DATE, %s, %s, %s, %s::jsonb)
                ON CONFLICT (sube_id, tarih) DO UPDATE SET
                    pencere_gun    = EXCLUDED.pencere_gun,
                    siparis_sayisi = EXCLUDED.siparis_sayisi,
                    aktif_gun      = EXCLUDED.aktif_gun,
                    detay_json     = EXCLUDED.detay_json,
                    olusturma      = NOW()
                """,
                (str(uuid.uuid4()), sid, pencere, _say, _gun,
                 json.dumps(detay, ensure_ascii=False)),
            )
            cur.execute("RELEASE SAVEPOINT sp_sdg")
            yazilan += 1
        except Exception:
            try:
                cur.execute("ROLLBACK TO SAVEPOINT sp_sdg")
                cur.execute("RELEASE SAVEPOINT sp_sdg")
            except Exception:
                pass
    return {"yazilan": yazilan, "pencere_gun": pencere}


# ════════════════════════════════════════════════════════════════════════════
#  P3 FAZ 1 — ÇİFT-KOLON TUTARLILIK DUYUSU (Akıllı Denetim entegrasyonu)
# ────────────────────────────────────────────────────────────────────────────
#  GPT+Opus sentezi (2026-06-15): sevkiyat_durumu (yeni) tek gerçek kaynak mı?
#  Bunu KANITLAMADAN migration'a başlamak = sessiz veri bozulması riski.
#  Bu fonksiyon SALT OKUMA ile "yeni kolondan beklenen legacy" ile gerçek eski
#  kolonu karşılaştırır (writer'ın AYNI eşlemesi: sevkiyat_durumu_guncelle_params,
#  kayıplı map yüzünden yanlış-pozitif olmaz). Bulgular öğrenme defterine
#  (denetim_hipotez_gozlem) per-şube gözlem olarak yazılır — yani bu, Audit
#  Brain'in yeni bir "iç veri-bütünlüğü duyusu". Hedef: haftalarca 0 tutarsızlık,
#  sonra P3 Faz 2 (okumaları yeni kolona taşı) güvenle başlar.
# ════════════════════════════════════════════════════════════════════════════

def sevkiyat_kolon_tutarsizlik_tara(cur: Any, gun: int = 120) -> Dict[str, Any]:
    """Çift-kolon (sevkiyat_durumu vs sevkiyat_durum) tutarlılığını ölçer. SALT OKUMA
    + öğrenme defterine gözlem yazar (davranış/veri değişmez).

    Returns: {taranan, uyumsuz, bos_eski, sube_bazli, ornekler}
    """
    gun_i = max(1, min(730, int(gun or 120)))
    cur.execute(
        """
        SELECT st.id, st.sube_id, COALESCE(s.ad, st.sube_id::text) AS sube_adi,
               st.durum, st.sevkiyat_durumu, st.sevkiyat_durum
        FROM siparis_talep st
        JOIN subeler s ON s.id = st.sube_id
        WHERE st.tarih >= CURRENT_DATE - (%s * INTERVAL '1 day')
        """,
        (gun_i,),
    )
    rows = cur.fetchall() or []

    # sube_id -> {taranan, uyumsuz, bos_eski}
    sube_bazli: Dict[str, Dict[str, Any]] = {}
    ornekler: List[Dict[str, Any]] = []
    taranan = uyumsuz = bos_eski = 0

    for r in rows:
        d = dict(r)
        sid = str(d.get("sube_id") or "")
        yeni = (str(d.get("sevkiyat_durumu") or "")).strip()
        eski = (str(d.get("sevkiyat_durum") or "")).strip()
        sb = sube_bazli.setdefault(sid, {
            "sube_adi": d.get("sube_adi"), "taranan": 0, "uyumsuz": 0, "bos_eski": 0,
        })

        # Yeni kolon boşsa "yeni = tek gerçek kaynak" hipotezi test edilemez — atla
        if not yeni:
            continue
        taranan += 1
        sb["taranan"] += 1

        # canonical(yeni) → writer'ın üreteceği beklenen legacy
        canonical = sevkiyat_durumu_coz(yeni, None)
        _, beklenen_eski = sevkiyat_durumu_guncelle_params(canonical)

        if not eski:
            bos_eski += 1
            sb["bos_eski"] += 1
            continue
        if eski != beklenen_eski:
            uyumsuz += 1
            sb["uyumsuz"] += 1
            if len(ornekler) < 20:
                ornekler.append({
                    "talep_id": str(d.get("id") or ""),
                    "sube_adi": d.get("sube_adi"),
                    "yeni": yeni, "eski": eski,
                    "beklenen_eski": beklenen_eski, "durum": d.get("durum"),
                })

    # ── Öğrenme defterine per-şube gözlem yaz (Audit Brain duyusu) ──────────
    try:
        import truth_motor as _tm
        from datetime import date as _date
        _bugun = _date.today().isoformat()
        for sid, sb in sube_bazli.items():
            if sb["taranan"] <= 0:
                continue
            _tm.hipotez_gozlem_kaydet(
                cur, "sevkiyat_cift_kolon", sid, _bugun,
                kosul_var=(sb["uyumsuz"] > 0),
                sonuc_anomali=(sb["uyumsuz"] > 0),
                kosul_siddet=float(sb["uyumsuz"]),
                detay={
                    "taranan": sb["taranan"],
                    "uyumsuz": sb["uyumsuz"],
                    "bos_eski": sb["bos_eski"],
                },
            )
    except Exception:
        pass  # gözlem yazımı başarısız olsa da tarama sonucu döner

    return {
        "taranan": taranan,
        "uyumsuz": uyumsuz,
        "bos_eski": bos_eski,
        "sube_bazli": sube_bazli,
        "ornekler": ornekler,
    }
