"""
FATURA İSTEK MOTORU (BM-4 + BM-4A) — İZOLE.

Sahip talebi (2026-07-09): "Tedarikçiye ÖDEME YAPILMIŞ ama FATURA GELMEMİŞSE
(vadeli alım / anlık gider / kart harcaması / teslim al) ≥5000 TL'de FATURA İSTE
butonu; tedarikçinin numarası yoksa numara isteyerek — Evvel mekanizmalarıyla
ÇAKIŞTIRMADAN."

Tasarım (feedback_duyu_izole_toplayici_kurali + kasa izi felsefesi):
- İZOLE tablo fatura_istek; (kaynak_tip, kaynak_id) UNIQUE → aday idempotent.
- ADAY MOTORU (gece + elle /tara): son PENCERE günün ≥ eşik ödemeleri üç kanaldan
  (kart HARCAMA şahsi-hariç / anlık gider / ödenmiş vadeli alım) toplanır; K2-D
  kuralıyla (tutar ±%2/±5 TL, tarih ±5 gün) fatura arşivine EŞLEŞMEYENLER aday olur.
- ÇAKIŞMA YOK: teslim-al kanalı belge_talep motorunun işidir — burada kayıt
  YARATILMAZ, yalnız bekleyen sayısı gösterilir (yönlendirme). Türetilmiş kayıtlar
  (kaynak_id dolu kart/anlık satırları) atlanır → aynı ödeme iki kanaldan aday olmaz.
- OTOMATİK KAPANIŞ: açık istek için sonradan eşleşen fatura bulunursa gece
  kendiliğinden 'fatura_geldi' olur — iz varsa kapanır, elle işaretleme gerekmez.
- wa.me TEK DOKUNUŞ (kotasız): tedarikçi bazlı BİRLEŞİK mesaj hazırlanır; numara
  yoksa UI sorar, birebir ad eşleşmesi varsa tedarikciler kartına da işlenir
  (kanonik kimlik kaynakta; kart ekstresi serbest metinse tedarikci KİRLETİLMEZ).
- ÖNERİ-ONLY: hiçbir ödeme/kayıt akışını etkilemez; çökse sistem yaşar.

Kaldırmak: main.py'den router + gece kancasını çıkar. Tablo zararsız kalır.
"""
from __future__ import annotations

import logging
import os
from datetime import date
from typing import List, Optional
from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/fatura-istek", tags=["fatura-istek"])

ESIK = float(os.getenv("FATURA_ISTEK_ESIK", "5000"))
PENCERE_GUN = 60
# KDV riski = kaba tahmin (%20 varsayım, tutar KDV dahil kabul edilir) — "≈" ile sunulur
_KDV_ORAN = 0.20
# FATURA ÜRETMEYEN gider türleri (canlı test dersi: 'geçiken araç kredisi' aday
# olmuştu) — kredi taksiti/maaş/vergi/SGK için tedarikçiden fatura İSTENMEZ;
# bunlar aday motoru gürültüsüdür (alert-yorgunluğu ilkesi). Liste bilinçli DAR:
# muhasebe/kira gibi belge üretebilen türler filtrelenmez.
_FATURASIZ_TUR = ("kredi", "maas", "maaş", "vergi", "sgk", "stopaj",
                  "faiz", "personel avans", "borç taksit", "borc taksit")


def _faturasiz_tur_mu(metin: str) -> bool:
    # TR-katlama ŞART (2026-07-15 vakası: 'HESAP FAİZİ'.lower() noktalı-i üretiyor,
    # 'faiz' kalıbı ıskalanıyordu — banka faizi 'fatura bekliyor' görünüyordu)
    try:
        from fatura_api import _cari_katla
        m = _cari_katla(metin)
        kaliplar = [_cari_katla(t) for t in _FATURASIZ_TUR]
    except Exception:  # noqa: BLE001
        m = (metin or "").lower()
        kaliplar = list(_FATURASIZ_TUR)
    return any(t in m for t in kaliplar)


def _ensure(cur) -> None:
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS fatura_istek (
            id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            kaynak_tip    TEXT NOT NULL,      -- kart | anlik_gider | vadeli_alim
            kaynak_id     TEXT NOT NULL,
            tarih         DATE,
            tutar         NUMERIC(14,2),
            aciklama      TEXT,
            kanal_detay   TEXT,               -- kart adı / kategori vb (snapshot)
            tedarikci_ad  TEXT,
            tedarikci_tel TEXT,
            durum         TEXT NOT NULL DEFAULT 'aday',
                          -- aday | istek_gonderildi | fatura_geldi | kapandi
            mesaj_sayisi  INT NOT NULL DEFAULT 0,
            son_mesaj_ts  TIMESTAMPTZ,
            eslesen_fatura_id TEXT,
            kapanis_aciklama  TEXT,
            kapanma_ts    TIMESTAMPTZ,
            olusturma     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (kaynak_tip, kaynak_id)
        )
        """
    )
    cur.execute("CREATE INDEX IF NOT EXISTS idx_fatura_istek_durum "
                "ON fatura_istek (durum, tarih DESC)")
    # KURUMSAL sınıfı (2026-07-14, MEPAŞ vakası): tedarikci=wa.me kovala,
    # kurumsal=kurum sitesi/GİB e-arşivden İNDİR (WhatsApp saçma olur)
    cur.execute("ALTER TABLE fatura_istek ADD COLUMN IF NOT EXISTS "
                "tur TEXT NOT NULL DEFAULT 'tedarikci'")


def _tel_norm(tel: str) -> str:
    """TR numarayı wa.me biçimine (90xxxxxxxxxx) çevirir; geçersizse ''."""
    d = "".join(ch for ch in str(tel or "") if ch.isdigit())
    if d.startswith("0"):
        d = d[1:]
    if d and not d.startswith("90"):
        d = "90" + d
    return d if len(d) == 12 else ""


def _wa_mesaj(tedarikci: str, satirlar: List[dict]) -> str:
    """Tedarikçi bazlı BİRLEŞİK nazik mesaj (BM-4A: tek mesajda tüm açık ödemeler)."""
    govde = "\n".join(
        f"• {s.get('tarih')} tarihli {float(s.get('tutar') or 0):,.0f} TL"
        for s in satirlar[:8]
    )
    return (f"Merhaba 🌷 TULİPİ Coffee.\nAşağıdaki ödememizin/ödemelerimizin "
            f"e-arşiv faturasını rica ederiz:\n{govde}\nTeşekkür ederiz 🙏")


def _k2d_eslesti(tutar: float, tarih: str, faturalar: List[dict],
                 kullanildi: set, gun_tol: int = 5) -> Optional[str]:
    """K2-D kuralı: tutar ±max(5, %2), tarih ±gun_tol; fatura tek kullanım.
    Eşleşen fatura id'si döner (yoksa None)."""
    for f in faturalar:
        if f["id"] in kullanildi or float(f.get("tutar") or 0) <= 0:
            continue
        if abs(float(f["tutar"]) - tutar) > max(5.0, tutar * 0.02):
            continue
        try:
            gf = abs((date.fromisoformat(str(tarih)[:10])
                      - date.fromisoformat(str(f["tarih"])[:10])).days)
        except Exception:  # noqa: BLE001
            continue
        if gf <= gun_tol:
            kullanildi.add(f["id"])
            return f["id"]
    return None


def gece_fatura_istek_tara() -> dict:
    """GECE + elle tetik. Hata-yutar: motor çökse gece zinciri yaşar."""
    try:
        return _tara()
    except Exception as e:  # noqa: BLE001
        logger.warning("fatura_istek tarama hatasi (yutuldu): %s", str(e)[:200])
        return {"ok": False, "hata": str(e)[:200]}


def _tara() -> dict:
    yeni, oto_kapanan = [], 0
    with db() as (conn, cur):
        _ensure(cur)
        # 1) ÖDEME ADAYLARI — üç kanal; türetilmiş satırlar (kaynak_id dolu) atlanır
        odemeler: List[dict] = []
        cur.execute(
            """SELECT h.id, h.tarih::text AS tarih, h.tutar::float AS tutar,
                      LEFT(COALESCE(h.aciklama,''),80) AS aciklama, k.kart_adi AS detay
               FROM kart_hareketleri h JOIN kartlar k ON k.id = h.kart_id
               WHERE h.islem_turu='HARCAMA' AND h.durum='aktif'
                 AND COALESCE(h.harcama_tipi,'belirsiz') <> 'sahsi'
                 AND h.kaynak_id IS NULL
                 AND h.tutar >= %s AND h.tarih >= CURRENT_DATE - %s""",
            (ESIK, PENCERE_GUN))
        for r in cur.fetchall() or []:
            d = dict(r)
            d["kaynak_tip"] = "kart"
            odemeler.append(d)
        cur.execute(
            """SELECT id, tarih::text AS tarih, tutar::float AS tutar,
                      LEFT(COALESCE(tedarikci,'') || ' ' || COALESCE(aciklama,''),80) AS aciklama,
                      kategori AS detay
               FROM anlik_giderler
               WHERE durum='aktif' AND kaynak_id IS NULL
                 AND tutar >= %s AND tarih >= CURRENT_DATE - %s""",
            (ESIK, PENCERE_GUN))
        for r in cur.fetchall() or []:
            d = dict(r)
            d["kaynak_tip"] = "anlik_gider"
            odemeler.append(d)
        cur.execute(
            """SELECT id, vade_tarihi::text AS tarih, tutar::float AS tutar,
                      LEFT(COALESCE(aciklama,''),80) AS aciklama, tedarikci AS detay
               FROM vadeli_alimlar
               WHERE durum='odendi' AND tutar >= %s
                 AND vade_tarihi >= CURRENT_DATE - %s""",
            (ESIK, PENCERE_GUN))
        for r in cur.fetchall() or []:
            d = dict(r)
            d["kaynak_tip"] = "vadeli_alim"
            odemeler.append(d)

        # 2) FATURA ARŞİVİ penceresi (K2-D eşleştirme havuzu)
        cur.execute(
            """SELECT id, COALESCE(fatura_tarih, olusturma::date)::text AS tarih,
                      COALESCE(toplam_tutar,0)::float AS tutar, tedarikci_ad
               FROM tedarikci_fatura
               WHERE COALESCE(durum,'') <> 'kopya'
                 AND COALESCE(fatura_tarih, olusturma::date)
                     >= CURRENT_DATE - %s""", (PENCERE_GUN + 15,))
        faturalar = [dict(r) for r in cur.fetchall() or []]

        # 3) TEDARİKÇİ REHBERİ (ad→tel; ad eşleşmesi için)
        cur.execute("SELECT ad, telefon FROM tedarikciler WHERE aktif = TRUE")
        rehber = [(str(r["ad"] or "").strip(), str(r["telefon"] or "").strip())
                  for r in cur.fetchall() or []]

        def _tel_bul(metin: str) -> tuple:
            """Ödeme açıklamasında geçen tedarikçi adı → (kanonik ad, tel)."""
            m = (metin or "").lower()
            for ad, tel in rehber:
                if len(ad) >= 4 and ad.lower() in m:
                    return ad, tel
            return None, None

        # 4) YENİ ADAYLAR — eşleşmeyen ödemeler (fatura tek kullanım, greedy)
        kullanildi: set = set()
        for o in sorted(odemeler, key=lambda x: -float(x["tutar"])):
            _metin_o = f"{o.get('aciklama') or ''} {o.get('detay') or ''}"
            if _faturasiz_tur_mu(_metin_o):
                continue  # kredi/maaş/vergi türü — fatura istenecek ödeme değil
            # 🚫 BELGE BEKLENMEZ (sabit kalıp + sahibin öğrettiği istisnalar):
            # personele elden para / prim / öğrenilen kalıp — aday OLMAZ
            try:
                from fatura_api import belge_beklenmez_mi, _belge_istisna_kaliplari
                if belge_beklenmez_mi(_metin_o, _belge_istisna_kaliplari(cur)):
                    continue
            except Exception:  # noqa: BLE001
                pass
            # Denetim P2-7: vadeli alımda elimizdeki tarih VADE tarihi — fatura
            # tipik 30-60 gün ÖNCE kesilir; ±5 gün penceresi hiç tutmuyordu ve
            # faturası arşivde olan ödenmiş vadeli KALICI aday oluyordu.
            _tol = 90 if o["kaynak_tip"] == "vadeli_alim" else 5
            fid = _k2d_eslesti(float(o["tutar"]), o["tarih"], faturalar,
                               kullanildi, gun_tol=_tol)
            if fid:
                # Canlı ders (2026-07-18, APS/Redbull): fatura sonradan havuza
                # girince bu adım eşleşip faturayı 'kullanildi' yapıyor ama daha
                # önce doğmuş AÇIK aday öylece kalıyordu (kapanış bölümü faturayı
                # bir daha göremiyordu). Eşleşme bulunduysa açık adayı da KAPAT.
                cur.execute(
                    """UPDATE fatura_istek
                       SET durum='fatura_geldi', eslesen_fatura_id=%s,
                           kapanma_ts=NOW()
                       WHERE kaynak_tip=%s AND kaynak_id=%s
                         AND durum IN ('aday','istek_gonderildi')""",
                    (fid, o["kaynak_tip"], str(o["id"])))
                if cur.rowcount:
                    oto_kapanan += 1
                continue
            metin = f"{o.get('aciklama') or ''} {o.get('detay') or ''}"
            ted_ad, ted_tel = _tel_bul(metin)
            if o["kaynak_tip"] == "vadeli_alim" and (o.get("detay") or "").strip():
                ted_ad = ted_ad or str(o["detay"]).strip()
            # MEPAŞ vb kurumsal otomatik ödeme → tur='kurumsal' (e-arşivden indirilir)
            try:
                from fatura_api import kurumsal_fatura_mu
                tur = "kurumsal" if kurumsal_fatura_mu(metin) else "tedarikci"
            except Exception:  # noqa: BLE001
                tur = "tedarikci"
            cur.execute(
                """INSERT INTO fatura_istek
                       (kaynak_tip, kaynak_id, tarih, tutar, aciklama, kanal_detay,
                        tedarikci_ad, tedarikci_tel, tur)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (kaynak_tip, kaynak_id) DO NOTHING
                   RETURNING id""",
                (o["kaynak_tip"], str(o["id"]), o["tarih"], o["tutar"],
                 o.get("aciklama"), o.get("detay"), ted_ad, ted_tel, tur))
            if cur.fetchone():
                yeni.append({"kaynak": o["kaynak_tip"], "tarih": o["tarih"],
                             "tutar": float(o["tutar"])})

        # 4b) GÜRÜLTÜ TEMİZLİĞİ — daha önce aday olmuş fatura-üretmeyen türler
        #     silinir (yalnız MAKİNE ürettiği 'aday' durumu; insan dokunmuşsa kalır)
        try:
            from fatura_api import belge_beklenmez_mi as _bbm, \
                _belge_istisna_kaliplari as _bik
            _ist = _bik(cur)
        except Exception:  # noqa: BLE001
            _bbm, _ist = (lambda m, i=None: False), []
        cur.execute("SELECT id, aciklama, kanal_detay FROM fatura_istek WHERE durum='aday'")
        for r in [dict(x) for x in cur.fetchall() or []]:
            _m = f"{r.get('aciklama') or ''} {r.get('kanal_detay') or ''}"
            if _faturasiz_tur_mu(_m) or _bbm(_m, _ist):
                cur.execute("DELETE FROM fatura_istek WHERE id=%s AND durum='aday'",
                            (r["id"],))
        # 4c) GERİYE DÖNÜK kurumsal etiketi — önceden 'tedarikci' doğmuş MEPAŞ vb
        #     adaylar kurumsal sınıfa taşınır (idempotent)
        try:
            from fatura_api import kurumsal_fatura_mu as _kfm
            cur.execute("""SELECT id, aciklama, kanal_detay FROM fatura_istek
                           WHERE durum IN ('aday','istek_gonderildi')
                             AND COALESCE(tur,'tedarikci')='tedarikci'""")
            for r in [dict(x) for x in cur.fetchall() or []]:
                if _kfm(f"{r.get('aciklama') or ''} {r.get('kanal_detay') or ''}"):
                    cur.execute("UPDATE fatura_istek SET tur='kurumsal' WHERE id=%s",
                                (r["id"],))
        except Exception:  # noqa: BLE001
            pass

        # 5) OTOMATİK KAPANIŞ — açık istek, sonradan gelen faturayla eşleşirse
        #    kendiliğinden kapanır. İKİ KURAL:
        #    K1 BİREBİR: tutar ±%2, tarih ±10g (vadeli 90g) — eski davranış.
        #    K2 KISMİ/AVANS (sahip 2026-07-18, DYK vakası: "5 Mayıs 15.000 avans,
        #    20 Mayıs 75.000 fatura, 25 Mayıs 60.000 ödeme — borç kapanır; kısmi
        #    ödemede birebir tutar hiç tutmuyordu, aday KALICI kalıyordu"):
        #    tedarikçi adı eşleşmesi + tarih ±45g + faturanın KALAN KAPASİTESİ
        #    (Codex çapraz görüşü: guard oran değil kalan-bakiye bazlı olsun;
        #    tavan fatura*1.05, bağlanan düşülür). 46-90 gün arası aday KALIR —
        #    otomatik bağlanmaz, insan bakar (öneri-only freni).
        cur.execute(
            """SELECT id, tarih::text AS tarih, tutar::float AS tutar, kaynak_tip,
                      COALESCE(aciklama,'') AS aciklama,
                      COALESCE(kanal_detay,'') AS kanal_detay,
                      COALESCE(tedarikci_ad,'') AS tedarikci_ad
               FROM fatura_istek WHERE durum IN ('aday','istek_gonderildi')""")
        acik_istekler = [dict(x) for x in cur.fetchall() or []]
        # Kapanış havuzu açık adayların yaşına göre GENİŞLER — sabit 75 günlük
        # havuz, eski adayın (DYK: ödeme 65 gün, faturası 89 gün önce) faturasını
        # hiç göremiyordu.
        havuz = faturalar
        _tarihli = [r["tarih"] for r in acik_istekler if r.get("tarih")]
        if _tarihli:
            try:
                cur.execute(
                    """SELECT id, COALESCE(fatura_tarih, olusturma::date)::text AS tarih,
                              COALESCE(toplam_tutar,0)::float AS tutar, tedarikci_ad
                       FROM tedarikci_fatura
                       WHERE COALESCE(durum,'') <> 'kopya'
                         AND COALESCE(fatura_tarih, olusturma::date) >= %s::date - 90""",
                    (min(_tarihli),))
                havuz = [dict(r) for r in cur.fetchall() or []]
            except Exception:  # noqa: BLE001
                havuz = faturalar
        try:
            from fatura_api import _odeme_eslesir as _oe
        except Exception:  # noqa: BLE001
            _oe = None
        kapasite: dict = {}  # fatura id → kalan bağlanabilir tutar (tutar*1.05 − bağlanan)
        for r in acik_istekler:
            _tol = 90 if r.get("kaynak_tip") == "vadeli_alim" else 10
            fid = _k2d_eslesti(float(r["tutar"]), r["tarih"], havuz,
                               kullanildi, gun_tol=_tol)
            k2_not = None
            if not fid and _oe:
                metin_a = (f"{r.get('aciklama')} {r.get('kanal_detay')} "
                           f"{r.get('tedarikci_ad')}")
                for f in havuz:
                    if f["id"] in kullanildi:
                        continue
                    fad = (f.get("tedarikci_ad") or "").strip()
                    tut_f = float(f.get("tutar") or 0)
                    if not fad or tut_f <= 0:
                        continue
                    ist_ad = (r.get("tedarikci_ad") or "").strip()
                    if not (_oe(fad, metin_a) or (ist_ad and _oe(ist_ad, fad))):
                        continue
                    try:
                        gf = abs((date.fromisoformat(str(r["tarih"])[:10])
                                  - date.fromisoformat(str(f["tarih"])[:10])).days)
                    except Exception:  # noqa: BLE001
                        continue
                    if gf > 45:
                        continue
                    kalan = kapasite.get(f["id"], round(tut_f * 1.05, 2))
                    if float(r["tutar"]) > kalan + 1:
                        continue  # bu faturanın kapasitesi dolu — başka fatura ara
                    kapasite[f["id"]] = round(kalan - float(r["tutar"]), 2)
                    fid = f["id"]
                    k2_not = "kısmi/avans eşleşme: tedarikçi adı + ±45 gün + kalan kapasite"
                    break
            if fid:
                cur.execute(
                    """UPDATE fatura_istek
                       SET durum='fatura_geldi', eslesen_fatura_id=%s,
                           kapanis_aciklama=COALESCE(%s, kapanis_aciklama),
                           kapanma_ts=NOW()
                       WHERE id=%s""", (fid, k2_not, r["id"]))
                oto_kapanan += 1
        conn.commit()

    # Omurga olayı — hata-yutar (öneri-only görünürlük)
    if yeni:
        try:
            from duyu_omurga import duyu_olay_yaz
            duyu_olay_yaz(
                "belge", "belge.fatura_istek.aday_dogdu", date.today().isoformat(),
                entity_scope="genel", entity_id=None,
                signal_name="Faturasız büyük ödeme adayı",
                payload={"adet": len(yeni),
                         "toplam": round(sum(x["tutar"] for x in yeni), 2)})
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True, "yeni_aday": len(yeni), "oto_kapanan": oto_kapanan}


def fatura_istek_ozet() -> dict:
    """Beyin (B47) + bağ defteri + WhatsApp özeti için hafif sayaç — salt-okur."""
    with db() as (_, cur):
        _ensure(cur)
        cur.execute(
            """SELECT COUNT(*)::int AS adet,
                      ROUND(COALESCE(SUM(tutar),0)::numeric,2) AS toplam,
                      MAX(tutar)::float AS en_buyuk_tutar
               FROM fatura_istek WHERE durum IN ('aday','istek_gonderildi')""")
        r = dict(cur.fetchone() or {})
    toplam = float(r.get("toplam") or 0)
    return {
        "acik_adet": int(r.get("adet") or 0),
        "acik_toplam": round(toplam, 2),
        "kdv_riski": round(toplam * _KDV_ORAN / (1 + _KDV_ORAN), 2),
        "en_buyuk": float(r.get("en_buyuk_tutar") or 0),
        "esik": ESIK,
    }


@router.get("/liste")
def fatura_istek_liste():
    """Belge Merkezi UI: açık istekler TEDARİKÇİ GRUPLU + birleşik wa.me mesajı.
    Teslim-al kanalı yönlendirilir (belge_talep bekleyen sayısı) — çakışma yok."""
    with db() as (_, cur):
        _ensure(cur)
        cur.execute(
            """SELECT id, kaynak_tip, tarih::text AS tarih, tutar::float AS tutar,
                      aciklama, kanal_detay, tedarikci_ad, tedarikci_tel, durum,
                      mesaj_sayisi, COALESCE(tur,'tedarikci') AS tur
               FROM fatura_istek
               WHERE durum IN ('aday','istek_gonderildi')
               ORDER BY tutar DESC""")
        acik = [dict(r) for r in cur.fetchall() or []]
        belge_talep_bekleyen = 0
        try:
            cur.execute("SELECT COUNT(*)::int AS a FROM belge_talep WHERE durum='bekliyor'")
            belge_talep_bekleyen = int((cur.fetchone() or {"a": 0})["a"])
        except Exception:  # noqa: BLE001
            pass

    gruplar: dict = {}
    for x in acik:
        kurumsal = x.get("tur") == "kurumsal"
        anahtar = (x.get("tedarikci_ad") or "").strip() \
            or ((x.get("aciklama") or "").strip()[:30] if kurumsal else "") \
            or "(tedarikçi belirsiz)"
        g = gruplar.setdefault(anahtar, {"tedarikci": anahtar, "tel": None,
                                         "adet": 0, "toplam": 0.0,
                                         "kurumsal": kurumsal, "istekler": []})
        g["adet"] += 1
        g["toplam"] = round(g["toplam"] + float(x["tutar"] or 0), 2)
        g["kurumsal"] = g["kurumsal"] or kurumsal
        if not g["tel"]:
            g["tel"] = _tel_norm(x.get("tedarikci_tel") or "") or None
        g["istekler"].append(x)
    for g in gruplar.values():
        if g["kurumsal"]:
            # MEPAŞ vb: WhatsApp DEĞİL — kurum sitesi / GİB e-arşivden indirilir
            g["wa_link"] = None
            g["eylem"] = "earsiv_indir"
        elif g["tel"]:
            g["wa_link"] = (f"https://wa.me/{g['tel']}?text="
                            + quote(_wa_mesaj(g["tedarikci"], g["istekler"])))
            g["eylem"] = "whatsapp"
        else:
            g["wa_link"] = None
            g["eylem"] = "numara_ekle"

    o = fatura_istek_ozet()
    return {
        **o,
        "gruplar": sorted(gruplar.values(), key=lambda g: -g["toplam"]),
        "belge_talep_bekleyen": belge_talep_bekleyen,
        "not": ("ADAY listesi — hüküm değil. Eşik ≥{:,.0f} TL; K2-D eşleşmesi "
                "(±%2 tutar, ±5 gün) bulunan ödeme aday olmaz; fatura sonradan "
                "gelirse istek gece KENDİLİĞİNDEN kapanır. Teslimat faturaları "
                "Açık Teslimat motorunda ayrı takip edilir.").format(ESIK),
    }


@router.post("/tara")
def fatura_istek_tara_uc():
    """Elle tetik — gece motorunun aynısı."""
    return gece_fatura_istek_tara()


@router.post("/{istek_id}/gonderildi")
def fatura_istek_gonderildi(istek_id: str):
    """Sahip wa.me mesajını gönderince: durum + mesaj izi (belge ritmi verisi)."""
    with db() as (_, cur):
        _ensure(cur)
        cur.execute(
            """UPDATE fatura_istek
               SET durum='istek_gonderildi', mesaj_sayisi = mesaj_sayisi + 1,
                   son_mesaj_ts = NOW()
               WHERE id=%s AND durum IN ('aday','istek_gonderildi')""", (istek_id,))
    return {"ok": True}


class TelefonBody(BaseModel):
    telefon: str


@router.post("/{istek_id}/telefon")
def fatura_istek_telefon(istek_id: str, body: TelefonBody):
    """BM-4A 'numara isteyerek': numarayı isteğe + AYNI tedarikçinin diğer açık
    isteklerine yazar; tedarikciler kartında BİREBİR ad eşleşmesi varsa oraya da
    işler (kanonik kimlik kaynakta) — serbest metin adla tedarikçi YARATILMAZ."""
    tel = _tel_norm(body.telefon)
    if not tel:
        raise HTTPException(400, "Geçersiz numara — örn. 0532 123 45 67")
    with db() as (_, cur):
        _ensure(cur)
        cur.execute("SELECT tedarikci_ad FROM fatura_istek WHERE id=%s", (istek_id,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "İstek bulunamadı")
        ted_ad = (dict(r).get("tedarikci_ad") or "").strip()
        if ted_ad:
            cur.execute(
                """UPDATE fatura_istek SET tedarikci_tel=%s
                   WHERE durum IN ('aday','istek_gonderildi')
                     AND LOWER(TRIM(COALESCE(tedarikci_ad,''))) = LOWER(%s)""",
                (tel, ted_ad))
            cur.execute(
                """UPDATE tedarikciler SET telefon=%s
                   WHERE aktif = TRUE AND LOWER(TRIM(ad)) = LOWER(%s)
                     AND COALESCE(TRIM(telefon),'') = ''""", (tel, ted_ad))
        else:
            cur.execute("UPDATE fatura_istek SET tedarikci_tel=%s WHERE id=%s",
                        (tel, istek_id))
    return {"ok": True, "telefon": tel}


class KapatBody(BaseModel):
    aciklama: str
    kalici_istisna: bool = False  # 🚫 belge beklenmez — kalıbı ÖĞREN


@router.post("/{istek_id}/kapat")
def fatura_istek_kapat(istek_id: str, body: KapatBody):
    """Manuel kapanış — açıklama ZORUNLU (kayıt sessizce kapanamaz; kapanış
    kanıtı iz bırakır — belge_talep ile aynı ilke). kalici_istisna=true:
    sahip 'belge beklenmez' dedi → kalıp öğrenilir (tedarikçi adı ya da
    açıklamanın ilk kelimeleri), aynı ödeme türü bir daha aday olmaz."""
    acik = (body.aciklama or "").strip()
    if not acik:
        raise HTTPException(400, "Açıklama zorunlu — örn. 'faturası kağıt geldi', "
                                 "'şahsi harcamaymış', 'fatura kesilmeyecek (X)'.")
    with db() as (_, cur):
        _ensure(cur)
        cur.execute(
            """UPDATE fatura_istek
               SET durum='kapandi', kapanis_aciklama=%s, kapanma_ts=NOW()
               WHERE id=%s AND durum IN ('aday','istek_gonderildi')
               RETURNING tedarikci_ad, aciklama""",
            (acik, istek_id))
        r = cur.fetchone()
        if body.kalici_istisna and r:
            d = dict(r)
            kalip = (d.get("tedarikci_ad") or "").strip() \
                or " ".join((d.get("aciklama") or "").split()[:3]).strip()
            if len(kalip) >= 3:
                try:
                    from fatura_api import _belge_istisna_kaliplari
                    _belge_istisna_kaliplari(cur)  # tabloyu garanti et
                    cur.execute(
                        """INSERT INTO belge_istisna_kalip (kalip, not_metin)
                           VALUES (%s, %s) ON CONFLICT (kalip) DO NOTHING""",
                        (kalip, f"sahip kapanışı: {acik[:120]}"))
                except Exception:  # noqa: BLE001
                    pass
    return {"ok": True, "ogrenilen_kalip": (kalip if body.kalici_istisna and r else None)}
